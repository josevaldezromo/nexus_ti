"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const {
  createApp,
  isAppointmentStatus,
  normalizeCompanies,
  parseDate,
  parsePagination,
  parsePort,
  validText,
  validateDriveUrl,
  validateResourceImage,
  validateTicketAttachment,
} = require("../server");

test("parseDate only accepts real calendar dates in ISO format", () => {
  assert.equal(parseDate("2028-02-29"), "2028-02-29");
  assert.equal(parseDate("2027-02-29"), null);
  assert.equal(parseDate("2027-13-01"), null);
  assert.equal(parseDate("01/02/2027"), null);
  assert.equal(parseDate(null), null);
});

test("validText trims values and enforces required and maximum length", () => {
  assert.equal(validText("  solicitud  ", 12), "solicitud");
  assert.equal(validText("  ", 12), null);
  assert.equal(validText("descripción", 4), null);
  assert.equal(validText("", 12, false), "");
  assert.equal(validText(null, 12, false), null);
});

test("parsePort defaults to 3000 and accepts valid configured ports", () => {
  assert.equal(parsePort(undefined), 3000);
  assert.equal(parsePort("8080"), 8080);
  assert.throws(() => parsePort("0"), /PORT debe ser/);
  assert.throws(() => parsePort("65536"), /PORT debe ser/);
  assert.throws(() => parsePort("abc"), /PORT debe ser/);
});

test("validateDriveUrl only accepts secure Google Drive and Docs links", () => {
  assert.equal(validateDriveUrl("https://drive.google.com/file/d/example/view"), "https://drive.google.com/file/d/example/view");
  assert.equal(validateDriveUrl("https://docs.google.com/document/d/example/edit"), "https://docs.google.com/document/d/example/edit");
  assert.equal(validateDriveUrl("http://drive.google.com/file/d/example/view"), null);
  assert.equal(validateDriveUrl("https://drive.google.com.evil.example/file/d/example"), null);
  assert.equal(validateDriveUrl("https://example.com/guide.pdf"), null);
  assert.equal(validateDriveUrl("javascript:alert(1)"), null);
  assert.equal(validateDriveUrl(null), null);
});

test("validateResourceImage accepts supported raster image data within the size limit", () => {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = validateResourceImage(`data:image/png;base64,${pngSignature.toString("base64")}`);
  assert.equal(png.mimeType, "image/png");
  assert.deepEqual(png.data, pngSignature);
  assert.equal(validateResourceImage(`data:image/jpeg;base64,${Buffer.from([255, 216, 255]).toString("base64")}`).mimeType, "image/jpeg");
  assert.equal(validateResourceImage(`data:image/webp;base64,${Buffer.from("RIFF0000WEBP").toString("base64")}`).mimeType, "image/webp");
  assert.equal(validateResourceImage("data:image/png;base64,PHN2Zy8+"), null);
  assert.equal(validateResourceImage(`data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64")}`), null);
  assert.equal(validateResourceImage(null), null);
});

test("appointment status validation only accepts supported states", () => {
  assert.equal(isAppointmentStatus("Pendiente"), true);
  assert.equal(isAppointmentStatus("Confirmada"), true);
  assert.equal(isAppointmentStatus("Cancelada"), true);
  assert.equal(isAppointmentStatus("Resuelta"), false);
  assert.equal(isAppointmentStatus(null), false);
});

test("company assignments only accept unique supported companies", () => {
  assert.deepEqual(normalizeCompanies(["Bormine", "Corpdiam", "Bormine"]), ["Bormine", "Corpdiam"]);
  assert.deepEqual(normalizeCompanies([]), []);
  assert.equal(normalizeCompanies(["Bormine", "Other"]), null);
  assert.equal(normalizeCompanies("Bormine"), null);
});

test("parsePagination validates page and limit and calculates offset", () => {
  assert.deepEqual(parsePagination(undefined, undefined), { page: 1, limit: 25, offset: 0 });
  assert.deepEqual(parsePagination("3", "10"), { page: 3, limit: 10, offset: 20 });
  assert.equal(parsePagination("0", "10"), null);
  assert.equal(parsePagination("1.5", "10"), null);
  assert.equal(parsePagination("1", "101"), null);
  assert.equal(parsePagination("1", "-1"), null);
});

test("ticket attachments accept only supported files with matching content and size", () => {
  const pdf = Buffer.from("%PDF-1.7 example");
  const attachment = validateTicketAttachment(" evidencia.pdf ", "application/pdf", `data:application/pdf;base64,${pdf.toString("base64")}`);
  assert.equal(attachment.fileName, "evidencia.pdf");
  assert.equal(attachment.mimeType, "application/pdf");
  assert.deepEqual(attachment.data, pdf);

  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(validateTicketAttachment("captura.png", "image/png", `data:image/png;base64,${png.toString("base64")}`).mimeType, "image/png");
  assert.equal(validateTicketAttachment("archivo.pdf", "application/pdf", "data:application/pdf;base64,PHN2Zy8+"), null);
  assert.equal(validateTicketAttachment("../archivo.pdf", "application/pdf", `data:application/pdf;base64,${pdf.toString("base64")}`), null);
  assert.equal(validateTicketAttachment("archivo.exe", "application/pdf", `data:application/pdf;base64,${pdf.toString("base64")}`), null);
  assert.equal(validateTicketAttachment("archivo.txt", "text/plain", `data:text/plain;base64,${pdf.toString("base64")}`), null);
  assert.equal(validateTicketAttachment("archivo.pdf", "application/pdf", `data:application/pdf;base64,${Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64")}`), null);
});

test("health endpoint checks the database and protected API rejects anonymous requests", async (t) => {
  const app = createApp({
    pool: { query: async () => ({ rows: [{ result: 1 }], rowCount: 1 }) },
    sessionSecret: "test-session-secret-with-at-least-32-characters",
    appOrigin: "http://127.0.0.1",
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const tickets = await fetch(`${origin}/api/tickets?page=1&limit=25`);
  assert.equal(tickets.status, 401);
  assert.match((await tickets.json()).error, /Inicia sesión/);
});

test("authenticated ticket API paginates records and rejects invalid page sizes", async (t) => {
  const admin = {
    id: 7,
    name: "Soporte TI",
    email: "soporte@example.test",
    role: "admin",
    company: null,
    companies: [],
    active: true,
    password_hash: await bcrypt.hash("test-password", 4),
  };
  const pool = {
    query: async (sql) => {
      if (sql.includes("password_hash") && sql.includes("WHERE email = $1")) {
        return { rows: [admin], rowCount: 1 };
      }
      if (sql.includes("SELECT id, name, email, role, company, companies, active FROM users WHERE id = $1")) {
        return { rows: [admin], rowCount: 1 };
      }
      if (sql.includes("SELECT COUNT(*)::int AS total FROM tickets")) {
        return { rows: [{ total: 30 }], rowCount: 1 };
      }
      if (sql.includes("SELECT COUNT(*)::int AS total FROM appointments")) {
        return { rows: [{ total: 2 }], rowCount: 1 };
      }
      if (sql.includes("FROM appointments")) {
        return {
          rows: [{ id: "2", subject: "Capacitación", status: "Pendiente" }],
          rowCount: 1,
        };
      }
      if (sql.includes("average_response_minutes")) {
        return {
          rows: [{
            total: 30,
            responded: 20,
            resolved: 10,
            awaiting_response: 10,
            average_response_minutes: 45,
            average_resolution_minutes: 180,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM tickets t LEFT JOIN users u")) {
        return {
          rows: [{ id: "6", subject: "Acceso a Odoo", status: "Nuevo", company: "Bormine" }],
          rowCount: 1,
        };
      }
      throw new Error(`Consulta inesperada en la prueba de integración: ${sql}`);
    },
  };
  const app = createApp({
    pool,
    sessionSecret: "test-session-secret-with-at-least-32-characters",
    appOrigin: "http://127.0.0.1",
    sessionStore: new session.MemoryStore(),
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  const csrfResponse = await fetch(`${origin}/api/auth/csrf`);
  const initialCookie = csrfResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await csrfResponse.json();
  const loginResponse = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: {
      Cookie: initialCookie,
      Origin: "http://127.0.0.1",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ email: admin.email, password: "test-password" }),
  });
  assert.equal(loginResponse.status, 200);
  const sessionCookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const login = await loginResponse.json();

  const pageResponse = await fetch(`${origin}/api/tickets?page=2&limit=25`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(pageResponse.status, 200);
  assert.deepEqual(await pageResponse.json(), {
    tickets: [{ id: "6", subject: "Acceso a Odoo", status: "Nuevo", company: "Bormine" }],
    total: 30,
    page: 2,
    limit: 25,
    pages: 2,
  });

  const appointmentsResponse = await fetch(`${origin}/api/appointments?page=1&limit=1`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(appointmentsResponse.status, 200);
  assert.deepEqual(await appointmentsResponse.json(), {
    appointments: [{ id: "2", subject: "Capacitación", status: "Pendiente" }],
    total: 2,
    page: 1,
    limit: 1,
    pages: 2,
  });

  const metricsResponse = await fetch(`${origin}/api/tickets/metrics?period=all`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(metricsResponse.status, 200);
  assert.equal((await metricsResponse.json()).metrics.average_response_minutes, 45);

  const invalidPage = await fetch(`${origin}/api/tickets?page=1&limit=1000`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(invalidPage.status, 400);
  assert.ok(login.user);
});
