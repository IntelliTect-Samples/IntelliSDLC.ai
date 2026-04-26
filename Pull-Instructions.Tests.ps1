BeforeAll {
    . $PSScriptRoot/Pull-Instructions.ps1
}

Describe 'Test-IsUpstreamRepo' {
    It 'returns $true for the upstream HTTPS URL' {
        Test-IsUpstreamRepo -RemoteUrl 'https://github.com/IntelliTect-Dev/IntelliAIInstructions.git' | Should -BeTrue
    }

    It 'returns $true for the upstream SSH URL' {
        Test-IsUpstreamRepo -RemoteUrl 'git@github.com:IntelliTect-Dev/IntelliAIInstructions.git' | Should -BeTrue
    }

    It 'returns $true with no .git suffix' {
        Test-IsUpstreamRepo -RemoteUrl 'https://github.com/IntelliTect-Dev/IntelliAIInstructions' | Should -BeTrue
    }

    It 'returns $false for a consumer repo' {
        Test-IsUpstreamRepo -RemoteUrl 'https://github.com/SomeOrg/SomeProject.git' | Should -BeFalse
    }

    It 'returns $false for an empty URL' {
        Test-IsUpstreamRepo -RemoteUrl '' | Should -BeFalse
    }
}

Describe 'Invoke-TemplateScaffold' {
    BeforeEach {
        $script:src = Join-Path $TestDrive 'src'
        $script:dst = Join-Path $TestDrive 'dst'
        # Clean prior test state -- TestDrive may persist within the Describe.
        if (Test-Path $script:src) { Remove-Item -Recurse -Force $script:src }
        if (Test-Path $script:dst) { Remove-Item -Recurse -Force $script:dst }
        New-Item -ItemType Directory -Path $script:src -Force | Out-Null
        New-Item -ItemType Directory -Path $script:dst -Force | Out-Null

        # Two templates the scaffolder should know about.
        New-Item -ItemType Directory -Path (Join-Path $script:src '.github/instructions') -Force | Out-Null
        Set-Content -Path (Join-Path $script:src '.github/instructions/project.instructions.md.template') -Value 'PROJECT_TEMPLATE_BODY'
        Set-Content -Path (Join-Path $script:src 'CLAUDE.project.md.template') -Value 'CLAUDE_TEMPLATE_BODY'

        $script:map = [ordered]@{
            '.github/instructions/project.instructions.md.template' = '.github/instructions/project.instructions.md'
            'CLAUDE.project.md.template'                            = 'CLAUDE.project.md'
        }
    }

    It 'creates both bare-named files when neither exists' {
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        $result.Count | Should -Be 2
        Test-Path (Join-Path $script:dst '.github/instructions/project.instructions.md') | Should -BeTrue
        Test-Path (Join-Path $script:dst 'CLAUDE.project.md') | Should -BeTrue
    }

    It 'copies template content verbatim' {
        Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map | Out-Null
        (Get-Content (Join-Path $script:dst 'CLAUDE.project.md') -Raw).Trim() | Should -Be 'CLAUDE_TEMPLATE_BODY'
    }

    It 'creates intermediate directories when missing' {
        Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map | Out-Null
        Test-Path (Join-Path $script:dst '.github/instructions') | Should -BeTrue
    }

    It 'never overwrites an existing target file' {
        $existing = Join-Path $script:dst 'CLAUDE.project.md'
        Set-Content -Path $existing -Value 'CONSUMER_OWN_CONTENT'

        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        # Only the other template should have been scaffolded.
        $result.Count | Should -Be 1
        $result | Should -Not -Contain 'CLAUDE.project.md'
        (Get-Content $existing -Raw).Trim() | Should -Be 'CONSUMER_OWN_CONTENT'
    }

    It 'returns an empty array when all targets already exist' {
        Set-Content -Path (Join-Path $script:dst 'CLAUDE.project.md') -Value 'X'
        New-Item -ItemType Directory -Path (Join-Path $script:dst '.github/instructions') -Force | Out-Null
        Set-Content -Path (Join-Path $script:dst '.github/instructions/project.instructions.md') -Value 'X'

        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        $result.Count | Should -Be 0
    }

    It 'silently skips entries whose template is missing in source' {
        Remove-Item (Join-Path $script:src 'CLAUDE.project.md.template') -Force
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        $result.Count | Should -Be 1
        $result[0] | Should -Be '.github/instructions/project.instructions.md'
    }
}
