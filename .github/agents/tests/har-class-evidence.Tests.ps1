#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the class/evidence half of the scrub policy (issue #297,
# Stages 2-4). Delegates to the zero-dep Node scripts and asserts exit code 0.
#
#   har-shapes-class.test.js  Stage 2 -- every pattern declares a class; secrets
#                             gate, identities advise, waivers drop a finding
#                             from the gate without erasing it from the report.
#   har-shapes-walk.test.js   Stage 3 -- findings carry a key path and an entry
#                             index, occurrences are grouped and counted, and
#                             the fields we wrote ourselves are not scanned as
#                             if they were wire data.
#   har-secrets-value.test.js Stage 4 -- a value of REDACTED is a redaction, not
#                             a live credential, and the secret NAMES come from
#                             the merged policy.
#   verify-scrub-policy.test.js Stage 4 -- what the exit code does under a
#                             project policy, which is the contract capture-har
#                             reads.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'har-shapes class tagging, waivers and the structural walk' {
    # The case table is inline because -ForEach is evaluated at DISCOVERY time,
    # before BeforeAll runs; a $script: variable set there is still empty here.
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'har-shapes-class.test.js'; Expect = 'All har-shapes-class tests passed' }
        @{ Name = 'har-shapes-walk.test.js';  Expect = 'All har-shapes-walk tests passed' }
        @{ Name = 'har-secrets-value.test.js';  Expect = 'All har-secrets-value tests passed' }
        @{ Name = 'verify-scrub-policy.test.js'; Expect = 'All verify-scrub-policy tests passed' }
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
