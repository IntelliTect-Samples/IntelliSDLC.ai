#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for issue #334: the scrubber and the gate must hold ONE
# definition of "credit card", and the MERGED project policy must reach the
# scrubber.
# Delegates to the zero-dep Node script `pii-policy-threading.test.js`
# and asserts exit code 0.
#
# Two defects with one root. `pii.js` fired on bare Luhn while `har-shapes.js`
# required an assigned issuer identifier, and because `pii.js` drives a REPLACE
# the divergence corrupted references rather than leaking from them. And the
# merged policy was never threaded into `scrubPii`, so a consuming project's
# `piiFields` and `cardIssuers` were validated, merged, loaded -- and then never
# consulted on the side that rewrites the capture.
#
# The Node suite drives `sanitize-har.js` end to end and asserts on the scrubbed
# file, with each policy case written as a PAIR (with and without the project
# policy). That is deliberate: a predecessor test asserted only that the
# policy-taking form EXISTED, which an entirely inert feature satisfies.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/pii-policy-threading.test.js'
}

Describe 'pii.js card predicate and merged-policy threading' {
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
        ($out -join "`n") | Should -Match 'All pii-policy-threading tests passed'
    }
}
