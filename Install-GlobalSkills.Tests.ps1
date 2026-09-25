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
        Get-ChildItem $Dir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object LinkType | ForEach-Object { $_.Delete() }
        Remove-Item $Dir -Recurse -Force
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

    It 'refuses a folder that is not a clone' {
        $tmp = New-TempDir
        try { { Get-MainCheckout $tmp } | Should -Throw '*not inside a git clone*' }
        finally { Remove-TempDir $tmp }
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

    It 'removes its own link to a skill that is gone, and leaves other links alone' {
        Install-SkillLinks -Root $root -Skills $skills -SkillsDir $skillsDir | Out-Null
        $elsewhere = Join-Path $tmp 'elsewhere/gone'
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
