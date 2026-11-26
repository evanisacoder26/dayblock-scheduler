# Dayblock

An AI-assisted day planner. Brain-dump your tasks, let AI turn them into timed blocks, then drag, resize and tick them off on an 8 AM–8 PM timeline.

## Accounts

When run through the server, Dayblock requires an account:

| Page | What it does |
|---|---|
| `/signup` | Create an account (name, email, password) |
| `/login` | Log in, with an optional "keep me logged in for 30 days" |
| `/dashboard` | Home after login: today's schedule, progress, this week's hours, time by category, backlog, account settings |
| `/planner` | The planner itself; your data is saved to your account |

How it's secured:

- **Two-factor sign-in by email.** Sign-up only creates the account after the user enters a 6-digit code emailed to them. Every login needs the password *and* a fresh emailed code, unless the user ticked "Don't ask for a code on this device for 30 days". Codes expire after 10 minutes, die after 5 wrong guesses, can't be reused, and can be resent once a minute (5 times max). Changing your password un-trusts all devices.
- Passwords are hashed with scrypt (Node's built-in `crypto`) with a random salt per user; plaintext is never stored.
- Sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie. Only a SHA-256 hash of each token is stored on the server. Sessions last 7 days, or 30 with "keep me logged in".
- Logging out deletes the session on the server. Changing your password logs out all your other devices.
- Login is rate limited (8 attempts per 15 minutes per email and IP); sign-ups are limited per IP.
- Wrong password and unknown email give the same error, and take the same time.
- Writes from other websites are blocked (Origin check), and pages send a strict Content-Security-Policy and refuse to be framed.
- Each user's data is validated and stored separately; API routes, including the AI routes, require a logged-in user.

Accounts and plans are stored as JSON files in `data/` (git-ignored). Set `DATA_DIR` to store them elsewhere. When you deploy behind HTTPS, set `COOKIE_SECURE=true`.

### Sending the code emails

Set one of these in `.env` (see `.env.example`):

- **Gmail / any SMTP server**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `EMAIL_FROM`. For Gmail, `SMTP_PASS` must be an [App Password](https://myaccount.google.com/apppasswords), not your normal password.
- **Resend**: `RESEND_API_KEY` and `EMAIL_FROM` (needs a verified domain to send to addresses other than your own).

With neither set, the server runs in **development mode**: codes are printed in the server console, and the code screen says so.

Not included yet: "forgot password".

## Run it locally

Requires Node.js 22.9 or newer.

```bash
cd scheduler
npm install
cp .env.example .env      # then add a Gemini or Anthropic API key
npm start                 # http://localhost:3000
```

The key is read on the server from `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` and is never sent to the browser. If both are set, Gemini is used unless `AI_PROVIDER=claude`. The page calls two server routes:

| Route | Body | Returns |
|---|---|---|
| `POST /api/parse` | `{ text, date }` | `{ tasks: [{ title, minutes, priority, category, preferredStart }] }` |
| `POST /api/advice` | `{ summary }` | `{ advice }` |

With Gemini, both use `gemini-3.5-flash` (override with `GEMINI_MODEL`), retrying once on `gemini-flash-latest` if Google reports it's overloaded. With Claude, both use `claude-opus-5-5` at low effort with server-side refusal fallback. `/api/parse` uses structured JSON output either way, so the task list always matches the schema.

## How AI is reached

The page tries, in order:

1. **claude.ai**: when opened as a published artifact, it uses Claude through the artifact's built-in AI access (no key needed).
2. **This server**: `/api/parse` and `/api/advice`, using Gemini or Claude.
3. **Offline parser**: if neither is available (e.g. you opened `index.html` directly), a built-in rule-based parser reads durations ("2 hrs", "15m"), times ("at 3:30pm") and keywords to guess category and priority. "Ask for advice" is unavailable in this mode; the assistant tips still work because they're computed in the browser.

## Features

- Brain dump → parsed tasks → placed into open slots without overlapping. High priority goes first; tasks with a named time are pinned to it when free.
- Drag from the backlog onto the timeline, drag blocks to move them, drag a block's bottom edge to resize (15-minute snaps), click to mark done, × or drag back to the backlog to unschedule.
- **Reschedule Remaining** re-packs unfinished tasks from the current time. Meetings and finished tasks stay where they are.
- **Focus Mode** dims everything except the task happening now.
- Assistant card flags overloaded days, long stretches without a break, and high-priority backlog items, and offers to move low-priority tasks to tomorrow.
- Everything is saved in `localStorage`. **Load Sample Day** fills the current day for testing.

## Deploy to Render

The repo includes `render.yaml`, so Render can set everything up from it.

1. Push this folder to a GitHub repository (private is fine).
2. In Render, choose **New → Blueprint**, connect GitHub, and pick the repository.
3. When asked, fill in `GEMINI_API_KEY` and `RESEND_API_KEY` (and optionally `EMAIL_FROM`). Leave any you don't use blank.
4. Click **Apply**. The site goes live at `https://dayblock-XXXX.onrender.com`.

On Render the server automatically uses secure cookies and reads the visitor's real IP for rate limiting (`RENDER` is set by Render; override with `COOKIE_SECURE` / `TRUST_PROXY`).

**The free plan is a demo.** Render wipes the disk on every deploy, restart and when a free instance sleeps after ~15 minutes idle, so accounts and plans reset and everyone is logged out. The first visit after a sleep takes about a minute. To keep data, change `plan: free` to `plan: starter` in `render.yaml` and uncomment the disk and `DATA_DIR` lines.

## GitHub Pages demo

A static demo (intro page + planner, saved in the visitor's browser, no accounts or server AI) is published by `.github/workflows/pages.yml` on every push to `main`. One-time setup: **Settings → Pages → Source: GitHub Actions**. Build it locally with `node scripts/build-pages.mjs` (output in `site/`).

## Full app on GitHub Pages (Supabase)

GitHub Pages can't run `server.mjs`, so the github.io build talks to Supabase instead:

- **Supabase Auth** holds the accounts; **Postgres** (`supabase/schema.sql`) stores each user's plan, with row-level security so a user can only reach their own data, and only from a login that passed the emailed code.
- The **`dayblock-api` edge function** (`supabase/functions/dayblock-api`) sends the email codes (Resend), handles trusted devices, email/password changes and account deletion, and makes every AI call, so API keys stay server-side. It uses the same prompts as the Node server (`ai-prompts.mjs`).
- **`web/supabase-backend.js`** answers the pages' `/api/...` requests in the browser, so the HTML is identical to the localhost version.

Setup: create a Supabase project, put `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` in `.env`, then run `node --env-file=.env scripts/setup-supabase.mjs`. It creates the tables, configures sign-in, stores the API keys as function secrets, deploys the function, and writes the public `supabase.config.json`. Commit that file and push; the Pages workflow builds the full app whenever it's filled in (and the browser-only demo when it's empty).

Difference from the Node version: Supabase can't list other logged-in devices individually, so Settings offers "Log out of all other devices" instead. Free Supabase projects pause after a week without visits; resume them from the Supabase dashboard.
