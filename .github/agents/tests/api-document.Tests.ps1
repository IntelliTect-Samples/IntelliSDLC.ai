#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the generated per-provider server API document (issue #382).
# Delegates to the zero-dep Node suite `api-document.test.js` and asserts exit 0.
#
# CI runs Pester over ./.github and nothing else, so a Node test with no wrapper
# here never runs on the pull request while still reporting green. This file is
# what makes the api.json generator's falsifiers -- the planted claim, the stale
# artifact, the unrepresented reference -- actually execute in CI.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/api-document.test.js'
    $script:GeneratorJs = Join-Path $script:ScriptsDir 'har/generate-api-document.js'
}

Describe 'per-provider generated API document' {
    It 'the generator and its test exist at the canonical paths' {
        Test-Path -LiteralPath $script:GeneratorJs | Should -BeTrue
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'both parse without syntax errors' {
        & node --check $script:GeneratorJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
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
        # A suite that printed nothing and exited 0 would read the same as one
        # that ran -- #304's failure mode. Require the terminating line.
        ($out -join "`n") | Should -Match 'all green'
    }
}
