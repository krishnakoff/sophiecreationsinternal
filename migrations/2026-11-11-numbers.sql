-- Numbers tab (Hormozi-style key figures). Two small tables:
--
-- monthly_financials: one row per calendar month. Revenue / gross profit are copied from the
--   B2C Lead Management Sheet (tab "1": Gross Profit N = before commissions, Z = after) — that
--   sheet stays the ledger and is read-only to us; these rows are a snapshot so the app can chart
--   them. opex_usd is the month's ACTUAL operating expenditure once known (from the accountant /
--   JS / bank statements); null until then. opex_breakdown holds the per-category split.
--
-- opex_budget: the recurring monthly costs we know about (rent share, staff, software...). Their
--   sum is the ESTIMATED monthly opex run-rate, used for runway / true profit until a month has an
--   actual opex figure. Edit amounts here from chat.
create table if not exists public.monthly_financials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  month date not null unique check (extract(day from month) = 1),
  orders_count integer,
  revenue_usd numeric(14, 2),
  passthrough_revenue_usd numeric(14, 2) not null default 0, -- transit revenue, excluded from GM %
  gross_profit_usd numeric(14, 2),
  gross_profit_net_usd numeric(14, 2),
  opex_usd numeric(14, 2),
  opex_breakdown jsonb not null default '{}'::jsonb,
  source text default '',
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.opex_budget (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  category text not null default 'other'
    check (category in ('rent', 'staff', 'directors', 'software', 'utilities', 'bank', 'marketing', 'professional', 'other')),
  label text not null,
  monthly_usd numeric(12, 2),
  confirmed boolean not null default false,
  basis text default '',
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists monthly_financials_touch_updated_at on public.monthly_financials;
create trigger monthly_financials_touch_updated_at before update on public.monthly_financials
  for each row execute function public.touch_updated_at();
drop trigger if exists opex_budget_touch_updated_at on public.opex_budget;
create trigger opex_budget_touch_updated_at before update on public.opex_budget
  for each row execute function public.touch_updated_at();

alter table public.monthly_financials enable row level security;
alter table public.opex_budget enable row level security;
do $$
declare t text;
begin
  foreach t in array array['monthly_financials', 'opex_budget'] loop
    execute format('drop policy if exists "authenticated read all" on public.%I', t);
    execute format('drop policy if exists "authenticated insert own" on public.%I', t);
    execute format('drop policy if exists "authenticated update own" on public.%I', t);
    execute format('drop policy if exists "authenticated delete own" on public.%I', t);
    execute format('create policy "authenticated read all" on public.%I for select using (auth.role() = ''authenticated'')', t);
    execute format('create policy "authenticated insert own" on public.%I for insert with check (auth.uid() = owner_id)', t);
    execute format('create policy "authenticated update own" on public.%I for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id)', t);
    execute format('create policy "authenticated delete own" on public.%I for delete using (auth.uid() = owner_id)', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.monthly_financials;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.opex_budget;
exception when duplicate_object then null; end $$;
