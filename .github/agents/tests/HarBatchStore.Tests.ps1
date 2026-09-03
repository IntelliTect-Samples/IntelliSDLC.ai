#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for "point an entry point at a FOLDER and it means every
# capture under it" (issue #386, narrowed by #387).
#
# THE FINDING THIS EXISTS FOR. A real store held 88 raw captures and 9.0 GB, and
# 5 of them had ever been processed. That ratio is not carelessness: the only
# available motion was one capture at a time, and a store accumulates faster
# than anyone will drive a per-capture tool by hand.
#
# WHAT IS PINNED HERE, AND WHAT IS PINNED NEXT DOOR. The classification of the
# three input classes -- current layout, legacy layout at the captures root, and
# captures this recorder did not make -- is pinned in
# `capture/capture-store.test.js`, because it is a property of the shared walk
# and belongs beside it. This suite runs that Node suite (Pester is the only
# suite CI runs, so a Node test with no wrapper here never runs on a pull
# request) and then pins what only the PowerShell drivers can be asked:
#
#   RESUME IS CORRECT, NOT APPROXIMATE. A 9.0 GB store WILL be interrupted, so
#   the second run must skip what finished and redo what did not -- including a
#   capture whose scrub the leak gate REFUSED, which has no verified artifact
#   and must not be mistaken for one.
#   -Force OVERRIDES THE RESUME CHECK AND NOTHING ELSE.
#   ISOLATION. One malformed capture is recorded against itself; the other
#   captures still run.
#   THE GATE IS NOT SOFTENED. A rejected scrub quarantines in its own session
#   directory and promotes nothing, exactly as a single run does. "Keep the
#   batch going" is a reason to move to the next capture, never a reason to
#   accept this one.
#   SINGLE-CAPTURE BEHAVIOUR IS UNCHANGED.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:Sanitize   = Join-Path $script:ScriptsDir 'har/Invoke-SanitizeHar.ps1'
    $script:Catalogue  = Join-Path $script:ScriptsDir 'capture/Invoke-HarCatalogue.ps1'

    # A fixture store, built from nothing. Not one byte comes from a real
    # capture: the shapes were measured, the contents are invented.
    #
    # `git init` and the .gitignore entries are not decoration -- since #318 the
    # scrub refuses to write a substitution table anywhere git will not confirm
    # is ignored, so a bare temp directory is not somewhere it runs at all.
    function New-BatchFixtureStore {
        param([Parameter(Mandatory)][string]$Path)

        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        & git -C $Path init --quiet 2>&1 | Out-Null
        Set-Content -LiteralPath (Join-Path $Path '.gitignore') -Encoding utf8 -Value @(
            '.har-profile.json', '.har-substitutions.json', '.substitutions.json', '.har-captures/')
        Set-Content -LiteralPath (Join-Path $Path '.har-profile.json') -Encoding utf8 -Value (
            @{ salt = 'har-batch-store-fixture-salt'; literals = @{} } | ConvertTo-Json)

        $writeHar = {
            param($p, $text)
            @{
                log = @{
                    version = '1.2'
                    creator = @{ name = 'fixture'; version = '1' }
                    entries = @(@{
                            startedDateTime = '2026-01-01T00:00:00.000Z'
                            time            = 1
                            request         = @{ method = 'GET'; url = 'https://api.example.test/v1/things'
                                httpVersion = 'HTTP/1.1'; headers = @(); queryString = @(); cookies = @()
                                headersSize = -1; bodySize = 0
                            }
                            response        = @{ status = 200; statusText = 'OK'; httpVersion = 'HTTP/1.1'
                                headers = @(); cookies = @()
                                content = @{ size = $text.Length; mimeType = 'application/json'; text = $text }
                                redirectURL = ''; headersSize = -1; bodySize = $text.Length
                            }
                            cache           = @{}
                            timings         = @{ send = 0; wait = 1; receive = 0 }
                        })
                }
            } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $p -Encoding utf8
        }

        $makeCapture = {
            param($dir, $opts)
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            if ($opts.Mitm) { Set-Content -LiteralPath (Join-Path $dir 'raw.mitm') -Value 'not-a-har' -Encoding utf8 }
            if ($opts.Malformed) {
                # Deliberately NOT '{ this is not json'. Node's JSON parser
                # QUOTES THE FIRST TEN BYTES of an input it cannot start
                # parsing -- "Unexpected token 'S', \"SENTINELBY\"... is not
                # valid JSON". Those ten bytes are a captured value that the
                # scrub's own failure message carries, and the assertion below
                # matches exactly them: a sentinel longer than the quote would
                # never appear in the output and the test would pass whether the
                # leak existed or not.
                Set-Content -LiteralPath (Join-Path $dir 'raw.har') `
                    -Value 'SENTINELBYTES-NOT-A-HAR' -Encoding utf8
            }
            else { & $writeHar (Join-Path $dir 'raw.har') '{"ok":true}' }
            if (-not $opts.NoSession) {
                # The start URI carries a token in its path on purpose: it is
                # the shape the summary must never echo.
                @{
                    uri = 'https://www.example.test/magic/FIXTURE-START-TOKEN'
                    describe = 'fixture capture'; sessionDir = $dir
                    harPath = (Join-Path $dir 'raw.har'); outputPath = $dir
                    startedUtc = '2026-01-01T00:00:00.000Z'; endedUtc = '2026-01-01T00:01:00.000Z'
                } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir 'session.json') -Encoding utf8
            }
            if ($opts.Scrubbed) { & $writeHar (Join-Path $dir 'scrubbed.har') '{"ok":true}' }
            if ($opts.Catalogued) { Set-Content -LiteralPath (Join-Path $dir 'catalogue.json') -Value '[]' -Encoding utf8 }
        }

        $captures = Join-Path $Path '.har-captures'
        $hostA = Join-Path $captures 'www.example.test'
        $hostB = Join-Path $captures 'www.other.test'

        & $makeCapture (Join-Path $hostA '2026-01-02-000001') @{}
        & $makeCapture (Join-Path $hostA '2026-01-02-000002') @{ Scrubbed = $true; Catalogued = $true }
        & $makeCapture (Join-Path $hostA '2026-01-02-000003') @{ Malformed = $true }
        & $makeCapture (Join-Path $captures '2026-01-01-000001') @{}
        & $makeCapture (Join-Path $hostB '2026-01-03-000001') @{ NoSession = $true; Mitm = $true }
        # A dump dropped straight under the captures root: declined, and with no
        # host layer to name it by.
        & $makeCapture (Join-Path $captures '2020-01-01-mitmdump') @{ NoSession = $true; Mitm = $true }
        New-Item -ItemType Directory -Path (Join-Path $captures '_analysis') -Force | Out-Null

        return $captures
    }

    # A copy of the scripts tree whose leak gate returns a chosen verdict.
    #
    # The rejection path cannot be reached with a payload: the scrub is good
    # enough that everything planted for it gets replaced, which is the point of
    # the scrub and not something to work around. So the VERDICT is stubbed --
    # the same technique capture-quarantine.test.js already uses for the same
    # reason -- while the scrub, the quarantine and the batch loop under test
    # stay real.
    function New-StubbedGateScripts {
        param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][int]$Verdict)

        Copy-Item -LiteralPath $script:ScriptsDir -Destination $Path -Recurse -Force
        $stub = @"
const fs = require('fs'), path = require('path');
const i = process.argv.indexOf('--in');
const target = process.argv[i + 1];
// verify-scrub.js writes its findings report beside the file it verified, and
// the quarantine is specified to move the report with the artifact. A stub that
// did not write one would leave that half of the behavior untested.
fs.writeFileSync(path.join(path.dirname(target), 'scrub-findings.json'),
    JSON.stringify({ findings: [], stub: true }));
// WHAT THE SESSION DIRECTORY LOOKED LIKE WHILE THE GATE WAS STILL DECIDING.
// This is the only moment an interruption can be observed from inside a test:
// the scrub has written its output and no verdict exists yet. If `scrubbed.har`
// is present HERE, then a run killed at this instant leaves the verified name
// beside a capture nobody verified -- and the next run skips it.
fs.writeFileSync(path.join(path.dirname(target), 'gate-observed.json'),
    JSON.stringify(fs.readdirSync(path.dirname(target))));
process.exit($Verdict);
"@
        Set-Content -LiteralPath (Join-Path $Path 'har/verify-scrub.js') -Value $stub -Encoding utf8
        return (Join-Path $Path 'har/Invoke-SanitizeHar.ps1')
    }

    function New-Tmp { Join-Path ([IO.Path]::GetTempPath()) ("har-batch-" + [guid]::NewGuid()) }
}

Describe 'the shared walk classifies every input class' {
    # Pester is the only suite CI runs. A Node test with no wrapper here is a
    # test that never runs on a pull request.
    It 'runs capture-store.test.js and all of its behavioral assertions pass' {
        $testJs = Join-Path $script:ScriptsDir 'capture/capture-store.test.js'
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All capture-store tests passed'
    }
}

Describe 'a folder means every capture under it' {

    BeforeEach {
        $script:Tmp = New-Tmp
        $script:Captures = New-BatchFixtureStore -Path $script:Tmp
        $script:Was = $PWD
        Set-Location -LiteralPath $script:Tmp
    }

    AfterEach {
        Set-Location -LiteralPath $script:Was
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'scrubs the unprocessed captures and skips the one already done' {
        $out = (& $script:Sanitize -InputHar $script:Captures 6>&1) -join "`n"

        # The two unprocessed recorder captures -- one current-layout, one
        # LEGACY at the captures root, which a host-scoped walk would never
        # have reached.
        Test-Path -LiteralPath (Join-Path $script:Captures 'www.example.test/2026-01-02-000001/scrubbed.har') |
            Should -BeTrue -Because 'a current-layout capture with no scrubbed HAR is what the batch is for'
        Test-Path -LiteralPath (Join-Path $script:Captures '2026-01-01-000001/scrubbed.har') |
            Should -BeTrue -Because 'the legacy layout is 6 of the captures in the measured store'

        $out | Should -Match '2 processed'
        $out | Should -Match 'www\.example\.test/2026-01-02-000002 -- already scrubbed'
    }

    It 'names and declines a capture this recorder did not make' {
        $out = (& $script:Sanitize -InputHar $script:Captures 6>&1) -join "`n"

        $out | Should -Match '2 declined'
        $out | Should -Match 'www\.other\.test/2026-01-03-000001 -- not recorder output \(raw\.mitm'

        # A DECLINED CAPTURE AT THE CAPTURES ROOT has no host layer, so it is
        # named by its stamp alone -- exactly as a legacy capture is. Labelling
        # it by class rather than by whether a host exists produced a leading
        # slash and an empty host segment, in the one output an operator reads
        # to decide what to triage.
        $out | Should -Match '(?m)^\s*2020-01-01-mitmdump -- not recorder output'
        $out | Should -Not -Match '(?m)^\s*/2020-01-01-mitmdump'
        # Declined, not scrubbed: it has no session.json, so nothing can say
        # whose traffic it is.
        Test-Path -LiteralPath (Join-Path $script:Captures 'www.other.test/2026-01-03-000001/scrubbed.har') |
            Should -BeFalse
    }

    It 'records a malformed capture against itself and keeps going' {
        $out = (& $script:Sanitize -InputHar $script:Captures 6>&1) -join "`n"

        $out | Should -Match 'www\.example\.test/2026-01-02-000003 -- sanitize-har\.js exit'
        # THE ISOLATION. The malformed capture sorts before the legacy one in
        # neither ordering by accident -- what matters is that captures other
        # than the failure still produced output.
        Test-Path -LiteralPath (Join-Path $script:Captures 'www.example.test/2026-01-02-000001/scrubbed.har') |
            Should -BeTrue -Because 'one bad capture must not abort a run over 88 of them'
        Test-Path -LiteralPath (Join-Path $script:Captures '2026-01-01-000001/scrubbed.har') |
            Should -BeTrue
    }

    It 'skips everything on a second run, and -Force runs it again' {
        & $script:Sanitize -InputHar $script:Captures 6>&1 | Out-Null

        $resumed = (& $script:Sanitize -InputHar $script:Captures 6>&1) -join "`n"
        $resumed | Should -Match '0 processed'
        $resumed | Should -Match '3 skipped'

        # A 9.0 GB store will be interrupted, so the SECOND run is the normal
        # one. What was scrubbed stays scrubbed and is not redone; what failed
        # is retried, because a failure left no completed artifact.
        $forced = (& $script:Sanitize -InputHar $script:Captures -Force 6>&1) -join "`n"
        $forced | Should -Match '3 processed'
        $forced | Should -Not -Match 'already scrubbed'
    }

    It 'summarises processed, skipped, declined and failed with reasons' {
        $out = (& $script:Sanitize -InputHar $script:Captures 6>&1) -join "`n"

        # Reviewable without reading 88 directories -- one line of counts, then
        # only the captures that need a decision.
        $out | Should -Match 'Scrub over 6 capture\(s\): 2 processed, 1 skipped, 2 declined, 1 failed'
        foreach ($section in 'skipped:', 'declined:', 'failed:') { $out | Should -Match $section }
    }

    It 'never prints a captured value' {
        $out = (& $script:Sanitize -InputHar $script:Captures 6>&1) -join "`n"

        # The fixture's start URI holds a token in its path -- a magic link, a
        # password reset, a signed start URL. Host and stamp are permitted; the
        # URI is not, and neither is the operator's describe.
        $out | Should -Not -Match 'FIXTURE-START-TOKEN'
        $out | Should -Not -Match 'api\.example\.test'

        # AND NOT THE CAPTURE'S OWN BYTES, by way of the scrub's failure
        # message. Node's JSON parser quotes the head of an input it cannot
        # parse, so republishing the scrub's last output line verbatim puts the
        # capture's first characters straight into the operator-facing summary.
        # The malformed fixture carries a sentinel for exactly this.
        $out | Should -Not -Match 'SENTINELBY' `
            -Because 'a failing scrub''s own output can quote the capture it failed on'
        # The failure is still REPORTED -- the capture is named and the exit
        # code is given, or the assertion above would pass on silence.
        $out | Should -Match 'www\.example\.test/2026-01-02-000003 -- sanitize-har\.js exit 1'
        # And the host/stamp that ARE permitted really are being printed, or
        # the assertion above would pass on an empty summary.
        $out | Should -Match 'www\.example\.test/2026-01-02-'
    }

    It 'narrows to one host by being pointed at the host folder' {
        $out = (& $script:Sanitize -InputHar (Join-Path $script:Captures 'www.example.test') 6>&1) -join "`n"

        # This is why there is no --host option: the path already says it.
        $out | Should -Match 'over 3 capture\(s\)'
        Test-Path -LiteralPath (Join-Path $script:Captures '2026-01-01-000001/scrubbed.har') |
            Should -BeFalse -Because 'a run narrowed to one host must not reach another capture'
    }

    It 'catalogues the store, and says which captures nobody has scrubbed' {
        & $script:Sanitize -InputHar $script:Captures 6>&1 | Out-Null
        $out = (& $script:Catalogue -Path $script:Captures 6>&1) -join "`n"

        # #386's actual complaint, said out loud: 83 of 88 captures are
        # unprocessed and nothing ever reported it.
        $out | Should -Match 'www\.example\.test/2026-01-02-000003 -- no scrubbed\.har'
        $out | Should -Match 'www\.example\.test/2026-01-02-000002 -- already catalogued'
        $out | Should -Match '2 declined'
    }
}

Describe 'a batch does not soften the leak gate' {

    BeforeEach {
        $script:Tmp = New-Tmp
        $script:Captures = New-BatchFixtureStore -Path $script:Tmp
        $script:Stubbed = Join-Path $script:Tmp 'stub-scripts'
        $script:Was = $PWD
        Set-Location -LiteralPath $script:Tmp
    }

    AfterEach {
        Set-Location -LiteralPath $script:Was
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'quarantines a rejected scrub in its own session directory and promotes nothing' {
        $sanitize = New-StubbedGateScripts -Path $script:Stubbed -Verdict 3
        $out = (& $sanitize -InputHar $script:Captures 6>&1) -join "`n"

        $capture = Join-Path $script:Captures 'www.example.test/2026-01-02-000001'
        Test-Path -LiteralPath (Join-Path $capture 'scrubbed.har') |
            Should -BeFalse -Because 'a scrub the gate refused must not be published under the verified name'
        Test-Path -LiteralPath (Join-Path $capture 'scrubbed.rejected.har') |
            Should -BeTrue -Because 'every byte is kept for triage; nothing under .har-captures is deleted'
        # The findings report moves with the artifact it describes. Separated,
        # it is a report nobody can act on.
        (Get-ChildItem -LiteralPath $capture -Filter 'scrub-findings*.json').Count |
            Should -BeGreaterThan 0

        # AND THE RUN CONTINUED. Both scrubbable captures were attempted and both
        # were rejected -- "keep going" moved to the next capture, it did not
        # accept this one. The malformed capture fails for its own reason, which
        # is why the count is three.
        $out | Should -Match '0 processed'
        $out | Should -Match '3 failed'
        $out | Should -Match 'www\.example\.test/2026-01-02-000001 -- leak gate REJECTED'
        $out | Should -Match '2026-01-01-000001 -- leak gate REJECTED'
    }

    It 'has not written the verified name while the gate is still deciding' {
        $sanitize = New-StubbedGateScripts -Path $script:Stubbed -Verdict 3
        & $sanitize -InputHar $script:Captures 6>&1 | Out-Null

        # THE INTERRUPTION THIS FEATURE HAS TO SURVIVE. A 9.0 GB store with a
        # 1.6 GB capture in it will be killed mid-run, and the dangerous instant
        # is between "the scrub wrote its output" and "the gate returned a
        # verdict". A run that had written straight to `scrubbed.har` and
        # quarantined afterwards leaves the completed artifact's own name on
        # disk at that instant -- and resume, which reads exactly that name,
        # skips a capture the gate was about to REFUSE.
        $capture = Join-Path $script:Captures 'www.example.test/2026-01-02-000001'
        $seen = Get-Content -LiteralPath (Join-Path $capture 'gate-observed.json') -Raw | ConvertFrom-Json
        $seen | Should -Not -Contain 'scrubbed.har' `
            -Because 'the finished name must never exist for a capture that has not earned it, not even briefly'
        $seen | Should -Contain '.scrubbing-scrubbed.har' `
            -Because 'the gate must have had something to verify, or this assertion checks nothing'
    }

    It 'does not mistake a quarantined scrub for a completed one on the next run' {
        $sanitize = New-StubbedGateScripts -Path $script:Stubbed -Verdict 3
        & $sanitize -InputHar $script:Captures 6>&1 | Out-Null

        # THE RESUME CORRECTNESS THIS FEATURE TURNS ON. If the scrub were
        # written straight to `scrubbed.har` and quarantined afterwards, an
        # interrupted run would leave the verified name beside a capture the
        # gate REFUSED -- and the next run would skip it.
        $again = (& $sanitize -InputHar $script:Captures 6>&1) -join "`n"
        $again | Should -Match 'www\.example\.test/2026-01-02-000001 -- leak gate REJECTED' `
            -Because 'a capture whose scrub was refused has no verified artifact and must be retried'
        $again | Should -Not -Match 'www\.example\.test/2026-01-02-000001 -- already scrubbed'
        # And the first quarantine was not overwritten by the second.
        $capture = Join-Path $script:Captures 'www.example.test/2026-01-02-000001'
        (Get-ChildItem -LiteralPath $capture -Filter 'scrubbed.rejected*.har').Count |
            Should -Be 2 -Because 'nothing under .har-captures is replaced, quarantined artifacts included'
    }

    It 'keeps the artifact on an ADVISORY verdict, and says so' {
        $sanitize = New-StubbedGateScripts -Path $script:Stubbed -Verdict 4
        $out = (& $sanitize -InputHar $script:Captures 6>&1) -join "`n"

        # Exit 4 is identity evidence by SHAPE alone. Non-zero so nothing reads
        # it as clean, but its own code so the artifact is KEPT -- the same
        # distinction a single run makes, carried through rather than collapsed
        # into "it failed".
        Test-Path -LiteralPath (Join-Path $script:Captures 'www.example.test/2026-01-02-000001/scrubbed.har') |
            Should -BeTrue
        $out | Should -Match '2 processed'
        $out | Should -Match 'ADVISORY'
    }
}

Describe 'single-capture behaviour is unchanged' {

    BeforeEach {
        $script:Tmp = New-Tmp
        $script:Captures = New-BatchFixtureStore -Path $script:Tmp
        $script:Was = $PWD
        Set-Location -LiteralPath $script:Tmp
    }

    AfterEach {
        Set-Location -LiteralPath $script:Was
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'a FILE still scrubs to the named output and prints no batch summary' {
        $raw = Join-Path $script:Captures 'www.example.test/2026-01-02-000001/raw.har'
        $outHar = Join-Path $script:Tmp 'clean.har'
        $out = (& $script:Sanitize -InputHar $raw -OutputHar $outHar 6>&1) -join "`n"

        Test-Path -LiteralPath $outHar | Should -BeTrue
        $out | Should -Not -Match 'Scrub over'
    }

    It 'a folder that is not a store falls through to the single-capture path' {
        # `.\Invoke-HarCatalogue.ps1 .\app.example.com` -- an OUTPUT directory
        # holding a scrubbed.har -- is a documented example. The shared walk
        # finds no captures in it, so nothing about that call changed.
        $outputDir = Join-Path $script:Tmp 'app.example.test'
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
        $out = (& $script:Catalogue -Path $outputDir 6>&1 2>&1) -join "`n"

        $out | Should -Not -Match 'Catalogue over'
        # It reaches capture-har.js, which says what a single run says.
        $out | Should -Match 'nothing to catalogue|does not exist'
    }

    It 'a bare not-recorder-output directory still fails as it did before' {
        # Pointing the catalogue stage straight at a mitmproxy dump resolved to
        # exactly one capture, so it must take the single-capture path and fail
        # the way it always has. Routing it into the batch instead would report
        # "1 declined" and exit 0 -- a run that did nothing, announcing success.
        $mitm = Join-Path $script:Captures 'www.other.test/2026-01-03-000001'
        $out = (& $script:Catalogue -Path $mitm 6>&1 2>&1) -join "`n"

        $out | Should -Not -Match 'Catalogue over'
        $out | Should -Match 'nothing to catalogue|does not exist'
        $LASTEXITCODE | Should -Not -Be 0 -Because 'nothing was catalogued'
    }

    It 'a single session directory is one capture, not a batch of one' {
        $capture = Join-Path $script:Captures 'www.example.test/2026-01-02-000002'
        $out = (& $script:Catalogue -Path $capture 6>&1 2>&1) -join "`n"

        $out | Should -Not -Match 'Catalogue over'
    }
}

Describe 'the approved command-line surface, and nothing more' {

    # -Force is the ONE option this feature adds, and it was approved
    # explicitly. --host and --dry-run were considered and dropped: host
    # filtering falls out of pointing at the host folder, and -WhatIf already
    # exists on the scrub wrapper. Pinned so they cannot arrive quietly later.
    It 'Invoke-SanitizeHar.ps1 gained exactly one parameter' {
        $params = (Get-Command $script:Sanitize).Parameters.Keys |
            Where-Object { $_ -notin [System.Management.Automation.PSCmdlet]::CommonParameters -and
                           $_ -notin [System.Management.Automation.PSCmdlet]::OptionalCommonParameters }
        ($params | Sort-Object) -join ',' |
            Should -Be 'Force,InputHar,OutputHar,ProfilePath,RemoveSource,SubstitutionsFile,VerifyOnly'
    }

    It 'Invoke-HarCatalogue.ps1 gained exactly one parameter' {
        $params = (Get-Command $script:Catalogue).Parameters.Keys |
            Where-Object { $_ -notin [System.Management.Automation.PSCmdlet]::CommonParameters -and
                           $_ -notin [System.Management.Automation.PSCmdlet]::OptionalCommonParameters }
        ($params | Sort-Object) -join ',' | Should -Be 'Force,OutputPath,Path'
    }

    It 'capture-store.js takes a path and offers no options at all' {
        # It is plumbing between the Node walk and the PowerShell drivers, not
        # an operator surface. The read-only store REPORT an operator runs is
        # #387, and giving this one filters would be that feature arriving by
        # the back door.
        $source = Get-Content -LiteralPath (Join-Path $script:ScriptsDir 'capture/capture-store.js') -Raw
        $source | Should -Not -Match "process\.argv\.indexOf\('--"
        $source | Should -Not -Match "startsWith\('--'\)"
    }

    It 'refuses -Force where there is nothing for it to override' {
        $tmp = New-Tmp
        try {
            $captures = New-BatchFixtureStore -Path $tmp
            $raw = Join-Path $captures 'www.example.test/2026-01-02-000001/raw.har'
            # The script sets $ErrorActionPreference = 'Stop', so its refusal
            # arrives as a terminating error rather than an exit code.
            $said = $null
            try { & $script:Sanitize -InputHar $raw -OutputHar (Join-Path $tmp 'x.har') -Force | Out-Null }
            catch { $said = "$($_.Exception.Message)" }
            $said | Should -Match '-Force applies to a folder run only'
        }
        finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'refuses the single-destination options over a folder' {
        $tmp = New-Tmp
        try {
            $captures = New-BatchFixtureStore -Path $tmp
            $said = $null
            try { & $script:Sanitize -InputHar $captures -OutputHar (Join-Path $tmp 'one.har') | Out-Null }
            catch { $said = "$($_.Exception.Message)" }
            $said | Should -Match '-OutputHar cannot be combined with a folder'

            # -RemoveSource in particular: "delete the raws for every capture
            # under this folder" is not on offer at any scale.
            $said = $null
            try { & $script:Sanitize -InputHar $captures -RemoveSource | Out-Null }
            catch { $said = "$($_.Exception.Message)" }
            $said | Should -Match 'nothing under \.har-captures/ is removed in bulk'
        }
        finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
