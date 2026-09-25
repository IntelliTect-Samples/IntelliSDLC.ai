#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Make this repository's portable skills available in every directory, to
    every installed AI engine, straight from this clone.

.DESCRIPTION
    A consuming repository gets these skills by pulling IntelliSDLC.ai. A bare
    directory gets nothing. This script closes that gap without a repository
    (issue #552): it links each skill folder into the personal skills folder of
    every AI engine installed on this machine.

      ~/.claude/skills   Claude Code
      ~/.agents/skills   GitHub Copilot, OpenAI Codex and Gemini CLI -- the
                         shared, engine-neutral location all three read

    A folder is linked only when its engine is present (~/.claude for the
    first; any of ~/.copilot, ~/.codex, ~/.gemini or ~/.agents for the second).

    LINKS, NOT COPIES. Each link points at the skill in this clone's MAIN
    working tree -- never a linked worktree, which is disposable -- so an edit
    shows up at once and `git pull` is the whole update. On another machine:
    clone, run this once.

    NOT LINKED: skills whose value depends on this repository's own layout
    (the dev-loop gate, evidence capture) and web-api-discovery, which is
    installed from its own repository.

    Twice-runnable: a second run reports every link unchanged. A real folder
    of the same name is never replaced; a link this clone owns whose skill no
    longer exists is removed.

.EXAMPLE
    ./Install-GlobalSkills.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Skills that work in any folder, relative to the repository root.
$script:SkillSources = @(
    '.github/skills/behavior-first-testing'
    '.github/skills/code-review-workflow'
    '.github/skills/functional-testing'
    '.github/skills/refactor-workflow'
    '.github/skills/security-review'
    '.github/skills/systematic-debugging'
    '.claude/skills/next-issue'
    '.claude/skills/wrap-up'
)

# Personal skills folders, and the home-folder entries that mean the engine
# reading each one is installed.
$script:SkillTargets = @(
    [pscustomobject]@{ Folder = '.claude/skills'; EngineHomes = @('.claude') }
    [pscustomobject]@{ Folder = '.agents/skills'; EngineHomes = @('.copilot', '.codex', '.gemini', '.agents') }
)

function Get-MainCheckout {
    <#
        The main working tree of the repository containing $Path. A link into
        a linked worktree would break when the worktree is cleaned up.
    #>
    param([Parameter(Mandatory)][string]$Path)

    $commonDir = & git -C $Path rev-parse --path-format=absolute --git-common-dir 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $commonDir) {
        throw "'$Path' is not inside a git clone of IntelliSDLC.ai. Clone it, then run this from the clone."
    }
    return [System.IO.Path]::GetFullPath((Split-Path $commonDir -Parent))
}

function Get-SkillFolders {
    <# The personal skills folders to link into, for the engines present under $HomeDir. #>
    param([Parameter(Mandatory)][string]$HomeDir)

    foreach ($target in $script:SkillTargets) {
        if ($target.EngineHomes | Where-Object { Test-Path -LiteralPath (Join-Path $HomeDir $_) }) {
            Join-Path $HomeDir $target.Folder
        }
    }
}

function Install-SkillLinks {
    <#
        Point $SkillsDir/<name> at each skill under $Root. Replaces a link that
        points elsewhere; never touches a real folder of the same name. Removes
        a link into $Root whose skill is gone. Returns one result per link.
    #>
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string[]]$Skills,
        [Parameter(Mandatory)][string]$SkillsDir
    )

    New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null
    $linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }

    foreach ($relative in $Skills) {
        $source = [System.IO.Path]::GetFullPath((Join-Path $Root $relative))
        $name = Split-Path $source -Leaf
        if (-not (Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) {
            [pscustomobject]@{ Skill = $name; Status = 'Missing'; Detail = "no SKILL.md in '$source'" }
            continue
        }

        $link = Join-Path $SkillsDir $name
        $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
        if ($item) {
            if (-not $item.LinkType) {
                [pscustomobject]@{ Skill = $name; Status = 'Skipped'; Detail = "'$link' is a real folder, not a link -- left alone" }
                continue
            }
            if ([System.IO.Path]::TrimEndingDirectorySeparator($item.Target) -eq
                [System.IO.Path]::TrimEndingDirectorySeparator($source)) {
                [pscustomobject]@{ Skill = $name; Status = 'Unchanged'; Detail = $link }
                continue
            }
            # Removing a junction or symlink removes the link, not its target.
            $item.Delete()
        }
        New-Item -ItemType $linkType -Path $link -Target $source | Out-Null
        [pscustomobject]@{ Skill = $name; Status = 'Linked'; Detail = "$link -> $source" }
    }

    # A link into this clone whose skill is gone would otherwise dangle.
    $owned = [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath($Root)) + [System.IO.Path]::DirectorySeparatorChar
    foreach ($item in Get-ChildItem -LiteralPath $SkillsDir -Force | Where-Object LinkType) {
        if ($item.Target -and $item.Target.StartsWith($owned, [System.StringComparison]::OrdinalIgnoreCase) -and
            -not (Test-Path -LiteralPath $item.Target)) {
            $item.Delete()
            [pscustomobject]@{ Skill = $item.Name; Status = 'Removed'; Detail = "'$($item.FullName)' pointed at a skill no longer in this clone" }
        }
    }
}

# Dot-sourced (by the tests): load the functions, run nothing.
if ($MyInvocation.InvocationName -eq '.') { return }

$root = Get-MainCheckout $PSScriptRoot
$folders = @(Get-SkillFolders -HomeDir $HOME)
if (-not $folders) {
    Write-Warning 'No AI engine found in your home folder (looked for .claude, .copilot, .codex, .gemini, .agents). Nothing linked.'
    return
}
foreach ($folder in $folders) {
    Write-Information "$folder" -InformationAction Continue
    Install-SkillLinks -Root $root -Skills $script:SkillSources -SkillsDir $folder |
        ForEach-Object { Write-Information "  $($_.Skill): $($_.Status) -- $($_.Detail)" -InformationAction Continue }
}
