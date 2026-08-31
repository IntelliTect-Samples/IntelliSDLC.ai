#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    PowerShell wrapper for `capture-har.js catalogue` -- digest and catalogue a
    capture that was already recorded and scrubbed.

.DESCRIPTION
    Re-enters the capture pipeline at its last stage. Locates Node, runs
    `capture-har.js catalogue` against an existing scrubbed HAR, and propagates
    the recorder's exit code back to the caller so it can be used in CI /
    pre-commit hooks.

    WHY THIS EXISTS. Scrubbing alone was already re-runnable through
    Invoke-SanitizeHar.ps1. Cataloguing alone was not possible at all: the
    digest and catalogue phases were reachable only as a side effect of a full
    recording, so regenerating a catalogue meant re-recording a browser session
    a human drove by hand -- which is not a repeat of anything. That matters
    since a rejected scrub is quarantined rather than destroyed and an advisory
    finding can be waived and the run repeated (#343).

    IT DECIDES NOTHING. Where a file may be written, what a finding means, and
    who runs the cataloguing AI are all owned by the recorder, which already
    implements them once. This script resolves Node, hands over the arguments,
    and returns the exit code. A second copy of any of those rules in
    PowerShell would drift from the Node one, which is the two-engines problem
    this subsystem exists to avoid.

    WHAT IT WILL NOT DO. It does not scrub, publish or quarantine anything. The
    recorder asks the leak gate about the HAR it is pointed at and produces no
    digest and no catalogue unless it passes -- so cataloguing a capture nobody
    scrubbed fails rather than writing a catalogue that merely looks safe. Use
    Invoke-SanitizeHar.ps1 for the scrub stage.

.PARAMETER Path
    What to catalogue. One of:

      a scrubbed HAR      the digest and catalogue are written beside it;
      a session directory one holding session.json under .har-captures/. Its
                          own output path is used, and the capture's URI,
                          intent hint and recording time are carried through;
      an output directory one that already holds a scrubbed.har.

    Omit it to catalogue the most recent capture under .har-captures/, which is
    the same resolution `capture-har.js stop` and `status` use.

.PARAMETER OutputPath
    Where the digest and catalogue are written. Defaults to the directory the
    scrubbed HAR is in -- for a session directory, the output path that
    capture recorded. Unlike Invoke-HarCapture's -OutputPath, no host-named
    folder is appended: this names the artifact directory itself, because the
    capture it belongs to already chose that name.

.EXAMPLE
    .\Invoke-HarCatalogue.ps1 .\app.example.com

    Regenerate the digest and catalogue for a capture already published there,
    with nothing re-recorded.

.EXAMPLE
    .\Invoke-SanitizeHar.ps1 -InputHar raw.har -OutputHar app.example.com\scrubbed.har
    .\Invoke-HarCatalogue.ps1 app.example.com\scrubbed.har

    The pipeline re-entered a stage at a time: scrub, then catalogue.

.EXAMPLE
    .\Invoke-HarCatalogue.ps1
    .\ConvertFrom-HarCatalogue.ps1 -Path app.example.com\catalogue.json

    Catalogue the most recent capture, then render its rows.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Path,

    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'node not found on PATH -- install Node.js >= 18 to use this script.'
    exit 1
}

$captureJs = Join-Path $PSScriptRoot 'capture-har.js'
if (-not (Test-Path -LiteralPath $captureJs)) {
    Write-Error "capture-har.js not found at $captureJs"
    exit 1
}

$captureArgs = @('catalogue')
if ($Path) { $captureArgs += $Path }
if ($OutputPath) { $captureArgs += @('--output-path', $OutputPath) }
# -Verbose is the only verbosity switch, and it is handed across rather than a
# second one being invented. Matches Invoke-HarCapture.ps1: the recorder prints
# its own console output directly, so re-streaming it through PowerShell would
# only buffer it.
if ($VerbosePreference -ne 'SilentlyContinue') { $captureArgs += @('--log-level', 'verbose') }

Write-Verbose "capture-har.js $($captureArgs -join ' ')"

& node $captureJs @captureArgs

# Propagated unchanged, and deliberately not translated. The recorder's codes
# are the contract every caller already reads: 6 means the catalogue was not
# produced, and 7 means it was produced over a capture whose leak gate reported
# ADVISORY findings -- non-zero so nothing reads it as clean, but not a failure.
# Collapsing them here would lose the distinction the quarantine work exists to
# make.
exit $LASTEXITCODE
