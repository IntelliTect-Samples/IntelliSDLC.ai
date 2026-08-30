#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for response-body truncation (issue #297, Stage 8).
# Delegates to the zero-dep Node script `har-truncation.test.js`.
#
# What it pins: `--max-response-bytes` is opt-in so nothing is cut unless asked
# for; a cut that IS asked for is recorded structurally and never written into
# the payload; and the reference gate fails a truncated RESPONSE in either
# spelling -- the structured marker, or the inline one the consumer-side
# exporter writes, which cuts the payload mid-string and evades a structured
# audit.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-truncation.test.js'
}

Describe 'web-api-discovery response-body truncation' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-truncation tests passed'
    }
}
