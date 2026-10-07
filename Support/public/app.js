"use strict";

const COMPANIES = ["Bormine", "Didiamant", "Corpdiam"];
const STATUSES = ["Nuevo", "En revisión", "En espera", "Resuelto", "Cerrado"];
const PRIORITIES = ["Baja", "Normal", "Alta", "Urgente"];
const CATEGORIES = ["Odoo", "Accesos", "Equipo", "Red", "Correo", "Otro"];

let currentUser = null;
let csrf = "";
let tickets = [];
let appointments = [];
let users = [];
let toastTimer;

function notify(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3600);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysAhead(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return localDateKey(date);
}

function displayDate(value, options = { day: "numeric", month: "short" }) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return new Intl.DateTimeFormat("es-MX", options).format(date);
}

function ticketCode(id) {
  return `TI-${String(id).padStart(4, "0")}`;
}

function statusClass(status) {
  return `status-${status.toLowerCase().replaceAll(" ", "-")}`;
}

function priorityClass(priority) {
  return `priority-${priority.toLowerCase()}`;
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (["POST", "PATCH", "PUT", "DELETE"].includes(options.method)) headers.set("X-CSRF-Token", csrf);
  let response;
  try {
    response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  } catch {
    throw new Error("No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.");
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && currentUser) {
      currentUser = null;
      showLogin("Tu sesión terminó. Inicia sesión de nuevo.");
    }
    throw new Error(payload.error || `La solicitud falló (${response.status}).`);
  }
  return payload;
}

async function refreshCsrf() {
  const result = await request("/api/auth/csrf");
  csrf = result.csrfToken;
}

function showLogin(message = "") {
  document.querySelector("#login-screen").classList.remove("hidden");
  document.querySelector(".app-shell").classList.add("auth-hidden");
  const error = document.querySelector("#login-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function showApplication() {
  document.querySelector("#login-screen").classList.add("hidden");
  document.querySelector(".app-shell").classList.remove("auth-hidden");
  document.querySelector("#profile-name").textContent = currentUser.name;
  document.querySelector("#profile-role").textContent = currentUser.role === "admin" ? "Administrador TI" : currentUser.company;
  document.querySelector("#greeting-name").textContent = currentUser.name.split(/\s+/)[0];
  document.querySelectorAll(".admin-only").forEach((element) => element.classList.toggle("hidden", currentUser.role !== "admin"));
  document.querySelector("#company-filter").classList.toggle("hidden", currentUser.role !== "admin");
  document.querySelector("#agenda-scope").textContent = currentUser.role === "admin" ? "Todas las empresas" : "Tus solicitudes";
  const companySelects = [
    document.querySelector('#ticket-form [name="company"]'),
    document.querySelector('#appointment-form [name="company"]'),
  ];
  for (const select of companySelects) {
    const label = select.closest("label");
    label.classList.toggle("hidden", currentUser.role !== "admin");
    select.required = currentUser.role === "admin";
  }
}

async function loadData() {
  const [ticketResult, appointmentResult] = await Promise.all([
    request("/api/tickets"),
    request("/api/appointments"),
  ]);
  tickets = ticketResult.tickets;
  appointments = appointmentResult.appointments;
  if (currentUser.role === "admin") {
    const userResult = await request("/api/users");
    users = userResult.users;
  }
  render();
}

function ticketRow(ticket, includeCategory = false) {
  const category = includeCategory ? `<td>${escapeHtml(ticket.category)}</td>` : "";
  const requester = includeCategory ? `<td>${escapeHtml(ticket.requester)}</td>` : "";
  const company = includeCategory ? `<td>${escapeHtml(ticket.company)}</td>` : "";
  const status = currentUser.role === "admin"
    ? `<select class="ticket-status ${statusClass(ticket.status)}" data-ticket-status="${escapeHtml(ticket.id)}" aria-label="Estado de ${ticketCode(ticket.id)}">${STATUSES.map((value) => `<option${value === ticket.status ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select>`
    : `<span class="status ${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span>`;
  return `<tr>
    <td>${ticketCode(ticket.id)}</td>
    <td class="subject-cell" title="${escapeHtml(ticket.subject)}">${escapeHtml(ticket.subject)}</td>
    ${requester}${company}${category}
    <td><span class="priority ${priorityClass(ticket.priority)}">${escapeHtml(ticket.priority)}</span></td>
    <td>${status}</td>
  </tr>`;
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    counts[item[key]] = (counts[item[key]] || 0) + 1;
    return counts;
  }, {});
}

function renderMetrics() {
  const active = tickets.filter((ticket) => !["Resuelto", "Cerrado"].includes(ticket.status));
  const month = localDateKey(new Date()).slice(0, 7);
  const resolved = tickets.filter((ticket) => ["Resuelto", "Cerrado"].includes(ticket.status)
    && String(ticket.updated_at).slice(0, 7) === month).length;
  document.querySelector("#metric-open").textContent = active.length;
  document.querySelector("#metric-progress").textContent = tickets.filter((ticket) => ticket.status === "En revisión").length;
  document.querySelector("#metric-resolved").textContent = resolved;
  document.querySelector("#metric-appointments").textContent = appointments.filter((item) => item.status !== "Cancelada").length;
  document.querySelector("#nav-ticket-count").textContent = active.length;
}

function renderTickets() {
  const sorted = [...tickets].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  document.querySelector("#recent-tickets").innerHTML = sorted.slice(0, 4).map((ticket) => ticketRow(ticket)).join("");
  document.querySelector("#ticket-empty").classList.toggle("hidden", sorted.length > 0);

  const query = document.querySelector("#ticket-search").value.trim().toLocaleLowerCase("es");
  const company = document.querySelector("#company-filter").value;
  const status = document.querySelector("#status-filter").value;
  const filtered = sorted.filter((ticket) => {
    const searchText = `${ticketCode(ticket.id)} ${ticket.subject} ${ticket.company} ${ticket.category} ${ticket.module}`.toLocaleLowerCase("es");
    return (!query || searchText.includes(query)) && (!company || ticket.company === company) && (!status || ticket.status === status);
  });
  document.querySelector("#all-tickets").innerHTML = filtered.map((ticket) => ticketRow(ticket, true)).join("");
  document.querySelector("#filtered-empty").classList.toggle("hidden", filtered.length > 0);
}

function renderAppointments() {
  const upcoming = [...appointments].filter((item) => item.status !== "Cancelada")
    .sort((a, b) => `${String(a.date).slice(0, 10)} ${String(a.time).slice(0, 5)}`.localeCompare(`${String(b.date).slice(0, 10)} ${String(b.time).slice(0, 5)}`));
  document.querySelector("#appointment-list").innerHTML = upcoming.slice(0, 3).map((item) => {
    const day = displayDate(item.date, { day: "2-digit" });
    const month = displayDate(item.date, { month: "short" }).replace(".", "");
    return `<div class="appointment-item"><div class="date-tile"><strong>${day}</strong><span>${escapeHtml(month)}</span></div><div class="appointment-copy"><strong>${escapeHtml(item.subject)}</strong><span>${escapeHtml(String(item.time).slice(0, 5))} · ${escapeHtml(item.company)}</span></div></div>`;
  }).join("");
  document.querySelector("#agenda-list").innerHTML = upcoming.map((item) => {
    const day = displayDate(item.date, { day: "2-digit" });
    const month = displayDate(item.date, { month: "short" }).replace(".", "");
    return `<div class="agenda-row"><div class="agenda-date"><strong>${day}</strong><span>${escapeHtml(month)}</span></div><div class="agenda-title"><strong>${escapeHtml(item.subject)}</strong><span>${escapeHtml(item.topic)} · ${escapeHtml(item.requester)}</span></div><div class="agenda-company">${escapeHtml(item.company)}</div><div class="agenda-meta">${escapeHtml(String(item.time).slice(0, 5))} · ${escapeHtml(item.status)}</div></div>`;
  }).join("");
  document.querySelector("#agenda-empty").classList.toggle("hidden", upcoming.length > 0);
}

function renderAnalysis() {
  const period = document.querySelector("#analysis-period").value;
  const now = new Date();
  const today = localDateKey(now);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let caption = "Todo el registro visible";
  if (period === "week") {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    caption = "Desde el lunes de esta semana";
  } else if (period === "month") {
    start.setDate(1);
    caption = "Desde el inicio de este mes";
  }
  const startKey = localDateKey(start);
  const selected = period === "all" ? tickets : tickets.filter((ticket) => {
    const created = localDateKey(new Date(ticket.created_at));
    return created >= startKey && created <= today;
  });
  const companyCounts = countBy(selected, "company");
  const categoryCounts = countBy(selected, "category");
  const topCompany = Object.entries(companyCounts).sort((a, b) => b[1] - a[1])[0];
  const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
  document.querySelector("#analysis-total").textContent = selected.length;
  document.querySelector("#analysis-open").textContent = selected.filter((ticket) => !["Resuelto", "Cerrado"].includes(ticket.status)).length;
  document.querySelector("#analysis-company").textContent = topCompany?.[0] || "—";
  document.querySelector("#analysis-category").textContent = topCategory?.[0] || "—";
  document.querySelector("#analysis-period-caption").textContent = caption;
  const categories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...categories.map(([, count]) => count));
  document.querySelector("#category-breakdown").innerHTML = categories.map(([name, count]) => (
    `<div class="category-row"><span class="category-name">${escapeHtml(name)}</span><div class="category-track"><div class="category-fill" style="width:${Math.round((count / max) * 100)}%"></div></div><span class="category-count">${count}</span></div>`
  )).join("");
  document.querySelector("#analysis-empty").classList.toggle("hidden", categories.length > 0);
}

function renderChart() {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return localDateKey(date);
  });
  const colors = ["bar-bormine", "bar-didiamant", "bar-corpdiam"];
  document.querySelector("#chart-bars").innerHTML = days.map((day) => {
    const values = COMPANIES.map((company) => tickets.filter((ticket) => localDateKey(new Date(ticket.created_at)) === day && ticket.company === company).length);
    const bars = values.map((count, index) => `<i class="bar ${colors[index]}" style="height:${Math.max(count ? 4 : 0, (count / 12) * 100)}%"></i>`).join("");
    const label = new Intl.DateTimeFormat("es-MX", { weekday: "short" }).format(new Date(`${day}T12:00:00`)).replace(".", "");
    return `<div class="bar-group">${bars}<span class="bar-day">${escapeHtml(label)}</span></div>`;
  }).join("");
}

function renderUsers() {
  document.querySelector("#users-table").innerHTML = users.map((user) => {
    const active = Boolean(user.active);
    const action = Number(user.id) === Number(currentUser.id) ? "Tu cuenta" : `<button class="user-action" data-user-active="${escapeHtml(user.id)}" data-active="${!active}">${active ? "Desactivar" : "Activar"}</button>`;
    return `<tr><td class="subject-cell">${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.company || "Todas")}</td><td>${user.role === "admin" ? "Administrador" : "Colaborador"}</td><td><span class="user-status ${active ? "active" : "inactive"}">${active ? "Activo" : "Inactivo"}</span></td><td>${action}</td></tr>`;
  }).join("");
  document.querySelector("#users-empty").classList.toggle("hidden", users.length > 0);
}

function render() {
  renderMetrics();
  renderTickets();
  renderAppointments();
  renderAnalysis();
  renderChart();
  if (currentUser.role === "admin") renderUsers();
}

function setView(name) {
  const viewName = name === "usuarios" && currentUser.role !== "admin" ? "inicio" : name;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === viewName));
  const labels = { inicio: "Resumen", tickets: "Tickets", agenda: "Agenda", analisis: "Análisis", usuarios: "Usuarios" };
  document.querySelector("#breadcrumb-current").textContent = labels[viewName] || "Resumen";
}

function openDialog(selector) {
  document.querySelector(selector).showModal();
}

function closeDialog(dialog) {
  dialog.close();
}

async function signIn(email, password) {
  const result = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  csrf = result.csrfToken;
  currentUser = result.user;
  await loadData();
  showApplication();
}

async function initialize() {
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("es-MX", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  }).format(new Date());
  document.querySelector(".app-shell").classList.add("auth-hidden");
  try {
    await refreshCsrf();
    const result = await request("/api/auth/me");
    currentUser = result.user;
    await loadData();
    showApplication();
  } catch (error) {
    if (error.message.startsWith("No se pudo conectar")) {
      showLogin("El servidor no está disponible. Recarga esta página en unos momentos.");
      return;
    }
    try {
      await refreshCsrf();
      showLogin();
    } catch (connectionError) {
      console.error("No fue posible iniciar una sesión contra la API de Nexo TI.", error, connectionError);
      showLogin("No se pudo conectar con el servicio de soporte. Comprueba que esté desplegado y recarga la página.");
    }
  }
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const submit = formElement.querySelector('[type="submit"]');
  const error = document.querySelector("#login-error");
  error.classList.add("hidden");
  submit.disabled = true;
  try {
    await signIn(form.get("email").trim(), form.get("password"));
    formElement.reset();
    setView("inicio");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await request("/api/auth/logout", { method: "POST" });
    currentUser = null;
    tickets = [];
    appointments = [];
    csrf = "";
    await refreshCsrf();
    showLogin("Sesión cerrada.");
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#open-password-modal").addEventListener("click", () => {
  document.querySelector("#password-error").classList.add("hidden");
  openDialog("#password-modal");
});

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const newPassword = form.get("newPassword");
  const error = document.querySelector("#password-error");
  const submit = formElement.querySelector('[type="submit"]');
  error.classList.add("hidden");
  if (newPassword !== form.get("confirmPassword")) {
    error.textContent = "Las contraseñas nuevas no coinciden.";
    error.classList.remove("hidden");
    return;
  }
  submit.disabled = true;
  try {
    const result = await request("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword }),
    });
    csrf = result.csrfToken;
    formElement.reset();
    closeDialog(document.querySelector("#password-modal"));
    notify("Contraseña actualizada; se cerraron las demás sesiones.");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => setView(link.dataset.view)));
document.querySelectorAll("[data-view-link]").forEach((link) => link.addEventListener("click", () => setView(link.dataset.viewLink)));
document.querySelectorAll("[data-open-ticket]").forEach((button) => button.addEventListener("click", () => openDialog("#ticket-modal")));
document.querySelectorAll("[data-open-appointment]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector('#appointment-form [name="date"]').min = daysAhead(0);
  openDialog("#appointment-modal");
}));
document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog(dialog);
}));
document.querySelector("#ticket-search").addEventListener("input", renderTickets);
document.querySelector("#company-filter").addEventListener("change", renderTickets);
document.querySelector("#status-filter").addEventListener("change", renderTickets);
document.querySelector("#analysis-period").addEventListener("change", renderAnalysis);

document.querySelector("#ticket-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const result = await request("/api/tickets", {
      method: "POST",
      body: JSON.stringify({
        subject: form.get("subject"),
        company: currentUser.role === "admin" ? form.get("company") : currentUser.company,
        priority: form.get("priority"),
        category: form.get("category"),
        module: form.get("module"),
        description: form.get("description"),
      }),
    });
    tickets.unshift(result.ticket);
    formElement.reset();
    closeDialog(document.querySelector("#ticket-modal"));
    render();
    setView("tickets");
    notify(`Ticket ${ticketCode(result.ticket.id)} creado.`);
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#all-tickets").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-ticket-status]");
  if (!select) return;
  select.disabled = true;
  try {
    const result = await request(`/api/tickets/${encodeURIComponent(select.dataset.ticketStatus)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value }),
    });
    const ticket = tickets.find((item) => Number(item.id) === Number(result.ticket.id));
    if (ticket) ticket.status = result.ticket.status;
    render();
    notify("Estado del ticket actualizado.");
  } catch (error) {
    notify(error.message);
    render();
  }
});

document.querySelector("#appointment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const result = await request("/api/appointments", {
      method: "POST",
      body: JSON.stringify({
        subject: form.get("subject"),
        company: currentUser.role === "admin" ? form.get("company") : currentUser.company,
        topic: form.get("topic"),
        date: form.get("date"),
        time: form.get("time"),
        notes: form.get("notes"),
      }),
    });
    appointments.push(result.appointment);
    formElement.reset();
    closeDialog(document.querySelector("#appointment-modal"));
    render();
    setView("agenda");
    notify("Solicitud registrada. La hora aún está pendiente de confirmación.");
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#open-user-modal").addEventListener("click", () => {
  document.querySelector("#user-error").classList.add("hidden");
  openDialog("#user-modal");
});

document.querySelector('#user-form [name="role"]').addEventListener("change", (event) => {
  const company = document.querySelector('#user-form [name="company"]');
  const label = document.querySelector("#user-company-label");
  const isEmployee = event.target.value === "user";
  label.classList.toggle("hidden", !isEmployee);
  company.required = isEmployee;
  if (!isEmployee) company.value = "";
});

document.querySelector("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const error = document.querySelector("#user-error");
  const submit = formElement.querySelector('[type="submit"]');
  error.classList.add("hidden");
  submit.disabled = true;
  try {
    const result = await request("/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        company: form.get("role") === "admin" ? null : form.get("company"),
        role: form.get("role"),
        password: form.get("password"),
      }),
    });
    users.unshift(result.user);
    formElement.reset();
    formElement.querySelector('[name="role"]').dispatchEvent(new Event("change"));
    closeDialog(document.querySelector("#user-modal"));
    renderUsers();
    notify("Cuenta creada. Comparte las credenciales por un canal seguro.");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#users-table").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-user-active]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await request(`/api/users/${encodeURIComponent(button.dataset.userActive)}/active`, {
      method: "PATCH",
      body: JSON.stringify({ active: button.dataset.active === "true" }),
    });
    const index = users.findIndex((user) => Number(user.id) === Number(result.user.id));
    if (index >= 0) users[index] = result.user;
    renderUsers();
    notify(result.user.active ? "Cuenta reactivada." : "Cuenta desactivada.");
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
});

document.querySelector("#help-button").addEventListener("click", () => notify("La base de conocimiento estará disponible en una siguiente etapa."));

initialize();
