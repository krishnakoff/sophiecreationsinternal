-- Numbers tab v2: bank-statement actuals per month + client/receivable snapshots.
--
-- monthly_financials gains the month's bank-statement totals (all company accounts: Airwallex,
-- Wing Lung, China CITIC; internal transfers and FX conversions excluded):
--   opex_usd                 operating costs EXCLUDING director draws (rent, staff incl. Fitaye
--                            base, software, utilities, bank fees, professional, marketing,
--                            shipping, tax, unidentified other)
--   director_draws_usd       payments to Sanjay / Anmol / Krishna personally
--   cogs_paid_usd            factory / goods payments (cash basis)
--   receipts_usd             money received from clients
--   loan_repayments_usd      loan principal + interest
--   unidentified_cheques_usd Wing Lung cheques with no payee on the statement (inside opex_usd
--                            until identified)
-- numbers_snapshots: small JSON snapshots computed from the B2C Lead Management Sheet (client
-- concentration, order cycle, unpaid invoices), keyed by name.
alter table public.monthly_financials add column if not exists director_draws_usd numeric(14, 2);
alter table public.monthly_financials add column if not exists cogs_paid_usd numeric(14, 2);
alter table public.monthly_financials add column if not exists receipts_usd numeric(14, 2);
alter table public.monthly_financials add column if not exists loan_repayments_usd numeric(14, 2);
alter table public.monthly_financials add column if not exists unidentified_cheques_usd numeric(14, 2);
alter table public.monthly_financials add column if not exists opex_source text default '';

create table if not exists public.numbers_snapshots (
  key text primary key,
  owner_id uuid not null references auth.users(id) default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  as_of date not null default current_date,
  source text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists numbers_snapshots_touch_updated_at on public.numbers_snapshots;
create trigger numbers_snapshots_touch_updated_at before update on public.numbers_snapshots
  for each row execute function public.touch_updated_at();
alter table public.numbers_snapshots enable row level security;
drop policy if exists "authenticated read all" on public.numbers_snapshots;
drop policy if exists "authenticated insert own" on public.numbers_snapshots;
drop policy if exists "authenticated update own" on public.numbers_snapshots;
drop policy if exists "authenticated delete own" on public.numbers_snapshots;
create policy "authenticated read all" on public.numbers_snapshots for select using (auth.role() = 'authenticated');
create policy "authenticated insert own" on public.numbers_snapshots for insert with check (auth.uid() = owner_id);
create policy "authenticated update own" on public.numbers_snapshots for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "authenticated delete own" on public.numbers_snapshots for delete using (auth.uid() = owner_id);
grant select, insert, update, delete on public.numbers_snapshots to authenticated, service_role;
revoke all on public.numbers_snapshots from anon;
do $$ begin
  alter publication supabase_realtime add table public.numbers_snapshots;
exception when duplicate_object then null; end $$;
