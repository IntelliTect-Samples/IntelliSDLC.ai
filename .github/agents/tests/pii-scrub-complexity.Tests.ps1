#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the PII replacement pass's complexity (issue #326).
# Delegates to the zero-dep Node script `pii-scrub-complexity.test.js`
# and asserts exit code 0.
#
# The Node test asserts a RATIO between two input sizes, never a wall clock,
# so it measures the growth curve rather than the speed of the runner. That is
# what lets it run here: a loaded CI machine moves both measurements together
# and the ratio is unchanged.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/pii-scrub-complexity.test.js'
}

Describe 'pii.js scrub complexity' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All pii-scrub-complexity tests passed'
    }
}
