# Fix #110: Self-refresh re-exec parameter mismatch

## Root cause
`Invoke-SelfReExec` is invoked from *inside* `Invoke-PullSDLC` using
`$PSBoundParameters` from the function scope. The function exposes 11
parameters including `RemoteUrl`, but the outer script exposes only 9
(no `RemoteUrl` -- it is a hardcoded constant at script top). When the
script calls `Invoke-PullSDLC -RemoteUrl $RemoteUrl ...` (line ~912),
`RemoteUrl` is bound in the function's `$PSBoundParameters`. The
splat-based re-exec then tries `& $ScriptPath -RemoteUrl ...` which
the outer script cannot bind -> fatal.

## Fix (Option A from the issue)
1. Extract a tiny wrapper `Invoke-SelfRefreshGate(ScriptPath, BoundParameters, NoSelfUpdate)`
   that performs the existing 3-line check: Test-SelfRefreshRequired ->
   Invoke-SelfRefresh -> Invoke-SelfReExec.
2. Move the call from inside `Invoke-PullSDLC` to the script's top
   level, right after the dot-source guard at line ~910. At that
   point `$PSBoundParameters` reflects the *script's* outer params,
   all of which are known-bindable on re-exec.
3. Delete the now-dead block inside `Invoke-PullSDLC` (lines ~714-719).

## Tests (TDD, behavior-first)
- Re-target existing `Invoke-PullSDLC self-refresh wiring` describe
  block: `Invoke-PullSDLC` no longer self-refreshes, so those tests
  now test `Invoke-SelfRefreshGate` directly.
- New: `Invoke-SelfRefreshGate splats only the supplied BoundParameters
  to Invoke-SelfReExec` -- regression for the bug. Mocks
  Test-SelfRefreshRequired/Invoke-SelfRefresh to true, mocks
  Invoke-SelfReExec to capture args. Asserts captured
  `BoundParameters.Keys` matches the input hashtable exactly (no
  function-only keys appearing).
- New: end-to-end. Run the script (with mocks for
  Test-SelfRefreshRequired/Invoke-SelfRefresh/Invoke-SelfReExec) and
  assert the captured BoundParameters does NOT contain `RemoteUrl`
  (a function-only param). This is the direct anti-regression
  for #110 and would fail against `main`.

## Verification
`pwsh -NoProfile -Command "Invoke-Pester -Path .\Pull-SDLC.ai.Tests.ps1 -PassThru | Select TotalCount,PassedCount,FailedCount"`
Expect 64/64 (was 62/62).