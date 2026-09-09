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
# WHY THIS FILE IS SO THIN. An earlier revision asserted the fix by grepping
# each source file for `function looksFormEncoded`, `const MAX_DEPTH` and
# friends. Independent review called that out as the broken-oracle shape this
# repo has named (#463): those assertions pin what the code LOOKS like, pass
# unchanged in the presence of real reach bugs, and fail for a correct
# implementation that spells things differently. They were replaced by
# assertions on BEHAVIOUR and on OBJECT IDENTITY, which live in the Node file
# (sections 8 and 9) where they can actually exercise the modules.
#
# Delegates to the zero-dep `har-nested-reach.test.js` and asserts exit 0.
# `node --test <dir>` is deliberately not used: it fails on Node 26.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:HarDir     = Join-Path $script:ScriptsDir 'har'
    $script:TestJs     = Join-Path $script:HarDir 'har-nested-reach.test.js'
}

Describe 'har nested-payload reach parity' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'the gate and the scrubber share ONE traversal, by object identity' {
        # The anti-drift invariant, asserted as a property of the loaded
        # modules rather than as a string in a file. Two byte-identical private
        # copies of `looksFormEncoded` are what this change removed, and the
        # comment above the second said outright that nothing could detect
        # their drift. Identity detects it, under any spelling.
        $js = @'
const path = require("path");
const secrets = require(path.join(process.argv[1], "har-secrets.js"));
const nested  = require(path.join(process.argv[1], "har-nested.js"));
if (secrets.looksFormEncoded !== nested.looksFormEncoded) {
    console.error("DRIFT: har-secrets defines its own looksFormEncoded");
    process.exit(1);
}
if (typeof nested.MAX_DEPTH !== "number") {
    console.error("DRIFT: MAX_DEPTH is not exported, so each engine picks its own reach");
    process.exit(1);
}
console.log("SHARED");
'@
        $out = & node -e $js $script:HarDir 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'SHARED'
    }

    It 'no fixture carries a live credential' {
        # Every value in the Node file is synthetic and generated there. This
        # one IS a source scan on purpose: it is a leak check over the file's
        # literals, not an assertion about the implementation's shape.
        $text = Get-Content -LiteralPath $script:TestJs -Raw
        $text | Should -Not -Match '#PWD_[A-Za-z0-9_]+:\d+:\d+:[A-Za-z0-9+/=_-]{140,}'
        $text | Should -Not -Match 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'har-nested-reach.test.js: all sections passed'
    }
}
