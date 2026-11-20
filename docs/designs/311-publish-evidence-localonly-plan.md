# Make `-PullRequest` optional when `Publish-Evidence.ps1` runs `-LocalOnly`

- Issue: https://github.com/IntelliTect-Dev/IntelliSDLC.ai/issues/311
- PR:    (filled in once the PR exists)
- Slug:  311-publish-evidence-localonly

## Overview

`Publish-Evidence.ps1` declares `-PullRequest` as `[Parameter(Mandatory)]`, but the
`-LocalOnly` path returns before `$PullRequest` is ever read. The documented Phase 5b
step — run with `-LocalOnly` before a PR exists — therefore cannot execute; the script
exits 1 on a missing mandatory parameter.

## Approved Design

Drop `Mandatory` from `-PullRequest` and validate it only on the path that actually
posts.

```powershell
[int]$PullRequest,          # was: [Parameter(Mandatory)][int]$PullRequest
```

Then, before any work is done:

```powershell
if (-not $LocalOnly -and -not $PSBoundParameters.ContainsKey('PullRequest')) {
    throw "-PullRequest is required when posting to a PR. Pass -PullRequest <number>, or -LocalOnly to print the local file:/// link without posting."
}
```

### Key decisions

1. **Not parameter sets.** The idiomatic PowerShell answer would be a `Post` set and a
   `LocalOnly` set. Rejected: strict sets would *reject* `-PullRequest <n> -LocalOnly`
   used together, which is exactly what `dev-loop.agent.md:276` documents and what all
   20 existing tests do. That would turn a small bug fix into a breaking change for
   every consuming project.
2. **`$PSBoundParameters.ContainsKey` rather than a sentinel value.** Distinguishes "not
   supplied" from "supplied as 0" precisely, instead of overloading `0`.
3. **Validate early, before resolving the artifact.** Fail fast on a usage error rather
   than after doing I/O.
4. **Error text names both ways out** — supply a number, or pass `-LocalOnly`. The
   current failure mode is PowerShell's generic missing-mandatory-parameter message,
   which does not hint that `-LocalOnly` is the intended pre-PR path.
5. **`-PullRequest` stays accepted with `-LocalOnly`** and continues to be ignored there.
   Non-breaking by construction.

## Evidence Plan

- **Change type**: CLI / PowerShell
- **Artifact format**: Inline markdown — the real helper invoked `-LocalOnly` **without**
  `-PullRequest` at `main` (fails) and at `HEAD` (prints the link), plus the new error
  message when neither is supplied
- **Capture command**: `pwsh -NoProfile -File .../Publish-Evidence.ps1 -ArtifactPath <md> -LocalOnly`
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [ ] `-LocalOnly` with **no** `-PullRequest` succeeds and prints the `file:///` URL
- [ ] `-LocalOnly` with no `-PullRequest` returns `Mode = 'LocalOnly'` and posts nothing
- [ ] Omitting both `-PullRequest` and `-LocalOnly` throws a clear error naming both options
- [ ] Posting still works unchanged with `-PullRequest <n>` (no `-LocalOnly`)
- [ ] `-PullRequest <n> -LocalOnly` together still works and still posts nothing
      (backward compatibility for the current docs and all 20 existing tests)
- [ ] The inline echo and `-SkipDisplay` behavior are unchanged on every path
- [ ] `dev-loop.agent.md` Phase 5b no longer instructs passing `-PullRequest` with `-LocalOnly`
- [ ] Existing Publish-Evidence tests stay green; full repo suite green

## Implementation Checklist

- [ ] **Task 1 (RED)** — Add tests to
      `.github/skills/evidence-capture/tests/Publish-Evidence.Tests.ps1`:
      `-LocalOnly` with no `-PullRequest` (link emitted, Mode LocalOnly, gh never
      invoked); neither supplied -> throws naming both options; and a backward-compat
      test pinning `-PullRequest <n> -LocalOnly` together. Watch them fail.
- [ ] **Task 2 (GREEN)** — Remove `Mandatory` from `-PullRequest`; add the guard clause
      with the actionable message. Watch tests pass.
- [ ] **Task 3** — Fix `.github/agents/dev-loop.agent.md:276` to drop `-PullRequest <num>`
      from the Phase 5b `-LocalOnly` call; check `evidence-capture/SKILL.md` and
      `dev-loop-phase-gate/SKILL.md` for the same contradiction and align them.
- [ ] **Task 4** — Run the evidence-capture tests and the full repo suite.
