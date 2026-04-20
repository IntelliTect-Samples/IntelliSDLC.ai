<#
.SYNOPSIS
    Syncs shared AI instruction files from IntelliAIInstructions into this project.

.DESCRIPTION
    Adds IntelliTect-Dev/IntelliAIInstructions as a git remote named 'instructions'
    (if not already present) and merges the latest changes from its main branch.

    Uses --allow-unrelated-histories for the initial merge, and --no-ff to keep
    a clear merge commit on subsequent syncs.

.PARAMETER Branch
    The upstream branch to merge from. Default: main.

.PARAMETER RemoteName
    Name for the git remote. Default: instructions.

.EXAMPLE
    ./sync-instructions.ps1

.EXAMPLE
    ./sync-instructions.ps1 -Branch develop
#>
[CmdletBinding()]
param(
    [string]$Branch = 'main',
    [string]$RemoteName = 'instructions'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteUrl = 'https://github.com/IntelliTect-Dev/IntelliAIInstructions.git'

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
    foreach ($line in $porcelain) {
        if ($line.Length -lt 4) { continue }
        $xy = $line.Substring(0, 2)
        $path = $line.Substring(3).Trim('"')
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
