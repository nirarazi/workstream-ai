# ATC MVP Implementation Plan

## Context

ATC is a greenfield desktop application for AI agent fleet operators. The codebase currently contains only `CLAUDE.md` (the spec). This plan builds the full MVP: a Tauri desktop app that reads agent conversations from Slack, classifies message status via LLM, stores context in SQLite, and presents an inbox UI for the operator to act on items needing attention.

The MVP validates one hypothesis: **agent conversation status can be extracted reliably enough from free-form messages to power a useful inbox.**

---

## Design Principle: Web-Ready Architecture

The architecture is deliberately split so ATC runs as both a **Tauri desktop app** and a **standalone web app** with minimal friction:

- **Core engine** (`core/server.ts`) is a standalone Node.js HTTP server (Hono). It owns all business logic, pipeline polling, and SQLite access. It runs independently — Tauri just spawns it as a sidecar.
- **React frontend** talks to the engine exclusively via `fetch` over HTTP. No Tauri IPC for data flow.
- **Tauri shell** is a thin wrapper: spawn sidecar, provide native window, done.

**Rules to maintain web compatibility:**
1. **No Tauri IPC for data.** All data flows through the HTTP API. Tauri commands are only for shell concerns (get engine URL, window management).
2. **`src/lib/api.ts` detects its environment.** In Tauri: gets engine URL from a Tauri command. In browser: uses `VITE_ENGINE_URL` env var or defaults to `window.location.origin`. This is the only branching point.
3. **No `@tauri-apps/*` imports in components.** Only `src/lib/api.ts` and `src/App.tsx` may import Tauri packages, behind dynamic imports with fallbacks.
4. **Add `npm run dev:web` script.** Starts `core/server.ts` + Vite dev server without Tauri. Works out of the box for web-only usage.
5. **Add `npm run start:web` script.** Production mode: builds React frontend, serves it from the Hono server's static file middleware.

**What the web version loses** (acceptable for MVP):
- No system tray, dock icon, or native OS notifications (browser notifications are a future option)
- No auto-start on login
- No native file dialogs
- Must manually start the engine server (`npm run start:web`)

**What the web version keeps** (everything that matters):
- Full inbox UI with all action buttons
- Real-time polling and classification
- Slack read/write, Jira enrichment
- MCP server (separate process, unaffected)
- SQLite context graph (engine-side, works identically)

---

## Phase 0: Project Scaffolding (Day 1)

### 0.1 Initialize Tauri + React + TypeScript
```
npm create tauri-app@latest . -- --template react-ts --manager npm
```

### 0.2 Install dependencies
```
npm install better-sqlite3 @slack/web-api @modelcontextprotocol/sdk hono @hono/node-server yaml zod
npm install -D @types/better-sqlite3 vitest @testing-library/react tailwindcss @tailwindcss/vite tsx @playwright/test
```

### 0.3 Configure Tailwind + Vitest
- Add Tailwind vite plugin to `vite.config.ts`, update `src/index.css`
- Add vitest config and npm scripts: `test`, `test:watch`, `classify`, `mcp`
- Add web-mode scripts: `dev:web` (engine + Vite, no Tauri), `start:web` (production build served from engine)

### 0.4 Create directory structure
```
core/classifier/providers/
core/graph/extractors/
core/adapters/platforms/slack/
core/adapters/tasks/jira/
core/mcp/tools/
config/prompts/
tests/{classifier,graph,adapters,mcp,actions,e2e,fixtures}/
docs/
```

### 0.5 Configuration files
- `config/default.yaml` — slack, classifier, jira, extractors, mcp sections
- `config/prompts/classify.yaml` — classifier system prompt + few-shot examples (the tunable "IP")
- `.env.example` — ATC_SLACK_TOKEN, ATC_LLM_API_KEY, ATC_LLM_BASE_URL, ATC_LLM_MODEL, ATC_JIRA_TOKEN
- `.gitignore` — config/local.yaml, *.db, .env, target/, node_modules/

---

## Phase 1: Prove the Classifier (Weeks 1–2)

**Goal**: Classify live Slack messages, log to stdout, measure 80%+ accuracy. No UI, no database.

### Files to create

| File | Purpose |
|------|---------|
| `core/types.ts` | All shared interfaces: StatusCategory, Classification, Message, Thread, WorkItem, Agent, Event, etc. |
| `core/config.ts` | YAML config loader — default.yaml + local.yaml + env var overlay |
| `core/logger.ts` | Thin console wrapper with levels, timestamps, component tags |
| `core/classifier/providers/interface.ts` | `ModelProvider` interface |
| `core/classifier/providers/openai-compatible.ts` | Single provider for Anthropic/OpenAI/Ollama/vLLM — all use `/chat/completions` |
| `core/classifier/index.ts` | Classifier orchestrator — loads prompt, calls provider, returns Classification |
| `core/classifier/cli.ts` | CLI runner — connect Slack, read threads, classify, print table to stdout |
| `core/adapters/platforms/interface.ts` | `PlatformAdapter` interface |
| `core/adapters/platforms/slack/index.ts` | Slack adapter — read threads via polling, reply as operator |

### Key decisions
- **Single LLM provider**: One `openai-compatible.ts` covers all backends via `/chat/completions`
- **Slack auth**: xoxp- user token (scopes: channels:history, channels:read, groups:history, groups:read, im:history, im:read, chat:write, users:read)
- **Polling**: 30s default interval

### Tests
- `tests/classifier/classifier.test.ts` — mock provider, verify prompt formatting + response parsing
- `tests/adapters/slack.test.ts` — mock @slack/web-api, verify readThreads mapping
- `tests/fixtures/slack-messages.json` — 50+ labeled messages for accuracy measurement

### Verification
- `npx tsx core/classifier/cli.ts` reads live Slack, classifies, prints table
- Works with Anthropic + Ollama backends
- Manual review of 50+ messages shows >= 80% accuracy

---

## Phase 2: Context Graph (Weeks 2–3)

**Goal**: Wire classifier into SQLite. Work item linking. Jira enrichment. Backfill 7 days correctly.

### Files to create

| File | Purpose |
|------|---------|
| `core/graph/db.ts` | SQLite connection (WAL mode), schema creation, prepared statements |
| `core/graph/schema.ts` | TypeScript row types mirroring DB tables |
| `core/graph/index.ts` | ContextGraph implementation — CRUD for all entities, actionable items query |
| `core/graph/extractors/interface.ts` | `Extractor` interface |
| `core/graph/extractors/default.ts` | Regex-based ticket/PR extraction (AI-xxx, IT-xxx, MS-xxx, PR #xxx) |
| `core/graph/linker.ts` | Links threads to work items via extracted patterns |
| `core/adapters/tasks/interface.ts` | `TaskAdapter` interface |
| `core/adapters/tasks/jira/index.ts` | Jira REST API v3 adapter (native fetch, basic auth) |
| `core/pipeline.ts` | Processing pipeline — orchestrates read → classify → link → store → enrich |

### Database schema
```
agents       (id, name, platform, platform_user_id, role, first_seen, last_seen)
work_items   (id, source, title, external_status, assignee, url, current_atc_status, current_confidence, snoozed_until, created_at, updated_at)
threads      (id, channel_id, channel_name, platform, work_item_id FK, last_activity, message_count)
events       (id, thread_id FK, message_id, work_item_id FK, agent_id FK, status, confidence, reason, raw_text, timestamp, created_at)
enrichments  (id, work_item_id FK, source, data JSON, fetched_at)
poll_cursors (channel_id PK, last_timestamp, updated_at)
```

### Tests
- `tests/graph/db.test.ts` — schema creation, CRUD, actionable items query
- `tests/graph/linker.test.ts` — extraction from various message formats
- `tests/graph/extractor.test.ts` — regex edge cases
- `tests/adapters/jira.test.ts` — mock fetch, API mapping

### Verification
- `npx tsx core/classifier/cli.ts --backfill` processes 7 days into SQLite
- `sqlite3 atc.db` shows correctly linked agents, work_items, threads, events
- Jira enrichments present for known ticket IDs

---

## Phase 3: Read-Only Inbox UI (Weeks 3–5)

**Goal**: Tauri app with single inbox screen displaying classified items.

### Architecture
Core engine runs as a Node.js sidecar spawned by Tauri. Exposes HTTP API on `localhost:9847` (127.0.0.1 only) via Hono. React frontend polls the API. **All data flows through HTTP — no Tauri IPC for data.** This keeps the web path working for free.

### Files to create

| File | Purpose |
|------|---------|
| `core/server.ts` | Hono HTTP server — `/api/inbox`, `/api/work-item/:id`, `/api/agents`, `/api/status` |
| `src/lib/api.ts` | Typed fetch wrapper — detects Tauri vs browser, resolves engine URL accordingly. Only file allowed to import `@tauri-apps/*`. |
| `src/lib/time.ts` | Relative time formatting |
| `src/components/StatusBadge.tsx` | Color-coded status badge (red=blocked, amber=needs_decision, green=completed, blue=in_progress, gray=noise) |
| `src/components/WorkItemCard.tsx` | Work item display — ID, agent, time, status, last message, action buttons (disabled) |
| `src/components/Inbox.tsx` | Main view — "NEEDS ATTENTION" (actionable) + "RECENT" sections, polls every 5s |
| `src/components/Setup.tsx` | First-run config screen — Slack token, LLM config, optional Jira |

### Files to modify
- `src/App.tsx` — header with "ATC" + connection status, routes to Inbox or Setup
- `src-tauri/src/main.rs` — spawn sidecar, kill on close
- `src-tauri/tauri.conf.json` — allow localhost, shell plugin

### Tests
- `tests/ui/inbox.test.ts` — component tests with mock API

### Verification
- `npm run tauri dev` opens the desktop app
- `npm run dev:web` opens in browser — same UI, same data
- Inbox shows items sorted by urgency
- Auto-refreshes as pipeline processes new messages
- Work item IDs link to Jira

---

## Phase 4: Bidirectional Messaging + MCP (Weeks 5–6)

**Goal**: Action buttons post back to Slack. MCP server for direct agent push.

### Files to create

| File | Purpose |
|------|---------|
| `core/actions.ts` | Action logic — approve, redirect, close, snooze |
| `core/mcp/server.ts` | MCP server (stdio) — atc_report_status, atc_request_approval, atc_complete |
| `core/mcp/cli.ts` | MCP entry point: `npx tsx core/mcp/cli.ts` |
| `src/components/ReplyBar.tsx` | Free-text reply input, posts to Slack as operator |

### Files to modify
- `core/server.ts` — add `POST /api/reply` and `POST /api/action` endpoints
- `core/adapters/platforms/slack/index.ts` — implement `replyToThread()` via `chat.postMessage`
- `src/components/WorkItemCard.tsx` — enable action buttons (approve, redirect, close, snooze)

### MCP tools
- `atc_report_status(workItemId, status, message)` — agent reports its state
- `atc_request_approval(workItemId, description, options?)` — agent requests human decision
- `atc_complete(workItemId, summary)` — agent marks work done

### Tests
- `tests/mcp/server.test.ts` — each tool, DB writes, concurrent access
- `tests/actions/actions.test.ts` — mock Slack, verify messages posted

### Verification
- "Approve" → message appears in Slack from operator's account
- Reply → appears in Slack as operator
- MCP `atc_request_approval` call → item appears in inbox
- Snooze → item disappears, returns after duration

---

## Phase 5: Dogfood (Weeks 6–8)

**Goal**: Run on reference fleet (InsureTax, ~19 agents). Operator stops opening Slack.

### Tasks
1. **Build & package** — `npm run tauri build` → macOS .dmg
2. **Prompt tuning** — analyze accuracy on reference fleet, add fleet-specific few-shot examples
3. **Error handling** — Slack 401 detection, LLM timeout retry, SQLite failure logging, offline mode
4. **Performance** — cold start < 3s, classification within 30s of poll, EXPLAIN ANALYZE queries
5. **Documentation** — README.md, docs/adapters.md, docs/mcp.md
6. **E2E tests** — `tests/e2e/inbox.spec.ts` with pre-seeded DB via Playwright
7. **LICENSE** — MIT

---

## Complete File Inventory (46 new files)

**Config (3)**: config/default.yaml, config/prompts/classify.yaml, .env.example
**Core Types (3)**: core/types.ts, core/config.ts, core/logger.ts
**Classifier (4)**: core/classifier/providers/interface.ts, core/classifier/providers/openai-compatible.ts, core/classifier/index.ts, core/classifier/cli.ts
**Graph (6)**: core/graph/db.ts, core/graph/schema.ts, core/graph/index.ts, core/graph/extractors/interface.ts, core/graph/extractors/default.ts, core/graph/linker.ts
**Adapters (4)**: core/adapters/platforms/interface.ts, core/adapters/platforms/slack/index.ts, core/adapters/tasks/interface.ts, core/adapters/tasks/jira/index.ts
**Pipeline & Server (3)**: core/pipeline.ts, core/server.ts, core/actions.ts
**MCP (2)**: core/mcp/server.ts, core/mcp/cli.ts
**Frontend (7)**: src/components/Inbox.tsx, src/components/WorkItemCard.tsx, src/components/StatusBadge.tsx, src/components/ReplyBar.tsx, src/components/Setup.tsx, src/lib/api.ts, src/lib/time.ts
**Tests (10)**: tests/classifier/classifier.test.ts, tests/adapters/slack.test.ts, tests/adapters/jira.test.ts, tests/graph/db.test.ts, tests/graph/linker.test.ts, tests/graph/extractor.test.ts, tests/mcp/server.test.ts, tests/actions/actions.test.ts, tests/e2e/inbox.spec.ts, tests/fixtures/slack-messages.json
**Docs (3)**: README.md, docs/adapters.md, docs/mcp.md
**Other (1)**: LICENSE
**Modified from scaffold (6)**: src/App.tsx, src/main.tsx, src/index.css, src-tauri/src/main.rs, src-tauri/tauri.conf.json, vite.config.ts

---

## Critical Path

`core/types.ts` → `core/config.ts` → `core/classifier/*` + `slack adapter` → `core/graph/*` → `core/pipeline.ts` → `core/server.ts` → UI components → `core/actions.ts` + `core/mcp/*`

Everything depends on types.ts and config.ts. The classifier and Slack adapter can be built in parallel. The graph depends on types. The pipeline depends on everything. The UI depends on the server. Actions and MCP depend on the graph.
