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
