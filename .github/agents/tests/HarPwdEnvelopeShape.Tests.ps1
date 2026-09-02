#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the password-envelope SHAPE rule (issue #395).
#
# #378 fixed the KEY-NAME control. The envelope itself --
# `#PWD_<LABEL>:<version>:<timestamp>:<base64>` -- was still invisible to the
# SHAPE control, which is the one that does not care what the field is called.
# The falsifier that matters puts the envelope under a BENIGN field name that
# `secretFields` does not carry, so only the shape rule can catch it; with both
# controls live the name control reports first and a shape test can otherwise
# pass for the wrong reason.
#
# Delegates to the zero-dep Node script `har-pwd-envelope-shape.test.js` and
# asserts exit code 0. `node --test <dir>` is deliberately not used: it fails
# on Node 26, so the file is named explicitly.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-pwd-envelope-shape.test.js'
    $script:ShapesJs   = Join-Path $script:ScriptsDir 'har/har-shapes.js'
    $script:PolicyJson = Join-Path $script:ScriptsDir 'har/har-policy.default.json'
}

Describe 'har password-envelope shape rule' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'the shipped policy is still valid JSON' {
        # The class declaration is DATA, so a trailing comma would disable the
        # entire scrub rather than fail one assertion.
        { Get-Content -LiteralPath $script:PolicyJson -Raw | ConvertFrom-Json } | Should -Not -Throw
    }

    It 'the policy governs the new kind' {
        # A pattern no policy class names can be neither tuned nor waived.
        # Asserted here as well as in the Node file because the two artifacts
        # are edited separately and this is the pairing that can be forgotten.
        $policy = Get-Content -LiteralPath $script:PolicyJson -Raw | ConvertFrom-Json
        $policy.classes.secret.'pwd-envelope' | Should -Be 'gate'
    }

    It 'neither the rule nor its tests carry a live envelope' {
        # Every fixture is synthetic and generated in the test file. A real
        # capture must never reach version control, and the ciphertext of a
        # genuine envelope is the one thing that could arrive by copy-paste.
        # The MARKER is expected in both files; a `#PWD_` token followed by a
        # long base64 tail is not.
        foreach ($file in @($script:ShapesJs, $script:TestJs)) {
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
        ($out -join "`n") | Should -Match 'All har-pwd-envelope-shape tests passed'
    }
}
