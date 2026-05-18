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
    '.gitattributes.template'                               = '.gitattributes'
    'tasks/README.md.template'                              = 'tasks/README.md'
}

# Paths (file or directory prefixes) that upstream owns. Anything under one
# of these is subject to diff-replay against upstream/<Branch>.
$script:UpstreamManagedPaths = @(
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    '.gitattributes.template',
    '.github/agents/',
    '.github/skills/',
    '.github/instructions/',
    'tasks/'
)

# Paths that are inherently consumer-owned. Always-local trumps managed-paths
# (e.g. .github/instructions/project.instructions.md sits under the managed
# .github/instructions/ tree but is filtered out of the op list).
$script:AlwaysLocalPaths = @(
    'README.md',
    '.github/instructions/project.instructions.md',
    'CLAUDE.project.md',
    '.gitattributes',
    '.sdlc-ai-sync.json',
    'tasks/'
)

# Paths whose upstream content is union-merged into the consumer's copy rather
# than overwritten (managed-paths) or left alone (always-local). The consumer
# keeps any local entries; any new upstream entries are appended. Today this is
# used only for .gitignore -- upstream is the single source of truth for
# sdlc.ai-mandated ignore patterns (.evidence/, .playwright-mcp/, .worktrees/,
# etc.) and consumers receive new patterns automatically as upstream evolves.
$script:MergePaths = @(
    '.gitignore'
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
        list. Entries ending in '/' are treated as directory prefixes
        (anything under them is consumer-owned), with one carve-out: files
        whose leaf name ends in '.template' or is exactly '.gitkeep' are
        upstream-managed even when they live inside a consumer-owned
        directory prefix (so first-time scaffolds and directory anchors can
        still flow from upstream). Other entries match exactly.
        Comparison is case-insensitive and tolerates ./ or .\ prefix.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    foreach ($candidate in $script:AlwaysLocalPaths) {
        $cc = $candidate -replace '\\', '/'
        if ($cc.EndsWith('/')) {
            if ($n.StartsWith($cc, [System.StringComparison]::OrdinalIgnoreCase)) {
                $leaf = Split-Path -Leaf $n
                if ($leaf.EndsWith('.template', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                if ([string]::Equals($leaf, '.gitkeep', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                return $true
            }
        }
        else {
            if ([string]::Equals($n, $cc, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
    }
    return $false
}

function Test-IsUpstreamManagedPath {
    <#
    .SYNOPSIS
        Returns $true if the given path is under an upstream-managed prefix
        AND not on the always-local or merge-paths list. Always-local and
        merge-paths trump managed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    if (Test-IsAlwaysLocalPath -Path $n) { return $false }
    if (Test-IsMergePath -Path $n) { return $false }
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

function Test-IsMergePath {
    <#
    .SYNOPSIS
        Returns $true if the given repo-relative path is on the merge-paths
        list (upstream content union-merged into the consumer's copy).
        Comparison is case-insensitive and tolerates ./ or .\ prefix.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    foreach ($candidate in $script:MergePaths) {
        if ([string]::Equals($n, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
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

function ConvertTo-GitignoreChunk {
    <#
    .SYNOPSIS
        Parses .gitignore text into ordered chunks. Each chunk is a contiguous
        run of comment lines (lines beginning with '#') followed by a
        contiguous run of entry lines (non-blank, non-comment). Blank lines
        and EOF terminate a chunk. A chunk may have only comments, only
        entries, or both -- but the comments always precede the entries.
    .OUTPUTS
        Array of hashtables: @{ Comments = [string[]]; Entries = [string[]] }.
        Order matches input order.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $lines = $Text -split "`r?`n"
    $chunks = New-Object System.Collections.Generic.List[hashtable]
    $current = @{ Comments = [System.Collections.Generic.List[string]]::new(); Entries = [System.Collections.Generic.List[string]]::new() }
    $flush = {
        if ($current.Comments.Count -gt 0 -or $current.Entries.Count -gt 0) {
            $chunks.Add(@{
                Comments = $current.Comments.ToArray()
                Entries  = $current.Entries.ToArray()
            }) | Out-Null
        }
        $script:__convertCurrent = @{ Comments = [System.Collections.Generic.List[string]]::new(); Entries = [System.Collections.Generic.List[string]]::new() }
    }
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if (-not $trim) {
            & $flush
            $current = $script:__convertCurrent
            continue
        }
        if ($trim.StartsWith('#')) {
            if ($current.Entries.Count -gt 0) {
                & $flush
                $current = $script:__convertCurrent
            }
            $current.Comments.Add($line) | Out-Null
        }
        else {
            $current.Entries.Add($line) | Out-Null
        }
    }
    & $flush
    Remove-Variable -Name __convertCurrent -Scope Script -ErrorAction SilentlyContinue
    return $chunks.ToArray()
}

function Get-GitignoreLineEnding {
    <#
    .SYNOPSIS
        Detects whether the file at $Path uses CRLF or LF line endings.
        Returns "`r`n" or "`n". Default LF when the file is missing, empty,
        or contains no line breaks.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return "`n" }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return "`n" }
    # CRLF detection: any CR (0x0D) followed by LF (0x0A) in the file.
    for ($i = 0; $i -lt $bytes.Length - 1; $i++) {
        if ($bytes[$i] -eq 13 -and $bytes[$i + 1] -eq 10) { return "`r`n" }
    }
    return "`n"
}

function Remove-UpstreamOnlyMarkerBlocks {
    <#
    .SYNOPSIS
        Strips upstream-only marker blocks from .gitignore text before it is
        propagated to a consumer. A block starts with a comment line matching
        `^#\s*>>>\s*upstream-only\s*>>>` and ends with the matching closer
        `^#\s*<<<\s*upstream-only\s*<<<` (case-insensitive). The markers and
        every line between them are dropped. If the closing marker is missing,
        everything from the opening marker to end of file is dropped
        (defensive: never leak upstream-only entries downstream just because
        someone forgot the closer).
    .OUTPUTS
        [string] the input text with all upstream-only blocks removed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $openRe  = '^\s*#\s*>>>\s*upstream-only\s*>>>'
    $closeRe = '^\s*#\s*<<<\s*upstream-only\s*<<<'
    $opts = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    $lines = $Text -split "`r?`n"
    $out = New-Object System.Collections.Generic.List[string]
    $inBlock = $false
    foreach ($line in $lines) {
        if (-not $inBlock) {
            if ([regex]::IsMatch($line, $openRe, $opts)) {
                $inBlock = $true
                continue
            }
            $out.Add($line) | Out-Null
        }
        else {
            if ([regex]::IsMatch($line, $closeRe, $opts)) {
                $inBlock = $false
            }
            # else: still inside block, drop the line.
        }
    }
    return ($out -join "`n")
}

function Merge-FileFromUpstream {
    <#
    .SYNOPSIS
        Union-merges an upstream file's content into the consumer's copy.
        Today only supports .gitignore (chunked comment-block + entry
        semantics). Creates the local file if absent. Idempotent.
    .DESCRIPTION
        Reads the upstream file via `git show $Ref:$Path`. Parses both the
        upstream and the local copy into (comment-block + entry) chunks.
        For each upstream chunk: drops any entries already present in the
        local file; if no entries remain, drops the whole chunk. Surviving
        chunks are appended to the local file (or written as the new file
        if no local copy existed).

        Upstream-only marker blocks (lines between `# >>> upstream-only >>>`
        and `# <<< upstream-only <<<`, case-insensitive) are stripped from
        the upstream text before chunking, so entries inside the markers
        are never propagated to the consumer. An unterminated marker drops
        everything from the opener to end of file.

        Line endings are preserved -- if the local file uses CRLF, the
        appended content uses CRLF; otherwise LF.
    .OUTPUTS
        [bool] $true if the local file was modified (or created); $false
        when no changes were needed (already in sync).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    Push-Location $RepoRoot
    try {
        $upstreamRaw = & git show "${Ref}:${Path}" 2>$null
        if ($LASTEXITCODE -ne 0 -or $null -eq $upstreamRaw) { return $false }
    }
    finally { Pop-Location }

    $upstreamText = if ($upstreamRaw -is [array]) { $upstreamRaw -join "`n" } else { [string]$upstreamRaw }
    $upstreamText = Remove-UpstreamOnlyMarkerBlocks -Text $upstreamText
    $upstreamChunks = ConvertTo-GitignoreChunk -Text $upstreamText

    $localAbs = Join-Path $RepoRoot $Path
    $localExists = Test-Path -LiteralPath $localAbs
    $localText = if ($localExists) { Get-Content -LiteralPath $localAbs -Raw } else { '' }
    if ($null -eq $localText) { $localText = '' }
    $localChunks = ConvertTo-GitignoreChunk -Text $localText

    $localEntrySet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($chunk in $localChunks) {
        foreach ($entry in $chunk.Entries) {
            $localEntrySet.Add($entry.Trim()) | Out-Null
        }
    }

    $additions = New-Object System.Collections.Generic.List[string]
    foreach ($chunk in $upstreamChunks) {
        if ($chunk.Entries.Count -eq 0) { continue }   # comment-only chunk -- skip
        $missing = New-Object System.Collections.Generic.List[string]
        foreach ($entry in $chunk.Entries) {
            if (-not $localEntrySet.Contains($entry.Trim())) {
                $missing.Add($entry) | Out-Null
            }
        }
        if ($missing.Count -eq 0) { continue }
        if ($additions.Count -gt 0 -or $localExists) {
            $additions.Add('') | Out-Null
        }
        foreach ($c in $chunk.Comments) { $additions.Add($c) | Out-Null }
        foreach ($e in $missing) { $additions.Add($e) | Out-Null }
    }

    if ($additions.Count -eq 0) { return $false }

    $eol = Get-GitignoreLineEnding -Path $localAbs
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $trimmedLocal = if ($localExists) { $localText.TrimEnd("`r", "`n") } else { '' }
    $newContent = if ($trimmedLocal) {
        $trimmedLocal + $eol + ($additions -join $eol) + $eol
    } else {
        ($additions -join $eol) + $eol
    }
    $localDir = Split-Path -Parent $localAbs
    if ($localDir -and -not (Test-Path -LiteralPath $localDir)) {
        New-Item -ItemType Directory -Path $localDir -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($localAbs, $newContent, $utf8NoBom)
    return $true
}

function Invoke-MainTreeCleanup {
    <#
    .SYNOPSIS
        Restores a parent (typically `main`) working tree to a clean state
        after a successful auto-worktree sync. For every manifest path that
        the user dropped into the parent tree to bootstrap the script
        (Pull-SDLC.ai.ps1, Cleanup-Worktree.ps1, etc.), if the local copy is
        byte-identical to upstream the script either deletes it (untracked
        case -- PR merge will restore as tracked) or `git checkout`s it
        (tracked-but-modified case). When local content differs from
        upstream, the file is left in place and a warning is printed.
    .OUTPUTS
        Array of strings describing each action taken (for caller logging /
        test inspection). Empty when nothing needed cleanup.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$UpstreamRef,
        [string[]]$Candidates = @(
            'Pull-SDLC.ai.ps1',
            'Pull-SDLC.ai.Tests.ps1',
            'Cleanup-Worktree.ps1',
            'Consolidate-Tasks.ps1',
            'Consolidate-Tasks.Tests.ps1',
            'sync-manifest.json'
        )
    )
    $actions = New-Object System.Collections.Generic.List[string]
    Push-Location $RepoRoot
    try {
        $porcelain = git status --porcelain 2>$null
        $untracked = @()
        $modified = @()
        foreach ($line in $porcelain) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            if ($line.Length -lt 4) { continue }
            $xy = $line.Substring(0, 2)
            $path = $line.Substring(3).Trim('"')
            if ($xy -eq '??') { $untracked += $path }
            elseif ($xy[1] -eq 'M' -or $xy[0] -eq 'M') { $modified += $path }
        }

        foreach ($path in $Candidates) {
            $abs = Join-Path $RepoRoot $path
            if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { continue }
            $isUntracked = ($untracked -contains $path)
            $isModified = ($modified -contains $path)
            if (-not ($isUntracked -or $isModified)) { continue }

            $upstreamSha = (& git rev-parse "${UpstreamRef}:${path}" 2>$null)
            if (-not $upstreamSha -or $LASTEXITCODE -ne 0) { continue }
            $localSha = (& git hash-object -- $abs 2>$null)
            if (-not $localSha) { continue }

            if ($localSha.Trim() -eq $upstreamSha.Trim()) {
                if ($isUntracked) {
                    if ($PSCmdlet.ShouldProcess($path, 'Remove untracked-and-identical file')) {
                        Remove-Item -LiteralPath $abs -Force
                        $msg = "Cleanup: removed untracked '$path' (byte-identical to upstream; PR merge will restore tracked)."
                        Write-Host $msg -ForegroundColor DarkGray
                        $actions.Add($msg) | Out-Null
                    }
                }
                else {
                    if ($PSCmdlet.ShouldProcess($path, 'Revert tracked-and-modified-to-identical file')) {
                        & git checkout -- $path 2>$null | Out-Null
                        $msg = "Cleanup: reverted '$path' to HEAD (working tree was modified but identical to upstream)."
                        Write-Host $msg -ForegroundColor DarkGray
                        $actions.Add($msg) | Out-Null
                    }
                }
            }
            else {
                $msg = "Cleanup: '$path' has local changes that differ from upstream; left in place."
                Write-Warning $msg
                $actions.Add($msg) | Out-Null
            }
        }
    }
    finally { Pop-Location }
    return $actions.ToArray()
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
        # Drop ops whose primary path is always-local or merge-managed. For
        # R/C, also drop if the OldPath is always-local or merge-managed
        # (don't delete consumer-owned or merged files).
        if (Test-IsAlwaysLocalPath -Path $entry.Path) { continue }
        if (Test-IsMergePath -Path $entry.Path) { continue }
        if ($entry.OldPath -and (Test-IsAlwaysLocalPath -Path $entry.OldPath)) { continue }
        if ($entry.OldPath -and (Test-IsMergePath -Path $entry.OldPath)) { continue }
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
        (unless -NoAutoPR) open a PR via gh. The sdlc-sync worktree is
        treated as pure scratch: any dirty state or stale unpushed commits
        from a prior interrupted run are discarded by an unconditional
        reset-hard + clean to ProtectedBranch before the sync replays.
    .DESCRIPTION
        Returns an integer status code:
            0 = success (PR opened OR push done with manual PR URL printed)
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
        # The sdlc-sync worktree is pure scratch -- every file in it is
        # regenerated from upstream on each run. So when reusing an existing
        # worktree we unconditionally reset it to ProtectedBranch and clean
        # untracked files. This makes Pull-SDLC.ai.ps1 self-healing across
        # interrupted prior runs, stale unpushed commits, half-applied
        # patches, etc. The branch HEAD will be rebuilt by the sync run that
        # follows; if a PR is already open against origin/$SyncBranch, the
        # subsequent push will simply update it.
        # A worktree directory always contains a .git FILE (not directory).
        $worktreeMarker = Join-Path $absWorktree '.git'
        $reusing = (Test-Path $worktreeMarker -PathType Leaf)
        if ($reusing) {
            Push-Location $absWorktree
            try {
                $dirty = git status --porcelain
                $aheadOfMain = git log "$ProtectedBranch..HEAD" --oneline 2>$null
                if ($dirty -or $aheadOfMain) {
                    Write-Host "Resetting reused worktree '$WorktreePath' to '$ProtectedBranch' (scratch area; prior state discarded)." -ForegroundColor DarkGray
                    git reset --hard $ProtectedBranch 2>&1 | Out-Null
                    git clean -fdx 2>&1 | Out-Null
                } else {
                    Write-Host "Reusing existing worktree '$WorktreePath' (clean)." -ForegroundColor DarkGray
                }
            } finally { if ((Get-Location).Path -eq $absWorktree) { Pop-Location } }
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
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false }
        return $false
    }
    try {
        $remoteHash = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash
        $localHash = (Get-FileHash -LiteralPath $ScriptPath -Algorithm SHA256).Hash
        if ($remoteHash -eq $localHash) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false
            return $false
        }
        Write-Host ("Self-updated Pull-SDLC.ai.ps1 from {0} to {1}; re-running with original args" -f $localHash.Substring(0, 7), $remoteHash.Substring(0, 7)) -ForegroundColor Cyan
        Move-Item -LiteralPath $tmp -Destination $ScriptPath -Force -WhatIf:$false -Confirm:$false
        return $true
    }
    catch {
        Write-Warning "Self-update check skipped: $($_.Exception.Message)"
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false }
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

function Invoke-SelfRefreshGate {
    <#
    .SYNOPSIS
        Top-level self-refresh check for Pull-SDLC.ai.ps1. If an upstream
        update is available and successfully applied, re-execs the script
        with the supplied bound parameters and never returns.
    .DESCRIPTION
        Must be called from the script's top level (NOT from inside
        Invoke-PullSDLC). The `$BoundParameters` argument must be the
        script's outer `$PSBoundParameters` so every key is, by
        definition, bindable to the freshly-downloaded script on re-exec.

        See issue #110: invoking this from inside Invoke-PullSDLC caused
        function-only parameters such as `RemoteUrl` to leak into the
        splat, breaking re-exec on the outer script (which has no
        `RemoteUrl` parameter).
    .OUTPUTS
        [bool] $true if a re-exec was attempted (in production this path
        never returns; mocks may return synchronously). $false if no
        update was needed or the refresh failed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$ScriptPath,
        [hashtable]$BoundParameters = @{},
        [switch]$NoSelfUpdate
    )
    if (Test-SelfRefreshRequired -ScriptPath $ScriptPath -NoSelfUpdate:$NoSelfUpdate) {
        if (Invoke-SelfRefresh -ScriptPath $ScriptPath) {
            Invoke-SelfReExec -ScriptPath $ScriptPath -BoundParameters $BoundParameters
            return $true
        }
    }
    return $false
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
            $rc = Invoke-AutoWorktreeSync -RepoRoot $RepoRoot -ProtectedBranch $Branch -NoAutoPR:$NoAutoPR -SyncArgs $syncArgs
            if ($rc -eq 0) {
                # After a successful worktree sync, clean up the parent tree:
                # delete untracked-and-identical bootstrap files (PR merge will
                # restore them tracked), revert tracked-modified-to-identical
                # files, leave real local edits alone with a warning.
                $null = Invoke-MainTreeCleanup -RepoRoot $RepoRoot -UpstreamRef "$RemoteName/$Branch"
            }
            return $rc
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

    # Union-merge merge-managed files (today: .gitignore). Done after the
    # main op loop so the merge always sees the latest upstream blob. The
    # merge is idempotent -- a no-op when local already contains every
    # upstream entry.
    $mergedPaths = New-Object System.Collections.Generic.List[string]
    foreach ($mp in $script:MergePaths) {
        if (Merge-FileFromUpstream -Path $mp -Ref $mergeRef -RepoRoot $RepoRoot) {
            $mergedPaths.Add($mp) | Out-Null
            Write-Host "Merged upstream entries into $mp" -ForegroundColor Green
        }
    }

    Set-SdlcSyncState -RepoRoot $RepoRoot -Remote $RemoteName -Ref $Branch -Commit $upstreamHead

    Push-Location $RepoRoot
    try {
        # Only include pathspecs that actually exist in the working tree --
        # `git add` aborts the entire operation on a missing pathspec. We add
        # both upstream-managed paths and any merge-managed file we touched.
        $addPaths = @()
        foreach ($p in @($script:UpstreamManagedPaths + $script:SdlcSyncStateFile + $mergedPaths.ToArray())) {
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

# Self-refresh check at script top level (issue #110). `$PSBoundParameters`
# here is the script's outer bound params, so every key is guaranteed to be
# bindable to the freshly-downloaded script on re-exec.
if (Invoke-SelfRefreshGate -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -NoSelfUpdate:$NoSelfUpdate) {
    exit $LASTEXITCODE
}

$exitCode = Invoke-PullSDLC -Branch $Branch -RemoteName $RemoteName -RemoteUrl $RemoteUrl `
    -Force:$Force -Bootstrap:$Bootstrap -NoPrompt:$NoPrompt -AllowDefaultBranch:$AllowDefaultBranch `
    -NoAutoWorktree:$NoAutoWorktree -NoAutoPR:$NoAutoPR -NoSelfUpdate:$NoSelfUpdate -WhatIf:$WhatIfPreference
exit $exitCode