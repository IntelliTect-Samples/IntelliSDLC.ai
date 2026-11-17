#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for "live tests are required at provider and service
# boundaries" (issue #596).
#
# The mock guidance ("mock external dependencies with Moq", mocks for "network
# calls") never said that code crossing a provider boundary ALSO needs a live
# test. For a thin client over a third-party API a mock only restates our
# assumption about the provider, so agents produced green suites that never
# touched the real thing. These tests pin the rule in copilot-instructions.md
# and pin every place that tells an agent to mock to it, so a revert of any
# one file fails here.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path

    # A section is its heading line plus every line up to the next heading of
    # the same or a higher level.
    function Get-Section {
        param([string]$Path, [string]$HeadingPattern)
        $lines = Get-Content -LiteralPath $Path
        $start = -1; $level = 0
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^(#{1,6})\s+$HeadingPattern") {
                $start = $i; $level = $Matches[1].Length; break
            }
        }
        if ($start -lt 0) { return $null }
        $end = $lines.Count
        for ($j = $start + 1; $j -lt $lines.Count; $j++) {
            if ($lines[$j] -match '^(#{1,6})\s' -and $Matches[1].Length -le $level) { $end = $j; break }
        }
        return ($lines[$start..($end - 1)]) -join "`n"
    }

    $script:Rule = Get-Section -Path (Join-Path $script:RepoRoot '.github/copilot-instructions.md') `
        -HeadingPattern 'Provider\s+and\s+Service\s+Boundaries'
}

Describe 'copilot-instructions.md states the boundary rule' {
    It 'has a Provider and Service Boundaries section' {
        $script:Rule | Should -Not -BeNullOrEmpty
    }

    It 'requires a live test for every operation that crosses a boundary' {
        $script:Rule | Should -Match '(?i)every\s+operation\s+that\s+crosses'
        $script:Rule | Should -Match '(?i)live\s+test'
    }

    It 'keeps unit tests with mocks for logic on our side, so both kinds have a place' {
        $script:Rule | Should -Match '(?i)our\s+side\s+of\s+the\s+boundary'
        $script:Rule | Should -Match '(?i)mocks?\s+or\s+fakes?'
    }

    It 'says why a mock cannot stand in at the boundary' {
        $script:Rule | Should -Match '(?i)cannot\s+fail\s+when\s+(that|the)\s+assumption\s+is\s+wrong'
    }

    It 'forbids a live test that passes silently when it could not run' {
        $script:Rule | Should -Match '(?i)skip\s+with\s+a\s+(stated\s+)?reason'
        $script:Rule | Should -Match '(?i)never\s+(pass|report)\s+(silently|green)'
    }

    It 'confines live writes to an opt-in, disposable resource cleaned up afterwards' {
        $script:Rule | Should -Match '(?i)opt-in'
        $script:Rule | Should -Match '(?i)disposable'
        $script:Rule | Should -Match '(?i)finally'
    }
}

Describe 'every place that tells an agent to mock points at the boundary rule' -ForEach @(
    @{ File = '.github/instructions/csharp.instructions.md' }
    @{ File = '.github/instructions/powershell.instructions.md' }
    @{ File = '.github/instructions/copilot-coding-agent.instructions.md' }
    @{ File = '.github/skills/behavior-first-testing/SKILL.md' }
) {
    It '<File> names Provider and Service Boundaries' {
        Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot $File) |
            Should -Match 'Provider\s+and\s+Service\s+Boundaries'
    }
}
