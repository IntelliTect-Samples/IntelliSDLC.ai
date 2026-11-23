#Requires -Modules Pester

<#
    Behavior tests for Install-GlobalSkills.ps1 (issue #552).

    Everything runs against temp folders: the real home folder and engine
    skills folders are never touched. The script returns early when
    dot-sourced, so its functions load without the install running.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot 'Install-GlobalSkills.ps1')

    function New-TempDir {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('igs-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        return (Resolve-Path $dir).ProviderPath
    }

    function Set-File([string]$Path, [string]$Value = 'x') {
        New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
        Set-Content -LiteralPath $Path -Value $Value
    }

    function Remove-TempDir([string]$Dir) {
        # Delete links before their targets so nothing is removed through them.
        Get-ChildItem $Dir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object LinkType -in 'Junction', 'SymbolicLink' | ForEach-Object { $_.Delete() }
        Remove-Item $Dir -Recurse -Force
    }

    # Record a Claude Code plugin the way `claude plugin install` / `disable`
    # do: an entry in plugins/installed_plugins.json, and (for a user-scope
    # install) enabledPlugins in the user's settings.json.
    function Set-PluginState {
        param(
            [string]$HomeDir,
            [string]$Id,
            [ValidateSet('user', 'project')][string]$Scope,
            [bool]$Enabled
        )
        $entry = @{ scope = $Scope; installPath = 'x'; version = 'abc123' }
        if ($Scope -eq 'project') { $entry.projectPath = 'C:/some/repo' }
        $registry = @{ version = 2; plugins = @{ $Id = @($entry) } }
        Set-File (Join-Path $HomeDir '.claude/plugins/installed_plugins.json') ($registry | ConvertTo-Json -Depth 5)
        $settings = if ($Scope -eq 'user') { @{ enabledPlugins = @{ $Id = $Enabled } } } else { @{} }
        Set-File (Join-Path $HomeDir '.claude/settings.json') ($settings | ConvertTo-Json -Depth 5)
    }

    function Get-LinkNames([string]$Dir) {
        @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue | Where-Object LinkType | ForEach-Object Name)
    }
}

Describe 'Get-MainCheckout' {
    It 'resolves a linked worktree to the main checkout, so links survive worktree cleanup' {
        $tmp = New-TempDir
        try {
            $main = Join-Path $tmp 'main'
            git init -q $main
            git -C $main -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init
            git -C $main worktree add -q (Join-Path $main '.worktrees/wt') -b wt 2>$null

            Get-MainCheckout (Join-Path $main '.worktrees/wt') | Should -Be ([System.IO.Path]::GetFullPath($main))
        }
        finally { Remove-TempDir $tmp }
    }

    It 'resolves a submodule to its own working tree, not the superproject''s .git' {
        $tmp = New-TempDir
        try {
            $sub = Join-Path $tmp 'sub-src'
            git init -q $sub
            git -C $sub -c user.email=t@e -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init
            $super = Join-Path $tmp 'super'
            git init -q $super
            git -C $super -c protocol.file.allow=always submodule add -q $sub sub 2>$null

            Get-MainCheckout (Join-Path $super 'sub') | Should -Be ([System.IO.Path]::GetFullPath((Join-Path $super 'sub')))
        }
        finally { Remove-TempDir $tmp }
    }

    It 'refuses a folder that is not a clone' {
        $tmp = New-TempDir
        try { { Get-MainCheckout $tmp } | Should -Throw '*not inside a git clone*' }
        finally { Remove-TempDir $tmp }
    }
}

Describe 'Get-PortableSkills' {
    It 'reads the skill list from the Claude Code plugin manifest, so the plugin and the global install cannot drift' {
        $tmp = New-TempDir
        try {
            Set-File (Join-Path $tmp '.claude-plugin/plugin.json') '{ "name": "x", "skills": ["./.github/skills/alpha", "./.claude/skills/beta"] }'

            Get-PortableSkills -Root $tmp | Should -Be @('.github/skills/alpha', '.claude/skills/beta')
        }
        finally { Remove-TempDir $tmp }
    }

    It 'is the list the installer links' {
        $script:SkillSources | Should -Be @(Get-PortableSkills -Root $PSScriptRoot)
    }
}

Describe 'Get-PluginId' {
    It 'names the plugin as Claude Code does, plugin@marketplace, from the two manifests' {
        $tmp = New-TempDir
        try {
            Set-File (Join-Path $tmp '.claude-plugin/plugin.json') '{ "name": "alpha", "skills": [] }'
            Set-File (Join-Path $tmp '.claude-plugin/marketplace.json') '{ "name": "beta-market", "plugins": [] }'

            Get-PluginId -Root $tmp | Should -Be 'alpha@beta-market'
        }
        finally { Remove-TempDir $tmp }
    }
}

Describe 'Test-ClaudePluginActive' {
    BeforeEach {
        $script:home_ = New-TempDir
        $script:id = 'alpha@beta-market'
    }
    AfterEach { Remove-TempDir $home_ }

    It 'is false when the plugin was never installed' {
        Test-ClaudePluginActive -HomeDir $home_ -PluginId $id | Should -BeFalse
    }

    It 'is true when it is installed for the user and enabled' {
        Set-PluginState -HomeDir $home_ -Id $id -Scope user -Enabled $true

        Test-ClaudePluginActive -HomeDir $home_ -PluginId $id | Should -BeTrue
    }

    It 'is false when it is installed only in one project, so Claude Code elsewhere still needs the global install' {
        Set-PluginState -HomeDir $home_ -Id $id -Scope project -Enabled $true

        Test-ClaudePluginActive -HomeDir $home_ -PluginId $id | Should -BeFalse
    }

    It 'is false when it is installed for the user but disabled' {
        Set-PluginState -HomeDir $home_ -Id $id -Scope user -Enabled $false

        Test-ClaudePluginActive -HomeDir $home_ -PluginId $id | Should -BeFalse
    }

    It 'is false, not an error, when Claude Code''s plugin registry is unreadable' {
        Set-File (Join-Path $home_ '.claude/plugins/installed_plugins.json') '{ not json'

        Test-ClaudePluginActive -HomeDir $home_ -PluginId $id | Should -BeFalse
    }
}

Describe 'Invoke-GlobalInstall' {
    BeforeEach {
        $script:home_ = New-TempDir
        New-Item -ItemType Directory (Join-Path $home_ '.claude'), (Join-Path $home_ '.copilot') | Out-Null
        $script:id = Get-PluginId -Root $PSScriptRoot
        $script:claudeSkills = Join-Path $home_ '.claude/skills'
        $script:claudeMd = Join-Path $home_ '.claude/CLAUDE.md'
        $script:copilotMd = Join-Path $home_ '.copilot/copilot-instructions.md'
    }
    AfterEach { Remove-TempDir $home_ }

    It 'serves Claude Code itself when the plugin is not installed' {
        Invoke-GlobalInstall -HomeDir $home_ -Root $PSScriptRoot 6>$null

        Get-LinkNames $claudeSkills | Should -HaveCount $script:SkillSources.Count
        Get-Content -Raw $claudeMd | Should -BeLike "*$($script:BlockBegin)*"
    }

    It 'leaves Claude Code to the plugin when it is installed for the user and enabled, and still serves the other engines' {
        Set-PluginState -HomeDir $home_ -Id $id -Scope user -Enabled $true

        Invoke-GlobalInstall -HomeDir $home_ -Root $PSScriptRoot 6>$null

        Get-LinkNames $claudeSkills | Should -BeNullOrEmpty
        $claudeMd | Should -Not -Exist
        Get-LinkNames (Join-Path $home_ '.agents/skills') | Should -HaveCount $script:SkillSources.Count
        Get-Content -Raw $copilotMd | Should -BeLike "*$($script:BlockBegin)*"
    }

    It 'removes its own earlier Claude copies once the plugin arrives, and keeps everything of the user''s' {
        Invoke-GlobalInstall -HomeDir $home_ -Root $PSScriptRoot 6>$null
        Set-Content -LiteralPath $claudeMd -Value ("# Mine`nKeep this.`n`n" + (Get-Content -Raw $claudeMd))
        New-Item -ItemType Directory (Join-Path $claudeSkills 'my-own-skill') | Out-Null
        Set-PluginState -HomeDir $home_ -Id $id -Scope user -Enabled $true

        Invoke-GlobalInstall -HomeDir $home_ -Root $PSScriptRoot 6>$null

        Get-LinkNames $claudeSkills | Should -BeNullOrEmpty
        Join-Path $claudeSkills 'my-own-skill' | Should -Exist
        $text = Get-Content -Raw $claudeMd
        $text | Should -Not -BeLike "*$($script:BlockBegin)*"
        $text | Should -BeLike '# Mine*Keep this.*'
    }

    It 'puts the Claude copies back when the plugin is disabled again' {
        Set-PluginState -HomeDir $home_ -Id $id -Scope user -Enabled $true
        Invoke-GlobalInstall -HomeDir $home_ -Root $PSScriptRoot 6>$null
        Set-PluginState -HomeDir $home_ -Id $id -Scope user -Enabled $false

        Invoke-GlobalInstall -HomeDir $home_ -Root $PSScriptRoot 6>$null

        Get-LinkNames $claudeSkills | Should -HaveCount $script:SkillSources.Count
        Get-Content -Raw $claudeMd | Should -BeLike "*$($script:BlockBegin)*"
    }
}

Describe 'Remove-ManagedBlock' {
    BeforeEach {
        $script:tmp = New-TempDir
        $script:file = Join-Path $tmp 'engine/CLAUDE.md'
    }
    AfterEach { Remove-TempDir $tmp }

    It 'removes only the block, leaving the user''s text above and below it' {
        Set-File $file '# Mine above'
        Set-ManagedBlock -Path $file -Content 'rules v1' | Out-Null
        Add-Content -LiteralPath $file -Value 'Mine below'

        (Remove-ManagedBlock -Path $file).Status | Should -Be 'Removed'

        $text = Get-Content -Raw $file
        $text | Should -Not -BeLike '*rules v1*'
        $text | Should -BeLike '# Mine above*Mine below*'
    }

    It 'deletes a file that held nothing but the block' {
        Set-ManagedBlock -Path $file -Content 'rules v1' | Out-Null

        (Remove-ManagedBlock -Path $file).Status | Should -Be 'Removed'

        $file | Should -Not -Exist
    }

    It 'refuses to touch a file whose markers are damaged, rather than swallow the user''s text' {
        Set-File $file "top`n$($script:BlockBegin)`nmy precious notes"
        $before = Get-Content -Raw $file

        (Remove-ManagedBlock -Path $file 3>$null).Status | Should -Be 'Skipped'

        Get-Content -Raw $file | Should -BeExactly $before
    }
}

Describe 'Get-SkillFolders' {
    BeforeEach { $script:home_ = New-TempDir }
    AfterEach { Remove-TempDir $home_ }

    It 'links nowhere when no engine is installed' {
        @(Get-SkillFolders -HomeDir $home_) | Should -BeNullOrEmpty
    }

    It 'links Claude''s folder when Claude is installed' {
        New-Item -ItemType Directory (Join-Path $home_ '.claude') | Out-Null

        Get-SkillFolders -HomeDir $home_ | Should -Be (Join-Path $home_ '.claude/skills')
    }

    It 'links the shared folder once for Copilot, Codex and Gemini together' {
        foreach ($engine in '.copilot', '.codex', '.gemini') { New-Item -ItemType Directory (Join-Path $home_ $engine) | Out-Null }

        Get-SkillFolders -HomeDir $home_ | Should -Be (Join-Path $home_ '.agents/skills')
    }
}

Describe 'Install-SkillLinks' {
    BeforeEach {
        $script:tmp = New-TempDir
        $script:root = Join-Path $tmp 'clone'
        Set-File (Join-Path $root '.github/skills/refactor-workflow/SKILL.md') 'refactor'
        Set-File (Join-Path $root '.claude/skills/wrap-up/SKILL.md') 'wrap-up'
        $script:skills = @('.github/skills/refactor-workflow', '.claude/skills/wrap-up')
        $script:skillsDir = Join-Path $tmp 'engine-skills'
    }
    AfterEach { Remove-TempDir $tmp }

    It 'makes each skill visible in the engine''s folder, live from the clone' {
        Install-SkillLinks -Root $root -Skills $skills -SkillsDir $skillsDir | Out-Null
        Set-Content (Join-Path $root '.claude/skills/wrap-up/SKILL.md') 'edited'

        Get-Content (Join-Path $skillsDir 'refactor-workflow/SKILL.md') | Should -Be 'refactor'
        Get-Content (Join-Path $skillsDir 'wrap-up/SKILL.md') | Should -Be 'edited'
    }

    It 'reports every skill unchanged on a second run' {
        Install-SkillLinks -Root $root -Skills $skills -SkillsDir $skillsDir | Out-Null

        (Install-SkillLinks -Root $root -Skills $skills -SkillsDir $skillsDir).Status | Sort-Object -Unique | Should -Be 'Unchanged'
    }

    It 'never replaces a real folder of the same name' {
        Set-File (Join-Path $skillsDir 'wrap-up/SKILL.md') 'my own wrap-up'

        $result = Install-SkillLinks -Root $root -Skills $skills -SkillsDir $skillsDir | Where-Object Skill -eq 'wrap-up'

        $result.Status | Should -Be 'Skipped'
        Get-Content (Join-Path $skillsDir 'wrap-up/SKILL.md') | Should -Be 'my own wrap-up'
    }

    It 'repoints a link from an earlier install, without deleting what it pointed at' {
        $old = Join-Path $tmp 'old/wrap-up'
        Set-File (Join-Path $old 'SKILL.md') 'old'
        New-Item -ItemType Directory $skillsDir | Out-Null
        New-Item -ItemType ($IsWindows ? 'Junction' : 'SymbolicLink') -Path (Join-Path $skillsDir 'wrap-up') -Target $old | Out-Null

        Install-SkillLinks -Root $root -Skills $skills -SkillsDir $skillsDir | Out-Null

        Get-Content (Join-Path $skillsDir 'wrap-up/SKILL.md') | Should -Be 'wrap-up'
        Join-Path $old 'SKILL.md' | Should -Exist
    }

    It 'reports a listed skill the clone does not have instead of linking an empty folder' {
        $result = Install-SkillLinks -Root $root -Skills ($skills + '.github/skills/no-such-skill') -SkillsDir $skillsDir |
            Where-Object Skill -eq 'no-such-skill'

        $result.Status | Should -Be 'Missing'
        Join-Path $skillsDir 'no-such-skill' | Should -Not -Exist
    }

    It 'removes its own link to a skill that is gone, and leaves a link into another part of the clone alone' {
        Install-SkillLinks -Root $root -Skills $skills -SkillsDir $skillsDir | Out-Null
        $elsewhere = Join-Path $root 'docs/gone'
        Set-File (Join-Path $elsewhere 'SKILL.md')
        New-Item -ItemType ($IsWindows ? 'Junction' : 'SymbolicLink') -Path (Join-Path $skillsDir 'unrelated') -Target $elsewhere | Out-Null
        Remove-Item $elsewhere -Recurse -Force
        Remove-Item (Join-Path $root '.claude/skills/wrap-up') -Recurse -Force

        $removed = Install-SkillLinks -Root $root -Skills @('.github/skills/refactor-workflow') -SkillsDir $skillsDir |
            Where-Object Status -eq 'Removed'

        $removed.Skill | Should -Be 'wrap-up'
        (Get-Item (Join-Path $skillsDir 'unrelated') -Force).LinkType | Should -Not -BeNullOrEmpty
    }
}

# Issue #593: the global working rules, wired into every engine's user-level
# instructions file.

Describe 'Get-InstructionFiles' {
    BeforeEach { $script:home_ = New-TempDir }
    AfterEach { Remove-TempDir $home_ }

    It 'wires nothing when no engine is installed' {
        @(Get-InstructionFiles -HomeDir $home_) | Should -BeNullOrEmpty
    }

    It 'imports into Claude''s CLAUDE.md, and inlines for each other engine present' {
        foreach ($engine in '.claude', '.copilot', '.codex', '.gemini') { New-Item -ItemType Directory (Join-Path $home_ $engine) | Out-Null }

        $files = Get-InstructionFiles -HomeDir $home_ | Sort-Object Path

        $files.Path | Should -Be @(
            (Join-Path $home_ '.claude/CLAUDE.md')
            (Join-Path $home_ '.codex/AGENTS.md')
            (Join-Path $home_ '.copilot/copilot-instructions.md')
            (Join-Path $home_ '.gemini/GEMINI.md')
        )
        ($files | Where-Object Path -like '*CLAUDE.md').Mode | Should -Be 'Import'
        ($files | Where-Object Path -notlike '*CLAUDE.md').Mode | Sort-Object -Unique | Should -Be 'Inline'
    }

    It 'wires only the engines that are installed' {
        New-Item -ItemType Directory (Join-Path $home_ '.codex') | Out-Null

        (Get-InstructionFiles -HomeDir $home_).Path | Should -Be (Join-Path $home_ '.codex/AGENTS.md')
    }
}

Describe 'Get-InstructionBlock' {
    BeforeEach {
        $script:tmp = New-TempDir
        $script:source = Join-Path $tmp 'GLOBAL-INSTRUCTIONS.md'
        Set-File $source "# Rules`n`nBe good."
    }
    AfterEach { Remove-TempDir $tmp }

    It 'imports the file by absolute path, so an edit or git pull is live without a rerun' {
        Get-InstructionBlock -Source $source -Mode Import | Should -Be ('@' + ($source -replace '\\', '/'))
    }

    It 'inlines the file''s text for an engine that cannot import' {
        Get-InstructionBlock -Source $source -Mode Inline | Should -Be "# Rules`n`nBe good."
    }
}

Describe 'Set-ManagedBlock' {
    BeforeEach {
        $script:tmp = New-TempDir
        $script:file = Join-Path $tmp 'engine/CLAUDE.md'
    }
    AfterEach { Remove-TempDir $tmp }

    It 'creates the file, holding only the managed block, when there is none' {
        (Set-ManagedBlock -Path $file -Content 'rules v1').Status | Should -Be 'Created'

        $text = Get-Content -Raw $file
        $text | Should -BeLike "*$($script:BlockBegin)*rules v1*$($script:BlockEnd)*"
    }

    It 'appends the block to a file of the user''s own, keeping every line of it' {
        Set-File $file "# My own notes`nAlways use tabs."

        (Set-ManagedBlock -Path $file -Content 'rules v1').Status | Should -Be 'Added'

        $text = Get-Content -Raw $file
        $text | Should -BeLike "# My own notes*Always use tabs.*rules v1*"
    }

    It 'replaces only the block on a later run, leaving the user''s text around it alone' {
        Set-File $file "# Mine above"
        Set-ManagedBlock -Path $file -Content 'rules v1' | Out-Null
        Add-Content -LiteralPath $file -Value 'Mine below'

        (Set-ManagedBlock -Path $file -Content 'rules v2').Status | Should -Be 'Updated'

        $text = Get-Content -Raw $file
        $text | Should -Not -BeLike '*rules v1*'
        $text | Should -BeLike '# Mine above*rules v2*Mine below*'
        ([regex]::Matches($text, [regex]::Escape($script:BlockBegin))).Count | Should -Be 1
    }

    It 'refuses to touch a file whose markers are damaged, rather than swallow the user''s text' {
        Set-File $file "top`n$($script:BlockBegin)`nmy precious notes"
        $before = Get-Content -Raw $file

        foreach ($run in 1, 2) {
            (Set-ManagedBlock -Path $file -Content 'rules v1' -WarningAction SilentlyContinue).Status | Should -Be 'Skipped'
        }
        Get-Content -Raw $file | Should -BeExactly $before
    }

    It 'is unchanged on a rerun even when the content has Windows line endings' {
        Set-ManagedBlock -Path $file -Content "line 1`r`nline 2" | Out-Null

        (Set-ManagedBlock -Path $file -Content "line 1`r`nline 2").Status | Should -Be 'Unchanged'
    }

    It 'writes regex replacement tokens in the content literally' {
        Set-ManagedBlock -Path $file -Content 'v1' | Out-Null

        Set-ManagedBlock -Path $file -Content 'costs $5 and $& and $1' | Out-Null

        Get-Content -Raw $file | Should -BeLike '*costs $5 and $& and $1*'
    }

    It 'reports unchanged, and does not rewrite the file, on a second identical run' {
        Set-ManagedBlock -Path $file -Content 'rules v1' | Out-Null
        $before = (Get-Item $file).LastWriteTimeUtc
        Start-Sleep -Milliseconds 50

        (Set-ManagedBlock -Path $file -Content 'rules v1').Status | Should -Be 'Unchanged'
        (Get-Item $file).LastWriteTimeUtc | Should -Be $before
    }
}

Describe 'GLOBAL-INSTRUCTIONS.md' {
    It 'stays repo-private: Pull-SDLC never ships it to a consuming project' {
        $managed = (Get-Content -Raw (Join-Path $PSScriptRoot 'Pull-SDLC.ai.ps1')) -match "'GLOBAL-INSTRUCTIONS\.md'"
        $managed | Should -BeFalse
        Join-Path $PSScriptRoot 'GLOBAL-INSTRUCTIONS.md' | Should -Exist
    }
}
