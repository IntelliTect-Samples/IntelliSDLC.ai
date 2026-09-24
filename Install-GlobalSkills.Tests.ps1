#Requires -Modules Pester

<#
    Behavior tests for Install-GlobalSkills.ps1 (issue #552).

    Everything runs against temp folders: the real Dropbox folder, ~/.claude
    and the User PATH are never touched. The script returns early when
    dot-sourced, so its functions load without the install running.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot 'Install-GlobalSkills.ps1')

    function New-TempDir {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('igs-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        return $dir
    }

    function Set-File([string]$Path, [string]$Value = 'x') {
        New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
        Set-Content -LiteralPath $Path -Value $Value
    }

    function New-FakeClone {
        <# The shape Test-IsSourceClone and Publish-GlobalSkills read. #>
        $root = New-TempDir
        Set-File (Join-Path $root '.github/skills/web-api-discovery/SKILL.md') 'discovery'
        Set-File (Join-Path $root '.claude/skills/wrap-up/SKILL.md') 'wrap'
        Set-File (Join-Path $root '.claude/skills/next-issue/SKILL.md') 'next'
        $tooling = Join-Path $root 'templates/web-api-discovery'
        Set-File (Join-Path $tooling 'scripts/capture/Invoke-HarCapture.ps1') 'capture'
        Set-File (Join-Path $tooling 'scripts/capture/capture-har.test.js') 'test'
        Set-File (Join-Path $tooling 'scripts/lib/helper.test-support.js') 'support'
        Set-File (Join-Path $tooling 'scripts/har/node_modules/pkg/index.js') 'dep'
        Set-File (Join-Path $tooling 'csharp/tests/Client.Tests.cs.tmpl') 'template'
        $installer = Join-Path $root 'Install-GlobalSkills.ps1'
        Set-File $installer 'installer'
        return [pscustomobject]@{ Root = $root; Installer = $installer }
    }
}

Describe 'Get-DropboxRoot' {
    BeforeEach { $script:tmp = New-TempDir }
    AfterEach { Remove-Item $script:tmp -Recurse -Force }

    It 'uses the path the Dropbox client records, not the default location' {
        $actual = New-Item -ItemType Directory -Path (Join-Path $tmp 'Elsewhere') | Select-Object -ExpandProperty FullName
        $info = Join-Path $tmp 'info.json'
        @{ personal = @{ path = $actual } } | ConvertTo-Json | Set-Content $info

        Get-DropboxRoot -InfoJsonPath $info -Fallback (Join-Path $tmp 'Dropbox') | Should -Be $actual
    }

    It 'falls back to the default location when the client has no record' {
        $fallback = New-Item -ItemType Directory -Path (Join-Path $tmp 'Dropbox') | Select-Object -ExpandProperty FullName

        Get-DropboxRoot -InfoJsonPath (Join-Path $tmp 'missing.json') -Fallback $fallback | Should -Be $fallback
    }

    It 'says Dropbox is missing rather than inventing a folder' {
        { Get-DropboxRoot -InfoJsonPath (Join-Path $tmp 'missing.json') -Fallback (Join-Path $tmp 'nope') } |
            Should -Throw '*No Dropbox folder found*'
    }
}

Describe 'Test-IsSourceClone' {
    It 'recognises a clone, which publishes' {
        $clone = New-FakeClone
        try { Test-IsSourceClone $clone.Root | Should -BeTrue }
        finally { Remove-Item $clone.Root -Recurse -Force }
    }

    It 'does not mistake a deployed folder for a clone, which only links' {
        $tmp = New-TempDir
        try { Test-IsSourceClone $tmp | Should -BeFalse }
        finally { Remove-Item $tmp -Recurse -Force }
    }
}

Describe 'Publish-GlobalSkills' {
    BeforeEach {
        $script:clone = New-FakeClone
        $script:deploy = Join-Path (New-TempDir) 'IntelliSDLC.ai'
    }
    AfterEach {
        Remove-Item $clone.Root -Recurse -Force
        Remove-Item (Split-Path $deploy -Parent) -Recurse -Force
    }

    It 'nests the tooling inside its skill, at the path the skill names' {
        Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer | Out-Null

        Join-Path $deploy 'skills/web-api-discovery/SKILL.md' | Should -Exist
        Join-Path $deploy 'skills/web-api-discovery/templates/web-api-discovery/scripts/capture/Invoke-HarCapture.ps1' | Should -Exist
        Join-Path $deploy 'skills/wrap-up/SKILL.md' | Should -Exist
        Join-Path $deploy 'skills/next-issue/SKILL.md' | Should -Exist
    }

    It 'ships the installer so another machine can link without a clone' {
        Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer | Out-Null

        Join-Path $deploy 'Install-GlobalSkills.ps1' | Should -Exist
        Join-Path $deploy $script:DeployMarker | Should -Exist
    }

    It 'leaves out the toolkit''s own tests and installed packages, but keeps test-project templates' {
        Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer | Out-Null
        $tooling = Join-Path $deploy 'skills/web-api-discovery/templates/web-api-discovery'

        Join-Path $tooling 'scripts/capture/capture-har.test.js' | Should -Not -Exist
        Join-Path $tooling 'scripts/lib/helper.test-support.js' | Should -Not -Exist
        Join-Path $tooling 'scripts/har/node_modules' | Should -Not -Exist
        Join-Path $tooling 'csharp/tests/Client.Tests.cs.tmpl' | Should -Exist
    }

    It 'changes nothing on a second run' {
        Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer | Out-Null

        Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer | Should -Be 0
    }

    It 'carries an edit and a deletion in the source to the deployment' {
        Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer | Out-Null
        Set-Content (Join-Path $clone.Root '.claude/skills/wrap-up/SKILL.md') 'wrap v2'
        Remove-Item (Join-Path $clone.Root 'templates/web-api-discovery/csharp') -Recurse -Force

        Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer | Out-Null

        Get-Content (Join-Path $deploy 'skills/wrap-up/SKILL.md') | Should -Be 'wrap v2'
        Join-Path $deploy 'skills/web-api-discovery/templates/web-api-discovery/csharp' | Should -Not -Exist
    }

    It 'refuses to mirror into a folder it did not create' {
        Set-File (Join-Path $deploy 'my-notes.txt') 'precious'

        { Publish-GlobalSkills -SourceRoot $clone.Root -DeployRoot $deploy -InstallerPath $clone.Installer } |
            Should -Throw '*was not created by this installer*'
        Get-Content (Join-Path $deploy 'my-notes.txt') | Should -Be 'precious'
    }
}

Describe 'Install-SkillLinks' {
    BeforeEach {
        $script:tmp = New-TempDir
        $script:deploy = Join-Path $tmp 'deploy'
        foreach ($name in 'web-api-discovery', 'wrap-up') { Set-File (Join-Path $deploy "skills/$name/SKILL.md") $name }
        $script:skillsDir = Join-Path $tmp 'claude-skills'
    }
    AfterEach {
        # Delete links before their targets so nothing is removed through them.
        Get-ChildItem $skillsDir -Force -ErrorAction SilentlyContinue | Where-Object LinkType | ForEach-Object { $_.Delete() }
        Remove-Item $tmp -Recurse -Force
    }

    It 'makes each deployed skill visible in the skills folder' {
        Install-SkillLinks -DeployRoot $deploy -SkillsDir $skillsDir | Out-Null

        Get-Content (Join-Path $skillsDir 'wrap-up/SKILL.md') | Should -Be 'wrap-up'
        Get-Content (Join-Path $skillsDir 'web-api-discovery/SKILL.md') | Should -Be 'web-api-discovery'
    }

    It 'reports every skill unchanged on a second run' {
        Install-SkillLinks -DeployRoot $deploy -SkillsDir $skillsDir | Out-Null

        (Install-SkillLinks -DeployRoot $deploy -SkillsDir $skillsDir).Status | Sort-Object -Unique | Should -Be 'Unchanged'
    }

    It 'never replaces a real folder of the same name' {
        Set-File (Join-Path $skillsDir 'wrap-up/SKILL.md') 'my own wrap-up'

        $result = Install-SkillLinks -DeployRoot $deploy -SkillsDir $skillsDir | Where-Object Skill -eq 'wrap-up'

        $result.Status | Should -Be 'Skipped'
        Get-Content (Join-Path $skillsDir 'wrap-up/SKILL.md') | Should -Be 'my own wrap-up'
    }

    It 'repoints a link left from an old deployment, without deleting what it pointed at' {
        $old = Join-Path $tmp 'old/wrap-up'
        Set-File (Join-Path $old 'SKILL.md') 'old'
        New-Item -ItemType ($IsWindows ? 'Junction' : 'SymbolicLink') -Path (Join-Path (New-Item -ItemType Directory $skillsDir).FullName 'wrap-up') -Target $old | Out-Null

        Install-SkillLinks -DeployRoot $deploy -SkillsDir $skillsDir | Out-Null

        Get-Content (Join-Path $skillsDir 'wrap-up/SKILL.md') | Should -Be 'wrap-up'
        Join-Path $old 'SKILL.md' | Should -Exist
    }
}

Describe 'Add-PathEntries' {
    BeforeAll { $script:sep = [System.IO.Path]::PathSeparator }

    It 'appends a missing entry' {
        Add-PathEntries -Current "a${sep}b" -Entries 'c' | Should -Be "a${sep}b${sep}c"
    }

    It 'does not add an entry twice, whatever its case or trailing separator' {
        $dir = Join-Path 'Tools' 'Capture'
        $current = "a${sep}$($dir.ToUpperInvariant())$([System.IO.Path]::DirectorySeparatorChar)"

        Add-PathEntries -Current $current -Entries $dir | Should -Be $current
    }

    It 'keeps unexpanded variables and drops empty segments' {
        Add-PathEntries -Current "%SystemRoot%${sep}${sep}b" -Entries 'c' | Should -Be "%SystemRoot%${sep}b${sep}c"
    }

    It 'accepts an empty PATH' {
        Add-PathEntries -Current '' -Entries 'c' | Should -Be 'c'
    }
}
