#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# the scrub may not leave a value its own substitution table says to replace (issue #475)
# Delegates to the zero-dep Node script `subs-survivors.test.js`.
#
# The wrapper is not ceremony: CI runs Pester over ./.github only, so a node test
# file reaches the pipeline solely by being shelled out to from here. Without
# this file the node test passes locally, never runs on a PR, and reports green
# either way -- which is the failure `node-test-coverage.Tests.ps1` exists to
# catch.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:ModuleJs   = Join-Path $script:ScriptsDir 'har/subs-survivors.js'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/subs-survivors.test.js'
}

Describe 'the substitution table is a post-condition on the scrub (issue #475)' {
    It 'the module and its test file exist at the canonical paths' {
        Test-Path -LiteralPath $script:ModuleJs | Should -BeTrue
        Test-Path -LiteralPath $script:TestJs   | Should -BeTrue
    }

    It 'both parse without syntax errors' {
        & node --check $script:ModuleJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions pass' {
        $out  = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All subs-survivors tests passed'
    }

    # The module reads a table whose keys are the plaintext credential store.
    # It must have no way to put one anywhere: no file it could write, and no
    # console it could print to. Pinned here rather than left to a reviewer,
    # because the sanctioned escape -- "just log it while debugging" -- is
    # exactly how #475 rendered live session cookies.
    It 'cannot write a file or print anything' {
        $source = Get-Content -LiteralPath $script:ModuleJs -Raw
        foreach ($escape in 'writeFileSync', 'appendFileSync', 'createWriteStream',
                            'console.log', 'console.error', 'process.stdout', 'process.stderr') {
            $source | Should -Not -Match ([regex]::Escape($escape))
        }
    }
}
