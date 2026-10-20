"use strict";

const COMPANIES = ["Bormine", "Didiamant", "Corpdiam"];
const STATUSES = ["Nuevo", "En revisión", "En espera", "Resuelto", "Cerrado"];
const PRIORITIES = ["Baja", "Normal", "Alta", "Urgente"];
const CATEGORIES = ["Odoo", "Accesos", "Equipo", "Red", "Correo", "Otro"];

let currentUser = null;
let csrf = "";
let selectedCompany = "";
let summary = null;
let summaryRequestId = 0;
let ticketPageRows = [];
let ticketPage = 1;
let ticketPageCount = 0;
let ticketTotal = 0;
let ticketPageRequestId = 0;
let appointmentPageRows = [];
let appointmentPage = 1;
let appointmentPageCount = 0;
let appointmentTotal = 0;
let appointmentPageRequestId = 0;
let ticketDetail = null;
let slaMetrics = null;
let users = [];
let resources = [];
let editingResourceId = null;
let selectedResourceImage = null;
let notifications = [];
let unreadNotificationCount = 0;
let knownNotificationIds = new Set();
let toastTimer;
let liveSource = null;
let liveRefreshTimer;
let liveReconnectTimer;
let notificationPollTimer;
let audioContext = null;
let soundEnabled = readNotificationSoundPreference();

function readNotificationSoundPreference() {
  try {
    return localStorage.getItem("nexo-notification-sound") !== "off";
  } catch (error) {
    console.warn("No se pudo leer la preferencia de sonido de notificaciones.", error);
    return true;
  }
}

function readThemePreference() {
  try {
    return localStorage.getItem("nexo-theme") === "dark";
  } catch (error) {
    console.warn("No se pudo leer la preferencia de tema.", error);
    return false;
  }
}

function applyTheme(isDark) {
  const theme = isDark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#171923" : "#f5f7fb";
  const toggle = document.querySelector("#theme-toggle");
  toggle.textContent = isDark ? "☀" : "☾";
  toggle.setAttribute("aria-pressed", String(isDark));
  toggle.setAttribute("aria-label", isDark ? "Activar modo claro" : "Activar modo oscuro");
  toggle.title = isDark ? "Activar modo claro" : "Activar modo oscuro";
}

let darkMode = readThemePreference();
applyTheme(darkMode);

function notify(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3600);
}

function updateNotificationControls() {
  const badge = document.querySelector("#notification-count");
  badge.textContent = unreadNotificationCount > 99 ? "99+" : String(unreadNotificationCount);
  badge.classList.toggle("hidden", unreadNotificationCount === 0);
  document.querySelector("#notification-summary").textContent = unreadNotificationCount
    ? `${unreadNotificationCount} sin leer`
    : "Al día";
  const soundToggle = document.querySelector("#notification-sound-toggle");
  soundToggle.textContent = soundEnabled ? "Activado" : "Desactivado";
  soundToggle.setAttribute("aria-pressed", String(soundEnabled));
}

function renderNotifications() {
  document.querySelector("#notification-list").innerHTML = notifications.length
    ? notifications.map((item) => {
      const destination = item.entity_type === "appointment" ? "agenda" : "tickets";
      const date = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(item.created_at));
      return `<button class="notification-item${item.read_at ? "" : " notification-unread"}" data-notification-id="${escapeHtml(item.id)}" data-notification-view="${destination}" type="button">
        <span class="notification-dot" aria-hidden="true"></span><span class="notification-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span><small>${escapeHtml(date)}</small></span>
      </button>`;
    }).join("")
    : '<p class="notification-empty">Aún no tienes notificaciones.</p>';
  updateNotificationControls();
}

async function loadNotifications(announce = false) {
  const result = await request("/api/notifications");
  const newUnread = result.notifications.filter((item) => !item.read_at && !knownNotificationIds.has(String(item.id)));
  result.notifications.forEach((item) => knownNotificationIds.add(String(item.id)));
  notifications = result.notifications;
  unreadNotificationCount = result.unreadCount;
  renderNotifications();
  if (announce && newUnread.length) playNotificationSound();
}

function initializeNotificationAudio() {
  if (!soundEnabled) return;
  if (audioContext) {
    if (audioContext.state === "suspended") audioContext.resume();
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume();
}

function playNotificationSound() {
  if (!soundEnabled) return;
  initializeNotificationAudio();
  if (!audioContext) return;
  if (audioContext.state === "suspended") {
    audioContext.resume().then(() => {
      if (soundEnabled && audioContext.state === "running") scheduleNotificationPop();
    }).catch((error) => console.warn("No se pudo activar el sonido de notificaciones.", error));
    return;
  }
  if (audioContext.state === "running") scheduleNotificationPop();
}

function scheduleNotificationPop() {
  const oscillator = audioContext.createOscillator();
  const volume = audioContext.createGain();
  const start = audioContext.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, start);
  oscillator.frequency.exponentialRampToValueAtTime(560, start + 0.11);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
  oscillator.connect(volume);
  volume.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.17);
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

async function openTicketDetail(ticketId) {
  const result = await request(`/api/tickets/${encodeURIComponent(ticketId)}`);
  ticketDetail = result;
  const ticket = result.ticket;
  document.querySelector("#ticket-detail-title").textContent = `${ticketCode(ticket.id)} · ${ticket.subject}`;
  document.querySelector("#ticket-detail-summary").innerHTML = `<div class="ticket-detail-summary">
    <div><strong>Estado y prioridad</strong>${escapeHtml(ticket.status)} · ${escapeHtml(ticket.priority)}</div>
    <div><strong>Empresa y categoría</strong>${escapeHtml(ticket.company)} · ${escapeHtml(ticket.category)}</div>
    <div><strong>Solicitante</strong>${escapeHtml(ticket.requester)} · ${escapeHtml(ticket.email)}</div>
    <div><strong>Creado</strong>${escapeHtml(formatTicketTimestamp(ticket.created_at))}</div>
    <div><strong>Tiempo a primera respuesta</strong>${escapeHtml(formatSlaDuration(ticket.first_response_at
      ? Math.floor((new Date(ticket.first_response_at) - new Date(ticket.created_at)) / 60000)
      : null))}</div>
    <div><strong>Tiempo a resolución</strong>${escapeHtml(formatSlaDuration(ticket.resolved_at
      ? Math.floor((new Date(ticket.resolved_at) - new Date(ticket.created_at)) / 60000)
      : null))}</div>
    <div><strong>Causa raíz</strong>${escapeHtml(ticket.root_cause || "Aún no documentada")}</div>
    <div class="ticket-detail-description"><strong>Descripción</strong>${escapeHtml(ticket.description)}</div>
  </div>`;
  const assigneeLabel = document.querySelector("#ticket-assignee-label");
  assigneeLabel.classList.toggle("hidden", currentUser.role !== "admin");
  if (currentUser.role === "admin") {
    document.querySelector("#ticket-assignee").innerHTML = `<option value="">Sin asignar</option>${users
      .filter((user) => user.role === "admin" && user.active)
      .map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`).join("")}`;
    document.querySelector("#ticket-assignee").value = ticket.assigned_to || "";
    document.querySelector("#ticket-root-cause").value = ticket.root_cause || "";
  }
  document.querySelector("#ticket-comments").innerHTML = result.comments.length
    ? result.comments.map((comment) => `<article class="ticket-comment"><header><strong>${escapeHtml(comment.author)}${comment.author_role === "admin" ? " · TI" : ""}</strong><time>${escapeHtml(formatTicketTimestamp(comment.created_at))}</time></header>${escapeHtml(comment.comment)}</article>`).join("")
    : '<p class="modal-description">Aún no hay comentarios en este ticket.</p>';
  document.querySelector("#ticket-attachments").innerHTML = result.attachments.length
    ? result.attachments.map((attachment) => `<div class="ticket-attachment"><a href="/api/tickets/${encodeURIComponent(ticket.id)}/attachments/${encodeURIComponent(attachment.id)}">${escapeHtml(attachment.file_name)}</a><span>${escapeHtml((attachment.size / 1024 / 1024).toFixed(2))} MB · ${escapeHtml(attachment.uploaded_by)}</span></div>`).join("")
    : '<p class="modal-description">No hay archivos adjuntos.</p>';
  const attachmentLimitReached = result.attachments.length >= 5;
  document.querySelector("#ticket-file").disabled = attachmentLimitReached;
  document.querySelector('#ticket-attachment-form [type="submit"]').disabled = attachmentLimitReached;
  const historyItems = [
    ...result.events.filter((item) => item.event_type !== "comment_added").map((item) => ({
      message: item.event_type === "status_changed" ? `Estado actualizado a ${item.detail}`
        : item.event_type === "assigned" ? item.detail
          : item.event_type === "attachment_added" ? item.detail
            : item.detail,
      actor: item.actor,
      created_at: item.created_at,
    })),
    ...result.comments.map((item) => ({ message: "Comentario agregado", actor: item.author, created_at: item.created_at })),
  ].sort((left, right) => new Date(left.created_at) - new Date(right.created_at));
  document.querySelector("#ticket-history").innerHTML = historyItems.length
    ? historyItems.map((item) => `<li>${escapeHtml(item.actor)} · ${escapeHtml(item.message)}<time>${escapeHtml(formatTicketTimestamp(item.created_at))}</time></li>`).join("")
    : "<li>No hay actividad registrada.</li>";
  document.querySelector("#ticket-comment").value = "";
  openDialog("#ticket-detail-modal");
}

function statusClass(status) {
  return `status-${status.toLowerCase().replaceAll(" ", "-")}`;
}

function formatTicketTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Hora no disponible";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatTicketElapsed(createdAt, updatedAt, status, now = Date.now()) {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return "Tiempo no disponible";
  const isFinished = ["Resuelto", "Cerrado"].includes(status);
  const finished = isFinished ? new Date(updatedAt || createdAt).getTime() : now;
  if (Number.isNaN(finished)) return "Tiempo no disponible";
  const totalMinutes = Math.floor(Math.max(0, finished - created) / 60000);
  if (totalMinutes < 60) return `${isFinished ? "Resuelto en" : "Abierto hace"} ${totalMinutes} min`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${isFinished ? "Resuelto en" : "Abierto hace"} ${totalHours} h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${isFinished ? "Resuelto en" : "Abierto hace"} ${days} d${hours ? ` ${hours} h` : ""}`;
}

function formatSlaDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return "—";
  const totalMinutes = Math.max(0, Number(minutes));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${hours} h${totalMinutes % 60 ? ` ${totalMinutes % 60} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

function updateTicketAgeLabels() {
  document.querySelectorAll("[data-ticket-age]").forEach((label) => {
    label.textContent = formatTicketElapsed(
      label.dataset.ticketCreated,
      label.dataset.ticketUpdated,
      label.dataset.ticketStatus,
    );
  });
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
  window.clearTimeout(liveReconnectTimer);
  window.clearTimeout(liveRefreshTimer);
  window.clearInterval(notificationPollTimer);
  liveSource?.close();
  liveSource = null;
  document.querySelector("#login-screen").classList.remove("hidden");
  document.querySelector(".app-shell").classList.add("auth-hidden");
  const error = document.querySelector("#login-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function showApplication() {
  document.querySelector("#login-screen").classList.add("hidden");
  document.querySelector(".app-shell").classList.remove("auth-hidden");
  if (currentUser.role !== "admin") {
    users = [];
    document.querySelector("#users-table").replaceChildren();
    document.querySelector("#users-empty").classList.add("hidden");
    if (document.querySelector("#view-usuarios").classList.contains("active")) setView("inicio");
  }
  document.querySelector("#profile-name").textContent = currentUser.name;
  document.querySelector("#profile-role").textContent = currentUser.role === "admin"
    ? "Administrador TI"
    : (currentUser.companies || [currentUser.company]).join(", ");
  document.querySelector("#greeting-name").textContent = currentUser.name.split(/\s+/)[0];
  document.querySelectorAll(".admin-only").forEach((element) => element.classList.toggle("hidden", currentUser.role !== "admin"));
  document.querySelector("#company-filter").classList.toggle("hidden", currentUser.role !== "admin");
  const assignedCompanies = currentUser.role === "admin" ? COMPANIES : currentUser.companies || [currentUser.company];
  const scopeControl = document.querySelector("#company-scope-control");
  const scopeSelect = document.querySelector("#company-scope");
  if (currentUser.role === "admin" || !assignedCompanies.includes(selectedCompany)) selectedCompany = "";
  scopeSelect.innerHTML = `<option value="">Todas mis empresas</option>${assignedCompanies.map((company) => `<option value="${escapeHtml(company)}">${escapeHtml(company)}</option>`).join("")}`;
  scopeSelect.value = selectedCompany;
  scopeControl.classList.toggle("hidden", currentUser.role === "admin" || assignedCompanies.length < 2);
  if (currentUser.role !== "admin") document.querySelector("#company-filter").value = "";
  document.querySelector("#agenda-scope").textContent = currentUser.role === "admin"
    ? "Todas las empresas"
    : "Empresas asignadas";
  const companySelects = [
    document.querySelector('#ticket-form [name="company"]'),
    document.querySelector('#appointment-form [name="company"]'),
  ];
  for (const select of companySelects) {
    const label = select.closest("label");
    select.innerHTML = `<option value="">Selecciona una empresa</option>${assignedCompanies.map((company) => `<option>${escapeHtml(company)}</option>`).join("")}`;
    select.required = true;
    select.value = selectedCompany || (assignedCompanies.length === 1 ? assignedCompanies[0] : "");
    label.classList.toggle("hidden", assignedCompanies.length === 1);
  }
}

async function loadData() {
  const resourceResult = await request(`/api/resources${currentUser.role === "admin" ? "?includeInactive=true" : ""}`);
  resources = resourceResult.resources;
  if (currentUser.role === "admin") {
    const userResult = await request("/api/users");
    users = userResult.users;
  }
  await Promise.all([loadSummary(), loadTicketPage(), loadAppointmentPage(), loadSlaMetrics()]);
  render();
}

async function loadTicketPage() {
  const requestId = ++ticketPageRequestId;
  const params = new URLSearchParams({ page: String(ticketPage), limit: "25" });
  const search = document.querySelector("#ticket-search").value.trim();
  const company = selectedCompany || document.querySelector("#company-filter").value;
  const status = document.querySelector("#status-filter").value;
  if (search) params.set("search", search);
  if (company) params.set("company", company);
  if (status) params.set("status", status);
  const result = await request(`/api/tickets?${params}`);
  if (requestId !== ticketPageRequestId) return;
  if (result.pages === 0 && ticketPage !== 1) {
    ticketPage = 1;
    return loadTicketPage();
  }
  if (result.pages > 0 && ticketPage > result.pages) {
    ticketPage = result.pages;
    return loadTicketPage();
  }
  ticketPageRows = result.tickets;
  ticketTotal = result.total;
  ticketPageCount = result.pages;
  renderTicketPage();
}

async function loadAppointmentPage() {
  const requestId = ++appointmentPageRequestId;
  const params = new URLSearchParams({ page: String(appointmentPage), limit: "25" });
  if (selectedCompany) params.set("company", selectedCompany);
  const result = await request(`/api/appointments?${params}`);
  if (requestId !== appointmentPageRequestId) return;
  if (result.pages === 0 && appointmentPage !== 1) {
    appointmentPage = 1;
    return loadAppointmentPage();
  }
  if (result.pages > 0 && appointmentPage > result.pages) {
    appointmentPage = result.pages;
    return loadAppointmentPage();
  }
  appointmentPageRows = result.appointments;
  appointmentTotal = result.total;
  appointmentPageCount = result.pages;
  renderAppointments();
}

async function loadSummary() {
  const requestId = ++summaryRequestId;
  const params = new URLSearchParams({ period: document.querySelector("#analysis-period").value });
  if (selectedCompany) params.set("company", selectedCompany);
  const result = await request(`/api/summary?${params}`);
  if (requestId !== summaryRequestId) return;
  summary = result;
  render();
}

async function loadSlaMetrics() {
  const params = new URLSearchParams({ period: document.querySelector("#analysis-period").value });
  if (selectedCompany) params.set("company", selectedCompany);
  const result = await request(`/api/tickets/metrics?${params}`);
  slaMetrics = result.metrics;
  renderSlaMetrics();
}

function renderSlaMetrics() {
  if (!slaMetrics) return;
  document.querySelector("#sla-response").textContent = formatSlaDuration(slaMetrics.average_response_minutes);
  document.querySelector("#sla-resolution").textContent = formatSlaDuration(slaMetrics.average_resolution_minutes);
  document.querySelector("#sla-awaiting").textContent = slaMetrics.awaiting_response;
  document.querySelector("#sla-total").textContent = slaMetrics.total;
}

function ticketRow(ticket, includeCategory = false) {
  const category = includeCategory ? `<td>${escapeHtml(ticket.category)}</td>` : "";
  const requester = includeCategory ? `<td>${escapeHtml(ticket.requester)}</td>` : "";
  const company = `<td>${escapeHtml(ticket.company)}</td>`;
  const status = currentUser.role === "admin"
    ? `<select class="ticket-status ${statusClass(ticket.status)}" data-ticket-status="${escapeHtml(ticket.id)}" aria-label="Estado de ${ticketCode(ticket.id)}">${STATUSES.map((value) => `<option${value === ticket.status ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select>`
    : `<span class="status ${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span>`;
  return `<tr>
    <td><span class="ticket-code">${ticketCode(ticket.id)}</span><time class="ticket-created" datetime="${escapeHtml(ticket.created_at)}" title="Fecha y hora de registro">${escapeHtml(formatTicketTimestamp(ticket.created_at))}</time><span class="ticket-age" data-ticket-age data-ticket-created="${escapeHtml(ticket.created_at)}" data-ticket-updated="${escapeHtml(ticket.resolved_at || ticket.updated_at || ticket.created_at)}" data-ticket-status="${escapeHtml(ticket.status)}">${escapeHtml(formatTicketElapsed(ticket.created_at, ticket.resolved_at || ticket.updated_at, ticket.status))}</span></td>
    <td class="subject-cell" title="${escapeHtml(ticket.subject)}"><button class="ticket-subject-link" type="button" data-ticket-open="${escapeHtml(ticket.id)}">${escapeHtml(ticket.subject)}</button></td>
    ${requester}${company}${category}
    <td><span class="priority ${priorityClass(ticket.priority)}">${escapeHtml(ticket.priority)}</span></td>
    <td>${status}</td>
    ${includeCategory ? `<td>${escapeHtml(ticket.assignee || "Sin asignar")}</td><td><button class="button button-outline ticket-open-button" type="button" data-ticket-open="${escapeHtml(ticket.id)}">Abrir</button></td>` : ""}
  </tr>`;
}

function renderMetrics() {
  if (!summary) return;
  const { tickets: ticketSummary, appointments: appointmentSummary } = summary;
  document.querySelector("#metric-open").textContent = ticketSummary.open;
  document.querySelector("#metric-progress").textContent = ticketSummary.in_review;
  document.querySelector("#metric-resolved").textContent = ticketSummary.resolved_this_month;
  document.querySelector("#metric-appointments").textContent = appointmentSummary.active;
  document.querySelector("#nav-ticket-count").textContent = ticketSummary.open;
  const appointmentCount = currentUser.role === "admin" ? appointmentSummary.pending : appointmentSummary.active;
  const appointmentBadge = document.querySelector("#nav-appointment-count");
  appointmentBadge.textContent = appointmentCount > 99 ? "99+" : String(appointmentCount);
  appointmentBadge.classList.toggle("hidden", appointmentCount === 0);
}

function renderTickets() {
  const recent = summary?.tickets.recent || [];
  document.querySelector("#recent-tickets").innerHTML = recent.map((ticket) => ticketRow(ticket)).join("");
  document.querySelector("#ticket-empty").classList.toggle("hidden", recent.length > 0);
  renderTicketPage();
  updateTicketAgeLabels();
}

function renderTicketPage() {
  document.querySelector("#all-tickets").innerHTML = ticketPageRows.map((ticket) => ticketRow(ticket, true)).join("");
  document.querySelector("#filtered-empty").classList.toggle("hidden", ticketTotal > 0);
  const pagination = document.querySelector("#ticket-pagination");
  pagination.classList.toggle("hidden", ticketPageCount <= 1);
  document.querySelector("#ticket-page-label").textContent = `${ticketTotal} tickets · Página ${ticketPage} de ${Math.max(ticketPageCount, 1)}`;
  document.querySelector("#ticket-page-previous").disabled = ticketPage <= 1;
  document.querySelector("#ticket-page-next").disabled = ticketPageCount === 0 || ticketPage >= ticketPageCount;
  updateTicketAgeLabels();
}

async function updateTicketStatus(event) {
  const select = event.target.closest("[data-ticket-status]");
  if (!select) return;
  select.disabled = true;
  try {
    const result = await request(`/api/tickets/${encodeURIComponent(select.dataset.ticketStatus)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value }),
    });
    const paginatedTicket = ticketPageRows.find((item) => Number(item.id) === Number(result.ticket.id));
    if (paginatedTicket) {
      paginatedTicket.status = result.ticket.status;
      paginatedTicket.updated_at = result.ticket.updated_at;
      paginatedTicket.resolved_at = result.ticket.resolved_at;
    }
    await Promise.all([loadSummary(), loadTicketPage(), loadSlaMetrics()]);
    notify("Estado del ticket actualizado.");
  } catch (error) {
    notify(error.message);
    renderTicketPage();
  }
}

function renderAppointments() {
  document.querySelector("#appointment-list").innerHTML = (summary?.appointments.upcoming || []).map((item) => {
    const day = displayDate(item.date, { day: "2-digit" });
    const month = displayDate(item.date, { month: "short" }).replace(".", "");
    return `<div class="appointment-item"><div class="date-tile"><strong>${day}</strong><span>${escapeHtml(month)}</span></div><div class="appointment-copy"><strong>${escapeHtml(item.subject)}</strong><span>${escapeHtml(String(item.time).slice(0, 5))} · ${escapeHtml(item.company)}</span></div></div>`;
  }).join("");
  document.querySelector("#agenda-list").innerHTML = appointmentPageRows.map((item) => {
    const day = displayDate(item.date, { day: "2-digit" });
    const month = displayDate(item.date, { month: "short" }).replace(".", "");
    const status = currentUser.role === "admin"
      ? `<select class="ticket-status appointment-status" data-appointment-status="${escapeHtml(item.id)}" aria-label="Cambiar estado de la solicitud de ${escapeHtml(item.requester)}">${["Pendiente", "Confirmada", "Cancelada"].map((value) => `<option${value === item.status ? " selected" : ""}>${value}</option>`).join("")}</select>`
      : `<span class="appointment-state">${escapeHtml(item.status)}</span>`;
    return `<div class="agenda-row"><div class="agenda-date"><strong>${day}</strong><span>${escapeHtml(month)}</span></div><div class="agenda-title"><strong>${escapeHtml(item.subject)}</strong><span>Solicitó: ${escapeHtml(item.requester)} · ${escapeHtml(item.email)} · ${escapeHtml(item.topic)}</span></div><div class="agenda-company">${escapeHtml(item.company)}</div><div class="agenda-meta">${escapeHtml(String(item.time).slice(0, 5))} · ${status}</div></div>`;
  }).join("");
  document.querySelector("#agenda-empty").classList.toggle("hidden", appointmentTotal > 0);
  const pagination = document.querySelector("#appointment-pagination");
  pagination.classList.toggle("hidden", appointmentPageCount <= 1);
  document.querySelector("#appointment-page-label").textContent = `${appointmentTotal} solicitudes · Página ${appointmentPage} de ${Math.max(appointmentPageCount, 1)}`;
  document.querySelector("#appointment-page-previous").disabled = appointmentPage <= 1;
  document.querySelector("#appointment-page-next").disabled = appointmentPageCount === 0 || appointmentPage >= appointmentPageCount;
}

function renderAnalysis() {
  if (!summary) return;
  const period = document.querySelector("#analysis-period").value;
  const caption = { all: "Todo el registro visible", week: "Desde el lunes de esta semana", month: "Desde el inicio de este mes" }[period];
  const { analysis } = summary;
  document.querySelector("#analysis-total").textContent = analysis.total;
  document.querySelector("#analysis-open").textContent = analysis.open;
  document.querySelector("#analysis-company").textContent = analysis.byCompany[0]?.name || "—";
  document.querySelector("#analysis-category").textContent = analysis.byCategory[0]?.name || "—";
  document.querySelector("#analysis-period-caption").textContent = caption;
  const max = Math.max(1, ...analysis.byCategory.map(({ count }) => count));
  document.querySelector("#category-breakdown").innerHTML = analysis.byCategory.map(({ name, count }) => (
    `<div class="category-row"><span class="category-name">${escapeHtml(name)}</span><div class="category-track"><div class="category-fill" style="width:${Math.round((count / max) * 100)}%"></div></div><span class="category-count">${count}</span></div>`
  )).join("");
  document.querySelector("#analysis-empty").classList.toggle("hidden", analysis.byCategory.length > 0);
}

function renderChart() {
  if (!summary) return;
  const colors = ["bar-bormine", "bar-didiamant", "bar-corpdiam"];
  const colorsByCompany = Object.fromEntries(COMPANIES.map((company, index) => [company, colors[index]]));
  document.querySelector("#chart-bars").innerHTML = summary.chart.days.map((day) => {
    const bars = COMPANIES.map((company) => {
      const count = selectedCompany && company !== selectedCompany
        ? 0
        : summary.chart.counts.find((row) => row.day === day && row.company === company)?.count || 0;
      return `<i class="bar ${colorsByCompany[company]}" style="height:${Math.max(count ? 4 : 0, (count / 12) * 100)}%"></i>`;
    }).join("");
    const label = new Intl.DateTimeFormat("es-MX", { weekday: "short" }).format(new Date(`${day}T12:00:00`)).replace(".", "");
    return `<div class="bar-group">${bars}<span class="bar-day">${escapeHtml(label)}</span></div>`;
  }).join("");
}

function renderUsers() {
  document.querySelector("#users-table").innerHTML = users.map((user) => {
    const active = Boolean(user.active);
    const isCurrentUser = Number(user.id) === Number(currentUser.id);
    const companies = user.companies || (user.company ? [user.company] : []);
    const accessAction = isCurrentUser ? "Tu cuenta" : `<button class="user-action" data-user-active="${escapeHtml(user.id)}" data-active="${!active}">${active ? "Desactivar" : "Activar"}</button>`;
    return `<tr><td class="subject-cell">${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.role === "admin" ? "Todas" : companies.join(", "))}</td><td>${user.role === "admin" ? "Administrador" : "Colaborador"}</td><td><span class="user-status ${active ? "active" : "inactive"}">${active ? "Activo" : "Inactivo"}</span></td><td><button class="user-action" data-user-edit="${escapeHtml(user.id)}" aria-label="Editar cuenta de ${escapeHtml(user.name)}">Editar</button>${isCurrentUser ? accessAction : `<button class="user-action" data-user-active="${escapeHtml(user.id)}" data-active="${!active}" aria-label="${active ? "Desactivar" : "Activar"} cuenta de ${escapeHtml(user.name)}">${active ? "Desactivar" : "Activar"}</button>`}</td></tr>`;
  }).join("");
  document.querySelector("#users-empty").classList.toggle("hidden", users.length > 0);
}

function renderResources() {
  const query = document.querySelector("#resource-search").value.trim().toLocaleLowerCase("es");
  const category = document.querySelector("#resource-category-filter").value;
  const type = document.querySelector("#resource-type-filter").value;
  const filtered = resources.filter((resource) => {
    const content = `${resource.title} ${resource.description} ${resource.category} ${resource.resource_type} ${resource.company || ""}`.toLocaleLowerCase("es");
    return (!query || content.includes(query))
      && (!category || resource.category === category)
      && (!type || resource.resource_type === type)
      && (!selectedCompany || !resource.company || resource.company === selectedCompany);
  });
  document.querySelector("#resource-grid").innerHTML = filtered.map((resource) => {
    const archived = !resource.active;
    const company = resource.company || "Todas las empresas";
    const archiveAction = currentUser.role === "admin"
      ? `<button class="resource-archive" data-resource-active="${escapeHtml(resource.id)}" data-active="${archived}">${archived ? "Reactivar" : "Archivar"}</button>`
      : "";
    const editAction = currentUser.role === "admin"
      ? `<button class="resource-edit" data-resource-edit="${escapeHtml(resource.id)}" type="button">Editar</button>`
      : "";
    const image = resource.has_image
      ? `<img class="resource-cover" src="/api/resources/${encodeURIComponent(resource.id)}/image" alt="Portada: ${escapeHtml(resource.title)}" loading="lazy">`
      : "";
    return `<article class="resource-card${archived ? " resource-archived" : ""}">
      ${image}
      <div class="resource-card-top"><span class="resource-type">${escapeHtml(resource.resource_type)}</span><span class="resource-category">${escapeHtml(resource.category)}</span></div>
      <h2>${escapeHtml(resource.title)}</h2>
      <p>${escapeHtml(resource.description || "Abre este recurso en Google Drive.")}</p>
      <div class="resource-card-bottom"><span>${escapeHtml(company)}</span><span class="resource-actions">${editAction}${archiveAction}</span></div>
      ${archived ? '<span class="resource-archived-label">Archivado · solo visible para administradores</span>' : ""}
      <a class="resource-open" href="${escapeHtml(resource.url)}" target="_blank" rel="noopener noreferrer">Abrir en Google Drive <span aria-hidden="true">↗</span></a>
    </article>`;
  }).join("");
  document.querySelector("#resources-empty").classList.toggle("hidden", filtered.length > 0);
}

function render() {
  renderMetrics();
  renderTickets();
  renderAppointments();
  renderAnalysis();
  renderChart();
  renderResources();
  if (currentUser.role === "admin") renderUsers();
}

function setView(name) {
  const viewName = name === "usuarios" && currentUser.role !== "admin" ? "inicio" : name;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === viewName));
  document.querySelector(".top-new-ticket").classList.toggle("hidden", viewName === "tickets");
  const labels = { inicio: "Resumen", tickets: "Tickets", agenda: "Agenda", recursos: "Guías y soluciones", analisis: "Análisis", usuarios: "Usuarios" };
  document.querySelector("#breadcrumb-current").textContent = labels[viewName] || "Resumen";
}

function openDialog(selector) {
  const dialog = document.querySelector(selector);
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "");
  dialog.setAttribute("aria-modal", "true");
  dialog.classList.add("modal-fallback-open");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  dialog.removeAttribute("aria-modal");
  dialog.classList.remove("modal-fallback-open");
}

function connectLiveUpdates() {
  liveSource?.close();
  liveSource = new EventSource("/api/events");
  liveSource.addEventListener("refresh", (event) => {
    const { entity } = JSON.parse(event.data);
    if (entity === "notifications") {
      loadNotifications(true).catch((error) => notify(error.message));
      return;
    }
    window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = window.setTimeout(() => {
      const refresh = async () => {
        if (entity === "users") {
          const result = await request("/api/auth/me");
          currentUser = result.user;
          const companies = currentUser.role === "admin" ? [] : currentUser.companies || [currentUser.company];
          if (!companies.includes(selectedCompany)) selectedCompany = "";
          if (currentUser.role !== "admin") document.querySelector("#company-filter").value = "";
        }
        await loadData();
        showApplication();
      };
      refresh().catch((error) => {
        if (!error.message.includes("401")) notify(error.message);
      });
    }, 200);
  });
  liveSource.onerror = () => {
    if (liveSource?.readyState !== EventSource.CLOSED) return;
    liveSource = null;
    request("/api/auth/me").then(connectLiveUpdates).catch((error) => {
      if (currentUser && !error.message.startsWith("No se pudo conectar")) notify(error.message);
      if (currentUser) {
        liveReconnectTimer = window.setTimeout(connectLiveUpdates, 5000);
      }
    });
  };
  window.clearInterval(notificationPollTimer);
  notificationPollTimer = window.setInterval(() => {
    loadNotifications(true).catch((error) => notify(error.message));
  }, 60000);
}

async function signIn(email, password) {
  const result = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  csrf = result.csrfToken;
  currentUser = result.user;
  selectedCompany = "";
  ticketPage = 1;
  appointmentPage = 1;
  document.querySelector("#company-filter").value = "";
  await loadData();
  await loadNotifications();
  showApplication();
  connectLiveUpdates();
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
    selectedCompany = "";
    ticketPage = 1;
    appointmentPage = 1;
    document.querySelector("#company-filter").value = "";
    await loadData();
    await loadNotifications();
    showApplication();
    connectLiveUpdates();
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
    window.clearInterval(notificationPollTimer);
    liveSource?.close();
    liveSource = null;
    currentUser = null;
    summary = null;
    notifications = [];
    unreadNotificationCount = 0;
    knownNotificationIds.clear();
    renderNotifications();
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
document.querySelectorAll("#recent-tickets, #all-tickets").forEach((tableBody) => tableBody.addEventListener("click", (event) => {
  const button = event.target.closest("[data-ticket-open]");
  if (!button) return;
  openTicketDetail(button.dataset.ticketOpen).catch((error) => notify(error.message));
}));
document.querySelectorAll("[data-open-appointment]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector('#appointment-form [name="date"]').min = daysAhead(0);
  openDialog("#appointment-modal");
}));
document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog(dialog);
}));
document.querySelector("#ticket-search").addEventListener("input", () => {
  ticketPage = 1;
  loadTicketPage().catch((error) => notify(error.message));
});
document.querySelector("#company-filter").addEventListener("change", () => {
  ticketPage = 1;
  loadTicketPage().catch((error) => notify(error.message));
});
document.querySelector("#company-scope").addEventListener("change", (event) => {
  selectedCompany = event.currentTarget.value;
  summary = null;
  ticketPageRows = [];
  ticketTotal = 0;
  ticketPageCount = 0;
  appointmentPageRows = [];
  appointmentTotal = 0;
  appointmentPageCount = 0;
  document.querySelectorAll('#ticket-form [name="company"], #appointment-form [name="company"]').forEach((select) => {
    select.value = selectedCompany;
  });
  render();
  ticketPage = 1;
  appointmentPage = 1;
  loadSummary().catch((error) => notify(error.message));
  loadTicketPage().catch((error) => notify(error.message));
  loadAppointmentPage().catch((error) => notify(error.message));
  loadSlaMetrics().catch((error) => notify(error.message));
});
document.querySelector("#status-filter").addEventListener("change", () => {
  ticketPage = 1;
  loadTicketPage().catch((error) => notify(error.message));
});
document.querySelector("#ticket-page-previous").addEventListener("click", () => {
  if (ticketPage <= 1) return;
  ticketPage -= 1;
  loadTicketPage().catch((error) => notify(error.message));
});
document.querySelector("#ticket-page-next").addEventListener("click", () => {
  if (ticketPage >= ticketPageCount) return;
  ticketPage += 1;
  loadTicketPage().catch((error) => notify(error.message));
});
document.querySelector("#appointment-page-previous").addEventListener("click", () => {
  if (appointmentPage <= 1) return;
  appointmentPage -= 1;
  loadAppointmentPage().catch((error) => notify(error.message));
});
document.querySelector("#appointment-page-next").addEventListener("click", () => {
  if (appointmentPage >= appointmentPageCount) return;
  appointmentPage += 1;
  loadAppointmentPage().catch((error) => notify(error.message));
});
document.querySelector("#analysis-period").addEventListener("change", () => {
  loadSummary().catch((error) => notify(error.message));
  loadSlaMetrics().catch((error) => notify(error.message));
});
window.setInterval(updateTicketAgeLabels, 60000);

document.querySelector("#theme-toggle").addEventListener("click", () => {
  darkMode = !darkMode;
  applyTheme(darkMode);
  try {
    localStorage.setItem("nexo-theme", darkMode ? "dark" : "light");
  } catch (error) {
    console.warn("No se pudo guardar la preferencia de tema.", error);
    notify("El tema elegido solo durará hasta que cierres esta pestaña.");
  }
});

document.addEventListener("pointerdown", initializeNotificationAudio, { once: true });
document.addEventListener("keydown", initializeNotificationAudio, { once: true });

document.querySelector("#notification-toggle").addEventListener("click", () => {
  const panel = document.querySelector("#notification-panel");
  const open = panel.classList.toggle("hidden") === false;
  document.querySelector("#notification-toggle").setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (event.target.closest(".notification-center")) return;
  document.querySelector("#notification-panel").classList.add("hidden");
  document.querySelector("#notification-toggle").setAttribute("aria-expanded", "false");
});

document.querySelector("#notification-sound-toggle").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  try {
    localStorage.setItem("nexo-notification-sound", soundEnabled ? "on" : "off");
  } catch (error) {
    console.warn("No se pudo guardar la preferencia de sonido de notificaciones.", error);
    notify("El cambio de sonido solo durará hasta que cierres esta pestaña.");
  }
  if (soundEnabled) {
    initializeNotificationAudio();
    playNotificationSound();
  }
  updateNotificationControls();
});

document.querySelector("#notification-read-all").addEventListener("click", async () => {
  try {
    await request("/api/notifications/read-all", { method: "PATCH" });
    notifications = notifications.map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() }));
    unreadNotificationCount = 0;
    renderNotifications();
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#notification-list").addEventListener("click", async (event) => {
  const itemButton = event.target.closest("[data-notification-id]");
  if (!itemButton) return;
  const notification = notifications.find((item) => String(item.id) === itemButton.dataset.notificationId);
  if (!notification) return;
  try {
    if (!notification.read_at) {
      await request(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: "PATCH" });
      notification.read_at = new Date().toISOString();
      unreadNotificationCount = Math.max(0, unreadNotificationCount - 1);
      renderNotifications();
    }
    setView(itemButton.dataset.notificationView);
    document.querySelector("#notification-panel").classList.add("hidden");
    document.querySelector("#notification-toggle").setAttribute("aria-expanded", "false");
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#ticket-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const result = await request("/api/tickets", {
      method: "POST",
      body: JSON.stringify({
        subject: form.get("subject"),
        company: form.get("company"),
        priority: form.get("priority"),
        category: form.get("category"),
        module: form.get("module"),
        description: form.get("description"),
      }),
    });
    ticketPage = 1;
    formElement.reset();
    closeDialog(document.querySelector("#ticket-modal"));
    await Promise.all([loadSummary(), loadTicketPage(), loadSlaMetrics()]);
    setView("tickets");
    notify(`Ticket ${ticketCode(result.ticket.id)} creado.`);
  } catch (error) {
    notify(error.message);
  }
});

document.querySelectorAll("#recent-tickets, #all-tickets").forEach((tableBody) => {
  tableBody.addEventListener("change", updateTicketStatus);
});

document.querySelector("#agenda-list").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-appointment-status]");
  if (!select) return;
  select.disabled = true;
  try {
    const result = await request(`/api/appointments/${encodeURIComponent(select.dataset.appointmentStatus)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value }),
    });
    const pageAppointment = appointmentPageRows.find((item) => Number(item.id) === Number(result.appointment.id));
    if (pageAppointment) pageAppointment.status = result.appointment.status;
    await Promise.all([loadSummary(), loadAppointmentPage()]);
    notify("Estado de la solicitud actualizado.");
  } catch (error) {
    notify(error.message);
    renderAppointments();
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
        company: form.get("company"),
        topic: form.get("topic"),
        date: form.get("date"),
        time: form.get("time"),
        notes: form.get("notes"),
      }),
    });
    appointmentPage = 1;
    formElement.reset();
    closeDialog(document.querySelector("#appointment-modal"));
    await Promise.all([loadSummary(), loadAppointmentPage()]);
    setView("agenda");
    notify("Solicitud registrada. La hora aún está pendiente de confirmación.");
  } catch (error) {
    notify(error.message);
  }
});

document.querySelector("#ticket-assignee").addEventListener("change", async (event) => {
  if (!ticketDetail) return;
  const select = event.currentTarget;
  select.disabled = true;
  try {
    await request(`/api/tickets/${encodeURIComponent(ticketDetail.ticket.id)}/assignee`, {
      method: "PATCH",
      body: JSON.stringify({ assignedTo: select.value || null }),
    });
    const { id } = ticketDetail.ticket;
    ticketDetail = null;
    await openTicketDetail(id);
    notify("Responsable actualizado.");
  } catch (error) {
    notify(error.message);
  } finally {
    select.disabled = false;
  }
});

document.querySelector("#ticket-root-cause-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ticketDetail) return;
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await request(`/api/tickets/${encodeURIComponent(ticketDetail.ticket.id)}/root-cause`, {
      method: "PATCH",
      body: JSON.stringify({ rootCause: new FormData(form).get("rootCause") }),
    });
    const { id } = ticketDetail.ticket;
    await openTicketDetail(id);
    notify("Causa raíz guardada.");
  } catch (error) {
    notify(error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#ticket-comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ticketDetail) return;
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await request(`/api/tickets/${encodeURIComponent(ticketDetail.ticket.id)}/comments`, {
      method: "POST",
      body: JSON.stringify({ comment: new FormData(form).get("comment") }),
    });
    await openTicketDetail(ticketDetail.ticket.id);
  } catch (error) {
    notify(error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#ticket-attachment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ticketDetail) return;
  const form = event.currentTarget;
  const file = document.querySelector("#ticket-file").files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    notify("El archivo supera el límite de 10 MB.");
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("No se pudo leer el archivo.")));
      reader.addEventListener("error", () => reject(new Error("No se pudo leer el archivo seleccionado.")));
      reader.readAsDataURL(file);
    });
    await request(`/api/tickets/${encodeURIComponent(ticketDetail.ticket.id)}/attachments`, {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, mimeType: file.type, data }),
    });
    const { id } = ticketDetail.ticket;
    form.reset();
    await openTicketDetail(id);
    notify("Archivo adjuntado.");
  } catch (error) {
    notify(error.message);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#open-user-modal").addEventListener("click", () => {
  document.querySelector("#user-error").classList.add("hidden");
  const form = document.querySelector("#user-form");
  form.reset();
  form.querySelector('[name="role"]').dispatchEvent(new Event("change"));
  openDialog("#user-modal");
});

function updateCompanyFieldset(form, fieldsetId) {
  const fieldset = document.querySelector(fieldsetId);
  const isEmployee = form.querySelector('[name="role"]').value === "user";
  fieldset.classList.toggle("hidden", !isEmployee);
  if (!isEmployee) fieldset.querySelectorAll('[name="companies"]').forEach((checkbox) => { checkbox.checked = false; });
}

function selectUserCompanies(form, companies) {
  form.querySelectorAll('[name="companies"]').forEach((checkbox) => {
    checkbox.checked = companies.includes(checkbox.value);
  });
}

document.querySelector('#user-form [name="role"]').addEventListener("change", () => {
  const form = document.querySelector("#user-form");
  const isEmployee = form.querySelector('[name="role"]').value === "user";
  updateCompanyFieldset(form, "#user-companies-field");
  if (!isEmployee) selectUserCompanies(form, []);
});

document.querySelector("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const error = document.querySelector("#user-error");
  const submit = formElement.querySelector('[type="submit"]');
  const companies = form.getAll("companies");
  error.classList.add("hidden");
  if (form.get("role") === "user" && companies.length === 0) {
    error.textContent = "Selecciona al menos una empresa para el colaborador.";
    error.classList.remove("hidden");
    return;
  }
  submit.disabled = true;
  try {
    const result = await request("/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        companies: form.get("role") === "admin" ? [] : companies,
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
  const editButton = event.target.closest("[data-user-edit]");
  if (editButton) {
    const user = users.find((item) => Number(item.id) === Number(editButton.dataset.userEdit));
    if (!user) return;
    const form = document.querySelector("#edit-user-form");
    const isCurrentUser = Number(user.id) === Number(currentUser.id);
    form.reset();
    form.querySelector('[name="name"]').value = user.name;
    form.querySelector('[name="email"]').value = user.email;
    form.querySelector('[name="role"]').value = user.role;
    selectUserCompanies(form, user.companies || (user.company ? [user.company] : []));
    updateCompanyFieldset(form, "#edit-user-companies-field");
    form.querySelector('[name="password"]').disabled = isCurrentUser;
    document.querySelector("#edit-user-password-label").classList.toggle("hidden", isCurrentUser);
    document.querySelector("#edit-user-error").classList.add("hidden");
    form.dataset.userId = user.id;
    openDialog("#edit-user-modal");
    return;
  }
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

document.querySelector('#edit-user-form [name="role"]').addEventListener("change", (event) => {
  updateCompanyFieldset(event.currentTarget.form, "#edit-user-companies-field");
});

document.querySelector("#edit-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const error = document.querySelector("#edit-user-error");
  const submit = formElement.querySelector('[type="submit"]');
  const companies = form.getAll("companies");
  error.classList.add("hidden");
  if (form.get("role") === "user" && companies.length === 0) {
    error.textContent = "Selecciona al menos una empresa para el colaborador.";
    error.classList.remove("hidden");
    return;
  }
  submit.disabled = true;
  try {
    const result = await request(`/api/users/${encodeURIComponent(formElement.dataset.userId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        role: form.get("role"),
        companies: form.get("role") === "admin" ? [] : companies,
        password: form.get("password"),
      }),
    });
    const index = users.findIndex((user) => Number(user.id) === Number(result.user.id));
    if (index >= 0) users[index] = result.user;
    closeDialog(document.querySelector("#edit-user-modal"));
    renderUsers();
    notify(result.passwordChanged
      ? "Cuenta actualizada. Se cerraron sus sesiones; comparte la nueva contraseña por un canal seguro."
      : "Datos de la cuenta actualizados.");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#resource-search").addEventListener("input", renderResources);
document.querySelector("#resource-category-filter").addEventListener("change", renderResources);
document.querySelector("#resource-type-filter").addEventListener("change", renderResources);
document.querySelector("#help-button").addEventListener("click", () => setView("recursos"));

document.querySelector("#open-resource-modal").addEventListener("click", () => {
  openResourceEditor();
});

function setResourcePreview(source, alt = "Vista previa de la imagen del recurso") {
  const image = document.querySelector("#resource-image-preview");
  const placeholder = document.querySelector("#resource-image-placeholder");
  image.classList.toggle("hidden", !source);
  placeholder.classList.toggle("hidden", Boolean(source));
  if (source) {
    image.src = source;
    image.alt = alt;
  } else {
    image.removeAttribute("src");
  }
}

function openResourceEditor(resource = null) {
  const form = document.querySelector("#resource-form");
  const removeImageLabel = document.querySelector("#resource-remove-image-label");
  editingResourceId = resource ? String(resource.id) : null;
  selectedResourceImage = null;
  form.reset();
  document.querySelector("#resource-error").classList.add("hidden");
  document.querySelector("#resource-modal-title").textContent = resource ? "Editar recurso" : "Agregar recurso";
  document.querySelector("#resource-submit").textContent = resource ? "Guardar cambios" : "Publicar recurso";
  removeImageLabel.classList.toggle("hidden", !resource?.has_image);
  if (resource) {
    form.elements.title.value = resource.title;
    form.elements.url.value = resource.url;
    form.elements.description.value = resource.description || "";
    form.elements.type.value = resource.resource_type;
    form.elements.category.value = resource.category;
    form.elements.company.value = resource.company || "";
    if (resource.has_image) setResourcePreview(`/api/resources/${encodeURIComponent(resource.id)}/image`, `Portada actual: ${resource.title}`);
    else setResourcePreview("");
  } else {
    setResourcePreview("");
  }
  openDialog("#resource-modal");
}

document.querySelector('#resource-form [name="image"]').addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files[0];
  const error = document.querySelector("#resource-error");
  const resource = resources.find((item) => String(item.id) === editingResourceId);
  const restoreSavedImage = () => {
    selectedResourceImage = null;
    if (resource?.has_image) setResourcePreview(`/api/resources/${encodeURIComponent(resource.id)}/image`, `Portada actual: ${resource.title}`);
    else setResourcePreview("");
  };
  error.classList.add("hidden");
  if (!file) {
    restoreSavedImage();
    return;
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
    input.value = "";
    restoreSavedImage();
    error.textContent = "Selecciona una imagen JPG, PNG o WebP de máximo 2 MB.";
    error.classList.remove("hidden");
    return;
  }
  document.querySelector('#resource-form [name="removeImage"]').checked = false;
  const submit = document.querySelector("#resource-submit");
  input.disabled = true;
  submit.disabled = true;
  try {
    selectedResourceImage = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("No se pudo interpretar la imagen seleccionada.")));
      reader.addEventListener("error", () => reject(new Error("No se pudo leer la imagen seleccionada.")));
      reader.readAsDataURL(file);
    });
    setResourcePreview(selectedResourceImage, `Vista previa: ${file.name}`);
  } catch (readError) {
    input.value = "";
    restoreSavedImage();
    error.textContent = readError.message;
    error.classList.remove("hidden");
  } finally {
    input.disabled = false;
    submit.disabled = false;
  }
});

document.querySelector('#resource-form [name="removeImage"]').addEventListener("change", (event) => {
  if (event.currentTarget.checked) {
    document.querySelector('#resource-form [name="image"]').value = "";
    selectedResourceImage = null;
    setResourcePreview("");
  }
  else {
    const resource = resources.find((item) => String(item.id) === editingResourceId);
    if (resource?.has_image) setResourcePreview(`/api/resources/${encodeURIComponent(resource.id)}/image`, `Portada actual: ${resource.title}`);
  }
});

document.querySelector("#resource-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const error = document.querySelector("#resource-error");
  const submit = formElement.querySelector('[type="submit"]');
  error.classList.add("hidden");
  submit.disabled = true;
  try {
    const payload = {
      title: form.get("title"),
      url: form.get("url"),
      description: form.get("description"),
      type: form.get("type"),
      category: form.get("category"),
      company: form.get("company"),
    };
    if (selectedResourceImage) payload.image = selectedResourceImage;
    if (editingResourceId && form.get("removeImage") === "on") payload.removeImage = true;
    const isEditing = Boolean(editingResourceId);
    const result = await request(isEditing
      ? `/api/resources/${encodeURIComponent(editingResourceId)}`
      : "/api/resources", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    const existingIndex = resources.findIndex((item) => Number(item.id) === Number(result.resource.id));
    if (existingIndex >= 0) resources[existingIndex] = result.resource;
    else resources.push(result.resource);
    formElement.reset();
    editingResourceId = null;
    selectedResourceImage = null;
    setResourcePreview("");
    closeDialog(document.querySelector("#resource-modal"));
    renderResources();
    setView("recursos");
    notify(isEditing ? "Recurso actualizado." : "Recurso publicado. Se abrirá en Google Drive.");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#resource-grid").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-resource-edit]");
  if (editButton) {
    const resource = resources.find((item) => String(item.id) === editButton.dataset.resourceEdit);
    if (resource) openResourceEditor(resource);
    return;
  }
  const button = event.target.closest("[data-resource-active]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await request(`/api/resources/${encodeURIComponent(button.dataset.resourceActive)}/active`, {
      method: "PATCH",
      body: JSON.stringify({ active: button.dataset.active === "true" }),
    });
    const resource = resources.find((item) => Number(item.id) === Number(result.resource.id));
    if (resource) resource.active = result.resource.active;
    renderResources();
    notify(result.resource.active ? "Recurso reactivado." : "Recurso archivado.");
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
});

initialize();
