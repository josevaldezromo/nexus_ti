"use strict";

const crypto = require("node:crypto");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_SCOPES = `openid email ${GOOGLE_EVENTS_SCOPE}`;
const OAUTH_STATE_TTL_MINUTES = 10;
const REQUEST_TIMEOUT_MS = 8000;
const SYNC_BATCH_SIZE = 25;
const CALLBACK_PATH = "/api/settings/calendar/oauth/callback";

const PENDING_SYNC_WHERE = `(
  (status = 'Confirmada' AND (google_event_id IS NULL OR calendar_error IS NOT NULL)
    AND appointment_date >= (NOW() AT TIME ZONE $1)::date)
  OR (status <> 'Confirmada' AND google_event_id IS NOT NULL)
)`;

class CalendarError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CalendarError";
    this.status = status;
  }
}

class GoogleError extends Error {
  constructor(status, code, description) {
    super(description || code || `Google respondió ${status}`);
    this.name = "GoogleError";
    this.status = status;
    this.code = code;
  }
}

function deriveEncryptionKey(material) {
  if (typeof material !== "string" || material.length < 32) return null;
  return Buffer.from(crypto.hkdfSync("sha256", material, "nexo-ti-config-v1", "calendar-credentials", 32));
}

function encryptSecret(plainText, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
}

function decryptSecret(payload, key) {
  if (typeof payload !== "string" || !payload.startsWith("v1:")) throw new Error("Formato de secreto no válido.");
  const raw = Buffer.from(payload.slice(3), "base64");
  if (raw.length < 29) throw new Error("Formato de secreto no válido.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

function validateCalendarSettings(body) {
  if (!body || typeof body !== "object") return null;
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  const calendarId = typeof body.calendarId === "string" && body.calendarId.trim() ? body.calendarId.trim() : "primary";
  const eventMinutes = Number(body.eventMinutes);
  if (clientId.length > 255 || /\s/.test(clientId)) return null;
  if (clientSecret.length > 256 || /\s/.test(clientSecret)) return null;
  if (!/^[^\s]{1,255}$/.test(calendarId)) return null;
  if (!Number.isInteger(eventMinutes) || eventMinutes < 15 || eventMinutes > 480) return null;
  if (typeof body.enabled !== "boolean") return null;
  return { clientId, clientSecret, calendarId, eventMinutes, enabled: body.enabled };
}

function addMinutes(date, time, minutes) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const end = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  const pad = (value) => String(value).padStart(2, "0");
  return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}T${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:00`;
}

function buildCalendarEvent(appointment, { minutes, timeZone }) {
  const description = [
    `Solicitante: ${appointment.requester} <${appointment.email}>`,
    `Empresa: ${appointment.company}`,
    `Tema: ${appointment.topic}`,
    appointment.notes ? `Notas: ${appointment.notes}` : "",
    `Solicitud #${appointment.id} registrada en Nexo TI.`,
  ].filter(Boolean).join("\n");
  return {
    summary: `${appointment.subject} · ${appointment.company}`.slice(0, 250),
    description: description.slice(0, 4000),
    status: "confirmed",
    start: { dateTime: `${appointment.date}T${appointment.time}:00`, timeZone },
    end: { dateTime: addMinutes(appointment.date, appointment.time, minutes), timeZone },
    extendedProperties: { private: { nexoAppointmentId: String(appointment.id) } },
  };
}

function describeGoogleError(error) {
  if (error instanceof CalendarError) return error.message;
  if (error instanceof GoogleError) {
    if (error.code === "invalid_grant") return "La autorización de Google expiró o fue revocada. Vuelve a conectar la cuenta.";
    if (error.code === "invalid_client" || error.code === "unauthorized_client") return "Google rechazó el Client ID o el Client Secret. Revísalos y vuelve a conectar.";
    if (error.status === 404) return "No se encontró el calendario. Verifica el ID y que la cuenta conectada tenga acceso.";
    if (error.status === 403) return "La cuenta conectada no tiene permiso para editar ese calendario o la API de Google Calendar no está habilitada.";
    if (error.status === 429) return "Google limitó temporalmente las solicitudes. Inténtalo más tarde.";
    return `Google Calendar respondió con un error (${error.status}).`;
  }
  return "No se pudo conectar con Google Calendar.";
}

function createCalendarService({ pool, appOrigin, timeZone, encryptionKey, fetchImpl = fetch }) {
  const key = deriveEncryptionKey(encryptionKey);
  const redirectUri = `${appOrigin}${CALLBACK_PATH}`;
  const queues = new Map();
  let cachedToken = null;

  const http = (url, options = {}) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const sha256 = (value, encoding) => crypto.createHash("sha256").update(value).digest(encoding);

  async function loadSettings() {
    const result = await pool.query("SELECT * FROM calendar_settings WHERE id = 1");
    return result.rows[0];
  }

  function requireKey() {
    if (!key) throw new CalendarError("Falta CONFIG_ENCRYPTION_KEY (mínimo 32 caracteres) en las variables de entorno del servicio.", 503);
    return key;
  }

  function reveal(payload) {
    try {
      return decryptSecret(payload, requireKey());
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw new CalendarError("No se pudieron descifrar las credenciales guardadas. Si cambió CONFIG_ENCRYPTION_KEY, vuelve a guardar el Client Secret y reconecta Google.", 409);
    }
  }

  async function googleJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const nested = body.error && typeof body.error === "object" ? body.error : null;
      throw new GoogleError(response.status, nested?.errors?.[0]?.reason || nested?.status || body.error, nested?.message || body.error_description);
    }
    return body;
  }

  async function tokenRequest(parameters) {
    const response = await http(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });
    return googleJson(response);
  }

  async function getAccessToken(settings) {
    if (cachedToken && cachedToken.expiresAt - 60000 > Date.now()) return cachedToken.value;
    const tokens = await tokenRequest({
      grant_type: "refresh_token",
      client_id: settings.client_id,
      client_secret: reveal(settings.client_secret_enc),
      refresh_token: reveal(settings.refresh_token_enc),
    });
    cachedToken = { value: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
    return cachedToken.value;
  }

  async function calendarRequest(settings, method, path, body, tolerated = []) {
    const send = async () => {
      const token = await getAccessToken(settings);
      return http(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(settings.calendar_id)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    };
    let response = await send();
    if (response.status === 401) {
      cachedToken = null;
      response = await send();
    }
    if (tolerated.includes(response.status)) return { status: response.status, json: {} };
    return { status: response.status, json: response.status === 204 ? {} : await googleJson(response) };
  }

  async function revokeQuietly(settings) {
    if (!key || !settings.refresh_token_enc) return;
    try {
      const token = decryptSecret(settings.refresh_token_enc, key);
      await http(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // La revocación es un mejor esfuerzo; el token ya se elimina localmente.
    }
  }

  async function dropConnection(message) {
    cachedToken = null;
    await pool.query(
      `UPDATE calendar_settings
       SET refresh_token_enc = NULL, connected_email = NULL, connected_at = NULL, enabled = FALSE,
         last_error = $1, updated_at = NOW()
       WHERE id = 1`,
      [message],
    );
  }

  async function recordConnectionError(message) {
    await pool.query("UPDATE calendar_settings SET last_error = $1, updated_at = NOW() WHERE id = 1", [String(message).slice(0, 500)]);
  }

  async function getPublicSettings() {
    const settings = await loadSettings();
    const connected = Boolean(settings.refresh_token_enc);
    let pendingSync = 0;
    if (settings.enabled && connected) {
      const pending = await pool.query(`SELECT COUNT(*)::int AS count FROM appointments WHERE ${PENDING_SYNC_WHERE}`, [timeZone]);
      pendingSync = pending.rows[0].count;
    }
    return {
      encryptionAvailable: Boolean(key),
      redirectUri,
      timeZone,
      clientId: settings.client_id,
      hasClientSecret: Boolean(settings.client_secret_enc),
      calendarId: settings.calendar_id,
      eventMinutes: settings.event_minutes,
      enabled: settings.enabled,
      connected,
      connectedEmail: settings.connected_email,
      connectedAt: settings.connected_at,
      lastError: settings.last_error,
      pendingSync,
    };
  }

  async function saveSettings(input, userId) {
    const current = await loadSettings();
    const clientChanged = input.clientId !== current.client_id;
    const hadConnection = Boolean(current.refresh_token_enc);
    let secretEnc = current.client_secret_enc;
    if (input.clientSecret) secretEnc = encryptSecret(input.clientSecret, requireKey());
    else if (clientChanged) secretEnc = null;
    const keepConnection = hadConnection && !clientChanged;
    if (input.enabled && !keepConnection) {
      throw new CalendarError("Conecta Google Calendar antes de activar la sincronización.");
    }
    if (hadConnection && clientChanged) await revokeQuietly(current);
    cachedToken = null;
    await pool.query(
      `UPDATE calendar_settings
       SET client_id = $1, client_secret_enc = $2, calendar_id = $3, event_minutes = $4, enabled = $5,
         refresh_token_enc = CASE WHEN $6::boolean THEN refresh_token_enc ELSE NULL END,
         connected_email = CASE WHEN $6::boolean THEN connected_email ELSE NULL END,
         connected_at = CASE WHEN $6::boolean THEN connected_at ELSE NULL END,
         last_error = NULL, updated_by = $7, updated_at = NOW()
       WHERE id = 1`,
      [input.clientId, secretEnc, input.calendarId, input.eventMinutes, input.enabled, keepConnection || !hadConnection, userId],
    );
  }

  async function createAuthorizationUrl(userId) {
    const settings = await loadSettings();
    if (!settings.client_id || !settings.client_secret_enc) {
      throw new CalendarError("Guarda primero el Client ID y el Client Secret.");
    }
    reveal(settings.client_secret_enc);
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(32).toString("base64url");
    await pool.query("DELETE FROM calendar_oauth_states WHERE user_id = $1 OR expires_at < NOW()", [userId]);
    await pool.query(
      `INSERT INTO calendar_oauth_states (state_hash, code_verifier, user_id, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))`,
      [sha256(state, "hex"), verifier, userId, OAUTH_STATE_TTL_MINUTES],
    );
    const parameters = new URLSearchParams({
      client_id: settings.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: sha256(verifier, "base64url"),
      code_challenge_method: "S256",
    });
    return `${GOOGLE_AUTH_URL}?${parameters}`;
  }

  async function completeAuthorization({ code, state }) {
    if (typeof code !== "string" || typeof state !== "string" || !code || code.length > 2048 || state.length < 20 || state.length > 100) {
      throw new CalendarError("La respuesta de Google no es válida. Inicia la conexión de nuevo.");
    }
    const stored = await pool.query(
      "DELETE FROM calendar_oauth_states WHERE state_hash = $1 AND expires_at > NOW() RETURNING code_verifier, user_id",
      [sha256(state, "hex")],
    );
    if (!stored.rowCount) throw new CalendarError("El enlace de autorización expiró o no es válido. Inicia la conexión de nuevo.");
    const { code_verifier: verifier, user_id: userId } = stored.rows[0];
    const admin = await pool.query("SELECT 1 FROM users WHERE id = $1 AND role = 'admin' AND active = TRUE", [userId]);
    if (!admin.rowCount) throw new CalendarError("La cuenta que inició la conexión ya no es administradora activa.", 403);
    const settings = await loadSettings();
    if (!settings.client_id || !settings.client_secret_enc) throw new CalendarError("Faltan las credenciales de Google.");
    const clientSecret = reveal(settings.client_secret_enc);
    let tokens;
    try {
      tokens = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: settings.client_id,
        client_secret: clientSecret,
        code_verifier: verifier,
      });
    } catch (error) {
      throw new CalendarError(describeGoogleError(error));
    }
    if (!String(tokens.scope || "").split(" ").includes(GOOGLE_EVENTS_SCOPE)) {
      throw new CalendarError("Debes permitir que Nexo TI vea y edite eventos de Google Calendar.");
    }
    if (!tokens.refresh_token) {
      throw new CalendarError("Google no entregó un token de actualización. Quita el acceso de Nexo TI en tu cuenta de Google y vuelve a conectar.");
    }
    let email = null;
    try {
      const profile = await googleJson(await http(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } }));
      email = typeof profile.email === "string" ? profile.email.slice(0, 320) : null;
    } catch {
      email = null;
    }
    cachedToken = { value: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
    await pool.query(
      `UPDATE calendar_settings
       SET refresh_token_enc = $1, connected_email = $2, connected_at = NOW(), last_error = NULL,
         updated_by = $3, updated_at = NOW()
       WHERE id = 1`,
      [encryptSecret(tokens.refresh_token, requireKey()), email, userId],
    );
  }

  async function testConnection() {
    const settings = await loadSettings();
    if (!settings.refresh_token_enc) throw new CalendarError("Conecta primero la cuenta de Google.");
    try {
      await calendarRequest(settings, "GET", `/events?maxResults=1&timeMin=${encodeURIComponent(new Date().toISOString())}`);
    } catch (error) {
      if (error instanceof GoogleError && error.code === "invalid_grant") await dropConnection(describeGoogleError(error));
      throw new CalendarError(describeGoogleError(error), error instanceof GoogleError && error.status < 500 ? 400 : 502);
    }
    await pool.query("UPDATE calendar_settings SET last_error = NULL WHERE id = 1");
  }

  async function disconnect(userId) {
    const settings = await loadSettings();
    await revokeQuietly(settings);
    cachedToken = null;
    await pool.query(
      `UPDATE calendar_settings
       SET refresh_token_enc = NULL, connected_email = NULL, connected_at = NULL, enabled = FALSE,
         last_error = NULL, updated_by = $1, updated_at = NOW()
       WHERE id = 1`,
      [userId],
    );
  }

  function serialize(appointmentId, task) {
    const previous = queues.get(appointmentId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(appointmentId, next);
    next.catch(() => {}).finally(() => {
      if (queues.get(appointmentId) === next) queues.delete(appointmentId);
    });
    return next;
  }

  function syncAppointment(appointmentId) {
    return serialize(String(appointmentId), async () => {
      const settings = await loadSettings();
      if (!settings.enabled || !settings.refresh_token_enc) return "disabled";
      const found = await pool.query(
        `SELECT id, requester, email, subject, company, topic, notes, status, google_event_id,
          to_char(appointment_date, 'YYYY-MM-DD') AS date, to_char(appointment_time, 'HH24:MI') AS time
         FROM appointments WHERE id = $1`,
        [appointmentId],
      );
      const appointment = found.rows[0];
      if (!appointment) return "skipped";
      try {
        if (appointment.status === "Confirmada") {
          const event = buildCalendarEvent(appointment, { minutes: settings.event_minutes, timeZone });
          let eventId = appointment.google_event_id;
          if (eventId) {
            const updated = await calendarRequest(settings, "PATCH", `/events/${encodeURIComponent(eventId)}`, event, [404, 410]);
            if ([404, 410].includes(updated.status) || updated.json.status === "cancelled") eventId = null;
          }
          if (!eventId) eventId = (await calendarRequest(settings, "POST", "/events", event)).json.id;
          await pool.query(
            "UPDATE appointments SET google_event_id = $2, calendar_synced_at = NOW(), calendar_error = NULL WHERE id = $1",
            [appointment.id, eventId],
          );
          return "synced";
        }
        if (!appointment.google_event_id) return "skipped";
        await calendarRequest(settings, "DELETE", `/events/${encodeURIComponent(appointment.google_event_id)}`, undefined, [404, 410]);
        await pool.query(
          "UPDATE appointments SET google_event_id = NULL, calendar_synced_at = NOW(), calendar_error = NULL WHERE id = $1",
          [appointment.id],
        );
        return "removed";
      } catch (error) {
        const message = describeGoogleError(error);
        if (error instanceof GoogleError && error.code === "invalid_grant") await dropConnection(message);
        await pool.query("UPDATE appointments SET calendar_error = $2 WHERE id = $1", [appointment.id, message.slice(0, 300)]);
        return "error";
      }
    });
  }

  async function syncPending() {
    const settings = await loadSettings();
    if (!settings.enabled || !settings.refresh_token_enc) throw new CalendarError("Activa la sincronización antes de sincronizar pendientes.");
    const pending = await pool.query(
      `SELECT id FROM appointments WHERE ${PENDING_SYNC_WHERE}
       ORDER BY appointment_date, appointment_time, id LIMIT ${SYNC_BATCH_SIZE}`,
      [timeZone],
    );
    const totals = { synced: 0, removed: 0, failed: 0 };
    for (const row of pending.rows) {
      const outcome = await syncAppointment(row.id);
      if (outcome === "synced") totals.synced += 1;
      else if (outcome === "removed") totals.removed += 1;
      else if (outcome === "error") totals.failed += 1;
      if (outcome === "disabled") break;
    }
    const remaining = await pool.query(`SELECT COUNT(*)::int AS count FROM appointments WHERE ${PENDING_SYNC_WHERE}`, [timeZone]);
    return { ...totals, remaining: remaining.rows[0].count };
  }

  return {
    redirectUri,
    getPublicSettings,
    saveSettings,
    createAuthorizationUrl,
    completeAuthorization,
    recordConnectionError,
    testConnection,
    disconnect,
    syncAppointment,
    syncPending,
  };
}

module.exports = {
  CALLBACK_PATH,
  CalendarError,
  buildCalendarEvent,
  createCalendarService,
  decryptSecret,
  deriveEncryptionKey,
  describeGoogleError,
  encryptSecret,
  validateCalendarSettings,
};
