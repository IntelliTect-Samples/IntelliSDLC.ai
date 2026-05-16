<#
.SYNOPSIS
    Syncs shared AI instruction files from IntelliSDLC.ai into this project.

.DESCRIPTION
    Replays the upstream commit history as a sequence of file-system
    operations (add / modify / delete / rename / copy / type-change) against
    the consumer working tree. Conflict-free by construction: rename
    detection runs against the single upstream timeline, and files are
    written byte-for-byte from upstream blobs (no three-way merge).

    Upstream-managed paths are listed in $script:UpstreamManagedPaths.
    Consumer-owned paths (immune to upstream replay) are listed in
    $script:AlwaysLocalPaths; that list trumps the managed-paths list.

    State is tracked in .sdlc-ai-sync.json at the repo root (always-local,
    committed). Schema:

        { "remote": "sdlc.ai", "ref": "main",
          "lastSyncCommit": "<sha>", "syncedAt": "<iso8601-utc>" }

    A pre-flight guard refuses to run if any upstream-managed file shows
    local drift from the recorded anchor (catches policy violations before
    they get overwritten). Pass -Force to override.

.PARAMETER Branch
    Upstream branch to sync from. Default: main.

.PARAMETER RemoteName
    Local name for the upstream git remote. Default: sdlc.ai.

.PARAMETER WhatIf
    Print the planned op list and exit without modifying the working tree.

.PARAMETER Force
    Bypass the pre-flight drift guard. A warning banner is printed.

.PARAMETER Bootstrap
    Accept the empty-tree anchor (full refresh from upstream HEAD) without
    prompting when no .sdlc-ai-sync.json and no prior sync commit are found.

.PARAMETER NoPrompt
    Equivalent to -Bootstrap when no anchor is found; never prompts.

.PARAMETER AllowDefaultBranch
    Bypass the pre-flight check that blocks running from the protected branch.
    Only needed in consumers without the .githooks/pre-commit policy active.

.PARAMETER NoAutoWorktree
    When on the protected branch with a gate, do NOT auto-create a worktree.
    Restores the previous behavior: print remediation and exit rc=3.

.PARAMETER NoAutoPR
    During auto-worktree mode, commit + push but do NOT open a pull request.
    Useful in CI or when gh is misconfigured.

.PARAMETER NoSelfUpdate
    Skip the start-of-run self-refresh check that pulls the latest
    Pull-SDLC.ai.ps1 from upstream raw.githubusercontent.com. Also honored
    via the PULL_SDLC_NO_SELF_UPDATE environment variable. The re-exec path
    always passes this flag to prevent an infinite refresh loop.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Branch = 'main',
    [string]$RemoteName = 'sdlc.ai',
    [switch]$Force,
    [switch]$Bootstrap,
    [switch]$NoPrompt,
    [switch]$AllowDefaultBranch,
    [switch]$NoAutoWorktree,
    [switch]$NoAutoPR,
    [switch]$NoSelfUpdate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteUrl = 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git'

# Map of <template path> -> <bare target path> used to scaffold consumer-owned
# files on first sync.
$script:TemplateScaffoldMap = [ordered]@{
    '.github/instructions/project.instructions.md.template' = '.github/instructions/project.instructions.md'
    'CLAUDE.project.md.template'                            = 'CLAUDE.project.md'
}

# Paths (file or directory prefixes) that upstream owns. Anything under one
# of these is subject to diff-replay against upstream/<Branch>.
$script:UpstreamManagedPaths = @(
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    '.github/agents/',
    '.github/skills/',
    '.github/instructions/'
)

# Paths that are inherently consumer-owned. Always-local trumps managed-paths
# (e.g. .github/instructions/project.instructions.md sits under the managed
# .github/instructions/ tree but is filtered out of the op list).
$script:AlwaysLocalPaths = @(
    'README.md',
    '.gitignore',
    '.github/instructions/project.instructions.md',
    'CLAUDE.project.md',
    '.sdlc-ai-sync.json'
)

$script:SdlcSyncStateFile = '.sdlc-ai-sync.json'

function ConvertTo-RepoRelativePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $n = $Path -replace '\\', '/'
    if ($n.StartsWith('./')) { $n = $n.Substring(2) }
    return $n
}

function Test-IsAlwaysLocalPath {
    <#
    .SYNOPSIS
        Returns $true if the given repo-relative path is on the always-local
        list. Comparison is case-insensitive and tolerates ./ or .\ prefix.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    foreach ($candidate in $script:AlwaysLocalPaths) {
        if ([string]::Equals($n, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Test-IsUpstreamManagedPath {
    <#
    .SYNOPSIS
        Returns $true if the given path is under an upstream-managed prefix
        AND not on the always-local list. Always-local trumps managed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    if (Test-IsAlwaysLocalPath -Path $n) { return $false }
    foreach ($p in $script:UpstreamManagedPaths) {
        $pp = $p -replace '\\', '/'
        if ($pp.EndsWith('/')) {
            if ($n.StartsWith($pp, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        else {
            if ([string]::Equals($n, $pp, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
    }
    return $false
}

function Test-IsUpstreamRepo {
    [CmdletBinding()]
    param([string]$RemoteUrl = (git remote get-url origin 2>$null))
    if (-not $RemoteUrl) { return $false }
    return $RemoteUrl -match 'IntelliSDLC\.ai(\.git)?/?$'
}

function Invoke-TemplateScaffold {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$TargetRoot,
        [Parameter(Mandatory)][System.Collections.IDictionary]$ScaffoldMap
    )
    $scaffolded = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $ScaffoldMap.GetEnumerator()) {
        $template = Join-Path $SourceRoot $entry.Key
        $target   = Join-Path $TargetRoot $entry.Value
        if (-not (Test-Path -LiteralPath $template)) { continue }
        if (Test-Path -LiteralPath $target) { continue }
        $targetDir = Split-Path -Parent $target
        if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $template -Destination $target -Force
        $scaffolded.Add($entry.Value) | Out-Null
    }
    return $scaffolded.ToArray()
}

function Get-SdlcSyncState {
    <#
    .SYNOPSIS
        Reads .sdlc-ai-sync.json from $RepoRoot. Returns $null when absent.
    #>
    [CmdletBinding()]
    param([string]$RepoRoot = '.')
    $path = Join-Path $RepoRoot $script:SdlcSyncStateFile
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
    }
    catch {
        throw "Failed to parse $path : $($_.Exception.Message)"
    }
}

function Set-SdlcSyncState {
    <#
    .SYNOPSIS
        Writes .sdlc-ai-sync.json with the given remote/ref/commit + UTC now.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Remote,
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][string]$Commit
    )
    $obj = [ordered]@{
        remote         = $Remote
        ref            = $Ref
        lastSyncCommit = $Commit
        syncedAt       = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    $json = ($obj | ConvertTo-Json) + "`n"
    $absPath = Join-Path $RepoRoot $script:SdlcSyncStateFile
    [System.IO.File]::WriteAllText($absPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Resolve-SyncAnchor {
    <#
    .SYNOPSIS
        Determines the anchor SHA. Returns @{ Sha = <sha or empty>; Source = <state|grep|bootstrap> }.
        Returns $null if no anchor could be determined and -Bootstrap / -NoPrompt
        not set and user declines the prompt.
    #>
    [CmdletBinding()]
    param(
        [string]$RepoRoot = '.',
        [switch]$Bootstrap,
        [switch]$NoPrompt
    )
    $state = Get-SdlcSyncState -RepoRoot $RepoRoot
    if ($Bootstrap) {
        return @{ Sha = ''; Source = 'bootstrap' }
    }
    if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'lastSyncCommit' -and $state.lastSyncCommit) {
        return @{ Sha = $state.lastSyncCommit; Source = 'state' }
    }
    Push-Location $RepoRoot
    try {
        $grep = git log --grep '^chore.*sync.*IntelliSDLC' --pretty=format:%H -n 1 2>$null
    }
    finally { Pop-Location }
    if ($grep) {
        Write-Host "Anchor: using commit $grep (matched 'chore: sync IntelliSDLC...' in git log)." -ForegroundColor DarkGray
        return @{ Sha = ($grep | Select-Object -First 1).Trim(); Source = 'grep' }
    }
    if ($Bootstrap -or $NoPrompt) {
        return @{ Sha = ''; Source = 'bootstrap' }
    }
    Write-Host ''
    Write-Host 'No .sdlc-ai-sync.json and no prior sync commit found.' -ForegroundColor Yellow
    Write-Host 'Bootstrap will perform a full refresh from upstream HEAD (empty-tree anchor).' -ForegroundColor Yellow
    $ans = Read-Host 'Proceed with bootstrap? [y/N]'
    if ($ans -match '^[Yy]') {
        return @{ Sha = ''; Source = 'bootstrap' }
    }
    return $null
}

function Get-UpstreamOps {
    <#
    .SYNOPSIS
        Parses `git diff --name-status -M -B <anchor> <ref> -- <paths>` into
        a list of op hashtables: @{ Op = A|M|D|T|R|C; Path = ...; OldPath = ... }.
    .DESCRIPTION
        Empty $Anchor means "empty tree" (full refresh). Always-local paths
        are filtered out (regardless of which side they appear on).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Anchor,
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][string[]]$ManagedPaths,
        [string]$RepoRoot = '.'
    )
    Push-Location $RepoRoot
    try {
        $left = if ([string]::IsNullOrWhiteSpace($Anchor)) {
            # Empty-tree SHA, hard-coded by git.
            '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
        } else { $Anchor }

        $argv = @('diff', '--name-status', '-M', '-B', $left, $Ref, '--')
        $argv += $ManagedPaths
        $raw = & git @argv 2>$null
    }
    finally { Pop-Location }

    $ops = New-Object System.Collections.Generic.List[hashtable]
    if (-not $raw) { return @() }
    foreach ($line in $raw) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "`t"
        if ($parts.Count -lt 2) { continue }
        $code = $parts[0]
        # First character is the op; trailing digits are similarity / break score.
        $op = $code.Substring(0, 1).ToUpperInvariant()
        $entry = $null
        switch ($op) {
            'R' {
                if ($parts.Count -lt 3) { continue }
                $entry = @{ Op = 'R'; OldPath = $parts[1]; Path = $parts[2] }
            }
            'C' {
                if ($parts.Count -lt 3) { continue }
                $entry = @{ Op = 'C'; OldPath = $parts[1]; Path = $parts[2] }
            }
            default {
                if ('A','M','D','T' -notcontains $op) { continue }
                $entry = @{ Op = $op; Path = $parts[1]; OldPath = $null }
            }
        }
        if ($null -eq $entry) { continue }
        # Drop ops whose primary path is always-local. For R/C, also drop if
        # the OldPath is always-local (don't delete consumer-owned files).
        if (Test-IsAlwaysLocalPath -Path $entry.Path) { continue }
        if ($entry.OldPath -and (Test-IsAlwaysLocalPath -Path $entry.OldPath)) { continue }
        $ops.Add($entry) | Out-Null
    }
    return $ops.ToArray()
}

function Invoke-UpstreamOp {
    <#
    .SYNOPSIS
        Applies one op (A/M/T/D/R/C) to the working tree at $RepoRoot,
        reading file contents from $Ref via `git show`.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Op,
        [Parameter(Mandatory)][string]$Ref,
        [string]$RepoRoot = '.'
    )
    $write = {
        param($relPath)
        $abs = Join-Path $RepoRoot $relPath
        $dir = Split-Path -Parent $abs
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        # Capture raw bytes via System.Diagnostics.Process to avoid PowerShell
        # pipeline newline normalization (preserves byte-for-byte equivalence
        # with the upstream blob).
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'git'
        $psi.ArgumentList.Add('show') | Out-Null
        $psi.ArgumentList.Add("${Ref}:${relPath}") | Out-Null
        $psi.WorkingDirectory = $RepoRoot
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $proc = [System.Diagnostics.Process]::Start($psi)
        $ms = New-Object System.IO.MemoryStream
        $proc.StandardOutput.BaseStream.CopyTo($ms)
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        if ($proc.ExitCode -ne 0) {
            throw "git show ${Ref}:${relPath} failed (exit $($proc.ExitCode)): $stderr"
        }
        [System.IO.File]::WriteAllBytes($abs, $ms.ToArray())
    }
    $remove = {
        param($relPath)
        $abs = Join-Path $RepoRoot $relPath
        if (Test-Path -LiteralPath $abs) {
            Remove-Item -LiteralPath $abs -Force
        }
    }
    switch ($Op.Op) {
        'A' { & $write $Op.Path }
        'M' { & $write $Op.Path }
        'T' { & $write $Op.Path }
        'D' { & $remove $Op.Path }
        'R' { & $remove $Op.OldPath; & $write $Op.Path }
        'C' { & $write $Op.Path }
        default { throw "Unsupported op: $($Op.Op)" }
    }
}

function Test-LocalDriftOnManagedPaths {
    <#
    .SYNOPSIS
        For each upstream-managed path that currently exists at HEAD, compares
        its HEAD blob to the same path's blob at $Anchor. Returns an array of
        @{ Path = ...; Commit = '<sha> <subject>' } for drift entries.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Anchor,
        [Parameter(Mandatory)][string[]]$ManagedPaths,
        [string]$RepoRoot = '.'
    )
    Push-Location $RepoRoot
    try {
        # Only ls-tree paths that actually exist at HEAD; trailing-slash directory
        # pathspecs are fine but a non-existent file path makes ls-tree no-op.
        $headPaths = & git ls-tree -r --name-only HEAD -- @ManagedPaths 2>$null
        $headPaths = @($headPaths)
        if ($headPaths.Count -eq 0) { return @() }
        $drift = New-Object System.Collections.Generic.List[hashtable]
        foreach ($p in $headPaths) {
            if (Test-IsAlwaysLocalPath -Path $p) { continue }
            $headSha = (& git rev-parse "HEAD:$p" 2>$null)
            $anchorSha = (& git rev-parse "${Anchor}:$p" 2>$null)
            if ($headSha -and $headSha -ne $anchorSha) {
                $log = (& git log -1 --pretty='%h %s' -- $p 2>$null) -join ''
                $drift.Add(@{ Path = $p; Commit = $log }) | Out-Null
            }
        }
        return $drift.ToArray()
    }
    finally { Pop-Location }
}

function Test-CommitContextAllowed {
    <#
    .SYNOPSIS
        Returns @{ Allowed = $true/$false; Reason = <string>; Branch = <branch> }.
        Used by Invoke-PullSDLC to fail fast before mutating the working tree when
        the consumer is on the protected branch (typically 'main'), which would
        cause the sync commit to fail (either via .githooks/pre-commit policy or
        a remote branch-protection rule on push).
    .DESCRIPTION
        Only the protected-branch rule is enforced here. Worktree / repo-root
        policies are left to .githooks/pre-commit so we don't duplicate or
        diverge from local conventions.
    #>
    [CmdletBinding()]
    param(
        [string]$RepoRoot = '.',
        [string]$ProtectedBranch = 'main'
    )
    Push-Location $RepoRoot
    try {
        $branch = (git symbolic-ref --short HEAD 2>$null)
        if ($branch -eq $ProtectedBranch) {
            return @{ Allowed = $false; Reason = "on protected branch '$ProtectedBranch'"; Branch = $branch }
        }
        return @{ Allowed = $true; Reason = $null; Branch = $branch }
    }
    finally { Pop-Location }
}

function Invoke-AutoWorktreeSync {
    <#
    .SYNOPSIS
        Auto-worktree workflow: create or reuse .worktrees/sdlc-sync on
        branch chore/sdlc-sync, re-invoke the sync inside it, push, and
        (unless -NoAutoPR) open a PR via gh.
    .DESCRIPTION
        Returns an integer status code:
            0 = success (PR opened OR push done with manual PR URL printed)
            5 = existing .worktrees/sdlc-sync has uncommitted work; aborted
            6 = sync inside worktree returned non-zero (passed through)
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$ProtectedBranch,
        [string]$WorktreePath = '.worktrees/sdlc-sync',
        [string]$SyncBranch = 'chore/sdlc-sync',
        [switch]$NoAutoPR,
        [hashtable]$SyncArgs = @{}
    )
    $absWorktree = Join-Path $RepoRoot $WorktreePath
    Push-Location $RepoRoot
    try {
        # Reuse-if-clean, abort-if-dirty, otherwise create.
        # A worktree directory always contains a .git FILE (not directory).
        $worktreeMarker = Join-Path $absWorktree '.git'
        $reusing = (Test-Path $worktreeMarker -PathType Leaf)
        if ($reusing) {
            Push-Location $absWorktree
            try {
                $dirty = git status --porcelain
                if ($dirty) {
                    Pop-Location
                    Write-Host ''
                    Write-Host "ABORT: existing worktree '$WorktreePath' has uncommitted changes." -ForegroundColor Red
                    Write-Host 'Resolve or remove the worktree before rerunning:' -ForegroundColor Yellow
                    Write-Host "  cd $WorktreePath; git status" -ForegroundColor Yellow
                    Write-Host "  cd $RepoRoot; git worktree remove $WorktreePath" -ForegroundColor Yellow
                    return 5
                }
            } finally { if ((Get-Location).Path -eq $absWorktree) { Pop-Location } }
            Write-Host "Reusing existing worktree '$WorktreePath' (clean)." -ForegroundColor DarkGray
        }
        else {
            Write-Host "Creating worktree '$WorktreePath' on '$SyncBranch' from '$ProtectedBranch' ..." -ForegroundColor DarkGray
            $branchListing = git branch --list $SyncBranch 2>$null
            $branchExists = $branchListing -ne $null -and ("$branchListing".Trim() -ne '')
            if ($branchExists) {
                git worktree add $absWorktree $SyncBranch | Out-Null
            } else {
                git worktree add -b $SyncBranch $absWorktree $ProtectedBranch | Out-Null
            }
        }
    }
    finally { Pop-Location }

    Push-Location $absWorktree
    try {
        Write-Host "Running sync inside worktree (branch '$SyncBranch') ..." -ForegroundColor DarkGray
        $args = @{} + $SyncArgs
        $args['RepoRoot'] = $absWorktree
        $rc = Invoke-PullSDLC @args
        if ($rc -ne 0) {
            Write-Host "Worktree sync returned rc=$rc. Aborting auto-PR." -ForegroundColor Red
            return 6
        }

        # Anything to push?
        $unpushed = git log "origin/$SyncBranch..HEAD" --oneline 2>$null
        $needsPush = $true
        $remoteHasBranch = (git ls-remote --heads origin $SyncBranch 2>$null)
        if ($remoteHasBranch -and -not $unpushed) {
            # No new commits vs remote.
            $needsPush = $false
        }
        $newCommits = git log "$ProtectedBranch..HEAD" --oneline 2>$null
        if (-not $newCommits) {
            Write-Host 'No new commits to push (worktree already in sync with main). Nothing to PR.' -ForegroundColor DarkGray
            return 0
        }

        if ($needsPush) {
            Write-Host "Pushing '$SyncBranch' to origin ..." -ForegroundColor DarkGray
            git push -u origin $SyncBranch 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "WARNING: git push failed; PR step skipped." -ForegroundColor Yellow
                return 0
            }
        }

        if ($NoAutoPR) {
            Write-Host "Skipping PR creation (-NoAutoPR)." -ForegroundColor DarkGray
            Write-Host "Open one manually: gh pr create --base $ProtectedBranch --head $SyncBranch" -ForegroundColor Yellow
            return 0
        }

        $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
        if (-not $ghCmd) {
            Write-Host 'gh CLI not found; skipping automatic PR creation.' -ForegroundColor Yellow
            $remoteUrl = (git remote get-url origin).Trim()
            $compareUrl = $remoteUrl -replace '\.git$','' -replace '^git@github\.com:','https://github.com/'
            Write-Host "Open one manually: $compareUrl/compare/${ProtectedBranch}...${SyncBranch}?expand=1" -ForegroundColor Yellow
            return 0
        }

        # Is there already an open PR for this branch?
        $existingPr = gh pr list --head $SyncBranch --base $ProtectedBranch --state open --json url 2>$null | ConvertFrom-Json
        if ($existingPr -and $existingPr.Count -gt 0) {
            Write-Host "Existing PR updated: $($existingPr[0].url)" -ForegroundColor Green
            return 0
        }

        $title = "chore: sync IntelliSDLC.ai content"
        $bodyText = "Automated sync from upstream IntelliSDLC.ai. See commit log for replayed ops.`n`nGenerated by Pull-SDLC.ai.ps1 auto-worktree mode."
        $bodyFile = Join-Path $absWorktree '.sdlc-sync-pr-body.tmp'
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($bodyFile, $bodyText, $utf8NoBom)
        try {
            $prUrl = gh pr create --base $ProtectedBranch --head $SyncBranch --title $title --body-file $bodyFile 2>&1 | Select-Object -Last 1
            if ($LASTEXITCODE -eq 0 -and $prUrl) {
                Write-Host "Opened PR: $prUrl" -ForegroundColor Green
            } else {
                Write-Host "PR creation failed: $prUrl" -ForegroundColor Yellow
            }
        }
        finally { Remove-Item $bodyFile -ErrorAction SilentlyContinue }

        return 0
    }
    finally { Pop-Location }
}

function Test-SelfRefreshRequired {
    <#
    .SYNOPSIS
        Decides whether Invoke-PullSDLC should attempt a network self-refresh
        of Pull-SDLC.ai.ps1 from upstream raw.githubusercontent.com.
    .DESCRIPTION
        Skips the refresh when any opt-out applies: -NoSelfUpdate parameter,
        $env:PULL_SDLC_NO_SELF_UPDATE, missing/empty ScriptPath, ScriptPath
        leaf is not 'Pull-SDLC.ai.ps1', running from inside .worktrees/sdlc-sync,
        or running from the upstream IntelliSDLC.ai repo itself (so upstream
        developers and tests don't have their working copy clobbered).
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyString()][AllowNull()][string]$ScriptPath,
        [switch]$NoSelfUpdate
    )
    if ($NoSelfUpdate) { return $false }
    if ($env:PULL_SDLC_NO_SELF_UPDATE) { return $false }
    if ([string]::IsNullOrWhiteSpace($ScriptPath)) { return $false }
    if (-not (Test-Path -LiteralPath $ScriptPath)) { return $false }
    if ((Split-Path -Leaf $ScriptPath) -ne 'Pull-SDLC.ai.ps1') { return $false }
    $normalized = ($ScriptPath -replace '\\', '/')
    if ($normalized -match '\.worktrees/sdlc-sync(/|$)') { return $false }
    # Never self-refresh when the script lives in the upstream repo itself.
    $scriptDir = Split-Path -Parent $ScriptPath
    if ($scriptDir) {
        $originUrl = $null
        try {
            Push-Location $scriptDir
            $originUrl = (git remote get-url origin 2>$null)
        } catch { }
        finally { Pop-Location -ErrorAction SilentlyContinue }
        if ($originUrl -and (Test-IsUpstreamRepo -RemoteUrl $originUrl)) { return $false }
    }
    return $true
}

function Invoke-SelfRefresh {
    <#
    .SYNOPSIS
        Fetches the upstream Pull-SDLC.ai.ps1 and, if its SHA256 differs from
        the local copy, atomically replaces $ScriptPath with the new content.
    .OUTPUTS
        [bool] $true if the local file was updated (caller should re-exec).
        $false if hashes match, the fetch failed, or any error occurred.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string]$Url = 'https://raw.githubusercontent.com/IntelliTect-Samples/IntelliSDLC.ai/main/Pull-SDLC.ai.ps1',
        [int]$TimeoutSec = 15
    )
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pull-sdlc-self-" + [guid]::NewGuid().ToString('N') + ".ps1")
    try {
        Invoke-WebRequest -Uri $Url -OutFile $tmp -TimeoutSec $TimeoutSec -UseBasicParsing | Out-Null
    }
    catch {
        Write-Warning "Self-update check skipped: $($_.Exception.Message)"
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        return $false
    }
    try {
        $remoteHash = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash
        $localHash = (Get-FileHash -LiteralPath $ScriptPath -Algorithm SHA256).Hash
        if ($remoteHash -eq $localHash) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            return $false
        }
        Write-Host ("Self-updated Pull-SDLC.ai.ps1 from {0} to {1}; re-running with original args" -f $localHash.Substring(0, 7), $remoteHash.Substring(0, 7)) -ForegroundColor Cyan
        Move-Item -LiteralPath $tmp -Destination $ScriptPath -Force
        return $true
    }
    catch {
        Write-Warning "Self-update check skipped: $($_.Exception.Message)"
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        return $false
    }
}

function Invoke-SelfReExec {
    <#
    .SYNOPSIS
        Re-invokes the freshly self-updated Pull-SDLC.ai.ps1 with the caller's
        original bound parameters, force-adding -NoSelfUpdate to prevent loops.
        Exits the host process with the child script's exit code.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [hashtable]$BoundParameters = @{}
    )
    $reArgs = @{} + $BoundParameters
    $reArgs['NoSelfUpdate'] = $true
    & $ScriptPath @reArgs
    exit $LASTEXITCODE
}

function Invoke-PullSDLC {
    <#
    .SYNOPSIS
        Runs the full sync (fetch -> drift guard -> compute ops -> apply ->
        commit). Returns nothing; throws on hard errors. Honors -WhatIf.
    .OUTPUTS
        An integer status code: 0 = success, 1 = bootstrap declined,
        2 = drift detected without -Force.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string]$Branch = 'main',
        [string]$RemoteName = 'sdlc.ai',
        [string]$RemoteUrl = 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git',
        [string]$RepoRoot,
        [switch]$Force,
        [switch]$Bootstrap,
        [switch]$NoPrompt,
        [switch]$NoFetch,
        [switch]$AllowDefaultBranch,
        [switch]$NoAutoWorktree,
        [switch]$NoAutoPR,
        [switch]$NoSelfUpdate
    )

    if (Test-SelfRefreshRequired -ScriptPath $PSCommandPath -NoSelfUpdate:$NoSelfUpdate) {
        if (Invoke-SelfRefresh -ScriptPath $PSCommandPath) {
            Invoke-SelfReExec -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters
            return
        }
    }

    if (-not $RepoRoot) {
        $RepoRoot = (git rev-parse --show-toplevel).Trim()
    }

    if (-not $AllowDefaultBranch -and -not $WhatIfPreference) {
        $ctx = Test-CommitContextAllowed -RepoRoot $RepoRoot -ProtectedBranch $Branch
        if (-not $ctx.Allowed) {
            if ($NoAutoWorktree) {
                Write-Host ''
                Write-Host "ABORT: cannot create sync commit -- $($ctx.Reason)." -ForegroundColor Red
                Write-Host ''
                Write-Host 'Create a worktree first:' -ForegroundColor Yellow
                Write-Host '  git worktree add .worktrees/sdlc-sync -b chore/sdlc-sync main' -ForegroundColor Yellow
                Write-Host '  cd .worktrees/sdlc-sync' -ForegroundColor Yellow
                Write-Host '  ../../Pull-SDLC.ai.ps1' -ForegroundColor Yellow
                Write-Host ''
                Write-Host 'Or rerun with -AllowDefaultBranch to bypass this check (consumers without a pre-commit hook policy).' -ForegroundColor DarkGray
                Write-Host 'Use -WhatIf to preview ops without committing.' -ForegroundColor DarkGray
                return 3
            }

            Write-Host "On protected branch '$($ctx.Branch)'. Switching to auto-worktree workflow ..." -ForegroundColor Cyan
            $syncArgs = @{
                Branch              = $Branch
                RemoteName          = $RemoteName
                Force               = [bool]$Force
                Bootstrap           = [bool]$Bootstrap
                NoPrompt            = [bool]$NoPrompt
                NoFetch             = [bool]$NoFetch
                AllowDefaultBranch  = $false
                NoAutoWorktree      = $true
            }
            return Invoke-AutoWorktreeSync -RepoRoot $RepoRoot -ProtectedBranch $Branch -NoAutoPR:$NoAutoPR -SyncArgs $syncArgs
        }
    }

    Push-Location $RepoRoot
    try {
        $existingUrl = git remote get-url $RemoteName 2>$null
        if (-not $existingUrl) {
            Write-Host "Adding remote '$RemoteName' -> $RemoteUrl"
            git remote add $RemoteName $RemoteUrl
        }
        if (-not $NoFetch) {
            Write-Host "Fetching $RemoteName ..." -ForegroundColor DarkGray
            git fetch $RemoteName --quiet
        }
    }
    finally { Pop-Location }

    $mergeRef = "$RemoteName/$Branch"

    $anchorInfo = Resolve-SyncAnchor -RepoRoot $RepoRoot -Bootstrap:$Bootstrap -NoPrompt:$NoPrompt
    if ($null -eq $anchorInfo) {
        Write-Host 'Bootstrap declined. Nothing to do.' -ForegroundColor Yellow
        return 1
    }
    $anchorSha = $anchorInfo.Sha

    if ($anchorSha) {
        $drift = @(Test-LocalDriftOnManagedPaths -Anchor $anchorSha -ManagedPaths $script:UpstreamManagedPaths -RepoRoot $RepoRoot)
        if ($drift.Count -gt 0) {
            if (-not $Force) {
                Write-Host ''
                Write-Host 'POLICY VIOLATION: upstream-managed files have local edits since last sync.' -ForegroundColor Red
                foreach ($d in $drift) {
                    Write-Host "  - $($d.Path)   (introduced by: $($d.Commit))" -ForegroundColor Red
                }
                Write-Host ''
                Write-Host 'Rerun with -Force to overwrite these with upstream contents, or revert the edits.' -ForegroundColor Yellow
                return 2
            }
            else {
                Write-Host ''
                Write-Host 'WARNING: -Force in effect. The following local edits to upstream-managed files will be OVERWRITTEN:' -ForegroundColor Yellow
                foreach ($d in $drift) {
                    Write-Host "  - $($d.Path)   (was: $($d.Commit))" -ForegroundColor Yellow
                }
                Write-Host ''
            }
        }
    }

    $ops = @(Get-UpstreamOps -Anchor $anchorSha -Ref $mergeRef -ManagedPaths $script:UpstreamManagedPaths -RepoRoot $RepoRoot)
    Push-Location $RepoRoot
    try { $upstreamHead = (git rev-parse $mergeRef).Trim() }
    finally { Pop-Location }

    $anchorLabel = if ($anchorSha) { $anchorSha.Substring(0, 7) } else { '(empty tree)' }
    $upstreamLabel = $upstreamHead.Substring(0, 7)
    Write-Host ''
    if ($ops.Count -eq 0) {
        Write-Host "Files to update: 0 (already at upstream $upstreamLabel -- nothing to sync)" -ForegroundColor Cyan
    }
    else {
        Write-Host "Files to update: $($ops.Count) (syncing $anchorLabel -> $upstreamLabel)" -ForegroundColor Cyan
    }
    $grouped = $ops | Group-Object { $_.Op } | Sort-Object Name
    foreach ($g in $grouped) {
        Write-Host ("  {0}: {1}" -f $g.Name, $g.Count) -ForegroundColor Cyan
    }
    foreach ($op in $ops) {
        $word = switch -Regex ($op.Op) {
            '^A$' { 'add' ; break }
            '^M$' { 'update' ; break }
            '^D$' { 'delete' ; break }
            '^R'  { 'rename' ; break }
            '^C'  { 'copy' ; break }
            default { $op.Op }
        }
        $col = $word.PadRight(8)
        $label = if ($op.Op -like 'R*' -or $op.Op -like 'C*') {
            "{0}{1} -> {2}" -f $col, $op.OldPath, $op.Path
        }
        else {
            "{0}{1}" -f $col, $op.Path
        }
        Write-Host "    $label" -ForegroundColor DarkGray
    }

    if ($WhatIfPreference) {
        Write-Host ''
        Write-Host '-WhatIf specified; no changes written.' -ForegroundColor Yellow
        return 0
    }

    if ($ops.Count -eq 0) {
        Write-Host ''
        Write-Host 'Already up to date.' -ForegroundColor Green
    }
    else {
        foreach ($op in $ops) {
            Invoke-UpstreamOp -Op $op -Ref $mergeRef -RepoRoot $RepoRoot
        }
        Write-Host "Applied $($ops.Count) ops." -ForegroundColor Green
    }

    Set-SdlcSyncState -RepoRoot $RepoRoot -Remote $RemoteName -Ref $Branch -Commit $upstreamHead

    Push-Location $RepoRoot
    try {
        # Only include pathspecs that actually exist in the working tree --
        # `git add` aborts the entire operation on a missing pathspec.
        $addPaths = @()
        foreach ($p in @($script:UpstreamManagedPaths + $script:SdlcSyncStateFile)) {
            if (Test-Path -LiteralPath $p) { $addPaths += $p }
        }
        if ($addPaths.Count -gt 0) {
            $addArgs = @('add', '-A', '--') + $addPaths
            & git @addArgs | Out-Null
        }
        $pending = git status --porcelain
        if ($pending) {
            $msg = "chore: sync IntelliSDLC.ai to $($upstreamHead.Substring(0,7))`n`nReplayed $($ops.Count) ops from upstream $mergeRef.`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
            $headBefore = (git rev-parse HEAD 2>$null).Trim()
            git commit -m $msg | Out-Null
            $headAfter = (git rev-parse HEAD 2>$null).Trim()
            if ($headBefore -eq $headAfter) {
                Write-Host 'ERROR: git commit did not advance HEAD. The commit was likely blocked by a pre-commit hook or branch protection.' -ForegroundColor Red
                Write-Host 'Working tree changes have been left in place for inspection. Resolve the policy violation and rerun.' -ForegroundColor Yellow
                return 4
            }
            Write-Host "Created sync commit: $(git rev-parse --short HEAD)" -ForegroundColor Green
        }
        else {
            Write-Host 'Nothing to commit.' -ForegroundColor DarkGray
        }
    }
    finally { Pop-Location }

    # Scaffold consumer-owned files from templates (first sync only).
    if (Test-IsUpstreamRepo) {
        Write-Host ''
        Write-Host "Detected upstream repo (origin -> IntelliSDLC.ai). Skipping template scaffolding." -ForegroundColor DarkGray
    }
    else {
        $scaffolded = @(Invoke-TemplateScaffold -SourceRoot $RepoRoot -TargetRoot $RepoRoot -ScaffoldMap $script:TemplateScaffoldMap)
        if ($scaffolded.Count -gt 0) {
            Write-Host ''
            Write-Host 'Scaffolded consumer-owned files from templates:' -ForegroundColor Green
            foreach ($f in $scaffolded) { Write-Host "  + $f" -ForegroundColor Green }
            Write-Host 'Open each file and fill in the sections, then commit them to your repo.' -ForegroundColor Green
        }
    }

    return 0
}

# Skip the rest of the script when dot-sourced (e.g. by tests).
if ($MyInvocation.InvocationName -eq '.') { return }

$exitCode = Invoke-PullSDLC -Branch $Branch -RemoteName $RemoteName -RemoteUrl $RemoteUrl `
    -Force:$Force -Bootstrap:$Bootstrap -NoPrompt:$NoPrompt -AllowDefaultBranch:$AllowDefaultBranch `
    -NoAutoWorktree:$NoAutoWorktree -NoAutoPR:$NoAutoPR -NoSelfUpdate:$NoSelfUpdate -WhatIf:$WhatIfPreference
exit $exitCode