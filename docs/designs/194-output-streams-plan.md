# Plan: Output-stream refactor of Pull-SDLC.ai.ps1 (issue #194)

## Design

Map every `Write-Host` in `Pull-SDLC.ai.ps1` to an intent-appropriate stream per the
"Output & Streams" guidance (commit 65b12a0). Preserve all exit/return codes and the
visible-by-default output of normal and `-WhatIf` runs.

### Stream assignment

| Category | Cmdlet | Sites (approx) |
|---|---|---|
| Errors (fatal) | `Write-Error -ErrorAction Continue` then existing `return <rc>` | rc6 worktree-sync-failed (~1302); rc5 no-git/init-failed (~1931,1938); rc3 ABORT commit-context (~1960); rc2 POLICY VIOLATION drift (~2022); rc4 commit-did-not-advance (~2129) |
| Advisories | `Write-Warning` | push failed (~1336); manual-PR hints (~1344,1350,1353); cannot-open-PR (~1384); PR-create-failed (~1406); bootstrap declined (~2012); rerun-with-Force (~2027); -Force-in-effect (~2032/2034); bootstrap-overwrite prompt preamble (~960-962); non-Windows SSH (~1773) |
| Status/progress | `Write-Information` | cleanup (~787,805); anchor/grep (~946); [Bootstrap] (~952-953,1934); worktree lifecycle (~1257-1297,1972); push status (~1316,1321,1333,1343); PR opened/updated (~1392,1404); self-update (~1514); add-remote/fetch (~1998,2002); already-up-to-date/applied/merged/created-commit/nothing (~2086,2092,2103,2133,2136); scaffolding (~2150,2155-2158) |
| Decorative (keep Write-Host) | `Write-Host` + narrow `PSAvoidUsingWriteHost` suppression | op preview list (~2048-2076) -> extracted to `Write-PlannedOpsPreview`; `Write-NextStepsBanner`; SSH `[skip]/[add]/[warn]` (`Add-GitConfigValueIfMissing`, `Invoke-SetupGitHubSsh`) |

### Key risk controls
- `$ErrorActionPreference='Stop'` is script-scoped, so bare `Write-Error` would terminate
  before `return <rc>`. Every fatal site uses `Write-Error -ErrorAction Continue` so the
  record lands on stream 2 **and** the original return code is preserved.
- `$InformationPreference='Continue'` set at script scope so status stays visible by default.
- Op-preview stays `Write-Host` (existing tests mock `Write-Host`); extracted into a tiny
  helper so the suppression is narrow.

## Acceptance criteria
1. All existing tests in `Pull-SDLC.ai.Tests.ps1` stay green.
2. New behavior-first tests assert: rc unchanged AND message on the correct stream for
   each category representative.
3. `Invoke-ScriptAnalyzer` clean except narrowly-suppressed decorative `Write-Host`.
4. No new CLI options.

## Verify
```powershell
Invoke-Pester -Path .\Pull-SDLC.ai.Tests.ps1 -Output Detailed
Invoke-ScriptAnalyzer -Path .\Pull-SDLC.ai.ps1 -Severity Warning,Error
```
