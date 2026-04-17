# Operator Persona — Evolving Classifier Context

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static `operator.context` config field into a living persona that learns from operator corrections, suggests prompt edits, and improves classification accuracy over time.

**Architecture:** The operator persona is a text block injected into the classifier system prompt. It starts as a manually written config value (already implemented). This plan adds a feedback loop: when the operator dismisses or reclassifies an item, the system records the correction, detects patterns, and suggests edits to the persona prompt. The persona lives in `config/local.yaml` and is fully operator-controlled.

**Tech Stack:** TypeScript, SQLite (corrections table), LLM (for suggestion generation), React (feedback UI)

**Depends on:** `targetedAtOperator` field (already shipped in work-item-stream branch)

---

### Task 1: Correction capture — record when the operator overrides a classification

When the operator dismisses an item from the inbox (e.g., "not for me") or reclassifies it, store the correction so we can learn from it.

**Files:**
- Create: `core/graph/corrections.ts`
- Modify: `core/graph/db.ts` (migration for `corrections` table)
- Modify: `core/graph/schema.ts` (CorrectionRow type)
- Modify: `core/server.ts` (new endpoint)
- Test: `tests/graph/corrections.test.ts`

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  work_item_id TEXT,
  original_status TEXT NOT NULL,
  original_targeted_at_operator INTEGER NOT NULL,
  corrected_status TEXT,
  corrected_targeted_at_operator INTEGER,
  correction_type TEXT NOT NULL, -- 'dismiss', 'reclassify', 'not_for_me'
  raw_text TEXT NOT NULL, -- the original message text, for pattern analysis
  channel_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 1:** Write failing test — insert a correction, retrieve it
- [ ] **Step 2:** Run test, verify it fails
- [ ] **Step 3:** Add migration in `db.ts`, add `CorrectionRow` to schema, implement `insertCorrection` and `getCorrections` in `corrections.ts`
- [ ] **Step 4:** Run test, verify it passes
- [ ] **Step 5:** Add `POST /api/work-item/:id/correct` endpoint that accepts `{ correctionType, correctedStatus?, correctedTargetedAtOperator? }`, looks up the latest event, and inserts a correction
- [ ] **Step 6:** Commit

### Task 2: "Not for me" button in the inbox

Add a quick dismiss action to the inbox that records a correction with `correction_type: 'not_for_me'` and `corrected_targeted_at_operator: false`.

**Files:**
- Modify: `src/components/stream/SuggestedActions.tsx`
- Modify: `src/lib/api.ts` (add `postCorrection` function)

- [ ] **Step 1:** Add `postCorrection(workItemId, correctionType, fields?)` to `api.ts`
- [ ] **Step 2:** Add "Not for me" button to `SuggestedActions.tsx` — visible for ALL blocked items (not just `isBlocked`), styled as a subtle dismiss action
- [ ] **Step 3:** On click, call `postCorrection` then trigger `onActioned` to refresh
- [ ] **Step 4:** Commit

### Task 3: Correction pattern detection

Periodically analyze corrections to find patterns. If the operator has dismissed 3+ items from the same channel or with similar content, generate a suggestion.

**Files:**
- Create: `core/persona/analyzer.ts`
- Test: `tests/persona/analyzer.test.ts`

**Pattern types to detect:**
- Channel patterns: "You dismissed 4 items from #leads-from-dev"
- Agent patterns: "You marked 3 items from 'CRM Bot' as not for you"
- Content patterns: "You dismissed 5 items containing 'new lead'"

- [ ] **Step 1:** Write failing test — given a list of corrections, detect channel pattern
- [ ] **Step 2:** Implement `analyzeCorrections(corrections)` returning `PatternSuggestion[]`
- [ ] **Step 3:** Each suggestion has: `type`, `description`, `suggestedPromptAddition` (the text to add to operator context)
- [ ] **Step 4:** Test content pattern detection
- [ ] **Step 5:** Commit

### Task 4: Suggestion UI

Show suggestions in the app when patterns are detected. The operator can accept (auto-appends to `operator.context` in config), dismiss, or edit.

**Files:**
- Modify: `core/server.ts` (new endpoint `GET /api/persona/suggestions`)
- Create: `src/components/PersonaSuggestion.tsx`
- Modify: `src/components/Inbox.tsx` (show suggestions banner)
- Modify: `core/server.ts` (`POST /api/persona/apply` — appends text to operator context in local.yaml)

- [ ] **Step 1:** Add `GET /api/persona/suggestions` endpoint that calls `analyzeCorrections` and returns suggestions
- [ ] **Step 2:** Add `POST /api/persona/apply` that reads `config/local.yaml`, appends the suggestion text to `operator.context`, and writes it back
- [ ] **Step 3:** Build `PersonaSuggestion.tsx` — a dismissible banner showing the suggestion with Accept/Edit/Dismiss buttons
- [ ] **Step 4:** Wire into Inbox — show banner when suggestions exist, poll on load
- [ ] **Step 5:** Test end-to-end: dismiss items → suggestions appear → accept → config updated
- [ ] **Step 6:** Commit

### Task 5: Channel affinity inference

Instead of requiring explicit channel muting, infer channel relevance from correction patterns and encode it in the operator context automatically.

**Files:**
- Modify: `core/persona/analyzer.ts` (add channel affinity scoring)

- [ ] **Step 1:** Track per-channel dismiss rate: `dismissals / total_items` for each channel
- [ ] **Step 2:** When dismiss rate > 80% over 10+ items, generate suggestion: "Channel #X appears to not require your attention. Add to operator context?"
- [ ] **Step 3:** Suggested text: `"Items from #channel-name are typically not for me unless they explicitly mention my name or request fleet-level action."`
- [ ] **Step 4:** Test with synthetic correction data
- [ ] **Step 5:** Commit

---

## Out of Scope

- Real-time persona updates (batch analysis is fine)
- ML-based pattern detection (simple counting + thresholds)
- Multi-user personas (single operator)
- Automatic application without operator approval (always suggest, never auto-apply)
