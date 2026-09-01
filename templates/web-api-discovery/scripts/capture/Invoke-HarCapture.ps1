#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Record a browser session, scrub it, and catalogue it -- one command.

.DESCRIPTION
    PowerShell front door for capture-har.js. Opens a browser on a dedicated
    capture profile, records every request, then scrubs, verifies, digests and
    catalogues what it recorded.

    The operator's surface is a URL and a sentence saying what the recording
    is for:

        Invoke-HarCapture https://example.com -Describe 'create, then delete, a post'

    Browse, perform the operations worth documenting -- including the failure
    paths, which are frequently the highest-value entries because they
    establish the site's real error taxonomy -- then press ENTER in this
    terminal. Closing the browser window does the same thing; so does
    Stop-HarRecording from another process. Ctrl+C asks whether you meant to
    finish or to cancel.

    HOW MUCH IT SAYS. By default the console names the site, how to end the
    recording, and the artifacts the run produced. `-Verbose` adds the resolved
    paths, the capture profile, the CDP endpoint and the per-phase detail --
    including the recorder's own, because the level is forwarded to it. Nothing
    a failure needs to report is ever gated by the level: a warning, a
    leak-gate rejection and an error are printed at every level.

    `-InformationAction SilentlyContinue` silences the status lines without
    silencing the warnings.

    `Invoke-`, not `Start-`, because the command no longer merely starts
    something: by the time it returns, the capture has been scrubbed and
    verified and the catalogue exists.

    TWO DIRECTORIES, and the difference is the whole safety story:

      .har-captures/   the raw capture. Carries live session cookies, is
                       gitignored, and CANNOT be redirected -- there is no
                       option for it, so an unignored credential-bearing
                       capture is not reachable by any argument.

                       WHICH .har-captures: the one in the repository's MAIN
                       working tree, never a linked worktree's. A worktree is
                       disposable by design and `git worktree remove` deletes a
                       gitignored capture outright with nothing to prompt
                       about; a raw is the one artifact that cannot be
                       regenerated. Outside a repository it is relative to the
                       current directory, as before. The recorder prints the
                       resolved path as it starts.
      -OutputPath      scrubbed, verified artifacts only: the per-action
                       reference HARs, the session digest, and the catalogue.

    Both are keyed on the captured site's HOST, so captures against different
    sites never overwrite each other:

      .har-captures/app.example.com/<timestamp>/raw.har
      ./app.example.com/{scrubbed.har,digest.json,catalogue.json}

    The host alone, never the full URL: a magic-link or password-reset URL
    carries its token in the path or the query, and the second of these
    directories is the committable one.

.PARAMETER Uri
    The site to open. Positional, so the parameter name is optional.

.PARAMETER OutputPath
    The parent of the host-named folder the scrubbed artifacts and the
    catalogue are written to. Passing -OutputPath D:\refs writes
    D:\refs\app.example.com\ instead -- the host folder is always appended, and
    a relative path resolves against the current directory. The raw capture
    never goes here.

    THE DEFAULT is the repository root when the working directory is inside a
    repository, and the current directory when it is not. It used to be the
    current directory unconditionally, which was right outside a repo and wrong
    inside one: run from a checkout's subdirectory, artifacts appeared wherever
    the operator happened to be standing.

    Anchoring alone does not make the placement CORRECT -- a worktree has its
    own root -- only predictable. Recording from the primary checkout on the
    protected branch additionally warns before anything is recorded; see
    ../lib/RepoWorkflowGuard.ps1.

.PARAMETER Describe
    REQUIRED. What this recording is for, in your own words. Omitting it is a
    terminating error, not a prompt: this front door and capture-har.js refuse
    on identical terms, so a person recording by hand and an agent driving the
    same script hit the same wall in the same way. It helps the
    cataloguing step segment the session into actions, but that is the smaller
    half of its job.

    THE CAPTURE STORE IS SHARED AND APPEND-ONLY, and its directory names are
    capture START times while session.json's mtime is when post-processing
    FINISHED -- so with several sessions recording at once neither orders
    reliably, and a time window wide enough to hold your runs holds other
    people's too. The host directory groups by site, not by intent. In that
    setting the description is the only reliable way to tell one capture from
    another, and it is the one part of a capture that cannot be reconstructed
    afterwards: the bytes can be re-captured, what you were doing cannot.

    It is never the source of action names -- those come from the traffic.

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
    Invoke-HarCapture https://example.com -Describe 'sign in, then sign out'

.EXAMPLE
    Invoke-HarCapture https://example.com -Describe 'browse the catalogue' |
        Where-Object Status -eq Observed

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

    # Required (#366), and DELIBERATELY NOT [Parameter(Mandatory)].
    #
    # Mandatory would make PowerShell PROMPT for it when a host is attached and
    # only hard-fail when one is not. That was considered and rejected: it gives
    # a human recording by hand a different failure from an agent driving the
    # same script, and #366 exists because the description is the one part of a
    # capture that cannot be reconstructed afterwards. The moment of refusal has
    # to look the same however you arrived at it -- which is also the only way
    # it can match what capture-har.js does, since the Node side has no prompt
    # to offer. So the check lives in the body, below, and terminates.
    #
    # Whitespace is empty, for the same reason it is on the Node side.
    [string]$Describe,

    [string]$Profile,

    [switch]$Isolated,

    [int]$Port = 9333
)

$ErrorActionPreference = 'Stop'

# THE REFUSAL, before anything else runs and before any host is consulted.
#
# It is a terminating error rather than a prompt so that this front door and
# `capture-har.js` fail IDENTICALLY -- same reason, same example, same
# non-zero exit -- whether a person or an agent invoked it. Nothing here reads
# $Host, $PSCmdlet.MyInvocation, or whether a TTY is attached: a refusal that
# varied by how the script was launched would be a second behaviour to reason
# about, and the one the operator would hit least often is the one that would
# rot.
if ([string]::IsNullOrWhiteSpace($Describe)) {
    # The explanation goes to stderr as its own lines, and only then does the
    # terminating error fire. Throwing the whole paragraph instead would hand it
    # to PowerShell's error renderer, which reflows it into one run-on line and
    # takes the `Try:` example -- the actionable half -- with it. Node prints
    # clean lines; so does this.
    [Console]::Error.WriteLine((@(
        'Invoke-HarCapture: refusing to record without -Describe.'
        '  A capture nobody can identify is a capture nobody can use: the store is'
        '  shared and append-only, the directory name is a START time, and several'
        '  sessions record into it at once. The description is the only part of a'
        '  capture that cannot be reconstructed afterwards -- the bytes can be'
        '  re-captured, what you were doing cannot.'
        "  Try: -Describe 'example.com: create a post with two photos, then delete it'"
    ) -join [Environment]::NewLine))
    # EXIT 2, matching capture-har.js's usage-error code exactly.
    #
    # `throw` was the first shape here and it disagreed quietly: an uncaught
    # throw exits 1, so the two doors were both non-zero -- enough for any
    # caller testing truthiness -- while still not saying the same thing. "Fail
    # identically" is the whole reason this is a hard failure rather than a
    # prompt, and a code is part of what a failure says. Refusing an invocation
    # is a usage error at either door, so both answer 2.
    exit 2
}

# The placement guard is SHARED, not reimplemented here. Bespoke per-script
# logic about where output may land is how the defect in #300 arrived, so every
# output-producing script dot-sources the one implementation.
. (Join-Path $PSScriptRoot '..' 'lib' 'RepoWorkflowGuard.ps1')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'node not found on PATH -- install Node.js >= 18 to record a capture.'
    return
}

$captureJs = Join-Path $PSScriptRoot 'capture-har.js'
if (-not (Test-Path -LiteralPath $captureJs)) {
    Write-Error "capture-har.js not found at $captureJs"
    return
}

# Status goes to the information stream, never to the pipeline: per
# powershell.instructions.md -> Output & Streams, chatter mixed into the output
# is what makes `... | ConvertTo-Json` return prose instead of data. It is also
# why there is no Write-Host here.
#
# The preference is set once rather than pinning `-InformationAction Continue`
# on every call. Pinning made the messages visible but also made them
# unsuppressable: the caller's own -InformationAction, the mechanism the
# convention points them at, did nothing. Honouring an explicit binding gives
# both -- on by default, and off when the caller says so.
if (-not $PSBoundParameters.ContainsKey('InformationAction')) {
    $InformationPreference = 'Continue'
}

# Which folder this capture's artifacts land in. Mirrors uriFolder() in
# capture-har.js -- HOST ONLY (never the path or query, which carry
# magic-link and reset tokens), periods kept, port joined with `_` because a
# dash is legal inside a hostname.
#
# Deliberately duplicated rather than shelled out to node: this script's whole
# observable contract is the arguments it hands the recorder, and a second node
# invocation would sit in the middle of that. The duplication is pinned instead
# -- har-recording.Tests.ps1 asserts this function and uriFolder() agree on a
# table of URIs, so the two cannot drift apart silently.
function Get-HarUriFolder {
    param([Parameter(Mandatory)][string]$Uri)

    $parsed = $null
    if (-not [uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$parsed)) { return $null }

    # Parsing is not enough: 'http://../evil' parses with a host of '..', and
    # file:/data:/about: URIs parse with none. Both are refused for the same
    # reasons capture-har.js refuses them -- the first would walk the capture
    # out of its directory, the second collapses every hostless capture into
    # one folder.
    $hostName = $parsed.Host
    if (-not $hostName -or $hostName -eq '.' -or $hostName -eq '..') { return $null }

    # .Host, NOT .IdnHost, is the wrong choice here: WHATWG punycodes an
    # international host and .Host does not, so a capture of a non-ASCII site
    # would be WRITTEN to xn--... and its catalogue LOOKED FOR under the
    # unicode name. .IdnHost matches the recorder, and already drops the
    # brackets from an IPv6 literal.
    $bare = $parsed.IdnHost -replace '^\[|\]$', ''

    # WHATWG folds an IPv4-mapped tail into hex groups (`::ffff:1.2.3.4` ->
    # `::ffff:102:304`); .NET keeps it dotted. Match the recorder.
    if ($bare -match '^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') {
        $hi = ([int]$Matches[2] -shl 8) -bor [int]$Matches[3]
        $lo = ([int]$Matches[4] -shl 8) -bor [int]$Matches[5]
        $bare = '{0}{1:x}:{2:x}' -f $Matches[1], $hi, $lo
    }
    $bare = $bare -replace ':', '-'

    $folder = if ($parsed.IsDefaultPort) { $bare } else { "${bare}_$($parsed.Port)" }
    $folded = $folder.ToLowerInvariant() -replace '[^a-z0-9._-]', '_'

    # Reserved Windows device names cannot be directories.
    if ($folded -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|_|$)') { return "${folded}_" }
    return $folded
}



$uriFolder = Get-HarUriFolder -Uri $Uri
if (-not $uriFolder) {
    Write-Error "cannot derive a capture folder from '$Uri' -- it must be a URL, e.g. https://example.com"
    return
}

# WHERE THE OUTPUT WILL LAND, checked here and nowhere later (#300).
#
# This sits ahead of the node invocation because the guard is only safe while
# nothing has been recorded yet. Warn a second in and cancelling costs the
# operator nothing; warn after a capture and the choice becomes "discard the
# recording you just spent minutes producing", which is worse than the
# misplacement it would prevent. Advisory, never fatal, and never moved
# downstream.
$placement = Get-CheckoutPlacement -Path '.'
if (-not (Assert-NotPrimaryCheckoutOnProtectedBranch -Placement $placement)) {
    Write-Information 'Cancelled before recording -- nothing was written.'
    return
}

# The recorder runs the same check. Telling it the guard already fired is what
# keeps an operator coming through this front door from being warned twice.
$env:HARCAPTURE_PLACEMENT_GUARD_RAN = '1'

# WHY THIS STILL HANDS THE WHOLE PIPELINE TO THE RECORDER, and does not call
# Invoke-SanitizeHar.ps1 and Invoke-HarCatalogue.ps1 in turn (#352).
#
# Re-entry was the ask, and re-entry now exists: the scrub stage has been
# re-runnable through Invoke-SanitizeHar.ps1 for some time, and the catalogue
# stage is re-runnable through Invoke-HarCatalogue.ps1 as of this change. An
# operator can enter the pipeline at either one against a capture recorded some
# other time. What was NOT done is rewriting this front door as a sequence of
# those two wrappers, because doing so loses invariants that #343 exists to
# hold, and the issue says to stop rather than lose them:
#
#   1. `capture-har.js start` records AND post-processes in one process. There
#      is no way to ask it for the recording alone, and adding one would be a
#      new command-line option -- which needs approval, not initiative.
#   2. The scrub stage inside postProcess is not "run sanitize-har, then
#      verify-scrub". It writes the candidate into the gitignored session
#      directory, promotes it to the output path by atomic rename ONLY after
#      the gate passes, and quarantines it as scrubbed.rejected.har when the
#      gate refuses. Invoke-SanitizeHar.ps1 does none of that -- it is a
#      general-purpose HAR scrubber -- so a composed front door would have to
#      write an unjudged file straight into the committable output path and
#      then clean up, which is precisely the window #343 closed.
#   3. Promotion and quarantine would then live in PowerShell, and the exit
#      3 / 4 -> 6 / 7 mapping with them. Three of the four invariants restated
#      on this side of the process boundary, drifting from the Node ones.
#
# So the composition is left undone deliberately, and the front door goes on
# delegating. If it is wanted, the honest shape is a `scrub` command on
# capture-har.js exposing postProcess's phase A whole -- another entry point to
# existing code, the same move the `catalogue` command makes -- rather than a
# PowerShell reassembly of it.
$captureArgs = @('start', '--uri', $Uri, '--port', $Port)
if ($OutputPath) { $captureArgs += @('--output-path', $OutputPath) }
$captureArgs += @('--describe', $Describe)
if ($Profile) { $captureArgs += @('--profile', $Profile) }
if ($Isolated) { $captureArgs += '--isolated' }
# -Verbose is the only verbosity switch. capture-har.js prints its own console
# output directly -- re-streaming it through PowerShell would buffer the ENTER
# prompt and the Ctrl+C question in the very terminal the operator answers --
# so the level is handed across instead of a second switch being invented.
if ($VerbosePreference -ne 'SilentlyContinue') { $captureArgs += @('--log-level', 'verbose') }

Write-Verbose "capture-har.js $($captureArgs -join ' ')"
Write-Information 'Recording. Browse, then press ENTER in the recorder terminal -- that writes the most complete HAR.'

try {
    & node $captureJs @captureArgs
    $exit = $LASTEXITCODE
}
finally {
    # Scoped to this invocation. Leaving it set would silence the recorder's own
    # warning for every later capture in the same session, including ones this
    # front door never saw.
    Remove-Item Env:HARCAPTURE_PLACEMENT_GUARD_RAN -ErrorAction SilentlyContinue
}
Write-Verbose "capture-har.js exited $exit"

# Exit codes are documented on capture-har.js. 5 means raw.har was assembled
# from the incremental log rather than recordHar -- a full capture either way,
# so it is not a failure. 6 means the recording is fine but a post-process
# phase is not, which must not be reported as success. 7 means every artifact
# was produced but the leak gate reported advisory findings -- non-zero so no
# caller reads it as clean, and handled here so the `default` arm below does
# not tell the operator no catalogue exists when one does.
switch ($exit) {
    0 { }
    5 { Write-Information 'Recording ended by closing the window; press ENTER next time for a slightly richer HAR.' }
    6 { Write-Warning 'Recorded successfully, but scrub or catalogue failed. The raw capture is intact.' }
    7 {
        # 7 is not a failure: everything was produced. The leak gate reported
        # identity findings that rest on SHAPE alone, which carries no
        # provenance -- a Luhn-valid digit run is a card, an object id, or
        # nothing. Withholding the catalogue over that is what this issue
        # exists to stop, so the run continues and the operator triages the
        # findings report the recorder just named.
        #
        # It names no location. The report USUALLY sits beside the artifact,
        # but when publishing it fails -- a locked file, a full disk -- it stays
        # in the session directory instead and the recorder says so. An arm
        # that asserted the usual place would send the operator looking for a
        # file that is not there, in exactly the case they most need to read it.
        #
        # And the loop closes without re-recording. Waiving a false positive
        # used to leave the operator with "run the capture again", which for a
        # session a human drove by hand is not a repeat of anything.
        # Invoke-HarCatalogue.ps1 re-enters at the catalogue stage instead
        # (#352); it is named here rather than implemented here.
        Write-Warning ('Recorded and catalogued, but the leak gate reported ADVISORY findings. ' +
            'The recorder printed each finding and the path to the full report -- review ' +
            'them, then waive or correct each one. To rebuild the catalogue afterwards ' +
            'without re-recording, run Invoke-HarCatalogue.ps1.')
    }
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
# The URI-named subfolder comes from the recorder itself (see $uriFolder above),
# so this path and the one the recorder wrote to cannot drift apart.
#
# The DEFAULT root is anchored the same way the recorder anchors it (#300):
# the repository root inside a repo, the working directory outside one. Both
# sides have to apply it or this script looks for a catalogue in a directory
# the recorder never wrote to. An explicit -OutputPath is left alone, resolved
# against the working directory, because a relative path the operator typed has
# to mean what they typed.
$outputRoot = if ($OutputPath) { $OutputPath } else { Get-DefaultOutputRoot -Path '.' }
$cataloguePath = Join-Path (Join-Path $outputRoot $uriFolder) 'catalogue.json'
Write-Verbose "catalogue: $cataloguePath"

# NO closing notice here, deliberately (#300). The recorder emits it, because
# the recorder is the process that actually wrote the files and prints it
# in-process. Printing it from here as well would duplicate it; printing it ONLY
# from here would make it depend on this process surviving long enough to reach
# its own epilogue -- and a notice that goes missing exactly when something went
# wrong is not a safety net. The opening warning is the reverse case and is
# owned here, because it is printed before the recorder exists.
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
        (Join-Path $PSScriptRoot 'catalogue-prompt.md'))
}

$rows
