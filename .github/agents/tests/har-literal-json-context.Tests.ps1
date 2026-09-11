#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the literal pass and JSON value context (issue #482).
# Delegates to the zero-dep Node script `har-literal-json-context.test.js`
# and asserts exit code 0.
#
# The literal pass runs over the SERIALIZED HAR as text, so it does not know
# what context a literal sat in. Replacing a quoted string is harmless; replacing
# a bare JSON NUMBER emitted `:<Sentinel>` unquoted and the document stopped
# parsing -- while the leak gate passed it, because the gate asks whether a
# secret survived and never whether the document is still a document.
#
# The fixtures NEST on purpose: a HAR carries bodies as strings, so an embedded
# document appears with its quotes escaped, and a fix that emits a bare quote
# would repair the outer document by breaking the inner one.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-literal-json-context.test.js'
}

Describe 'har-literals.js JSON value context' {
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
        ($out -join "`n") | Should -Match 'All har-literal-json-context tests passed'
    }
}
