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
   **First results (2026-10-10, 150 messages, draft labels — see caveats):**

   | Backend | Status acc. | Unnecessary / missed interrupts | Calibration error | p50 latency |
   |---|---|---|---|---|
   | Live labels in `workstream.db` | 52% | 32 / 4 | 0.36 | — |
   | Current classifier, Gemini 2.5 Flash-Lite | 57% | 52 / 2 | 0.34 | 1.1 s |
   | Current classifier, Haiku 5.5 | 57% | 44 / 2 | 0.26 | 2.0 s |
   | Decision questions, Gemini 2.5 Flash-Lite | 53% | 32 / 4 | 0.31 | 0.9 s |
   | Decision questions, Jev 1.13 (OpenRouter) | 63% | 48 / 1 | **0.18** | **0.5 s** |
   | Decision questions, Haiku 5.5 | **74%** | **21 / 1** | 0.34 | 2.5 s |

   **Second run (2026-10-11):** after Alex reviewed the 77 disputed items (8 statuses changed) and the
   action-vs-decision definitions were added to the prompt.
   - Haiku 5.5 with decision questions: **79.3%**. The current classifier with Haiku: 64.7%. Jev: 64.7%.
   - On the 77 reviewed items alone, the hard ones, the scores are 62%, 40% and 47%.
   - **21 of Haiku's 28 unnecessary interrupts are real blocks that Dana owns.**
     - A channel rule (Dana's channels never reach Alex) cuts unnecessary interrupts to 4.
     - But it also misses 4 items that Alex needs: agent and infra failures inside a business
       channel (for example an integration failing).
     - So ownership depends on channel *and* the kind of problem: business approvals go to Dana;
       infra and agent misbehaviour go to Alex.
     - That means filling in the operator's remit in config, and asking the "targeted" question with
       ownership in the state instead of forcing every block into the inbox.
   **Third run (2026-10-12): with Alex's remit in `operator.context`.** In the decision path, the remit now
   decides whether a block reaches the operator, instead of every block going to the inbox.

   | Backend | Status acc. | Unnecessary / missed interrupts | Interrupt precision |
   |---|---|---|---|
   | Current classifier, Haiku 5.5 | 65% | 34 / 5 | 23% |
   | Decision questions, Haiku 5.5 | 75% | **6 / 2** (was 28 / 2) | **68%** |
   | Decision questions, Jev 1.13 | 61% | **5 / 4** (was 52 / 1) | 69% |

   - The remit cut unnecessary interrupts by about 80%. For Haiku that came without missing anything more.
   - The current classifier barely changed, because its code still sends any block with no named person
     (`action_required_from: []`) to the operator. **The live app uses this classifier**, so it doesn't get
     this improvement until that rule changes too.
   - Haiku's status accuracy fell from 79.3% to 75.2%. The run had one parse error (fixed since), and the
     wording of the status question changed. The dip is within run-to-run noise on 150 items; check it again
     with thread context.
   **Fourth run (2026-10-12): the live classifier follows the remit, and every backend sees the thread.**
   Thread context means the thread's work item plus up to 4 earlier messages; the live pipeline now passes it too.

   | Backend | Status acc. | Unnecessary / missed interrupts | Interrupt precision |
   |---|---|---|---|
   | **Current classifier, Haiku 5.5 (what the app runs)** | **73%** (was 65%) | **11 / 0** (was 34 / 5) | 58% |
   | Decision questions, Haiku 5.5 | 75% | 6 / 2 | 68% |
   | Decision questions, Jev 1.13 | 60% | 3 / 2 | 81% |
   | **Decision questions, OpenAI Decisions (gpt-6-luna)** | 71% | **0 / 2** | **100%** |

   - OpenAI's Decisions API (public beta since 2026-10-06) is the most precise and best calibrated backend
     (calibration error 0.07), and it is fast (p50 0.3 s) at about $0.00012 per message (input tokens only).
     It missed the same 2 items as Jev, both Atlas status posts that hide a stuck agent (a ticket waiting,
     Quill not running). Haiku caught both.
   - After adding "an agent reported as stuck, waiting or not running is mine, even inside a routine status
     post" to the remit, the result was 1 unnecessary / 1 missed. With the status threshold lowered to 0.3
     it was 4 unnecessary / 0 missed, against Haiku's 11 / 0.
   - **Shipped as `classifier.mode: decisions`** (2026-10-12). The decision model decides status and inbox
     membership, while the LLM runs in parallel for titles, next actions, links and breakdowns. If the
     decision call fails, the LLM result stands. Usage is recorded under caller "decisions".
     Measured end to end through the app's own classifier path (Haiku + Luna @0.3): 4 unnecessary /
     0 missed, calibration error 0.04, p50 3.0 s (bounded by Haiku).

   - The app's own classifier gained the most: 8 points of status accuracy, a third of the unnecessary
     interrupts, and it now misses nothing that needed Alex.
   - What still stops anything reaching 80% is mostly in_progress vs noise (and in_progress read as a
     decision). Telling progress from noise doesn't change what reaches the inbox; it matters for Catch-up (6).
     **Consider making interrupts the headline metric** (unnecessary + missed, precision and recall).
     CLAUDE.md already calls it the metric that matters, and the 5-way accuracy can stay as a diagnostic.
   - Nothing reaches the 80% target yet.
   - Splitting the classifier into separate questions helped Haiku a lot (57% → 74%).
   - Jev is the fastest and best calibrated, but weak on `noise` (28% recall).
   - **Caveats:** the labels are Claude drafts, not the operator's, and Haiku is also a Claude model, so its
     lead may be inflated. Run `npm run eval:label -- --disputed` before trusting any of this.
   - **Two failure sources dominate every backend, and both are product problems, not model problems:**
     - **Messages from humans** (34 of 150, mostly Dana instructing agents) score 18–47%. They should probably
       be routed by sender in code rather than classified.
     - **Blocks owned by a second human** (Dana approving an agent's drafts) account for 10–22 of the
       "unnecessary" interrupts. The "operator is the backstop for every block" rule doesn't fit a fleet
       with two humans. This needs per-channel or per-person ownership.

5. **Operator persona and remit** (plan `docs/superpowers/plans/2026-04-17-operator-persona.md`): add "Not for me" and correction capture.
   Every correction becomes a new labeled eval item and a live count of unnecessary interrupts.
   - **The remit is written by each person and never hardcoded.** The 2026-10-11 eval shows why it matters:
     21 of 28 unnecessary interrupts were blocks owned by another human.
   - **Who owns an item depends on what kind of problem it is, not only the channel.** Alex owns agent and
     infra failures even inside business channels, so a channel rule alone misses items.
   - **Helpers for writing it:**
     - **A first draft from usage:** channels the person posts in, items they acted on, items they dismissed.
     - **A fixed structure:** *I own… / not mine… / escalate to me anyway when…*
     - **Plain-language remit plus optional hard rules** ("#partners → Dana"), so the model only
       handles what the rules can't.
     - **Edits suggested from "not for me" corrections**, as in the existing plan.
     - **A score against the person's own answers:** "this remit agrees with 26 of your 30 past
       answers; here are the 4 it gets wrong."
   - **When a remit changes:**
     - **Only targeting is re-decided; statuses stay**, since whether something is a block doesn't
       depend on who owns it. "Is this for me?" is its own question, so a change re-asks only that,
       or runs only the hard rules.
     - **Re-decide open items, never history.** Re-evaluate open blocks and decisions (and recent
       Catch-up). Past events keep their targeting and record the remit version that produced it.
     - **Preview before saving:** "6 items would leave your inbox and go to Dana, 1 would join it",
       with a "this is wrong" link on each.
     - **Version the eval labels too.** Labels encode the remit in mind at labeling time, so a big
       remit change shows up as stale labels rather than as model errors.
   - **Several humans:** each has their own remit. Items nobody owns fall back to the main operator,
     marked "unowned". A run of unowned items shows a remit gap, and the app suggests whose remit
     should cover it.
   - **Replaces** the decision code's rule that every block goes to the operator's inbox
     (`classifyWithDecisions`).
6. **Catch-up (FYI news that needs no action).** The inbox covers what needs action; nothing covers
   *what happened*, so the operator still opens Slack to check whether the deploy went out or what
   happened overnight. "Noise" is ~65% of classified events (2,274 of ~3,500), and the app shows none of it.
   - Split noise into **news** (a change of state: deploy, merge, tag, ticket closed, task completed,
     shift summary) and **chatter** (acks, heartbeats, intermediate progress). Only news is shown.
   - **First version, no classifier change:** a "Catch-up" tab in Stream with completed events plus
     bot notifications (`bot_type = 'notification'`) since the last visit, grouped by work item.
     Use it for a week before building more.
   - **Full version:** add a decision question ("does this report a change of state?") and filter
     per person, using the same ownership model as the inbox (engineering news to Alex,
     business news to Dana).
   - **Guardrails:** it ends with an "all caught up" state, has no unread badge or notifications, and
     groups by work item rather than by message. The inbox stays the only thing that interrupts you.
   - Depends on the label review (3) and per-person ownership (see the second failure source in 4).

7. **Decision log and action ownership.** The two "needs you" statuses differ in what happens after the
   human responds:
   - **Action (`blocked_on_human`)** — the human has to examine or produce something (credentials, a
     call, approving a draft, reviewing a PR). They hold responsibility until they respond.
     **Track ownership:** who holds which item and for how long ("you've held OPS-401 for 2 days").
     The item closes when the agent confirms the action is done, not when someone replies.
   - **Decision (`needs_decision`)** — the human chooses a direction with no work product to inspect,
     and the work returns to the agent straight away. **Log the decision:** work item, question,
     options offered, choice, who decided, when, and an optional one-line reason.
   - **Where decisions come from:**
     - Approve, Redirect and Reply in the app, captured for free.
     - The `options` in `workstream_request_approval`.
     - A human reply in Slack that follows a needs_decision message (needs detection).
   - **What the log enables:**
     - **Precedent on pending decisions:** "what do we usually do in similar cases?" Show similar past
       decisions next to the pending one, suggest an answer, and push back when the choice about to be
       made differs from precedent.
     - **Precedent for agents:** an MCP resource agents can check before escalating.
     - **Delegation:** when a type of decision always goes the same way, offer it as a standing rule for
       the agent. This removes the interrupt, the metric that matters most.
     - **Searchable history:** "why did we pick REST for the reports API?"
   - Decisions made by other humans (Dana) are also Catch-up material (6).

8. **Reopen completed work items.** ✅ Messages on a `completed` work item used to be stored as noise
   without being classified, so a regression or follow-up on a done ticket never reached the inbox. Now:
   - They're classified like any other message.
   - A blocker (`blocked_on_human`) or decision (`needs_decision`) reopens the item, shown with a
     "Reopened" marker. A human saying work resumed reopens it as `in_progress`. Agent chatter after
     completion leaves it done.
   - Approve and Close record when the item was closed, so an older message classified later can't
     reopen it.
   - Late replies on threads up to 3 days old are now read whatever the thread's status (see the Slack
     adapter's read-back to the reply window), so these messages are actually seen.
   - Still open: reopening from the task adapter (Jira moving back to In Progress), and labelled
     post-completion messages in the eval set.

**Local (offline) classification — findings from 2026-10-12, on an M4 with 16 GB:**
- **Generative local models aren't viable on a typical laptop yet.**
  - Qwen3 8B: about 6 tokens/s; each message timed out.
  - Qwen3 1.7B: fast (about 2 s per message), but 7 of 25 statuses correct and it never detected a block.
  - Ollama's default 4,096-token context also cuts off the ~7,300-token classifier prompt. Setup must
    raise `num_ctx`, and the app should warn when the prompt doesn't fit.
- **An embedding model plus a small trained classifier is fast and cheap**
  (nomic-embed-text, 137M parameters, 64 ms per message). Results, cross-validated on the 150 labels:
  - **Inbox flag:** 88%, better than Haiku's 82%. Ownership is learnable from labels.
  - **Status:** 63%.
  - **Needed interrupts:** misses 7 of 15. There are only 15 positive examples, so it's starved of data.
  - **As a front filter for Haiku:** it handles only 12–20% of messages locally. Not worth it yet.
- **Revisit when corrections have grown the label set** (item 5). The most promising piece is using the
  embedding classifier to decide *whose* item it is, alongside the LLM.

**Work model and work item identity** (design: [`docs/work-model.md`](work-model.md)). A re-link dry run over
real history found about half of proposed items right and a third merging unrelated work. The design replaces
phases 3–8 of the work item redesign (after phase 1, PR #44, and phase 2, the resolver and dry run, PR #45: 3 keys
table and typed refs; 4 resolver in the pipeline; 5 lifecycle and done policy; 6 asks, owner and baton; 7 streams;
8 apply the re-link) with: pair labels and precision/recall first, then opaque ids with a keys table,
operator corrections as constraints, asks attached to messages, subject keys, the resolver in shadow mode,
routines and runs, and a done policy before streams. Applying the re-link as first planned would discard operator
merges and must not ship.

**Grouping results, October 2026** (pairwise F1 on 761 labelled message pairs: the operator's labels, plus model
labels the operator's labels overrule, with the model's unsure pairs left out, plus pairs drawn where v2's decisions
act (`npm run eval:targets`); 598 dev pairs, 163 held-out test pairs):

| Grouping | dev F1 | test F1 |
|---|---|---|
| Current linker | 0.77 | 0.80 |
| Re-link dry run (phase 2 resolver) | 0.73 | 0.78 |
| v2 grouping (`core/grouping/`) | 0.88 | 0.90 |

- v2 splits much less and merges less unrelated work on dev, and leads on the held-out pairs too. The test half is
  small (about 100 scored pairs), so its intervals are wide. The pairs the model labeller couldn't decide went to the
  operator, whose labels keep them in the set: on those 26 hardest pairs v2 gets 17 right, the current linker and
  the re-link 13 each.
- Each decision v2 makes is measured where it acts (`npm run eval:targets`): the over-merge detector's cuts were
  judged right in 12 of 12 pairs, and starting a new case after a subject's week of quiet in 7 of 10.
- On the earlier 673-pair set, fitting v2's weights to dev (`npm run eval:tune`) raised dev to 0.87 but dropped
  test to 0.76, an overfit, so the hand-set weights stay. More labels come first: the operator's corrections in
  the app now become labels (`npm run eval:constraint-labels`).
- Each join rule, on pairs drawn where it decided (model labels, unsure left out): near copies 12 of 14 right,
  named subjects 6 of 8, a question and its answer 5 of 7, a person's follow-up 5 of 8, a sender's keyless
  continuation 4 of 7. Switching off any but named subjects lowers dev F1; named subjects changes nothing on dev
  and stays until more labels say otherwise.
- Tried and dropped, on the labels:
  - splitting long threads by the subjects they name, or cutting their weaker links: about half the cuts joined
    the same work;
  - weakening a thread's pull after a day: it cost dev F1;
  - holding back a ticket first named inside another conversation: 4 of 5 such pairs were the same work;
  - reply chains inside threads, read from whom a reply addresses (Slack threads are flat): dev F1 unchanged, with
    4 over-merges fixed and 5 same-work pairs split, and test fell from 0.90 to 0.89.

  Most of v2's remaining mistakes are a long thread changing topic, which none of these see.
- `npm run regroup` puts the real history in about 1,600 cases in 530 streams, most of them keyed by a subject.

## Then — strategic

9. **MCP over Streamable HTTP, on spec 2026-07-28.** The reference fleet runs on a cloud VM, so the stdio-only
   push path never reaches it. Have `workstream_request_approval` block until the operator answers,
   using the Tasks extension or multi-round-trip requests.
10. **Runtime sources beyond chat.** Read events from the agent gateway, Claude Code / Codex sessions
   or OTel GenAI traces, which gives structured status and avoids Slack rate limits. Slack stays the
   channel for replies.
11. **GitHub/Bitbucket task adapter.** Agent work mostly ends in a PR, so show PR state next to the item.

## Before open-sourcing

12. **Self-contained desktop build.** Tauri currently starts the engine with `npx tsx` from the project
   root (`src-tauri/src/lib.rs`). Ship the engine as a bundled sidecar instead.
13. **Project docs.** ✅ CLAUDE.md now describes the product as built and reads as an open-source project
    guide. LICENSE added. Still to add: the README, `docs/adapters.md` and `docs/mcp.md`.

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
