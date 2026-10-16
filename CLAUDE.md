# workstream.ai — The Operator's Inbox for AI Agent Fleets

workstream.ai is an open-source (MIT) desktop app for people who run fleets of autonomous AI agents. When 10–20+ agents coordinate through a messaging platform such as Slack, their threads pile up faster than anyone can read them. workstream.ai reads those conversations, works out what each one is about and what state it's in, and shows the operator only what needs them right now. The operator can act on each item, reply, approve, snooze or dismiss, without opening the messaging platform.

This file is the project guide for contributors and coding agents: what the product is, how it's built, and how to work on it. The process every change goes through before it's merged is in [AGENTS.md](AGENTS.md), imported at the end of this file.

---

## Who It's For

The user is an **agent fleet operator**: the person who configures, deploys and governs a fleet of agents, not someone who occasionally asks an agent a question. They are comfortable in a terminal. They unblock agents, review their pull requests, make the decisions agents escalate, and keep track of what's in progress, what's done and what's waiting on a human. A fleet may have several humans who each own different areas, so "what needs me" depends on who is asking.

---

## Principles

- **It comes to you.** workstream.ai is an inbox, not a dashboard you check. It surfaces only what needs the operator and stays quiet otherwise. Success is measured in unnecessary interruptions eliminated, not tasks tracked.
- **Avoid the throughput trap.** Never optimize for tasks closed or agents active. Those metrics reward agents for marking work done early and generating busywork. The metric that matters is how often the operator was interrupted for nothing.
- **The transport layer stays the same.** workstream.ai doesn't replace Slack or any other platform. Humans and agents keep working where they do; workstream.ai reads from and writes to those platforms on the operator's behalf.
- **Post as the operator, not as a bot.** Replies go out under the operator's own identity, because agents are already set up to respond to the operator. This is non-negotiable.
- **Context is the product.** What the app learns about a fleet (which agent owns which work item, what a ticket prefix means, what "done" looks like for a given agent) accumulates over time and makes it more useful.
- **No vendor lock-in.** No specific model provider, cloud, messaging service or task tracker is required. Every external dependency sits behind an interface, and operators bring their own.
- **Local-first and self-hostable.** Everything runs on the operator's machine: no account, no telemetry, no phoning home. It is designed to work fully offline with a local model and a self-hosted messaging platform. Slack is the only messaging adapter so far. The data belongs to the operator.

Not goals: a project manager, a monitoring dashboard, a chat client for talking to agents, or a replacement for the messaging platform.

---

## How It Works

```
messaging platform ──► pipeline ──► classifier ──► context graph ──► engine API ──► UI (Tauri / browser)
 (Slack adapter)       (polls)      (LLM and/or     (SQLite)          (Hono, local)
                                     decision model)
agents via MCP ────────────────────────────────────►
```

- **Engine** (`core/server.ts`): a local HTTP server (Hono) on `127.0.0.1:9847`. It owns all state and logic. The API has no authentication: any local process can call it, so keep `server.host` on loopback. It refuses requests addressed to other hostnames, and writes from browser origins other than the app's own.
- **Pipeline** (`core/pipeline.ts`): polls the messaging adapter, classifies new messages, links them to work items and writes the results to the context graph. It can also auto-dismiss items that have gone quiet.
- **Classifier** (`core/classifier/`): sends each message with its thread context to any OpenAI-compatible model (including local ones via Ollama). The default is Anthropic's OpenAI-compatible endpoint with `claude-sonnet-4-6`, set by `WORKSTREAM_LLM_BASE_URL`, `WORKSTREAM_LLM_MODEL` and `WORKSTREAM_LLM_API_KEY` or in Settings. It returns a status, a title, the next action, linked work items, and whether the message needs the operator.
  - **Statuses:** `completed`, `in_progress`, `blocked_on_human`, `needs_decision`, `noise`.
  - **Operator's remit:** an optional written description of what the operator owns (`operator.context` in `config/local.yaml`), used to judge "is this for me?" when several humans share a fleet.
  - **Decisions mode:** with `classifier.mode: decisions`, a decision model (`core/decisions/`) decides the status and inbox membership with calibrated probabilities. The LLM still writes titles and links.
- **Context graph** (`core/graph/`): a SQLite database (WAL mode) holding work items, threads, events (every classification, as an audit trail), agents and enrichments from task adapters. It's a plain file the operator can open with any SQLite tool.
- **Work item linking** (`core/graph/linker.ts`, `core/graph/extractors/`): pattern extraction of ticket IDs and PR numbers, plus continuation detection for messages outside threads (`core/continuation/`).
- **Task adapters** (`core/adapters/tasks/`): enrich work items with data from a tracker (Jira is the reference implementation) and create tickets.
- **MCP server** (`core/mcp/`, stdio, started with `npm run mcp`): lets agents push status directly instead of being read from chat. Tools:
  - `workstream_report_status`
  - `workstream_request_approval`
  - `workstream_complete`
- **UI** (`src/`): React, run in a Tauri desktop window or a browser tab.
  - **Stream view:** tabs for Needs me, Snoozed, All active and Dismissed, each searchable. Each item has a timeline, suggested actions and a reply box.
  - **Fleet board:** shows the agents.
  - **Sidekick:** a question-answering pane over the context graph (`core/sidekick/`).
  - **Settings screen:** credentials, model and inbox preferences.
- **Desktop shell** (`src-tauri/`): Tauri 2. It currently starts the engine from the project directory. A self-contained build is on the roadmap.

---

## Extension Points

workstream.ai is meant to be extended without forking. Messaging and task adapters register themselves by name in `core/adapters/registry.ts` when their module is imported. The engine imports them at startup in `core/server.ts`, so a new adapter also needs an import line there. The other extension points are wired in `core/server.ts` or chosen by config (decision providers in `core/decisions/gate.ts`).

| Extension | Interface | Location | Reference implementation |
|---|---|---|---|
| Messaging platform | `MessagingAdapter` | `core/adapters/messaging/` | Slack |
| Task tracker / version control | `TaskAdapter` | `core/adapters/tasks/` | Jira |
| Model provider | `ModelProvider` | `core/classifier/providers/` | OpenAI-compatible |
| Decision provider | `DecisionProvider` | `core/decisions/providers/` | LLM, OpenAI Decisions, TypeSafe |
| Work item extractor | `Extractor` | `core/graph/extractors/` | Regex ticket/PR extraction |
| Continuation strategy | `ContinuationStrategy` | `core/continuation/` | Interface only so far; the shipped behavior is built into the classifier |

Adapters each live in their own directory, and arrive by pull request with passing tests. The Slack adapter sets the standard for a complete messaging adapter. Interfaces are a contract: breaking changes need a deprecation cycle.

---

## Repository Layout

```
core/                  Engine (TypeScript, Node)
  server.ts            HTTP API and startup
  pipeline.ts          Polling, classification and linking loop
  adapters/            Messaging and task adapters, registry, setup-field types
  classifier/          LLM classifier, prompt handling, providers, CLI
  decisions/           Decision-model interface, providers and gate
  graph/               SQLite schema, queries, linker, extractors, anomalies
  continuation/        Grouping of non-threaded messages
  mcp/                 MCP server (stdio) and CLI
  sidekick/            Question answering over the graph
  summarizer/          Work item summaries
  usage/               LLM token and cost tracking, daily budget
  eval/                Classifier evaluation harness (sample, label, run)
src/                   React UI (components/, stream/, lib/api.ts, messaging/ renderers)
src-tauri/             Tauri desktop shell (Rust)
config/default.yaml    Default configuration (documented inline)
config/prompts/        Classifier prompt and few-shot examples
docs/                  Roadmap, Slack setup, theming, design notes
tests/                 Vitest tests, grouped by area
```

---

## Development

Requirements: a current Node.js LTS and npm. For the desktop app, also the Rust toolchain and Tauri's prerequisites.

```bash
npm install

# In a browser: engine and UI together
npm run dev:web       # engine on 127.0.0.1:9847 and UI on http://localhost:5173, both restart on change
# (or run them in two terminals: npm run engine, npm run dev)

# Or as the desktop app: starts the UI and the engine itself (don't run the two above as well)
npm run tauri dev

npm test              # full test suite (Vitest); npm run test:watch to rerun on change
npm run typecheck     # TypeScript check of the engine, UI and Vite config
npm run start:web     # build the UI and serve it from the engine
npm run mcp           # MCP server on stdio
npm run classify      # classify a message given as arguments or on stdin (calls the configured model)
```

The engine and the MCP server open `workstream.db` in the directory they're started from. Start them from the repo root, or point the MCP server at the engine's database with `WORKSTREAM_DB_PATH`.

Configuration:
- **`config/default.yaml`:** the defaults, with comments.
- **`config/local.yaml`:** the operator's overrides. Gitignored, and written by the Settings screen.
- **`.env`:** secrets such as tokens and API keys. Gitignored, written by Settings, readable by the owner only.
- **The database:** `workstream.db` (see above). Gitignored.

See [docs/slack-setup.md](docs/slack-setup.md) to connect Slack.

Classifier evaluation: `npm run eval:sample`, `eval:label` and `eval:run` build and score a labeled set from your own messages. The data stays in `eval-data/`, which is gitignored. The roadmap records results so far.

---

## Working in This Repo

- **This repo is public.** Never commit credentials, `.env`, `config/local.yaml`, databases, `eval-data/`, or real messages, people, Slack IDs, ticket keys or incidents. Tests, docs, examples and commit messages use fictional stand-ins, for example:
  - people: "Dana", "Alex Rivera";
  - agents: "Atlas", "Relay";
  - ticket keys: `OPS-101`;
  - Slack IDs: `U0OPERATOR1`.
- **Tests stay offline.** Mock adapters and model providers. Never call a live Slack workspace, Jira instance or paid LLM endpoint from a test.
- **Coding agents: don't drive a live engine.** An engine started with the operator's real credentials reads their workspace, and its action endpoints post as the operator, where real agents act on it. Exercise write and action paths with tests and mocks, or against a test workspace.
- **Match the surrounding code:** its naming, comment density and idioms. Keep the core platform-agnostic, so nothing outside an adapter knows which platform it's talking to.
- **Theming:** see [docs/theming.md](docs/theming.md) for the color system and status colors.
- **Roadmap:** [docs/roadmap.md](docs/roadmap.md) has current priorities, eval results and open design questions.

---

## Shipping Changes: Required Reviews on Every PR

Every pull request gets a code review from the `Code Reviewer` subagent and a security review from the `Security Engineer` subagent (or the fallback described in AGENTS.md). Their findings are verified, fixed, and re-reviewed in a loop until the PR is clean. The full process, shared with other coding agents, is in AGENTS.md:

@AGENTS.md
