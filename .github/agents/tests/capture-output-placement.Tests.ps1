#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the capture output-placement guard (issue #300).
#
# Two jobs:
#
#  1. Delegate to the zero-dep Node suite. The wrapper is not ceremony -- CI
#     runs Pester over ./.github only, so a node test file reaches the pipeline
#     solely by being shelled out to from here. Without this file the node tests
#     pass locally and never run on a PR.
#
#  2. Pin the PowerShell guard against the Node guard over ONE table of
#     repository shapes. There are two implementations because there are two
#     runtimes, and two implementations of one rule is exactly how the original
#     defect got in. Asserting they agree is what stops them drifting apart
#     silently -- the same technique already used for Get-HarUriFolder against
#     uriFolder().
#
# The fixtures are REAL git repositories, never stubs. The whole subject under
# test is what git actually reports about a checkout, so a stub would pin our
# belief about git's output instead of git's output.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:GuardPs1   = Join-Path $script:ScriptsDir 'lib/RepoWorkflowGuard.ps1'
    $script:GuardJs    = Join-Path $script:ScriptsDir 'lib/repo-workflow-guard.js'
    $script:TestJs     = Join-Path $script:ScriptsDir 'lib/repo-workflow-guard.test.js'

    . $script:GuardPs1

    # GetTempPath is frequently the 8.3 short form on Windows (MARKMI~1) while
    # git always reports the long one. Normalising here keeps every path
    # comparison below about the code under test rather than about 8.3 names.
    $script:Tmp = (Get-Item -LiteralPath (
            New-Item -ItemType Directory -Path (
                Join-Path ([IO.Path]::GetTempPath()) ("placement-" + [guid]::NewGuid().ToString('N'))
            ) | Select-Object -ExpandProperty FullName)).FullName

    function Invoke-Git {
        param([string]$Cwd, [string[]]$Arguments)
        $out = & git -C $Cwd @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $out" }
        return $out
    }

    # A bare origin plus a clone of it. The clone is what produces a real
    # refs/remotes/origin/HEAD; setting one by hand would assert the fixture
    # rather than the shape git actually creates.
    function New-Checkout {
        param(
            [Parameter(Mandatory)][string]$Name,
            [switch]$TrackedHooks,
            [string]$HooksPath,
            [string]$DefaultBranch = 'main',
            [string]$Declare
        )

        $seed = Join-Path $script:Tmp "$Name-seed"
        New-Item -ItemType Directory -Path $seed -Force | Out-Null
        Invoke-Git $seed @('init', '--initial-branch', $DefaultBranch) | Out-Null
        Invoke-Git $seed @('config', 'user.email', 't@example.com') | Out-Null
        Invoke-Git $seed @('config', 'user.name', 'Test') | Out-Null
        Set-Content -LiteralPath (Join-Path $seed 'README.md') -Value '# seed'
        if ($TrackedHooks) {
            $hooks = Join-Path $seed '.githooks'
            New-Item -ItemType Directory -Path $hooks -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $hooks 'pre-commit') -Value "#!/bin/sh`nexit 0"
        }
        Invoke-Git $seed @('add', '-A') | Out-Null
        Invoke-Git $seed @('commit', '-m', 'seed') | Out-Null

        $bare = Join-Path $script:Tmp "$Name.git"
        Invoke-Git $script:Tmp @('clone', '--bare', $seed, $bare) | Out-Null
        $work = Join-Path $script:Tmp $Name
        Invoke-Git $script:Tmp @('clone', $bare, $work) | Out-Null
        Invoke-Git $work @('config', 'user.email', 't@example.com') | Out-Null
        Invoke-Git $work @('config', 'user.name', 'Test') | Out-Null
        if ($HooksPath) { Invoke-Git $work @('config', 'core.hooksPath', $HooksPath) | Out-Null }
        if ($PSBoundParameters.ContainsKey('Declare')) {
            Invoke-Git $work @('config', 'sdlc.protectedBranchWorkflow', $Declare) | Out-Null
        }
        return $work
    }

    # A repository with NO REMOTE at all: git init, never cloned, so there is no
    # refs/remotes/origin/HEAD to discover the protected branch from. This is the
    # shape that exercises the trunk-name fallback, and it cannot be reached
    # through New-Checkout -- every clone gets a real origin/HEAD.
    function New-RemotelessCheckout {
        param(
            [Parameter(Mandatory)][string]$Name,
            [switch]$TrackedHooks,
            [string]$HooksPath,
            [string]$Branch = 'main'
        )

        $work = Join-Path $script:Tmp $Name
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        Invoke-Git $work @('init', '--initial-branch', $Branch) | Out-Null
        Invoke-Git $work @('config', 'user.email', 't@example.com') | Out-Null
        Invoke-Git $work @('config', 'user.name', 'Test') | Out-Null
        if ($TrackedHooks) {
            $hooks = Join-Path $work '.githooks'
            New-Item -ItemType Directory -Path $hooks -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $hooks 'pre-commit') -Value "#!/bin/sh`nexit 0"
        }
        Set-Content -LiteralPath (Join-Path $work 'README.md') -Value '# seed'
        Invoke-Git $work @('add', '-A') | Out-Null
        Invoke-Git $work @('commit', '-m', 'seed') | Out-Null
        if ($HooksPath) { Invoke-Git $work @('config', 'core.hooksPath', $HooksPath) | Out-Null }
        return $work
    }

    $script:CheckSh = Join-Path $script:RepoRoot '.githooks/check-dirty-primary-checkout'

    # bash is not on PATH in a Windows PowerShell session, but Git for Windows
    # always ships one beside git itself -- and a machine running these tests has
    # git by definition. Resolving it from git's own location keeps the suite
    # from depending on the operator having put bash on PATH.
    $script:Bash = (Get-Command bash -ErrorAction SilentlyContinue)?.Source
    if (-not $script:Bash) {
        $gitExe = (Get-Command git -ErrorAction Stop).Source
        $candidate = Join-Path (Split-Path (Split-Path $gitExe)) 'bin/bash.exe'
        if (Test-Path -LiteralPath $candidate) { $script:Bash = $candidate }
    }

    # The safety net's verdict, run from $Cwd. Exit 2 means "reported".
    function Invoke-DirtyCheck {
        param([Parameter(Mandatory)][string]$Cwd, [string]$StdIn = '')
        $errFile = Join-Path $script:Tmp ('chk-' + [guid]::NewGuid().ToString('N') + '.txt')
        Push-Location -LiteralPath $Cwd
        try { $out = $StdIn | & $script:Bash $script:CheckSh 2>$errFile }
        finally { Pop-Location }
        $code = $LASTEXITCODE
        $err = if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile -Raw } else { '' }
        [pscustomobject]@{ ExitCode = $code; StdErr = ($err ?? ''); StdOut = $out }
    }

    # The Node guard's verdict for the same directory, so the two can be compared.
    function Get-NodePlacement {
        param([Parameter(Mandatory)][string]$Path)
        $js = "const g=require(process.argv[1]);" +
              "const i=g.inspectCheckout(process.argv[2]);" +
              "process.stdout.write(JSON.stringify(i));"
        $json = & node -e $js $script:GuardJs $Path
        return $json | ConvertFrom-Json
    }
}

AfterAll {
    if ($script:Tmp -and (Test-Path -LiteralPath $script:Tmp)) {
        # Worktrees hold handles; best effort is enough for a temp directory.
        Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'the Node guard suite (issue #300)' {
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
        ($out -join "`n") | Should -Match 'All repo-workflow-guard tests passed'
    }
}

Describe 'Get-CheckoutPlacement -- the three git probes' {
    It 'is inert outside a repository, where the cwd default is already correct' {
        $dir = Join-Path $script:Tmp 'plain'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $info = Get-CheckoutPlacement -Path $dir
        $info.InsideRepo | Should -BeFalse
        $info.TopLevel | Should -BeNullOrEmpty
        $info.ShouldWarn | Should -BeFalse
    }

    It 'warns in the primary checkout on the protected branch when the repo declares the rule' {
        $work = New-Checkout -Name 'ps-declared' -TrackedHooks -HooksPath '.githooks'
        $info = Get-CheckoutPlacement -Path $work
        $info.PrimaryCheckout | Should -BeTrue
        $info.CurrentBranch | Should -Be 'main'
        $info.ProtectedBranch | Should -Be 'main'
        $info.RuleSource | Should -Be 'hooksPath'
        $info.ShouldWarn | Should -BeTrue
    }

    It 'discovers the protected branch from origin/HEAD rather than hardcoding main' {
        $work = New-Checkout -Name 'ps-trunk' -TrackedHooks -HooksPath '.githooks' -DefaultBranch 'trunk'
        $info = Get-CheckoutPlacement -Path $work
        $info.ProtectedBranch | Should -Be 'trunk'
        $info.ShouldWarn | Should -BeTrue
    }

    It 'never warns in a worktree -- the sanctioned place to work' {
        $work = New-Checkout -Name 'ps-wt' -TrackedHooks -HooksPath '.githooks'
        $wt = Join-Path $script:Tmp 'ps-wt-tree'
        Invoke-Git $work @('worktree', 'add', $wt, '-b', 'feat/a') | Out-Null
        $info = Get-CheckoutPlacement -Path $wt
        $info.PrimaryCheckout | Should -BeFalse
        $info.ShouldWarn | Should -BeFalse
    }

    It 'stays quiet in a repo that declares no such rule' {
        $work = New-Checkout -Name 'ps-undeclared'
        $info = Get-CheckoutPlacement -Path $work
        $info.DeclaresRule | Should -BeFalse
        $info.ShouldWarn | Should -BeFalse
    }

    It 'does not accept an untracked hooks directory as the repository speaking' {
        $work = New-Checkout -Name 'ps-untracked' -HooksPath '.localhooks'
        $local = Join-Path $work '.localhooks'
        New-Item -ItemType Directory -Path $local -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $local 'pre-commit') -Value "#!/bin/sh`nexit 0"
        $info = Get-CheckoutPlacement -Path $work
        $info.DeclaresRule | Should -BeFalse
    }

    It 'honours an explicit opt-out over tracked hooks' {
        $work = New-Checkout -Name 'ps-optout' -TrackedHooks -HooksPath '.githooks' -Declare 'false'
        (Get-CheckoutPlacement -Path $work).ShouldWarn | Should -BeFalse
    }
}

Describe 'Get-CheckoutPlacement -- no origin/HEAD to discover' {
    It 'falls back to a conventional trunk rather than giving up' {
        # Disabling the guard when the protected branch cannot be discovered
        # would reopen the defect for every repo without a remote. A spurious
        # warning costs one ignored line; a missed one is the bug.
        $work = New-RemotelessCheckout -Name 'ps-noremote' -TrackedHooks -HooksPath '.githooks'
        $info = Get-CheckoutPlacement -Path $work
        $info.ProtectedBranch | Should -Be 'main'
        $info.ShouldWarn | Should -BeTrue
    }

    It 'does not assume every branch in a remote-less repo is the protected one' {
        $work = New-RemotelessCheckout -Name 'ps-noremote-dev' -TrackedHooks -HooksPath '.githooks' -Branch 'develop'
        $info = Get-CheckoutPlacement -Path $work
        $info.CurrentBranch | Should -Be 'develop'
        $info.ProtectedBranch | Should -Be 'main'
        $info.ShouldWarn | Should -BeFalse
    }
}

Describe 'Get-DefaultOutputRoot -- anchoring, and only the default' {
    It 'is the working directory outside a repository' {
        $dir = Join-Path $script:Tmp 'plain-anchor'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Get-DefaultOutputRoot -Path $dir | Should -Be $dir
    }

    It 'is the repo root, not the cwd, from a subdirectory of a checkout' {
        $work = New-Checkout -Name 'ps-anchor' -TrackedHooks -HooksPath '.githooks'
        $deep = Join-Path $work 'docs/deep'
        New-Item -ItemType Directory -Path $deep -Force | Out-Null
        Get-DefaultOutputRoot -Path $deep | Should -Be $work
    }

    It "anchors to the worktree's own root when inside one" {
        $work = New-Checkout -Name 'ps-anchor-wt' -TrackedHooks -HooksPath '.githooks'
        $wt = Join-Path $script:Tmp 'ps-anchor-wt-tree'
        Invoke-Git $work @('worktree', 'add', $wt, '-b', 'feat/b') | Out-Null
        Get-DefaultOutputRoot -Path $wt | Should -Be $wt
    }
}

Describe 'Assert-NotPrimaryCheckoutOnProtectedBranch -- warn, never hard-fail' {
    It 'proceeds and warns rather than throwing when the guard fires' {
        # The verified trap: $PSCmdlet.ShouldContinue() throws under
        # -NonInteractive, so the naive implementation produces a hard stop with
        # a confusing error instead of an advisory. Pester runs non-interactive,
        # which makes this the exact condition that broke.
        $work = New-Checkout -Name 'ps-warn' -TrackedHooks -HooksPath '.githooks'
        $warnings = @()
        $proceed = Assert-NotPrimaryCheckoutOnProtectedBranch -Path $work -WarningVariable warnings -WarningAction SilentlyContinue
        $proceed | Should -BeTrue
        $warnings.Count | Should -BeGreaterThan 0
    }

    It 'says what it detected, why it matters, the fix, and that it continues' {
        $work = New-Checkout -Name 'ps-message' -TrackedHooks -HooksPath '.githooks'
        $warnings = @()
        Assert-NotPrimaryCheckoutOnProtectedBranch -Path $work -WarningVariable warnings -WarningAction SilentlyContinue | Out-Null
        $text = $warnings -join "`n"
        $text | Should -Match 'main'
        $text | Should -Match 'git worktree add'
        $text | Should -Match 'commits are blocked'
        $text | Should -Match 'Continuing anyway is safe'
    }

    It 'is silent and proceeds when the guard does not fire' {
        $work = New-Checkout -Name 'ps-silent' -TrackedHooks -HooksPath '.githooks'
        Invoke-Git $work @('checkout', '-b', 'feat/c') | Out-Null
        $warnings = @()
        $proceed = Assert-NotPrimaryCheckoutOnProtectedBranch -Path $work -WarningVariable warnings -WarningAction SilentlyContinue
        $proceed | Should -BeTrue
        $warnings.Count | Should -Be 0
    }
}

Describe 'Get-RelocationNotice -- cleanup in one step' {
    It 'names the paths written and a single move command' {
        $work = New-Checkout -Name 'ps-notice' -TrackedHooks -HooksPath '.githooks'
        $info = Get-CheckoutPlacement -Path $work
        $notice = Get-RelocationNotice -Placement $info -WrittenPath @((Join-Path $work 'app.example.com'))
        $notice | Should -Match 'app\.example\.com'
        $notice | Should -Match 'git worktree add'
        $notice | Should -Match '\bmv\b'
    }

    It 'returns nothing when the guard never fired, so callers can emit it unconditionally' {
        $work = New-Checkout -Name 'ps-notice-quiet'
        $info = Get-CheckoutPlacement -Path $work
        Get-RelocationNotice -Placement $info -WrittenPath @((Join-Path $work 'x')) | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-HarCapture -- the front door honours the guard' {
    BeforeAll {
        $script:InvokePs1 = Join-Path $script:ScriptsDir 'capture/Invoke-HarCapture.ps1'

        # A stub `node` on PATH: standing one in front of the real recorder
        # makes "what did the front door do before launching anything"
        # observable without opening a browser.
        #
        # The stub has to be shaped per platform. Windows resolves a bare `node`
        # through PATHEXT to `node.cmd`; Linux and macOS look for a file named
        # exactly `node` with the execute bit set, and separate PATH entries
        # with ':' rather than ';'. A Windows-only stub silently fails to
        # shadow anything on Linux, the REAL recorder runs, and the test fails
        # with "capture-har exited 1" -- which is exactly what happened for as
        # long as this suite never ran on Linux (issue #308).
        # A stub that is written but not executable is worse than no stub: the
        # PATH search silently skips it, the REAL recorder runs, and the test
        # fails with the same "capture-har exited 1" that issue #308 was about,
        # pointing at nothing. Fail loudly at the setup step instead.
        function Assert-StubIsExecutable {
            param([Parameter(Mandatory)][string]$Path)

            if ($LASTEXITCODE -ne 0) {
                throw "chmod +x failed on the stub node (exit $LASTEXITCODE): $Path"
            }
            # UnixMode is the ls -l string, e.g. '-rwxr-xr-x'. Check the OWNER
            # triplet (chars 1-3) specifically: this process runs the stub as
            # the owner, so an x borrowed from the group or other bits would
            # pass a bare -match 'x' while the stub still could not run.
            $mode = (Get-Item -LiteralPath $Path -Force).UnixMode
            if ($mode.Length -lt 4 -or $mode.Substring(1, 3) -notmatch 'x') {
                throw "stub node is not executable by its owner (mode '$mode'): $Path -- " +
                'the real recorder would run instead. Is TMPDIR mounted noexec?'
            }
        }

        function New-NodeStub {
            param(
                [Parameter(Mandatory)][string]$Directory,
                [Parameter(Mandatory)][string]$EnvFile
            )

            if ($IsWindows) {
                Set-Content -LiteralPath (Join-Path $Directory 'node.cmd') -Encoding ascii -Value @(
                    '@echo off'
                    "echo GUARD=%HARCAPTURE_PLACEMENT_GUARD_RAN% > `"$EnvFile`""
                    'exit /b 0'
                )
                return
            }

            $stub = Join-Path $Directory 'node'
            # LF endings and no BOM: the kernel reads the shebang literally, and
            # a CR would make the interpreter path '/bin/sh\r', which does not exist.
            $body = "#!/bin/sh`necho `"GUARD=`$HARCAPTURE_PLACEMENT_GUARD_RAN`" > '$EnvFile'`nexit 0`n"
            [System.IO.File]::WriteAllText($stub, $body, [System.Text.UTF8Encoding]::new($false))
            & chmod +x $stub
            Assert-StubIsExecutable -Path $stub
        }

        function Invoke-FrontDoorIn {
            param([Parameter(Mandatory)][string]$Cwd, [hashtable]$Arguments = @{})

            $stubDir = Join-Path $script:Tmp ('stub-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
            $envFile = Join-Path $stubDir 'env.txt'
            New-NodeStub -Directory $stubDir -EnvFile $envFile

            $infoFile = Join-Path $stubDir 'info.txt'
            $warnFile = Join-Path $stubDir 'warn.txt'
            $savedPath = $env:PATH
            $env:PATH = $stubDir + [System.IO.Path]::PathSeparator + $savedPath
            Push-Location -LiteralPath $Cwd
            try {
                & $script:InvokePs1 @Arguments 6> $infoFile 3> $warnFile 2>$null | Out-Null
            }
            finally {
                Pop-Location
                $env:PATH = $savedPath
                Remove-Item Env:HARCAPTURE_PLACEMENT_GUARD_RAN -ErrorAction SilentlyContinue
            }

            function Read-Stream([string]$Path) {
                $t = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { $null }
                if ($null -eq $t) { '' } else { $t }
            }

            [pscustomobject]@{
                NodeEnv     = (Read-Stream $envFile).Trim()
                Information = (Read-Stream $infoFile).Trim()
                Warning     = (Read-Stream $warnFile).Trim()
                NodeRan     = (Test-Path -LiteralPath $envFile)
            }
        }
    }

    It 'warns and still records -- the advisory never becomes a hard failure' {
        $work = New-Checkout -Name 'fd-warn' -TrackedHooks -HooksPath '.githooks'
        $r = Invoke-FrontDoorIn -Cwd $work -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        $r.Warning | Should -Match 'git worktree add'
        $r.NodeRan | Should -BeTrue -Because 'the recording must proceed; nothing is discarded'
    }

    It 'tells the recorder the guard already ran, so the operator is warned once' {
        $work = New-Checkout -Name 'fd-once' -TrackedHooks -HooksPath '.githooks'
        $r = Invoke-FrontDoorIn -Cwd $work -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        $r.NodeEnv | Should -Match 'GUARD=1'
    }

    It 'stays silent in a worktree' {
        $work = New-Checkout -Name 'fd-quiet' -TrackedHooks -HooksPath '.githooks'
        $wt = Join-Path $script:Tmp 'fd-quiet-tree'
        Invoke-Git $work @('worktree', 'add', $wt, '-b', 'feat/fd') | Out-Null
        $r = Invoke-FrontDoorIn -Cwd $wt -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        $r.Warning | Should -Not -Match 'git worktree add'
        $r.NodeRan | Should -BeTrue
    }

    It 'reads the catalogue from the repo root by default, not the cwd (#300)' {
        # The front door computes the catalogue path itself rather than shelling
        # out to node for it, so anchoring has to be applied in both places or
        # the script looks for a catalogue where the recorder did not write one.
        $work = New-Checkout -Name 'fd-anchor' -TrackedHooks -HooksPath '.githooks'
        $deep = Join-Path $work 'docs'
        New-Item -ItemType Directory -Path $deep -Force | Out-Null
        $r = Invoke-FrontDoorIn -Cwd $deep -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        # No catalogue exists, so the front door reports where it looked --
        # which is the observable proof of which root it anchored to.
        $r.Warning | Should -Match ([regex]::Escape((Join-Path $work 'app.example.com')))
    }
}

Describe 'check-dirty-primary-checkout -- the session-level safety net' {
    It 'reports a dirty primary checkout on the protected branch' {
        $work = New-Checkout -Name 'net-dirty' -TrackedHooks -HooksPath '.githooks'
        # An untracked output directory: exactly what the incident produced.
        New-Item -ItemType Directory -Path (Join-Path $work 'www.example.com') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $work 'www.example.com/catalogue.json') -Value '{}'

        $r = Invoke-DirtyCheck -Cwd $work

        $r.ExitCode | Should -Be 2 -Because 'exit 2 is what feeds the message back to the agent'
        $r.StdErr | Should -Match 'www\.example\.com'
        $r.StdErr | Should -Match 'git worktree add'
    }

    It 'is silent when the primary checkout is clean' {
        $work = New-Checkout -Name 'net-clean' -TrackedHooks -HooksPath '.githooks'
        $r = Invoke-DirtyCheck -Cwd $work
        $r.ExitCode | Should -Be 0
    }

    It 'ignores a dirty worktree -- the sanctioned place to work' {
        $work = New-Checkout -Name 'net-wt' -TrackedHooks -HooksPath '.githooks'
        $wt = Join-Path $script:Tmp 'net-wt-tree'
        Invoke-Git $work @('worktree', 'add', $wt, '-b', 'feat/net') | Out-Null
        Set-Content -LiteralPath (Join-Path $wt 'stray.txt') -Value 'x'
        $r = Invoke-DirtyCheck -Cwd $wt
        $r.ExitCode | Should -Be 0
    }

    It 'ignores a repo that declares no such rule' {
        $work = New-Checkout -Name 'net-undeclared'
        Set-Content -LiteralPath (Join-Path $work 'stray.txt') -Value 'x'
        $r = Invoke-DirtyCheck -Cwd $work
        $r.ExitCode | Should -Be 0
    }

    It 'does not block twice -- stop_hook_active ends the loop' {
        # A Stop hook that keeps blocking on a condition the agent cannot always
        # clear is an infinite loop, so the second pass has to stand down.
        $work = New-Checkout -Name 'net-loop' -TrackedHooks -HooksPath '.githooks'
        Set-Content -LiteralPath (Join-Path $work 'stray.txt') -Value 'x'
        $r = Invoke-DirtyCheck -Cwd $work -StdIn '{"stop_hook_active":true}'
        $r.ExitCode | Should -Be 0
    }

    It 'is wired as a Stop hook in this repository' {
        $settings = Get-Content -LiteralPath (Join-Path $script:RepoRoot '.claude/settings.json') -Raw |
            ConvertFrom-Json
        $commands = $settings.hooks.Stop.hooks.command
        ($commands -join ' ') | Should -Match 'check-dirty-primary-checkout'
    }
}

Describe 'the guards agree -- one rule, three runtimes' {
    # Reimplementing one rule per runtime is how the original defect got in.
    # There are three implementations here because there are three runtimes --
    # Node for the recorder, PowerShell for the front doors, bash for the
    # harness-level net -- and this is the table that stops them drifting: every
    # shape that matters, all three, same verdict.
    It 'reaches the same verdict for <Name>' -ForEach @(
        @{ Name = 'primary checkout on the protected branch'; Setup = 'declared' }
        @{ Name = 'a feature branch in the primary checkout'; Setup = 'feature' }
        @{ Name = 'a worktree';                               Setup = 'worktree' }
        @{ Name = 'a repo declaring no rule';                 Setup = 'undeclared' }
        @{ Name = 'a non-default trunk name';                 Setup = 'trunk' }
        @{ Name = 'an explicit opt-out';                      Setup = 'optout' }
        @{ Name = 'somewhere outside a repository';           Setup = 'plain' }
        @{ Name = 'a remote-less repo on a conventional trunk'; Setup = 'noremote' }
        @{ Name = 'a remote-less repo on an unusual branch';  Setup = 'noremote-dev' }
    ) {
        $target = switch ($Setup) {
            'declared' { New-Checkout -Name "cmp-$Setup" -TrackedHooks -HooksPath '.githooks' }
            'feature' {
                $w = New-Checkout -Name "cmp-$Setup" -TrackedHooks -HooksPath '.githooks'
                Invoke-Git $w @('checkout', '-b', 'feat/cmp') | Out-Null
                $w
            }
            'worktree' {
                $w = New-Checkout -Name "cmp-$Setup" -TrackedHooks -HooksPath '.githooks'
                $t = Join-Path $script:Tmp "cmp-$Setup-tree"
                Invoke-Git $w @('worktree', 'add', $t, '-b', 'feat/cmp2') | Out-Null
                $t
            }
            'undeclared' { New-Checkout -Name "cmp-$Setup" }
            'trunk' { New-Checkout -Name "cmp-$Setup" -TrackedHooks -HooksPath '.githooks' -DefaultBranch 'trunk' }
            'optout' { New-Checkout -Name "cmp-$Setup" -TrackedHooks -HooksPath '.githooks' -Declare 'false' }
            'plain' {
                $d = Join-Path $script:Tmp "cmp-$Setup"
                New-Item -ItemType Directory -Path $d -Force | Out-Null
                $d
            }
            'noremote' { New-RemotelessCheckout -Name "cmp-$Setup" -TrackedHooks -HooksPath '.githooks' }
            'noremote-dev' {
                New-RemotelessCheckout -Name "cmp-$Setup" -TrackedHooks -HooksPath '.githooks' -Branch 'develop'
            }
        }

        $ps = Get-CheckoutPlacement -Path $target
        $js = Get-NodePlacement -Path $target

        $ps.InsideRepo      | Should -Be $js.insideRepo      -Because 'insideRepo must agree'
        $ps.PrimaryCheckout | Should -Be $js.primaryCheckout -Because 'primaryCheckout must agree'
        $ps.ProtectedBranch | Should -Be $js.protectedBranch -Because 'protectedBranch must agree'
        $ps.DeclaresRule    | Should -Be $js.declaresRule    -Because 'declaresRule must agree'
        $ps.RuleSource      | Should -Be $js.ruleSource      -Because 'ruleSource must agree'
        $ps.ShouldWarn      | Should -Be $js.shouldWarn      -Because 'the verdict must agree'

        # The bash net answers a narrower question -- "is this checkout dirty
        # AND in the state the guards warn about" -- so dirtying the target
        # first is what makes the two comparable. With the tree dirty, it must
        # report exactly when the guards would have warned.
        Set-Content -LiteralPath (Join-Path $target 'stray-output.txt') -Value 'x'
        $net = Invoke-DirtyCheck -Cwd $target
        ($net.ExitCode -eq 2) | Should -Be $ps.ShouldWarn -Because 'the safety net must agree too'
    }
}
