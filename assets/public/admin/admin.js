"use strict";

/* ---------- tiny helpers ---------- */

const API = "/api/v9";
const SNOWFLAKE_EPOCH = 1420070400000n;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// everything interpolated into html`` is escaped unless wrapped in raw()
class Raw {
  constructor(value) {
    this.value = value;
  }
}
const raw = (value) => new Raw(value);
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const renderValue = (value) => {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (value === false || value === null || value === undefined) return "";
  return escapeHtml(value);
};
const html = (strings, ...values) =>
  raw(
    strings.reduce(
      (out, str, i) => out + str + (i < values.length ? renderValue(values[i]) : ""),
      "",
    ),
  );
const mount = (el, content) => {
  el.innerHTML = renderValue(content);
  return el;
};

const snowflakeDate = (id) => {
  try {
    return new Date(Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH));
  } catch {
    return null;
  }
};
const fmtDate = (value) => {
  const d = value instanceof Date ? value : value ? new Date(value) : null;
  return d && !isNaN(d)
    ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
};
const fmtDay = (value) => {
  const d = value instanceof Date ? value : value ? new Date(value) : null;
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
};
const fmtNumber = (n) => Number(n ?? 0).toLocaleString();
const fmtDuration = (seconds) => {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
// datetime-local inputs work in local time without a zone
const toLocalInput = (value) => {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

const debounce = (fn, ms = 250) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const toast = (message, kind = "ok") => {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = message;
  const container = $("#toasts");
  container.append(el);
  while (container.children.length > 3) container.firstElementChild.remove();
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
};

const userName = (u) => (u ? u.global_name || u.username || u.id : "—");
const userTag = (u) =>
  u
    ? u.discriminator && u.discriminator !== "0"
      ? `${u.username}#${u.discriminator}`
      : `@${u.username}`
    : "";

const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const defaultAvatarIndex = (u) => {
  try {
    return u.discriminator && u.discriminator !== "0"
      ? Number(u.discriminator) % 5
      : Number((BigInt(u.id) >> 22n) % 6n);
  } catch {
    return 0;
  }
};

const avatar = (u, cls = "") =>
  !u
    ? html`<span class="avatar ${cls}">${initials(userName(u))}</span>`
    : u.avatar
      ? html`<img class="avatar ${cls}" src="/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=128" alt="" loading="lazy" />`
      : html`<img class="avatar ${cls}" src="/embed/avatars/${defaultAvatarIndex(u)}.png" alt="" loading="lazy" />`;

// a server tag the way it looks next to a name: badge icon + tag text
const tagChip = (guildId, tag, badgeHash) =>
  html`<span class="tag-chip small">${badgeHash ? html`<img src="/clan-badges/${guildId}/${badgeHash}.png?size=32" alt="" />` : ""}${tag}</span>`;

const guildIcon = (g, cls = "") =>
  g?.icon
    ? html`<img class="avatar square ${cls}" src="/icons/${g.id}/${g.icon}.${g.icon.startsWith("a_") ? "gif" : "png"}?size=128" alt="" loading="lazy" />`
    : html`<span class="avatar square ${cls}">${initials(g?.name)}</span>`;

/* ---------- auth + api ---------- */

const auth = {
  get token() {
    try {
      const own = localStorage.getItem("admin_token");
      if (own) return own;
      // reuse the web client's session on the same origin, unless the dashboard was explicitly signed out of
      if (sessionStorage.getItem("admin_skip_client")) return null;
      const client = localStorage.getItem("token");
      return client ? JSON.parse(client) : null;
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      localStorage.setItem("admin_token", token);
      sessionStorage.removeItem("admin_skip_client");
    } catch {
      /* storage blocked: the session just won't survive a reload */
    }
    this.memory = token;
  },
  clear({ skipClient = false } = {}) {
    try {
      localStorage.removeItem("admin_token");
      if (skipClient) sessionStorage.setItem("admin_skip_client", "1");
    } catch {
      /* ignore */
    }
    this.memory = null;
  },
  memory: null,
};
const currentToken = () => auth.memory || auth.token;

class ApiError extends Error {
  constructor(status, body) {
    super(
      status >= 500
        ? "Something went wrong on the server. Try again in a moment."
        : describeError(body) || `Request failed (${status})`,
    );
    this.status = status;
    this.body = body;
  }
}

function describeError(body) {
  if (!body || typeof body !== "object") return null;
  const fieldErrors = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node._errors))
      node._errors.forEach((e) => fieldErrors.push(`${path}: ${e.message}`));
    for (const [k, v] of Object.entries(node))
      if (k !== "_errors") walk(v, path ? `${path}.${k}` : k);
  };
  walk(body.errors, "");
  return fieldErrors.length ? fieldErrors.join("; ") : body.message;
}

let pageRequests = new AbortController();

async function api(
  path,
  { method = "GET", body, auth: useAuth = true, signal: requestSignal } = {},
) {
  // FormData goes as multipart, and the browser sets its content type with the boundary
  const signal =
    method === "GET"
      ? requestSignal
        ? AbortSignal.any([pageRequests.signal, requestSignal])
        : pageRequests.signal
      : requestSignal;
  const multipart = body instanceof FormData;
  const headers = {};
  if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
  if (useAuth && currentToken()) headers.Authorization = currentToken();
  const res = await fetch(API + path, {
    method,
    headers,
    signal,
    body: body !== undefined && !multipart ? JSON.stringify(body) : body,
  }).catch((error) => {
    if (signal?.aborted) throw new ApiError(499, { message: "Navigation changed" });
    throw new ApiError(0, {
      message: "Couldn't reach the server. Check your connection and try again.",
    });
  });
  const text = await res.text();
  if (signal?.aborted) throw new ApiError(499, { message: "Navigation changed" });
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (res.status === 401 && useAuth) {
    auth.clear();
    showLogin("Your session expired. Sign in again.");
    throw new ApiError(res.status, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// run an action, surfacing errors as toasts and disabling the trigger meanwhile
const formEditVersions = new WeakMap();
const formControlValues = new WeakMap();
async function act(button, fn, success) {
  const form = button?.closest("form");
  const editVersion = form && formEditVersions.get(form);
  if (button) button.disabled = true;
  try {
    const result = await fn();
    if (success) {
      if (form && formEditVersions.get(form) === editVersion) delete form.dataset.dirty;
      toast(success);
    }
    return result;
  } catch (e) {
    if (e.status !== 401 && e.status !== 499) toast(e.message, "error");
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- constants ---------- */

const RIGHTS = [
  ["OPERATOR", 0, "Full access to everything"],
  ["MANAGE_GUILDS", 2, "Manage every server"],
  ["MANAGE_MESSAGES", 3, "Edit/delete any visible message"],
  ["MANAGE_USERS", 7, "Manage users from this dashboard"],
  ["BYPASS_RATE_LIMITS", 9, "Not rate limited"],
  ["CREATE_GUILDS", 14, "Create servers"],
  ["CREATE_INVITES", 15, "Create mass invites"],
  ["JOIN_GUILDS", 19, "Join servers"],
  ["SELF_ADD_REACTIONS", 21, "Add reactions"],
  ["SELF_DELETE_MESSAGES", 22, "Delete own messages"],
  ["SELF_EDIT_MESSAGES", 23, "Edit own messages"],
  ["SEND_MESSAGES", 25, "Send messages"],
  ["KICK_BAN_MEMBERS", 33, "Kick/ban in servers they moderate"],
  ["SELF_LEAVE_GROUPS", 34, "Leave group DMs"],
  ["PRESENCE", 35, "Presence routing override"],
  ["SEND_BACKDATED_EVENTS", 42, "Send backdated events"],
  ["USE_MASS_INVITES", 43, "Accept mass invites"],
];
const hasRight = (rights, bit) => {
  try {
    return (BigInt(rights || 0) & (1n << BigInt(bit))) !== 0n;
  } catch {
    return false;
  }
};

const GUILD_FEATURES = [
  "VERIFIED",
  "PARTNERED",
  "DISCOVERABLE",
  "COMMUNITY",
  "NEWS",
  "VANITY_URL",
  "INVITE_SPLASH",
  "BANNER",
  "ANIMATED_ICON",
  "ANIMATED_BANNER",
  "WELCOME_SCREEN_ENABLED",
  "MEMBER_VERIFICATION_GATE_ENABLED",
  "PREVIEW_ENABLED",
  "ROLE_ICONS",
  "INTERNAL_EMPLOYEE_ONLY",
];

const USER_TAGS = [
  ["none", "No tag", "Bot accounts still show the regular BOT tag."],
  ["verified_bot", "Verified Bot", "The blurple ✓ BOT tag. Only shows on bot accounts."],
  ["ai", "AI", "The green AI tag, for any account."],
  ["verified_ai", "Verified AI", "The green ✓ AI tag, for any account."],
  [
    "official",
    "Official",
    "The blurple ✓ OFFICIAL tag that Discord puts on its own messages, for any account.",
  ],
  ["system", "System", "The blurple ✓ SYSTEM tag, for any account."],
];

// mirrors how the patched web client draws the tag next to a name
const nameTag = (tag, isBot) => {
  if (tag === "official" || tag === "system")
    return html`<span class="name-tag" title="Official message">${raw(CHECK_ICON)}${tag === "official" ? "OFFICIAL" : "SYSTEM"}</span>`;
  const verified = tag === "verified_bot" || tag === "verified_ai";
  const ai = tag === "ai" || tag === "verified_ai";
  if (!ai && !isBot)
    return html`
      <span class="muted">no tag</span>
    `;
  return html`<span class="name-tag ${ai ? "ai" : ""}" title="${verified ? (ai ? "Verified AI" : "Verified Bot") : ""}"
        >${verified ? raw(CHECK_ICON) : ""}${ai ? "AI" : "BOT"}</span
    >`;
};
const CHECK_ICON =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M18.7 7.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4l3.3 3.29 7.3-7.3a1 1 0 0 1 1.4 0Z"/></svg>';

const badgeIcon = (b) =>
  html`<img class="badge-icon" src="/badge-icons/${b.icon}.png" alt="" loading="lazy" />`;

const STANDINGS = [
  [100, "All good", "ok"],
  [200, "Limited", "warn"],
  [300, "Very limited", "warn"],
  [400, "At risk", "danger"],
  [500, "Suspended", "danger"],
];
const standingOf = (state) => STANDINGS.find(([v]) => v === state) ?? STANDINGS[0];

const VIOLATION_TYPES = [
  [3030, "Spam"],
  [290, "Harassment and bullying"],
  [320, "Hateful conduct"],
  [220, "Hate speech"],
  [210, "Glorifying violence"],
  [3010, "Malicious conduct"],
  [711, "Impersonation"],
  [720, "Ban evasion"],
  [4010, "Fraud"],
  [250, "Social engineering"],
  [240, "Illicit goods"],
  [230, "Cracked accounts"],
  [100, "Unsolicited adult content"],
  [4000, "Non-consensual adult content"],
  [5305, "Doxxing"],
  [5440, "Copyright infringement"],
  [280, "Child safety"],
  [5090, "Self-harm"],
  [5411, "Underage user"],
  [1, "Other"],
];
const violationType = (id) => VIOLATION_TYPES.find(([v]) => v === id)?.[1] ?? `Type ${id}`;

const VIOLATION_ACTIONS = [
  [4, "Warning"],
  [9, "Limited access"],
  [1, "Temporary ban"],
  [0, "Ban"],
  [2, "Quarantine"],
  [3, "Verification required"],
  [13, "Content removed"],
  [16, "Messages removed"],
  [14, "Username reset"],
  [22, "Profile reset"],
  [5, "Marked as spammer"],
];
const APPEAL_REASONS = [
  "They didn't break the rules",
  "The decision was too strict or unfair",
  "They disagree with the penalty",
  "Something else",
];

const violationAction = (id) => VIOLATION_ACTIONS.find(([v]) => v === id)?.[1] ?? `Action ${id}`;

const VIOLATION_DURATIONS = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [180, "180 days"],
  [365, "1 year"],
  ["", "Permanent"],
];

const COMPONENT_STATUSES = [
  ["operational", "Operational", "ok"],
  ["degraded_performance", "Degraded performance", "warn"],
  ["partial_outage", "Partial outage", "warn"],
  ["major_outage", "Major outage", "danger"],
  ["under_maintenance", "Under maintenance", "info"],
];
const componentStatus = (key) =>
  COMPONENT_STATUSES.find(([k]) => k === key) ?? COMPONENT_STATUSES[0];

const IMPACTS = [
  ["none", "None", ""],
  ["minor", "Minor", "warn"],
  ["major", "Major", "danger"],
  ["critical", "Critical", "danger"],
];
const INCIDENT_STATES = [
  ["investigating", "Investigating"],
  ["identified", "Identified"],
  ["monitoring", "Monitoring"],
  ["resolved", "Resolved"],
];
const MAINTENANCE_STATES = [
  ["scheduled", "Scheduled"],
  ["in_progress", "In progress"],
  ["verifying", "Verifying"],
  ["completed", "Completed"],
];
const RESOLVED = ["resolved", "completed"];
const stateLabel = (key) =>
  [...INCIDENT_STATES, ...MAINTENANCE_STATES].find(([k]) => k === key)?.[1] ?? key;
const stateBadge = (key) =>
  html`<span class="badge ${RESOLVED.includes(key) ? "ok" : key === "scheduled" ? "info" : "warn"}">${stateLabel(key)}</span>`;
const impactBadge = (incident) =>
  incident.impact === "maintenance"
    ? html`
        <span class="badge info">Maintenance</span>
      `
    : html`<span class="badge ${IMPACTS.find(([k]) => k === incident.impact)?.[2] ?? ""}"
              >${IMPACTS.find(([k]) => k === incident.impact)?.[1] ?? incident.impact} impact</span
          >`;

const options = (list, selected) =>
  list.map(
    ([value, label]) =>
      html`<option value="${value}" ${String(value) === String(selected) ? raw("selected") : ""}>${label}</option>`,
  );

/* ---------- shell ---------- */

const state = { overview: null, me: null };

function showLogin(message) {
  pageRequests.abort();
  pageRequests = new AbortController();
  state.overview = null;
  state.me = null;
  $("#app").hidden = true;
  $("#login").hidden = false;
  closeDrawer({ discard: true });
  $("#view").replaceChildren();
  $("#me").replaceChildren();
  const err = $("#login-error");
  err.hidden = !message;
  err.textContent = message || "";
  $("#login-form input[name=login]").focus();
}

function syncBrandIcon() {
  const image = state.overview.instance.image;
  const icon = $(".sidebar .brand-icon");
  if (!image || icon?.getAttribute("src") === image) return;
  icon?.replaceWith(
    Object.assign(document.createElement("img"), { className: "brand-icon", src: image, alt: "" }),
  );
}

async function boot() {
  if (!currentToken()) return showLogin();
  try {
    const [overview, me] = await Promise.all([api("/admin"), api("/users/@me")]);
    state.overview = overview;
    state.me = me;
  } catch (e) {
    if (e.status === 401) return;
    if (e.status === 403 || e.body?.code === 50013) {
      auth.clear();
      return showLogin("This account doesn't have admin rights on this instance.");
    }
    return showLogin(e.message);
  }

  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#brand-name").textContent = state.overview.instance.name;
  document.title = `${state.overview.instance.name} Admin`;
  syncBrandIcon();
  mount(
    $("#me"),
    html`${avatar(state.me)}
            <div class="ident">
                <div><strong>${userName(state.me)}</strong><span class="muted">${userTag(state.me)}</span></div>
            </div>`,
  );
  filterNavigation();
  syncNavCounts();
  route();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = $("button[type=submit]", form);
  const data = Object.fromEntries(new FormData(form));
  const err = $("#login-error");
  err.hidden = true;
  button.disabled = true;
  try {
    let result;
    if (form.dataset.ticket)
      result = await api("/auth/mfa/totp", {
        method: "POST",
        body: { code: data.code, ticket: form.dataset.ticket },
        auth: false,
      });
    else
      result = await api("/auth/login", {
        method: "POST",
        body: { login: data.login, password: data.password, undelete: false },
        auth: false,
      });

    if (result.mfa && result.ticket) {
      form.dataset.ticket = result.ticket;
      $("#mfa-field").hidden = false;
      $("#mfa-field input").required = true;
      $("#mfa-field input").focus();
      return;
    }
    if (!result.token)
      throw new Error(
        "This account needs a sign-in method this page doesn't support (security key).",
      );
    auth.set(result.token);
    delete form.dataset.ticket;
    form.reset();
    $("#mfa-field").hidden = true;
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$("#logout").addEventListener("click", () => {
  // only drops the dashboard's session; the web client stays signed in
  auth.clear({ skipClient: true });
  state.overview = null;
  showLogin();
});

/* ---------- router ---------- */

const TABS = {
  overview: renderOverview,
  settings: renderSettings,
  users: renderUsers,
  badges: renderBadges,
  experiments: renderExperiments,
  games: renderGames,
  store: renderStore,
  announcements: renderAnnouncements,
  official: renderOfficialInbox,
  guilds: renderGuilds,
  reports: renderReports,
  status: renderStatus,
  system: renderSystem,
  performance: renderPerformance,
};

let activeHash = location.hash;
function route() {
  if (!state.overview) return;
  let [tab] = location.hash.replace(/^#\/?/, "").split("/");
  const link = $(`#nav a[data-tab="${CSS.escape(tab || "")}"]`);
  if (!TABS[tab] || !link || (link.dataset.access && !state.overview.access[link.dataset.access]))
    tab = "overview";
  if (
    !closeDrawer() ||
    ($("form[data-dirty]", $("#view")) && !confirm("Discard unsaved changes?"))
  ) {
    history.replaceState(null, "", activeHash);
    return;
  }
  for (const a of $$("#nav a")) {
    a.classList.toggle("active", a.dataset.tab === tab);
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  activeHash = location.hash;
  pageRequests.abort();
  pageRequests = new AbortController();
  const view = $("#view").cloneNode(false);
  $("#view").replaceWith(view);
  mount(
    view,
    html`
      <div class="spinner">Loading…</div>
    `,
  );
  TABS[tab](view).catch((e) => {
    if (e.status !== 401 && e.status !== 499)
      mount(
        view,
        html`<div class="card">
                    <h2>Something went wrong</h2>
                    <p class="muted">${e.message}</p>
                </div>`,
      );
  });
}
window.addEventListener("hashchange", route);

/* ---------- drawer ---------- */

let drawerReturnFocus;
let drawerScrollState;
function openDrawer(title, content) {
  if (!$("#drawer").hidden && !closeDrawer()) return null;
  drawerReturnFocus = document.activeElement;
  const fresh = $("#drawer-body").cloneNode(false);
  $("#drawer-body").replaceWith(fresh);
  $("#drawer-title").textContent = title;
  mount($("#drawer-body"), content);
  $("#drawer").hidden = false;
  $("#app").inert = true;
  drawerScrollState = ["overflow-x", "overflow-y"].map((property) => ({
    property,
    value: document.body.style.getPropertyValue(property),
    priority: document.body.style.getPropertyPriority(property),
  }));
  document.body.style.overflow = "hidden";
  $(".drawer-head button").focus();
  return $("#drawer-body");
}
function closeDrawer({ discard = false } = {}) {
  if ($("#drawer").hidden) return true;
  if (!discard && $("form[data-dirty]", $("#drawer")) && !confirm("Discard unsaved changes?"))
    return false;
  $("#drawer").hidden = true;
  $("#app").inert = false;
  for (const { property, value, priority } of drawerScrollState) {
    if (value) document.body.style.setProperty(property, value, priority);
    else document.body.style.removeProperty(property);
  }
  drawerScrollState = undefined;
  const returnFocus = [
    drawerReturnFocus,
    $("#nav-search"),
    $("#login-form input[name=login]"),
  ].find(
    (element) =>
      element &&
      element !== document.body &&
      element.isConnected &&
      !element.matches(":disabled, [aria-disabled=true]") &&
      !element.closest("[inert]") &&
      getComputedStyle(element).visibility === "visible" &&
      element.getClientRects().length,
  );
  returnFocus?.focus();
  drawerReturnFocus = undefined;
  $("#drawer-body").innerHTML = "";
  return true;
}
$("#drawer").addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
});

function filterNavigation() {
  const query = $("#nav-search").value.trim().toLowerCase();
  for (const link of $$("#nav a")) {
    const allowed = !link.dataset.access || state.overview?.access[link.dataset.access];
    link.hidden = !allowed || !link.textContent.toLowerCase().includes(query);
  }
  for (const group of $$(".nav-group")) group.hidden = !$$("a", group).some((link) => !link.hidden);
  $("#nav-empty").hidden = $$("#nav a").some((link) => !link.hidden);
}
$("#nav-search").addEventListener("input", filterNavigation);
function markFormDirty(event) {
  const form = event.target.closest("form");
  if (form && form.id !== "login-form") {
    const control = event.target;
    const value =
      control.type === "file"
        ? control.files
        : ["checkbox", "radio"].includes(control.type)
          ? control.checked
          : control.multiple && control.selectedOptions
            ? JSON.stringify(Array.from(control.selectedOptions, (option) => option.value))
            : control.value;
    if (
      event.type === "change" &&
      value !== undefined &&
      formControlValues.has(control) &&
      formControlValues.get(control) === value
    )
      return;
    formControlValues.set(control, value);
    form.dataset.dirty = "true";
    formEditVersions.set(form, (formEditVersions.get(form) || 0) + 1);
  }
}
document.addEventListener("input", markFormDirty);
document.addEventListener("change", markFormDirty);
window.addEventListener("beforeunload", (event) => {
  if ($("form[data-dirty]")) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !$("#app").inert) {
    event.preventDefault();
    $("#nav-search").focus();
    $("#nav-search").select();
  }
  if (event.key === "Tab" && !$("#drawer").hidden) {
    const focusable = $$(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
      $("#drawer"),
    ).filter((el) => el.getClientRects().length);
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});

/* ---------- overview ---------- */

async function renderOverview(view) {
  const o = await api("/admin");
  state.overview = o;
  syncNavCounts();
  const status = await api("/status/summary.json", { auth: false }).catch(() => null);
  const stat = (label, value, href) => html`
        <a class="card stat" ${href ? raw(`href="${escapeHtml(href)}"`) : ""} style="text-decoration:none;color:inherit">
            <div class="muted">${label}</div>
            <div class="value">${value}</div>
        </a>
    `;

  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>${o.instance.name}</h1>
                    <p class="muted">${o.instance.description || "No description set."}</p>
                </div>
                ${
                  o.access.settings
                    ? html`
                        <a class="btn" href="#/settings">Edit site settings</a>
                      `
                    : ""
                }
            </div>
            <div class="stack">
                <div class="stats">
                    ${stat("Users", fmtNumber(o.counts.users), o.access.users ? "#/users" : null)}
                    ${stat("Servers", fmtNumber(o.counts.guilds), o.access.guilds ? "#/guilds" : null)} ${stat("Messages", fmtNumber(o.counts.messages))}
                    ${stat("Memberships", fmtNumber(o.counts.members))} ${stat("Disabled accounts", fmtNumber(o.counts.disabled_users), o.access.users ? "#/users" : null)}
                    ${stat("Open incidents", fmtNumber(o.counts.open_incidents), o.access.status ? "#/status" : null)}
                    ${o.access.reports ? stat("Open reports", fmtNumber(o.counts.open_reports), "#/reports") : ""}
                </div>
                <p class="muted">Counts sampled ${fmtDate(o.counts_sampled_at)}. Refresh every ${o.counts_refresh_seconds ?? 30} seconds.</p>
                <div class="card">
                    <h3>Instance</h3>
                    <div class="list">
                        <div class="list-item">
                            <span class="grow muted">Public status</span
                            >${status ? html`<span class="badge ${status.status.indicator === "none" ? "ok" : status.status.indicator === "maintenance" ? "info" : "warn"}"><span class="dot"></span>${status.status.description}</span>` : "—"}
                        </div>
                        <div class="list-item"><span class="grow muted">Uptime</span><span>${fmtDuration(o.uptime)}</span></div>
                        <div class="list-item"><span class="grow muted">Revision</span><code>${o.revision?.rev?.slice(0, 10) ?? "unknown"}</code></div>
                        <div class="list-item"><span class="grow muted">Instance ID</span><code>${o.instance.id}</code></div>
                        <div class="list-item">
                            <span class="grow muted">Your access</span
                            ><span class="badges"
                                >${Object.entries(o.access)
                                  .filter(([k, v]) => v && k !== "operator")
                                  .map(([k]) => html`<span class="badge accent">${k}</span>`)}</span
                            >
                        </div>
                    </div>
                </div>
            </div>
        `,
  );
}

/* ---------- settings ---------- */

const CAP_MODES = [
  ["core", "Cap core (default)"],
  ["standalone", "Cap Standalone server"],
];

const RATE_LIMITS = [
  ["ip", "Per IP, signed out", "Every request from an IP without an account"],
  ["global", "Per account", "Every request from a signed-in account"],
  ["error", "Failed requests per IP", "Requests answered with 401, 403 or 429"],
  ["login", "Sign-in attempts", "Also covers two-factor, password reset and verification"],
  ["register", "Registrations per IP", "Only successful sign-ups count"],
];

const RESOURCE_LIMITS = {
  user: [
    "Account limits",
    [
      ["maxGuilds", "Joined servers"],
      ["maxUsername", "Username characters"],
      ["maxFriends", "Friends"],
      ["maxBio", "Bio characters"],
      ["maxPronouns", "Pronoun characters"],
    ],
  ],
  guild: [
    "Server limits",
    [
      ["maxRoles", "Roles"],
      ["maxEmojis", "Emojis"],
      ["maxStickers", "Stickers"],
      ["maxMembers", "Members"],
      ["maxChannels", "Channels"],
      ["maxBulkBanUsers", "Users per bulk ban"],
      ["maxChannelsInCategory", "Channels per category"],
    ],
  ],
  message: [
    "Message limits",
    [
      ["maxCharacters", "Message characters"],
      ["maxTTSCharacters", "Text-to-speech characters"],
      ["maxReactions", "Reactions"],
      ["maxAttachments", "Attachments"],
      ["maxAttachmentSize", "Attachment bytes"],
      ["maxBulkDelete", "Messages per bulk delete"],
      ["maxEmbedDownloadSize", "Embed download bytes"],
      ["maxPreloadCount", "Preloaded channels"],
      ["maxEmbeds", "Embeds"],
      ["maxEmbedCharacters", "Embed characters"],
    ],
  ],
  channel: [
    "Channel limits",
    [
      ["maxPins", "Pinned messages"],
      ["maxTopic", "Topic characters"],
      ["maxWebhooks", "Webhooks"],
      ["maxName", "Name characters"],
      ["maxGroupDmRecipients", "Group DM participants"],
    ],
  ],
};

const E2EE_LIMITS = [
  [
    "maxEnvelopeBytes",
    "Largest encrypted message",
    "Bytes. Discord-sized messages fit in the default 65536.",
    1024,
  ],
  [
    "maxEnvelopeDevices",
    "Devices per encrypted message",
    "How many recipient devices one message can be encrypted for.",
    1,
  ],
  [
    "pendingDeviceTtlHours",
    "Unapproved device lifetime",
    "Hours before a browser that was never approved is revoked.",
    1,
  ],
  [
    "deviceRegistrationsPerHour",
    "New devices per hour",
    "Per account. Re-signing a known device doesn't count.",
    1,
  ],
  [
    "deviceUpdatesPerHour",
    "Device updates per hour",
    "Per account, for re-signing devices that already exist.",
    1,
  ],
  [
    "keyQueriesPerMinute",
    "Key lookups per minute",
    "Per account, for fetching other people's device keys.",
    1,
  ],
];

const getPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const setPath = (obj, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
};

async function renderSettings(view) {
  const s = await api("/admin/settings");
  const gifs = await api("/admin/gifs");
  const text = (path, label, hint, type = "text", placeholder = "") =>
    html`<label
            >${label}${hint ? html`<span class="hint">${hint}</span>` : ""}<input type="${type}" name="${path}" value="${getPath(s, path) ?? ""}" placeholder="${placeholder}"
        /></label>`;
  const number = (path, label, hint, min = 0) =>
    html`<label
            >${label}${hint ? html`<span class="hint">${hint}</span>` : ""}<input
                type="number"
                data-number
                name="${path}"
                min="${min}"
                step="1"
                value="${getPath(s, path) ?? ""}"
                required
        /></label>`;
  const toggle = (path, label, hint) =>
    html`<label class="toggle"
            ><input type="checkbox" name="${path}" ${getPath(s, path) ? raw("checked") : ""} /><span>${label}${hint ? html`<span class="hint">${hint}</span>` : ""}</span></label
        >`;
  const invertedToggle = (path, label, hint) =>
    html`<label class="toggle"
            ><input type="checkbox" name="${path}" data-inverted ${getPath(s, path) ? "" : raw("checked")} /><span>${label}${hint ? html`<span class="hint">${hint}</span>` : ""}</span></label
        >`;
  const captchaState =
    s.captcha.active || s.register.requireCaptcha
      ? html`<span class="badge ok"><span class="dot"></span>${s.register.requireCaptcha ? "Signup verification active" : "Active"}</span>`
      : s.captcha.enabled
        ? html`
            <span class="badge warn"><span class="dot"></span>Enabled but incomplete</span>
          `
        : html`
            <span class="badge"><span class="dot"></span>Off</span>
          `;

  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Site settings</h1>
                    <p class="muted">Instance information, how the web client is branded, who can sign up, and the limits that protect the instance.</p>
                </div>
            </div>
            <form id="settings-form" class="stack">
                <div class="settings-jump" aria-label="Settings shortcuts">
                    <a href="#/settings" data-settings-target="settings-instance">Instance</a><a href="#/settings" data-settings-target="settings-branding">Branding</a
                    ><a href="#/settings" data-settings-target="settings-registration">Registration</a
                    ><a href="#/settings" data-settings-target="settings-limits">Feature limits</a>
                </div>
                <div class="card">
                    <h2>External requests</h2>
                    <p class="muted">Local files and cached assets remain available. By default, only Discord's existing decoration artwork can be downloaded.</p>
                    <div class="stack">
                        ${toggle("externalRequests.discordDecorations", "Download existing Discord decoration artwork", "Avatar decorations, nameplates and profile effects. Shop items remain free.")}
                        ${toggle("externalRequests.discordAssetFallback", "Download other missing Discord assets")}
                        ${toggle("externalRequests.discordClientAssets", "Download missing Discord client assets while browsing")}
                        ${toggle("externalRequests.discordGames", "Refresh the games list from Discord")}
                        ${toggle("externalRequests.discordTemplates", "Import server templates from Discord")}
                        ${toggle("externalRequests.discordStickerPacks", "Import standard sticker packs from Discord")}
                        ${toggle("externalRequests.discordBadDomains", "Download Discord's blocked-domain list")}
                        ${toggle("externalRequests.thirdParty", "Allow configured third-party integrations", "Also requires configuring each provider. Leave off for local operation.")}
                    </div>
                </div>
                <div class="card" id="settings-gifs">
                    <h2>GIF search</h2>
                    <p class="muted">Klipy is the default. These providers work independently of other third-party integrations. Keys stay on the server.</p>
                    <label class="toggle"><input id="gif-enabled" type="checkbox" ${gifs.enabled ? raw("checked") : ""} /><span>Enable GIF search</span></label>
                    <label
                        >Default provider<select id="gif-default">
                            ${options(
                              [
                                ["klipy", "Klipy"],
                                ["tenor", "Tenor"],
                              ],
                              gifs.defaultProvider,
                            )}
                        </select></label
                    >
                    <div class="form-grid">
                        ${["klipy", "tenor"].map(
                          (provider) =>
                            html`<div class="stack">
                                    <label class="toggle"
                                        ><input id="gif-${provider}-enabled" type="checkbox" ${gifs[provider].enabled ? raw("checked") : ""} /><span
                                            >Enable ${provider === "klipy" ? "Klipy" : "Tenor"}</span
                                        ></label
                                    ><label
                                        >${provider === "klipy" ? "Klipy" : "Tenor"} API key<span class="hint"
                                            >${gifs[provider].key_set ? "A key is configured. Leave blank to keep it." : "No key configured."}${provider === "tenor" ? " Uses Vencord's public key by default." : " Get a key from partner.klipy.com."}</span
                                        ><input id="gif-${provider}-key" type="password" autocomplete="new-password" /></label
                                    ><label class="toggle"><input id="gif-${provider}-clear" type="checkbox" /><span>Remove configured key</span></label>
                                    <p class="muted">${gifs.providers[provider]?.available ? "Configured and ready" : "Not configured"}</p>
                                </div>`,
                        )}
                    </div>
                    <button class="btn" type="button" id="gif-save">Save GIF settings</button>
                    <p class="hint">Google announced Tenor API retirement. This compatibility provider uses the same endpoint as Vencord; availability depends on Tenor.</p>
                </div>
                <div class="card" id="settings-limits">
                    <h2>Feature limits</h2>
                    <p class="muted">Control the limits used by accounts, servers, messages and channels.</p>
                    ${Object.entries(RESOURCE_LIMITS).map(
                      ([section, [label, fields]]) =>
                        html`<details class="settings-section">
                                <summary>${label}</summary>
                                <div class="form-grid">${fields.map(([key, name]) => number(`limits.${section}.${key}`, name, "", 1))}</div>
                            </details>`,
                    )}
                    <label
                        >Default server features<span class="hint">One per line. Used when new servers are created.</span
                        ><textarea name="guild.defaultFeatures" data-lines>${(s.guild.defaultFeatures ?? []).join("\n")}</textarea>
                    </label>
                    ${toggle("guild.publicThreadsInvitable", "Let members invite others to public threads")}
                    ${toggle("limits.channel.allowSlowmodeBypass", "Allow moderators to bypass slowmode", "Owners and members with Manage Messages, Manage Channels or Bypass Slowmode can send without waiting.")}
                    ${toggle("guild.discovery.hideJoinedGuilds", "Hide servers people are in from Discovery", "Off is how Discord works. When it's on, whoever adds a server to Discovery never sees it there.")}
                </div>
                <div class="card">
                    <h2 id="settings-instance">Instance information</h2>
                    <div class="form-grid">
                        <label>Instance name<input name="general.instanceName" value="${s.general.instanceName}" required maxlength="100" /></label>
                        ${text("general.image", "Icon URL", "Fallback icon when the client icon below is empty", "url")}
                        <label class="span">Description<textarea name="general.instanceDescription" maxlength="1000">${s.general.instanceDescription ?? ""}</textarea></label>
                        ${text("general.frontPage", "Homepage URL", "Linked from the status page", "url")}
                        ${text("general.tosPage", "Terms of service URL", "Opened from every Terms of Service link in the client", "url")}
                        ${text("general.privacyPage", "Privacy policy URL", "Falls back to the terms of service URL", "url")}
                        ${text("general.guidelinesPage", "Community guidelines URL", "Falls back to the terms of service URL", "url")}
                        ${text("general.correspondenceEmail", "Contact email", "", "email")}
                        ${text("general.correspondenceUserID", "Contact user ID", "The account users can message for help")}
                    </div>
                </div>
                <div class="card">
                    <h2 id="settings-branding">Web client branding</h2>
                    <p class="muted" style="margin:0 0 14px">
                        What the bundled web client shows instead of Discord's name and artwork. Open clients pick it up on their next reload.
                    </p>
                    <div class="form-grid">
                        <label
                            >Name in the client<span class="hint">Replaces "Discord" in titles and text</span
                            ><input name="client.instanceName" value="${s.client.instanceName}" required maxlength="100"
                        /></label>
                        ${text("client.icon", "Square icon", "A URL, or a file path relative to the server folder. Used for the favicon, avatars and the app icon.", "text", "assets/icon.png")}
                        ${text("client.logo", "Wordmark logo", "A URL or file path. Shown where Discord shows its wordmark; empty draws the name next to the icon.", "text")}
                        ${text("client.helpUrl", "Help center URL", "Where help links go. Empty hides them.", "url", "https://")}
                        ${text("client.activityApplicationHost", "Activity host", "Host that serves embedded activities. Empty uses this instance.", "text", "activities.example.com")}
                    </div>
                </div>
                <div class="card">
                    <h2 id="settings-loading">Loading screen</h2>
                    <p class="muted">Customize the loading screen for everyone on this instance. Changes appear after reload.</p>
                    <label>Did you know? tips<span class="hint">One tip per line, up to 100 tips of 500 characters each. Leave empty to use the built-in tips.</span><textarea id="loading-tips" name="client.loadingTips" data-lines rows="5">${(s.client.loadingTips ?? []).join("\n")}</textarea></label>
                    <label style="margin-top:16px">Loading animation SVG<span class="hint">Paste a self-contained SVG under 64 KB. Scripts, external images and embedded HTML are blocked. Leave empty for the built-in animation.</span><textarea id="loading-svg" name="client.loadingSvg" rows="8" spellcheck="false">${s.client.loadingSvg ?? ""}</textarea></label>
                    <div class="row" style="margin-top:16px"><button class="btn" type="button" id="loading-preview-button">Preview</button><button class="btn" type="button" id="loading-reset">Restore defaults</button></div>
                    <div id="loading-preview" class="stack" style="margin-top:16px;padding:24px;text-align:center;align-items:center" aria-live="polite"><p class="muted">Preview your loading screen before saving.</p></div>
                </div>
                <div class="card">
                    <h2 id="settings-registration">Registration</h2>
                    <div class="stack">
                        ${toggle("register.disabled", "Disable registration entirely", "Nobody can create an account, including with an invite.")}
                        ${toggle("register.allowNewRegistration", "Allow new registrations", "Turn off to stop new sign-ups while keeping invite-based registration rules.")}
                        ${toggle("register.requireInvite", "Require an invite to register", "New accounts must join through an invite link.")}
                        ${toggle("register.guestsRequireInvite", "Require an invite for guest accounts", "Guest accounts are created without a password.")}
                        ${toggle("register.email.required", "Require an email address", "Off lets people sign up with only a username and password.")}
                        ${invertedToggle("defaults.user.verified", "Verify email addresses", "Sends each new account a link to confirm its address. Off marks new accounts as verified without checking. Needs email delivery.")}
                        ${toggle("login.requireVerification", "Require a verified email", "Until an account opens its verification link it can sign in and read, but not post, join or call. The app holds it at a prompt to resend the link or change its address. Needs an email address to be required.")}
                        ${toggle("register.allowMultipleAccounts", "Allow multiple accounts per person", "When off, sign-ups from known devices or IPs are refused.")}
                        ${toggle("register.incrementingDiscriminators", "Give out discriminators in order", "Off picks a random free one for legacy usernames.")}
                    </div>
                    <label style="margin-top:16px"
                        >Blacklisted usernames<span class="hint"
                            >One per line, not case-sensitive. Nobody can register with these or change their username to one, and the sign-up page says so as they type.
                            <code>*</code> matches anything, so <code>*admin*</code> blocks every name containing "admin". Accounts that already have one keep it.</span
                        ><textarea name="register.blacklistedUsernames" data-lines rows="5" placeholder="admin&#10;moderator&#10;*official*">
${(s.register.blacklistedUsernames ?? []).join("\n")}</textarea>
                    </label>
                    <label style="margin-top:16px"
                        >Blocked identity words<span class="hint" id="identity-blocked-terms-hint"
                            >One word per line, up to 256 words of 64 letters or numbers each. Applies to usernames, display names and guild nicknames, including bots.
                            Matching ignores case and common obfuscations. Leave empty to clear the list. Existing names are kept.</span
                        ><textarea name="user.identityBlockedTerms" data-lines rows="5" aria-describedby="identity-blocked-terms-hint">${(s.user?.identityBlockedTerms ?? []).join("\n")}</textarea>
                    </label>
                    <div class="form-grid" style="margin-top:16px">
                        ${number("register.dateOfBirth.minimum", "Minimum age", "Years. Set to 0 to accept any date of birth.")}
                        ${number("register.password.minLength", "Minimum password length", "", 1)} ${number("register.password.minNumbers", "Digits a password needs")}
                        ${number("register.password.minUpperCase", "Capital letters a password needs")} ${number("register.password.minSymbols", "Symbols a password needs")}
                    </div>
                </div>
                <div class="card">
                    <div class="row" style="justify-content:space-between;margin-bottom:12px">
                        <h2 style="margin:0">Captcha</h2>
                        ${captchaState}
                    </div>
                    <div class="stack">
                        <label
                            >Cap mode<select id="captcha-provider" name="captcha.capMode">
                                ${options(CAP_MODES, s.captcha.capMode === "standalone" ? "standalone" : "core")}
                            </select></label
                        >
                        <p class="muted" data-cap-core>Cap core runs inside this instance. Signup verification needs no separate server, API key or external service.</p>
                        <div class="form-grid">
                            <label data-cap-standalone
                                >Standalone server URL<span class="hint">The base URL of your Cap Standalone deployment. Browsers must be able to reach it.</span
                                ><input type="url" name="captcha.instance" value="${s.captcha.instance ?? ""}" placeholder="https://cap.example.com"
                            /></label>
                            <label data-cap-standalone
                                >Site key<span class="hint">The site key from your Cap Standalone dashboard.</span
                                ><input name="captcha.sitekey" value="${s.captcha.sitekey ?? ""}"
                            /></label>
                            <label data-cap-standalone
                                >Secret<span class="hint"
                                    >${s.captcha.secret_set ? "A secret is configured. Leave blank to keep it." : "Enter the site's secret from Cap Standalone."}</span
                                ><input type="password" name="captcha.secret" autocomplete="new-password"
                            /></label>
                        </div>
                        ${toggle("captcha.enabled", "Enable additional sign-in and password-reset verification", "Uses the selected Cap mode for the actions enabled below. Required signup verification stays active independently.")}
                        ${toggle("register.requireCaptcha", "Require Cap to create an account", "Always displays the selected Cap widget before an account can be created. Cap core is the default.")}
                        ${toggle("login.requireCaptcha", "Ask for a captcha when signing in", "")}
                        ${toggle("passwordReset.requireCaptcha", "Ask for a captcha when requesting a password reset", "")}
                    </div>
                </div>
                <div class="card">
                    <h2>Rate limits</h2>
                    <p class="muted" style="margin:0 0 14px">Requests allowed per window of seconds. Changes apply after the server restarts.</p>
                    <div class="stack">
                        ${toggle("rate.enabled", "Rate limit requests", "Accounts with the BYPASS_RATE_LIMITS right are never limited.")}
                        <div class="form-grid">
                            ${RATE_LIMITS.map(
                              ([key, label, hint]) =>
                                html`<div class="stack" style="gap:6px">
                                        <strong style="font-size:13px">${label}</strong><span class="hint muted" style="font-size:12px">${hint}</span>
                                        <div class="row" style="flex-wrap:nowrap">
                                            <input
                                                type="number"
                                                data-number
                                                name="rate.${key}.count"
                                                min="1"
                                                step="1"
                                                value="${s.rate[key].count}"
                                                aria-label="${label}: requests"
                                                required
                                            />
                                            <span class="muted">per</span>
                                            <input
                                                type="number"
                                                data-number
                                                name="rate.${key}.window"
                                                min="1"
                                                step="1"
                                                value="${s.rate[key].window}"
                                                aria-label="${label}: seconds"
                                                required
                                            />
                                            <span class="muted">s</span>
                                        </div>
                                    </div>`,
                            )}
                        </div>
                    </div>
                </div>
                <div class="card">
                    <h2>Encrypted DMs</h2>
                    <p class="muted" style="margin:0 0 14px">Limits for end-to-end encrypted conversations. They apply right away.</p>
                    <div class="form-grid">${E2EE_LIMITS.map(([key, label, hint, min]) => number(`e2ee.${key}`, label, hint, min))}</div>
                </div>
                <div class="form-actions">
                    <button class="btn" type="reset">Discard changes</button>
                    <button class="btn primary" type="submit">Save settings</button>
                </div>
            </form>
        `,
  );

  const syncCaptchaProvider = () => {
    const standalone = $("#captcha-provider", view).value === "standalone";
    for (const group of $$("[data-cap-standalone]", view)) {
      group.hidden = !standalone;
      for (const input of $$("input", group)) {
        input.disabled = !standalone;
        input.required = standalone && (input.name !== "captcha.secret" || !s.captcha.secret_set);
      }
    }
    $("[data-cap-core]", view).hidden = standalone;
  };
  $("#captcha-provider", view).addEventListener("change", syncCaptchaProvider);
  syncCaptchaProvider();
  $("#gif-save", view).addEventListener("click", async () => {
    const body = {
      enabled: $("#gif-enabled", view).checked,
      defaultProvider: $("#gif-default", view).value,
    };
    for (const provider of ["klipy", "tenor"]) {
      const apiKey = $(`#gif-${provider}-key`, view).value.trim();
      body[provider] = {
        enabled: $(`#gif-${provider}-enabled`, view).checked,
        clearKey: $(`#gif-${provider}-clear`, view).checked,
        ...(apiKey ? { apiKey } : {}),
      };
    }
    const saved = await act(
      $("#gif-save", view),
      () => api("/admin/gifs", { method: "PATCH", body }),
      "GIF settings saved",
    );
    if (saved) renderSettings(view);
  });
  for (const link of $$("[data-settings-target]", view))
    link.addEventListener("click", (event) => {
      event.preventDefault();
      document.getElementById(link.dataset.settingsTarget)?.scrollIntoView({ block: "start" });
    });
  $("#loading-preview-button", view).addEventListener("click", () => {
    const preview = $("#loading-preview", view);
    preview.replaceChildren();
    const svg = $("#loading-svg", view).value.trim();
    if (svg) {
      const image = document.createElement("img");
      image.alt = "Loading animation preview";
      image.style.cssText = "width:144px;height:144px;object-fit:contain";
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      preview.append(image);
    }
    const heading = document.createElement("strong");
    heading.textContent = "Did you know?";
    const tip = document.createElement("p");
    tip.textContent =
      $("#loading-tips", view)
        .value.split("\n")
        .map((line) => line.trim())
        .find(Boolean) || "Built-in loading tips will be used.";
    preview.append(heading, tip);
  });
  $("#loading-reset", view).addEventListener("click", () => {
    $("#loading-tips", view).value = "";
    $("#loading-svg", view).value = "";
    $("#loading-preview", view).textContent =
      "Built-in tips and animation will be restored when you save settings.";
  });
  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = {};
    for (const el of $$("input, textarea, select", form)) {
      if (!el.name || el.disabled) continue;
      if (el.name === "captcha.secret" && !el.value) continue;
      const value =
        el.type === "checkbox"
          ? "inverted" in el.dataset
            ? !el.checked
            : el.checked
          : "number" in el.dataset
            ? Number(el.value)
            : "lines" in el.dataset
              ? el.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean)
              : el.value;
      setPath(body, el.name, value);
    }
    const saved = await act(
      $("button[type=submit]", form),
      () => api("/admin/settings", { method: "PATCH", body }),
      "Settings saved",
    );
    if (saved) {
      state.overview = await api("/admin");
      $("#brand-name").textContent = state.overview.instance.name;
      syncBrandIcon();
      renderSettings(view);
    }
  });
}

function latestList(view, results, status) {
  let pending;
  let generation = 0;
  const cancel = () => {
    generation++;
    pending?.abort();
    results.setAttribute("aria-busy", "false");
    status.hidden = true;
  };
  return {
    cancel,
    async load(path, render, retry) {
      if (!view.isConnected) return;
      cancel();
      const current = generation;
      pending = new AbortController();
      results.setAttribute("aria-busy", "true");
      status.hidden = false;
      status.textContent = "Loading results…";
      try {
        const data = await api(path, { signal: pending.signal });
        if (current !== generation || !view.isConnected) return;
        render(data);
        status.textContent = `${fmtNumber(data.total)} ${data.total === 1 ? "result" : "results"}`;
      } catch (error) {
        if (
          current !== generation ||
          !view.isConnected ||
          error.status === 499 ||
          error.status === 401
        )
          return;
        mount(
          status,
          html`<span>${error.message}</span><button class="btn small" type="button">Retry search</button>`,
        );
        $("button", status).addEventListener("click", retry);
        if (!$("table, .empty", results))
          mount(
            results,
            html`
              <div class="card empty">Results couldn't load. Retry your search.</div>
            `,
          );
      } finally {
        if (current === generation && view.isConnected) results.setAttribute("aria-busy", "false");
      }
    },
  };
}

/* ---------- users ---------- */

const usersState = { q: "", filter: "all", offset: 0, limit: 50 };

async function renderUsers(view) {
  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Users</h1>
                    <p class="muted">Search by name, email or ID. Click a user to edit or ban them.</p>
                </div>
            </div>
            <div class="row" style="margin-bottom:12px">
                <label class="grow list-search"
                    >Find users<input id="user-search" type="search" placeholder="Search names, emails or IDs" value="${usersState.q}" aria-controls="user-results"
                /></label>
                <label class="list-filter"
                    ><span id="user-filter-label">Filter users</span
                    ><select id="user-filter" aria-labelledby="user-filter-label">
                        ${options(
                          [
                            ["all", "All users"],
                            ["disabled", "Disabled"],
                            ["verified", "Verified email"],
                            ["unverified", "Unverified email"],
                            ["bots", "Bots"],
                          ],
                          usersState.filter,
                        )}
                    </select></label
                >
            </div>
            <div class="list-status muted" id="user-status" role="status" aria-live="polite" hidden></div>
            <div id="user-results"><div class="spinner">Loading…</div></div>
        `,
  );

  const results = $("#user-results", view);
  const requests = latestList(view, results, $("#user-status", view));
  const load = async () => {
    const params = new URLSearchParams({
      q: usersState.q,
      filter: usersState.filter,
      limit: usersState.limit,
      offset: usersState.offset,
    });
    await requests.load(
      `/admin/users?${params}`,
      ({ users, total }) => {
        mount(
          results,
          users.length
            ? html`
                              <div class="table-wrap">
                                  <table>
                                      <thead>
                                          <tr>
                                              <th>User</th>
                                              <th class="hide-sm">Email</th>
                                              <th class="hide-sm">Joined</th>
                                              <th>Flags</th>
                                          </tr>
                                      </thead>
                                      <tbody>
                                          ${users.map(
                                            (u) => html`
                                                  <tr data-id="${u.id}">
                                                      <td>
                                                          <div class="ident">
                                                              ${avatar(u)}
                                                              <div><strong>${userName(u)}</strong><span class="muted">${userTag(u)}</span></div>
                                                          </div>
                                                      </td>
                                                      <td class="hide-sm">${
                                                        u.email ||
                                                        html`
                                                          <span class="muted">—</span>
                                                        `
                                                      }</td>
                                                      <td class="hide-sm">${fmtDay(u.created_at)}</td>
                                                      <td>${userBadges(u)}</td>
                                                  </tr>
                                              `,
                                          )}
                                      </tbody>
                                  </table>
                              </div>
                              ${pager(total, usersState)}
                          `
            : html`
                <div class="card empty">No users match.</div>
              `,
        );
        for (const row of $$("tbody tr", results))
          row.addEventListener("click", () => openUser(row.dataset.id, load));
        bindPager(results, total, usersState, load);
      },
      load,
    );
  };

  const search = debounce(load);
  $("#user-search", view).addEventListener("input", (e) => {
    requests.cancel();
    usersState.q = e.target.value.trim();
    usersState.offset = 0;
    search();
  });
  $("#user-filter").addEventListener("change", (e) => {
    usersState.filter = e.target.value;
    usersState.offset = 0;
    load();
  });
  await load();
}

function userBadges(u) {
  const badges = [];
  if (hasRight(u.rights, 0))
    badges.push(
      html`
        <span class="badge accent">Operator</span>
      `,
    );
  else if (hasRight(u.rights, 7) || hasRight(u.rights, 2))
    badges.push(
      html`
        <span class="badge accent">Staff</span>
      `,
    );
  if (u.disabled)
    badges.push(
      html`
        <span class="badge danger">Disabled</span>
      `,
    );
  if (u.deleted)
    badges.push(
      html`
        <span class="badge danger">Deleted</span>
      `,
    );
  if (u.bot)
    badges.push(
      html`
        <span class="badge info">Bot</span>
      `,
    );
  if (u.tag && u.tag !== "none") badges.push(nameTag(u.tag, u.bot));
  if (!u.verified && !u.bot)
    badges.push(
      html`
        <span class="badge warn">Unverified</span>
      `,
    );
  return html`<div class="badges">${badges}</div>`;
}

function pager(total, st) {
  if (total <= st.limit)
    return html`<div class="pager"><span class="muted">${fmtNumber(total)} total</span></div>`;
  const from = st.offset + 1;
  const to = Math.min(st.offset + st.limit, total);
  return html`<div class="pager">
        <span class="muted">${fmtNumber(from)}–${fmtNumber(to)} of ${fmtNumber(total)}</span>
        <div class="row">
            <button class="btn small" data-page="prev" ${st.offset === 0 ? raw("disabled") : ""}>Previous</button>
            <button class="btn small" data-page="next" ${to >= total ? raw("disabled") : ""}>Next</button>
        </div>
    </div>`;
}

function bindPager(root, total, st, load) {
  $(`[data-page="prev"]`, root)?.addEventListener("click", () => {
    st.offset = Math.max(0, st.offset - st.limit);
    load();
  });
  $(`[data-page="next"]`, root)?.addEventListener("click", () => {
    if (st.offset + st.limit < total) st.offset += st.limit;
    load();
  });
}

const imageField = (field, label, current) =>
  html`<label>${label}<input type="file" name="${field}_file" accept="image/png,image/jpeg,image/webp,image/gif" /></label>
        ${current ? html`<label class="toggle"><input type="checkbox" name="${field}_remove" /><span>Remove ${label.toLowerCase()}</span></label>` : ""}`;
const imagePatch = async (form, fields, patch) => {
  for (const field of fields) {
    const file = form.elements[`${field}_file`]?.files[0];
    if (file) {
      if (file.size > 7 * 1024 * 1024) throw new Error("Choose an image smaller than 7 MB.");
      patch[field] = await readAsDataUrl(file);
    } else if (form.elements[`${field}_remove`]?.checked) patch[field] = null;
  }
  if (JSON.stringify(patch).length > 9 * 1024 * 1024)
    throw new Error("These images exceed the upload limit. Save one image at a time.");
};
const hexColor = (value) =>
  `#${Number(value ?? 0x5865f2)
    .toString(16)
    .padStart(6, "0")}`;

let profileCatalog;
const getProfileCatalog = async () => {
  if (!profileCatalog || Date.now() >= profileCatalog.expires) {
    const entry = { expires: Date.now() + 30000, promise: api("/admin/store/catalog") };
    profileCatalog = entry;
    entry.promise.catch(() => {
      if (profileCatalog === entry) profileCatalog = null;
    });
  }
  return profileCatalog.promise;
};

async function openUser(id, reload) {
  const body = openDrawer(
    "User",
    html`
      <div class="spinner">Loading…</div>
    `,
  );
  if (!body) return;
  let u, badges, standing, catalog;
  try {
    [u, badges, standing, catalog] = await Promise.all([
      api(`/admin/users/${id}`),
      api("/admin/badges"),
      api(`/admin/users/${id}/violations`),
      getProfileCatalog(),
    ]);
  } catch (e) {
    if (!body.isConnected || $("#drawer").hidden || e.status === 401 || e.status === 499) return;
    return mount(body, html`<p class="form-error">${e.message}</p>`);
  }
  if (!body.isConnected || $("#drawer").hidden) return;
  const cosmeticOf = (type) =>
    u.profile_collectibles?.find((item) => item.type === type)?.sku_id ?? "";
  const choicesFor = (type, selected, query = "") => {
    const matching = catalog.items
      .filter(
        (item) =>
          item.type === type &&
          `${item.pack} ${item.name}`.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 100);
    const current = catalog.items.find((item) => item.sku_id === selected);
    if (selected && !matching.some((item) => item.sku_id === selected))
      matching.unshift(current ?? { sku_id: selected, name: "Current item", pack: "Profile" });
    return [["", "None"], ...matching.map((item) => [item.sku_id, `${item.pack} · ${item.name}`])];
  };
  const cosmeticField = (type, field, label, selected) =>
    html`<div class="stack" style="gap:6px">
            <label>Find ${label.toLowerCase()}<input type="search" data-cosmetic-search="${field}" data-cosmetic-type="${type}" placeholder="Search names and packs" /></label
            ><label
                >${label}<select name="${field}">
                    ${options(choicesFor(type, selected), selected ?? "")}
                </select></label
            ><span class="hint">Showing up to 100 matching items.</span>
        </div>`;
  const isOperator = state.overview.access.operator;
  const isSelf = u.id === state.me.id;

  mount(
    body,
    html`
            <div class="ident">
                ${avatar(u, "large")}
                <div>
                    <h2>${userName(u)}</h2>
                    <span class="muted">${userTag(u)}</span>
                    <code class="muted">${u.id}</code>
                </div>
            </div>
            ${userBadges(u)}
            ${isOperator && !u.bot && !u.system ? html`<a class="btn" href="#/official/${u.id}">Message as Official</a>` : ""}
            <div class="card">
                <div class="list">
                    <div class="list-item"><span class="grow muted">Email</span><span>${u.email || "—"}</span></div>
                    <div class="list-item"><span class="grow muted">Registered</span><span>${fmtDate(u.created_at)}</span></div>
                    <div class="list-item"><span class="grow muted">Active sessions</span><span>${fmtNumber(u.session_count)}</span></div>
                </div>
            </div>

            <form id="user-form" class="card stack">
                <h3>Profile & account</h3>
                <label>Username<input name="username" value="${u.username}" minlength="2" maxlength="32" required /></label>
                <label>Pronouns<input name="pronouns" value="${u.pronouns ?? ""}" maxlength="40" /></label>
                <div class="form-grid">
                    ${imageField("avatar", "Avatar", u.avatar)} ${imageField("banner", "Profile banner", u.banner)}
                    <label>Accent color<input type="color" name="accent_color" value="${hexColor(u.accent_color)}" /></label>
                    <label class="toggle"
                        ><input type="checkbox" name="accent_default" ${u.accent_color == null ? raw("checked") : ""} /><span>Use automatic accent color</span></label
                    >
                    <label>Primary profile color<input type="color" name="theme_primary" value="${hexColor(u.theme_colors?.[0])}" /></label>
                    <label>Secondary profile color<input type="color" name="theme_secondary" value="${hexColor(u.theme_colors?.[1])}" /></label>
                    <label class="toggle"><input type="checkbox" name="theme_default" ${!u.theme_colors ? raw("checked") : ""} /><span>Use default profile theme</span></label>
                </div>
                <label>Display name<input name="global_name" value="${u.global_name ?? ""}" maxlength="32" placeholder="${u.username}" /></label>
                <label>Bio<textarea name="bio" maxlength="1024">${u.bio ?? ""}</textarea></label>
                <div class="form-grid">
                    ${cosmeticField(0, "avatar_decoration_sku_id", "Avatar decoration", u.avatar_decoration_sku_id)}
                    ${cosmeticField(2, "nameplate_sku_id", "Nameplate", u.nameplate_sku_id)} ${cosmeticField(1, "profile_effect_sku_id", "Profile effect", cosmeticOf(1))}
                    ${cosmeticField(3, "profile_frame_sku_id", "Profile frame", cosmeticOf(3))}
                </div>
                <div class="stack">
                    <h3>Name tag</h3>
                    <div class="row">
                        <select name="tag" class="grow" style="max-width:260px">
                            ${options(USER_TAGS, u.tag ?? "none")}
                        </select>
                        <span class="row" style="gap:6px"><span class="muted">Preview</span><strong>${userName(u)}</strong><span id="tag-preview"></span></span>
                    </div>
                    <span class="hint muted" id="tag-hint"></span>
                </div>
                <div class="stack">
                    <div class="row" style="justify-content:space-between">
                        <h3>Profile badges</h3>
                        ${
                          isOperator
                            ? html`
                                <a class="btn small ghost" href="#/badges">Manage badges</a>
                              `
                            : ""
                        }
                    </div>
                    ${
                      badges.length
                        ? html`<div class="checks">
                                  ${badges.map(
                                    (b) =>
                                      html`<label class="toggle"
                                              ><input type="checkbox" name="badge" value="${b.id}" ${u.badge_ids?.includes(b.id) ? raw("checked") : ""} /><span
                                                  class="row"
                                                  style="gap:8px"
                                                  >${badgeIcon(b)}${b.description}</span
                                              ></label
                                          >`,
                                  )}
                              </div>`
                        : html`<p class="muted" style="margin:0">No badges yet.${
                            isOperator
                              ? html`
                                  <a href="#/badges">Create one</a>.
                                `
                              : ""
                          }</p>`
                    }
                </div>
                <label class="toggle"><input type="checkbox" name="verified" ${u.verified ? raw("checked") : ""} /><span>Email verified</span></label>
                <label class="toggle"
                    ><input type="checkbox" name="disabled" ${u.disabled ? raw("checked") : ""} ${isSelf ? raw("disabled") : ""} /><span
                        >Account disabled<span class="hint">Blocks sign-in and API access and ends their sessions. Reversible.</span></span
                    ></label
                >
                ${
                  isOperator
                    ? html`
                              <div class="stack">
                                  <h3>Instance rights</h3>
                                  <div class="checks">
                                      ${RIGHTS.map(
                                        ([name, bit, hint]) =>
                                          html`<label class="toggle"
                                                  ><input
                                                      type="checkbox"
                                                      data-right="${bit}"
                                                      ${hasRight(u.rights, bit) ? raw("checked") : ""}
                                                      ${isSelf && bit === 0 ? raw("disabled") : ""}
                                                  /><span><code>${name}</code><span class="hint">${hint}</span></span></label
                                              >`,
                                      )}
                                  </div>
                              </div>
                          `
                    : ""
                }
                <div class="form-actions"><button class="btn primary" type="submit">Save user</button></div>
            </form>

            <div class="card stack" id="standing-card"></div>
            <div class="card stack" id="security-card"></div>
            <div class="card stack" id="sessions-card"></div>

            ${
              u.guilds.length
                ? html`<div class="card">
                          <h3>Servers (${u.guilds.length})</h3>
                          <div class="list">
                              ${u.guilds.map(
                                (g) =>
                                  html`<div class="list-item">
                                          ${guildIcon(g)}<span class="grow">${g.name}</span>${
                                            g.owner
                                              ? html`
                                                  <span class="badge accent">Owner</span>
                                                `
                                              : ""
                                          }
                                          ${state.overview.access.guilds ? html`<button class="btn small ghost" data-guild="${g.id}" type="button">Open</button>` : ""}
                                      </div>`,
                              )}
                          </div>
                      </div>`
                : ""
            }
            ${
              u.instance_bans.length
                ? html`<div class="card">
                          <h3>Instance bans</h3>
                          <div class="list">
                              ${u.instance_bans.map((b) => html`<div class="list-item"><span class="grow">${b.reason}</span><span class="muted">${fmtDay(b.created_at)}</span></div>`)}
                          </div>
                      </div>`
                : ""
            }
            ${
              !isSelf
                ? html`
                    <div class="card danger-zone stack">
                      <h3>Danger zone</h3>
                      <p class="muted" style="margin: 0">
                        Permanently deletes the account, its DMs and memberships, and hands owned servers to the
                        next-highest member. This can't be undone.
                      </p>
                      <label class="toggle"
                        ><input type="checkbox" id="ban-persist" checked /><span
                          >Ban them from registering again<span class="hint"
                            >Adds them to the instance ban list with the reason below.</span
                          ></span
                        ></label
                      >
                      <label>Reason<input id="ban-reason" placeholder="Shown in the instance ban list" /></label>
                      <div><button class="btn danger" id="ban-user" type="button">Delete & ban user</button></div>
                    </div>
                  `
                : ""
            }
        `,
  );

  import("/admin/user-customization.js")
    .then(({ mountUserCustomization }) => {
      if (body.isConnected && !$("#drawer").hidden) mountUserCustomization(body, u, { api, toast });
    })
    .catch(() => toast("Could not load account customization", "err"));
  $("#user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const patch = {
      username: form.username.value,
      pronouns: form.pronouns.value,
      accent_color: form.accent_default.checked
        ? null
        : parseInt(form.accent_color.value.slice(1), 16),
      theme_colors: form.theme_default.checked
        ? null
        : [form.theme_primary, form.theme_secondary].map((input) =>
            parseInt(input.value.slice(1), 16),
          ),
      global_name: form.global_name.value,
      bio: form.bio.value,
      verified: form.verified.checked,
      tag: form.tag.value,
    };
    // keep the order badges were originally given in, appending new ones
    for (const field of ["avatar_decoration_sku_id", "nameplate_sku_id"]) {
      if (form.elements[field].value !== (u[field] ?? ""))
        patch[field] = form.elements[field].value || null;
    }
    if (
      form.profile_effect_sku_id.value !== cosmeticOf(1) ||
      form.profile_frame_sku_id.value !== cosmeticOf(3)
    )
      patch.collectibles_sku_ids = [
        form.profile_effect_sku_id.value,
        form.profile_frame_sku_id.value,
      ].filter(Boolean);
    const checked = $$("input[name=badge]:checked", form).map((x) => x.value);
    const nextBadges = [
      ...(u.badge_ids ?? []).filter((b) => checked.includes(b)),
      ...checked.filter((b) => !(u.badge_ids ?? []).includes(b)),
    ];
    if (JSON.stringify(nextBadges) !== JSON.stringify(u.badge_ids ?? []))
      patch.badge_ids = nextBadges;
    if (!isSelf) patch.disabled = form.disabled.checked;
    if (isOperator) {
      let rights = BigInt(u.rights || 0);
      for (const box of $$("[data-right]", form)) {
        const bit = 1n << BigInt(box.dataset.right);
        rights = box.checked ? rights | bit : rights & ~bit;
      }
      if (rights.toString() !== String(u.rights)) patch.rights = rights.toString();
    }
    const saved = await act(
      $("button[type=submit]", form),
      async () => {
        await imagePatch(form, ["avatar", "banner"], patch);
        return api(`/admin/users/${u.id}`, { method: "PATCH", body: patch });
      },
      "User updated",
    );
    if (saved && form.isConnected && !$("#drawer").hidden && !form.dataset.dirty) {
      reload?.();
      openUser(u.id, reload);
    }
  });

  for (const input of $$("[data-cosmetic-search]", body))
    input.addEventListener(
      "input",
      debounce(() => {
        const select = $("#user-form", body).elements[input.dataset.cosmeticSearch];
        mount(
          select,
          options(
            choicesFor(Number(input.dataset.cosmeticType), select.value, input.value),
            select.value,
          ),
        );
      }, 150),
    );

  const syncTag = () => {
    const tag = $("#user-form").tag.value;
    mount($("#tag-preview"), nameTag(tag, u.bot));
    $("#tag-hint").textContent =
      tag === "verified_bot" && !u.bot
        ? "Verified Bot only shows on bot accounts. This is a regular user, so their name will show no tag."
        : (USER_TAGS.find(([k]) => k === tag)?.[2] ?? "");
  };
  $("#user-form").tag.addEventListener("change", syncTag);
  syncTag();

  for (const btn of $$("[data-guild]", body))
    btn.addEventListener("click", () => openGuild(btn.dataset.guild));

  const renderStanding = () => {
    const [, label, tone] = standingOf(standing.standing.state);
    const card = $("#standing-card");
    mount(
      card,
      html`
                <div class="row" style="justify-content:space-between">
                    <h3>Account standing</h3>
                    <span class="badge ${tone}" style="font-size:12px;padding:3px 10px"><span class="dot"></span>${label}</span>
                </div>
                <label
                    >Standing<span class="hint"
                        >What the user sees on their Account Standing page. Automatic goes down one step per active violation (suspended for disabled accounts).</span
                    ><select name="standing">
                        <option value="">Automatic (${standingOf(standing.standing.automatic)[1].toLowerCase()})</option>
                        ${options(STANDINGS, standing.standing.override ?? "")}
                    </select></label
                >
                <div class="stack">
                    <h3>Violations (${standing.violations.length})</h3>
                    ${
                      standing.violations.length
                        ? standing.violations.map(
                            (v) =>
                              html`<div class="violation ${v.active ? "" : "inactive"}" data-violation="${v.id}">
                                          <div class="row">
                                              <strong class="grow">${violationType(v.classification_type)}</strong>
                                              ${
                                                v.appeal_status === 1
                                                  ? html`
                                                      <span class="badge warn">Appeal pending</span>
                                                    `
                                                  : ""
                                              }
                                              ${
                                                v.appeal_status === 2
                                                  ? html`
                                                      <span class="badge">Appeal denied</span>
                                                    `
                                                  : ""
                                              }
                                              ${
                                                v.appeal_status === 3
                                                  ? html`
                                                      <span class="badge ok">Overturned</span>
                                                    `
                                                  : ""
                                              }
                                              ${
                                                v.active
                                                  ? html`
                                                      <span class="badge danger">Active</span>
                                                    `
                                                  : v.appeal_status !== 3
                                                    ? html`
                                                        <span class="badge">Expired</span>
                                                      `
                                                    : ""
                                              }
                                          </div>
                                          <p>${v.description}</p>
                                          ${
                                            v.appeal_status
                                              ? html`<div class="appeal-note">
                                                        <strong>Appeal</strong> · ${APPEAL_REASONS[v.appeal_signal ?? 3]}${v.appealed_at ? html` · ${fmtDate(v.appealed_at)}` : ""}
                                                        ${v.appeal_user_input ? html`<p>${v.appeal_user_input}</p>` : ""}
                                                    </div>`
                                              : ""
                                          }
                                          ${v.actions.length ? html`<div class="badges">${v.actions.map((a) => html`<span class="badge">${violationAction(a.action_type)}</span>`)}</div>` : ""}
                                          <div class="muted">
                                              Issued ${fmtDate(v.created_at)}${v.issued_by ? html` by ${userName(v.issued_by)}` : ""} ·
                                              ${v.permanent ? "Permanent" : html`${v.active || new Date(v.expires_at) > new Date() ? "Expires" : "Expired"} ${fmtDate(v.expires_at)}`}
                                          </div>
                                          <div class="row" style="justify-content:flex-end">
                                              ${
                                                v.appeal_status === 1
                                                  ? html`
                                                      <button class="btn small" type="button" data-appeal="2">Deny appeal</button
                                                      ><button class="btn small primary" type="button" data-appeal="3">Overturn</button>
                                                    `
                                                  : ""
                                              }
                                              <button class="btn small ghost" type="button" data-remove-violation>Remove</button>
                                          </div>
                                      </div>`,
                          )
                        : html`
                            <p class="muted" style="margin: 0">No violations.</p>
                          `
                    }
                </div>
                <details class="stack">
                    <summary class="btn small" style="width:max-content">Add violation</summary>
                    <form id="violation-form" class="stack" style="margin-top:12px">
                        <label
                            >Type<select name="classification_type">
                                ${options(VIOLATION_TYPES, 3030)}
                            </select></label
                        >
                        <label
                            >Message to the user<span class="hint">Shown on their Account Standing page.</span
                            ><textarea name="description" required maxlength="2000" placeholder="You sent unsolicited advertisements to other members."></textarea>
                        </label>
                        <div class="stack">
                            <span class="muted">Actions taken</span>
                            <div class="checks">
                                ${VIOLATION_ACTIONS.map(
                                  ([id, label]) =>
                                    html`<label class="toggle"
                                            ><input type="checkbox" name="action" value="${id}" ${id === 4 ? raw("checked") : ""} /><span>${label}</span></label
                                        >`,
                                )}
                            </div>
                        </div>
                        <label
                            >Counts against them for<select name="duration">
                                ${options(VIOLATION_DURATIONS, 90)}
                            </select></label
                        >
                        <p class="muted" style="margin:0">This records the violation and its effect on their standing. To actually restrict the account, disable it above.</p>
                        <div class="form-actions"><button class="btn danger" type="submit">Add violation</button></div>
                    </form>
                </details>
            `,
    );

    card.querySelector("[name=standing]").addEventListener("change", async (e) => {
      const value = e.target.value === "" ? null : Number(e.target.value);
      const saved = await act(
        e.target,
        () => api(`/admin/users/${u.id}`, { method: "PATCH", body: { account_standing: value } }),
        "Standing updated",
      );
      if (saved) {
        standing = await api(`/admin/users/${u.id}/violations`);
        renderStanding();
      }
    });

    for (const row of $$("[data-violation]", card)) {
      const vid = row.dataset.violation;
      for (const btn of $$("[data-appeal]", row))
        btn.addEventListener("click", async () => {
          const next = await act(
            btn,
            () =>
              api(`/admin/users/${u.id}/violations/${vid}`, {
                method: "PATCH",
                body: { appeal_status: Number(btn.dataset.appeal) },
              }),
            btn.dataset.appeal === "3" ? "Violation overturned" : "Appeal denied",
          );
          if (next) {
            standing = next;
            renderStanding();
          }
        });
      $("[data-remove-violation]", row).addEventListener("click", async (e) => {
        if (
          !confirm("Remove this violation completely? Use Overturn instead to keep a record of it.")
        )
          return;
        const next = await act(
          e.currentTarget,
          () => api(`/admin/users/${u.id}/violations/${vid}`, { method: "DELETE" }),
          "Violation removed",
        );
        if (next) {
          standing = next;
          renderStanding();
        }
      });
    }

    $("#violation-form", card).addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const payload = {
        classification_type: Number(form.classification_type.value),
        description: form.description.value,
        actions: $$("input[name=action]:checked", form).map((x) => ({
          action_type: Number(x.value),
        })),
        expires_in_days: form.duration.value ? Number(form.duration.value) : null,
      };
      const next = await act(
        $("button[type=submit]", form),
        () => api(`/admin/users/${u.id}/violations`, { method: "POST", body: payload }),
        "Violation added",
      );
      if (next) {
        standing = next;
        renderStanding();
      }
    });
  };
  renderStanding();
  renderUserSecurity(u);
  renderUserSessions(u);

  $("#ban-persist")?.addEventListener("change", (e) => {
    $("#ban-user").textContent = e.target.checked ? "Delete & ban user" : "Delete user";
  });
  $("#ban-user")?.addEventListener("click", async (e) => {
    const ban = $("#ban-persist").checked;
    if (
      !confirm(`Permanently delete${ban ? " and ban" : ""} ${userName(u)}? This can't be undone.`)
    )
      return;
    const reason =
      $("#ban-reason").value.trim() ||
      `${ban ? "Banned" : "Deleted"} from the admin dashboard by ${state.me.username}`;
    const done = await act(
      e.currentTarget,
      () =>
        api(`/users/${u.id}/delete`, { method: "POST", body: { reason, persistInstanceBan: ban } }),
      `${userName(u)} was deleted${ban ? " and banned" : ""}`,
    );
    if (done !== undefined) {
      closeDrawer();
      reload?.();
    }
  });
}

const describeClient = (session) => {
  const info = session.client_info ?? {};
  const parts = [info.browser ?? info.client ?? info.platform, info.os].filter(Boolean);
  return parts.length ? parts.join(" on ") : "Unknown client";
};

async function renderUserSecurity(u) {
  const card = $("#security-card");
  if (!card) return;
  const isSelf = u.id === state.me.id;
  let mfa;
  try {
    mfa = await api(`/admin/users/${u.id}/mfa`);
  } catch (e) {
    return mount(
      card,
      html`<h3>Sign-in & security</h3>
                <p class="form-error">${e.message}</p>`,
    );
  }
  const methods = [
    mfa.totp ? "an authenticator app" : null,
    mfa.security_keys
      ? `${mfa.security_keys} security ${mfa.security_keys === 1 ? "key" : "keys"}`
      : null,
  ].filter(Boolean);
  mount(
    card,
    html`
            <h3>Sign-in & security</h3>
            <div class="list">
                <div class="list-item">
                    <div class="grow">
                        <strong>Two-factor authentication</strong>
                        <div class="muted">
                            ${
                              mfa.mfa_enabled
                                ? html`On with
                                      ${methods.join(" and ") || "a method this page can't name"}${mfa.backup_codes ? html`, ${fmtNumber(mfa.backup_codes)} backup codes left` : ""}`
                                : "Off"
                            }
                        </div>
                    </div>
                    ${
                      mfa.mfa_enabled && !isSelf
                        ? html`
                            <button class="btn small" id="mfa-reset" type="button">Turn off 2FA</button>
                          `
                        : ""
                    }
                </div>
                <div class="list-item">
                    <div class="grow">
                        <strong>Password</strong>
                        <div class="muted">
                            Make a reset link that works for one hour. ${u.email ? "It can also be emailed to them." : "They have no email, so send them the link yourself."}
                        </div>
                    </div>
                    ${
                      !isSelf
                        ? html`
                            <button class="btn small" id="password-reset" type="button">Make reset link</button>
                          `
                        : ""
                    }
                </div>
            </div>
            <div id="reset-result" hidden></div>
        `,
  );

  $("#mfa-reset", card)?.addEventListener("click", async (e) => {
    if (
      !confirm(
        `Turn off two-factor for ${userName(u)}? Their authenticator app, security keys and backup codes stop working, and they can sign in with only their password.`,
      )
    )
      return;
    const done = await act(
      e.currentTarget,
      () => api(`/admin/users/${u.id}/mfa`, { method: "DELETE" }),
      "Two-factor turned off",
    );
    if (done !== undefined) renderUserSecurity(u);
  });
  $("#password-reset", card)?.addEventListener("click", (e) => {
    e.currentTarget.hidden = true;
    const result = $("#reset-result", card);
    result.hidden = false;
    mount(
      result,
      html`<form id="reset-form" class="stack" style="gap:10px">
                ${
                  u.email
                    ? html`<label class="toggle"
                              ><input type="checkbox" name="send_email" checked /><span
                                  >Email the link to ${u.email}<span class="hint">Only sent when the instance has email set up.</span></span
                              ></label
                          >`
                    : ""
                }
                <label class="toggle"
                    ><input type="checkbox" name="revoke_sessions" /><span
                        >Sign them out everywhere<span class="hint">Use this when the account might be compromised.</span></span
                    ></label
                >
                <div class="form-actions" style="margin-top:0"><button class="btn primary small" type="submit">Make reset link</button></div>
            </form>`,
    );
    $("#reset-form", result).addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const body = {
        send_email: !!form.send_email?.checked,
        revoke_sessions: form.revoke_sessions.checked,
      };
      const out = await act($("button[type=submit]", form), () =>
        api(`/admin/users/${u.id}/password-reset`, { method: "POST", body }),
      );
      if (!out) return;
      mount(
        result,
        html`<div class="stack" style="gap:8px">
                    <label
                        >Reset link<span class="hint">Works once, for one hour, and stops working if they change their password another way.</span
                        ><input id="reset-link" readonly value="${out.link}"
                    /></label>
                    <div class="row">
                        <button class="btn small" id="copy-reset" type="button">Copy link</button>
                        <span class="muted"
                            >${out.emailed ? `Also emailed to ${u.email}.` : body.send_email ? "Email isn't set up on this instance, so nothing was sent." : ""}${
                              body.revoke_sessions ? " Their sessions were ended." : ""
                            }</span
                        >
                    </div>
                </div>`,
      );
      $("#copy-reset", result).addEventListener("click", () =>
        navigator.clipboard.writeText(out.link).then(
          () => toast("Link copied"),
          () => $("#reset-link", result).select(),
        ),
      );
      if (body.revoke_sessions) renderUserSessions(u);
    });
  });
}

async function renderUserSessions(u) {
  const card = $("#sessions-card");
  if (!card) return;
  let sessions;
  try {
    sessions = await api(`/admin/users/${u.id}/sessions`);
  } catch (e) {
    return mount(
      card,
      html`<h3>Sessions</h3>
                <p class="form-error">${e.message}</p>`,
    );
  }
  mount(
    card,
    html`
            <div class="row" style="justify-content:space-between">
                <h3>Sessions (${sessions.length})</h3>
                ${
                  sessions.length
                    ? html`
                        <button class="btn small" id="sessions-end-all" type="button">Sign out everywhere</button>
                      `
                    : ""
                }
            </div>
            ${
              sessions.length
                ? html`<div class="list">
                          ${sessions.map(
                            (s) =>
                              html`<div class="list-item" data-session="${s.id}">
                                      <div class="grow">
                                          <strong>${describeClient(s)}</strong>
                                          <div class="muted">
                                              Last active
                                              ${fmtDate(s.last_seen ?? s.created_at)}${s.last_seen_location ? html` · ${s.last_seen_location}` : ""}${
                                                s.last_seen_ip
                                                  ? html` · <code>${s.last_seen_ip}</code>`
                                                  : ""
                                              }
                                              · signed in ${fmtDay(s.created_at)}
                                          </div>
                                      </div>
                                      <button class="btn small ghost" type="button" data-end>Sign out</button>
                                  </div>`,
                          )}
                      </div>`
                : html`
                    <p class="muted" style="margin: 0">Not signed in anywhere.</p>
                  `
            }
        `,
  );
  const end = async (button, sessionIds) => {
    const done = await act(
      button,
      () =>
        api(`/admin/users/${u.id}/sessions/logout`, {
          method: "POST",
          body: sessionIds ? { session_ids: sessionIds } : {},
        }),
      sessionIds ? "Session ended" : "Signed out everywhere",
    );
    if (done !== undefined) renderUserSessions(u);
  };
  for (const row of $$("[data-session]", card))
    $("[data-end]", row).addEventListener("click", (e) =>
      end(e.currentTarget, [row.dataset.session]),
    );
  $("#sessions-end-all", card)?.addEventListener("click", (e) => {
    if (
      confirm(`Sign ${userName(u)} out of every session? They'll have to sign in again everywhere.`)
    )
      end(e.currentTarget);
  });
}

/* ---------- reports ---------- */

const REPORT_TYPES = {
  message: "Message",
  first_dm: "First DM",
  user: "User",
  guild: "Server",
  guild_discovery: "Server in Discovery",
  guild_directory_entry: "Directory entry",
  guild_scheduled_event: "Event",
  stage_channel: "Stage",
  application: "App",
  widget: "Profile widget",
};
const REPORT_STATUSES = [
  ["open", "Open", "warn"],
  ["resolved", "Resolved", "ok"],
  ["dismissed", "Dismissed", ""],
];
const reportStatus = (key) => REPORT_STATUSES.find(([k]) => k === key) ?? REPORT_STATUSES[0];

const guessViolationType = (reason) => {
  const text = (reason ?? "").toLowerCase();
  const rules = [
    ["spam", 3030],
    ["scam", 4010],
    ["fraud", 4010],
    ["impersonat", 711],
    ["hate", 320],
    ["harass", 290],
    ["abuse", 290],
    ["violence", 210],
    ["self-harm", 5090],
    ["self harm", 5090],
    ["minor", 280],
    ["private identifying", 5305],
    ["sexual", 100],
    ["porn", 100],
    ["illegal goods", 240],
    ["drugs", 240],
    ["stolen accounts", 230],
    ["too young", 5411],
  ];
  return rules.find(([needle]) => text.includes(needle))?.[1] ?? 1;
};

const reportsState = { status: "open", offset: 0, limit: 50 };

async function renderReports(view) {
  mount(
    view,
    html`
      <div class="page-head">
        <div>
          <h1>Reports</h1>
          <p class="muted">
            Everything people reported from the client's Report menus. Click a report to review it and act
            on it.
          </p>
        </div>
      </div>
      <div class="row" id="report-tabs" style="margin-bottom: 12px"></div>
      <div id="report-results"><div class="spinner">Loading…</div></div>
    `,
  );

  const load = async () => {
    const params = new URLSearchParams({
      status: reportsState.status,
      limit: reportsState.limit,
      offset: reportsState.offset,
    });
    const { reports, total, counts } = await api(`/admin/reports?${params}`);
    const tabs = $("#report-tabs");
    const results = $("#report-results");
    if (!results) return;
    mount(
      tabs,
      [...REPORT_STATUSES, ["all", "All"]].map(
        ([key, label]) =>
          html`<button class="btn small ${reportsState.status === key ? "primary" : ""}" type="button" data-status="${key}">
                        ${label}${key !== "all" ? html` <span class="muted" style="${reportsState.status === key ? "color:inherit" : ""}">${fmtNumber(counts[key])}</span>` : ""}
                    </button>`,
      ),
    );
    mount(
      results,
      reports.length
        ? html`
                      <div class="table-wrap">
                          <table>
                              <thead>
                                  <tr>
                                      <th>Report</th>
                                      <th>Reported</th>
                                      <th class="hide-sm">By</th>
                                      <th class="hide-sm">When</th>
                                      <th>Status</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${reports.map(
                                    (r) => html`
                                          <tr data-id="${r.id}">
                                              <td>
                                                  <strong>${REPORT_TYPES[r.type] ?? r.type}</strong>
                                                  <div class="muted">${r.reason || "No reason picked"}</div>
                                              </td>
                                              <td>${reportTarget(r)}</td>
                                              <td class="hide-sm">
                                                  ${r.reporter ? html`<div class="ident">${avatar(r.reporter)}<span>${userName(r.reporter)}</span></div>` : "—"}
                                              </td>
                                              <td class="hide-sm">${fmtDate(r.created_at)}</td>
                                              <td><span class="badge ${reportStatus(r.status)[2]}">${reportStatus(r.status)[1]}</span></td>
                                          </tr>
                                      `,
                                  )}
                              </tbody>
                          </table>
                      </div>
                      ${pager(total, reportsState)}
                  `
        : html`<div class="card empty">${reportsState.status === "open" ? "No open reports. Reports people send from the client show up here." : "No reports here."}</div>`,
    );
    for (const btn of $$("[data-status]", tabs))
      btn.addEventListener("click", () => {
        reportsState.status = btn.dataset.status;
        reportsState.offset = 0;
        load();
      });
    for (const row of $$("tbody tr", results))
      row.addEventListener("click", () =>
        openReport(
          reports.find((r) => r.id === row.dataset.id),
          load,
        ),
      );
    bindPager(results, total, reportsState, load);
  };
  await load();
}

const reportTarget = (r) => {
  if (r.reported_user)
    return html`<div class="ident">${avatar(r.reported_user)}<span>${userName(r.reported_user)}</span></div>`;
  if (r.guild)
    return html`<div class="ident">${guildIcon(r.guild)}<span>${r.guild.name ?? r.guild.id}</span></div>`;
  if (r.application_id)
    return html`<span class="muted">App <code>${r.application_id}</code></span>`;
  return html`
    <span class="muted">—</span>
  `;
};

function openReport(r, reload) {
  const access = state.overview.access;
  const snap = r.snapshot ?? {};
  const answers = Object.entries(r.elements ?? {}).filter(([, v]) =>
    Array.isArray(v) ? v.length : v,
  );
  const isImage = (a) =>
    /^image\//.test(a.content_type ?? "") || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.filename);
  const images = (snap.attachments ?? []).filter(isImage);
  const files = (snap.attachments ?? []).filter((a) => !isImage(a));
  const lastReason = r.reason ? r.reason.split(" › ").pop() : "";
  const body = openDrawer(
    `${REPORT_TYPES[r.type] ?? r.type} report`,
    html`
            <div class="row" style="justify-content:space-between">
                <div>
                    <h2>${r.reason || "No reason picked"}</h2>
                    <span class="muted">Reported ${fmtDate(r.created_at)}</span>
                </div>
                <span class="badge ${reportStatus(r.status)[2]}" style="font-size:12px;padding:3px 10px"><span class="dot"></span>${reportStatus(r.status)[1]}</span>
            </div>

            ${
              snap.content !== undefined
                ? html`<div class="card stack" style="gap:8px">
                          <div class="row" style="justify-content:space-between">
                              <h3 style="margin:0">${r.type === "widget" ? `Reported widget${snap.name ? `: ${snap.name}` : ""}` : "Reported message"}</h3>
                              ${
                                r.type === "widget"
                                  ? ""
                                  : r.message_exists
                                    ? html`
                                        <span class="badge">Still posted</span>
                                      `
                                    : html`
                                        <span class="badge danger">Deleted</span>
                                      `
                              }
                          </div>
                          ${
                            snap.author
                              ? html`<div class="ident">
                                        ${avatar(snap.author)}
                                        <div><strong>${userName(snap.author)}</strong><span class="muted">${fmtDate(snap.sent_at)}</span></div>
                                    </div>`
                              : ""
                          }
                          <p style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere">${
                            snap.content ||
                            html`
                              <span class="muted">No text</span>
                            `
                          }</p>
                          ${
                            images.length
                              ? html`<div class="report-attachments">
                                        ${images.map((a) => html`<a href="${a.url}" target="_blank" rel="noopener"><img src="${a.url}" alt="Attachment ${a.filename}" loading="lazy" /></a>`)}
                                    </div>`
                              : ""
                          }
                          ${
                            files.length
                              ? html`<div class="list">
                                        ${files.map((a) => html`<div class="list-item"><a href="${a.url}" target="_blank" rel="noopener" class="grow">${a.filename}</a><span class="muted">${a.content_type ?? ""}</span></div>`)}
                                    </div>`
                              : ""
                          }
                          ${snap.embeds ? html`<span class="muted">${fmtNumber(snap.embeds)} ${snap.embeds === 1 ? "embed" : "embeds"} not shown</span>` : ""}
                          <span class="muted">This is how the message looked when it was reported.</span>
                      </div>`
                : ""
            }

            <div class="card">
                <div class="list">
                    ${
                      r.reported_user
                        ? html`<div class="list-item">
                                  <span class="grow muted">Reported user</span>
                                  <span class="ident">${avatar(r.reported_user)}<span>${userName(r.reported_user)}</span></span>
                                  ${
                                    r.reported_user.disabled
                                      ? html`
                                          <span class="badge danger">Disabled</span>
                                        `
                                      : ""
                                  }
                                  ${access.users ? html`<button class="btn small ghost" type="button" data-open-user="${r.reported_user.id}">Open</button>` : ""}
                              </div>`
                        : ""
                    }
                    ${
                      r.guild
                        ? html`<div class="list-item">
                                  <span class="grow muted">Server</span>
                                  <span class="ident">${guildIcon(r.guild)}<span>${r.guild.name ?? r.guild.id}</span></span>
                                  ${access.guilds && r.guild.name ? html`<button class="btn small ghost" type="button" data-open-guild="${r.guild.id}">Open</button>` : ""}
                              </div>`
                        : ""
                    }
                    ${r.channel ? html`<div class="list-item"><span class="grow muted">Channel</span><span>${r.channel.name ? `#${r.channel.name}` : html`<code>${r.channel.id}</code>`}</span></div>` : ""}
                    ${r.application_id ? html`<div class="list-item"><span class="grow muted">App</span><code>${r.application_id}</code></div>` : ""}
                    ${r.guild_scheduled_event_id ? html`<div class="list-item"><span class="grow muted">Event</span><code>${r.guild_scheduled_event_id}</code></div>` : ""}
                    <div class="list-item">
                        <span class="grow muted">Reported by</span>
                        ${r.reporter ? html`<span class="ident">${avatar(r.reporter)}<span>${userName(r.reporter)}</span></span>` : "—"}
                        ${r.reporter && access.users ? html`<button class="btn small ghost" type="button" data-open-user="${r.reporter.id}">Open</button>` : ""}
                    </div>
                    ${answers.map(
                      ([key, value]) =>
                        html`<div class="list-item">
                                <span class="grow muted">${key.replace(/_/g, " ")}</span
                                ><span style="white-space:pre-wrap;text-align:right">${Array.isArray(value) ? value.join(", ") : value}</span>
                            </div>`,
                    )}
                </div>
            </div>

            ${
              r.status !== "open"
                ? html`<div class="card">
                          <div class="list">
                              <div class="list-item">
                                  <span class="grow muted">${reportStatus(r.status)[1]} by</span><span>${r.resolved_by ? userName(r.resolved_by) : "—"}</span>
                              </div>
                              <div class="list-item"><span class="grow muted">On</span><span>${fmtDate(r.resolved_at)}</span></div>
                              ${r.resolution_note ? html`<div class="list-item"><span class="grow muted">Note</span><span style="white-space:pre-wrap">${r.resolution_note}</span></div>` : ""}
                              ${r.violation_id ? html`<div class="list-item"><span class="grow muted">Violation</span><code>${r.violation_id}</code></div>` : ""}
                          </div>
                      </div>`
                : ""
            }
            ${
              r.status === "open" && r.reported_user && access.users
                ? html`<form id="report-violation" class="card stack">
                          <h3>Issue a violation</h3>
                          <label
                              >Type<select name="classification_type">
                                  ${options(VIOLATION_TYPES, guessViolationType(r.reason))}
                              </select></label
                          >
                          <label
                              >Message to the user<span class="hint"
                                  >Shown on their Account Standing page${snap.content !== undefined ? ", with the reported message attached" : ""}.</span
                              ><textarea name="description" required maxlength="2000">${lastReason ? `Reported for: ${lastReason}` : ""}</textarea>
                          </label>
                          <div class="stack">
                              <span class="muted">Actions taken</span>
                              <div class="checks">
                                  ${VIOLATION_ACTIONS.map(
                                    ([id, label]) =>
                                      html`<label class="toggle"
                                              ><input type="checkbox" name="action" value="${id}" ${id === 4 ? raw("checked") : ""} /><span>${label}</span></label
                                          >`,
                                  )}
                              </div>
                          </div>
                          <label
                              >Counts against them for<select name="duration">
                                  ${options(VIOLATION_DURATIONS, 90)}
                              </select></label
                          >
                          <div class="form-actions">
                              <button class="btn danger" type="submit">Issue violation</button>
                          </div>
                      </form>`
                : ""
            }

            <form id="report-form" class="card stack">
                <h3>${r.status === "open" ? "Close this report" : "Change the outcome"}</h3>
                <label>Note<span class="hint">For staff only. The reporter isn't told.</span><textarea name="note" maxlength="2000">${r.resolution_note ?? ""}</textarea></label>
                ${
                  r.message_exists && access.messages
                    ? html`
                        <label class="toggle"
                          ><input type="checkbox" name="delete_message" /><span
                            >Delete the reported message<span class="hint">Removes it for everyone.</span></span
                          ></label
                        >
                      `
                    : ""
                }
                <div class="form-actions">
                    ${
                      r.status !== "open"
                        ? html`
                            <button class="btn" type="submit" value="open">Reopen</button>
                          `
                        : ""
                    }
                    ${
                      r.status !== "dismissed"
                        ? html`
                            <button class="btn" type="submit" value="dismissed">Dismiss</button>
                          `
                        : ""
                    }
                    ${
                      r.status !== "resolved"
                        ? html`
                            <button class="btn primary" type="submit" value="resolved">Mark resolved</button>
                          `
                        : ""
                    }
                </div>
            </form>
        `,
  );
  if (!body) return;

  for (const btn of $$("[data-open-user]", body))
    btn.addEventListener("click", () => openUser(btn.dataset.openUser, reload));
  for (const btn of $$("[data-open-guild]", body))
    btn.addEventListener("click", () => openGuild(btn.dataset.openGuild, reload));

  $("#report-violation", body)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const payload = {
      classification_type: Number(form.classification_type.value),
      description: form.description.value,
      actions: $$("input[name=action]:checked", form).map((x) => ({
        action_type: Number(x.value),
      })),
      expires_in_days: form.duration.value ? Number(form.duration.value) : null,
    };
    const next = await act(
      $("button[type=submit]", form),
      () => api(`/admin/reports/${r.id}/violation`, { method: "POST", body: payload }),
      "Violation issued",
    );
    if (next) {
      reload?.();
      refreshOverviewCounts();
      openReport(next, reload);
    }
  });

  $("#report-form", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const status = e.submitter?.value ?? "resolved";
    const deleting = !!form.delete_message?.checked;
    if (deleting && !confirm("Delete the reported message for everyone?")) return;
    const next = await act(
      e.submitter,
      () =>
        api(`/admin/reports/${r.id}`, {
          method: "PATCH",
          body: {
            status,
            resolution_note: form.note.value,
            ...(deleting ? { delete_message: true } : {}),
          },
        }),
      { open: "Report reopened", dismissed: "Report dismissed", resolved: "Report resolved" }[
        status
      ],
    );
    if (next) {
      reload?.();
      refreshOverviewCounts();
      openReport(next, reload);
    }
  });
}

async function refreshOverviewCounts() {
  state.overview = await api("/admin").catch(() => state.overview);
  syncNavCounts();
}

function syncNavCounts() {
  const link = $('#nav a[data-tab="reports"]');
  if (!link) return;
  const open = state.overview?.counts?.open_reports ?? 0;
  mount(link, html`Reports${open ? html`<span class="nav-count">${fmtNumber(open)}</span>` : ""}`);
}

/* ---------- announcements ---------- */

function announcementProgress(announcement) {
  const d = announcement.delivery;
  if (!d) return "Legacy announcement: delivery progress was not recorded.";
  return `${fmtNumber(d.delivered)} delivered · ${fmtNumber(d.queued)} queued · ${fmtNumber(d.delivering)} sending · ${fmtNumber(d.failed)} failed`;
}

async function renderAnnouncements(view) {
  const { official, announcements } = await api("/admin/announcements");
  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Announcements</h1>
                    <p class="muted">
                        Sent as an encrypted direct message from <strong>${official.global_name || official.username}</strong>, the instance's official system account. Recipients without encryption keys wait until their account is ready.
                    </p>
                </div>
            </div>
            <div class="stack">
                <div class="card row" id="official-card">
                    <div class="ident grow">
                        ${avatar(official, "large")}
                        <div><strong>${official.global_name || official.username}</strong><span class="muted">${userTag(official)} · official account</span></div>
                    </div>
                    <label class="btn small">Change picture<input id="official-avatar" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden /></label>
                    ${
                      official.avatar
                        ? html`
                            <button class="btn small" id="official-avatar-remove" type="button">Remove</button>
                          `
                        : ""
                    }
                </div>
                <form id="announce-form" class="card stack">
                    <h2>New announcement</h2>
                    <label
                        >Message<span class="hint">Markdown works: **bold**, *italics*, links, lists.</span
                        ><textarea name="body" required maxlength="4000" rows="6" placeholder="We'll be upgrading the database at 23:00 UTC…"></textarea>
                    </label>
                    <label
                        >Attachments<span class="hint">Optional. Images, videos or any other files, sent along with the message.</span><input name="files" type="file" multiple
                    /></label>
                    <label
                        >Send to<select name="audience" style="max-width:320px">
                            ${options(
                              [
                                ["everyone", "Everyone on the instance"],
                                ["staff", "Staff only (admin panel access)"],
                                ["selected", "Selected users"],
                              ],
                              "everyone",
                            )}
                        </select></label
                    >
                    <label id="announce-selected" hidden>Recipient user IDs<span class="hint">1–100 unique user IDs, separated by commas or spaces.</span><textarea name="recipient_ids" rows="2" placeholder="123456789012345678, 234567890123456789"></textarea></label>
                    <p class="hint">Attachments have a combined 10 MiB limit. Delivery progress is retained across server restarts.</p>
                    <div class="form-actions"><button class="btn primary" type="submit">Send announcement</button></div>
                </form>
                <div class="stack">
                    <h2>Delivery history</h2>
                    ${
                      announcements.length
                        ? announcements.map(
                            (a) =>
                              html`<div class="card stack" style="gap:6px" data-id="${a.id}">
                                          <div class="row">
                                              <span class="grow muted">${fmtDate(a.created_at)}</span>
                                              <span class="badge">${a.audience === "staff" ? "Staff" : a.audience === "selected" ? "Selected" : "Everyone"} · ${fmtNumber(a.recipient_count)}</span>
                                              <button class="btn danger small announcement-delete" type="button">Delete</button>
                                          </div>
                                          <p class="muted announcement-progress" aria-live="polite">${announcementProgress(a)}</p>
                                          ${a.title ? html`<strong>${a.title}</strong>` : ""}
                                          <p style="margin:0;white-space:pre-wrap">${a.body}</p>
                                      </div>`,
                          )
                        : html`
                            <div class="card empty">Nothing sent yet.</div>
                          `
                    }
                </div>
            </div>
        `,
  );

  const currentForm = $("#announce-form", view);
  const selectedInput = $("#announce-selected", view);
  currentForm.audience.addEventListener("change", () => {
    selectedInput.hidden = currentForm.audience.value !== "selected";
    currentForm.recipient_ids.required = currentForm.audience.value === "selected";
  });
  const refreshProgress = async () => {
    if (!view.isConnected || $("#announce-form", view) !== currentForm) return;
    try {
      const result = await api("/admin/announcements");
      for (const entry of result.announcements) {
        const status = $(`[data-id="${entry.id}"] .announcement-progress`, view);
        if (status) status.textContent = announcementProgress(entry);
      }
    } catch {}
    if (view.isConnected && $("#announce-form", view) === currentForm)
      setTimeout(refreshProgress, 10_000);
  };
  setTimeout(refreshProgress, 10_000);

  $("#announce-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const audience = form.audience.value;
    if (
      audience === "everyone" &&
      !confirm("Send this announcement to every user on the instance?")
    )
      return;
    const payload = { body: form.body.value, audience };
    if (audience === "selected")
      payload.recipient_ids = form.recipient_ids.value
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
    const files = [...form.files.files];
    if (files.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) {
      toast("Attachments exceed the combined 10 MiB limit", "error");
      return;
    }
    let body = payload;
    if (files.length) {
      body = new FormData();
      body.append("payload_json", JSON.stringify(payload));
      files.forEach((file, i) => body.append(`files[${i}]`, file, file.name));
    }
    const sent = await act($("button[type=submit]", form), () =>
      api("/admin/announcements", { method: "POST", body }),
    );
    if (sent) {
      toast(
        `Queued for ${fmtNumber(sent.recipient_count)} ${sent.recipient_count === 1 ? "user" : "users"}`,
      );
      renderAnnouncements(view);
    }
  });

  const setOfficialAvatar = async (trigger, avatarData, success) => {
    const updated = await act(
      trigger,
      () => api("/admin/announcements/official", { method: "PATCH", body: { avatar: avatarData } }),
      success,
    );
    if (updated) renderAnnouncements(view);
  };
  $("#official-avatar").addEventListener("change", async (e) => {
    const file = e.currentTarget.files[0];
    if (file)
      await setOfficialAvatar(
        e.currentTarget.closest("label"),
        await readAsDataUrl(file),
        "Profile picture updated",
      );
  });
  $("#official-avatar-remove")?.addEventListener("click", (e) =>
    setOfficialAvatar(e.currentTarget, null, "Profile picture removed"),
  );

  for (const button of $$(".announcement-delete", view))
    button.addEventListener("click", async (e) => {
      const id = e.currentTarget.closest("[data-id]").dataset.id;
      if (
        !confirm(
          "Delete this announcement? Its message, and any attachments, are removed from every user's DMs.",
        )
      )
        return;
      const done = await act(
        e.currentTarget,
        () => api(`/admin/announcements/${id}`, { method: "DELETE" }),
        "Announcement deleted",
      );
      if (done !== undefined) renderAnnouncements(view);
    });
}

/* ---------- badges ---------- */

// discord's own badge art; the CDN proxies any icon hash it doesn't store from discord's CDN
const BADGE_PRESETS = [
  ["5e74e9b61934fc1f67c65515d1f7e60d", "Staff"],
  ["3f9748e53446a137a052f3454e2de41e", "Partnered Server Owner"],
  ["fee1624003e2fee35cb398e125dc479b", "Moderator Programs Alumni"],
  ["bf01d1073931f921909045f3a39fd264", "HypeSquad Events"],
  ["8a88d63823d8a71cd5e390baa45efa02", "HypeSquad Bravery"],
  ["011940fd013da3f7fb926e4a1cd2e618", "HypeSquad Brilliance"],
  ["3aa41de486fa12454c3761e8e223442e", "HypeSquad Balance"],
  ["2717692c7dca7289b35297368a940dd0", "Bug Hunter"],
  ["848f79194d4be5ff5f81505cbd0ce1e6", "Gold Bug Hunter"],
  ["6df5892e0f35b051f8b61eace34f4967", "Early Verified Bot Developer"],
  ["6bdc42827a38498929a4920da12695d9", "Active Developer"],
  ["7060786766c9c840eb3019e725d2b358", "Early Supporter"],
  ["2ba85e8026a8614b640c2837bcdfe21b", "Subscriber"],
  ["7d9ae358c8c5e118768335dbe68b4fb8", "Completed a Quest"],
  ["83d8a1eb09a8d64e59233eec5d4d5c2d", "Orbs Apprentice"],
];

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

async function renderBadges(view) {
  const badges = await api("/admin/badges");
  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Badges</h1>
                    <p class="muted">Badges shown on user profiles. Create them here, then give them to people from their user page.</p>
                </div>
                <button class="btn primary" id="new-badge" type="button">Create badge</button>
            </div>
            ${
              badges.length
                ? html`<div class="table-wrap">
                          <table>
                              <thead>
                                  <tr>
                                      <th>Badge</th>
                                      <th class="hide-sm">Link</th>
                                      <th>Given to</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${badges.map(
                                    (b) =>
                                      html`<tr data-id="${b.id}">
                                              <td>
                                                  <div class="ident">${badgeIcon(b)}<strong>${b.description}</strong></div>
                                              </td>
                                              <td class="hide-sm">${
                                                b.link
                                                  ? html`<span class="muted">${b.link}</span>`
                                                  : html`
                                                      <span class="muted">—</span>
                                                    `
                                              }</td>
                                              <td>${fmtNumber(b.holders)} ${b.holders === 1 ? "user" : "users"}</td>
                                          </tr>`,
                                  )}
                              </tbody>
                          </table>
                      </div>`
                : html`
                    <div class="card empty">No badges yet. Create one with your own icon or a preset.</div>
                  `
            }
        `,
  );
  const refresh = () => renderBadges(view);
  $("#new-badge").addEventListener("click", () => openBadge(null, refresh));
  for (const row of $$("tbody tr", view))
    row.addEventListener("click", () =>
      openBadge(
        badges.find((b) => b.id === row.dataset.id),
        refresh,
      ),
    );
}

function openBadge(badge, refresh) {
  let icon = badge?.icon ?? null;
  let iconData = null;
  const body = openDrawer(
    badge ? "Edit badge" : "Create badge",
    html`
            <form id="badge-form" class="stack">
                <div class="card row" style="gap:12px">
                    <span id="badge-preview" class="badge-preview"></span>
                    <div class="grow">
                        <strong id="badge-preview-text">${badge?.description ?? "Badge name"}</strong>
                        <div class="muted">Shown as a tooltip when hovering the badge on a profile.</div>
                    </div>
                </div>
                <label>Tooltip text<input name="description" required maxlength="120" value="${badge?.description ?? ""}" placeholder="Early Tester" /></label>
                <label
                    >Link<span class="hint">Optional. Opens when the badge is clicked.</span><input name="link" type="url" value="${badge?.link ?? ""}" placeholder="https://…"
                /></label>
                <div class="stack">
                    <h3>Icon</h3>
                    <label
                        >Upload an image<span class="hint">Square PNG, WebP or GIF. Shown at about 22px.</span
                        ><input name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                    /></label>
                    <span class="muted">or pick a preset</span>
                    <div class="preset-grid">
                        ${BADGE_PRESETS.map(
                          ([hash, name]) =>
                            html`<button type="button" class="preset ${hash === icon ? "active" : ""}" data-preset="${hash}" data-name="${name}" title="${name}">
                                    <img src="/badge-icons/${hash}.png" alt="${name}" />
                                </button>`,
                        )}
                    </div>
                </div>
                <div class="form-actions">
                    ${
                      badge
                        ? html`
                            <button class="btn danger" id="badge-delete" type="button" style="margin-right: auto">
                              Delete badge
                            </button>
                          `
                        : ""
                    }
                    <button class="btn primary" type="submit">${badge ? "Save badge" : "Create badge"}</button>
                </div>
            </form>
        `,
  );
  if (!body) return;
  const form = $("#badge-form", body);
  const preview = () => {
    const src = iconData ?? (icon ? `/badge-icons/${icon}.png` : null);
    mount(
      $("#badge-preview"),
      src
        ? html`<img class="badge-icon large" src="${src}" alt="" />`
        : html`
            <span class="muted">?</span>
          `,
    );
    $("#badge-preview-text").textContent = form.description.value || "Badge name";
    for (const b of $$("[data-preset]", form))
      b.classList.toggle("active", !iconData && b.dataset.preset === icon);
  };
  preview();

  form.description.addEventListener("input", preview);
  form.file.addEventListener("change", async () => {
    const file = form.file.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      form.file.value = "";
      return toast("Badge icons have to be under 2 MB.", "error");
    }
    iconData = await readAsDataUrl(file);
    preview();
  });
  for (const btn of $$("[data-preset]", form))
    btn.addEventListener("click", () => {
      icon = btn.dataset.preset;
      iconData = null;
      form.file.value = "";
      if (!form.description.value) form.description.value = btn.dataset.name;
      preview();
    });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!icon && !iconData) return toast("Pick a preset or upload an icon first.", "error");
    const payload = { description: form.description.value, link: form.link.value || null };
    if (iconData) payload.icon_data = iconData;
    else if (icon !== badge?.icon) payload.icon = icon;
    const done = await act(
      $("button[type=submit]", form),
      () =>
        badge
          ? api(`/admin/badges/${badge.id}`, { method: "PATCH", body: payload })
          : api("/admin/badges", { method: "POST", body: payload }),
      badge ? "Badge saved" : "Badge created",
    );
    if (done) {
      closeDrawer();
      refresh();
    }
  });

  $("#badge-delete", body)?.addEventListener("click", async (e) => {
    const who = badge.holders
      ? ` It's taken off the ${badge.holders} ${badge.holders === 1 ? "user" : "users"} who have it.`
      : "";
    if (!confirm(`Delete the "${badge.description}" badge?${who}`)) return;
    const done = await act(
      e.currentTarget,
      () => api(`/admin/badges/${badge.id}`, { method: "DELETE" }),
      "Badge deleted",
    );
    if (done !== undefined) {
      closeDrawer();
      refresh();
    }
  });
}

async function renderExperiments(view) {
  const [data, catalog] = await Promise.all([
    api("/admin/experiments"),
    api("/admin/experiments/catalog"),
  ]);
  const whoOf = async (kind, id) => {
    try {
      const r = await api(`/admin/${kind === "user" ? "users" : "guilds"}/${id}`);
      return kind === "user" ? userName(r.user ?? r) : r.name || id;
    } catch {
      return id;
    }
  };
  const rolloutRows = Object.entries(data.rollouts ?? {});
  const stat = (label, value) =>
    html`<div class="card stat"><div class="muted">${label}</div><div class="value">${value}</div></div>`;
  const rows = [
    ...Object.entries(data.global).map(([name, variant]) => ({
      kind: "global",
      id: "",
      name,
      variant,
    })),
    ...Object.entries(data.users).flatMap(([id, g]) =>
      Object.entries(g).map(([name, variant]) => ({ kind: "user", id, name, variant })),
    ),
    ...Object.entries(data.guilds).flatMap(([id, g]) =>
      Object.entries(g).map(([name, variant]) => ({ kind: "guild", id, name, variant })),
    ),
  ];
  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Experiments</h1>
                    <p class="muted">Turn Discord client features on for some of your users. People get changes after reloading the app.</p>
                </div>
                <div class="row" style="gap:8px">
                    <button class="btn" id="new-rollout" type="button">Roll out to a percentage</button>
                    <button class="btn primary" id="new-grant" type="button">Grant experiments</button>
                </div>
            </div>
            <div class="stats" style="margin-bottom:24px">
                ${stat("Active rollouts", fmtNumber(rolloutRows.length))} ${stat("Direct grants", fmtNumber(rows.length))} ${stat("Experiments in the client", fmtNumber(catalog.length))}
            </div>
            <div class="section-head">
                <h2>Gradual rollouts</h2>
                <p class="muted">A share of all users gets the experiment. Raising the share only adds people, nobody who already has it loses it.</p>
            </div>
            ${
              rolloutRows.length
                ? html`<div class="rollouts">
                      ${rolloutRows.map(([name, r]) => {
                        const reach = Math.round(((data.users_total ?? 0) * r.percent) / 100);
                        return html`<div class="card rollout">
                              <div class="rollout-name">${name}</div>
                              <div class="rollout-top">
                                  <div class="rollout-pct">${r.percent}%</div>
                                  <span class="badge info">Variant ${r.variant}</span>
                              </div>
                              <div class="rollout-bar"><span style="width:${r.percent}%"></span></div>
                              <div class="rollout-foot">
                                  <span class="muted">About ${fmtNumber(reach)} of ${fmtNumber(data.users_total ?? 0)} users</span>
                                  <span class="row rollout-actions">
                                      <button class="btn small" data-roll-users="${name}" type="button">Who got it</button>
                                      <button class="btn small" data-roll-edit="${name}" type="button">Change</button>
                                      <button class="btn small danger" data-roll-stop="${name}" type="button">Stop</button>
                                  </span>
                              </div>
                          </div>`;
                      })}
                  </div>`
                : html`
                    <div class="card empty">
                      <p>No rollouts yet.</p>
                      <button class="btn primary" data-roll-new type="button">Roll out an experiment</button>
                    </div>
                  `
            }
            <div class="section-head" style="margin-top:32px">
                <h2>Direct grants</h2>
                <p class="muted">Experiments turned on for everyone, for one person, or for one server.</p>
            </div>
            ${
              rows.length
                ? html`<div class="table-wrap">
                      <table>
                          <thead>
                              <tr>
                                  <th>Experiment</th>
                                  <th>Given to</th>
                                  <th>Variant</th>
                                  <th></th>
                              </tr>
                          </thead>
                          <tbody>
                              ${rows.map(
                                (r, i) =>
                                  html`<tr data-i="${i}">
                                          <td><strong>${r.name}</strong></td>
                                          <td>
                                              ${
                                                r.kind === "global"
                                                  ? html`
                                                      <span class="badge accent">Everyone</span>
                                                    `
                                                  : html`<span class="badge info">${r.kind === "user" ? "User" : "Server"}</span> <span class="who muted" data-kind="${r.kind}" data-id="${r.id}">${r.id}</span>`
                                              }
                                          </td>
                                          <td>${r.variant}</td>
                                          <td><button class="btn small danger" data-revoke="${i}" type="button">Revoke</button></td>
                                      </tr>`,
                              )}
                          </tbody>
                      </table>
                  </div>`
                : html`
                    <div class="card empty">Nothing granted yet. Experiments in the built-in defaults still apply.</div>
                  `
            }
        `,
  );
  const refresh = () => renderExperiments(view);
  for (const el of $$(".who", view))
    whoOf(el.dataset.kind, el.dataset.id).then((n) => (el.textContent = `${n} (${el.dataset.id})`));
  for (const btn of $$("[data-revoke]", view))
    btn.addEventListener("click", async () => {
      const r = rows[btn.dataset.revoke];
      const done = await act(
        btn,
        () =>
          api("/admin/experiments", {
            method: "PUT",
            body: { target: r.kind, id: r.id || undefined, name: r.name, variant: 0 },
          }),
        "Revoked",
      );
      if (done) refresh();
    });
  $("#new-grant").addEventListener("click", () => openGrant(catalog, refresh));
  $("#new-rollout").addEventListener("click", () =>
    openRollout(catalog, refresh, undefined, undefined, data.users_total),
  );
  $("[data-roll-new]", view)?.addEventListener("click", () =>
    openRollout(catalog, refresh, undefined, undefined, data.users_total),
  );
  for (const btn of $$("[data-roll-users]", view))
    btn.addEventListener("click", () => openRolloutUsers(btn.dataset.rollUsers));
  for (const btn of $$("[data-roll-edit]", view))
    btn.addEventListener("click", () =>
      openRollout(
        catalog,
        refresh,
        btn.dataset.rollEdit,
        data.rollouts[btn.dataset.rollEdit],
        data.users_total,
      ),
    );
  for (const btn of $$("[data-roll-stop]", view))
    btn.addEventListener("click", async () => {
      const done = await act(
        btn,
        () =>
          api("/admin/experiments/rollout", {
            method: "PUT",
            body: { name: btn.dataset.rollStop, percent: 0 },
          }),
        "Rollout stopped",
      );
      if (done) refresh();
    });
}

function openRollout(catalog, refresh, presetName, preset, usersTotal = 0) {
  let name = presetName ?? "";
  const body = openDrawer(
    presetName ? "Change rollout" : "Roll out to a percentage",
    html`
            <form id="rollout-form" class="stack">
                ${
                  presetName
                    ? html`<div class="card"><div class="muted">Experiment</div><div class="mono" style="margin-top:4px">${presetName}</div></div>`
                    : html`
                        <div class="stack" style="gap: 8px">
                          <label
                            >Experiment<input name="search" autocomplete="off" placeholder="Search, or type a full name"
                          /></label>
                          <div class="picker" id="rollout-picker"></div>
                        </div>
                      `
                }
                <div class="stack" style="gap:8px">
                    <label>Share of users</label>
                    <div class="pct-row">
                        <input name="slider" type="range" min="0" max="100" step="0.1" aria-label="Share of users" />
                        <input name="percent" type="number" min="0" max="100" step="0.01" aria-label="Percent" />
                        <span>%</span>
                    </div>
                    <div class="pct-presets">${[0.1, 1, 5, 10, 25, 50, 100].map((v) => html`<button type="button" class="btn small" data-pct="${v}">${v}%</button>`)}</div>
                    <p class="hint" id="rollout-estimate"></p>
                </div>
                <label>Variant<span class="hint">1 is on for most. Some experiments have more.</span><input name="variant" type="number" min="1" max="1000" value="${preset?.variant ?? 1}" /></label>
                <div class="form-actions"><button class="btn primary" type="submit">${presetName ? "Save" : "Start rollout"}</button></div>
            </form>
        `,
  );
  if (!body) return;
  const form = $("#rollout-form", body);

  const setPercent = (value, from) => {
    const pct = Math.min(100, Math.max(0, Math.round(Number(value) * 100) / 100 || 0));
    if (from !== "number") form.percent.value = pct;
    if (from !== "slider") form.slider.value = Math.sqrt(pct * 100);
    const reach = Math.round((usersTotal * pct) / 100);
    $("#rollout-estimate").textContent = usersTotal
      ? `About ${fmtNumber(reach)} of ${fmtNumber(usersTotal)} users.`
      : "";
  };
  form.slider.addEventListener("input", () => {
    form.percent.value = Math.round((Number(form.slider.value) ** 2 / 100) * 100) / 100;
    setPercent(form.percent.value, "slider");
  });
  form.percent.addEventListener("input", () => setPercent(form.percent.value, "number"));
  for (const b of $$("[data-pct]", body))
    b.addEventListener("click", () => setPercent(b.dataset.pct));
  setPercent(preset?.percent ?? 1);

  if (!presetName) {
    const picker = $("#rollout-picker", body);
    const list = () => {
      const q = form.search.value.trim().toLowerCase();
      const shown = catalog.filter((n) => n.includes(q)).slice(0, 80);
      if (q && /^[\w.-]{3,128}$/.test(q) && !catalog.includes(q)) shown.unshift(q);
      mount(
        picker,
        shown.length
          ? html`${shown.map((n) => html`<button type="button"  data-name="${n}" aria-pressed="${n === name}">${n}</button>`)}`
          : html`
              <p class="muted" style="padding: 12px">No match.</p>
            `,
      );
      for (const b of $$("[data-name]", picker))
        b.addEventListener("click", () => {
          name = b.dataset.name;
          list();
        });
    };
    form.search.addEventListener("input", list);
    list();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!name) return toast("Pick an experiment.", "error");
    const done = await act(
      $("button[type=submit]", form),
      () =>
        api("/admin/experiments/rollout", {
          method: "PUT",
          body: {
            name,
            percent: Number(form.percent.value),
            variant: Number(form.variant.value) || 1,
          },
        }),
      "Rollout saved",
    );
    if (done) {
      closeDrawer();
      refresh();
    }
  });
}

async function openRolloutUsers(name) {
  const body = openDrawer(
    `Who got it`,
    html`
      <p class="muted">Loading…</p>
    `,
  );
  if (!body) return;
  const shown = [];
  let filter = "";
  let nextCursor = "";
  let loading = false;
  const draw = (r) => {
    const q = filter.toLowerCase();
    const rows = shown.filter(
      (u) => !q || `${userName(u)} ${u.username} ${u.id}`.toLowerCase().includes(q),
    );
    mount(
      body,
      html`
                <div class="card">
                    <div class="mono" style="word-break:break-all">${name}</div>
                    <div class="muted" style="margin-top:4px">${fmtNumber(shown.length)} users loaded at ${r.percent}%, variant ${r.variant}</div>
                </div>
                ${shown.length > 8 ? html`<label>Filter users<input id="who-filter" placeholder="Name or ID" value="${filter}" autocomplete="off" /></label>` : ""}
                ${
                  rows.length
                    ? html`<div>
                          ${rows.map(
                            (u) => html`<div class="list-item">
                                  ${avatar(u)}
                                  <div class="grow"><strong>${userName(u)}</strong><div class="muted">${userTag(u)}</div></div>
                                  <span class="mono muted">${u.id}</span>
                              </div>`,
                          )}
                      </div>`
                    : html`<div class="card empty">${shown.length ? "No match." : "Nobody has it yet."}</div>`
                }
                ${
                  nextCursor
                    ? html`
                        <button class="btn" id="more-users" type="button">Show more</button>
                      `
                    : ""
                }
            `,
    );
    const input = $("#who-filter", body);
    input?.addEventListener("input", () => {
      filter = input.value;
      draw(r);
      const again = $("#who-filter", body);
      again.focus();
      again.setSelectionRange(filter.length, filter.length);
    });
    $("#more-users", body)?.addEventListener("click", load);
  };
  const load = async () => {
    if (loading) return;
    loading = true;
    const button = $("#more-users", body);
    if (button) button.disabled = true;
    try {
      const r = await api(
        `/admin/experiments/rollout/${encodeURIComponent(name)}/users?${new URLSearchParams(nextCursor ? { after: nextCursor } : {})}`,
      ).catch((e) => ({ error: e }));
      if (r.error)
        return mount(
          body,
          html`
            <p class="err">Couldn't load the list.</p>
          `,
        );
      shown.push(...r.users);
      nextCursor = r.next_cursor;
      draw(r);
    } finally {
      loading = false;
    }
  };
  load();
}

function openGrant(catalog, refresh) {
  const picked = new Set();
  let target = { kind: "user", id: "@me", label: "Me" };
  const body = openDrawer(
    "Grant experiments",
    html`
      <form id="grant-form" class="stack">
        <label
          >Give to
          <select name="kind">
            <option value="user">A user</option>
            <option value="guild">A server</option>
            <option value="global">Everyone</option>
          </select></label
        >
        <div id="target-box" class="stack">
          <label
            >Find <span id="target-noun">user</span
            ><span class="hint">Search by name, or leave it on yourself.</span
            ><input name="search" autocomplete="off" placeholder="Search…"
          /></label>
          <div id="target-results" class="stack"></div>
          <div class="card row" style="gap: 12px">
            <strong>Selected:</strong> <span id="target-label"></span>
            <button class="btn small ghost" id="target-me" type="button">Me</button>
          </div>
          <label class="row" style="gap: 8px" id="owned-row"
            ><input name="owned" type="checkbox" checked /> Also give it to every server they own</label
          >
        </div>
        <label
          >Variant<span class="hint">1 is on for most. Some experiments have more.</span
          ><input name="variant" type="number" min="1" max="1000" value="1"
        /></label>
        <label
          >Experiments<input name="filter" autocomplete="off" placeholder="Filter, for example profile"
        /></label>
        <div class="row" style="gap: 8px">
          <span id="picked-count" class="muted"></span
          ><button class="btn small ghost" id="picked-clear" type="button" style="margin-left: auto">
            Clear
          </button>
        </div>
        <div id="exp-list" style="max-height: 320px; overflow: auto" class="stack"></div>
        <div class="form-actions"><button class="btn primary" type="submit">Grant</button></div>
      </form>
    `,
  );
  if (!body) return;
  const form = $("#grant-form", body);
  const label = () => {
    $("#target-label").textContent = target.label;
    $("#picked-count").textContent = `${picked.size} selected`;
    $("#target-box").hidden = form.kind.value === "global";
    $("#target-noun").textContent = form.kind.value === "user" ? "user" : "server";
    $("#owned-row").hidden = form.kind.value !== "user";
  };
  const list = () => {
    const q = form.filter.value.toLowerCase();
    const shown = catalog.filter((n) => n.includes(q) || picked.has(n)).slice(0, 200);
    mount(
      $("#exp-list"),
      shown.length
        ? html`${shown.map((n) => html`<label class="row" style="gap:8px"><input type="checkbox" data-name="${n}" ${picked.has(n) ? "checked" : ""} /> ${n}</label>`)}`
        : html`
            <p class="muted">No match. You can type a name exactly and press Enter.</p>
          `,
    );
    for (const c of $$("[data-name]", body))
      c.addEventListener("change", () => {
        if (c.checked) picked.add(c.dataset.name);
        else picked.delete(c.dataset.name);
        label();
      });
  };
  form.filter.addEventListener("input", list);
  form.filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && /^[\w.-]{3,128}$/.test(form.filter.value)) {
      e.preventDefault();
      picked.add(form.filter.value);
      label();
      list();
    }
  });
  $("#picked-clear").addEventListener("click", () => {
    picked.clear();
    label();
    list();
  });
  const search = debounce(async () => {
    const q = form.search.value.trim();
    const kind = form.kind.value;
    if (!q)
      return mount(
        $("#target-results"),
        html`
          
        `,
      );
    const res = await api(
      `/admin/${kind === "user" ? "users" : "guilds"}?${new URLSearchParams({ q, limit: 6 })}`,
    ).catch(() => ({}));
    const found = kind === "user" ? (res.users ?? []) : (res.guilds ?? []);
    const nameOf = (f) => (kind === "user" ? userName(f) : f.name);
    mount(
      $("#target-results"),
      html`${found.map((f) => html`<button type="button" class="btn ghost" data-pick="${f.id}" data-label="${nameOf(f)}">${nameOf(f)} <span class="muted">${f.id}</span></button>`)}`,
    );
    for (const b of $$("[data-pick]", body))
      b.addEventListener("click", () => {
        target = { kind, id: b.dataset.pick, label: `${b.dataset.label} (${b.dataset.pick})` };
        label();
      });
  });
  form.search.addEventListener("input", search);
  form.kind.addEventListener("change", () => {
    target =
      form.kind.value === "user"
        ? { kind: "user", id: "@me", label: "Me" }
        : { kind: form.kind.value, id: "", label: "Search for a server" };
    form.search.value = "";
    mount(
      $("#target-results"),
      html`
        
      `,
    );
    label();
  });
  $("#target-me").addEventListener("click", () => {
    form.kind.value = "user";
    target = { kind: "user", id: "@me", label: "Me" };
    label();
  });
  label();
  list();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const kind = form.kind.value;
    if (!picked.size) return toast("Pick at least one experiment.", "error");
    if (kind !== "global" && !target.id) return toast("Choose who to give it to.", "error");
    const done = await act(
      $("button[type=submit]", form),
      async () => {
        for (const name of picked)
          await api("/admin/experiments", {
            method: "PUT",
            body: {
              target: kind,
              id: kind === "global" ? undefined : target.id,
              name,
              variant: Number(form.variant.value) || 1,
              include_owned_guilds: kind === "user" && form.owned.checked,
            },
          });
        return true;
      },
      `Granted ${picked.size} ${picked.size === 1 ? "experiment" : "experiments"}`,
    );
    if (done) {
      closeDrawer();
      refresh();
    }
  });
}

/* ---------- games ---------- */

// art lives where the client looks for game art: app-icons/<game id>/<hash>
const gameArt = (g, hash, cls = "") =>
  hash
    ? html`<img class="avatar square ${cls}" src="/app-icons/${g.id}/${hash}.png?size=128" alt="" loading="lazy" />`
    : html`<span class="avatar square ${cls}">${initials(g.name)}</span>`;

async function renderGames(view) {
  const games = await api("/admin/games");
  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Games</h1>
                    <p class="muted">
                        Games you add here show up next to the built-in game list wherever people pick games, such as the games on their profile or their server's profile. Open
                        clients see new games in search right away; their full game list refreshes within a few hours.
                    </p>
                </div>
                <button class="btn primary" id="new-game" type="button">Add game</button>
            </div>
            ${
              games.length
                ? html`<div class="table-wrap">
                          <table>
                              <thead>
                                  <tr>
                                      <th>Game</th>
                                      <th class="hide-sm">Also found by</th>
                                      <th class="hide-sm">Added</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${games.map(
                                    (g) =>
                                      html`<tr data-id="${g.id}">
                                              <td>
                                                  <div class="ident">${gameArt(g, g.icon_hash)}<strong>${g.name}</strong></div>
                                              </td>
                                              <td class="hide-sm">
                                                  ${
                                                    g.aliases.length
                                                      ? html`<span class="muted">${g.aliases.join(", ")}</span>`
                                                      : html`
                                                          <span class="muted">—</span>
                                                        `
                                                  }
                                              </td>
                                              <td class="hide-sm"><span class="muted">${fmtDate(g.created_at)}</span></td>
                                          </tr>`,
                                  )}
                              </tbody>
                          </table>
                      </div>`
                : html`
                    <div class="card empty">
                      No custom games yet. Add one so people can put it on their profile or server.
                    </div>
                  `
            }
        `,
  );
  const refresh = () => renderGames(view);
  $("#new-game").addEventListener("click", () => openGame(null, refresh));
  for (const row of $$("tbody tr", view))
    row.addEventListener("click", () =>
      openGame(
        games.find((g) => g.id === row.dataset.id),
        refresh,
      ),
    );
}

function openGame(game, refresh) {
  // undefined keeps the saved art, null removes it, a data: URI replaces it
  const art = { icon: undefined, cover: undefined };
  const body = openDrawer(
    game ? "Edit game" : "Add game",
    html`
            <form id="game-form" class="stack">
                <div class="card row" style="gap:12px">
                    <span id="game-preview"></span>
                    <div class="grow">
                        <strong id="game-preview-name">${game?.name ?? "Game name"}</strong>
                        <div class="muted">How it looks in game pickers and on profiles.</div>
                    </div>
                </div>
                <label>Name<input name="name" required maxlength="100" value="${game?.name ?? ""}" placeholder="My Game" /></label>
                <label
                    >Also found by<span class="hint">Optional. Other names people might search for, separated by commas.</span
                    ><input name="aliases" value="${(game?.aliases ?? []).join(", ")}" placeholder="MG, My Game Remastered"
                /></label>
                <div class="form-grid">
                    <div class="stack">
                        <label
                            >Icon<span class="hint">Square image, at least 256×256.</span
                            ><input name="icon" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                        /></label>
                        ${
                          game?.icon_hash
                            ? html`
                                <button class="btn small" type="button" data-remove="icon">Remove icon</button>
                              `
                            : ""
                        }
                    </div>
                    <div class="stack">
                        <label
                            >Cover art<span class="hint">Optional. A tall box-art style image, like 600×800.</span
                            ><input name="cover" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                        /></label>
                        ${
                          game?.cover_image_hash
                            ? html`
                                <button class="btn small" type="button" data-remove="cover">Remove cover art</button>
                              `
                            : ""
                        }
                    </div>
                </div>
                <div class="form-actions">
                    ${
                      game
                        ? html`
                            <button class="btn danger" id="game-delete" type="button" style="margin-right: auto">
                              Delete game
                            </button>
                          `
                        : ""
                    }
                    <button class="btn primary" type="submit">${game ? "Save game" : "Add game"}</button>
                </div>
            </form>
        `,
  );
  if (!body) return;
  const form = $("#game-form", body);
  const preview = () => {
    const icon =
      art.icon === undefined
        ? game?.icon_hash
          ? `/app-icons/${game.id}/${game.icon_hash}.png?size=128`
          : null
        : art.icon;
    const name = form.name.value || "Game name";
    mount(
      $("#game-preview"),
      icon
        ? html`<img class="avatar square large" src="${icon}" alt="" />`
        : html`<span class="avatar square large">${initials(name)}</span>`,
    );
    $("#game-preview-name").textContent = name;
  };
  preview();
  form.name.addEventListener("input", preview);

  for (const key of ["icon", "cover"]) {
    form[key].addEventListener("change", async () => {
      const file = form[key].files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        form[key].value = "";
        return toast("Game art has to be under 8 MB.", "error");
      }
      art[key] = await readAsDataUrl(file);
      preview();
    });
  }
  for (const btn of $$("[data-remove]", form))
    btn.addEventListener("click", () => {
      art[btn.dataset.remove] = null;
      form[btn.dataset.remove].value = "";
      btn.remove();
      preview();
    });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: form.name.value,
      aliases: form.aliases.value
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
    };
    if (art.icon !== undefined && (game || art.icon)) payload.icon_data = art.icon;
    if (art.cover !== undefined && (game || art.cover)) payload.cover_data = art.cover;
    const done = await act(
      $("button[type=submit]", form),
      () =>
        game
          ? api(`/admin/games/${game.id}`, { method: "PATCH", body: payload })
          : api("/admin/games", { method: "POST", body: payload }),
      game ? "Game saved" : "Game added",
    );
    if (done) {
      closeDrawer();
      refresh();
    }
  });

  $("#game-delete", body)?.addEventListener("click", async (e) => {
    if (!confirm(`Delete "${game.name}"? Profiles and servers that list it stop showing it.`))
      return;
    const done = await act(
      e.currentTarget,
      () => api(`/admin/games/${game.id}`, { method: "DELETE" }),
      "Game deleted",
    );
    if (done !== undefined) {
      closeDrawer();
      refresh();
    }
  });
}

/* ---------- store ---------- */

const STORE_TYPES = [
  [0, "Avatar decoration", "Drawn around the avatar."],
  [2, "Nameplate", "Shown behind the name in member lists and DMs."],
  [1, "Profile effect", "Plays over the profile card."],
  [3, "Profile frame", "Wraps the profile card."],
];
const storeTypeName = (type) => STORE_TYPES.find(([t]) => t === type)?.[1] ?? "Item";
const IMAGE_TYPES = "image/png,image/apng,image/gif,image/webp,image/jpeg,image/avif";
// art goes up as JSON, and the API takes bodies up to 10 MB
const MAX_ART_BYTES = 7 * 1024 * 1024;

const storeState = { data: null };

async function renderStore(view) {
  const data = (storeState.data = await api("/admin/store"));
  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Store</h1>
                    <p class="muted">
                        Packs of avatar decorations, nameplates, profile effects and profile frames people can pick up for free in the shop. Your packs come first, then the ones
                        mirrored from Discord. Edit pack details and artwork, or hide packs from the shop. Your edits affect this instance’s shop.
                    </p>
                </div>
                <button class="btn primary" id="new-pack" type="button">Add pack</button>
            </div>
            <div class="stack">
                <h2>Your packs</h2>
                ${
                  data.packs.length
                    ? html`<div class="table-wrap">
                              <table>
                                  <thead>
                                      <tr>
                                          <th>Pack</th>
                                          <th class="hide-sm">Items</th>
                                      </tr>
                                  </thead>
                                  <tbody>
                                      ${data.packs.map(
                                        (p) =>
                                          html`<tr data-pack="${p.id}">
                                                  <td>
                                                      <div class="ident">
                                                          ${
                                                            p.logo || p.banner
                                                              ? html`<img class="avatar square" src="${p.logo || p.banner}" alt="" loading="lazy" style="object-fit:cover" />`
                                                              : html`<span class="avatar square">${initials(p.name)}</span>`
                                                          }
                                                          <div>
                                                              <button class="btn small" type="button" aria-label="Edit ${p.name}">${p.name}</button
                                                              ><span class="muted">${p.summary || "No summary"}</span>
                                                          </div>
                                                      </div>
                                                  </td>
                                                  <td class="hide-sm">
                                                      <span class="badges"
                                                          >${STORE_TYPES.map(([type, name]) => {
                                                            const count = p.items.filter(
                                                              (i) => i.type === type,
                                                            ).length;
                                                            return count
                                                              ? html`<span class="badge">${count} ${name.toLowerCase()}${count === 1 ? "" : "s"}</span>`
                                                              : "";
                                                          })}${
                                                            p.items.length
                                                              ? ""
                                                              : html`
                                                                  <span class="muted">Empty</span>
                                                                `
                                                          }</span
                                                      >
                                                  </td>
                                              </tr>`,
                                      )}
                                  </tbody>
                              </table>
                          </div>`
                    : html`
                        <div class="card empty">
                          No packs yet. Add one, then fill it with decorations, nameplates, effects and frames.
                        </div>
                      `
                }
                <h2>Packs from Discord</h2>
                <p class="muted" style="margin:0">Turn a pack off to take it out of the shop. People who already have its items keep them.</p>
                <div class="card stack" style="gap:0;padding:0">
                    ${data.builtin.map(
                      (b) =>
                        html`<div class="list-item" style="padding:10px 16px">
                                <label class="toggle grow"
                                    ><input type="checkbox" data-builtin="${b.sku_id}" ${b.hidden ? "" : raw("checked")} /><span
                                        ><strong>${b.name}</strong
                                        ><span class="hint">${b.items} ${b.items === 1 ? "item" : "items"}${b.customized ? " · Customized" : ""}</span></span
                                    ></label
                                >
                                <button class="btn small" type="button" data-edit-builtin="${b.sku_id}" aria-label="Edit ${b.name}">Edit pack</button>
                            </div>`,
                    )}
                </div>
            </div>
        `,
  );
  const refresh = () => renderStore(view);
  $("#new-pack").addEventListener("click", () => openPack(null, refresh));
  for (const row of $$("tr[data-pack]", view))
    row.addEventListener("click", () => openPack(row.dataset.pack, refresh));
  for (const button of $$("[data-edit-builtin]", view))
    button.addEventListener("click", () => openBuiltinPack(button.dataset.editBuiltin, refresh));
  for (const box of $$("[data-builtin]", view))
    box.addEventListener("change", async () => {
      const done = await act(
        null,
        () =>
          api(`/admin/store/builtin/${box.dataset.builtin}`, {
            method: "PATCH",
            body: { hidden: !box.checked },
          }),
        box.checked ? "Back in the shop" : "Taken out of the shop",
      );
      if (!done) box.checked = !box.checked;
    });
}

// reads a picked file as a data: URI, refusing ones too big to send
async function pickArt(input) {
  const file = input.files[0];
  if (!file) return undefined;
  if (file.size > MAX_ART_BYTES) {
    input.value = "";
    toast("Files have to be under 7 MB.", "error");
    return undefined;
  }
  return readAsDataUrl(file);
}

function artField(name, label, hint, current, { accept = IMAGE_TYPES, removable = true } = {}) {
  const isVideo = current && /\/video\?/.test(current);
  return html`<div class="stack" style="gap:6px">
        <label>${label}${hint ? html`<span class="hint">${hint}</span>` : ""}<input type="file" data-art="${name}" accept="${accept}" /></label>
        <div class="row" style="gap:8px" data-art-preview="${name}">
            ${
              current
                ? html`${
                    isVideo
                      ? html`<video src="${current}" autoplay loop muted playsinline style="max-height:64px;max-width:220px;border-radius:6px"></video>`
                      : html`<img src="${current}" alt="" style="max-height:64px;max-width:220px;border-radius:6px" />`
                  }
                      ${removable ? html`<button class="btn small" type="button" data-art-remove="${name}">Remove</button>` : ""}`
                : html`
                    <span class="muted">Nothing uploaded</span>
                  `
            }
        </div>
    </div>`;
}

function openBuiltinPack(skuId, refresh) {
  const pack = storeState.data.builtin.find((item) => item.sku_id === skuId);
  if (!pack) return;
  const art = {};
  const body = openDrawer(
    `Edit ${pack.name}`,
    html`<form class="stack" id="builtin-pack-form">
            <p class="muted">
                Customize this pack for your instance. Restore defaults to use its original details and artwork again. Existing owners keep their items when you hide the pack.
            </p>
            <label>Name<input name="name" value="${pack.name}" required maxlength="100" /></label>
            <label>Summary<textarea name="summary" maxlength="500" rows="2">${pack.summary ?? ""}</textarea></label>
            <label
                >Order<input name="position" type="number" step="1" min="-2147483648" max="2147483647" value="${pack.position ?? 0}" /><span class="hint"
                    >Lower numbers appear first among packs from Discord.</span
                ></label
            >
            <label class="toggle"><input name="visible" type="checkbox" ${pack.hidden ? "" : raw("checked")} /><span>Show in the shop</span></label>
            ${artField("banner", "Banner", "Upload artwork to replace the original banner on this instance.", pack.banner)}
            ${artField("logo", "Logo", "Upload artwork to replace the original logo on this instance.", pack.logo)}
            <div class="form-actions">
                <button class="btn" data-reset-builtin type="button">Restore defaults</button><button class="btn primary" type="submit">Save pack</button>
            </div>
        </form>`,
  );
  if (!body) return;
  const form = $("form", body);
  for (const input of $$("[data-art]", form))
    input.addEventListener("change", async () => (art[input.dataset.art] = await pickArt(input)));
  for (const button of $$("[data-art-remove]", form)) {
    button.textContent = "Restore original";
    button.addEventListener("click", () => {
      art[button.dataset.artRemove] = null;
      form.dataset.dirty = "true";
      mount(
        button.parentElement,
        html`
          <span class="muted">Original artwork restored when you save</span>
        `,
      );
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = form.elements;
    const payload = {
      name: fields.namedItem("name").value,
      summary: fields.namedItem("summary").value,
      position: Number(fields.namedItem("position").value),
      hidden: !fields.namedItem("visible").checked,
    };
    for (const slot of ["banner", "logo"])
      if (art[slot] !== undefined) payload[`${slot}_data`] = art[slot];
    const saved = await act(
      $("button[type=submit]", form),
      () => api(`/admin/store/builtin/${skuId}`, { method: "PATCH", body: payload }),
      "Pack saved",
    );
    if (saved) {
      await refresh();
      if (!body.isConnected || $("#drawer").hidden) return;
      openBuiltinPack(skuId, refresh);
    }
  });
  $("[data-reset-builtin]", form).addEventListener("click", async (event) => {
    if (!confirm(`Restore the original details and artwork for "${pack.name}"?`)) return;
    const saved = await act(
      event.currentTarget,
      () => api(`/admin/store/builtin/${skuId}`, { method: "PATCH", body: { reset: true } }),
      "Pack defaults restored",
    );
    if (saved) {
      await refresh();
      if (!body.isConnected || $("#drawer").hidden) return;
      openBuiltinPack(skuId, refresh);
    }
  });
}

async function openPack(packId, refresh) {
  const pack = packId ? storeState.data.packs.find((p) => p.id === packId) : null;
  const art = {};
  const body = openDrawer(
    pack ? pack.name : "Add pack",
    html`
            <form id="pack-form" class="stack">
                <label>Name<input name="name" required maxlength="100" value="${pack?.name ?? ""}" placeholder="Spooky Season" /></label>
                <label
                    >Summary<span class="hint">Optional. Shown under the name in the shop.</span><textarea name="summary" maxlength="500" rows="2">${pack?.summary ?? ""}</textarea>
                </label>
                <label
                    >Order<span class="hint">Lower numbers come first in the shop. The first pack is the big one at the top.</span
                    ><input name="position" type="number" step="1" value="${pack?.position ?? 0}"
                /></label>
                ${artField("banner", "Banner", "A wide image across the top of the pack, around 1280×300.", pack?.banner)}
                ${artField("logo", "Logo", "Optional. Shown on the banner.", pack?.logo)}
                <div class="form-actions">
                    ${
                      pack
                        ? html`
                            <button class="btn danger" id="pack-delete" type="button" style="margin-right: auto">
                              Delete pack
                            </button>
                          `
                        : ""
                    }
                    <button class="btn primary" type="submit">${pack ? "Save pack" : "Add pack"}</button>
                </div>
            </form>
            ${
              pack
                ? html`<div class="stack" style="margin-top:20px">
                          <div class="row" style="justify-content:space-between">
                              <h3 style="margin:0">Items</h3>
                              <button class="btn small primary" id="item-new" type="button">Add item</button>
                          </div>
                          ${
                            pack.items.length
                              ? html`<div class="card stack" style="gap:0;padding:0">
                                        ${pack.items.map(
                                          (item) =>
                                            html`<div class="list-item" style="padding:10px 16px;cursor:pointer" data-item="${item.id}">
                                                    <div class="ident grow">
                                                        ${itemThumb(item)}
                                                        <div><strong>${item.name}</strong><span class="muted">${storeTypeName(item.type)}</span></div>
                                                    </div>
                                                </div>`,
                                        )}
                                    </div>`
                              : html`
                                  <p class="muted" style="margin: 0">No items yet.</p>
                                `
                          }
                      </div>`
                : ""
            }
        `,
  );
  if (!body) return;
  const form = $("#pack-form", body);
  for (const input of $$("[data-art]", form))
    input.addEventListener("change", async () => (art[input.dataset.art] = await pickArt(input)));
  for (const btn of $$("[data-art-remove]", form))
    btn.addEventListener("click", () => {
      art[btn.dataset.artRemove] = null;
      form.dataset.dirty = "true";
      mount(
        btn.parentElement,
        html`
          <span class="muted">Removed when you save</span>
        `,
      );
    });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: form.name.value,
      summary: form.summary.value,
      position: Number(form.position.value) || 0,
    };
    for (const slot of ["banner", "logo"])
      if (art[slot] !== undefined && (pack || art[slot])) payload[`${slot}_data`] = art[slot];
    const saved = await act(
      $("button[type=submit]", form),
      () =>
        pack
          ? api(`/admin/store/packs/${pack.id}`, { method: "PATCH", body: payload })
          : api("/admin/store/packs", { method: "POST", body: payload }),
      pack ? "Pack saved" : "Pack added",
    );
    if (saved) {
      await refresh();
      if (!body.isConnected || $("#drawer").hidden) return;
      openPack(saved.id, refresh);
    }
  });
  $("#pack-delete", body)?.addEventListener("click", async (e) => {
    if (
      !confirm(
        `Delete "${pack.name}" and its ${pack.items.length} ${pack.items.length === 1 ? "item" : "items"}? People who have them stop seeing them.`,
      )
    )
      return;
    const done = await act(
      e.currentTarget,
      () => api(`/admin/store/packs/${pack.id}`, { method: "DELETE" }),
      "Pack deleted",
    );
    if (done !== undefined) {
      closeDrawer();
      refresh();
    }
  });
  $("#item-new", body)?.addEventListener("click", () => openStoreItem(pack, null, refresh));
  for (const row of $$("[data-item]", body))
    row.addEventListener("click", () =>
      openStoreItem(
        pack,
        pack.items.find((i) => i.id === row.dataset.item),
        refresh,
      ),
    );
}

const itemThumb = (item) => {
  const src =
    item.art.image ??
    item.art.static ??
    item.art.thumbnail ??
    item.art.effect ??
    item.art.front_top ??
    item.art.front_bottom ??
    item.art.back_top;
  return src
    ? html`<img class="avatar square" src="${src}" alt="" loading="lazy" style="object-fit:contain;background:var(--bg-2, #111)" />`
    : html`
        <span class="avatar square">?</span>
      `;
};

function storeItemFields(type, item) {
  const { palettes, sizes } = storeState.data;
  const a = item?.art ?? {};
  switch (type) {
    case 0:
      return artField(
        "image",
        "Decoration",
        "A square PNG, APNG, GIF or WebP, 288×288. It's drawn over the avatar, so leave the middle transparent.",
        a.image,
        {
          removable: false,
        },
      );
    case 2:
      return html`<label
                    >Color<span class="hint">The background behind the name.</span
                    ><select name="palette">
                        ${options(
                          palettes.map((p) => [p, p.replace("_", " ")]),
                          item?.palette ?? "violet",
                        )}
                    </select></label
                >
                ${artField("static", "Still image", "A wide PNG, 448×84. Shown when it isn't animating.", a.static, { accept: "image/png,image/webp,image/jpeg,image/avif", removable: false })}
                ${artField("motion", "Animation", "Optional. A WebM video, or an animated PNG or GIF, the same size.", a.motion, { accept: `video/webm,video/mp4,${IMAGE_TYPES}` })}`;
    case 1:
      return html`${artField("effect", "Effect", `An animated PNG, GIF or WebP, ${sizes.effect.width}×${sizes.effect.height}, drawn over the whole profile card.`, a.effect, { removable: false })}
                ${artField("thumbnail", "Thumbnail", "Optional. The preview in the shop and the effect picker. The effect itself is used otherwise.", a.thumbnail)}
                ${artField("reduced", "Reduced motion", "Optional. A still image shown to people who turned animations off.", a.reduced)}
                <div class="form-grid">
                    <label
                        >Length<span class="hint">One play of the animation, in milliseconds.</span
                        ><input name="duration" type="number" min="100" max="60000" step="1" value="${item?.duration ?? 3000}"
                    /></label>
                    <label class="toggle"><input type="checkbox" name="loop" ${item?.loop === false ? "" : raw("checked")} /><span>Play on repeat</span></label>
                </div>`;
    case 3:
      return html`<p class="muted" style="margin:0">
                    Layers are ${sizes.frame.width}px wide: the ${sizes.frame.inner_width}px profile card plus the art past its sides. Top layers sit at the top of the card and
                    bottom layers at the bottom; front layers go over the card and back layers behind it. At least one layer is needed.
                </p>
                <div class="form-grid">
                    <label
                        >Reaches above the card<span class="hint">How many pixels of the top layers stick out above the card.</span
                        ><input name="overflow_top" type="number" min="0" max="2000" step="1" value="${item?.overflow_top ?? 280}"
                    /></label>
                    <label
                        >Reaches below the card<span class="hint">How many pixels of the bottom layers stick out below it.</span
                        ><input name="overflow_bottom" type="number" min="0" max="2000" step="1" value="${item?.overflow_bottom ?? 190}"
                    /></label>
                </div>
                ${artField("front_top", "Front, top", "", a.front_top)} ${artField("front_bottom", "Front, bottom", "", a.front_bottom)}
                ${artField("back_top", "Back, top", "", a.back_top)} ${artField("back_bottom", "Back, bottom", "", a.back_bottom)}`;
    default:
      return "";
  }
}

function openStoreItem(pack, item, refresh) {
  let type = item?.type ?? 0;
  const art = {};
  const body = openDrawer(
    item ? `Edit ${storeTypeName(item.type).toLowerCase()}` : `Add to ${pack.name}`,
    html`
            <form id="store-item-form" class="stack">
                ${
                  item
                    ? html`<label
                              >Pack<select name="pack_id">
                                  ${options(
                                    storeState.data.packs.map((entry) => [entry.id, entry.name]),
                                    item.pack_id,
                                  )}</select
                              ><span class="hint">Moving keeps the item and its artwork.</span></label
                          >`
                    : ""
                }
                ${
                  item
                    ? ""
                    : html`<label
                              >Type<select name="type">
                                  ${options(
                                    STORE_TYPES.map(([t, name]) => [String(t), name]),
                                    "0",
                                  )}</select
                              ><span class="hint" id="store-type-hint">${STORE_TYPES[0][2]}</span></label
                          >`
                }
                <label>Name<input name="name" required maxlength="100" value="${item?.name ?? ""}" placeholder="Pumpkin Crown" /></label>
                <label
                    >Summary<span class="hint">Optional. Shown in the shop; each type has a default.</span><input name="summary" maxlength="500" value="${item?.summary ?? ""}"
                /></label>
                <label
                    >Description for screen readers<span class="hint">What it looks like, for people who can't see it.</span
                    ><input name="label" maxlength="500" value="${item?.label ?? ""}"
                /></label>
                <label
                    >Order in this pack<input name="position" type="number" step="1" min="-2147483648" max="2147483647" value="${item?.position ?? 0}" /><span class="hint"
                        >Lower numbers appear first.</span
                    ></label
                >
                <div class="stack" id="store-type-fields"></div>
                <div class="form-actions">
                    <button class="btn" id="store-item-back" type="button" style="margin-right:auto">Back to ${pack.name}</button>
                    ${
                      item
                        ? html`
                            <button class="btn danger" id="store-item-delete" type="button">Delete</button>
                          `
                        : ""
                    }
                    <button class="btn primary" type="submit">${item ? "Save" : "Add item"}</button>
                </div>
            </form>
        `,
  );
  if (!body) return;
  const form = $("#store-item-form", body);
  const renderFields = () => {
    for (const key of Object.keys(art)) delete art[key];
    mount($("#store-type-fields", body), storeItemFields(type, item));
    for (const input of $$("[data-art]", form))
      input.addEventListener("change", async () => (art[input.dataset.art] = await pickArt(input)));
    for (const btn of $$("[data-art-remove]", form))
      btn.addEventListener("click", () => {
        art[btn.dataset.artRemove] = null;
        form.dataset.dirty = "true";
        mount(
          btn.parentElement,
          html`
            <span class="muted">Removed when you save</span>
          `,
        );
      });
  };
  renderFields();
  form.type?.addEventListener("change", () => {
    type = Number(form.type.value);
    $("#store-type-hint").textContent = STORE_TYPES.find(([t]) => t === type)?.[2] ?? "";
    renderFields();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: form.name.value,
      summary: form.summary.value,
      label: form.label.value,
      position: Number(form.position.value),
    };
    if (item) payload.pack_id = form.pack_id.value;
    if (!item) payload.type = type;
    if (type === 2) payload.palette = form.palette.value;
    if (type === 1)
      Object.assign(payload, {
        duration: Number(form.duration.value) || 3000,
        loop: form.loop.checked,
      });
    if (type === 3)
      Object.assign(payload, {
        overflow_top: Number(form.overflow_top.value) || 0,
        overflow_bottom: Number(form.overflow_bottom.value) || 0,
      });
    const changed = Object.fromEntries(
      Object.entries(art).filter(([, v]) => v !== undefined && (item || v)),
    );
    if (Object.keys(changed).length) payload.art = changed;
    const saved = await act(
      $("button[type=submit]", form),
      () =>
        item
          ? api(`/admin/store/items/${item.id}`, { method: "PATCH", body: payload })
          : api(`/admin/store/packs/${pack.id}/items`, { method: "POST", body: payload }),
      item ? "Item saved" : "Item added",
    );
    if (saved) {
      await refresh();
      if (!body.isConnected || $("#drawer").hidden) return;
      openPack(saved.pack_id ?? pack.id, refresh);
    }
  });
  $("#store-item-back", body).addEventListener("click", () => openPack(pack.id, refresh));
  $("#store-item-delete", body)?.addEventListener("click", async (e) => {
    if (!confirm(`Delete "${item.name}"? People who have it stop seeing it.`)) return;
    const done = await act(
      e.currentTarget,
      () => api(`/admin/store/items/${item.id}`, { method: "DELETE" }),
      "Item deleted",
    );
    if (done !== undefined) {
      await refresh();
      if (!body.isConnected || $("#drawer").hidden) return;
      openPack(pack.id, refresh);
    }
  });
}

/* ---------- guilds ---------- */

const guildsState = { q: "", offset: 0, limit: 50 };

async function renderGuilds(view) {
  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Servers</h1>
                    <p class="muted">Every server on this instance. Click one to edit, transfer or delete it.</p>
                </div>
            </div>
            <div class="row" style="margin-bottom:12px">
                <label class="grow list-search"
                    >Find servers<input id="guild-search" type="search" placeholder="Search names or IDs" value="${guildsState.q}" aria-controls="guild-results"
                /></label>
            </div>
            <div class="list-status muted" id="guild-status" role="status" aria-live="polite" hidden></div>
            <div id="guild-results"><div class="spinner">Loading…</div></div>
        `,
  );

  const results = $("#guild-results", view);
  const requests = latestList(view, results, $("#guild-status", view));
  const load = async () => {
    const params = new URLSearchParams({
      q: guildsState.q,
      limit: guildsState.limit,
      offset: guildsState.offset,
    });
    await requests.load(
      `/admin/guilds?${params}`,
      ({ guilds, total }) => {
        mount(
          results,
          guilds.length
            ? html`
                              <div class="table-wrap">
                                  <table>
                                      <thead>
                                          <tr>
                                              <th>Server</th>
                                              <th>Owner</th>
                                              <th>Members</th>
                                              <th class="hide-sm">Created</th>
                                          </tr>
                                      </thead>
                                      <tbody>
                                          ${guilds.map(
                                            (g) => html`
                                                  <tr data-id="${g.id}">
                                                      <td>
                                                          <div class="ident">
                                                              ${guildIcon(g)}
                                                              <div>
                                                                  <strong class="row" style="gap:6px">${g.name}${g.tag ? tagChip(g.id, g.tag.tag, g.tag.badge_hash) : ""}</strong>
                                                                  ${g.features.length ? html`<span class="muted">${g.features.slice(0, 3).join(", ")}${g.features.length > 3 ? "…" : ""}</span>` : ""}
                                                              </div>
                                                          </div>
                                                      </td>
                                                      <td>
                                                          ${
                                                            g.owner
                                                              ? html`<div class="ident">${avatar(g.owner)}<span>${userName(g.owner)}</span></div>`
                                                              : html`
                                                                  <span class="muted">None</span>
                                                                `
                                                          }
                                                      </td>
                                                      <td>${fmtNumber(g.member_count)}</td>
                                                      <td class="hide-sm">${fmtDay(snowflakeDate(g.id))}</td>
                                                  </tr>
                                              `,
                                          )}
                                      </tbody>
                                  </table>
                              </div>
                              ${pager(total, guildsState)}
                          `
            : html`
                <div class="card empty">No servers match.</div>
              `,
        );
        for (const row of $$("tbody tr", results))
          row.addEventListener("click", () => openGuild(row.dataset.id, load));
        bindPager(results, total, guildsState, load);
      },
      load,
    );
  };

  const search = debounce(load);
  $("#guild-search", view).addEventListener("input", (e) => {
    requests.cancel();
    guildsState.q = e.target.value.trim();
    guildsState.offset = 0;
    search();
  });
  await load();
}

async function openGuild(id, reload, resourcesOpen = false) {
  const body = openDrawer(
    "Server",
    html`
      <div class="spinner">Loading…</div>
    `,
  );
  if (!body) return;
  let g;
  try {
    g = await api(`/admin/guilds/${id}`);
  } catch (e) {
    if (!body.isConnected || $("#drawer").hidden || e.status === 401 || e.status === 499) return;
    return mount(body, html`<p class="form-error">${e.message}</p>`);
  }
  if (!body.isConnected || $("#drawer").hidden) return;
  const features = new Set(g.features);

  const renderFeatures = () =>
    mount(
      $("#feature-chips"),
      features.size
        ? [...features].map(
            (f) =>
              html`<span class="chip">${f}<button type="button" data-remove="${f}" aria-label="Remove ${f}">✕</button></span>`,
          )
        : html`
            <span class="muted">No features</span>
          `,
    );

  mount(
    body,
    html`
            <div class="ident">
                ${guildIcon(g, "large")}
                <div>
                    <h2>${g.name}</h2>
                    <code class="muted">${g.id}</code>
                </div>
            </div>
            <div class="card">
                <div class="list">
                    <div class="list-item">
                        <span class="grow muted">Owner</span>
                        ${g.owner ? html`<span class="ident">${avatar(g.owner)}<span>${userName(g.owner)}</span></span>` : "None"}
                        ${
                          g.owner && state.overview.access.users
                            ? html`
                                <button class="btn small ghost" id="open-owner" type="button">Open</button>
                              `
                            : ""
                        }
                    </div>
                    <div class="list-item"><span class="grow muted">Members</span><span>${fmtNumber(g.member_count)}</span></div>
                    <div class="list-item"><span class="grow muted">Channels</span><span>${fmtNumber(g.channel_count)}</span></div>
                    <div class="list-item"><span class="grow muted">Created</span><span>${fmtDate(snowflakeDate(g.id))}</span></div>
                </div>
            </div>

            <form id="guild-form" class="card stack">
                <h3>Details</h3>
                <div class="form-grid">
                    ${imageField("icon", "Server icon", g.icon)} ${imageField("banner", "Server banner", g.banner)} ${imageField("splash", "Invite background", g.splash)}
                    ${imageField("discovery_splash", "Discovery background", g.discovery_splash)}
                </div>
                <label>Name<input name="name" value="${g.name}" minlength="2" maxlength="100" required /></label>
                <label>Description<textarea name="description" maxlength="300">${g.description ?? ""}</textarea></label>
                <div class="stack">
                    <div class="row" style="justify-content:space-between">
                        <h3>Server tag</h3>
                        <span id="tag-preview"></span>
                    </div>
                    <label
                        >Tag<span class="hint"
                            >Shown next to members' names. Staff can use any text of any length here (server owners are limited to 2–4 letters or numbers). Leave empty to remove
                            the tag.</span
                        ><input name="tag" autocomplete="off" value="${g.tag?.tag ?? ""}" placeholder="LARP"
                    /></label>
                    <div class="stack" id="tag-badge-fields">
                        <span class="muted">Badge</span>
                        <div id="badge-picker" class="badge-picker"><span class="muted">Loading badges…</span></div>
                        <label class="toggle"
                            ><input type="checkbox" name="badge_default_colors" ${g.tag?.badge_color_primary ? "" : raw("checked")} /><span
                                >Use the badge's own colours</span
                            ></label
                        >
                        <div class="row" id="badge-colors">
                            <label class="row" style="gap:8px">Main<input type="color" name="badge_color_primary" value="${g.tag?.badge_color_primary ?? "#5865f2"}" /></label>
                            <label class="row" style="gap:8px"
                                >Accent<input type="color" name="badge_color_secondary" value="${g.tag?.badge_color_secondary ?? "#ffffff"}"
                            /></label>
                        </div>
                    </div>
                </div>
                <div class="stack">
                    <h3>Feature flags</h3>
                    <div id="feature-chips" class="chips"></div>
                    <div class="row">
                        <input class="grow" id="feature-input" list="feature-list" placeholder="Add a feature, e.g. VERIFIED" />
                        <datalist id="feature-list">${GUILD_FEATURES.map((f) => html`<option value="${f}"></option>`)}</datalist>
                        <button class="btn" type="button" id="feature-add">Add</button>
                    </div>
                </div>
                <div class="form-grid">
                    <label
                        >Verification level<select name="verification_level">
                            ${options(
                              [
                                [0, "None"],
                                [1, "Verified email"],
                                [2, "Registered for 5 minutes"],
                                [3, "Member for 10 minutes"],
                                [4, "Verified phone"],
                              ],
                              g.verification_level,
                            )}
                        </select></label
                    >
                    <label
                        >Media filter<select name="explicit_content_filter">
                            ${options(
                              [
                                [0, "Off"],
                                [1, "Members without roles"],
                                [2, "All members"],
                              ],
                              g.explicit_content_filter,
                            )}
                        </select></label
                    >
                    <label
                        >Default notifications<select name="default_message_notifications">
                            ${options(
                              [
                                [0, "All messages"],
                                [1, "Only mentions"],
                              ],
                              g.default_message_notifications,
                            )}
                        </select></label
                    >
                    <label
                        >Boost tier<select name="premium_tier">
                            ${options(
                              [
                                [0, "None"],
                                [1, "Level 1"],
                                [2, "Level 2"],
                                [3, "Level 3"],
                              ],
                              g.premium_tier,
                            )}
                        </select></label
                    >
                    <label
                        >Inactive voice timeout<select name="afk_timeout">
                            ${options(
                              [
                                [60, "1 minute"],
                                [300, "5 minutes"],
                                [900, "15 minutes"],
                                [1800, "30 minutes"],
                                [3600, "1 hour"],
                              ],
                              g.afk_timeout,
                            )}
                        </select></label
                    >
                    <label>Language<input name="preferred_locale" value="${g.preferred_locale ?? "en-US"}" required /></label>
                    <label class="toggle"><input name="nsfw" type="checkbox" ${g.nsfw ? raw("checked") : ""} /><span>Age restricted server</span></label>
                </div>
                <label
                    >Owner user ID<span class="hint">Transfer ownership to another member of this server.</span
                    ><input name="owner_id" value="${g.owner?.id ?? ""}" inputmode="numeric"
                /></label>
                <div class="form-actions"><button class="btn primary" type="submit">Save server</button></div>
            </form>

            <details class="card" id="server-resources">
                <summary>Manage channels and roles</summary>
                <p class="muted">Create channels and roles, or edit their details and permissions.</p>
                <div id="server-resource-body" class="stack"></div>
            </details>
            <div class="card danger-zone stack">
                <h3>Danger zone</h3>
                <p class="muted" style="margin:0">Deletes the server with all its channels, messages, roles and members. This can't be undone.</p>
                <label>Type the server name to confirm<input id="guild-confirm" placeholder="${g.name}" autocomplete="off" /></label>
                <div><button class="btn danger" id="guild-delete" type="button" disabled>Delete server</button></div>
            </div>
        `,
  );
  let resourcesLoaded = false;
  $("#server-resources", body).addEventListener("toggle", async (event) => {
    if (!event.currentTarget.open || resourcesLoaded) return;
    const target = $("#server-resource-body", body);
    mount(
      target,
      html`
        <div class="spinner">Loading channels and roles…</div>
      `,
    );
    try {
      const [channelData, roleData] = await Promise.all([
        api(`/admin/guilds/${id}/channels`),
        api(`/admin/guilds/${id}/roles`),
      ]);
      resourcesLoaded = true;
      mount(
        target,
        html`<div class="form-actions">
                        <h3>Channels</h3>
                        <button class="btn" type="button" data-create-channel>Create channel</button>
                    </div>
                    ${
                      channelData.truncated
                        ? html`
                            <p class="muted">Showing the first 1,000 channels.</p>
                          `
                        : ""
                    }
                    <div class="resource-list">
                        ${channelData.channels.map((channel) => html`<button class="resource-row" type="button" data-edit-channel="${channel.id}"><span>${channel.type === 4 ? "Category" : channel.type === 2 ? "Voice" : "Channel"}</span><strong>${channel.name}</strong><span class="muted">Edit</span></button>`)}
                    </div>
                    <div class="form-actions">
                        <h3>Roles</h3>
                        <button class="btn" type="button" data-create-role>Create role</button>
                    </div>
                    <div class="resource-list">
                        ${roleData.roles.map((role) => html`<button class="resource-row" type="button" data-edit-role="${role.id}" ${role.managed ? raw("disabled") : ""}><strong>${role.name}</strong><span class="muted">${role.managed ? "Integration managed" : "Edit"}</span></button>`)}
                    </div>`,
      );
      $("[data-create-channel]", target).addEventListener("click", () =>
        openAdminChannel(id, null, channelData.channels),
      );
      $("[data-create-role]", target).addEventListener("click", () =>
        openAdminRole(id, null, roleData.permissions),
      );
      for (const button of $$("[data-edit-channel]", target))
        button.addEventListener("click", () =>
          openAdminChannel(
            id,
            channelData.channels.find((channel) => channel.id === button.dataset.editChannel),
            channelData.channels,
          ),
        );
      for (const button of $$("[data-edit-role]", target))
        button.addEventListener("click", () =>
          openAdminRole(
            id,
            roleData.roles.find((role) => role.id === button.dataset.editRole),
            roleData.permissions,
          ),
        );
    } catch (error) {
      if (error.status !== 499) mount(target, html`<p class="form-error">${error.message}</p>`);
    }
  });
  renderFeatures();

  const addFeature = () => {
    const input = $("#feature-input");
    const value = input.value.trim().toUpperCase().replace(/\s+/g, "_");
    if (value) features.add(value);
    input.value = "";
    renderFeatures();
  };
  $("#feature-add").addEventListener("click", addFeature);
  $("#feature-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFeature();
    }
  });
  $("#feature-chips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    features.delete(btn.dataset.remove);
    renderFeatures();
  });
  $("#open-owner")?.addEventListener("click", () => openUser(g.owner.id));

  const tagForm = $("#guild-form");
  let badge = g.tag?.badge ?? 0;
  const badgeColours = () =>
    tagForm.badge_default_colors.checked
      ? {}
      : {
          primary: tagForm.badge_color_primary.value,
          secondary: tagForm.badge_color_secondary.value,
        };
  const previewUrl = (id, size) =>
    `/clan-badges/preview/${id}?${new URLSearchParams({ size, ...badgeColours() })}`;
  const renderTagPreview = () => {
    const tag = tagForm.tag.value.trim();
    $("#tag-badge-fields").hidden = !tag;
    $("#badge-colors").hidden = tagForm.badge_default_colors.checked;
    mount(
      $("#tag-preview"),
      tag
        ? html`<span class="tag-chip"><img src="${previewUrl(badge, 32)}" alt="" />${tag}</span>`
        : html`
            <span class="muted">No tag</span>
          `,
    );
    for (const img of $$("[data-badge] img", tagForm))
      img.src = previewUrl(img.closest("[data-badge]").dataset.badge, 48);
    for (const btn of $$("[data-badge]", tagForm))
      btn.classList.toggle("active", Number(btn.dataset.badge) === badge);
  };
  // revalidated, since browsers may still hold a copy from when the list was cached for hours
  fetch("/clan-badges/preview", { cache: "no-cache" })
    .then((r) => r.json())
    .then((list) => {
      // grouped by pack, in the order the packs first appear: discord's free badges and packs, then the instance's own
      const packs = new Map();
      for (const b of list)
        packs.set(b.pack ?? "Discord", [...(packs.get(b.pack ?? "Discord") ?? []), b]);
      mount(
        $("#badge-picker"),
        list.length
          ? [...packs].map(
              ([pack, badges]) =>
                html`<div class="badge-pack-title">${pack}<span class="muted">${badges.length}</span></div>
                                  ${badges.map(
                                    (b) =>
                                      html`<button
                                              type="button"
                                              class="badge-option ${b.staff_only ? "staff-only" : ""}"
                                              data-badge="${b.id}"
                                              title="${b.name.toLowerCase().replace(/_/g, " ")}${b.staff_only ? " (staff only: server owners can't pick it)" : ""}"
                                          >
                                              <img src="${previewUrl(b.id, 48)}" alt="${b.name}" />
                                          </button>`,
                                  )}`,
            )
          : html`
              <span class="muted"
                >Badge artwork isn't available. Run <code>npm run generate:client</code> on the server.</span
              >
            `,
      );
      renderTagPreview();
    })
    .catch(() =>
      mount(
        $("#badge-picker"),
        html`
          <span class="muted">Couldn't load badges.</span>
        `,
      ),
    );
  $("#badge-picker").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-badge]");
    if (!btn) return;
    badge = Number(btn.dataset.badge);
    renderTagPreview();
  });
  tagForm.tag.addEventListener("input", renderTagPreview);
  tagForm.badge_default_colors.addEventListener("change", renderTagPreview);
  for (const input of [tagForm.badge_color_primary, tagForm.badge_color_secondary])
    input.addEventListener("input", debounce(renderTagPreview, 150));
  renderTagPreview();

  $("#guild-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const patch = {
      name: form.name.value,
      description: form.description.value,
      features: [...features],
      nsfw: form.nsfw.checked,
      preferred_locale: form.preferred_locale.value,
    };
    for (const field of [
      "verification_level",
      "explicit_content_filter",
      "default_message_notifications",
      "premium_tier",
      "afk_timeout",
    ])
      patch[field] = Number(form.elements[field].value);
    const owner = form.owner_id.value.trim();
    if (owner && owner !== g.owner?.id) patch.owner_id = owner;

    const tag = form.tag.value.trim();
    const colours = badgeColours();
    const next = {
      tag: tag || null,
      badge,
      badge_color_primary: colours.primary ?? null,
      badge_color_secondary: colours.secondary ?? null,
    };
    const prev = g.tag
      ? {
          tag: g.tag.tag,
          badge: g.tag.badge,
          badge_color_primary: g.tag.badge_color_primary,
          badge_color_secondary: g.tag.badge_color_secondary,
        }
      : { tag: null };
    if (!next.tag) {
      if (prev.tag) patch.tag = null;
    } else if (JSON.stringify(next) !== JSON.stringify(prev)) Object.assign(patch, next);
    const saved = await act(
      $("button[type=submit]", form),
      async () => {
        await imagePatch(form, ["icon", "banner", "splash", "discovery_splash"], patch);
        return api(`/admin/guilds/${g.id}`, { method: "PATCH", body: patch });
      },
      "Server updated",
    );
    if (saved && form.isConnected && !$("#drawer").hidden && !form.dataset.dirty) {
      reload?.();
      openGuild(g.id, reload);
    }
  });

  $("#guild-confirm").addEventListener("input", (e) => {
    $("#guild-delete").disabled = e.target.value !== g.name;
  });
  $("#guild-delete").addEventListener("click", async (e) => {
    const done = await act(
      e.currentTarget,
      () => api(`/admin/guilds/${g.id}`, { method: "DELETE" }),
      `${g.name} was deleted`,
    );
    if (done !== undefined) {
      closeDrawer();
      reload?.();
    }
  });
  $("#server-resources", body).open = resourcesOpen;
}

/* ---------- system ---------- */

const fmtBytes = (n) =>
  n == null ? "—" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
const fmtAgo = (value) => {
  if (!value) return "never";
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  return seconds < 60 ? "just now" : `${fmtDuration(seconds)} ago`;
};
const item = (label, value) =>
  html`<div class="list-item"><span class="grow muted">${label}</span><span style="text-align:right">${value}</span></div>`;
const PATCH_GROUPS = [
  ["fosscord", "Fosscord plugins", "danger"],
  ["enabled", "Upstream plugins enabled by default", "warn"],
  ["upstream", "Other upstream plugins", ""],
];

async function renderSystem(view) {
  mount(
    view,
    html`
      <div class="page-head">
        <div>
          <h1>System</h1>
          <p class="muted">The bundled web client, its Vencord mods, the Shop catalogue and voice.</p>
        </div>
        <button class="btn" id="system-refresh" type="button">Check again</button>
      </div>
      <div class="stack">
        <div id="system-client" class="stack"><div class="card spinner">Loading client status…</div></div>
        <div class="card stack" id="system-voice"><div class="spinner">Loading voice status…</div></div>
        <div class="card stack" id="system-collectibles">
          <div class="spinner">Loading Shop catalogue…</div>
        </div>
      </div>
    `,
  );
  $("#system-refresh").addEventListener("click", () => renderSystem(view));

  const fail = (el, title) => (e) => {
    if (e.status !== 401 && e.status !== 499)
      mount(
        el,
        html`<h2>${title}</h2>
                    <p class="form-error">${e.message}</p>`,
      );
  };
  await Promise.all([
    api("/admin/system/client").then(renderClientStatus, fail($("#system-client"), "Web client")),
    api("/admin/system/voice").then(renderVoiceStatus, fail($("#system-voice"), "Voice")),
    api("/admin/system/collectibles").then(
      renderCollectiblesStatus,
      fail($("#system-collectibles"), "Shop catalogue"),
    ),
  ]);
}

function renderClientStatus({ client, vencord, patch_check: check }) {
  const el = $("#system-client");
  if (!el) return;
  const stale = check && client.build_number && check.build_number !== client.build_number;
  const outdated =
    check && vencord.built_at && new Date(check.checked_at) < new Date(vencord.built_at);
  const groups = check
    ? PATCH_GROUPS.map(([key, label, tone]) => ({
        label,
        tone,
        items: [
          ...check.bad_patches
            .filter((p) => p.group === key)
            .map((p) => ({
              plugin: p.plugin,
              text: `Patch ${p.type}`,
              detail: p.error ?? p.match,
            })),
          ...check.bad_starts
            .filter((p) => p.group === key)
            .map((p) => ({ plugin: p.plugin, text: "Failed to start", detail: p.error })),
          ...(key === "fosscord"
            ? check.unmatched_all_patches.map((p) => ({
                plugin: p.plugin,
                text: "Patch found no module",
                detail: p.find,
              }))
            : []),
          ...(key === "upstream"
            ? check.bad_finds.map((find) => ({
                plugin: "Webpack",
                text: "Find failed",
                detail: find,
              }))
            : []),
        ],
      }))
    : [];
  const problems = groups.slice(0, 2).reduce((n, g) => n + g.items.length, 0);

  mount(
    el,
    html`
            <div class="card">
                <div class="row" style="justify-content:space-between;margin-bottom:8px">
                    <h2 style="margin:0">Web client</h2>
                    ${
                      !client.enabled
                        ? html`
                            <span class="badge"><span class="dot"></span>Not served</span>
                          `
                        : client.present
                          ? html`<span class="badge ok"><span class="dot"></span>Build ${client.build_number ?? "unknown"}</span>`
                          : html`
                              <span class="badge danger"><span class="dot"></span>Missing</span>
                            `
                    }
                </div>
                ${
                  client.present
                    ? html`<div class="list">
                              ${item("Build number", client.build_number ?? "—")} ${item("Version hash", html`<code>${client.version_hash?.slice(0, 12) ?? "—"}</code>`)}
                              ${item("Downloaded", html`${fmtDate(client.generated_at)} <span class="muted">(${fmtAgo(client.generated_at)})</span>`)}
                              ${item("Cached files", `${fmtNumber(client.files)} files, ${client.compressed_files == null ? "not precompressed" : `${fmtNumber(client.compressed_files)} precompressed`}`)}
                              ${item("Client patches", client.patches.length ? html`<span class="badges" style="justify-content:flex-end">${client.patches.map((p) => html`<span class="badge">${p.replace(/\.js$/, "")}</span>`)}</span>` : "None")}
                              ${item(
                                "Failed downloads",
                                client.failures.count
                                  ? html`<span class="badge warn">${fmtNumber(client.failures.count)}</span>`
                                  : html`
                                      <span class="badge ok">None</span>
                                    `,
                              )}
                              ${item(
                                "Assets missing from the cache",
                                client.misses.count
                                  ? html`<span class="badge warn">${fmtNumber(client.misses.count)} files</span>`
                                  : html`
                                      <span class="badge ok">None</span>
                                    `,
                              )}
                          </div>`
                    : html`
                        <p class="muted" style="margin: 0">
                          There's no client in <code>assets/cache</code>. Run <code>npm run generate:client</code> on the
                          server.
                        </p>
                      `
                }
                ${
                  client.failures.count || client.misses.count
                    ? html`<details style="margin-top:12px">
                              <summary class="btn small" style="width:max-content">Show files</summary>
                              <div class="stack" style="margin-top:10px;gap:10px">
                                  ${
                                    client.failures.count
                                      ? html`<div>
                                                <strong>Failed during download</strong>
                                                <pre class="file-list">${client.failures.items.join("\n")}</pre>
                                            </div>`
                                      : ""
                                  }
                                  ${
                                    client.misses.count
                                      ? html`<div>
                                                <strong>Not in the cache, fetched from Discord when asked for</strong>
                                                <pre class="file-list">${client.misses.items.join("\n")}</pre>
                                                <span class="muted">Running <code>npm run generate:client</code> again adds them to the cache.</span>
                                            </div>`
                                      : ""
                                  }
                              </div>
                          </details>`
                    : ""
                }
            </div>
            <div class="card">
                <div class="row" style="justify-content:space-between;margin-bottom:8px">
                    <h2 style="margin:0">Vencord</h2>
                    ${
                      vencord.present
                        ? html`<span class="badge ok"><span class="dot"></span>v${vencord.version ?? "?"}</span>`
                        : html`
                            <span class="badge danger"><span class="dot"></span>Not built</span>
                          `
                    }
                </div>
                ${
                  vencord.present
                    ? html`<div class="list">
                              ${item("Built", html`${fmtDate(vencord.built_at)} <span class="muted">(${fmtAgo(vencord.built_at)})</span>`)}
                              ${item("Commit", vencord.commit ? html`<code>${vencord.commit.slice(0, 10)}</code>` : "—")} ${item("Bundle size", fmtBytes(vencord.size))}
                              ${item("Fosscord plugins", html`<span class="badges" style="justify-content:flex-end">${vencord.plugins.map((p) => html`<span class="badge accent">${p.replace(/^fosscord/, "")}</span>`)}</span>`)}
                          </div>`
                    : html`
                        <p class="muted" style="margin: 0">
                          The client runs without its mods. Run <code>npm run build:vencord</code> on the server.
                        </p>
                      `
                }
            </div>
            <div class="card">
                <div class="row" style="justify-content:space-between;margin-bottom:8px">
                    <h2 style="margin:0">Patch check</h2>
                    ${
                      !check
                        ? html`
                            <span class="badge"><span class="dot"></span>Never run</span>
                          `
                        : check.outcome !== "done"
                          ? html`<span class="badge danger"><span class="dot"></span>Didn't finish (${check.outcome})</span>`
                          : problems
                            ? html`<span class="badge danger"><span class="dot"></span>${fmtNumber(problems)} ${problems === 1 ? "problem" : "problems"}</span>`
                            : html`
                                <span class="badge ok"><span class="dot"></span>Passing</span>
                              `
                    }
                </div>
                ${
                  check
                    ? html`<div class="list">
                                  ${item("Checked", html`${fmtDate(check.checked_at)} <span class="muted">(${fmtAgo(check.checked_at)}, took ${check.seconds}s)</span>`)}
                                  ${item(
                                    "Against build",
                                    html`${check.build_number ?? "unknown"}${stale ? html` <span class="badge warn">The client is now ${client.build_number}</span>` : ""}`,
                                  )}
                                  ${
                                    outdated
                                      ? item(
                                          "Vencord",
                                          html`
                                            <span class="badge warn">Rebuilt since this check</span>
                                          `,
                                        )
                                      : ""
                                  }
                                  ${check.errors.length ? item("Page errors", html`<span class="badge danger">${fmtNumber(check.errors.length)}</span>`) : ""}
                              </div>
                              <div class="stack" style="margin-top:14px;gap:12px">
                                  ${groups.map(
                                    (g) =>
                                      html`<div class="stack" style="gap:6px">
                                              <div class="row">
                                                  <strong class="grow">${g.label}</strong
                                                  >${
                                                    g.items.length
                                                      ? html`<span class="badge ${g.tone}">${fmtNumber(g.items.length)}</span>`
                                                      : html`
                                                          <span class="badge ok">OK</span>
                                                        `
                                                  }
                                              </div>
                                              ${
                                                g.items.length
                                                  ? html`<div class="list">
                                                            ${g.items.map(
                                                              (i) =>
                                                                html`<div class="list-item" style="align-items:flex-start">
                                                                        <div class="grow" style="min-width:0">
                                                                            <strong>${i.plugin}</strong> <span class="muted">${i.text}</span>
                                                                            <pre class="file-list" style="margin:4px 0 0">${i.detail}</pre>
                                                                        </div>
                                                                    </div>`,
                                                            )}
                                                        </div>`
                                                  : ""
                                              }
                                          </div>`,
                                  )}
                                  ${
                                    check.errors.length
                                      ? html`<div>
                                                <strong>Page errors</strong>
                                                <pre class="file-list">${check.errors.join("\n")}</pre>
                                            </div>`
                                      : ""
                                  }
                              </div>`
                    : ""
                }
                <p class="muted" style="margin:12px 0 0">Run <code>npm run check:client</code> on the server after updating the client or the plugins to refresh this.</p>
            </div>
        `,
  );
}

function renderVoiceStatus(v) {
  const el = $("#system-voice");
  if (!el) return;
  const server = v.server;
  const sfu = server?.sfu;
  const healthy = server?.enabled && (!sfu || (sfu.connected && sfu.ping_ms !== null));
  mount(
    el,
    html`
            <div class="row" style="justify-content:space-between">
                <h2 style="margin:0">Voice</h2>
                ${
                  !server
                    ? html`
                        <span class="badge"><span class="dot"></span>Runs in another process</span>
                      `
                    : !server.enabled
                      ? html`
                          <span class="badge danger"><span class="dot"></span>Off</span>
                        `
                      : healthy
                        ? html`
                            <span class="badge ok"><span class="dot"></span>Healthy</span>
                          `
                        : html`
                            <span class="badge danger"><span class="dot"></span>Unhealthy</span>
                          `
                }
            </div>
            ${
              !server
                ? html`
                    <p class="muted" style="margin: 0">
                      The voice server doesn't run in the same process as the API, so only the database numbers below
                      are available here.
                    </p>
                  `
                : !server.enabled
                  ? html`<p class="form-error">${server.reason ?? "Voice is disabled."}</p>`
                  : html`<div class="list">
                            ${item("Media server", server.library === "pion" ? "Built-in pion SFU" : (server.library ?? "—"))} ${item("Voice gateway", server.listen ?? "—")}
                            ${item("Running since", html`${fmtDate(server.started_at)} <span class="muted">(${fmtAgo(server.started_at)})</span>`)}
                            ${server.reason ? item("Problem", html`<span class="form-error">${server.reason}</span>`) : ""}
                            ${
                              sfu
                                ? html`
                                          ${item(
                                            "SFU connection",
                                            sfu.connected
                                              ? html`<span class="badge ok">Connected</span>
                                                        <span class="muted">${sfu.ping_ms !== null ? `${sfu.ping_ms} ms ping` : sfu.ping_error}</span>`
                                              : html`
                                                  <span class="badge danger">Disconnected</span>
                                                `,
                                          )}
                                          ${item("SFU process", sfu.managed ? (sfu.pid ? html`Started by the server, pid <code>${sfu.pid}</code>` : "Started by the server, not running") : "Runs on its own")}
                                          ${item("Media address", html`<code>${sfu.public_ip}:${sfu.udp_port}</code> <span class="muted">UDP</span>`)}
                                          ${item("Restarts", sfu.restarts ? html`<span class="badge warn">${fmtNumber(sfu.restarts)}</span>${sfu.last_exit_at ? html` <span class="muted">last exit code ${sfu.last_exit_code ?? "?"}, ${fmtAgo(sfu.last_exit_at)}</span>` : ""}` : "None")}
                                          ${item("Connected media clients", `${fmtNumber(sfu.connected ? server.connected_clients : 0)} of ${fmtNumber(server.clients)} in ${fmtNumber(server.rooms)} ${server.rooms === 1 ? "room" : "rooms"}`)}
                                      `
                                : ""
                            }
                            ${item("DAVE sessions", fmtNumber(server.dave_sessions ?? 0))}
                        </div>`
            }
            <div class="stats">
                <div class="card stat">
                    <div class="muted">In voice</div>
                    <div class="value">${fmtNumber(v.voice_states.users)}</div>
                </div>
                <div class="card stat">
                    <div class="muted">Active channels</div>
                    <div class="value">${fmtNumber(v.voice_states.channels)}</div>
                </div>
                <div class="card stat">
                    <div class="muted">DM calls</div>
                    <div class="value">${fmtNumber(v.voice_states.dm_calls)}</div>
                </div>
                <div class="card stat">
                    <div class="muted">Cameras on</div>
                    <div class="value">${fmtNumber(v.voice_states.video)}</div>
                </div>
                <div class="card stat">
                    <div class="muted">Go Live streams</div>
                    <div class="value">${fmtNumber(v.voice_states.streams)}</div>
                </div>
            </div>
            <div class="stack" style="gap:6px">
                <strong>Voice regions</strong>
                <div class="list">
                    ${v.regions.available.map(
                      (r) =>
                        html`<div class="list-item">
                                <span class="grow"
                                    >${r.name}${
                                      r.id === v.regions.default
                                        ? html`
                                            <span class="badge accent">Default</span>
                                          `
                                        : ""
                                    }${
                                      r.deprecated
                                        ? html`
                                            <span class="badge">Deprecated</span>
                                          `
                                        : ""
                                    }</span
                                >
                                <code>${r.endpoint ?? "—"}</code>
                            </div>`,
                    )}
                </div>
            </div>
        `,
  );
}

function renderCollectiblesStatus(c) {
  const el = $("#system-collectibles");
  if (!el) return;
  const source = (label, s) =>
    item(
      label,
      s.updated_at
        ? html`${fmtDate(s.updated_at)} <span class="muted">(${fmtAgo(s.updated_at)}, ${fmtBytes(s.size)})</span>`
        : html`
            <span class="badge warn">Not downloaded</span>
          `,
    );
  mount(
    el,
    html`
            <div class="row" style="justify-content:space-between">
                <h2 style="margin:0">Shop catalogue</h2>
                <button class="btn small" id="collectibles-refresh" type="button">Refresh catalogue</button>
            </div>
            <p class="muted" style="margin:0">
                Decorations, effects, nameplates and bundles in the free Shop come from a public copy of Discord's catalogue, re-downloaded every ${c.refresh_interval_hours} hours.
            </p>
            <div class="list">
                ${source("Catalogue", c.catalog)} ${source("Profile effects", c.effects)}
                ${item(
                  "Loaded in the Shop",
                  c.loaded
                    ? `${fmtNumber(c.loaded.categories)} categories, ${fmtNumber(c.loaded.products)} products, ${fmtNumber(c.loaded.items)} items`
                    : html`
                        <span class="muted">Loads the first time someone opens the Shop</span>
                      `,
                )}
                ${
                  c.last_refresh
                    ? item(
                        "Last refresh",
                        c.last_refresh.ok
                          ? html`<span class="badge ok">OK</span> <span class="muted">${fmtAgo(c.last_refresh.at)}</span>`
                          : html`<span class="badge danger">Failed</span> <span class="muted">${fmtAgo(c.last_refresh.at)}</span>`,
                      )
                    : ""
                }
                ${c.last_refresh?.error ? item("Problem", html`<span class="form-error">${c.last_refresh.error}</span>`) : ""}
            </div>
        `,
  );
  $("#collectibles-refresh", el).addEventListener("click", async (e) => {
    const next = await act(e.currentTarget, () =>
      api("/admin/system/collectibles/refresh", { method: "POST" }),
    );
    if (!next) return;
    toast(
      next.last_refresh?.ok
        ? `Catalogue refreshed: ${fmtNumber(next.last_refresh.products)} products`
        : "Couldn't refresh the catalogue",
      next.last_refresh?.ok ? "ok" : "error",
    );
    renderCollectiblesStatus(next);
  });
}

/* ---------- status page ---------- */

async function renderStatus(view) {
  const [summary, components, { incidents }] = await Promise.all([
    api("/status/summary.json", { auth: false }),
    api("/admin/status/components"),
    api("/admin/status/incidents?limit=50"),
  ]);
  const open = incidents.filter((i) => !RESOLVED.includes(i.status));
  const closed = incidents.filter((i) => RESOLVED.includes(i.status));
  const indicatorClass =
    { none: "ok", maintenance: "info", minor: "warn", major: "warn", critical: "danger" }[
      summary.status.indicator
    ] ?? "";

  mount(
    view,
    html`
            <div class="page-head">
                <div>
                    <h1>Status page</h1>
                    <p class="muted">Components, incidents and maintenance shown on the public <a href="/status" target="_blank" rel="noopener">status page</a>.</p>
                </div>
                <div class="row">
                    <button class="btn" id="new-maintenance" type="button">Schedule maintenance</button>
                    <button class="btn primary" id="new-incident" type="button">Report incident</button>
                </div>
            </div>
            <div class="stack">
                <div class="card row">
                    <span class="badge ${indicatorClass}" style="font-size:13px;padding:5px 12px"><span class="dot"></span>${summary.status.description}</span>
                    <span class="muted">Currently shown at the top of the public page.</span>
                </div>

                <div class="card">
                    <div class="row" style="justify-content:space-between;margin-bottom:8px">
                        <h2>Components</h2>
                    </div>
                    <div class="list" id="component-list">
                        ${
                          components.length
                            ? components.map(
                                (c) => html`
                                          <div class="list-item" data-component="${c.id}">
                                              <div class="grow">
                                                  <strong>${c.name}</strong>
                                                  ${c.description ? html`<div class="muted">${c.description}</div>` : ""}
                                              </div>
                                              <select data-status style="width:auto">
                                                  ${options(COMPONENT_STATUSES, c.status)}
                                              </select>
                                              <button class="btn small ghost" data-edit type="button">Edit</button>
                                              <button class="btn small ghost" data-delete type="button" aria-label="Delete ${c.name}">Delete</button>
                                          </div>
                                      `,
                              )
                            : html`
                                <p class="muted">
                                  No components yet. Add the parts of your service people care about, like "API", "Gateway" or
                                  "Media".
                                </p>
                              `
                        }
                    </div>
                    <form id="component-add" class="row" style="margin-top:12px">
                        <input name="name" placeholder="Component name, e.g. Gateway" required maxlength="100" class="grow" style="min-width:180px" />
                        <input name="description" placeholder="Description (optional)" class="grow" style="min-width:180px" />
                        <button class="btn" type="submit">Add component</button>
                    </form>
                </div>

                <div class="stack">
                    <h2>Open incidents & maintenance</h2>
                    ${
                      open.length
                        ? open.map((i) => incidentCard(i, true))
                        : html`
                            <div class="card empty">Nothing open. All quiet.</div>
                          `
                    }
                </div>

                <div class="stack">
                    <h2>History</h2>
                    ${
                      closed.length
                        ? closed.map((i) => incidentCard(i, false))
                        : html`
                            <div class="card empty">No resolved incidents yet.</div>
                          `
                    }
                </div>
            </div>
        `,
  );

  const refresh = () => renderStatus(view);

  $("#new-incident").addEventListener("click", () => openIncidentForm(components, false, refresh));
  $("#new-maintenance").addEventListener("click", () =>
    openIncidentForm(components, true, refresh),
  );

  $("#component-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const done = await act(
      $("button", form),
      () =>
        api("/admin/status/components", {
          method: "POST",
          body: { name: form.name.value, description: form.description.value || null },
        }),
      "Component added",
    );
    if (done) refresh();
  });

  for (const row of $$("[data-component]", view)) {
    const id = row.dataset.component;
    const component = components.find((c) => c.id === id);
    $("[data-status]", row).addEventListener("change", async (e) => {
      const done = await act(
        e.target,
        () =>
          api(`/admin/status/components/${id}`, {
            method: "PATCH",
            body: { status: e.target.value },
          }),
        `${component.name}: ${componentStatus(e.target.value)[1]}`,
      );
      if (done) refresh();
    });
    $("[data-edit]", row).addEventListener("click", () => {
      const body = openDrawer(
        "Edit component",
        html`<form id="component-edit" class="stack">
                    <label>Name<input name="name" value="${component.name}" required maxlength="100" /></label>
                    <label>Description<textarea name="description">${component.description ?? ""}</textarea></label>
                    <label>Position<span class="hint">Lower numbers are listed first.</span><input name="position" type="number" value="${component.position}" /></label>
                    <div class="form-actions"><button class="btn primary" type="submit">Save component</button></div>
                </form>`,
      );
      if (!body) return;
      $("#component-edit", body).addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        const done = await act(
          $("button", f),
          () =>
            api(`/admin/status/components/${id}`, {
              method: "PATCH",
              body: {
                name: f.name.value,
                description: f.description.value || null,
                position: Number(f.position.value) || 0,
              },
            }),
          "Component saved",
        );
        if (done) refresh();
      });
    });
    $("[data-delete]", row).addEventListener("click", async (e) => {
      if (
        !confirm(
          `Delete the "${component.name}" component? It's also removed from incidents that reference it.`,
        )
      )
        return;
      const done = await act(
        e.currentTarget,
        () => api(`/admin/status/components/${id}`, { method: "DELETE" }),
        "Component deleted",
      );
      if (done !== undefined) refresh();
    });
  }

  for (const card of $$("[data-incident]", view)) {
    const incident = incidents.find((i) => i.id === card.dataset.incident);
    $("[data-update-form]", card)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const done = await act(
        $("button[type=submit]", f),
        () =>
          api(`/admin/status/incidents/${incident.id}/updates`, {
            method: "POST",
            body: { status: f.status.value, body: f.body.value },
          }),
        "Update posted",
      );
      if (done) refresh();
    });
    $("[data-edit]", card)?.addEventListener("click", () =>
      openIncidentForm(components, incident.impact === "maintenance", refresh, incident),
    );
    $("[data-delete]", card).addEventListener("click", async (e) => {
      if (
        !confirm(
          `Delete "${incident.name}" and its whole timeline? Use an update to resolve it instead if it should stay in the history.`,
        )
      )
        return;
      const done = await act(
        e.currentTarget,
        () => api(`/admin/status/incidents/${incident.id}`, { method: "DELETE" }),
        "Incident deleted",
      );
      if (done !== undefined) refresh();
    });
  }
}

function incidentCard(i, isOpen) {
  const isMaintenance = i.impact === "maintenance";
  const states = isMaintenance ? MAINTENANCE_STATES : INCIDENT_STATES;
  return html`
        <div class="incident" data-incident="${i.id}">
            <div class="row">
                <strong class="grow">${i.name}</strong>
                ${impactBadge(i)} ${stateBadge(i.status)}
            </div>
            <div class="muted">
                ${isMaintenance && i.scheduled_for ? html`Window: ${fmtDate(i.scheduled_for)} → ${fmtDate(i.scheduled_until)} · ` : ""}Opened
                ${fmtDate(i.created_at)}${i.resolved_at ? html` · ${isMaintenance ? "Completed" : "Resolved"} ${fmtDate(i.resolved_at)}` : ""}
            </div>
            ${i.components.length ? html`<div class="badges">${i.components.map((c) => html`<span class="badge">${c.name}</span>`)}</div>` : ""}
            <div class="timeline">
                ${i.incident_updates.map(
                  (u) =>
                    html`<div class="timeline-item">
                            <div class="row"><strong>${stateLabel(u.status)}</strong><span class="muted">${fmtDate(u.created_at)}</span></div>
                            <p>${u.body}</p>
                        </div>`,
                )}
            </div>
            ${
              isOpen
                ? html`<form data-update-form class="stack">
                          <div class="row">
                              <select name="status" style="width:auto">
                                  ${options(states, states[Math.min(states.findIndex(([k]) => k === i.status) + 1, states.length - 1)][0])}
                              </select>
                              <span class="muted">Posting an update moves the ${isMaintenance ? "maintenance" : "incident"} to this state.</span>
                          </div>
                          <textarea name="body" placeholder="What's the latest?" required></textarea>
                          <div class="row" style="justify-content:flex-end">
                              <button class="btn ghost small" data-edit type="button">Edit details</button>
                              <button class="btn ghost small" data-delete type="button">Delete</button>
                              <button class="btn primary small" type="submit">Post update</button>
                          </div>
                      </form>`
                : html`
                    <div class="row" style="justify-content: flex-end">
                      <button class="btn ghost small" data-delete type="button">Delete</button>
                    </div>
                  `
            }
        </div>
    `;
}

function openIncidentForm(components, isMaintenance, refresh, existing) {
  const editing = !!existing;
  const title = editing
    ? `Edit ${isMaintenance ? "maintenance" : "incident"}`
    : isMaintenance
      ? "Schedule maintenance"
      : "Report incident";
  const body = openDrawer(
    title,
    html`
            <form id="incident-form" class="stack">
                <label
                    >Title<input
                        name="name"
                        required
                        maxlength="200"
                        value="${existing?.name ?? ""}"
                        placeholder="${isMaintenance ? "Database upgrade" : "Messages failing to send"}"
                /></label>
                ${
                  isMaintenance
                    ? html`<div class="form-grid">
                              <label>Starts<input name="scheduled_for" type="datetime-local" required value="${toLocalInput(existing?.scheduled_for)}" /></label>
                              <label>Ends<input name="scheduled_until" type="datetime-local" required value="${toLocalInput(existing?.scheduled_until)}" /></label>
                          </div>`
                    : html`<label
                              >Impact<select name="impact">
                                  ${options(IMPACTS, existing?.impact ?? "minor")}
                              </select></label
                          >`
                }
                ${
                  !editing
                    ? html`<label
                                  >Status<select name="status">
                                      ${options(isMaintenance ? MAINTENANCE_STATES.filter(([k]) => k !== "completed") : INCIDENT_STATES.filter(([k]) => k !== "resolved"), isMaintenance ? "scheduled" : "investigating")}
                                  </select></label
                              >
                              <label
                                  >Message<span class="hint">The first entry in the public timeline.</span
                                  ><textarea name="body" required placeholder="${isMaintenance ? "We'll be upgrading…" : "We're looking into reports of…"}"></textarea>
                              </label>`
                    : ""
                }
                <div class="stack">
                    <h3>Affected components</h3>
                    ${
                      components.length
                        ? html`<div class="checks">
                                  ${components.map(
                                    (c) =>
                                      html`<label class="toggle"
                                              ><input
                                                  type="checkbox"
                                                  name="component"
                                                  value="${c.id}"
                                                  ${existing?.components.some((x) => x.id === c.id) ? raw("checked") : ""}
                                              /><span>${c.name}</span></label
                                          >`,
                                  )}
                              </div>`
                        : html`
                            <p class="muted">No components yet. Add some on the status page tab.</p>
                          `
                    }
                    ${
                      !editing && !isMaintenance && components.length
                        ? html`<label
                                  >Set affected components to<select name="component_status">
                                      ${options(
                                        COMPONENT_STATUSES.filter(
                                          ([k]) => k !== "operational" && k !== "under_maintenance",
                                        ),
                                        "partial_outage",
                                      )}
                                  </select></label
                              >`
                        : ""
                    }
                    ${
                      isMaintenance && !editing
                        ? html`
                            <p class="muted">
                              Components switch to "Under maintenance" when you mark the maintenance in progress.
                            </p>
                          `
                        : ""
                    }
                </div>
                <div class="form-actions"><button class="btn primary" type="submit">${editing ? "Save changes" : isMaintenance ? "Schedule" : "Publish incident"}</button></div>
            </form>
        `,
  );
  if (!body) return;

  $("#incident-form", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const component_ids = $$("input[name=component]:checked", f).map((x) => x.value);
    const payload = { name: f.name.value, component_ids };
    if (isMaintenance) {
      payload.scheduled_for = fromLocalInput(f.scheduled_for.value);
      payload.scheduled_until = fromLocalInput(f.scheduled_until.value);
      if (new Date(payload.scheduled_until) <= new Date(payload.scheduled_for))
        return toast("The maintenance has to end after it starts.", "error");
    } else payload.impact = f.impact.value;

    let done;
    if (editing)
      done = await act(
        $("button[type=submit]", f),
        () => api(`/admin/status/incidents/${existing.id}`, { method: "PATCH", body: payload }),
        "Saved",
      );
    else {
      Object.assign(payload, {
        status: f.status.value,
        body: f.body.value,
        impact: isMaintenance ? "maintenance" : payload.impact,
      });
      if (f.component_status && component_ids.length)
        payload.component_status = f.component_status.value;
      done = await act(
        $("button[type=submit]", f),
        () => api("/admin/status/incidents", { method: "POST", body: payload }),
        isMaintenance ? "Maintenance scheduled" : "Incident published",
      );
    }
    if (done) {
      closeDrawer();
      refresh();
    }
  });
}

boot();

async function renderPerformance(view) {
  const data = await api("/admin/system/performance");
  const bytes = (n) => `${(Number(n) / 1048576).toFixed(1)} MB`;
  const ms = (n) => `${Number(n).toFixed(1)} ms`;
  mount(
    view,
    html` <div class="page-head">
                <div>
                    <h1>Performance</h1>
                    <p class="muted">${data.scope}. Sampled ${fmtDate(data.sampled_at)}.</p>
                </div>
                <button class="btn" id="performance-refresh" type="button">Refresh measurements</button>
            </div>
            <div class="stack">
                <div class="stats">
                    <div class="card stat">
                        <span class="muted">Requests</span>
                        <div class="value">${fmtNumber(data.requests)}</div>
                    </div>
                    <div class="card stat">
                        <span class="muted">Server errors</span>
                        <div class="value">${fmtNumber(data.errors)}</div>
                    </div>
                    <div class="card stat">
                        <span class="muted">Rate limited</span>
                        <div class="value">${fmtNumber(data.rate_limited)}</div>
                    </div>
                    <div class="card stat">
                        <span class="muted">Process memory</span>
                        <div class="value">${bytes(data.memory.rss)}</div>
                    </div>
                </div>
                <div class="card">
                    <h2>Runtime health</h2>
                    <div class="list">
                        ${item(
                          "Database",
                          data.database.connected
                            ? html`<span class="badge ok">Connected · ${ms(data.database.round_trip_ms)}</span>`
                            : html`
                                <span class="badge danger">Unavailable</span>
                              `,
                        )}
                        ${item("Node.js", data.node)}${item("Uptime", fmtDuration(data.uptime_seconds))}
                        ${item("Heap used / allocated", `${bytes(data.memory.heapUsed)} / ${bytes(data.memory.heapTotal)}`)}
                        ${item("Event loop delay, p95 / p99", `${ms(data.event_loop.p95_ms)} / ${ms(data.event_loop.p99_ms)}`)}
                        ${item("Maximum event loop delay", ms(data.event_loop.max_ms))}
                    </div>
                    <p class="muted">Event loop sampling uses a 20 ms interval. Timings include authentication and database work.</p>
                </div>
                <div class="card">
                    <h2>Slowest routes</h2>
                    <p class="muted">Average completed request time since startup. Use the load benchmark for p50, p95 and p99 under concurrency.</p>
                    <div class="table-wrap performance-routes">
                        <table>
                            <thead>
                                <tr>
                                    <th>Route</th>
                                    <th>Requests</th>
                                    <th>Mean</th>
                                    <th>Server errors</th>
                                    <th>Rate limited</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${data.routes.map(
                                  (row) =>
                                    html`<tr>
                                            <td>${row.method} ${row.path}</td>
                                            <td>${fmtNumber(row.requests)}</td>
                                            <td>${ms(row.mean_ms)}</td>
                                            <td>${fmtNumber(row.errors)}</td>
                                            <td>${fmtNumber(row.limited)}</td>
                                        </tr>`,
                                )}
                            </tbody>
                        </table>
                    </div>
                    ${
                      data.routes.length
                        ? ""
                        : html`
                            <p class="muted">No completed requests yet. Refresh after using the app.</p>
                          `
                    }
                </div>
            </div>`,
  );
  $("#performance-refresh", view).addEventListener("click", (e) =>
    act(e.currentTarget, () => renderPerformance(view)),
  );
}

function openAdminChannel(guildId, channel, channels) {
  const creating = !channel;
  channel ??= { name: "", type: 0, parent_id: null, rate_limit_per_user: 0, nsfw: false };
  const body = openDrawer(
    creating ? "Create channel" : `Edit ${channel.name}`,
    html`<form class="stack" id="admin-channel-form">
            ${
              creating
                ? html`<label
                              >Channel type<select name="type">
                                  ${options(
                                    [
                                      [0, "Text"],
                                      [2, "Voice"],
                                      [4, "Category"],
                                      [5, "Announcement"],
                                      [13, "Stage"],
                                      [15, "Forum"],
                                      [16, "Media"],
                                    ],
                                    0,
                                  )}
                              </select></label
                          >
                          <p class="muted">Announcement and stage channels require the corresponding server features.</p>`
                : ""
            }
            <label>Name<input name="name" value="${channel.name}" required maxlength="100" /></label>
            <label data-channel-topic>Topic<textarea name="topic" maxlength="4096">${channel.topic ?? ""}</textarea></label>
            <label
                >Category<select name="parent_id">
                    ${options([["", "No category"], ...channels.filter((item) => item.type === 4 && item.id !== channel.id).map((item) => [item.id, item.name])], channel.parent_id ?? "")}
                </select></label
            >
            <label data-channel-slowmode
                >Slowmode in seconds<input name="rate_limit_per_user" type="number" min="0" max="21600" step="1" value="${channel.rate_limit_per_user ?? 0}"
            /></label>
            ${
              creating
                ? html`
                    <div class="form-grid" data-channel-voice hidden>
                      <label
                        >Bitrate in bits per second<input
                          name="bitrate"
                          type="number"
                          min="8000"
                          max="384000"
                          step="1000"
                          value="64000" /></label
                      ><label
                        >Member limit<input name="user_limit" type="number" min="0" max="99" step="1" value="0" /><span
                          class="hint"
                          >Use 0 for no limit.</span
                        ></label
                      >
                    </div>
                  `
                : ""
            }
            <label class="toggle"><input name="nsfw" type="checkbox" ${channel.nsfw ? raw("checked") : ""} /><span>Age restricted channel</span></label>
            <div class="form-actions">
                <button class="btn primary" type="submit">${creating ? "Create channel" : "Save channel"}</button
                ><button class="btn" type="button" data-return-server>Back to server</button>
            </div>
        </form>`,
  );
  if (!body) return;
  $("[data-return-server]", body).addEventListener("click", () =>
    openGuild(guildId, undefined, true),
  );
  const form = $("form", body);
  const field = (name) => form.elements.namedItem(name);
  const updateType = () => {
    const type = creating ? Number(field("type").value) : channel.type;
    const voice = type === 2 || type === 13;
    $("[data-channel-topic]", body).hidden = voice || type === 4;
    $("[data-channel-slowmode]", body).hidden = voice || type === 4;
    field("parent_id").disabled = type === 4;
    if (type === 4) field("parent_id").value = "";
    const voiceFields = $("[data-channel-voice]", body);
    if (voiceFields) {
      voiceFields.hidden = !voice;
      for (const input of $$("input", voiceFields)) input.disabled = !voice;
    }
  };
  if (creating) field("type").addEventListener("change", updateType);
  updateType();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const type = creating ? Number(field("type").value) : channel.type;
    const voice = type === 2 || type === 13;
    const patch = {
      name: field("name").value,
      parent_id: field("parent_id").value || null,
      nsfw: field("nsfw").checked,
    };
    if (!voice && type !== 4)
      Object.assign(patch, {
        topic: field("topic").value || null,
        rate_limit_per_user: Number(field("rate_limit_per_user").value),
      });
    if (creating) {
      patch.type = type;
      if (voice)
        Object.assign(patch, {
          bitrate: Number(field("bitrate").value),
          user_limit: Number(field("user_limit").value),
        });
    }
    const path = `/admin/guilds/${guildId}/channels${creating ? "" : `/${channel.id}`}`;
    const result = await act(
      $("button[type=submit]", form),
      () => api(path, { method: creating ? "POST" : "PATCH", body: patch }),
      creating ? "Channel created" : "Channel saved",
    );
    if (result) openGuild(guildId, undefined, true);
  });
}

function openAdminRole(guildId, role, permissions) {
  const creating = !role;
  role ??= { name: "", color: 0, permissions: "0", hoist: false, mentionable: false };
  const body = openDrawer(
    creating ? "Create role" : `Edit ${role.name}`,
    html`<form class="stack" id="admin-role-form">
            <label>Name<input name="name" value="${role.name}" required maxlength="100" /></label>
            <label>Color<input name="color" type="color" value="${hexColor(role.color)}" /></label>
            <label class="toggle"><input name="hoist" type="checkbox" ${role.hoist ? raw("checked") : ""} /><span>Display members separately</span></label>
            <label class="toggle"><input name="mentionable" type="checkbox" ${role.mentionable ? raw("checked") : ""} /><span>Allow anyone to mention this role</span></label>
            <h3>Permissions</h3>
            <p class="muted">Administrator grants every server permission. ${creating ? "New roles start with no permissions." : "Existing unknown permissions are preserved."}</p>
            <div class="checks">
                ${permissions.map((permission) => html`<label class="toggle"><input type="checkbox" data-permission="${permission.value}" ${(BigInt(role.permissions) & BigInt(permission.value)) === BigInt(permission.value) ? raw("checked") : ""} /><span>${permission.name.toLowerCase().replaceAll("_", " ")}</span></label>`)}
            </div>
            <div class="form-actions">
                <button class="btn primary" type="submit">${creating ? "Create role" : "Save role"}</button
                ><button class="btn" type="button" data-return-server>Back to server</button>
            </div>
        </form>`,
  );
  if (!body) return;
  $("[data-return-server]", body).addEventListener("click", () =>
    openGuild(guildId, undefined, true),
  );
  $("form", body).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    let bits = BigInt(role.permissions);
    for (const checkbox of $$("[data-permission]", form)) {
      const bit = BigInt(checkbox.dataset.permission);
      bits = checkbox.checked ? bits | bit : bits & ~bit;
    }
    const patch = {
      name: form.name.value,
      color: parseInt(form.color.value.slice(1), 16),
      hoist: form.hoist.checked,
      mentionable: form.mentionable.checked,
      permissions: bits.toString(),
    };
    const path = `/admin/guilds/${guildId}/roles${creating ? "" : `/${role.id}`}`;
    const result = await act(
      $("button[type=submit]", form),
      () => api(path, { method: creating ? "POST" : "PATCH", body: patch }),
      creating ? "Role created" : "Role saved",
    );
    if (result) openGuild(guildId, undefined, true);
  });
}

async function renderOfficialInbox(view) {
  const initial = location.hash.split("/")[2] || "";
  mount(
    view,
    html`
      <div class="page-head">
        <h1>Official inbox</h1>
        <p class="muted">Messages to and from the Official account.</p>
      </div>
      <div class="official-layout">
        <aside class="card official-sidebar" aria-label="Users">
          <label
            >Search users<input
              id="official-search"
              type="search"
              maxlength="100"
              placeholder="Name or username"
          /></label>
          <div class="row">
            <span class="muted grow">Support conversations first</span
            ><button class="btn small" id="official-users-refresh" type="button">Refresh users</button>
          </div>
          <div id="official-users" class="official-users" aria-label="Choose a user"></div>
          <p id="official-users-status" class="muted" role="status"></p>
          <button id="official-users-more" class="btn" type="button" hidden>Load more users</button>
        </aside>
        <div id="official-conversation">
          <section class="card">
            <p class="muted">Select a user to read or start a conversation.</p>
          </section>
        </div>
      </div>
    `,
  );
  let generation = 0;
  let request;
  let selectedId = initial;
  let directoryGeneration = 0;
  let directoryRequest;
  let directory = [];
  let directoryOffset = 0;
  const panel = $("#official-conversation", view);
  const list = $("#official-users", view);
  const search = $("#official-search", view);
  const more = $("#official-users-more", view);
  const directoryStatus = $("#official-users-status", view);
  const selection = () => {
    for (const button of $$("[data-official-user]", list))
      button.setAttribute("aria-pressed", String(button.dataset.officialUser === selectedId));
  };
  function drawDirectory() {
    mount(
      list,
      directory.map(
        (
          user,
        ) => html`<button type="button" class="official-user" data-official-user="${user.id}" aria-pressed="${user.id === selectedId}">
            ${avatar(user)}<span class="official-user-label"><strong>${userName(user)}</strong><span>${userTag(user)}</span>
            ${user.has_replied ? html`<span class="official-user-support">Contacted support · ${fmtDate(user.last_incoming_at)}</span>` : html`<span class="muted">${user.channel_id ? "Official conversation" : "Start conversation"}</span>`}</span></button>`,
      ),
    );
    for (const button of $$("[data-official-user]", list))
      button.addEventListener("click", () => {
        if (button.dataset.officialUser === selectedId) return;
        if ($("form[data-dirty]", panel) && !confirm("Discard your unsent message?")) return;
        open(button.dataset.officialUser);
      });
  }
  async function loadDirectory(reset = true) {
    const current = ++directoryGeneration;
    directoryRequest?.abort();
    directoryRequest = new AbortController();
    more.disabled = true;
    directoryStatus.textContent = "Loading users…";
    try {
      const data = await api(
        `/admin/conversations?q=${encodeURIComponent(search.value.trim())}&offset=${reset ? 0 : directoryOffset}`,
        { signal: directoryRequest.signal },
      );
      if (!view.isConnected || current !== directoryGeneration) return;
      const previous = reset ? [] : directory;
      const known = new Set(previous.map((user) => user.id));
      directory = [...previous, ...data.users.filter((user) => !known.has(user.id))];
      directoryOffset = data.offset;
      more.hidden = !data.has_more;
      drawDirectory();
      directoryStatus.textContent = directory.length
        ? `${directory.length} users shown`
        : "No users found.";
      if (!selectedId && directory.length) open(directory[0].id);
    } catch (error) {
      if (!view.isConnected || current !== directoryGeneration || error.status === 499) return;
      directoryStatus.textContent = error.message;
    } finally {
      if (current === directoryGeneration) more.disabled = false;
    }
  }
  search.addEventListener(
    "input",
    debounce(() => loadDirectory(), 250),
  );
  more.addEventListener("click", () => loadDirectory(false));
  $("#official-users-refresh", view).addEventListener("click", () => loadDirectory());
  async function open(id, retainedDraft = "") {
    selectedId = id;
    selection();
    const current = ++generation;
    request?.abort();
    request = new AbortController();
    const previousSend = $("#official-send", panel);
    const draft =
      retainedDraft || (previousSend?.dataset.userId === id ? previousSend.content.value : "");
    mount(
      panel,
      html`
        <p role="status">Loading conversation…</p>
      `,
    );
    let data;
    try {
      data = await api(`/admin/conversations/${encodeURIComponent(id)}`, {
        signal: request.signal,
      });
    } catch (error) {
      if (!view.isConnected || current !== generation || error.status === 499) return;
      mount(
        panel,
        html`<section class="card stack"><p class="form-error" role="alert">${error.message}</p>
                ${draft ? html`<form class="stack" data-dirty="true"><label>Unsent message<textarea rows="4" readonly>${draft}</textarea></label></form><p class="muted">Your draft is kept. Retry to continue editing.</p>` : ""}
                <button class="btn" id="official-retry" type="button">Retry loading conversation</button></section>`,
      );
      $("#official-retry", panel).addEventListener("click", () => open(id, draft));
      return;
    }
    if (!view.isConnected || current !== generation) return;
    mount(
      panel,
      html`<section class="card stack"><div class="row"><h2 class="grow">${userName(data.user)}</h2><button class="btn" id="official-refresh" type="button">Refresh</button></div>
            <button class="btn" id="official-older" type="button" ${data.has_more ? "" : raw("hidden")}>Load older messages</button>
            <div id="official-history" class="stack" aria-label="Conversation history"></div>
            <p id="official-status" class="muted" role="status"></p>
            <form id="official-send" class="stack" data-user-id="${id}"><label>Message<textarea name="content" rows="4" maxlength="${data.max_characters}" required></textarea></label><button class="btn primary" type="submit">Send as Official</button></form></section>`,
    );
    let messages = data.messages;
    let before = data.before;
    const older = $("#official-older", panel);
    const history = $("#official-history", panel);
    function draw() {
      mount(
        history,
        messages.length
          ? messages.map(
              (message) =>
                html`<article class="official-message"><div class="row"><strong class="grow">${message.author_id === data.official.id ? "Official" : userName(data.user)}</strong><time datetime="${message.timestamp}">${fmtDate(message.timestamp)}</time></div><p>${message.readable ? message.content : "This encrypted message could not be opened."}</p>${message.attachments.map((file) => html`<span class="muted">Attachment: ${file.filename}</span>`)}</article>`,
            )
          : html`
              <p class="muted">No messages yet.</p>
            `,
      );
    }
    draw();
    older.addEventListener("click", () =>
      act(older, async () => {
        const page = await api(
          `/admin/conversations/${encodeURIComponent(id)}?before=${encodeURIComponent(before)}`,
          { signal: request.signal },
        );
        if (!view.isConnected || current !== generation) return;
        messages = [...page.messages, ...messages];
        before = page.before;
        older.hidden = !page.has_more;
        draw();
      }),
    );
    const send = $("#official-send", panel);
    if (retainedDraft) {
      send.content.value = retainedDraft;
      send.dataset.dirty = "true";
    }
    $("#official-refresh", panel).addEventListener("click", () => {
      if (send.content.value && !confirm("Discard your unsent message and refresh?")) return;
      open(id);
    });
    send.addEventListener("input", () => {
      send.dataset.dirty = "true";
    });
    send.addEventListener("submit", async (event) => {
      event.preventDefault();
      const content = send.content.value.trim();
      if (!content) return;
      const result = await act($("button", send), () =>
        api(`/admin/conversations/${encodeURIComponent(id)}`, {
          method: "POST",
          body: { content },
        }),
      );
      if (!result || !view.isConnected || current !== generation) return;
      delete send.dataset.dirty;
      send.reset();
      await open(id);
    });
  }
  await loadDirectory();
  if (/^\d{1,20}$/.test(initial)) await open(initial);
}
