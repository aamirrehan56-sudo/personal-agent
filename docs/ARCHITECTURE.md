# Personal AI Agent: architecture and plan

One private web app for one person (you), running in Australia/Melbourne time with AUD amounts. You talk to the agent in the dashboard; the agent uses **tools** to read and change your real data in Postgres. Every tool call goes through a permission check, and anything risky waits for your approval.

## 1. Recommended architecture

A **modular monolith**: one Node.js + TypeScript server, split into separate service modules that share one Postgres database. This is the most reliable and cheapest shape for a single user. Each module can later move into its own process if it ever needs to, but you don't pay for that complexity now.

| Module | Folder | Phase | What it does |
|---|---|---|---|
| Auth | `src/auth` | 1 ✅ | Account setup, login, sessions, password change, rate limiting, CSRF protection |
| Tasks | `src/services/tasks` | 1 ✅ | Tasks, priorities, due dates, recurring tasks and habits, overview, weekly report |
| Memory | `src/services/memory` | 1 ✅ | What the agent remembers about you; inspect, edit, export, delete; refuses sensitive data |
| AI | `src/services/ai` | 1 ✅ | Claude agent loop, tool registry, permission checks, approval queue |
| Audit | `src/services/audit` | 1 ✅ | Records logins, tool calls, approvals and setting changes |
| Finance | `src/services/finance` | 2 ✅ | Transactions, CSV import, categories, budgets, bills, debts, reports |
| Goals | `src/services/goals` | 2 ✅ | Savings goals, weekly and monthly targets, progress, milestones |
| Social | `src/services/social` | 3 | Content plans, captions, scripts, drafts, approval workflow, calendar |
| Automation | `src/services/automation` | 4 | Scheduled 7 am / 1 pm / 8 pm routines and reminders (pg-boss job queue in Postgres) |
| Integrations | `src/services/integrations` | 5 | Google Calendar, Meta/YouTube/TikTok publishing, open banking via OAuth |

## 2. How the agent works

```
 You (phone or laptop browser)
        │  HTTPS, httpOnly session cookie
        ▼
┌───────────────────────── Node.js + TypeScript server (Fastify) ─────────────────────────┐
│                                                                                          │
│  Auth & sessions ──► Dashboard API (/api/...)                                            │
│                            │                                                             │
│                            ▼                                                             │
│                    AI Agent (agent loop)  ◄───────►  Claude API  (key stays on server)   │
│                            │   Claude replies with "tool_use" requests                    │
│                            ▼                                                             │
│                  Tool executor: validate input ─► check permission                        │
│                            │                        ├─ allow   → run now                  │
│                            │                        ├─ approve → Approval queue → You ✔/✖ │
│                            │                        └─ deny    → blocked                  │
│                            ▼                                                             │
│     Tasks · Memory · (Finance · Goals · Social · Automation in later phases)             │
│                            │                                                             │
│                       Audit log  (every tool call, approval and login)                   │
└────────────────────────────┼─────────────────────────────────────────────────────────────┘
                             ▼
                      PostgreSQL database  ──►  nightly pg_dump backups

 Phase 4: Scheduler (pg-boss) fires 7:00, 13:00, 20:00 Melbourne → runs the same agent with
          read-only tools → saves a briefing → you see it on Home (and optionally a push/email).
```

**One chat message, step by step** (e.g. "Remind me to pay electricity next Friday"):

1. The server adds the current Melbourne date and time to your message and sends it to Claude with the list of tools.
2. Claude answers with a tool request: `create_task { title: "Pay electricity bill", due_date: "2026-11-06" }`.
3. The tool executor checks the input against a strict schema, then checks your permission setting for `create_task`.
4. Allowed, so it inserts the task into Postgres, writes an audit entry and sends the real result back to Claude.
5. Claude writes the final reply, which can only describe what the tool result confirms.
6. If the tool were set to "Ask me" (like `delete_task` by default), step 4 would instead create an approval card. Nothing happens until you press Approve.

## 3. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | Your preference; one language everywhere |
| Web server | Fastify 5 | Fast, small, good built-in validation and testing (`inject`) |
| Database | PostgreSQL 16 via `pg` | Reliable, cheap to host, plain SQL migrations you can read |
| Validation | Zod | One schema validates API input **and** becomes the AI tool definition |
| AI | Claude via the official `@anthropic-ai/sdk` | Real tool calling; model set in `.env` |
| Frontend | Plain HTML/CSS/JS modules served by the same server | No build step, no framework to learn, works on phone and desktop |
| Auth | Email + password (scrypt hash), httpOnly SameSite=Strict cookie, sessions in Postgres | Secure, no third-party service needed for one user |
| Encryption | AES-256-GCM (`ENCRYPTION_KEY`) for stored OAuth tokens | Ready for Phase 5 integrations |
| Jobs (Phase 4) | pg-boss (job queue inside Postgres) | Reliable cron-style jobs with retries, no Redis to pay for |
| Tests | Node's built-in test runner via `tsx` | No extra test framework |
| Hosting | Render or Railway (app + managed Postgres), Sydney/Singapore region | Push-to-deploy, HTTPS included, backups included |

Only 7 runtime dependencies: `fastify`, `@fastify/cookie`, `@fastify/static`, `pg`, `zod`, `@anthropic-ai/sdk`, `dotenv`.

## 4. Expected monthly running costs (AUD)

Assumes about A$1.55 per US$1 and around 20 chat messages a day. Check current prices before you commit: these are estimates, not quotes.

| Item | Low | Typical | Notes |
|---|---|---|---|
| Hosting: web app | A$0 | A$11 | Free tiers sleep when idle; a paid "starter" instance (~US$7) runs 24/7, which Phase 4 schedules need |
| Hosting: managed Postgres | A$0 | A$11 | Small paid plan (~US$6–7) with daily backups |
| Claude API: Claude Haiku 5.5 | A$1 | A$3 | Cheapest; fine for simple task commands |
| Claude API: Claude Sonnet 5.5 | A$8 | A$20 | Good balance |
| Claude API: Claude Opus 5.5 (default) | A$15 | A$40 | Smartest planning; set `AI_EFFORT=low` to keep cost down |
| Phase 4 scheduled briefings (3 a day) | A$1 | A$5 | Depends on model |
| Domain name (optional) | A$0 | A$2 | ~A$20–25 a year |
| Social publishing APIs (Phase 5) | A$0 | A$0 | Meta Graph API, YouTube Data API and TikTok Content Posting API are free but need app review |
| Optional third-party publisher (e.g. Ayrshare) | A$0 | A$75+ | Only if you want to skip the platform app reviews |
| Open banking (optional, Phase 5) | A$0 | quote | Basiq / Fiskil price per connection; CSV import is free |
| **Total** | **~A$2** (local only, Haiku) | **~A$35–75** | Running on your own computer costs only the API usage |

Claude API prices used (per million tokens, USD): Opus 5.5 $4 in / $20 out, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50. The system prompt is cached, which lowers repeat-input cost.

## 5. Project structure

```
personal-agent/
├── .env.example            Settings template (copy to .env)
├── docker-compose.yml      Local Postgres
├── migrations/             Database schema, one SQL file per change
│   └── 001_init.sql
├── public/                 The dashboard (served by the server)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── scripts/
│   ├── backup.sh           pg_dump backup (keeps 14)
│   └── init-test-db.sql
├── src/
│   ├── server.ts           Starts everything
│   ├── app.ts              Builds the web app (used by tests too)
│   ├── config.ts           Reads .env
│   ├── routes.ts           Dashboard API endpoints
│   ├── auth/auth.ts        Setup, login, sessions, CSRF, rate limiting
│   ├── db/                 Connection pool and migration runner
│   ├── lib/                Time (Melbourne), crypto (hashing, AES-GCM)
│   └── services/
│       ├── ai/             agent.ts (loop), tools.ts, executor.ts, permissions.ts
│       ├── tasks/          tasks.ts
│       ├── memory/         memory.ts
│       └── audit/          audit.ts
│       (finance/, goals/, social/, automation/, integrations/ arrive in Phases 2–5)
├── tests/                  58 automated tests
└── docs/ARCHITECTURE.md    This document
```

## 6. MVP plan (Phase 1, built now)

- ✅ Secure single-user account (first-run setup with a one-time setup code), login, logout, password change, sign out other devices
- ✅ Postgres schema with migrations
- ✅ Task management: priorities, due dates and times, estimates, recurring tasks and habits, today / next 7 days / missed / completed views, weekly productivity report with chart
- ✅ AI chat with real tool calling: plan my day, add reminders with exact dates, reschedule, prioritise, find missed tasks, weekly review, remember preferences
- ✅ Per-tool permissions (Allow / Ask me / Block), approval cards in chat, audit log
- ✅ Memory page: view, add, edit, export JSON, delete one or all; sensitive data refused
- ✅ Home briefing built only from your real data
- ✅ Mobile-first dark dashboard with all nine sections in the menu; Finance, Goals, Social Studio and Automations are clearly marked as later phases and show no fake data
- ✅ Backups script, security headers, encrypted token storage ready for integrations

## 7. Next phases

- **Phase 2 Finance (done ✅):** transactions table (amounts stored as integer cents), CSV import with bank-format presets (CommBank, NAB, ANZ, Westpac, ING), rule + AI categorisation, budgets, bills and subscriptions, debts, savings goals with weekly/monthly targets and charts, "safe to spend this week" calculation, finance tools for the agent (read-only by default).
- **Phase 3 Social Studio:** accounts and content categories, weekly plans, ideas, captions, hashtags, scripts, creative briefs, drafts with preview, approve/request-changes workflow, content calendar. Publishing tools are fixed to "Ask me" and cannot be switched to Allow.
- **Phase 4 Automation:** pg-boss scheduler, 7:00 / 13:00 / 20:00 Melbourne briefings saved to Home, reminder notifications (web push or email), job history, retries.
- **Phase 5 Integrations:** Google Calendar (OAuth), Meta Graph API for Instagram/Facebook, YouTube Data API for Shorts, TikTok Content Posting API (needs TikTok app audit before public posting), optional open banking via an accredited CDR provider. Tokens stored encrypted.
- **Phase 6 Advanced AI:** proactive suggestions, spending insights, engagement analytics, smarter memory.

**Social media API limits to know now:** TikTok only allows posting through its Content Posting API after an app audit (unaudited apps can only post privately). Instagram publishing needs a Business or Creator account linked to a Facebook Page. YouTube uploads use a daily quota (about 6 uploads a day on the default quota). Personal Facebook profiles cannot be posted to by apps; only Pages. No scraping or unofficial automation will be used.
