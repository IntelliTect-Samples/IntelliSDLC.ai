---
name: wrap-up
description: End a session cleanly before a restart -- merge this session's finished PRs, park unfinished work with a hand-off on its issue, record every loose end as an issue, release claims, then report. Use when asked to wrap up, finish up, or close out a session, or when invoked as /wrap-up.
---

# /wrap-up -- end a session so nothing lives only in the conversation

Pairs with `/next-issue`: one starts a unit of work, the other ends a session.
The test of a good wrap-up is that **a fresh session can continue every
unfinished item from GitHub alone**. Anything left only in this conversation is
lost at restart.

**Scope: only work this session owns** -- the branches, worktrees and PRs it
created, and the claims it posted (claim comments naming this session; see
**Issue Queue -- Priority Labels and Claims** in `.github/copilot-instructions.md`).
When ownership is unclear, leave the item alone and list it under **Needs you**.
Never merge, park, release or clean up another session's work.

## Step 0 -- Resolve the repository

```powershell
git remote get-url origin
```

Parse `owner/repo` from that URL and pass `--repo <owner>/<repo>` on every `gh`
call.

## Step 1 -- Inventory

Build the list before acting on any of it:

```powershell
git worktree list
git -C <worktree> status --short          # uncommitted work, per owned worktree
git -C <worktree> log '@{u}..' --oneline  # unpushed commits
git stash list
gh pr list --repo <owner>/<repo> --state open --json number,headRefName,title
gh issue list --repo <owner>/<repo> --label in-progress --json number,title
```

Also check the primary checkout: if `.githooks/check-dirty-primary-checkout`
exists, run it; a dirty primary checkout on the protected branch is a loose end
even if this session did not obviously cause it.

## Step 2 -- Finish what is finishable

For each PR this session owns, merge **only if every exit criterion holds**:

- the independent review ran, under an explicit model override, by a model that
  did not author the change -- and the reviewer's model is recorded;
- its findings were triaged, every accepted Critical/Important finding fixed,
  and the reviewer re-read the updated diff;
- the CI gate is satisfied -- hosted CI green, or, where the instructions allow
  it because hosted CI cannot run, the recorded local run with real counts in
  the PR;
- no unresolved review threads;
- neither the PR nor its issue is labelled `hold`.

When they all hold, **check whether this repository's shared instructions
pre-authorize merging** a finished PR: read the Merge Step of the development
workflow in the shared instructions, and `CLAUDE.md`, for an explicit statement
that a PR whose exit criteria hold is merged **without asking**. Do not assume
it -- whether it is granted varies by repository and by instruction version.

- **Pre-authorized** -> merge, using the merge method those instructions
  specify. Then confirm the issue closed (close it with a one-line comment if
  the PR did not), and clean up the worktree and branch (`Cleanup-Worktree.ps1`
  when present, otherwise the manual steps in the instructions).
- **Not pre-authorized, or you cannot tell** -> do not merge. List the PR under
  **Needs you** as ready to merge, with its evidence: the reviewer's model, the
  triage outcome, the CI or recorded local-CI result with real counts, and the
  exact merge command to run. Leave its worktree in place.

**Any criterion fails -> park it (Step 3). Never merge a PR that fails one.**

## Step 3 -- Park what is not finished

1. **Commit and push the work in progress** to its own branch. Stage explicit
   paths -- never `git add -A`, which sweeps scratch files into the commit.
   A stash is not parked work: turn it into a commit on its branch, or report it.
2. **Post a hand-off comment on the owning issue** (`--body-file`):

   ```markdown
   ## Hand-off -- <date>
   **State:** <what exists: branch, PR, what passes, what does not>
   **Tried:** <approaches taken, and what each showed>
   **Next step:** <the exact next action -- a command or an edit, not a theme>
   **Verified vs assumed:** <which claims were checked, and which were not>
   ```

3. **Release the claim**: remove the `in-progress` label and post a release
   marker so the next dispatcher can take the issue at once rather than waiting
   out the stale-claim window:

   ```markdown
   Released by `<session name>`: <one-line reason>.
   <!-- release: session="<session name>" reason="<reason>" -->
   ```

Leave the worktree in place -- it holds unmerged work. The pushed branch is
what lets a session on another machine continue.

## Step 4 -- Record every loose end

Open decisions, follow-ups, and defects found along the way go onto the issue
that owns them, or into a new issue (`gh issue create --body-file`). A new issue
gets exactly one `priority-N` label and a comment giving the reason for it.
Nothing that matters may exist only in the conversation.

## Step 5 -- Report

Use the Task Complete Summary Format from the shared instructions:

- **Merged** -- PR, issue, and the reviewer model that satisfied the review gate.
- **Parked** -- issue, branch, and the next step from its hand-off comment.
- **Filed** -- the issues created or commented on in Step 4.
- **Assumptions** -- always present; "None" when there were none.
- **Needs you** -- anything left for the owner, including items whose ownership
  was unclear.

End by telling the user it is safe to restart.

## Never

- Merge a PR that fails an exit criterion, is held, or belongs to another session.
- Delete unmerged work, drop a stash, or force-push.
- Remove a worktree or directory that holds files git does not track without
  first confirming they are disposable -- gitignored data is invisible to
  `git status` and cannot be recovered.
