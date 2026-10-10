# Roadmap — October 2026

Priorities after the April–October 2026 pause. The aim is unchanged: one operator goes two weeks without
opening Slack to check on their agents. The biggest gap is that the core hypothesis (≥80% classifier
accuracy on the reference fleet) has never been measured.

## Now — before Nov 16, 2026

1. **Slack app check.** Slack retires classic apps on Nov 16, 2026. Since Mar 3, 2026, apps not on the
   Marketplace are limited to 1 req/min and 15 objects on `conversations.history`/`.replies`.
   Internal (customer-built) apps keep the old limits. Confirm the reference install is an internal,
   non-classic app, and state in `docs/slack-setup.md` that each operator creates their own app.
2. **Move the default model off `claude-sonnet-4-6`** (now legacy). Run the comparison in step 3 first,
   then pick the default from the results. Haiku 5.5 is the likely candidate.

## Next — prove the hypothesis

3. **Classifier eval set** ✅ *drafted* (`core/eval/`).
   - `npm run eval:sample` draws 30 messages per status from `workstream.db` into `eval-data/`
     (gitignored, because it holds real fleet messages).
   - `npm run eval:label` is a keyboard labeler that pre-fills each message with the live classifier's answer.
   - `npm run eval:run -- --backend production,classifier,llm,typesafe` reports:
     - accuracy against the 80% target, per-class F1 and the confusion matrix
     - **unnecessary and missed interrupts**
     - calibration (ECE)
     - latency and tokens
   - **Left to do:** label the first 150 items, record a baseline, and add work-item-linking labels.
4. **Decision interface + Jev** ✅ *drafted* (`core/decisions/`).
   - `DecisionProvider` answers typed questions about one message and returns probabilities:
     choice (1–255 options), score (2–10 levels) or yes/no.
   - Backends:
     - `LLMDecisionProvider`: any OpenAI-compatible or Anthropic endpoint, including Ollama.
       This is the local default.
     - `TypeSafeDecisionProvider`: TypeSafe Jev. Hosted and **optional**, never required.
   - `classification.ts` covers the closed-set decisions: status, whether the item belongs in the
     operator's inbox, and which candidate work item a message continues. Free text (title, next action)
     stays with the LLM and is only generated for items that surface.
   - **Left to do:** compare backends on the labeled set. If decisions win, add a `classifier.mode`
     config and run decisions on every message, with the LLM writing text only for surfaced items.
     Then use the threshold sweep to choose an interrupt threshold.
5. **Operator persona** (plan `2026-04-17-operator-persona.md`): add "Not for me" and correction capture.
   Every correction becomes a new labeled eval item and a live count of unnecessary interrupts.

## Then — strategic

6. **MCP over Streamable HTTP, on spec 2026-07-28.** The reference fleet runs on a cloud VM, so the stdio-only
   push path never reaches it. Have `workstream_request_approval` block until the operator answers,
   using the Tasks extension or multi-round-trip requests.
7. **Runtime sources beyond chat.** Read events from the agent gateway, Claude Code / Codex sessions
   or OTel GenAI traces, which gives structured status and avoids Slack rate limits. Slack stays the
   channel for replies.
8. **GitHub/Bitbucket task adapter.** Agent work mostly ends in a PR, so show PR state next to the item.

## Before open-sourcing

9. **Self-contained desktop build.** Tauri currently starts the engine with `npx tsx` from the project
   root (`src-tauri/src/lib.rs`). Ship the engine as a bundled sidecar instead.
10. **Update CLAUDE.md to match the product** (Stream view, Sidekick, Fleet Board, settings, folder
    layout, default model). Add the README, LICENSE, `docs/adapters.md` and `docs/mcp.md`.

## Cleanup

- `core/server.ts` declares `findThreadForWorkItem` twice (around lines 700 and 719); the first one is dead.
- Drop `threads.work_item_id` (Task 9 of the junction plan) and tick off that plan's checkboxes.
- Delete the unused `ContextPane.tsx` and `WorkItemCard.tsx`.
- Rename the leftover `current_atc_status` column.

## Jev caveats

- Hosted only, with no self-hosting, so it conflicts with "self-hostable by default". It stays an
  optional backend behind `DecisionProvider`.
- Agent messages are untrusted input. Both providers keep the message separate from the questions,
  and rules that matter (operator as the backstop for blocks) stay in code.
- Its documented weak spots are dates, counting and double negatives. Staleness and anomaly logic
  stays in `core/graph/anomalies.ts`.
- Calibration is a vendor claim. The eval's ECE and threshold sweep measure it on our own data.
