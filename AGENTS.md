# Working on workstream.ai — instructions for coding agents

Product context, architecture and design decisions are in [`CLAUDE.md`](CLAUDE.md). This file covers how changes get shipped.

## Every pull request gets a code review and a security review

Before a PR is ready to merge, two independent reviewers check it, and their findings are worked through until it's clean.

1. **Review.** Run both reviews on the PR's full diff against its base branch, in parallel:
   - **Code review:** the `Code Reviewer` subagent. It checks correctness, maintainability and performance.
   - **Security review:** the `Security Engineer` subagent. It checks for vulnerabilities, secrets and data exposure, and unsafe input handling.

   Give each reviewer the PR number, the branch, its base, and what the change is meant to do. In a tool without these subagents, run two equivalent independent reviews, each in a fresh context that didn't write the code.
2. **Check each finding before acting on it.** Read the code it points at and reproduce the problem where you can. Reviewers can be wrong.
   - **Real:** fix it, and add a test that fails without the fix where that's practical.
   - **Not real:** don't change the code. Write down why it's wrong.
   - **Real but out of scope** (for example a problem that predates the PR): leave it, say so, and propose a follow-up.
3. **Re-review.** After fixing, run both reviewers again on the updated diff. Tell them what they found last time and what changed, so they confirm the fixes and look for new problems. Repeat steps 2 and 3 until a round finds nothing new to fix.
4. **Stop and ask the maintainer** if three rounds pass and new findings still turn up, or if a finding needs a product decision (a change in behavior, not a bug fix).
5. **Report in the PR description.** Add a "Review" section listing each round, what was fixed, and anything deliberately left, with the reason.

The PR is ready to merge when:
- both reviewers' latest round has nothing left to fix;
- the full test suite passes;
- anything left unfixed is listed in the PR with its reason, and the maintainer has accepted it.

This applies to every PR, including small fixes and docs-only changes. A small change gets a quick review, not no review.
