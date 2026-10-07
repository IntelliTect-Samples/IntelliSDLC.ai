#Requires -Version 7
Set-StrictMode -Version Latest

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '../../..')
    $script:Path = Join-Path $script:RepoRoot '.github/instructions/console-ui.instructions.md'
    $script:Content = if (Test-Path $script:Path) { Get-Content -LiteralPath $script:Path -Raw } else { '' }
}

Describe 'console-ui.instructions.md (Issue #581)' {
    It 'exists with applyTo frontmatter' {
        Test-Path $script:Path | Should -BeTrue
        $script:Content | Should -Match "(?s)\A---\s.*applyTo:\s*'[^']+'.*?---"
    }

    It 'requires one line per item, updated in place' {
        $script:Content | Should -Match 'One line per item'
    }

    It 'forbids absolute cursor rows in favour of cursor-relative updates' {
        $script:Content | Should -Match 'never to absolute rows'
        $script:Content | Should -Match 'ESC\[nA'
        $script:Content | Should -Match 'ESC\[K'
    }

    It 'keeps escape sequences out of redirected output' {
        $script:Content | Should -Match 'Redirected output is a different mode'
    }

    It 'asks for tests against a fake screen, not the raw text' {
        $script:Content | Should -Match 'fake screen'
    }

    It 'is referenced from CLAUDE.md and copilot-instructions.md' {
        Get-Content -LiteralPath (Join-Path $script:RepoRoot 'CLAUDE.md') -Raw | Should -Match 'console UI'
        Get-Content -LiteralPath (Join-Path $script:RepoRoot '.github/copilot-instructions.md') -Raw |
            Should -Match 'console-ui\.instructions\.md'
    }
}
