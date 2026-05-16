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
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Branch = 'main',
    [string]$RemoteName = 'sdlc.ai',
    [switch]$Force,
    [switch]$Bootstrap,
    [switch]$NoPrompt
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
        [switch]$NoFetch
    )

    if (-not $RepoRoot) {
        $RepoRoot = (git rev-parse --show-toplevel).Trim()
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
    Write-Host ''
    Write-Host "Planned ops ($($ops.Count)) from $anchorLabel -> $($upstreamHead.Substring(0,7)):" -ForegroundColor Cyan
    $grouped = $ops | Group-Object { $_.Op } | Sort-Object Name
    foreach ($g in $grouped) {
        Write-Host ("  {0}: {1}" -f $g.Name, $g.Count) -ForegroundColor Cyan
    }
    foreach ($op in $ops) {
        $label = switch ($op.Op) {
            'R' { "R  $($op.OldPath) -> $($op.Path)" }
            'C' { "C  $($op.OldPath) -> $($op.Path)" }
            default { "$($op.Op)  $($op.Path)" }
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
            git commit -m $msg | Out-Null
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
    -Force:$Force -Bootstrap:$Bootstrap -NoPrompt:$NoPrompt -WhatIf:$WhatIfPreference
exit $exitCode