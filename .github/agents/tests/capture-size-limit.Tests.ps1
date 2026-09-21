#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests that pin issue #528 -- a capture
# too large to hold as a single string says so BY NAME, and says it while the
# session can still be saved. Pester is the only suite CI runs, so a Node test
# with no wrapper here is a test that never runs on a pull request.
#
#   lib/capture-size.test.js              the one definition of the ceiling and
#                                         the bands below it: the limit is the
#                                         runtime's own rather than a copied hex
#                                         literal, boundaries belong to the band
#                                         below them, every message names the
#                                         file, its size and the limit, and the
#                                         errors the runtime really raises when a
#                                         string cannot exist are recognised.
#
#   har/sanitize-har-size-limit.test.js   the scrub refuses an oversized capture
#                                         on a stat alone, before profile and
#                                         policy loading, writing nothing and
#                                         leaving the raw untouched -- and does
#                                         not pass the band below the ceiling in
#                                         silence.
#
#   capture/capture-size-warning.test.js  the recorder warns once, during
#                                         recording, which is the only moment an
#                                         operator can still stop, split the
#                                         session or narrow the filter.
#
# WHY AN OVERSIZED FIXTURE IS CHEAP. The scrub half creates its input with
# `ftruncate`, which sets a file's length without writing its contents, so a
# 600 MB capture exists in milliseconds and is never read past the `statSync`.
# If this wrapper ever becomes slow, that is the regression: something started
# reading the file.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'a capture too large to read whole says so, in time (#528)' {
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'lib/capture-size.test.js';              Expect = 'All capture-size tests passed' }
        @{ Name = 'har/sanitize-har-size-limit.test.js';   Expect = 'All sanitize-har size-limit tests passed' }
        @{ Name = 'capture/capture-size-warning.test.js';  Expect = 'All capture size-warning tests passed' }
    ) {
        $testJs = Join-Path $script:ScriptsDir $Name
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
