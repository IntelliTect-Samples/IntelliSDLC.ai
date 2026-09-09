#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for NESTED-PAYLOAD REACH PARITY between the gate and the
# scrubber (issue #454).
#
# There are two parity axes between `har-secrets.js` (the GATE) and
# `sanitize-har.js` (the SCRUBBER):
#
#   rule parity  -- does each engine know this value is a secret?  (#395, #408)
#   reach parity -- does each engine GET to where the value sits?  (#378, #454)
#
# This covers the reach axis. Every fixture in the Node file uses a kind BOTH
# engines already know, so #408's shape-table parity test passes on all of them
# while the capture still gates. Nothing here can be satisfied by teaching
# either engine a new rule.
#
# Delegates to the zero-dep Node script `har-nested-reach.test.js` and asserts
# exit code 0. `node --test <dir>` is deliberately not used: it fails on Node
# 26, so the file is named explicitly.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-nested-reach.test.js'
    $script:NestedJs   = Join-Path $script:ScriptsDir 'har/har-nested.js'
    $script:SanitizeJs = Join-Path $script:ScriptsDir 'har/sanitize-har.js'
    $script:SecretsJs  = Join-Path $script:ScriptsDir 'har/har-secrets.js'
    $script:LiteralsJs = Join-Path $script:ScriptsDir 'har/har-literals.js'
}

Describe 'har nested-payload reach parity' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'both engines import the one traversal' {
        # The whole of #454 in two lines. Each engine used to own a private
        # descent and they did not descend equally, so the gate reported
        # secrets the scrubber could not reach.
        Get-Content -LiteralPath $script:SanitizeJs -Raw | Should -Match "require\(.*har-nested\.js.*\)"
        Get-Content -LiteralPath $script:SecretsJs  -Raw | Should -Match "require\(.*har-nested\.js.*\)"
    }

    It 'neither engine keeps a private looksFormEncoded' {
        # Two byte-identical private copies, neither importing the other. The
        # comment above the second said outright that nothing could detect
        # their drift -- which is why sharing the predicate alone (b4c1a57) was
        # not enough and the TRAVERSAL had to move.
        Get-Content -LiteralPath $script:SanitizeJs -Raw |
            Should -Not -Match 'function looksFormEncoded'
        Get-Content -LiteralPath $script:SecretsJs -Raw |
            Should -Not -Match 'function looksFormEncoded'
        Get-Content -LiteralPath $script:NestedJs -Raw |
            Should -Match 'function looksFormEncoded'
    }

    It 'the depth cap is one exported definition, not a per-engine constant' {
        # The parity guarantee. A gate that is uncapped while the scrubber caps
        # at 3 is two different reaches wearing the same name, which is this
        # bug one layer further down.
        Get-Content -LiteralPath $script:NestedJs -Raw | Should -Match 'const MAX_DEPTH ='
        Get-Content -LiteralPath $script:SanitizeJs -Raw |
            Should -Not -Match 'MAX_DECODE_DEPTH'
    }

    It 'decodeNestedJson parses before it decodes' {
        # Defect D3, the only one of the three that failed OPEN: an already
        # decoded JSON document carrying a bare `%` was unreadable to BOTH
        # engines, so a secret inside it survived the scrub AND the gate
        # reported the artifact clean.
        $literals = Get-Content -LiteralPath $script:LiteralsJs -Raw
        $literals | Should -Match 'function parseJsonObject'
        $literals | Should -Match 'const direct = parseJsonObject\(value\);'
    }

    It 'no fixture carries a live credential' {
        # Every value in the Node file is synthetic and generated there.
        $text = Get-Content -LiteralPath $script:TestJs -Raw
        $text | Should -Not -Match '#PWD_[A-Za-z0-9_]+:\d+:\d+:[A-Za-z0-9+/=_-]{140,}'
        $text | Should -Not -Match 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'har-nested-reach.test.js: all sections passed'
    }
}
