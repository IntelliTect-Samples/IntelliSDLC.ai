# IntelliSDLC.ai -- Global Working Rules

These rules apply in **every repository and every folder**, on every machine where
`Install-GlobalSkills.ps1` has been run. They are the floor, not the ceiling.

**Precedence.** A repository's own instructions (its `CLAUDE.md`, `AGENTS.md`,
`.github/copilot-instructions.md`, contributing guide) win wherever they are more
specific -- build and test commands, branch naming, the allowed merge method, the
tech stack. Where a repository is silent, these rules hold. A repository that has
pulled IntelliSDLC.ai carries a longer version of the same rules; follow that one.

## Before Any Commit -- or Any Write

In any git repository, before you **commit or write files**:

1. **Be in a worktree, not the primary checkout.** `git rev-parse --git-dir` must
   differ from `git rev-parse --git-common-dir`. Create worktrees under
   `.worktrees/` at the repository root:
   `git worktree add .worktrees/<issue#>-<name> -b <type>/<issue#>-<name> <default-branch>`.
   If the repository does not already ignore `.worktrees/`, add it to
   `.git/info/exclude` (local, never committed) rather than to a tracked
   `.gitignore`.
2. **Never be on the default branch** (`main`, `master`, ...). Work on a feature
   branch named `<type>/<issue#>-<short-description>`.
3. **An issue exists for the work.** Create one first if it does not. When the
   repository has no issue tracker you can reach, say so and carry on with the
   branch and worktree.
4. **Merge only through a pull request** linked to that issue (`Closes #<n>`),
   when the repository has a remote that supports them.

The rule covers **writes, not just commits**: a script, generator, capture or build
that emits files must run in the worktree too, or its output lands on the default
branch where nothing reports it.

Outside a git repository these four rules do not apply.

Commit messages follow Conventional Commits: `type(scope): description`
(`feat`, `fix`, `test`, `refactor`, `docs`, `chore`).

## How Work Gets Done

- **Behavior-first testing.** Every behavior change ships with a test that fails
  for a behavioral reason when the change is reverted. Default to test-first.
- **Evidence over claims.** Verify before declaring success; show the real output.
- **Simplicity.** YAGNI. Refactor duplication away after every green step.
- **Systematic debugging.** Find the root cause before proposing a fix.
- **Pre-production: no backwards compatibility.** Until a project is marked as
  released to production, replace an API or CLI surface outright -- no deprecated
  aliases, shims or compatibility flags.

## Independent Review -- Reviewer != Author Model

Before a PR merges, its diff must be reviewed by a **model that did not write it**.
In Claude Code, spawn a review subagent with an **explicit model override**
different from the authoring model -- a subagent without one inherits the author's
model, which is self-review. Record which model ran the review. Triage every
finding against the code (a review is advisory, never auto-applied), fix accepted
Critical / Important findings test-first, and have the reviewer re-read the
updated diff. If no other model is available, stop and say so rather than
self-reviewing.

## Merging a Finished PR Is Pre-Authorized

When the gates hold -- independent review done and recorded, tests green, CI green
-- **merge the PR with the repository's allowed merge method, close its issue,
and clean up the worktree and branch without asking**, then report. Stop and ask
only when the PR or issue is labelled `hold`, the review evidence is missing, the
PR belongs to someone else, or the change is outside the agreed design.

## Adding Command-Line Options -- Prompt First

A new flag, switch, argument or environment-variable toggle is an API decision.
**Stop and get explicit approval first**, with a recommendation -- prefer changing
the default over adding an option. This holds in autopilot / unattended mode too.

## Reporting

- **Surface assumptions.** When you continue without the user and resolve an
  ambiguity yourself, list every such assumption (what you assumed, what it drove)
  at the end. Say "None" when there were none. Mirror them in the PR description.
- **Number report items** so the user can answer one by name: results `R1`,
  assumptions `A1`, items needing the user `N1`. `N` numbers are stable for the
  session -- never reused, re-listed until answered. `R` and `A` restart in each
  report. This applies to every end-of-turn report, whatever its layout.

## Shell and Tooling

- **PowerShell** is the default shell; fall back to bash when it is unavailable.
- **`gh` bodies always go through `--body-file`**, never inline `--body`: inline
  bodies lose newlines and, on Windows, garble Unicode. Build the whole body from
  scratch -- never read a PR body back with `--jq` and re-interpolate it. Write the
  file as UTF-8 without a BOM, and prefer ASCII (`--`, `->`) over em dashes and
  arrows.
- Prefer the `git` CLI for git operations.
