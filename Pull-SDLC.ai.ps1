<#
.SYNOPSIS
    Syncs shared AI instruction files from IntelliSDLC.ai into this project.

.DESCRIPTION
    Adds IntelliTect-Samples/IntelliSDLC.ai as a git remote named 'sdlc.ai'
    (if not already present) and pulls the documented sync set from its main
    branch.

    Two modes are supported:

      * 'Selective' (default when sync-manifest.json exists in upstream):
        only the paths/globs listed in sync-manifest.json are pulled via
        per-path `git checkout sdlc.ai/<branch> -- <path>`. Changes are
        staged onto the current consumer branch (no merge commit, no
        unrelated upstream tree leaks).

      * 'Merge' (legacy fallback, used when no manifest exists): full
        `git merge sdlc.ai/<branch> --no-ff --allow-unrelated-histories`,
        preserved for backwards compatibility with consumers that have
        not yet pulled the manifest-aware version of this script.

    The files in $script:AlwaysLocalPaths (README.md and .gitignore) plus
    anything listed under "consumer_owned" in sync-manifest.json are
    treated as consumer-owned and immune to upstream syncs: any conflict
    on those paths -- whether an untracked-file overwrite, a tracked
    content conflict (UU), or a modify/delete (UD/DU) -- is force-resolved
    to the local version with no prompt and no diff.

.PARAMETER Branch
    The upstream branch to merge from. Default: main.

.PARAMETER RemoteName
    Name for the git remote. Default: sdlc.ai.

.PARAMETER Mode
    Override the sync mode. 'Auto' (default) selects Selective when a
    manifest is present, Merge otherwise. 'Selective' forces selective
    even if no manifest exists (errors out if so). 'Merge' forces the
    legacy full-merge path.

.PARAMETER RemoveStale
    When in Selective mode, also `git rm` files that exist locally but
    have been removed from upstream within the manifest scope. Off by
    default for safety; without this flag, stale files trigger a warning
    only.

.EXAMPLE
    ./Pull-SDLC.ai.ps1

.EXAMPLE
    ./Pull-SDLC.ai.ps1 -Branch develop

.EXAMPLE
    ./Pull-SDLC.ai.ps1 -RemoveStale
#>
[CmdletBinding()]
param(
    [string]$Branch = 'main',
    [string]$RemoteName = 'sdlc.ai',
    [ValidateSet('Auto', 'Selective', 'Merge')]
    [string]$Mode = 'Auto',
    [switch]$RemoveStale
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteUrl = 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git'

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
function Get-SyncManifestPaths {
    <#
    .SYNOPSIS
        Parses sync-manifest.json content and returns an ordered hashtable
        with 'Paths' (sync set) and 'ConsumerOwned' (always-local additions
        beyond the hardcoded $script:AlwaysLocalPaths).
    .OUTPUTS
        [hashtable] with keys 'Paths' (string[]) and 'ConsumerOwned' (string[]).
        On null/empty/invalid input returns @{ Paths = @(); ConsumerOwned = @() }.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$Json
    )
    $empty = @{ Paths = @(); ConsumerOwned = @() }
    if ([string]::IsNullOrWhiteSpace($Json)) { return $empty }
    try {
        $parsed = $Json | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Write-Warning "sync-manifest.json is not valid JSON: $($_.Exception.Message)"
        return $empty
    }
    $paths = @()
    $owned = @()
    if ($parsed.PSObject.Properties['paths'] -and $parsed.paths) {
        $paths = @($parsed.paths | Where-Object { $_ -and -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
    }
    if ($parsed.PSObject.Properties['consumer_owned'] -and $parsed.consumer_owned) {
        $owned = @($parsed.consumer_owned | Where-Object { $_ -and -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
    }
    return @{ Paths = $paths; ConsumerOwned = $owned }
}

function Convert-GlobToRegex {
    <#
    .SYNOPSIS
        Converts a wildmatch-style glob (* and ** semantics) into a
        case-insensitive anchored .NET regex. Forward slashes only; callers
        should normalise '\\' to '/' before invoking.
    .NOTES
        - '**' matches any number of path segments (including zero).
        - '*'  matches any characters within a single segment (no '/').
        - All other regex metacharacters are escaped.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Glob)

    $g = $Glob -replace '\\', '/'
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('^')
    $i = 0
    while ($i -lt $g.Length) {
        $c = $g[$i]
        if ($c -eq '*') {
            if ($i + 1 -lt $g.Length -and $g[$i + 1] -eq '*') {
                # '**' -> any chars including '/'
                [void]$sb.Append('.*')
                $i += 2
                # Eat an optional trailing '/' so '**/foo' matches 'foo'.
                if ($i -lt $g.Length -and $g[$i] -eq '/') { $i++ }
                continue
            }
            else {
                # single '*' -> any chars except '/'
                [void]$sb.Append('[^/]*')
                $i++
                continue
            }
        }
        # Escape other regex metacharacters
        if ('.^$+?()[]{}|\'.Contains($c)) {
            [void]$sb.Append([regex]::Escape([string]$c))
        }
        else {
            [void]$sb.Append($c)
        }
        $i++
    }
    [void]$sb.Append('$')
    return $sb.ToString()
}

function Expand-SyncPaths {
    <#
    .SYNOPSIS
        Expands an array of literal paths and globs against a tree listing,
        returning the de-duplicated list of paths that actually exist in
        the tree. Pure function -- performs no git operations.
    .PARAMETER Patterns
        Manifest entries (literal paths or globs).
    .PARAMETER TreeListing
        Output of `git ls-tree -r --name-only <ref>` as a string array.
    .OUTPUTS
        [string[]] of repo-relative paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Patterns,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$TreeListing
    )
    $tree = @($TreeListing | ForEach-Object { ($_ -replace '\\', '/') })
    $treeSet = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]$tree, [System.StringComparer]::OrdinalIgnoreCase)
    $resolved = New-Object System.Collections.Generic.List[string]
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase)

    foreach ($pattern in $Patterns) {
        if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
        $p = ($pattern -replace '\\', '/')
        # Strip a leading './' prefix but never trim individual '.' chars
        # (otherwise '.github/...' would become 'github/...').
        if ($p.StartsWith('./')) { $p = $p.Substring(2) }
        if ($p -notmatch '[\*\?\[]') {
            # Literal path -- include only if present in tree.
            if ($treeSet.Contains($p) -and $seen.Add($p)) {
                $resolved.Add($p) | Out-Null
            }
            continue
        }
        $regex = Convert-GlobToRegex -Glob $p
        $rx = [regex]::new($regex, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        foreach ($entry in $tree) {
            if ($rx.IsMatch($entry) -and $seen.Add($entry)) {
                $resolved.Add($entry) | Out-Null
            }
        }
    }
    return $resolved.ToArray()
}

function Invoke-SelectivePathSync {
    <#
    .SYNOPSIS
        Performs path-selective sync: for each resolved path, runs
        `git checkout <ref> -- <path>` and stages it. Returns a summary
        hashtable of @{ Updated; Added; Skipped; StaleLocal }.
    .DESCRIPTION
        - Paths on $AlwaysLocalList (case-insensitive) are skipped with a
          notice.
        - Paths that exist locally but are absent from $ManifestPaths AND
          present in upstream tree are reported as 'StaleLocal'. Callers
          can `git rm` them if -RemoveStale is set.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ManifestPaths,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$AlwaysLocalList
    )
    $alwaysLocal = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]$AlwaysLocalList, [System.StringComparer]::OrdinalIgnoreCase)
    $updated = New-Object System.Collections.Generic.List[string]
    $added   = New-Object System.Collections.Generic.List[string]
    $skipped = New-Object System.Collections.Generic.List[string]

    foreach ($path in $ManifestPaths) {
        if ($alwaysLocal.Contains($path)) {
            Write-Host "  skip $path (always-local)" -ForegroundColor DarkGray
            $skipped.Add($path) | Out-Null
            continue
        }
        $existedLocally = Test-Path -LiteralPath $path
        git checkout $Ref -- $path 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "  failed to checkout $path from $Ref (exit $LASTEXITCODE)"
            continue
        }
        git add -- $path | Out-Null
        if ($existedLocally) { $updated.Add($path) | Out-Null }
        else                 { $added.Add($path)   | Out-Null }
    }
    return @{
        Updated = $updated.ToArray()
        Added   = $added.ToArray()
        Skipped = $skipped.ToArray()
    }
}

if ($MyInvocation.InvocationName -eq '.') { return }

# Add remote if it doesn't exist
$existingUrl = git remote get-url $RemoteName 2>$null
if (-not $existingUrl) {
    Write-Host "Adding remote '$RemoteName' -> $RemoteUrl"
    git remote add $RemoteName $RemoteUrl
}

git fetch $RemoteName

# --- Mode selection --------------------------------------------------------
# When sync-manifest.json exists in upstream and Mode is not forced to
# 'Merge', use path-selective sync: only the paths/globs in the manifest are
# pulled, via per-path `git checkout`. This avoids dragging the rest of the
# upstream tree (templates/, dogfood/, scaffolding tests/, etc.) into the
# consumer.
$mergeRef = "$RemoteName/$Branch"
$manifestRaw = git show "${mergeRef}:sync-manifest.json" 2>$null
$manifestExists = ($LASTEXITCODE -eq 0 -and $manifestRaw)
$manifestJson = if ($manifestExists) { ($manifestRaw -join "`n") } else { $null }
$manifestExists = $manifestExists -and -not [string]::IsNullOrWhiteSpace($manifestJson)

$selectiveMode = switch ($Mode) {
    'Selective' { $true }
    'Merge'     { $false }
    default     { $manifestExists }
}

if ($Mode -eq 'Selective' -and -not $manifestExists) {
    Write-Error "Mode 'Selective' was requested but sync-manifest.json is not present in $mergeRef."
    exit 1
}

if ($selectiveMode) {
    Write-Host "Selective sync mode (sync-manifest.json found in $mergeRef)." -ForegroundColor Cyan

    $manifest = Get-SyncManifestPaths -Json $manifestJson
    if (-not $manifest.Paths -or $manifest.Paths.Count -eq 0) {
        Write-Error "sync-manifest.json contains no 'paths' entries; nothing to sync."
        exit 1
    }
    $tree = @(git ls-tree -r --name-only $mergeRef)
    $resolved = @(Expand-SyncPaths -Patterns $manifest.Paths -TreeListing $tree)
    if ($resolved.Count -eq 0) {
        Write-Error "Manifest matched zero files in $mergeRef tree."
        exit 1
    }
    Write-Host ("Manifest resolved {0} path(s) from {1} pattern(s)." -f $resolved.Count, $manifest.Paths.Count) -ForegroundColor DarkGray

    $alwaysLocal = @($script:AlwaysLocalPaths) + @($manifest.ConsumerOwned)
    $summary = Invoke-SelectivePathSync -Ref $mergeRef -ManifestPaths $resolved -AlwaysLocalList $alwaysLocal

    # Detect stale local files (within manifest scope, removed upstream).
    $resolvedSet = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]$resolved, [System.StringComparer]::OrdinalIgnoreCase)
    $tracked = @(git ls-files)
    $stale = @()
    foreach ($pattern in $manifest.Paths) {
        $localMatches = Expand-SyncPaths -Patterns @($pattern) -TreeListing $tracked
        foreach ($m in $localMatches) {
            if (-not $resolvedSet.Contains($m) -and -not (Test-IsAlwaysLocalPath -Path $m)) {
                $stale += $m
            }
        }
    }
    $stale = @($stale | Sort-Object -Unique)

    if ($stale.Count -gt 0) {
        if ($RemoveStale) {
            Write-Host "Removing stale local files (upstream-deleted within manifest scope):" -ForegroundColor Yellow
            foreach ($s in $stale) {
                Write-Host "  - $s" -ForegroundColor Yellow
                git rm -- $s | Out-Null
            }
        }
        else {
            Write-Warning "The following files exist locally but were removed from upstream within the manifest scope. Re-run with -RemoveStale to delete them:"
            foreach ($s in $stale) { Write-Host "  - $s" -ForegroundColor DarkYellow }
        }
    }

    $staged = @(git diff --name-only --cached)
    if ($staged.Count -eq 0) {
        Write-Host "Already up to date with $mergeRef -- no changes to commit." -ForegroundColor Green
    }
    else {
        Write-Host ""
        Write-Host "Staged the following changes for review:" -ForegroundColor Green
        foreach ($f in $staged) { Write-Host "  $f" }
        Write-Host ""
        Write-Host "Run 'git commit' to record the sync, or 'git restore --staged .' to discard." -ForegroundColor DarkGray
    }

    # Fall through to template-scaffolding step (single shared block at the
    # end of the script). Skip the legacy merge logic entirely.
    $script:SkipMergeFlow = $true
}

if (-not $script:SkipMergeFlow) {
    Write-Warning "Falling back to legacy full-merge mode (no sync-manifest.json in $mergeRef). This may pull the entire upstream tree -- see IntelliSDLC.ai issue #82."

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

} # end if (-not $script:SkipMergeFlow)

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
