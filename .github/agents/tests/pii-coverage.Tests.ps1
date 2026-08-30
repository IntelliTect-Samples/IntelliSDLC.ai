#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the PII coverage work (issue #297, Stage 6).
# Delegates to the zero-dep Node scripts and asserts exit code 0.
#
#   pii-fieldtype.test.js     Task 6.2 -- field names match on the key's WORDS,
#                             with a qualifier allowlist on the ambiguous tails
#                             so `file_name` and `ip_address` are not scrubbed
#                             as a person and a street.
#   pii-phone-cookies.test.js Tasks 6.3/6.4 -- national phone spellings, the
#                             bare ten-digit run gated on a phone-named field,
#                             and request/response cookies walked by both the
#                             detector and the scrubber.
#   pii-new-types.test.js     Task 6.5 -- IBAN (checksum-backed, context-free),
#                             MAC (punctuated shape), and advertising ids
#                             (plain UUIDs, so gated on field name only).

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'web-api-discovery PII coverage' {
    # Inline because -ForEach is evaluated at DISCOVERY time, before BeforeAll.
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'pii-fieldtype.test.js';     Expect = 'All pii-fieldtype tests passed' }
        @{ Name = 'pii-phone-cookies.test.js'; Expect = 'All pii-phone-cookies tests passed' }
        @{ Name = 'pii-new-types.test.js';     Expect = 'All pii-new-types tests passed' }
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
}
