-- Ideas board: things Krishna/Sanjay want to build or try later (automations, process ideas),
-- with an optional example (e.g. a message that inspired it). Company-wide like team_members:
-- everyone signed in can read; you can only write your own rows. Added from chat (CLAUDE.md "Ideas").
create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  title text not null,
  area text default '',            -- e.g. "B2B + B2C", "CRM / ERP", "Ops"
  details text default '',
  example text default '',         -- a sample message / reference that inspired the idea
  status text not null default 'idea' check (status in ('idea', 'planned', 'in_progress', 'done', 'parked')),
  position numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists ideas_touch_updated_at on public.ideas;
create trigger ideas_touch_updated_at before update on public.ideas
  for each row execute function public.touch_updated_at();

alter table public.ideas enable row level security;
drop policy if exists "authenticated read all" on public.ideas;
drop policy if exists "authenticated insert own" on public.ideas;
drop policy if exists "authenticated update own" on public.ideas;
drop policy if exists "authenticated delete own" on public.ideas;
create policy "authenticated read all" on public.ideas
  for select using (auth.role() = 'authenticated');
create policy "authenticated insert own" on public.ideas
  for insert with check (auth.uid() = owner_id);
create policy "authenticated update own" on public.ideas
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "authenticated delete own" on public.ideas
  for delete using (auth.uid() = owner_id);

grant select, insert, update, delete on public.ideas to authenticated, service_role;
revoke all on public.ideas from anon;

do $$ begin
  alter publication supabase_realtime add table public.ideas;
exception when duplicate_object then null; end $$;
