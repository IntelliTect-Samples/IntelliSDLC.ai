#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Where a script's output is allowed to land, and when to say so (issue #300).

.DESCRIPTION
    Dot-source this from every output-producing script:

        . (Join-Path $PSScriptRoot '..' 'lib' 'RepoWorkflowGuard.ps1')

    Output resolved against the WORKING DIRECTORY is correct outside a
    repository and wrong inside one. Run from a project's root checkout while
    sitting on the protected branch, an output folder is created at the repo
    root on `main`, where the repo's own rules forbid committing it -- and
    nothing notices, so the violation stays invisible until somebody happens to
    run `git status`.

    THE INVARIANT THIS FILE EXISTS TO SERVE:

        The guard runs BEFORE any work begins, never after. Nothing that cost
        the operator effort may exist when it fires.

    That is what makes warn-and-proceed safe. Launching a recorder is cheap, so
    a warning seconds in costs nothing to act on. A guard placed downstream
    would instead be deciding whether to discard a recording the operator spent
    minutes producing -- a worse outcome than the misplacement it prevents.

    It is SHARED rather than reimplemented per script on purpose. Bespoke
    per-script placement logic is how the defect arrived. repo-workflow-guard.js
    is its Node twin; capture-output-placement.Tests.ps1 drives both over one
    table of repository shapes and fails if they ever disagree.

    ON INTERACTIVITY, which is where the obvious implementation breaks.
    `$PSCmdlet.ShouldContinue()` -- the natural way to say "warn, allow
    continue" -- THROWS in a non-interactive session:

        PowerShell is in NonInteractive mode. Read and Prompt functionality is
        not available.

    So the naive version turns an advisory into a hard stop with a confusing
    error. The intuitive detector lies too: measured inside an agent's session,
    [Environment]::UserInteractive returns True and $Host.Name is ConsoleHost,
    identical to a real console. [Console]::IsInputRedirected is the probe that
    tells the truth, and the prompt is wrapped in try/catch anyway so that a
    throw is treated as "non-interactive", never as failure.
#>

# NO Set-StrictMode here, deliberately. This file is DOT-SOURCED, so anything it
# sets runs in the CALLER's scope and would silently change the host script's
# semantics for everything after the dot-source line. A library that
# reconfigures its host is a worse bug than the one it was written to fix.

# Every probe is a plain git question with a plain git answer. There are no
# heuristics here by design: each of the three has a definite answer, so there
# is nothing to guess and nothing to tune.
function Invoke-GuardGit {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    # Not a repo, no such ref, no such config -- all answers, not faults. The
    # caller tells them apart by which probe went quiet.
    $out = & git -C $Path @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    if ($null -eq $out) { return $null }
    return ($out | Select-Object -First 1).Trim()
}

function Resolve-GuardPath {
    param([string]$Path)
    if (-not $Path) { return $null }
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.ProviderPath }
    return [IO.Path]::GetFullPath($Path)
}

<#
.SYNOPSIS
    Probe 1 of 3 -- the repository root, or $null when there is not one.

.DESCRIPTION
    Outside a repository the working-directory default is CORRECT, and $null is
    what keeps standalone behavior byte-for-byte unchanged.
#>
function Get-RepoTopLevel {
    [CmdletBinding()]
    param([string]$Path = '.')

    $top = Invoke-GuardGit -Path $Path -Arguments @('rev-parse', '--show-toplevel')
    if (-not $top) { return $null }
    return Resolve-GuardPath $top
}

<#
.SYNOPSIS
    Everything the three git probes know about a checkout.

.DESCRIPTION
    Probe 2 -- primary checkout vs. worktree. In a linked worktree `--git-dir`
    points at `.git/worktrees/<name>` while `--git-common-dir` points at the
    shared `.git`; in the primary checkout they are the same directory. This is
    deliberately the same test the repository's own pre-commit hook uses: a
    guard that disagreed with the hook about what counts as a worktree would be
    worse than no guard at all.

    Probe 3 -- the protected branch, DISCOVERED from origin/HEAD rather than
    hardcoded, so a repo whose trunk is `trunk` or `develop` is served
    correctly. When origin/HEAD is absent (no remote, or a clone that never had
    one set) it falls back to the conventional trunk names instead of disabling
    the guard. That asymmetry is deliberate: a spurious warning costs one
    ignored line and the run proceeds regardless, while a missed warning is
    exactly the defect being fixed.

    Then: does the repository DECLARE a no-work-on-the-protected-branch rule?
    Asking matters because warning in a repo with no such rule is noise, and
    noise is how a warning gets trained out of an operator's attention.

      1. `core.hooksPath` resolving to a TRACKED directory containing a
         `pre-commit`. Self-declaring, needs no new configuration, and it is the
         convention's own artifact. Tracked is the load-bearing half -- an
         untracked hooks directory is one developer's local preference and
         cannot speak for the repository.
      2. An explicit `sdlc.protectedBranchWorkflow` boolean, for repos relying
         on server-side branch protection that ship no hooks. Set false it is
         also the opt-out, so it is consulted first.

    Deliberately NOT `git hook run pre-commit`: `pre-commit` semantics are not
    `pre-write` and hooks may have side effects. Nor is the hook's CONTENT
    grepped -- matching on what a shell script says is the sort of heuristic
    this design set out to avoid, and it would break the moment a repo phrased
    its own rule differently.

.OUTPUTS
    PSCustomObject with InsideRepo, TopLevel, PrimaryCheckout, CurrentBranch,
    ProtectedBranch, DeclaresRule, RuleSource and ShouldWarn.
#>
function Get-CheckoutPlacement {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([string]$Path = '.')

    $fallbackTrunks = @('main', 'master')
    $topLevel = Get-RepoTopLevel -Path $Path

    if (-not $topLevel) {
        return [pscustomobject]@{
            InsideRepo      = $false
            TopLevel        = $null
            PrimaryCheckout = $false
            CurrentBranch   = $null
            ProtectedBranch = $null
            DeclaresRule    = $false
            RuleSource      = $null
            ShouldWarn      = $false
        }
    }

    $gitDir = Invoke-GuardGit -Path $Path -Arguments @('rev-parse', '--absolute-git-dir')
    $commonDir = Invoke-GuardGit -Path $Path -Arguments @(
        'rev-parse', '--path-format=absolute', '--git-common-dir')
    $primary = [bool]($gitDir -and $commonDir -and
        (Resolve-GuardPath $gitDir) -eq (Resolve-GuardPath $commonDir))

    # A detached HEAD reports "HEAD", which is not a branch name and so can
    # never equal the protected branch. That is the right answer -- nothing is
    # being committed to the protected branch from a detached head either.
    $branch = Invoke-GuardGit -Path $Path -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
    if ($branch -eq 'HEAD') { $branch = $null }

    $originHead = Invoke-GuardGit -Path $Path -Arguments @(
        'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    $protected = if ($originHead) { $originHead -replace '^origin/', '' }
    elseif ($branch -and $fallbackTrunks -contains $branch) { $branch }
    else { $fallbackTrunks[0] }

    $ruleSource = $null
    $declared = Invoke-GuardGit -Path $Path -Arguments @(
        'config', '--get', 'sdlc.protectedBranchWorkflow')
    if ($declared) {
        if ($declared -match '^(true|yes|on|1)$') { $ruleSource = 'config' }
    }
    else {
        $hooksPath = Invoke-GuardGit -Path $Path -Arguments @('config', '--get', 'core.hooksPath')
        if ($hooksPath) {
            $resolvedHooks = if ([IO.Path]::IsPathRooted($hooksPath)) { $hooksPath }
            else { Join-Path $topLevel $hooksPath }
            $preCommit = Join-Path $resolvedHooks 'pre-commit'
            if (Test-Path -LiteralPath $preCommit) {
                $tracked = Invoke-GuardGit -Path $topLevel -Arguments @(
                    'ls-files', '--error-unmatch', '--', $preCommit)
                if ($tracked) { $ruleSource = 'hooksPath' }
            }
        }
    }

    [pscustomobject]@{
        InsideRepo      = $true
        TopLevel        = $topLevel
        PrimaryCheckout = $primary
        CurrentBranch   = $branch
        ProtectedBranch = $protected
        DeclaresRule    = ($null -ne $ruleSource)
        RuleSource      = $ruleSource
        ShouldWarn      = [bool]($primary -and $ruleSource -and $branch -and
            $branch -eq $protected)
    }
}

<#
.SYNOPSIS
    Where DEFAULT output goes -- the repo root inside a repo, the working
    directory outside one.

.DESCRIPTION
    The default only. An explicitly supplied relative path keeps resolving
    against the working directory, because a path the operator typed has to mean
    what they typed.

    Anchoring on its own does NOT fix the problem this file is named for: a
    worktree has its own toplevel, so output still lands wherever the operator
    happens to be. It makes placement PREDICTABLE, not correct. The warning is
    what addresses correctness and is still required.
#>
function Get-DefaultOutputRoot {
    [CmdletBinding()]
    [OutputType([string])]
    param([string]$Path = '.')

    $top = Get-RepoTopLevel -Path $Path
    if ($top) { return $top }
    return Resolve-GuardPath $Path
}

function Get-GuardWorktreeCommand {
    param([Parameter(Mandatory)][psobject]$Placement)
    $branch = if ($Placement.ProtectedBranch) { $Placement.ProtectedBranch } else { 'main' }
    return "git worktree add .worktrees/<name> -b <type>/<issue#>-<name> $branch"
}

<#
.SYNOPSIS
    The advisory itself -- warn, then proceed. Never a hard failure.

.DESCRIPTION
    Returns $true to proceed and $false only when an interactive operator
    explicitly declined. A non-interactive caller ALWAYS gets $true: an agent
    sees the warning on the warning stream and will typically cancel and create
    a worktree, and if it does not, the capture still completes and nothing is
    lost.

    The message carries four things or it is not actionable -- what was
    detected, why it matters, the exact command to run instead, and the fact
    that ignoring it is safe. Omitting the last would make an advisory read like
    a failure.

.OUTPUTS
    System.Boolean -- $true to proceed.
#>
function Assert-NotPrimaryCheckoutOnProtectedBranch {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [string]$Path = '.',
        [psobject]$Placement
    )

    if (-not $Placement) { $Placement = Get-CheckoutPlacement -Path $Path }
    if (-not $Placement.ShouldWarn) { return $true }

    $message = @(
        "This is the primary checkout on the protected branch ($($Placement.ProtectedBranch))."
        "Output will land in $($Placement.TopLevel), where commits are blocked,"
        'so the artifacts will strand there until somebody notices a dirty tree.'
        'To place them somewhere committable, cancel and run:'
        "    $(Get-GuardWorktreeCommand -Placement $Placement)"
        'Continuing anyway is safe -- nothing is discarded.'
    ) -join [Environment]::NewLine

    # UserInteractive is NOT consulted: it returns True inside an agent session,
    # which is exactly the case that must not be prompted.
    $interactive = -not [Console]::IsInputRedirected -and
        -not ([Environment]::GetCommandLineArgs() -contains '-NonInteractive')

    if ($interactive) {
        try {
            # Defaults to yes, so leaning on ENTER continues -- the safe
            # direction, since the warning fires before anything exists to lose.
            return $PSCmdlet.ShouldContinue(
                "$message$([Environment]::NewLine)Continue?", 'Output placement')
        }
        catch {
            # ShouldContinue throws under -NonInteractive. A throw here means
            # "not actually interactive", never "stop": treating it as failure
            # is what turns this advisory into the confusing hard error the
            # issue documents.
            Write-Verbose "ShouldContinue unavailable ($($_.Exception.Message)); warning instead."
        }
    }

    Write-Warning $message
    return $true
}

<#
.SYNOPSIS
    The closing notice: what was written, and the one command that relocates it.

.DESCRIPTION
    The other half of what makes "proceed" genuinely safe rather than merely
    deferred. Having declined to discard anything, the run owes the operator the
    exact paths it wrote and a single move to fix them. Raw captures are already
    confined to a gitignored directory, so the polluting set is small and
    precisely known.

    Returns $null when the guard never fired, so callers can emit it
    unconditionally.

    NOT called by Invoke-HarCapture, and that is deliberate rather than an
    oversight: in the capture pipeline the RECORDER emits the closing notice,
    because it is the process that actually writes the files and prints it
    in-process, where a dying parent cannot take it away. This function is here
    for the next output-producing PowerShell script that has no such child
    process to delegate to -- which is the whole reason this file is a shared
    library. Reintroducing this logic per script is how the defect arrived.
#>
function Get-RelocationNotice {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [psobject]$Placement,
        [string[]]$WrittenPath
    )

    if (-not $Placement -or -not $Placement.ShouldWarn) { return $null }
    $paths = @($WrittenPath | Where-Object { $_ })
    if (-not $paths.Count) { return $null }

    $lines = @("Written to the primary checkout on $($Placement.ProtectedBranch):")
    foreach ($p in $paths) { $lines += "    $p" }
    $lines += 'To move them somewhere committable:'
    $lines += "    $(Get-GuardWorktreeCommand -Placement $Placement)"
    $lines += '    mv ' + (($paths | ForEach-Object { """$_""" }) -join ' ') + ' .worktrees/<name>/'
    return ($lines -join [Environment]::NewLine)
}

# ---------------------------------------------------------------------------
# THE DESTINATION QUESTION (#471)
#
# Everything above answers "where is the operator standing". That was the whole
# question while capture wrote its default output into the work tree root. It
# is not the question any more, and #471 is what happened when it kept being
# asked: capture warned on runs that could not strand anything, the operator
# learned to click past it, and the four steps that DO write committable output
# -- the reference extract, the api document, the standalone scrub and the
# standalone catalogue -- said nothing at all, because the guard had never been
# wired into them.
#
# So the guard gains the second half: will THIS write land somewhere that shows
# up as untracked? Location plus destination, and both must be true.
# ---------------------------------------------------------------------------

$script:GuardIgnored = 'ignored'
$script:GuardNotIgnored = 'not-ignored'
$script:GuardOutsideWorkTree = 'outside-work-tree'
$script:GuardUnverifiable = 'unverifiable'


# The environment the ignore probes run in: everything except what can tell git
# where to find configuration.
#
# THIS MIRRORS probeEnv() IN subs-destination.js, and exists for the reason
# given there. `GIT_CONFIG_COUNT` with a `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
# pair injects `core.excludesFile`, so `check-ignore` calls a path ignored that
# the repository does not protect; `GIT_DIR` and `GIT_WORK_TREE` redirect the
# answer to another repository entirely. Without this, the PowerShell half of
# the guard would answer "ignored" where the Node half answers "not ignored" --
# two implementations of one rule disagreeing, which is the failure the shared
# library exists to prevent.
#
# The whole `GIT_*` namespace goes rather than the variables known to be
# dangerous today, because a blocklist is the wrong shape and the next release
# may add a third way. The home variables are OVERRIDDEN rather than removed:
# a home that does not exist is one nothing can be planted in, and on Windows
# clearing HOMEDRIVE/HOMEPATH is not reliably honoured.
#
# System config stays honoured. Once `GIT_*` is stripped its location is fixed
# rather than environment-named, and an admin-installed rule is a real fact
# about the machine.
$script:GuardEnvSaved = $null

function Push-GuardProbeEnvironment {
    [CmdletBinding()]
    param()

    $saved = @{}
    $noHome = Join-Path ([IO.Path]::GetTempPath()) ("guard-no-home-" + [guid]::NewGuid().ToString('N'))

    foreach ($entry in (Get-ChildItem Env: | Where-Object { $_.Name -match '^(?i)GIT_' })) {
        $saved[$entry.Name] = $entry.Value
        Remove-Item "Env:$($entry.Name)" -ErrorAction SilentlyContinue
    }
    foreach ($name in @('HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH')) {
        if (-not $saved.ContainsKey($name)) {
            $saved[$name] = (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value
        }
    }

    $env:HOME = $noHome
    $env:XDG_CONFIG_HOME = $noHome
    $env:USERPROFILE = $noHome
    $env:HOMEDRIVE = $noHome.Substring(0, 2)
    $env:HOMEPATH = $noHome.Substring(2)
    # A second way of saying the same thing, for git versions that honour it,
    # without depending on how home discovery happens to be implemented.
    $env:GIT_CONFIG_GLOBAL = Join-Path $noHome 'gitconfig'

    $script:GuardEnvSaved = $saved
}

function Pop-GuardProbeEnvironment {
    [CmdletBinding()]
    param()

    if ($null -eq $script:GuardEnvSaved) { return }
    # Everything touched is restored, including the variables that were ABSENT
    # before -- a $null saved value means "there was none", and leaving our
    # placeholder behind would change git's behaviour for the rest of the
    # session, which is exactly the class of bug this function guards against.
    foreach ($name in @('HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOMEDRIVE',
            'HOMEPATH', 'GIT_CONFIG_GLOBAL')) {
        if ($script:GuardEnvSaved.ContainsKey($name) -and $script:GuardEnvSaved[$name]) {
            Set-Item "Env:$name" -Value $script:GuardEnvSaved[$name]
        }
        else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    }
    foreach ($name in $script:GuardEnvSaved.Keys) {
        if ($name -match '^(?i)GIT_' -and $script:GuardEnvSaved[$name]) {
            Set-Item "Env:$name" -Value $script:GuardEnvSaved[$name]
        }
    }
    $script:GuardEnvSaved = $null
}

<#
.SYNOPSIS
    Whether a path would show up as untracked: ignored, not-ignored,
    outside-work-tree, or unverifiable.

.DESCRIPTION
    The same four answers, spelled the same way, as classifyDestination() in
    subs-destination.js -- capture-output-placement.Tests.ps1 drives both over
    one table and fails if they ever disagree.

    Asked about the FILE, not its directory, because a consumer's .gitignore
    covers these artifacts by name at any depth as well as by directory, and
    asking about the directory would miss that.

    The path need not exist yet -- that is the point, the guard runs before the
    write -- so the probe is made from the nearest ancestor that does.

    UNVERIFIABLE is not folded into "ignored". git declining to answer is not
    the same as git answering no, and treating them alike would make the warning
    vanish in exactly the case where nobody can tell whether it was needed.
#>
function Get-DestinationIgnoreStatus {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Destination)

    $full = Resolve-GuardPath $Destination
    if (-not $full) { return $script:GuardUnverifiable }

    $probe = $full
    while ($probe -and -not (Test-Path -LiteralPath $probe -PathType Container)) {
        $parent = Split-Path -Parent $probe
        if ($parent -eq $probe) { break }
        $probe = $parent
    }
    if (-not $probe -or -not (Test-Path -LiteralPath $probe -PathType Container)) {
        return $script:GuardUnverifiable
    }

    # "not a repository" is an ANSWER, and git delivers it as a non-zero exit --
    # the same shape Invoke-GuardGit collapses to $null for probes where absence
    # is the answer. Here the two must stay apart: git saying no means
    # outside-work-tree, and only git failing to RUN is unverifiable.
    #
    # Both probes go through git directly rather than Invoke-GuardGit, because
    # both need the exit CODE and not merely "did it work" -- check-ignore
    # answers 0 / 1 / 2 and collapsing non-zero would fold "not ignored" into
    # "cannot tell". Which is why they are wrapped: a missing git raises a
    # terminating CommandNotFoundException rather than setting $LASTEXITCODE, so
    # without the catch the unverifiable answer would be unreachable and the
    # caller would get an exception where it expected one of four strings.
    try {
        Push-GuardProbeEnvironment
        try {
            $inTree = & git -C $probe rev-parse --is-inside-work-tree 2>$null
            if ($LASTEXITCODE -ne 0 -or "$inTree".Trim() -ne 'true') {
                return $script:GuardOutsideWorkTree
            }

            & git -C $probe check-ignore -q -- $full 2>$null
            switch ($LASTEXITCODE) {
                0 { return $script:GuardIgnored }
                1 { return $script:GuardNotIgnored }
                default { return $script:GuardUnverifiable }
            }
        }
        finally { Pop-GuardProbeEnvironment }
    }
    catch {
        # A missing git raises a TERMINATING CommandNotFoundException rather
        # than setting $LASTEXITCODE -- verified, not assumed -- so without this
        # the caller would get an exception where it expected one of four
        # strings, and the unverifiable answer would be unreachable.
        Write-Verbose "git unavailable for $full ($($_.Exception.Message)); treating as unverifiable."
        return $script:GuardUnverifiable
    }
}

<#
.SYNOPSIS
    $Full expressed relative to $Base, or $null when it does not sit under it.

.DESCRIPTION
    Shared by the two callers that had grown the same prefix comparison, and
    both had the same gap: requiring a separator AFTER the base means a path
    that IS the base compares as "outside it", so a destination naming the
    checkout root was reported as somewhere else entirely. The equality case is
    the empty relative path, which is a real answer and not a miss.

    Case-insensitive because the platforms this runs on are, and trailing
    separators are trimmed first so `C:\repo` and `C:\repo\` behave alike.
#>
function Get-GuardRelativePath {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Full,
        [Parameter(Mandatory)][AllowNull()][string]$Base
    )

    if (-not $Base) { return $null }
    $sep = [IO.Path]::DirectorySeparatorChar
    $prefix = $Base.TrimEnd($sep, [IO.Path]::AltDirectorySeparatorChar)
    $trimmed = $Full.TrimEnd($sep, [IO.Path]::AltDirectorySeparatorChar)

    if ($trimmed.Equals($prefix, [StringComparison]::OrdinalIgnoreCase)) { return '' }
    if ($trimmed.StartsWith($prefix + $sep, [StringComparison]::OrdinalIgnoreCase)) {
        return $trimmed.Substring($prefix.Length + 1)
    }
    return $null
}

<#
.SYNOPSIS
    How to NAME a path inside a suggested command. The PowerShell twin of
    commandPath in repo-workflow-guard.js.

.DESCRIPTION
    A suggestion built by gluing a prefix onto whatever the operator typed
    breaks the moment they typed an absolute path -- `.worktrees/<name>/C:\x\y`
    is not a command anybody can paste. The relative form is used while it stays
    inside the tree and the absolute one otherwise, and separators are
    normalised to `/` so the line does not read like a typo.
#>
function Get-GuardCommandPath {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Target,
        [string]$From
    )

    $full = Resolve-GuardPath $Target
    if (-not $full) { return $Target }
    $base = Resolve-GuardPath ($From ? $From : (Get-Location).ProviderPath)
    if (-not $base) { return ($full -replace '\\', '/') }

    $relative = Get-GuardRelativePath -Full $full -Base $base
    if ($null -ne $relative) { return ($relative -replace '\\', '/') }
    return ($full -replace '\\', '/')
}

<#
.SYNOPSIS
    Will writing to $Destination strand committable output on the protected
    branch? Returns the placement to warn about, or $null.

.DESCRIPTION
    The PowerShell twin of placementForRun in capture-har.js. Both halves must
    hold: a primary checkout on the protected branch of a repo that declares the
    rule, AND a destination that will show as untracked there.
#>
function Get-StrandingPlacement {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][string]$Destination,
        [psobject]$Placement,
        [string]$Path = '.'
    )

    if (-not $Placement) { $Placement = Get-CheckoutPlacement -Path $Path }
    if (-not $Placement.ShouldWarn) { return $null }

    $status = Get-DestinationIgnoreStatus -Destination $Destination
    if ($status -eq $script:GuardIgnored -or $status -eq $script:GuardOutsideWorkTree) {
        return $null
    }
    return $Placement
}

<#
.SYNOPSIS
    The advisory for a step that is about to write committable output, with the
    commands that fix it.

.DESCRIPTION
    A pre-write guard cannot end in `mv` the way the capture epilogue does --
    nothing has been written yet. The actionable fix is the pair: make a
    worktree, then run this same command with its output landing inside it. Both
    are printed filled in, because a command an operator has to reconstruct from
    a description is one they will skip.

    $ReRunCommand is supplied by the caller rather than reconstructed here. Only
    the caller knows its own argument vector, and a library guessing at it would
    print something subtly wrong -- which is worse than printing nothing.
#>
function Get-StrandingNotice {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][psobject]$Placement,
        [Parameter(Mandatory)][string]$Destination,
        [string]$ReRunCommand,
        [string]$WorktreeName = '<name>'
    )

    $branch = if ($Placement.ProtectedBranch) { $Placement.ProtectedBranch } else { 'main' }
    $lines = @(
        "This is the primary checkout on the protected branch ($branch)."
        "About to write $Destination, which is not gitignored there,"
        'so the output will show as untracked where commits are blocked.'
        'To put it somewhere committable:'
        "    git worktree add .worktrees/$WorktreeName -b <type>/<issue#>-$WorktreeName $branch"
    )
    if ($ReRunCommand) {
        $lines += '    ' + $ReRunCommand
    }
    $lines += 'Continuing anyway is safe -- nothing is discarded.'
    return ($lines -join [Environment]::NewLine)
}

<#
.SYNOPSIS
    Warn before writing committable output to the protected branch, and offer to
    create the worktree that fixes it. Returns where to write.

.DESCRIPTION
    Returns a Proceed/Destination pair: Proceed $false only when an interactive
    operator declined outright, and Destination the possibly-retargeted path.

    THE OFFER IS INTERACTIVE-ONLY, and not because prompting an agent would be
    rude -- ShouldContinue THROWS under -NonInteractive, and
    [Environment]::UserInteractive reports True inside an agent session, so
    [Console]::IsInputRedirected is the probe and the call is wrapped anyway.
    A non-interactive caller is given the commands and proceeds, unchanged.

    Retargeting only happens for a destination INSIDE the checkout. One pointing
    somewhere else was not describing a path relative to the work tree, and
    rewriting it against a worktree root would move it somewhere the operator
    never asked for.
#>
function Assert-DestinationCommittable {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][string]$Destination,
        [string]$ReRunCommand,
        [string]$WorktreeName,
        [string]$Path = '.',
        [psobject]$Placement
    )

    $proceed = [pscustomobject]@{ Proceed = $true; Destination = $Destination; Relocated = $false }

    $stranding = Get-StrandingPlacement -Destination $Destination -Placement $Placement -Path $Path
    if (-not $stranding) { return $proceed }

    if (-not $WorktreeName) {
        # The file's stem, not its name: the suggestion becomes both a directory
        # and a branch, and `.worktrees/scrubbed.har` on `chore/scrubbed.har`
        # reads like a mistake even though git would accept it.
        $leaf = [IO.Path]::GetFileNameWithoutExtension((Resolve-GuardPath $Destination))
        $WorktreeName = if ($leaf) { ($leaf -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant() } else { 'output' }
    }

    $message = Get-StrandingNotice -Placement $stranding -Destination $Destination `
        -ReRunCommand $ReRunCommand -WorktreeName $WorktreeName

    $interactive = -not [Console]::IsInputRedirected -and
        -not ([Environment]::GetCommandLineArgs() -contains '-NonInteractive')

    if ($interactive) {
        try {
            $create = $PSCmdlet.ShouldContinue(
                "$message$([Environment]::NewLine)Create the worktree now and write there instead?",
                'Output placement')
            if ($create) {
                $made = New-GuardWorktree -Placement $stranding -Name $WorktreeName -Destination $Destination
                if ($made) { return $made }
                # Creating it failed and said why. Fall through: the step still
                # runs, because refusing here would discard nothing but the
                # operator's time.
            }
            return $proceed
        }
        catch {
            Write-Verbose "ShouldContinue unavailable ($($_.Exception.Message)); warning instead."
        }
    }

    Write-Warning $message
    return $proceed
}

<#
.SYNOPSIS
    Create `.worktrees/<name>` off the protected branch and retarget the
    destination into it.

.DESCRIPTION
    Returns the same Proceed/Destination shape as its caller, or $null when the
    worktree could not be made -- a name already taken, a branch that exists, a
    detached state. Failure is reported and never thrown: the guard is advisory,
    and a step that would have run without the offer must still run when the
    offer does not work out.
#>
function New-GuardWorktree {
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][psobject]$Placement,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Destination
    )

    $top = $Placement.TopLevel
    $branchBase = if ($Placement.ProtectedBranch) { $Placement.ProtectedBranch } else { 'main' }
    $worktree = Join-Path (Join-Path $top '.worktrees') $Name
    $branch = "chore/$Name"

    if (Test-Path -LiteralPath $worktree) {
        Write-Warning "$worktree already exists -- writing to the original destination instead."
        return $null
    }
    if (-not $PSCmdlet.ShouldProcess($worktree, 'git worktree add')) { return $null }

    & git -C $top worktree add $worktree -b $branch $branchBase 2>&1 | Write-Verbose
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $worktree)) {
        Write-Warning "could not create $worktree (git exited $LASTEXITCODE) -- writing to the original destination instead."
        return $null
    }

    # Only a destination inside the checkout can be re-rooted; see the caller.
    $full = Resolve-GuardPath $Destination
    $relative = Get-GuardRelativePath -Full $full -Base $top

    if ($null -eq $relative) {
        Write-Warning "created $worktree, but $Destination is outside $top -- writing to the original destination."
        return [pscustomobject]@{ Proceed = $true; Destination = $Destination; Relocated = $false }
    }

    # '' means the destination IS the checkout root, so the worktree root is
    # where it moves to. Join-Path with '' would throw.
    $moved = if ($relative) { Join-Path $worktree $relative } else { $worktree }
    Write-Information "Created $worktree on $branch. Writing to $moved." -InformationAction Continue
    return [pscustomobject]@{ Proceed = $true; Destination = $moved; Relocated = $true }
}
