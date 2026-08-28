#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    End a HAR recording started by Invoke-HarCapture.

.DESCRIPTION
    PowerShell front door for `capture-har.js stop`.

    A HUMAN does not normally need this: they end the recording by pressing
    ENTER in the console Invoke-HarCapture is waiting on, or by closing the
    browser window. Both reach the same post-processing.

    This script exists for the case where nobody is holding that console --
    an AI driving the session over CDP from another process -- and as the
    recovery path when the console or window is out of reach.

    It does NOT post-process. It writes a STOP sentinel; the recording process
    polls for it, wins the ending race, and runs scrub, verify and digest in
    the process that owns the browser. Doing the work in two places would mean
    two answers to "was this capture scrubbed".

    So this script WAITS -- first for the recording to end, then for
    post-processing to finish -- and reports both the raw capture and the
    scrubbed artifacts. Reporting a capture as done while the scrub is still
    running would name files that do not exist yet.

    It never kills a browser process: killing one discards the entire
    recording, and a developer's machine may hold real signed-in windows whose
    loss has nothing to do with this capture.

    It is idempotent. Against a window the operator already closed, the work is
    already done, so it verifies and reports rather than failing.

    A capture that produced no HAR, or one below -MinimumBytes, is reported as
    a failure -- silently handing back an empty file sends you off to analyze a
    recording that never existed.

.PARAMETER Session
    The capture session directory to stop. Defaults to the running capture, or
    the most recent one on disk.

.PARAMETER MinimumBytes
    Size below which the capture is treated as failed. Default 1024.

.PARAMETER CapturesDirectory
    Where captures live. Default .har-captures. This resolves an EXISTING
    session; it cannot move where a new capture is written.

.PARAMETER ValidateOnly
    Resolve and print what would be stopped, without stopping it.

.EXAMPLE
    Stop-HarRecording
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Session,

    [int]$MinimumBytes = 1024,

    [string]$CapturesDirectory,

    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'node not found on PATH -- install Node.js >= 18 to use this script.'
    return
}

$captureJs = Join-Path $PSScriptRoot 'capture-har.js'
if (-not (Test-Path -LiteralPath $captureJs)) {
    Write-Error "capture-har.js not found at $captureJs"
    return
}

$captureArgs = @('stop', '--min-bytes', $MinimumBytes)
if ($Session) { $captureArgs += @('--session', $Session) }
if ($CapturesDirectory) { $captureArgs += @('--dir', $CapturesDirectory) }
if ($ValidateOnly) { $captureArgs += '--validate-only' }
# One verbosity switch, forwarded rather than duplicated -- see Invoke-HarCapture.ps1.
if ($VerbosePreference -ne 'SilentlyContinue') { $captureArgs += @('--log-level', 'verbose') }

Write-Verbose "capture-har.js $($captureArgs -join ' ')"

& node $captureJs @captureArgs
exit $LASTEXITCODE
