#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the password-envelope SCRUB rule (issue #407).
#
# #395 moved the GATE: `har-shapes.js` catches `#PWD_<LABEL>:<v>:<unix>:<b64>`
# by SHAPE, under any field name. It did not move the SCRUBBER, so an envelope
# under a name `secretFields` does not carry BLOCKED with no automatic remedy --
# the operator's only route out was naming the field, which is the control that
# had already failed. #407 adds the matching shape rule to `sanitize-har.js`.
#
# The falsifier puts the envelope under a BENIGN field name so only the shape
# scrub can remove it; with both controls live the NAME control acts first and a
# shape test can otherwise pass for the wrong reason.
#
# Delegates to the zero-dep Node script `har-pwd-envelope-scrub.test.js` and
# asserts exit code 0. `node --test <dir>` is deliberately not used: it fails on
# Node 26, so the files are named explicitly.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-pwd-envelope-scrub.test.js'
    $script:ShapeJs    = Join-Path $script:ScriptsDir 'har/har-pwd-envelope-shape.test.js'
    $script:SanitizeJs = Join-Path $script:ScriptsDir 'har/sanitize-har.js'
    $script:ShapesJs   = Join-Path $script:ScriptsDir 'har/har-shapes.js'
}

Describe 'har password-envelope scrub rule' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'the scrubber carries the pwd-envelope shape rule' {
        # The whole of #407 in one line. Asserted here as well as in the Node
        # file because this is the pairing that gets reverted by accident.
        Get-Content -LiteralPath $script:SanitizeJs -Raw |
            Should -Match "kind:\s*'pwd-envelope'"
    }

    It 'the gate exempts the scrubber fake instead of returning false' {
        # The scrub's replacement is FORMAT-PRESERVING, so it matches the gate
        # pattern. Without a real `isFake` the gate re-reports the scrubber's
        # own redaction forever and no scrubbed capture can ever pass.
        $shapes = Get-Content -LiteralPath $script:ShapesJs -Raw
        $shapes | Should -Match '#PWD_REDACTED:0:0:'
        $shapes | Should -Not -Match 'isFake:\s*\(\)\s*=>\s*false'
    }

    It 'the scrubber and the gate agree on the fake sentinel' {
        # Two files, one spelling. If they drift, the scrubber emits a value
        # the gate reports on every run.
        Get-Content -LiteralPath $script:SanitizeJs -Raw |
            Should -Match "PWD_ENVELOPE_FAKE_PREFIX = '#PWD_REDACTED:0:0:'"
        Get-Content -LiteralPath $script:ShapesJs -Raw |
            Should -Match '\^#PWD_REDACTED:0:0:\[0-9a-f\]\{24\}\$'
    }

    It 'no rule or test carries a live envelope' {
        # Every fixture is synthetic and generated in the test files. The
        # MARKER is expected; a `#PWD_` token with a long base64 tail is not.
        foreach ($file in @($script:SanitizeJs, $script:ShapesJs, $script:TestJs, $script:ShapeJs)) {
            $text = Get-Content -LiteralPath $file -Raw
            $text | Should -Not -Match '#PWD_[A-Za-z0-9_]+:\d+:\d+:[A-Za-z0-9+/=_-]{140,}'
        }
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-pwd-envelope-scrub tests passed'
    }

    It 'the inverted #395 section still passes' {
        # #407 inverted section 8 of the shape tests: it pinned the ABSENCE of
        # a scrub rule, and now pins its presence. Run here too, because the
        # two files are edited together and only ever together.
        $out = & node $script:ShapeJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-pwd-envelope-shape tests passed'
    }
}
