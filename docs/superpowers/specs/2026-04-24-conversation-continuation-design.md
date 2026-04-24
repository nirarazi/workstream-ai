# Conversation Continuation & Work Item Merge

**Date:** 2026-04-24
**Status:** Approved

## Problem

Non-threaded messages in DM channels (and occasionally in regular channels) each create a separate synthetic work item, even when they're part of the same conversation. In Slack DMs, threading is supported but rarely used — people send sequential messages. The pipeline treats each standalone message as its own "thread" (`thread_ts === ts`), which creates a separate `thread:$ts` synthetic work item per message.

**Example:** Guy sends "I'm OK with it. But would a partner?" and Nir replies 2 minutes later with "No big difference from floating it over..." — these are the same conversation but create two separate work items with different titles.

Deterministic grouping (time windows, same-participant heuristics) cannot reliably distinguish continuations from new topics. The classifier already has the infrastructure to receive candidate work items — it just lacks the message content needed to judge semantic continuity.

## Solution Overview

Two complementary features:

1. **Auto-grouping via classifier enrichment** — enrich the existing classification prompt with recent channel message content so the LLM can recognize continuations
2. **Manual merge** — four interaction patterns for operators to merge work items when auto-grouping misses

Conservative by design: under-merge (split related messages) is preferred over over-merge (jumble unrelated ones), because manual merge provides a quick, delightful escape hatch.

## Auto-Grouping: Classifier Enhancement

### Pipeline Changes

When processing a non-threaded message (where `thread_ts === ts`, i.e. a standalone message that is the root and only message in its "thread"), the pipeline gathers **recent channel context** — the last N non-threaded messages from the same channel that already have work items — and passes their content alongside the candidate work items to the classifier.

The classifier already receives candidates with titles and graph-signal reasons. The enhancement: for candidates that came from the **same channel** and are **recent non-threaded messages**, include the actual message text. This gives the LLM enough context to judge semantic continuity rather than relying on title keyword overlap alone.

### Classifier Prompt Addition

When channel context exists, a new section is appended to the system prompt:

> "The following recent messages are from the same channel. If this new message is a continuation of one of these conversations (a reply, follow-up, or related remark), return that work item's ID in workItemIds. If it's a new, unrelated topic, return empty workItemIds as usual."

Each context message includes: sender name, relative timestamp, text snippet (truncated to ~200 chars), and its work item ID.

### Pipeline Flow

1. Before classification, query the graph for recent non-threaded messages in the same channel (configurable window, default 30 minutes, max 5 messages)
2. Enrich the candidate list with these messages' actual content
3. If the classifier returns an existing work item ID → link this thread to it; update title if the classifier suggests a refined one
4. If the classifier returns empty workItemIds → create synthetic work item as before (current behavior)

### Chronological Processing Fix

Slack's `conversations.history` returns messages newest-first. Currently, within a single poll batch, a newer message may be processed before the older one it's a continuation of — meaning there's no existing work item to find as a candidate.

**Fix:** Sort messages oldest-first before processing. This ensures the earlier message always creates the work item before the later message's classification runs.

### Channel Context Query

New graph method to fetch recent non-threaded messages from a channel:

```typescript
getRecentChannelContext(params: {
  channelId: string;
  windowMinutes?: number;  // default 30
  limit?: number;          // default 5
  excludeThreadId?: string; // exclude the current message's thread
}): Array<{
  workItemId: string;
  workItemTitle: string;
  senderName: string;
  text: string;           // truncated to ~200 chars
  timestamp: string;
}>
```

This joins `events` → `threads` → `work_items` to find recent classified messages from standalone threads in the same channel.

## Merge Backend

### The Merge Operation

A single graph method: `mergeWorkItems(sourceId, targetId)`:

1. Re-link all threads from `sourceId` to `targetId` (update `threads.work_item_id`)
2. Re-link all events from `sourceId` to `targetId` (update `events.work_item_id`)
3. Update the target's title if the source has a more descriptive one
4. Soft-delete the source work item by setting `merged_into = targetId`

The merge is purely structural — no status inference. The target's status stays as-is. The next classification against the merged work item will have the LLM reassess status with full context naturally.

### Undo Support

The `merged_into` column on `work_items` records the merge target and enables reversal.

**Undo within toast window (5 seconds):**
1. Re-link threads and events back to `sourceId`
2. Clear `merged_into` on the source
3. Restore original status/title on both items

**After toast expires:** merge is still reversible via an "unmerge" action, but isn't one-click anymore.

### Schema Change

One new column: `work_items.merged_into TEXT` (nullable, references another work item ID).

Work items with `merged_into IS NOT NULL` are excluded from stream queries (they don't appear in the list).

### API Endpoints

- `POST /api/work-item/:targetId/merge` — body: `{ sourceId }` — performs the merge, returns the updated target
- `POST /api/work-item/:sourceId/unmerge` — reverses a merge using the `merged_into` pointer

## Manual Merge UX

Four interaction layers, all shipping together:

### A) "Same conversation?" Contextual Suggestion (Detail Panel)

Appears when viewing a work item and the operator recently viewed another item from the same channel (within the last 5 items viewed). A subtle banner at the top of the detail panel showing: channel context, the other item's title, a "Merge" button, and a dismiss "✕".

- Dismissing hides the suggestion for that pair permanently (stored client-side)
- Clicking "Merge" triggers the merge operation + animation
- This turns manual merge from "operator does cleanup" into "app confirms what it suspects"

### B) "Merge into..." Action Button (Detail Panel)

Lives in the action bar alongside Unblock, Done, Dismiss.

- Opens a dropdown: recently viewed items listed at top, search field below
- Selecting an item triggers the merge
- Provides a fallback for when the contextual suggestion doesn't appear or the target isn't a recently-viewed item

### C) Drag to Merge (List View)

Drag a list item onto another to merge.

- Target glows purple on drag-hover, "Drop to merge" label appears
- On drop: source shrinks and slides into target with merge animation
- Works with multi-select: drag a selection onto another item to merge all

### D) Keyboard Shortcuts

- `M` — open "Merge into..." dropdown from detail view
- `⇧M` — instant merge with previously viewed item (no dropdown)
- `Space` — toggle select in list for multi-merge
- `⌘Z` — undo last merge (within toast window)

### Merge Animation Sequence

Shared across all entry points (drag, button, keyboard):

| Time | Action |
|------|--------|
| 0ms | Source item lifts slightly (subtle scale + shadow increase) |
| 150ms | Source shrinks to 80% and slides toward target position |
| 300ms | Source fades into target — target briefly glows purple |
| 500ms | Target's thread count increments, participant list updates |
| 600ms | Undo toast slides up from bottom |
| 5000ms | Undo toast fades — merge is finalized |

## Extensibility: Continuation Strategies

The auto-grouping logic is designed as a pluggable strategy so approaches B (two-pass) and C (hybrid heuristic) can be swapped in later or made user-configurable.

### ContinuationStrategy Interface

```typescript
interface ContinuationStrategy {
  name: string;
  findContinuation(params: {
    message: Message;
    channelId: string;
    recentMessages: RecentChannelMessage[];
    candidates: CandidateWorkItem[];
  }): Promise<ContinuationResult | null>;
}

interface ContinuationResult {
  workItemId: string;
  confidence: number;
  refinedTitle?: string;
}
```

### Implementations

- **`ClassifierInlineContinuation`** (Approach A, ships now) — enriches the existing classifier prompt with channel context. Returns `null` (delegates to normal classification flow) — the continuation logic is folded into the classify call itself.
- **`PreClassifierContinuation`** (Approach B, future) — makes a separate lightweight LLM call before classification. Returns a `ContinuationResult` if it finds a match, potentially using a cheaper/faster model.
- **`HeuristicPrefilterContinuation`** (Approach C, future) — runs deterministic checks (time window, same participants) and only triggers classifier enrichment when heuristics flag a possible match.

### Configuration

```yaml
continuation:
  strategy: "classifier-inline"  # or "pre-classifier", "heuristic-prefilter"
  channelContextWindow: 30       # minutes to look back for recent messages
  maxContextMessages: 5          # max messages to include as context
```

## Files Affected

### Backend (auto-grouping + merge)
- `core/pipeline.ts` — channel context gathering, chronological sort, strategy integration
- `core/classifier/index.ts` — prompt enrichment with channel context messages
- `core/graph/index.ts` — `getRecentChannelContext()`, `mergeWorkItems()`, `unmergeWorkItem()`, schema migration for `merged_into`
- `core/graph/db.ts` — migration adding `merged_into` column
- `core/server.ts` — `/merge` and `/unmerge` API endpoints
- `core/adapters/messaging/slack/index.ts` — sort channel history oldest-first
- `config/default.yaml` — `continuation` config section

### Frontend (manual merge UX)
- `src/components/stream/StreamDetail.tsx` — "Same conversation?" banner, "Merge into..." button
- `src/components/stream/StreamListItem.tsx` — drag source/target behavior
- `src/components/stream/StreamView.tsx` — drag-and-drop container, merge animation orchestration, undo toast, keyboard shortcuts, recently-viewed tracking
- `src/components/stream/MergeDropdown.tsx` — new component for merge target selection

### New files
- `core/continuation/interface.ts` — `ContinuationStrategy` interface
- `core/continuation/classifier-inline.ts` — Approach A implementation
- `src/components/stream/MergeDropdown.tsx` — merge target dropdown with recent items + search
