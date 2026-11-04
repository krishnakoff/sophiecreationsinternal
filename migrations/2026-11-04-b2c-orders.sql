-- B2C orders: private-client deals being pushed toward "Sai Ram" (delivered AND paid).
-- Stages mirror the B2C Lead Management Sheet's CRM Stage column. The sheet stays the ledger
-- (revenue, cost, commission); this table is the action layer: who it's waiting on, the next
-- action, and what's still owed.
create table if not exists public.b2c_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  salesperson text not null default '',
  client text not null,
  contact text default '',
  item text not null default '',
  reference text default '',
  source text default '',
  stage text not null default 'design_pricing'
    check (stage in ('story', 'design_pricing', 'in_production', 'ready_to_ship', 'in_transit',
                     'delivered', 'sai_ram', 'on_hold', 'cancelled')),
  waiting_on text check (waiting_on in ('client', 'salesperson', 'factory', 'us')),
  currency text not null default 'USD' check (currency in ('USD', 'HKD')),
  invoice_amount numeric(12, 2),
  deposit_amount numeric(12, 2),
  deposit_on date,
  balance_due numeric(12, 2),
  balance_received_on date,
  promised_on date,
  next_action text default '',
  next_action_on date,
  last_update_on date,
  last_update text default '',
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists b2c_orders_touch_updated_at on public.b2c_orders;
create trigger b2c_orders_touch_updated_at before update on public.b2c_orders
  for each row execute function public.touch_updated_at();

alter table public.b2c_orders enable row level security;
drop policy if exists "authenticated read all" on public.b2c_orders;
drop policy if exists "authenticated insert own" on public.b2c_orders;
drop policy if exists "authenticated update own" on public.b2c_orders;
drop policy if exists "authenticated delete own" on public.b2c_orders;
create policy "authenticated read all" on public.b2c_orders
  for select using (auth.role() = 'authenticated');
create policy "authenticated insert own" on public.b2c_orders
  for insert with check (auth.uid() = owner_id);
create policy "authenticated update own" on public.b2c_orders
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "authenticated delete own" on public.b2c_orders
  for delete using (auth.uid() = owner_id);

grant select, insert, update, delete on public.b2c_orders to authenticated, service_role;
revoke all on public.b2c_orders from anon; -- default privileges would otherwise hand anon access
create index if not exists b2c_orders_stage_idx on public.b2c_orders(stage);

do $$ begin
  alter publication supabase_realtime add table public.b2c_orders;
exception when duplicate_object then null; end $$;
