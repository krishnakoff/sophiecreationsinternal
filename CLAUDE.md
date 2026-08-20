# Sophie — shared CRM + priority tracker

This repo is the Sophie web app (`index.html` / `style.css` / `app.js`, static, hosted on
GitHub Pages, backed by Supabase). It's also driven directly from the terminal: instead of
using the web UI, describe a lead or to-do change in chat and update the database directly.
Because `todo_items` and `leads` are realtime-enabled, the change shows up on the live web app
within a second or two — no redeploy needed.

## Roles: Krishna is super admin, Sanjay is a full user

Krishna is the super admin. Sanjay gets every feature the platform has — the same CRM stage
model, priority flags, emailed/called tracking, clickable stat-card filtering, outbound scanning,
everything — applied to his own data, exactly like Krishna's. Nothing in this app is gated by
which of them is asking; the feature set is identical, only the data is scoped per owner (see
"Whose data am I writing?" below).

The one thing that's reserved for Krishna: changes to the platform itself — `index.html`,
`app.js`, `style.css`, `schema.sql`, RLS policies, or anything else that changes how the app
behaves for everyone. If you're in a session with Sanjay and he asks for a new feature, a schema
change, or a fix to how something works (as opposed to "add this lead" / "update my to-do" /
"check my outbound," which are just his own data), say so and hold off until Krishna directs it
— don't make the change on Sanjay's say-so alone, even if it seems like a small tweak.

## This backend already exists — do not re-provision it

There is exactly **one** Supabase project behind this app, already fully set up:
`config.js` already has the real project URL and anon key (committed, live, pushed),
`schema.sql` has already been run against it (both tables, RLS policies, and the seed data all
exist), and login accounts for both Sanjay and Krishna already exist under
*Authentication -> Users*. If you (or a fresh Claude session with no memory of this) are asked
to "finish setting up Supabase," the actual remaining step is almost certainly just **getting
the `.env` file below onto this machine** — not creating a new project, not re-running
`schema.sql`, and not creating new accounts. Re-running `schema.sql` is safe (it's idempotent),
but creating a second Supabase project would split the data in two and break the shared
CRM/to-do model the whole app depends on.

## Local setup required

This only works if a `.env` file exists in this directory (never commit it — it's gitignored)
with:

```
DATABASE_URL=...
SUPABASE_URL=https://grkqbudhjxxewrhpdjtz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

These are the same three values used everywhere else this project runs — get them from
whoever set up your machine (don't regenerate/rotate them without checking, since that would
break the other person's local setup too). The service_role key bypasses row-level security
entirely — treat it like a password. Never print it in full, never commit it, never put it in
`config.js` (that file only ever gets the public anon key).

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

**`owner_id` vs `lead_owner`** on `leads` are different things. `owner_id` is the technical field
above — whose tab a lead shows under, and (in principle, though all writes currently go through
this service_role key anyway) who's allowed to edit it. `lead_owner` is a free-text business
attribution field — literally whoever reached out to that company first, as a name. These
usually match, but not always: a lead can be jointly worked (`lead_owner: "Krishna & Sanjay"`)
while still needing a single `owner_id` for tab-filtering purposes — pick either person's id in
that case, it's just a technical default, `lead_owner` is the fact that actually matters. When
told "X is my lead" / "Y is Sanjay's", that's telling you `lead_owner` (and normally `owner_id`
too, unless it's a joint one).

## Adding a CRM lead

**This CRM is strictly for B2B retail/wholesale clients — companies buying jewelry to resell or
manufacture with.** Never add a B2C individual customer here, even if they show up in Gmail with
a sales invoice, a costing email, or an active order (e.g. Chloe's SI-numbered invoice emails to
individuals like Jeetu Ramchandani, Jasmine Mehta, Jyoti Bhagchandani — these are personal
customers, not retail-client leads). B2C customer tracking lives in Krishna's to-do outline
instead (see the B2C Orders section there), not in `leads`. If a Gmail scan turns up a personal
sale, at most flag it back ("saw an invoice for X, might be worth checking off your to-do") —
don't create or touch a `leads` row for it.

Table `public.leads`. A lead moves through `stage`:

`prospect` -> `contacted` -> `conversation` -> `sampling` -> `client`
(`dead` is reachable from any stage, with an optional `lost_reason`).

There's no separate `responded` stage — the moment a reply lands, a lead goes straight from
`contacted` to `conversation` (once they've replied, you're already talking to them, so pausing
on an intermediate "responded" stage didn't add anything). `responded_at` still gets stamped as
a plain timestamp of when that first reply came in, independent of stage.

- **`prospect`** — identified as worth reaching out to (by research, Apollo, Google, a
  referral), but no email has gone out yet. This is the default for anything added from a
  "here's a company we should target" conversation.
- **`contacted`** — the first outbound email has actually gone out. Don't set this by hand from
  a chat request like "add this lead" — it gets set automatically by the outbound-email scan
  below, which stamps `contacted_at` and starts the day 1/4/7/10 cadence
  (`steps_completed`, 0–4, tracks how far through it they are).
- **`conversation` / `sampling` / `client`** — manual judgment calls, except the initial
  `contacted` -> `conversation` flip on a reply (see the Gmail scan below, which is mechanical).
  Advance these when told to ("sample's out the door" -> `sampling`; "they signed" -> `client`).
  `next_action_date` + `next_action_type` (`"email"` or `"call"`) hold the manual next step once
  a lead is past `contacted`.
- **`revive`** — a signed `client` who's gone quiet (no repeat order in a while) but hasn't
  declined — set this when told to keep actively pushing them for another order ("they haven't
  reordered in months, let's push" -> `revive`). From `revive` a lead goes back to `client` once
  they order again, or to `dead` if you're told they genuinely won't reorder. Same
  `next_action_date`/`next_action_type` manual-next-step fields apply here as in
  `conversation`/`sampling`.
- **`dead`** — set `lost_reason` if you're told why (no budget, went silent, chose a competitor,
  not a fit).

**`priority`** (boolean, default false) is separate from stage — set it when told a lead is
worth pushing hard on ("favourite this one", "don't let this go cold"). It pins the lead to the
top of the table with a star, regardless of what stage it's in. Leave it set until the lead
closes (`client`) or explicitly declines (`dead` + a real reason) — don't clear it just because
follow-up is slow or they've gone quiet for a bit. Put the *why* in `notes` when you set it
("perfect match, push to close") so the reason is visible, not just the flag.

**A common request pattern**: "favourite `<company/website>` and mention `<product detail>`" —
possibly for a company that isn't in `leads` yet. Handle it as:
- If no matching row exists (match by domain in `email`, or company name), create one at
  `stage: "prospect"` (don't assume an email's gone out just because it was favourited).
  If you don't have an actual contact email for them, leave `email` blank and say so back to
  the person rather than guessing one — don't fabricate contact details.
- Set `priority: true` and put the mentioned product detail in `product` (that's what "mention
  X" means — it's the specific product/material angle for that lead, not a general note).
- If the row already exists, update `product` with the new detail rather than overwriting a
  good `notes` entry that's already there.

**`emailed`** / **`called`** (booleans, default false) are simple yes/no flags for whether
outreach on that channel has actually happened — kept in sync with stage where obvious (e.g.
`emailed` flips true the moment stage leaves `prospect`), but also settable directly from a
quick chat update ("called Anup, no answer") without needing a full stage change.

**`call_response`** (free text, no fixed list) holds what a call actually turned up — e.g. "no
connection", "receptionist said no", "manager said no", "good convo with manager, follow up", or
anything else you're told. Don't constrain this to a preset enum; just record what you're given.
When you're told about a call, stamp `called_at` = the date it happened (today, if not
specified) — that's what the "Outbound calls this week" widget counts against, the same way
`outbound_emails.sent_at` drives the email count.

**`country`** (free text) is just the company's country — keep it to the country, not a full
address (if you're given a city too, put that in `notes` instead).

Insert a new prospect via the REST API with the service_role key:

```bash
SUPABASE_URL=$(grep ^SUPABASE_URL .env | cut -d= -f2-)
SERVICE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY .env | cut -d= -f2-)
curl -s -X POST "$SUPABASE_URL/rest/v1/leads" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{
    "owner_id": "<the chatting person'"'"'s id>", "lead_owner": "Krishna",
    "company": "...", "country": "...", "contact": "...", "email": "...", "product": "...",
    "stage": "prospect",
    "notes": "..."
  }'
```

Updating an existing lead (advancing its stage, setting a manual next action, marking
dead+reason) is a PATCH to `$SUPABASE_URL/rest/v1/leads?id=eq.<id>` with just the changed
fields.

## Detecting outbound emails (Gmail scan)

When asked to check outbound activity (e.g. "how'd outbound look this week", "log this week's
emails"), this only works from a session with that person's Gmail connected via MCP — it reads
their own Sent mail, not a shared inbox. Run this on request; it isn't scheduled.

For each message in Sent since the last scan (ask what date to start from the first time; after
that, use the latest `sent_at` already in `outbound_emails` for that owner):

1. **Skip replies.** Only count a message if it's the first message in its thread — i.e. this
   person sent it, nobody emailed them first. A reply to an inbound email is not an outbound
   attempt.
2. **Check if the recipient is new.** Search Sent for `to:<address>` — if this message is the
   only (or earliest) one to that address, it's a first-time outbound attempt.
3. **Check it actually delivered.** Search for a `mailer-daemon@googlemail.com` bounce
   ("Delivery Status Notification (Failure)") tied to that address before counting it. A bounced
   send never reached anyone — don't log it as an outbound attempt, and if a lead was already
   created from it, revert it to `prospect` (clear `contacted_at`, set `emailed` back to false)
   and note the bad address in `notes` rather than leaving a false `contacted` on record.
4. **Log it**: insert into `outbound_emails` — `owner_id` (the mailbox owner), `recipient_email`,
   `thread_id`, `sent_at`. Match `lead_id` if the recipient email already exists on a `leads`
   row for that owner.
5. **Flip stage if there's a matching lead**: `prospect` -> `contacted` (stamp `contacted_at` =
   the send date, `steps_completed` = 1). If there's no matching lead at all, don't invent one —
   flag it back to the person ("emailed X at newcompany.com, no lead on file — add it?") rather
   than silently creating a CRM entry for an address you don't have context on.
6. **Check for replies** on threads already in `contacted` stage: if anything after the first
   outbound message is from someone other than the account owner, flip that lead straight to
   `conversation` (there's no intermediate `responded` stage) and stamp `responded_at`. This
   stage flip is mechanical (reply exists or it doesn't) — don't read the reply's content to
   judge quality or sentiment. If the thread shows real back-and-forth (multiple replies, new
   people looped in, a catalog/samples request), reflect that in `notes` — e.g. who else got
   added to the thread — since that context is exactly what makes `conversation` the right call
   rather than just noise.

### Scanning more broadly for lead developments (not just this week's outbound)

When asked to check for "any updates" over some period (not specifically "outbound this week"),
search across all mail, not just Sent — `after:YYYY/MM/DD` with no `in:` restriction — since a
development can show up as a reply landing in the inbox, not just a new send. Walk every thread
touching a company already in `leads`, and apply the same rules as above: new first-time sends
get logged and flip `prospect` -> `contacted`; a reply on a `contacted` lead flips it to
`conversation` with the new contacts/context noted. Ignore internal/operational mail (invoices,
vendor support threads, meeting-notes bots) unless it's clearly about a specific lead's deal.

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/outbound_emails" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner_id": "<id>", "recipient_email": "...", "lead_id": "<id or null>", "thread_id": "...", "sent_at": "ISO timestamp"}'
```

The web app's "Outbound email this week" widget and the CRM stage cards read straight off this
table and `leads.stage` — no further wiring needed once these are logged correctly. The
"Outbound calls this week" widget next to it reads `leads.called_at` instead (see `called_at`
above) since there's no call log table — just the latest call date per lead.

## Checking Apollo for double-email risk (read-only audit)

When asked to check whether manually-emailed contacts might also get an automated Apollo email
(so nobody gets double-emailed), or whether anyone already `conversation`/`sampling`/`client`
is still sitting in a cold sequence: **only use read tools** (`apollo_contacts_search`,
`apollo_emailer_campaigns_search`) — never pause, remove, or approve anything in Apollo unless
separately asked to.

**Don't trust email wording to tell manual from Apollo-sent.** Apollo can draft fully
personalized, non-templated copy per contact (it researches each account and writes custom
hooks) — a "manual-looking" email in Gmail can still be an Apollo `auto_email` step that just
fired. The only reliable signal is `apollo_contacts_search` on that email/company: check
`contact_campaign_statuses` for an `active` status, which `emailer_campaign_id`, and
`current_step_position` — then look up that sequence's own `active` flag and its
`emailer_steps` to see what step is next and whether it's an `auto_email` (fires on its own) or
a `call`/`manual_email` step (needs a human to act). A contact idling at a `call` step with an
`auto_email` step after it will still auto-send once that call is marked done — flag that, it's
a live risk even though nothing's firing today.

Cross-check both directions: every contact manually emailed in the lookback window, and every
CRM lead already at `conversation`/`sampling`/`client` (sequences should only ever touch
`prospect`/early `contacted` leads). Report exactly what you find — company, sequence name,
current step, what's next — and let the person decide whether to remove/pause it themselves.

## Adding/updating a to-do item

**Everyone's to-do list lives in the same table, `public.todo_outline`, in the same nested
format.** Krishna originally wanted his existing iCloud Notes outline kept as-is rather than
switched to a tier structure, so that became the shared format for both of them — the web app
renders identically for whichever account's tab is open, scoped only by `owner_id`. (There's a
legacy `public.todo_items` table — a flat, tier-grouped list Sanjay used before his to-do list
was migrated into this same outline format. It's no longer read or written by the app; don't use
it for new work.)

A tree, not a flat list. Every row has:
- `parent_id` — the containing node, or `null` for a top-level section (e.g. "B2B Client",
  "Operations"). A section like "MBM" or "KA" is itself a node nested one level under
  "B2B Client", not a separate top-level entry.
- `list_style` — `"none"` (a heading/paragraph — no marker, not checkable), `"numbered"`, or
  `"dashed"`. This describes how the node renders *within its parent's list* — match whatever
  style the surrounding siblings already use.
- `position` — order among siblings sharing the same `parent_id`, 0-based.
- `content` — the text. Wrap a span in `**double asterisks**` for bold (rendered as `<strong>`,
  matches how the app's contenteditable bold round-trips). Only use bold where the source
  actually had it (section titles like "Operations" are bold; plain client names like "MBM" are
  not).
- `done` — only meaningful when `list_style != "none"`. Checking an item in the app collapses it
  into a "Completed" section at the bottom (view-only grouping, doesn't change `parent_id`).

To add something you're told about ("add X to my to-do under Operations"): find the target
section's `id` (scoped to the chatting person's `owner_id`), then find the max `position` among
its existing children:

```bash
curl -s "$SUPABASE_URL/rest/v1/todo_outline?parent_id=eq.<parent-id>&select=position&order=position.desc&limit=1" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
```

then insert as a new child, matching the parent's existing list style:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/todo_outline" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner_id": "<the chatting person'"'"'s id>", "parent_id": "<parent-id>", "position": <max+1>, "list_style": "dashed", "content": "..."}'
```

A brand new top-level section is the same insert with `"parent_id": null`. Editing content or
toggling `done` is a PATCH to `todo_outline?id=eq.<id>` with just the changed field.

## Other rules

- Never touch the seed/schema RLS policies without checking with Krishna first — they're what
  keep each person's writes scoped to their own rows.
- Read `schema.sql` for the full column/constraint reference before improvising a field.
