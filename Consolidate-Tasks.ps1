<#
.SYNOPSIS
    Consolidates historical spec artifacts (PRDs, plans, design notes) into
    the unified tasks/ directory at the repo root.

.DESCRIPTION
    Imports files from legacy locations into tasks/<feature>-<kind>.md form,
    so a project's PRD + implementation plan + design notes live side by
    side in a single AI-replay archive. Distributed to all consumers via
    Pull-SDLC.ai.ps1.

    Source policies (configurable via switches):

      In-repo legacy sources -- MOVED via "git mv" to preserve history:
        - docs/designs/*.md                -> tasks/<date>-<feature>-plan.md
        - docs/prd/*.md                    -> tasks/<date>-<feature>-prd.md
        - root PRD.md / plan.md /
          IMPLEMENTATION_PLAN.md           -> tasks/<date>-legacy-<kind>.md

      Every imported destination is date-prefixed so the tasks/ listing sorts
      chronologically. The date is resolved (in order): a leading YYYY-MM-DD-
      prefix already in the source name; else the date of the most recent git
      commit that modified the file; else the file's last-write time. Pass
      -InsertDatePrefix:$false to suppress synthesized prefixes (an embedded
      prefix in the source name is always preserved). The resolved date is also
      recorded in the Source Date column of tasks/MIGRATION.md.

      Out-of-repo session sources -- COPIED (originals stay in place):
        - ~/.copilot/session-state/<id>/plan.md
                                           -> tasks/<date>-session-<short>-plan.md
        - ~/.claude/... (opt-in)           -> tasks/<date>-claude-<short>-plan.md

    Collision policy: if the destination exists with DIFFERENT content,
    a -<sha1-first-8> suffix is appended. If it already exists with
    IDENTICAL content, the action is skipped (idempotent).

    Writes tasks/MIGRATION.md with an audit row per action.

    Uses SupportsShouldProcess: -WhatIf is the dry run; -Confirm:$false is
    required for unattended runs because ConfirmImpact is High.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [switch]$IncludeDocsDesigns = $true,
    [switch]$IncludeDocsPrd = $true,
    [switch]$IncludeRootDocs = $true,
    [switch]$IncludeCopilotSessions = $true,
    [switch]$IncludeClaudeSessions,
    [switch]$LinkIssues = $true,
    [switch]$InsertDatePrefix = $true,
    [string]$RepoRoot,
    [string]$CopilotSessionRoot,
    [string]$ClaudeSessionRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-FeatureSlug {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FileName)
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
    $stem = $stem -replace "^\d{4}-\d{2}-\d{2}-", ""
    $stem = $stem -replace "-(prd|plan)$", ""
    if ([string]::IsNullOrWhiteSpace($stem)) { return "untitled" }
    return $stem
}

function Get-DatePrefix {
    <#
    .SYNOPSIS
        Returns the leading YYYY-MM-DD date embedded in a filename, or "" when
        none is present. The date prefix is preserved on the destination name so
        the tasks/ listing sorts chronologically.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FileName)
    if ($FileName -match "^(\d{4}-\d{2}-\d{2})-") { return $Matches[1] }
    return ""
}

function Get-GitDate {
    <#
    .SYNOPSIS
        Returns the date (yyyy-MM-dd) of the most recent commit that modified a
        file, or "" when the file is untracked, outside a repo, or git is
        unavailable. The git committer date survives copies and is more reliable
        provenance than the filesystem mtime, which is reset on clone/checkout.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $dir = Split-Path -Parent $Path
    if (-not $dir) { $dir = "." }
    try {
        $out = & git -C $dir log -1 --format=%cs -- $Path 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return ($out | Select-Object -First 1).Trim() }
    }
    catch { }
    return ""
}

function Get-SourceDate {
    <#
    .SYNOPSIS
        Returns the provenance date (yyyy-MM-dd) of a source file. Resolution
        order: (1) an embedded YYYY-MM-DD filename prefix, (2) the date of the
        most recent git commit that modified the file, (3) the file's last-write
        time (UTC). Returns "" only when none of these is available.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $prefix = Get-DatePrefix -FileName (Split-Path -Leaf $Path)
    if ($prefix) { return $prefix }
    $gitDate = Get-GitDate -Path $Path
    if ($gitDate) { return $gitDate }
    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        return $item.LastWriteTimeUtc.ToString("yyyy-MM-dd")
    }
    catch {
        return ""
    }
}

function Get-ShortHash {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha1.ComputeHash($bytes)
        $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
        return $hex.Substring(0, 8)
    }
    finally { $sha1.Dispose() }
}

function Resolve-Destination {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DestinationDir,
        [Parameter(Mandatory)][string]$BaseName,
        [Parameter(Mandatory)][string]$Extension,
        [Parameter(Mandatory)][AllowEmptyString()][string]$SourceContent
    )
    $target = Join-Path $DestinationDir ($BaseName + $Extension)
    if (-not (Test-Path -LiteralPath $target)) { return $target }
    $existing = Get-Content -LiteralPath $target -Raw -ErrorAction SilentlyContinue
    if ($null -ne $existing -and $existing -eq $SourceContent) { return $null }
    $suffix = Get-ShortHash -Text $SourceContent
    return (Join-Path $DestinationDir ("{0}-{1}{2}" -f $BaseName, $suffix, $Extension))
}

function Find-LinkedIssues {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return @() }
    $found = New-Object System.Collections.Generic.HashSet[int]
    foreach ($m in [regex]::Matches($Text, "(?i)(?:closes|fixes|refs?|resolves)\s+#(\d+)")) {
        [void]$found.Add([int]$m.Groups[1].Value)
    }
    foreach ($m in [regex]::Matches($Text, "(?<![A-Za-z0-9])#(\d+)\b")) {
        [void]$found.Add([int]$m.Groups[1].Value)
    }
    return @($found) | Sort-Object
}

function Test-CopilotSessionMatchesRepo {
    <#
    .SYNOPSIS
        Returns $true if the Copilot session directory's recorded repository
        or cwd matches the target RepoRoot.

        Looks for sidecar files repository.txt / cwd.txt inside the session
        directory. These are written by the Copilot CLI when available and
        let unit tests stub repo-scoping without a real SQLite dependency.
        If no metadata is present we conservatively SKIP (return $false).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SessionDir,
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$OriginUrl
    )
    $rootFull = (Resolve-Path -LiteralPath $RepoRoot).Path
    $candidates = @()
    foreach ($name in "repository.txt", "cwd.txt") {
        $f = Join-Path $SessionDir $name
        if (Test-Path -LiteralPath $f) {
            $candidates += (Get-Content -LiteralPath $f -Raw).Trim()
        }
    }
    if ($candidates.Count -eq 0) { return $false }
    foreach ($c in $candidates) {
        if (-not $c) { continue }
        if ($OriginUrl -and ($c -ieq $OriginUrl)) { return $true }
        try {
            $resolved = (Resolve-Path -LiteralPath $c -ErrorAction Stop).Path
            if ($resolved -ieq $rootFull) { return $true }
        }
        catch { }
        $leaf = Split-Path -Leaf $rootFull
        if ($leaf -and $c -match [regex]::Escape($leaf)) { return $true }
    }
    return $false
}

function New-MigrationRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][ValidateSet("move", "copy", "skip")] [string]$Action,
        [Parameter(Mandatory)][string]$SourceType,
        [string]$SourceDate = "",
        [int[]]$LinkedIssues = @(),
        [string]$Note = ""
    )
    return [pscustomobject]@{
        Source       = $Source
        Destination  = $Destination
        Action       = $Action
        SourceType   = $SourceType
        SourceDate   = $SourceDate
        TimestampUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        LinkedIssues = $LinkedIssues
        Note         = $Note
    }
}

function Write-MigrationManifest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Records
    )
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("# tasks/ Migration Manifest") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add("Generated by ``Consolidate-Tasks.ps1``. Each row records one import.") | Out-Null
    $lines.Add("") | Out-Null
    $lines.Add("| Timestamp (UTC) | Source Date | Action | Source Type | Source | Destination | Linked Issues | Note |") | Out-Null
    $lines.Add("|---|---|---|---|---|---|---|---|") | Out-Null
    $ordered = $Records | Sort-Object -Stable -Property `
    @{ Expression = { if ($_.SourceDate) { $_.SourceDate } else { "9999-99-99" } } }, `
    @{ Expression = { $_.Source } }
    foreach ($r in $ordered) {
        $issues = ""
        if ($r.LinkedIssues -and $r.LinkedIssues.Count -gt 0) {
            $issues = ($r.LinkedIssues | ForEach-Object { "#$_" }) -join " "
        }
        $lines.Add(("| {0} | {1} | {2} | {3} | ``{4}`` | ``{5}`` | {6} | {7} |" -f `
                $r.TimestampUtc, $r.SourceDate, $r.Action, $r.SourceType, $r.Source, $r.Destination, $issues, $r.Note)) | Out-Null
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, ($lines -join "`n") + "`n", $utf8NoBom)
}

function Import-InRepoFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$TasksDir,
        [Parameter(Mandatory)][string]$KindSuffix,
        [Parameter(Mandatory)][string]$SourceType,
        [string]$ForcedBaseName,
        [switch]$LinkIssues,
        [switch]$InsertDatePrefix,
        $ShouldProcessHandler
    )
    $content = Get-Content -LiteralPath $Source -Raw -ErrorAction Stop
    $sourceDate = Get-SourceDate -Path $Source
    $slug = if ($ForcedBaseName) { $ForcedBaseName } else { Get-FeatureSlug -FileName (Split-Path -Leaf $Source) }
    $embedded = Get-DatePrefix -FileName (Split-Path -Leaf $Source)
    $datePrefix = if ($embedded) { $embedded } elseif ($InsertDatePrefix -and $sourceDate) { $sourceDate } else { "" }
    $base = if ($datePrefix) { "$datePrefix-$slug$KindSuffix" } else { "$slug$KindSuffix" }
    $dest = Resolve-Destination -DestinationDir $TasksDir -BaseName $base -Extension ".md" -SourceContent $content
    $relSource = [System.IO.Path]::GetRelativePath($RepoRoot, $Source) -replace "\\", "/"
    if ($null -eq $dest) {
        $existingDest = Join-Path $TasksDir "$base.md"
        $relDest = [System.IO.Path]::GetRelativePath($RepoRoot, $existingDest) -replace "\\", "/"
        return New-MigrationRecord -Source $relSource -Destination $relDest `
            -Action "skip" -SourceType $SourceType -SourceDate $sourceDate `
            -Note "destination already exists with identical content"
    }
    $relDest = [System.IO.Path]::GetRelativePath($RepoRoot, $dest) -replace "\\", "/"
    $issues = @()
    if ($LinkIssues) { $issues = Find-LinkedIssues -Text $content }
    if ($ShouldProcessHandler -and -not $ShouldProcessHandler.ShouldProcess($relSource, "git mv -> $relDest")) {
        return New-MigrationRecord -Source $relSource -Destination $relDest -Action "move" `
            -SourceType $SourceType -SourceDate $sourceDate -LinkedIssues $issues -Note "planned (WhatIf)"
    }
    Push-Location $RepoRoot
    try {
        $tracked = $true
        & git ls-files --error-unmatch -- $relSource 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $tracked = $false }
        $destDir = Split-Path -Parent $dest
        if ($destDir -and -not (Test-Path -LiteralPath $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        if ($tracked) {
            & git mv -- $relSource $relDest | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "git mv failed for $relSource -> $relDest" }
        }
        else {
            Move-Item -LiteralPath $Source -Destination $dest -Force
        }
    }
    finally { Pop-Location }
    return New-MigrationRecord -Source $relSource -Destination $relDest -Action "move" `
        -SourceType $SourceType -SourceDate $sourceDate -LinkedIssues $issues
}

function Import-SessionFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$TasksDir,
        [Parameter(Mandatory)][string]$BaseName,
        [Parameter(Mandatory)][string]$KindSuffix,
        [Parameter(Mandatory)][string]$SourceType,
        [switch]$LinkIssues,
        [switch]$InsertDatePrefix,
        $ShouldProcessHandler
    )
    $content = Get-Content -LiteralPath $Source -Raw -ErrorAction Stop
    $sourceDate = Get-SourceDate -Path $Source
    $datePrefix = if ($InsertDatePrefix -and $sourceDate) { $sourceDate } else { "" }
    $base = if ($datePrefix) { "$datePrefix-$BaseName$KindSuffix" } else { "$BaseName$KindSuffix" }
    $dest = Resolve-Destination -DestinationDir $TasksDir -BaseName $base -Extension ".md" -SourceContent $content
    if ($null -eq $dest) {
        $existingDest = Join-Path $TasksDir "$base.md"
        return New-MigrationRecord -Source $Source -Destination $existingDest `
            -Action "skip" -SourceType $SourceType -SourceDate $sourceDate `
            -Note "destination already exists with identical content"
    }
    $issues = @()
    if ($LinkIssues) { $issues = Find-LinkedIssues -Text $content }
    if ($ShouldProcessHandler -and -not $ShouldProcessHandler.ShouldProcess($Source, "Copy -> $dest")) {
        return New-MigrationRecord -Source $Source -Destination $dest -Action "copy" `
            -SourceType $SourceType -SourceDate $sourceDate -LinkedIssues $issues -Note "planned (WhatIf)"
    }
    $destDir = Split-Path -Parent $dest
    if ($destDir -and -not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $Source -Destination $dest -Force
    return New-MigrationRecord -Source $Source -Destination $dest -Action "copy" `
        -SourceType $SourceType -SourceDate $sourceDate -LinkedIssues $issues
}

function Invoke-ConsolidateTasks {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [switch]$IncludeDocsDesigns,
        [switch]$IncludeDocsPrd,
        [switch]$IncludeRootDocs,
        [switch]$IncludeCopilotSessions,
        [switch]$IncludeClaudeSessions,
        [switch]$LinkIssues,
        [switch]$InsertDatePrefix,
        [string]$CopilotSessionRoot,
        [string]$ClaudeSessionRoot,
        [string]$OriginUrl
    )
    $rootFull = (Resolve-Path -LiteralPath $RepoRoot).Path
    $tasksDir = Join-Path $rootFull "tasks"
    if (-not (Test-Path -LiteralPath $tasksDir)) {
        if ($PSCmdlet.ShouldProcess($tasksDir, "Create tasks/ directory")) {
            New-Item -ItemType Directory -Path $tasksDir -Force | Out-Null
        }
        else {
            # In WhatIf mode we still need somewhere to compute paths against;
            # create a temp shadow only if it does not exist. Skip silently:
            # downstream calls will tolerate the missing directory.
        }
    }

    $records = New-Object System.Collections.Generic.List[object]

    if ($IncludeDocsDesigns) {
        $dir = Join-Path $rootFull "docs/designs"
        if (Test-Path -LiteralPath $dir) {
            Get-ChildItem -LiteralPath $dir -Filter "*.md" -File | ForEach-Object {
                $r = Import-InRepoFile -Source $_.FullName `
                    -RepoRoot $rootFull -TasksDir $tasksDir `
                    -KindSuffix "-plan" -SourceType "docs/designs" `
                    -LinkIssues:$LinkIssues -InsertDatePrefix:$InsertDatePrefix -ShouldProcessHandler $PSCmdlet
                if ($r) { $records.Add($r) | Out-Null }
            }
        }
    }

    if ($IncludeDocsPrd) {
        $dir = Join-Path $rootFull "docs/prd"
        if (Test-Path -LiteralPath $dir) {
            Get-ChildItem -LiteralPath $dir -Filter "*.md" -File | ForEach-Object {
                $r = Import-InRepoFile -Source $_.FullName `
                    -RepoRoot $rootFull -TasksDir $tasksDir `
                    -KindSuffix "-prd" -SourceType "docs/prd" `
                    -LinkIssues:$LinkIssues -InsertDatePrefix:$InsertDatePrefix -ShouldProcessHandler $PSCmdlet
                if ($r) { $records.Add($r) | Out-Null }
            }
        }
    }

    if ($IncludeRootDocs) {
        $rootMap = [ordered]@{
            "PRD.md"                 = "-prd"
            "plan.md"                = "-plan"
            "IMPLEMENTATION_PLAN.md" = "-plan"
        }
        foreach ($name in $rootMap.Keys) {
            $src = Join-Path $rootFull $name
            if (Test-Path -LiteralPath $src) {
                $r = Import-InRepoFile -Source $src `
                    -RepoRoot $rootFull -TasksDir $tasksDir `
                    -KindSuffix $rootMap[$name] -SourceType "root-doc" `
                    -ForcedBaseName "legacy" `
                    -LinkIssues:$LinkIssues -InsertDatePrefix:$InsertDatePrefix -ShouldProcessHandler $PSCmdlet
                if ($r) { $records.Add($r) | Out-Null }
            }
        }
    }

    if ($IncludeCopilotSessions) {
        $sessionRoot = if ($CopilotSessionRoot) { $CopilotSessionRoot } else { Join-Path $HOME ".copilot/session-state" }
        if (Test-Path -LiteralPath $sessionRoot) {
            Get-ChildItem -LiteralPath $sessionRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                $plan = Join-Path $_.FullName "plan.md"
                if (-not (Test-Path -LiteralPath $plan)) { return }
                if (-not (Test-CopilotSessionMatchesRepo -SessionDir $_.FullName -RepoRoot $rootFull -OriginUrl $OriginUrl)) {
                    return
                }
                $short = if ($_.Name.Length -ge 8) { $_.Name.Substring(0, 8) } else { $_.Name }
                $base = "session-$short"
                $r = Import-SessionFile -Source $plan `
                    -TasksDir $tasksDir -BaseName $base -KindSuffix "-plan" `
                    -SourceType "copilot-session" `
                    -LinkIssues:$LinkIssues -InsertDatePrefix:$InsertDatePrefix -ShouldProcessHandler $PSCmdlet
                if ($r) { $records.Add($r) | Out-Null }
            }
        }
    }

    if ($IncludeClaudeSessions) {
        $sessionRoot = if ($ClaudeSessionRoot) { $ClaudeSessionRoot } else { Join-Path $HOME ".claude" }
        if (Test-Path -LiteralPath $sessionRoot) {
            Get-ChildItem -LiteralPath $sessionRoot -File -Recurse -Filter "*plan*.md" -ErrorAction SilentlyContinue | ForEach-Object {
                $short = Get-ShortHash -Text $_.FullName
                $base = "claude-$short"
                $r = Import-SessionFile -Source $_.FullName `
                    -TasksDir $tasksDir -BaseName $base -KindSuffix "-plan" `
                    -SourceType "claude-session" `
                    -LinkIssues:$LinkIssues -InsertDatePrefix:$InsertDatePrefix -ShouldProcessHandler $PSCmdlet
                if ($r) { $records.Add($r) | Out-Null }
            }
        }
    }

    if ($records.Count -gt 0) {
        $manifestPath = Join-Path $tasksDir "MIGRATION.md"
        if ($PSCmdlet.ShouldProcess($manifestPath, "Write migration manifest")) {
            Write-MigrationManifest -Path $manifestPath -Records $records.ToArray()
        }
    }

    return $records.ToArray()
}

if ($MyInvocation.InvocationName -ne ".") {
    if (-not $RepoRoot) {
        $top = (& git rev-parse --show-toplevel 2>$null)
        if ($LASTEXITCODE -eq 0 -and $top) {
            $RepoRoot = $top.Trim()
        }
        else {
            $RepoRoot = (Get-Location).Path
        }
    }
    $originUrl = $null
    try {
        $tmp = (& git -C $RepoRoot remote get-url origin 2>$null)
        if ($LASTEXITCODE -eq 0 -and $tmp) { $originUrl = $tmp.Trim() }
    }
    catch { }

    $records = Invoke-ConsolidateTasks `
        -RepoRoot $RepoRoot `
        -IncludeDocsDesigns:$IncludeDocsDesigns `
        -IncludeDocsPrd:$IncludeDocsPrd `
        -IncludeRootDocs:$IncludeRootDocs `
        -IncludeCopilotSessions:$IncludeCopilotSessions `
        -IncludeClaudeSessions:$IncludeClaudeSessions `
        -LinkIssues:$LinkIssues `
        -InsertDatePrefix:$InsertDatePrefix `
        -CopilotSessionRoot $CopilotSessionRoot `
        -ClaudeSessionRoot $ClaudeSessionRoot `
        -OriginUrl $originUrl `
        -WhatIf:$WhatIfPreference

    if (-not $records -or $records.Count -eq 0) {
        Write-Host "Consolidate-Tasks: no legacy spec artifacts found. Nothing to import." -ForegroundColor DarkGray
    }
    else {
        $records | Format-Table -AutoSize Action, SourceType, Source, Destination
        Write-Host ("Consolidate-Tasks: {0} action(s) recorded in tasks/MIGRATION.md." -f $records.Count) -ForegroundColor Green
    }
}