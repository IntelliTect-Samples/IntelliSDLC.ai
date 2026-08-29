<#
.SYNOPSIS
    Runs the repository's Pester suite and gates the build on the result.

.DESCRIPTION
    The entry point for the "Pester tests (.github/)" CI job. Resolves test
    files itself rather than handing Invoke-Pester a directory, because Pester
    cannot resolve a hidden path -- `.github` is hidden on Linux, which made the
    job run zero tests while reporting success (issue #304).

    Exits 0 only when tests were discovered, actually ran, and all passed. Every
    failure path writes a GitHub Actions ::error:: annotation naming the check
    that tripped.

.PARAMETER Path
    One or more roots to search for *.Tests.ps1 files. Defaults to .github.

.EXAMPLE
    pwsh -File .github/ci/Invoke-PesterSuite.ps1 -Path ./.github
#>
[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string[]]$Path = @('.github')
)

$ErrorActionPreference = 'Stop'

# Deliberately no Set-StrictMode here. This script shares a session with the
# suite it runs, so anything it sets leaks into every test: StrictMode Latest
# turned six unrelated, previously-passing tests red. A gate must not change
# the outcome it is measuring. PesterGate.psm1 sets StrictMode for its own
# code, where the module scope keeps it contained.
$script:GateModule = Join-Path $PSScriptRoot 'PesterGate.psm1'
Import-Module $script:GateModule -Force

try {
    $testFiles = @(Get-PesterTestFile -Path $Path)
}
catch {
    Write-Output "::error::Pester gate: could not resolve the test roots -- $($_.Exception.Message)"
    exit 1
}

Write-Output "Discovered $($testFiles.Count) test file(s) under: $($Path -join ', ')"

# $result stays $null if Invoke-Pester throws. That is the state the old gate
# could not see, and Test-PesterGate treats it as a failure.
$result = $null
if ($testFiles.Count -gt 0) {
    try {
        $result = Invoke-Pester -Path $testFiles -Output Detailed -PassThru
    }
    catch {
        Write-Output "::error::Pester gate: Invoke-Pester threw -- $($_.Exception.Message)"
    }
}

# The suite can unload this module -- PesterGate's own tests import it and
# remove it in AfterAll -- which would leave Test-PesterGate undefined right
# when the verdict is needed. Re-import before relying on it.
Import-Module $script:GateModule -Force

$verdict = Test-PesterGate -Result $result -ExpectedFile $testFiles

if (-not $verdict.Passed) {
    Write-Output "::error::Pester gate failed: $($verdict.Reason)"
    exit 1
}

Write-Output "Pester gate passed: $($verdict.Reason)"
exit 0
