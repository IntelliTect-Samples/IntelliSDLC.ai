#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the web-api-discovery capture/scrub script templates
# (issue #36). These exercise sanitize-har.js, verify-scrub.js, and
# Invoke-SanitizeHar.ps1 against a synthetic HAR fixture.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:SanitizeJs = Join-Path $script:ScriptsDir 'har/sanitize-har.js'
    $script:VerifyJs   = Join-Path $script:ScriptsDir 'har/verify-scrub.js'
    $script:WrapperPs1 = Join-Path $script:ScriptsDir 'har/Invoke-SanitizeHar.ps1'
    $script:CaptureJs  = Join-Path $script:ScriptsDir 'capture/capture-cdp.js'

    . (Join-Path $PSScriptRoot 'fixtures/ProtectedFixtureRepo.ps1')

    function New-FixtureHar {
        param(
            [Parameter(Mandatory)][string]$Path,
            [string]$Jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
            [string]$HexToken = ('a' * 64),
            [string]$Email = 'jane.doe@example.com'
        )
        $har = @{
            log = @{
                version = '1.2'
                creator = @{ name = 'test'; version = '1.0' }
                entries = @(
                    @{
                        startedDateTime = '2026-01-01T00:00:00Z'
                        time            = 1
                        request         = @{
                            method      = 'GET'
                            url         = 'https://example.com/api/me'
                            httpVersion = 'HTTP/1.1'
                            headers     = @(
                                @{ name = 'Authorization'; value = "Bearer $Jwt" },
                                @{ name = 'Cookie';        value = "session=$HexToken" },
                                @{ name = 'X-User-Email';  value = $Email }
                            )
                            queryString = @()
                            cookies     = @()
                            headersSize = -1
                            bodySize    = 0
                        }
                        response        = @{
                            status      = 200
                            statusText  = 'OK'
                            httpVersion = 'HTTP/1.1'
                            headers     = @(
                                @{ name = 'Set-Cookie'; value = "session=$HexToken; Path=/" }
                            )
                            cookies     = @()
                            content     = @{
                                size     = 0
                                mimeType = 'application/json'
                                text     = "{`"email`":`"$Email`",`"token`":`"$Jwt`"}"
                            }
                            redirectURL = ''
                            headersSize = -1
                            bodySize    = 0
                        }
                        cache           = @{}
                        timings         = @{ send = 0; wait = 1; receive = 0 }
                    }
                )
            }
        }
        $json = $har | ConvertTo-Json -Depth 20
        Set-Content -LiteralPath $Path -Value $json -Encoding utf8
    }
}

Describe 'sanitize-har.js' {

    BeforeEach {
        $script:Tmp     = Join-Path ([IO.Path]::GetTempPath()) ("har-test-" + [guid]::NewGuid())
        New-ProtectedFixtureRepo -Path $script:Tmp
        # sanitize-har reads its salt and literal -> sentinel map from the
        # operator's gitignored .har-profile.json (issue #255); there is no
        # default salt, so each fixture project declares its own.
        $script:Profile = Join-Path $script:Tmp '.har-profile.json'
        Set-Content -LiteralPath $script:Profile -Encoding utf8 -Value (
            @{ salt = 'pester-test-salt'; literals = @{} } | ConvertTo-Json)
        $script:InHar   = Join-Path $script:Tmp 'in.har'
        $script:OutHar  = Join-Path $script:Tmp 'out.har'
        $script:SubsMap = Join-Path $script:Tmp 'subs.json'
        New-FixtureHar -Path $script:InHar
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:SanitizeJs | Should -BeTrue
    }

    It 'removes a JWT from the scrubbed HAR' {
        & node $script:SanitizeJs --in $script:InHar --out $script:OutHar --subs $script:SubsMap --profile $script:Profile
        $LASTEXITCODE | Should -Be 0
        $scrubbed = Get-Content -LiteralPath $script:OutHar -Raw
        $scrubbed | Should -Not -Match 'eyJhbGciOiJIUzI1NiJ9'
    }

    It 'removes a 64-char hex session token from the scrubbed HAR' {
        & node $script:SanitizeJs --in $script:InHar --out $script:OutHar --subs $script:SubsMap --profile $script:Profile
        $LASTEXITCODE | Should -Be 0
        $scrubbed = Get-Content -LiteralPath $script:OutHar -Raw
        $scrubbed | Should -Not -Match ('a' * 64)
    }

    It 'removes email addresses from the scrubbed HAR' {
        & node $script:SanitizeJs --in $script:InHar --out $script:OutHar --subs $script:SubsMap --profile $script:Profile
        $LASTEXITCODE | Should -Be 0
        $scrubbed = Get-Content -LiteralPath $script:OutHar -Raw
        $scrubbed | Should -Not -Match 'jane\.doe@example\.com'
    }

    It 'persists a substitution map' {
        & node $script:SanitizeJs --in $script:InHar --out $script:OutHar --subs $script:SubsMap --profile $script:Profile
        Test-Path -LiteralPath $script:SubsMap | Should -BeTrue
        $map = Get-Content -LiteralPath $script:SubsMap -Raw | ConvertFrom-Json
        $map.PSObject.Properties.Count | Should -BeGreaterThan 0
    }

    It 'is deterministic: same input + same salt produce same output' {
        $out1 = Join-Path $script:Tmp 'out1.har'
        $out2 = Join-Path $script:Tmp 'out2.har'
        & node $script:SanitizeJs --in $script:InHar --out $out1 --subs (Join-Path $script:Tmp 's1.json') --profile $script:Profile
        & node $script:SanitizeJs --in $script:InHar --out $out2 --subs (Join-Path $script:Tmp 's2.json') --profile $script:Profile
        (Get-FileHash $out1).Hash | Should -Be (Get-FileHash $out2).Hash
    }
}

Describe 'verify-scrub.js' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("verify-test-" + [guid]::NewGuid())
        New-ProtectedFixtureRepo -Path $script:Tmp
        # sanitize-har reads its salt and literal -> sentinel map from the
        # operator's gitignored .har-profile.json (issue #255); there is no
        # default salt, so each fixture project declares its own.
        $script:Profile = Join-Path $script:Tmp '.har-profile.json'
        Set-Content -LiteralPath $script:Profile -Encoding utf8 -Value (
            @{ salt = 'pester-test-salt'; literals = @{} } | ConvertTo-Json)
        $script:CleanHar = Join-Path $script:Tmp 'clean.har'
        New-FixtureHar -Path (Join-Path $script:Tmp 'src.har')
        & node $script:SanitizeJs `
            --in   (Join-Path $script:Tmp 'src.har') `
            --out  $script:CleanHar `
            --subs (Join-Path $script:Tmp 'subs.json') `
            --profile $script:Profile
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:VerifyJs | Should -BeTrue
    }

    It 'exits zero on a properly scrubbed HAR' {
        & node $script:VerifyJs --in $script:CleanHar
        $LASTEXITCODE | Should -Be 0
    }

    It 'exits non-zero when a JWT is planted in the HAR' {
        $leaked = Join-Path $script:Tmp 'leaked.har'
        $jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsZWFrZWQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
        $payload = '{"log":{"entries":[{"response":{"content":{"text":"token=' + $jwt + '"}}}]}}'
        Set-Content -LiteralPath $leaked -Value $payload -Encoding utf8
        & node $script:VerifyJs --in $leaked 2>&1 | Out-Null
        $LASTEXITCODE | Should -Not -Be 0
    }

    It 'exits non-zero when a long hex token is planted in the HAR' {
        $leaked = Join-Path $script:Tmp 'leaked-hex.har'
        $hex = 'F' * 64
        $payload = '{"log":{"entries":[{"response":{"content":{"text":"session=' + $hex + '"}}}]}}'
        Set-Content -LiteralPath $leaked -Value $payload -Encoding utf8
        & node $script:VerifyJs --in $leaked 2>&1 | Out-Null
        $LASTEXITCODE | Should -Not -Be 0
    }
}

Describe 'Invoke-SanitizeHar.ps1' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("wrap-test-" + [guid]::NewGuid())
        New-ProtectedFixtureRepo -Path $script:Tmp
        # sanitize-har reads its salt and literal -> sentinel map from the
        # operator's gitignored .har-profile.json (issue #255); there is no
        # default salt, so each fixture project declares its own.
        $script:Profile = Join-Path $script:Tmp '.har-profile.json'
        Set-Content -LiteralPath $script:Profile -Encoding utf8 -Value (
            @{ salt = 'pester-test-salt'; literals = @{} } | ConvertTo-Json)
        $script:InHar = Join-Path $script:Tmp 'in.har'
        $script:OutHar = Join-Path $script:Tmp 'out.har'
        New-FixtureHar -Path $script:InHar
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            # -WhatIf:$false for the same reason every internal caller needs it:
            # the cases below set $WhatIfPreference, and without this the
            # cleanup is suppressed too and the fixtures pile up in TEMP.
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -WhatIf:$false -ErrorAction SilentlyContinue
        }
    }

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:WrapperPs1 | Should -BeTrue
    }

    It 'runs sanitize then verify and produces a scrubbed HAR' {
        & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar -ProfilePath $script:Profile
        $LASTEXITCODE | Should -Be 0
        Test-Path -LiteralPath $script:OutHar | Should -BeTrue
        (Get-Content -LiteralPath $script:OutHar -Raw) | Should -Not -Match 'eyJhbGciOiJIUzI1NiJ9'
    }

    It 'writes no substitution table beside the scrubbed output' {
        # Issue #294. The wrapper used to default the map to
        # <OutputHar>.subs.json -- the same credential-keyed reverse lookup
        # table the scrub exists to keep out of a committed directory, sitting
        # beside the artifact that is safe to commit and under a name no
        # gitignore entry and no gate recognises.
        & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar -ProfilePath $script:Profile
        $LASTEXITCODE | Should -Be 0
        Test-Path -LiteralPath ([IO.Path]::ChangeExtension($script:OutHar, '.subs.json')) | Should -BeFalse
        $stray = Get-ChildItem -LiteralPath $script:Tmp -Recurse -Force -File |
            Where-Object { $_.Name -match '(?i)subs.*\.json$' } |
            Where-Object { $_.FullName -notmatch '(?i)[\\/]\.har-captures[\\/]' }
        ($stray | ForEach-Object { $_.FullName }) -join ', ' | Should -BeNullOrEmpty
    }

    It 'still honours an explicit -SubstitutionsFile' {
        $explicit = Join-Path $script:Tmp 'explicit-subs.json'
        & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
            -ProfilePath $script:Profile -SubstitutionsFile $explicit
        $LASTEXITCODE | Should -Be 0
        Test-Path -LiteralPath $explicit | Should -BeTrue
    }

    Context '-WhatIf' {
        # A dry run must write NOTHING -- not the scrubbed HAR, not the
        # substitution table, and not verify-scrub.js's own findings report. The
        # last one is the easy miss: verification looks read-only and is not.

        It 'writes no scrubbed HAR and no substitution table' {
            & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
                -ProfilePath $script:Profile -WhatIf 2>&1 | Out-Null

            Test-Path -LiteralPath $script:OutHar | Should -BeFalse
            $written = Get-ChildItem -LiteralPath $script:Tmp -Recurse -Force -File |
                Where-Object { $_.Name -match '(?i)subs.*\.json$|scrub-findings\.json$' }
            ($written | ForEach-Object { $_.FullName }) -join ', ' | Should -BeNullOrEmpty
        }

        It 'says what it would have written, including where the substitution table goes' {
            # The conventional ShouldProcess line names the operation and the
            # target, which the operator already knew. What they cannot see
            # without being told is where the credential-keyed substitution
            # table lands (#294).
            $out = & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
                -ProfilePath $script:Profile -WhatIf -InformationAction Continue 6>&1 2>&1

            $text = ($out | Out-String)
            $text | Should -Match 'Nothing was written'
            $text | Should -Match ([regex]::Escape($script:OutHar))
            $text | Should -Match 'substitution table'
        }

        It 'writes no findings report for a leaking capture under -VerifyOnly' {
            $leaked = Join-Path $script:Tmp 'leaked.har'
            $jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsZWFrZWQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
            Set-Content -LiteralPath $leaked -Encoding utf8 -Value (
                '{"log":{"entries":[{"response":{"content":{"text":"' + $jwt + '"}}}]}}')

            & $script:WrapperPs1 -InputHar $leaked -OutputHar (Join-Path $script:Tmp 'ignored.har') `
                -ProfilePath $script:Profile -VerifyOnly -WhatIf 2>&1 | Out-Null

            Test-Path -LiteralPath (Join-Path $script:Tmp 'scrub-findings.json') | Should -BeFalse
        }
    }

    Context '-WhatIf arrives by preference, not only as a parameter' {
        # The trap. A caller that does NOT declare SupportsShouldProcess
        # correctly rejects a -WhatIf parameter, and still propagates
        # $WhatIfPreference from its own scope into everything it invokes. The
        # result is the worst available combination: a pipeline that records the
        # traffic and then silently does not scrub it, while the operator
        # believes they hold a scrubbed artifact.

        It 'an ambient $WhatIfPreference suppresses the scrub' {
            # Pinned as the MECHANISM, not as desirable behaviour -- this is
            # what the -WhatIf:$false below exists to defend against.
            $WhatIfPreference = $true
            & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
                -ProfilePath $script:Profile 2>&1 | Out-Null

            Test-Path -LiteralPath $script:OutHar | Should -BeFalse -Because (
                'this is the silent-skip an ambient preference causes; a composing caller ' +
                'must pass -WhatIf:$false so the pipeline is never suppressed by one')
        }

        It '-WhatIf:$false makes the scrub run anyway' {
            # What every internal caller must do. Without it a $WhatIfPreference
            # set in a profile or an outer scope silently disables the scrub.
            $WhatIfPreference = $true
            & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
                -ProfilePath $script:Profile -WhatIf:$false

            $LASTEXITCODE | Should -Be 0
            Test-Path -LiteralPath $script:OutHar | Should -BeTrue
            (Get-Content -LiteralPath $script:OutHar -Raw) | Should -Not -Match 'eyJhbGciOiJIUzI1NiJ9'
            # The substitution table is written too -- "the scrub ran" means the
            # whole of it, not merely that a file appeared at the destination.
            $subs = Get-ChildItem -LiteralPath $script:Tmp -Recurse -Force -File |
                Where-Object { $_.Name -match '(?i)subs.*\.json$' }
            @($subs).Count | Should -BeGreaterThan 0
        }
    }

    It 'propagates a non-zero exit code when verification fails' {
        $leaked = Join-Path $script:Tmp 'leaked.har'
        $jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsZWFrZWQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
        $payload = '{"log":{"entries":[{"response":{"content":{"text":"' + $jwt + '"}}}]}}'
        Set-Content -LiteralPath $leaked -Value $payload -Encoding utf8
        & $script:WrapperPs1 -InputHar $leaked -OutputHar (Join-Path $script:Tmp 'ignored.har') -ProfilePath $script:Profile -VerifyOnly 2>&1 | Out-Null
        $LASTEXITCODE | Should -Not -Be 0
    }
}

# ---------------------------------------------------------------------------
# -RemoveSource (#352). A raw capture holds the live session cookies the scrub
# exists to strip, and they accumulate -- 8.6 GB of them on one machine. The
# switch is the operator's lever against that, and every condition on it is
# about not leaving them with NEITHER a clean artifact NOR the source.
# ---------------------------------------------------------------------------

Describe 'Invoke-SanitizeHar.ps1 -RemoveSource' {

    BeforeAll {
        # Defined in BeforeAll, not in the Describe body: Pester 5 runs the body
        # in the discovery pass and the `It` blocks in a later run pass, so a
        # function declared at body scope is gone by the time a test calls it.

        # A capture the scrub cleans completely: the gate passes, exit 0.
        function Invoke-CleanScrub {
            param([switch]$RemoveSource, [switch]$AsWhatIf)
            & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
                -ProfilePath $script:Profile -RemoveSource:$RemoveSource -WhatIf:$AsWhatIf 2>&1 | Out-Null
        }

        # Make the scrub leave the card alone, so the GATE is the one that
        # judges it. `off` means detect, report, do not act (#346).
        function Set-ScrubBlindToCards {
            Set-Content -LiteralPath (Join-Path $script:Src '.har-policy.project.json') -Encoding utf8 `
                -Value '{"schemaVersion":1,"classes":{"identity":{"credit-card":"off"}}}'
            $doc = Get-Content -LiteralPath $script:InHar -Raw | ConvertFrom-Json
            $doc.log.entries[0].response.content.text = '{"amount_paid":"4539578763621486"}'
            $doc.log.entries[0].request.headers = @()
            $doc.log.entries[0].response.headers = @()
            Set-Content -LiteralPath $script:InHar -Encoding utf8 -Value ($doc | ConvertTo-Json -Depth 20)
        }
    }

    BeforeEach {
        # src/ and dst/ are SIBLINGS, not nested, so each can carry its own
        # .har-policy.project.json. That is the only lever found that produces a
        # real exit 3 and a real exit 4 from the real binaries: the scrub reads
        # the policy beside its INPUT and the gate reads the one beside the file
        # it verifies, so a class switched off for the scrub and left at
        # `advise` (or opted up to `gate`) for the gate makes a value survive
        # one and be judged by the other. Ten hand-built payloads were tried
        # first -- the scrub caught every one, which is the subsystem working.
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("rms-test-" + [guid]::NewGuid())
        New-ProtectedFixtureRepo -Path $script:Tmp
        $script:Src = Join-Path $script:Tmp 'src'
        $script:Dst = Join-Path $script:Tmp 'dst'
        New-Item -ItemType Directory -Path $script:Src, $script:Dst -Force | Out-Null

        $script:Profile = Join-Path $script:Tmp '.har-profile.json'
        Set-Content -LiteralPath $script:Profile -Encoding utf8 -Value (
            @{ salt = 'pester-test-salt'; literals = @{} } | ConvertTo-Json)

        $script:InHar = Join-Path $script:Src 'raw.har'
        $script:OutHar = Join-Path $script:Dst 'scrubbed.har'
        New-FixtureHar -Path $script:InHar

        # Where sanitize-har.js derives the two tables when nobody says: a
        # .har-captures/ beside the input.
        $script:SubsDir = Join-Path $script:Src '.har-captures'
        $script:LegacySubs = Join-Path $script:SubsDir '.har-substitutions.json'
        $script:PiiSubs = Join-Path $script:SubsDir '.substitutions.json'
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -WhatIf:$false -ErrorAction SilentlyContinue
        }
    }

    It 'deletes the raw HAR once the scrub verifies' {
        Invoke-CleanScrub -RemoveSource
        $LASTEXITCODE | Should -Be 0
        Test-Path -LiteralPath $script:OutHar | Should -BeTrue -Because 'the clean artifact is what the source is traded for'
        Test-Path -LiteralPath $script:InHar | Should -BeFalse
    }

    It 'deletes the substitution tables the run actually wrote' {
        # The tables are keyed by the PLAINTEXT originals, which makes each one
        # a reverse lookup table of the live credentials the raw carried. They
        # are exactly as sensitive as the raw, so they go with it -- leaving
        # them behind would keep the secrets and delete only the evidence.
        Invoke-CleanScrub -RemoveSource
        $LASTEXITCODE | Should -Be 0
        Test-Path -LiteralPath $script:LegacySubs | Should -BeFalse
        Test-Path -LiteralPath $script:PiiSubs | Should -BeFalse
    }

    It 'deletes the table -SubstitutionsFile named, not a path it recomputed' {
        # The run's OWN destinations, not a second derivation that happens to
        # agree today. An explicit -SubstitutionsFile moves the legacy table
        # somewhere deriveSubsDir would never name.
        $explicit = Join-Path $script:Tmp 'elsewhere/legacy-subs.json'
        New-Item -ItemType Directory -Path (Split-Path $explicit) -Force | Out-Null
        & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
            -ProfilePath $script:Profile -SubstitutionsFile $explicit -RemoveSource 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
        Test-Path -LiteralPath $explicit | Should -BeFalse -Because 'the table this run wrote is the table it removes'
        Test-Path -LiteralPath $script:LegacySubs | Should -BeFalse -Because 'no legacy table was derived, so none should be there'
        Test-Path -LiteralPath $script:PiiSubs | Should -BeFalse -Because 'the typed-PII table was still derived and is still sensitive'
    }

    It 'touches nothing else under .har-captures/' {
        # There is deliberately no age sweep and no Remove-HarCaptures. This
        # switch removes THIS run's source and THIS run's tables; another
        # session's raw, its recording log and session.json are none of its
        # business.
        $otherSession = Join-Path $script:SubsDir '20260101-000000'
        New-Item -ItemType Directory -Path $otherSession -Force | Out-Null
        $bystanders = @(
            (Join-Path $script:SubsDir 'session.json')
            (Join-Path $otherSession 'raw.har')
            (Join-Path $otherSession 'recording.log')
            (Join-Path $otherSession '.substitutions.json')
        )
        foreach ($b in $bystanders) { Set-Content -LiteralPath $b -Value 'keep me' -Encoding utf8 }

        Invoke-CleanScrub -RemoveSource
        $LASTEXITCODE | Should -Be 0
        foreach ($b in $bystanders) {
            Test-Path -LiteralPath $b | Should -BeTrue -Because "$b belongs to another run"
        }
    }

    It 'keeps the raw when the leak gate REJECTS the scrub' {
        # The condition that matters most. Deleting here leaves the operator
        # with neither a clean artifact nor the source -- strictly worse than
        # either failure alone, and unrecoverable.
        Set-ScrubBlindToCards
        Set-Content -LiteralPath (Join-Path $script:Dst '.har-policy.project.json') -Encoding utf8 `
            -Value '{"schemaVersion":1,"classes":{"identity":{"credit-card":"gate"}}}'
        Invoke-CleanScrub -RemoveSource
        $LASTEXITCODE | Should -Be 3
        Test-Path -LiteralPath $script:InHar | Should -BeTrue
        Test-Path -LiteralPath $script:LegacySubs | Should -BeTrue
        Test-Path -LiteralPath $script:PiiSubs | Should -BeTrue
    }

    It 'keeps the raw when the gate reports ADVISORY findings only' {
        # Exit 4 keeps the ARTIFACT (#343) -- it does not make the source
        # disposable. The advisory loop is "review the findings, waive or
        # correct, scrub again", and scrubbing again needs the raw. Removing it
        # here would break the one workflow exit 4 exists to enable.
        Set-ScrubBlindToCards
        Invoke-CleanScrub -RemoveSource
        $LASTEXITCODE | Should -Be 4
        Test-Path -LiteralPath $script:InHar | Should -BeTrue
        Test-Path -LiteralPath $script:PiiSubs | Should -BeTrue
    }

    It 'is refused with -VerifyOnly' {
        # -VerifyOnly scrubs nothing, so the file -InputHar names is not a spent
        # source: it is the artifact under inspection. Accepting the
        # combination would delete the thing the operator asked about.
        # Throws rather than exits: the script sets $ErrorActionPreference =
        # 'Stop', so its own Write-Error is terminating -- the same way every
        # other refusal in it behaves.
        { & $script:WrapperPs1 -InputHar $script:InHar -ProfilePath $script:Profile `
                -VerifyOnly -RemoveSource } | Should -Throw -ExpectedMessage '*-VerifyOnly*'
        Test-Path -LiteralPath $script:InHar | Should -BeTrue
    }

    It 'deletes nothing under -WhatIf' {
        Invoke-CleanScrub -RemoveSource -AsWhatIf
        Test-Path -LiteralPath $script:InHar | Should -BeTrue
        Test-Path -LiteralPath $script:OutHar | Should -BeFalse
    }

    It 'says under -WhatIf that the source would be removed' {
        $out = & $script:WrapperPs1 -InputHar $script:InHar -OutputHar $script:OutHar `
            -ProfilePath $script:Profile -RemoveSource -WhatIf -InformationAction Continue 6>&1 2>&1
        ($out | Out-String) | Should -Match '(?i)removed once the scrub verifies'
    }

    It 'is not offered by Invoke-HarCapture.ps1' {
        # The front door records into .har-captures/ and the recorder holds the
        # only copy of the session. Removing a source it just created, in the
        # same breath, is a different decision from an operator pointing this
        # switch at a raw they already have -- and it is not this issue's.
        $capture = Join-Path $script:ScriptsDir 'capture/Invoke-HarCapture.ps1'
        (Get-Content -LiteralPath $capture -Raw) | Should -Not -Match 'RemoveSource'
    }
}

Describe 'capture-cdp.js' {
    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:CaptureJs | Should -BeTrue
    }

    It 'is valid JavaScript (parses without syntax errors)' {
        # `node --check` returns 0 on valid syntax, non-zero on parse error.
        & node --check $script:CaptureJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'documents the --storage-state flag' {
        (Get-Content -LiteralPath $script:CaptureJs -Raw) | Should -Match '--storage-state'
    }

    It 'documents the --out flag for HAR output' {
        (Get-Content -LiteralPath $script:CaptureJs -Raw) | Should -Match '--out'
    }
}
