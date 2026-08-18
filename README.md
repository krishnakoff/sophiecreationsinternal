# Loupe

Shared outreach CRM + daily priority tracker. Plain HTML/CSS/JS frontend, [Supabase](https://supabase.com) as the backend (Postgres + auth + realtime), hosted free on GitHub Pages.

## Files

- `index.html` / `style.css` / `app.js` — the app.
- `config.js` — the two public values that connect the frontend to your Supabase project (safe to commit — see below).
- `schema.sql` — run once in Supabase to create the tables, security rules, and seed the 30 starting to-do items.

## One-time setup

1. **Create a Supabase project** at [supabase.com/dashboard](https://supabase.com/dashboard) (free tier is plenty for this).
2. **Run the schema**: open the project's *SQL Editor*, paste in the contents of `schema.sql`, and run it.
3. **Get your API keys**: *Project Settings -> API*.
   - Copy the **Project URL** and the **anon public** key into `config.js`. These are meant to be public — access is controlled by the row-level-security rules in `schema.sql`, not by hiding this key.
   - The **service_role** key is different: it bypasses all security rules. Never put it in `config.js`, never commit it. Only Claude uses it, and only locally, to update CRM data from chat.
4. **Create logins for the team**: *Authentication -> Users -> Add user*, one per person (email + password). There's no public sign-up screen on purpose — accounts are created here, by an admin, only.
5. **Enable GitHub Pages**: repo *Settings -> Pages -> Deploy from branch -> main / root*. Your team's link will be `https://<your-github-username>.github.io/<repo-name>/`.

## Editing

It's plain HTML/CSS/JS — no build step, no framework. Edit a file, commit, push; GitHub Pages redeploys automatically within a minute or two.

## Data model

- **`leads`** — one row per company. `steps_completed` (0–4) and `mode` (`sequence` or `snoozed`) drive the day 1 / 4 / 7 / 10 outreach cadence shown in the "Next action" column.
- **`todo_items`** — one row per task, grouped by `tier` (1–6, matching the priority sections) and ordered by `position` within it.

Both tables are realtime-enabled, so any change — a checkbox, an edited line, a new lead — appears for everyone with the page open, instantly, no refresh needed.
