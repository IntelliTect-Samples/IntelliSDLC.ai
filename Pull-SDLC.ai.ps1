<#
.SYNOPSIS
    Syncs shared AI instruction files from IntelliSDLC.ai into this project.

.DESCRIPTION
    Adds IntelliTect-Dev/IntelliSDLC.ai as a git remote named 'sdlc.ai'
    (if not already present) and merges the latest changes from its main branch.

    Uses --allow-unrelated-histories for the initial merge, and --no-ff to keep
    a clear merge commit on subsequent syncs.

    The files in $script:AlwaysLocalPaths (README.md and .gitignore) are
    treated as consumer-owned and immune to upstream syncs: any conflict on
    those paths -- whether an untracked-file overwrite, a tracked content
    conflict (UU), or a modify/delete (UD/DU) -- is force-resolved to the
    local version with no prompt and no diff.

.PARAMETER Branch
    The upstream branch to merge from. Default: main.

.PARAMETER RemoteName
    Name for the git remote. Default: sdlc.ai.

.EXAMPLE
    ./Pull-SDLC.ai.ps1

.EXAMPLE
    ./Pull-SDLC.ai.ps1 -Branch develop
#>
[CmdletBinding()]
param(
    [string]$Branch = 'main',
    [string]$RemoteName = 'sdlc.ai'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteUrl = 'https://github.com/IntelliTect-Dev/IntelliSDLC.ai.git'

# Map of <template path> -> <bare target path> used to scaffold consumer-owned
# files on first sync. Defined at script scope so tests can dot-source and use it.
$script:TemplateScaffoldMap = [ordered]@{
    '.github/instructions/project.instructions.md.template' = '.github/instructions/project.instructions.md'
    'CLAUDE.project.md.template'                            = 'CLAUDE.project.md'
}

# Repo-relative paths that are inherently consumer-owned. The upstream copies
# act as templates only; once a consumer fills them in, an instructions sync
# must never overwrite or prompt about them. Compared case-insensitively.
$script:AlwaysLocalPaths = @('README.md', '.gitignore')

function Test-IsAlwaysLocalPath {
    <#
    .SYNOPSIS
        Returns $true if the given repo-relative path is on the always-local
        list (README.md, .gitignore). Comparison is case-insensitive and
        tolerates a leading './' or '.\' prefix.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Path
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $normalized = $Path -replace '\\', '/'
    if ($normalized.StartsWith('./')) { $normalized = $normalized.Substring(2) }
    foreach ($candidate in $script:AlwaysLocalPaths) {
        if ([string]::Equals($normalized, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Resolve-AlwaysLocalConflicts {
    <#
    .SYNOPSIS
        Given the output of `git status --porcelain` as a string array, returns
        the repo-relative paths of conflicted files that should be force-kept
        as the local version because they are on the always-local list.

    .DESCRIPTION
        Pure classifier - performs no git operations. Caller is responsible for
        running `git checkout --ours -- <path>` and `git add` on each returned
        path. Recognises any conflict status (XY contains 'U', or 'AA'/'DD').
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Porcelain
    )
    $resolved = New-Object System.Collections.Generic.List[string]
    foreach ($line in $Porcelain) {
        if ($null -eq $line -or $line.Length -lt 4) { continue }
        $xy = $line.Substring(0, 2)
        $isConflict = ($xy -eq 'AA') -or ($xy -eq 'DD') -or
                      ($xy[0] -eq 'U') -or ($xy[1] -eq 'U')
        if (-not $isConflict) { continue }
        $path = $line.Substring(3).Trim('"')
        if (Test-IsAlwaysLocalPath -Path $path) {
            $resolved.Add($path) | Out-Null
        }
    }
    return $resolved.ToArray()
}

function Test-IsUpstreamRepo {
    <#
    .SYNOPSIS
        Returns $true when the current working directory is the upstream
        IntelliSDLC.ai repo itself, $false otherwise. Used to skip
        template scaffolding when the script runs against its own source.
    #>
    [CmdletBinding()]
    param(
        [string]$RemoteUrl = (git remote get-url origin 2>$null)
    )
    if (-not $RemoteUrl) { return $false }
    return $RemoteUrl -match 'IntelliSDLC\.ai(\.git)?/?$'
}

function Invoke-TemplateScaffold {
    <#
    .SYNOPSIS
        Copies each *.template file from $SourceRoot to its bare-named target
        under $TargetRoot, skipping any target that already exists.
    .OUTPUTS
        [string[]] Relative paths of the targets that were created.
    #>
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

# Skip the rest of the script when dot-sourced (e.g. by tests).
if ($MyInvocation.InvocationName -eq '.') { return }

# Add remote if it doesn't exist
$existingUrl = git remote get-url $RemoteName 2>$null
if (-not $existingUrl) {
    Write-Host "Adding remote '$RemoteName' -> $RemoteUrl"
    git remote add $RemoteName $RemoteUrl
}

git fetch $RemoteName

# Resolve untracked working-tree files that would be overwritten by the merge.
# For each conflicting untracked file:
#   - If its content matches the incoming version, delete it (merge will add it cleanly).
#   - Otherwise, show the diff and prompt the user to choose which version to keep.
$mergeRef = "$RemoteName/$Branch"
$untracked = git ls-files --others --exclude-standard
$restoreLocal = @{}
if ($untracked) {
    $incoming = git ls-tree -r --name-only $mergeRef
    $incomingSet = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]$incoming, [System.StringComparer]::OrdinalIgnoreCase)

    foreach ($file in $untracked) {
        if (-not $incomingSet.Contains($file)) { continue }

        $localHash = (git hash-object -- $file).Trim()
        $incomingHash = (git rev-parse "${mergeRef}:${file}" 2>$null).Trim()

        if ($localHash -eq $incomingHash) {
            Write-Host "Removing untracked '$file' (identical to incoming version)."
            Remove-Item -LiteralPath $file -Force
            continue
        }

        # Always-local paths (README.md, .gitignore) short-circuit the prompt:
        # save local content, remove the file so the merge can proceed, then
        # restore it after the merge. No diff, no Read-Host.
        if (Test-IsAlwaysLocalPath -Path $file) {
            $savedPath = [System.IO.Path]::GetTempFileName()
            Copy-Item -LiteralPath $file -Destination $savedPath -Force
            $restoreLocal[$file] = $savedPath
            Remove-Item -LiteralPath $file -Force
            Write-Host "Auto-keeping local '$file' (always-local policy; no prompt)." -ForegroundColor Cyan
            continue
        }

        # Extract the incoming version to a temp file and show the diff against local.
        $tempIncoming = [System.IO.Path]::GetTempFileName()
        try {
            git show "${mergeRef}:${file}" | Out-File -LiteralPath $tempIncoming -Encoding utf8

            while ($true) {
                Write-Host ""
                Write-Host "=== Conflict on untracked file: $file ===" -ForegroundColor Yellow
                Write-Host "(< local, > incoming from $mergeRef)" -ForegroundColor DarkGray
                git --no-pager diff --no-index --color=always -- $file $tempIncoming
                Write-Host ""
                $choice = Read-Host "Keep [L]ocal, use [I]ncoming, [D]iff again, or [A]bort?"
                switch -Regex ($choice) {
                    '^[Ll]' {
                        # Save local content; remove file so merge can proceed; restore after merge.
                        $savedPath = [System.IO.Path]::GetTempFileName()
                        Copy-Item -LiteralPath $file -Destination $savedPath -Force
                        $restoreLocal[$file] = $savedPath
                        Remove-Item -LiteralPath $file -Force
                        Write-Host "Will keep local '$file' (restored after merge; working tree will differ from merge commit)." -ForegroundColor Cyan
                        break
                    }
                    '^[Ii]' {
                        Remove-Item -LiteralPath $file -Force
                        Write-Host "Will take incoming '$file'." -ForegroundColor Cyan
                        break
                    }
                    '^[Dd]' { continue }
                    '^[Aa]' {
                        Write-Host "Aborting sync at user request." -ForegroundColor Red
                        exit 1
                    }
                    default {
                        Write-Host "Unrecognized choice. Please enter L, I, D, or A." -ForegroundColor Red
                        continue
                    }
                }
                break
            }
        }
        finally {
            if (Test-Path -LiteralPath $tempIncoming) { Remove-Item -LiteralPath $tempIncoming -Force }
        }
    }
}

# Run merge with native-command error preference disabled so we can inspect
# conflicts (a non-zero exit from merge-with-conflicts is expected, not fatal).
$prevNativeErrorPref = $null
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) {
    $prevNativeErrorPref = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
}
try {
    git merge $mergeRef --no-ff --allow-unrelated-histories
    $mergeExit = $LASTEXITCODE
}
finally {
    if ($null -ne $prevNativeErrorPref) {
        $PSNativeCommandUseErrorActionPreference = $prevNativeErrorPref
    }
}

# Restore any files the user chose to keep local (overwrites what the merge applied).
foreach ($entry in $restoreLocal.GetEnumerator()) {
    Copy-Item -LiteralPath $entry.Value -Destination $entry.Key -Force
    Remove-Item -LiteralPath $entry.Value -Force
    Write-Host "Restored local '$($entry.Key)' over merged version." -ForegroundColor Cyan
}

# Auto-resolve modify/delete conflicts where upstream deleted a file that
# local has modified. These files are project-specific content (e.g.,
# .gitignore, README) that should never be removed by an instructions sync;
# keep the local version. Likewise, if local deleted a file upstream modified,
# keep local's delete.
if ($mergeExit -ne 0) {
    $porcelain = @(git status --porcelain)
    $autoResolved = @()

    # Force-keep-local for any conflicted always-local path (UU/AA/etc.).
    $alwaysLocalConflicts = @(Resolve-AlwaysLocalConflicts -Porcelain $porcelain)
    foreach ($path in $alwaysLocalConflicts) {
        Write-Host "Auto-keeping local '$path' (always-local policy)." -ForegroundColor Cyan
        git checkout --ours -- $path | Out-Null
        git add -- $path | Out-Null
        $autoResolved += $path
    }

    foreach ($line in $porcelain) {
        if ($line.Length -lt 4) { continue }
        $xy = $line.Substring(0, 2)
        $path = $line.Substring(3).Trim('"')
        if ($alwaysLocalConflicts -contains $path) { continue }
        switch ($xy) {
            'UD' {
                Write-Host "Auto-keeping local '$path' (upstream deleted, local modified)." -ForegroundColor Cyan
                git add -- $path | Out-Null
                $autoResolved += $path
            }
            'DU' {
                Write-Host "Auto-keeping local delete of '$path' (upstream modified, local deleted)." -ForegroundColor Cyan
                git rm -- $path | Out-Null
                $autoResolved += $path
            }
        }
    }

    # If every remaining conflict was auto-resolved, finalize the merge.
    $remaining = @(git diff --name-only --diff-filter=U)
    if ($autoResolved.Count -gt 0 -and $remaining.Count -eq 0) {
        git commit --no-edit | Out-Null
        $mergeExit = $LASTEXITCODE
        if ($mergeExit -eq 0) {
            Write-Host "Merge completed after auto-resolving modify/delete conflicts." -ForegroundColor Green
        }
    }
}

if ($mergeExit -ne 0) {
    $conflicted = git diff --name-only --diff-filter=U
    if ($conflicted) {
        Write-Warning "Merge produced conflicts in tracked files. Resolve with 'git mergetool' or edit manually, then 'git commit'."
        Write-Host "Conflicted files:`n$($conflicted -join "`n")"
    }
    exit $mergeExit
}

# --- Scaffold consumer-owned files from templates (first sync only) ---
# After a successful merge we may now have *.template files in the working
# tree. For each one, if the corresponding bare-named file does NOT exist in
# the consumer project, copy the template to the bare name so the consumer
# starts from a populated stub instead of an empty file. Subsequent syncs
# never overwrite -- the template-to-bare-name copy only happens when the
# bare-named file is missing.
#
# Skipped when running inside the upstream IntelliSDLC.ai repo itself
# (otherwise scaffolding would create the bare-named files in upstream).

if (Test-IsUpstreamRepo) {
    Write-Host ""
    Write-Host "Detected upstream repo (origin -> IntelliSDLC.ai). Skipping template scaffolding." -ForegroundColor DarkGray
}
else {
    $cwd = (Get-Location).Path
    $scaffolded = @(Invoke-TemplateScaffold -SourceRoot $cwd -TargetRoot $cwd -ScaffoldMap $script:TemplateScaffoldMap)

    if ($scaffolded.Count -gt 0) {
        Write-Host ""
        Write-Host "Scaffolded consumer-owned files from templates:" -ForegroundColor Green
        foreach ($f in $scaffolded) {
            Write-Host "  + $f" -ForegroundColor Green
        }
        Write-Host "Open each file and fill in the sections, then commit them to your repo." -ForegroundColor Green
    }
}
