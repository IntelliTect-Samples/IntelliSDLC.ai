<#
.SYNOPSIS
    Cleans up feature branches + worktrees after their pull requests have been
    merged or closed.

.DESCRIPTION
    Performs the post-merge/rebase cleanup sequence prescribed by the shared
    AI instruction files. Runs in one of two modes:

    TARGETED (default, when -Branch/-WorktreePath is given or the shell is
    inside a linked worktree):
      1. Move out of the target worktree (if the current shell is inside it).
      2. Unlock the worktree (if locked) and remove it.
      3. Prune any stale worktree metadata.
      4. Switch to the default branch (main) and pull latest.
      5. Delete the feature branch -- safe delete by default (-d), or force
         delete (-D) when -Force is specified (for PRs closed without merge).

    SWEEP (-Sweep or -PruneStale):
      After the targeted step (if any), also:
      * `git fetch --all --prune`  -- removes stale remote-tracking refs.
      * Delete any local branch whose upstream is gone (typical after GitHub
        squash-merges delete the PR branch). Uses -D because squash-merges
        leave the local branch "unmerged" from git's perspective.
      * Remove any worktree whose branch no longer exists.

    CAPTURE SAFETY (both modes, issue #371):
    Removing a worktree destroys its gitignored files outright -- no Recycle
    Bin, no undo -- and `git status` reports such a worktree CLEAN, because
    ignored content never appears there. Before any removal, this script
    refuses if the worktree holds raw captures (`*.har` / `session.json`)
    under a gitignored path. A capture store that is a junction or symbolic
    link does NOT block removal: its bytes live elsewhere, so dropping the
    link loses nothing. The remedy is to move the captures to the shared
    store and re-run -- there is deliberately no override switch.

    WHY A GUARD AND NOT A CHECK. The check that "found nothing" is the
    failure mode here, not the deletion. Six ordinary commands each report
    an empty result for a reason unrelated to emptiness:

      git status --porcelain   omits ignored content entirely
      ls (without -Force/-A)   hides dot-directories
      git cat-file -e <r>:.x   false-negatives on a leading-dot path
      git cherry / patch-id    unreliable across a directory rename
      an absent symbol         work can land under a different name
      git diff main..branch    counts are meaningless on a stale branch

    That is what any proxy does at the edge of what it models, so a second
    proxy is no safer than the first. For CODE the reliable question is
    behavioural -- does the target actually do the thing? For DATA there is
    no behaviour to run: the bytes exist or they do not, and the check is
    destructive if wrong. So the remedy differs by kind: test the behaviour
    for code, preserve before concluding for data. This guard is the second
    case, which is why it refuses rather than reporting.

    The script is project-agnostic: it infers the worktree path, branch name
    and repository root from git, and only acts on worktrees that live under
    the .worktrees/ directory unless -AllowOutsideWorktreesDir is passed.

.PARAMETER Branch
    Name of the feature branch to clean up (e.g. feat/42-user-auth).
    If omitted and the current working directory is inside a worktree, the
    branch checked out in that worktree is used.

.PARAMETER WorktreePath
    Explicit path to the worktree to remove. If omitted, it is resolved from
    `git worktree list` using -Branch.

.PARAMETER DefaultBranch
    Name of the branch to return to after cleanup. Default: main.

.PARAMETER Force
    Force-delete the feature branch with `git branch -D` (discards unmerged
    commits). Use for PRs that were closed without merging.

.PARAMETER KeepBranch
    Skip deletion of the local branch. Useful when only removing the worktree.

.PARAMETER SkipPull
    Do not run `git pull` after switching to the default branch.

.PARAMETER AllowOutsideWorktreesDir
    Permit removing a worktree that is not located under .worktrees/. By
    default the script refuses, to avoid destroying unrelated checkouts.

.PARAMETER Sweep
    Also run a full sweep: fetch+prune remote-tracking refs, delete local
    branches whose upstream is gone, and remove worktrees whose branch no
    longer exists. Alias: -PruneStale.

.PARAMETER DryRun
    Print the git commands that would be executed without running them.

.EXAMPLE
    ./Cleanup-Worktree.ps1
    # From inside .worktrees/42-user-auth -- cleans up that worktree+branch.

.EXAMPLE
    ./Cleanup-Worktree.ps1 -Branch feat/42-user-auth

.EXAMPLE
    ./Cleanup-Worktree.ps1 -Branch fix/99-broken -Force
    # PR closed without merge: discard the branch.

.EXAMPLE
    ./Cleanup-Worktree.ps1 -Sweep
    # Targeted cleanup (if applicable) + prune stale remotes and branches.

.EXAMPLE
    ./Cleanup-Worktree.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Branch,
    [string]$WorktreePath,
    [string]$DefaultBranch = 'main',
    [switch]$Force,
    [switch]$KeepBranch,
    [switch]$SkipPull,
    [switch]$AllowOutsideWorktreesDir,
    [Alias('PruneStale')]
    [switch]$Sweep,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$IgnoreFailure
    )
    $display = 'git ' + ($Arguments -join ' ')
    if ($DryRun) {
        Write-Host "[dry-run] $display" -ForegroundColor DarkGray
        return ''
    }
    Write-Host "> $display" -ForegroundColor DarkCyan
    $output = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $IgnoreFailure) {
        if ($output) { Write-Host ($output -join [Environment]::NewLine) }
        throw "git $($Arguments[0]) failed with exit code $LASTEXITCODE"
    }
    return ($output -join [Environment]::NewLine)
}

function Get-RepoRoot {
    $root = & git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $root) {
        throw 'Not inside a git repository.'
    }
    return (Resolve-Path $root).Path
}

function Get-CommonDir {
    $common = & git rev-parse --path-format=absolute --git-common-dir 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $common) {
        throw 'Unable to determine git common dir.'
    }
    return (Resolve-Path $common).Path
}

function Get-WorktreeList {
    $raw = & git worktree list --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'git worktree list failed.' }
    $entries = @()
    $current = $null
    foreach ($line in ($raw -split "`r?`n")) {
        if ($line -match '^worktree (.+)$') {
            if ($current) { $entries += [pscustomobject]$current }
            $current = @{ Path = $Matches[1]; Branch = $null; Locked = $false }
        }
        elseif ($line -match '^branch refs/heads/(.+)$' -and $current) {
            $current.Branch = $Matches[1]
        }
        elseif ($line -match '^locked' -and $current) {
            $current.Locked = $true
        }
    }
    if ($current) { $entries += [pscustomobject]$current }
    return $entries
}

<#
.SYNOPSIS
    Raw capture artifacts inside a worktree that removing it would destroy.
.DESCRIPTION
    Capture stores are gitignored, so `git status --porcelain` reports the
    worktree clean while a multi-gigabyte store sits inside it. The standard
    "what would I lose?" check is structurally blind to the only thing worth
    protecting, which is how a 71 MB raw HAR was permanently destroyed
    (issue #371). This enumerates IGNORED entries instead.

    Reparse points (junction / symbolic link) count as EMPTY on purpose: the
    bytes live outside the worktree, so dropping the link loses nothing.
    Following one would both misreport a shared store as worktree-local --
    refusing every linked worktree forever -- and risk deleting through it,
    since Windows PowerShell 5.1's `Remove-Item -Recurse` follows junctions
    (pwsh 7 does not).
#>
function Get-WorktreeCaptureArtifact {
    param([Parameter(Mandatory)][string]$WorktreePath)

    if (-not (Test-Path -LiteralPath $WorktreePath)) { return @() }

    $ignored = & git -C $WorktreePath status --porcelain --ignored 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $ignored) { return @() }

    $found = @()
    foreach ($line in ($ignored -split "`r?`n")) {
        if ($line -notlike '!!*') { continue }
        $relative = $line.Substring(3).Trim().Trim('"')
        if (-not $relative) { continue }
        $item = Get-Item -LiteralPath (Join-Path $WorktreePath $relative) -Force -ErrorAction SilentlyContinue
        if (-not $item) { continue }
        # A link's target is not ours to lose -- see .DESCRIPTION.
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }

        if ($item.PSIsContainer) {
            # -Recurse does not traverse reparse points in pwsh 7, so a linked
            # store nested inside an ignored directory stays excluded too.
            $found += Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Extension -eq '.har' -or $_.Name -eq 'session.json' }
        }
        elseif ($item.Extension -eq '.har' -or $item.Name -eq 'session.json') {
            # Same filter as the container branch above. `git status --ignored`
            # reports a whole ignored DIRECTORY when the rule names one, and an
            # individual FILE when the rule names the file -- so a store ignored
            # as `.har-captures/` arrives here as a directory, while a rule
            # naming `session.json` directly arrives as a file. Checking only
            # `.har` in this branch would see a raw capture and miss the file
            # that says what the capture was for.
            $found += $item
        }
    }
    return $found
}

<#
.SYNOPSIS
    Refuse to remove a worktree holding raw captures that exist nowhere else.
.DESCRIPTION
    Throws rather than merely letting `git worktree remove` refuse, because
    this script escalates to `--force` on refusal -- a guard at the git layer
    would be defeated by the script's own retry.

    Under -DryRun this reports instead of throwing, so the check can be used
    to audit worktrees safely.
#>
function Assert-WorktreeCaptureSafe {
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        # Passed explicitly rather than read off the script scope: under
        # Set-StrictMode -Version Latest an unset $DryRun throws, which would
        # turn this guard into a crash in any context that dot-sources it.
        [switch]$DryRun
    )

    $captures = @(Get-WorktreeCaptureArtifact -WorktreePath $WorktreePath)
    if ($captures.Count -eq 0) { return }

    # Scale the unit: a refusal that says "0 MB" reads like a rounding bug and
    # invites the operator to dismiss it.
    $bytes = ($captures | Measure-Object -Property Length -Sum).Sum
    $size = if ($bytes -ge 1GB) { '{0:N2} GB' -f ($bytes / 1GB) }
            elseif ($bytes -ge 1MB) { '{0:N1} MB' -f ($bytes / 1MB) }
            elseif ($bytes -ge 1KB) { '{0:N0} KB' -f ($bytes / 1KB) }
            else { "$bytes bytes" }
    $roots = $captures | ForEach-Object { $_.DirectoryName } | Sort-Object -Unique | Select-Object -First 3
    $message = @(
        "Refusing to remove '$WorktreePath': it holds $($captures.Count) raw capture file(s), $size, that git does not track."
        'These are gitignored, so `git status` reports this worktree clean -- removing it would destroy them with no Recycle Bin and no undo.'
        "Locations: $($roots -join '; ')"
        'Move them to the shared capture store first, then re-run this script.'
    ) -join [Environment]::NewLine

    if ($DryRun) {
        Write-Warning $message
        return
    }
    throw $message
}

# --- Resolve context -------------------------------------------------------

$startingDir = (Get-Location).Path
$repoRoot    = Get-RepoRoot
$commonDir   = Get-CommonDir

# If the shell is inside a linked worktree, hop out to the main repo root
# before doing anything (git refuses to remove a worktree you're inside, and
# pulling main from a feature worktree would pollute it).
$gitDir = (Resolve-Path (& git rev-parse --path-format=absolute --git-dir)).Path
$inLinkedWorktree = ($gitDir -ne $commonDir)

if ($inLinkedWorktree) {
    $mainRepoRoot = Split-Path -Parent $commonDir  # .git's parent
    Write-Host "Leaving worktree: $repoRoot -> $mainRepoRoot" -ForegroundColor Yellow
    Set-Location $mainRepoRoot
    $repoRoot = $mainRepoRoot
}

$worktrees = Get-WorktreeList

# Infer branch from the starting worktree if not provided.
if (-not $Branch -and $inLinkedWorktree) {
    $match = $worktrees | Where-Object {
        try { (Resolve-Path $_.Path -ErrorAction Stop).Path -eq $startingDir } catch { $false }
    } | Select-Object -First 1
    if ($match) { $Branch = $match.Branch }
}

# Resolve worktree path from branch if not provided.
if (-not $WorktreePath -and $Branch) {
    $match = $worktrees | Where-Object { $_.Branch -eq $Branch } | Select-Object -First 1
    if ($match) { $WorktreePath = $match.Path }
}

if (-not $Branch -and -not $WorktreePath -and -not $Sweep) {
    throw 'Unable to determine which branch/worktree to clean up. Pass -Branch, -WorktreePath, or -Sweep.'
}

$hasTarget = [bool]$Branch -or [bool]$WorktreePath

if ($Branch -eq $DefaultBranch) {
    throw "Refusing to delete the default branch '$DefaultBranch'."
}

# --- Safety check: only touch worktrees under .worktrees/ by default -------

if ($WorktreePath) {
    if (-not (Test-Path $WorktreePath)) {
        Write-Warning "Worktree path not found on disk: $WorktreePath (will still attempt git cleanup)"
    }
    $worktreesDir = Join-Path $repoRoot '.worktrees'
    $absWorktree = try { (Resolve-Path $WorktreePath -ErrorAction Stop).Path } catch { $WorktreePath }
    $underDotWorktrees = $absWorktree.StartsWith($worktreesDir, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $underDotWorktrees -and -not $AllowOutsideWorktreesDir) {
        throw "Worktree '$absWorktree' is not under '$worktreesDir'. Pass -AllowOutsideWorktreesDir to proceed."
    }

    # Issue #371: refuse before anything is deleted, not at the git layer --
    # the removal below escalates to --force on refusal.
    Assert-WorktreeCaptureSafe -WorktreePath $absWorktree -DryRun:$DryRun
}

# --- Summary ---------------------------------------------------------------

Write-Host ''
Write-Host 'Cleanup plan:' -ForegroundColor Cyan
Write-Host "  Repo root      : $repoRoot"
Write-Host "  Worktree       : $([string]::IsNullOrEmpty($WorktreePath) ? '(none)' : $WorktreePath)"
Write-Host "  Branch         : $([string]::IsNullOrEmpty($Branch) ? '(none)' : $Branch)"
Write-Host "  Default branch : $DefaultBranch"
Write-Host "  Delete branch  : $((-not $KeepBranch))  (force: $Force)"
Write-Host "  Pull after     : $((-not $SkipPull))"
Write-Host "  Sweep stale    : $Sweep"
if ($DryRun) { Write-Host '  Mode           : DRY RUN' -ForegroundColor Yellow }
Write-Host ''

# --- 1 & 2. Unlock + remove worktree --------------------------------------

if ($hasTarget -and $WorktreePath) {
    $wtEntry = $worktrees | Where-Object {
        try { (Resolve-Path $_.Path -ErrorAction Stop).Path -eq (Resolve-Path $WorktreePath -ErrorAction Stop).Path } catch { $false }
    } | Select-Object -First 1

    if ($wtEntry -and $wtEntry.Locked) {
        Invoke-Git -Arguments @('worktree', 'unlock', $WorktreePath) -IgnoreFailure | Out-Null
    }
    elseif (-not $wtEntry) {
        # Try unlock anyway -- entry may not be parsed but still locked.
        Invoke-Git -Arguments @('worktree', 'unlock', $WorktreePath) -IgnoreFailure | Out-Null
    }

    # Pre-clean ephemeral evidence-capture artifacts so `git worktree remove`
    # doesn't refuse on untracked files. See
    # .github/skills/evidence-capture/SKILL.md for the lifecycle.
    $evidenceDir = Join-Path $WorktreePath '.evidence'
    if (-not $DryRun -and (Test-Path -LiteralPath $evidenceDir)) {
        Write-Host "  Removing ephemeral .evidence/ from '$WorktreePath'." -ForegroundColor DarkGray
        Remove-Item -LiteralPath $evidenceDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Invoke-Git -Arguments @('worktree', 'remove', $WorktreePath) -IgnoreFailure | Out-Null
    if (-not $DryRun -and (Test-Path $WorktreePath)) {
        # `worktree remove` can refuse on dirty state -- retry with --force.
        Write-Warning "Worktree still present; retrying with --force."
        Invoke-Git -Arguments @('worktree', 'remove', '--force', $WorktreePath) -IgnoreFailure | Out-Null
    }
}

# --- 3. Prune --------------------------------------------------------------

Invoke-Git -Arguments @('worktree', 'prune') | Out-Null

# --- 4. Checkout default branch + pull ------------------------------------

$currentBranch = & git rev-parse --abbrev-ref HEAD 2>$null
if ($currentBranch -ne $DefaultBranch) {
    Invoke-Git -Arguments @('checkout', $DefaultBranch) | Out-Null
}
if (-not $SkipPull) {
    Invoke-Git -Arguments @('pull', '--ff-only') | Out-Null
}

# --- 5. Delete target branch ----------------------------------------------

if ($hasTarget -and $Branch -and -not $KeepBranch) {
    $flag = if ($Force) { '-D' } else { '-d' }
    try {
        Invoke-Git -Arguments @('branch', $flag, $Branch) | Out-Null
    }
    catch {
        if (-not $Force) {
            Write-Warning "Safe delete failed for '$Branch'. If the PR was closed without merge, re-run with -Force."
        }
        throw
    }
}

# --- 6. Sweep mode: prune stale remotes + branches + worktrees ------------

if ($Sweep) {
    Write-Host ''
    Write-Host 'Sweeping stale refs, branches, and worktrees...' -ForegroundColor Cyan

    # Fetch + prune removes remote-tracking branches whose remote ref is gone.
    Invoke-Git -Arguments @('fetch', '--all', '--prune') | Out-Null

    # Find local branches whose upstream is "gone" (PR branch deleted on remote,
    # typical after GitHub squash-merges). Uses -D because squash-merges leave
    # the local branch "unmerged" from git's perspective.
    $goneRaw = & git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads 2>$null
    $goneBranches = @()
    foreach ($line in ($goneRaw -split "`r?`n")) {
        if ($line -match '^(\S+)\s+\[gone\]$') {
            $name = $Matches[1]
            if ($name -ne $DefaultBranch) { $goneBranches += $name }
        }
    }

    if ($goneBranches.Count -eq 0) {
        Write-Host '  No local branches with gone upstream.' -ForegroundColor DarkGray
    }
    else {
        foreach ($b in $goneBranches) {
            # A branch with a gone upstream may still be checked out in a worktree;
            # remove that worktree first.
            $refreshed = Get-WorktreeList
            $wt = $refreshed | Where-Object { $_.Branch -eq $b } | Select-Object -First 1
            if ($wt) {
                Write-Host "  Branch '$b' is checked out at '$($wt.Path)' -- removing worktree first." -ForegroundColor Yellow
                # Issue #371: a sweep must not destroy captures either.
                Assert-WorktreeCaptureSafe -WorktreePath $wt.Path -DryRun:$DryRun
                Invoke-Git -Arguments @('worktree', 'unlock', $wt.Path) -IgnoreFailure | Out-Null
                Invoke-Git -Arguments @('worktree', 'remove', '--force', $wt.Path) -IgnoreFailure | Out-Null
            }
            Invoke-Git -Arguments @('branch', '-D', $b) -IgnoreFailure | Out-Null
        }
    }

    # Drop any worktrees whose branch no longer exists locally.
    $finalWorktrees = Get-WorktreeList
    foreach ($wt in $finalWorktrees) {
        if (-not $wt.Branch) { continue }
        $exists = & git show-ref --verify --quiet "refs/heads/$($wt.Branch)"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Worktree '$($wt.Path)' references missing branch '$($wt.Branch)' -- removing." -ForegroundColor Yellow
            # Issue #371: a missing branch does not make the captures expendable.
            Assert-WorktreeCaptureSafe -WorktreePath $wt.Path -DryRun:$DryRun
            Invoke-Git -Arguments @('worktree', 'unlock', $wt.Path) -IgnoreFailure | Out-Null
            Invoke-Git -Arguments @('worktree', 'remove', '--force', $wt.Path) -IgnoreFailure | Out-Null
        }
    }

    Invoke-Git -Arguments @('worktree', 'prune') | Out-Null
}

Write-Host ''
Write-Host 'Cleanup complete.' -ForegroundColor Green
