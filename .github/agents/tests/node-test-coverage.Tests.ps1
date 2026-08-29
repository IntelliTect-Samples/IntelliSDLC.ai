#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Every Node test file must be reachable from CI.
#
# The failure this exists to stop is a quiet one. CI runs Pester over ./.github
# and nothing else, so a `*.test.js` added under templates/ with no wrapper in
# this directory passes on the author's machine, is never executed on the pull
# request, and reports green either way. That is worse than having no test: the
# suite's own coverage is what a reviewer trusts when deciding a change is safe.
#
# It is the same class of defect as #304 -- a suite that never ran reading as a
# suite that passed -- and it is fixed the same way, by asserting the property
# mechanically instead of relying on anyone remembering the convention.
#
# A wrapper "covers" a test file when some .Tests.ps1 in this directory names it
# by filename. That is deliberately a weak check: it cannot verify the wrapper
# actually invokes node, and it does not try to. What it CAN do is guarantee no
# test file is orphaned, which is the failure that actually happens.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'

    $script:NodeTests = @(
        Get-ChildItem -LiteralPath $script:ScriptsDir -Recurse -File -Filter '*.test.js' |
            Select-Object -ExpandProperty Name |
            Sort-Object -Unique
    )

    # One read of every wrapper, joined, so the lookup below is a substring test
    # rather than a re-read per candidate.
    $script:WrapperText = (
        Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.Tests.ps1' |
            ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }
    ) -join "`n"
}

Describe 'Node test files are covered by a Pester wrapper' {
    It 'finds Node test files to check' {
        # A zero-length list would make every assertion below vacuously true,
        # which is the exact false green this file exists to prevent.
        $script:NodeTests.Count | Should -BeGreaterThan 0
    }

    It 'every *.test.js under templates/web-api-discovery/scripts is named by a wrapper' {
        $orphans = @($script:NodeTests | Where-Object { -not $script:WrapperText.Contains($_) })

        $orphans -join ', ' | Should -BeExactly '' -Because (
            'CI runs Pester over ./.github only, so a Node test no wrapper names never ' +
            'runs on the pull request while still reporting green. Add a wrapper in ' +
            '.github/agents/tests/ that invokes it and asserts $LASTEXITCODE is 0.')
    }
}
