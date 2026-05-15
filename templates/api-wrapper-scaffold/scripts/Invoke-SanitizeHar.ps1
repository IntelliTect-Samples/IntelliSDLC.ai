#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    PowerShell wrapper for sanitize-har.js and verify-scrub.js.

.DESCRIPTION
    Locates Node, runs sanitize-har.js (unless -VerifyOnly), then runs
    verify-scrub.js. Propagates the non-zero exit code of either step
    back to the caller so it can be used in CI / pre-commit hooks.

.PARAMETER InputHar
    Path to the input HAR file (original, unscrubbed -- or, with -VerifyOnly,
    the HAR to verify directly).

.PARAMETER OutputHar
    Path to write the scrubbed HAR to. Ignored when -VerifyOnly is set.

.PARAMETER Salt
    HMAC salt for the deterministic faker substitution table. Required.

.PARAMETER SubstitutionsFile
    Path to write the substitution map to. Defaults to alongside OutputHar.

.PARAMETER VerifyOnly
    Skip sanitize; only run verify-scrub against InputHar.

.EXAMPLE
    .\Invoke-SanitizeHar.ps1 -InputHar capture.har -OutputHar clean.har -Salt 'project-salt'
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$InputHar,

    [string]$OutputHar,

    [Parameter(Mandatory)]
    [string]$Salt,

    [string]$SubstitutionsFile,

    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node not found on PATH -- install Node.js >= 18 to use this script."
    exit 1
}

$scriptDir = $PSScriptRoot
$sanitizeJs = Join-Path $scriptDir 'sanitize-har.js'
$verifyJs   = Join-Path $scriptDir 'verify-scrub.js'

if (-not (Test-Path -LiteralPath $sanitizeJs)) {
    Write-Error "sanitize-har.js not found at $sanitizeJs"
    exit 1
}
if (-not (Test-Path -LiteralPath $verifyJs)) {
    Write-Error "verify-scrub.js not found at $verifyJs"
    exit 1
}

if (-not $VerifyOnly) {
    if (-not $OutputHar) {
        Write-Error "OutputHar is required when not using -VerifyOnly."
        exit 1
    }
    if (-not $SubstitutionsFile) {
        $SubstitutionsFile = [System.IO.Path]::ChangeExtension($OutputHar, '.subs.json')
    }
    & node $sanitizeJs --in $InputHar --out $OutputHar --subs $SubstitutionsFile --salt $Salt
    if ($LASTEXITCODE -ne 0) {
        Write-Error "sanitize-har.js failed with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
    $target = $OutputHar
}
else {
    $target = $InputHar
}

& node $verifyJs --in $target
exit $LASTEXITCODE
