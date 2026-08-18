# Sophie — shared CRM + priority tracker

This repo is the Sophie web app (`index.html` / `style.css` / `app.js`, static, hosted on
GitHub Pages, backed by Supabase). It's also driven directly from the terminal: instead of
using the web UI, describe a lead or to-do change in chat and update the database directly.
Because `todo_items` and `leads` are realtime-enabled, the change shows up on the live web app
within a second or two — no redeploy needed.

## Local setup required

This only works if a `.env` file exists in this directory (never commit it — it's gitignored)
with:

```
DATABASE_URL=...
SUPABASE_URL=https://grkqbudhjxxewrhpdjtz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

The service_role key bypasses row-level security entirely — treat it like a password. Never
print it in full, never commit it, never put it in `config.js` (that file only ever gets the
public anon key).

## Whose data am I writing?

Both tables have an `owner_id` (uuid). The two accounts:

| Name    | owner_id                              |
|---------|----------------------------------------|
| Sanjay  | `cd66a924-67ec-4ecf-90a9-54edc57d3966` |
| Krishna | `87133383-89c3-468e-96b5-1cce2455edc7` |

**Before writing anything, confirm which person is chatting right now** (ask if it isn't
obvious from context) and use their `owner_id` on every insert/update. Never write to the other
person's `owner_id` unless they explicitly say the item belongs to that person — e.g. "add this
to Sanjay's list" while Krishna is chatting.

Reads (`select`) can freely cross both owners — that's the point, so either of you can check in
on the other's data. Writes must stay scoped to whoever is actually chatting.

## Adding a CRM lead

Table `public.leads`. Insert via the REST API with the service_role key:

```bash
SUPABASE_URL=$(grep ^SUPABASE_URL .env | cut -d= -f2-)
SERVICE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY .env | cut -d= -f2-)
curl -s -X POST "$SUPABASE_URL/rest/v1/leads" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{
    "owner_id": "<the chatting person'"'"'s id>",
    "company": "...", "contact": "...", "email": "...", "product": "...",
    "added_date": "YYYY-MM-DD",
    "steps_completed": 0,
    "mode": "sequence",
    "status": "active",
    "notes": "..."
  }'
```

Field notes:
- `mode`: `"sequence"` (auto day 1/4/7/10 email→call→email→call cadence from `added_date`) or
  `"snoozed"` (manually set `next_action_date` + `next_action_type` instead).
- `steps_completed`: 0–4, how far through the sequence they are.
- `status`: `"active"`, `"dead"`, or `"client"`.
- Updating an existing lead (marking a step done, snoozing, closing as client/dead) is a PATCH
  to `$SUPABASE_URL/rest/v1/leads?id=eq.<id>` with just the changed fields.

## Adding/updating a to-do item

Table `public.todo_items`, grouped into 6 tiers matching the app's sections:

1. Collect money already earned
2. Close warm sales already in motion
3. Two-minute habits that protect everything above
4. Keep the MBM pipeline moving
5. Build leverage that multiplies future sales
6. Bigger, slower bets

Pick the tier that matches what's being added. `position` orders items within a tier for that
owner — query the current max and add 1:

```bash
curl -s "$SUPABASE_URL/rest/v1/todo_items?owner_id=eq.<id>&tier=eq.<n>&select=position&order=position.desc&limit=1" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
```

then insert:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/todo_items" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner_id": "<id>", "tier": <n>, "position": <max+1>, "title": "...", "note": "...", "done": false}'
```

Marking done / editing title-note is a PATCH to `todo_items?id=eq.<id>`.

## Other rules

- Never touch the seed/schema RLS policies without checking with Krishna first — they're what
  keep each person's writes scoped to their own rows.
- Read `schema.sql` for the full column/constraint reference before improvising a field.
