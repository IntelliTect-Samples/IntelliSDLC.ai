# CI: Pester job reports success while running zero tests

- Issue: https://github.com/IntelliTect-Dev/IntelliSDLC.ai/issues/304
- PR:    https://github.com/IntelliTect-Samples/IntelliSDLC.ai/pull/306
- Slug:  304-pester-false-green

## Overview

The `Pester tests (.github/)` job exits 0 while running zero tests. Two independent
defects: `Invoke-Pester` cannot resolve the hidden `.github` directory, and the gate
only asks "did any test fail?", never "did any test run?".

## Approved Design

### Root cause (verified, not hypothesised)

Pester's `Find-File` calls `Get-Item $p` **without** `-Force`. PowerShell's `Get-Item`
throws `IOException: Could not find item ...` for any *hidden* leaf. `.github` is
hidden on Linux (dot-prefix); on Windows it is not, which is why the failure looked
platform-specific.

Reproduced locally on Windows by setting the `Hidden` attribute on a test directory --
identical error, identical `Pester.psm1: line 4014` frame as CI run 33232287713.

The issue's hypothesis said "Pester 6 skipping dot-prefixed directories". That is
**wrong in one important respect**: Pester **5.4.0 and 5.7.1 fail identically**.
Verified matrix against a hidden directory:

| Pester | Result on a hidden directory path |
|---|---|
| 6.1.0  | `IOException` from `Find-File`, `$r` unassigned |
| 5.7.1  | same `Get-Item` failure -> "No test files were found", `$r` unassigned |
| 5.4.0  | same |
| 4.9.0  | works (irrelevant -- suite uses Pester 5+ syntax) |

**Consequence: pinning to Pester 5.x does not fix this.** The job has never run a
test on Linux since it was added (0b105fd, 2026-05-15); every historical run is
23-26s, consistent with zero tests. So the "Why now" section of the issue is also
wrong -- nothing regressed, the job was born broken.

Passing *resolved file paths* instead of the directory works on Pester 6. The full
suite then runs green: **511 tests, 507 passed, 4 skipped, 0 failed, 32 containers**.
So the fix is to correct path resolution, and **no version pin is warranted**.

### Design

Extract the CI gate from inline YAML into a tested PowerShell module + thin entry
script, so the gate's behaviour is unit-testable rather than asserted by grep.

| File | Role |
|---|---|
| `.github/ci/PesterGate.psm1` | `Get-PesterTestFile` (hidden-safe discovery), `Test-PesterGate` (verdict) |
| `.github/ci/Invoke-PesterSuite.ps1` | Thin entry: discover -> `Invoke-Pester` -> evaluate -> `exit` |
| `.github/ci/tests/PesterGate.Tests.ps1` | Unit tests for both functions |
| `.github/ci/tests/Invoke-PesterSuite.Tests.ps1` | End-to-end child-process tests |
| `.github/workflows/validate-instructions.yml` | Step becomes a two-line call |

`Get-PesterTestFile -Path <roots>` enumerates with `Get-ChildItem -Recurse -Force`
and returns `*.Tests.ps1` full paths, so no hidden directory is ever handed to Pester.

`Test-PesterGate -Result <r> -ExpectedFile <paths>` fails when **any** of:

1. `$Result` is `$null` (Invoke-Pester threw -- the exact false-green in this issue)
2. `$Result.TotalCount -lt 1` (nothing executed)
3. `$Result.FailedCount -gt 0` (a test failed -- the only case covered today)
4. `$Result.Result -ne 'Passed'` (container/discovery error with no failed test)
5. A discovered file produced no container (partial discovery collapse)

Check 5 replaces a hard-coded "expect >= N tests" floor: it is self-maintaining and
still catches discovery silently shrinking.

Each failure prints a distinct `::error::` line naming which check tripped.

### New command-line surface (approved)

`Invoke-PesterSuite.ps1` takes exactly one parameter:

- `-Path <string[]>` -- roots to search. Default `.github`.

No other flags. Exit code 0 = gate passed, 1 = gate failed.

### Keeping this repo's own tests out of consumer repos

This repo is a template synced into downstream projects by `Pull-SDLC.ai.ps1`.
Test files that exercise *this repo's* internals must never land in a consumer
tree. Two independent guards (belt and braces):

**Guard 1 -- not on the manifest.** `$script:UpstreamManagedPaths` is an explicit
allowlist. `.github/ci/` is absent from it, so nothing under it can ship. Verified:
`Test-IsAlwaysLocalPath`/`Test-IsUpstreamPrivatePath` both `$false` for
`.github/ci/PesterGate.psm1`, and it matches no managed prefix.

**Guard 2 -- upstream-private by pattern.** Guard 1 is protection by *omission*: a
future maintainer who adds `.github/ci/` to the managed list would silently begin
shipping test files. So widen `$script:UpstreamPrivatePrefixes`:

```
-  '^\.github/(?:agents|skills)/(?:[^/]+/)*(?:tests|fixtures)/'
+  '^\.github/(?:[^/]+/)*(?:tests|fixtures)/'
```

Any `tests/` or `fixtures/` directory at any depth under `.github/` is now
upstream-private regardless of the manifest. Deliberately **not** widened beyond
`.github/` -- a `tests/` directory under `templates/` holds test-project templates
the generator emits into the consumer's solution and must keep shipping (the
existing comment in `Pull-SDLC.ai.ps1` warns about exactly this).

*Blast radius, measured against the tracked file list:* exactly one file that
ships today becomes upstream-private --
`.github/instructions/tests/tdd-instructions-shape.Tests.ps1`. That is correct;
it tests this repo's own instruction files. Consumers already holding a copy get
a delete replayed by the existing `Get-UpstreamPrivatePruneOps`.

### Documenting the rule where consumers won't inherit it

The rule above belongs in this repo's AI instructions, but `CLAUDE.md` and
`.github/copilot-instructions.md` are both synced downstream, so neither can hold
it. Create `.github/instructions/project.instructions.md` from its template.

Verified with the real predicates: that path returns `Test-IsAlwaysLocalPath =
$true`, and `Get-UpstreamOps` drops always-local paths *before* emitting an op --
so upstream's copy never ships even though it sits under the managed
`.github/instructions/` prefix. Each consumer instead gets its own copy scaffolded
from `project.instructions.md.template` via `$script:TemplateScaffoldMap`. It is
also exempt from the workflow's leak scan by basename, so it may name this repo.

Chosen over `CLAUDE.project.md` (equally always-local) because it is read by every
coding agent, not only Claude. Scope for this PR: the repo-private-tooling section
plus minimal orientation stubs -- not a full architecture document.

### Deliberately out of scope

The root-level `*.Tests.ps1` files (`Pull-SDLC.ai.Tests.ps1`,
`Consolidate-Specs.Tests.ps1`, `Consolidate-Tasks.Tests.ps1`,
`Start-IssueAgent.Tests.ps1`) have **two** problems, both out of scope here:

1. They are not run by CI at all -- this job only targets `./.github`.
2. They are on `$script:UpstreamManagedPaths` and match no upstream-private
   prefix, so they **ship to every consumer repo today** (verified:
   `OnManagedList = True`, `UpstreamPrivate = False`).

Both are real, and (2) is the same clutter problem this PR guards against for
`.github/`. They are excluded because turning on four never-CI'd suites risks
unrelated red that would stall this fix, and carving root scripts out of the sync
needs its own reasoning about which root files consumers legitimately need. File
a follow-up issue covering both halves.

## Evidence Plan

- **Change type**: Bug fix (CLI / command output)
- **Artifact format**: Inline markdown -- before/after of the gate against a fixture
  tree, plus the real suite run showing a non-zero test count
- **Capture command**: `pwsh -File .github/ci/Invoke-PesterSuite.ps1 -Path ./.github`
  at `HEAD~1` (false green) and at `HEAD` (real run)
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [x] `Get-PesterTestFile` finds test files under a *hidden* directory
- [x] Gate exits non-zero when `Invoke-Pester` returned `$null`
- [x] Gate exits non-zero when zero tests ran
- [x] Gate exits non-zero when a test failed
- [x] Gate exits non-zero when a container errored with no failed test
- [x] Gate exits non-zero when a discovered file produced no container
- [x] Gate exits zero for a clean run with tests
- [x] The workflow job runs the real suite and reports a non-zero test count on Linux
- [x] No Pester version pin added
- [x] `.github/ci/tests/` is classified upstream-private by `Test-IsUpstreamPrivatePath`
- [x] A `tests/` dir under `templates/` is still shipped (regex not over-widened)
- [x] `.github/instructions/project.instructions.md` exists and is never synced

## Implementation Checklist

- [x] Add `.github/ci/tests/PesterGate.Tests.ps1` -- red
- [x] Add `.github/ci/PesterGate.psm1` -- green
- [x] Add `.github/ci/tests/Invoke-PesterSuite.Tests.ps1` -- red
- [x] Add `.github/ci/Invoke-PesterSuite.ps1` -- green
- [x] Rewrite the `Run Pester suite` step in `validate-instructions.yml`
- [x] Add `.github/ci` to the workflow's leak-scan `scan_roots`
- [x] Add sync tests to `Pull-SDLC.ai.Tests.ps1` for the widened prefix -- red
- [x] Widen `$script:UpstreamPrivatePrefixes` in `Pull-SDLC.ai.ps1` -- green
- [x] Create `.github/instructions/project.instructions.md` documenting the rule
- [x] Confirm CI reports a real test count on `ubuntu-latest`
- [x] File the follow-up issue for root-level `*.Tests.ps1` (untested + shipped)

## Outcome

Delivered. CI on `ubuntu-latest`: **588 tests across 36 files, 585 passed, 0 failed,
3 skipped** -- the job previously ran none.

Two things the plan did not anticipate:

1. **Turning the gate on exposed 10 pre-existing Linux failures** (a Windows-only
   `node.cmd` stub, and a `.tmpl` enumeration missing `-Force`). Filed as #308 and
   fixed in #310, merged into this branch, because a branch off `main` still runs the
   old workflow and could not have verified the fix.
2. **Independent review (Sonnet) found a Critical follow-on**: widening
   `$script:UpstreamPrivatePrefixes` left `Get-UpstreamPrivatePruneOps` inventorying
   only `.github/agents` and `.github/skills`, so consumers would keep a stale
   `.github/instructions/tests/*` forever. Fixed with tests.

Follow-up #309 tracks the root-level `*.Tests.ps1`, which are both never run by CI and
shipped to every consumer.
