# The Work Model and Message-to-Work-Item Identity

Status: design, agreed in direction with the maintainer, not yet built. It supersedes the direction in
[streams-and-message-linking.md](streams-and-message-linking.md), which still describes how linking works today.

It replaces phases 3–8 of the work item redesign. Phase 1 shipped in PR #44 and phase 2 (the resolver and the
re-link dry run) in PR #45. The phases it replaces were:

- **3:** a keys table and typed refs;
- **4:** the resolver in the pipeline;
- **5:** item lifecycle and the done policy;
- **6:** asks, owner and baton;
- **7:** streams;
- **8:** applying the re-link to the live database.

The question this doc answers: what is a unit of work, and how does the app decide, durably and explainably, which
messages belong to it?

---

## 1. Why the current model has to change

The resolver (`core/graph/resolver.ts`) and the `npm run relink` dry run made it possible to look at the whole of a
real fleet's history through one set of rules. On that history, about half of the proposed items were right, a third
merged unrelated work, and a tenth weren't work at all. Over-merging is the main failure, not fragmentation. The
causes are structural, not rule bugs, so more rules won't fix them.

**The item's id is its key.** `work_items.id` is a ticket key or `thread:<id>` (`core/graph/db.ts:23-24`,
`core/pipeline.ts:1028-1045`). An item can't gain a second key, lose a wrong one, or be split without changing its
identity, and every table that references it (`events`, `threads`, `thread_work_items`, `event_subjects`,
`event_targets`, `digest_checks`, `summaries`, `enrichments`) has to be rewritten when it does.

**Linking is per message, online, first rule wins, with no scores, and never revisited.** The linker creates an
item for the first id it extracts (`core/graph/linker.ts:37-61`); the resolver tries its rules in a fixed order and
stops at the first that decides (`core/graph/resolver.ts:7-16`, `389-467`). Nothing records how sure a decision
was, and nothing reconsiders it when later messages make the answer obvious.

**Operator corrections aren't durable.** A merge is recorded by item id in `work_item_merges`
(`core/graph/db.ts:151-158`, `core/graph/index.ts:1872`). A manual link is a flag on the thread
(`threads.manually_linked`, `core/graph/db.ts:284-289`, `core/graph/index.ts:628-639`). Neither says *which
messages* the operator put together. The re-link replay mints fresh item ids (`core/graph/relink.ts:413`), reads
`merged_into` only to skip merged items, and never loads `manually_linked` (`core/graph/relink.ts:244-292`).

**Classifier status gates membership.** A top-level `noise` message that names no key ("ack, on it") is placed
nowhere: it never gets a thread item (`core/pipeline.ts:1031`), and the resolver stops it before rule 6
(`core/graph/resolver.ts:463-465`). Candidate scoring drops completed, noise and dismissed items outright and
multiplies the rest by a status factor (`core/graph/index.ts:1276-1289`, `1331`). In the other direction,
`asks(status)` creates items (`core/graph/resolver.ts:357-359`, `381-384`): on the real history, most items were
created because a message was classified as an ask. Heartbeats, alerts and narration that happen to read as a
request become items of their own. Whether something needs the operator and what it belongs to are different
questions, and one label answers both.

**The thread is a container, not a deliverable.** Synthetic items are keyed by thread. But most agent posts were
top-level, not thread replies, so a thread holds one message; and long human threads work through several cases one
after another, so one thread holds several deliverables.

**The real grouping is often a named subject that no key sees.** Agents write "Northwind: contract redlines
sent", not a ticket key. The partner, customer, repo or claim the work is about is the thing the operator tracks,
and only a configured subject rule (`core/graph/resolver.ts:190-204`) can see it today. An unkeyed "Northwind
renewal shipped" is completed work, and the resolver drops it as activity (`core/graph/resolver.ts:385-386`); in
this design it lands in the Northwind stream.

**Continuation joins by proximity, not subject.** Non-threaded messages are offered the same channel's last 30
minutes (`core/pipeline.ts:871-884`, `core/graph/index.ts:1739-1775`). Candidate scoring weights the same agent
5.0, title keywords up to 3.0, recency up to 2.0 and the same channel 1.0, against a threshold of 1.5
(`core/graph/index.ts:1253-1347`). The same agent alone, or the same channel plus recent activity, clears the bar
with no shared subject. An agent that works on Northwind and then on Contoso in one channel gets both merged.

**English and Slack sit in the core.** Dependency words ("blocked by", "see also", `resolver.ts:147-149`), report
headers ("Daily digest", "Shift update", `resolver.ts:267-286`) and Slack's escaped quote marker `&gt;`
(`core/graph/own-lines.ts:4-14`) are parsed by core code. That breaks the rule that nothing outside an adapter knows
the platform, and it ties identity to one language.

---

## 2. The core kinds

The model has a closed set of nine kinds. Everything else is an attribute of one of them, or a specialisation that
a plugin adds as data.

| Kind | What it is | Notes |
|---|---|---|
| **Actor** | A person, agent or team. | One identity across channels and platforms, reached through handles (`U0OPERATOR1` in Slack, an email address, a forge login). Has a department, and may be external (a customer, a vendor). |
| **Subject** | What work is about. | Open subject kinds, registered by packs: partner, customer, repo, service, claim, site. Has names ("Northwind", "Northwind Ltd", "NW"). A subject keys a stream, never a work item. |
| **Work item** | A deliverable with a done condition: one case. | "Ship the Northwind export fix", "OPS-101". Belongs to streams; has refs and an origin, and has asks through its member observations. |
| **Ask** | A request or commitment between actors. | After Winograd and Flores' *conversation for action*: request → promise → reported done → accepted or rejected, with refusals, counter-offers and withdrawal along the way. Carries the **baton**: whose move it is. |
| **Routine** (with its runs) | Recurring work; a run is one occurrence. | Grooming, draining a queue, a weekly partner review. A run is done when its sweep is covered. |
| **Stream** | A long-lived grouping, keyed by a subject, lane or project. | Never done; has health (quiet, stuck, overdue, noisy). The Northwind stream holds every Northwind case. |
| **Observation** | Evidence. | A message, a tracker event, a forge event, an agent's MCP report (any MCP tool call: status report, approval request or completion). Append-only. |
| **Ref** | A pointer to an external thing. | Ticket, PR, document, URL, commit, build. Open ref kinds, registered by packs. |
| **Rule** | A standing instruction: how work is to be done from now on. | "Never state a date that isn't in the change calendar." Has a scope (an actor, a subject, a routine or the whole fleet), an author, a source observation, its confirmed text, and the rule it replaces. Has no done condition; it's replaced or retired. |

Decisions, incidents and milestones are not kinds. A decision is an ask whose request is a choice between options;
an incident is a work item with a severity and a timeline; a milestone is a work item whose done condition is a set
of other items. Conversations, claims, assignments, constraints and lineage (sections 3 and 5) aren't kinds either:
they're the resolver's machinery for deciding membership, not things the operator works with.

A rule is the one kind added after the first draft. A rule isn't an ask: an ask ends when it's done, a rule stays in
force until it's replaced. Telling an agent about a rule ("please add this to your instructions") is an ordinary ask
inside a case, done once the rule is applied; the rule itself goes on. Rules matter because they explain what agents
do, they can conflict, and the operator needs to see what each agent has been told: context is the product.

**The rule:** if a real need fits none of the nine, the core is wrong and is revisited deliberately, in a design
change like this one. It is never grown silently by adding a table for the case at hand.

**Kinds are data, behaviour lives in plugins.** Subject kinds, ref kinds and routine kinds are rows in registries
that packs fill, not classes in a hierarchy. Core code handles "a subject" and "a ref"; what makes a claim number
look like a claim number is a pack's business.

### What a case is

A work item is one case: one piece of work with one intended outcome, which can be finished. Three tests:

1. **One outcome.** "Done when ___" can be finished with one thing: PR #12 merged, Northwind's referral agreement
   signed, one order decided. A milestone passes too: its one outcome is that a set of other items is done.
2. **A done condition.** It ends when the outcome is reached or abandoned, and then it stops needing anyone. A
   partner, a routine and a rule have no done condition (a routine's runs do), so none of them is a case.
3. **One holder at a time.** An agent, a person or the operator holds it; the holder can change. A case nobody
   holds is still a case: an orphaned one.

Where one case ends and the next begins is decided by the outcome, not by the thread, channel, agent or time:

- **Same case:** steps toward the same outcome, such as reminders, a call, its preparation and status updates, even
  weeks apart and across channels.
- **New case:** a different outcome, even with the same partner. "Get Northwind signed" and "fix Northwind's broken
  link" are two cases in the Northwind stream.
- **Spin-off:** something found along the way that could be finished on its own by someone else (a bug found
  during an onboarding) is its own case, with the first case as its `origin`.

A case is not a ticket. A ticket is one way a case gets a key; most cases in a fleet never get one, because they're
too small or too short to be worth filing. Those are the ones the operator most needs tracked. How a case starts is
in section 5 ("Starting an item").

### Message acts

What a message *does* is a separate question from what it belongs to. Speech-act theory gives a small fixed set
that holds in any line of work, plus one bucket for machine output:

| Act | Examples | What it becomes |
|---|---|---|
| **Directive** | A request, a question, "please tell Atlas…" | An ask's request |
| **Commissive** | "On it", "I'll have it by Friday", "I can't take this" | An ask's promise or refusal |
| **Assertive** | A status line, a fact, an FYI, "done", an alert that names a case | Activity on a case or stream; "done" reports an ask done; a fact about a subject is an attribute claim |
| **Declarative** | A decision, an approval, "from now on…" | Accepts, rejects or withdraws an ask; a rule proposal |
| **Expressive** | Thanks, greetings, apologies | Not work |
| **Telemetry** | Heartbeats, tick logs, health pings: machine output about no case | Not work; evidence for a routine's runs |

An ask claim is an act made specific, on the same span, alongside the act claim:

| Ask move | Act | Made by |
|---|---|---|
| `request` | directive | the requester |
| `promise`, `refuse` | commissive | the performer |
| `report_done` | assertive; declarative when the request asked for a decision or approval | the performer |
| `accept`, `reject` (not done yet), `withdraw` | declarative | the requester |

"Thanks" right after a reported done, from the requester, is an `accept`; anywhere else it's expressive. When an
agent asks the operator to decide or approve, the agent is the requester and the operator the performer: the
operator's "approved", "no" or "go with B" is the `report_done`, and the ask closes on it unless the agent rejects
it. A counter-offer is a `refuse` followed by a new `request`.

Acts belong to parts of a message, not to the whole: one message can thank, set a rule and give facts at once.
Example, in one thread: after Atlas emails twelve Contoso users the wrong maintenance window, Dana writes "Atlas,
never state a date that isn't in the change calendar. The window is Saturday 02:00–04:00 UTC." That's a rule
proposal scoped to Atlas (declarative) and a fact (assertive). She follows with "Atlas, please write to each of them
with the right time" (directive, a request to Atlas), Atlas answers "On it" (commissive: the case starts) and later
"Done: all twelve sent" (assertive, `report_done`). The case is "correct the window for the twelve users". The
thread is its conversation, so Dana's first message joins the case with the rest (section 5, "Conversations as a
prior"). The rule is a separate, standing thing whose source is that first message.

A message moves no case when none of its parts does; that message is not work. A report or digest is not an act: it's
a message whose assertive parts are about several cases or subjects, found by counting them (plan step 5). Each of
those parts is activity on its own case (a `mention` assignment, not membership), so the report is a member of no
case, never becomes one item, and never merges them. The pair labeller (section 6) judges whole messages, so it marks
a report not work as a unit. A notification is a sender kind, not an act.

**Who tags acts.** Every observation gets act claims, cheapest source first: fleet-pack recognizers for the runtime's
telemetry and report formats, default-pack recognizers for ask moves and short acknowledgements, then the
classification call, which already runs on every message and adds act tags to its output. Acts from the model are soft
evidence: a model ask claim can surface an ask, but on their own, model acts can't make an observation not work, start
a case, close an ask, or keep a part from surfacing (section 7). The model returns the text it tags (each part's
opening words), and the engine maps it to spans of `parts.own`. With no act claims at all, a part is treated as
assertive: activity, never not work and never an ask. Where claims overlap, a part with any directive, commissive or
declarative claim is never not work, whatever telemetry or expressive claims also cover it.

### Routines, runs and origin

A routine declares a cadence (a cron expression) and a sweep: a declarative selector for what a run must cover (every
partner subject, every open PR older than a day, the triage queue). A run is done when every member of its sweep is
covered: acted on, or marked reviewed with no action. A run's outputs are work items linked by `origin`, which is
provenance, not membership (a spin-off's `origin` is the case it came from): the item lives in its subject's stream.
"Reviewed, no action" is recorded on the subject's stream. What surfaces is a run that was missed or is stuck, never
the routine's normal ticking.

Example: Monday's partner review finds a renewal due for Northwind and yields an engagement item (a new case) in
the Northwind stream, with `origin` = this run; Contoso is reviewed with no action, one line on its stream; a
partner with an open item gets an update on it, not a duplicate.

---

## 3. Layers

Each layer is computed from the one below it and can be recomputed without losing anything the operator said.

| Layer | Contents | Written by | Recomputable |
|---|---|---|---|
| **L0** observations | Normalised messages and events, append-only, with the fields of the raw payload needed to re-parse | Adapters | No (it's the record) |
| **L1** conversations | Which observations form one exchange | Adapter rules: a Slack thread; for email, the reply graph from `Message-ID`, `In-Reply-To` and `References`, with a subject-line fallback | Yes |
| **L2** claims | What each observation says, with provenance | Recognizers and the model | Yes, per recognizer version |
| **L3** work items | Clusters of observations | The resolver, under constraints | Yes |
| **L4** streams | Groupings of work items by subject, lane or project | Rules and the operator | Yes |

The adapter drops what it identifies as a signature from both the raw copy and the normalised form. When the
platform reports a message deleted or edited, or the operator purges one, its raw and normalised text are
tombstoned; claims derived from it are recomputed.

Claims at L2, each with its source and confidence:

- **keys** (ticket, PR, MCP id) the observation names, each with a relation: `about` (what it's about), `dependency`
  ("blocked by"), `mention` (in passing), `closes` ("fixes OPS-101");
- **acts:** the message acts of its parts (section 2), each over a span of `parts.own`;
- **asks:** a move in a conversation for action, with who asks whom, on the same span as its act (section 2);
- **rules:** a span of `parts.own` that proposes a standing instruction, with the name of its scope; the operator
  resolves the scope and any rule it replaces when confirming it (section 7);
- **subject mentions:** "Northwind" as a partner, at some confidence, with the same relations. A subject `about`
  places the observation in that subject's stream;
- **routine-run membership:** this observation is part of Monday's partner review.

**Status decides surfacing, never membership.** The classifier's status (and the decision model's inbox flag) says
whether something needs the operator. It is never consulted to decide what an observation belongs to. A noise
message can still be evidence for an item, and an ask surfaces as an ask whatever the grouping (section 5).

---

## 4. Recognizers

Today two extension points read messages for identity: `Extractor` (`core/graph/extractors/interface.ts:3-6`),
which returns ids from text, and `ContinuationStrategy` (`core/continuation/interface.ts:35-42`), which has no
shipped implementation. Both fold into one plugin interface: a **recognizer** reads observations and emits claims,
each with a confidence. The resolver is one consumer of claims; the surfacing logic is another. `Extractor` and
`ContinuationStrategy` are deprecated, not removed: an adapter wraps an existing implementation as a recognizer, and
both are dropped one release after the default pack replaces them.

Recognizers ship in packs:

- **Fleet packs** describe an agent runtime's habits: its heartbeat and report formats, how its agents identify
  themselves, and above all its schedule. Where the runtime exposes it, a fleet pack reads the runtime's cron or
  heartbeat configuration and *declares* routines, instead of inferring them from chat after the fact.
- **Domain packs** describe a line of work: its subject kinds (partner, claim, site), its ref patterns (claim
  numbers, work order numbers) and its vocabulary, in whatever language the fleet writes.

Today's English dependency words and report headers move into a default pack (step 5).

### Interfaces (sketch)

```ts
/** What an adapter produces. Core never parses platform markup: the adapter separates quoted text. */
interface Observation {
  id: string;                    // assigned by core (ULID)
  dedupeKey: string;             // the platform's own id, namespaced: "slack:<workspace>/<channel>/<ts>"
  kind: "message" | "tracker_event" | "forge_event" | "agent_report";
  occurredAt: string;            // ISO 8601
  container: { kind: string; id: string; name?: string };   // a channel, a mailbox, a repo
  author: Handle;                // verified by the adapter, except agent_report (section 7)
  participants: Handle[];
  senderKind: "agent" | "human" | "notification" | "unknown";
  parts: {
    own: string;                 // what the author wrote
    quoted: Array<{ text: string; claimedAuthor?: Handle }>;      // unverified
    forwarded: Array<{ text: string; claimedAuthor?: Handle; dedupeKey?: string }>;
    signature?: string;          // never stored or sent anywhere
  };
  refs: { repliesTo?: string; quotes: string[]; forwards: string[] };   // dedupeKeys
  externalRefs: Array<{ kind: string; value: string; url?: string }>;  // links the platform resolved
}

interface Handle { platform: string; id: string }

type ClaimBody =
  | { type: "key"; key: string; relation: "about" | "dependency" | "mention" | "closes" }
  | { type: "act"; act: "directive" | "commissive" | "assertive" | "declarative" | "expressive" | "telemetry";
      span?: { start: number; end: number } }                 // offsets into parts.own; absent = all of it
  | { type: "rule"; span: { start: number; end: number };
      scope: { kind: "fleet" } | { kind: "actor" | "subject" | "routine"; name: string } }   // resolved on confirm
  | { type: "ask"; move: "request" | "promise" | "refuse" | "report_done" | "accept" | "reject" | "withdraw";
      from: Handle; to?: Handle; askRef?: string; span?: { start: number; end: number } }
  | { type: "subjectMention"; subjectKind: string; name: string; relation: "about" | "dependency" | "mention" }
  | { type: "runMember"; routine: string; run: string; subject?: string };

/** What a recognizer returns; the engine adds the source ("<recognizer>@<version>", "model:<name>@<prompt>") */
interface ClaimDraft {
  body: ClaimBody;
  confidence: number;            // 0..1
  evidence?: { pattern: string; start?: number; end?: number }; // a pattern name and offsets, not copied text
}

interface Recognizer {
  name: string;
  version: string;               // a bump re-runs this recognizer over history
  reads: Observation["kind"][];
  recognize(obs: Observation, ctx: RecognizerContext): ClaimDraft[] | Promise<ClaimDraft[]>;
}

/**
 * Read-only. A recognizer is deterministic given the observation, the conversation up to it, and the alias-table
 * version, which is recorded on each claim; confirming a subject name re-runs the claims it affects.
 */
interface RecognizerContext {
  conversationUpTo(obs: Observation): readonly Observation[];
  subjectsByName(name: string): readonly { id: string; kind: string }[];
  aliasTableVersion: number;
}

interface Pack {
  name: string;
  recognizers: Recognizer[];
  subjectKinds?: Array<{ kind: string; label: string; sensitive?: boolean }>;
  refKinds?: Array<{ kind: string; pattern?: string }>;
  /** cadence: a cron expression; sweep: a declarative selector. Schema-validated by the engine. */
  routines?(): Promise<Array<{ id: string; cadence: string; sweep: SweepSelector; owner?: Handle }>>;
}
```

The messaging adapter interface (`core/adapters/messaging/interface.ts`) gains a method returning observations in
this shape. The Slack adapter strips `&gt;` quotes, forwarded blocks and signatures, and passes the reply and
permalink metadata Slack already gives it; an email adapter would use MIME parts and its headers.

---

## 5. Identity

### Storage

- **Opaque item ids.** A new work item's id is a ULID. Keys are attributes, not the id. Existing ids (`OPS-101`,
  `thread:…`) are kept as they are and treated as opaque from then on, so nothing that references them is
  rewritten; each also gets the matching row in `item_keys`. `thread:` is a legacy-only key kind: new items are
  never keyed by thread.
- **`item_keys(key, item_id, source, confidence, decided_by, evidence, created_at, retired_at)`.** Item key kinds
  are `ticket`, `pr`, `mcp` and the legacy `thread`. An item can hold several (`ticket:OPS-101` and
  `pr:forge.example/org/repo#7`). A key is retired, not deleted. A key is held by one live item, unless the operator
  split an item that held it. The work item id an MCP tool passes (a status report, an approval request or a
  completion) is a structural `about` key from the MCP channel (a local stdio process the operator configured): a
  ticket-shaped id is a ticket key, any other id an `mcp:` key.
- **`stream_keys(key, stream_id, …)`** with the same shape: subject keys (`subject:partner:northwind`), lanes and
  projects. Subject keys live only here.
- **`assignments(observation, item, role, score, decided_by, evidence, superseded_at)`.** `role` is `member`,
  `mention` or `target` (it puts the item in front of the operator). Superseded rows stay.
- **`constraints(id, kind, a, b, decided_by, created_at, retired_at, superseded_by)`.** Kinds: `must_link`,
  `cannot_link`, `pin` (observation to key), `not_an_item`, `key_alias` (two keys name the same work), and for
  streams `in_stream` and `not_in_stream`. They name observations (by `dedupeKey`) or keys, never item ids, so they
  survive every recompute. An action on a whole conversation is stored against its root observation and expanded at
  solve time. Undoing an action sets `retired_at`.
- **`item_lineage(from_item, to_item, kind, at)`** with kinds `split` and `merge`: the UI can say where an item's
  history went, and links to an old id still resolve.
- **`subjects` and `subject_aliases`** for subjects and their names. `key_alias` says two keys are the same work;
  `subject_aliases` says two names are the same subject. A name is soft evidence until the operator confirms it.
- **`actors` and `actor_handles`** for actors: one person, many handles. Today's `agents` table migrates into them.
- **`rules(id, scope_kind, scope_name, scope_id, text, text_hash, source_observation, author, replaces, status,
  decided_by, created_at, retired_at)`.** A proposal keeps the scope name it claimed and a suggested `scope_id`,
  looked up through subject names and actor handles; the operator confirms the scope. `status` is `proposed`,
  `confirmed`, `source_changed` or `retired`. `text` is the exact span as confirmed, never a paraphrase. `replaces`
  points back to the rule this one replaced, which the operator retires when confirming it. Proposals come only from
  rule claims; everything else is the operator's.

### Operator actions and backfill

From step 3 of the plan on, the app's merge, unmerge, link, unlink and "Not work" actions write or retire
constraints as they happen. Unmerge keeps deleting its `work_item_merges` row (`core/graph/index.ts:2017`) and also
retires the matching constraint. "Not work" is a dismissal with that reason, and writes `not_an_item`.

The backfill of earlier actions is idempotent and re-run at cutover, so actions taken in between aren't lost. It
skips any source row that already has a constraint, live or retired, so a re-run never revives an undone merge. Its
rows are stamped `decided_by = backfill` and ordered by the original action's time (`merged_at`; manual links have
none and count as oldest):

- **A merge** in `work_item_merges`: when both items hold structural keys, a `key_alias` between them. Otherwise
  `must_link` between the source's recorded events and the target's anchor observation. `work_item_merges.moved`
  records only what moved from the source, so the target's full membership at merge time isn't known; its anchor
  is enough to tie the two together.
- **A manual link** (`threads.manually_linked`): a `pin` of the thread's root observation to the item's
  structural key, or, for an item with none, a `must_link` to the item's anchor observation. A live link action
  does the same.

### Precedence

Operator constraints beat structural keys, and structural keys beat scores. A structural key is a ticket, PR or
MCP-id key from a deterministic recognizer, a platform-structured ref, or the MCP channel; a key the model proposed
is only a candidate. Keys are strong evidence, not hard rules: after the operator splits an
item, the two halves can both hold the key, kept apart by `cannot_link`. Contradictions are checked over must-link
components (a `cannot_link` between two observations that a chain of `must_link` joins). The newest constraint wins
and is applied; the older one is suspended (still live and shown, not applied) until the operator picks which to
retire. The solver never violates a live, unsuspended constraint.

### Starting an item

An ask always surfaces as an ask, attached to its observation, whatever the grouping, so nothing waiting on the
operator depends on clustering. A work item (a case) starts only from:

- an `about` structural key that no live item holds, including the work item id an MCP tool passes, as today;
- a request that gets a response, so a conversation for action has formed. The request ask must come from a
  deterministic recognizer, on an observation by a verified author, name the actor it asks (`to`), and get a
  promise or reply from that verified actor. A model-sourced ask or an MCP report can't start an item this way;
- a routine run yielding it.

A subject never starts an item. A subject `about` places the observation in the subject's stream and is a strong
signal for which case inside that stream it belongs to; it never makes all of a subject's observations one item.
Anything else is activity on its stream, conversation or run: assertive parts, a report, a directive nobody has
answered, a commissive nobody asked for. Expressive and telemetry parts are not work. Each author has a cap on items
started per day; unverified authors share one cap per source, and MCP tools count against one cap for the MCP source
as a whole, never against a claimed agent name.

### Deciding

1. **Candidate generation.** For a new observation, gather items that share a structural key with it; open or
   recently done items in the stream of a subject it's about (the window is open question 1); items its
   platform-structured reply refs point into; items that share participants within a few minutes; and items a
   routine template expects. Text quotes and pasted permalinks are soft evidence. Recency alone never makes a
   candidate. A done or dismissed item found by key or reply ref stays a candidate, since reopening depends on
   finding it; its state lowers the score but never removes it.
2. **Pairwise scoring.** Score observation–item pairs with explainable weighted evidence ("same ticket as about
   +3.0; in the Northwind stream and about Northwind +1.5; same agent, different subject −1.0"). Weights are
   hand-set first and fitted on operator labels once there are enough. The model is consulted only for the
   uncertain band (below).
3. **Clustering under constraints**, in the precedence above.
4. **Incremental re-clustering.** A new observation re-clusters only its neighbourhood (the items its candidates
   touched). A change has to beat the current assignment by a margin, so items don't flap. A recognizer or weights
   version bump runs a full re-cluster offline, with the same margin, and produces a diff for the operator to review,
   as `npm run relink` does now. A model version bump uses the cached claims unless a re-run is requested explicitly.

**Conversations as a prior.** A message in a platform-structured conversation (a thread reply, an email
`In-Reply-To`) inherits the conversation's item unless its own claims disagree strongly. Top-level posts are their
own conversations and are scored one by one. A long conversation splits only on a deterministic recognizer's claim
(a different `about` key, a routine run walking several subjects in one thread) or a request ask from a verified
author about a different subject, where the subject comes from a deterministic recognizer or a confirmed name, never
from the model. No single observation can merge or split established items on its own (section 7).

**The model's part.** The classification call stays as it is: it decides status and surfacing, and may see thread
context, which excludes observations about sensitive subjects. Identity questions for the uncertain band go on a
separate, small call that sees only the observation's `parts.own`, delimited as untrusted, and the candidate items'
titles and keys; never quoted, forwarded or signature text, and never other observations. The model may emit
act and ask claims (soft evidence, section 2), rule proposals over a span a deterministic recognizer also found,
and a bounded score adjustment; key and subject claims it emits are candidates only,
capped below the hard band. Candidate items whose keys or stream subjects are sensitive are excluded or masked in
any list sent to a remote model, in both calls; where masking can't be guaranteed, a local model or no model is
used. Cost is bounded: only uncertain-band units, a per-conversation and per-author budget,
and answers cached by observation, model and prompt version.

**When the model is unavailable or over budget**, the starting rules above still apply. Otherwise the resolver
places the observation in the top candidate if it clears a lower bar, and leaves it as activity if not, to be
revisited on the next re-cluster. It never creates an item per post.

### What happens to operator state

When re-clustering splits an item, the operator's state (snooze, dismissal, a renamed title, summaries,
enrichments, digest checks) stays with the part that holds the item's anchor observation, or failing that, most of
its members. The anchor (also the title's source) prefers an observation from a verified fleet member. When it
merges two items, the earlier snooze or dismissal wins. Either way the operator sees a lineage note ("split from
…", "merged with …") and can undo it, which records a constraint.

### Contracts that assume id = key

These change in step 2 of the plan, each with a deprecation path:

- **`TaskAdapter.getWorkItem(id)`** (`core/adapters/tasks/interface.ts:27`, called at `core/pipeline.ts:1237`) and
  its siblings take a ticket key, looked up from `item_keys`, not an item id. `enrichments` gains a key column.
- **MCP `workItemId`** (`core/mcp/server.ts:34`, `72`, `110`) is read as a structural key: a ticket key when it
  looks like one, otherwise `mcp:<id>`, as resolver rule 1 already does.
- **The classifier** echoes candidate ids and `isValidWorkItemId` checks them by ticket prefix
  (`core/pipeline.ts:666`, `1006`); it gets opaque candidate ids and returns one of them, while ticket keys it spots
  go through the key path.
- **`startsWith("thread:")`** tests in core (`pipeline.ts`, `graph/linker.ts`, `graph/index.ts`, `graph/relink.ts`,
  `decisions/classification.ts`, `classifier/index.ts`, `eval/label.ts`) and the UI (`WorkItemsView.tsx`,
  `stream/StreamListItem.tsx`, `stream/SuggestedActions.tsx`, `stream/StatusSnapshot.tsx`, and the unused
  `ContextPane.tsx` and `WorkItemCard.tsx`) become questions about the item's key kinds.
- **`relink.ts:266-271`** derives tracker prefixes from `enrichments.work_item_id`; it reads enriched ticket keys
  instead.

---

## 6. Evaluation

The current eval labels statuses. Identity needs its own labels and its own numbers.

- **Pair labels**, keyed by a platform-stable message identity (the future `dedupeKey`) so they stay valid however
  the items are regrouped: for two messages, *same work*, *different work*, or *not work*.
- **Pairwise precision and recall** over the labelled pairs; **B-cubed** precision and recall where a full cluster
  is labelled.
- **Items per ticket** (should be close to one), **Needs-me entries per real ask** (should be one: no duplicates,
  no misses), and the **share of items labelled not work** ("Not work" dismissals become labels).
- **A synthetic fixture fleet in CI**: a few weeks of fictional traffic (Atlas and Relay working on OPS tickets, a
  Northwind review, Contoso noise) with its true clustering. The suite fails on any violated constraint or a score
  drop beyond a set tolerance.
- **The app's corrections are labels.** An operator merge or split in the app is both a constraint and a pair
  label, so the gold set grows with use, as `docs/roadmap.md` item 5 proposes for status corrections.

---

## 7. Trust and safety

Message content, model output, MCP reports and packs are untrusted. Identity decisions change what reaches the
operator and where their replies go, so they get the same care as the action endpoints.

- **Only the operator writes constraints.** Constraints with `decided_by = operator` come only from operator actions
  in the UI; the backfill of past operator actions is stamped `backfill`. The endpoints that write constraints get the
  same host and origin checks as the action endpoints. The engine stamps every claim's source; a recognizer can't set
  it. Claims, model output, MCP reports and packs never create constraints, aliases, subject names or confirmed rules,
  or confirm them. A structured identifier in message text makes a candidate, never an alias binding.
- **No single observation merges or splits established work.** It can't merge two items that each hold their own
  structural key, or split an item, without clearing the margin and going to the operator for review. Keys
  claimed per observation, and items started per author (per source for MCP), are capped.
- **Actions name what the operator saw.** A reply goes to the conversation the operator viewed, whatever the
  grouping is now. Actions that depend on membership (create a ticket from an item, say) are refused if that
  membership changed since the view loaded.
- **The model only adjusts scores**, within the limits in section 5. It can't reach the hard band alone, create
  keys, names or constraints, or override `cannot_link`.
- **Identity comes from the platform.** A handle links to a person only through an adapter-verified identity (a
  platform user id) or the operator's confirmation, never a display name or message content. DMARC-aligned DKIM or SPF
  verifies an email's domain only; tying a specific mailbox to a person needs the operator's confirmation. Quoted and
  forwarded authors are unverified: never an ask's `from`, never the operator, and unable to close an ask. An MCP
  report's author is recorded as an unverified agent handle; never a verified requester or responder, never the
  operator, and can't close an ask. MCP reports are subject to the key cap and the single-observation rule. Closing an
  ask (accept, refuse, withdraw), or handing its baton back (reject), needs a verified author whose turn it is.
  `dedupeKey` comes only from the platform's own id, namespaced by platform and workspace (MCP reports use their own
  `mcp-report:` namespace, distinct from the `mcp:` item key kind); a quote or forward never replaces or dedupes the
  original.
- **Packs are local code.** They run in-process with the same trust as adapters; this is not a sandbox. They are
  explicitly installed, never fetched automatically. A fleet pack reads only config paths the operator chose,
  read-only, takes only cadence, sweep and owner fields, and drops everything else without logging, storing,
  sending or showing it. `routines()` output is schema-validated, and a sweep is a declarative selector, never SQL or
  code. Recognizers are given no adapter, network or credential handles. Pack patterns run on a linear-time regex
  engine, or under an input cap and a timeout.
- **Sensitive subjects.** A subject kind can be marked sensitive (a patient account, say). Sensitivity is decided
  by local deterministic recognizers before any remote call. Observations about a sensitive subject never go to a
  remote model: a local model or no model. Their evidence holds pattern names and offsets, never copied text. Pair
  labels in `eval-data/` follow the same rule. Signatures are never stored or sent. Summaries, model-written titles
  rule text and eval labels derived from a deleted or purged observation are recomputed or tombstoned with it.
- **No fetching refs.** Core never fetches a ref's URL. Only a task adapter calls its own configured base URL.
- **Rules are records, not instructions.**
  - *Who can author one.* A rule claim is a proposal, and only on an observation by a verified handle of the
    operator or of a person the operator has marked as a fleet member. Only an operator action in the UI marks a
    fleet member, behind the same host and origin checks, and only on adapter-verified handles; a pack, claim,
    display name or MCP report can't. Rule-like text from anyone else (an external partner, a guest, an agent, an
    MCP report) is assertive content, never a proposal; an agent restating a rule ("added it to my instructions")
    is evidence that it was received. Proposals are capped per author per day.
  - *Who confirms.* Only the operator confirms, retires or replaces a rule, and picks between two that conflict; the
    endpoints that do it get the same host and origin checks as the action endpoints. The confirm view shows the
    author, whether they're a fleet member, a link to the source, and the exact text that will be stored.
  - *Stable text.* A confirmed rule keeps the text and hash it was confirmed with. If its source is edited, the rule
    becomes `source_changed` and keeps the confirmed text until the operator reconfirms; it never takes the new text
    silently. If the source is deleted or purged, the rule's text is tombstoned with it.
  - *Display only.* Rules are shown on the actor, subject or routine they apply to. They never change surfacing,
    membership or suggested actions, never feed a drafted reply, and the app never sends one to an agent: that's
    the operator's reply. Changing this is a design change. When a model sees rule text (to suggest a conflict, say),
    it's delimited as untrusted and never placed among the model's instructions; a rule about a sensitive subject, or
    from an observation about one, is treated as sensitive.

---

## 8. Coverage check: five fleets

To test whether the first eight kinds were enough, a typical week of five dissimilar fictional fleets was walked
through the kinds: a support desk, an SDR and sales fleet, a software team, healthcare billing, and field-service
dispatch (appendix). Each gap is either a missing attribute (fine: add it) or a missing kind (an open question).

**Result.** Every fleet mapped onto the eight kinds. The gaps are attributes: external actors, deadlines and
expected-by dates on asks, time windows, item and subject hierarchies, per-subject routines, rotating owners,
stages, and a sensitivity class (section 7 sets its default). In every fleet the subject keys a stream and the
cases inside it are items. An entity that is both an actor and a subject (a
sales contact) is one entity in two roles, not a new kind; how it's stored is open question 6. A bookable resource
is flagged below as a possible missing kind, and a standing agreement (SLA, contract terms) as possibly a rule.

The check walked work, not instructions, so it missed rules: every one of these fleets has standing instructions
("never offer a refund over $X", "don't chase a payer before day 30"). Real labelling found them, and Rule was added
as a ninth kind.

---

## 9. Revised plan

**The old phase 8 (apply the re-link) must not run as designed:** it would mint new items from scratch and discard
the operator's merges and manual links (section 1). Re-linking becomes continuous re-clustering under constraints,
at the end of this plan.

1. **Measurement.** A pair labeller keyed by platform-stable message identity (a new eval script, writing only to
   `eval-data/`), and pairwise precision and recall for the current linker and the resolver. Nothing below ships
   without a number.
2. **Observations, keys and opaque ids.** L0 observations with `dedupeKey` and the adapter's observation method.
   Historical events are backfilled into L0; the database stores no workspace, so it's taken from the connected
   adapter. MCP reports get `mcp-report:<engine-assigned id>` as their `dedupeKey`, a deliberate exception, since
   the MCP server assigns message ids itself (`core/mcp/server.ts:53`). Slack's reply, quote and permalink refs are
   stored (the resolver's rule 4 needs them). Add `item_keys` and a key column on `enrichments`; new items get ULIDs,
   existing ids stay as opaque ids; migrate the id-equals-key contracts (section 5).
3. **Constraints.** Add `constraints`; merge, unmerge, link, unlink and "Not work" write or retire them from here
   on; backfill earlier actions from `work_item_merges` and `threads.manually_linked`.
4. **Asks on observations, and actors.** Attach asks to observations, not items. Here asks still come from the
   classifier's status and MCP `workstream_request_approval`, whose author is recorded as an unverified agent
   handle; never a verified requester or responder, never the operator, and can't close an ask. Ask claims replace
   them in step 5. Add `actors` and `actor_handles`, migrating `agents`. This carries over the pipeline's capped
   escalation of asks inside reports (`core/pipeline.ts:80`), and an operator's follow-up in a report's thread
   continues the open request.
5. **Claims, recognizers, subjects.** L2 claims, the `Recognizer` and `Pack` interfaces, a default pack holding the
   English and `&gt;` parsing that leaves core, `Extractor` and `ContinuationStrategy` wrapped as recognizers, and
   ask, act and rule claims. `subjects`, `subject_aliases` and `stream_keys`: subjects from lane-tagged lines (the dry
   run's `subject-rule-candidates.json` is the starting list) give stream membership and a candidate signal, never an
   item key. Report detection counts subjects, not only tickets.
6. **Resolver in shadow mode.** Run the resolver in the pipeline beside the current linker, writing `assignments`
   with scores but not changing what the operator sees; compare the two on the pair labels. Add scored candidates
   and `item_lineage`.
7. **Cutover.** Switch the pipeline to the resolver once its pair-label precision and recall beat the current
   linker's by an agreed margin; re-run the backfill of constraints first.
8. **Routines, runs and rules.** Routines are declared by fleet packs where the runtime exposes a schedule,
   otherwise proposed from recurring report patterns and confirmed by the operator. Missed and stuck runs surface.
   Add `rules`: proposals from rule claims wait in a low-priority review list, with a count on the actor, subject
   or routine they'd apply to; confirmed rules are shown there. Rules never appear in Needs me.
9. **Done policy, the stream view, then re-linking.** A configurable done policy (which source leads, tracker or
   classifier; quiet time alone never closes an item); the stream view and stream health, over the `stream_keys`
   that exist from step 5; and re-linking as continuous, constraint-respecting re-clustering with a reviewable diff
   on version bumps.

---

## 10. Open questions

1. **Telling cases apart inside a stream.** Decided: a subject is a stream and each case inside it is a work item,
   started by a structural key, a request that gets a response, or a routine run. Open: with no key, which open
   case does a follow-up belong to when the stream has several, and how long does a done case stay a candidate?
   And should a commitment nobody asked for ("I'll take the flaky CI test") from a verified fleet member start a
   case? Today it's activity.
2. **Bookable resources.** Is capacity (technicians, vans, rooms) ever the inbox's concern, and if so, is it a
   tenth kind or an attribute of actors and subjects?
3. **Standing agreements.** SLAs, contract terms and filing limits set deadlines for many asks. Are they rules
   scoped to a subject, with terms a domain pack can read, or do renewal and breach need more than a rule's
   lifecycle?
4. **Score weights.** How many pair labels before fitted weights beat hand-set ones, and are weights per fleet or
   shared defaults with per-fleet adjustment?
5. **Re-clustering in the UI.** When is a change big enough to ask before applying rather than show after?
6. **Actor and subject storage.** An entity in both roles: one table with roles, or an actor linked to a subject?
7. **Routines without a declared schedule.** How many recurring reports does it take to propose a routine, and how
   is a skipped run told from a routine that was retired?
8. **Redacting sensitive subjects.** Section 7 sets the defaults. Open: whether sensitive titles shown in the UI
   need masking too, and how a sensitive subject is marked before its first message arrives.
9. **Rules.** How is a likely conflict between two rules in one scope found? The model may suggest one; only the
   operator decides. And should a fleet pack propose the rules an agent already has, from instruction files? If so,
   only under these limits: paths the operator chose, read-only, no symlinks out of them; each proposal authored as
   `pack:<name>` from its path and unconfirmed until the operator confirms it; secrets redacted before anything is
   stored, logged or shown; never sent to a remote model by default; file text not proposed as a rule isn't kept;
   and a file the agent can write to is marked as a weaker source. Adopting this would amend section 7's authorship
   bullet with an explicit exception: `source_observation` becomes optional, with the pack as `author`.

---

## Appendix: coverage check

| Fleet | Subject kinds | Example routine | Gaps found |
|---|---|---|---|
| **Support desk:** agents triage and answer tickets; Dana approves refunds | Customer account, product area | Hourly drain of the new-ticket queue | External actors (customers); an SLA deadline on each ask; the SLA itself (open question 3) |
| **SDR and sales:** agents research, run sequences, book meetings; Alex Rivera reviews key accounts | Account, contact | A follow-up cadence per prospect | A contact is both actor and subject; routines per subject; pipeline stages; items only on exceptions (a reply) |
| **Software team:** agents take tickets, open PRs, triage CI; Alex reviews | Repo, service | Nightly dependency updates | Parent and child items (epics, releases); done varies by team; an on-call routine with a rotating owner |
| **Healthcare billing:** agents submit claims, work denials, draft appeals; Dana approves write-offs | Claim, patient account, payer | Weekly aging sweep (30/60/90 days) | Subject hierarchy (account → claim → line); asks to external payers with expected-by dates weeks out; sensitive personal data throughout (section 7) |
| **Field-service dispatch:** agents schedule, confirm and order parts; technicians in the field; Alex dispatches | Site, asset | Quarterly preventive maintenance per asset | Appointments as promises with a time window; capacity fits no kind (open question 2) |
