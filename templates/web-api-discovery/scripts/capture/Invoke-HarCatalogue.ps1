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

    OR A FOLDER HOLDING SEVERAL CAPTURES, WHICH MEANS ALL OF THEM (#386). A
    store root or one host's folder is catalogued capture by capture, skipping
    those that already have a catalogue.json. The captures are found through the
    same enumeration `resolveSession` uses -- not a second walk -- so the batch
    and the single-capture command can never disagree about what a capture is.

    Every shape that worked before still takes the identical path: a session
    directory, an output directory holding a scrubbed.har, and a scrubbed HAR
    file are all single-capture runs exactly as they were.

.PARAMETER Force
    Catalogue a capture again even though it already has a catalogue.json. Only
    meaningful with a folder holding several captures, and refused otherwise.

    IT DOES NOT OVERRIDE THE RECORDER'S REFUSAL to replace a catalogue that
    carries described actions. Cataloguing is an AI pass rather than a
    recomputation, so a second run may group a session differently, and
    discarding a catalogue somebody reviewed is the expensive mistake. -Force
    means only "do not skip this capture"; a capture whose catalogue holds work
    is still reported as skipped, with the reason.

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

    [string]$OutputPath,

    # The ONE option this feature adds, and the only one approved for it.
    [switch]$Force
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

# ---------------------------------------------------------------------------
# A FOLDER MEANS "EVERY CAPTURE UNDER IT" (#386)
# ---------------------------------------------------------------------------
#
# The same plural argument the scrub stage takes, on the stage that follows it,
# so the two halves of the pipeline can be driven over a store the same way.
#
# WHAT MUST NOT CHANGE, AND DOES NOT. -Path already accepted three directory
# shapes: a session directory, an output directory holding a scrubbed.har, and
# nothing at all. Each of those still reaches `capture-har.js catalogue`
# untouched, and the test that decides is the inventory itself:
#
#   the walk finds NOTHING            an output directory, or any other folder
#                                     that is not a capture. Falls through --
#                                     this is the `.\Invoke-HarCatalogue.ps1
#                                     .\app.example.com` case from the examples.
#   the walk finds THE PATH ITSELF    a single session directory. Falls through,
#                                     because a batch of one is the single
#                                     capture command and re-routing it would
#                                     change behaviour for nothing.
#   the walk finds captures UNDER it  a store root or a host folder. Batch.
#
# So the folder cases that worked before still take the identical code path, and
# the new behaviour appears only where the old one had nothing to say.
if ($Path -and (Test-Path -LiteralPath $Path -PathType Container)) {
    # The summary goes to the information stream, and is on unless the caller
    # says otherwise -- the same bargain Invoke-SanitizeHar.ps1 already makes.
    # Honouring an explicit -InformationAction rather than pinning 'Continue'
    # keeps it suppressable.
    if (-not $PSBoundParameters.ContainsKey('InformationAction')) {
        $InformationPreference = 'Continue'
    }

    Import-Module (Join-Path $PSScriptRoot '..' 'har' 'HarStoreBatch.psm1') -Force
    $captureStoreJs = Join-Path $PSScriptRoot 'capture-store.js'
    $inventory = Get-HarCaptureInventory -Path $Path -CaptureStoreJs $captureStoreJs

    # Path equality across two runtimes: .NET resolved it, Node resolved it, and
    # `-eq` compares them case-insensitively -- which is the right reading of a
    # Windows path and the only platform this pipeline targets. On a
    # case-sensitive filesystem the two could legitimately disagree about a path
    # typed in a different case than the directory entry; the effect would be a
    # single capture taking the batch path, which is a cosmetic difference and
    # not a wrong answer.
    $resolvedPath = (Resolve-Path -LiteralPath $Path).ProviderPath

    # ONE capture, and the operator pointed straight at it. That is the
    # single-capture command however the capture is classified -- including a
    # DECLINED one.
    #
    # Excluding foreign here looked tidier and was wrong. Pointing this script
    # at a mitmproxy dump used to reach capture-har.js and fail, correctly,
    # because there is nothing verified to catalogue. Routing it into the batch
    # instead answered "1 declined" and exited 0: a run that did nothing,
    # reporting success, for a path that had a perfectly good answer before.
    # Declining belongs to a capture found WHILE WALKING A STORE, not to the one
    # the operator named.
    $isSingleCapture = $inventory.Count -eq 1 -and $inventory[0].dir -eq $resolvedPath

    if ($inventory.Count -and -not $isSingleCapture) {
        if ($OutputPath) {
            # One destination for many captures would put every catalogue.json
            # on top of the last. Each capture's output goes to its own session
            # directory, which is #377's placement rule and needs no option.
            Write-Error ('-OutputPath cannot be combined with a folder holding several captures: ' +
                'digest.json and catalogue.json are fixed names, so one destination would have ' +
                'each capture overwrite the last. Each capture is catalogued into its own session directory.')
            exit 1
        }

        $catalogueOne = {
            param($capture)

            # Cataloguing a capture nobody scrubbed FAILS rather than writing a
            # catalogue that merely looks safe -- that is the property this
            # script's own header protects, and a batch is not allowed to be the
            # thing that erodes it. So an unscrubbed capture is reported as
            # skipped WITH THE REASON, which is precisely #386's complaint: 83
            # of 88 captures are in this state and nothing ever said so.
            if (-not $capture.scrubbed) {
                $why = if ($capture.rejected) {
                    'no scrubbed.har -- an earlier scrub was REJECTED and quarantined; triage it and scrub again'
                }
                else {
                    'no scrubbed.har -- run the scrub stage over it first (Invoke-SanitizeHar)'
                }
                return @{ Outcome = 'skipped'; Reason = $why }
            }

            & node $captureJs catalogue $capture.dir --output-path $capture.dir 2>&1 | Out-Null
            $code = $LASTEXITCODE
            switch ($code) {
                0 { return @{ Outcome = 'processed'; Reason = $null } }
                # Advisory: the catalogue WAS produced, over a capture whose
                # gate reported advisory findings. Non-zero so nothing reads it
                # as clean, but not a failure -- the same distinction the single
                # run makes, carried through rather than collapsed.
                7 { return @{ Outcome = 'processed'; Reason = 'gate reported ADVISORY findings (exit 7) -- catalogue produced' } }
                # The recorder's refusal to replace a catalogue somebody has
                # worked on. -Force means "do not skip"; it does NOT mean
                # "overwrite described work", and there is deliberately no
                # option on the recorder that would.
                2 { return @{ Outcome = 'skipped'; Reason = 'catalogue already carries described actions -- not replaced (move it aside to re-catalogue)' } }
                default { return @{ Outcome = 'failed'; Reason = "capture-har.js catalogue exit $code" } }
            }
        }

        $results = Invoke-HarCaptureBatch -Inventory $inventory -Stage 'catalogued' -Force:$Force `
            -IsProcessed { param($c) [bool]$c.catalogue } -Process $catalogueOne

        Write-Information ''
        Get-HarBatchSummaryLines -Results $results -Stage 'Catalogue' |
            ForEach-Object { Write-Information $_ }
        $failures = @($results | Where-Object { $_.Outcome -eq 'failed' })
        exit ($failures.Count ? 1 : 0)
    }
}

# -Force is the folder run's resume override and means nothing here. Refused
# rather than ignored, because ignoring it would let an operator believe it had
# overridden the recorder's refusal to replace a catalogue carrying described
# work -- which nothing overrides.
if ($Force) {
    Write-Error ('-Force applies to a folder holding several captures only: it means "catalogue ' +
        'captures that already have a catalogue.json". It does not override the refusal to ' +
        'replace a catalogue that carries described actions -- move that file aside instead.')
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
