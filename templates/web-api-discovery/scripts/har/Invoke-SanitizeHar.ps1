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

.PARAMETER ProfilePath
    Path to the operator's .har-profile.json, which carries the HMAC salt for
    the deterministic faker table and the literal -> sentinel map for the
    literal-value scrub pass. Defaults to the nearest .har-profile.json at or
    above the working directory. The file is gitignored and never defaulted:
    the literals are the operator's own identifiers.

.PARAMETER SubstitutionsFile
    Path to write the substitution map to. Defaults to sanitize-har.js's own
    choice: the gitignored capture tree, never beside OutputHar. The map's
    keys are the values the scrub replaced, so it is recorder state and not
    an artifact to commit.

.PARAMETER VerifyOnly
    Skip sanitize; only run verify-scrub against InputHar.

.EXAMPLE
    .\Invoke-SanitizeHar.ps1 -InputHar capture.har -OutputHar clean.har
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$InputHar,

    [string]$OutputHar,

    [string]$ProfilePath,

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

$profileArgs = if ($ProfilePath) { @('--profile', $ProfilePath) } else { @() }

if (-not $VerifyOnly) {
    if (-not $OutputHar) {
        Write-Error "OutputHar is required when not using -VerifyOnly."
        exit 1
    }
    # No default of our own. The map is keyed by the plaintext values the
    # scrub replaced, and defaulting it to <OutputHar>.subs.json put that
    # reverse lookup table beside the artifact that is safe to commit
    # (issue #294). Omitting --subs lets sanitize-har.js place it in the
    # gitignored capture tree, which is the one place the decision belongs.
    $subsArgs = if ($SubstitutionsFile) { @('--subs', $SubstitutionsFile) } else { @() }
    & node $sanitizeJs --in $InputHar --out $OutputHar @subsArgs @profileArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "sanitize-har.js failed with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
    $target = $OutputHar
}
else {
    $target = $InputHar
}

& node $verifyJs --in $target @profileArgs
exit $LASTEXITCODE
