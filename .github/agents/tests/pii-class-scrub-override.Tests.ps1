#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for issue #346: a `classes` setting of `off` must govern the
# SCRUB, not only the gate.
# Delegates to the zero-dep Node script `pii-class-scrub-override.test.js`
# and asserts exit code 0.
#
# #297 requirement 1 is "consumers can override the scrub"; requirement 2
# accepts a stringent default GIVEN a working override path. There was none.
# `classes` reached `har-shapes.js`, `har-literals.js` and `har-policy.js` --
# all gate-side -- and `pii.js` never mentioned it, so `detectPii` found a value
# and `scrubPii` replaced it whatever the project had declared. Measured on a
# travel-domain corpus: over 125,000 CORRECT identity detections replaced by
# fakes in captures where place names and coordinates ARE the payload.
#
# `off` means DETECT, REPORT, DO NOT ACT -- the meaning `har-shapes.js` already
# gives it, where a disabled finding is still returned carrying `setting: 'off'`
# and `gating: false`. The scrubber now agrees with the gate rather than holding
# a second definition of the word.
#
# The Node suite drives `sanitize-har.js` end to end and asserts on the SCRUBBED
# FILE, with every policy case written as a PAIR (with and without the project
# policy). That is deliberate: a predecessor test in this area asserted only
# that a policy-taking form EXISTED, which an entirely inert feature satisfies.
# It also pins the secret floor on the scrub side, from both directions -- the
# loader rejects a project file that lowers a secret class, and a policy object
# constructed directly, bypassing the loader, still cannot switch one off.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/pii-class-scrub-override.test.js'
}

Describe 'classes govern the scrub, not only the gate' {
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
        ($out -join "`n") | Should -Match 'All pii-class-scrub-override tests passed'
    }
}
