const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const TIERS = [
  { n: 1, heading: "1. Collect money already earned", note: "Confirmed orders, quotes already sent — these are just a call or WhatsApp away from cash in hand." },
  { n: 2, heading: "2. Close warm sales already in motion", note: "Real buyers, live conversations — these just need a nudge to convert." },
  { n: 3, heading: "3. Two-minute habits that protect everything above", note: "Zero cost, compounds daily — these determine how much of the list above actually gets done." },
  { n: 4, heading: "4. Keep the MBM pipeline moving", note: "Real production and shipping already underway — this protects revenue already in motion." },
  { n: 5, heading: "5. Build leverage that multiplies future sales", note: "More effort, but these stop revenue depending entirely on your own hours." },
  { n: 6, heading: "6. Bigger, slower bets", note: "Worth doing, but the payoff is further out — don't let these crowd out the list above." }
];

let session = null;
let leads = [];
let todoItems = [];
let realtimeReady = false;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- auth ----------
async function initAuth() {
  const { data: { session: s } } = await supabase.auth.getSession();
  session = s;
  renderShell();
  supabase.auth.onAuthStateChange((_event, s2) => { session = s2; renderShell(); });
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errBox = document.getElementById("login-error");
  errBox.hidden = true;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) { errBox.textContent = error.message; errBox.hidden = false; }
});

document.getElementById("signout").addEventListener("click", async () => {
  await supabase.auth.signOut();
});

function renderShell() {
  const loginScreen = document.getElementById("login-screen");
  const app = document.getElementById("app");
  if (session) {
    loginScreen.hidden = true;
    app.hidden = false;
    loadAll();
  } else {
    loginScreen.hidden = false;
    app.hidden = true;
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
  await Promise.all([loadLeads(), loadTodos()]);
  subscribeRealtime();
}

function subscribeRealtime() {
  if (realtimeReady) return;
  realtimeReady = true;
  supabase.channel("public:leads")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, loadLeads)
    .subscribe();
  supabase.channel("public:todo_items")
    .on("postgres_changes", { event: "*", schema: "public", table: "todo_items" }, loadTodos)
    .subscribe();
}

async function loadLeads() {
  const { data, error } = await supabase.from("leads").select("*").order("created_at");
  if (!error) { leads = data || []; renderCrm(); }
  else console.error("loadLeads:", error.message);
}

async function loadTodos() {
  const { data, error } = await supabase.from("todo_items").select("*").order("tier").order("position");
  if (!error) { todoItems = data || []; renderTodo(); }
  else console.error("loadTodos:", error.message);
}

// ---------- CRM ----------
const SEQUENCE_OFFSETS = [0, 4, 7, 10];
const SEQUENCE_TYPES = ["email", "call", "email", "call"];

function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtDate(date) { return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
function isoDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function daysDiff(a, b) { return Math.round((isoDay(a) - isoDay(b)) / 86400000); }

function computeNextAction(lead, today) {
  if (lead.status !== "active") return null;
  if (lead.mode === "snoozed") {
    if (!lead.next_action_date) return null;
    return { date: parseDate(lead.next_action_date), type: lead.next_action_type || "email" };
  }
  const step = lead.steps_completed || 0;
  if (step >= 4) return { exhausted: true };
  return { date: addDays(parseDate(lead.added_date), SEQUENCE_OFFSETS[step]), type: SEQUENCE_TYPES[step] };
}

function statusPill(lead, next) {
  if (lead.status === "client") return '<span class="pill pill-client">Client</span>';
  if (lead.status === "dead") return '<span class="pill pill-dead">Dead</span>';
  if (next && next.exhausted) return '<span class="pill pill-flag">Sequence done</span>';
  if (lead.mode === "snoozed") return '<span class="pill" style="background:var(--sapphire-tint);color:var(--sapphire)">Nurture</span>';
  return '<span class="pill pill-active">In sequence</span>';
}

function actionCell(lead, next, today) {
  if (!next || next.exhausted || lead.status !== "active") return '<span class="muted">&mdash;</span>';
  const diff = daysDiff(next.date, today);
  let cls = "", label = fmtDate(next.date);
  if (diff < 0) { cls = "overdue"; label = fmtDate(next.date) + " (" + Math.abs(diff) + "d overdue)"; }
  else if (diff === 0) { cls = "today"; label = "Today"; }
  return '<span class="next-action ' + cls + '">' + label + ' <span class="type">&middot; ' + next.type + '</span></span>';
}

function rankLead(lead, next, today) {
  if (lead.status === "active" && next && !next.exhausted) {
    const diff = daysDiff(next.date, today);
    if (diff < 0) return [0, diff];
    if (diff === 0) return [1, 0];
    return [2, diff];
  }
  if (next && next.exhausted) return [3, 0];
  if (lead.status === "client") return [4, 0];
  return [5, 0];
}

function renderCrm() {
  const today = new Date();
  const enriched = leads.map(l => { const next = computeNextAction(l, today); return { lead: l, next, rank: rankLead(l, next, today) }; });
  enriched.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);

  const total = leads.length;
  const overdue = enriched.filter(e => e.rank[0] === 0).length;
  const dueToday = enriched.filter(e => e.rank[0] === 1).length;
  const nurture = leads.filter(l => l.status === "active" && l.mode === "snoozed").length;
  const clients = leads.filter(l => l.status === "client").length;
  const dead = leads.filter(l => l.status === "dead").length;
  const activeTotal = leads.filter(l => l.status === "active").length;

  document.getElementById("crm-subtitle").textContent =
    "Top-line summary as of " + today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  document.getElementById("cards").innerHTML = `
    <div class="card"><div class="num">${total}</div><div class="label">Total leads</div></div>
    <div class="card"><div class="num">${activeTotal}</div><div class="label">Active</div></div>
    <div class="card c-garnet"><div class="num">${overdue}</div><div class="label">Overdue</div></div>
    <div class="card c-amber"><div class="num">${dueToday}</div><div class="label">Due today</div></div>
    <div class="card c-sapphire"><div class="num">${nurture}</div><div class="label">Nurture</div></div>
    <div class="card c-emerald"><div class="num">${clients}</div><div class="label">Clients</div></div>
    <div class="card"><div class="num">${dead}</div><div class="label">Dead</div></div>
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
      <td>${statusPill(lead, next)}</td>
      <td>${actionCell(lead, next, today)}</td>
      <td class="notes-cell">${escapeHtml(lead.notes)}</td>
    </tr>
  `).join("");
  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>Company</th><th>Contact</th><th>Email</th><th>Product</th><th>Status</th><th>Next action</th><th>Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  `;
}

// ---------- To-Do ----------
async function toggleDone(id, done) {
  const { error } = await supabase.from("todo_items").update({ done }).eq("id", id);
  if (error) console.error("toggleDone:", error.message);
}

async function saveField(id, field, value) {
  const { error } = await supabase.from("todo_items").update({ [field]: value }).eq("id", id);
  if (error) console.error("saveField:", error.message);
}

function renderTodo() {
  const total = todoItems.length;
  const done = todoItems.filter(i => i.done).length;
  document.getElementById("fill").style.width = (total ? done / total * 100 : 0) + "%";
  document.getElementById("progLabel").textContent = done + " of " + total + " done";

  const html = TIERS.map(tier => {
    const items = todoItems.filter(i => i.tier === tier.n).sort((a, b) => a.position - b.position);
    if (!items.length) return "";
    const rows = items.map(item => `
      <li class="item${item.done ? " done" : ""}" data-id="${item.id}">
        <span class="num">${item.position}</span>
        <span class="checkbox${item.done ? " checked" : ""}" data-action="toggle" data-id="${item.id}" data-done="${item.done}">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M4 12l6 6L20 6"/></svg>
        </span>
        <span class="item-body">
          <div class="item-title" contenteditable="true" data-id="${item.id}" data-field="title">${escapeHtml(item.title)}</div>
          <div class="item-note" contenteditable="true" data-id="${item.id}" data-field="note">${escapeHtml(item.note)}</div>
        </span>
      </li>
    `).join("");
    return `
      <div class="tier">
        <div class="tier-heading">${escapeHtml(tier.heading)}</div>
        <div class="tier-note">${escapeHtml(tier.note)}</div>
        <ul class="items">${rows}</ul>
      </div>
    `;
  }).join("");

  document.getElementById("todo-wrap").innerHTML = html;

  document.querySelectorAll('.checkbox[data-action="toggle"]').forEach(cb => {
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
}

initAuth();
