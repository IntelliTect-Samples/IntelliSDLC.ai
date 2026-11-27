---
description: 'PowerShell coding conventions and best practices'
applyTo: '**/*.ps1,**/*.psm1,**/*.psd1'
---

# PowerShell Conventions

> Applied automatically to `.ps1`, `.psm1`, and `.psd1` files.

## General

- All new source and test files must be `.ps1` / `.psm1` / `.psd1`.
- Follow the **Verb-Noun** naming convention for functions.
- Use **comment-based help** (`<# .SYNOPSIS ... #>`) for every exported function.
- Prefer `[CmdletBinding()]` and `param()` blocks for all functions.
- Use **approved verbs** only (`Get-Verb` to list them).

## Parameters & Validation

- Use `[Parameter(Mandatory)]` for required parameters.
- Use `[ValidateNotNullOrEmpty()]`, `[ValidateSet()]`, `[ValidateRange()]` etc.
  where appropriate.
- Use `[OutputType()]` on functions that return typed objects.

## Output & Streams

- Pick the output cmdlet by **intent**. Avoid `Write-Host` (PSScriptAnalyzer
  `PSAvoidUsingWriteHost`) -- it writes straight to the host and cannot be
  captured, redirected, or suppressed.
  - `Write-Output` (or just emit the object) -- pipeline data / return values.
  - `Write-Information` -- human-facing status / progress messages (stream 6;
    controllable via `-InformationAction`, redirectable with `6>`).
  - `Write-Verbose` / `Write-Debug` -- opt-in diagnostics, gated by `-Verbose` /
    `-Debug`.
  - `Write-Warning` -- warnings. `Write-Error` (or `throw`) -- errors.
- **Color is a host concern -- do not hand-roll it.** The host renders
  `Write-Warning` in yellow and `Write-Error` in red automatically, so choosing
  the right stream gives you the color for free. In PowerShell 7.2+ these are
  configurable via `$PSStyle.Formatting.Warning`, `$PSStyle.Formatting.Error`,
  etc.; `Write-Information` is intentionally uncolored.
- Keep human-facing chatter out of a function's pipeline output so callers get
  clean return values.
- `Write-Host` is acceptable only for intentional, decorative interactive console
  UX that is never captured (e.g. colorized dry-run previews). Even then, prefer
  `$PSStyle`-composed ANSI over `-ForegroundColor` on PowerShell 7.2+.

## State-Changing Functions

- For functions or scripts that modify state (create / change / delete files,
  registry, services, remote resources, etc.), implement the standard
  `SupportsShouldProcess` pattern -- declare
  `[CmdletBinding(SupportsShouldProcess)]` and guard each mutating action with
  `if ($PSCmdlet.ShouldProcess($target, $action)) { ... }`.
- This gives callers the built-in `-WhatIf` (dry run) and `-Confirm` (prompt)
  switches for free. **Prefer this over a hand-rolled `-DryRun` / `-Preview`
  switch or any other bespoke dry-run flag** -- `-WhatIf` is the idiomatic
  PowerShell dry run and integrates with `$WhatIfPreference` and the rest of
  the engine.
- Set `[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]` for
  destructive operations so they prompt by default; unattended callers opt out
  with `-Confirm:$false`. That prompt still needs a guard when no one can answer
  it -- see **Non-Interactive Runs** below.

## Non-Interactive Runs

A script must never wait for input it cannot get -- the rule is
**Non-Interactive Runs -- Never Block on Input** in
`.github/copilot-instructions.md`. In PowerShell:

- **These all prompt, so each needs an interactivity guard:** `Read-Host`,
  `$Host.UI.PromptForChoice`, `Get-Credential`, `[Console]::ReadKey`,
  `Out-GridView`, `pause`, `$PSCmdlet.ShouldContinue`, the confirmation of a
  `ConfirmImpact = 'High'` function, and a `Mandatory` parameter left unbound.
  With stdin an open pipe no one writes to -- an agent session, a CI step --
  each of them hangs.
- **`-NonInteractive` alone is not the fix.** Under it `Read-Host` writes a
  non-terminating error and returns nothing, so the script carries on with an
  empty answer and can exit 0.
- **Prefer parameters to prompts.** Prompt only for a value that was not passed,
  and only when interactive; otherwise `throw`, naming the parameter that
  supplies it. Automation binds every `Mandatory` parameter and passes
  `-Confirm:$false` (or `-Force`) deliberately.
- **Decide interactivity in one function**, so tests can mock it:

  ```powershell
  function Test-Interactive {
      [CmdletBinding()]
      [OutputType([bool])]
      param()
      [Environment]::UserInteractive -and                    # not a service
          -not [Console]::IsInputRedirected -and             # not piped, redirected, or an agent's pipe
          $Host.Name -ne 'Default Host' -and                 # a host that can prompt (not a bare runspace)
          -not ([Environment]::GetCommandLineArgs() -match '^(--?|/)noni') -and  # not -NonInteractive
          [string]$env:CI -in '', 'false', '0'               # not CI (unset, empty, false or 0)
  }
  ```

  `[Environment]::UserInteractive` alone is not enough: it is `$true` inside an
  agent session, which is exactly the unattended case. It is `$false` only in a
  non-interactive window station (a service, or a task in session 0), and a
  remoting host is not covered by this sample. The stdin check catches pipes and
  redirects, not a pseudo-terminal an automation attaches. So automation should
  also set `CI` (or pass the tool's documented non-interactive switch), and every
  tool still offers that explicit switch. The `-NonInteractive` match also
  catches its abbreviations (`-noni`) and, rarely, an unrelated argument that
  starts the same way.
- **Native commands get their non-interactive flags** (`--yes`, `--no-input`,
  `--accept-*`, ...); one with no such flag gets no stdin to wait on:
  `$null | <tool> ...`.
- **Test the non-interactive path.** Mock `Test-Interactive` to return `$false`
  to cover the branch, and run the real script once in a child process whose
  stdin is an open pipe, under a timeout:

  ```powershell
  $psi = [System.Diagnostics.ProcessStartInfo]::new('pwsh')
  '-NoProfile', '-File', $ScriptPath | ForEach-Object { $psi.ArgumentList.Add($_) }
  $psi.RedirectStandardInput = $true   # held open, never written: the agent / CI case
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  try {
      $stderr = $proc.StandardError.ReadToEndAsync()
      $proc.WaitForExit(30000) | Should -BeTrue -Because 'it must fail fast, not wait for input'
      $proc.ExitCode | Should -Not -Be 0
      $stderr.Result | Should -Match '-Name'   # the message names what to pass instead
  } finally { if (-not $proc.HasExited) { $proc.Kill($true) } }
  ```

## Error Handling

- Use `-ErrorAction Stop` on critical calls within `try/catch` blocks.
- Write informative error messages with `Write-Error` or `throw`.
- Inspect `$Error[0]` and `$Error[0].ScriptStackTrace` when debugging.
- Prefer `$ErrorActionPreference = 'Stop'` at script scope for strict error handling.

## Module Patterns

- Always `Import-Module ... -Force` after code changes during development.
- Export only public functions via `Export-ModuleMember` or the module manifest.

## Static Analysis

```powershell
Invoke-ScriptAnalyzer -Path src/ -Recurse -Severity Warning
```

Fix all findings before committing.

## Testing (Pester)

| Layer | Tool | Location |
|---|---|---|
| Unit tests | Pester | `tests/unit/**/*.Tests.ps1` |
| Integration tests | Pester | `tests/integration/**/*.Tests.ps1` |

- Run tests with:
  ```powershell
  Invoke-Pester -Path tests/ -Output Detailed
  ```
- Use **Arrange / Act / Assert** pattern within `It` blocks.
- Use `BeforeAll`, `BeforeEach` for setup; `AfterAll`, `AfterEach` for cleanup.
- Mock external commands with `Mock` and verify with `Should -Invoke`.
- Code that crosses a provider or service boundary also needs a **live** test against the real provider -- see **Provider and Service Boundaries -- Live Tests Are Required** in `.github/copilot-instructions.md`.
