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

const TIERS = [
  { n: 1, heading: "1. Collect money already earned", note: "Confirmed orders, quotes already sent — these are just a call or WhatsApp away from cash in hand." },
  { n: 2, heading: "2. Close warm sales already in motion", note: "Real buyers, live conversations — these just need a nudge to convert." },
  { n: 3, heading: "3. Two-minute habits that protect everything above", note: "Zero cost, compounds daily — these determine how much of the list above actually gets done." },
  { n: 4, heading: "4. Keep the MBM pipeline moving", note: "Real production and shipping already underway — this protects revenue already in motion." },
  { n: 5, heading: "5. Build leverage that multiplies future sales", note: "More effort, but these stop revenue depending entirely on your own hours." },
  { n: 6, heading: "6. Bigger, slower bets", note: "Worth doing, but the payoff is further out — don't let these crowd out the list above." }
];

const OWNERS = [
  { id: "87133383-89c3-468e-96b5-1cce2455edc7", name: "Krishna" },
  { id: "cd66a924-67ec-4ecf-90a9-54edc57d3966", name: "Sanjay" }
];
function ownerName(id) { return (OWNERS.find(o => o.id === id) || {}).name || "Unknown"; }
function isOwnData() { return viewingOwnerId === session.user.id; }
const KRISHNA_ID = OWNERS.find(o => o.name === "Krishna").id;

let session = null;
let leads = [];
let todoItems = [];
let outlineNodes = [];
let outlineCompletedCollapsed = true;
let realtimeReady = false;
let viewingOwnerId = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  const todoLoad = viewingOwnerId === KRISHNA_ID ? loadOutline() : loadTodos();
  await Promise.all([loadLeads(), todoLoad, loadOutboundStats()]);
  subscribeRealtime();
}

function subscribeRealtime() {
  if (realtimeReady) return;
  realtimeReady = true;
  sb.channel("public:leads")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, loadLeads)
    .subscribe();
  sb.channel("public:todo_items")
    .on("postgres_changes", { event: "*", schema: "public", table: "todo_items" }, () => { if (viewingOwnerId !== KRISHNA_ID) loadTodos(); })
    .subscribe();
  sb.channel("public:todo_outline")
    .on("postgres_changes", { event: "*", schema: "public", table: "todo_outline" }, () => { if (viewingOwnerId === KRISHNA_ID) loadOutline(); })
    .subscribe();
  sb.channel("public:outbound_emails")
    .on("postgres_changes", { event: "*", schema: "public", table: "outbound_emails" }, loadOutboundStats)
    .subscribe();
}

async function loadLeads() {
  const { data, error } = await sb.from("leads").select("*").eq("owner_id", viewingOwnerId).order("created_at");
  if (!error) { leads = data || []; renderCrm(); }
  else console.error("loadLeads:", error.message);
}

async function loadTodos() {
  const { data, error } = await sb.from("todo_items").select("*").eq("owner_id", viewingOwnerId).order("tier").order("position");
  if (!error) { todoItems = data || []; renderTodo(); }
  else console.error("loadTodos:", error.message);
}

async function loadOutline() {
  const { data, error } = await sb.from("todo_outline").select("*").eq("owner_id", KRISHNA_ID).order("position");
  if (!error) { outlineNodes = data || []; renderTodo(); }
  else console.error("loadOutline:", error.message);
}

// ---------- CRM ----------
const SEQUENCE_OFFSETS = [0, 4, 7, 10];
const SEQUENCE_TYPES = ["email", "call", "email", "call"];
const STAGES = [
  { id: "prospect", label: "Prospect" },
  { id: "contacted", label: "Contacted" },
  { id: "responded", label: "Responded" },
  { id: "conversation", label: "In conversation" },
  { id: "sampling", label: "Sampling" },
  { id: "client", label: "Client" },
  { id: "dead", label: "Dead" }
];

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
  if (["responded", "conversation", "sampling"].includes(lead.stage) && lead.next_action_date) {
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
  } else if (lead.stage === "responded") stageRank = 4;
  else if (lead.stage === "conversation") stageRank = 5;
  else if (lead.stage === "sampling") stageRank = 6;
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

  document.getElementById("cards").innerHTML = `
    <div class="card"><div class="num">${total}</div><div class="label">Total leads</div></div>
    <div class="card"><div class="num">${counts.prospect}</div><div class="label">Prospects</div></div>
    <div class="card c-sapphire"><div class="num">${counts.contacted}</div><div class="label">Contacted</div></div>
    <div class="card c-amber"><div class="num">${counts.responded}</div><div class="label">Responded</div></div>
    <div class="card c-accent"><div class="num">${counts.conversation}</div><div class="label">In conversation</div></div>
    <div class="card c-garnet"><div class="num">${counts.sampling}</div><div class="label">Sampling</div></div>
    <div class="card c-emerald"><div class="num">${counts.client}</div><div class="label">Clients</div></div>
    <div class="card"><div class="num">${counts.dead}</div><div class="label">Dead</div></div>
  `;

  const wrap = document.getElementById("crm-table-wrap");
  if (total === 0) {
    wrap.innerHTML = '<div class="empty-state">No leads yet.</div>';
    return;
  }
  const yn = v => v ? '<span class="yn yes">&#10003;</span>' : '<span class="yn no">&mdash;</span>';
  const rows = enriched.map(({ lead, next }) => `
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

// ---------- To-Do ----------
async function toggleDone(id, done) {
  const { error } = await sb.from("todo_items").update({ done }).eq("id", id);
  if (error) console.error("toggleDone:", error.message);
}

async function saveField(id, field, value) {
  const { error } = await sb.from("todo_items").update({ [field]: value }).eq("id", id);
  if (error) console.error("saveField:", error.message);
}

async function addTodoItem(tierNum) {
  const inTier = todoItems.filter(i => i.tier === tierNum);
  const position = inTier.length ? Math.max(...inTier.map(i => i.position)) + 1 : 1;
  const { error } = await sb.from("todo_items")
    .insert({ owner_id: session.user.id, tier: tierNum, position, title: "New task", note: "" });
  if (error) console.error("addTodoItem:", error.message);
}

function renderTodo() {
  if (viewingOwnerId === KRISHNA_ID) { renderOutline(); return; }
  renderTierTodo();
}

let tierCompletedCollapsed = true;

function renderTierItemRow(item, own) {
  return `
    <li class="item" data-id="${item.id}">
      <span class="num">${item.position}</span>
      <span class="checkbox${item.done ? " checked" : ""}${own ? "" : " disabled"}" data-action="toggle" data-id="${item.id}" data-done="${item.done}">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
      </span>
      <span class="item-body">
        <div class="item-title" contenteditable="${own}" data-id="${item.id}" data-field="title">${escapeHtml(item.title)}</div>
        <div class="item-note" contenteditable="${own}" data-id="${item.id}" data-field="note">${escapeHtml(item.note)}</div>
      </span>
    </li>
  `;
}

function renderTierTodo() {
  const total = todoItems.length;
  const done = todoItems.filter(i => i.done).length;
  document.getElementById("fill").style.width = (total ? done / total * 100 : 0) + "%";
  document.getElementById("progLabel").textContent = done + " of " + total + " done";

  const own = isOwnData();
  const activeItems = todoItems.filter(i => !i.done);
  const completedItems = todoItems.filter(i => i.done).sort((a, b) => a.tier - b.tier || a.position - b.position);

  let html = TIERS.map(tier => {
    const items = activeItems.filter(i => i.tier === tier.n).sort((a, b) => a.position - b.position);
    if (!items.length && !own) return "";
    const rows = items.map(item => renderTierItemRow(item, own)).join("");
    return `
      <div class="tier">
        <div class="tier-heading">${escapeHtml(tier.heading)}</div>
        <div class="tier-note">${escapeHtml(tier.note)}</div>
        <ul class="items">${rows}</ul>
        ${own ? `<button type="button" class="add-item-btn" data-tier="${tier.n}">+ Add task</button>` : ""}
      </div>
    `;
  }).join("");

  if (completedItems.length) {
    html += `
      <div class="completed-section">
        <button type="button" id="tier-completed-toggle" class="completed-toggle">
          ${tierCompletedCollapsed ? "&#9656;" : "&#9662;"} Completed (${completedItems.length})
        </button>
        <ul class="items completed-list"${tierCompletedCollapsed ? " hidden" : ""}>
          ${completedItems.map(item => renderTierItemRow(item, own)).join("")}
        </ul>
      </div>
    `;
  }

  document.getElementById("todo-wrap").innerHTML = html;

  document.querySelectorAll('.checkbox[data-action="toggle"]:not(.disabled)').forEach(cb => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDone(cb.dataset.id, cb.dataset.done !== "true");
    });
  });

  document.querySelectorAll(".item-title, .item-note").forEach(el => {
    el.addEventListener("click", e => e.stopPropagation());
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
    el.addEventListener("blur", () => saveField(el.dataset.id, el.dataset.field, el.innerText.trim()));
  });

  document.querySelectorAll(".add-item-btn").forEach(btn => {
    btn.addEventListener("click", () => addTodoItem(Number(btn.dataset.tier)));
  });

  const completedToggle = document.getElementById("tier-completed-toggle");
  if (completedToggle) completedToggle.addEventListener("click", () => {
    tierCompletedCollapsed = !tierCompletedCollapsed;
    renderTierTodo();
  });
}

// ---------- To-Do (Krishna's outline) ----------
function parseBold(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function serializeOutlineEditable(el) {
  let html = el.innerHTML.replace(/<(b|strong)>(.*?)<\/(b|strong)>/gi, "**$2**");
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || "").replace(/ /g, " ").trim();
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

async function toggleOutlineDone(id, done) {
  const { error } = await sb.from("todo_outline").update({ done }).eq("id", id);
  if (error) console.error("toggleOutlineDone:", error.message);
}

async function saveOutlineContent(id, el) {
  const content = serializeOutlineEditable(el);
  const { error } = await sb.from("todo_outline").update({ content }).eq("id", id);
  if (error) console.error("saveOutlineContent:", error.message);
}

async function addOutlineNode(parentId, listStyle) {
  const siblings = outlineNodes.filter(n => (n.parent_id || null) === (parentId || null));
  const position = siblings.length ? Math.max(...siblings.map(n => n.position)) + 1 : 0;
  const { error } = await sb.from("todo_outline")
    .insert({ owner_id: KRISHNA_ID, parent_id: parentId, position, list_style: listStyle, content: "New item" });
  if (error) console.error("addOutlineNode:", error.message);
}

async function addOutlineSection() {
  await addOutlineNode(null, "none");
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
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
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
