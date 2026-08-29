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
    $script:IssuersJs  = Join-Path $script:ScriptsDir 'har/har-card-issuers.test.js'
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

# Issuer identification ranges are a public payment-network standard, so the
# shipped table stays in har-shapes.js -- but which markets a consumer operates
# in is a project fact, and "patch upstream" is not an override path. The policy
# appends ranges and can never subtract one, and Maestro is deliberately absent
# from the default because its range overlaps Discover and UnionPay and would
# reopen the false-positive surface #295 closed.
Describe 'har-policy extendable card issuer ranges' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:IssuersJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:IssuersJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:IssuersJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-card-issuers tests passed'
    }
}
