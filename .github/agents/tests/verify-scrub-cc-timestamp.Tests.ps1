#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests that pin the `credit-card`
# predicate. Pester is the only suite CI runs, so a Node test with no wrapper
# here is a test that never runs on a pull request.
#
#   verify-scrub-cc-timestamp.test.js  issue #87  -- a Luhn-valid 13-digit
#                                      Unix-millisecond timestamp is not a card.
#   verify-scrub-cc-decimal.test.js    issue #292 -- the fractional (or integer)
#                                      part of a decimal number is not a card.
#   verify-scrub-cc-iin.test.js        issue #295 -- a Luhn-valid digit run is
#                                      not a card unless it also carries an
#                                      assigned issuer identifier at a length
#                                      that issuer mints.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'verify-scrub credit-card predicate' {
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'verify-scrub-cc-timestamp.test.js'; Expect = 'All verify-scrub-cc-timestamp tests passed' }
        @{ Name = 'verify-scrub-cc-decimal.test.js';   Expect = 'verify-scrub-cc-decimal: \d+ case\(s\) passed' }
        @{ Name = 'verify-scrub-cc-iin.test.js';       Expect = 'All verify-scrub-cc-iin tests passed' }
    ) {
        $testJs = Join-Path $script:ScriptsDir "har/$Name"
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match $Expect
    }
}
