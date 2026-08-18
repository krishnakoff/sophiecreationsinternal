-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New query).
-- Creates both tables, enables realtime, and locks writes to signed-in users only.

create extension if not exists pgcrypto;

-- ---------- leads (Outreach CRM) ----------
-- stage lifecycle: prospect -> contacted -> responded -> conversation -> sampling -> client
-- (dead is reachable from any stage). contacted_at drives the day 1/4/7/10 auto follow-up
-- cadence; next_action_date/next_action_type are the manual "what's next" fields once a lead
-- is past the auto-cadence stage (responded/conversation/sampling).
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) default auth.uid(),
  company text not null,
  contact text default '',
  email text default '',
  product text default '',
  added_date date not null default current_date,
  contacted_at date,
  responded_at timestamptz,
  steps_completed int not null default 0,
  next_action_date date,
  next_action_type text check (next_action_type in ('email', 'call')),
  stage text not null default 'prospect'
    check (stage in ('prospect', 'contacted', 'responded', 'conversation', 'sampling', 'client', 'dead')),
  lost_reason text,
  priority boolean not null default false,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- outbound_emails (per-person log of first-time-recipient emails) ----------
-- Populated by Claude scanning Gmail on request (see CLAUDE.md) — not written by the web app.
-- Drives the weekly "who reached out to how many people" rollup and flips a lead from
-- prospect -> contacted (first outbound) and contacted -> responded (a reply lands in the thread).
create table if not exists public.outbound_emails (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  recipient_email text not null,
  lead_id uuid references public.leads(id) on delete set null,
  thread_id text,
  sent_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ---------- todo_items (Priority list) ----------
create table if not exists public.todo_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  tier int not null,
  position int not null,
  title text not null,
  note text default '',
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- keep updated_at fresh ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_touch_updated_at on public.leads;
create trigger leads_touch_updated_at before update on public.leads
  for each row execute function public.touch_updated_at();

drop trigger if exists todo_items_touch_updated_at on public.todo_items;
create trigger todo_items_touch_updated_at before update on public.todo_items
  for each row execute function public.touch_updated_at();

-- ---------- row level security: everyone signed in can read everything; you can only write your own rows ----------
alter table public.leads enable row level security;
alter table public.todo_items enable row level security;
alter table public.outbound_emails enable row level security;

drop policy if exists "authenticated full access" on public.leads;
drop policy if exists "authenticated read all" on public.leads;
drop policy if exists "authenticated insert own" on public.leads;
drop policy if exists "authenticated update own" on public.leads;
drop policy if exists "authenticated delete own" on public.leads;
create policy "authenticated read all" on public.leads
  for select using (auth.role() = 'authenticated');
create policy "authenticated insert own" on public.leads
  for insert with check (auth.uid() = owner_id);
create policy "authenticated update own" on public.leads
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "authenticated delete own" on public.leads
  for delete using (auth.uid() = owner_id);

drop policy if exists "authenticated full access" on public.todo_items;
drop policy if exists "authenticated read all" on public.todo_items;
drop policy if exists "authenticated insert own" on public.todo_items;
drop policy if exists "authenticated update own" on public.todo_items;
drop policy if exists "authenticated delete own" on public.todo_items;
create policy "authenticated read all" on public.todo_items
  for select using (auth.role() = 'authenticated');
create policy "authenticated insert own" on public.todo_items
  for insert with check (auth.uid() = owner_id);
create policy "authenticated update own" on public.todo_items
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "authenticated delete own" on public.todo_items
  for delete using (auth.uid() = owner_id);

drop policy if exists "authenticated read all" on public.outbound_emails;
drop policy if exists "authenticated insert own" on public.outbound_emails;
drop policy if exists "authenticated update own" on public.outbound_emails;
drop policy if exists "authenticated delete own" on public.outbound_emails;
create policy "authenticated read all" on public.outbound_emails
  for select using (auth.role() = 'authenticated');
create policy "authenticated insert own" on public.outbound_emails
  for insert with check (auth.uid() = owner_id);
create policy "authenticated update own" on public.outbound_emails
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "authenticated delete own" on public.outbound_emails
  for delete using (auth.uid() = owner_id);

create index if not exists leads_owner_id_idx on public.leads(owner_id);
create index if not exists todo_items_owner_id_idx on public.todo_items(owner_id);
create index if not exists outbound_emails_owner_id_idx on public.outbound_emails(owner_id);
create index if not exists outbound_emails_sent_at_idx on public.outbound_emails(sent_at);
create index if not exists outbound_emails_recipient_idx on public.outbound_emails(recipient_email);

-- ---------- realtime: push live changes to every connected browser ----------
alter publication supabase_realtime add table public.leads;
alter publication supabase_realtime add table public.todo_items;
alter publication supabase_realtime add table public.outbound_emails;

-- ---------- seed the 30 priority items (safe to run once; skipped if already seeded) ----------
-- Requires the admin account (Sanjay) to already exist (Authentication -> Users -> Add user, email sanjay@sophiecreations.net).
insert into public.todo_items (owner_id, tier, position, title, note, done)
select (select id from auth.users where email = 'sanjay@sophiecreations.net'), tier, position, title, note, done
from (values
  (1, 1, 'Invoice MBM for the display stands', 'Quotation already sent — stands are ready, just waiting on payment.', false),
  (1, 2, 'Invoice Chandra and collect her deposit', 'Necklace drawings are done — issue the invoice and take the deposit.', false),
  (1, 3, 'Collect Kamlesh''s strap and send his invoice', 'AP watch strap in 18K rose gold — collect and bill it.', false),
  (1, 4, 'Collect deposit on the confirmed watch boxes', '16 styles confirmed — get the deposit locked in.', false),
  (1, 5, 'Settle Hemal''s balance so delivery can release', 'Delivery''s on hold — resolve the balance conversation first.', false),
  (1, 6, 'Get Ramesh Nandwani''s bangle out the door', 'Delivery date''s already passed — close this out.', false),

  (2, 1, 'Confirm and close Anup''s watches', 'He''s chosen a few — get the confirmation.', false),
  (2, 2, 'Send Anup a quote on the 1ct diamond necklace', 'It''s already on his books to get.', false),
  (2, 3, 'Get Anmol''s diamond options to Renu', 'For her solitaire and ring band — a few nice pieces are ready to offer.', false),
  (2, 4, 'Follow up on Meera Kam''s pink diamond ring', 'Source the stone and keep it moving.', false),
  (2, 5, 'Contact Jeetu about jewellery', 'Warm, unqualified — a quick call to size it up.', false),
  (2, 6, 'Follow up with Rajesh Bhojwani', 'He wants to buy — don''t let this go cold.', false),
  (2, 7, 'Sell the TJC silver stock sitting in GC', 'Inventory sitting idle — convert it to cash.', false),
  (2, 8, 'Chase Anmol for the Raveena Parvani update', 'Quick check-in to see where this stands.', false),

  (3, 1, 'Fix a wake time and be at your desk by 9:30', '7:30am wake, 9:30am start — make it non-negotiable.', false),
  (3, 2, 'Plan the day for 10 minutes each morning', 'In order of dollar impact — this list is the input.', false),
  (3, 3, 'Set fixed phone-check windows', 'e.g. 12:30 and evening — instead of all day.', false),
  (3, 4, 'Stop defaulting to WhatsApp for anything that needs a record', 'Invoices, confirmations, payment asks — keep those trackable.', false),

  (4, 1, 'Check the watch box renderings on your laptop', 'Flagged as your action item from yesterday''s MBM meeting.', false),
  (4, 2, 'Visit the jewelry box factory this week', 'Also from yesterday''s meeting — shipments are tracking for early September.', false),
  (4, 3, 'Send Ranvir the new product images and styles', 'Keeps the line expanding beyond the current 16 styles.', false),
  (4, 4, 'Push Liwan for final box pricing', 'Confirm pricing and the sample delivery date.', false),

  (5, 1, 'Hire 1–2 commission-only salespeople', 'Outbound stops being bottlenecked on you alone.', false),
  (5, 2, 'Scope 2–3 new products for your existing clients', 'Includes the new ring/collection line — use AI tools to speed up design.', false),
  (5, 3, 'Set a daily outbound number and track it', 'e.g. 5 new contacts a day — make outreach a habit, not a mood.', false),
  (5, 4, 'Get retail-store videography going', 'Cheap asset that compounds foot traffic over time.', false),

  (6, 1, 'Progress the new bank loan', 'Deepu''s introduction — unlocks capital for inventory and growth.', false),
  (6, 2, 'Scout pop-up store / storefront locations', 'Where to book, what it costs.', false),
  (6, 3, 'Get a lawyer engaged', 'Formalize the commission structures and loan terms before they scale.', false),
  (6, 4, 'Explore client segments beyond your current base', 'Most clients are Indian — test other nationalities and markets.', false)
) as seed(tier, position, title, note, done)
where not exists (select 1 from public.todo_items);
