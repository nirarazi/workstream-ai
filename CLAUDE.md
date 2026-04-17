# workstream.ai — The Operator's Inbox for AI Agent Fleets

## What This Is

workstream.ai isan open source desktop application for people who run AI agent fleets. It solves a specific, acute problem: when you operate 10–20+ autonomous agents that communicate through messaging platforms (Slack, Telegram, WhatsApp, etc.), the threads pile up fast. You end up manually reading dozens of conversations to find out what's in progress, what's done, and what needs your input. workstream.aireplaces that with a purpose-built inbox that surfaces only what requires a human right now — and lets you act on it without opening the underlying platform.

The product is not a project manager. It is not a monitoring dashboard. It is not a replacement for Slack or any messaging platform. It is a purpose-built client for the person who *runs* the fleet — the operator — that makes the underlying messaging platform invisible.

---

## The Core User

The primary user is an **agent fleet operator**: a technical founder or CTO running multiple autonomous AI agents in production, coordinating them through messaging platforms, managing overnight dispatches, reviewing PRs submitted by agents, and unblocking work items across a fleet of 10–20+ agents. This person is comfortable in a terminal. They are not the person who occasionally asks an agent a question — they are the person who configures, deploys, and governs the agents.

This is a small but fast-growing segment. Build for the 50 teams that exist today, not a hypothetical future audience.

---

## Core Philosophy

**It comes to you.** The product is not a dashboard you check. It is an inbox that surfaces only what requires your attention, and stays silent when it doesn't. The measure of success is not tasks tracked — it is unnecessary interruptions eliminated.

**The transport layer stays the same.** workstream.aidoes not replace Slack, Telegram, or any messaging platform. Human teammates keep working as they do. Agents keep communicating as they do. workstream.aireads from and writes to those platforms on the operator's behalf, making the underlying platform invisible without removing it.

**Context is the product.** The accumulated understanding of the fleet — which agents own which work items, what ticket naming conventions mean, what "done" looks like for a specific agent — is the asset that grows over time. Every other tool starts cold. This one gets smarter.

**Platform-agnostic by design.** The core engine works identically regardless of whether the underlying platform is Slack, Telegram, or something not yet built. Platform integrations are pluggable adapters. The open source community adds them. The core stays stable.

**Avoid the throughput trap.** Never optimize for tasks closed or agents active. Those metrics create perverse incentives (agents marking work done prematurely, generating busywork). The metric that matters is: how many times did the operator intervene unnecessarily today? Good product drives that to zero.

**Post as the operator, not as a bot.** When workstream.aisends a message back to an agent thread, it posts using the operator's identity — not a bot account. Agents are already trained to respond to the operator. Preserving that trust relationship is not optional.

**No vendor lock-in, ever.** workstream.aimust never require a specific model provider, cloud platform, messaging service, or task management tool to function. Every external dependency is behind an interface. Operators bring their own everything: their own LLM, their own Slack workspace, their own Jira instance. workstream.ai isthe engine; they supply the fuel.

**Self-hostable by default.** workstream.airuns entirely on the operator's machine with zero cloud dependencies required. No account creation, no telemetry, no phoning home. An operator with no internet access should be able to run workstream.aiagainst a local model and a self-hosted messaging platform and have a fully functional product.

---

## Open Source Model

**License:** MIT. Maximum adoption, minimum friction for commercial use. This is a community tool, not a future SaaS moat.

**Open core principle:** Everything is open. The context graph engine, status classifier, all platform adapters, and the desktop app are fully open source. There is no closed "enterprise edition" planned. A potential future commercial layer (cloud sync, team sharing, a managed hosted version) would be a separate product built on top, not a gated version of this one.

**Adapter registry:** Community-contributed adapters (Telegram, WhatsApp, Teams, Discord, Linear, GitHub, etc.) live in the main repository under `core/adapters/`. Each adapter is a self-contained directory. The Slack adapter is the reference implementation — it sets the standard for what a complete adapter looks like. New adapters are accepted via pull request with passing tests and a working example.

**Contributor model:** The core team maintains the classifier, context graph, and Tauri shell. The community owns the adapter ecosystem. The interface contract (`PlatformAdapter`, `TaskAdapter`, `MCPAdapter`) is stable and versioned — breaking changes require a deprecation cycle.

---

## Architecture Overview

workstream.aihas five core components plus an MCP server layer:

### 1. Platform Adapter (Messaging)
A pluggable interface for any messaging platform. Responsible for reading agent threads, writing replies as the operator, and streaming new messages. The Slack adapter ships with the MVP. All others are community-contributed.

```typescript
interface PlatformAdapter {
  name: string;
  connect(credentials: Credentials): Promise<void>;
  readThreads(since: Date): Promise<Thread[]>;
  replyToThread(threadId: string, message: string, asUser: true): Promise<void>;
  streamMessages(handler: (msg: Message) => void): void;
}
```

### 2. Task Adapter (Project Management & Version Control)
A pluggable interface for task/project management tools and version control systems. Task adapters enrich the context graph with structured data from external systems — ticket status, PR state, assignees, labels — rather than inferring everything from message text alone.

```typescript
interface TaskAdapter {
  name: string;
  connect(credentials: Credentials): Promise<void>;
  getWorkItem(id: string): Promise<WorkItemDetail>;
  updateWorkItem(id: string, update: Partial<WorkItemDetail>): Promise<void>;
  searchWorkItems(query: string): Promise<WorkItemDetail[]>;
}
```

Reference implementations to ship alongside the MVP or shortly after: **Jira** (AI-xxx, IT-xxx ticket resolution), **Bitbucket** (PR status), **GitHub** (PR and issue status). These are the integrations the reference fleet uses. Community adds Linear, Asana, GitLab, and others.

### 3. Status Classifier
Takes a raw agent message and returns a structured classification:
- `completed` — the agent finished a task
- `in_progress` — work is actively underway
- `blocked_on_human` — the agent needs input, approval, or a manual action
- `needs_decision` — a choice is required before the agent can continue
- `noise` — status update, system message, or informational — no action needed

The classifier uses a foundation model API call via a **model-agnostic interface** — any OpenAI-compatible endpoint works, including local models via Ollama. The default is Claude claude-sonnet-4-6 but operators can substitute any model in config. The prompt is the IP, not the model. Accuracy target: 80%+ on the operator's actual fleet within one week of use. The prompt is tunable — operators provide few-shot examples for their specific fleet.

```typescript
interface ModelProvider {
  name: string;
  baseUrl: string;          // OpenAI-compatible endpoint
  model: string;
  apiKey?: string;          // Optional — Ollama needs none
  classify(message: string, prompt: string): Promise<Classification>;
}
```

### 4. Context Graph
A local SQLite database (WAL mode) that is the operator's persistent, portable asset. It stores:
- **WorkItems**: tasks, tickets, or goals (linked by ID extracted from messages — e.g. "AI-382", "PR #716")
- **Threads**: individual conversation threads on any platform, each linked to a WorkItem
- **Events**: timestamped classifications for each message (the full audit trail)
- **Agents**: known agents and their roles, inferred from message authorship and content
- **Enrichments**: structured data pulled from task adapters (Jira ticket details, PR state, etc.)

The context graph is local-first and portable. It belongs to the operator. The SQLite file is directly accessible, exportable, and readable with any SQLite tool. workstream.aiwill never move this data to a cloud service without explicit operator action.

Work item linking uses pattern extraction (ticket IDs, PR numbers, agent names) plus task adapter lookups for authoritative status. Pattern extraction is the fallback when no task adapter is connected.

### 5. Inbox UI
A single-screen Tauri desktop application (Rust + React). Shows one thing: items that need the operator's attention right now, ranked by urgency. Each item displays:
- Work item identifier and brief description
- The agent responsible
- The last relevant message (the reason it surfaced)
- Action buttons: **Approve**, **Redirect**, **Close**, **Snooze**
- A single free-text reply field for instructions that don't fit a button

Nothing else in v1. No sidebar, no navigation, no settings panel beyond initial setup.

### 6. MCP Server (workstream.aias a Tool)
workstream.aiexposes a local MCP server so agents can push status directly to workstream.airather than having workstream.aiscrape it from messaging platforms. This is architecturally cleaner for agents that natively support MCP and removes the dependency on a messaging platform as the intermediary.

The MCP server exposes tools that agents can call:
- `workstream_report_status(workItemId, status, message)` — agent proactively reports its state
- `workstream_request_approval(workItemId, description, options)` — agent requests a human decision
- `workstream_complete(workItemId, summary)` — agent marks a work item done

This means workstream.aiworks in two modes simultaneously: **passive** (scraping messages from platform adapters) and **active** (receiving direct pushes from MCP-capable agents). As the agent ecosystem matures toward MCP, passive scraping becomes the legacy path and active push becomes the norm. Both are always supported.

---

## Extensibility Model

workstream.ai isdesigned to be extended without forking. The extension points are:

| Extension type | Interface | Location | Who builds it |
|---|---|---|---|
| Messaging platform | `PlatformAdapter` | `core/adapters/platforms/` | Community |
| Task / PM tool | `TaskAdapter` | `core/adapters/tasks/` | Community |
| Version control | `TaskAdapter` (same interface) | `core/adapters/vcs/` | Community |
| Model provider | `ModelProvider` | `core/classifier/providers/` | Community |
| Work item extractor | `Extractor` | `core/graph/extractors/` | Community |
| MCP tool | `MCPTool` | `core/mcp/tools/` | Community |

Custom action templates (what "Approve" sends to a given agent type) are configurable per-agent in the context graph — no code required.

---

## MVP Scope

The MVP validates one hypothesis: that agent conversation status can be extracted reliably enough from free-form messages to power a useful inbox. Everything is built to test that, and nothing beyond it.

### In scope
- Slack platform adapter (read threads, post replies as operator)
- Status classifier with model-agnostic provider interface (default: Claude claude-sonnet-4-6)
- Context graph (SQLite, local-first)
- Work item linking via pattern extraction
- Jira task adapter (enriches work items with real ticket data — used by reference fleet)
- Inbox UI (Tauri, single screen)
- Action buttons + free-text reply, posting back to Slack as the operator
- MCP server with `workstream_report_status`, `workstream_request_approval`, `workstream_complete` tools
- macOS build (primary), Linux build (secondary)

### Explicitly out of scope for MVP
- Telegram, WhatsApp, Teams, Discord adapters
- GitHub, Bitbucket, Linear, Asana adapters (post-MVP)
- Terminal session attachment
- Multi-user / team features
- Cloud sync or hosted version
- Fine-tuned / specialized small language model
- Windows build
- Settings UI beyond initial credential setup
- Billing, SaaS infrastructure, or analytics

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Desktop shell | Tauri (Rust) | Smaller binary than Electron, better performance, native OS integration |
| UI | React + TypeScript | Familiar, fast to build, embeds cleanly in Tauri WebView |
| Styling | Tailwind CSS | Minimal setup, consistent design system |
| Context graph | SQLite (WAL mode) via `better-sqlite3` | Local-first, zero dependencies, fast reads, portable |
| Status classifier | Model-agnostic (OpenAI-compatible API) | Works with Claude, GPT-4, Mistral, Ollama — operator's choice |
| Slack integration | Slack Web API + polling | Standard, well-documented, supports posting as user |
| MCP server | `@modelcontextprotocol/sdk` | Official MCP SDK, standardised agent tool interface |
| Build/package | Tauri bundler | Cross-platform native installers |
| Testing | Vitest (unit), Playwright (e2e) | Fast, TypeScript-native |

**Theming:** See [`docs/theming.md`](docs/theming.md) for the color system, theme swap mechanism, and status color conventions.

---

## Repository Structure

```
workstream/
├── CLAUDE.md                        # This file — persistent project context
├── LICENSE                          # MIT
├── README.md
├── src-tauri/                       # Rust/Tauri shell
│   ├── src/main.rs
│   └── tauri.conf.json
├── src/                             # React frontend (Tauri WebView)
│   ├── components/
│   │   ├── Inbox.tsx
│   │   ├── WorkItem.tsx
│   │   └── ReplyBar.tsx
│   ├── App.tsx
│   └── main.tsx
├── core/                            # Platform-agnostic engine (TypeScript)
│   ├── classifier/
│   │   ├── index.ts                 # Classifier orchestration
│   │   ├── prompt.ts                # The classifier prompt (tunable)
│   │   └── providers/
│   │       ├── interface.ts         # ModelProvider interface
│   │       ├── anthropic.ts         # Claude (default)
│   │       ├── openai.ts            # OpenAI / any compatible endpoint
│   │       └── ollama.ts            # Local model via Ollama
│   ├── graph/
│   │   ├── db.ts                    # SQLite connection + migrations
│   │   ├── schema.ts                # WorkItem, Thread, Event, Agent types
│   │   ├── linker.ts                # Work item ID extraction
│   │   └── extractors/
│   │       ├── interface.ts         # Extractor interface
│   │       └── default.ts           # Regex-based ticket/PR extraction
│   ├── adapters/
│   │   ├── platforms/
│   │   │   ├── interface.ts         # PlatformAdapter interface
│   │   │   └── slack/               # Reference platform adapter
│   │   │       ├── index.ts
│   │   │       └── auth.ts
│   │   └── tasks/
│   │       ├── interface.ts         # TaskAdapter interface
│   │       └── jira/                # Reference task adapter
│   │           ├── index.ts
│   │           └── auth.ts
│   └── mcp/
│       ├── server.ts                # MCP server bootstrap
│       └── tools/
│           ├── report-status.ts
│           ├── request-approval.ts
│           └── complete.ts
├── docs/
│   ├── adapters.md                  # How to build a community adapter
│   └── mcp.md                       # How to connect an agent via MCP
├── tests/
│   ├── classifier/
│   ├── graph/
│   └── adapters/
└── package.json
```

---

## Build Phases

**Phase 1 — Prove the classifier (Weeks 1–2)**
Build the Slack reader and status classifier in isolation. No UI. Run it against a real fleet and log classifications to stdout. Measure accuracy against human-labeled examples. Define "good enough" before moving on. If the classifier doesn't work at 80%+, nothing else matters. Also stand up the Ollama provider so the classifier can run fully locally from day one.

**Phase 2 — Build the context graph (Weeks 2–3)**
Wire classifier output into SQLite. Implement work item linking (ticket ID extraction, agent attribution, thread-to-item mapping). Add the Jira task adapter to enrich work items with real ticket data. Test against real historical Slack threads — the graph should correctly associate related threads after processing a week of history.

**Phase 3 — Inbox UI, read-only (Weeks 3–5)**
Build the Tauri app with the single inbox screen. Read from the context graph. Display classified items. No actions yet — read-only to validate the display model and confirm the right things are surfacing.

**Phase 4 — Bidirectional messaging + MCP (Weeks 5–6)**
Add action buttons and free-text reply. Wire back to Slack API, posting as the authenticated operator. Stand up the MCP server with the three core tools. Test both paths end-to-end: passive (agent posts to Slack → inbox surfaces item) and active (agent calls `workstream_request_approval` directly → inbox surfaces item).

**Phase 5 — Dogfood (Weeks 6–8)**
Run exclusively on one real fleet (the reference deployment). Measure: does the operator stop opening Slack to check on agents? Fix what breaks. Write the adapter contribution guide. Only open source after this works cleanly for one real team.

---

## Success Criteria

The MVP succeeds when one person — the operator running the reference fleet — goes two weeks without opening Slack to check on their agents. Not because Slack is gone, but because the inbox showed them everything they needed and let them act on it without leaving the app.

Secondary criteria:
- Classifier accuracy: 80%+ on the reference fleet's message patterns within 7 days
- Latency: new agent messages appear in inbox within 60 seconds of being posted
- Zero false positives that require the operator to open Slack to understand context
- MCP server: at least one agent on the reference fleet reporting status via MCP by end of Phase 5

---

## Key Design Decisions Already Made

- **MIT license.** Maximum community adoption.
- **Post as operator, not bot.** workstream.aisends replies using the operator's token. Non-negotiable.
- **Local-first context graph.** SQLite on the operator's machine. No cloud dependency.
- **No chat interface.** workstream.ai isan inbox with actions, not a chat window.
- **Model-agnostic classifier.** Any OpenAI-compatible endpoint, including Ollama for fully local operation.
- **MCP server from the start.** Agents should be able to push status to workstream.aidirectly; don't make passive scraping the only path.
- **Adapters are the community's job.** Slack + Jira are the reference implementations. Document the interfaces well.
- **Foundation model for classifier, not fine-tuned model.** The prompt is the IP. Fine-tuning is a v2+ decision.

---

## Open Questions (to resolve during build)

1. **Slack authentication model**: OAuth app (requires Slack app approval, more portable) vs. user token via existing workspace (faster for MVP, less portable). Decide before Phase 1.
2. **Real-time vs. polling**: Slack Events API (requires public webhook) vs. polling the conversations API every 30s. Polling is fine for MVP; Events API is Phase 2.
3. **Classifier prompt tuning UX**: How does an operator improve accuracy for their fleet? YAML few-shot examples in a config file? In-app thumbs up/down feedback? Decide in Phase 3.
4. **MCP server transport**: stdio (simpler, works for local agents) vs. SSE over HTTP (works for remote agents). Start with stdio; add HTTP in Phase 4.
5. **Open source release timing**: After Phase 5 (one working fleet) or earlier to attract contributors? Lean toward after Phase 5.

---

## Reference Fleet

The reference deployment for Phase 5 dogfooding is the InsureTax agent fleet:
- ~19 agents including Levy (orchestrator), Byte (coding), Pixel (creative), Norma (voice/outbound calling), Guardian (compliance)
- Communicates primarily via Slack (`#agent-orchestrator` channel + direct messages)
- Work items tracked in Jira (AI-xxx, IT-xxx, MS-xxx prefixes)
- Runs on EC2, managed via OpenClaw gateway
- Overnight dispatches, morning shift summaries posted by Levy to `#agent-orchestrator`

This fleet is the ground truth for classifier training examples and UX decisions. When in doubt, ask: would this have helped the InsureTax operator stop opening Slack?
