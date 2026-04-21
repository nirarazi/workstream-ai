# Stream Redesign — Live Work Item Feed

## Goal

Redesign the Stream view as a live, work-item-level activity feed inspired by Slack's Activity view and Paperclip AI's organizational awareness — purpose-built for operators of mixed human+AI fleets. The operator should be able to triage their entire fleet's work from a single screen, act without leaving the app, and trust that nothing requiring their attention will be missed.

## Context & Motivation

**Slack Activity** (Jan-Mar 2026) proved that a unified notification feed with smart filtering is a compelling UX pattern. It does four things well: relevance filtering, action state tracking ("Replied"), side-by-side list+detail, and a live feel. But it's platform-locked, notification-centric (not work-item-centric), has no auto-resolve, and no task system awareness.

**Paperclip AI** (57K+ stars) proved that operators of AI agent fleets need organizational awareness — seeing all active work, who's doing what, and what's blocked. But it has no communication platform integration; everything lives in its own task/comment system.

**workstream.ai** already bridges both worlds — it reads from Slack, links to Jira, classifies messages with an LLM, and surfaces only what the operator needs. But the current UX is two disconnected views (Stream inbox + Fleet table) with a full-screen overlay detail pane. This redesign makes the Stream feel like a live, intelligent activity feed where the operator can scan, deep-dive, act, and move on — all in one fluid motion.

## Target User

A single operator of an AI agent fleet (~10-50 agents), working in an environment that also includes human teammates. The operator is the backstop — agents and humans escalate to them when blocked. The operator needs to distinguish: agent blocked on me, agent blocked on a human teammate, human asking me something, and noise.

## Architecture

Two primary views accessed via top-level tabs:

- **Stream** (default, this spec) — Live work-item-level activity feed. The operator's inbox.
- **Fleet** (unchanged) — Agent-centric monitoring view for status, progress, cost, anomalies. Not part of this redesign.

---

## Stream View

### Layout

**Desktop:** Persistent two-panel layout. Left panel (45%) is the work item list. Right panel (55%) is the detail view for the selected item.

**Mobile:** Single-panel with drill-in/back navigation. List view → tap item → detail view → back button returns to list.

### Filter Tabs

Three filter tabs at the top of the list panel:

1. **Needs me** (default) — Items where `targetedAtOperator: true`, not resolved, not noise. The operator's hot queue. Badge count shown on the tab and the macOS dock icon.
2. **All active** — Every non-completed, non-noise work item across the fleet. No `targetedAtOperator` filter. Items that are also in "Needs me" get a visual indicator. Answers "what's happening across the fleet right now."
3. **Snoozed** — Items the operator has deferred. Shows countdown timers. Items return to "Needs me" when timer expires or new activity auto-breaks the snooze.

---

## Stream List (Left Panel)

### Item Representation

Each entry represents **one work item** (not individual messages). One entry per work item ID — no duplicates.

Each item shows:
- Work item ID + title
- Agent responsible + channel name
- Status badge (Blocked / Decision / In Progress / Replied / Unblocked / Snoozed)
- Time since last activity
- Left border color-coded by status: red = blocked, amber = decision, green = replied/done, gray = snoozed

### Ordering

- Most recent activity first (newest at top)
- **Pinned items** stick to the top in a subtle "Pinned" section (thin divider, not a heavy header)
- Items the operator hasn't interacted with yet get visual priority (bolder text or unread dot)
- Snoozed items appear dimmed at the bottom of "Needs me" by default (user preference to hide entirely)

### Deduplication

When a new message arrives for a work item already in the list:
- The existing entry updates in-place (new timestamp, new preview, possibly new status badge)
- The item moves to the top of the list (most recent activity)
- No duplicate entry is created

### Action State Tracking

After the operator acts on an item, the status badge on the list entry updates:
- **Replied** (green) — operator sent a reply without clicking an action button
- **Unblocked** (green with checkmark) — operator clicked Unblock
- **Done** (green with checkmark) — operator clicked Done
- **Snoozed Xh** (amber, dimmed) — operator snoozed with remaining time shown

### Pinning

- Pin/unpin from the detail panel header or right-click context menu on list item
- Pinned items follow all normal rules (auto-resolve, snooze, re-entry)
- Resolved items (Done, Dismiss) auto-unpin
- Snoozed pinned items stay pinned but dim
- Pins persist across sessions (stored in context graph)

---

## Detail Panel (Right Panel)

Persistent right panel showing full context for the selected work item.

### Sections (top to bottom)

**Header:**
- Work item ID + status badge
- Title
- AI-generated one-line situation summary
- External link (Jira ticket, PR) with external system status
- Pin/unpin toggle

**Timeline:**
- Chat-style: oldest messages first, newest at bottom (like WhatsApp/iMessage)
- On open, auto-scroll to bottom and show the latest N messages (~5-10)
- Scrolling to the top triggers "load older messages"
- Messages from agents, humans, and the operator ("You") are visually distinguished (different avatar colors, name labels)
- Operator actions appear as timeline entries ("You unblocked this", "You replied")
- The most recent blocking message has a color-coded left border (red for blocked, amber for decision)
- Date separators for multi-day threads

**Actions bar:**
- **Unblock** (primary, cyan) — posts reply + marks as redirected/unblocked
- **Done** (green) — marks as completed
- **Dismiss** (gray) — removes from "Needs me", stays in "All active". Means "not for me right now"
- **Noise** (dark gray) — classifies as noise, removes from both views. Serves as classifier feedback signal for future improvement
- **Snooze** (amber, with dropdown) — time picker
- Dismiss is shown in "Needs me" view. In "All active" view, only Noise is shown (Dismiss is irrelevant).

**Reply field:**
- Sticky at the bottom of the panel
- @mention support for agents and humans (existing MentionInput component)
- Text is sent along with any action button click, or standalone via Enter
- "Replies to latest thread in #channel" indicator below the field

**Empty state:**
When no item is selected, the detail panel shows a brief summary: "4 items need you" or "All clear" — with quick fleet health stats.

---

## Snooze System

### Time-based with auto-break

**Snooze picker** (dropdown from Snooze button):
- 30 minutes
- 1 hour
- 3 hours
- Tomorrow morning
- Next Monday
- Custom (date/time picker)

**Behavior:**
- Snoozed items move to the "Snoozed" filter tab with a visible countdown timer
- In "Needs me", snoozed items appear dimmed at the bottom by default (configurable: user preference to hide entirely)
- Detail panel for a snoozed item shows: countdown timer, return time, "or when new activity is detected", and a "Wake now" button

**Auto-break:** If any new activity occurs on a snoozed work item (new agent message, ticket status change, new thread reply), the snooze breaks immediately and the item re-enters "Needs me" at full visibility with its updated status.

---

## Auto-resolve Rules

Items enter and leave "Needs me" based on whether the operator actually needs to act right now. "Needs me" is a live queue, not a to-do list.

### Operator actions that resolve

- **Unblock** — item fades out of "Needs me" after ~2s confirmation animation. Moves to "All active" as in_progress.
- **Done** — item fades out. Moves to completed.
- **Dismiss** — item fades out of "Needs me". Stays in "All active" with current status.
- **Noise** — item fades out of both views. Classified as noise in context graph.
- **Reply** (standalone, no action button) — item stays in "Needs me" but badge changes to "Replied". Still needs resolution.

### System auto-resolve

- Agent replies after operator unblocked → item leaves "Needs me" (agent is working again)
- External ticket status changes to resolved/closed → item leaves "Needs me"
- Classifier re-classifies based on new messages as `noise` or `completed` → item leaves "Needs me"

### Re-entry

- Any item that left "Needs me" can re-enter if a new message is classified as `blocked_on_human` or `needs_decision` with `targetedAtOperator: true`
- Snoozed items re-enter when timer expires OR auto-break triggers

---

## Liveness

### Speed
- 5-second polling interval (current behavior, proven and simple)
- New/updated items appear within one poll cycle
- Future: WebSocket upgrade path for sub-second updates (not in scope for this redesign)

### Motion
- **New items:** animate in (slide down from top of list)
- **Resolved items:** fade out (opacity transition over ~1.5s, then remove from DOM)
- **Status badge changes:** color transition animation
- **Selected item update:** subtle highlight pulse when data updates while viewing
- **Snoozed items:** smoothly animate to the bottom of the list

### Confidence signals
- Sync indicator in existing window chrome (title bar area): green dot + "Live · synced 2s ago"
- Connection issues: yellow dot + "Reconnecting..."
- Stale (>30s without sync): red dot + "Last synced 45s ago"
- No separate bottom status bar — reuse existing window chrome

### Send confirmation animation

When the operator clicks an action button (e.g., Unblock) with a reply:

1. **0ms:** Reply input flashes green border/glow. Action button pulses with confirmation color.
2. **400ms:** Input clears. Operator's message animates into the timeline ("You · just now").
3. **800ms:** Checkmark appears next to message: "Sent to #channel".
4. **1200ms:** Slack delivery confirmation: "Delivered to Slack · #channel thread".
5. **1400ms:** Status badges transition in both list and detail panel ("Blocked" → "Unblocked").
6. **1600ms:** Resolve message appears: "Unblocked · leaving stream / Will reappear if agent needs you again".
7. **2000ms:** List item fades to resolved state and eventually removes from "Needs me".

**Error state:** Reply field gets red border + shake animation with inline error message. Text preserved for retry.

**Optional confirmation sound:** A subtle audio cue on successful action delivery. Off by default, toggleable in settings. Single sound for all action types (keep it simple to start).

---

## API Changes

### Existing endpoints (unchanged)
- `GET /api/inbox` — continues to return `ActionableItem[]` for "Needs me"
- `GET /api/work-item/:id/stream` — continues to return `StreamData`
- `POST /api/action` — continues to process actions
- `POST /api/reply` — continues to post replies

### New/modified endpoints

**`GET /api/stream/all-active`** — Returns all non-completed, non-noise work items for the "All active" tab. Similar structure to `/api/inbox` but without `targetedAtOperator` filtering.

**`POST /api/action` modifications:**
- New action type: `dismiss` — inserts an event marking the item as operator-dismissed (suppresses it from "Needs me" until a new blocking event re-triggers targeting), without changing the work item's underlying status
- New action type: `noise` — reclassifies work item as noise
- Response includes a `delivered: boolean` field confirming Slack delivery for send confirmation animation

**`POST /api/work-item/:id/pin`** — Toggle pin state for a work item.

**`GET /api/work-item/:id/stream` modifications:**
- `timeline` entries support pagination: accept `before` timestamp parameter, return `hasOlder: boolean`
- Include operator's own actions in timeline

### New user preferences

Stored locally (not in context graph):
- `snooze.showInNeedsMe: boolean` (default: `true`) — whether snoozed items appear dimmed in "Needs me" or are hidden
- `sound.actionConfirmation: boolean` (default: `false`) — whether to play confirmation sound on successful action

---

## Component Changes

### Renamed/restructured
- `Inbox.tsx` → refactored into `StreamView.tsx` — the full Stream layout (list + detail)
- `WorkItemCard.tsx` → becomes the list item component within Stream
- `WorkItemStream.tsx` → becomes the detail panel component within Stream

### New components
- `StreamList.tsx` — Left panel: filter tabs, item list with animations, pin support
- `StreamDetail.tsx` — Right panel: header, timeline, actions, reply (refactored from WorkItemStream)
- `SnoozeDropdown.tsx` — Time picker dropdown for snooze action
- `SendConfirmation.tsx` — Inline animation sequence for action confirmation
- `FilterTabs.tsx` — Needs me / All active / Snoozed tabs with badge counts

### Modified components
- `SuggestedActions.tsx` — Add Noise button, snooze dropdown integration, pin toggle
- `Timeline.tsx` — Chat-style ordering (oldest first), auto-scroll to bottom, load-older pagination
- `StatusBadge.tsx` — Add action states (Replied, Unblocked) with transition animations

---

## What's NOT Changing

- **Fleet view** — stays as agent-centric table. Separate future brainstorm for agent-centric improvements.
- **Backend engine** — classifier, pipeline, context graph, adapters all stay as-is.
- **Reply semantics** — same Slack posting behavior, same MentionInput, same operator identity.
- **Data model** — `StreamData`, `ActionableItem`, `WorkItem` types stay mostly the same. Minor additions for pin state and pagination.
- **Setup/settings** — no changes to adapter configuration or onboarding.

---

## Success Criteria

1. Operator can triage all pending work items from the Stream view without opening Slack or Jira
2. Each work item appears exactly once in the list, regardless of how many messages/threads it spans
3. After acting on an item, it auto-resolves from "Needs me" within 2 seconds
4. Snoozed items auto-break and resurface when new activity occurs
5. The send confirmation animation provides clear, gratifying feedback that the action landed in Slack
6. "All active" tab gives situational awareness of the full fleet without switching to Fleet view
7. The stream feels live — items animate in/out, sync indicator shows recency, no manual refresh needed
