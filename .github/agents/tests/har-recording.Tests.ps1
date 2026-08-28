#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the HAR capture pipeline (issues #270, #281):
# capture-har.js and its two PowerShell front doors.
#
# None of these launch a browser. The recorder's browser handling is verified
# by hand against a real site; what is pinned here is everything a regression
# could silently break -- argument contracts, the containment that keeps a
# credential-bearing raw capture out of a committable directory, the object
# surface, and the failure reporting that stops an empty capture being
# analyzed as data.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:CaptureDir = Join-Path $script:ScriptsDir 'capture'
    $script:CaptureJs  = Join-Path $script:CaptureDir 'capture-har.js'
    $script:CaptureTestJs = Join-Path $script:CaptureDir 'capture-har.test.js'
    $script:InvokePs1  = Join-Path $script:CaptureDir 'Invoke-HarCapture.ps1'
    $script:StopPs1    = Join-Path $script:CaptureDir 'Stop-HarRecording.ps1'
    $script:ConvertPs1 = Join-Path $script:CaptureDir 'ConvertFrom-HarCatalogue.ps1'
    $script:PromptMd   = Join-Path $script:CaptureDir 'catalogue-prompt.md'
    $script:SkillMd    = Join-Path $script:RepoRoot '.github/skills/web-api-discovery/SKILL.md'

    # The raw capture location is FIXED and no flag can move it. It resolves
    # against the WORKING DIRECTORY, so the only way a test contains one is by
    # choosing where node runs -- which is exactly the containment being
    # asserted, exercised rather than bypassed.
    function Invoke-CaptureHar {
        param([Parameter(ValueFromRemainingArguments)][string[]]$CaptureArgs)
        Push-Location -LiteralPath $script:Tmp
        # Keep the streams apart: --validate-only writes machine-readable JSON
        # on stdout and human notes on stderr, and a test that merges them
        # cannot assert on either.
        $errFile = [IO.Path]::GetTempFileName()
        try {
            $out = & node $script:CaptureJs @CaptureArgs 2>$errFile | Out-String
            $code = $LASTEXITCODE
            $err = Get-Content -LiteralPath $errFile -Raw
        }
        finally {
            Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
            Pop-Location
        }
        [pscustomobject]@{
            StdOut   = $out
            StdErr   = $err
            Output   = "$out$err"
            ExitCode = $code
        }
    }

    # Run a PowerShell front door against a STUB node, and report what it
    # forwarded and what it wrote to each stream.
    #
    # The front doors were previously asserted by grepping their own source for
    # '--log-level' and 'VerbosePreference'. That passes just as happily when
    # the condition is inverted, so it pins the spelling rather than the
    # behavior. Standing a fake `node` in front of the real one on PATH is what
    # makes "which arguments did node receive" and "did -InformationAction
    # actually suppress anything" observable without launching a browser.
    #
    # node.cmd rather than a .ps1: PATHEXT makes `& node` resolve a .cmd, and
    # the front door's own `Get-Command node` preflight finds it too.
    function Invoke-FrontDoor {
        param(
            [Parameter(Mandatory)][string]$Script,
            [hashtable]$Arguments = @{}
        )
        $stubDir = Join-Path $script:Tmp ('stub-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
        $argsFile = Join-Path $stubDir 'args.txt'
        Set-Content -LiteralPath (Join-Path $stubDir 'node.cmd') -Encoding ascii -Value @(
            '@echo off'
            "echo %* > `"$argsFile`""
            'exit /b 0'
        )

        # Streams are redirected to FILES, not to -InformationVariable: the
        # common variable parameters collect records even when the matching
        # action is SilentlyContinue, so a test built on them cannot tell
        # "suppressed" from "emitted". What reaches stream 6 can.
        $infoFile = Join-Path $stubDir 'info.txt'
        $warnFile = Join-Path $stubDir 'warn.txt'

        $savedPath = $env:PATH
        $env:PATH = "$stubDir;$savedPath"
        try {
            & $Script @Arguments 6> $infoFile 3> $warnFile 2>$null | Out-Null
        }
        finally {
            $env:PATH = $savedPath
        }

        # Get-Content -Raw returns $null for an empty file, and a stream a
        # command never wrote to is exactly that -- coalesce so the caller can
        # always .Trim() what comes back.
        function Read-Stream([string]$Path) {
            $text = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { $null }
            if ($null -eq $text) { '' } else { $text }
        }

        [pscustomobject]@{
            Args        = (Read-Stream $argsFile).Trim()
            Information = (Read-Stream $infoFile).Trim()
            Warning     = (Read-Stream $warnFile).Trim()
        }
    }

    # A pid that cannot exist: Windows pids are multiples of 4 well below this,
    # so process.kill(pid, 0) reports ESRCH -- i.e. "that driver is gone".
    $script:DeadPid = 999999

    # A session directory as it looks after the driver was lost: a record log
    # with entries, a session.json, and no raw.har.
    #
    # -Crashed models the case that actually matters and is easy to get wrong:
    # a driver killed MID-RECORDING never gets to write endedUtc, so a fixture
    # that hardcodes endedUtc quietly tests a different, far rarer scenario --
    # "ended cleanly, cleanup failed" -- while reading as though it covered the
    # crash.
    function New-LostSession {
        param(
            [Parameter(Mandatory)][string]$Root,
            [int]$Entries = 2,
            [switch]$Crashed,
            # Sessions resolve newest-last by directory name, so a test that
            # needs to tell "the pointer was followed" from "the newest-on-disk
            # fallback found the same thing" must create two, with different
            # stamps. A single-session fixture cannot distinguish them.
            [string]$Stamp = '2026-01-01-120000',
            [int]$OwnerPid = $script:DeadPid,
            [string]$OutputPath,
            # Sessions live at <capturesRoot>/<host>/<stamp>. The fixture must
            # mirror that: seeded flat, the newest-on-disk fallback finds
            # nothing and every status/stop test resolves no session at all.
            [string]$HostFolder = 'example.com'
        )
        $sessionDir = Join-Path (Join-Path $Root $HostFolder) $Stamp
        New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null
        if (-not $OutputPath) { $OutputPath = Join-Path $Root 'out' }
        $lines = 1..$Entries | ForEach-Object {
            @{
                startedDateTime = "2026-01-01T12:00:0${_}Z"
                time            = 0
                request         = @{ method = 'GET'; url = "https://example.com/api/thing/$_"; headers = @() }
                response        = @{ status = 200; content = @{ text = '{"ok":true}' }; headers = @() }
                cache           = @{}
                timings         = @{}
            } | ConvertTo-Json -Depth 8 -Compress
        }
        Set-Content -LiteralPath (Join-Path $sessionDir 'raw.ndjson') -Value $lines -Encoding utf8
        $session = @{
            uri        = 'https://example.com'
            sessionDir = $sessionDir
            harPath    = Join-Path $sessionDir 'raw.har'
            recordLog  = Join-Path $sessionDir 'raw.ndjson'
            outputPath = $OutputPath
            startedUtc = '2026-01-01T12:00:00Z'
            port       = 49999
            pid        = $OwnerPid
        }
        # A crashed driver leaves NO endedUtc -- that is the whole difficulty.
        if (-not $Crashed) { $session.endedUtc = '2026-01-01T12:05:00Z' }
        $session | ConvertTo-Json -Depth 8 |
            Set-Content -LiteralPath (Join-Path $sessionDir 'session.json') -Encoding utf8
        return $sessionDir
    }
}

Describe 'capture-har.js behavior suite' {
    # The pure functions -- entry construction, log assembly, digest,
    # containment, catalogue delegation -- are pinned by the zero-dep Node
    # suite beside the script, following the convention the rest of the
    # toolkit's JS uses.

    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:CaptureTestJs | Should -BeTrue
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:CaptureTestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Information ($out -join "`n") -InformationAction Continue }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All capture-har tests passed'
    }
}

Describe 'capture-har.js' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("har-rec-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:CaptureJs | Should -BeTrue
    }

    It 'is valid JavaScript (parses without syntax errors)' {
        & node --check $script:CaptureJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'resolves a session without launching a browser under --validate-only' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' --validate-only
        $r.ExitCode | Should -Be 0
        $r.Output | Should -Match 'no browser launched'
        $r.Output | Should -Match 'cdpEndpoint'
    }

    It 'rejects a start with no URI' {
        $r = Invoke-CaptureHar start
        $r.ExitCode | Should -Be 2
    }

    It 'accepts --log-level on start, and rejects a value that is not a level' {
        $ok = Invoke-CaptureHar start --uri 'https://example.com' --log-level verbose --validate-only
        $ok.ExitCode | Should -Be 0
        $bad = Invoke-CaptureHar start --uri 'https://example.com' --log-level loud --validate-only
        $bad.ExitCode | Should -Be 2
        $bad.Output | Should -Match '(?i)log-level'
    }

    It 'keeps stdout machine-readable at every level' {
        # The banner used to be on stdout. Levelling it up without moving it
        # would make `Invoke-HarCapture ... | ConvertFrom-Json` fail on exactly
        # the verbose run an operator reaches for when something is wrong.
        foreach ($level in 'normal', 'verbose') {
            $r = Invoke-CaptureHar start --uri 'https://example.com' `
                --log-level $level --validate-only
            $r.ExitCode | Should -Be 0
            { $r.StdOut | ConvertFrom-Json } | Should -Not -Throw `
                -Because "stdout must be pure JSON at --log-level $level"
        }
    }

    It 'reports a failed phase without -Verbose, and the raw path only with it' {
        # The level must never gate a failure. This fixture has no
        # .har-profile.json, so the scrub cannot run -- an operator who never
        # types -Verbose still has to be told that, while the resolved raw
        # path stays a diagnostic.
        $sessionDir = New-LostSession -Root $script:Tmp
        $quiet = Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp
        $quiet.Output | Should -Match 'ERROR:'
        $quiet.Output | Should -Not -Match 'raw:\s+\S'

        $sessionDir2 = New-LostSession -Root $script:Tmp -Stamp '2026-01-01-130000'
        $loud = Invoke-CaptureHar stop --session $sessionDir2 --dir $script:Tmp --log-level verbose
        $loud.Output | Should -Match 'raw:\s+\S'
        $loud.Output | Should -Match 'ERROR:'
    }

    It 'refuses --dir on start rather than silently ignoring it' {
        # --dir was how a raw capture got redirected out of the gitignored
        # tree. Accepting and ignoring it would leave the operator believing
        # the raw had moved -- worse than rejecting it.
        $r = Invoke-CaptureHar start --uri 'https://example.com' --dir $script:Tmp --validate-only
        $r.ExitCode | Should -Be 2
        $r.Output | Should -Match '(?i)confined to \.har-captures'
    }

    It 'refuses --storage-state, which is now auto-discovered' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' `
            --storage-state (Join-Path $script:Tmp 'state.json') --validate-only
        $r.ExitCode | Should -Be 2
        $r.Output | Should -Match '(?i)discovered automatically'
    }

    It 'writes the raw capture under the captures root, never under --output-path' {
        # The leak .gitignore documented in its own comment, closed by
        # construction rather than by a check.
        $outputPath = Join-Path $script:Tmp 'refs'
        $r = Invoke-CaptureHar start --uri 'https://example.com' `
            --output-path $outputPath --validate-only
        $r.ExitCode | Should -Be 0
        $session = $r.StdOut | ConvertFrom-Json
        $session.harPath | Should -BeLike (Join-Path $script:Tmp '.har-captures*')
        $session.harPath | Should -Not -BeLike "$outputPath*"
    }

    It 'keys both output roots on the captured host' {
        # scrubbed.har, digest.json and catalogue.json are fixed filenames, so
        # before this a second capture silently overwrote the first.
        $outputPath = Join-Path $script:Tmp 'refs'
        $r = Invoke-CaptureHar start --uri 'https://app.example.com/login' `
            --output-path $outputPath --validate-only
        $r.ExitCode | Should -Be 0
        $session = $r.StdOut | ConvertFrom-Json
        $session.harPath | Should -BeLike '*.har-captures*app.example.com*raw.har'
        $session.outputPath | Should -Be (Join-Path $outputPath 'app.example.com')
    }

    It 'names the folder from the host alone, never the rest of the URL' {
        # A magic-link or password-reset URL carries its token in the path or
        # the query, and the output path is the committable directory.
        $r = Invoke-CaptureHar start --uri 'https://app.example.com/reset/PATHTOK?t=QUERYTOK' `
            --validate-only
        $r.ExitCode | Should -Be 0
        $session = $r.StdOut | ConvertFrom-Json
        $session.outputPath | Should -BeLike '*app.example.com'
        $session.outputPath | Should -Not -Match 'PATHTOK|QUERYTOK'
        $session.harPath | Should -Not -Match 'PATHTOK|QUERYTOK'
    }

    It 'renders a port with an underscore, since a dash is legal in a hostname' {
        $r = Invoke-CaptureHar start --uri 'https://localhost:5001/' --validate-only
        $r.ExitCode | Should -Be 0
        ($r.StdOut | ConvertFrom-Json).outputPath | Should -BeLike '*localhost_5001'
    }

    It 'falls forward to a free port instead of failing on a busy one' {
        # A busy port used to be a hard error because it doubled as the
        # "a capture is already running" detector. Those are different
        # concerns; only a profile in use is a real conflict.
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $busy = $listener.LocalEndpoint.Port
        try {
            $r = Invoke-CaptureHar start --uri 'https://example.com' --port $busy --validate-only
            $r.ExitCode | Should -Be 0
            $session = $r.StdOut | ConvertFrom-Json
            $session.port | Should -Not -Be $busy
            $session.requestedPort | Should -Be $busy
            $session.cdpEndpoint | Should -Match ":$($session.port)$" `
                -Because 'an agent reads the endpoint rather than assuming 9333'
        }
        finally { $listener.Stop() }
    }

    It 'reports that there is nothing to stop rather than inventing a session' {
        $r = Invoke-CaptureHar stop --dir $script:Tmp
        $r.ExitCode | Should -Be 3
        $r.Output | Should -Match 'no capture session found'
    }

    It 'never terminates a process' {
        # Killing a browser discards the recording AND can destroy unrelated
        # signed-in windows on the developer's machine.
        #
        # The invariant is "terminates nothing", not "never names an API called
        # kill": `process.kill(pid, 0)` sends no signal and is the standard way
        # to ask whether a pid is alive. So ban the terminating forms, and
        # require every process.kill call to pass signal 0.
        $source = Get-Content -LiteralPath $script:CaptureJs -Raw
        $source | Should -Not -Match 'SIGKILL|SIGTERM|taskkill|pkill|\.destroy\(\)'

        $killCalls = [regex]::Matches($source, 'process\.kill\(([^)]*)\)')
        foreach ($call in $killCalls) {
            $call.Groups[1].Value | Should -Match ',\s*0\s*$' -Because 'a liveness probe must send signal 0, never a terminating signal'
        }
    }

    It 'applies no HAR glob -- the capture is unfiltered' {
        (Get-Content -LiteralPath $script:CaptureJs -Raw) | Should -Not -Match 'save-har-glob|urlFilter'
    }
}

Describe 'capture-har.js --profile' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("har-rec-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'gives a bare name its own capture profile' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' --profile 'work' --validate-only
        $r.ExitCode | Should -Be 0
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Match 'har-capture[\\/]profile-work$'
    }

    It 'folds an awkward name to a safe directory name' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' --profile 'My Account!' --validate-only
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Match 'profile-my-account-$'
    }

    It 'records into a path another tool owns, verbatim' {
        # The integration point for a project that keys profiles off its own
        # concept: it computes the directory, we record as that identity.
        $external = Join-Path $script:Tmp 'someapp/profile-alias-1a2b3c4d'
        $r = Invoke-CaptureHar start --uri 'https://example.com' --profile $external --validate-only
        $r.ExitCode | Should -Be 0
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Be ([IO.Path]::GetFullPath($external))
    }

    It 'defaults to the shared capture profile when none is named' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' --validate-only
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Match 'har-capture[\\/]profile$'
    }
}

Describe 'capture-har.js assembling a lost recording' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("har-rec-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'assembles raw.har itself when the driver was lost' {
        # Exit 5 no longer means "degraded artifact" -- it means "assembled
        # from the incremental log rather than recordHar". The file is a
        # genuine HAR either way, which is what makes closing the window safe.
        $sessionDir = New-LostSession -Root $script:Tmp -Entries 3
        $r = Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp

        $r.ExitCode | Should -BeIn @(5, 6)
        $rawHar = Join-Path $sessionDir 'raw.har'
        Test-Path -LiteralPath $rawHar | Should -BeTrue

        $har = Get-Content -LiteralPath $rawHar -Raw | ConvertFrom-Json
        $har.log.version | Should -Be '1.2'
        $har.log.entries.Count | Should -Be 3
        $har.log.entries[0].request.url | Should -Match 'example\.com'
    }

    It 'does not write a separate raw.snapshot.har any more' {
        # Two artifacts invited someone to analyze the weaker one. There is
        # now exactly one: raw.har.
        $sessionDir = New-LostSession -Root $script:Tmp
        Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp | Out-Null
        Test-Path -LiteralPath (Join-Path $sessionDir 'raw.snapshot.har') | Should -BeFalse
    }

    It 'does not label the assembled capture a degraded recovery artifact' {
        $sessionDir = New-LostSession -Root $script:Tmp
        Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp | Out-Null
        $text = Get-Content -LiteralPath (Join-Path $sessionDir 'raw.har') -Raw
        $text | Should -Not -Match 'RECOVERY ARTIFACT'
    }

    It 'honours an explicit --min-bytes 0 instead of substituting the default' {
        # `Number(x) || DEFAULT` swallows a deliberate 0, turning "accept
        # whatever was captured" into the 1024-byte floor without a word.
        $sessionDir = New-LostSession -Root $script:Tmp
        Set-Content -LiteralPath (Join-Path $sessionDir 'raw.har') `
            -Value '{"log":{"version":"1.2","entries":[]}}' -Encoding utf8

        $r = Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp --min-bytes 0
        $r.Output | Should -Not -Match 'failed capture'
    }

    It 'gives up quickly on a session whose recorder crashed mid-recording' {
        # A dead driver never answers the sentinel. Waiting the full 60s timeout
        # for it is indistinguishable from a healthy but slow stop.
        $sessionDir = New-LostSession -Root $script:Tmp -Crashed

        $elapsed = Measure-Command { $script:R = Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp }
        $elapsed.TotalSeconds | Should -BeLessThan 30
        $script:R.Output | Should -Match 'no longer running'
    }

    It 'abandons a current-session pointer whose recorder crashed, for the newer capture' {
        # The hard case: a driver killed before its own cleanup leaves the
        # pointer behind AND never writes endedUtc, so "has it ended?" cannot
        # distinguish it from a live recording -- only "is its driver alive?"
        # can.
        #
        # TWO sessions, deliberately: with only one on disk, the pointer branch
        # and the newest-on-disk fallback resolve the same directory, and the
        # test would pass even if the pointer logic were deleted outright.
        $crashed = New-LostSession -Root $script:Tmp -Crashed -Stamp '2020-01-01-120000'
        $newer = New-LostSession -Root $script:Tmp -Stamp '2030-01-01-120000'
        @{ sessionDir = $crashed } | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $script:Tmp 'current.json') -Encoding utf8

        $r = Invoke-CaptureHar status --dir $script:Tmp
        $r.ExitCode | Should -Be 0
        $status = $r.StdOut | ConvertFrom-Json
        $status.sessionDir | Should -Be $newer `
            -Because 'a dead pointer must not hide the capture the operator actually wants'
        $status.recording | Should -BeFalse `
            -Because 'a crashed recorder must never be reported as still recording'
    }

    It 'follows the pointer to a live recording even when a newer capture exists' {
        # The mirror: liveness is judged by the driver pid, so a live session
        # must still win over a newer-but-finished one. Without this, "ignore
        # stale pointers" could regress into "ignore all pointers" and every
        # stop would target the wrong capture.
        $live = New-LostSession -Root $script:Tmp -Crashed -Stamp '2020-01-01-120000' -OwnerPid $PID
        New-LostSession -Root $script:Tmp -Stamp '2030-01-01-120000' | Out-Null
        @{ sessionDir = $live } | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $script:Tmp 'current.json') -Encoding utf8

        $status = (Invoke-CaptureHar status --dir $script:Tmp).StdOut | ConvertFrom-Json
        $status.sessionDir | Should -Be $live `
            -Because 'the running recording is the one a stop must reach'
        $status.recording | Should -BeTrue
    }

    It 'reports a failure when neither recorder produced anything' {
        $sessionDir = New-LostSession -Root $script:Tmp
        Remove-Item -LiteralPath (Join-Path $sessionDir 'raw.ndjson') -Force

        $r = Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp
        $r.ExitCode | Should -Be 4
        $r.Output | Should -Match 'lost entirely'
    }

    It 'treats a trivially small capture as failed rather than as data' {
        $sessionDir = New-LostSession -Root $script:Tmp
        Set-Content -LiteralPath (Join-Path $sessionDir 'raw.har') -Value '{}' -Encoding utf8

        $r = Invoke-CaptureHar stop --session $sessionDir --dir $script:Tmp --min-bytes 1024
        $r.ExitCode | Should -Be 4
        $r.Output | Should -Match 'failed capture'
    }

}

Describe 'raw captures are gitignored' {
    # A raw capture carries live session cookies. These assert what git will
    # ACTUALLY do, because the natural-looking pattern `*.raw.har` does not
    # match the file the recorder writes (`raw.har`), and the .har-captures/
    # directory rule hides that until someone looks closely.

    It 'ignores the capture the recorder writes, wherever it is written' {
        foreach ($p in @(
                '.har-captures/app.example.com/2026-01-01-120000/raw.har',
                '.har-captures/2026-01-01-120000/raw.har',
                'somewhere/else/raw.har',
                'somewhere/else/raw.ndjson')) {
            & git -C $script:RepoRoot check-ignore -q -- $p
            $LASTEXITCODE | Should -Be 0 -Because "$p holds live credentials and must never be committable"
        }
    }

    It 'ignores the operator profile and any serialized session' {
        foreach ($p in @('.har-profile.json', '.har-storage-state.json', 'anywhere/creds.storage-state.json')) {
            & git -C $script:RepoRoot check-ignore -q -- $p
            $LASTEXITCODE | Should -Be 0 -Because "$p holds real account identifiers or a live session"
        }
    }

    It 'does not ignore a scrubbed reference bound for the catalogue' {
        # The output path is now a host-named folder in the working directory,
        # so the scrubbed artifacts must stay visible to git there too.
        foreach ($p in @(
                'docs/har-reference/example.com/example.com-login-2026-01-01.har',
                'app.example.com/scrubbed.har',
                'app.example.com/catalogue.json',
                'app.example.com/acme/acme-login-2026-01-01.har')) {
            & git -C $script:RepoRoot check-ignore -q -- $p
            $LASTEXITCODE | Should -Not -Be 0 -Because "$p is a scrubbed artifact and must be committable"
        }
    }
}

Describe 'Invoke-HarCapture.ps1' {

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:InvokePs1 | Should -BeTrue
    }

    It 'replaced Start-HarRecording outright -- no alias, no shim' {
        Test-Path -LiteralPath (Join-Path $script:CaptureDir 'Start-HarRecording.ps1') | Should -BeFalse
    }

    It 'parses without syntax errors' {
        foreach ($f in @($script:InvokePs1, $script:StopPs1, $script:ConvertPs1)) {
            $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errors)
            $errors | Should -BeNullOrEmpty -Because "$f must parse"
        }
    }

    It 'exposes exactly the six documented parameters' {
        # Six, down from eight: -StorageState is auto-discovered and
        # -ValidateOnly stays on capture-har.js where it is the test seam.
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:InvokePs1, [ref]$null, [ref]$errors)
        $names = $ast.ParamBlock.Parameters |
            ForEach-Object { $_.Name.VariablePath.UserPath } |
            Sort-Object
        $names | Should -Be @('Describe', 'Isolated', 'OutputPath', 'Port', 'Profile', 'Uri')
    }

    It 'takes the URI positionally, so the parameter name is optional' {
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:InvokePs1, [ref]$null, [ref]$errors)
        $uri = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Uri' }
        $uri | Should -Not -BeNullOrEmpty
        $attr = $uri.Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' }
        ($attr.NamedArguments | Where-Object { $_.ArgumentName -eq 'Position' }) | Should -Not -BeNullOrEmpty
    }

    It 'reads the catalogue from its own -OutputPath, not the newest session on disk' {
        # Captures now coexist on different ports, so "newest directory under
        # .har-captures" is not this run's session: a second capture started in
        # another terminal and finished first would win the sort, and this
        # invocation would emit a different site's catalogue as its own.
        # Resolving from -OutputPath is the fix, and it means the script has no
        # reason to look under the captures root at all.
        $text = Get-Content -LiteralPath $script:InvokePs1 -Raw
        $text | Should -Not -Match "Select-Object\s+-Last\s+1" `
            -Because 'picking the last session directory is the race this fixes'
        $text | Should -Match 'catalogue\.json'
    }

    It 'wires -Verbose to the recorder instead of adding a seventh parameter' {
        # -Verbose is free with [CmdletBinding()]. A -LogLevel switch would be
        # a second way to say the same thing, and the six-parameter assertion
        # above is what stops one appearing.
        #
        # Asserted on the arguments node actually RECEIVES, not on the source
        # text: a grep for 'VerbosePreference' passes just as happily when the
        # condition is inverted.
        $plain = (Invoke-FrontDoor -Script $script:InvokePs1 -Arguments @{ Uri = 'https://example.com' }).Args
        $plain | Should -Match 'start --uri' -Because 'an args file node never wrote would satisfy the negative below for the wrong reason'
        $plain | Should -Not -Match '--log-level'

        (Invoke-FrontDoor -Script $script:InvokePs1 `
            -Arguments @{ Uri = 'https://example.com'; Verbose = $true }).Args |
            Should -Match '--log-level verbose'
    }

    It 'treats -Verbose:$false as off, not as "the switch was mentioned"' {
        # $PSBoundParameters.ContainsKey('Verbose') is true for -Verbose:$false
        # too. Reading the preference rather than the binding is what keeps an
        # explicit opt-out from turning the level up.
        $off = (Invoke-FrontDoor -Script $script:InvokePs1 `
            -Arguments @{ Uri = 'https://example.com'; Verbose = $false }).Args
        $off | Should -Match 'start --uri'
        $off | Should -Not -Match '--log-level'
    }

    It 'lets a caller take over the information stream with -InformationAction' {
        # `-InformationAction Continue` pinned on every call site meant the
        # common parameter did nothing: the stream was uncontrollable by the
        # very mechanism the convention points callers at.
        #
        # `Ignore` is the assertable end of that, not `SilentlyContinue`:
        # Write-Information writes the record to stream 6 either way and
        # SilentlyContinue only stops the HOST rendering it, so a redirect
        # cannot see the difference. Only Ignore drops the record -- and only
        # if the script stopped overriding the caller.
        $loud = Invoke-FrontDoor -Script $script:InvokePs1 -Arguments @{ Uri = 'https://example.com' }
        $loud.Information | Should -Match 'press ENTER' `
            -Because 'status is on by default -- that is what the pinning bought'

        $quiet = Invoke-FrontDoor -Script $script:InvokePs1 `
            -Arguments @{ Uri = 'https://example.com'; InformationAction = 'Ignore' }
        $quiet.Information | Should -BeNullOrEmpty
    }

    It 'keeps warnings audible when the status lines are silenced' {
        # Silencing chatter must not silence the report that the run produced
        # no catalogue.
        $quiet = Invoke-FrontDoor -Script $script:InvokePs1 `
            -Arguments @{ Uri = 'https://example.com'; InformationAction = 'Ignore' }
        $quiet.Warning | Should -Match 'no catalogue'
    }

    It 'derives the capture folder exactly as the recorder does' {
        # The rule lives in two runtimes: uriFolder() in capture-har.js decides
        # where artifacts are WRITTEN, Get-HarUriFolder here decides where the
        # catalogue is LOOKED FOR. If they ever disagree the front door reports
        # "no catalogue" for a capture that succeeded, so the duplication is
        # pinned rather than trusted.
        #
        # Dot-sourcing is not possible -- the script has a mandatory parameter
        # and would run -- so the function is lifted out of the source text and
        # re-defined here. That still pins the shipped implementation: an edit
        # to it changes what this test executes.
        $text = Get-Content -LiteralPath $script:InvokePs1 -Raw
        $start = $text.IndexOf('function Get-HarUriFolder')
        $start | Should -BeGreaterThan -1 -Because 'the front door must derive the folder itself'
        $end = $text.IndexOf("`n}", $start)
        . ([scriptblock]::Create($text.Substring($start, $end - $start + 2)))

        foreach ($u in @(
                'https://example.com',
                'https://app.example.com/reset/PATHTOK?t=QUERYTOK',
                'https://localhost:5001/',
                'https://my-app.example.com/',
                'HTTPS://APP.Example.COM/',
                'http://example.com:8080/x',
                'http://[::1]:8080/',
                # Two host-normalisation engines, assumed equivalent. .NET does
                # not punycode `.Host` (only `.IdnHost` does) and renders an
                # IPv4-mapped IPv6 tail dotted where WHATWG folds it to hex --
                # so an international site would have had its capture written
                # to one folder and its catalogue looked for in another.
                'http://xn--fiq228c.example/x',
                'http://中文.example/x',
                'http://[::ffff:1.2.3.4]/x',
                'http://example.com./x',
                'http://user:pass@example.com/x')) {
            $fromNode = & node -e 'process.stdout.write(require(require("path").resolve(process.argv[1])).uriFolder(process.argv[2]))' $script:CaptureJs $u
            $LASTEXITCODE | Should -Be 0 -Because "the recorder must accept $u"
            Get-HarUriFolder -Uri $u | Should -Be $fromNode -Because "the two implementations must agree on $u"
        }

        # Where the two engines cannot be reconciled, the front door must fail
        # CLOSED rather than guess. .NET will not parse a percent-encoded
        # hostname at all, while WHATWG decodes and punycodes it -- so this
        # errors out before recording instead of writing the capture to one
        # folder and looking for the catalogue in another.
        Get-HarUriFolder -Uri 'http://%E4%B8%AD%E6%96%87.example/x' | Should -BeNullOrEmpty `
            -Because 'an unreconcilable host must be refused up front, not guessed at'

        # The refusals matter as much as the agreements: 'http://../evil'
        # parses with a host of '..' and would walk the capture out of its own
        # directory, and file:/data:/about: parse with no host at all.
        foreach ($bad in @(
                'not-a-url',
                'http://../evil',
                'http://./x',
                'file:///etc/passwd',
                'data:text/plain,x',
                'about:blank')) {
            Get-HarUriFolder -Uri $bad | Should -BeNullOrEmpty `
                -Because "$bad must not yield a capture folder"

            & node -e 'try { require(require("path").resolve(process.argv[1])).uriFolder(process.argv[2]); process.exit(0) } catch (e) { process.exit(9) }' $script:CaptureJs $bad
            $LASTEXITCODE | Should -Be 9 -Because "the recorder must refuse $bad too"
        }
    }

    It 'forwards the level from Stop-HarRecording too' {
        $plain = (Invoke-FrontDoor -Script $script:StopPs1 -Arguments @{}).Args
        $plain | Should -Match 'stop --min-bytes'
        $plain | Should -Not -Match '--log-level'
        (Invoke-FrontDoor -Script $script:StopPs1 -Arguments @{ Verbose = $true }).Args |
            Should -Match '--log-level verbose'
    }

    It 'keeps status out of the pipeline -- no Write-Host anywhere in capture/' {
        # PSAvoidUsingWriteHost: Write-Host cannot be captured, redirected or
        # suppressed, and a ConvertTo-Json of the result must be pure data.
        $analyzer = Get-Module -ListAvailable -Name PSScriptAnalyzer
        if (-not $analyzer) { Set-ItResult -Skipped -Because 'PSScriptAnalyzer is not installed' ; return }
        Import-Module PSScriptAnalyzer -ErrorAction Stop
        $findings = Invoke-ScriptAnalyzer -Path $script:CaptureDir -Recurse `
            -IncludeRule PSAvoidUsingWriteHost
        $findings | Should -BeNullOrEmpty -Because ($findings | Out-String)
    }

    It 'is clean under the full default rule set' {
        $analyzer = Get-Module -ListAvailable -Name PSScriptAnalyzer
        if (-not $analyzer) { Set-ItResult -Skipped -Because 'PSScriptAnalyzer is not installed' ; return }
        Import-Module PSScriptAnalyzer -ErrorAction Stop
        $findings = Invoke-ScriptAnalyzer -Path $script:CaptureDir -Recurse -Severity Error, Warning
        $findings | Should -BeNullOrEmpty -Because ($findings | Out-String)
    }
}

Describe 'The catalogue object surface' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("har-cat-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
        $script:CataloguePath = Join-Path $script:Tmp 'catalogue.json'
        @(
            @{ Action = 'composer-story-create'; Description = 'Created a post'; Methods = @('POST')
               Endpoints = @('api.example.com/v1/posts'); EntryCount = 3; Status = 'Exercised'
               HarFile = 'example.com/example.com-composer-story-create-2026-01-01.har'
               CapturedUtc = '2026-01-01T12:00:00Z' }
            @{ Action = 'get-v1-notifications'; Description = $null; Methods = @('GET')
               Endpoints = @('api.example.com/v1/notifications'); EntryCount = 1; Status = 'Observed'
               HarFile = $null; CapturedUtc = '2026-01-01T12:00:00Z' }
        ) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $script:CataloguePath -Encoding utf8
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'emits one typed object per catalogue entry' {
        $rows = & $script:ConvertPs1 -Path $script:CataloguePath
        $rows.Count | Should -Be 2
        foreach ($row in $rows) {
            $row.PSObject.TypeNames | Should -Contain 'IntelliSDLC.HarCapture.CatalogueEntry'
        }
    }

    It 'carries every documented property' {
        $row = (& $script:ConvertPs1 -Path $script:CataloguePath)[0]
        foreach ($name in @('Action', 'Description', 'Methods', 'Endpoints',
                            'EntryCount', 'Status', 'HarFile', 'CapturedUtc')) {
            $row.PSObject.Properties.Name | Should -Contain $name
        }
    }

    It 'survives ConvertTo-Json as pure data, with no status text in the pipeline' {
        # Per powershell.instructions.md -> Output & Streams: status goes to
        # Write-Information so the pipeline carries objects and nothing else.
        $json = & $script:ConvertPs1 -Path $script:CataloguePath | ConvertTo-Json -Depth 4
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.Count | Should -Be 2
        $parsed[0].Action | Should -Be 'composer-story-create'
    }

    It 'survives ConvertTo-Csv' {
        $csv = & $script:ConvertPs1 -Path $script:CataloguePath | ConvertTo-Csv -NoTypeInformation
        $csv[0] | Should -Match 'Action'
    }

    It 'filters on Status, so Observed rows are addressable' {
        $observed = & $script:ConvertPs1 -Path $script:CataloguePath | Where-Object Status -eq 'Observed'
        $observed.Count | Should -Be 1
        $observed.Action | Should -Be 'get-v1-notifications'
    }

    It 'renders through PowerShell formatting rather than hand-rolled text' {
        $formatXml = Join-Path $script:CaptureDir 'HarCapture.Format.ps1xml'
        Test-Path -LiteralPath $formatXml | Should -BeTrue
        [xml]$doc = Get-Content -LiteralPath $formatXml -Raw
        $doc.Configuration.ViewDefinitions.View.ViewSelectedBy.TypeName |
            Should -Contain 'IntelliSDLC.HarCapture.CatalogueEntry'
    }
}

Describe 'The catalogue phase is never silently dropped' {

    It 'ships the prompt as a file, so the shell-out and an agent read the same thing' {
        Test-Path -LiteralPath $script:PromptMd | Should -BeTrue
        $text = Get-Content -LiteralPath $script:PromptMd -Raw
        $text | Should -Match 'digest\.json'
        $text | Should -Match 'extract-har-reference\.js'
        $text | Should -Match 'verify-har-reference\.js'
        $text | Should -Match '(?i)Observed, not exercised'
    }

    It 'SKILL.md points an agent at that same prompt' {
        $skill = Get-Content -LiteralPath $script:SkillMd -Raw
        $skill | Should -Match 'catalogue-prompt\.md'
    }
}

Describe 'Stop-HarRecording.ps1' {

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:StopPs1 | Should -BeTrue
    }

    It 'documents itself as the automation path' {
        (Get-Content -LiteralPath $script:StopPs1 -Raw) | Should -Match 'AI driving the session|automation'
    }

    It 'says it waits for post-processing' {
        # Reporting a capture as done while the scrub is still running names
        # files that do not exist yet.
        (Get-Content -LiteralPath $script:StopPs1 -Raw) | Should -Match '(?i)post-process'
    }

    It 'no longer tells the reader that closing the window loses the capture' {
        # Both recorders now run and exactly one survives, so a window close
        # yields a full HAR. The old warning is false.
        #
        # \s+ between words, not literal spaces: the sentence wraps across
        # lines in the docstring, so a literal-space pattern silently never
        # matches and the guard is dead.
        $stop = Get-Content -LiteralPath $script:StopPs1 -Raw
        $stop | Should -Not -Match '(?i)no\s+HAR\s+is\s+written\s+at\s+all'
    }
}

Describe 'The repository no longer references the deleted command' {

    It 'has zero references to Start-HarRecording outside git history' {
        # 19 across 9 files at the time of writing (issue #281). A stale
        # reference sends a reader to a command that does not exist.
        Push-Location $script:RepoRoot
        try {
            # Excluded: docs/designs holds historical plans, and this file
            # necessarily names the command it asserts is gone.
            $hits = & git grep -n -I 'Start-HarRecording' -- . `
                ':!docs/designs/*' ':!.github/agents/tests/har-recording.Tests.ps1' 2>$null
        }
        finally { Pop-Location }
        $hits | Should -BeNullOrEmpty -Because ($hits -join "`n")
    }

    It 'SKILL.md documents the one-command capture' {
        $skill = Get-Content -LiteralPath $script:SkillMd -Raw
        $skill | Should -Match 'Invoke-HarCapture'
        $skill | Should -Match '(?i)catalogue'
    }
}
