"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildCalendarEvent,
  createCalendarService,
  decryptSecret,
  deriveEncryptionKey,
  encryptSecret,
  validateCalendarSettings,
} = require("../calendar");

const MATERIAL = "k".repeat(40);

test("encryption round-trips and rejects tampered or foreign-key payloads", () => {
  const key = deriveEncryptionKey(MATERIAL);
  const payload = encryptSecret("super-secreto", key);
  assert.match(payload, /^v1:/);
  assert.equal(decryptSecret(payload, key), "super-secreto");
  assert.notEqual(encryptSecret("super-secreto", key), payload);
  const raw = Buffer.from(payload.slice(3), "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decryptSecret(`v1:${raw.toString("base64")}`, key));
  assert.throws(() => decryptSecret(payload, deriveEncryptionKey("z".repeat(40))));
  assert.equal(deriveEncryptionKey("corta"), null);
  assert.equal(deriveEncryptionKey(undefined), null);
});

test("validateCalendarSettings enforces bounds and defaults the calendar id", () => {
  const valid = validateCalendarSettings({ clientId: " id.apps ", calendarId: "", eventMinutes: 60, enabled: false });
  assert.deepEqual(valid, { clientId: "id.apps", clientSecret: "", calendarId: "primary", eventMinutes: 60, enabled: false });
  assert.equal(validateCalendarSettings({ clientId: "a b", eventMinutes: 60, enabled: false }), null);
  assert.equal(validateCalendarSettings({ clientId: "a", eventMinutes: 10, enabled: false }), null);
  assert.equal(validateCalendarSettings({ clientId: "a", eventMinutes: 60, enabled: "yes" }), null);
  assert.equal(validateCalendarSettings(null), null);
});

test("buildCalendarEvent computes the end time, including midnight rollover", () => {
  const appointment = {
    id: "5", requester: "Ana", email: "ana@example.test", company: "Bormine", topic: "Odoo",
    subject: "Capacitación", notes: "", date: "2026-12-31", time: "23:30",
  };
  const event = buildCalendarEvent(appointment, { minutes: 60, timeZone: "America/Mexico_City" });
  assert.equal(event.start.dateTime, "2026-12-31T23:30:00");
  assert.equal(event.end.dateTime, "2027-01-01T00:30:00");
  assert.equal(event.end.timeZone, "America/Mexico_City");
  assert.equal(event.extendedProperties.private.nexoAppointmentId, "5");
  assert.equal(event.attendees, undefined);
});

test("createAuthorizationUrl stores only a hash of the state and sends PKCE parameters", async () => {
  const key = deriveEncryptionKey(MATERIAL);
  const inserted = [];
  const pool = {
    query: async (sql, params) => {
      if (sql.includes("SELECT * FROM calendar_settings")) {
        return { rows: [{ client_id: "cid", client_secret_enc: encryptSecret("sec", key) }] };
      }
      if (sql.includes("INSERT INTO calendar_oauth_states")) inserted.push(params);
      return { rows: [] };
    },
  };
  const service = createCalendarService({ pool, appOrigin: "https://app.example.test", timeZone: "UTC", encryptionKey: MATERIAL });
  const url = new URL(await service.createAuthorizationUrl(7));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.test/api/settings/calendar/oauth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(inserted.length, 1);
  assert.notEqual(inserted[0][0], url.searchParams.get("state"));
  assert.match(inserted[0][0], /^[0-9a-f]{64}$/);
});

test("saving a new client secret without CONFIG_ENCRYPTION_KEY fails with 503", async () => {
  const pool = { query: async () => ({ rows: [{ client_id: "", client_secret_enc: null, refresh_token_enc: null }] }) };
  const service = createCalendarService({ pool, appOrigin: "https://app.example.test", timeZone: "UTC" });
  await assert.rejects(
    service.saveSettings({ clientId: "cid", clientSecret: "sec", calendarId: "primary", eventMinutes: 60, enabled: false }, 1),
    (error) => error.status === 503,
  );
});
