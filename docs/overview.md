# The Overview: Seeing Everything Without Being Overwhelmed

Status: design, for review. Nothing here is built yet. The model underneath it (cases, streams, subjects, the
graph) is in [work-model.md](work-model.md); this doc is about what the operator sees. The Overview is a new page
beside the existing ones: the Stream view (Needs me, Snoozed, All active, Dismissed) stays the place to act on
items, and the Work items table stays the full list. The Overview links into both.

The question this doc answers: when a company runs hundreds of streams of work at once, how does one page let a
person see what's going on and focus on the right things, without adding to the overload it's meant to remove?

---

## 1. The questions it serves

Operators ask three questions over and over, in roughly these words:

1. **"What's the most important thing for me to work on next?"** Usually that means "what am I blocking?" and
   "what is blocked that only I can unblock?"
2. **"What are all the things we're working on, and what's the status and next step of each?"**
3. **"Should we be doing this now?"**

Needs me serves the first. The Overview serves the second, shows the first in context, and lays out the facts the
third needs. Ranking what needs you is later work (open question 5). The third stays the operator's judgment: the
page lays out the facts, it doesn't decide.

**Why this isn't a dashboard.** CLAUDE.md rules out a monitoring dashboard, and the product's first principle is
that it comes to you. The Overview is the page an operator opens *instead of* scrolling the messaging platform to
find out what's going on, so it replaces a check rather than adding one. Later, its top section can come to the
operator as a local notification each morning, or, if they turn it on, as a message to themselves alone, under
section 6's rule.

## 2. The problem is volume

Even a small company has a lot in flight. On the reference fleet, the v2 grouping finds about 1,600 cases in
about 530 streams, and a single week touches well over a hundred of them. Listing them all answers question 2
on paper and fails in practice: nobody reads it, and the list itself becomes a source of anxiety. A big number
that only grows, like an overdue-task count, is the throughput trap in visual form.

So the page never starts from "everything". It starts from a much smaller question and lets the operator go
further when they choose to.

## 3. Principles

- **By default, answer "is anything off?"** Most streams at any moment are moving fine, aren't the viewer's, or
  are agents doing routine work. They collapse into one line ("84 streams moving normally"). What's visible is the
  exceptions: needs you, stuck, changed since you last looked, nobody owns it. Exceptions grow much more slowly
  than streams, so the page stays short as the company grows.
- **Show what changed, not the state of everything.** "Since you last looked: 3 finished, 2 got stuck, 1 new, 1
  handed to you" stays short at any size, and takes a glance instead of a read.
- **Judge a stream against its own pace.** A weekly report quiet for five days is fine; a payment chase quiet for
  two may not be. A stream *moves* when a case in it changes state, finishes, gets a decision, or a linked key (a
  ticket, a PR) changes state. A routine "still waiting" report is not movement. With the stream health states
  of work-model.md section 2:
  - **stuck** (no movement for longer than its pace) and **overdue** (past a stated date) are exceptions;
  - **noisy** (lots of messages, no movement) is an exception too: it's the fact "should we be doing this now?"
    most often needs;
  - **quiet** is normal for a slow stream, and folds into the one line.
- **Show what's done.** Seeing work close lets the operator stop holding it in their head. Without a "finished
  this week" section, the page only ever grows.
- **No number the reader can't act on,** with one exception: the single reassurance line ("84 streams moving
  normally"), whose job is to say that nothing else needs looking at.
- **Let "not now" be an action** (later, section 6). The operator parks a stream with what brings it back: a date,
  a reply, a state change. Shortening the list on purpose is where "should we be doing this now?" becomes
  something one can act on, and how a noisy stream with no outcome gets dropped by a decision instead of lingering.
- **Keep the tone calm.** No red badges, no unread counts. A plain sentence ("Two things are stuck on you;
  everything else is moving") beats a dashboard. A good morning looks boring.

## 4. Zoom levels and lenses

How people group work changes with what they're doing, not with who they are. In a small company the CEO looks at
the whole business at 9 AM and runs partner success at 11. So the page doesn't pick one right grouping; it's one
picture seen at different zoom levels:

- **The whole business:** each area's health in one line, plus what cuts across areas: work no one owns, and work
  two people each think the other owns.
- **One area** (partner success, platform): its streams, its exceptions, and what's waiting on whoever runs it now.
- **One subject** (a customer, a partner, a contract): everything about it, across areas.

**An area** is a named group of streams: a level above the stream, which work-model.md keys by subject, lane or
project. It isn't a new kind and nothing stores it in the first version: the page computes areas from where each
stream's messages are posted and who posts them (section 5).

**Lenses are a few remembered roles.** Each person keeps a handful of saved lenses ("Whole business", "Partner
success", "Platform") and switches with one click. Areas can also be re-cut on the spot: by function, by subject,
by agent.

**Taking a role is a temporary remit.** Eventually, while Dana has the "Partner success" lens on, "needs me" on this
page means "needs whoever runs partner success". Nobody has to write down where their responsibilities end; picking
a lens says it, for as long as it's on. Which lens a person picks, and when, may be evidence the app can learn from
(open question 6). This fits how ownership works in practice: loose, renegotiated in the open, and better inferred
from what people say and do than declared up front. In the first version a lens only filters this page: "needs you"
stays the operator's own asks, and Needs me, its interrupts and `operator.context` are unchanged. How lenses should
combine with the learned remit in roadmap item 5 is open question 6.

**Each zoom level has its own actions** (later, section 6):

- the whole business: set a standing rule, assign an owner where there's none, settle a conflict over who owns
  something, ask someone to do something;
- an area: approve, reply, reprioritise, park, hand off, set the standing rules for that area's agents.

Each level shows its own exceptions and its own changes since the viewer last looked at that level, with
everything else collapsed into one line. Zooming in never means "now show me everything".

## 5. The first version: read-only

The first version has no actions and writes nothing to the graph. It tests the riskiest part, whether the summary
actually stays calm on a real fleet, with something small enough to use every day.

**Where its data comes from.** It reads the v2 grouping that already runs in shadow mode, read-only, so it doesn't
wait for the cutover (work-model.md section 9, step 7). Shadow mode stores its result in `v2_cases`,
`v2_assignments` and `v2_claims` and regroups only when the grouping's inputs change (`core/grouping/shadow.ts`), so
the page reads those tables and never regroups on a page load. This brings a read-only preview of step 9's stream
view forward; the stored `stream_keys`, the done policy and stored health stay in step 9.

The v2 inbox rule ("needs you", below) lives in the eval script today (`v2Inbox` in `core/eval/inbox-diff.ts`), fed
by a fresh regroup. The first version moves it, with the rule for what the operator has already handled, into
`core/grouping/`, fed from the stored `v2_assignments`, the loaded messages and the events, so it needs no regroup
either.

**Movement, in the first version,** is what the messages show: a case's status changing (from the events of its
messages, through `v2_assignments`) or a decision. Routine reports and telemetry (the recognizer's `kind` claims)
never count. A linked ticket or PR changing state counts once tracker history is stored. Pace and "stuck" are per
stream: a stream is stuck when its latest movement, in any of its cases, is older than its stuck line.

**What it shows:**

1. **One page for the whole business:**
   - what changed since you last looked;
   - what needs you: the asks the v2 inbox rule shows the operator, the rule `npm run eval:inbox-diff` scores;
   - what's stuck or noisy, judged against each stream's pace;
   - what finished in the last seven days;
   - one line for everything moving normally: the streams with a message in the last 30 days that aren't shown
     above.
2. **Lenses as filters** on that page: an area lens shows the same sections for that area only, and "needs you"
   stays the operator's own asks within it. The lenses themselves are the computed areas; saved lenses come later.
3. **Areas computed** from channels: each stream goes to the channel most of its messages are in, and each channel
   is an area named after it, with direct messages together in one. This is the part most likely to be wrong at
   first. Renaming and merging areas is a write, so it comes later; the first version shows how far computed areas
   get alone.

**Not in the first version:** overdue (it needs expectation claims, which work-model.md step 5 doesn't store yet),
and "nobody owns it" and the cross-area ownership lines (they need actors, step 4).

**Starting rules,** placeholders to tune during the two-week trial (open question 1):

- **stuck:** no movement for longer than three times the stream's median gap between movements, and at least two
  days; a stream with fewer than three movements so far uses seven days;
- **noisy:** ten or more messages in the last seven days and no movement.

**Changes since you last looked** come from message times, not a stored snapshot: a case finished since then if its
latest status became completed after that time, it's new if its first message came after it, and a stream got
stuck if it crossed its stuck line after it. A case's id holds only while its first message stays its first,
so a regroup can make an old case look new; the trial will show how often.

**Its only state** is when the viewer last looked, per lens: kept in the viewer's own browser storage, never in
the graph, and if it's missing the page falls back to the last 24 hours.

```
Since you last looked (yesterday)  ·  3 finished · 2 stuck or noisy · 1 new

Needs you (2)
  Northwind renewal   — waiting on you for 5 days · signature on hold
  Pricing page copy   — Atlas has asked twice

Stuck or noisy (2)
  Partners · Welcome notes   — waiting on one decision, 4 days
  Platform · Nightly import  — Relay's import failing since Monday

Finished, last 7 days (3)
  Contoso onboarding · OPS-101 export fix · Q3 price list

Areas                 Partners ◐  Billing ●  Platform ◐  Product ●
                      84 streams moving normally
```

● means every stream in the area is moving; ◐ means at least one is stuck or noisy. They use the green and amber of
the status colors in [theming.md](theming.md), never red: nothing on this page is an alarm.

**How it's judged:** an operator uses it every morning for two weeks, which is the roadmap's aim of two weeks
without opening the messaging platform to check on the agents. Each day, count:

- things it surfaced that would otherwise have been missed;
- things it surfaced for nothing;
- times the operator still had to open the messaging platform to find out what's going on.

It passes if the first is clearly above zero, the second stays rare (each one is a reason to change what counts as
an exception), and the third keeps falling. If the operator is still reading the platform the way they used to, no
eval score makes up for it.

## 6. Later

- **Actions** at each zoom level (section 4), parking among them.
- **Nothing goes out without the operator.** Every action that posts to the messaging platform or writes to a
  tracker goes out the way replies do today: as the operator, through the platform, after the operator confirms
  that one action. Nothing is ever sent because of a lens, a standing rule or an inference.
- **Standing rules for agents** follow the rules model in work-model.md (sections 2 and 5): scoped, with exact
  text, an author and a source observation. A rule the operator writes here is posted that way and stored as
  confirmed, since its author is the operator. The platform returns the posted message's id; when that message is
  read back, it's matched to the rule by that id, never by its text, and becomes the rule's source observation, so
  nobody else posting the same words gets a confirmed rule.
- **Several people on one picture.** Open question 4.

## 7. Open questions

1. **A stream's pace.** How much history does it take to know a stream's normal rhythm, and what's the default
   before there's enough?
2. **Areas.** How well do channels and agents predict the areas people actually think in, and how often would an
   operator need to correct them?
3. **What counts as a look.** Opening the page counts as looking at the whole business; opening an area counts as
   looking at that area. Should opening a single stream count for that stream?
4. **Several people.** Several people, each in their own roles, would look at one company through different lenses.
   Today the app is local-first, one operator per engine, and the engine's API has no authentication: it's safe only
   because it listens on loopback. Sharing one picture would need authentication and per-person scoping of what each
   person can see first, and direct messages left out of anything shared by default. So would each person's learned
   remit and the actions it's learned from: those belong to that person. Whether to share one picture, or have each
   person run their own and get different answers, is an architecture and product decision, and not one to make yet.
5. **Ranking what needs you.** By what's queued behind each block, how long it has waited, and what it's worth.
   Where do those signals come from when agents don't state them?
6. **Lenses and the learned remit.** Roadmap item 5 learns each person's remit from what they do, with a written
   one optional. A lens is a remit taken on for a while. Is picking a lens one more piece of evidence for the
   learned remit, or should a lens override it while it's on?
7. **Goals.** Setting goals and seeing which are going off track belongs at the whole-business level, but a goal
   isn't a kind in the work model yet. What is one: a milestone, a rule, or something new?
