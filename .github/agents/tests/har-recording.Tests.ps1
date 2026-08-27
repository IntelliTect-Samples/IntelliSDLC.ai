#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the HAR session recorder (issue #270): capture-har.js and
# its two PowerShell front doors.
#
# None of these launch a browser. The recorder's browser handling is verified
# by hand against a real site; what is pinned here is everything a regression
# could silently break -- argument contracts, the failure reporting that stops
# an empty capture being analyzed as data, and the snapshot recovery that makes
# an unexpected ending survivable.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/api-wrapper-scaffold/scripts'
    $script:CaptureJs  = Join-Path $script:ScriptsDir 'capture-har.js'
    $script:StartPs1   = Join-Path $script:ScriptsDir 'Start-HarRecording.ps1'
    $script:StopPs1    = Join-Path $script:ScriptsDir 'Stop-HarRecording.ps1'

    function Invoke-CaptureHar {
        param([Parameter(ValueFromRemainingArguments)][string[]]$CaptureArgs)
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
        }
        [pscustomobject]@{
            StdOut   = $out
            StdErr   = $err
            Output   = "$out$err"
            ExitCode = $code
        }
    }

    # A session directory as it looks after the driver was lost: a snapshot log
    # with entries, a session.json, and no raw.har.
    function New-LostSession {
        param([Parameter(Mandatory)][string]$Root, [int]$Entries = 2)
        $sessionDir = Join-Path $Root '2026-01-01-120000'
        New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null
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
        Set-Content -LiteralPath (Join-Path $sessionDir 'raw.snapshot.ndjson') -Value $lines -Encoding utf8
        @{
            uri             = 'https://example.com'
            sessionDir      = $sessionDir
            harPath         = Join-Path $sessionDir 'raw.har'
            snapshotLog     = Join-Path $sessionDir 'raw.snapshot.ndjson'
            snapshotHarPath = Join-Path $sessionDir 'raw.snapshot.har'
            startedUtc      = '2026-01-01T12:00:00Z'
            endedUtc        = '2026-01-01T12:05:00Z'
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $sessionDir 'session.json') -Encoding utf8
        return $sessionDir
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
        $r = Invoke-CaptureHar start --uri 'https://example.com' --dir $script:Tmp --validate-only
        $r.ExitCode | Should -Be 0
        $r.Output | Should -Match 'no browser launched'
        $r.Output | Should -Match 'cdpEndpoint'
    }

    It 'rejects a start with no URI' {
        $r = Invoke-CaptureHar start --dir $script:Tmp
        $r.ExitCode | Should -Be 2
    }

    It 'fails when the storage state file does not exist' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' --dir $script:Tmp `
            --storage-state (Join-Path $script:Tmp 'nope.json')
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'storage-state file not found'
    }

    It 'reports that there is nothing to stop rather than inventing a session' {
        $r = Invoke-CaptureHar stop --dir $script:Tmp
        $r.ExitCode | Should -Be 3
        $r.Output | Should -Match 'no capture session found'
    }

    It 'never kills a browser process' {
        # Killing a browser discards the recording AND can destroy unrelated
        # signed-in windows on the developer's machine.
        $source = Get-Content -LiteralPath $script:CaptureJs -Raw
        $source | Should -Not -Match 'process\.kill|taskkill|SIGKILL|\bkill\('
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
        $r = Invoke-CaptureHar start --uri 'https://example.com' --dir $script:Tmp `
            --profile 'work' --validate-only
        $r.ExitCode | Should -Be 0
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Match 'har-capture[\\/]profile-work$'
    }

    It 'folds an awkward name to a safe directory name' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' --dir $script:Tmp `
            --profile 'My Account!' --validate-only
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Match 'profile-my-account-$'
    }

    It 'records into a path another tool owns, verbatim' {
        # The integration point for a project that keys profiles off its own
        # concept: it computes the directory, we record as that identity.
        $external = Join-Path $script:Tmp 'someapp/profile-alias-1a2b3c4d'
        $r = Invoke-CaptureHar start --uri 'https://example.com' --dir $script:Tmp `
            --profile $external --validate-only
        $r.ExitCode | Should -Be 0
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Be ([IO.Path]::GetFullPath($external))
    }

    It 'defaults to the shared capture profile when none is named' {
        $r = Invoke-CaptureHar start --uri 'https://example.com' --dir $script:Tmp --validate-only
        ($r.StdOut | ConvertFrom-Json).profileDir | Should -Match 'har-capture[\\/]profile$'
    }
}

Describe 'capture-har.js snapshot recovery' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("har-rec-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'recovers a HAR from the snapshot when the driver was lost' {
        $sessionDir = New-LostSession -Root $script:Tmp -Entries 3
        $r = Invoke-CaptureHar stop --session $sessionDir

        # Exit 5 == "only the recovery snapshot survives": distinct from 0 so a
        # caller cannot mistake a degraded artifact for a clean capture.
        $r.ExitCode | Should -Be 5
        $snapshotHar = Join-Path $sessionDir 'raw.snapshot.har'
        Test-Path -LiteralPath $snapshotHar | Should -BeTrue

        $har = Get-Content -LiteralPath $snapshotHar -Raw | ConvertFrom-Json
        $har.log.version | Should -Be '1.2'
        $har.log.entries.Count | Should -Be 3
        $har.log.entries[0].request.url | Should -Match 'example\.com'
    }

    It 'labels the recovered file as a recovery artifact, not a capture' {
        $sessionDir = New-LostSession -Root $script:Tmp
        Invoke-CaptureHar stop --session $sessionDir | Out-Null
        $har = Get-Content -LiteralPath (Join-Path $sessionDir 'raw.snapshot.har') -Raw | ConvertFrom-Json
        $har.log.comment | Should -Match 'RECOVERY ARTIFACT'
        $har.log.creator.name | Should -Match 'snapshot'
    }

    It 'salvages the rest when the final snapshot line was truncated' {
        # An abrupt ending mid-write leaves a partial line. Losing the whole
        # recovery to one bad line would defeat the artifact's purpose.
        $sessionDir = New-LostSession -Root $script:Tmp -Entries 2
        $log = Join-Path $sessionDir 'raw.snapshot.ndjson'
        Add-Content -LiteralPath $log -Value '{"startedDateTime":"2026-01-01T12:00:09Z","req' -Encoding utf8

        $r = Invoke-CaptureHar stop --session $sessionDir
        $r.ExitCode | Should -Be 5
        $har = Get-Content -LiteralPath (Join-Path $sessionDir 'raw.snapshot.har') -Raw | ConvertFrom-Json
        $har.log.entries.Count | Should -Be 2
        $har.log.comment | Should -Match 'truncated'
    }

    It 'reports a failure when neither a HAR nor a snapshot exists' {
        $sessionDir = New-LostSession -Root $script:Tmp
        Remove-Item -LiteralPath (Join-Path $sessionDir 'raw.snapshot.ndjson') -Force

        $r = Invoke-CaptureHar stop --session $sessionDir
        $r.ExitCode | Should -Be 4
        $r.Output | Should -Match 'lost entirely'
    }

    It 'treats a trivially small capture as failed rather than as data' {
        $sessionDir = New-LostSession -Root $script:Tmp
        Set-Content -LiteralPath (Join-Path $sessionDir 'raw.har') -Value '{}' -Encoding utf8

        $r = Invoke-CaptureHar stop --session $sessionDir --min-bytes 1024
        $r.ExitCode | Should -Be 4
        $r.Output | Should -Match 'failed capture'
    }
}

Describe 'Start-HarRecording.ps1 / Stop-HarRecording.ps1' {

    BeforeEach {
        $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("har-rec-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
    }

    AfterEach {
        if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
            Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'both exist at the canonical path' {
        Test-Path -LiteralPath $script:StartPs1 | Should -BeTrue
        Test-Path -LiteralPath $script:StopPs1 | Should -BeTrue
    }

    It 'parse without syntax errors' {
        foreach ($f in @($script:StartPs1, $script:StopPs1)) {
            $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errors)
            $errors | Should -BeNullOrEmpty
        }
    }

    It 'takes the URI positionally, so the parameter name is optional' {
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:StartPs1, [ref]$null, [ref]$errors)
        $uri = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Uri' }
        $uri | Should -Not -BeNullOrEmpty
        $attr = $uri.Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' }
        ($attr.NamedArguments | Where-Object { $_.ArgumentName -eq 'Position' }) | Should -Not -BeNullOrEmpty
    }

    It 'passes -ValidateOnly through without launching a browser' {
        & $script:StartPs1 'https://example.com' -ValidateOnly -CapturesDirectory $script:Tmp | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'tells the operator to press ENTER, not to close the window' {
        # Closing the window is the one ending that cannot write a HAR.
        $start = Get-Content -LiteralPath $script:StartPs1 -Raw
        $start | Should -Match 'ENTER'
        $start | Should -Not -Match 'CLOSE THE BROWSER WINDOW'
    }

    It 'documents Stop as the automation path' {
        (Get-Content -LiteralPath $script:StopPs1 -Raw) | Should -Match 'AI driving the session|automation'
    }
}
