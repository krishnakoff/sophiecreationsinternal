-- Outreach contact list: every domain / address / company outbound must NOT cold-email
-- (clients, active conversations, people who replied, opted out or blocked us, suppliers,
-- internal, dead addresses). Doubles as a high-level "who have we spoken to" view; the
-- 'replied' group is the re-engagement pool. Shown in a collapsed section on the CRM tab.
create table if not exists public.outreach_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  entry text not null unique,
  kind text not null default 'domain' check (kind in ('domain', 'email', 'company')),
  category text not null
    check (category in ('client', 'active', 'replied', 'opted_out', 'blocked', 'supplier', 'internal', 'dead_address')),
  company text default '',
  reason text default '',
  last_activity_on date,
  source text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists outreach_contacts_touch_updated_at on public.outreach_contacts;
create trigger outreach_contacts_touch_updated_at before update on public.outreach_contacts
  for each row execute function public.touch_updated_at();

alter table public.outreach_contacts enable row level security;
drop policy if exists "authenticated read all" on public.outreach_contacts;
drop policy if exists "authenticated insert own" on public.outreach_contacts;
drop policy if exists "authenticated update own" on public.outreach_contacts;
drop policy if exists "authenticated delete own" on public.outreach_contacts;
create policy "authenticated read all" on public.outreach_contacts
  for select using (auth.role() = 'authenticated');
create policy "authenticated insert own" on public.outreach_contacts
  for insert with check (auth.uid() = owner_id);
create policy "authenticated update own" on public.outreach_contacts
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "authenticated delete own" on public.outreach_contacts
  for delete using (auth.uid() = owner_id);

grant select, insert, update, delete on public.outreach_contacts to authenticated, service_role;
revoke all on public.outreach_contacts from anon;
create index if not exists outreach_contacts_category_idx on public.outreach_contacts(category);
