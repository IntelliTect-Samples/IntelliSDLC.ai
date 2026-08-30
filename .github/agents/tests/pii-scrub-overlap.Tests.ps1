#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for how the PII replacement pass arbitrates between detected
# values that overlap each other (issue #326).
# Delegates to the zero-dep Node script `pii-scrub-overlap.test.js`
# and asserts exit code 0.
#
# The case that matters is STAGGERED overlap -- two values sharing characters
# at different start positions, the shorter starting first. A scanner that
# arbitrates only among candidates sharing a start position leaves the longer
# value's tail unscrubbed, which ships real PII in the clear.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/pii-scrub-overlap.test.js'
}

Describe 'pii.js scrub overlap arbitration' {
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
        ($out -join "`n") | Should -Match 'All pii-scrub-overlap tests passed'
    }
}
