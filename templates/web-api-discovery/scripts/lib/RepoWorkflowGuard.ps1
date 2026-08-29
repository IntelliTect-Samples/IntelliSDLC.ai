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
