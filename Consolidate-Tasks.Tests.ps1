BeforeAll {
    . $PSScriptRoot/Consolidate-Tasks.ps1

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
}

Describe "Get-FeatureSlug" {
    It "strips a YYYY-MM-DD date prefix" {
        Get-FeatureSlug -FileName "2026-05-12-foo-plan.md" | Should -Be "foo"
    }
    It "strips a trailing -prd suffix" {
        Get-FeatureSlug -FileName "bar-prd.md" | Should -Be "bar"
    }
    It "strips a trailing -plan suffix" {
        Get-FeatureSlug -FileName "baz-plan.md" | Should -Be "baz"
    }
    It "handles both date prefix and -plan suffix" {
        Get-FeatureSlug -FileName "2025-01-01-qux-plan.md" | Should -Be "qux"
    }
    It "returns the stem unchanged when no prefix/suffix matches" {
        Get-FeatureSlug -FileName "raw-name.md" | Should -Be "raw-name"
    }
    It "returns untitled for an effectively empty stem" {
        Get-FeatureSlug -FileName "-plan.md" | Should -Be "untitled"
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
        New-Item -ItemType Directory -Path (Join-Path $script:repo "docs/designs") -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:repo "docs/prd") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:repo "docs/designs/2026-05-12-alpha-plan.md") -Value "PLAN-ALPHA Closes #7"
        Set-Content -LiteralPath (Join-Path $script:repo "docs/prd/beta-prd.md") -Value "PRD-BETA"
        Set-Content -LiteralPath (Join-Path $script:repo "PRD.md") -Value "ROOT-PRD"
        Push-Location $script:repo
        try {
            & git add -A
            & git commit --quiet -m "seed legacy sources"
        }
        finally { Pop-Location }
    }

    It "with -WhatIf, plans actions and writes nothing to disk" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -IncludeDocsPrd -IncludeRootDocs -LinkIssues -WhatIf
        $records.Count | Should -BeGreaterOrEqual 3
        ($records | Where-Object { $_.Note -eq "planned (WhatIf)" }).Count | Should -BeGreaterOrEqual 3
        Test-Path (Join-Path $script:repo "docs/designs/2026-05-12-alpha-plan.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/prd/beta-prd.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "PRD.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "tasks/alpha-plan.md") | Should -BeFalse
        Test-Path (Join-Path $script:repo "tasks/MIGRATION.md") | Should -BeFalse
    }

    It "with -Confirm:false, moves files via git mv (history preserved)" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -IncludeDocsPrd -IncludeRootDocs -LinkIssues -Confirm:$false
        $records.Count | Should -BeGreaterOrEqual 3
        Test-Path (Join-Path $script:repo "tasks/alpha-plan.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "tasks/beta-prd.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "tasks/legacy-prd.md") | Should -BeTrue
        Test-Path (Join-Path $script:repo "docs/designs/2026-05-12-alpha-plan.md") | Should -BeFalse
        Test-Path (Join-Path $script:repo "PRD.md") | Should -BeFalse
        Push-Location $script:repo
        try {
            $diff = & git diff --cached --name-status -M
            ($diff | Where-Object { $_ -match "^R" }).Count | Should -BeGreaterOrEqual 3
        }
        finally { Pop-Location }
        $manifestPath = Join-Path $script:repo "tasks/MIGRATION.md"
        Test-Path $manifestPath | Should -BeTrue
        $manifest = Get-Content -LiteralPath $manifestPath -Raw
        $manifest | Should -Match "# tasks/ Migration Manifest"
        $manifest | Should -Match "alpha-plan.md"
    }

    It "normalizes docs/designs date prefixes and docs/prd suffix conventions" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -IncludeDocsPrd -IncludeRootDocs -LinkIssues -Confirm:$false
        $records.Destination -join "`n" | Should -Match "tasks/alpha-plan.md"
        $records.Destination -join "`n" | Should -Match "tasks/beta-prd.md"
        $records.Destination -join "`n" | Should -Match "tasks/legacy-prd.md"
    }

    It "captures linked issue numbers (Closes #7) in records" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -LinkIssues -Confirm:$false
        $alpha = $records | Where-Object { $_.Destination -match "alpha-plan" }
        $alpha.LinkedIssues | Should -Contain 7
    }

    It "is idempotent: a second run with identical source content reports skip" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -Confirm:$false | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:repo "docs/designs") -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $script:repo "tasks/alpha-plan.md") -Destination (Join-Path $script:repo "docs/designs/alpha-plan.md")
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -Confirm:$false
        $skips = $records | Where-Object { $_.Action -eq "skip" }
        @($skips).Count | Should -BeGreaterOrEqual 1
    }

    It "appends a sha1 suffix when destination exists with different content" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -Confirm:$false | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:repo "docs/designs") -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:repo "docs/designs/alpha-plan.md") -Value "DIFFERENT-CONTENT"
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeDocsDesigns -Confirm:$false
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

    It "copies the matching session plan into tasks/" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false
        @($records).Count | Should -Be 1
        $records[0].Action | Should -Be "copy"
        $records[0].SourceType | Should -Be "copilot-session"
        Test-Path (Join-Path $script:repo "tasks/session-abcdef12-plan.md") | Should -BeTrue
    }

    It "leaves the original session plan in place (copy not move)" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false | Out-Null
        Test-Path (Join-Path $script:matchDir "plan.md") | Should -BeTrue
    }

    It "filters out sessions whose recorded repo does not match the target" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false | Out-Null
        Test-Path (Join-Path $script:repo "tasks/session-deadbeef-plan.md") | Should -BeFalse
    }

    It "with -WhatIf, plans copy actions and writes nothing" {
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -WhatIf
        @($records).Count | Should -Be 1
        $records[0].Note | Should -Be "planned (WhatIf)"
        Test-Path (Join-Path $script:repo "tasks/session-abcdef12-plan.md") | Should -BeFalse
    }

    It "second run is idempotent (skip on identical content)" {
        Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false | Out-Null
        $records = Invoke-ConsolidateTasks -RepoRoot $script:repo -IncludeCopilotSessions -CopilotSessionRoot $script:sessionRoot -Confirm:$false
        ($records | Where-Object { $_.Action -eq "skip" }).Count | Should -BeGreaterOrEqual 1
    }
}

Describe "Write-MigrationManifest" {
    It "writes a well-formed markdown table" {
        $records = @(
            (New-MigrationRecord -Source "docs/designs/foo.md" -Destination "tasks/foo-plan.md" -Action "move" -SourceType "docs/designs" -LinkedIssues @(1, 2)),
            (New-MigrationRecord -Source "~/.copilot/x/plan.md" -Destination "tasks/session-x-plan.md" -Action "copy" -SourceType "copilot-session")
        )
        $path = Join-Path $TestDrive "MIGRATION.md"
        Write-MigrationManifest -Path $path -Records $records
        $text = Get-Content -LiteralPath $path -Raw
        $text | Should -Match "# tasks/ Migration Manifest"
        $text | Should -Match "Timestamp \(UTC\)"
        $text | Should -Match "#1 #2"
        $text | Should -Match "foo-plan.md"
        $text | Should -Match "session-x-plan.md"
    }
}