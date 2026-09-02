#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for "API calls are the default selection" (issue #410).
# Delegates to the zero-dep Node script `har-api-default.test.js`.
#
# What it pins: `extract-har-reference.js` no longer requires `--match`; it
# classifies entries as API traffic or as static assets / beacons and keeps the
# former by default. The classification is conservative about what it DROPS --
# documents, redirects and anything it cannot positively identify as an asset
# are kept -- it accounts for every entry (kept + dropped == total), it reports
# the outcome by category without ever echoing a captured value, and `--match`
# narrows WITHIN the API set rather than replacing the classification.
#
# The Node suite deliberately collects failures instead of stopping at the
# first one: a dozen assertions pin a single classifier, so one broken category
# would otherwise mask every other finding.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'har/har-api-default.test.js'
    $script:Extractor  = Join-Path $script:ScriptsDir 'har/extract-har-reference.js'
}

Describe 'web-api-discovery extract defaults to API calls' {
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
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-api-default tests passed'
    }

    It 'no new command-line option was introduced to carry the change' {
        # #410 is a DEFAULT change plus the relaxing of an existing required
        # argument. A new flag would be the wrong shape for it -- the project's
        # own rule prefers changing a default over accumulating options, and a
        # toggle here would hand the operator back the decision they said they
        # could not make. Pinned so it cannot be added quietly later.
        $source = Get-Content -LiteralPath $script:Extractor -Raw
        $optionNames = [regex]::Matches($source, "key === '(?<name>[a-z-]+)'") |
            ForEach-Object { $_.Groups['name'].Value }
        $optionNames | Should -Be @('match')

        # And the same set is what the help text advertises. Scoped to the
        # usage() body: elsewhere in the file `--subs` and `--pii-subs` are
        # arguments this script PASSES to sanitize-har.js, not options of its
        # own, and counting those would make this guard report nonsense.
        $usageBody = [regex]::Match($source, '(?s)function usage\(msg\) \{.*?\n\}').Value
        $usageBody | Should -Not -BeNullOrEmpty -Because 'the usage() anchor must still match, or this guard checks nothing'
        $advertised = [regex]::Matches($usageBody, '(?<flag>--[a-z-]+)') |
            ForEach-Object { $_.Groups['flag'].Value } |
            Sort-Object -Unique
        $advertised | Should -Be @('--action', '--in', '--match', '--max-response-bytes', '--out', '--profile', '--provider')
    }
}
