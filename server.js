"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { Pool } = require("pg");

const COMPANIES = new Set(["Bormine", "Didiamant", "Corpdiam"]);
const CATEGORIES = new Set(["Odoo", "Accesos", "Equipo", "Red", "Correo", "Otro"]);
const TOPICS = new Set(["Odoo", "Accesos", "Equipo", "Otro"]);
const PRIORITIES = new Set(["Baja", "Normal", "Alta", "Urgente"]);
const STATUSES = new Set(["Nuevo", "En revisión", "En espera", "Resuelto", "Cerrado"]);
const APPOINTMENT_STATUSES = new Set(["Pendiente", "Confirmada", "Cancelada"]);
const RESOURCE_CATEGORIES = new Set(["General", ...CATEGORIES]);
const RESOURCE_TYPES = new Set(["Guía", "PDF", "Video"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT_LENGTH = 1200;
const MAX_TICKET_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TICKET_ATTACHMENTS = 5;
const TICKET_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno obligatoria ${name}.`);
  return value;
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function parsePort(value) {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT debe ser un número entero entre 1 y 65535.");
  }
  return port;
}

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  return email.length <= 254 ? email : "";
}

function validText(value, maxLength, required = true) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maxLength) return null;
  return normalized;
}

function validateDriveUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["drive.google.com", "docs.google.com"].includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function validateResourceImage(value) {
  if (typeof value !== "string") return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const [, mimeType, encoded] = match;
  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.length > 2 * 1024 * 1024 || data.toString("base64") !== encoded) return null;
  const isValidImage = mimeType === "image/png"
    ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === "image/jpeg"
      ? data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  return isValidImage ? { data, mimeType } : null;
}

function isAppointmentStatus(value) {
  return typeof value === "string" && APPOINTMENT_STATUSES.has(value);
}

function normalizeCompanies(value) {
  if (!Array.isArray(value) || value.length > COMPANIES.size
    || value.some((company) => typeof company !== "string" || !COMPANIES.has(company))) return null;
  return [...new Set(value)];
}

function parsePagination(pageValue, limitValue) {
  const page = pageValue === undefined ? 1 : Number(pageValue);
  const limit = limitValue === undefined ? TICKET_PAGE_SIZE : Number(limitValue);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE
    || !Number.isSafeInteger((page - 1) * limit)) {
    return null;
  }
  return { page, limit, offset: (page - 1) * limit };
}

function validateTicketAttachment(fileName, mimeType, value) {
  if (typeof fileName !== "string" || typeof mimeType !== "string" || typeof value !== "string") return null;
  const name = fileName.trim();
  if (!name || name.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(name)) return null;
  const match = /^data:(application\/pdf|image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1] !== mimeType) return null;
  const [, detectedType, encoded] = match;
  const extension = path.extname(name).toLowerCase();
  const allowedExtensions = {
    "application/pdf": [".pdf"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
  };
  if (!allowedExtensions[detectedType].includes(extension)) return null;
  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.length > MAX_TICKET_ATTACHMENT_SIZE || data.toString("base64") !== encoded) return null;
  const isValidFile = detectedType === "application/pdf"
    ? data.subarray(0, 5).toString("ascii") === "%PDF-"
    : detectedType === "image/png"
      ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return isValidFile ? { fileName: name, mimeType: detectedType, data } : null;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    company: user.company,
    companies: user.companies || (user.company ? [user.company] : []),
    active: user.active,
  };
}

function csrfToken() {
  return crypto.randomBytes(32).toString("hex");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createApp({ pool, sessionSecret, appOrigin, events = new EventEmitter(), sessionStore }) {
  const app = express();
  const PgSessionStore = connectPgSimple(session);
  const production = process.env.NODE_ENV === "production";
  const jsonBodyParser = express.json({ limit: "3mb", strict: true });
  const attachmentBodyParser = express.json({ limit: "15mb", strict: true });

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use((req, res, next) => {
    const uploadRequest = req.method === "POST" && /^\/api\/tickets\/\d+\/attachments$/.test(req.path);
    return (uploadRequest ? attachmentBodyParser : jsonBodyParser)(req, res, next);
  });
  app.use(session({
    name: "mesa-ti.sid",
    store: sessionStore || new PgSessionStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
      pruneSessionInterval: 15 * 60,
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    },
  }));

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." },
  });
  const publishChange = (entity) => events.emit("change", { entity });
  const saveNotifications = async (client, userIds, { title, message, entityType, entityId }) => {
    const recipients = [...new Set(userIds.map(Number))];
    if (!recipients.length) return;
    await client.query(
      `INSERT INTO notifications (user_id, title, message, entity_type, entity_id)
       SELECT recipients.recipient_id, $2, $3, $4, $5
       FROM unnest($1::bigint[]) AS recipients(recipient_id)`,
      [recipients, title, message, entityType, entityId],
    );
  };

  app.get("/api/health", asyncRoute(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  }));

  app.get("/api/auth/csrf", (req, res, next) => {
    if (!req.session.csrfToken) req.session.csrfToken = csrfToken();
    req.session.save((error) => {
      if (error) return next(error);
      res.set("Cache-Control", "no-store").json({ csrfToken: req.session.csrfToken });
    });
  });

  app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res, next) => {
    if (req.get("origin") !== appOrigin) return res.status(403).json({ error: "Origen de solicitud no permitido." });
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!EMAIL_PATTERN.test(email) || password.length > 128 || !safeEqual(req.get("x-csrf-token"), req.session.csrfToken || "")) {
      return res.status(400).json({ error: "Correo o contraseña no válidos." });
    }
    const result = await pool.query(
      "SELECT id, name, email, password_hash, role, company, companies, active FROM users WHERE email = $1",
      [email],
    );
    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, user?.password_hash || "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy");
    if (!user || !user.active || !passwordMatches) {
      return res.status(401).json({ error: "Correo o contraseña incorrectos." });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.csrfToken = csrfToken();
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.set("Cache-Control", "no-store").json({ user: publicUser(user), csrfToken: req.session.csrfToken });
      });
    });
  }));

  app.use("/api", asyncRoute(async (req, res, next) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && req.get("origin") !== appOrigin) {
      return res.status(403).json({ error: "Origen de solicitud no permitido." });
    }
    if (req.path === "/auth/logout" && req.method === "POST") return next();
    if (req.path === "/auth/me" && req.method === "GET") return next();
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: "Inicia sesión para continuar." });
    const result = await pool.query(
      "SELECT id, name, email, role, company, companies, active FROM users WHERE id = $1",
      [userId],
    );
    const user = result.rows[0];
    if (!user || !user.active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: "La cuenta no está activa. Contacta al administrador." });
    }
    req.user = user;
    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)
      && !safeEqual(req.get("x-csrf-token"), req.session.csrfToken || "")) {
      return res.status(403).json({ error: "La sesión expiró. Recarga la página e inténtalo de nuevo." });
    }
    return next();
  }));

  app.get("/api/events", (req, res) => {
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const sendRefresh = ({ entity }) => res.write(`event: refresh\ndata: ${JSON.stringify({ entity })}\n\n`);
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
    events.on("change", sendRefresh);
    res.on("close", () => {
      clearInterval(heartbeat);
      events.off("change", sendRefresh);
    });
  });

  const requireAdmin = (req, res, next) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Esta acción requiere permisos de administrador." });
    return next();
  };

  app.get("/api/auth/me", asyncRoute(async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "No hay una sesión activa." });
    const result = await pool.query(
      "SELECT id, name, email, role, company, companies, active FROM users WHERE id = $1",
      [req.session.userId],
    );
    const user = result.rows[0];
    if (!user?.active) return res.status(401).json({ error: "La cuenta no está activa." });
    return res.set("Cache-Control", "no-store").json({ user: publicUser(user) });
  }));

  app.post("/api/auth/logout", (req, res) => {
    if (!safeEqual(req.get("x-csrf-token"), req.session.csrfToken || "")) {
      return res.status(403).json({ error: "La sesión expiró. Recarga la página." });
    }
    req.session.destroy((error) => {
      if (error) return res.status(500).json({ error: "No fue posible cerrar la sesión." });
      res.clearCookie("mesa-ti.sid", { httpOnly: true, secure: production, sameSite: "strict", path: "/" });
      return res.status(204).end();
    });
  });

  app.post("/api/auth/password", asyncRoute(async (req, res, next) => {
    const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
    if (currentPassword.length > 128 || newPassword.length < 12 || newPassword.length > 128 || newPassword === currentPassword) {
      return res.status(400).json({ error: "La nueva contraseña debe tener 12 caracteres o más y ser distinta." });
    }
    const account = await pool.query("SELECT password_hash FROM users WHERE id = $1 AND active = TRUE", [req.user.id]);
    const matches = account.rowCount && await bcrypt.compare(currentPassword, account.rows[0].password_hash);
    if (!matches) return res.status(400).json({ error: "La contraseña actual no es correcta." });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, req.user.id]);
    await pool.query("DELETE FROM user_sessions WHERE sess::jsonb ->> 'userId' = $1", [String(req.user.id)]);
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = req.user.id;
      req.session.csrfToken = csrfToken();
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        return res.json({ csrfToken: req.session.csrfToken });
      });
    });
  }));

  app.get("/api/tickets", asyncRoute(async (req, res) => {
    if (req.query.page !== undefined || req.query.limit !== undefined) {
      const pagination = parsePagination(req.query.page, req.query.limit);
      const search = validText(req.query.search ?? "", 120, false);
      const company = req.query.company || "";
      const status = req.query.status || "";
      if (!pagination || search === null || (company && !COMPANIES.has(company)) || (status && !STATUSES.has(status))) {
        return res.status(400).json({ error: "Los filtros o parámetros de paginación no son válidos." });
      }
      const values = [];
      const filters = [];
      if (req.user.role !== "admin") filters.push(`t.company = ANY($${values.push(req.user.companies)}::varchar[])`);
      if (company) filters.push(`t.company = $${values.push(company)}`);
      if (status) filters.push(`t.status = $${values.push(status)}`);
      if (search) {
        const index = values.push(`%${search}%`);
        filters.push(`(t.id::text ILIKE $${index} OR t.subject ILIKE $${index} OR t.requester ILIKE $${index}
          OR t.company ILIKE $${index} OR t.category ILIKE $${index} OR t.module ILIKE $${index})`);
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM tickets t ${where}`, values);
      const rows = await pool.query(
        `SELECT t.id, t.subject, t.requester, t.email, t.company, t.category, t.module, t.priority, t.status, t.root_cause,
          t.description, t.created_at, t.updated_at, t.first_response_at, t.resolved_at,
          u.name AS assignee
         FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to
         ${where}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pagination.limit, pagination.offset],
      );
      const total = count.rows[0].total;
      return res.json({
        tickets: rows.rows,
        total,
        page: pagination.page,
        limit: pagination.limit,
        pages: Math.ceil(total / pagination.limit),
      });
    }
    const companyScope = req.user.role === "admin" ? "" : " AND t.company = ANY($1::varchar[])";
    const values = req.user.role === "admin" ? [] : [req.user.companies];
    const result = await pool.query(
      `SELECT t.id, t.subject, t.requester, t.email, t.company, t.category, t.module, t.priority, t.status, t.description, t.created_at, t.updated_at,
        t.first_response_at, t.resolved_at, t.root_cause,
        u.name AS assignee
       FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to
       WHERE TRUE${companyScope}
       ORDER BY t.created_at DESC LIMIT 500`,
      values,
    );
    res.json({ tickets: result.rows });
  }));

  app.get("/api/notifications", asyncRoute(async (req, res) => {
    const [notifications, unread] = await Promise.all([
      pool.query(
        `SELECT id, title, message, entity_type, entity_id, read_at, created_at
         FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
        [req.user.id],
      ),
      pool.query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL", [req.user.id]),
    ]);
    return res.json({ notifications: notifications.rows, unreadCount: unread.rows[0].count });
  }));

  app.patch("/api/notifications/read-all", asyncRoute(async (req, res) => {
    await pool.query("UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
    publishChange("notifications");
    return res.status(204).end();
  }));

  app.patch("/api/notifications/:id/read", asyncRoute(async (req, res) => {
    const notificationId = Number(req.params.id);
    if (!Number.isSafeInteger(notificationId)) return res.status(400).json({ error: "Notificación no válida." });
    const result = await pool.query(
      "UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id",
      [notificationId, req.user.id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "La notificación no existe." });
    publishChange("notifications");
    return res.status(204).end();
  }));

  app.get("/api/tickets/metrics", asyncRoute(async (req, res) => {
    const values = [];
    const filters = [];
    if (req.user.role !== "admin") filters.push(`company = ANY($${values.push(req.user.companies)}::varchar[])`);
    if (req.query.company) {
      if (!COMPANIES.has(req.query.company)) return res.status(400).json({ error: "Empresa no válida." });
      filters.push(`company = $${values.push(req.query.company)}`);
    }
    const period = req.query.period || "all";
    if (!["all", "week", "month"].includes(period)) return res.status(400).json({ error: "Periodo no válido." });
    if (period !== "all") {
      const timeZone = process.env.APP_TIMEZONE || "UTC";
      const index = values.push(timeZone);
      const unit = period === "week" ? "week" : "month";
      filters.push(`created_at >= date_trunc('${unit}', NOW() AT TIME ZONE $${index}) AT TIME ZONE $${index}`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total,
        COUNT(first_response_at)::int AS responded,
        COUNT(resolved_at)::int AS resolved,
        COUNT(*) FILTER (WHERE first_response_at IS NULL)::int AS awaiting_response,
        ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60)
          FILTER (WHERE first_response_at IS NOT NULL))::int AS average_response_minutes,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60)
          FILTER (WHERE resolved_at IS NOT NULL))::int AS average_resolution_minutes
       FROM tickets ${where}`,
      values,
    );
    return res.json({ metrics: result.rows[0] });
  }));

  app.post("/api/tickets", asyncRoute(async (req, res) => {
    const { subject, category, priority, module, description } = req.body;
    const company = req.body.company;
    const validSubject = validText(subject, 90);
    const validDescription = validText(description, MAX_TEXT_LENGTH);
    const validModule = validText(module ?? "", 60, false);
    if (!validSubject || !validDescription || validModule === null || !CATEGORIES.has(category)
      || !PRIORITIES.has(priority) || !COMPANIES.has(company)
      || (req.user.role !== "admin" && !req.user.companies.includes(company))) {
      return res.status(400).json({ error: "Completa los campos obligatorios con valores válidos." });
    }
    const client = await pool.connect();
    let ticket;
    let adminIds = [];
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO tickets (requester_id, subject, requester, email, company, category, module, priority, status, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Nuevo', $9)
         RETURNING id, subject, requester, email, company, category, module, priority, status, description, created_at`,
        [req.user.id, validSubject, req.user.name, req.user.email, company, category, validModule, priority, validDescription],
      );
      ticket = result.rows[0];
      await client.query(
        "INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES ($1, $2, 'created', 'Ticket creado')",
        [ticket.id, req.user.id],
      );
      const admins = await client.query("SELECT id FROM users WHERE role = 'admin' AND active = TRUE");
      adminIds = admins.rows.map((user) => user.id).filter((id) => Number(id) !== Number(req.user.id));
      await saveNotifications(client, adminIds, {
        title: "Nuevo ticket",
        message: `${req.user.name} · ${company} · ${ticket.subject}`,
        entityType: "ticket",
        entityId: ticket.id,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    publishChange("tickets");
    if (adminIds.length) publishChange("notifications");
    res.status(201).json({ ticket });
  }));

  app.get("/api/tickets/:id", asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.id);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1) return res.status(400).json({ error: "Ticket no válido." });
    const values = [ticketId];
    const scope = req.user.role === "admin" ? "" : ` AND t.company = ANY($${values.push(req.user.companies)}::varchar[])`;
    const result = await pool.query(
      `SELECT t.id, t.subject, t.requester, t.email, t.company, t.category, t.module, t.priority, t.status, t.root_cause,
        t.description, t.created_at, t.updated_at, t.first_response_at, t.resolved_at, t.assigned_to,
        u.name AS assignee
       FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.id = $1${scope}`,
      values,
    );
    if (!result.rowCount) return res.status(404).json({ error: "El ticket no existe." });
    const [comments, eventsForTicket, attachments] = await Promise.all([
      pool.query(
        `SELECT c.id, c.comment, c.created_at, u.name AS author, u.role AS author_role
         FROM ticket_comments c JOIN users u ON u.id = c.author_id
         WHERE c.ticket_id = $1 ORDER BY c.created_at, c.id`,
        [ticketId],
      ),
      pool.query(
        `SELECT e.id, e.event_type, e.detail, e.created_at, u.name AS actor
         FROM ticket_events e JOIN users u ON u.id = e.actor_id
         WHERE e.ticket_id = $1 ORDER BY e.created_at, e.id`,
        [ticketId],
      ),
      pool.query(
        `SELECT a.id, a.file_name, a.mime_type, octet_length(a.file_data)::int AS size,
          a.created_at, u.name AS uploaded_by
         FROM ticket_attachments a JOIN users u ON u.id = a.uploaded_by
         WHERE a.ticket_id = $1 ORDER BY a.created_at, a.id`,
        [ticketId],
      ),
    ]);
    return res.json({
      ticket: result.rows[0],
      comments: comments.rows,
      events: eventsForTicket.rows,
      attachments: attachments.rows,
    });
  }));

  app.post("/api/tickets/:id/comments", asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.id);
    const comment = validText(req.body.comment, 2000);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1 || !comment) {
      return res.status(400).json({ error: "El comentario o el ticket no son válidos." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const values = [ticketId];
      const scope = req.user.role === "admin" ? "" : ` AND company = ANY($${values.push(req.user.companies)}::varchar[])`;
      const ticket = await client.query(`SELECT id, requester_id, subject FROM tickets WHERE id = $1${scope} FOR UPDATE`, values);
      if (!ticket.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "El ticket no existe." });
      }
      const inserted = await client.query(
        `INSERT INTO ticket_comments (ticket_id, author_id, comment)
         VALUES ($1, $2, $3) RETURNING id, comment, created_at`,
        [ticketId, req.user.id, comment],
      );
      if (req.user.role === "admin") {
        await client.query("UPDATE tickets SET first_response_at = COALESCE(first_response_at, NOW()) WHERE id = $1", [ticketId]);
      }
      await client.query(
        "INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES ($1, $2, 'comment_added', 'Comentario agregado')",
        [ticketId, req.user.id],
      );
      const recipients = req.user.role === "admin"
        ? [ticket.rows[0].requester_id].filter((id) => Number(id) !== Number(req.user.id))
        : (await client.query("SELECT id FROM users WHERE role = 'admin' AND active = TRUE")).rows
          .map((user) => user.id).filter((id) => Number(id) !== Number(req.user.id));
      await saveNotifications(client, recipients, {
        title: "Nuevo comentario en un ticket",
        message: `TI-${String(ticketId).padStart(4, "0")} · ${ticket.rows[0].subject}`,
        entityType: "ticket",
        entityId: ticketId,
      });
      await client.query("COMMIT");
      publishChange("tickets");
      if (recipients.length) publishChange("notifications");
      return res.status(201).json({ comment: { ...inserted.rows[0], author: req.user.name, author_role: req.user.role } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/tickets/:id/attachments", asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.id);
    const attachment = validateTicketAttachment(req.body.fileName, req.body.mimeType, req.body.data);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1 || !attachment) {
      return res.status(400).json({ error: "El archivo debe ser PDF, JPG o PNG válido de hasta 10 MB." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const values = [ticketId];
      const scope = req.user.role === "admin" ? "" : ` AND company = ANY($${values.push(req.user.companies)}::varchar[])`;
      const ticket = await client.query(`SELECT id FROM tickets WHERE id = $1${scope} FOR UPDATE`, values);
      if (!ticket.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "El ticket no existe." });
      }
      const count = await client.query("SELECT COUNT(*)::int AS total FROM ticket_attachments WHERE ticket_id = $1", [ticketId]);
      if (count.rows[0].total >= MAX_TICKET_ATTACHMENTS) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Cada ticket admite hasta ${MAX_TICKET_ATTACHMENTS} archivos.` });
      }
      const inserted = await client.query(
        `INSERT INTO ticket_attachments (ticket_id, uploaded_by, file_name, mime_type, file_data)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, file_name, mime_type, octet_length(file_data)::int AS size, created_at`,
        [ticketId, req.user.id, attachment.fileName, attachment.mimeType, attachment.data],
      );
      await client.query(
        "INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES ($1, $2, 'attachment_added', $3)",
        [ticketId, req.user.id, `Archivo adjunto: ${attachment.fileName.slice(0, 450)}`],
      );
      await client.query("COMMIT");
      publishChange("tickets");
      return res.status(201).json({ attachment: inserted.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/tickets/:id/root-cause", requireAdmin, asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.id);
    const rootCause = validText(req.body.rootCause ?? "", 500, false);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1 || rootCause === null) {
      return res.status(400).json({ error: "La causa raíz no es válida (máximo 500 caracteres)." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT root_cause FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "El ticket no existe." });
      }
      if (current.rows[0].root_cause !== rootCause) {
        await client.query("UPDATE tickets SET root_cause = $1, updated_at = NOW() WHERE id = $2", [rootCause, ticketId]);
        await client.query(
          "INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES ($1, $2, 'root_cause_changed', $3)",
          [ticketId, req.user.id, rootCause ? `Causa raíz: ${rootCause}` : "Causa raíz eliminada"],
        );
      }
      await client.query("COMMIT");
      publishChange("tickets");
      return res.status(204).end();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/tickets/:ticketId/attachments/:attachmentId", asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.ticketId);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1 || !Number.isSafeInteger(attachmentId) || attachmentId < 1) {
      return res.status(400).json({ error: "Archivo no válido." });
    }
    const values = [ticketId, attachmentId];
    const scope = req.user.role === "admin" ? "" : ` AND t.company = ANY($${values.push(req.user.companies)}::varchar[])`;
    const result = await pool.query(
      `SELECT a.file_name, a.mime_type, a.file_data
       FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id
       WHERE t.id = $1 AND a.id = $2${scope}`,
      values,
    );
    if (!result.rowCount) return res.status(404).json({ error: "El archivo no existe." });
    const attachment = result.rows[0];
    const safeName = encodeURIComponent(attachment.file_name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set({
      "Content-Type": attachment.mime_type,
      "Content-Disposition": `attachment; filename*=UTF-8''${safeName}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    return res.send(attachment.file_data);
  }));

  app.patch("/api/tickets/:id/assignee", requireAdmin, asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.id);
    const assigneeId = req.body.assignedTo === null || req.body.assignedTo === "" ? null : Number(req.body.assignedTo);
    if (!Number.isSafeInteger(ticketId) || ticketId < 1
      || (assigneeId !== null && (!Number.isSafeInteger(assigneeId) || assigneeId < 1))) {
      return res.status(400).json({ error: "Ticket o responsable no válidos." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ticket = await client.query("SELECT assigned_to FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
      if (!ticket.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "El ticket no existe." });
      }
      let assigneeName = null;
      if (assigneeId !== null) {
        const assignee = await client.query("SELECT id, name FROM users WHERE id = $1 AND role = 'admin' AND active = TRUE", [assigneeId]);
        if (!assignee.rowCount) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "El responsable debe ser un administrador activo." });
        }
        assigneeName = assignee.rows[0].name;
      }
      const currentAssigneeId = ticket.rows[0].assigned_to === null ? null : Number(ticket.rows[0].assigned_to);
      if (currentAssigneeId !== assigneeId) {
        await client.query("UPDATE tickets SET assigned_to = $1, updated_at = NOW() WHERE id = $2", [assigneeId, ticketId]);
        await client.query(
          "INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES ($1, $2, 'assigned', $3)",
          [ticketId, req.user.id, assigneeId === null ? "Responsable retirado" : `Responsable asignado: ${assigneeName}`],
        );
      }
      await client.query("COMMIT");
      publishChange("tickets");
      return res.status(204).end();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/tickets/:id/status", requireAdmin, asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.id);
    const { status } = req.body;
    if (!Number.isSafeInteger(ticketId) || !STATUSES.has(status)) return res.status(400).json({ error: "Estado o ticket no válidos." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT status FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "El ticket no existe." });
      }
      const updated = await client.query(
        `UPDATE tickets
         SET status = $1, updated_at = NOW(),
           resolved_at = CASE WHEN $1 IN ('Resuelto', 'Cerrado') THEN COALESCE(resolved_at, NOW()) ELSE NULL END
         WHERE id = $2
         RETURNING id, status, updated_at, resolved_at, requester_id, requester, subject`,
        [status, ticketId],
      );
      if (current.rows[0].status !== status) {
        await client.query(
          "INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES ($1, $2, 'status_changed', $3)",
          [ticketId, req.user.id, status],
        );
        await saveNotifications(client, [updated.rows[0].requester_id], {
          title: "Actualización de tu ticket",
          message: `TI-${String(updated.rows[0].id).padStart(4, "0")} · ${updated.rows[0].subject} · ${status}`,
          entityType: "ticket",
          entityId: updated.rows[0].id,
        });
      }
      await client.query("COMMIT");
      publishChange("tickets");
      if (current.rows[0].status !== status) publishChange("notifications");
      return res.json({ ticket: updated.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/appointments", asyncRoute(async (req, res) => {
    if (req.query.page !== undefined || req.query.limit !== undefined) {
      const pagination = parsePagination(req.query.page, req.query.limit);
      const company = req.query.company || "";
      if (!pagination || (company && !COMPANIES.has(company))) {
        return res.status(400).json({ error: "Los parámetros de paginación no son válidos." });
      }
      const values = [];
      const filters = [];
      if (req.user.role !== "admin") filters.push(`company = ANY($${values.push(req.user.companies)}::varchar[])`);
      if (company) filters.push(`company = $${values.push(company)}`);
      const scope = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM appointments${scope}`, values);
      const rows = await pool.query(
        `SELECT id, requester, email, subject, company, topic, appointment_date AS date,
          appointment_time AS time, notes, status
         FROM appointments${scope}
         ORDER BY appointment_date, appointment_time, id
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pagination.limit, pagination.offset],
      );
      const total = count.rows[0].total;
      return res.json({
        appointments: rows.rows,
        total,
        page: pagination.page,
        limit: pagination.limit,
        pages: Math.ceil(total / pagination.limit),
      });
    }
    const scope = req.user.role === "admin" ? "" : " AND company = ANY($1::varchar[])";
    const result = await pool.query(
      `SELECT id, requester, email, subject, company, topic, appointment_date AS date, appointment_time AS time, notes, status
       FROM appointments WHERE TRUE${scope} ORDER BY appointment_date, appointment_time LIMIT 500`,
      req.user.role === "admin" ? [] : [req.user.companies],
    );
    res.json({ appointments: result.rows });
  }));

  app.post("/api/appointments", asyncRoute(async (req, res) => {
    const { subject, topic, date, time, notes } = req.body;
    const company = req.body.company;
    const validSubject = validText(subject, 90);
    const validNotes = validText(notes ?? "", 500, false);
    const validDate = parseDate(date);
    const validTime = typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null;
    const timeZone = process.env.APP_TIMEZONE || "UTC";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    if (!validSubject || validNotes === null || !TOPICS.has(topic) || !validDate || validDate < today
      || !validTime || !COMPANIES.has(company)
      || (req.user.role !== "admin" && !req.user.companies.includes(company))) {
      return res.status(400).json({ error: "Completa la cita con una fecha futura o de hoy y valores válidos." });
    }
    const client = await pool.connect();
    let appointment;
    let adminIds = [];
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO appointments (requester_id, requester, email, subject, company, topic, appointment_date, appointment_time, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, requester, email, subject, company, topic, appointment_date AS date, appointment_time AS time, notes, status`,
        [req.user.id, req.user.name, req.user.email, validSubject, company, topic, validDate, validTime, validNotes],
      );
      appointment = result.rows[0];
      const admins = await client.query("SELECT id FROM users WHERE role = 'admin' AND active = TRUE");
      adminIds = admins.rows.map((user) => user.id).filter((id) => Number(id) !== Number(req.user.id));
      await saveNotifications(client, adminIds, {
        title: "Nueva solicitud de atención",
        message: `${req.user.name} · ${company} · ${appointment.subject}`,
        entityType: "appointment",
        entityId: appointment.id,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    publishChange("appointments");
    if (adminIds.length) publishChange("notifications");
    res.status(201).json({ appointment });
  }));

  app.patch("/api/appointments/:id/status", requireAdmin, asyncRoute(async (req, res) => {
    const appointmentId = Number(req.params.id);
    const { status } = req.body;
    if (!Number.isSafeInteger(appointmentId) || !isAppointmentStatus(status)) {
      return res.status(400).json({ error: "Estado o solicitud de cita no válidos." });
    }
    const client = await pool.connect();
    let appointment;
    let statusChanged = false;
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT status FROM appointments WHERE id = $1 FOR UPDATE",
        [appointmentId],
      );
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "La solicitud de cita no existe." });
      }
      const result = await client.query(
        "UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status, requester_id, requester, subject",
        [status, appointmentId],
      );
      appointment = result.rows[0];
      if (current.rows[0].status !== status) {
        await saveNotifications(client, [appointment.requester_id], {
          title: "Actualización de tu solicitud",
          message: `${appointment.subject} · ${status}`,
          entityType: "appointment",
          entityId: appointment.id,
        });
        statusChanged = true;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    publishChange("appointments");
    if (statusChanged) publishChange("notifications");
    return res.json({ appointment: { id: appointment.id, status: appointment.status } });
  }));

  app.get("/api/users", requireAdmin, asyncRoute(async (_req, res) => {
    const result = await pool.query(
      "SELECT id, name, email, role, company, companies, active, created_at FROM users ORDER BY created_at DESC",
    );
    res.json({ users: result.rows });
  }));

  app.post("/api/users", requireAdmin, asyncRoute(async (req, res) => {
    const name = validText(req.body.name, 80);
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const companies = normalizeCompanies(req.body.companies ?? (req.body.company ? [req.body.company] : []));
    const role = req.body.role;
    if (!name || !EMAIL_PATTERN.test(email) || password.length < 12 || password.length > 128
      || !["admin", "user"].includes(role) || !companies
      || (role === "user" && companies.length === 0) || (role === "admin" && companies.length > 0)) {
      return res.status(400).json({ error: "Datos inválidos. Los colaboradores requieren al menos una empresa y la contraseña debe tener 12 caracteres." });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, role, company, companies)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, email, role, company, companies, active, created_at`,
        [name, email, passwordHash, role, companies[0] || null, companies],
      );
      publishChange("users");
      return res.status(201).json({ user: result.rows[0] });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
      throw error;
    }
  }));

  app.patch("/api/users/:id", requireAdmin, asyncRoute(async (req, res) => {
    const userId = Number(req.params.id);
    const name = validText(req.body.name, 80);
    const email = normalizeEmail(req.body.email);
    const companies = normalizeCompanies(req.body.companies);
    const role = req.body.role;
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!Number.isSafeInteger(userId) || !name || !EMAIL_PATTERN.test(email) || !companies
      || !["admin", "user"].includes(role) || (role === "user" && companies.length === 0)
      || (role === "admin" && companies.length > 0)
      || (password && (password.length < 12 || password.length > 128))) {
      return res.status(400).json({ error: "Revisa nombre, correo, rol, empresas y contraseña (mínimo 12 caracteres si la cambias)." });
    }
    if (userId === req.user.id && (role !== "admin" || password)) {
      return res.status(400).json({ error: "No puedes cambiar tu propio rol ni restablecer tu propia contraseña desde este formulario." });
    }
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const targetResult = await client.query(
        "SELECT id, role, active FROM users WHERE id = $1 FOR UPDATE",
        [userId],
      );
      const target = targetResult.rows[0];
      if (!target) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "La cuenta no existe." });
      }
      if (target.active && target.role === "admin" && role !== "admin") {
        const admins = await client.query(
          "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = TRUE",
        );
        if (admins.rows[0].count <= 1) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Debe permanecer al menos un administrador activo." });
        }
      }
      const result = await client.query(
        `UPDATE users
         SET name = $1, email = $2, role = $3, company = $4, companies = $5,
             password_hash = COALESCE($6::text, password_hash)
         WHERE id = $7
         RETURNING id, name, email, role, company, companies, active, created_at`,
        [name, email, role, companies[0] || null, companies, passwordHash, userId],
      );
      if (passwordHash || !target.active) {
        await client.query("DELETE FROM user_sessions WHERE sess::jsonb ->> 'userId' = $1", [String(userId)]);
      }
      await client.query("COMMIT");
      publishChange("users");
      return res.json({ user: result.rows[0], passwordChanged: Boolean(passwordHash) });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/users/:id/active", requireAdmin, asyncRoute(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || typeof req.body.active !== "boolean") return res.status(400).json({ error: "Solicitud no válida." });
    if (userId === req.user.id && !req.body.active) return res.status(400).json({ error: "No puedes desactivar tu propia cuenta." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
      const targetResult = await client.query("SELECT role, active FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const target = targetResult.rows[0];
      if (!target) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "La cuenta no existe." });
      }
      if (!req.body.active && target.role === "admin" && target.active) {
        const admins = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = TRUE");
        if (admins.rows[0].count <= 1) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Debe permanecer al menos un administrador activo." });
        }
      }
      const result = await client.query(
        "UPDATE users SET active = $1 WHERE id = $2 RETURNING id, name, email, role, company, companies, active",
        [req.body.active, userId],
      );
      if (!req.body.active) await client.query("DELETE FROM user_sessions WHERE sess::jsonb ->> 'userId' = $1", [String(userId)]);
      await client.query("COMMIT");
      publishChange("users");
      return res.json({ user: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/resources", asyncRoute(async (req, res) => {
    const adminView = req.user.role === "admin" && req.query.includeInactive === "true";
    const visibility = req.user.role === "admin"
      ? (adminView ? "" : " AND active = TRUE")
      : " AND active = TRUE AND (company IS NULL OR company = ANY($1::varchar[]))";
    const values = req.user.role === "admin" ? [] : [req.user.companies];
    const result = await pool.query(
      `SELECT id, title, description, category, resource_type, company, drive_url AS url, active,
              image_data IS NOT NULL AS has_image, created_at
       FROM resources WHERE TRUE${visibility} ORDER BY category, title LIMIT 500`,
      values,
    );
    return res.json({ resources: result.rows });
  }));

  app.post("/api/resources", requireAdmin, asyncRoute(async (req, res) => {
    const title = validText(req.body.title, 120);
    const description = validText(req.body.description ?? "", 500, false);
    const url = validateDriveUrl(req.body.url);
    const { category, type } = req.body;
    const company = req.body.company === "" || req.body.company === null ? null : req.body.company;
    const image = req.body.image === undefined || req.body.image === null || req.body.image === ""
      ? null
      : validateResourceImage(req.body.image);
    if (!title || description === null || !url || !RESOURCE_CATEGORIES.has(category)
      || !RESOURCE_TYPES.has(type) || (company !== null && !COMPANIES.has(company))
      || (req.body.image !== undefined && req.body.image !== null && req.body.image !== "" && !image)) {
      return res.status(400).json({ error: "Revisa los datos del recurso, el enlace seguro de Drive y la imagen JPG, PNG o WebP (máximo 2 MB)." });
    }
    const result = await pool.query(
      `INSERT INTO resources (title, description, category, resource_type, company, drive_url, created_by, image_data, image_mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, title, description, category, resource_type, company, drive_url AS url, active,
                 image_data IS NOT NULL AS has_image, created_at`,
      [title, description, category, type, company, url, req.user.id, image?.data ?? null, image?.mimeType ?? null],
    );
    publishChange("resources");
    return res.status(201).json({ resource: result.rows[0] });
  }));

  app.patch("/api/resources/:id", requireAdmin, asyncRoute(async (req, res) => {
    const resourceId = Number(req.params.id);
    const title = validText(req.body.title, 120);
    const description = validText(req.body.description ?? "", 500, false);
    const url = validateDriveUrl(req.body.url);
    const { category, type } = req.body;
    const company = req.body.company === "" || req.body.company === null ? null : req.body.company;
    const hasImage = Object.hasOwn(req.body, "image");
    const image = hasImage && req.body.image !== null && req.body.image !== ""
      ? validateResourceImage(req.body.image)
      : null;
    const removeImage = req.body.removeImage === true;
    if (!Number.isSafeInteger(resourceId) || !title || description === null || !url
      || !RESOURCE_CATEGORIES.has(category) || !RESOURCE_TYPES.has(type)
      || (company !== null && !COMPANIES.has(company))
      || (hasImage && req.body.image !== null && req.body.image !== "" && !image)
      || (req.body.removeImage !== undefined && typeof req.body.removeImage !== "boolean")
      || (removeImage && image)) {
      return res.status(400).json({ error: "Revisa los datos del recurso, el enlace seguro de Drive y la imagen JPG, PNG o WebP (máximo 2 MB)." });
    }
    const result = await pool.query(
      `UPDATE resources
       SET title = $1, description = $2, category = $3, resource_type = $4, company = $5, drive_url = $6,
           image_data = CASE WHEN $7 THEN $8::bytea WHEN $9 THEN NULL ELSE image_data END,
           image_mime_type = CASE WHEN $7 THEN $10::varchar WHEN $9 THEN NULL ELSE image_mime_type END
       WHERE id = $11
       RETURNING id, title, description, category, resource_type, company, drive_url AS url, active,
                 image_data IS NOT NULL AS has_image, created_at`,
      [title, description, category, type, company, url, Boolean(image), image?.data ?? null, removeImage, image?.mimeType ?? null, resourceId],
    );
    if (!result.rowCount) return res.status(404).json({ error: "El recurso no existe." });
    publishChange("resources");
    return res.json({ resource: result.rows[0] });
  }));

  app.get("/api/resources/:id/image", asyncRoute(async (req, res) => {
    const resourceId = Number(req.params.id);
    if (!Number.isSafeInteger(resourceId)) return res.status(404).json({ error: "La imagen no existe." });
    const result = await pool.query(
      `SELECT image_data, image_mime_type, active, company FROM resources WHERE id = $1`,
      [resourceId],
    );
    const resource = result.rows[0];
    const canView = resource && (req.user.role === "admin"
      || (resource.active && (resource.company === null || req.user.companies.includes(resource.company))));
    if (!canView || !resource.image_data) return res.status(404).json({ error: "La imagen no existe." });
    res.set({
      "Cache-Control": "private, no-store",
      "Content-Type": resource.image_mime_type,
      "X-Content-Type-Options": "nosniff",
    });
    return res.send(resource.image_data);
  }));

  app.patch("/api/resources/:id/active", requireAdmin, asyncRoute(async (req, res) => {
    const resourceId = Number(req.params.id);
    if (!Number.isSafeInteger(resourceId) || typeof req.body.active !== "boolean") {
      return res.status(400).json({ error: "Solicitud no válida." });
    }
    const result = await pool.query(
      "UPDATE resources SET active = $1 WHERE id = $2 RETURNING id, active",
      [req.body.active, resourceId],
    );
    if (!result.rowCount) return res.status(404).json({ error: "El recurso no existe." });
    publishChange("resources");
    return res.json({ resource: result.rows[0] });
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "Recurso no encontrado." }));
  app.use(express.static(path.join(__dirname, "public"), {
    etag: true,
    index: "index.html",
    maxAge: 0,
    dotfiles: "deny",
    fallthrough: false,
  }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "El cuerpo JSON no es válido." });
    if (error.status === 404 && error.path?.startsWith("/api/")) return res.status(404).json({ error: "Recurso no encontrado." });
    console.error("Error de solicitud:", error);
    return res.status(error.status || 500).json({ error: "Ocurrió un error interno. Inténtalo de nuevo." });
  });

  return app;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(10) NOT NULL CHECK (role IN ('admin', 'user')),
      company VARCHAR(40),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((role = 'admin' AND company IS NULL) OR (role = 'user' AND company IN ('Bormine', 'Didiamant', 'Corpdiam')))
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS companies VARCHAR(40)[] NOT NULL DEFAULT '{}';
    UPDATE users
    SET companies = CASE WHEN role = 'user' THEN ARRAY[company] ELSE '{}'::varchar[] END
    WHERE cardinality(companies) = 0;
    CREATE TABLE IF NOT EXISTS tickets (
      id BIGSERIAL PRIMARY KEY,
      requester_id BIGINT NOT NULL REFERENCES users(id),
      subject VARCHAR(90) NOT NULL,
      requester VARCHAR(80) NOT NULL,
      email VARCHAR(254) NOT NULL,
      company VARCHAR(40) NOT NULL CHECK (company IN ('Bormine', 'Didiamant', 'Corpdiam')),
      category VARCHAR(40) NOT NULL CHECK (category IN ('Odoo', 'Accesos', 'Equipo', 'Red', 'Correo', 'Otro')),
      module VARCHAR(60) NOT NULL DEFAULT '',
      priority VARCHAR(10) NOT NULL CHECK (priority IN ('Baja', 'Normal', 'Alta', 'Urgente')),
      status VARCHAR(20) NOT NULL DEFAULT 'Nuevo' CHECK (status IN ('Nuevo', 'En revisión', 'En espera', 'Resuelto', 'Cerrado')),
      description VARCHAR(1200) NOT NULL,
      assigned_to BIGINT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tickets_created_at_idx ON tickets (created_at DESC);
    CREATE INDEX IF NOT EXISTS tickets_requester_created_idx ON tickets (requester_id, created_at DESC);
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS root_cause VARCHAR(500) NOT NULL DEFAULT '';
    UPDATE tickets SET resolved_at = updated_at
    WHERE resolved_at IS NULL AND status IN ('Resuelto', 'Cerrado');
    CREATE TABLE IF NOT EXISTS appointments (
      id BIGSERIAL PRIMARY KEY,
      requester_id BIGINT NOT NULL REFERENCES users(id),
      requester VARCHAR(80) NOT NULL,
      email VARCHAR(254) NOT NULL,
      subject VARCHAR(90) NOT NULL,
      company VARCHAR(40) NOT NULL CHECK (company IN ('Bormine', 'Didiamant', 'Corpdiam')),
      topic VARCHAR(20) NOT NULL CHECK (topic IN ('Odoo', 'Accesos', 'Equipo', 'Otro')),
      appointment_date DATE NOT NULL,
      appointment_time TIME NOT NULL,
      notes VARCHAR(500) NOT NULL DEFAULT '',
      status VARCHAR(20) NOT NULL DEFAULT 'Pendiente' CHECK (status IN ('Pendiente', 'Confirmada', 'Cancelada')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS appointments_date_idx ON appointments (appointment_date, appointment_time);
    CREATE TABLE IF NOT EXISTS ticket_events (
      id BIGSERIAL PRIMARY KEY,
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      actor_id BIGINT NOT NULL REFERENCES users(id),
      event_type VARCHAR(40) NOT NULL,
      detail VARCHAR(500) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ticket_events ALTER COLUMN detail TYPE TEXT;
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id BIGSERIAL PRIMARY KEY,
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_id BIGINT NOT NULL REFERENCES users(id),
      comment VARCHAR(2000) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ticket_comments_ticket_created_idx ON ticket_comments (ticket_id, created_at, id);
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id BIGSERIAL PRIMARY KEY,
      ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      uploaded_by BIGINT NOT NULL REFERENCES users(id),
      file_name VARCHAR(180) NOT NULL,
      mime_type VARCHAR(30) NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
      file_data BYTEA NOT NULL CHECK (octet_length(file_data) <= 10485760),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_created_idx ON ticket_attachments (ticket_id, created_at, id);
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      message VARCHAR(300) NOT NULL,
      entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('ticket', 'appointment')),
      entity_id BIGINT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
    CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON user_sessions (expire);
    CREATE TABLE IF NOT EXISTS resources (
      id BIGSERIAL PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      category VARCHAR(40) NOT NULL CHECK (category IN ('General', 'Odoo', 'Accesos', 'Equipo', 'Red', 'Correo', 'Otro')),
      resource_type VARCHAR(10) NOT NULL CHECK (resource_type IN ('Guía', 'PDF', 'Video')),
      company VARCHAR(40) CHECK (company IN ('Bormine', 'Didiamant', 'Corpdiam')),
      drive_url VARCHAR(2048) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by BIGINT NOT NULL REFERENCES users(id),
      image_data BYTEA,
      image_mime_type VARCHAR(20),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE resources ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE resources ADD COLUMN IF NOT EXISTS image_mime_type VARCHAR(20);
    CREATE INDEX IF NOT EXISTS resources_active_company_idx ON resources (active, company, category);
  `);
}

async function bootstrapAdmin(pool) {
  const existing = await pool.query("SELECT EXISTS (SELECT 1 FROM users) AS has_users");
  if (existing.rows[0].has_users) return;
  const name = validText(process.env.BOOTSTRAP_ADMIN_NAME || "", 80);
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";
  if (!name || !EMAIL_PATTERN.test(email) || password.length < 16 || password.length > 128) {
    throw new Error("La base de datos está vacía. Configura BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD (mínimo 16 caracteres) para crear la cuenta inicial.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') ON CONFLICT (email) DO NOTHING",
    [name, email, passwordHash],
  );
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  if (count.rows[0].count === 0) throw new Error("No se pudo crear la cuenta inicial de administrador.");
  console.info("Cuenta inicial de administrador creada. Retira las variables BOOTSTRAP_ADMIN_* del panel de despliegue.");
}

async function main() {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const sessionSecret = requiredEnvironment("SESSION_SECRET");
  const appOrigin = requiredEnvironment("APP_ORIGIN").replace(/\/+$/, "");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET debe contener al menos 32 caracteres aleatorios.");
  let origin;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new Error("APP_ORIGIN debe ser una URL absoluta como https://soporte.example.com.");
  }
  if (origin.origin !== appOrigin || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("APP_ORIGIN debe contener solo el origen público (protocolo, dominio y puerto opcional).");
  }
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("APP_ORIGIN debe usar HTTP o HTTPS.");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE || "UTC" });
  } catch {
    throw new Error("APP_TIMEZONE debe ser una zona horaria IANA válida.");
  }
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:") {
    throw new Error("APP_ORIGIN debe usar HTTPS en producción.");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_MAX || 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ...(process.env.DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  pool.on("error", (error) => console.error("Error inesperado en el pool PostgreSQL:", error));
  try {
    await migrate(pool);
    await bootstrapAdmin(pool);
    const activeAdmin = await pool.query("SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND active = TRUE) AS has_admin");
    if (!activeAdmin.rows[0].has_admin) throw new Error("No hay un administrador activo. Recupera el acceso antes de iniciar la aplicación.");
    const app = createApp({ pool, sessionSecret, appOrigin: origin.origin });
    const port = parsePort(process.env.PORT);
    const server = app.listen(port, "0.0.0.0", () => console.info(`Nexo TI listo en el puerto ${port}.`));
    const shutdown = (signal) => {
      console.info(`Recibida señal ${signal}; cerrando Nexo TI.`);
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  isAppointmentStatus,
  migrate,
  normalizeCompanies,
  parseDate,
  parsePagination,
  parsePort,
  validText,
  validateDriveUrl,
  validateResourceImage,
  validateTicketAttachment,
};
