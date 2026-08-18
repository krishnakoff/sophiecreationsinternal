const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

let session = null;
let leads = [];
let todoItems = [];
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

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
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
  await Promise.all([loadLeads(), loadTodos(), loadOutboundStats()]);
  subscribeRealtime();
}

function subscribeRealtime() {
  if (realtimeReady) return;
  realtimeReady = true;
  sb.channel("public:leads")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, loadLeads)
    .subscribe();
  sb.channel("public:todo_items")
    .on("postgres_changes", { event: "*", schema: "public", table: "todo_items" }, loadTodos)
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
  if (lead.stage === "contacted") {
    if (next && !next.exhausted) {
      const diff = daysDiff(next.date, today);
      if (diff < 0) return [0, diff];  // overdue, most overdue first
      if (diff === 0) return [1, 0];   // due today
      return [2, diff];                 // upcoming, soonest first
    }
    return [3, 0]; // sequence exhausted, no reply yet — needs a manual follow-up
  }
  if (lead.stage === "responded") return [4, 0];
  if (lead.stage === "conversation") return [5, 0];
  if (lead.stage === "sampling") return [6, 0];
  if (lead.stage === "prospect") return [7, 0];
  if (lead.stage === "client") return [8, 0];
  return [9, 0]; // dead
}

async function loadOutboundStats() {
  const weekStart = startOfWeek(new Date());
  const { data, error } = await sb.from("outbound_emails").select("owner_id").gte("sent_at", weekStart.toISOString());
  if (error) { console.error("loadOutboundStats:", error.message); return; }
  const counts = {};
  OWNERS.forEach(o => counts[o.id] = 0);
  (data || []).forEach(row => { if (row.owner_id in counts) counts[row.owner_id]++; });
  document.getElementById("outbound-stats").innerHTML = `
    <span class="outbound-label">Outbound this week</span>
    ${OWNERS.map(o => `<span class="outbound-count"><strong>${counts[o.id]}</strong> ${escapeHtml(o.name)}</span>`).join("")}
  `;
}

function renderCrm() {
  const today = new Date();
  const enriched = leads.map(l => { const next = computeNextAction(l, today); return { lead: l, next, rank: rankLead(l, next, today) }; });
  enriched.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);

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
  const rows = enriched.map(({ lead, next }) => `
    <tr>
      <td class="company">${escapeHtml(lead.company)}</td>
      <td>${escapeHtml(lead.contact)}</td>
      <td class="muted">${escapeHtml(lead.email)}</td>
      <td>${escapeHtml(lead.product)}</td>
      <td>${stagePill(lead)}</td>
      <td>${actionCell(lead, next, today)}</td>
      <td class="notes-cell">${escapeHtml(lead.stage === "dead" && lead.lost_reason ? lead.lost_reason : lead.notes)}</td>
    </tr>
  `).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>Company</th><th>Contact</th><th>Email</th><th>Product</th><th>Stage</th><th>Next action</th><th>Notes</th></tr></thead>
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
  const total = todoItems.length;
  const done = todoItems.filter(i => i.done).length;
  document.getElementById("fill").style.width = (total ? done / total * 100 : 0) + "%";
  document.getElementById("progLabel").textContent = done + " of " + total + " done";

  const own = isOwnData();

  const html = TIERS.map(tier => {
    const items = todoItems.filter(i => i.tier === tier.n).sort((a, b) => a.position - b.position);
    if (!items.length && !own) return "";
    const rows = items.map(item => `
      <li class="item${item.done ? " done" : ""}" data-id="${item.id}">
        <span class="num">${item.position}</span>
        <span class="checkbox${item.done ? " checked" : ""}${own ? "" : " disabled"}" data-action="toggle" data-id="${item.id}" data-done="${item.done}">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
        </span>
        <span class="item-body">
          <div class="item-title" contenteditable="${own}" data-id="${item.id}" data-field="title">${escapeHtml(item.title)}</div>
          <div class="item-note" contenteditable="${own}" data-id="${item.id}" data-field="note">${escapeHtml(item.note)}</div>
        </span>
      </li>
    `).join("");
    return `
      <div class="tier">
        <div class="tier-heading">${escapeHtml(tier.heading)}</div>
        <div class="tier-note">${escapeHtml(tier.note)}</div>
        <ul class="items">${rows}</ul>
        ${own ? `<button type="button" class="add-item-btn" data-tier="${tier.n}">+ Add task</button>` : ""}
      </div>
    `;
  }).join("");

  document.getElementById("todo-wrap").innerHTML = html;

  document.querySelectorAll('.checkbox[data-action="toggle"]:not(.disabled)').forEach(cb => {
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = cb.dataset.id;
      const nowDone = cb.dataset.done !== "true";
      cb.closest(".item").classList.toggle("done", nowDone);
      cb.classList.toggle("checked", nowDone);
      cb.dataset.done = String(nowDone);
      toggleDone(id, nowDone);
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
}

initAuth();
