#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the AUDIT's ENVELOPE-vs-CAPTURED field-name distinction
# (issue #375). Delegates to the zero-dep Node script and asserts exit code 0.
#
#   audit-envelope-field-names.test.js  `audit-scrub-drift.js` emits envelope
#                                       strings with paths of the form
#                                       `${ctx}.headers.${h.name}`,
#                                       `${ctx}.cookies.${c.name}` and
#                                       `request.queryString.${q.name}` -- the
#                                       path's LAST SEGMENT is that header,
#                                       cookie or query-parameter's OWN NAME,
#                                       not a JSON field the captured document
#                                       chose. A card-shaped value seen ONLY
#                                       under an id-shaped envelope name (a
#                                       header literally called `X-Media-Id`,
#                                       say) must be adjudicated CLEAN, not
#                                       CORRUPTED / identifier-field-rewritten.
#                                       A card-shaped value at a genuine BODY
#                                       field of the same shape must still be
#                                       CORRUPTED -- that boundary is the easy
#                                       over-correction and is pinned here.
#
# This is NOT #369/#374 (the GATE's envelope-property defect, pinned by
# har-envelope-field-names.Tests.ps1 against har-shapes.js). This wrapper
# targets the AUDIT, on audit-scrub-drift.js, and is named distinctly so it
# cannot collide with that file while both land concurrently.
#
# The wrapper is not ceremony: CI runs Pester over ./.github only, so a node
# test file reaches the pipeline solely by being shelled out to from here.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'the scrub-drift audit does not treat an envelope property name as a captured field name (issue #375)' {
    # The case table is inline because -ForEach is evaluated at DISCOVERY time,
    # before BeforeAll runs; a $script: variable set there is still empty here.
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'audit-envelope-field-names.test.js'; Expect = 'All audit-envelope-field-names tests passed' }
    ) {
        $testJs = Join-Path $script:ScriptsDir "har/$Name"
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match $Expect
    }

    # This mutator list is DUPLICATED VERBATIM in
    # audit-scrub-drift.Tests.ps1's 'ships no repair path' block (both assert
    # against the same file, audit-scrub-drift.js, from two issues -- #335 and
    # #375 -- that landed concurrently). The two lists MUST stay identical: if
    # you add or remove a mutator name here, make the same edit there, and vice
    # versa. Left as two copies with this note (rather than a shared helper)
    # because there is no established pattern in .github/agents/tests for
    # sharing a check body between two otherwise independent Pester files.
    It 'audit-scrub-drift.js still has no repair path after this change' {
        $auditJs = Join-Path $script:ScriptsDir 'har/audit-scrub-drift.js'
        $source = Get-Content -LiteralPath $auditJs -Raw
        foreach ($mutator in 'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync',
                             'rmdirSync', 'renameSync', 'mkdirSync', 'createWriteStream',
                             'copyFileSync', 'truncateSync', 'utimesSync') {
            $source | Should -Not -Match ([regex]::Escape($mutator))
        }
    }
}
