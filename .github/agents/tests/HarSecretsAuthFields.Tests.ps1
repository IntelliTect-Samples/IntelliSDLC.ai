#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for auth-flow secret field names (issue #378).
#
# A capture of a LOGIN is an input class the scrub had never seen: every prior
# capture was of an already-authenticated session, so `secretFields` named only
# post-login state and the gate reported `(verified)` over an output still
# carrying a live password envelope.
#
# Delegates to the zero-dep Node script `har-auth-secret-fields.test.js` and
# asserts exit code 0. `node --test <dir>` is deliberately not used: it fails
# on Node 26, so the file is named explicitly.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-auth-secret-fields.test.js'
    $script:PolicyJson = Join-Path $script:ScriptsDir 'har/har-policy.default.json'
}

Describe 'har auth-flow secret field names' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'the shipped policy is still valid JSON' {
        # The change is data, so a trailing comma would disable the entire
        # scrub rather than fail one assertion.
        { Get-Content -LiteralPath $script:PolicyJson -Raw | ConvertFrom-Json } | Should -Not -Throw
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-auth-secret-fields tests passed'
    }
}
