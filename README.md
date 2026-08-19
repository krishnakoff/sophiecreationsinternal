# Sophie

Shared outreach CRM + daily priority tracker. Plain HTML/CSS/JS frontend, [Supabase](https://supabase.com) as the backend (Postgres + auth + realtime), hosted free on GitHub Pages.

**If you're Sanjay (or Krishna) opening a Claude session in this folder**: `CLAUDE.md` is the
actual briefing — it auto-loads as instructions the moment Claude Code runs here, and covers the
owner mapping, the lead stage pipeline, the priority/emailed/called/call_response fields, the
"favourite X, mention Y" shorthand, and the Gmail outbound-scan procedure. This README is the
plain-English overview for a human skim; `CLAUDE.md` is what Claude actually follows, so that's
the one to check first if something isn't behaving as expected.

## Files

- `index.html` / `style.css` / `app.js` — the app.
- `config.js` — the two public values that connect the frontend to your Supabase project (safe to commit — see below).
- `schema.sql` — run once in Supabase to create the tables, security rules, and seed the 30 starting to-do items.

## One-time setup

1. **Create a Supabase project** at [supabase.com/dashboard](https://supabase.com/dashboard) (free tier is plenty for this).
2. **Create logins for the team**: *Authentication -> Users -> Add user*, one per person (email + password) — the admin account (`sanjay@sophiecreations.net`) first, since the schema's seed data is assigned to it by email lookup. There's no public sign-up screen on purpose — accounts are created here, by an admin, only.
3. **Run the schema**: open the project's *SQL Editor*, paste in the contents of `schema.sql`, and run it.
4. **Get your API keys**: *Project Settings -> API*.
   - Copy the **Project URL** and the **anon public** key into `config.js`. These are meant to be public — access is controlled by the row-level-security rules in `schema.sql`, not by hiding this key.
   - The **service_role** key is different: it bypasses all security rules. Never put it in `config.js`, never commit it. Only Claude uses it, and only locally, to update CRM data from chat.
5. **Enable GitHub Pages**: repo *Settings -> Pages -> Deploy from branch -> main / root*. Your team's link will be `https://<your-github-username>.github.io/<repo-name>/`.

## Editing

It's plain HTML/CSS/JS — no build step, no framework. Edit a file, commit, push; GitHub Pages redeploys automatically within a minute or two.

## Data model

- **`leads`** — one row per company, moving through a `stage`: `prospect` -> `contacted` ->
  `responded` -> `conversation` -> `sampling` -> `client` (`dead`, with an optional
  `lost_reason`, is reachable from any stage). `contacted_at` + `steps_completed` (0–4) drive
  the day 1 / 4 / 7 / 10 auto follow-up cadence shown in the "Next action" column while a lead
  is `contacted`; past that, `next_action_date`/`next_action_type` are the manual "what's next"
  fields. `prospect` -> `contacted` and `contacted` -> `responded` are flipped automatically by
  Claude scanning Gmail (see `CLAUDE.md`); `conversation`/`sampling`/`client`/`dead` are manual
  calls. A `priority` flag pins a lead to the top of the table (with a star) regardless of
  stage — for the ones worth pushing hard on, until they close or explicitly decline.
  `emailed`/`called` are simple yes/no flags, and `call_response` is free text (no fixed set of
  values) for whatever the call actually turned up. `country` is the company's country;
  `lead_owner` is a free-text "who actually reached out first" field, separate from `owner_id`
  (which just controls which tab a lead shows under) — see `CLAUDE.md` for how the two differ.
- **`todo_items`** — Sanjay's to-do list: one row per task, grouped by `tier` (1–6, matching the priority sections) and ordered by `position` within it.
- **`todo_outline`** — Krishna's to-do list: a different shape entirely, since he wanted his existing iCloud Notes outline format kept as-is rather than the tier structure above. It's a tree (`parent_id` points to the containing node, `list_style` is `none`/`numbered`/`dashed` for how that node renders in its parent's list, `content` can hold `**bold**` spans). The web app renders whichever of `todo_items`/`todo_outline` matches the account being viewed — Sanjay's tab always shows the tier view, Krishna's always shows the outline, regardless of who's looking.
- **`outbound_emails`** — one row per first-time-recipient email detected in Gmail (sender, recipient, thread, timestamp). Feeds the weekly "who emailed how many new contacts" rollup and drives the stage auto-flips above.
- All four tables have an **`owner_id`**. Everyone signed in can read every row (so you can check in on each other), but row-level security only lets you insert/update/delete rows you own. The topbar's name switcher picks whose data the page is showing; the other person's view is read-only.

All four tables are realtime-enabled, so any change — a checkbox, an edited line, a new lead, a logged email — appears for everyone with the page open, instantly, no refresh needed.
