#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the merged scrub policy (issue #297, Stage 1).
# Delegates to the zero-dep Node script `har-policy.test.js` and asserts exit code 0.
#
# The policy is the one document the scrubber and both verifiers will read, so
# the floor it enforces -- a consumer may lower an identity class, never a
# secret class -- is the check that has to hold in CI, not only on a desk.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-policy.test.js'
    $script:DefaultJson = Join-Path $script:ScriptsDir 'har/har-policy.default.json'
}

Describe 'har-policy merged scrub policy' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'the synced default policy ships beside the loader' {
        Test-Path -LiteralPath $script:DefaultJson | Should -BeTrue
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
        ($out -join "`n") | Should -Match 'All har-policy tests passed'
    }
}
