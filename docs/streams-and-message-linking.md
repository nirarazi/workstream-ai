# Streams and Message-to-Work-Item Linking

## The Core Challenge

workstream.ai reads raw messages from messaging platforms and must decide: **which work item does this message belong to?** Get it right, and the inbox shows coherent streams of work. Get it wrong, and the operator sees 52 separate "New lead" items instead of one stream, or misses a critical block because it was linked to the wrong item.

Today, "work item" and "stream" are the same concept. A work item _is_ a stream — it accumulates messages, events, and status over time. The question is how reliably we can route each incoming message to the right stream.

---

## How It Works Today

Messages reach a work item through three paths, tried in order:

### Path 1: Regex Extraction (High Confidence)

The `DefaultExtractor` scans message text for patterns matching configured ticket prefixes (e.g., `AI-382`, `IT-205`). Only IDs whose prefix appears in `config.taskAdapter.ticketPrefixes` are accepted.

**Strengths:** Deterministic, zero false positives when prefixes are configured, fast.
**Weaknesses:** Only works when the message contains a literal ticket ID. Many messages don't mention one — agents say "working on the deployment" not "working on AI-382."

### Path 2: LLM Classification (Medium Confidence)

The classifier receives the message plus a list of currently open work items (`getOpenWorkItemSummaries()`). The prompt instructs it to return matching IDs in `workItemIds` — either ticket IDs it spotted in context, or existing open work item IDs that match the topic.

LLM-suggested IDs are validated against known ticket prefixes before being accepted. Invalid IDs (e.g., `Q-456` when only `AI-`, `IT-`, `MS-` are configured) are discarded.

**Strengths:** Semantic understanding — can link "the deployment is blocked" to `AI-382` if it appears in the open items list. Handles follow-up messages that don't repeat the ticket ID.
**Weaknesses:** Non-deterministic. Limited by context window (100 open items max). Can hallucinate IDs. Expensive per message (one LLM call each).

### Path 3: Synthetic Work Item (Fallback)

If no work item ID is found (neither extracted nor inferred) and the message isn't noise, a synthetic work item is created with ID `thread:<thread-id>`. This groups all messages in the same Slack thread under one work item.

**Strengths:** Ensures no actionable message is orphaned. Thread-level grouping is natural for conversations.
**Weaknesses:** Each thread becomes its own work item. 52 lead alert threads = 52 work items. No cross-thread grouping.

### Thread Inheritance

Once a thread is linked to a work item, subsequent messages in that thread inherit the same work item ID (unless the classifier finds a different one). This means the first message in a thread determines its work item — later messages ride along.

---

## Where It Breaks Down

### Problem 1: Notification Spam (the 52 Leads)

Notification bots (CRM alerts, monitoring, CI/CD) post templated messages to Slack. Each message starts a new thread. Each thread becomes a separate synthetic work item. The inbox fills with near-identical items.

The root cause: **the system has no concept of "message type" or "stream category."** It treats a CRM lead alert the same as an agent asking for approval. The classifier sees "Pending" and says `blocked_on_human` because, read literally, someone does need to act on the lead.

### Problem 2: Cross-Thread Continuity

An agent posts about `AI-382` in thread A on Monday. On Wednesday, the same agent posts a follow-up in thread B without mentioning the ticket ID. The LLM _might_ link it via the open items list, but only if the title is similar enough and the item is still in the top 100.

### Problem 3: No Feedback Loop

When the operator dismisses a work item, that signal is lost. The system doesn't learn that "lead alerts from InsureTax Sync are noise to this operator." Every new lead alert is classified from scratch.

### Problem 4: Sender Identity is Underused

The system knows `is_bot=true` and the sender name, but treats all bots as "agents." A Slack bot posting CRM alerts is fundamentally different from an AI agent reporting work status, but the classifier sees both as `[Sender: X (agent)]`.

---

## The Streams Mental Model

Instead of thinking about work items as isolated tickets, think of them as **streams** — ongoing flows of related activity that the operator has a relationship with.

Some streams are high-signal (an agent blocked on a PR review). Some are low-signal (CRM lead notifications). The operator's relationship to each stream determines how it surfaces:

- **A stream I own:** Every event surfaces in my inbox. I act on these.
- **A stream I watch:** I see a digest or exceptions. "12 new leads today" not 12 inbox items.
- **A stream I've muted:** Exists in the graph, doesn't surface. I can search for it.

Today, work item = stream, and every stream is implicitly "owned." The product improvement path is giving the operator tools to change that relationship — starting with the ability to say "this type of thing is not actionable for me."

---

## The Missing Piece: Graph-Based Retrieval

The context graph stores rich relational data — agents, channels, threads, events, work items, enrichments. But the message-linking pipeline doesn't query it. Instead, it dumps up to 100 work item titles into the LLM context and hopes for a match. This is the equivalent of searching a database by printing every row and eyeballing it.

The graph should be the **retrieval layer** that narrows candidates _before_ the LLM is involved. The LLM's job changes from "find a needle in 100 haystacks" to "confirm or reject these 3 candidates."

### Signals Already in the Graph

Every incoming message carries metadata that the graph can match against:

| Signal | Source | What it tells us |
|--------|--------|-----------------|
| **Agent ID** | `message.userId` | Which agent sent this. The graph knows every work item this agent has been linked to via past events. |
| **Channel ID** | `thread.channelId` | Which channel. The graph knows which work items have threads in this channel. |
| **Recency** | `work_items.updated_at` | When was the work item last active. An item updated 2 hours ago is more likely a match than one from last week. |
| **Status** | `work_items.current_atc_status` | Is the work item still open? Completed items are unlikely matches. In-progress items from the same agent are strong candidates. |
| **Title keywords** | `work_items.title` | Simple word overlap between the message and existing titles. Not semantic — just shared terms. |
| **Bot flag** | `agents.is_bot` | Is the sender a known bot? Bots that only post one-way notifications behave differently from conversational agents. |

### Proposed: Candidate Scoring Function

A new graph method — `findCandidateWorkItems(message)` — that returns the top N most likely work items for an incoming message, ranked by a weighted score.

```
Score(work_item, message) =
    W_agent  * agent_match(work_item, message.userId)
  + W_channel * channel_match(work_item, message.channelId)
  + W_recency * recency_decay(work_item.updated_at)
  + W_keywords * keyword_overlap(work_item.title, message.text)
  + W_status  * status_boost(work_item.current_atc_status)
```

**Signal definitions:**

- **`agent_match`** (0 or 1): Has this agent posted events against this work item before? Query: `SELECT DISTINCT work_item_id FROM events WHERE agent_id = ?`. This is the strongest signal — if Byte was working on AI-382 yesterday, a new message from Byte is likely about AI-382.

- **`channel_match`** (0 or 1): Does this work item have threads in the same channel? Query: `SELECT DISTINCT work_item_id FROM threads WHERE channel_id = ?`. Weaker than agent match, but useful — work items tend to live in specific channels.

- **`recency_decay`** (0.0–1.0): Exponential decay based on time since last update. `exp(-hours_since_update / 48)`. An item updated 1 hour ago scores ~0.98. An item updated 3 days ago scores ~0.22. Tunable half-life.

- **`keyword_overlap`** (0.0–1.0): Fraction of significant words in the work item title that appear in the message. Strip stop words. "Working on the deployment" vs title "Deploy payment service to staging" → overlap on "deploy" → 0.25. Cheap, imperfect, but better than nothing.

- **`status_boost`** (multiplier): Open items (`in_progress`, `blocked_on_human`, `needs_decision`) get a 1.0 multiplier. `completed` gets 0.1. `noise` gets 0.0. Prevents dead items from matching.

**Suggested starting weights:**

| Signal | Weight | Rationale |
|--------|--------|-----------|
| `W_agent` | 5.0 | Same agent is the strongest correlation |
| `W_channel` | 1.0 | Same channel is a soft signal |
| `W_recency` | 2.0 | Recent activity matters |
| `W_keywords` | 3.0 | Title overlap is meaningful |
| `W_status` | — | Multiplier, not additive |

**Return:** Top 5 candidates with score > threshold (e.g., 2.0). If no candidates pass the threshold, the LLM gets no candidates and falls through to synthetic creation.

### How It Changes the Pipeline

```
Before:
  message → regex extract → LLM (with 100 open items) → link

After:
  message → regex extract → graph candidate scoring → LLM (with ≤5 ranked candidates + reasons) → link
```

The classifier prompt changes from:

```
## Open Work Items
- AI-382: Deploy payment service to staging
- AI-383: Refactor auth middleware
- IT-205: Payment webhook handler
... (97 more)
```

To:

```
## Candidate Work Items (ranked by relevance)
1. AI-382: "Deploy payment service to staging" — same agent (Byte), last active 2h ago, channel match
2. IT-205: "Payment webhook handler" — keyword overlap ("payment"), same channel
3. thread:abc.123: "Missing API key for Anthropic" — same agent (Byte)

If the message is about one of these items, return its ID. If none match, return an empty workItemIds array.
```

The LLM makes a **confirmation decision** (pick one or none) instead of a **search decision** (find something in a haystack). This is cheaper, faster, and more reliable.

### Implementation: Pure SQL, No New Dependencies

The scoring function can be implemented as a single SQL query with JOINs across events, threads, and work_items. No vector database, no embeddings, no new dependencies. The keyword overlap requires a lightweight text comparison — either in SQL with LIKE/INSTR, or a small TypeScript helper post-query.

```sql
-- Candidate work items scored by graph signals
SELECT
  wi.id,
  wi.title,
  wi.current_atc_status,
  wi.updated_at,
  -- Agent match: has this agent worked on this item?
  CASE WHEN e_agent.work_item_id IS NOT NULL THEN 5.0 ELSE 0.0 END AS agent_score,
  -- Channel match: does this item have threads in this channel?
  CASE WHEN t_chan.work_item_id IS NOT NULL THEN 1.0 ELSE 0.0 END AS channel_score,
  -- Recency: exponential decay (SQLite approximation)
  2.0 * MAX(0, 1.0 - (julianday('now') - julianday(wi.updated_at)) / 2.0) AS recency_score,
  -- Status filter
  CASE
    WHEN wi.current_atc_status IN ('in_progress','blocked_on_human','needs_decision') THEN 1.0
    WHEN wi.current_atc_status = 'completed' THEN 0.1
    ELSE 0.0
  END AS status_multiplier
FROM work_items wi
LEFT JOIN (
  SELECT DISTINCT work_item_id FROM events WHERE agent_id = :agentId
) e_agent ON e_agent.work_item_id = wi.id
LEFT JOIN (
  SELECT DISTINCT work_item_id FROM threads WHERE channel_id = :channelId
) t_chan ON t_chan.work_item_id = wi.id
WHERE wi.current_atc_status NOT IN ('completed', 'noise')
   OR wi.current_atc_status IS NULL
ORDER BY
  (COALESCE(agent_score, 0) + COALESCE(channel_score, 0) + COALESCE(recency_score, 0))
  * COALESCE(status_multiplier, 0)
  DESC
LIMIT 5;
```

Keyword overlap is applied as a post-query filter in TypeScript — SQLite's text capabilities are too limited for meaningful word matching.

### Evolution Path

1. **Now: Graph scoring with SQL** — uses existing schema, no dependencies, replaces the 100-item dump
2. **Next: Semantic search** — embed work item titles + recent messages, use vector similarity for keyword_overlap. sqlite-vec or a lightweight embedding model via Ollama. Richer matching for "the deployment thing" → "Deploy payment service to staging"
3. **Later: Learned weights** — track which candidates the LLM actually selects. Adjust weights per-operator based on real selection patterns. The scoring function improves over time without explicit training.
4. **Eventually: SLM classifier** — when enough labeled data exists (message → work item pairs from operator feedback), train a small model that replaces the scoring function entirely. The graph signals become features, not a formula.

---

## Improvement Directions

These are not committed plans. They're ideas ranked by feasibility and impact.

### 1. Graph-Based Candidate Retrieval (Near-term, High Impact)

Replace `getOpenWorkItemSummaries()` (100 items, no ranking) with `findCandidateWorkItems()` (top 5, scored by graph signals). See section above for full design. This is the single highest-leverage change — it makes the LLM's job dramatically easier and uses the context graph for what it's built for.

### 2. Operator Feedback on Dismiss (Near-term)

When the operator dismisses a work item, offer: **"Silence similar items from this sender?"** This creates a rule: `{sender: "InsureTax Sync", channel: "C09..."} -> auto-resolve`. No ML, no pattern matching — just a sender-level mute. Covers the 52-leads case directly.

### 3. Better Sender Classification (Near-term)

Distinguish notification bots from AI agents. The Slack adapter knows `is_bot=true`, but could further classify based on whether the bot has ever had a conversation (back-and-forth) or only posts one-way notifications. One-way bots get `senderType: "notification"` instead of `"agent"`. The classifier prompt can then treat notifications differently.

### 4. Pattern-Based Grouping (Medium-term)

Detect when multiple work items share a pattern (same sender, similar title template, same channel) and suggest grouping them into a single stream. The operator confirms, and future matches auto-group. This is the "auto-suggest, operator confirms" model.

### 5. Stream Preferences (Medium-term)

Add a `stream_preference` to work items: own / watch / mute. The inbox query filters by preference. The "watch" level introduces digest summaries — a single card that aggregates N events from the same stream. This is the full streams model, but it builds on top of the existing work item structure rather than replacing it.

---

## Design Principles

1. **Start permissive, learn to filter.** Show too much, let the operator train it down. Missing a critical block is worse than showing a noisy lead alert.

2. **One human label > 1000 LLM classifications.** When the operator acts on something (dismiss, reply, silence), that signal is gold. Use it.

3. **Deterministic beats probabilistic.** Regex extraction and sender-based rules are cheap and reliable. LLM classification is the fallback, not the primary path.

4. **Streams are work items.** Don't introduce a new abstraction layer until the existing one is proven insufficient. A work item already _is_ a stream. The improvement is giving operators control over how each stream surfaces.
