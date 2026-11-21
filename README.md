# Xirel OS — Hybrid AI Operating System

Xirel OS is one application with two faces, sharing one Supabase
project, one auth system, and one set of workspaces:

- **AI OS** — the agent runtime: provider-routed AI, the Xirel Manager
  (plan → execute → verify), a durable Postgres task queue executed by a
  Render background worker, project registry + memory, a tool gateway
  with permissions/audit/approvals, schedules, and the `/command` AI
  command center.
- **Business OS** — the commerce suite at `/business`: customers,
  inventory, sales, invoices, and payments over the `bos_*` tables with
  RLS-enforced workspace isolation.

## Live surfaces

| Surface | Route | Notes |
|---|---|---|
| AI Command Center | `/command` | default landing for signed-in users: conversation, durable tasks, approvals, activity, schedules, provider health |
| Classic chat | `/chat` | agent turn via `/api/agent/chat` (durable run + verification badge) |
| AI dashboard | `/dashboard` | workspace/provider overview |
| Business OS | `/business` | standalone suite from `main`, same auth + workspaces |
| Legacy streaming | `POST /api/chat` | kept intact for existing callers |

## Architecture

```
USER → VERCEL (Next.js frontend + authenticated API)
     → SUPABASE (auth, Postgres: tasks/jobs/runs/steps/events/
                 projects/memory/approvals/schedules/bos_*)
     → RENDER background worker
         → Xirel Manager (plan → execute via tool gateway → verify)
             → central AI provider router (Gemini/OpenRouter/Groq/…)
         → durable queue: FOR UPDATE SKIP LOCKED, leases, heartbeats,
           checkpoints, bounded retries, approval checkpoints, crons
```

Key sources of truth:
- `supabase/migrations/0001…0011` — DDL + RLS (0007 fixes the
  `workspace_members` policy recursion; 0008 is the durable engine).
- `src/lib/db/schema.ts` — Drizzle mirror (TypeScript types).
- `src/lib/jobs/` — queue/state machine/retry/backoff.
- `worker/` — the Render worker (starts independently of Next.js).
- `docs/` — integration strategy, safe rollout, connector boundaries.

## Commands

Use Node.js 22.

```bash
npm run dev          # Next.js dev server
npm run build        # production build (type-checked)
npm run typecheck    # tsc --noEmit
npm run lint        # Next.js ESLint rules
npm run worker       # background worker (node --conditions=react-server --import tsx)
npm run test:logic   # 59 pure-logic checks (state machine, backoff, cron, …)
npm run test:db      # checks against a REAL throwaway PostgreSQL
                     #   (migrations, routes, RLS, runtime, queue, approvals; Linux namespaces)
npm run test:sandbox # Linux file-scope and isolated preset checks
```

## Environment

Copy `.env.example` → `.env.local` and fill in at minimum
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
`DATABASE_URL`. On Render, use the provider-issued IPv4 shared pooler:
transaction mode for the web app and session mode for a persistent worker.
See [Render database configuration](docs/render-database.md).
Provider keys (Gemini/OpenRouter/Groq) enable AI features — unconfigured
providers are skipped, never faked. Render configuration lives in
`render.yaml` (manual deploy; secrets stay in the dashboard).

## GitHub Hub

Open **GitHub Hub** from Dashboard or Command Center to connect GitHub identities and explore their authorized repositories. See the [GitHub Hub setup and staging checklist](docs/github-hub.md) for App permissions, environment configuration, and opt-in agent sharing.

## Optional project tooling

See [project execution and rollout](docs/project-execution.md) for the staging worktree, Linux presets, approval-bound GitHub publishing, public research and OpenRouter role configuration. See the [dependency audit](docs/dependency-audit-2026-11-20.md) for the Next.js upgrade and remaining development-only findings.

## Staging validation

See the [staging validation report and deployment procedure](docs/staging-validation.md) for local evidence, live probe instructions, and outstanding Render/Supabase gates.

Production authentication uses `APP_URL` as its trusted origin. See [Render authentication setup](docs/render-authentication.md) before changing Supabase URL configuration or deploying.

## Deployment status

Phase 1–4 AI OS code complete and tested (logic + real-DB suites);
hybrid integration with the Business OS complete. Production rollout is
gated behind the safe-rollout plan — see `docs/safe-rollout.md` (migrations
are applied manually in Supabase; nothing auto-deploys to production).

See [Autonomous runtime: implementation and rollout](docs/autonomous-runtime.md) for current capabilities, connector opt-in, security boundaries, and staging gates.
