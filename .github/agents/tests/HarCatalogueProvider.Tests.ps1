#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for issue #428 -- buildCatalogueScaffold fills `Provider`
# from the ROW's own endpoint host (`group.host`), never from the capture's
# start URI.
#
# capture-har.test.js already reaches CI through har-recording.Tests.ps1 --
# this is a second, issue-scoped entry point onto the SAME node suite, not
# the only one, matching the convention other single-issue wrappers in this
# directory follow (e.g. HarAuditEnvelopeFieldNames.Tests.ps1). It names the
# suite where issue #428 is easy to find and re-run, and it surfaces the
# output on failure; the assertions themselves live in capture-har.test.js,
# alongside the rest of the scaffold's behavior tests.

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
