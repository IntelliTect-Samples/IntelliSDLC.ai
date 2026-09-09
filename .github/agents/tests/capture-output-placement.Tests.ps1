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
    # The destination half of the guard (#471), asked of the Node side so the
    # table below can pin it against the PowerShell one. Run WITH the checkout
    # as cwd, because classifyDestination asks git from where it is standing.
    function Get-NodeStranding {
        param([Parameter(Mandatory)][string]$Cwd, [Parameter(Mandatory)][string]$Destination)
        $js = "const g=require(process.argv[1]);" +
              "const p=g.strandingPlacement(process.argv[2]);" +
              "process.stdout.write(JSON.stringify({warns: !!p}));"
        Push-Location -LiteralPath $Cwd
        try { $json = & node -e $js $script:GuardJs $Destination }
        finally { Pop-Location }
        return $json | ConvertFrom-Json
    }

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

    It 'does not warn about the default destination, which cannot strand (#471)' {
        # It used to warn here, and that was right while the default output was
        # the work tree root. Since #377 the default is the gitignored session
        # directory, so this run leaves nothing behind and the warning was
        # telling the operator something untrue -- which is how they learned to
        # answer yes and go on capturing from the protected branch.
        $work = New-Checkout -Name 'fd-warn' -TrackedHooks -HooksPath '.githooks'
        $r = Invoke-FrontDoorIn -Cwd $work -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        $r.Warning | Should -Not -Match 'git worktree add'
        $r.NodeRan | Should -BeTrue -Because 'the recording must proceed; nothing is discarded'
    }

    It 'leaves the placement call to the recorder, which resolved the destination (#471)' {
        # The handshake env var is gone with the front door's copy of the check.
        # Two owners meant two answers free to disagree; the one that can see
        # the resolved --output-path is the one that keeps the decision.
        $work = New-Checkout -Name 'fd-once' -TrackedHooks -HooksPath '.githooks'
        $r = Invoke-FrontDoorIn -Cwd $work -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        $r.NodeEnv | Should -Not -Match 'GUARD=1'
    }

    It 'stays silent in a worktree' {
        $work = New-Checkout -Name 'fd-quiet' -TrackedHooks -HooksPath '.githooks'
        $wt = Join-Path $script:Tmp 'fd-quiet-tree'
        Invoke-Git $work @('worktree', 'add', $wt, '-b', 'feat/fd') | Out-Null
        $r = Invoke-FrontDoorIn -Cwd $wt -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        $r.Warning | Should -Not -Match 'git worktree add'
        $r.NodeRan | Should -BeTrue
    }

    It 'takes the catalogue from the recorder rather than an anchoring rule (#377)' {
        # It USED TO rebuild the path by applying the same anchoring rule as the
        # recorder -- the repo root plus the host folder. #377 moved the default
        # output into the run's own STAMPED session directory, which this script
        # cannot compute, and globbing .har-captures/ for the newest session is
        # what this file's own comment refuses: a concurrent capture against
        # another site finishing first would hand this run somebody else's
        # catalogue.
        #
        # So the recorder reports its own paths on stdout. The stub recorder
        # here reports nothing, and the observable proof that the anchoring rule
        # is gone is that the front door names no invented path at all.
        $work = New-Checkout -Name 'fd-anchor' -TrackedHooks -HooksPath '.githooks'
        $deep = Join-Path $work 'docs'
        New-Item -ItemType Directory -Path $deep -Force | Out-Null
        $r = Invoke-FrontDoorIn -Cwd $deep -Arguments @{ Uri = 'https://app.example.com'; Describe = 'pester fixture' }
        $r.Warning | Should -Match 'reported no catalogue'
        $r.Warning | Should -Not -Match ([regex]::Escape((Join-Path $work 'app.example.com')))
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

Describe 'the destination question -- will THIS write strand anything (#471)' {
    It 'reports a path that is not gitignored as committable' {
        $work = New-Checkout -Name 'dest-plain' -TrackedHooks -HooksPath '.githooks'
        Get-DestinationIgnoreStatus -Destination (Join-Path $work 'docs/x.har') |
            Should -Be 'not-ignored'
    }

    It 'reports a gitignored path as ignored, even before it exists' {
        # The guard runs BEFORE the write, so the path it asks about is by
        # definition one that is not there yet. Answering from the nearest
        # existing ancestor is what makes a pre-write guard possible at all.
        $work = New-Checkout -Name 'dest-ign' -TrackedHooks -HooksPath '.githooks'
        Set-Content -LiteralPath (Join-Path $work '.gitignore') -Value 'scratch/'
        Get-DestinationIgnoreStatus -Destination (Join-Path $work 'scratch/deep/x.har') |
            Should -Be 'ignored'
    }

    It 'reports a path outside any work tree as such' {
        $plain = Join-Path $script:Tmp 'dest-outside'
        New-Item -ItemType Directory -Path $plain -Force | Out-Null
        Get-DestinationIgnoreStatus -Destination (Join-Path $plain 'x.har') |
            Should -Be 'outside-work-tree'
    }

    It 'warns only when BOTH halves hold -- on the protected branch AND committable' {
        $work = New-Checkout -Name 'strand-both' -TrackedHooks -HooksPath '.githooks'
        Get-StrandingPlacement -Destination (Join-Path $work 'docs/x.har') -Path $work |
            Should -Not -BeNullOrEmpty
    }

    It 'stays silent for a gitignored destination on the protected branch' {
        # The regression #471 is named for, in its general form: being on the
        # protected branch is not by itself evidence that this run will leave
        # anything behind.
        $work = New-Checkout -Name 'strand-ign' -TrackedHooks -HooksPath '.githooks'
        Set-Content -LiteralPath (Join-Path $work '.gitignore') -Value 'scratch/'
        Get-StrandingPlacement -Destination (Join-Path $work 'scratch/x.har') -Path $work |
            Should -BeNullOrEmpty
    }

    It 'stays silent in a worktree, committable destination or not' {
        $work = New-Checkout -Name 'strand-wt' -TrackedHooks -HooksPath '.githooks'
        $wt = Join-Path $script:Tmp 'strand-wt-tree'
        Invoke-Git $work @('worktree', 'add', $wt, '-b', 'feat/strand') | Out-Null
        Get-StrandingPlacement -Destination (Join-Path $wt 'docs/x.har') -Path $wt |
            Should -BeNullOrEmpty
    }

    It 'hands over the worktree command AND the retargeted re-run, both filled in' {
        # A pre-write guard cannot end in `mv`; the actionable fix is the pair.
        # A command the operator has to reconstruct from prose is one they skip,
        # which is how #471 was reported in the first place.
        $work = New-Checkout -Name 'strand-msg' -TrackedHooks -HooksPath '.githooks'
        $placement = Get-CheckoutPlacement -Path $work
        $notice = Get-StrandingNotice -Placement $placement -Destination 'docs/x.har' `
            -ReRunCommand 'node extract.js --out .worktrees/<name>/docs/x.har' `
            -WorktreeName 'har-reference'

        $notice | Should -Match 'git worktree add \.worktrees/har-reference'
        $notice | Should -Match 'extract\.js'
        $notice | Should -Match 'Continuing anyway is safe'
    }

    It 'warns and proceeds non-interactively -- an agent is never prompted' {
        $work = New-Checkout -Name 'strand-agent' -TrackedHooks -HooksPath '.githooks'
        $dest = Join-Path $work 'docs/x.har'
        $warned = @()
        $r = Assert-DestinationCommittable -Destination $dest -Path $work `
            -ReRunCommand 'node extract.js' -WarningVariable warned
        $r.Proceed | Should -BeTrue
        $r.Destination | Should -Be $dest -Because 'nothing is silently relocated without consent'
        $r.Relocated | Should -BeFalse
        ($warned -join ' ') | Should -Match 'git worktree add'
    }

    It 'is silent and returns the destination untouched when there is nothing to say' {
        $work = New-Checkout -Name 'strand-quiet' -TrackedHooks -HooksPath '.githooks'
        Set-Content -LiteralPath (Join-Path $work '.gitignore') -Value 'scratch/'
        $dest = Join-Path $work 'scratch/x.har'
        $warned = @()
        $r = Assert-DestinationCommittable -Destination $dest -Path $work -WarningVariable warned
        $r.Proceed | Should -BeTrue
        $r.Destination | Should -Be $dest
        ($warned -join ' ') | Should -Not -Match 'git worktree add'
    }
}

Describe 'New-GuardWorktree -- the offer that does the work for you (#471)' {
    It 'creates the worktree off the protected branch and retargets into it' {
        # The whole point of offering: a guard that only prints a command still
        # leaves the operator to run it, and the reported behaviour was not
        # running it. Accepting has to end with the output actually going
        # somewhere committable.
        $work = New-Checkout -Name 'wt-make' -TrackedHooks -HooksPath '.githooks'
        $placement = Get-CheckoutPlacement -Path $work
        $r = New-GuardWorktree -Placement $placement -Name 'har-reference' `
            -Destination (Join-Path $work 'docs/x.har')

        $r.Relocated | Should -BeTrue
        $r.Destination | Should -Match 'har-reference'
        Join-Path $work '.worktrees/har-reference' | Should -Exist
        (Invoke-Git $work @('worktree', 'list')) -join ' ' | Should -Match 'chore/har-reference'
    }

    It 'reports and declines rather than throwing when the name is taken' {
        # Advisory to the end. A step that would have run without the offer must
        # still run when the offer cannot be honoured -- returning $null is how
        # the caller learns to fall back to the original destination.
        $work = New-Checkout -Name 'wt-taken' -TrackedHooks -HooksPath '.githooks'
        New-Item -ItemType Directory -Path (Join-Path $work '.worktrees/taken') -Force | Out-Null
        $placement = Get-CheckoutPlacement -Path $work
        $warned = @()
        $r = New-GuardWorktree -Placement $placement -Name 'taken' `
            -Destination (Join-Path $work 'docs/x.har') -WarningVariable warned

        $r | Should -BeNullOrEmpty
        ($warned -join ' ') | Should -Match 'already exists'
    }

    It 'keeps a destination outside the checkout where the operator put it' {
        # Re-rooting a path that was never relative to this work tree would move
        # the output somewhere nobody asked for.
        $work = New-Checkout -Name 'wt-outside' -TrackedHooks -HooksPath '.githooks'
        $elsewhere = Join-Path $script:Tmp 'wt-outside-elsewhere'
        New-Item -ItemType Directory -Path $elsewhere -Force | Out-Null
        $dest = Join-Path $elsewhere 'x.har'
        $placement = Get-CheckoutPlacement -Path $work
        $r = New-GuardWorktree -Placement $placement -Name 'outside' -Destination $dest -WarningAction SilentlyContinue

        $r.Relocated | Should -BeFalse
        $r.Destination | Should -Be $dest
    }
}

Describe 'the destination guards agree -- one rule, two runtimes (#471)' {
    It 'reaches the same verdict for <Name>' -ForEach @(
        @{ Name = 'a committable path on the protected branch'; Setup = 'committable' }
        @{ Name = 'a gitignored path on the protected branch';  Setup = 'ignored' }
        @{ Name = 'a committable path in a worktree';           Setup = 'worktree' }
        @{ Name = 'a path outside any work tree';               Setup = 'outside' }
    ) {
        $ctx = switch ($Setup) {
            'committable' {
                $w = New-Checkout -Name "dcmp-$Setup" -TrackedHooks -HooksPath '.githooks'
                @{ Cwd = $w; Dest = (Join-Path $w 'docs/x.har') }
            }
            'ignored' {
                $w = New-Checkout -Name "dcmp-$Setup" -TrackedHooks -HooksPath '.githooks'
                Set-Content -LiteralPath (Join-Path $w '.gitignore') -Value 'scratch/'
                @{ Cwd = $w; Dest = (Join-Path $w 'scratch/x.har') }
            }
            'worktree' {
                $w = New-Checkout -Name "dcmp-$Setup" -TrackedHooks -HooksPath '.githooks'
                $t = Join-Path $script:Tmp "dcmp-$Setup-tree"
                Invoke-Git $w @('worktree', 'add', $t, '-b', 'feat/dcmp') | Out-Null
                @{ Cwd = $t; Dest = (Join-Path $t 'docs/x.har') }
            }
            'outside' {
                $d = Join-Path $script:Tmp "dcmp-$Setup"
                New-Item -ItemType Directory -Path $d -Force | Out-Null
                @{ Cwd = $d; Dest = (Join-Path $d 'x.har') }
            }
        }

        $ps = [bool](Get-StrandingPlacement -Destination $ctx.Dest -Path $ctx.Cwd)
        $js = (Get-NodeStranding -Cwd $ctx.Cwd -Destination $ctx.Dest).warns
        $ps | Should -Be $js -Because 'the two runtimes must not drift on the destination question'
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
