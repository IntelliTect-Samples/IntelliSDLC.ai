# Exempt Git LFS hooks from the `.githooks/` managed-path sweep

- Issue: https://github.com/IntelliTect-Dev/IntelliSDLC.ai/issues/301
- PR:    (filled in once the PR exists)
- Slug:  301-lfs-hooks-always-local

## Overview

`Pull-SDLC.ai.ps1` treats all of `.githooks/` as upstream-managed, but upstream
ships only `pre-commit` and `check-dirty-primary-checkout`. A consumer that runs
`git lfs install` while `core.hooksPath` points at `.githooks/` — exactly what the
shared instructions prescribe — gets four LFS-authored hooks in that directory.
Sync then either refuses to run (drift guard) or, under `-Force`, deletes them,
silently breaking LFS push for every other clone.

## Approved Design

Add the four Git LFS hook filenames to `$script:AlwaysLocalPaths`, which already
trumps `$script:UpstreamManagedPaths`:

```
.githooks/post-checkout
.githooks/post-commit
.githooks/post-merge
.githooks/pre-push
```

**Why this is sufficient — one list change fixes both symptoms.** Both failing
code paths funnel through `Test-IsAlwaysLocalPath`:

| Symptom | Code path | Effect of the fix |
|---|---|---|
| Sync refuses to run | `Test-LocalDriftOnManagedPaths`, `Pull-SDLC.ai.ps1:1404` | Path is skipped before the blob comparison, so no drift is reported |
| `-Force` deletes the hooks | `Get-UpstreamOps`, `Pull-SDLC.ai.ps1:1188` | The `D` op is dropped from the op list |

**Why non-LFS consumers are unaffected.** `$script:AlwaysLocalPaths` is consumed
by exactly one function, `Test-IsAlwaysLocalPath` (`Pull-SDLC.ai.ps1:348`), and
every functional caller (`:406`, `:462`, `:1188`, `:1404`) uses it *subtractively*
— to skip an entry. Nothing reads the list to fetch, scaffold, or write a file;
creation comes only from `$script:TemplateScaffoldMap`, which these names are not
added to. Upstream also has no blob at any of the four paths, so the diff-replay
has nothing to propagate regardless. A repo without LFS therefore sees no new
files and no behavior change.

### Key decisions

1. **Exact-name entries, not a directory prefix.** Entries without a trailing `/`
   are exact matches (`Test-IsAlwaysLocalPath`), so `.githooks/pre-commit` and
   `.githooks/check-dirty-primary-checkout` stay fully upstream-managed. A
   `.githooks/` prefix entry would orphan the workflow guard hooks — the opposite
   of what #301 wants.
2. **Only the four hooks `git lfs install` actually writes.** YAGNI: no
   speculative exemption for other tools.
3. **Also stop the sync commit sweeping consumer-owned files (in scope).**
   `.githooks/` stays on `$script:UpstreamManagedPaths`, so the sync commit's
   `git add -A -- .githooks/` (`Pull-SDLC.ai.ps1:2708-2722`) stages any untracked
   LFS hook into the `chore: sync ...` commit. This is the same failure class
   #222 fixed for `run.ps1`, and it cannot be fixed the same way (removing
   `.githooks/` from the managed list would orphan the guard hooks — see
   decision 1).

   **Approach: stage as today, then unstage what is consumer-owned.** After the
   existing `git add -A`, enumerate staged paths and unstage any for which
   `Test-IsAlwaysLocalPath` returns `$true`.

   Why unstage rather than `:(exclude)` pathspecs:
   - **Single source of truth.** It reuses the same predicate as the rest of the
     script, so the `.template` / `.gitkeep` carve-outs inside always-local
     directory prefixes and the `$script:AlwaysLocalPrefixes` regex
     (`^\.github/skills/project-[^/]+/`) are honored automatically. A pathspec
     translation layer would have to re-encode those rules and could drift.
   - **No regex-to-glob translation** for the `project-*` skill carve-out.

   **Required carve-out.** `$script:SdlcSyncStateFile` (`.sdlc-ai-sync.json`) is
   on `$script:AlwaysLocalPaths` (`:271`) *and* deliberately appended to
   `$addPaths` (`:2708`) because it records the sync anchor. It must stay staged,
   or every sync loses its anchor. The unstage step must skip it explicitly.

   **Safe because scaffolding is unaffected.** `Invoke-TemplateScaffold` runs at
   `:2753`, *after* the staging/commit block, and the next-steps banner (`:2023`)
   tells the user to commit scaffolded files themselves. So no scaffolded
   consumer file depends on this staging step today.

## Evidence Plan

- **Change type**: CLI / PowerShell (library-function behavior verified through tests)
- **Artifact format**: Inline markdown — captured Pester run plus a live
  `New-DiffReplayFixture` scenario showing an LFS-equipped consumer surviving a
  `-Force` sync with all four hooks intact
- **Capture command**: `pwsh -NoProfile -Command "Invoke-Pester -Path ./Pull-SDLC.ai.Tests.ps1 -Output Detailed"` (filtered to the #301 block)
- **Note**: the end-to-end fixture must COMMIT the LFS hooks in the consumer. The
  deletes originate in the HEAD->tip reconcile pass (`Pull-SDLC.ai.ps1:2606`), which
  diffs the consumer's HEAD tree; untracked files never appear there, so an
  uncommitted fixture would pass even without the fix and prove nothing.
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [ ] `Test-IsAlwaysLocalPath` returns `$true` for each of the four LFS hook paths
- [ ] `Test-IsUpstreamManagedPath` returns `$false` for those four paths
- [ ] `.githooks/pre-commit` and `.githooks/check-dirty-primary-checkout` remain
      upstream-managed (`Test-IsUpstreamManagedPath` -> `$true`)
- [ ] Matching is exact — a lookalike such as `.githooks/pre-push-custom` is NOT
      treated as always-local
- [ ] `Get-UpstreamOps` emits no delete op for an LFS hook present only in the consumer
- [ ] `Test-LocalDriftOnManagedPaths` reports no drift for a consumer-modified LFS hook
- [ ] End-to-end: a `-Force` sync against an LFS-equipped consumer leaves all four
      hooks byte-identical
- [ ] Non-LFS regression: none of the four names appear in `$script:TemplateScaffoldMap`,
      so no file is created in a consumer that never ran `git lfs install`
- [ ] Sync commit does NOT contain an untracked LFS hook swept in by
      `git add -A -- .githooks/`
- [ ] Sync commit still contains `.sdlc-ai-sync.json` (anchor persistence intact)
- [ ] A consumer-owned `.github/skills/project-*/` file in the working tree is
      likewise not swept into the sync commit (prefix-regex carve-out honored)
- [ ] Full existing suite stays green

## Implementation Checklist

- [ ] **Task 1 (RED)** — Add `Describe 'Issue #301: Git LFS hooks are consumer-owned'`
      to `Pull-SDLC.ai.Tests.ps1` covering the eight criteria above. Watch the
      list/predicate tests fail on assertion (not on a missing symbol).
- [ ] **Task 2 (GREEN)** — Add the four entries to `$script:AlwaysLocalPaths` in
      `Pull-SDLC.ai.ps1` with a comment explaining the `git lfs install` origin
      and why upstream has nothing to overwrite them with. Watch tests pass.
- [ ] **Task 3** — Update the precedence comment block near `$script:UpstreamManagedPaths`
      where `.githooks/` is declared, cross-referencing the carve-out so the next
      reader does not re-broaden it.
- [ ] **Task 4 (RED)** — Add tests for the staging sweep: an LFS-equipped
      consumer with UNTRACKED hooks runs a sync; assert the resulting commit tree
      contains neither the hooks nor any `project-*` skill file, but does contain
      `.sdlc-ai-sync.json`. Watch fail.
- [ ] **Task 5 (GREEN)** — Add the unstage step after `git add -A` in
      `Invoke-PullSDLC` (`Pull-SDLC.ai.ps1:~2722`), skipping
      `$script:SdlcSyncStateFile`. Watch pass.
- [ ] **Task 6** — Run the full `Pull-SDLC.ai.Tests.ps1` suite; confirm no regressions.
