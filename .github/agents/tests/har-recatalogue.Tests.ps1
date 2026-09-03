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

    It 'is not suppressed by an ambient $WhatIfPreference' {
        # The catalogue wrapper declares no SupportsShouldProcess and invokes
        # node directly, so a $WhatIfPreference set in an outer scope or a
        # user's profile cannot silently turn it into a no-op. Pinned because
        # the failure it would cause is invisible: a run that reports success
        # and writes nothing.
        $sandbox = New-Sandbox
        try {
            $har = Join-Path $sandbox 'scrubbed.har'
            New-CleanHar -Path $har

            $WhatIfPreference = $true
            $env:CLAUDECODE = ''
            $env:CLAUDE_CODE_ENTRYPOINT = ''
            & $script:CataloguePs1 -Path $har 2>&1 | Out-Null
            $LASTEXITCODE | Should -Be 0

            Test-Path -LiteralPath (Join-Path $sandbox 'catalogue.json') | Should -BeTrue -Because (
                'a dry-run preference the operator never asked this command for must not ' +
                'silently reduce it to nothing')
        }
        finally {
            Remove-Item -LiteralPath $sandbox -Recurse -Force -WhatIf:$false -ErrorAction SilentlyContinue
        }
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
        $code | Should -Match 'exit \$LASTEXITCODE'
    }

    # THE EXIT CODE, AND WHAT #386 CHANGED ABOUT IT.
    #
    # This used to be one assertion: no `switch` anywhere in the file, because
    # an arm that reinterpreted an exit code would be a second copy of the
    # recorder's meanings. Pointing the script at a FOLDER makes that too blunt
    # in one direction and too weak in the other.
    #
    # Too blunt: a batch's single exit cannot carry 88 verdicts, so it MUST map
    # each capture's code to an outcome. Too weak: a blanket ban says nothing
    # about whether that mapping keeps the distinctions the codes exist to make.
    #
    # So the rule is split. The single-capture path still propagates whole -- the
    # file's last statement is the untouched propagation, and nothing switches on
    # $LASTEXITCODE. And the batch mapping is pinned on the two codes it would be
    # easiest to flatten into "it failed": 7 (catalogue produced over an ADVISORY
    # verdict) and 2 (the recorder's refusal to replace a catalogue carrying
    # described work).
    It 'propagates the recorder exit code whole on the single-capture path' {
        $raw = Get-Content -LiteralPath $script:CataloguePs1 -Raw
        $withoutBlocks = [regex]::Replace($raw, '(?s)<#.*?#>', ' ')
        $code = ($withoutBlocks -split "`r?`n" | Where-Object { $_.TrimStart() -notlike '#*' }) -join "`n"

        $lastStatement = @($code -split "`n" | Where-Object { $_.Trim() } )[-1].Trim()
        $lastStatement | Should -Be 'exit $LASTEXITCODE'
        $code | Should -Not -Match 'switch\s*\(\s*\$LASTEXITCODE'
    }

    It 'the batch mapping keeps what the recorder codes mean' {
        $raw = Get-Content -LiteralPath $script:CataloguePs1 -Raw
        $withoutBlocks = [regex]::Replace($raw, '(?s)<#.*?#>', ' ')
        $code = ($withoutBlocks -split "`r?`n" | Where-Object { $_.TrimStart() -notlike '#*' }) -join "`n"

        # Exit 7: the catalogue WAS produced. Non-zero so nothing reads it as
        # clean, but not a failure.
        $code | Should -Match "(?m)^\s*7\s*\{\s*return @\{ Outcome = 'processed'"
        # Exit 2: the recorder declined to overwrite described work. That is a
        # skip with a reason, never a failure and never something -Force undoes.
        $code | Should -Match "(?m)^\s*2\s*\{\s*return @\{ Outcome = 'skipped'"
    }
}

Describe 'ShouldProcess cannot silently disable a stage' {
    BeforeAll {
        $script:CapturePs1 = Join-Path $script:ScriptsDir 'capture/Invoke-HarCapture.ps1'
        $script:SanitizePs1 = Join-Path $script:ScriptsDir 'har/Invoke-SanitizeHar.ps1'
    }

    It 'Invoke-HarCapture.ps1 does not accept -WhatIf' {
        # A recording session has no meaningful "what if", so the parameter is
        # rejected rather than accepted and ignored. GUARD: this passes because
        # SupportsShouldProcess was never added there, and exists to keep it
        # that way.
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:CapturePs1, [ref]$null, [ref]$null)
        $text = $ast.Extent.Text
        $text | Should -Not -Match 'SupportsShouldProcess'

        { & $script:CapturePs1 -Uri 'https://example.com' -WhatIf } |
            Should -Throw -ExpectedMessage '*WhatIf*'
    }

    It 'every internal call to the scrub wrapper passes -WhatIf:$false' {
        # TRIPWIRE, and VACUOUS TODAY -- there are currently no internal call
        # sites, because Invoke-HarCapture.ps1 delegates the whole pipeline to
        # capture-har.js rather than composing the PowerShell stages. That was
        # a deliberate stop, not an oversight: composing would have to restate
        # promotion, quarantine and the exit-code mapping in PowerShell, and
        # the rationale is written out above `$captureArgs` in that file.
        #
        # It is here because the day somebody adds the first call site is the
        # day the trap becomes reachable: Invoke-SanitizeHar.ps1 now declares
        # SupportsShouldProcess, so an ambient $WhatIfPreference would make the
        # composed pipeline record traffic and silently skip scrubbing it.
        #
        # Reported as a guard, not as evidence: it asserts nothing about the
        # current tree beyond the absence of call sites.
        $callers = Get-ChildItem -LiteralPath (Join-Path $script:ScriptsDir 'capture') -File -Filter '*.ps1'
        $offenders = foreach ($file in $callers) {
            $raw = Get-Content -LiteralPath $file.FullName -Raw
            $withoutBlocks = [regex]::Replace($raw, '(?s)<#.*?#>', ' ')
            $code = ($withoutBlocks -split "`r?`n" | Where-Object { $_.TrimStart() -notlike '#*' }) -join "`n"
            foreach ($line in ($code -split "`n")) {
                if ($line -match 'Invoke-SanitizeHar\.ps1' -and $line -notmatch '-WhatIf:\$false') {
                    "$($file.Name): $($line.Trim())"
                }
            }
        }
        @($offenders) -join "`n" | Should -BeNullOrEmpty -Because (
            'Invoke-SanitizeHar.ps1 supports ShouldProcess, so an ambient $WhatIfPreference ' +
            'would suppress the scrub in a composed pipeline while the run still looked ' +
            'successful. Pass -WhatIf:$false on the call.')
    }
}
