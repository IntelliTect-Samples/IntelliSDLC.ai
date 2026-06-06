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
  with `-Confirm:$false`.

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
