#Requires -Version 7.0

<#
.SYNOPSIS
    The batch driver shared by the pipeline's two re-entry points (#386).

.DESCRIPTION
    Issue #386 measured a real store: 88 raw captures, 9.0 GB, and 5 of them
    ever processed. Nobody was careless -- the only available motion was one
    capture at a time, and a store accumulates faster than anyone will drive a
    per-capture tool by hand.

    So POINTING AN EXISTING ENTRY POINT AT A FOLDER MEANS "ALL OF THEM". There
    is no batch verb, no --store, and no subcommand: `Invoke-SanitizeHar.ps1`
    and `Invoke-HarCatalogue.ps1` already name the two stages, and a directory
    is simply a plural argument to the stage that was already there. A path that
    resolves to a single capture still behaves exactly as it did.

    THIS MODULE IS THE LOOP AND NOTHING ELSE. It does not know what a scrub is
    or what a catalogue is; each entry point hands it a scriptblock for one
    capture and this decides only the four things a batch adds:

      WHICH CAPTURES     -- by asking `capture-store.js`, which is the SAME walk
                            `resolveSession` uses for `stop`, `status` and
                            `catalogue`. Not a second one (#387).
      WHICH TO SKIP      -- resume is behaviour, not a flag. A completed
                            artifact beside the raw is the signal, and -Force is
                            the one approved way to ignore it.
      ISOLATION          -- one malformed capture is recorded against itself and
                            the run continues. A 9.0 GB store with a 1.6 GB
                            capture in it will be interrupted; aborting on the
                            first bad directory would make the other 87
                            unreachable.
      THE SUMMARY        -- processed / skipped / declined / failed with
                            reasons, so 88 directories do not have to be read.

    WHAT IT REFUSES TO SOFTEN. A per-capture stage decides its own verdict and
    this never overrides one. A capture the leak gate rejects fails here exactly
    as it fails alone; "keep the batch going" is a reason to CONTINUE past a
    rejection, never a reason to accept it.

    IT NEVER PRINTS A CAPTURED VALUE. The summary carries host, stamp, class,
    outcome and reason. Not a URL, not a header, not an entry -- nothing in this
    module ever opens a HAR.
#>

Set-StrictMode -Version Latest

# Outcomes, and why there are four rather than three.
#
# #386 asked for processed / skipped / failed. DECLINED is a fourth because the
# store contains captures this pipeline must not touch -- mitmproxy dumps with
# no session.json -- and folding those into "skipped" would report them in the
# same breath as work that was correctly already done. The operator needs to see
# that a directory was recognised and REFUSED, which is the opposite of being
# passed over.
$script:OutcomeProcessed = 'processed'
$script:OutcomeSkipped   = 'skipped'
$script:OutcomeDeclined  = 'declined'
$script:OutcomeFailed    = 'failed'

<#
.SYNOPSIS
    Every capture at or under $Path, classified, from the one shared walk.

.DESCRIPTION
    Shells out to capture-store.js rather than walking the tree in PowerShell.
    That is the entire point: the enumeration `resolveSession` uses is in Node,
    a PowerShell reimplementation of it would be free to disagree about what a
    capture is, and the store having two answers to that is the defect this
    subsystem exists to avoid (#387).
#>
function Get-HarCaptureInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        # Where capture-store.js is. Passed in rather than derived, because the
        # two entry points sit in different directories and neither should have
        # to agree with this module about the other's layout.
        [Parameter(Mandatory)][string]$CaptureStoreJs
    )

    if (-not (Test-Path -LiteralPath $CaptureStoreJs)) {
        throw "capture-store.js not found at $CaptureStoreJs"
    }

    $json = & node $CaptureStoreJs $Path
    if ($LASTEXITCODE -ne 0) {
        throw "capture-store.js failed with exit code $LASTEXITCODE while enumerating $Path."
    }
    $parsed = ($json -join "`n") | ConvertFrom-Json
    # ConvertFrom-Json unwraps a one-element array, and a store with exactly one
    # capture in it is the everyday case for a test fixture and for an operator
    # pointing at a single session directory. Without the wrap, the loop below
    # would iterate the object's properties instead of the capture.
    return @($parsed)
}

<#
.SYNOPSIS
    Run one pipeline stage over an inventory, in isolation, and summarise.

.PARAMETER Inventory
    What Get-HarCaptureInventory returned.

.PARAMETER Stage
    What this stage has DONE to a capture once it is finished with it --
    'scrubbed', 'catalogued'. Past tense, because the only sentence it appears
    in is "already <Stage>", and building that from a stem meant interpolating
    "$Stage`ed", where PowerShell reads the backtick-e as an escape and quietly
    prints a control character.

.PARAMETER IsProcessed
    Given a capture, has this stage already completed for it? This is what
    "resume" means, and it is asked of the ARTIFACT rather than of any state
    file: a run that was killed halfway through a 1.6 GB capture leaves no
    completed artifact, so it is not mistaken for done.

.PARAMETER Process
    Given a capture, run the stage. Returns a hashtable with `Outcome` and
    `Reason`. It is called inside a try/catch: a throw is recorded against that
    capture as a failure and the run continues.

.PARAMETER Force
    Run the stage even where IsProcessed says it is done. The ONE new option
    this feature adds, and the only one approved.
#>
function Invoke-HarCaptureBatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Inventory,
        [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][scriptblock]$IsProcessed,
        [Parameter(Mandatory)][scriptblock]$Process,
        [switch]$Force
    )

    $results = [System.Collections.Generic.List[object]]::new()

    foreach ($capture in $Inventory) {
        $record = [ordered]@{
            Label   = Get-HarCaptureLabel -Capture $capture
            Class   = $capture.captureClass
            Outcome = $null
            Reason  = $null
        }

        # A capture this recorder did not make. NAMED and DECLINED -- never fed
        # to the HAR scrub, and never passed over in silence. It has no
        # session.json, so there is no URI, no intent and no provenance to
        # attribute the traffic to, and a scrub that cannot say what it scrubbed
        # is not one worth having.
        if ($capture.captureClass -eq 'foreign') {
            $record.Outcome = $script:OutcomeDeclined
            $record.Reason = "not recorder output ($($capture.reason))"
            $results.Add([pscustomobject]$record)
            continue
        }

        if (-not $Force -and (& $IsProcessed $capture)) {
            $record.Outcome = $script:OutcomeSkipped
            $record.Reason = "already $Stage -- use -Force to run it again"
            $results.Add([pscustomobject]$record)
            continue
        }

        # THE ISOLATION. Everything the stage can do wrong happens inside this
        # try: a corrupt HAR, a missing raw, a node crash, an unreadable
        # directory. Each is recorded against the capture that caused it, and
        # the loop moves on -- because the alternative is that capture 3 of 88
        # decides the other 85 do not get processed, which is how the store
        # reached 83 unprocessed captures in the first place.
        try {
            $outcome = & $Process $capture
            $record.Outcome = $outcome.Outcome
            $record.Reason = $outcome.Reason
        }
        catch {
            $record.Outcome = $script:OutcomeFailed
            $record.Reason = "$($_.Exception.Message)"
        }
        $results.Add([pscustomobject]$record)
    }

    return $results.ToArray()
}

<#
.SYNOPSIS
    How a capture is named in output: `<host>/<stamp>`, and never more.

.DESCRIPTION
    Host and stamp are the two things #386 permits printing. The full path would
    add only the operator's own directory layout, and `describe` and the URI are
    left out on purpose -- a magic-link or password-reset start URL carries its
    token, which is exactly the class of value this pipeline exists to keep out
    of output.

    A LEGACY capture has no host directory; its parent is the captures root
    itself, so naming that parent would print `.har-captures` as though it were
    a site.
#>
function Get-HarCaptureLabel {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Capture)

    if ($Capture.captureClass -eq 'legacy') { return $Capture.stamp }
    return "$($Capture.host)/$($Capture.stamp)"
}

<#
.SYNOPSIS
    The end-of-run summary as LINES: counts, then every capture that is not a
    plain success, with its reason.

.DESCRIPTION
    Reviewable without reading 88 directories, which is the requirement. The
    processed captures are counted and not listed: a successful scrub says
    nothing an operator needs to act on, and 83 success lines would bury the
    five that do.

    IT RETURNS TEXT RATHER THAN WRITING IT. A module function's Write-Information
    is subject to the MODULE's preference, not the calling script's, so a
    summary written from in here would silently vanish for exactly the caller
    that asked for it. Handing the lines back lets each entry point emit them in
    its own scope, under its own -InformationAction, and lets a test assert on
    them without capturing a stream.

    NOT ONE CAPTURED VALUE APPEARS. Host, stamp, class, outcome, reason -- no
    URL, no header, no entry. Nothing in this module opens a HAR.
#>
function Get-HarBatchSummaryLines {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Results,
        [Parameter(Mandatory)][string]$Stage
    )

    # Each @() is load-bearing: a scriptblock that filters everything out emits
    # NOTHING rather than an empty array, so an unwrapped result is $null and
    # `$null.Count` interpolates as blank -- a summary that says "  processed"
    # where it means "0 processed".
    $by = { param($o) @($Results | Where-Object { $_.Outcome -eq $o }) }
    $processed = @(& $by $script:OutcomeProcessed)
    $skipped   = @(& $by $script:OutcomeSkipped)
    $declined  = @(& $by $script:OutcomeDeclined)
    $failed    = @(& $by $script:OutcomeFailed)

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("$Stage over $($Results.Count) capture(s): $($processed.Count) processed, " +
        "$($skipped.Count) skipped, $($declined.Count) declined, $($failed.Count) failed")

    foreach ($group in @(
            @{ Name = 'skipped';  Items = $skipped },
            @{ Name = 'declined'; Items = $declined },
            @{ Name = 'failed';   Items = $failed })) {
        if (-not $group.Items.Count) { continue }
        $lines.Add("  $($group.Name):")
        foreach ($item in $group.Items) { $lines.Add("    $($item.Label) -- $($item.Reason)") }
    }

    # Advisory and other noteworthy successes still carry a reason, and it is
    # the one kind of success worth a line: exit 4 / exit 7 mean the artifact
    # was kept while the gate had something to say about it.
    $noted = @($processed | Where-Object { $_.Reason })
    if ($noted.Count) {
        $lines.Add('  processed with findings:')
        foreach ($item in $noted) { $lines.Add("    $($item.Label) -- $($item.Reason)") }
    }

    return $lines.ToArray()
}

<#
.SYNOPSIS
    A destination name nothing already occupies.

.DESCRIPTION
    Nothing under .har-captures/ is overwritten, quarantined artifacts
    included: a second rejection of the same capture is a second thing to
    triage, not a replacement for the first. Mirrors what capture-har.js's
    `freeName` does for the same file on the same path.
#>
function Get-HarFreeName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string]$Stem,
        [Parameter(Mandatory)][string]$Extension
    )

    $candidate = Join-Path $Directory "$Stem$Extension"
    $n = 1
    while (Test-Path -LiteralPath $candidate) {
        $n++
        $candidate = Join-Path $Directory "$Stem-$n$Extension"
    }
    return $candidate
}

Export-ModuleMember -Function Get-HarCaptureInventory, Invoke-HarCaptureBatch,
    Get-HarBatchSummaryLines, Get-HarCaptureLabel, Get-HarFreeName
