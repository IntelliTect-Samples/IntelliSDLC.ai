#Requires -Modules Pester

<#
    Behavior tests for Cleanup-Worktree.ps1's two safety gates:
    the capture guard (issue #371) and the safe-location check (issue #383).

    These exercise the functions directly rather than running the whole
    script, because its side effects are repo-wide (checkout, pull, branch
    deletion) and cannot be safely driven from a test.

    Every case here corresponds to a way a gate could be wrong in a manner
    that destroys data or blocks work forever -- not to a line of code.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Cleanup-Worktree.ps1'

    # Issue #383: the script returns early when dot-sourced, so its functions
    # load without the body running. This replaces the #371 loader, which cut
    # the file at the "Resolve context" banner and re-parsed the front half --
    # a text hack that would have silently loaded nothing had that banner
    # moved, and the tests would have failed obscurely rather than usefully.
    . $script:ScriptPath

    function New-TestWorktree {
        <# A real git repo, so `git status --ignored` behaves as in production. #>
        param([string[]]$IgnorePatterns = @('.har-captures/'))

        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("cwguard-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        Push-Location $dir
        try {
            & git init --quiet 2>$null
            & git config user.email 'test@example.com'
            & git config user.name 'Test'
            Set-Content -Path (Join-Path $dir '.gitignore') -Value $IgnorePatterns
            & git add -A 2>$null
            & git -c commit.gpgsign=false commit --quiet -m 'init' 2>$null
        }
        finally { Pop-Location }
        return $dir
    }

    function New-Capture {
        param([string]$WorktreePath, [string]$Relative, [int]$Bytes = 1024)
        $full = Join-Path $WorktreePath $Relative
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllBytes($full, (New-Object byte[] $Bytes))
        return $full
    }
}

Describe 'Get-WorktreeCaptureArtifact' {

    It 'finds a raw capture inside a gitignored store' {
        $wt = New-TestWorktree
        try {
            New-Capture -WorktreePath $wt -Relative '.har-captures/run-1/raw.har' | Out-Null
            $found = @(Get-WorktreeCaptureArtifact -WorktreePath $wt)
            $found.Count | Should -Be 1
            $found[0].Name | Should -Be 'raw.har'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'finds session.json, not only .har files' {
        # run-capture.sh counts sessions by session.json; a store can hold one
        # before its raw.har has been written.
        $wt = New-TestWorktree
        try {
            New-Capture -WorktreePath $wt -Relative '.har-captures/run-1/session.json' | Out-Null
            @(Get-WorktreeCaptureArtifact -WorktreePath $wt).Count | Should -Be 1
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'finds a capture ignored as a FILE, not only one inside an ignored directory' {
        # `git status --ignored` reports a whole DIRECTORY when the ignore rule
        # names one (`.har-captures/`) and an individual FILE when the rule
        # names the file. Those are two branches in Get-WorktreeCaptureArtifact,
        # and only the directory branch was covered: the file branch checked the
        # .har extension alone, so a lone ignored session.json -- the artifact
        # that says what a capture was FOR -- was invisible to the guard.
        $wt = New-TestWorktree -IgnorePatterns @('session.json', '*.har')
        try {
            New-Capture -WorktreePath $wt -Relative 'session.json' | Out-Null
            @(Get-WorktreeCaptureArtifact -WorktreePath $wt).Count |
                Should -Be 1 -Because 'an ignored session.json is a capture artifact wherever it sits'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'returns nothing for a worktree with no captures' {
        $wt = New-TestWorktree
        try {
            @(Get-WorktreeCaptureArtifact -WorktreePath $wt).Count | Should -Be 0
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'ignores a TRACKED .har file, because git already protects it' {
        $wt = New-TestWorktree
        try {
            $f = New-Capture -WorktreePath $wt -Relative 'docs/reference.har'
            Push-Location $wt
            & git add -A 2>$null
            & git -c commit.gpgsign=false commit --quiet -m 'add reference' 2>$null
            Pop-Location
            @(Get-WorktreeCaptureArtifact -WorktreePath $wt).Count | Should -Be 0
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'treats a linked capture store as empty, so linked worktrees stay removable' {
        # The regression that matters most: following the link would refuse
        # every linked worktree forever AND risk deleting the shared store.
        $wt = New-TestWorktree
        $shared = Join-Path ([System.IO.Path]::GetTempPath()) ("cwshared-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $shared | Out-Null
        [System.IO.File]::WriteAllBytes((Join-Path $shared 'raw.har'), (New-Object byte[] 4096))
        try {
            $link = Join-Path $wt '.har-captures'
            cmd /c mklink /J "`"$link`"" "`"$shared`"" | Out-Null
            (Get-Item $link -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint |
                Should -Not -Be 0 -Because 'the test must actually create a reparse point'

            @(Get-WorktreeCaptureArtifact -WorktreePath $wt).Count | Should -Be 0
            Test-Path (Join-Path $shared 'raw.har') | Should -BeTrue -Because 'the shared store must be untouched'
        }
        finally {
            cmd /c rmdir "`"$(Join-Path $wt '.har-captures')`"" 2>$null
            Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item $shared -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'returns nothing for a path that does not exist' {
        @(Get-WorktreeCaptureArtifact -WorktreePath (Join-Path ([System.IO.Path]::GetTempPath()) 'cwguard-absent')).Count |
            Should -Be 0
    }
}

Describe 'Assert-WorktreeCaptureSafe' {

    It 'throws when the worktree holds raw captures' {
        $wt = New-TestWorktree
        try {
            New-Capture -WorktreePath $wt -Relative '.har-captures/run-1/raw.har' -Bytes 2048 | Out-Null
            { Assert-WorktreeCaptureSafe -WorktreePath $wt } | Should -Throw
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'names the count and the remedy so the operator can act on the refusal' {
        $wt = New-TestWorktree
        try {
            New-Capture -WorktreePath $wt -Relative '.har-captures/run-1/raw.har' | Out-Null
            New-Capture -WorktreePath $wt -Relative '.har-captures/run-2/raw.har' | Out-Null
            $err = { Assert-WorktreeCaptureSafe -WorktreePath $wt } | Should -Throw -PassThru
            $text = $err.Exception.Message
            $text | Should -Match '2 raw capture file'
            $text | Should -Match 'shared capture store'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'does not throw when there is nothing to lose' {
        $wt = New-TestWorktree
        try {
            { Assert-WorktreeCaptureSafe -WorktreePath $wt } | Should -Not -Throw
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'warns instead of throwing under -DryRun, so the check can audit safely' {
        $wt = New-TestWorktree
        try {
            New-Capture -WorktreePath $wt -Relative '.har-captures/run-1/raw.har' | Out-Null
            { Assert-WorktreeCaptureSafe -WorktreePath $wt -DryRun -WarningAction SilentlyContinue } |
                Should -Not -Throw
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'scales the size unit, so a small capture does not report "0 MB"' {
        # A refusal that says "0 MB" reads like a rounding bug and invites the
        # operator to dismiss it.
        $wt = New-TestWorktree
        try {
            New-Capture -WorktreePath $wt -Relative '.har-captures/run-1/raw.har' -Bytes 2048 | Out-Null
            $err = { Assert-WorktreeCaptureSafe -WorktreePath $wt } | Should -Throw -PassThru
            $err.Exception.Message | Should -Not -Match '0 MB'
            $err.Exception.Message | Should -Match '2 KB'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Cleanup-Worktree.ps1 wiring' {

    It 'guards every worktree-removal site' {
        # A guard that covers only the targeted path would still let -Sweep
        # destroy captures, which is how a sweep would repeat issue #371.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        ([regex]::Matches($raw, 'Assert-WorktreeCaptureSafe -WorktreePath')).Count |
            Should -Be 3 -Because 'the targeted removal and both sweep removals must each be guarded'
    }

    It 'guards before EVERY --force retry, not just the first' {
        # `worktree remove` refusing is not enough: the script escalates to
        # --force on refusal, so a git-layer guard defeats itself.
        #
        # Checked PER SITE, not on first occurrence. An earlier version compared
        # $raw.IndexOf(guard) with $raw.IndexOf(force): both resolve to the
        # TARGETED path, so swapping the guard and the --force call at either
        # SWEEP site left this test green -- and the sweep sites are the
        # unattended ones, where an unsupervised regression costs the most.
        #
        # The property is interleaving: walking the file, each --force call must
        # be preceded by a guard that comes after the previous --force. Offsets
        # rather than line numbers, so the assertion survives reformatting.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $guards = @([regex]::Matches($raw, 'Assert-WorktreeCaptureSafe -WorktreePath') |
            ForEach-Object { $_.Index })
        $forces = @([regex]::Matches($raw, "'worktree', 'remove', '--force'") |
            ForEach-Object { $_.Index })

        $guards.Count | Should -Be 3 -Because 'each removal site needs its own guard'
        $forces.Count | Should -Be 3 -Because 'the targeted retry and both sweep removals force'

        $previousForce = -1
        foreach ($force in $forces) {
            $own = @($guards | Where-Object { $_ -lt $force -and $_ -gt $previousForce })
            $own.Count | Should -BeGreaterThan 0 -Because (
                "the --force call at offset $force must be preceded by its OWN guard, " +
                'not merely by the guard belonging to an earlier site')
            $previousForce = $force
        }
    }

    It 'adds no new command-line option' {
        # Adding a flag is an API decision requiring explicit human approval.
        # The refusal's remedy is to move the captures, not to pass a switch.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $raw | Should -Not -Match 'AllowCaptureLoss|SkipCaptureCheck|IgnoreCaptures'
    }
}

# --- Issue #383: safe-location recognition -------------------------------

Describe 'ConvertTo-NormalizedPath' {
    It 'strips a trailing backslash' {
        ConvertTo-NormalizedPath -Path 'C:\Git\Repo\' | Should -Be 'C:\Git\Repo'
    }

    It 'strips a trailing forward slash' {
        ConvertTo-NormalizedPath -Path 'C:/Git/Repo/' | Should -Be 'C:\Git\Repo'
    }

    It 'converts forward slashes to backslashes (git porcelain format)' {
        ConvertTo-NormalizedPath -Path 'C:/Git/Repo/.worktrees/foo' |
            Should -Be 'C:\Git\Repo\.worktrees\foo'
    }

    It 'returns empty for empty input' {
        ConvertTo-NormalizedPath -Path '' | Should -Be ''
    }
}

Describe 'Test-WorktreeInSafeLocation' {

    Context 'Legit {repo}\.worktrees\{slug} layout (regression)' {
        It 'accepts a worktree directly under .worktrees/' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Git\MyRepo\.worktrees\42-feature' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @() |
                Should -BeTrue
        }

        It 'accepts a nested worktree under .worktrees/' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Git\MyRepo\.worktrees\group\42-feature' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @() |
                Should -BeTrue
        }

        It 'accepts .worktrees/ layout even when git porcelain uses forward slashes' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:/Git/MyRepo/.worktrees/42-feature' `
                -MainRepoRoot  'C:/Git/MyRepo' `
                -RegisteredWorktreePaths @() |
                Should -BeTrue
        }
    }

    Context 'Legit Copilot desktop app layout' {
        It 'accepts **\copilot-worktrees\{repoName}\{slug} when git worktree list registers it' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Users\Me\copilot-worktrees\MyRepo\musical-adventure' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @('C:\Users\Me\copilot-worktrees\MyRepo\musical-adventure') |
                Should -BeTrue
        }

        It 'accepts the {mainRepoRoot}\..\copilot-worktrees\{repoName}\{slug} variant when registered' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Git\copilot-worktrees\MyRepo\my-slug' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @('C:\Git\copilot-worktrees\MyRepo\my-slug') |
                Should -BeTrue
        }

        It 'accepts when the registered list uses forward-slash porcelain output' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Users\Me\copilot-worktrees\MyRepo\musical-adventure' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @('C:/Users/Me/copilot-worktrees/MyRepo/musical-adventure') |
                Should -BeTrue
        }

        It 'is case-insensitive on the copilot-worktrees segment' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Users\Me\Copilot-Worktrees\MyRepo\slug' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @('C:\Users\Me\Copilot-Worktrees\MyRepo\slug') |
                Should -BeTrue
        }
    }

    Context 'copilot-worktrees segment without git registration' {
        It 'rejects a **\copilot-worktrees path that git does NOT list' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Users\Me\copilot-worktrees\MyRepo\stray' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @('C:\Users\Me\copilot-worktrees\MyRepo\real') |
                Should -BeFalse
        }

        It 'rejects a copilot-worktrees path for a different repo name' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Users\Me\copilot-worktrees\OtherRepo\slug' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @('C:\Users\Me\copilot-worktrees\OtherRepo\slug') |
                Should -BeFalse
        }

        It 'rejects when the registered-list is empty' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Users\Me\copilot-worktrees\MyRepo\slug' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @() |
                Should -BeFalse
        }
    }

    Context 'Off-tree foreign paths' {
        It 'rejects an unrelated off-tree path' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Temp\bogus\MyRepo-checkout' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @('C:\Temp\bogus\MyRepo-checkout') |
                Should -BeFalse
        }

        It 'rejects a sibling directory that resembles .worktrees but is not' {
            Test-WorktreeInSafeLocation `
                -WorktreePath 'C:\Git\MyRepo.worktrees-backup\42' `
                -MainRepoRoot  'C:\Git\MyRepo' `
                -RegisteredWorktreePaths @() |
                Should -BeFalse
        }
    }
}

# --- Issue #392: uncommitted-work guard ------------------------------------

Describe 'Get-WorktreeDirtyState' {

    It 'reports a clean worktree as clean' {
        $wt = New-TestWorktree
        try {
            $state = Get-WorktreeDirtyState -WorktreePath $wt
            @($state.Tracked).Count | Should -Be 0
            @($state.Untracked).Count | Should -Be 0
            $state.Unknown | Should -BeFalse
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'classifies a MODIFIED tracked file as tracked work, not as untracked' {
        # The whole point of the split: this is the case that is unrecoverable.
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# edited')
            $state = Get-WorktreeDirtyState -WorktreePath $wt
            @($state.Tracked).Count | Should -Be 1
            @($state.Tracked)[0] | Should -Match '\.gitignore'
            @($state.Untracked).Count | Should -Be 0
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'classifies a STAGED addition as tracked work' {
        # Staged-but-uncommitted survives in the object store, but the operator
        # still loses the index state and the intent; it is not build output.
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt 'new.txt') -Value 'x'
            Push-Location $wt; & git add new.txt 2>$null; Pop-Location
            $state = Get-WorktreeDirtyState -WorktreePath $wt
            @($state.Tracked).Count | Should -Be 1
            @($state.Untracked).Count | Should -Be 0
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'classifies an UNTRACKED file as untracked, so build output does not block cleanup' {
        # The other half of the distinction. If this collapsed into Tracked,
        # every worktree with a bin/ directory would demand consent and the
        # gate would be trained away.
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt 'scratch.txt') -Value 'x'
            $state = Get-WorktreeDirtyState -WorktreePath $wt
            @($state.Untracked).Count | Should -Be 1
            @($state.Tracked).Count | Should -Be 0
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'reports nothing for a path that is not on disk' {
        $state = Get-WorktreeDirtyState -WorktreePath (Join-Path ([System.IO.Path]::GetTempPath()) 'cwdirty-absent')
        @($state.Tracked).Count | Should -Be 0
        $state.Unknown | Should -BeFalse
    }

    It 'reports Unknown -- not clean -- when git cannot answer for an existing path' {
        # "No output" is the failure mode this script's own banner is about.
        # A directory git refuses to report on must not read as empty.
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("cwdirty-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -Path (Join-Path $dir 'work.txt') -Value 'unsaved'
        try {
            $state = Get-WorktreeDirtyState -WorktreePath $dir
            $state.Unknown | Should -BeTrue -Because 'a non-repository directory is unknown, not clean'
        }
        finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Assert-WorktreeRemovalConsent' {

    BeforeEach {
        # Default posture for these cases: nobody is watching. Individual
        # interactive cases override it.
        Mock -CommandName Test-CleanupInteractive -MockWith { $false }
    }

    It 'does not block a clean worktree' {
        $wt = New-TestWorktree
        try { { Assert-WorktreeRemovalConsent -WorktreePath $wt } | Should -Not -Throw }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'does not block on UNTRACKED files alone, even non-interactively' {
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt 'obj-output.txt') -Value 'x'
            { Assert-WorktreeRemovalConsent -WorktreePath $wt } |
                Should -Not -Throw -Because 'build output is a nuisance, not work'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'FAILS non-interactively when tracked changes would be destroyed' {
        # The 2026-09-02 loss, in a fixture: a merge-then-cleanup run with no
        # human attached, over a worktree the authoring agent was still editing.
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            $err = { Assert-WorktreeRemovalConsent -WorktreePath $wt -WarningAction SilentlyContinue } |
                Should -Throw -PassThru
            $err.Exception.Message | Should -Match 'Refusing to force-remove'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'names the dirty files and the flag that would authorise the loss' {
        # A refusal the operator cannot act on is just an outage.
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            $err = { Assert-WorktreeRemovalConsent -WorktreePath $wt -WarningAction SilentlyContinue } |
                Should -Throw -PassThru
            $err.Exception.Message | Should -Match '\.gitignore'
            $err.Exception.Message | Should -Match '-Force'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'reports file NAMES and never file CONTENTS' {
        # This text lands in terminals, transcripts and CI logs.
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', 'SUPERSECRETPAYLOAD')
            $err = { Assert-WorktreeRemovalConsent -WorktreePath $wt -WarningAction SilentlyContinue } |
                Should -Throw -PassThru
            $err.Exception.Message | Should -Not -Match 'SUPERSECRETPAYLOAD'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'treats an Unknown state as work at risk, not as consent to proceed' {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("cwdirty-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        try {
            { Assert-WorktreeRemovalConsent -WorktreePath $dir -WarningAction SilentlyContinue } | Should -Throw
        }
        finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'proceeds under -Force, because -Force is the authorisation' {
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            { Assert-WorktreeRemovalConsent -WorktreePath $wt -Force -WarningAction SilentlyContinue } |
                Should -Not -Throw
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'still says what -Force is about to destroy' {
        # Authorised is not the same as unreported: #392 is as much about the
        # silence as about the escalation.
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            $warnings = @()
            Assert-WorktreeRemovalConsent -WorktreePath $wt -Force -WarningVariable warnings -WarningAction SilentlyContinue
            ($warnings -join ' ') | Should -Match '\.gitignore'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'reports instead of throwing under -DryRun, so an audit run can finish' {
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            { Assert-WorktreeRemovalConsent -WorktreePath $wt -DryRun -WarningAction SilentlyContinue } |
                Should -Not -Throw
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'prompts, and proceeds, when a human is attached and says yes' {
        $wt = New-TestWorktree
        try {
            Mock -CommandName Test-CleanupInteractive -MockWith { $true }
            Mock -CommandName Confirm-WorktreeDirtyDiscard -MockWith { $true }
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            { Assert-WorktreeRemovalConsent -WorktreePath $wt -Cmdlet ([pscustomobject]@{}) -WarningAction SilentlyContinue } |
                Should -Not -Throw
            Should -Invoke -CommandName Confirm-WorktreeDirtyDiscard -Times 1 -Exactly
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'aborts when the human says no' {
        $wt = New-TestWorktree
        try {
            Mock -CommandName Test-CleanupInteractive -MockWith { $true }
            Mock -CommandName Confirm-WorktreeDirtyDiscard -MockWith { $false }
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            $err = { Assert-WorktreeRemovalConsent -WorktreePath $wt -Cmdlet ([pscustomobject]@{}) -WarningAction SilentlyContinue } |
                Should -Throw -PassThru
            $err.Exception.Message | Should -Match 'Aborted at operator request'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'shows the human the file list rather than asking blind' {
        $wt = New-TestWorktree
        try {
            $script:PromptedReport = $null
            Mock -CommandName Test-CleanupInteractive -MockWith { $true }
            Mock -CommandName Confirm-WorktreeDirtyDiscard -MockWith { $script:PromptedReport = $Report; $true }
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            Assert-WorktreeRemovalConsent -WorktreePath $wt -Cmdlet ([pscustomobject]@{}) -WarningAction SilentlyContinue
            $script:PromptedReport | Should -Match '\.gitignore'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'never prompts when nothing can answer, even if the console looks interactive' {
        # -Cmdlet absent means there is no ShouldContinue to reach. Prompting
        # anyway would hang an unattended run rather than failing it.
        $wt = New-TestWorktree
        try {
            Mock -CommandName Test-CleanupInteractive -MockWith { $true }
            Mock -CommandName Confirm-WorktreeDirtyDiscard -MockWith { $true }
            Set-Content -Path (Join-Path $wt '.gitignore') -Value @('.har-captures/', '# mid-edit')
            { Assert-WorktreeRemovalConsent -WorktreePath $wt -WarningAction SilentlyContinue } | Should -Throw
            Should -Invoke -CommandName Confirm-WorktreeDirtyDiscard -Times 0 -Exactly
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Cleanup-Worktree.ps1 consent wiring' {

    It 'gates every --force removal on consent, per site' {
        # Same interleaving property as the capture guard, for the same reason:
        # the sweep sites are the unattended ones, and a first-occurrence check
        # would pass while both of them ran unguarded.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $consents = @([regex]::Matches($raw, 'Assert-WorktreeRemovalConsent -WorktreePath') |
            ForEach-Object { $_.Index })
        $forces = @([regex]::Matches($raw, "'worktree', 'remove', '--force'") |
            ForEach-Object { $_.Index })

        $consents.Count | Should -Be 3 -Because 'the targeted retry and both sweep removals each need consent'
        $forces.Count | Should -Be 3

        $previousForce = -1
        foreach ($force in $forces) {
            $own = @($consents | Where-Object { $_ -lt $force -and $_ -gt $previousForce })
            $own.Count | Should -BeGreaterThan 0 -Because (
                "the --force call at offset $force must be preceded by its OWN consent gate")
            $previousForce = $force
        }
    }

    It 'keeps the capture guard ahead of the consent gate at every site' {
        # Ordering between the two guards is itself a property: "that worktree
        # holds a capture that exists nowhere else" is a refusal no prompt
        # should be able to override, so it must be reached first.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $guards = @([regex]::Matches($raw, 'Assert-WorktreeCaptureSafe -WorktreePath') | ForEach-Object { $_.Index })
        $consents = @([regex]::Matches($raw, 'Assert-WorktreeRemovalConsent -WorktreePath') | ForEach-Object { $_.Index })
        $guards.Count | Should -Be 3
        $consents.Count | Should -Be 3
        for ($i = 0; $i -lt 3; $i++) {
            $guards[$i] | Should -BeLessThan $consents[$i]
        }
    }

    It 'passes the operator -Force through to the consent gate at every site' {
        # A gate that always saw $false would fail an authorised run; one that
        # always saw $true would be no gate at all.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        ([regex]::Matches($raw, 'Assert-WorktreeRemovalConsent[^\r\n]*-Force:\$Force')).Count |
            Should -Be 3
    }

    It 'documents that -Force now also authorises destroying uncommitted work' {
        # The widening is only legitimate if the help says so.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $forceHelp = [regex]::Match($raw, '(?s)\.PARAMETER Force(.*?)\.PARAMETER KeepBranch').Groups[1].Value
        $forceHelp | Should -Match 'uncommitted'
        $forceHelp | Should -Match 'TRACKED'
    }

    It 'adds no new command-line option for either issue' {
        # The parameter block is the API. Pinned by name, so a new switch
        # cannot slip in under a name no negative match anticipated.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $block = [regex]::Match($raw, '(?s)\[CmdletBinding\(\)\]\s*param\((.*?)\r?\n\)').Groups[1].Value
        $names = @([regex]::Matches($block, '\$(\w+)') | ForEach-Object { $_.Groups[1].Value })
        ($names -join ',') | Should -Be 'Branch,WorktreePath,DefaultBranch,Force,KeepBranch,SkipPull,AllowOutsideWorktreesDir,Sweep,DryRun'
    }
}

Describe 'Issue #390: case-sensitivity comes from the operator' {

    It 'carries no inline (?i) flag anywhere in the script' {
        # Redundant under -match/-notmatch, and a trap for the next edit: a
        # reader switching to -cnotmatch for real case sensitivity would get
        # none. NOTE for ablation: deleting the flag changes no behaviour, so
        # a mutation test on the flag itself proves nothing -- the behavioural
        # case is 'is case-insensitive on the copilot-worktrees segment'
        # above, which only bites when the OPERATOR is changed to -cnotmatch.
        # Comment lines are excluded on purpose: the comment left at the fix
        # site NAMES the flag in order to warn the next reader off re-adding
        # it, and a check that banned the word would ban its own explanation.
        $code = @(Get-Content -LiteralPath $script:ScriptPath |
            Where-Object { $_.TrimStart() -notlike '#*' })
        ($code -join "`n") | Should -Not -Match '\(\?i\)'
    }
}

# --- Independent-review findings (PR #433) --------------------------------

Describe 'Format-PorcelainPath' {

    It 'unwraps the quotes git puts around a path with spaces' {
        Format-PorcelainPath -Path '"my file.txt"' | Should -Be 'my file.txt'
    }

    It 'leaves an ordinary path alone' {
        Format-PorcelainPath -Path 'src/app.ps1' | Should -Be 'src/app.ps1'
    }

    It 'leaves a RENAME line intact rather than eating one quote from each end' {
        # `old -> new` can be quoted on either side; a blind Trim would strip
        # the outermost quote of each path and leave the inner ones, which is
        # worse than doing nothing.
        Format-PorcelainPath -Path '"old name.txt" -> "new name.txt"' |
            Should -Be '"old name.txt" -> "new name.txt"'
    }
}

Describe 'Dirty report legibility' {

    It 'names a non-ASCII file as itself, not as octal escapes' {
        # The operator is being asked to authorise destroying these files.
        # "caf\303\251.txt" is not a name anyone can recognise, and git emits
        # exactly that unless core.quotepath is turned off.
        $wt = New-TestWorktree
        try {
            $name = [string]([char]0x63 + [char]0x61 + [char]0x66 + [char]0xE9) + '.txt'
            $full = Join-Path $wt $name
            [System.IO.File]::WriteAllText($full, 'v1', [System.Text.Encoding]::UTF8)
            Push-Location $wt
            & git add -A 2>$null
            & git -c commit.gpgsign=false commit --quiet -m 'add' 2>$null
            Pop-Location
            [System.IO.File]::WriteAllText($full, 'v2', [System.Text.Encoding]::UTF8)

            $state = Get-WorktreeDirtyState -WorktreePath $wt
            @($state.Tracked).Count | Should -Be 1
            @($state.Tracked)[0] | Should -Match ([regex]::Escape($name))
            @($state.Tracked)[0] | Should -Not -Match '\\303'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'truncates a long list and says how many it withheld' {
        # An unbounded list buries the decision it exists to inform.
        $wt = New-TestWorktree
        try {
            1..25 | ForEach-Object { Set-Content -Path (Join-Path $wt "f$_.txt") -Value 'v1' }
            Push-Location $wt
            & git add -A 2>$null
            & git -c commit.gpgsign=false commit --quiet -m 'add' 2>$null
            Pop-Location
            1..25 | ForEach-Object { Set-Content -Path (Join-Path $wt "f$_.txt") -Value 'v2' }

            $state = Get-WorktreeDirtyState -WorktreePath $wt
            @($state.Tracked).Count | Should -Be 25
            $report = Format-WorktreeDirtyReport -WorktreePath $wt -DirtyState $state
            $report | Should -Match '25 uncommitted change'
            $report | Should -Match 'and 5 more'
            # The count of listed entries must be the cap, not the total.
            @($report -split "`r?`n" | Where-Object { $_ -match '^\s{4}\s*M\s' }).Count |
                Should -Be 20
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'says "Would discard" under -DryRun, because a dry run discards nothing' {
        $wt = New-TestWorktree
        try {
            Set-Content -Path (Join-Path $wt 'obj-output.txt') -Value 'x'
            $out = Assert-WorktreeRemovalConsent -WorktreePath $wt -DryRun 6>&1 |
                ForEach-Object { "$_" }
            ($out -join ' ') | Should -Match 'Would discard'
            ($out -join ' ') | Should -Not -Match 'Discarding'
        }
        finally { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Targeted-site path resolution' {

    It 'hands the consent gate the RESOLVED worktree path, as the capture guard does' {
        # The script may Set-Location to the main repo root before this point,
        # so a relative -WorktreePath no longer means what the operator typed.
        # A guard pointed at the wrong directory answers "nothing to lose".
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $raw | Should -Match 'Assert-WorktreeRemovalConsent -WorktreePath \$absWorktree'
        $raw | Should -Not -Match 'Assert-WorktreeRemovalConsent -WorktreePath \$WorktreePath '
    }
}
