#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the gate's ENVELOPE-vs-CAPTURED field-name distinction
# (issue #369). Delegates to the zero-dep Node script and asserts exit code 0.
#
#   har-envelope-field-names.test.js  A HAR property name -- `value` on a
#                                     header, a cookie or a query pair, `url`
#                                     on a request, `text` on a body node -- is
#                                     never read as a captured field name, so a
#                                     project declaring an identifier pattern
#                                     that happens to match one cannot switch
#                                     off gate reporting for entire classes of
#                                     finding. A card-shaped value at a genuine
#                                     BODY field of the same name is still
#                                     suppressed; that boundary is the easy
#                                     over-correction and is pinned here.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'HAR envelope property names are not captured field names' {
    # The case table is inline because -ForEach is evaluated at DISCOVERY time,
    # before BeforeAll runs; a $script: variable set there is still empty here.
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'har-envelope-field-names.test.js'; Expect = 'All har-envelope-field-names tests passed' }
    ) {
        $testJs = Join-Path $script:ScriptsDir "har/$Name"
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match $Expect
    }
}
