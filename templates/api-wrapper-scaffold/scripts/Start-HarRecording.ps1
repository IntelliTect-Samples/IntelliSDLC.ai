#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Record a whole browser session to a raw HAR file.

.DESCRIPTION
    PowerShell front door for capture-har.js. Opens a browser on a dedicated
    capture profile, records every request, and writes a raw HAR when the
    session ends.

    The operator's entire surface is a URL:

        Start-HarRecording https://example.com

    Browse, perform the operations worth documenting -- including the failure
    paths, which are frequently the highest-value entries because they
    establish the site's real error taxonomy -- then press ENTER in this
    terminal. Ctrl+C does the same thing; it is trapped, not fatal.

    Do NOT end a recording by closing the browser window. Playwright serializes
    the HAR during a close this script performs; when the window goes first,
    Chrome exits before that can happen and no HAR is written at all. A
    snapshot is flushed every few seconds precisely so that ending is
    survivable -- it yields a recovery artifact with best-effort bodies and no
    timings, which is much better than nothing and much worse than the real
    thing.

    Nothing is scrubbed, extracted or catalogued automatically: which entries
    document which operation, what to name them, and which literal values must
    be redacted are judgement calls. Ask Claude to "catalogue that capture", or
    drive extract-har-reference.js yourself.

    The raw capture carries live credentials and is never committed.

.PARAMETER Uri
    The site to open. Positional, so the parameter name is optional.

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
    the persistent capture profile. For CI and throwaway captures; an isolated
    run is not signed in unless -StorageState supplies a session.

.PARAMETER StorageState
    A Playwright storageState.json whose cookies and local storage are loaded
    into the session.

.PARAMETER Port
    Remote-debugging port the recording context listens on, so an agent can
    attach over CDP and drive the same recording. Default 9333.

.PARAMETER CapturesDirectory
    Where captures are written. Default .har-captures (gitignored).

.PARAMETER ValidateOnly
    Resolve and print the paths without launching a browser.

.EXAMPLE
    Start-HarRecording https://example.com

.EXAMPLE
    Start-HarRecording -Uri https://example.com -Isolated -StorageState .\state.json
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Uri,

    [string]$Profile,

    [switch]$Isolated,

    [string]$StorageState,

    [int]$Port = 9333,

    [string]$CapturesDirectory,

    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'node not found on PATH -- install Node.js >= 18 to record a capture.'
    exit 1
}

$captureJs = Join-Path $PSScriptRoot 'capture-har.js'
if (-not (Test-Path -LiteralPath $captureJs)) {
    Write-Error "capture-har.js not found at $captureJs"
    exit 1
}

$captureArgs = @('start', '--uri', $Uri, '--port', $Port)
if ($Profile) { $captureArgs += @('--profile', $Profile) }
if ($Isolated) { $captureArgs += '--isolated' }
if ($StorageState) { $captureArgs += @('--storage-state', $StorageState) }
if ($CapturesDirectory) { $captureArgs += @('--dir', $CapturesDirectory) }
if ($ValidateOnly) { $captureArgs += '--validate-only' }

if (-not $ValidateOnly) {
    Write-Host ''
    Write-Host 'Recording. Drive the browser, then press ' -NoNewline
    Write-Host 'ENTER here' -ForegroundColor Yellow -NoNewline
    Write-Host ' to end the capture and write the HAR.'
    Write-Host 'Closing the browser window instead leaves only a recovery snapshot.'
    Write-Host ''
}

& node $captureJs @captureArgs
exit $LASTEXITCODE
