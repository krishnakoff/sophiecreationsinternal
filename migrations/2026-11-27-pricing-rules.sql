-- Client pricing rules on the CRM profile: how we price this client (markups on factory cost,
-- FX rate used, plating/metal assumptions, MOQ, mould fee, deposit and shipping terms).
-- INTERNAL ONLY — shown in the CRM profile panel; read it before quoting or repricing.
alter table public.leads
  add column if not exists pricing_rules text default '';
