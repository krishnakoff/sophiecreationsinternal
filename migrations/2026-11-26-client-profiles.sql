-- Client profiles on CRM leads: what each client buys, samples they hold on memo,
-- every contact person, and the shipping profiles we ship to (MBM alone has three).
-- Filled from chat / Gmail research (see CLAUDE.md "Client profiles"); shown in the
-- expandable profile panel under each company on the CRM tab.
alter table public.leads
  add column if not exists legal_name text default '',
  add column if not exists product_categories text[] not null default '{}',
  add column if not exists samples_on_memo text default '',
  -- [{ "name", "role", "email", "phone" }] in priority order (contact person 1, 2, ...)
  add column if not exists contacts jsonb not null default '[]'::jsonb,
  -- [{ "label", "company_name", "contact_name", "contact_number", "email",
  --    "address_line1", "address_line2", "city", "state", "postal_code", "country", "notes" }]
  add column if not exists shipping_addresses jsonb not null default '[]'::jsonb,
  add column if not exists billing_address text default '';
