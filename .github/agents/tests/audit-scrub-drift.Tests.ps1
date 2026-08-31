#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# the scrub-drift audit reports CLEAN / CORRUPTED / UNADJUDICABLE and never repairs (issue #335)
# Delegates to the zero-dep Node script `audit-scrub-drift.test.js`.
#
# The wrapper is not ceremony: CI runs Pester over ./.github only, so a node test
# file reaches the pipeline solely by being shelled out to from here. Without
# this file the node test passes locally, never runs on a PR, and reports green
# either way -- which is the failure `node-test-coverage.Tests.ps1` exists to
# catch.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:AuditJs    = Join-Path $script:ScriptsDir 'har/audit-scrub-drift.js'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/audit-scrub-drift.test.js'
}

Describe 'the scrub-drift audit reports three outcomes and never repairs (issue #335)' {
    It 'the audit and its test file exist at the canonical paths' {
        Test-Path -LiteralPath $script:AuditJs | Should -BeTrue
        Test-Path -LiteralPath $script:TestJs  | Should -BeTrue
    }

    It 'both parse without syntax errors' {
        & node --check $script:AuditJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions pass' {
        $out  = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All audit-scrub-drift tests passed'
    }

    # The audit is READ-ONLY by design, and repair is a separate human-approved
    # step. A `--fix` arriving later would not be a feature, it would be the
    # thing the issue deliberately kept out -- so its absence is pinned here
    # rather than left to a reviewer to notice.
    It 'ships no repair path -- it cannot write, delete or rename anything' {
        $source = Get-Content -LiteralPath $script:AuditJs -Raw
        foreach ($mutator in 'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync',
                             'rmdirSync', 'renameSync', 'mkdirSync', 'createWriteStream',
                             'copyFileSync', 'truncateSync', 'utimesSync') {
            $source | Should -Not -Match ([regex]::Escape($mutator))
        }
    }
}
