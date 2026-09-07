#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# sanitize-har.js is a CLI *and* a library (issue #446).
# Delegates to the zero-dep Node script `sanitize-har-importable.test.js`.
#
# A NEW wrapper rather than an extra It in scrub-scripts.Tests.ps1: that file's
# BeforeAll builds one shared fixture project and its Describes are about what
# the scrub DOES to a capture. This suite is about the module's packaging --
# whether importing it does work -- and needs its own throwaway project per
# section so "nothing was written" is a statement about the guard rather than
# about leftovers from a previous It. Keeping them apart also keeps the
# consolidation scan (section 4) off a file whose subject is scrubbing.
#
# The wrapper is not ceremony: CI runs Pester over ./.github only, so a node
# test file reaches the pipeline solely by being shelled out to from here.
# Without this file the node test passes locally and never runs on a PR --
# and node-test-coverage.Tests.ps1 fails until it exists.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/sanitize-har-importable.test.js'
}

Describe 'sanitize-har.js is importable without running a scrub (issue #446)' {
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
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All sanitize-har-importable tests passed'
    }
}
