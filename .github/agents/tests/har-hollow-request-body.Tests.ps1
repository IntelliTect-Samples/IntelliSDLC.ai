#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for gate 7 -- a request body PRESENT but replaced by a
# placeholder (issue #358). Delegates to the zero-dep Node script
# `har-hollow-request-body.test.js`.
#
# What it pins: a committed reference whose request body was REPLACED (not
# shortened) fails the gate, naming the file and the entry index and quoting
# nothing of the body; a body that carries payload structure -- a JSON object
# or array, or anything joining two parts with a separator -- still passes; a
# body already reported as truncated stays gate 1's and is not double-reported.
#
# The `node --check` step is not boilerplate here. The gate's predicate is
# built from regex LITERALS, and the failure mode this issue warns about is a
# pattern that cannot compile surfacing through the runner as a failing
# assertion -- indistinguishable from the gate having found a real defect.
# Checking the syntax of the gate itself separates the two.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-hollow-request-body.test.js'
    $script:GateJs     = Join-Path $script:ScriptsDir 'har/verify-har-reference.js'
}

Describe 'web-api-discovery hollow request body gate' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'the gate it exercises parses without syntax errors' {
        & node --check $script:GateJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0 -Because (
            'a regex literal that cannot compile is a SyntaxError for the whole gate, and ' +
            'that reaches a test runner looking exactly like a real finding')
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
        ($out -join "`n") | Should -Match 'All har-hollow-request-body tests passed'
    }
}
