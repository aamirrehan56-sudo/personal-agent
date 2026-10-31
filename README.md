# Personal AI Agent

Your private assistant for tasks, money, goals and social media. Australian dollars, Australian dates, Australia/Melbourne time.

**Working today (Phases 1 and 2):**

- Secure login, dashboard, AI chat with real tool calling, per-tool permissions, approvals and an audit log
- Tasks with priorities, recurring tasks and habits, missed tasks and weekly productivity reports
- Memory you can inspect, edit, export and delete
- **Finance:** manual entry and bank CSV import (no bank login needed), automatic categories that learn from your corrections, weekly and monthly budgets, bills and subscriptions with reminders, debts with payoff estimates, savings capacity, "safe to spend this week", spending insights, and weekly and monthly reports
- **Goals:** savings goals with weekly and monthly targets, on-track or behind status, realistic-date checks against your real data, suggested cutbacks, progress charts and 25/50/75/100% milestones

Social Studio (Phase 3) and Automations (Phase 4) are visible in the menu but marked as later phases; they show no fake data.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture, diagram, stack, costs and roadmap.

---

## Run it on your computer (step by step)

You need three things installed once:

1. **Node.js 22 or newer**: download the LTS version from https://nodejs.org. Check with `node -v`.
2. **Docker Desktop** (easiest way to run Postgres): https://www.docker.com/products/docker-desktop. Or install PostgreSQL 16 directly from https://www.postgresql.org/download/.
3. **Git**: https://git-scm.com/downloads.

Then open a terminal in this folder and run:

```bash
# 1. Install the code's dependencies
npm install

# 2. Create your settings file
cp .env.example .env          # Windows PowerShell: copy .env.example .env

# 3. Generate two secrets and paste them into .env
node -e "console.log('SETUP_CODE=' + require('crypto').randomBytes(16).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

Open `.env` in a text editor and:

- paste the `SETUP_CODE=...` and `ENCRYPTION_KEY=...` lines over the empty ones,
- add your Claude API key to `ANTHROPIC_API_KEY=` (create one at https://console.anthropic.com → API Keys, and add a small amount of credit; you can set a monthly spend limit there too).

```bash
# 4. Start Postgres (runs in the background)
docker compose up -d

# 5. Create the database tables
npm run migrate

# 6. Run the automated tests (should say "pass 58, fail 0")
npm test

# 7. Start the app
npm run dev
```

Open **http://localhost:3000**. The first time, you'll see "Create your account": enter your name, email, a password of 12+ characters, and the `SETUP_CODE` from `.env`. Only one account can ever be created.

To open it on your phone while on the same Wi-Fi, use `http://<your-computer's-IP>:3000`.

### Try these in AI Chat

- "Plan my day tomorrow"
- "Remind me to pay electricity next Friday"
- "What important tasks have I missed?"
- "Organise my tasks based on priority"
- "Add a daily habit: 20 minute walk at 7am"
- "Remember that I do my best focused work before 11am"
- "Delete the groceries task" (this shows an approval card, because deleting is set to "Ask me")
- "How much money can I safely spend this week?"
- "I spent $42.50 at Coles today"
- "I want to save $10,000 in six months. Is that realistic?"
- "Set my eating out budget to $60 a week" (budgets always ask for your approval)
- "Add my electricity bill: $390 every quarter, next due 3 November"
- "Where can I cut back on spending?"
- "Give me my monthly financial report"

### Importing your bank transactions

1. In your bank's app or internet banking, export transactions as **CSV** (CommBank, NAB, ANZ, Westpac, ING, Up, Macquarie all support this).
2. In the dashboard go to **Finance → Import CSV** and pick the file.
3. Check the columns it guessed (date, description, amount, or debit/credit), then press Import.
4. Re-importing the same file is safe: rows already imported are skipped.

### How the money numbers are worked out

- **Safe to spend this week** = weekly take-home pay − bills (spread evenly, so a $390 quarterly bill sets aside $30 every week) − debt repayments − what your savings goals need per week − flexible spending already this week (rent, bills, subscriptions, debt and transfers are not counted twice).
- **Weekly income** comes from your real transactions once you have 4+ weeks of them; until then it uses the take-home pay you enter in Finance → Overview.
- **Savings capacity** = average monthly income − average monthly spending over the last 90 days.
- **Goal targets** = amount left ÷ weeks (or months) left. "Behind" means you've saved less than a straight line from the start date to the target date says you should have by now.
- If there isn't enough data, the app and the AI say so instead of guessing.

Wrong category? Change it in **Finance → Transactions** and choose "always" so similar transactions get it automatically next time.

### Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app and restart automatically when code changes |
| `npm test` | Run all tests |
| `npm run migrate` | Apply new database changes |
| `npm run backup` | Save a database backup to `backups/` (needs `pg_dump`, included with Postgres) |
| `npm run build` then `npm start` | Production build and start |
| `docker compose down` | Stop Postgres (your data is kept) |

Restore a backup: `gunzip -c backups/agent-YYYYMMDD-HHMM.sql.gz | psql "$DATABASE_URL"`

---

## Choosing the AI model (cost vs smarts)

Set `AI_MODEL` in `.env`, then restart:

| Model | Approx. monthly cost at ~20 messages/day | Good for |
|---|---|---|
| `claude-opus-5-5` (default) | A$15–40 | Best planning and judgement |
| `claude-sonnet-5-5` | A$8–20 | Good balance |
| `claude-haiku-5-5` | A$1–3 | Cheapest; simple commands |

`AI_EFFORT=low` keeps thinking short and cheap; raise to `medium` for better day plans.

---

## Security in this version

- Password hashed with scrypt; never stored in plain text.
- Session cookie is httpOnly + SameSite=Strict; only a hash of the session token is stored.
- Every API change requires a custom header (CSRF protection); 5 failed logins per 15 minutes per IP are blocked.
- The Claude API key stays on the server. The browser never sees it.
- Every AI tool call is validated, permission-checked and written to the audit log (Settings → Audit log).
- Risky tools (delete task, delete memory) wait for your approval. You can change any tool to Allow, Ask me or Block in Settings.
- Stored content (task titles, notes, memory) is treated as data, not instructions, to resist prompt injection.
- Memory refuses card numbers, passwords, bank account details and tax file numbers.
- The agent has no tools to move money, make payments, send messages or publish posts. "Mark bill paid" and "add savings" only update your records.
- Budgets the AI proposes always wait for your approval. Deleting transactions also asks first.
- Bank data comes only from CSV files you export yourself. Your bank login is never requested or stored.
- `ENCRYPTION_KEY` encrypts OAuth tokens (AES-256-GCM) for the integrations coming in Phase 5.

**Keep `.env` private.** It's in `.gitignore` so it won't be uploaded to GitHub.

---

## Deploying online (when you're ready)

Recommended: **Render** (or Railway) with a managed Postgres, in the Singapore or Sydney region.

1. Push this project to a private GitHub repository.
2. On Render: New → PostgreSQL (copy its "Internal Database URL").
3. New → Web Service → pick your repo. Build command: `npm install --include=dev && npm run build`. Start command: `npm start` (the server applies database migrations automatically when it starts).
4. Add environment variables: everything from your `.env`, with `DATABASE_URL` set to Render's database URL and `COOKIE_SECURE=true`.
5. Use a new `SETUP_CODE` for production, create your account, then you can leave the code as is (setup is disabled once an account exists).

---

## Project layout

```
src/server.ts            starts the server (runs migrations first)
src/app.ts               builds the app
src/routes.ts            dashboard API
src/auth/                login, sessions, CSRF, rate limiting
src/services/ai/         agent loop, tools, permissions, approvals
src/services/tasks/      tasks, recurrence, overview, weekly report
src/services/memory/     agent memory
src/services/finance/    transactions, CSV import, categories, budgets, bills, debts, reports
src/services/goals/      savings goals, targets, advice, milestones
src/services/audit/      audit log
migrations/              database schema
public/                  dashboard (HTML, CSS, JS)
tests/                   automated tests
```

### Adding a new AI tool (how the app grows)

1. Write the logic in a service (e.g. `src/services/finance/finance.ts`).
2. Add a `tool({...})` entry in `src/services/ai/tools.ts` with a Zod schema, a default permission and a one-line summary. Set `alwaysRequireApproval: true` for anything that publishes, sends or touches money.
3. Add a test in `tests/`.

The agent picks it up automatically, and it appears in Settings → Permissions.
