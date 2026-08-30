#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests that pin issue #297 Stage 7 --
# non-destructive rejection. Pester is the only suite CI runs, so a Node test
# with no wrapper here is a test that never runs on a pull request.
#
#   capture-quarantine.test.js       tasks 7.1/7.2 -- a scrub the leak gate
#                                    refused is MOVED into the gitignored
#                                    session directory, never deleted, and an
#                                    advisory-only verdict keeps the artifact.
#   verify-scrub-findings.test.js    task 7.3 -- scrub-findings.json carries a
#                                    location and never a value, and the
#                                    emitted waiver fragment actually works.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
}

Describe 'scrub rejection is non-destructive' {
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'capture/capture-quarantine.test.js';    Expect = 'All capture-quarantine tests passed' }
        @{ Name = 'har/verify-scrub-findings.test.js';     Expect = 'All verify-scrub-findings tests passed' }
    ) {
        $testJs = Join-Path $script:ScriptsDir $Name
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match $Expect
    }
}

Describe 'the PowerShell front door understands the advisory exit code' {
    # capture-har.js exit 7 means "recorded, scrubbed and catalogued, but the
    # leak gate reported advisory findings". Invoke-HarCapture.ps1 has a
    # `default` arm that writes an error saying no catalogue was produced --
    # which would be false for 7, and would send the operator looking for a
    # capture that is sitting right where it belongs.
    It 'maps exit 7 to a warning that keeps going, not to the no-catalogue error' {
        $wrapper = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts/capture/Invoke-HarCapture.ps1'
        $text = Get-Content -LiteralPath $wrapper -Raw
        $text | Should -Match '(?m)^\s*7\s*\{'
    }
}
