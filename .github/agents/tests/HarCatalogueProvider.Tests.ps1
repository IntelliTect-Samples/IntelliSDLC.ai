#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for issue #428 -- buildCatalogueScaffold fills `Provider`
# from the ROW's own endpoint host (`group.host`), never from the capture's
# start URI.
#
# The wrapper is not ceremony -- CI runs Pester over ./.github only, so the
# zero-dep Node suite that actually pins this behavior reaches the pipeline
# solely by being shelled out to from here. The assertions themselves live in
# capture-har.test.js, alongside the rest of the scaffold's behavior tests;
# this wrapper only makes sure they run in CI and surfaces the output on
# failure.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'capture/capture-har.test.js'
}

Describe 'catalogue scaffold Provider, derived per row from the row''s own endpoint host (issue #428)' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions pass, including the Provider derivation tests' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All capture-har tests passed'
    }
}
