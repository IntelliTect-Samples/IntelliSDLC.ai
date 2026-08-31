#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests that pin issue #352 -- the
# capture pipeline is RE-ENTERABLE at the catalogue stage. Pester is the only
# suite CI runs, so a Node test with no wrapper here is a test that never runs
# on a pull request.
#
#   capture-recatalogue.test.js   the `catalogue` command: it exists, it
#                                 regenerates the digest and catalogue from an
#                                 already scrubbed capture with nothing
#                                 recorded, it refuses a HAR the leak gate does
#                                 not pass, it carries the advisory exit code
#                                 through, and it asks the ONE existing
#                                 delegation decision rather than a second copy.
#
# The Describe blocks below cover the PowerShell half, which the Node suite
# cannot reach: Invoke-HarCatalogue.ps1.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:CataloguePs1 = Join-Path $script:ScriptsDir 'capture/Invoke-HarCatalogue.ps1'

    # A HAR that has been scrubbed: nothing in it the leak gate objects to.
    function New-CleanHar {
        param([Parameter(Mandatory)][string]$Path)

        $entry = @{
            startedDateTime = '2026-01-01T12:00:00Z'
            time            = 5
            request         = @{
                method = 'GET'; url = 'https://api.example.com/v1/thing'
                headers = @(); queryString = @(); cookies = @()
                headersSize = 10; bodySize = 0
            }
            response        = @{
                status = 200; statusText = 'OK'; headers = @(); cookies = @(); redirectURL = ''
                headersSize = 10; bodySize = 2
                content = @{ size = 2; mimeType = 'application/json'; text = '{}' }
            }
            cache           = @{}
            timings         = @{ send = 1; wait = 3; receive = 1 }
        }
        $doc = @{ log = @{ version = '1.2'; creator = @{ name = 'recat'; version = '1' }; entries = @($entry) } }
        Set-Content -LiteralPath $Path -Value ($doc | ConvertTo-Json -Depth 12) -Encoding utf8
    }

    # The same capture, still carrying the Authorization header a live session
    # hands out -- i.e. one nobody scrubbed.
    function New-LeakyHar {
        param([Parameter(Mandatory)][string]$Path)

        New-CleanHar -Path $Path
        $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $doc.log.entries[0].request.headers = @(
            @{ name = 'Authorization'; value = 'Bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXBheWxvYWQ.7Qk3vZ1xY9' }
        )
        Set-Content -LiteralPath $Path -Value ($doc | ConvertTo-Json -Depth 12) -Encoding utf8
    }

    function New-Sandbox {
        $dir = Join-Path ([IO.Path]::GetTempPath()) ("har-recatalogue-" + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        return $dir
    }
}

Describe 'the pipeline is re-enterable at the catalogue stage' {
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'capture/capture-recatalogue.test.js'; Expect = 'All capture-recatalogue tests passed' }
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

Describe 'Invoke-HarCatalogue.ps1' {
    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:CataloguePs1 | Should -BeTrue
    }

    It 'is valid PowerShell (parses without syntax errors)' {
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $script:CataloguePs1, [ref]$null, [ref]$errors) | Out-Null
        @($errors).Count | Should -Be 0
    }

    It 'catalogues a scrubbed capture without recording anything' {
        # The whole point of #352, end to end through the PowerShell door: a
        # capture that exists on disk gets its digest and catalogue rebuilt with
        # no browser launched and no traffic re-recorded.
        $sandbox = New-Sandbox
        try {
            $har = Join-Path $sandbox 'scrubbed.har'
            New-CleanHar -Path $har

            $env:CLAUDECODE = ''
            $env:CLAUDE_CODE_ENTRYPOINT = ''
            & $script:CataloguePs1 -Path $har 2>&1 | Out-Null
            $LASTEXITCODE | Should -Be 0

            Test-Path -LiteralPath (Join-Path $sandbox 'digest.json') | Should -BeTrue
            Test-Path -LiteralPath (Join-Path $sandbox 'catalogue.json') | Should -BeTrue

            $rows = Get-Content -LiteralPath (Join-Path $sandbox 'catalogue.json') -Raw | ConvertFrom-Json
            @($rows).Count | Should -BeGreaterThan 0
        }
        finally { Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'refuses a HAR the leak gate does not pass, and writes no catalogue' {
        # The recorder owns this decision; what is pinned here is that the
        # wrapper carries the refusal through instead of reporting success.
        # A catalogue derived from a leaking capture is worse than none: it
        # looks safe.
        $sandbox = New-Sandbox
        try {
            $har = Join-Path $sandbox 'scrubbed.har'
            New-LeakyHar -Path $har

            & $script:CataloguePs1 -Path $har 2>&1 | Out-Null
            $LASTEXITCODE | Should -Be 6

            Test-Path -LiteralPath (Join-Path $sandbox 'digest.json') | Should -BeFalse
            Test-Path -LiteralPath (Join-Path $sandbox 'catalogue.json') | Should -BeFalse
        }
        finally { Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'does not restate where files may go or what a finding means' {
        # PowerShell orchestrates; the recorder decides. A wrapper that grew its
        # own copy of the promotion rule, the quarantine rule or the advisory /
        # gating split would drift from the Node implementation -- the
        # two-engines problem this subsystem has spent a dozen PRs removing.
        # Comments stripped first: this file explains those rules in prose, and
        # a guard its own rationale can satisfy is no guard.
        $raw = Get-Content -LiteralPath $script:CataloguePs1 -Raw
        $withoutBlocks = [regex]::Replace($raw, '(?s)<#.*?#>', ' ')
        $code = ($withoutBlocks -split "`r?`n" | Where-Object { $_.TrimStart() -notlike '#*' }) -join "`n"

        $code | Should -Not -Match 'scrubbed\.rejected'
        $code | Should -Not -Match 'har-captures'
        $code | Should -Not -Match 'Rename-Item|Copy-Item|Move-Item|Remove-Item'
        # No arm that reinterprets an exit code -- it is propagated whole.
        $code | Should -Not -Match '(?m)^\s*switch\s*\('
        $code | Should -Match 'exit \$LASTEXITCODE'
    }
}
