#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for JSON-body key-path resolution and the `identifierFields`
# policy mechanism (issue #297). Delegates to the zero-dep Node script and
# asserts exit code 0.
#
#   har-identifier-fields.test.js  A finding inside a JSON body reports the key
#                                  path of the field that holds it -- including
#                                  when the body carries a big integer the
#                                  parser cannot represent, an anti-hijacking
#                                  prefix, or a nested JSON document -- and an
#                                  IDENTITY-class finding at a field the policy
#                                  declares to hold ids is reported without
#                                  blocking. A SECRET at such a field still
#                                  gates; that boundary is the dangerous one and
#                                  is pinned there.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'JSON key-path resolution and identifierFields' {
    # The case table is inline because -ForEach is evaluated at DISCOVERY time,
    # before BeforeAll runs; a $script: variable set there is still empty here.
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'har-identifier-fields.test.js'; Expect = 'All har-identifier-fields tests passed' }
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
