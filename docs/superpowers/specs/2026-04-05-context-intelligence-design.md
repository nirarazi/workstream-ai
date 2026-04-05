# Context Intelligence — Design Spec

Thread inheritance, manual thread management, forward/dispatch, and new thread creation.

## Problem

ATC's thread-to-work-item linking relies on ticket IDs appearing in message text. This breaks in three common scenarios:

1. **Reply inheritance (#11):** An agent starts a thread mentioning `AI-382`, but subsequent replies don't re-mention the ticket. ATC processes only the latest message, misses the link, and creates a duplicate synthetic work item.
2. **Combining threads (#10):** Multiple threads relate to the same effort but have no shared ticket ID. The operator knows they're connected but has no way to tell ATC.
3. **Forwarding context (#9):** The operator sees a blocked thread and wants to dispatch it to another agent or pull someone in — without leaving ATC to open Slack.

## Design Decisions

- **Work item as hub:** The context pane becomes the management center. Threads orbit the work item; actions radiate from it.
- **Action bar pattern (Option B):** Thread list stays clean. A persistent action bar below the conversations list holds Link / Forward / New Thread buttons. Actions open slide panels.
- **Platform-agnostic messaging:** Forward and new-thread actions go through `PlatformAdapter` interface methods, not Slack APIs directly.
- **Sidekick deferred:** Natural language support for these actions will come after the API endpoints are stable.

---

## Component 1: Thread-to-Work-Item Inheritance

**Solves:** #11 — replies in linked threads not appearing in conversations list.

### Change

In `pipeline.processMessageInternal()`, before extracting work item IDs from message text (Step 1), check if the thread already has a `work_item_id` in the graph:

```typescript
// Before Step 1 — inherit existing thread link
const existingThread = this.graph.getThread(thread.id);
if (existingThread?.workItemId) {
  allWorkItemIds.add(existingThread.workItemId);
}
```

Move `allWorkItemIds` initialization above Step 1 so inherited IDs are included in the set before extraction runs.

### Behavior

- If the thread already has a `work_item_id`, it's added to `allWorkItemIds` as a baseline.
- The extractor and classifier can still find additional IDs from the message text. Both get added.
- The thread's existing link is never lost due to a reply that doesn't mention the ticket.
- If a reply mentions a *different* ticket, both the inherited and new IDs are linked.

### Files Changed

- `core/pipeline.ts` — add inheritance check before Step 1

### Tests

- Process a message in a thread that already has a `work_item_id` but whose text contains no ticket ID. Assert the inherited ID is in the result's `workItemIds`.
- Process a message in a thread with an existing `work_item_id` where the message mentions a *different* ticket. Assert both IDs are linked.

---

## Component 2: Thread Management (Link / Unlink)

**Solves:** #10 — combining unrelated threads into a single work stream.

### Database Changes

Add `manually_linked` column to `threads` table:

```sql
ALTER TABLE threads ADD COLUMN manually_linked INTEGER DEFAULT 0;
```

Migration in `core/graph/db.ts`. When `manually_linked = 1`, the pipeline skips auto-linking for this thread (preserves operator intent).

### Graph Methods

Add to `ContextGraph`:

- `linkThread(threadId: string, workItemId: string): void` — sets `work_item_id` and `manually_linked = 1`.
- `unlinkThread(threadId: string): void` — nulls `work_item_id` and sets `manually_linked = 0` (allows auto-linking to resume).
- `getUnlinkedThreads(limit: number, query?: string): Thread[]` — returns recent threads where `work_item_id IS NULL` or starts with `thread:` (synthetic). Optional text search against `channel_name`.
- `getThread(threadId: string): Thread | null` — already exists, but ensure it exposes `manuallyLinked`.

### Pipeline Change

In `processMessageInternal()`, after computing `allWorkItemIds`, skip updating the thread's `work_item_id` if it has `manually_linked = 1`:

```typescript
const isManuallyLinked = existingThread?.manuallyLinked;
// Step 4: Upsert thread — don't overwrite manually linked work item
this.graph.upsertThread({
  ...threadData,
  workItemId: isManuallyLinked ? existingThread.workItemId : primaryWorkItemId,
});
```

### API Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/work-item/:id/link-thread` | `{ threadId: string }` | `{ ok: true }` |
| POST | `/api/work-item/:id/unlink-thread` | `{ threadId: string }` | `{ ok: true }` |
| GET | `/api/threads/unlinked` | query: `?limit=20&q=search` | `{ threads: Thread[] }` |
| POST | `/api/work-item/:id/link-url` | `{ url: string }` | `{ ok: true, threadId: string }` |

`link-url` parses the Slack thread URL to extract channel ID and thread timestamp, fetches the thread via the platform adapter if not already in the graph, then calls `linkThread()`.

### UI — Link Thread Panel

Triggered by "+ Link thread" button in the action bar. Opens a dropdown panel:

- **Top:** Search input filtering by channel name or message text.
- **Body:** List of recent unlinked threads (last 7 days, max 20). Each row shows channel name, latest message preview (truncated), and relative timestamp. Click to link.
- **Bottom:** Text input labeled "Or paste a Slack thread URL". Submit resolves and links.

### UI — Unlink

Manually-linked threads show a subtle × icon and a "manually linked" badge. Clicking × calls `unlink-thread`, which resets `manually_linked = 0` and nulls `work_item_id`.

Auto-linked threads don't show the unlink icon (unlinking would be overridden on next poll).

### Files Changed

- `core/graph/db.ts` — migration for `manually_linked` column
- `core/graph/schema.ts` — add `manually_linked` to `ThreadRow`
- `core/graph/index.ts` — `linkThread`, `unlinkThread`, `getUnlinkedThreads` methods
- `core/types.ts` — add `manuallyLinked` to `Thread` type
- `core/pipeline.ts` — respect `manually_linked` flag
- `core/server.ts` — 4 new endpoints
- `src/lib/api.ts` — typed API functions for new endpoints
- `src/components/ContextPane.tsx` — action bar, link panel, unlink icon

### Tests

- Link a thread, verify `manually_linked = 1` and `work_item_id` is set.
- Unlink a thread, verify `manually_linked = 0` and `work_item_id` is null.
- Process a message in a manually-linked thread — verify the pipeline doesn't overwrite `work_item_id`.
- `getUnlinkedThreads` returns threads with no work item or synthetic IDs, respects limit and search.
- `link-url` endpoint resolves a Slack URL and links correctly.

---

## Component 3: Forward / Dispatch

**Solves:** #9A — forwarding context from one thread to an agent or channel.

### Platform Adapter Interface

Add two methods to `PlatformAdapter`:

```typescript
interface PlatformAdapter {
  // ... existing ...

  /** Post a new top-level message in a channel */
  postMessage(channelId: string, message: string): Promise<{ threadId: string }>;

  /** Open a DM with a user and post a message */
  sendDirectMessage(userId: string, message: string): Promise<{ channelId: string; threadId: string }>;
}
```

### Slack Adapter Implementation

- `postMessage`: calls `chat.postMessage` without `thread_ts`, returns the message's `ts` as `threadId`.
- `sendDirectMessage`: calls `conversations.open` to get/create the DM channel, then `chat.postMessage`. Returns both the DM channel ID and message `ts`.

Both use `as_user: true` and go through `withRateLimitRetry`.

### API Endpoint

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/forward` | see below | `{ ok: true, threadId: string, channelId: string }` |

Request body:
```typescript
{
  sourceThreadId: string;
  sourceChannelId: string;
  targetId: string;         // user ID or channel ID
  targetType: "user" | "channel";
  quoteMode: "latest" | "full";  // default: "latest"
  includeSummary: boolean;        // default: false
  note?: string;
}
```

### Message Composition (server-side)

The server assembles the forwarded message — the adapter just sends a string:

```
{note}

> Forwarded from #{channelName}:
> "{quoted content}"

{optional summary as bullet points}
```

- `quoteMode: "latest"` — quotes only the last message in the source thread.
- `quoteMode: "full"` — quotes all messages, each prefixed with the author name.
- `includeSummary: true` — appends the AI-generated summary if one exists for the work item.

### Side Effect

The response includes the new `threadId` and `channelId`. The server proactively links this new thread to the same work item as the source thread (using `graph.linkThread` with `manually_linked = 0` so it behaves as auto-linked).

### UI — Forward Panel

Triggered by "↗ Forward" button in the action bar (requires a selected thread). Opens a slide panel:

- **To:** `MentionInput` typeahead for agents and channels.
- **Quote:** Shows latest message text. Toggle: `Latest message | Full thread`.
- **Attach summary:** Checkbox. Disabled with "(no summary available)" if none exists.
- **Your note:** Free text input.
- **Send / Cancel** buttons.

### Files Changed

- `core/adapters/platforms/interface.ts` — add `postMessage`, `sendDirectMessage`
- `core/adapters/platforms/slack/index.ts` — implement new methods
- `core/server.ts` — `POST /api/forward` endpoint, message composition logic
- `src/lib/api.ts` — typed `postForward` function
- `src/components/ContextPane.tsx` — forward panel in action bar

### Tests

- Slack adapter `postMessage` calls `chat.postMessage` without `thread_ts`.
- Slack adapter `sendDirectMessage` calls `conversations.open` then `chat.postMessage`.
- Forward endpoint with `quoteMode: "latest"` includes only last message.
- Forward endpoint with `quoteMode: "full"` includes all messages.
- Forward endpoint with `includeSummary: true` appends summary when available.
- New thread is proactively linked to source work item.

---

## Component 4: New Thread (Dispatch)

**Solves:** #9B — dispatching a new thread to an agent in the context of a work item.

### API Change

Extend `POST /api/reply` to support threadless messages:

- When `threadId` is omitted and `channelId` is provided: call `adapter.postMessage(channelId, message)`.
- When `threadId` is omitted and `targetUserId` is provided: call `adapter.sendDirectMessage(targetUserId, message)`.
- Existing behavior (both `threadId` and `channelId` provided) unchanged.

Updated request body:
```typescript
{
  threadId?: string;
  channelId?: string;
  targetUserId?: string;
  message: string;
}
```

Response includes `{ ok: true, threadId: string, channelId: string }` for new threads.

### Side Effect

Server proactively links the new thread to the work item from which the action was initiated (passed as a query parameter or body field: `workItemId`).

### UI — New Thread Panel

Triggered by "⊕ New thread" button in the action bar. Opens a slide panel:

- **To:** `MentionInput` typeahead (agents and channels).
- **Message:** Free text input.
- **Send / Cancel** buttons.

No quote section — this is a fresh message, not a forward.

### Files Changed

- `core/server.ts` — extend `POST /api/reply` for threadless messages
- `src/lib/api.ts` — update `postReply` signature
- `src/components/ContextPane.tsx` — new thread panel in action bar

### Tests

- Reply endpoint with no `threadId` + `channelId` calls `adapter.postMessage`.
- Reply endpoint with no `threadId` + `targetUserId` calls `adapter.sendDirectMessage`.
- New thread is proactively linked to the specified work item.

---

## Implementation Order

Each component is independently shippable:

1. **Thread Inheritance** — pipeline-only, no UI, no new endpoints. Can ship immediately.
2. **Thread Management** — schema migration + API + UI. Depends on nothing.
3. **Forward** — requires new adapter interface methods. UI builds on action bar from #2.
4. **New Thread** — reuses adapter methods from #3. UI builds on action bar from #2.

Components 3 and 4 depend on 2 (for the action bar UI) and share adapter methods. Component 1 is fully independent.

## Out of Scope

- Sidekick / natural language integration for these actions
- Drag-and-drop thread reordering
- Bulk operations (link multiple threads at once)
- Cross-platform forwarding (e.g. Slack → Telegram)
- Auto-suggested thread links ("these threads might be related")
