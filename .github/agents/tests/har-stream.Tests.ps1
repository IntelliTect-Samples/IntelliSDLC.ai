#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Streaming read and write for captures larger than a JavaScript string (issue #450).
# Delegates to the zero-dep Node script `har-stream.test.js`.
#
# The wrapper is not ceremony: CI runs Pester over ./.github only, so a node
# test file reaches the pipeline solely by being shelled out to from here.
# Without this file the node test passes locally and never runs on a PR --
# and node-test-coverage.Tests.ps1 fails until it exists.
#
# WHY THIS SUITE IS SLOWER THAN ITS NEIGHBOURS, deliberately. One of its
# sections builds a ~150 MB capture in the temp directory and runs the reader
# over it in a child process capped at a 64 MB heap, because the issue asks for
# memory to be confirmed by measurement rather than by reading the code. That
# section also runs the OLD whole-document read under the same cap and requires
# it to FAIL, so a pass distinguishes a streaming reader from a machine that
# simply had enough memory. Removing the large file would make the suite fast
# and make its central claim untested.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'lib/har-stream.test.js'
    $script:ModuleJs   = Join-Path $script:ScriptsDir 'lib/har-stream.js'
}

Describe 'har-stream.js streams captures larger than a JavaScript string (issue #450)' {
    It 'the module exists at the canonical path' {
        Test-Path -LiteralPath $script:ModuleJs | Should -BeTrue
    }

    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:ModuleJs 2>&1 | Out-Null
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
        ($out -join "`n") | Should -Match 'All har-stream tests passed'
    }
}
