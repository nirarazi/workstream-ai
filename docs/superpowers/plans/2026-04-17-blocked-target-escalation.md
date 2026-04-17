# Blocked Target & Escalation Rules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the boolean `targetedAtOperator` with a structured `blockedTarget` field that identifies WHO an item is blocked on, and add configurable escalation rules that promote items to the operator's inbox based on conditions (e.g., "blocked on anyone for >3h → escalate to operator").

**Architecture:** The classifier returns a `blocked_target` string (e.g., "operator", "Guy", "sales team", "infrastructure") instead of just true/false. A rules engine evaluates work items against configurable escalation rules and promotes items that match. The inbox shows promoted items with an "escalated" badge explaining why.

**Tech Stack:** TypeScript, SQLite, YAML config (rules), React (escalation badges)

**Depends on:** `targetedAtOperator` (already shipped), Operator Persona plan (recommended but not required)

---

### Task 1: Replace `targetedAtOperator` with `blockedTarget`

Evolve the boolean into a structured field that captures who the item is blocked on.

**Files:**
- Modify: `core/types.ts` — Add `blockedTarget: string | null` to `Event` and `Classification` (keep `targetedAtOperator` for backward compat, derive it from `blockedTarget`)
- Modify: `core/graph/schema.ts` — Add `blocked_target TEXT` to `EventRow`
- Modify: `core/graph/db.ts` — Migration: add `blocked_target` column, backfill from `targeted_at_operator` (1 → "operator", 0 → "unknown")
- Modify: `core/graph/index.ts` — Wire through `toEvent`, `insertEvent`, queries
- Modify: `config/prompts/classify.yaml` — Replace `targeted_at_operator` with `blocked_target` in output spec. Values: "operator", a person's name, a team name, "infrastructure", "external_service", or null (not blocked)
- Modify: `core/classifier/index.ts` — Parse `blocked_target`, derive `targetedAtOperator` from it (`blockedTarget === "operator"`)
- Test: `tests/graph/blocked-target.test.ts`

- [ ] **Step 1:** Write failing test — insert event with `blockedTarget: "Guy"`, verify it round-trips
- [ ] **Step 2:** Add migration, schema type, wire through graph layer
- [ ] **Step 3:** Update classifier prompt and parser
- [ ] **Step 4:** Verify `targetedAtOperator` is derived correctly (backward compat)
- [ ] **Step 5:** Commit

### Task 2: Escalation rules config

Define a YAML-based rule format that specifies when items should be promoted to the operator's inbox.

**Files:**
- Create: `core/escalation/rules.ts` — Rule parser and evaluator
- Modify: `core/config.ts` — Add `escalation.rules` to ConfigSchema
- Modify: `config/default.yaml` — Default rules
- Test: `tests/escalation/rules.test.ts`

**Rule format:**
```yaml
escalation:
  rules:
    - name: "Stale block escalation"
      description: "Any item blocked on anyone for more than 3 hours"
      condition:
        status: ["blocked_on_human", "needs_decision"]
        blockedTarget: ["!operator"]  # any target EXCEPT operator (those are already in inbox)
        staleDuration: "3h"
      action: escalate
      priority: medium

    - name: "Agent-facing block"
      description: "Items blocked on a specific agent that hasn't responded"
      condition:
        status: ["blocked_on_human"]
        blockedTarget: ["agent:*"]  # any agent
        staleDuration: "1h"
      action: escalate
      priority: high

    - name: "Never escalate leads"
      description: "CRM lead alerts never escalate regardless of duration"
      condition:
        channel: ["leads-from-dev", "leads-from-prod"]
      action: suppress
```

- [ ] **Step 1:** Define `EscalationRule` and `RuleCondition` types
- [ ] **Step 2:** Write failing test — rule matches a stale blocked item
- [ ] **Step 3:** Implement `evaluateRules(workItem, latestEvent, rules)` → `{ escalated: boolean, rule: string, priority: string } | null`
- [ ] **Step 4:** Add `staleDuration` check — compare `latestEvent.timestamp` to now
- [ ] **Step 5:** Test suppress rules override escalate rules
- [ ] **Step 6:** Add to ConfigSchema and default.yaml
- [ ] **Step 7:** Commit

### Task 3: Escalation evaluator in the inbox query

Run escalation rules against items that are NOT `targetedAtOperator` and promote matching ones into the inbox with an escalation badge.

**Files:**
- Modify: `core/graph/index.ts` — New method `getEscalatedItems(rules)` that queries non-operator-targeted blocked items and evaluates rules
- Modify: `core/server.ts` — Merge `getActionableItems()` + `getEscalatedItems()` in the inbox endpoint
- Modify: `core/types.ts` — Add `escalation?: { rule: string; priority: string }` to `ActionableItem`
- Test: `tests/escalation/integration.test.ts`

- [ ] **Step 1:** Write `getEscalatedItems(rules)` — queries events where `targeted_at_operator = 0` and `status IN ('blocked_on_human', 'needs_decision')`
- [ ] **Step 2:** For each candidate, evaluate rules. Return matches with the triggering rule.
- [ ] **Step 3:** Modify inbox endpoint to merge and sort: operator-targeted items first, then escalated items
- [ ] **Step 4:** Test: item blocked on "Guy" for 4h with default 3h rule → appears in inbox as escalated
- [ ] **Step 5:** Test: item from #leads-from-dev with suppress rule → does NOT appear
- [ ] **Step 6:** Commit

### Task 4: Escalation badge in the UI

Show escalated items in the inbox with a distinct visual treatment so the operator knows why they're seeing it.

**Files:**
- Modify: `src/components/WorkItem.tsx` — Show escalation badge with rule description
- Modify: `src/components/stream/StatusSnapshot.tsx` — Show "Escalated: [rule description]" below unified status
- Modify: `src/lib/api.ts` — Add escalation field to types

- [ ] **Step 1:** Add escalation info to frontend `ActionableItem` type
- [ ] **Step 2:** In `WorkItem.tsx`, render an amber badge: "Escalated · Blocked on Guy for 4h"
- [ ] **Step 3:** In `StatusSnapshot.tsx`, show escalation context below the unified status line
- [ ] **Step 4:** Commit

### Task 5: Escalation rules settings UI

Let the operator view, add, edit, and disable escalation rules from within the app.

**Files:**
- Create: `src/components/settings/EscalationRules.tsx`
- Modify: `core/server.ts` — CRUD endpoints for escalation rules
- Modify: `core/config.ts` — Write rules back to `config/local.yaml`

- [ ] **Step 1:** Add `GET /api/settings/escalation-rules` and `POST /api/settings/escalation-rules` endpoints
- [ ] **Step 2:** POST writes rules to `config/local.yaml` (same pattern as operator context apply)
- [ ] **Step 3:** Build `EscalationRules.tsx` — list view with toggle, add form, inline edit
- [ ] **Step 4:** Wire into settings panel
- [ ] **Step 5:** Commit

---

## Migration Path

This plan replaces `targetedAtOperator: boolean` with `blockedTarget: string`. The migration is:
1. Add `blocked_target` column
2. Backfill: `targeted_at_operator = 1` → `blocked_target = "operator"`, `0` → `"unknown"`
3. Keep `targeted_at_operator` as a derived/computed field for backward compat
4. Inbox query shifts from `WHERE targeted_at_operator = 1` to `WHERE blocked_target = 'operator' OR (escalation match)`

## Out of Scope

- Notification channels for escalations (Slack DM, push notification) — inbox-only for now
- Auto-resolution (e.g., "if escalated item resolves within 1h, auto-dismiss") — manual only
- Escalation chains (escalate to different people based on type) — single operator only
- ML-based escalation threshold tuning — manual config only
