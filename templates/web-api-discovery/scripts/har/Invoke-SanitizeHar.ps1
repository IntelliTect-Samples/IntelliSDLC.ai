#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    PowerShell wrapper for sanitize-har.js and verify-scrub.js.

.DESCRIPTION
    Locates Node, runs sanitize-har.js (unless -VerifyOnly), then runs
    verify-scrub.js. Propagates the non-zero exit code of either step
    back to the caller so it can be used in CI / pre-commit hooks.

    -WhatIf reports what would be written and runs nothing. Neither the
    scrubbed HAR, nor the substitution table, nor verify-scrub.js's findings
    report is produced -- a dry run that wrote its own report would not be one.

    A CAVEAT WORTH KNOWING, because it is a property of PowerShell rather than
    of this script: -WhatIf also arrives by PREFERENCE. A caller that never
    declares SupportsShouldProcess, and therefore rejects a -WhatIf parameter,
    still propagates $WhatIfPreference from its own scope into everything it
    invokes -- so this script would report and skip while its caller believed
    the scrub had run. Any script that composes this one must therefore pass
    -WhatIf:$false explicitly on the call.

.PARAMETER InputHar
    Path to the input HAR file (original, unscrubbed -- or, with -VerifyOnly,
    the HAR to verify directly).

    OR A FOLDER, WHICH MEANS "EVERY CAPTURE UNDER IT" (#386). A store root, one
    host's folder, or a single session directory -- the enumeration is the same
    one `capture-har.js` uses to answer `stop`, `status` and `catalogue`, so the
    batch and the single-capture commands can never disagree about what a
    capture is. A FILE behaves exactly as it always has; nothing about the
    single-capture path changed.

    Pointing at a host folder IS the host filter. There is no --host, because
    there is nothing for it to do that the path does not already say.

    Each capture is scrubbed into its OWN session directory, which is where
    #377 already puts a capture's artifacts: beside the raw it came from,
    carrying the stamp, inside the gitignored capture tree. -OutputHar,
    -SubstitutionsFile, -VerifyOnly and -RemoveSource are all refused with a
    folder -- the first two name one destination for many captures, and the
    last two are single-artifact decisions that should not be taken 88 at a
    time.

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

.PARAMETER RemoveSource
    Delete the raw HAR named by -InputHar, and the substitution tables this run
    wrote, once the scrub has VERIFIED. A raw capture carries the live session
    cookies the scrub exists to strip, and they accumulate -- this is the lever
    against that. Four conditions, and each of them is the point:

      * ONLY on a clean verify. A rejected scrub keeps its source, and so does
        an ADVISORY one (exit 4): advisory means "review the findings, then
        waive or correct and scrub again", and scrubbing again needs the raw.
        Deleting on a verdict short of clean would leave the operator with
        neither a clean artifact nor the source -- worse than either alone.
      * NEVER with -VerifyOnly, which is refused outright. Nothing was scrubbed,
        so -InputHar is not a spent source; it is the artifact under inspection.
      * THE TABLES GO WITH THE RAW. `.substitutions.json` and
        `.har-substitutions.json` are keyed by the plaintext originals, so each
        is a reverse lookup table of exactly what the raw carried. The paths
        removed are the ones sanitize-har.js REPORTS having written, not paths
        recomputed here -- a second derivation is a second engine, and this one
        deletes files.
      * NOTHING ELSE. This run's source and this run's tables. Not another
        session, not session.json, not a recording log. There is deliberately
        no age sweep and no Remove-HarCaptures.
      * IT CAUTIONS FIRST when -InputHar is not under a `.har-captures/`
        directory, which is where the recorder puts a raw and nowhere else. A
        HAR that has already been scrubbed is corrupted by a second scrub
        (#353), and deleting the source leaves nothing to regenerate from. The
        signal is LOCATION and deliberately not content; it is a warning rather
        than a refusal, because a raw can legitimately live elsewhere. The DRY
        RUN says it too, from the same function: a preview is where the decision
        gets made, so a caution that appeared only on the real run would arrive
        after the choice. Interim until #355's provenance stamp makes the
        question answerable.

.PARAMETER Force
    Scrub a capture again even though it already has a `scrubbed.har`. Only
    meaningful with a folder, and refused otherwise.

    RESUME IS BEHAVIOUR, NOT A FLAG. A folder run skips what is already done by
    looking for the completed artifact beside the raw, because a 9.0 GB store
    with a 1.6 GB capture in it WILL be interrupted and the second run has to
    pick up rather than start over. -Force is the way to say "do it anyway"
    after the profile's literals changed, or after a scrub was rejected and
    corrected. It replaces that capture's derived `scrubbed.har`; it never
    touches a raw.

.EXAMPLE
    .\Invoke-SanitizeHar.ps1 -InputHar capture.har -OutputHar clean.har

.EXAMPLE
    .\Invoke-SanitizeHar.ps1 -InputHar raw.har -OutputHar clean.har -RemoveSource

    Scrub, verify, and -- only if the gate passed clean -- delete raw.har and
    the substitution tables the run wrote.

.EXAMPLE
    .\Invoke-SanitizeHar.ps1 -InputHar .har-captures

    Scrub every capture in the store that does not already have a scrubbed HAR,
    then print processed / skipped / declined / failed with reasons.

.EXAMPLE
    .\Invoke-SanitizeHar.ps1 -InputHar .har-captures/app.example.com -Force

    The same, narrowed to one host by pointing at its folder, and re-running the
    captures that were already scrubbed.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$InputHar,

    [string]$OutputHar,

    [string]$ProfilePath,

    [string]$SubstitutionsFile,

    [switch]$VerifyOnly,

    [switch]$RemoveSource,

    # The ONE option this feature adds, and the only one approved for it. See
    # .PARAMETER Force -- it means "ignore the resume check", nothing else, and
    # in particular it does not soften the leak gate.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Refused, not quietly ignored. -VerifyOnly scrubs nothing, so there is no
# "source" that has been superseded -- the file -InputHar names IS the artifact
# under inspection, and the combination reads as a request to delete it.
# -Force is the resume override, and resume only exists for a folder. Accepting
# it silently on a single file would imply it overrode something -- the leak
# gate, the -RemoveSource conditions -- that it does not.
if ($Force -and -not (Test-Path -LiteralPath $InputHar -PathType Container)) {
    Write-Error ('-Force applies to a folder run only: it means "scrub captures that already have a ' +
        'scrubbed.har". Scrubbing a single HAR is not skipped, so there is nothing for it to override.')
    exit 1
}

if ($RemoveSource -and $VerifyOnly) {
    Write-Error ('-RemoveSource cannot be combined with -VerifyOnly: nothing is scrubbed, so ' +
        '-InputHar is the artifact being inspected rather than a spent source.')
    exit 1
}

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

# Does -InputHar sit where the RECORDER puts a raw?
#
# capture-har.js writes every raw under a `.har-captures/` directory --
# CAPTURES_DIR is a constant there and no option redirects it -- and
# sanitize-har.js's deriveSubsDir makes the same path-segment test to place the
# substitution tables. So an input under such a segment came from the recorder;
# an input anywhere else MIGHT have, and might equally be a HAR some earlier run
# already scrubbed.
#
# THE SIGNAL IS LOCATION, AND IT MUST NOT BECOME CONTENT. Scanning the file for
# `@example.invalid`, `4242...`, `ZZ00`, `+1555`, `9XX` or `06:F0:0D` would flag
# exactly the captures that most need scrubbing -- a payment-test environment
# legitimately carries the card, a test harness legitimately carries the address
# -- and would miss an already-scrubbed file whose fakes happened to omit those
# markers. That is the defect class #355 rules out explicitly.
#
# GetFullPath alone would resolve against [Environment]::CurrentDirectory, which
# PowerShell does not keep in step with $PWD, so a relative -InputHar is joined
# to the provider path first. Combine returns an absolute Path unchanged.
function Test-UnderCapturesDirectory {
    param([Parameter(Mandatory)][string]$Path)

    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($PWD.ProviderPath, $Path))
    $segments = [IO.Path]::GetDirectoryName($full).Split(
        [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    # -contains is case-insensitive, which is the right reading of a Windows
    # path and the forgiving direction for a caution: a near-miss on case stays
    # quiet rather than crying wolf.
    return $segments -contains '.har-captures'
}

# The caution itself: ONE message, ONE location test, two call sites -- the dry
# run's plan and the real run, immediately before the deletion. Copying the text
# into both is how a preview and a run drift apart, and a preview that no longer
# describes the run is precisely the inaccuracy this exists to close.
#
# A CAUTION, NOT A VERDICT. It cannot know the file was already scrubbed; it
# knows only that the file is not where the recorder leaves a raw, and
# sanitize-har.js's own usage text names samples/har-original/ as a legitimate
# raw location. So it does not refuse -- refusing would block a documented
# workflow on an inference. It names what is at risk and gets out of the way.
#
# The wording is deliberately true in BOTH contexts: it says what -RemoveSource
# does, not that a deletion is imminent, so the dry run does not claim an action
# it is not about to take.
#
# INTERIM (#353). The real fix is #355: sanitize-har.js stamps its output with
# provenance and refuses an input carrying one. That stamp does not exist yet --
# it is #297 Stage 10 -- and building a second one here is the two-engines
# failure this subsystem has spent fourteen PRs undoing.
function Write-ProvenanceCaution {
    param([Parameter(Mandatory)][string]$Path)

    if (Test-UnderCapturesDirectory -Path $Path) { return }
    Write-Warning ("$Path is not under a .har-captures/ directory, so it does not look like a " +
        'capture-recorder raw. Scrubbing an already-scrubbed HAR corrupts it: the second pass ' +
        "replaces the first pass's generated names with different ones, and the first pass's " +
        'substitution table stops describing the artifact (#353). -RemoveSource deletes this file ' +
        'once the scrub verifies clean, so check it is the raw before relying on this run.')
}

# What a dry run says. The conventional ShouldProcess line names the operation
# and the target, which tells an operator nothing they did not already know, so
# the destinations are listed as well -- including the substitution table, which
# is the file most easily written somewhere it should not be (#294).
#
# WHAT IT DOES NOT YET SAY is what would be REPLACED: counts by kind and class,
# with key path and fingerprint and never a value. That needs detection to run,
# and detection is not reachable from here without a change on the Node side --
# sanitize-har.js exposes no module surface and no dry-run mode, and
# verify-scrub.js both answers a different question (what is still present in a
# scrubbed file) and writes a findings report of its own. Driving pii.js's
# detectPii from an inline node program in this file would put a second walker
# over the HAR in a PowerShell string, which is the duplication this subsystem
# exists to avoid. So it is left out rather than approximated.
function Write-ScrubPlan {
    Write-Information "Nothing was written. This run would have produced:"
    if (-not $VerifyOnly) {
        Write-Information "  scrubbed HAR:       $OutputHar"
        if ($SubstitutionsFile) {
            Write-Information "  substitution table: $SubstitutionsFile"
        }
        else {
            Write-Information "  substitution table: chosen by sanitize-har.js, in the gitignored capture tree"
        }
    }
    Write-Information "  findings report:    scrub-findings.json, beside the verified file, if it is not clean"
    if ($RemoveSource) {
        Write-Information "  and $InputHar would be removed once the scrub verifies clean, with the substitution tables the run wrote"
        # A dry run's job is to be an accurate preview, and the preview is where
        # the decision gets made. A caution that appears only on the real run
        # arrives after the choice rather than before it. The plan already
        # commits to the consequence on the line above; omitting the caution
        # about that consequence is what would make it inaccurate.
        Write-ProvenanceCaution -Path $InputHar
    }
}

# Status goes to the information stream, and is on unless the caller says
# otherwise -- honouring an explicit -InformationAction rather than pinning
# 'Continue' on every call, which would make the messages unsuppressable.
if (-not $PSBoundParameters.ContainsKey('InformationAction')) {
    $InformationPreference = 'Continue'
}

# ---------------------------------------------------------------------------
# A FOLDER MEANS "EVERY CAPTURE UNDER IT" (#386)
# ---------------------------------------------------------------------------
#
# A store accumulates faster than anyone will drive a per-capture tool by hand:
# 88 raw captures, 9.0 GB, 5 ever scrubbed. That ratio is not carelessness, it
# is what happens when the only available motion is one at a time.
#
# So the plural argument is a DIRECTORY on the entry point that already exists,
# rather than a `batch` verb or a --store flag. -InputHar naming a file is
# untouched by every line below.
#
# WHY THIS ENTRY POINT AND NOT ONLY THE CATALOGUE ONE. The scrub is the stage
# the store is starving for -- 83 of the 88 have no scrubbed HAR at all, and a
# batch catalogue would decline every one of them, correctly, because
# cataloguing an unscrubbed capture is refused by design. Scrub is where the
# work is; catalogue gets the same treatment so the two halves of the pipeline
# stay symmetrical, but this is the one that moves the number.
if (Test-Path -LiteralPath $InputHar -PathType Container) {

    # REFUSED, not quietly ignored, and each for its own reason.
    #
    # -OutputHar and -SubstitutionsFile name ONE destination; with many captures
    # they would either collide or silently mean something other than what was
    # typed. Each capture's artifacts go to its own session directory instead,
    # which is where #377 already puts them.
    #
    # -VerifyOnly and -RemoveSource are single-artifact decisions. -RemoveSource
    # in particular deletes a raw, and "delete the raws for every capture under
    # this folder" is not a thing this pipeline will offer -- nothing under
    # .har-captures/ is removed in bulk.
    $refusals = [ordered]@{
        OutputHar         = 'names one destination file, and a folder holds many captures. Each capture is scrubbed into its own session directory.'
        SubstitutionsFile = 'names one table, and a folder holds many captures. sanitize-har.js places each table in the gitignored capture tree.'
        VerifyOnly        = 'is a single-artifact inspection. Point it at the HAR you want verified.'
        RemoveSource      = 'deletes a raw capture. It is not offered over a folder: nothing under .har-captures/ is removed in bulk.'
    }
    foreach ($name in $refusals.Keys) {
        if ($PSBoundParameters.ContainsKey($name) -and $PSBoundParameters[$name]) {
            Write-Error "-$name cannot be combined with a folder: it $($refusals[$name])"
            exit 1
        }
    }

    Import-Module (Join-Path $PSScriptRoot 'HarStoreBatch.psm1') -Force
    $captureStoreJs = Join-Path $PSScriptRoot '..' 'capture' 'capture-store.js'

    # THE SAME WALK `resolveSession` USES. Asked of Node, because a PowerShell
    # reimplementation would be a second answer to "what is a capture" and free
    # to disagree with the one `stop`, `status` and `catalogue` already give.
    $inventory = Get-HarCaptureInventory -Path $InputHar -CaptureStoreJs $captureStoreJs
    if (-not $inventory.Count) {
        Write-Error ("$InputHar holds no captures. A capture is a directory with a session.json in " +
            'it, at the captures root or one level under a host folder.')
        exit 3
    }

    $scrubOne = {
        param($capture)

        $sessionDir = $capture.dir
        if (-not $capture.raw) {
            return @{ Outcome = 'failed'; Reason = 'session.json but no raw.har -- nothing to scrub' }
        }

        $final = Join-Path $sessionDir 'scrubbed.har'
        if (-not $PSCmdlet.ShouldProcess($final, 'Scrub HAR -- replace detected secrets and PII')) {
            return @{ Outcome = 'skipped'; Reason = 'reported only; nothing was written' }
        }

        # SCRUBBED UNDER A TEMPORARY NAME, AND ONLY CALLED scrubbed.har ONCE THE
        # GATE HAS PASSED IT.
        #
        # This is what keeps resume correct rather than approximate. sanitize
        # writes its output before verify ever runs, so a rejected scrub written
        # straight to `scrubbed.har` would leave the completed artifact's own
        # name sitting beside the raw -- and the next run would read that as
        # "already processed" and skip a capture the leak gate had REFUSED. The
        # temporary name means the finished name never exists for a capture that
        # did not earn it, not even briefly.
        #
        # The prefix is deliberately not `.publishing-`: capture-har.js sweeps
        # abandoned temporaries under that prefix out of the output path, and
        # since #377 the output path IS this directory.
        $temp = Join-Path $sessionDir '.scrubbing-scrubbed.har'
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }

        # The scrub's output is SEEN, not RELAYED. It goes to the console as it
        # always has; what the summary carries is the exit code and nothing else.
        #
        # WHY THE MESSAGE IS NOT REPUBLISHED, tempting as it is. A failing scrub
        # can quote the capture it failed on: Node's JSON parser answers a
        # malformed HAR with `Unexpected token 'x', "<the first ten bytes>"...`,
        # and sanitize-har.js passes that message through. Lifting the last
        # output line into the summary therefore puts the capture's own bytes in
        # front of the operator -- in the one artifact of a batch run that is
        # meant to be safe to read, paste and share.
        #
        # "It is only ten characters" is not a defence: they are the ten
        # characters at the start of a file this pipeline exists to keep
        # unpublished. The capture is named, the code is given, and re-running
        # that one capture shows the message in full.
        # CAPTURED, then written to the host -- not left in the pipeline. This
        # scriptblock's return value is the outcome record and nothing else; a
        # stray stdout line in it makes the loop read node's chatter as the
        # result. Out-Host puts the text where the operator can see it without
        # it ever becoming a value this code passes on.
        $said = & node $sanitizeJs --in $capture.raw --out $temp @profileArgs 2>&1
        $scrubExit = $LASTEXITCODE
        $said | Out-Host
        if ($scrubExit -ne 0) {
            if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
            return @{
                Outcome = 'failed'
                Reason  = "sanitize-har.js exit $scrubExit -- its message is above and is not " +
                          'repeated here (a scrub error can quote the capture); re-run this ' +
                          'capture alone to see it in full'
            }
        }

        & node $verifyJs --in $temp @profileArgs 2>&1 | Out-Null
        $gate = $LASTEXITCODE

        if ($gate -eq 0 -or $gate -eq 4) {
            # -Force replaces the DERIVED artifact of a capture the operator
            # asked to redo. It never replaces a raw; no path here writes to one.
            Move-Item -LiteralPath $temp -Destination $final -Force
            $note = if ($gate -eq 4) {
                'gate returned ADVISORY findings (exit 4) -- artifact kept, findings to review'
            }
            else { $null }
            return @{ Outcome = 'processed'; Reason = $note }
        }

        # REJECTED. Quarantined in this capture's own session directory, exactly
        # as a single run does, and nothing is promoted.
        #
        # A BATCH DOES NOT SOFTEN THE GATE. "Keep the run going" is a reason to
        # move on to the next capture; it is never a reason to accept this one.
        # The rejected artifact keeps every byte under a name nothing reads as
        # finished, and its findings report moves with it -- a report separated
        # from the artifact it describes is one nobody can act on.
        $quarantine = Get-HarFreeName -Directory $sessionDir -Stem 'scrubbed.rejected' -Extension '.har'
        Move-Item -LiteralPath $temp -Destination $quarantine
        $findings = Join-Path $sessionDir 'scrub-findings.json'
        if (Test-Path -LiteralPath $findings) {
            $suffix = [IO.Path]::GetFileNameWithoutExtension($quarantine).Substring('scrubbed.rejected'.Length)
            $moved = Get-HarFreeName -Directory $sessionDir -Stem "scrub-findings$suffix" -Extension '.json'
            Move-Item -LiteralPath $findings -Destination $moved
        }
        return @{
            Outcome = 'failed'
            Reason  = "leak gate REJECTED the scrub (exit $gate) -- quarantined as $(Split-Path -Leaf $quarantine), nothing promoted"
        }
    }

    # RESUME, ASKED OF THE ARTIFACT. Not of a state file and not of a log: a
    # `scrubbed.har` beside the raw is the only thing that means the scrub
    # finished, and it is written under that name only after the gate passed.
    $results = Invoke-HarCaptureBatch -Inventory $inventory -Stage 'scrubbed' -Force:$Force `
        -IsProcessed { param($c) [bool]$c.scrubbed } -Process $scrubOne

    Write-Information ''
    Get-HarBatchSummaryLines -Results $results -Stage 'Scrub' |
        ForEach-Object { Write-Information $_ }

    # One code for "some capture failed", because a batch's exit cannot carry 88
    # verdicts and the summary above is where they are. The per-capture codes are
    # not collapsed into it -- they are reported, by capture, with reasons.
    $failures = @($results | Where-Object { $_.Outcome -eq 'failed' })
    exit ($failures.Count ? 1 : 0)
}

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
    if (-not $PSCmdlet.ShouldProcess($OutputHar, 'Scrub HAR -- replace detected secrets and PII')) {
        Write-ScrubPlan
        exit 0
    }
    # The scrub's own console output is passed straight through by default --
    # Tee-Object relays stdout as it arrives rather than buffering it to the
    # end, so the operator sees the same run they saw before. It is only
    # CAPTURED at all so -RemoveSource can read back the substitution-table
    # paths the run reported writing, instead of deriving them a second time
    # here and hoping the two derivations agree.
    if ($RemoveSource) {
        & node $sanitizeJs --in $InputHar --out $OutputHar @subsArgs @profileArgs |
            Tee-Object -Variable sanitizeSaid
    }
    else {
        & node $sanitizeJs --in $InputHar --out $OutputHar @subsArgs @profileArgs
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "sanitize-har.js failed with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
    $target = $OutputHar

    # What the run actually wrote, in the run's own words. An empty list here
    # is not "no tables": it means the scrub did not say, and a delete built on
    # a guess about a credential-keyed file is not one to make -- so the tables
    # are left alone and the operator is told, rather than a derived path being
    # removed on speculation.
    $tablesWritten = @(
        foreach ($line in @($sanitizeSaid)) {
            if ("$line" -match '^\s*sanitize-har: subs-table:\s*(.+?)\s*$') { $Matches[1] }
        })
}
else {
    $target = $InputHar
}

# The verifier is guarded too, and not only for symmetry: a non-clean run
# writes scrub-findings.json beside what it verified. A dry run that produced
# its own report on disk would not be a dry run.
if (-not $PSCmdlet.ShouldProcess($target, 'Verify scrub -- scan for residual leaks')) {
    if ($VerifyOnly) { Write-ScrubPlan }
    exit 0
}

& node $verifyJs --in $target @profileArgs
$verifyExit = $LASTEXITCODE

# -RemoveSource, and the one condition that decides it: the gate came back
# CLEAN. Not "the scrub ran", not "the artifact was kept".
#
# Exit 4 keeps the artifact (#343) and still fails this test on purpose. An
# advisory verdict is an invitation to review the findings and either waive or
# correct them and scrub AGAIN -- which needs the raw. Removing it on a 4 would
# break the single workflow the advisory code exists to enable, and would do it
# at the moment the operator is least able to notice.
#
# The raw is the ONLY copy of the recording, so the failure mode of getting
# this wrong is total: no clean artifact and no source. Hence a positive test
# for zero rather than a negative test for the codes known to be bad -- a code
# this script has never heard of must keep the source, not lose it.
if ($RemoveSource -and $verifyExit -eq 0) {
    # Said BEFORE anything is removed, so the sentence is on screen beside the
    # thing it is about and survives a deletion that later fails. Same function
    # the dry run calls, so the preview and the run cannot disagree.
    Write-ProvenanceCaution -Path $InputHar

    # THIS run's source and THIS run's tables, and nothing else. Not another
    # session's raw, not session.json, not the recording log; there is
    # deliberately no age sweep and no Remove-HarCaptures command. The table
    # paths come from what sanitize-har.js reported writing, never from a
    # second derivation of deriveSubsDir here.
    $doomed = @($InputHar) + @($tablesWritten)
    if (-not $tablesWritten) {
        Write-Warning ('sanitize-har.js reported no substitution tables, so none were removed. ' +
            'They are keyed by the values the scrub replaced -- find and remove them by hand.')
    }
    foreach ($victim in $doomed) {
        if (-not (Test-Path -LiteralPath $victim)) { continue }
        if ($PSCmdlet.ShouldProcess($victim, 'Remove -- superseded by the verified scrub')) {
            Remove-Item -LiteralPath $victim -Force
            Write-Information "removed $victim"
        }
    }
}

exit $verifyExit
