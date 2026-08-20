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
document.querySelectorAll("nav.tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.target).classList.add("active");
  });
});

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
      if (active && active.classList && active.classList.contains("outline-content")) return; // don't yank focus mid-edit
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
  return Array.from(document.querySelectorAll('#todo-wrap .outline-content[contenteditable="true"]'));
}

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
      next.focus();
      placeCaretNear(next, x, targetRect.top + 2);
    }
  } else if (e.key === "ArrowUp" && caretOnFirstLine(el)) {
    const prev = fields[idx - 1];
    if (prev) {
      e.preventDefault();
      const targetRect = prev.getBoundingClientRect();
      prev.focus();
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
// fired before the first node's insert has confirmed — awaits `resolveOutlineId` first so it
// never sends a temp- id to the database.
const pendingOutlineIds = {};
async function resolveOutlineId(id) {
  if (!id || !id.startsWith("temp-")) return id;
  const pending = pendingOutlineIds[id];
  return pending ? (await pending) || id : id;
}

async function toggleOutlineDone(id, done) {
  const node = outlineNodes.find(n => n.id === id);
  if (node) { node.done = done; renderTodo(); }
  const realId = await resolveOutlineId(id);
  const { error } = await sb.from("todo_outline").update({ done }).eq("id", realId);
  if (error) console.error("toggleOutlineDone:", error.message);
}

async function saveOutlineContent(id, el) {
  const content = serializeOutlineEditable(el);
  const node = outlineNodes.find(n => n.id === id);
  if (node) node.content = content;
  const realId = await resolveOutlineId(id);
  const { error } = await sb.from("todo_outline").update({ content }).eq("id", realId);
  if (error) console.error("saveOutlineContent:", error.message);
}

function selectAllInOutlineNode(id) {
  const el = document.querySelector(`.outline-content[data-id="${id}"]`);
  if (!el) return;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Swaps a temp id for the real one everywhere it appears in the DOM, without touching the
// DOM nodes themselves — preserves focus/cursor/selection if the user is still mid-edit there.
function relabelOutlineNodeId(oldId, newId) {
  document.querySelectorAll(`[data-id="${oldId}"]`).forEach(el => { el.dataset.id = newId; });
  document.querySelectorAll(`[data-parent-id="${oldId}"]`).forEach(el => { el.dataset.parentId = newId; });
}

function insertOptimisticOutlineNode(parentId, position, listStyle, content) {
  const tempId = "temp-" + Math.random().toString(36).slice(2);
  const optimisticNode = { id: tempId, owner_id: session.user.id, parent_id: parentId, position, list_style: listStyle, content, done: false };
  outlineNodes.push(optimisticNode);

  const promise = sb.from("todo_outline")
    .insert({ owner_id: session.user.id, parent_id: parentId, position, list_style: listStyle, content })
    .select().single()
    .then(({ data, error }) => {
      delete pendingOutlineIds[tempId];
      if (error) {
        console.error("insertOptimisticOutlineNode:", error.message);
        outlineNodes = outlineNodes.filter(n => n.id !== tempId);
        renderTodo();
        return null;
      }
      Object.assign(optimisticNode, data);
      relabelOutlineNodeId(tempId, data.id);
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
  el.focus();
  if (typeof offset === "number") placeCaretAtOffset(el, offset);
  else placeCaretAtStart(el);
}

async function outlineEnterKey(el, id) {
  const node = outlineNodes.find(n => n.id === id);
  if (!node) return;
  const { before, after } = splitContentAtCaret(el);

  const siblings = outlineNodes
    .filter(n => (n.parent_id || null) === (node.parent_id || null))
    .sort((a, b) => a.position - b.position);
  const idx = siblings.findIndex(n => n.id === id);
  const nextSibling = siblings[idx + 1];
  const newPosition = nextSibling ? (node.position + nextSibling.position) / 2 : node.position + 1;

  node.content = before;
  const { tempId } = insertOptimisticOutlineNode(node.parent_id, newPosition, node.list_style, after);
  renderTodo();
  focusOutlineNode(tempId, 0);

  const realId = await resolveOutlineId(id);
  const { error } = await sb.from("todo_outline").update({ content: before }).eq("id", realId);
  if (error) console.error("outlineEnterKey:", error.message);
}

async function outlineBackspaceKey(e, el, id) {
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
  const currentContent = serializeOutlineEditable(el);
  const caretPos = prev.content.length;
  const mergedContent = (prev.content + currentContent).trim();

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

function renderOutlineList(nodes, own) {
  if (!nodes.length) return "";
  let numberIdx = 0;
  const rows = nodes.map(n => {
    let marker = "";
    if (n.list_style === "numbered") { numberIdx++; marker = numberIdx + "."; }
    else if (n.list_style === "dashed") { marker = "&ndash;"; }
    const isHeading = n.list_style === "none";
    const checkbox = !isHeading ? `
      <span class="checkbox${n.done ? " checked" : ""}${own ? "" : " disabled"}" data-action="outline-toggle" data-id="${n.id}" data-done="${n.done}">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
      </span>` : "";
    return `
      <div class="outline-node ${isHeading ? "outline-heading" : "outline-item"}">
        <div class="outline-row">
          ${checkbox}
          ${marker ? `<span class="outline-marker">${marker}</span>` : ""}
          <div class="outline-content" contenteditable="${own}" data-id="${n.id}">${parseBold(n.content)}</div>
        </div>
        ${renderOutlineList(n.children, own)}
        ${own ? `<button type="button" class="outline-add-btn" data-parent-id="${n.id}" data-style="${defaultChildStyle(n)}">+ add</button>` : ""}
      </div>
    `;
  }).join("");
  return `<div class="outline-list">${rows}</div>`;
}

function renderOutline() {
  const actionable = outlineNodes.filter(n => n.list_style !== "none");
  const total = actionable.length;
  const done = actionable.filter(n => n.done).length;
  document.getElementById("fill").style.width = (total ? done / total * 100 : 0) + "%";
  document.getElementById("progLabel").textContent = done + " of " + total + " done";

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

  let html = renderOutlineList(tree, own);
  if (own) html += `<button type="button" id="outline-add-section-btn" class="add-item-btn">+ Add section</button>`;

  if (completed.length) {
    html += `
      <div class="completed-section">
        <button type="button" id="outline-completed-toggle" class="completed-toggle">
          ${outlineCompletedCollapsed ? "&#9656;" : "&#9662;"} Completed (${completed.length})
        </button>
        <div class="completed-list"${outlineCompletedCollapsed ? " hidden" : ""}>
          ${renderOutlineList(completed, own)}
        </div>
      </div>
    `;
  }

  document.getElementById("todo-wrap").innerHTML = html;

  document.querySelectorAll('#todo-wrap .checkbox[data-action="outline-toggle"]:not(.disabled)').forEach(cb => {
    cb.addEventListener("click", e => {
      e.stopPropagation();
      toggleOutlineDone(cb.dataset.id, cb.dataset.done !== "true");
    });
  });

  document.querySelectorAll('#todo-wrap .outline-content[contenteditable="true"]').forEach(el => {
    el.addEventListener("click", e => e.stopPropagation());
    el.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); outlineEnterKey(el, el.dataset.id); }
      else if (e.key === "Backspace") { outlineBackspaceKey(e, el, el.dataset.id); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { outlineArrowKey(e, el); }
    });
    el.addEventListener("blur", () => saveOutlineContent(el.dataset.id, el));
  });

  document.querySelectorAll("#todo-wrap .outline-add-btn").forEach(btn => {
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

initAuth();
