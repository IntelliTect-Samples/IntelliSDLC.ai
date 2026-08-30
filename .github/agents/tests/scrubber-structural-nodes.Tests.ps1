#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behaviour tests for the scrubber's structural nodes (issue #297).
# Delegates to the zero-dep Node script `scrubber-structural-nodes.test.js`
# and asserts exit code 0.
#
# CI runs Pester over ./.github only, so this wrapper is what makes the Node
# test run on the pull request at all.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/scrubber-structural-nodes.test.js'
}

Describe 'sanitize-har structural-node coverage' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'both copies of a redundantly-stored secret are redacted' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All scrubber-structural-nodes tests passed'
    }
}
