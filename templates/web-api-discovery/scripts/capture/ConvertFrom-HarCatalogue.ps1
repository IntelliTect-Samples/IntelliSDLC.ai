#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Read a capture catalogue and emit it as typed pipeline objects.

.DESCRIPTION
    The catalogue is the durable half of a capture: an AI segments the session,
    names what a human actually did, and records which endpoints were merely
    observed. This turns that file into objects so callers can compose with it
    rather than parse text:

        Invoke-HarCapture https://example.com | ConvertTo-Json -Depth 4
        Invoke-HarCapture https://example.com | Where-Object Status -eq Observed

    A separate script rather than a function inside Invoke-HarCapture.ps1,
    because the conversion is the one part of the pipeline that can be exercised
    without launching a browser -- and behavior nothing can reach is behavior
    nothing tests.

    Console rendering comes from PowerShell's own formatting engine via
    HarCapture.Format.ps1xml, not from hand-rolled text. Emitting objects and
    letting the host format them is what keeps ConvertTo-Json / ConvertTo-Csv
    working on the same result.

.PARAMETER Path
    The catalogue.json written into the capture's output path.

.OUTPUTS
    IntelliSDLC.HarCapture.CatalogueEntry

.EXAMPLE
    ConvertFrom-HarCatalogue.ps1 -Path ./app.example.com/catalogue.json |
        Where-Object Status -eq Exercised
#>

[CmdletBinding()]
[OutputType('IntelliSDLC.HarCapture.CatalogueEntry')]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "catalogue not found: $Path"
    return
}

$formatFile = Join-Path $PSScriptRoot 'HarCapture.Format.ps1xml'
if (Test-Path -LiteralPath $formatFile) {
    # -PrependPath so a re-run in the same session picks up the current file
    # rather than the copy loaded the first time.
    Update-FormatData -PrependPath $formatFile -ErrorAction SilentlyContinue
}

$raw = Get-Content -LiteralPath $Path -Raw
if ([string]::IsNullOrWhiteSpace($raw)) { return }

# -AsHashtable is deliberately NOT used: the property order in the file is the
# order a reader expects to see, and a hashtable would discard it.
$entries = $raw | ConvertFrom-Json

foreach ($entry in @($entries)) {
    [pscustomobject]@{
        PSTypeName  = 'IntelliSDLC.HarCapture.CatalogueEntry'
        Action      = $entry.Action
        Description = $entry.Description
        # @() around each so a single-element array survives ConvertFrom-Json's
        # unwrapping -- a caller doing .Methods.Count on a scalar gets a
        # character count instead of 1, which is a silent wrong answer.
        Methods     = @($entry.Methods)
        Endpoints   = @($entry.Endpoints)
        EntryCount  = $entry.EntryCount
        Status      = $entry.Status
        HarFile     = $entry.HarFile
        CapturedUtc = $entry.CapturedUtc
    }
}
