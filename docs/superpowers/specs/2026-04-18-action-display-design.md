# Action Display — Spec

## Goal

Show **who** is blocking a work item and **what** they need to do, replacing the hardcoded "Waiting on you" with actor-aware status lines and a next-action description.

## Current State

- The classifier already outputs `actionRequiredFrom` (array of platform user IDs) and `nextAction` (free-text description of what needs to happen)
- These fields are computed in the pipeline but **not persisted** — `insertEvent()` discards them
- `buildUnifiedStatus()` in `core/stream.ts` uses hardcoded labels: "Waiting on you", "Needs your decision"
- The operator's identity is resolved from `getAuthenticatedUser()` on the Slack adapter, but only the messaging adapter exposes this — the task adapter does not

## Design

### 1. Operator Identities Map

**New type** in `core/types.ts`:

```typescript
// Keyed by platform/adapter name (e.g., "slack", "jira")
export type OperatorIdentityMap = Map<string, OperatorIdentity>;
```

**Collection:** The server collects operator identities from all connected adapters into a single `OperatorIdentityMap`. Each adapter that supports `getAuthenticatedUser()` contributes its entry.

**`TaskAdapter` interface change:** Add an optional `getAuthenticatedUser()` method, same signature as `MessagingAdapter`:

```typescript
getAuthenticatedUser?(): { userId: string; userName: string } | null;
```

The Jira adapter implements this by storing the authenticated user from the `connect()` response (Jira's `myself` endpoint returns the current user). Other task adapters implement it when ready.

**Server state:** `state.operatorIdentities: OperatorIdentityMap` is populated after adapters connect and updated when adapters reconnect. The pipeline and stream builder both reference this map.

### 2. Schema Migration (events table)

Add two nullable columns to the `events` table:

| Column | Type | Default |
|---|---|---|
| `action_required_from` | TEXT (JSON array of user ID strings) | NULL |
| `next_action` | TEXT | NULL |

Migration follows the existing pattern in `db.ts`: check if column exists via `pragma table_info`, add with `ALTER TABLE` if missing.

### 3. Graph Layer Changes

**`insertEvent()`** accepts two new optional fields:

- `actionRequiredFrom?: string[] | null` — serialized to JSON string for storage
- `nextAction?: string | null` — stored as-is

**Event queries** (`toEvent` mapper) deserialize `action_required_from` back to `string[]`.

**`Event` type** in `core/types.ts` gains:

```typescript
actionRequiredFrom: string[] | null;
nextAction: string | null;
```

### 4. Pipeline Changes

`processMessageInternal()` passes the new fields through to `insertEvent()`:

```typescript
this.graph.insertEvent({
  // ...existing fields...
  actionRequiredFrom: classification.actionRequiredFrom,
  nextAction: classification.nextAction,
});
```

Same for the breakdown event insertion and the completed-skip/dedup paths (those pass `null`).

### 5. Stream Layer Changes

**`buildUnifiedStatus()` signature change:**

```typescript
function buildUnifiedStatus(
  workItem: WorkItem,
  latestBlockEvent: Event | null,
  operatorIdentities: OperatorIdentityMap,
  agentNameMap: Map<string, string>,
): string
```

**Logic:**

1. If `latestBlockEvent` has `actionRequiredFrom`:
   - Check if any ID matches an operator identity (look up by the event's platform, via its thread). If match → "Waiting on you" / "Needs your decision" (preserves the status-specific label prefix)
   - Otherwise, resolve IDs to display names via `agentNameMap` → "Waiting on Guy" / "Needs Guy's decision"
   - If ID can't be resolved → use the raw ID as fallback (e.g., "Waiting on U07ABC123")
2. If `actionRequiredFrom` is null/empty, fall back to current hardcoded labels (backwards-compatible)
3. Time suffix logic (· 2h 15m) stays the same

**`StreamData` gains:**

```typescript
nextAction: string | null;
```

Populated from `latestBlockEvent.nextAction` when the work item is blocked/needs_decision. Null otherwise.

### 6. Server Changes

**`GET /api/work-item/:id/stream`** passes `operatorIdentities` and `agentMap` to `buildUnifiedStatus()`, and includes `nextAction` in the response.

The `latestBlockEvent` already has the event's thread context to determine platform for operator identity lookup.

### 7. UI Changes (StatusSnapshot.tsx)

Render `nextAction` as a gray text line below the status badge:

```tsx
{nextAction && (
  <div className="text-xs text-gray-400 mt-1 pl-0.5">{nextAction}</div>
)}
```

Only displayed when `nextAction` is non-null (i.e., blocked/needs_decision items).

### 8. Platform Resolution for Operator Matching

The `latestBlockEvent` is linked to a thread, and threads have a `platform` field. When `buildUnifiedStatus()` checks `actionRequiredFrom` against operator identities, it:

1. Looks up the thread's platform from the event's `threadId`
2. Gets the operator identity for that platform from `OperatorIdentityMap`
3. Checks if the operator's `userId` is in `actionRequiredFrom`

This ensures Slack user IDs are matched against the Slack operator identity, Jira user IDs against the Jira identity, etc.

To avoid a DB lookup inside `buildUnifiedStatus()`, the server passes the relevant platform string alongside the event (it already has the thread data).

## Out of Scope

- Progress stage display for in-progress items (future feature)
- Resolving user IDs to display names via platform API calls (we use agent names from the graph — already populated by the pipeline)
- Persisting operator identities to the database (they're ephemeral, re-resolved on each adapter connect)

## Visual Reference

Mockup validated in the visual companion showing four states:
1. "Waiting on Guy · 2h 15m" + "Review and approve PR #716"
2. "Waiting on you · 45m" + "Provide new DNS credentials for domain verification"
3. "Needs your decision · 1h 30m" + "Choose between 3 brand color palette options"
4. "In progress" (no action line)
