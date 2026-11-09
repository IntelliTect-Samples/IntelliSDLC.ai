BeforeAll {
    . $PSScriptRoot/Consolidate-Specs.ps1

    function New-FakeConsumerRepo {
        param([string]$Root)
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
        Push-Location $Root
        try {
            & git init --quiet
            & git config user.email "test@example.com"
            & git config user.name "Test"
            & git config commit.gpgsign false
            "placeholder" | Set-Content -LiteralPath README.md
            & git add README.md
            & git commit --quiet -m "init"
        }
        finally { Pop-Location }
    }

    # Stages everything and commits it with a fixed author date, so a test can
    # control the date git reports for a file.
    function Invoke-GitCommitAt {
        param([string]$Root, [string]$Date, [string]$Message)
        $previous = $env:GIT_AUTHOR_DATE
        $env:GIT_AUTHOR_DATE = "$($Date)T12:00:00Z"
        try {
            & git -C $Root add -A
            & git -C $Root commit --quiet -m $Message
        }
        finally { $env:GIT_AUTHOR_DATE = $previous }
    }
}

Describe "Get-FeatureSlug" {
    It "keeps a YYYY-MM-DD date prefix, so imports sort chronologically (#174)" {
        Get-FeatureSlug -FileName "2026-05-12-foo-plan.md" | Should -Be "2026-05-12-foo"
    }
    It "strips a trailing -prd suffix" {
        Get-FeatureSlug -FileName "bar-prd.md" | Should -Be "bar"
    }
    It "strips a trailing -plan suffix" {
        Get-FeatureSlug -FileName "baz-plan.md" | Should -Be "baz"
    }
    It "drops the -plan suffix but keeps the date prefix" {
        Get-FeatureSlug -FileName "2025-01-01-qux-plan.md" | Should -Be "2025-01-01-qux"
    }
    It "returns the stem unchanged when no prefix/suffix matches" {
        Get-FeatureSlug -FileName "raw-name.md" | Should -Be "raw-name"
    }
    It "returns untitled for an effectively empty stem" {
        Get-FeatureSlug -FileName "-plan.md" | Should -Be "untitled"
    }
}

Describe "Get-SourceDate" {
    BeforeEach {
        $script:repo = Join-Path $TestDrive "dates"
        if (Test-Path $script:repo) { Remove-Item -Recurse -Force $script:repo }
        New-FakeConsumerRepo -Root $script:repo
    }

    It "prefers a date embedded in the filename over git and the filesystem" {
        $file = Join-Path $script:repo "2021-03-04-foo-plan.md"
        Set-Content -LiteralPath $file -Value "x"
        Invoke-GitCommitAt -Root $script:repo -Date "2023-01-01" -Message "add"
        Get-SourceDate -Path $file | Should -Be "2021-03-04"
    }

    It "uses the date the file was first committed, not a later rename" {
        Set-Content -LiteralPath (Join-Path $script:repo "old-plan.md") -Value "x"
        Invoke-GitCommitAt -Root $script:repo -Date "2020-01-01" -Message "add"
        & git -C $script:repo mv old-plan.md new-plan.md
        Invoke-GitCommitAt -Root $script:repo -Date "2024-06-01" -Message "rename"
        Get-SourceDate -Path (Join-Path $script:repo "new-plan.md") | Should -Be "2020-01-01"
    }

    It "falls back to the last-write time for a file git does not track" {
        $file = Join-Path $script:repo "untracked-plan.md"
        Set-Content -LiteralPath $file -Value "x"
        (Get-Item -LiteralPath $file).LastWriteTimeUtc = [datetime]::new(2019, 5, 6, 12, 0, 0, [DateTimeKind]::Utc)
        Get-SourceDate -Path $file | Should -Be "2019-05-06"
    }

    It "falls back to the last-write time outside any git repository" {
        $dir = Join-Path $TestDrive "no-repo"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $file = Join-Path $dir "plan.md"
        Set-Content -LiteralPath $file -Value "x"
        (Get-Item -LiteralPath $file).LastWriteTimeUtc = [datetime]::new(2018, 7, 8, 12, 0, 0, [DateTimeKind]::Utc)
        Get-SourceDate -Path $file | Should -Be "2018-07-08"
    }

    It "falls back to the last-write time when invoking git throws" {
        # Windows PowerShell 5.1 raises git's stderr as a terminating error
        # under -ErrorAction Stop, and a missing git throws everywhere.
        Mock git { throw "fatal: not a git repository" }
        $file = Join-Path $script:repo "plan.md"
        Set-Content -LiteralPath $file -Value "x"
        (Get-Item -LiteralPath $file).LastWriteTimeUtc = [datetime]::new(2017, 9, 10, 12, 0, 0, [DateTimeKind]::Utc)
        Get-SourceDate -Path $file | Should -Be "2017-09-10"
    }
}

Describe "Get-ShortHash" {
    It "returns 8 hex chars" {
        $h = Get-ShortHash -Text "hello"
        $h | Should -Match "^[0-9a-f]{8}$"
    }
    It "is deterministic" {
        (Get-ShortHash -Text "abc") | Should -Be (Get-ShortHash -Text "abc")
    }
    It "differs on different input" {
        (Get-ShortHash -Text "abc") | Should -Not -Be (Get-ShortHash -Text "abd")
    }
}

Describe "Find-LinkedIssues" {
    It "finds Closes #N" {
        Find-LinkedIssues -Text "Some text. Closes #42 in passing." | Should -Be @(42)
    }
    It "finds bare #N references" {
        $r = Find-LinkedIssues -Text "See #10 and #20."
        @($r) | Should -Be @(10, 20)
    }
    It "ignores hex-like tokens that follow letters" {
        Find-LinkedIssues -Text "abc#7" | Should -Be @()
    }
    It "returns an empty array for empty text" {
        @(Find-LinkedIssues -Text "") | Should -Be @()
    }
    It "deduplicates repeated references" {
        @(Find-LinkedIssues -Text "Closes #5 fixes #5 and #5") | Should -Be @(5)
    }
}

Describe "Resolve-Destination" {
    BeforeEach {
        $script:tdir = Join-Path $TestDrive "rd"
        if (Test-Path $script:tdir) { Remove-Item -Recurse -Force $script:tdir }
        New-Item -ItemType Directory -Path $script:tdir -Force | Out-Null
    }
    It "returns the bare target when it does not exist" {
        $r = Resolve-Destination -DestinationDir $script:tdir -BaseName "foo-prd" -Extension ".md" -SourceContent "x"
        $r | Should -Be (Join-Path $script:tdir "foo-prd.md")
    }
    It "returns null when the target already has identical content" {
        Set-Content -LiteralPath (Join-Path $script:tdir "foo-prd.md") -Value "x" -NoNewline
        $r = Resolve-Destination -DestinationDir $script:tdir -BaseName "foo-prd" -Extension ".md" -SourceContent "x"
        $r | Should -BeNullOrEmpty
    }
    It "appends a deterministic 8-char suffix on content collision" {
        Set-Content -LiteralPath (Join-Path $script:tdir "foo-prd.md") -Value "OLD" -NoNewline
        $r1 = Resolve-Destination -DestinationDir $script:tdir -BaseName "foo-prd" -Extension ".md" -SourceContent "NEW"
        $r2 = Resolve-Destination -DestinationDir $script:tdir -BaseName "foo-prd" -Extension ".md" -SourceContent "NEW"
        $r1 | Should -Be $r2
        $r1 | Should -Match "foo-prd-[0-9a-f]{8}\.md$"
    }
}

Describe "Test-CopilotSessionMatchesRepo" {
    BeforeEach {
        $script:repo = Join-Path $TestDrive "scope-repo"
        $script:sess = Join-Path $TestDrive "scope-session"
        if (Test-Path $script:repo) { Remove-Item -Recurse -Force $script:repo }
        if (Test-Path $script:sess) { Remove-Item -Recurse -Force $script:sess }
        New-Item -ItemType Directory -Path $script:repo -Force | Out-Null
        New-Item -ItemType Directory -Path $script:sess -Force | Out-Null
    }
    It "returns true when cwd.txt points at the repo root" {
        Set-Content -LiteralPath (Join-Path $script:sess "cwd.txt") -Value $script:repo -NoNewline
        Test-CopilotSessionMatchesRepo -SessionDir $script:sess -RepoRoot $script:repo | Should -BeTrue
    }
    It "returns true when repository.txt matches the supplied origin URL" {
        Set-Content -LiteralPath (Join-Path $script:sess "repository.txt") -Value "https://github.com/Acme/widget.git" -NoNewline
        Test-CopilotSessionMatchesRepo -SessionDir $script:sess -RepoRoot $script:repo -OriginUrl "https://github.com/Acme/widget.git" | Should -BeTrue
    }
    It "returns false when neither cwd nor repository matches" {
        Set-Content -LiteralPath (Join-Path $script:sess "cwd.txt") -Value "C:\nope\else" -NoNewline
        Test-CopilotSessionMatchesRepo -SessionDir $script:sess -RepoRoot $script:repo | Should -BeFalse
    }
    It "returns false when no metadata is present (conservative default)" {
        Test-CopilotSessionMatchesRepo -SessionDir $script:sess -RepoRoot $script:repo | Should -BeFalse
    }
}

Describe "Invoke-ConsolidateTasks -- in-repo legacy moves" {
    BeforeEach {
        $script:repo = Join-Path $TestDrive "consumer"
        if (Test-Path $script:repo) { Remove-Item -Recurse -Force $script:repo }
        New-FakeConsumerRepo -Root $script:repo
        New-Item -ItemType Directory -Path (Join-Path $script:repo "tasks") -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:repo "docs/prd") -Force | Out-Null
        # Legacy tasks/ sources: split by -prd / -plan suffix into the new docs structure.
        Set-Content -LiteralPath (Join-Path $script:repo "tasks/2026-05-12-alpha-plan.md") -Value "PLAN-ALPHA Closes #7"
        Set-Content -LiteralPath (Join-Path $script:repo "tasks/gamma-prd.md") -Value "PRD-GAMMA"
        # Legacy docs/prd source.
        Set-Content -LiteralPath (Join-Path $script:repo "docs/prd/beta-prd.md") -Value "PRD-BETA"
        # Root doc source.
        Set-Content -LiteralPath (Join-Path $script:repo "PRD.md") -Value "ROOT-PRD"
        Push-Location $script:repo
        try {
            & git add -A
            & git commit --quiet -m "seed legacy sources"
        }
        finally { Pop-Location }
    }

    It "with -WhatIf, plans actions and writes nothing to disk" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -IncludeDocsPrd -IncludeRootDocs -LinkIssues -WhatIf
        $records.Count | Should -BeGreaterOrEqual 4
        ($records | Where-Object { $_.Note -eq "planned (WhatIf)" }).Count | Should -BeGreaterOrEqual 4
        Test-Path (Join-Path $script:repo "tasks/2026-05-12-alpha-plan.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/prd/beta-prd.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "PRD.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/designs/2026-05-12-alpha-plan.md") | Should -BeFalse
        Test-Path (Join-Path $script:repo "docs/MIGRATION.md") | Should -BeFalse
    }

    It "keeps a dated source's date on the destination name and leaves undated names alone (#174)" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -Confirm:$false | Out-Null
        Test-Path (Join-Path $script:repo "docs/designs/2026-05-12-alpha-plan.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/designs/alpha-plan.md") | Should -BeFalse
        Test-Path (Join-Path $script:repo "docs/specs/gamma-prd.md") | Should -BeTrue
    }

    It "records each source's date and lists manifest rows oldest first (#174)" {
        # Discovery order is alphabetical: alpha (2026-05-12) is found before
        # omega, an undated plan first committed in 2020.
        Set-Content -LiteralPath (Join-Path $script:repo "tasks/omega-plan.md") -Value "PLAN-OMEGA"
        Invoke-GitCommitAt -Root $script:repo -Date "2020-01-01" -Message "add an older undated plan"
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -Confirm:$false
        ($records | Where-Object { $_.Source -eq "tasks/omega-plan.md" }).SourceDate | Should -Be "2020-01-01"
        ($records | Where-Object { $_.Source -eq "tasks/2026-05-12-alpha-plan.md" }).SourceDate | Should -Be "2026-05-12"
        $rows = @(Get-Content -LiteralPath (Join-Path $script:repo "docs/MIGRATION.md") | Where-Object { $_ -match '`tasks/' })
        $rows[0] | Should -Match "omega-plan\.md"
        $rows[1] | Should -Match "alpha-plan\.md"
    }

    It "with -Confirm:false, moves files via git mv (history preserved)" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -IncludeDocsPrd -IncludeRootDocs -LinkIssues -Confirm:$false
        $records.Count | Should -BeGreaterOrEqual 4
        Test-Path (Join-Path $script:repo "docs/designs/2026-05-12-alpha-plan.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/specs/gamma-prd.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/specs/beta-prd.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/specs/legacy-prd.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "tasks/2026-05-12-alpha-plan.md") | Should -BeFalse
        Test-Path (Join-Path $script:repo "PRD.md") | Should -BeFalse
        Push-Location $script:repo
        try {
            $diff = & git diff --cached --name-status -M
            ($diff | Where-Object { $_ -match "^R" }).Count | Should -BeGreaterOrEqual 4
        }
        finally { Pop-Location }
        $manifestPath = Join-Path $script:repo "docs/MIGRATION.md"
        Test-Path $manifestPath | Should -BeTrue
        $manifest = Get-Content -LiteralPath $manifestPath -Raw
        $manifest | Should -Match "# docs/ Migration Manifest"
        $manifest | Should -Match "alpha-plan.md"
    }

    It "routes prd sources to docs/specs and plan sources to docs/designs" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -IncludeDocsPrd -IncludeRootDocs -LinkIssues -Confirm:$false
        $records.Destination -join "`n" | Should -Match "docs/designs/2026-05-12-alpha-plan.md"
        $records.Destination -join "`n" | Should -Match "docs/specs/gamma-prd.md"
        $records.Destination -join "`n" | Should -Match "docs/specs/beta-prd.md"
        $records.Destination -join "`n" | Should -Match "docs/specs/legacy-prd.md"
    }

    It "captures linked issue numbers (Closes #7) in records" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -LinkIssues -Confirm:$false
        $alpha = $records | Where-Object { $_.Destination -match "alpha-plan" }
        $alpha.LinkedIssues | Should -Contain 7
    }

    It "is idempotent: a second run with identical source content reports skip" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -Confirm:$false | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:repo "tasks") -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $script:repo "docs/designs/2026-05-12-alpha-plan.md") -Destination (Join-Path $script:repo "tasks/2026-05-12-alpha-plan.md")
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -Confirm:$false
        $skips = $records | Where-Object { $_.Action -eq "skip" }
        @($skips).Count | Should -BeGreaterOrEqual 1
        # A re-run's manifest is ordered by skip rows too, so they carry the date.
        @($skips)[0].SourceDate | Should -Be "2026-05-12"
    }

    It "appends a sha1 suffix when destination exists with different content" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -Confirm:$false | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:repo "tasks") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:repo "tasks/2026-05-12-alpha-plan.md") -Value "DIFFERENT-CONTENT"
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeLegacyTasks -Confirm:$false
        ($records | Where-Object { $_.Destination -match "alpha-plan-[0-9a-f]{8}\.md" }).Count | Should -BeGreaterOrEqual 1
    }
}

Describe "Invoke-ConsolidateTasks -- copilot session sources" {
    BeforeEach {
        $script:repo = Join-Path $TestDrive "session-consumer"
        if (Test-Path $script:repo) { Remove-Item -Recurse -Force $script:repo }
        New-FakeConsumerRepo -Root $script:repo

        $script:sessionRoot = Join-Path $TestDrive "sessions"
        if (Test-Path $script:sessionRoot) { Remove-Item -Recurse -Force $script:sessionRoot }
        New-Item -ItemType Directory -Path $script:sessionRoot -Force | Out-Null

        $script:matchDir = Join-Path $script:sessionRoot "abcdef1234567890"
        New-Item -ItemType Directory -Path $script:matchDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:matchDir "plan.md") -Value "SESSION-PLAN"
        Set-Content -LiteralPath (Join-Path $script:matchDir "cwd.txt") -Value $script:repo -NoNewline

        $script:otherDir = Join-Path $script:sessionRoot "deadbeef00000000"
        New-Item -ItemType Directory -Path $script:otherDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:otherDir "plan.md") -Value "OTHER-REPO-PLAN"
        Set-Content -LiteralPath (Join-Path $script:otherDir "cwd.txt") -Value "C:\some\other\repo" -NoNewline
    }

    It "copies the matching session plan into docs/designs/" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false
        @($records).Count | Should -Be 1
        $records[0].Action | Should -Be "copy"
        $records[0].SourceType | Should -Be "copilot-session"
        Test-Path (Join-Path $script:repo "docs/designs/session-abcdef12-plan.md") | Should -BeTrue
    }

    It "leaves the original session plan in place (copy not move)" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false | Out-Null
        Test-Path (Join-Path $script:matchDir "plan.md") | Should -BeTrue
    }

    It "filters out sessions whose recorded repo does not match the target" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false | Out-Null
        Test-Path (Join-Path $script:repo "docs/designs/session-deadbeef-plan.md") | Should -BeFalse
    }

    It "with -WhatIf, plans copy actions and writes nothing" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -WhatIf
        @($records).Count | Should -Be 1
        $records[0].Note | Should -Be "planned (WhatIf)"
        Test-Path (Join-Path $script:repo "docs/designs/session-abcdef12-plan.md") | Should -BeFalse
    }

    It "second run is idempotent (skip on identical content)" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false | Out-Null
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false
        ($records | Where-Object { $_.Action -eq "skip" }).Count | Should -BeGreaterOrEqual 1
    }

    It "records the session plan's last-write date as its Source Date (#174)" {
        (Get-Item -LiteralPath (Join-Path $script:matchDir "plan.md")).LastWriteTimeUtc = [datetime]::new(2025, 2, 3, 12, 0, 0, [DateTimeKind]::Utc)
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false
        $records[0].SourceDate | Should -Be "2025-02-03"
    }
}

Describe "Write-MigrationManifest" {
    It "writes a well-formed markdown table" {
        $records = @(
            (New-MigrationRecord -Source "tasks/foo-plan.md" -Destination "docs/designs/foo-plan.md" -Action "move" -SourceType "legacy-tasks" -LinkedIssues @(1, 2)),
            (New-MigrationRecord -Source "~/.copilot/x/plan.md" -Destination "docs/designs/session-x-plan.md" -Action "copy" -SourceType "copilot-session")
        )
        $path = Join-Path $TestDrive "MIGRATION.md"
        Write-MigrationManifest -Path $path -Records $records
        $text = Get-Content -LiteralPath $path -Raw
        $text | Should -Match "# docs/ Migration Manifest"
        $text | Should -Match "Timestamp \(UTC\)"
        $text | Should -Match "#1 #2"
        $text | Should -Match "foo-plan.md"
        $text | Should -Match "session-x-plan.md"
    }

    It "leads with a Source Date column and lists rows oldest first, undated last (#174)" {
        $records = @(
            (New-MigrationRecord -Source "tasks/b-plan.md" -Destination "docs/designs/b-plan.md" -Action "move" -SourceType "legacy-tasks" -SourceDate "2024-02-02"),
            (New-MigrationRecord -Source "tasks/u-plan.md" -Destination "docs/designs/u-plan.md" -Action "move" -SourceType "legacy-tasks"),
            (New-MigrationRecord -Source "tasks/a-plan.md" -Destination "docs/designs/a-plan.md" -Action "move" -SourceType "legacy-tasks" -SourceDate "2021-01-01")
        )
        $path = Join-Path $TestDrive "ordered.md"
        Write-MigrationManifest -Path $path -Records $records
        $lines = Get-Content -LiteralPath $path
        $lines | Should -Contain "| Source Date | Timestamp (UTC) | Action | Source Type | Source | Destination | Linked Issues | Note |"
        $rows = @($lines | Where-Object { $_ -match '`tasks/' })
        $rows[0] | Should -Match "^\| 2021-01-01 \|.*a-plan\.md"
        $rows[1] | Should -Match "^\| 2024-02-02 \|.*b-plan\.md"
        $rows[2] | Should -Match "^\|  \|.*u-plan\.md"
    }
}