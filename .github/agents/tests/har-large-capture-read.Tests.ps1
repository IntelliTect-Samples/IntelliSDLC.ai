#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Reading captures larger than a JavaScript string through the one read
# boundary, and the walk-only stages that stream it (issue #450).
# Delegates to the zero-dep Node script `har-large-capture-read.test.js`.
#
# CI runs Pester over ./.github only, so a node test file reaches the pipeline
# solely by being shelled out to from here.
#
# WHY THIS SUITE IS SLOW, deliberately. It builds a ~150 MB capture and runs
# each migrated stage over it in a child process capped at a 64 MB heap, with
# the old whole-document read required to FAIL under the same cap -- and it
# writes a file just past Node's maximum string length to prove the boundary
# reads one. The issue asks for memory to be confirmed by measurement; removing
# the large files would make the suite fast and its central claim untested.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-large-capture-read.test.js'
    $script:ModuleJs   = Join-Path $script:ScriptsDir 'har/har-document.js'
}

Describe 'captures larger than a JavaScript string read through the boundary (issue #450)' {
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
        ($out -join "`n") | Should -Match 'All large-capture read tests passed'
    }
}
