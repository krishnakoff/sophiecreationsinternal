// "Keep me signed in" support: the session token itself is routed to localStorage (persists
// across browser restarts) or sessionStorage (cleared when the browser/tab closes) depending
// on the checkbox at the moment of sign-in. The preference flag is always kept in localStorage
// (it's not sensitive) so the checkbox reflects the last choice on the next visit.
const KEEP_SIGNED_IN_KEY = "sophie_keep_signed_in";
function keepSignedInPreferred() { return localStorage.getItem(KEEP_SIGNED_IN_KEY) !== "false"; }
function authStorage() { return keepSignedInPreferred() ? localStorage : sessionStorage; }
const customAuthStorage = {
  getItem: key => authStorage().getItem(key),
  setItem: (key, value) => authStorage().setItem(key, value),
  removeItem: key => authStorage().removeItem(key)
};

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: customAuthStorage, persistSession: true, autoRefreshToken: true }
});

const OWNERS = [
  { id: "87133383-89c3-468e-96b5-1cce2455edc7", name: "Krishna" },
  { id: "cd66a924-67ec-4ecf-90a9-54edc57d3966", name: "Sanjay" }
];
function ownerName(id) { return (OWNERS.find(o => o.id === id) || {}).name || "Unknown"; }
function isOwnData() { return viewingOwnerId === session.user.id; }

let session = null;
let leads = [];
let outlineNodes = [];
let outlineCompletedCollapsed = true;
let dailyMusts = [];
let realtimeReady = false;
let viewingOwnerId = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Hong Kong is the fixed reset boundary for the daily "5 calls/emails" habit, regardless of
// whichever timezone Krishna or Sanjay happen to be in when they open the app.
function hkDateToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

// ---------- auth ----------
async function initAuth() {
  const { data: { session: s } } = await sb.auth.getSession();
  session = s;
  renderShell();
  sb.auth.onAuthStateChange((_event, s2) => { session = s2; renderShell(); });
}

document.getElementById("keep-signed-in").checked = keepSignedInPreferred();

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const keepSignedIn = document.getElementById("keep-signed-in").checked;
  localStorage.setItem(KEEP_SIGNED_IN_KEY, keepSignedIn ? "true" : "false");
  const errBox = document.getElementById("login-error");
  errBox.hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { errBox.textContent = error.message; errBox.hidden = false; }
});

document.getElementById("signout").addEventListener("click", async () => {
  viewingOwnerId = null;
  await sb.auth.signOut();
});

function renderShell() {
  const loginScreen = document.getElementById("login-screen");
  const app = document.getElementById("app");
  if (session) {
    loginScreen.hidden = true;
    app.hidden = false;
    if (!viewingOwnerId) viewingOwnerId = session.user.id;
    renderOwnerSwitch();
    loadAll();
  } else {
    loginScreen.hidden = false;
    app.hidden = true;
  }
}

// ---------- owner switch ----------
function renderOwnerSwitch() {
  const wrap = document.getElementById("owner-switch");
  wrap.innerHTML = OWNERS.map(o => `
    <button type="button" data-owner-id="${o.id}" class="${o.id === viewingOwnerId ? "active" : ""}">${o.name}</button>
  `).join("");
  wrap.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      viewingOwnerId = btn.dataset.ownerId;
      renderOwnerSwitch();
      loadAll();
    });
  });

  const banner = document.getElementById("readonly-banner");
  if (isOwnData()) {
    banner.hidden = true;
  } else {
    document.getElementById("readonly-name").textContent = ownerName(viewingOwnerId);
    banner.hidden = false;
  }
}

// ---------- nav ----------
// Remembers the last open tab in localStorage so a refresh lands back where you were, instead of
// always resetting to the CRM tab (which is only the default for a brand new, never-visited session).
const LAST_TAB_KEY = "sophie_last_tab";
function switchTab(target) {
  document.querySelectorAll("nav.tabs button").forEach(b => b.classList.toggle("active", b.dataset.target === target));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + target));
  localStorage.setItem(LAST_TAB_KEY, target);
}
document.querySelectorAll("nav.tabs button").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.target));
});
const lastTab = localStorage.getItem(LAST_TAB_KEY);
if (lastTab && document.getElementById("view-" + lastTab)) switchTab(lastTab);

// ---------- data + realtime ----------
async function loadAll() {
  await Promise.all([loadLeads(), loadOutline(), loadOutboundStats(), loadMusts()]);
  subscribeRealtime();
}

function subscribeRealtime() {
  if (realtimeReady) return;
  realtimeReady = true;
  sb.channel("public:leads")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, loadLeads)
    .subscribe();
  sb.channel("public:todo_outline")
    .on("postgres_changes", { event: "*", schema: "public", table: "todo_outline" }, () => {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains("outline-editable")) return; // don't yank focus mid-edit
      loadOutline();
    })
    .subscribe();
  sb.channel("public:outbound_emails")
    .on("postgres_changes", { event: "*", schema: "public", table: "outbound_emails" }, loadOutboundStats)
    .subscribe();
  sb.channel("public:daily_musts")
    .on("postgres_changes", { event: "*", schema: "public", table: "daily_musts" }, () => {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains("must-content")) return; // don't yank focus mid-edit
      loadMusts();
    })
    .subscribe();
}

async function loadLeads() {
  const { data, error } = await sb.from("leads").select("*").eq("owner_id", viewingOwnerId).order("created_at");
  if (!error) { leads = data || []; renderCrm(); }
  else console.error("loadLeads:", error.message);
}

async function loadOutline() {
  const { data, error } = await sb.from("todo_outline").select("*").eq("owner_id", viewingOwnerId).order("position");
  if (!error) { outlineNodes = data || []; renderTodo(); }
  else console.error("loadOutline:", error.message);
}

async function loadMusts() {
  const { data, error } = await sb.from("daily_musts").select("*").eq("owner_id", viewingOwnerId).order("slot");
  if (error) { console.error("loadMusts:", error.message); return; }
  dailyMusts = data || [];

  // Slot 1 (the fixed daily habit) unchecks itself once a new Hong Kong day has started.
  // Only the owner's own session can write that reset back (RLS), so a cross-view of a stale
  // slot 1 still displays as unchecked, it just won't be persisted until that owner loads it.
  const today = hkDateToday();
  const slot1 = dailyMusts.find(m => m.slot === 1);
  if (slot1 && slot1.done && slot1.reset_date !== today) {
    slot1.done = false;
    if (isOwnData()) {
      sb.from("daily_musts").update({ done: false, reset_date: today }).eq("id", slot1.id)
        .then(({ error }) => { if (error) console.error("loadMusts reset:", error.message); });
    }
  }

  renderMusts();
}

// ---------- CRM ----------
const SEQUENCE_OFFSETS = [0, 4, 7, 10];
const SEQUENCE_TYPES = ["email", "call", "email", "call"];
const STAGES = [
  { id: "prospect", label: "Prospect" },
  { id: "contacted", label: "Contacted" },
  { id: "conversation", label: "In conversation" },
  { id: "sampling", label: "Sampling" },
  { id: "client", label: "Client" },
  { id: "revive", label: "Revive" },
  { id: "dead", label: "Dead" }
];
let crmStageFilter = null;

function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtDate(date) { return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
function isoDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function daysDiff(a, b) { return Math.round((isoDay(a) - isoDay(b)) / 86400000); }
function startOfWeek(date) { const d = isoDay(date); const dow = (d.getDay() + 6) % 7; return addDays(d, -dow); }

function computeNextAction(lead, today) {
  if (lead.stage === "contacted") {
    const step = lead.steps_completed || 0;
    if (step >= 4) return { exhausted: true };
    if (!lead.contacted_at) return null;
    return { date: addDays(parseDate(lead.contacted_at), SEQUENCE_OFFSETS[step]), type: SEQUENCE_TYPES[step] };
  }
  if (["conversation", "sampling", "revive"].includes(lead.stage) && lead.next_action_date) {
    return { date: parseDate(lead.next_action_date), type: lead.next_action_type || "email" };
  }
  return null;
}

function stagePill(lead) {
  const label = (STAGES.find(s => s.id === lead.stage) || {}).label || lead.stage;
  return `<span class="pill pill-${lead.stage}">${escapeHtml(label)}</span>`;
}

function actionCell(lead, next, today) {
  if (!next) return '<span class="muted">&mdash;</span>';
  if (next.exhausted) return '<span class="pill pill-flag">Sequence done</span>';
  const diff = daysDiff(next.date, today);
  let cls = "", label = fmtDate(next.date);
  if (diff < 0) { cls = "overdue"; label = fmtDate(next.date) + " (" + Math.abs(diff) + "d overdue)"; }
  else if (diff === 0) { cls = "today"; label = "Today"; }
  return '<span class="next-action ' + cls + '">' + label + ' <span class="type">&middot; ' + next.type + '</span></span>';
}

function rankLead(lead, next, today) {
  const stillPursuing = !["client", "dead"].includes(lead.stage);
  const priorityBit = (lead.priority && stillPursuing) ? 0 : 1;

  let stageRank, dateRank = 0;
  if (lead.stage === "contacted") {
    if (next && !next.exhausted) {
      const diff = daysDiff(next.date, today);
      if (diff < 0) { stageRank = 0; dateRank = diff; }        // overdue, most overdue first
      else if (diff === 0) { stageRank = 1; }                   // due today
      else { stageRank = 2; dateRank = diff; }                  // upcoming, soonest first
    } else {
      stageRank = 3; // sequence exhausted, no reply yet — needs a manual follow-up
    }
  } else if (lead.stage === "conversation") stageRank = 4;
  else if (lead.stage === "sampling") stageRank = 5;
  else if (lead.stage === "revive") stageRank = 6; // gone quiet, but still worth pushing
  else if (lead.stage === "prospect") stageRank = 7;
  else if (lead.stage === "client") stageRank = 8;
  else stageRank = 9; // dead

  return [priorityBit, stageRank, dateRank];
}

async function loadOutboundStats() {
  const weekStart = startOfWeek(new Date());
  const [emailRes, callRes] = await Promise.all([
    sb.from("outbound_emails").select("owner_id").gte("sent_at", weekStart.toISOString()),
    sb.from("leads").select("owner_id").gte("called_at", weekStart.toISOString().slice(0, 10))
  ]);
  if (emailRes.error) { console.error("loadOutboundStats (emails):", emailRes.error.message); return; }
  if (callRes.error) { console.error("loadOutboundStats (calls):", callRes.error.message); return; }

  const emailCounts = {}, callCounts = {};
  OWNERS.forEach(o => { emailCounts[o.id] = 0; callCounts[o.id] = 0; });
  (emailRes.data || []).forEach(row => { if (row.owner_id in emailCounts) emailCounts[row.owner_id]++; });
  (callRes.data || []).forEach(row => { if (row.owner_id in callCounts) callCounts[row.owner_id]++; });

  document.getElementById("outbound-stats").innerHTML = `
    <span class="outbound-label">Outbound email this week</span>
    ${OWNERS.map(o => `<span class="outbound-count"><strong>${emailCounts[o.id]}</strong> ${escapeHtml(o.name)}</span>`).join("")}
    <span class="outbound-label">Outbound calls this week</span>
    ${OWNERS.map(o => `<span class="outbound-count"><strong>${callCounts[o.id]}</strong> ${escapeHtml(o.name)}</span>`).join("")}
  `;
}

function renderCrm() {
  const today = new Date();
  const enriched = leads.map(l => { const next = computeNextAction(l, today); return { lead: l, next, rank: rankLead(l, next, today) }; });
  enriched.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);

  const total = leads.length;
  const counts = {};
  STAGES.forEach(s => counts[s.id] = 0);
  leads.forEach(l => { if (l.stage in counts) counts[l.stage]++; });

  document.getElementById("crm-subtitle").textContent =
    ownerName(viewingOwnerId) + "'s top-line summary as of " + today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  const cardSpecs = [
    { stage: null, num: total, label: "Total leads", cls: "" },
    { stage: "prospect", num: counts.prospect, label: "Prospects", cls: "" },
    { stage: "contacted", num: counts.contacted, label: "Contacted", cls: "c-sapphire" },
    { stage: "conversation", num: counts.conversation, label: "In conversation", cls: "c-accent" },
    { stage: "sampling", num: counts.sampling, label: "Sampling", cls: "c-garnet" },
    { stage: "client", num: counts.client, label: "Clients", cls: "c-emerald" },
    { stage: "revive", num: counts.revive, label: "Revive", cls: "c-amber" },
    { stage: "dead", num: counts.dead, label: "Dead", cls: "" }
  ];
  document.getElementById("cards").innerHTML = cardSpecs.map(c => `
    <div class="card ${c.cls} ${crmStageFilter === c.stage ? "card-active" : ""}" data-stage="${c.stage ?? ""}">
      <div class="num">${c.num}</div><div class="label">${c.label}</div>
    </div>
  `).join("");
  document.querySelectorAll("#cards .card").forEach(card => {
    card.addEventListener("click", () => {
      const stage = card.dataset.stage || null;
      crmStageFilter = crmStageFilter === stage ? null : stage;
      renderCrm();
    });
  });

  const wrap = document.getElementById("crm-table-wrap");
  if (total === 0) {
    wrap.innerHTML = '<div class="empty-state">No leads yet.</div>';
    return;
  }
  const visible = crmStageFilter ? enriched.filter(e => e.lead.stage === crmStageFilter) : enriched;
  if (!visible.length) {
    wrap.innerHTML = `<div class="empty-state">No leads in this stage. <button type="button" id="clear-stage-filter" class="add-item-btn">Clear filter</button></div>`;
    document.getElementById("clear-stage-filter").addEventListener("click", () => { crmStageFilter = null; renderCrm(); });
    return;
  }
  const yn = v => v ? '<span class="yn yes">&#10003;</span>' : '<span class="yn no">&mdash;</span>';
  const rows = visible.map(({ lead, next }) => `
    <tr class="${lead.priority ? "priority-row" : ""}">
      <td class="company">${lead.priority ? '<span class="star" title="Priority">&#9733;</span>' : ""}${escapeHtml(lead.company)}</td>
      <td class="muted">${escapeHtml(lead.country)}</td>
      <td>${escapeHtml(lead.contact)}</td>
      <td class="muted">${escapeHtml(lead.email)}</td>
      <td>${escapeHtml(lead.product)}</td>
      <td class="muted">${escapeHtml(lead.lead_owner)}</td>
      <td>${stagePill(lead)}</td>
      <td>${yn(lead.emailed)}</td>
      <td>${yn(lead.called)}</td>
      <td class="muted">${escapeHtml(lead.call_response) || '<span class="muted">&mdash;</span>'}</td>
      <td>${actionCell(lead, next, today)}</td>
      <td class="notes-cell">${escapeHtml(lead.stage === "dead" && lead.lost_reason ? lead.lost_reason : lead.notes)}</td>
    </tr>
  `).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>Company</th><th>Country</th><th>Contact</th><th>Email</th><th>Product</th><th>Lead Owner</th><th>Stage</th><th>Emailed</th><th>Called</th><th>Call response</th><th>Next action</th><th>Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  `;
}

// ---------- To-Do (shared outline format for every account) ----------
function renderTodo() {
  renderOutline();
}

// ---------- 3 Musts Today ----------
const MUST_1_LABEL = "Make 5 cold calls or send 5 cold emails";

function renderMusts() {
  const own = isOwnData();
  const visible = dailyMusts
    .filter(m => !m.done)
    .filter(m => own || m.slot === 1 || m.content.trim()) // don't show empty, uneditable slots on a read-only view
    .sort((a, b) => a.slot - b.slot);

  const rows = visible.map(m => {
    const isFixed = m.slot === 1;
    const editable = own && !isFixed;
    const placeholder = !isFixed ? ' data-placeholder="+ Add a focus for today"' : "";
    const content = isFixed ? MUST_1_LABEL : escapeHtml(m.content);
    return `
      <div class="must-row">
        <span class="checkbox${own ? "" : " disabled"}" data-action="must-toggle" data-slot="${m.slot}">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
        </span>
        <div class="must-content" contenteditable="${editable}" data-slot="${m.slot}"${placeholder}>${content}</div>
      </div>
    `;
  }).join("");

  document.getElementById("musts-wrap").innerHTML = `
    <div class="musts-card">
      <div class="musts-heading">3 Musts Today</div>
      ${rows || '<div class="musts-empty">All clear for today.</div>'}
    </div>
  `;

  document.querySelectorAll('#musts-wrap .checkbox[data-action="must-toggle"]:not(.disabled)').forEach(cb => {
    cb.addEventListener("click", e => {
      e.stopPropagation();
      toggleMust(Number(cb.dataset.slot));
    });
  });

  document.querySelectorAll('#musts-wrap .must-content[contenteditable="true"]').forEach(el => {
    el.addEventListener("click", e => e.stopPropagation());
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
    el.addEventListener("blur", () => saveMustContent(Number(el.dataset.slot), el.innerText.trim()));
  });
}

async function toggleMust(slot) {
  const m = dailyMusts.find(x => x.slot === slot);
  if (!m) return;

  if (slot === 1) {
    m.done = true;
    m.reset_date = hkDateToday();
    renderMusts();
    const { error } = await sb.from("daily_musts").update({ done: true, reset_date: m.reset_date }).eq("id", m.id);
    if (error) console.error("toggleMust:", error.message);
  } else {
    // Slots 2/3 aren't archived either — "done" just clears the slot, ready for the next thing.
    m.content = "";
    m.done = false;
    renderMusts();
    const { error } = await sb.from("daily_musts").update({ content: "", done: false }).eq("id", m.id);
    if (error) console.error("toggleMust:", error.message);
  }
}

async function saveMustContent(slot, text) {
  const m = dailyMusts.find(x => x.slot === slot);
  if (!m || text === m.content) return;
  m.content = text;
  const { error } = await sb.from("daily_musts").update({ content: text }).eq("id", m.id);
  if (error) console.error("saveMustContent:", error.message);
}

function parseBold(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function serializeOutlineEditable(el) {
  let html = el.innerHTML.replace(/<(b|strong)>(.*?)<\/(b|strong)>/gi, "**$2**");
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || "").replace(/ /g, " ").trim();
}

function placeCaretAtStart(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtOffset(el, offset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node, remaining = offset;
  while ((node = walker.nextNode())) {
    if (remaining <= node.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= node.length;
  }
  placeCaretAtEnd(el);
}

function isCaretAtStart(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const testRange = document.createRange();
  testRange.selectNodeContents(el);
  testRange.setEnd(range.startContainer, range.startOffset);
  return testRange.toString().length === 0;
}

function splitContentAtCaret(el) {
  const sel = window.getSelection();
  const range = sel.getRangeAt(0);
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(el);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(el);
  afterRange.setStart(range.startContainer, range.startOffset);

  const beforeDiv = document.createElement("div");
  beforeDiv.appendChild(beforeRange.cloneContents());
  const afterDiv = document.createElement("div");
  afterDiv.appendChild(afterRange.cloneContents());

  return { before: serializeOutlineEditable(beforeDiv), after: serializeOutlineEditable(afterDiv) };
}

// Cross-line Up/Down navigation: each line is its own contenteditable, so the browser's
// default arrow-key handling can't cross between them on its own. These check whether the
// caret is on the visual first/last line of the CURRENT field (not just "is it multi-line") so
// arrowing within a wrapped paragraph still works normally, and only jump fields at the edge.
function getCaretClientRect(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  return rects.length ? rects[0] : null;
}

function caretOnLastLine(el) {
  const rect = getCaretClientRect(el);
  if (!rect) return true;
  const elRect = el.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || rect.height || 18;
  return elRect.bottom - rect.bottom < lineHeight * 0.6;
}

function caretOnFirstLine(el) {
  const rect = getCaretClientRect(el);
  if (!rect) return true;
  const elRect = el.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || rect.height || 18;
  return rect.top - elRect.top < lineHeight * 0.6;
}

function placeCaretNear(el, x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (range && el.contains(range.startContainer)) {
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    placeCaretAtStart(el);
  }
}

function navigableOutlineFields() {
  return Array.from(document.querySelectorAll('#todo-wrap .outline-content'));
}

// The whole outline is one shared contenteditable region (see renderOutline), so the ancestor
// stays focused throughout — moving the caret between rows only needs a Range/Selection change,
// never re-focusing an individual row (they aren't separately focusable elements any more).
function outlineArrowKey(e, el) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rect = getCaretClientRect(el);
  const x = rect ? rect.left : el.getBoundingClientRect().left + 4;
  const fields = navigableOutlineFields();
  const idx = fields.indexOf(el);

  if (e.key === "ArrowDown" && caretOnLastLine(el)) {
    const next = fields[idx + 1];
    if (next) {
      e.preventDefault();
      const targetRect = next.getBoundingClientRect();
      placeCaretNear(next, x, targetRect.top + 2);
    }
  } else if (e.key === "ArrowUp" && caretOnFirstLine(el)) {
    const prev = fields[idx - 1];
    if (prev) {
      e.preventDefault();
      const targetRect = prev.getBoundingClientRect();
      placeCaretNear(prev, x, targetRect.bottom - 2);
    }
  }
}

function buildOutlineTree(nodes) {
  const byId = {};
  nodes.forEach(n => { byId[n.id] = Object.assign({}, n, { children: [] }); });
  const roots = [];
  nodes.forEach(n => {
    if (n.parent_id && byId[n.parent_id]) byId[n.parent_id].children.push(byId[n.id]);
    else roots.push(byId[n.id]);
  });
  (function sortRec(list) { list.sort((a, b) => a.position - b.position); list.forEach(c => sortRec(c.children)); })(roots);
  return roots;
}

function defaultChildStyle(node) {
  if (node.children.length) return node.children[0].list_style;
  if (node.list_style === "numbered" || node.list_style === "dashed") return node.list_style;
  return "dashed";
}

// Every Supabase round-trip in this environment costs ~1s, so these mutations update local
// state and re-render immediately (optimistic), firing the actual write in the background.
// The realtime subscription still reconciles with the server afterward (harmless no-op re-render
// when it's just confirming our own write, essential when the change came from elsewhere).
//
// New nodes get a temp- id immediately (so they're focusable/typeable at once) and get relabeled
// to their real uuid in place once the insert resolves, with no re-render (so an in-progress edit
// is never disturbed). Anything that needs to write to a node by id — including a second Enter
// fired before the first node's insert has confirmed, or a debounced content save that fires long
// after — awaits `resolveOutlineId` first so it never sends a temp- id to the database.
// pendingOutlineIds[tempId] holds the in-flight insert Promise while it's pending, then the
// resolved real id itself afterward (not deleted) — a debounced save can look up a temp id well
// after its insert already resolved, and `await` on a plain string just yields that string back.
const pendingOutlineIds = {};
async function resolveOutlineId(id) {
  if (!id || !id.startsWith("temp-")) return id;
  const pending = pendingOutlineIds[id];
  return pending ? (await pending) || id : id;
}

// A node's own `.id` field gets overwritten to its real uuid the moment an insert resolves (see
// insertOptimisticOutlineNode), so looking it up by a temp id that's already resolved would find
// nothing — check the temp id first (covers the still-in-flight case) and fall back to whatever
// it resolved to (covers the case where the insert beat this call, e.g. a debounced content save
// firing well after a fast insert).
function findOutlineNodeByAnyId(id) {
  return outlineNodes.find(n => n.id === id) || outlineNodes.find(n => n.id === pendingOutlineIds[id]);
}

async function toggleOutlineDone(id, done) {
  const node = findOutlineNodeByAnyId(id);
  if (node) { node.done = done; renderTodo(); }
  const realId = await resolveOutlineId(id);
  const { error } = await sb.from("todo_outline").update({ done }).eq("id", realId);
  if (error) console.error("toggleOutlineDone:", error.message);
}

// A row's own content should only ever hold plain text plus inline <strong> spans (from
// **bold**) or a lone placeholder <br> — that's all our own rendering and editing code ever
// produces. Block-level markup (ol/ul/li/div/p/table) has no business being in there; its
// presence means rich HTML got into the DOM some other way (e.g. a native paste that wasn't
// actually intercepted) rather than through any controlled path. Flattening a whole foreign
// subtree like that into one string is exactly how a good-looking paste turns into a mangled
// blob after the next reload — so decline the save outright rather than risk it, even though
// the paste handler below is now supposed to make this unreachable.
function hasUnexpectedBlockMarkup(el) {
  return !!el.querySelector("ol, ul, li, div, p, table, tr, td, h1, h2, h3, h4, h5, h6");
}

async function saveOutlineContent(id, el) {
  if (hasUnexpectedBlockMarkup(el)) {
    console.error("saveOutlineContent: unexpected block-level markup in row, declining to save", el.innerHTML.slice(0, 200));
    return;
  }
  const content = serializeOutlineEditable(el);
  const node = findOutlineNodeByAnyId(id);
  if (node) node.content = content;
  const realId = await resolveOutlineId(id);
  const { error } = await sb.from("todo_outline").update({ content }).eq("id", realId);
  if (error) console.error("saveOutlineContent:", error.message);
}

// The whole outline is one shared contenteditable region (see renderOutline) rather than one
// field per row, so plain typing no longer fires a per-row blur to save on — instead every
// keystroke schedules a debounced save for whichever row the caret is currently in, and anything
// that mutates a row directly (split, merge, multi-row replace) cancels that row's pending timer
// first so a stale debounce can never fire afterward and clobber the fresh content with an old
// captured snapshot of the DOM node.
const saveDebounceTimers = {};
function cancelPendingSave(id) {
  if (saveDebounceTimers[id]) { clearTimeout(saveDebounceTimers[id]); delete saveDebounceTimers[id]; }
}
function scheduleOutlineSave(id, el) {
  cancelPendingSave(id);
  saveDebounceTimers[id] = setTimeout(() => {
    delete saveDebounceTimers[id];
    if (!findOutlineNodeByAnyId(id)) return; // row was deleted before the debounce fired
    saveOutlineContent(id, el);
  }, 500);
}
function flushPendingSaves() {
  Object.keys(saveDebounceTimers).forEach(id => {
    clearTimeout(saveDebounceTimers[id]);
    delete saveDebounceTimers[id];
    const el = document.querySelector(`.outline-content[data-id="${id}"]`);
    if (el) saveOutlineContent(id, el);
  });
}

// Lightweight undo for the structural outline operations that bypass the browser's native undo
// entirely — Enter-split, Backspace-merge, and paste/Backspace/Delete over a multi-row selection
// all call preventDefault() and do their own DOM/data manipulation, so there's nothing in the
// browser's own undo history for Cmd+Z to revert. Plain typing is untouched by this: ordinary
// character input is never intercepted, so native undo already handles it on its own.
// Each entry is a full snapshot of outlineNodes taken right before one of those operations
// mutates anything; undoing restores it and reconciles the database against whatever the diff
// between "now" and "the snapshot" actually is (some rows re-inserted, some deleted, some just
// updated) rather than needing separate undo logic per operation type.
const outlineUndoStack = [];
const MAX_OUTLINE_UNDO = 20;
function pushOutlineUndoSnapshot() {
  outlineUndoStack.push(outlineNodes.map(n => ({ ...n })));
  if (outlineUndoStack.length > MAX_OUTLINE_UNDO) outlineUndoStack.shift();
}
async function undoLastOutlineChange() {
  const snapshot = outlineUndoStack.pop();
  if (!snapshot) return;
  const currentById = new Map(outlineNodes.map(n => [n.id, n]));
  const snapshotById = new Map(snapshot.map(n => [n.id, n]));
  const isReal = id => !id.startsWith("temp-");

  // A row created by the very operation being undone may still be temp- at this point (its
  // insert hasn't resolved yet) — that in-flight insert was never cancelled, so it's still going
  // to land in the database regardless of what happens to local state here. Skipping it (instead
  // of waiting for it to resolve and then deleting the real row) would leave it to write itself
  // in as an orphan no one's tracking anymore, the exact way undo could silently leave a ghost
  // duplicate behind. toInsert/toUpdate only ever touch rows that already existed before the
  // operation being undone, which by definition already had real ids — no such race there.
  const toDelete = outlineNodes.filter(n => !snapshotById.has(n.id));
  const toInsert = snapshot.filter(n => isReal(n.id) && !currentById.has(n.id));
  const toUpdate = snapshot.filter(n => {
    const cur = currentById.get(n.id);
    return cur && isReal(n.id) && (
      cur.content !== n.content || cur.done !== n.done || cur.position !== n.position ||
      cur.parent_id !== n.parent_id || cur.list_style !== n.list_style
    );
  });

  outlineNodes = snapshot.map(n => ({ ...n }));
  renderTodo();

  const ops = [];
  toDelete.forEach(n => ops.push(resolveOutlineId(n.id).then(realId => sb.from("todo_outline").delete().eq("id", realId))));
  toInsert.forEach(n => ops.push(sb.from("todo_outline").insert({
    id: n.id, owner_id: n.owner_id, parent_id: n.parent_id, position: n.position,
    list_style: n.list_style, content: n.content, done: n.done
  })));
  toUpdate.forEach(n => ops.push(sb.from("todo_outline").update({
    content: n.content, done: n.done, position: n.position, parent_id: n.parent_id, list_style: n.list_style
  }).eq("id", n.id)));
  const results = await Promise.all(ops);
  results.forEach(r => { if (r && r.error) console.error("undoLastOutlineChange:", r.error.message); });
}

// Focuses the shared editable ancestor (not the row itself — rows aren't separately focusable)
// then places the caret/selection inside the given row.
function focusOutlineAncestorOf(el) {
  const editable = el && el.closest(".outline-editable");
  if (editable) editable.focus();
}

function selectAllInOutlineNode(id) {
  const el = document.querySelector(`.outline-content[data-id="${id}"]`);
  if (!el) return;
  focusOutlineAncestorOf(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Finds the .outline-content row the caret is currently sitting in, if any.
function currentOutlineRow() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return node ? node.closest(".outline-content") : null;
}

// Resolves the current selection down to the .outline-content rows its start and end fall in,
// so a drag-selection spanning multiple rows can be reasoned about as a row range. Clones the
// range immediately rather than handing back the live Selection's own Range object — anything
// downstream that mutates the DOM (e.g. building the before/after clones below) has no business
// being able to shift boundary points out from under a range someone else is still holding.
function getSelectionRowSpan() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0).cloneRange();
  let startNode = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
  let endNode = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer;
  const startEl = startNode && startNode.closest(".outline-content");
  const endEl = endNode && endNode.closest(".outline-content");
  if (!startEl || !endEl) return null;
  return { range, startEl, endEl };
}

// Rich outline sources hand the browser real nested <ol>/<ul><li> markup in the clipboard's HTML
// flavor — that's the only place the actual structure lives; their plain-text flavor commonly
// bakes each item's own "1. "/"2. " marker in as literal characters with no indentation at all,
// so there's nothing for a tab-count heuristic to find. Parses that HTML into a flat {depth,
// text} list instead. Always parses into a detached container that's never inserted into the
// page — this reads the markup, it never lets it touch the live DOM. Returns null if the markup
// doesn't contain any list items at all, so the caller can fall back to plain text.
function parseNestedLinesFromHtml(html) {
  if (!html) return null;
  const container = document.createElement("div");
  container.innerHTML = html;
  if (!container.querySelector("li")) return null;

  const lines = [];
  function textOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("ol, ul").forEach(n => n.remove());
    return serializeOutlineEditable(clone);
  }
  // listType carries whether THIS li's own list was <ol> (numbered) or <ul> (dashed) so the
  // pasted rows can match the source's actual marker style rather than guessing at one.
  function walkLi(li, depth, listType) {
    const text = textOf(li);
    if (text.trim()) lines.push({ depth, text, listType });
    Array.from(li.children).forEach(child => {
      if (child.tagName === "OL" || child.tagName === "UL") {
        const childType = child.tagName === "OL" ? "numbered" : "dashed";
        Array.from(child.children).forEach(childLi => {
          if (childLi.tagName === "LI") walkLi(childLi, depth + 1, childType);
        });
      }
    });
  }
  function walk(node, depth) {
    Array.from(node.children).forEach(child => {
      if (child.tagName === "OL" || child.tagName === "UL") {
        const listType = child.tagName === "OL" ? "numbered" : "dashed";
        Array.from(child.children).forEach(li => { if (li.tagName === "LI") walkLi(li, depth, listType); });
      } else if (child.tagName === "LI") {
        walkLi(child, depth, "dashed");
      } else {
        const t = textOf(child);
        if (t.trim()) lines.push({ depth: 0, text: t, listType: null });
        walk(child, depth);
      }
    });
  }
  walk(container, 0);
  return lines.length ? lines : null;
}

// Falls back to the clipboard's plain-text flavor when there's no usable HTML list structure —
// still tries a leading-tab-per-level heuristic for sources that do encode depth that way in
// plain text, but most of the time (a plain multi-line paste with no real hierarchy) this just
// produces everything at depth 0, which is the correct, honest answer for genuinely flat text.
function parseNestedLinesFromPlainText(text) {
  const lines = text.split(/\r\n|\r|\n/);
  return lines.map(line => {
    const m = line.match(/^\t*/);
    return { depth: m[0].length, text: line.slice(m[0].length), listType: null };
  });
}

// Replaces whatever `span` covers — a run of whole rows, or just part of one row — with
// `parsedLines` (an array of {depth, text}, depth relative to startNode's own level, one entry
// per resulting row). Used for pasting a multi-line block over a drag-selection, and for
// Backspace/Delete when a selection spans more than one row. Takes `span` from the caller rather
// than re-deriving it from the live selection — by the time this runs, whatever prompted it
// (preventDefault, other synchronous work) has already happened, so re-querying the selection
// here would be reasoning about browser state that's no longer guaranteed to match what the
// caller actually saw. Declines (returns false, changes nothing) for selections that cross into a
// different nesting level, that touch a row with children, or where the computed prefix/suffix
// come out longer than the rows they supposedly came from — the last one is a sanity backstop, not
// a case that's expected to legitimately trigger, but a Range that's ended up somewhere it
// shouldn't should never be trusted with rewriting rows.
async function replaceOutlineSelectionRange(parsedLines, span) {
  if (!span) return false;
  const { range, startEl, endEl } = span;

  const startId = startEl.dataset.id;
  const endId = endEl.dataset.id;
  const startNode = outlineNodes.find(n => n.id === startId);
  const endNode = outlineNodes.find(n => n.id === endId);
  if (!startNode || !endNode) return false;
  if ((startNode.parent_id || null) !== (endNode.parent_id || null)) return false;

  const siblings = outlineNodes
    .filter(n => (n.parent_id || null) === (startNode.parent_id || null))
    .sort((a, b) => a.position - b.position);
  const startIdx = siblings.findIndex(n => n.id === startId);
  const endIdx = siblings.findIndex(n => n.id === endId);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return false;

  const rowsInRange = siblings.slice(startIdx, endIdx + 1);
  if (rowsInRange.some(n => outlineNodes.some(c => c.parent_id === n.id))) return false;

  // startEl/endEl were derived from range.startContainer/endContainer via .closest(), so by
  // construction the boundary points should always be inside them — but that reasoning has
  // burned us before (a stale clone, a re-render landing at the wrong moment, anything that
  // leaves the Range referencing something it shouldn't by the time we get here). Rather than
  // trust that invariant implicitly, check it explicitly: if either boundary point isn't
  // actually contained in the row it's supposed to describe, refuse to build any Range from it
  // at all. This is what actually prevents a boundary that's ended up elsewhere from producing a
  // Range that spans out into unrelated content — checking the input, not just the output.
  if (!startEl.contains(range.startContainer) || !endEl.contains(range.endContainer)) {
    console.error("replaceOutlineSelectionRange: selection boundary not contained in its row, aborting");
    return false;
  }

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(startEl);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeDiv = document.createElement("div");
  beforeDiv.appendChild(beforeRange.cloneContents());
  const prefix = serializeOutlineEditable(beforeDiv);

  const afterRange = document.createRange();
  afterRange.selectNodeContents(endEl);
  afterRange.setStart(range.endContainer, range.endOffset);
  const afterDiv = document.createElement("div");
  afterDiv.appendChild(afterRange.cloneContents());
  const suffix = serializeOutlineEditable(afterDiv);

  // prefix can never be longer than startNode's own original content (it's defined as "the part
  // of startNode's content before the selection"), same for suffix against endNode — if either
  // comes out longer, the Range boundary ended up somewhere outside the row it was supposed to
  // be scoped to, and trusting it would risk splicing in unrelated content from elsewhere in the
  // tree. Bail out rather than write anything in that case.
  if (prefix.length > startNode.content.length || suffix.length > endNode.content.length) {
    console.error("replaceOutlineSelectionRange: prefix/suffix exceeded source row length, aborting");
    return false;
  }

  // The first parsed line always continues at startNode's own level (there's nothing sensible
  // for it to nest under, whatever depth it nominally carries), and gets whatever unselected
  // text preceded the selection within startNode prepended to it; the last gets whatever
  // unselected text followed the selection within endNode appended.
  const resultLines = (parsedLines.length ? parsedLines.map(l => ({ ...l })) : [{ depth: 0, text: "" }]);
  resultLines[0].depth = 0;
  resultLines[0].text = prefix + resultLines[0].text;
  resultLines[resultLines.length - 1].text = resultLines[resultLines.length - 1].text + suffix;

  const deleteIds = rowsInRange.slice(1).map(n => n.id);
  cancelPendingSave(startId);
  deleteIds.forEach(cancelPendingSave);

  pushOutlineUndoSnapshot();
  startNode.content = resultLines[0].text;
  // startNode itself is reused as the first resulting row rather than recreated, so its own
  // list_style needs the same source-matching treatment every other depth-0 line gets — otherwise
  // it would silently keep whatever style it happened to have before the paste (most commonly
  // "dashed", the fallback new empty rows get) even when the pasted content is clearly numbered.
  if (resultLines[0].listType) startNode.list_style = resultLines[0].listType;
  outlineNodes = outlineNodes.filter(n => !deleteIds.includes(n.id));

  const remainingSiblings = outlineNodes
    .filter(n => (n.parent_id || null) === (startNode.parent_id || null))
    .sort((a, b) => a.position - b.position);
  const afterIdx = remainingSiblings.findIndex(n => n.id === startId);
  const nextSibling = remainingSiblings[afterIdx + 1];
  const basePos = startNode.position;
  const endPos = nextSibling ? nextSibling.position : basePos + 1;
  const topLevelCount = resultLines.filter(l => l.depth === 0).length;

  // Walk the parsed lines with a stack of "most recently created row at each depth" — each new
  // line nests under whichever shallower row most recently preceded it, a direct translation of
  // the source's own list nesting into parent/child relationships. Top-level continuations
  // (depth 0) are spaced fractionally into the gap after startNode, same as the flat case always
  // was; anything deeper is a brand-new subtree with no pre-existing siblings to conflict with,
  // so it just counts up from 0. Each row's list_style matches whichever kind of list (<ol> vs
  // <ul>) it actually came from in the source when that's known; falling back to startNode's own
  // style for depth 0, or "dashed" for anything deeper, only when it isn't.
  const stack = [{ depth: 0, id: startId }];
  let topSeen = 0;
  let lastRowId = startId;
  for (let i = 1; i < resultLines.length; i++) {
    const { depth, text, listType } = resultLines[i];
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    let parentId, position, listStyle;
    if (depth === 0) {
      topSeen++;
      parentId = startNode.parent_id;
      position = basePos + (endPos - basePos) * (topSeen / topLevelCount);
      listStyle = listType || startNode.list_style;
    } else {
      parentId = parent.id;
      position = outlineNodes.filter(n => n.parent_id === parentId).length;
      listStyle = listType || "dashed";
    }
    const { tempId } = insertOptimisticOutlineNode(parentId, position, listStyle, text);
    stack.push({ depth, id: tempId });
    lastRowId = tempId;
  }

  renderTodo();

  const lastLine = resultLines[resultLines.length - 1].text;
  focusOutlineNode(lastRowId, Math.max(0, lastLine.length - suffix.length));

  const realStartId = await resolveOutlineId(startId);
  const ops = [sb.from("todo_outline").update({ content: startNode.content, list_style: startNode.list_style }).eq("id", realStartId)];
  for (const delId of deleteIds) {
    const realDelId = await resolveOutlineId(delId);
    ops.push(sb.from("todo_outline").delete().eq("id", realDelId));
  }
  const results = await Promise.all(ops);
  results.forEach(({ error }) => { if (error) console.error("replaceOutlineSelectionRange:", error.message); });

  return true;
}

// Swaps a temp id for the real one everywhere it appears in the DOM, without touching the
// DOM nodes themselves — preserves focus/cursor/selection if the user is still mid-edit there.
function relabelOutlineNodeId(oldId, newId) {
  document.querySelectorAll(`[data-id="${oldId}"]`).forEach(el => { el.dataset.id = newId; });
  document.querySelectorAll(`[data-parent-id="${oldId}"]`).forEach(el => { el.dataset.parentId = newId; });
  // Any row created (optimistically) as a child of this one before this insert resolved is
  // still carrying the old temp id as its own parent_id in memory — without this, buildOutlineTree
  // would stop finding its parent the moment this id changes, and it'd render as orphaned/top-level.
  outlineNodes.forEach(n => { if (n.parent_id === oldId) n.parent_id = newId; });
}

function insertOptimisticOutlineNode(parentId, position, listStyle, content) {
  const tempId = "temp-" + Math.random().toString(36).slice(2);
  const optimisticNode = { id: tempId, owner_id: session.user.id, parent_id: parentId, position, list_style: listStyle, content, done: false };
  outlineNodes.push(optimisticNode);

  // parentId may itself be another row's still-unresolved temp id (e.g. nesting a pasted child
  // under a sibling row created earlier in the very same paste) — the database has no idea what
  // a "temp-" string is, so the real parent id has to be awaited before this row's own insert
  // can go out, even though the optimistic node above is already showing with the temp parentId.
  const promise = resolveOutlineId(parentId)
    .then(realParentId => sb.from("todo_outline")
      .insert({ owner_id: session.user.id, parent_id: realParentId, position, list_style: listStyle, content })
      .select().single())
    .then(({ data, error }) => {
      if (error) {
        console.error("insertOptimisticOutlineNode:", error.message);
        delete pendingOutlineIds[tempId];
        outlineNodes = outlineNodes.filter(n => n.id !== tempId);
        renderTodo();
        return null;
      }
      Object.assign(optimisticNode, data);
      relabelOutlineNodeId(tempId, data.id);
      // Keep this mapping (as the resolved id itself, not a pending promise) rather than
      // deleting it — a debounced save can still look up this temp id well after the insert
      // resolves, and resolveOutlineId needs something to return besides the temp id itself.
      pendingOutlineIds[tempId] = data.id;
      return data.id;
    });
  pendingOutlineIds[tempId] = promise;

  return { tempId, optimisticNode };
}

async function addOutlineNode(parentId, listStyle) {
  const siblings = outlineNodes.filter(n => (n.parent_id || null) === (parentId || null));
  const position = siblings.length ? Math.max(...siblings.map(n => n.position)) + 1 : 0;
  const { tempId } = insertOptimisticOutlineNode(parentId, position, listStyle, "New item");
  renderTodo();
  selectAllInOutlineNode(tempId);
}

async function addOutlineSection() {
  await addOutlineNode(null, "none");
}

function focusOutlineNode(id, offset) {
  const el = document.querySelector(`.outline-content[data-id="${id}"]`);
  if (!el) return;
  focusOutlineAncestorOf(el);
  if (typeof offset === "number") placeCaretAtOffset(el, offset);
  else placeCaretAtStart(el);
}

async function outlineEnterKey(el, id) {
  const node = outlineNodes.find(n => n.id === id);
  if (!node) return;
  cancelPendingSave(id);
  const { before, after } = splitContentAtCaret(el);

  const siblings = outlineNodes
    .filter(n => (n.parent_id || null) === (node.parent_id || null))
    .sort((a, b) => a.position - b.position);
  const idx = siblings.findIndex(n => n.id === id);
  const nextSibling = siblings[idx + 1];
  const newPosition = nextSibling ? (node.position + nextSibling.position) / 2 : node.position + 1;

  pushOutlineUndoSnapshot();
  node.content = before;
  const { tempId } = insertOptimisticOutlineNode(node.parent_id, newPosition, node.list_style, after);
  renderTodo();
  focusOutlineNode(tempId, 0);

  const realId = await resolveOutlineId(id);
  const { error } = await sb.from("todo_outline").update({ content: before }).eq("id", realId);
  if (error) console.error("outlineEnterKey:", error.message);
}

// A non-collapsed selection spanning more than one row takes the multi-row replace path (same
// one paste uses, just with empty replacement text); a selection within a single row is left to
// the browser's native Backspace, since that's always worked fine on its own. Only a plain
// collapsed caret at the start of a row falls through to the existing merge-with-previous logic.
async function outlineBackspaceKey(e, el, id) {
  const sel = window.getSelection();
  if (sel.rangeCount && !sel.isCollapsed) {
    const span = getSelectionRowSpan();
    if (span && span.startEl !== span.endEl) {
      e.preventDefault();
      await replaceOutlineSelectionRange([{ depth: 0, text: "", listType: null }], span);
    }
    return;
  }

  if (!isCaretAtStart(el)) return;
  const node = outlineNodes.find(n => n.id === id);
  if (!node) return;
  if (outlineNodes.some(n => n.parent_id === id)) return; // has children — too risky to auto-merge

  const siblings = outlineNodes
    .filter(n => (n.parent_id || null) === (node.parent_id || null))
    .sort((a, b) => a.position - b.position);
  const idx = siblings.findIndex(n => n.id === id);
  if (idx <= 0) return; // no previous sibling to merge into

  const prev = siblings[idx - 1];
  if (outlineNodes.some(n => n.parent_id === prev.id)) return; // previous has children — skip

  e.preventDefault();
  cancelPendingSave(prev.id);
  cancelPendingSave(id);
  const currentContent = serializeOutlineEditable(el);
  const caretPos = prev.content.length;
  const mergedContent = (prev.content + currentContent).trim();

  pushOutlineUndoSnapshot();
  prev.content = mergedContent;
  outlineNodes = outlineNodes.filter(n => n.id !== id);
  renderTodo();
  focusOutlineNode(prev.id, caretPos);

  const [realPrevId, realId] = await Promise.all([resolveOutlineId(prev.id), resolveOutlineId(id)]);
  await Promise.all([
    sb.from("todo_outline").update({ content: mergedContent }).eq("id", realPrevId),
    sb.from("todo_outline").delete().eq("id", realId)
  ]);
}

// A non-collapsed selection spanning more than one row deletes the range (same path paste and
// Backspace use); anything else is left to native behavior, matching how Delete already worked
// (or rather, didn't do anything special) before this change.
function outlineDeleteKey(e) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const span = getSelectionRowSpan();
  if (!span || span.startEl === span.endEl) return;
  e.preventDefault();
  replaceOutlineSelectionRange([{ depth: 0, text: "", listType: null }], span);
}

function renderOutlineList(nodes, own) {
  if (!nodes.length) return "";
  let numberIdx = 0;
  const rows = nodes.map(n => {
    let marker = "";
    if (n.list_style === "numbered") { numberIdx++; marker = numberIdx + "."; }
    else if (n.list_style === "dashed") { marker = "&ndash;"; }
    const isHeading = n.list_style === "none";
    // checkbox/marker/add-btn are contenteditable="false" islands inside the shared editable
    // region below (see renderOutline) — otherwise they'd be typeable/selectable text themselves.
    const checkbox = !isHeading ? `
      <span class="checkbox${n.done ? " checked" : ""}${own ? "" : " disabled"}" contenteditable="false" data-action="outline-toggle" data-id="${n.id}" data-done="${n.done}">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
      </span>` : "";
    return `
      <div class="outline-node ${isHeading ? "outline-heading" : "outline-item"}">
        <div class="outline-row">
          ${checkbox}
          ${marker ? `<span class="outline-marker" contenteditable="false">${marker}</span>` : ""}
          <div class="outline-content" data-id="${n.id}">${n.content ? parseBold(n.content) : "<br>"}</div>
        </div>
        ${renderOutlineList(n.children, own)}
        ${own ? `<button type="button" class="outline-add-btn" contenteditable="false" data-parent-id="${n.id}" data-style="${defaultChildStyle(n)}">+ add</button>` : ""}
      </div>
    `;
  }).join("");
  return `<div class="outline-list">${rows}</div>`;
}

// The whole tree (every depth, every section) renders inside one shared contenteditable div per
// list (active vs. completed) rather than one per row — that's what lets a native mouse-drag
// selection span multiple rows at all; browsers won't let a drag selection cross from one
// contenteditable region into a separate one. Enter/Backspace/arrow-nav/paste are still fully
// custom-handled (see initOutlineEditing below), so this doesn't hand line-splitting over to the
// browser — it only unlocks selection, copy, and paste spanning rows.
function renderOutline() {
  const own = isOwnData();
  const tree = buildOutlineTree(outlineNodes);
  const completed = [];

  (function extract(nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.list_style !== "none" && n.done) {
        completed.push(n);
        nodes.splice(i, 1);
      } else {
        extract(n.children);
      }
    }
  })(tree);
  completed.sort((a, b) => a.position - b.position);

  let html = `<div class="outline-editable" contenteditable="${own}">${renderOutlineList(tree, own)}</div>`;
  if (own) html += `<button type="button" id="outline-add-section-btn" class="add-item-btn">+ Add section</button>`;

  if (completed.length) {
    html += `
      <div class="completed-section">
        <button type="button" id="outline-completed-toggle" class="completed-toggle">
          ${outlineCompletedCollapsed ? "&#9656;" : "&#9662;"} Completed (${completed.length})
        </button>
        <div class="completed-list"${outlineCompletedCollapsed ? " hidden" : ""}>
          <div class="outline-editable" contenteditable="${own}">${renderOutlineList(completed, own)}</div>
        </div>
      </div>
    `;
  }

  document.getElementById("todo-wrap").innerHTML = html;

  document.querySelectorAll('#todo-wrap .checkbox[data-action="outline-toggle"]:not(.disabled)').forEach(cb => {
    cb.addEventListener("mousedown", e => e.preventDefault()); // don't disturb an active selection/caret
    cb.addEventListener("click", e => {
      e.stopPropagation();
      toggleOutlineDone(cb.dataset.id, cb.dataset.done !== "true");
    });
  });

  document.querySelectorAll("#todo-wrap .outline-add-btn").forEach(btn => {
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => addOutlineNode(btn.dataset.parentId, btn.dataset.style));
  });

  const addSectionBtn = document.getElementById("outline-add-section-btn");
  if (addSectionBtn) addSectionBtn.addEventListener("click", addOutlineSection);

  const completedToggle = document.getElementById("outline-completed-toggle");
  if (completedToggle) completedToggle.addEventListener("click", () => {
    outlineCompletedCollapsed = !outlineCompletedCollapsed;
    renderOutline();
  });
}

// Attached once to the stable #todo-wrap element (renderOutline only ever replaces its
// innerHTML, never the element itself), delegating to whichever row the selection is currently
// in — the individual rows aren't separately focusable any more, so per-row listeners no longer
// make sense. Guarded by isOwnData() since read-only views never render an editable region at all.
let outlineEditingInitialized = false;
function initOutlineEditing() {
  if (outlineEditingInitialized) return;
  outlineEditingInitialized = true;
  const wrap = document.getElementById("todo-wrap");

  wrap.addEventListener("keydown", e => {
    if (!isOwnData()) return;
    if (e.key === "Delete") { outlineDeleteKey(e); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      // Only take over Cmd/Ctrl+Z when there's actually a structural change to undo — otherwise
      // leave it alone so native undo still handles plain typing within a row.
      if (outlineUndoStack.length) { e.preventDefault(); undoLastOutlineChange(); }
      return;
    }
    const el = currentOutlineRow();
    if (!el) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      // Native Select All would grab the entire shared editable region (every row in the whole
      // list, not just this one) since the outline is one contenteditable host — scope it to
      // the current row instead, matching what "select all" means in an ordinary text field.
      e.preventDefault();
      selectAllInOutlineNode(el.dataset.id);
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); outlineEnterKey(el, el.dataset.id); }
    else if (e.key === "Backspace") { outlineBackspaceKey(e, el, el.dataset.id); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { outlineArrowKey(e, el); }
  });

  wrap.addEventListener("input", () => {
    if (!isOwnData()) return;
    const el = currentOutlineRow();
    if (!el) return;
    scheduleOutlineSave(el.dataset.id, el);
  });

  // Rich clipboard sources (iCloud Notes, Word, etc.) carry real nested <ol>/<li>/<div>
  // structure in their HTML flavor, but their plain-text flavor doesn't always mark line breaks
  // the same way — some encode a whole list with no \n between items at all. Deciding whether to
  // intercept a paste based on the plain text's line count let that HTML slip through natively
  // on exactly those sources: it renders looking perfectly fine (it's genuine rich markup being
  // shown as-is), but the very next content save flattens that whole foreign subtree into one
  // string, which is how a good paste turns into a mangled all-bold blob after a reload. So:
  // ALWAYS take control of paste here, unconditionally, and never let the browser's own paste
  // insertion touch the DOM at all — only ever insert the plain-text flavor, ourselves.
  wrap.addEventListener("paste", e => {
    if (!isOwnData()) return;
    e.preventDefault();
    const span = getSelectionRowSpan();
    if (!span) return;
    const clipboard = e.clipboardData || window.clipboardData;
    const html = clipboard.getData("text/html");
    const text = clipboard.getData("text/plain");
    if (text == null && !html) return;
    // Try the HTML flavor's real list structure first (falling back to plain text, tab-depth
    // heuristic and all, only when there's no usable list markup) — the reconciliation this
    // feeds into never inserts raw HTML into the DOM either way, it only ever writes plain text
    // (with **bold** markers) into rows, whether pasting one line or many.
    const parsedLines = parseNestedLinesFromHtml(html) || parseNestedLinesFromPlainText(text || "");
    replaceOutlineSelectionRange(parsedLines, span);
  });

  // Flush any pending debounced save the instant focus leaves the editable region entirely
  // (e.g. switching tabs), so a quick edit-then-navigate-away never gets silently dropped.
  wrap.addEventListener("focusout", flushPendingSaves);
}

initOutlineEditing();
initAuth();
