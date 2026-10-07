"use strict";

const crypto = require("node:crypto");
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
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT_LENGTH = 1200;

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

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    company: user.company,
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

function createApp({ pool, sessionSecret, appOrigin }) {
  const app = express();
  const PgSessionStore = connectPgSimple(session);
  const production = process.env.NODE_ENV === "production";

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
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use(session({
    name: "mesa-ti.sid",
    store: new PgSessionStore({
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
      "SELECT id, name, email, password_hash, role, company, active FROM users WHERE email = $1",
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
      "SELECT id, name, email, role, company, active FROM users WHERE id = $1",
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

  const requireAdmin = (req, res, next) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Esta acción requiere permisos de administrador." });
    return next();
  };

  app.get("/api/auth/me", asyncRoute(async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "No hay una sesión activa." });
    const result = await pool.query(
      "SELECT id, name, email, role, company, active FROM users WHERE id = $1",
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
    const companyScope = req.user.role === "admin" ? "" : " AND t.requester_id = $1";
    const values = req.user.role === "admin" ? [] : [req.user.id];
    const result = await pool.query(
      `SELECT t.id, t.subject, t.requester, t.email, t.company, t.category, t.module, t.priority, t.status, t.description, t.created_at, t.updated_at,
        u.name AS assignee
       FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to
       WHERE TRUE${companyScope}
       ORDER BY t.created_at DESC LIMIT 500`,
      values,
    );
    res.json({ tickets: result.rows });
  }));

  app.post("/api/tickets", asyncRoute(async (req, res) => {
    const { subject, category, priority, module, description } = req.body;
    const company = req.user.role === "admin" ? req.body.company : req.user.company;
    const validSubject = validText(subject, 90);
    const validDescription = validText(description, MAX_TEXT_LENGTH);
    const validModule = validText(module ?? "", 60, false);
    if (!validSubject || !validDescription || validModule === null || !CATEGORIES.has(category)
      || !PRIORITIES.has(priority) || !COMPANIES.has(company)) {
      return res.status(400).json({ error: "Completa los campos obligatorios con valores válidos." });
    }
    const result = await pool.query(
      `INSERT INTO tickets (requester_id, subject, requester, email, company, category, module, priority, status, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Nuevo', $9)
       RETURNING id, subject, requester, email, company, category, module, priority, status, description, created_at`,
      [req.user.id, validSubject, req.user.name, req.user.email, company, category, validModule, priority, validDescription],
    );
    res.status(201).json({ ticket: result.rows[0] });
  }));

  app.patch("/api/tickets/:id/status", requireAdmin, asyncRoute(async (req, res) => {
    const ticketId = Number(req.params.id);
    const { status } = req.body;
    if (!Number.isSafeInteger(ticketId) || !STATUSES.has(status)) return res.status(400).json({ error: "Estado o ticket no válidos." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status",
        [status, ticketId],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "El ticket no existe." });
      }
      await client.query(
        "INSERT INTO ticket_events (ticket_id, actor_id, event_type, detail) VALUES ($1, $2, 'status_changed', $3)",
        [ticketId, req.user.id, status],
      );
      await client.query("COMMIT");
      return res.json({ ticket: updated.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/appointments", asyncRoute(async (req, res) => {
    const scope = req.user.role === "admin" ? "" : " AND requester_id = $1";
    const result = await pool.query(
      `SELECT id, requester, email, subject, company, topic, appointment_date AS date, appointment_time AS time, notes, status
       FROM appointments WHERE TRUE${scope} ORDER BY appointment_date, appointment_time LIMIT 500`,
      req.user.role === "admin" ? [] : [req.user.id],
    );
    res.json({ appointments: result.rows });
  }));

  app.post("/api/appointments", asyncRoute(async (req, res) => {
    const { subject, topic, date, time, notes } = req.body;
    const company = req.user.role === "admin" ? req.body.company : req.user.company;
    const validSubject = validText(subject, 90);
    const validNotes = validText(notes ?? "", 500, false);
    const validDate = parseDate(date);
    const validTime = typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null;
    const timeZone = process.env.APP_TIMEZONE || "UTC";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    if (!validSubject || validNotes === null || !TOPICS.has(topic) || !validDate || validDate < today
      || !validTime || !COMPANIES.has(company)) {
      return res.status(400).json({ error: "Completa la cita con una fecha futura o de hoy y valores válidos." });
    }
    const result = await pool.query(
      `INSERT INTO appointments (requester_id, requester, email, subject, company, topic, appointment_date, appointment_time, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, requester, email, subject, company, topic, appointment_date AS date, appointment_time AS time, notes, status`,
      [req.user.id, req.user.name, req.user.email, validSubject, company, topic, validDate, validTime, validNotes],
    );
    res.status(201).json({ appointment: result.rows[0] });
  }));

  app.get("/api/users", requireAdmin, asyncRoute(async (_req, res) => {
    const result = await pool.query(
      "SELECT id, name, email, role, company, active, created_at FROM users ORDER BY created_at DESC",
    );
    res.json({ users: result.rows });
  }));

  app.post("/api/users", requireAdmin, asyncRoute(async (req, res) => {
    const name = validText(req.body.name, 80);
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const company = req.body.company;
    const role = req.body.role;
    if (!name || !EMAIL_PATTERN.test(email) || password.length < 12 || password.length > 128
      || !["admin", "user"].includes(role) || (role === "user" && !COMPANIES.has(company))
      || (role === "admin" && company !== null && company !== "")) {
      return res.status(400).json({ error: "Datos inválidos. La contraseña debe tener al menos 12 caracteres." });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, role, company)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, role, company, active, created_at`,
        [name, email, passwordHash, role, role === "admin" ? null : company],
      );
      return res.status(201).json({ user: result.rows[0] });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
      throw error;
    }
  }));

  app.patch("/api/users/:id/active", requireAdmin, asyncRoute(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || typeof req.body.active !== "boolean") return res.status(400).json({ error: "Solicitud no válida." });
    if (userId === req.user.id && !req.body.active) return res.status(400).json({ error: "No puedes desactivar tu propia cuenta." });
    if (!req.body.active) {
      const target = await pool.query("SELECT role, active FROM users WHERE id = $1", [userId]);
      if (!target.rowCount) return res.status(404).json({ error: "La cuenta no existe." });
      if (target.rows[0].role === "admin" && target.rows[0].active) {
        const admins = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = TRUE");
        if (admins.rows[0].count <= 1) return res.status(400).json({ error: "Debe permanecer al menos un administrador activo." });
      }
    }
    const result = await pool.query(
      "UPDATE users SET active = $1 WHERE id = $2 RETURNING id, name, email, role, company, active",
      [req.body.active, userId],
    );
    if (!result.rowCount) return res.status(404).json({ error: "La cuenta no existe." });
    if (!req.body.active) await pool.query("DELETE FROM user_sessions WHERE sess::jsonb ->> 'userId' = $1", [String(userId)]);
    return res.json({ user: result.rows[0] });
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "Recurso no encontrado." }));
  app.use(express.static(path.join(__dirname, "public"), {
    etag: true,
    index: "index.html",
    maxAge: production ? "1h" : 0,
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
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON user_sessions (expire);
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
    const port = Number(process.env.PORT || 3000);
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

module.exports = { createApp, migrate, parseDate, validText };
