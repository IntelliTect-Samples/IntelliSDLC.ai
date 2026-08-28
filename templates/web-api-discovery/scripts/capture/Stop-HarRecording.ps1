#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    End a HAR recording started by Start-HarRecording.

.DESCRIPTION
    PowerShell front door for `capture-har.js stop`.

    A HUMAN does not normally need this: they end the recording by pressing
    ENTER in the console Start-HarRecording is waiting on, which performs the
    same close this script asks for.

    Do NOT end a recording by closing the browser window. Playwright
    serializes recordHar during a close the DRIVER performs; when the window
    goes first, Chrome exits before that can happen and no HAR is written at
    all. That is measured, not theoretical -- see the skill's Phase 2.

    This script exists for the case where nobody is holding that console --
    an AI driving the session over CDP from another process -- and as the
    recovery path when the console or window is out of reach.

    It asks the recording context to close and waits for the flush. It never
    kills a browser process: killing one discards the entire recording, and a
    developer's machine may hold real signed-in windows whose loss has nothing
    to do with this capture.

    It is idempotent. Against a window the operator already closed, the HAR is
    already written, so it verifies and reports rather than failing.

    A capture that produced no HAR, or one below -MinimumBytes, is reported as
    a failure -- silently handing back an empty file sends you off to analyze a
    recording that never existed.

.PARAMETER Session
    The capture session directory to stop. Defaults to the running capture, or
    the most recent one on disk.

.PARAMETER MinimumBytes
    Size below which the capture is treated as failed. Default 1024.

.PARAMETER CapturesDirectory
    Where captures live. Default .har-captures.

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
    exit 1
}

$captureJs = Join-Path $PSScriptRoot 'capture-har.js'
if (-not (Test-Path -LiteralPath $captureJs)) {
    Write-Error "capture-har.js not found at $captureJs"
    exit 1
}

$captureArgs = @('stop', '--min-bytes', $MinimumBytes)
if ($Session) { $captureArgs += @('--session', $Session) }
if ($CapturesDirectory) { $captureArgs += @('--dir', $CapturesDirectory) }
if ($ValidateOnly) { $captureArgs += '--validate-only' }

& node $captureJs @captureArgs
exit $LASTEXITCODE
