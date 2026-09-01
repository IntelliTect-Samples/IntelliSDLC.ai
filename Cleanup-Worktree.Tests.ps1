#Requires -Modules Pester

<#
    Behavior tests for Cleanup-Worktree.ps1's capture guard (issue #371).

    These exercise the two guard functions directly rather than running the
    whole script, because the script's side effects are repo-wide (checkout,
    pull, branch deletion) and cannot be safely driven from a test.

    Every case here corresponds to a way the guard could be wrong in a manner
    that destroys data or blocks work forever -- not to a line of code.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Cleanup-Worktree.ps1'

    # Load the functions without executing the script body. The body starts at
    # the "Resolve context" banner and immediately touches the live repo.
    $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
    $marker = '# --- Resolve context'
    $cut = $raw.IndexOf($marker)
    if ($cut -lt 0) { throw "Could not find the '$marker' banner in Cleanup-Worktree.ps1." }
    $functionsOnly = $raw.Substring(0, $cut)

    # param() cannot be re-declared in this scope; strip it and the help block.
    $functionsOnly = $functionsOnly -replace '(?s)^.*?\)\s*\r?\n\s*Set-StrictMode', 'Set-StrictMode'
    . ([scriptblock]::Create($functionsOnly))

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

    It 'guards before the --force retry, not after' {
        # `worktree remove` refusing is not enough: the script escalates to
        # --force on refusal, so a git-layer guard defeats itself.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $firstGuard = $raw.IndexOf('Assert-WorktreeCaptureSafe -WorktreePath')
        $firstForce = $raw.IndexOf("'worktree', 'remove', '--force'")
        $firstGuard | Should -BeGreaterThan 0
        $firstForce | Should -BeGreaterThan 0
        $firstGuard | Should -BeLessThan $firstForce
    }

    It 'adds no new command-line option' {
        # Adding a flag is an API decision requiring explicit human approval.
        # The refusal's remedy is to move the captures, not to pass a switch.
        $raw = Get-Content -LiteralPath $script:ScriptPath -Raw
        $raw | Should -Not -Match 'AllowCaptureLoss|SkipCaptureCheck|IgnoreCaptures'
    }
}
