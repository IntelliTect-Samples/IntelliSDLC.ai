# 300 -- Capture output lands in the root checkout on the protected branch

**Issue:** [#300](https://github.com/IntelliTect-Dev/IntelliSDLC.ai/issues/300)
**Branch:** `fix/300-capture-output-placement`

## Problem

Capture tooling resolves its output against the **current working directory**. Run from a
consuming project's root checkout while on the protected branch, artifacts are created at
the repo root on `main`, where the repo's own rules forbid committing them. Nothing
notices; discovery is a human eventually running `git status`.

The cwd default is correct **outside** a repo and stays. The defect is failing to detect
being *inside* one.

## Load-bearing invariant

> The guard runs **before any capture begins**, never after. Nothing that cost the
> operator effort may exist when it fires.

This is what makes warn-and-proceed safe. Any guard downstream of the recording violates
it -- discarding a capture the operator spent minutes producing is worse than the
pollution it prevents.

## Detection -- three git probes, no heuristics

| Probe | Determines |
|---|---|
| `git rev-parse --show-toplevel` | Inside a repo at all. Fails => cwd default is correct, do nothing. |
| `git rev-parse --git-dir` vs `--git-common-dir` | Primary checkout vs. worktree (identical => primary) |
| `git symbolic-ref --short refs/remotes/origin/HEAD` | The protected branch, discovered not hardcoded |

"Does this repo have a no-work-on-`main` rule", in preference order:

1. `core.hooksPath` resolves to a **tracked** hooks dir whose `pre-commit` enforces it.
2. Explicit declaration `git config --get sdlc.protectedBranchWorkflow` (bool) as override.
3. Never `git hook run pre-commit` -- `pre-commit` is not `pre-write` and hooks have
   side effects.

## Interactivity -- the verified trap

`$PSCmdlet.ShouldContinue()` **throws** under `-NonInteractive`. `[Environment]::UserInteractive`
returns `True` inside an agent session and is unusable. Use `[Console]::IsInputRedirected`,
**and** wrap `ShouldContinue` in try/catch treating the throw as non-interactive.

## Deliverables

### 1. Shared guard, two runtimes, one pinned decision table

- `templates/web-api-discovery/scripts/lib/RepoWorkflowGuard.ps1` --
  `Assert-NotPrimaryCheckoutOnProtectedBranch`, dot-sourced by the PowerShell front doors.
  Returns `$true` (proceed) / `$false` (operator cancelled).
- `templates/web-api-discovery/scripts/lib/repo-workflow-guard.js` -- same three probes,
  used by `capture-har.js` so the direct-`node` entry point is not a hole.
- A behavior test drives **both** over one table of repo shapes and asserts they reach the
  same decision -- the pattern already used to pin `Get-HarUriFolder` against `uriFolder()`.
- The front door sets an internal env var so node does not warn a second time.

Not bespoke logic per script: reintroducing it per script is how the defect arrived.

### 2. Anchor the *default* output to the repo root

`capture-har.js` `resolveSessionPaths()` resolves the default output against
`--show-toplevel` when that succeeds, cwd otherwise. `Invoke-HarCapture.ps1` mirrors it for
the catalogue path, pinned by test so the two cannot drift.

**Scoped to the default only.** An explicit `-OutputPath` / `--output-path` keeps resolving
against cwd -- a relative path the operator typed should mean what they typed.

> This alone does **not** fix the worktree problem (a worktree has its own toplevel). It
> makes output land somewhere *predictable*, not somewhere *correct*. Item 3 is still
> required.

### 3. Warn and proceed -- never hard-fail

Primary checkout + protected branch + repo declares the rule => advisory warning, then continue.

- Interactive human => `ShouldContinue`, defaulting to continue.
- Non-interactive (agent) => `Write-Warning`, then **proceed**.

The message states: what was detected; why it matters (output lands in the root checkout
where commits are blocked, so artifacts strand); the **exact** `git worktree add` command
to run instead; and that recording continues if ignored.

### 4. Closing notice -- never discard, make cleanup one step

When the guard fired, the run's closing output names the **exact paths written** and the
single command to relocate them into a worktree. Raw captures are gitignored, so the
polluting set is small and precisely known.

### 5. Session-level safety net

Warn-and-proceed is deliberately soft and *will* sometimes be ignored on the
non-interactive path; this is the only layer that catches the missed case, and it is
tool-agnostic (the incident involved more than one tool).

- `.githooks/check-dirty-primary-checkout` -- reports untracked/modified paths in a primary
  checkout sitting on the protected branch. `.githooks/` is in `Pull-SDLC.ai.ps1`'s sync
  list, so consumers get it.
- Wired as a `Stop` hook in this repo's `.claude/settings.json` (`.claude/` is **not**
  synced, so consumers wire their own; documented).

### 6. Instructions

Ranked last deliberately -- they were already present and already failed. A short
working-tree-writes subsection in `copilot-instructions.md` / `CLAUDE.md` noting that the
no-`main` rule covers **writes**, not just commits.

## Explicitly out of scope

- **No override flag** for "deliberately capturing on `main`". That is a new command-line
  option and needs explicit human approval per the Adding Command-Line Options rule.
- **The consuming wrapper's docstring drift** (`OutputPath` documented as
  `docs/har-reference/`, actual default `.`) lives in a consuming project, not this repo.
  No file here carries that text (verified by grep). Nothing to fix upstream.
- **#294** -- credential-exposure aspect of the same output path, tracked separately.

## Acceptance criteria

- [ ] Outside a repo: behavior is byte-for-byte unchanged (no warning, cwd default).
- [ ] Inside a worktree on a feature branch: no warning.
- [ ] Inside a primary checkout on the protected branch, repo declares the rule:
      warning fires **before** the recorder launches, and the run proceeds.
- [ ] Non-interactive session: warning, no throw, exit code unchanged.
- [ ] Interactive session: prompt defaulting to continue; declining stops before capture.
- [ ] Repo does **not** declare the rule: no warning.
- [ ] Protected branch is discovered from `origin/HEAD`, not hardcoded.
- [ ] Default output anchors to repo root; explicit `-OutputPath` still resolves to cwd.
- [ ] PS and JS guards agree across the pinned table.
- [ ] Closing notice names the real written paths and a runnable relocate command.
- [ ] `Invoke-Pester .github/agents/tests` green.

## Task checklist

- [ ] T1 Red: guard decision-table tests (repo shapes x expected decision), PS + JS
- [ ] T2 Green: `RepoWorkflowGuard.ps1` + `repo-workflow-guard.js`
- [ ] T3 Red/Green: interactivity -- non-interactive warns and proceeds, no throw
- [ ] T4 Red/Green: default output anchors to toplevel; explicit path unchanged
- [ ] T5 Red/Green: guard is called before the recorder launches (ordering test)
- [ ] T6 Red/Green: closing notice contents
- [ ] T7 `.githooks/check-dirty-primary-checkout` + Stop hook wiring + its test
- [ ] T8 Instructions subsection
- [ ] T9 Refactor, full Pester run, evidence capture
