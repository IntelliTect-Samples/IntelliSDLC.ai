#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Make the web-api-discovery skill, its PowerShell front doors and the Claude
    skills available in every directory on this machine -- and, through
    Dropbox, on every other machine you run this on.

.DESCRIPTION
    A consuming repository gets these skills by pulling IntelliSDLC.ai. A bare
    directory gets nothing: no `Invoke-HarCapture`, no `/wrap-up`. This script
    closes that gap without a repository (issue #552).

    TWO MODES, and where the script runs decides which -- there is no option:

      From a CLONE of IntelliSDLC.ai: PUBLISH, then LINK.
        Publish mirrors each skill into a git-free copy under your Dropbox
        folder (<Dropbox>\IntelliSDLC.ai). The web-api-discovery tooling is
        nested INSIDE its skill folder, at the same relative path the skill's
        instructions use (templates/web-api-discovery/...), so those paths
        resolve against the skill folder as well as a repository root. The
        script copies itself into that folder too.

      From that DEPLOYED folder (any machine, no clone needed): LINK only.
        Link points ~/.claude/skills/<name> at each deployed skill, puts the
        capture and scrub script folders on the User PATH, and unblocks the
        deployed files -- a Dropbox-synced script can carry Mark-of-the-Web,
        which a RemoteSigned policy refuses to run.

    UPDATING: `git pull` in the clone, then run this again. Dropbox carries the
    new copy to every machine; the links there already point at it.

    WHY A COPY AND NOT THE CLONE ITSELF IN DROPBOX: a git repository under a
    sync client races it for index.lock and worktree metadata. The clone stays
    where you develop; Dropbox only ever holds plain files.

    Twice-runnable: every step checks before it acts, and a second run changes
    nothing.

.EXAMPLE
    # From your IntelliSDLC.ai clone: publish to Dropbox and link this machine.
    ./Install-GlobalSkills.ps1

.EXAMPLE
    # On another machine, once Dropbox has synced: link only.
    & "$env:USERPROFILE\Dropbox\IntelliSDLC.ai\Install-GlobalSkills.ps1"
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- What gets published ---------------------------------------------------

# Each skill: where it lives in the repository, and any tooling that must
# travel with it. `Nested` paths are copied to the SAME relative path under the
# skill's deployed folder, which is what makes the skill's repo-relative paths
# resolve there.
$script:SkillSources = @(
    [pscustomobject]@{ Name = 'web-api-discovery'; Path = '.github/skills/web-api-discovery'; Nested = @('templates/web-api-discovery') }
    [pscustomobject]@{ Name = 'wrap-up';           Path = '.claude/skills/wrap-up';           Nested = @() }
    [pscustomobject]@{ Name = 'next-issue';        Path = '.claude/skills/next-issue';        Nested = @() }
)

# Script folders put on PATH, relative to the deployed root. pwsh resolves a
# `.ps1` on PATH by bare name, so `Invoke-HarCapture` works from anywhere.
$script:PathFolders = @(
    'skills/web-api-discovery/templates/web-api-discovery/scripts/capture'
    'skills/web-api-discovery/templates/web-api-discovery/scripts/har'
)

# The toolkit's own tests are not shipped -- the same carve-out Pull-SDLC.ai.ps1
# makes for consumers -- and neither is anything npm installed.
$script:ExcludedFilePatterns = @('*.test.js', '*.test-support.js')
$script:ExcludedDirectoryNames = @('node_modules')

$script:DeployFolderName = 'IntelliSDLC.ai'

# Written into the deployed folder on first publish. Publishing MIRRORS --
# deletes what the source no longer has -- so it must never be pointed at a
# folder it did not create.
$script:DeployMarker = '.intellisdlc-global-install'

# --- Functions ---------------------------------------------------------------

function Get-DropboxRoot {
    <#
        The personal Dropbox folder, from the client's own info.json (it is
        not always ~/Dropbox), falling back to ~/Dropbox when that exists.
    #>
    param(
        [string]$InfoJsonPath = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Dropbox/info.json' }),
        [string]$Fallback = (Join-Path $HOME 'Dropbox')
    )

    if ($InfoJsonPath -and (Test-Path -LiteralPath $InfoJsonPath)) {
        $info = Get-Content -LiteralPath $InfoJsonPath -Raw | ConvertFrom-Json
        foreach ($account in 'personal', 'business') {
            $entry = $info.PSObject.Properties[$account]
            if ($entry -and $entry.Value.path -and (Test-Path -LiteralPath $entry.Value.path)) {
                return $entry.Value.path
            }
        }
    }
    if (Test-Path -LiteralPath $Fallback) { return $Fallback }

    throw "No Dropbox folder found (looked in '$InfoJsonPath' and '$Fallback'). Install and sign in to Dropbox, then run this again."
}

function Test-IsSourceClone {
    <# True when $Root is an IntelliSDLC.ai checkout, i.e. this run publishes. #>
    param([Parameter(Mandatory)][string]$Root)

    foreach ($skill in $script:SkillSources) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $skill.Path 'SKILL.md'))) { return $false }
    }
    return $true
}

function Test-IsExcluded {
    param([Parameter(Mandatory)][string]$RelativePath)

    $segments = $RelativePath -split '[\\/]'
    $directories = if ($segments.Count -gt 1) { $segments[0..($segments.Count - 2)] } else { @() }
    foreach ($dir in $directories) {
        if ($script:ExcludedDirectoryNames -contains $dir) { return $true }
    }
    foreach ($pattern in $script:ExcludedFilePatterns) {
        if ($segments[-1] -like $pattern) { return $true }
    }
    return $false
}

function Sync-Directory {
    <#
        Make $Destination hold exactly $Source's files, minus exclusions.
        Copies only files whose size or content differ, so a re-run touches
        nothing and Dropbox uploads only what changed. Paths under a $Keep
        prefix belong to another sync and are left alone. Returns the number
        of files copied plus files removed.
    #>
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [string[]]$Keep = @()
    )

    $keepPrefixes = $Keep | ForEach-Object { ($_ -replace '[\\/]', [System.IO.Path]::DirectorySeparatorChar).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar }

    $Source = (Resolve-Path -LiteralPath $Source).ProviderPath
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $Destination = (Resolve-Path -LiteralPath $Destination).ProviderPath

    $wanted = @{}
    $changes = 0
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
        $relative = [System.IO.Path]::GetRelativePath($Source, $file.FullName)
        if (Test-IsExcluded $relative) { continue }
        $wanted[$relative] = $true

        $target = Join-Path $Destination $relative
        if (Test-Path -LiteralPath $target) {
            $existing = Get-Item -LiteralPath $target -Force
            if ($existing.Length -eq $file.Length -and
                (Get-FileHash -LiteralPath $target).Hash -eq (Get-FileHash -LiteralPath $file.FullName).Hash) {
                continue
            }
        }
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        $changes++
    }

    foreach ($file in Get-ChildItem -LiteralPath $Destination -Recurse -File -Force) {
        $relative = [System.IO.Path]::GetRelativePath($Destination, $file.FullName)
        if ($keepPrefixes | Where-Object { $relative.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }) { continue }
        if (-not $wanted.ContainsKey($relative)) {
            Remove-Item -LiteralPath $file.FullName -Force
            $changes++
        }
    }
    # Directories the source no longer has, deepest first.
    Get-ChildItem -LiteralPath $Destination -Recurse -Directory -Force |
        Sort-Object { $_.FullName.Length } -Descending |
        Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

    return $changes
}

function Publish-GlobalSkills {
    <#
        Mirror every skill (with its nested tooling) and this script into
        $DeployRoot. Refuses a non-empty folder it did not create.
    #>
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DeployRoot,
        [string]$InstallerPath = $PSCommandPath
    )

    $marker = Join-Path $DeployRoot $script:DeployMarker
    if ((Test-Path -LiteralPath $DeployRoot) -and -not (Test-Path -LiteralPath $marker) -and
        (Get-ChildItem -LiteralPath $DeployRoot -Force | Select-Object -First 1)) {
        throw "'$DeployRoot' already exists and was not created by this installer. Publishing mirrors (deletes what the source lacks), so it will not write there. Move or rename that folder, then run this again."
    }
    New-Item -ItemType Directory -Path $DeployRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath $marker)) {
        Set-Content -LiteralPath $marker -Value 'Created by IntelliSDLC.ai Install-GlobalSkills.ps1. Contents are overwritten on publish; edit the source repository instead.'
    }

    $changes = 0
    $skillsRoot = Join-Path $DeployRoot 'skills'
    foreach ($skill in $script:SkillSources) {
        $skillDeploy = Join-Path $skillsRoot $skill.Name
        # The skill's own files first, keeping clear of the nested tooling,
        # which is synced second into its own subfolder.
        $changes += Sync-Directory -Source (Join-Path $SourceRoot $skill.Path) -Destination $skillDeploy -Keep $skill.Nested
        foreach ($nested in $skill.Nested) {
            $changes += Sync-Directory -Source (Join-Path $SourceRoot $nested) -Destination (Join-Path $skillDeploy $nested)
        }
    }

    # Skills removed from the list are removed from the deployment.
    foreach ($dir in Get-ChildItem -LiteralPath $skillsRoot -Directory -Force) {
        if ($script:SkillSources.Name -notcontains $dir.Name) {
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force
            $changes++
        }
    }

    $installerTarget = Join-Path $DeployRoot (Split-Path $InstallerPath -Leaf)
    if (-not (Test-Path -LiteralPath $installerTarget) -or
        (Get-FileHash -LiteralPath $installerTarget).Hash -ne (Get-FileHash -LiteralPath $InstallerPath).Hash) {
        Copy-Item -LiteralPath $InstallerPath -Destination $installerTarget -Force
        $changes++
    }
    return $changes
}

function Install-SkillLinks {
    <#
        Point $SkillsDir/<name> at each deployed skill. Replaces a link that
        points elsewhere; never touches a real directory of the same name.
        Returns one result object per skill.
    #>
    param(
        [Parameter(Mandatory)][string]$DeployRoot,
        [Parameter(Mandatory)][string]$SkillsDir
    )

    New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null
    $linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }

    foreach ($skill in Get-ChildItem -LiteralPath (Join-Path $DeployRoot 'skills') -Directory) {
        $link = Join-Path $SkillsDir $skill.Name
        $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
        if ($item) {
            if (-not $item.LinkType) {
                [pscustomobject]@{ Skill = $skill.Name; Status = 'Skipped'; Detail = "'$link' is a real folder, not a link -- left alone" }
                continue
            }
            if ([System.IO.Path]::TrimEndingDirectorySeparator($item.Target) -eq
                [System.IO.Path]::TrimEndingDirectorySeparator($skill.FullName)) {
                [pscustomobject]@{ Skill = $skill.Name; Status = 'Unchanged'; Detail = $link }
                continue
            }
            # Removing a junction or symlink removes the link, not its target.
            $item.Delete()
        }
        New-Item -ItemType $linkType -Path $link -Target $skill.FullName | Out-Null
        [pscustomobject]@{ Skill = $skill.Name; Status = 'Linked'; Detail = "$link -> $($skill.FullName)" }
    }
}

function Add-PathEntries {
    <#
        $Current with each of $Entries appended once. Pure: comparison ignores
        case and a trailing separator; unrelated entries are kept verbatim,
        unexpanded %VARIABLES% included.
    #>
    param(
        [AllowEmptyString()][string]$Current,
        [Parameter(Mandatory)][string[]]$Entries
    )

    $sep = [System.IO.Path]::PathSeparator
    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($p in ($Current -split [regex]::Escape($sep))) { if ($p) { $parts.Add($p) } }

    foreach ($entry in $Entries) {
        $normalized = [System.IO.Path]::TrimEndingDirectorySeparator($entry)
        $present = $parts | Where-Object { [System.IO.Path]::TrimEndingDirectorySeparator($_) -ieq $normalized }
        if (-not $present) { $parts.Add($normalized) }
    }
    return ($parts -join $sep)
}

function Set-UserPath {
    <#
        Persist $Entries on the User PATH and the current session. On Windows
        the registry value is read UNEXPANDED and written back as
        REG_EXPAND_SZ, so existing %VARIABLE% entries survive; then running
        applications are told the environment changed.
    #>
    param([Parameter(Mandatory)][string[]]$Entries)

    $env:PATH = Add-PathEntries -Current $env:PATH -Entries $Entries
    if (-not $IsWindows) {
        Write-Warning "Not Windows: added to this session only. Add these to your shell profile's PATH: $($Entries -join ', ')"
        return $false
    }

    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    $current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $updated = Add-PathEntries -Current $current -Entries $Entries
    if ($updated -eq $current) { return $false }

    New-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $updated -PropertyType ExpandString -Force | Out-Null
    if (-not ('IntelliSdlc.EnvBroadcast' -as [type])) {
        Add-Type -Namespace IntelliSdlc -Name EnvBroadcast -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5s
    [IntelliSdlc.EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
    return $true
}

function Get-PrerequisiteWarnings {
    <# What the capture tooling needs and cannot find. Reports; installs nothing. #>

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        'Node.js is not on PATH -- the recorder is a Node script. Install Node.js LTS.'
        return
    }
    $globalRoot = (& npm root -g 2>$null)
    $inGlobal = $globalRoot -and (Test-Path -LiteralPath (Join-Path $globalRoot 'playwright'))
    $inNodePath = $env:NODE_PATH -and ($env:NODE_PATH -split [regex]::Escape([System.IO.Path]::PathSeparator) |
        Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'playwright')) })
    if (-not ($inGlobal -or $inNodePath)) {
        'Playwright is not installed globally -- run: npm install -g playwright   (a project that installs its own copy also works, from that folder)'
    }
    $chrome = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    if ($IsWindows -and -not $chrome) {
        'Google Chrome was not found -- the recorder drives your installed Chrome by default.'
    }
}

# Dot-sourced (by the tests): load the functions, run nothing.
if ($MyInvocation.InvocationName -eq '.') { return }

# --- Run ---------------------------------------------------------------------

$here = $PSScriptRoot
if (Test-IsSourceClone $here) {
    $deployRoot = Join-Path (Get-DropboxRoot) $script:DeployFolderName
    $changes = Publish-GlobalSkills -SourceRoot $here -DeployRoot $deployRoot
    Write-Information "Published to $deployRoot ($changes file change(s))." -InformationAction Continue
}
elseif (Test-Path -LiteralPath (Join-Path $here $script:DeployMarker)) {
    $deployRoot = $here
    Write-Information "Linking this machine to $deployRoot." -InformationAction Continue
}
else {
    throw "Run this from an IntelliSDLC.ai clone (to publish) or from its deployed Dropbox folder (to link). '$here' is neither."
}

if ($IsWindows) {
    Get-ChildItem -LiteralPath $deployRoot -Recurse -File | Unblock-File
}

Install-SkillLinks -DeployRoot $deployRoot -SkillsDir (Join-Path $HOME '.claude/skills') |
    ForEach-Object { Write-Information "  skill $($_.Skill): $($_.Status) -- $($_.Detail)" -InformationAction Continue }

$pathEntries = $script:PathFolders | ForEach-Object { [System.IO.Path]::GetFullPath((Join-Path $deployRoot $_)) }
if (Set-UserPath -Entries $pathEntries) {
    Write-Information '  PATH: capture and scrub scripts added. Open a new terminal for other shells to see them.' -InformationAction Continue
}
else {
    Write-Information '  PATH: already present.' -InformationAction Continue
}

foreach ($warning in Get-PrerequisiteWarnings) { Write-Warning $warning }

Write-Warning ("Run captures from a working folder OUTSIDE Dropbox (or any synced folder): a raw capture carries live session cookies and lands in .har-captures under the current directory.")
