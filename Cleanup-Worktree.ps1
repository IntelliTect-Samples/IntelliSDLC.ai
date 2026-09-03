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

    UNCOMMITTED-WORK SAFETY (both modes, issue #392):
    `git worktree remove` refuses when the worktree is dirty. That refusal
    IS the protection -- unstaged edits are not in the object store, so once
    the directory is gone `git fsck --lost-found` has nothing to offer. This
    script used to escalate to `--force` unconditionally, and on 2026-09-02
    that destroyed an authoring agent's in-progress work. Now, before any
    `--force`, it reports what is dirty (file names and counts, never
    contents) and distinguishes untracked build output -- discarded with a
    note -- from modified or staged TRACKED files, which need consent:
    interactive runs prompt with the list, non-interactive runs fail and name
    -Force as the authorisation. In sweep mode the refusal stops the sweep,
    the same way the capture guard does: an unattended run is exactly the
    case where continuing past a warning nobody read is the whole problem.

    RESIDUAL RISK, recorded rather than fixed: "is a human attached?" is
    answered by [Console]::IsInputRedirected, because the obvious probe
    ([Environment]::UserInteractive) returns $true inside an agent session
    and would defeat the gate entirely. A host that leaves stdin attached to
    a live console while nobody is watching -- a Scheduled Task set to run
    whether or not a user is logged on, an orchestrator that allocates a pty
    -- therefore looks interactive, and the prompt BLOCKS instead of failing
    fast. That is a hang, not a data loss, and it is the safe direction to be
    wrong in; closing it properly would need a new switch, which requires
    explicit human approval. If a run appears stuck here, pass -Force (having
    decided the changes are expendable) or clean the worktree first.

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
    and repository root from git. By default it only acts on worktrees that
    live in a known-safe layout (either <mainRepoRoot>\.worktrees\ or the
    Copilot desktop app's <any>\copilot-worktrees\<repoName>\<slug> path,
    confirmed via `git worktree list`). Anything else requires
    -AllowOutsideWorktreesDir.

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
    Authorises DISCARDING WORK, in two places (widened in issue #392):

      1. Force-delete the feature branch with `git branch -D` (discards
         unmerged commits). Use for PRs that were closed without merging.
      2. Destroy uncommitted changes to TRACKED files in the worktree being
         removed. Without -Force, an interactive run prompts and shows the
         file list; a non-interactive run FAILS and names -Force as the
         authorisation.

    One switch covers both because they are one decision -- "discard work I
    have decided I do not need" -- and because adding a command-line option
    is an API decision that requires explicit human approval. Untracked files
    are reported and discarded without -Force: build output is a nuisance,
    not work.

.PARAMETER KeepBranch
    Skip deletion of the local branch. Useful when only removing the worktree.

.PARAMETER SkipPull
    Do not run `git pull` after switching to the default branch.

.PARAMETER AllowOutsideWorktreesDir
    Permit removing a worktree that is not located under one of the
    known-safe layouts. By default the script refuses, to avoid destroying
    unrelated checkouts. Known-safe layouts are:

      * <mainRepoRoot>\.worktrees\<slug>
      * <any>\copilot-worktrees\<repoName>\<slug> -- the Copilot desktop
        app's layout -- provided `git worktree list` in the main repo
        confirms the path is a registered worktree.

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

function ConvertTo-NormalizedPath {
    <#
    .SYNOPSIS
        Normalizes a filesystem path for case-insensitive comparison.

    .DESCRIPTION
        Strips trailing directory separators and converts forward slashes to
        backslashes. `git worktree list --porcelain` on Windows emits forward
        slashes, so normalization is required before path comparisons.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrEmpty($Path)) { return '' }
    return $Path.Replace('/', '\').TrimEnd('\')
}

function Test-WorktreeInSafeLocation {
    <#
    .SYNOPSIS
        Returns $true when a worktree path sits in a known-safe layout.

    .DESCRIPTION
        Safe layouts are:
          1. <MainRepoRoot>\.worktrees\<anything>
          2. <any>\copilot-worktrees\<repoName>\<slug> -- but only when
             `git worktree list` in the main repo confirms the exact path is
             a registered worktree. The registration check is what prevents
             a random directory that happens to contain a
             `copilot-worktrees` segment from being trusted.

        The <MainRepoRoot>\..\copilot-worktrees\<repoName>\<slug> layout (the
        one the Copilot desktop app uses when its storage_location is the
        parent of the repo) is a natural subset of rule 2 and needs no
        special-case.

    .PARAMETER WorktreePath
        Absolute path to the worktree under evaluation.

    .PARAMETER MainRepoRoot
        Absolute path to the main repository's working tree (not a linked
        worktree).

    .PARAMETER RegisteredWorktreePaths
        Paths reported by `git worktree list` in the main repo. Used to
        validate the Copilot desktop app layout.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)][string]$MainRepoRoot,
        [string[]]$RegisteredWorktreePaths = @()
    )

    $abs  = ConvertTo-NormalizedPath -Path $WorktreePath
    $root = ConvertTo-NormalizedPath -Path $MainRepoRoot

    if ([string]::IsNullOrEmpty($abs) -or [string]::IsNullOrEmpty($root)) {
        return $false
    }

    # Rule 1: <MainRepoRoot>\.worktrees\...
    $dotWorktrees = ConvertTo-NormalizedPath -Path (Join-Path $root '.worktrees')
    if ($abs.StartsWith($dotWorktrees + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $abs.Equals($dotWorktrees, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    # Rule 2: **\copilot-worktrees\<repoName>\<slug>, cross-checked against
    # the main repo's registered worktree list.
    $repoName = Split-Path -Leaf $root
    if ([string]::IsNullOrEmpty($repoName)) { return $false }

    $pattern = '\\copilot-worktrees\\' + [regex]::Escape($repoName) + '\\[^\\]+'
    # Case-insensitivity comes from the OPERATOR, not the pattern: `-notmatch`
    # is case-insensitive by definition. An inline `(?i)` here was redundant
    # (issue #390) and actively misleading -- it would have kept the comparison
    # case-insensitive even after a future edit switched this to `-cnotmatch`
    # for deliberate case sensitivity, leaving the literal and the operator
    # disagreeing. Do not re-add it; change the operator instead.
    if ($abs -notmatch $pattern) { return $false }

    foreach ($registered in $RegisteredWorktreePaths) {
        $reg = ConvertTo-NormalizedPath -Path $registered
        if ($reg.Equals($abs, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
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

<#
.SYNOPSIS
    Uncommitted work inside a worktree that `worktree remove --force` would destroy.
.DESCRIPTION
    Splits `git status --porcelain` into the two cases that deserve different
    answers (issue #392):

      Tracked   -- modified, staged, renamed, deleted or unmerged entries.
                   This is WORK. It exists nowhere else: unstaged changes are
                   not in the object store, so `git fsck --lost-found` cannot
                   recover them after the directory is gone.
      Untracked -- `??` entries. Usually build or ephemeral output; a nuisance,
                   not a loss, and the reason `git worktree remove` refuses at
                   all in the common case.

    Ignored entries are deliberately NOT requested here: those are the capture
    guard's business (Assert-WorktreeCaptureSafe, issue #371), and `--ignored`
    would flood this list with build directories.

    Unknown is the conservative third state. If the path exists but git cannot
    report on it, "no output" must not read as "nothing to lose" -- that is
    precisely the failure mode recorded in this script's WHY A GUARD banner.
.OUTPUTS
    [pscustomobject] with Tracked (string[]), Untracked (string[]), Unknown (bool).
#>
function Format-PorcelainPath {
    <#
    .SYNOPSIS
        Unwraps the quotes `git status --porcelain` puts around an awkward path.
    .DESCRIPTION
        git quotes a path containing spaces or special characters. The quotes
        are transport, not part of the name, and the sibling capture guard
        already strips them (Get-WorktreeCaptureArtifact).

        A rename arrives as `old -> new` and may carry quotes around EITHER
        side, so a blind Trim('"') would eat one quote from each end of a
        two-path line and leave the inner ones -- worse than doing nothing.
        Rename lines are therefore returned untouched.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)

    if ($Path -like '* -> *') { return $Path }
    if ($Path.Length -ge 2 -and $Path.StartsWith('"') -and $Path.EndsWith('"')) {
        return $Path.Substring(1, $Path.Length - 2)
    }
    return $Path
}

function Get-WorktreeDirtyState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$WorktreePath)

    $empty = [pscustomobject]@{ Tracked = @(); Untracked = @(); Unknown = $false }

    # A path that is not on disk holds nothing. This is the only "no output"
    # that is safe to read as "nothing to lose".
    if (-not (Test-Path -LiteralPath $WorktreePath)) { return $empty }

    # core.quotepath=false so a non-ASCII filename arrives as itself rather than
    # as octal escapes. The operator is being asked to authorise destroying
    # these files; "caf\303\251.txt" is not a name anyone can recognise.
    $status = & git -c core.quotepath=false -C $WorktreePath status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) {
        return [pscustomobject]@{ Tracked = @(); Untracked = @(); Unknown = $true }
    }

    $tracked = @()
    $untracked = @()
    foreach ($line in ($status -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line.Length -le 3) { continue }
        $code = $line.Substring(0, 2)
        $path = Format-PorcelainPath -Path $line.Substring(3).Trim()
        if ($code -eq '??') { $untracked += $path }
        elseif ($code -eq '!!') { continue }
        else { $tracked += "$code $path" }
    }
    return [pscustomobject]@{ Tracked = $tracked; Untracked = $untracked; Unknown = $false }
}

<#
.SYNOPSIS
    Renders a dirty worktree as file names and counts -- never file contents.
.DESCRIPTION
    The operator has to decide whether to destroy this, so the report has to
    name it. It names paths and counts only: a status report is not a place to
    spill the contents of someone's unsaved work into a terminal or a log.
#>
function Format-WorktreeDirtyReport {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)]$DirtyState,
        [int]$MaxListed = 20
    )

    $lines = @()
    if ($DirtyState.Unknown) {
        $lines += "Cannot determine what '$WorktreePath' would lose -- git status failed there."
    }
    $tracked = @($DirtyState.Tracked)
    $untracked = @($DirtyState.Untracked)
    if ($tracked.Count -gt 0) {
        $lines += "$($tracked.Count) uncommitted change(s) to TRACKED files in '$WorktreePath':"
        $lines += ($tracked | Select-Object -First $MaxListed | ForEach-Object { "    $_" })
        if ($tracked.Count -gt $MaxListed) { $lines += "    ... and $($tracked.Count - $MaxListed) more" }
    }
    if ($untracked.Count -gt 0) {
        $lines += "$($untracked.Count) untracked file(s):"
        $lines += ($untracked | Select-Object -First $MaxListed | ForEach-Object { "    $_" })
        if ($untracked.Count -gt $MaxListed) { $lines += "    ... and $($untracked.Count - $MaxListed) more" }
    }
    return ($lines -join [Environment]::NewLine)
}

<#
.SYNOPSIS
    Is there a human on the other end of this run?
.DESCRIPTION
    Extracted so tests can mock it, and because the obvious probe is wrong:
    `[Environment]::UserInteractive` returns $true inside an agent session,
    which is exactly the unattended case this gate exists for. Input being
    redirected is the signal that no one can answer a prompt.
#>
function Test-CleanupInteractive {
    [CmdletBinding()]
    [OutputType([bool])]
    param()
    return (-not [Console]::IsInputRedirected)
}

<#
.SYNOPSIS
    Asks the operator whether to destroy uncommitted work. Extracted so tests
    can answer deterministically -- $PSCmdlet.ShouldContinue cannot be mocked.
#>
function Confirm-WorktreeDirtyDiscard {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]$Cmdlet,
        [Parameter(Mandatory)][string]$Report
    )
    # ShouldContinue defaults to Yes and cannot be made to default to No, so the
    # caption -- not the default -- has to carry the weight.
    return $Cmdlet.ShouldContinue(
        'Destroy these uncommitted changes and remove the worktree?',
        "PERMANENT: unstaged changes are not in the object store and git fsck cannot recover them.$([Environment]::NewLine)$Report")
}

<#
.SYNOPSIS
    Refuse to force-remove a worktree holding uncommitted work without consent.
.DESCRIPTION
    Issue #392. `git worktree remove` refusing on dirty state IS the protection;
    this script escalates to `--force`, so the protection has to be re-created
    here or it is simply defeated. On 2026-09-02 the unconditional escalation
    destroyed an authoring agent's in-progress polish pass, unrecoverably.

    The decision table:

      tracked changes, -Force            -> warn, naming them, and proceed
      tracked changes, interactive       -> prompt, showing them
      tracked changes, non-interactive   -> THROW, naming -Force as the authorisation
      untracked only                     -> report and proceed (build output is a nuisance)
      unknown state                      -> treated as tracked: unknown is not empty

    -Force is the authorisation deliberately: it already means "discard work I
    have decided I do not need" for `git branch -D`, and adding a command-line
    option is an API decision requiring explicit human approval.

    Under -DryRun this reports instead of throwing -- nothing is removed, so
    there is no consent to obtain, and an audit run must be able to finish.
#>
function Assert-WorktreeRemovalConsent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$WorktreePath,
        # Passed explicitly rather than read off the script scope, for the same
        # reason Assert-WorktreeCaptureSafe does: under Set-StrictMode an unset
        # $Force/$DryRun throws, turning this guard into a crash when dot-sourced.
        [switch]$Force,
        [switch]$DryRun,
        # The calling cmdlet, so the prompt is attributed to the script rather
        # than to this helper. Absent => nothing can prompt => non-interactive.
        $Cmdlet
    )

    $state = Get-WorktreeDirtyState -WorktreePath $WorktreePath
    $tracked = @($state.Tracked)
    $untracked = @($state.Untracked)
    $atRisk = ($tracked.Count -gt 0) -or $state.Unknown

    if (-not $atRisk) {
        if ($untracked.Count -gt 0) {
            # Named, not silently forced -- the same shape as the .evidence/
            # pre-clean: say what is being discarded rather than force blindly.
            # This branch sits ahead of the -DryRun check below, so it has to
            # get the tense right itself: a dry run discards nothing.
            $verb = if ($DryRun) { 'Would discard' } else { 'Discarding' }
            Write-Host ("  $verb $($untracked.Count) untracked file(s) in '$WorktreePath' (no tracked changes at risk).") -ForegroundColor DarkGray
        }
        return
    }

    $report = Format-WorktreeDirtyReport -WorktreePath $WorktreePath -DirtyState $state

    if ($DryRun) {
        Write-Warning ("Would need consent to remove '$WorktreePath':" + [Environment]::NewLine + $report)
        return
    }

    if ($Force) {
        Write-Warning ("-Force: destroying uncommitted work in '$WorktreePath'." + [Environment]::NewLine + $report)
        return
    }

    if (-not $Cmdlet -or -not (Test-CleanupInteractive)) {
        throw (@(
            "Refusing to force-remove '$WorktreePath': it holds uncommitted work and nothing here can ask you about it."
            $report
            'These changes exist nowhere else -- unstaged edits are not in the object store, so `git fsck` cannot recover them.'
            'Commit or stash them, or re-run with -Force to authorise destroying them.'
        ) -join [Environment]::NewLine)
    }

    Write-Warning ("'$WorktreePath' holds uncommitted work:" + [Environment]::NewLine + $report)
    if (-not (Confirm-WorktreeDirtyDiscard -Cmdlet $Cmdlet -Report $report)) {
        throw "Aborted at operator request: '$WorktreePath' still holds uncommitted work. Commit or stash it, then re-run."
    }
}

# Skip the rest of the script when dot-sourced (e.g. by tests). Supersedes
# the regex-slicing loader the #371 tests used, which cut the file at this
# banner and re-parsed it -- fragile, and broken by moving the banner.
if ($MyInvocation.InvocationName -eq '.') { return }

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

# --- Safety check: only touch worktrees in a known-safe layout by default --

if ($WorktreePath) {
    if (-not (Test-Path $WorktreePath)) {
        Write-Warning "Worktree path not found on disk: $WorktreePath (will still attempt git cleanup)"
    }
    $worktreesDir = Join-Path $repoRoot '.worktrees'
    $absWorktree = try { (Resolve-Path $WorktreePath -ErrorAction Stop).Path } catch { $WorktreePath }

    # Issue #383: the Copilot desktop app's layout is recognised as safe, but
    # only when `git worktree list` registers the exact path -- the path shape
    # alone is a proxy, the registration is the fact.
    $registeredPaths = @($worktrees | ForEach-Object { $_.Path })
    $isSafe = Test-WorktreeInSafeLocation `
        -WorktreePath $absWorktree `
        -MainRepoRoot $repoRoot `
        -RegisteredWorktreePaths $registeredPaths
    if (-not $isSafe -and -not $AllowOutsideWorktreesDir) {
        throw ("Worktree '{0}' is not under '{1}' or a registered '**\copilot-worktrees\{2}\<slug>' layout. Pass -AllowOutsideWorktreesDir to proceed." -f $absWorktree, $worktreesDir, (Split-Path -Leaf $repoRoot))
    }

    # Issue #371: refuse before anything is deleted, not at the git layer --
    # the removal below escalates to --force on refusal. Ordered AFTER the
    # location check on purpose: "that is not a worktree I should touch" is a
    # better message than "that worktree holds captures".
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
        # `worktree remove` refused. That refusal is the protection, not an
        # obstacle (issue #392): say what is dirty, and get consent before
        # escalating past it.
        Write-Warning 'Worktree still present -- git refused to remove it.'
        # $absWorktree, not $WorktreePath: the script may have Set-Location'd to
        # the main repo root above, so a relative -WorktreePath no longer means
        # what the operator typed. The capture guard already resolves for the
        # same reason -- a guard that inspects the wrong directory reports the
        # wrong answer, and here the wrong answer is "nothing to lose".
        Assert-WorktreeRemovalConsent -WorktreePath $absWorktree -Force:$Force -DryRun:$DryRun -Cmdlet $PSCmdlet
        # $absWorktree here too: a gate that inspects one directory while the
        # command deletes another is the defect this whole change is about,
        # and leaving the pair disagreeing invites someone to "fix" the gate
        # back. Resolution falls back to $WorktreePath, so this is the same
        # path in every case where it resolved.
        Invoke-Git -Arguments @('worktree', 'remove', '--force', $absWorktree) -IgnoreFailure | Out-Null
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
                # Issue #392: nor uncommitted work. A gone upstream says the PR
                # branch was deleted on the remote; it says nothing about what
                # the authoring agent is still editing here.
                Assert-WorktreeRemovalConsent -WorktreePath $wt.Path -Force:$Force -DryRun:$DryRun -Cmdlet $PSCmdlet
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
            # Issue #392: nor the uncommitted work. A worktree whose branch is
            # gone is the MOST likely to hold edits no ref points at.
            Assert-WorktreeRemovalConsent -WorktreePath $wt.Path -Force:$Force -DryRun:$DryRun -Cmdlet $PSCmdlet
            Invoke-Git -Arguments @('worktree', 'unlock', $wt.Path) -IgnoreFailure | Out-Null
            Invoke-Git -Arguments @('worktree', 'remove', '--force', $wt.Path) -IgnoreFailure | Out-Null
        }
    }

    Invoke-Git -Arguments @('worktree', 'prune') | Out-Null
}

Write-Host ''
Write-Host 'Cleanup complete.' -ForegroundColor Green
