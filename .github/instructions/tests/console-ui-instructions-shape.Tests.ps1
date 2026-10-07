#Requires -Version 7
Set-StrictMode -Version Latest

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '../../..')
    $script:Path = Join-Path $script:RepoRoot '.github/instructions/console-ui.instructions.md'
    $script:Content = if (Test-Path $script:Path) { Get-Content -LiteralPath $script:Path -Raw } else { '' }

    function script:Read([string] $relative) {
        Get-Content -LiteralPath (Join-Path $script:RepoRoot $relative) -Raw
    }
}

Describe 'console-ui.instructions.md (Issue #581)' {
    It 'exists with applyTo in its frontmatter block' {
        Test-Path $script:Path | Should -BeTrue
        # Anchored to the first frontmatter block, so an applyTo in the body cannot satisfy it.
        $script:Content | Should -Match "\A---\r?\n(?:(?!---)[\s\S])*applyTo:\s*'[^']+'"
    }

    It 'requires one line per item, updated in place' {
        $script:Content | Should -Match 'One line per item'
    }

    It 'forbids absolute cursor rows in favour of cursor-relative updates' {
        $script:Content | Should -Match 'never to absolute rows'
        $script:Content | Should -Match 'ESC\[nA'
        $script:Content | Should -Match 'ESC\[K'
    }

    It 'decides the mode from the stream actually written to, never from whether a layout fits' {
        $script:Content | Should -Match 'Check the stream you actually write to'
        $script:Content | Should -Match 'Never decide the mode from whether a layout fits'
    }

    It 'keeps escape sequences out of plain mode' {
        $script:Content | Should -Match 'emit no escape sequences at all'
    }

    It 'restores a hidden cursor on every exit path' {
        $script:Content | Should -Match 'ESC\[\?25h'
    }

    It 'asks for tests against a fake screen, not the raw text' {
        $script:Content | Should -Match 'fake screen'
    }

    It 'is referenced from CLAUDE.md, copilot-instructions.md, README.md and the required-files check' {
        Read 'CLAUDE.md' | Should -Match 'console-ui\.instructions\.md'
        Read '.github/copilot-instructions.md' | Should -Match 'console-ui\.instructions\.md'
        Read 'README.md' | Should -Match '`console-ui`'
        Read '.github/workflows/validate-instructions.yml' | Should -Match '\.github/instructions/console-ui\.instructions\.md'
    }
}
