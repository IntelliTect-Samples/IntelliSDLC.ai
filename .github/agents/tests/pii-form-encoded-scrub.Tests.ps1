#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for scrubbing a PERCENT-ENCODED form body (issue #479).
# Delegates to the zero-dep Node script `pii-form-encoded-scrub.test.js`
# and asserts exit code 0.
#
# Detection and replacement used to run over the encoded text as plain text,
# so `%22` was read as the two digits `22` rather than as a delimiter. Those
# digits join the adjacent value and change its measured LENGTH, which is how
# the digit-run detectors decide what a value is -- and it fails BOTH ways:
# two extra digits can complete a 14-digit id into a card-length run, whose
# replacement then overwrites the escape and leaves the body unparseable; or
# extend a real 16-digit card to 18 and push it out of range, so the card is
# never detected and ships in the clear.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/pii-form-encoded-scrub.test.js'
}

Describe 'pii.js form-encoded body scrub' {
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
        ($out -join "`n") | Should -Match 'All pii-form-encoded-scrub tests passed'
    }
}
