# Work Item Stream Design

**Date:** 2026-04-17
**Status:** Draft
**Prototype:** `.superpowers/brainstorm/91893-1776421281/content/work-item-stream-v2.html`

## Problem

The context graph is structurally sound but functionally empty. 93.5% of threads are orphaned (544 of 582). 96.3% of events are classified as noise. Only 6.5% of fleet activity is connected to work items. The operator still has to open Slack to understand what's going on.

Root causes:
1. **Linking depends on ticket IDs.** The linker only connects threads when agents explicitly mention Jira-format IDs (AI-xxx, IT-xxx). Most messages don't.
2. **Context doesn't accumulate.** Each message is classified in isolation. The graph doesn't build a narrative per work item.
3. **Operator actions aren't tracked.** Replies sent through workstream.ai aren't stored as events, so there's no decision log.

## Goal

Replace the current flat work item display with a **Work Item Stream** — a layered view that gives the operator enough context to act without opening Slack. The stream surfaces:

1. **Status Snapshot** — unified status, summary sentence, agents involved, channels, external links
2. **Timeline + Decision Log** — typed chronological entries showing what happened and what the operator decided
3. **Conversation Excerpts** — inline expansions of timeline entries showing the actual messages that matter
4. **Suggested Actions** — pre-drafted contextual responses the operator can send with one tap

## Design

### Status Snapshot

The top of every work item. Always visible, never collapsed.

**Elements:**
- Work item ID (if exists) and title
- Unified status with duration: "Waiting on you · 2h 14m"
- One-sentence summary of WHY it's surfacing (LLM-generated)
- Agents involved (all agents who contributed, not just assignee)
- Channels and thread count (work items span multiple threads/channels)
- External link (Jira, GitHub) — shown only when present, not a placeholder

**Key decision: unified status.** workstream.ai's status ("Waiting on you") is the primary signal. External system status (Jira: "In Review") is secondary metadata shown as a link. They don't compete visually.

**Key decision: no Jira = no Jira line.** Work items without external tickets show the same structure minus the external link. No "N/A" or empty fields.

### Timeline + Decision Log

Sits below the snapshot. **Starts collapsed** to keep the view clean. Shows summary stats when collapsed: duration, decision count, event count. Expands on click.

**Entry types:**
- ⏳ **Block** — agent waiting on the operator
- ✅ **Decision** — what the operator said/approved/rejected, with their words quoted. Visually prominent (left border highlight).
- 🔨 **Progress** — agent completed a step. Collapsible when many in one day ("Byte · 4 progress updates").
- 📋 **Assignment/handoff** — ownership or responsibility changed
- 🚩 **Escalation** — agent flagged a problem or exception

**Grouping:** By day, most recent first.

**Channel attribution:** Every entry shows which channel it came from, since work items span multiple threads/channels.

**Decision log is built into the timeline**, not a separate view. Operator decisions are visually distinct entries with the operator's actual words quoted back.

### Conversation Excerpts

Not a separate section. Excerpts are **inline expansions of timeline entries** — click a timeline entry to see the source messages.

**Principles:**
- Show the 2-3 messages that matter, not all of them
- Most recent first within expansion
- "Earlier in thread (N messages)" truncation for the rest
- Operator's own messages are never truncated away
- Cross-channel excerpts — a decision in #strategy and a block in #agent-orchestrator both appear under the same work item

### Suggested Actions

Bottom of the stream. Pinned when urgent.

**Principles:**
- Actions are **pre-drafted** — "Approve" already has a default message. Edit or send.
- Every action shows **where it goes** — "→ replies to Byte in #agent-orchestrator"
- Actions are **contextual** — generated from the block reason, not generic buttons
- Reassign routes through the orchestrator agent (Levy)
- Snooze is always available (1h, 4h, tomorrow, custom)
- Free-text reply is always available

## Graph Changes Required

### New: Entry type on events

Events currently have `status` (blocked_on_human, in_progress, etc.) but need an `entry_type` to drive the timeline:

```
decision | progress | block | assignment | escalation | noise
```

The classifier prompt extends to return `entry_type` alongside `status`. These are orthogonal: a message can be `status: blocked_on_human` with `entry_type: block`, or `status: in_progress` with `entry_type: assignment`.

### New: Operator events

When the operator sends a reply through workstream.ai, insert an event with:
- `agent_id`: null (or a special operator agent ID)
- `status`: based on the action taken (approve → completed, request changes → in_progress, etc.)
- `entry_type`: `decision`
- `raw_text`: the operator's actual message
- `thread_id`: the thread being replied to

This is the critical gap. Without operator events, the decision log has no decisions.

### New: Work-item-level summary

The `summaries` table exists but stores generic LLM summaries. Extend to store the **status snapshot summary sentence** — a one-line explanation of why this work item is surfacing right now. Regenerated asynchronously (non-blocking) when:
- Work item status changes
- New block event arrives
- Operator takes an action

The summary is generated from the most recent N events for the work item, not just the latest message. It answers: "why is this in your inbox right now?" Stale summaries (where `latest_event_id` doesn't match the newest event) are refreshed on next view.

### Improved: Cross-thread work item linking

Current state: threads link to work items via extracted ticket IDs. 93.5% fail.

**Incremental improvement path:**

**Layer 1 (immediate):** Extend the classifier to suggest a `canonical_task_name` for each message (e.g., "landing page redesign", "ACP integration rework"). Use simple normalized string matching to connect messages with the same canonical name to the same work item. This handles the case where agents discuss a task without mentioning a ticket ID.

**Layer 2 (short-term):** When a Jira ticket is later created for a task, allow merging: the operator (or an automated rule) connects the canonical name to the ticket ID. All previously-orphaned threads under that name get linked.

**Layer 3 (future):** LLM-powered entity resolution — given a new message and a list of existing work items, ask "does this belong to an existing item or is it new?" This handles synonyms, abbreviations, and context-dependent references.

### Improved: Multi-agent, multi-thread awareness

Current state: work items link to one agent (via the latest event's agent_id) and threads have a single work_item_id FK.

**Change:** The work item display aggregates across ALL threads and ALL agents that have events for that work item. The status snapshot shows "Byte, Pixel" not just "Byte". The meta shows "#agent-orchestrator, #strategy · 3 threads" not just one channel.

This requires no schema change — it's a query change. Aggregate agents and channels from the events table grouped by work_item_id.

### Unchanged: Agent roles

Agent `role` field exists but is unpopulated. For suggested actions (e.g., "reassign → notifies Levy"), the system needs to know Levy is the orchestrator. For MVP: hardcode or configure in settings. For v2: infer from message patterns (Levy assigns work → Levy is the orchestrator).

## Feasibility Assessment

| Capability | Difficulty | Approach |
|---|---|---|
| Status snapshot with summary sentence | Medium | Additional LLM call per status change, not per message |
| Timeline entry typing | Low | Extend classifier prompt to return entry_type |
| Operator event capture | Low | Insert event when reply sent through the app |
| Collapsed/expandable timeline UI | Low | Frontend only |
| Inline conversation excerpts | Low | Frontend + existing raw_text data |
| Pre-drafted suggested actions | Medium | LLM generates action options from block context |
| Canonical task name extraction | Medium | Extend classifier prompt, simple string matching |
| Cross-thread aggregation queries | Low | Query changes, no schema changes |
| Work item merging | Medium | New UI flow + graph merge operation |

## Security and Privacy Posture

The work item stream makes the graph's understanding of fleet activity more visible to the operator. This raises a legitimate question: is it "creepy" that the app understands this much?

**Defenses:**
1. **Local-first.** The context graph is a SQLite file on the operator's machine. No cloud, no telemetry.
2. **Single-user tool.** workstream.ai is the operator's personal inbox, not a team surveillance tool. The operator already has full visibility into these threads.
3. **Transparency.** Every timeline entry links to its source. The operator can verify anything the system inferred.
4. **No new access.** workstream.ai doesn't see anything the operator can't already see in Slack. It structures existing visibility, it doesn't expand it.

**Explicit boundary:** workstream.ai is the operator's personal tool, not an organizational surveillance layer. If multi-user features are ever added, they must not expose individual agent or human performance metrics to anyone other than the operator who already has that access.

## Out of Scope

- Knowledge graph database (Neo4j, etc.) — SQLite with better linking is sufficient for now
- Vector embeddings for semantic search — canonical task names with string matching first
- Fine-tuned classifier model — prompt engineering handles entry typing
- Settings UI for agent roles — hardcode/config for MVP
- Real-time streaming updates to the timeline — polling is fine
