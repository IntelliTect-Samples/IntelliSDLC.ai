#!/usr/bin/env pwsh
#Requires -Version 7.0

<#
.SYNOPSIS
    Make this repository's portable skills and global working rules
    available in every directory, to every installed AI engine, straight from
    this clone.

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

    GLOBAL INSTRUCTIONS (issue #593). GLOBAL-INSTRUCTIONS.md -- the working
    rules that apply in every repository and folder -- is wired into the
    user-level instructions file of every installed engine, inside a
    marker-delimited managed block. Text outside the block is never touched.

      ~/.claude/CLAUDE.md                 an @-import of the file: live
      ~/.copilot/copilot-instructions.md  the file's text, refreshed per run
      ~/.codex/AGENTS.md                  the file's text, refreshed per run
      ~/.gemini/GEMINI.md                 the file's text, refreshed per run

    After a `git pull`, rerun this to refresh the inlined copies.

    Twice-runnable: a second run reports every link and block unchanged. A
    real folder of the same name is never replaced; a link this clone owns
    whose skill no longer exists is removed.

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

    # In a linked worktree the git dir differs from the common dir, whose
    # parent is the main tree. Otherwise -- a plain clone or a submodule,
    # whose common dir lives in the superproject's .git/modules -- this IS
    # the main tree, and --show-toplevel names it.
    $dirs = @(& git -C $Path rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or $dirs.Count -ne 3) {
        throw "'$Path' is not inside a git clone of IntelliSDLC.ai. Clone it, then run this from the clone."
    }
    $main = if ($dirs[0] -ne $dirs[1]) { Split-Path $dirs[1] -Parent } else { $dirs[2] }
    return [System.IO.Path]::GetFullPath($main)
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

    # A link into one of this clone's skill folders whose skill is gone would
    # otherwise dangle. Scoped to those folders, so a link of your own into
    # some other part of the clone is never touched.
    # Every folder a listed skill can live in, so a skill dropped from the
    # list is still recognised as this clone's.
    $owned = @($script:SkillSources) + $Skills | ForEach-Object {
        [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath((Join-Path $Root (Split-Path $_ -Parent)))) +
            [System.IO.Path]::DirectorySeparatorChar
    } | Sort-Object -Unique
    foreach ($item in Get-ChildItem -LiteralPath $SkillsDir -Force | Where-Object LinkType) {
        $target = $item.Target
        if ($target -and -not (Test-Path -LiteralPath $target) -and
            ($owned | Where-Object { $target.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) })) {
            $item.Delete()
            [pscustomobject]@{ Skill = $item.Name; Status = 'Removed'; Detail = "'$($item.FullName)' pointed at a skill no longer in this clone" }
        }
    }
}

# The global working rules (issue #593), and each engine's user-level
# instructions file. Claude Code can @-import a file, so an edit or `git pull`
# is live at once; the others get the text itself, refreshed on every run.
$script:InstructionsSource = 'GLOBAL-INSTRUCTIONS.md'
$script:InstructionTargets = @(
    [pscustomobject]@{ File = '.claude/CLAUDE.md'; EngineHome = '.claude'; Mode = 'Import' }
    [pscustomobject]@{ File = '.copilot/copilot-instructions.md'; EngineHome = '.copilot'; Mode = 'Inline' }
    [pscustomobject]@{ File = '.codex/AGENTS.md'; EngineHome = '.codex'; Mode = 'Inline' }
    [pscustomobject]@{ File = '.gemini/GEMINI.md'; EngineHome = '.gemini'; Mode = 'Inline' }
)
$script:BlockBegin = '<!-- BEGIN IntelliSDLC.ai global instructions -- managed by Install-GlobalSkills.ps1; edits inside this block are overwritten -->'
$script:BlockEnd = '<!-- END IntelliSDLC.ai global instructions -->'

function Get-InstructionFiles {
    <# The user-level instructions files to wire, for the engines present under $HomeDir. #>
    param([Parameter(Mandatory)][string]$HomeDir)

    foreach ($target in $script:InstructionTargets) {
        if (Test-Path -LiteralPath (Join-Path $HomeDir $target.EngineHome)) {
            [pscustomobject]@{ Path = Join-Path $HomeDir $target.File; Mode = $target.Mode }
        }
    }
}

function Get-InstructionBlock {
    <# What goes inside the managed block: an @-import of $Source, or its text. #>
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][ValidateSet('Import', 'Inline')][string]$Mode
    )

    if ($Mode -eq 'Import') { return '@' + ($Source -replace '\\', '/') }
    return (Get-Content -LiteralPath $Source -Raw).TrimEnd()
}

function Set-ManagedBlock {
    <#
        Put $Content between the managed markers in $Path. Creates the file,
        appends the block to a file without one, or replaces the existing
        block -- never touching any text outside it. Writes nothing when the
        block already holds $Content.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )

    $block = "$script:BlockBegin`n$Content`n$script:BlockEnd"
    $existing = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { $null }
    $pattern = [regex]::Escape($script:BlockBegin) + '[\s\S]*?' + [regex]::Escape($script:BlockEnd)

    if ($null -eq $existing) {
        $status, $text = 'Created', "$block`n"
    }
    elseif ($existing -match $pattern) {
        if ($Matches[0] -replace "`r`n", "`n" -ceq $block) { return [pscustomobject]@{ Path = $Path; Status = 'Unchanged' } }
        $status = 'Updated'
        $text = [regex]::new($pattern).Replace($existing, { $block }, 1)
    }
    else {
        $status, $text = 'Added', ($existing.TrimEnd() + "`n`n$block`n")
    }

    New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
    [System.IO.File]::WriteAllText($Path, $text, [System.Text.UTF8Encoding]::new($false))
    [pscustomobject]@{ Path = $Path; Status = $status }
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

$source = Join-Path $root $script:InstructionsSource
if (-not (Test-Path -LiteralPath $source)) {
    Write-Warning "No '$source' in this clone -- `git pull` it, then rerun. No instructions wired."
    return
}
Write-Information "Global instructions ($source)" -InformationAction Continue
foreach ($file in Get-InstructionFiles -HomeDir $HOME) {
    $result = Set-ManagedBlock -Path $file.Path -Content (Get-InstructionBlock -Source $source -Mode $file.Mode)
    Write-Information "  $($result.Path): $($result.Status) ($($file.Mode.ToLower()))" -InformationAction Continue
}
