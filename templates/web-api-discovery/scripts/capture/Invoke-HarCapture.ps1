#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Record a browser session, scrub it, and catalogue it -- one command.

.DESCRIPTION
    PowerShell front door for capture-har.js. Opens a browser on a dedicated
    capture profile, records every request, then scrubs, verifies, digests and
    catalogues what it recorded.

    The operator's entire surface is a URL:

        Invoke-HarCapture https://example.com

    Browse, perform the operations worth documenting -- including the failure
    paths, which are frequently the highest-value entries because they
    establish the site's real error taxonomy -- then press ENTER in this
    terminal. Closing the browser window does the same thing; so does
    Stop-HarRecording from another process. Ctrl+C asks whether you meant to
    finish or to cancel.

    `Invoke-`, not `Start-`, because the command no longer merely starts
    something: by the time it returns, the capture has been scrubbed and
    verified and the catalogue exists.

    TWO DIRECTORIES, and the difference is the whole safety story:

      .har-captures/   the raw capture. Carries live session cookies, is
                       gitignored, and CANNOT be redirected -- there is no
                       option for it, so an unignored credential-bearing
                       capture is not reachable by any argument.
      -OutputPath      scrubbed, verified artifacts only: the per-action
                       reference HARs, the session digest, and the catalogue.

.PARAMETER Uri
    The site to open. Positional, so the parameter name is optional.

.PARAMETER OutputPath
    Where the scrubbed artifacts and the catalogue are written.
    Default docs/har-reference/. The raw capture never goes here.

.PARAMETER Describe
    An optional hint about what you intend to do, which helps the cataloguing
    step segment the session into actions. It is never the source of action
    names -- those come from the traffic.

.PARAMETER Profile
    Which signed-in identity to record as.

    A NAME keeps a separate capture profile per identity, so several accounts
    can stay signed in side by side without you knowing where profiles live.

    A PATH records as an identity another tool already owns -- useful when a
    project keys browser profiles off its own concept (a workspace, an account,
    a tenant) and can compute that directory for you. That tool cannot use the
    profile until the recording ends, because a persistent profile is
    single-instance; the recorder says so when you pass one.

    Omit it for the default capture profile.

.PARAMETER Isolated
    Use bundled Chromium with an ephemeral profile instead of system Chrome on
    the persistent capture profile. For CI and throwaway captures. An isolated
    run is not signed in unless a .har-storage-state.json is found at or above
    the working directory, which is discovered automatically.

.PARAMETER Port
    Remote-debugging port the recording context listens on, so an agent can
    attach over CDP and drive the same recording. Default 9333, and it never
    has to be specified: a busy port falls forward to the next free one, and
    the endpoint actually chosen is written to the session so an agent reads
    it rather than assuming.

.OUTPUTS
    IntelliSDLC.HarCapture.CatalogueEntry

.EXAMPLE
    Invoke-HarCapture https://example.com

.EXAMPLE
    Invoke-HarCapture https://example.com | Where-Object Status -eq Observed

.EXAMPLE
    Invoke-HarCapture https://example.com -Describe 'create, edit and delete a post' |
        ConvertTo-Json -Depth 4
#>

[CmdletBinding()]
[OutputType('IntelliSDLC.HarCapture.CatalogueEntry')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidAssignmentToAutomaticVariable', 'Profile',
    Justification = 'Which signed-in identity to record as is the operator-facing name for this input, and $PROFILE is never read in this script. Renaming the parameter to satisfy the analyzer would make the surface worse to serve a shadowing that has no effect here.')]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Uri,

    [string]$OutputPath,

    [string]$Describe,

    [string]$Profile,

    [switch]$Isolated,

    [int]$Port = 9333
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'node not found on PATH -- install Node.js >= 18 to record a capture.'
    return
}

$captureJs = Join-Path $PSScriptRoot 'capture-har.js'
if (-not (Test-Path -LiteralPath $captureJs)) {
    Write-Error "capture-har.js not found at $captureJs"
    return
}

$captureArgs = @('start', '--uri', $Uri, '--port', $Port)
if ($OutputPath) { $captureArgs += @('--output-path', $OutputPath) }
if ($Describe) { $captureArgs += @('--describe', $Describe) }
if ($Profile) { $captureArgs += @('--profile', $Profile) }
if ($Isolated) { $captureArgs += '--isolated' }

# Status goes to the information stream, never to the pipeline: per
# powershell.instructions.md -> Output & Streams, chatter mixed into the output
# is what makes `... | ConvertTo-Json` return prose instead of data. It is also
# why there is no Write-Host here.
Write-Information 'Recording. Browse, then press ENTER in this terminal to end the capture.' -InformationAction Continue
Write-Information 'Closing the browser window does the same thing. Ctrl+C asks first.' -InformationAction Continue

& node $captureJs @captureArgs
$exit = $LASTEXITCODE

# Exit codes are documented on capture-har.js. 5 means raw.har was assembled
# from the incremental log rather than recordHar -- a full capture either way,
# so it is not a failure. 6 means the recording is fine but a post-process
# phase is not, which must not be reported as success.
switch ($exit) {
    0 { }
    5 { Write-Information 'Capture assembled from the incremental record log.' -InformationAction Continue }
    6 { Write-Warning 'Recorded successfully, but scrub or catalogue failed. The raw capture is intact.' }
    default {
        Write-Error "capture-har exited $exit -- no catalogue was produced."
        return
    }
}

# The catalogue is read from THIS invocation's output path, which we already
# know -- never by globbing .har-captures/ for the newest session directory.
#
# That glob looks equivalent and is not: captures now coexist happily on
# different ports, so a second capture started in another terminal and finished
# first would be the lexicographically-last directory, and this run would emit
# a different site's catalogue as though it were its own. The recorder's
# current.json pointer is no help either -- it is deleted when recording ends,
# before node returns here.
$cataloguePath = Join-Path (
    $(if ($OutputPath) { $OutputPath } else { Join-Path 'docs' 'har-reference' })) 'catalogue.json'

if (-not (Test-Path -LiteralPath $cataloguePath)) {
    Write-Warning "no catalogue was written to $cataloguePath"
    return
}

$rows = @(& (Join-Path $PSScriptRoot 'ConvertFrom-HarCatalogue.ps1') -Path $cataloguePath)

# Say so when the catalogue is still a scaffold. The Status column already
# distinguishes the two, but an operator who does not read it would otherwise
# take a list of provisional rows for a finished catalogue. Derived from the
# rows themselves rather than from session state, so it survives the catalogue
# being filled in by any of the three runners.
#
# Keyed on Description, not Status: a real AI pass may legitimately conclude
# that every group was observed and none exercised, and telling that operator
# their catalogue never ran would be wrong. Describing a row is the one thing
# the AI does that the scaffold never can.
if ($rows.Count -and -not ($rows | Where-Object { $_.Description })) {
    Write-Information (
        'Every row is still Observed -- the catalogue needs its AI pass. See ' +
        (Join-Path $PSScriptRoot 'catalogue-prompt.md')) -InformationAction Continue
}

$rows
