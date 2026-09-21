#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests that pin issue #529. Pester is
# the only suite CI runs, so a Node test with no wrapper here is a test that
# never runs on a pull request.
#
#   scrub-coordinate-reach.test.js  issue #529 -- a detected coordinate is a
#                                   NUMBER and has no text spelling to enrol,
#                                   so the scrub must not rewrite the digits of
#                                   URLs, hashes, or its own redaction
#                                   sentinels; and a known-secret finding must
#                                   say which entry and which field it is in.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'scrub coordinate reach' {
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'scrub-coordinate-reach.test.js'; Expect = 'All scrub-coordinate-reach tests passed' }
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
