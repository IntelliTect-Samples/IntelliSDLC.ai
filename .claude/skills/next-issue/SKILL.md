---
name: next-issue
description: Triage the GitHub issue queue in this repository, show the next several highest-priority unblocked, unclaimed issues and who holds what, let the owner pick one or more, then claim and dispatch only those to dev-loop sessions (or to a background subagent when the work is small and settled). Use when asked what to work on next, to work on the next priority issues, or when invoked as /next-issue [N] [area:<label>] [here].
argument-hint: "[N] [area:<label>] [here]"
---

# /next-issue -- see what is next, pick, claim, dispatch

A **stateless** dispatcher. GitHub is the queue: priority lives on each issue as
a label, ordering is GitHub's native "blocked by", and a claim is written on the
issue itself. This command reads GitHub, triages, shows the owner the head of
the queue, claims what the owner picks, dispatches it, and exits. It never
reads or writes a tracking/controller issue and keeps no state of its own -- so
two dispatchers running at once are safe, because the claim is on the issue.

The label contract, the filing rule and the claim protocol are defined in the
shared instructions (**Issue Queue -- Priority Labels and Claims** in
`.github/copilot-instructions.md`). This skill is the procedure that applies
them.

## Arguments

| Invocation | Behaviour |
|---|---|
| `/next-issue` | Triage, then show the top **5** candidates and every live claim; the owner picks one or more, and only those are claimed and dispatched |
| `/next-issue 3` | The same, showing the top three |
| `/next-issue area:<label>` | Restrict triage and the list to issues carrying that area label |
| `/next-issue here` | The same list; the one issue picked is worked in **this** session |

Arguments combine (`/next-issue 3 area:<label>`). When nobody is present to
answer a prompt, the count means how many to claim instead -- see **When no
user is present**.

## Step 0 -- Resolve the repository, and this session's identity

```powershell
git remote get-url origin
hostname
```

Parse `owner/repo` from that URL (never from the directory name) and pass
`--repo <owner>/<repo>` on **every** `gh` call below. A checkout can hold several
remotes pointing at one repository, and `gh` guesses wrongly without it.

**This session's ID, as the harness supplies it:** `${CLAUDE_SESSION_ID}`.
Use that value wherever a step below says `<session id>`. If it is not a
session ID -- empty, or still an unsubstituted placeholder because this harness
does not fill it in -- write `session_id="unknown"` instead. Never guess or
invent one. `<host>` is the `hostname` output above: a transcript lives only on
the machine that ran the session, so the claim must say which machine that is.
`<session name>` is the name this session was started with.

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
   `priority-1`, `priority-2` and `priority-3` labels; an issue with none is
   **unprioritized** -- it goes to triage (Step 2) and is never offered for
   claiming until it carries a priority. Sort by rank, then oldest `createdAt`
   first.
2. **Drop issues that are already being worked without a claim.** Work that
   predates the claim protocol carries no `in-progress` label. Fetch once:

   ```powershell
   gh pr list --repo <owner>/<repo> --state open --json number,headRefName
   git ls-remote --heads origin
   ```

   Skip an issue when an open PR's head branch, or any remote branch, matches
   `<type>/<number>-*` -- report it as "already in flight, no claim".
3. **Re-check the blocker count** for each issue near the head of the list.
   Search semantics are GitHub's to change; the REST summary counts only
   **open** blockers:

   ```powershell
   gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary
   ```

   A `blocked_by` other than `0` is blocked -- skip it. Keep `total_blocked_by`:
   Step 2 uses it to spot newly unblocked issues.
4. **Stale claims are candidates too.** List `in-progress` issues separately
   (`--search "label:in-progress"`). A claim is **stale** when there has been no
   comment on the issue *and* no commit on its claimed branch for **3 days**. A
   stale-claimed issue is ranked like any other; taking it over is part of
   claiming (Step 4).

Keep the whole ranked list; Step 3 shows its head.

## Step 2 -- Triage before listing

**This is when re-prioritization happens.** A new issue, or one whose scope
changed after it was prioritized, gets a decision the next time anyone asks
what is next -- not whenever someone happens to notice. Triage runs before the
list is shown, so the list reflects the decisions.

**Unprioritized issues** -- open, no priority label, not held:

```powershell
gh issue list --repo <owner>/<repo> --state open --limit 300 `
  --search "-label:priority-0 -label:priority-1 -label:priority-2 -label:priority-3 -label:hold" `
  --json number,title,labels,body
```

For each, propose a priority and (when the repository uses area labels and the
issue has none) an area, each with a one-line reason drawn from the issue.

**Changed since prioritized** -- the issue body was edited, or a comment was
added or edited, after its current priority was last decided:

```powershell
$json = gh api graphql --paginate --slurp -f q="repo:<owner>/<repo> is:issue is:open label:priority-0,priority-1,priority-2,priority-3" -f query='
query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue {
      number title lastEditedAt
      labels(first: 20) { nodes { name } }
      timelineItems(itemTypes: [LABELED_EVENT], last: 50) {
        nodes { ... on LabeledEvent { createdAt label { name } } } }
      comments(last: 50) { nodes { createdAt lastEditedAt body } }
    } }
  }
}'
```

The priority was last decided at the later of the latest `LabeledEvent` for the
issue's current `priority-N` label and the latest comment carrying that
decision's `<!-- priority: label="priority-N" -->` marker. A comment that
**contains** a claim, release or priority marker is bookkeeping, not a change,
however much prose surrounds the marker:

```powershell
$ignore = '<!-- (claim|release|priority):'
$issues = @(($json | ConvertFrom-Json) | ForEach-Object { $_.data.search.nodes })
foreach ($i in $issues) {
    $label = @($i.labels.nodes.name | Where-Object { $_ -match '^priority-\d$' })[0]
    $decided = @(
        $i.timelineItems.nodes | Where-Object { $_.label.name -eq $label } | ForEach-Object { [datetime]$_.createdAt }
        $i.comments.nodes | Where-Object { $_.body -match "<!-- priority: label=`"$label`"" } | ForEach-Object { [datetime]$_.createdAt }
    ) | Sort-Object | Select-Object -Last 1
    if (-not $decided) { continue }
    $bodyEdited = $i.lastEditedAt -and [datetime]$i.lastEditedAt -gt $decided
    $changes = @($i.comments.nodes | Where-Object {
        $_.body -notmatch $ignore -and
        ([datetime]$_.createdAt -gt $decided -or ($_.lastEditedAt -and [datetime]$_.lastEditedAt -gt $decided)) })
    if ($bodyEdited -or $changes.Count) {
        [pscustomobject]@{ Number = $i.number; Priority = $label; BodyEdited = [bool]$bodyEdited; NewOrEditedComments = $changes.Count }
    }
}
```

Report what changed ("body edited", "3 new comments") -- never quote the
content.

**Newly unblocked** -- for a candidate whose `total_blocked_by` is above `0` but
whose open `blocked_by` is `0`:

```powershell
gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by --jq '.[] | [.number, .state, .closed_at] | @tsv'
```

When its last blocker closed within the past 7 days, mark it
**newly unblocked** in the list ("blocker #<m> closed <date>"). This needs no
decision -- closing a blocker changes no priority, it only lets the issue in.

**Decide.** Ask the owner to confirm or change each proposed and each changed
priority, through the harness's choice prompt: the proposal first, marked as
recommended, then the other priorities and `hold`. Batch the questions; do not
ask one issue at a time when several are waiting. Then write each decision --
**add the new label first, remove the old one second**, so the issue is never
without a priority, not even for a moment:

```powershell
gh issue edit <n> --repo <owner>/<repo> --add-label <new-priority>
gh issue edit <n> --repo <owner>/<repo> --remove-label <old-priority>
gh issue comment <n> --repo <owner>/<repo> --body-file <reason.md>
```

For a first-time priority there is no old label: the remove is a harmless
no-op, and may be skipped. A **confirmation** changes no label at all. Every
decision -- set, changed or confirmed -- is recorded by its reason comment,
which says what was decided and why and ends with the marker
`<!-- priority: label="priority-N" -->`. That marker is what makes the decision
time visible to the next run, so a confirmed issue is not flagged again.

## Step 3 -- Show the pick list and who holds what

**Re-rank first.** Triage may have just set, changed or held priorities. Apply
those decisions to the ranked list from Step 1 -- re-fetch the relabelled
issues rather than trusting the labels read before triage -- so an issue just
raised to `priority-0` is at the top, one just held drops out, and one just
prioritized enters.

Then show the head of the re-ranked list: the top `N` candidates
(default **5**), one row each.

| Issue | Priority | Area | Title | Why it is here |
|---|---|---|---|---|
| #<n> | priority-1 | area:<x> | <title> | oldest priority-1 |
| #<m> | priority-1 | area:<y> | <title> | newly unblocked: blocker #<k> closed <date> |
| #<j> | priority-2 | area:<x> | <title> | stale claim by `<session>`, silent 4 days -- picking it takes it over |

Then **who holds what** -- every live claim, read from the claim markers the
protocol already writes (no other state exists):

```powershell
gh issue list --repo <owner>/<repo> --state open --label in-progress --json number,title
gh issue view <n> --repo <owner>/<repo> --json comments --jq '.comments[] | select(.body | test("<!-- (claim|release):")) | {createdAt, body}'
git fetch origin --quiet
git log -1 --format=%cI origin/<branch>
```

For each `in-progress` issue, the live claim is the latest
`<!-- claim: session="..." session_id="..." host="..." branch="..." -->` marker
not followed by a matching release. Report:

| Issue | Session | Session ID | Host | Branch | Claimed-at | Last activity | Stale |
|---|---|---|---|---|---|---|---|

*Last activity* is the later of the issue's latest comment and the last commit
on the branch; *stale* is more than 3 days of neither. An `in-progress` issue
with no parseable claim marker is listed as "claimed, no marker". A claim made
before session IDs were recorded, or recorded as `unknown`, shows its session
ID as unknown.

For a **quiet** claim -- no activity for more than a day, or stale -- print how
to reach its session:

```
claude --resume <session_id>
transcript: ~/.claude/projects/<encoded-working-directory>/<session_id>.jsonl   (on host <host>)
```

`--resume` finds the session from any directory, but **only on the machine that
ran it**, and transcripts are removed after the retention period (30 days by
default). When the claim's host is not this machine, say so plainly: the
transcript is on another machine, and resuming or reading it has to happen
there. With an unknown session ID there is nothing to resume; the issue's
comments are the only record.

**Ask the owner to pick** one or more, through the harness's multi-select choice
prompt (in Claude Code: `AskUserQuestion` with `multiSelect: true`). It takes at
most four options, so offer the top four candidates -- label `#<n> <short
title>`, description priority plus why -- and say that any other listed issue,
or several, can be typed under "Other". With `here`, ask for exactly one.

If the owner picks nothing, stop: claim nothing, dispatch nothing.

## Step 4 -- Claim (per picked issue, one at a time)

Claim only the picked issues -- never the rest of the list -- and claim
**before** dispatching, so no other dispatcher picks up work being done out of
sight. The list may be minutes old, and a pick typed under "Other" was never
filtered at all: re-check each pick is still open, carries a priority label,
is not `hold`, is not claimed by someone else, and is not blocked. A pick with
no priority label is not claimed -- put it through Step 2's decision first, and
claim it only once it carries a priority.

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
   Claimed by `<session name>` (session ID `<session id>`, host `<host>`) on branch `<branch>` at <UTC ISO-8601 time>.
   <!-- claim: session="<session name>" session_id="<session id>" host="<host>" branch="<branch>" -->
   ```

   For a **stale takeover**, say so in the same comment and quote the previous
   holder's session name, session ID and host from its claim marker, so the new
   session can load that transcript before it starts rather than redoing or
   contradicting the work. Pass the same three values to the dispatched session
   (Step 6).
4. **Resolve a race.** Re-read the comments. Among claim markers not followed
   by a matching `<!-- release: ... -->` marker, the **earliest** wins. If it is
   not yours, release: post a release comment
   (`<!-- release: session="<you>" session_id="<session id>" reason="lost claim race" -->`),
   delete the branch you pushed **only if it still points at the commit you
   pushed** (`git push origin --delete <branch>`), leave the label (the winner
   holds it), and tell the owner that pick was lost to another session.

## Step 5 -- Choose how to run each claimed issue

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
#<n> -> subagent: settled scope, two one-line changes
#<m> -> new session: open design decision in the issue
```

**Either way the full dev loop applies** -- behavior-first tests, evidence, and
the independent review by a model that did not author the change, with the
reviewer's model recorded. Smaller does not mean fewer gates.

## Step 6 -- Dispatch

- **New session** -- reuse the repository's launcher, which names the session
  `<number>: <title>`, starts it in the main worktree, and runs `@dev-loop` on
  the issue. From inside a Claude Code session it opens a new terminal tab by
  itself:

  ```powershell
  pwsh -NoProfile -File <repo-root>/Start-IssueAgent.ps1 <n> "<context>"
  ```

  `<context>` tells the session what the dispatcher already did: *"Claimed by
  /next-issue. Branch `<branch>` is pushed; create your worktree from it rather
  than a new branch. The claim comment is posted."* For a stale takeover, add
  the previous holder's session ID and host, and the transcript path when it is
  on this machine, with the instruction to read it first. If
  `Start-IssueAgent.ps1` is not present, print that command for the user
  instead of improvising a launcher.
- **Subagent** -- launch it in the background with its own worktree on the
  claimed branch, and give it the issue, the branch, and the gates above. Use an
  explicit model override for its reviewer so the review is not self-review.
- **here** -- run `@dev-loop` on the issue in this session. A session cannot
  rename itself, so print the line for the user to type:

  ```
  /rename <number>: <title>
  ```

## Step 7 -- Report

One short table of what was dispatched: issue, title, mode and the one-line
reason, branch. Then, if any: the triage decisions written (priorities set,
changed or confirmed), issues skipped as "already in flight, no claim", stale
claims taken over (with the previous holder's session ID), picks lost to a
race, and the live-claims table from Step 3.

## When no user is present

A background run, a `/loop` run, or any run where nobody can answer a prompt:
do not show a pick list or ask. Claim the top `N` ranked candidates instead
(the count; default **1**), dispatch them as in Steps 4-6, and say so in the
report ("unattended: claimed the top N without a pick").

Triage labels nothing when unattended. List the unprioritized and
changed-since-prioritized issues under **Needs you**, each with a proposed
priority and reason, and dispatch only from issues that already carry a
priority label -- an unprioritized issue is never claimed without the owner.
Newly unblocked issues are still marked.

## Continuous dispatch

Keeping N issues in flight is `/loop /next-issue` on top of this command -- not
a new component, and not a controller. A loop runs unattended, so it follows
**When no user is present**.

## Never

- Dispatch an issue labelled `hold`, or one with an open blocker.
- Claim or dispatch an unprioritized issue -- not even one typed under "Other".
  It goes through triage first.
- Claim an issue the owner did not pick, when the owner is present to pick.
- Set, change or confirm a priority label without the owner's decision.
- Guess a session ID. The harness's value, or `unknown`.
- Read or update a tracking/controller issue to decide what is next.
- Claim with the assignee field -- every session runs as the same account, so an
  assignee cannot tell sessions apart.
- Launch work before its claim comment is posted.
