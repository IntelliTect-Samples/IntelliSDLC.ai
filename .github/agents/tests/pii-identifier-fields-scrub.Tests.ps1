#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for issue #360: the SCRUBBER must consult `identifierFields`
# the way the GATE already does.
# Delegates to the zero-dep Node script `pii-identifier-fields-scrub.test.js`
# and asserts exit code 0.
#
# The gap this closes. `har-shapes.js` marks a finding `identifierField` when an
# IDENTITY value sits at a field the policy declares to hold object ids, and
# `blocksLeak` then declines to fail the run (#328). `pii.js` never asked the
# question, so the same value the gate had agreed was an object id was still
# REPLACED with a generated fake. That is the design doc's beat 5 -- a predicate
# has two halves, and unifying one moves the divergence -- landing on the half
# where a false positive is silent and permanent rather than noisy and
# reversible.
#
# The predicate is CONSUMED, not copied: `har-shapes.isIdentifierShaped` states
# the scope in one place (identity class only, secret never, a resolved key path
# only) and both engines now reach the decision through it.
#
# The headline case is a PROPERTY over generated documents rather than a list of
# field names, because three review rounds on the gate side each found a name a
# curated list had not imagined. The generator is seeded with the ADJACENT
# shapes -- a value staggered between an identifier field and a plain one, an
# identifier field holding an array, a header / cookie / query parameter whose
# NAME is a declared identifier field but which has no resolved key path, and a
# secret-class value under an `*id` name.
#
# Every assertion in the Node suite was ablated: the seam, the promotion rule,
# the scope restriction, the mark, the retained row, the run's own report, the
# export, and the generator's coverage guards were each broken in turn and the
# suite watched to fail. The generator guard caught a real defect in itself that
# way -- it was reading the PLAN rather than the built document, so a `harWith`
# that dropped the generated name would have left it green.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/pii-identifier-fields-scrub.test.js'
}

Describe 'identifierFields govern the scrub, not only the gate' {
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
        ($out -join "`n") | Should -Match 'All pii-identifier-fields-scrub tests passed'
    }
}
