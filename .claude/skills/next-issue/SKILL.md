---
name: next-issue
description: Pick the highest-priority unblocked, unclaimed GitHub issue in this repository, claim it, and dispatch it to a dev-loop session (or to a background subagent when the work is small and settled). Use when asked to work on the next issue or the next priority issues, or when invoked as /next-issue [N] [area:<label>] [here].
argument-hint: "[N] [area:<label>] [here]"
---

# /next-issue -- dispatch the next priority issue

A **stateless** dispatcher. GitHub is the queue: priority lives on each issue as
a label, ordering is GitHub's native "blocked by", and a claim is written on the
issue itself. This command reads GitHub, claims, dispatches, and exits. It never
reads or writes a tracking/controller issue, and it keeps no state of its own --
so two dispatchers running at once are safe, because the claim is on the issue.

The label contract and the claim protocol are defined in the shared instructions
(**Issue Queue -- Priority Labels and Claims** in `.github/copilot-instructions.md`).
This skill is the procedure that applies them.

## Arguments

| Invocation | Behaviour |
|---|---|
| `/next-issue` | Claim the top issue and dispatch it (fan-out **1**) |
| `/next-issue 3` | Claim the top three and dispatch each |
| `/next-issue area:<label>` | Restrict selection to issues carrying that area label |
| `/next-issue here` | Claim the top issue and work it in **this** session |

Arguments combine (`/next-issue 2 area:<label>`). `here` implies a count of 1.

## Step 0 -- Resolve the repository

```powershell
git remote get-url origin
```

Parse `owner/repo` from that URL (never from the directory name) and pass
`--repo <owner>/<repo>` on **every** `gh` call below. A checkout can hold several
remotes pointing at one repository, and `gh` guesses wrongly without it.

## Step 1 -- Select candidates

One query does most of the filtering:

```powershell
gh issue list --repo <owner>/<repo> --state open --limit 300 `
  --search "-label:hold -label:in-progress -is:blocked sort:created-asc" `
  --json number,title,labels,createdAt,body
```

With an area argument, add `label:"<area-label>"` to the search string.

Then, in order:

1. **Rank.** An issue's rank is the lowest `N` among its `priority-0`,
   `priority-1`, `priority-2` and `priority-3` labels; an issue with none ranks
   after `priority-3` and is **unprioritized**. Sort by rank, then oldest
   `createdAt` first.
2. **Drop issues that are already being worked without a claim.** Work that
   predates the claim protocol carries no `in-progress` label. Fetch once:

   ```powershell
   gh pr list --repo <owner>/<repo> --state open --json number,headRefName
   git ls-remote --heads origin
   ```

   Skip an issue when an open PR's head branch, or any remote branch, matches
   `<type>/<number>-*` -- report it as "already in flight, no claim".
3. **Re-check the blocker count** for each issue you are about to take. Search
   semantics are GitHub's to change; the REST summary counts only **open**
   blockers:

   ```powershell
   gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by
   ```

   Anything other than `0` is blocked -- skip it.
4. **Stale claims are candidates too.** List `in-progress` issues separately
   (`--search "label:in-progress"`). A claim is **stale** when there has been no
   comment on the issue *and* no commit on its claimed branch for **3 days**. A
   stale-claimed issue is ranked like any other; taking it over is part of
   claiming (Step 2).

Take the first `N`. If only unprioritized issues remain, you may still dispatch
them, but say so -- an unprioritized issue reaching the top means the queue
needs triage.

## Step 2 -- Claim (per issue, one at a time)

Claim **before** dispatching, so no other dispatcher picks up work being done
out of sight.

1. **Name the branch** `<type>/<number>-<short-slug>`, taking `<type>` from the
   issue title's Conventional Commits prefix (`feat`, `fix`, `docs`, `test`,
   `refactor`, `chore`; default `feat`).
2. **Push the branch at once**, without touching any local checkout:

   ```powershell
   $default = gh repo view <owner>/<repo> --json defaultBranchRef --jq .defaultBranchRef.name
   git fetch origin --quiet
   git push origin "origin/${default}:refs/heads/<branch>"
   ```

   The branch name carries the issue number, so the claim is visible from any
   machine even before the session starts.
3. **Label and comment:**

   ```powershell
   gh issue edit <n> --repo <owner>/<repo> --add-label in-progress
   gh issue comment <n> --repo <owner>/<repo> --body-file <claim.md>
   ```

   The claim comment is one human-readable line plus a machine-readable marker:

   ```markdown
   Claimed by `<session name>` on branch `<branch>` at <UTC ISO-8601 time>.
   <!-- claim: session="<session name>" branch="<branch>" -->
   ```

   For a stale takeover, say so in the same comment: whose claim is being
   taken over, and that it had been silent for 3+ days.
4. **Resolve a race.** Re-read the comments. Among claim markers not followed
   by a matching `<!-- release: ... -->` marker, the **earliest** wins. If it is
   not yours, release: post a release comment
   (`<!-- release: session="<you>" reason="lost claim race" -->`), delete the
   branch you pushed **only if it still points at the commit you pushed**
   (`git push origin --delete <branch>`), leave the label (the winner holds it),
   and move to the next candidate.

## Step 3 -- Choose how to run each claimed issue

**Background subagent** (in its own worktree) only when **all** of these hold:

- **Settled scope** -- no unchecked `- [ ]` decision checkbox, no unanswered
  owner question, no `question` label. A subagent cannot pause for a plan
  approval.
- **Small** -- e.g. a docs fix or a couple of one-line changes.
- **Unlikely to need steering** -- a subagent is invisible, cannot be joined,
  and dies with its parent session.

**Otherwise a new named session** -- anything needing approval, anything large,
anything the owner may want to drive. `here` always means this session.

Say which was chosen and why, in one line per issue, so a wrong call is easy to
spot and redirect:

```
#117 -> subagent: settled scope, two one-line changes
#212 -> new session: open design decision in the issue
```

**Either way the full dev loop applies** -- behavior-first tests, evidence, and
the independent review by a model that did not author the change, with the
reviewer's model recorded. Smaller does not mean fewer gates.

## Step 4 -- Dispatch

- **New session** -- reuse the repository's launcher, which names the session
  `<number>: <title>`, starts it in the main worktree, and runs `@dev-loop` on
  the issue. From inside a Claude Code session it opens a new terminal tab by
  itself:

  ```powershell
  pwsh -NoProfile -File <repo-root>/Start-IssueAgent.ps1 <n> "<context>"
  ```

  `<context>` tells the session what the dispatcher already did: *"Claimed by
  /next-issue. Branch `<branch>` is pushed; create your worktree from it rather
  than a new branch. The claim comment is posted."* If `Start-IssueAgent.ps1` is
  not present, print that command for the user instead of improvising a launcher.
- **Subagent** -- launch it in the background with its own worktree on the
  claimed branch, and give it the issue, the branch, and the gates above. Use an
  explicit model override for its reviewer so the review is not self-review.
- **here** -- run `@dev-loop` on the issue in this session. A session cannot
  rename itself, so print the line for the user to type:

  ```
  /rename <number>: <title>
  ```

## Step 5 -- Report

One short table: issue, title, mode and the one-line reason, branch. Then list,
if any: issues skipped as "already in flight, no claim", stale claims taken
over, and unprioritized issues seen near the top of the queue.

## Continuous dispatch

Keeping N issues in flight is `/loop /next-issue` on top of this command -- not
a new component, and not a controller.

## Never

- Dispatch an issue labelled `hold`, or one with an open blocker.
- Read or update a tracking/controller issue to decide what is next.
- Claim with the assignee field -- every session runs as the same account, so an
  assignee cannot tell sessions apart.
- Launch work before its claim comment is posted.
