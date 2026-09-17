#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Five CLI entry points are commands *and* modules (issue #456).
# Delegates to the zero-dep Node script `cli-entry-points-importable.test.js`.
#
# A NEW wrapper rather than an extra It in sanitize-har-importable.Tests.ps1:
# that suite's subject is one file and the filename consolidation the guard on
# it made possible. This one's subject is the other five scripts the #446
# survey found, and it needs a throwaway project per script so "nothing was
# written" is a statement about that script's guard rather than about leftovers
# from the previous one.
#
# The wrapper is not ceremony: CI runs Pester over ./.github only, so a node
# test file reaches the pipeline solely by being shelled out to from here.
# Without this file the node test passes locally and never runs on a PR --
# and node-test-coverage.Tests.ps1 fails until it exists.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'lib/cli-entry-points-importable.test.js'
}

Describe 'Five CLI entry points are importable without running their work (issue #456)' {
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
        ($out -join "`n") | Should -Match 'All cli-entry-points-importable tests passed'
    }
}
