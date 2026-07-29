BeforeAll {
    . $PSScriptRoot/Pull-SDLC.ai.ps1
}

Describe 'Test-IsUpstreamRepo' {
    It 'returns $true for the upstream HTTPS URL' {
        Test-IsUpstreamRepo -RemoteUrl 'https://github.com/IntelliTect-Dev/IntelliSDLC.ai.git' | Should -BeTrue
    }

    It 'returns $true for the upstream SSH URL' {
        Test-IsUpstreamRepo -RemoteUrl 'git@github.com:IntelliTect-Dev/IntelliSDLC.ai.git' | Should -BeTrue
    }

    It 'returns $true with no .git suffix' {
        Test-IsUpstreamRepo -RemoteUrl 'https://github.com/IntelliTect-Dev/IntelliSDLC.ai' | Should -BeTrue
    }

    It 'returns $false for a consumer repo' {
        Test-IsUpstreamRepo -RemoteUrl 'https://github.com/SomeOrg/SomeProject.git' | Should -BeFalse
    }

    It 'returns $false for an empty URL' {
        Test-IsUpstreamRepo -RemoteUrl '' | Should -BeFalse
    }
}

Describe 'ConvertTo-GitHubRepoSlug' {
    It 'parses an HTTPS URL with .git suffix' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'https://github.com/MarkMichaelis/PSBitwarden.git' |
            Should -Be 'MarkMichaelis/PSBitwarden'
    }

    It 'parses an HTTPS URL without .git suffix' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'https://github.com/Owner/Repo' |
            Should -Be 'Owner/Repo'
    }

    It 'parses an SSH URL' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'git@github.com:Owner/Repo.git' |
            Should -Be 'Owner/Repo'
    }

    It 'parses an SSH URL with ssh.github.com host alias' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'git@ssh.github.com:MarkMichaelis/PSBitwarden.git' |
            Should -Be 'MarkMichaelis/PSBitwarden'
    }

    It 'parses an ssh:// URL' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'ssh://git@github.com/Owner/Repo.git' |
            Should -Be 'Owner/Repo'
    }

    It 'returns $null for an empty URL' {
        ConvertTo-GitHubRepoSlug -RemoteUrl '' | Should -BeNullOrEmpty
    }

    It 'returns $null for a non-GitHub URL' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'https://gitlab.com/Owner/Repo.git' |
            Should -BeNullOrEmpty
    }

    It 'matches the scheme and host case-insensitively while preserving owner/repo casing' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'https://GitHub.com/MarkMichaelis/PSBitwarden.git' |
            Should -Be 'MarkMichaelis/PSBitwarden'
        ConvertTo-GitHubRepoSlug -RemoteUrl 'git@SSH.GitHub.com:MarkMichaelis/PSBitwarden.git' |
            Should -Be 'MarkMichaelis/PSBitwarden'
        ConvertTo-GitHubRepoSlug -RemoteUrl 'SSH://git@GitHub.com/Owner/Repo.git' |
            Should -Be 'Owner/Repo'
    }
}

Describe 'Resolve-OpenSyncPRAction' {
    It 'returns Skip with a push remediation when origin lacks the protected branch' {
        $plan = Resolve-OpenSyncPRAction -RemoteHasProtectedBranch $false `
            -ProtectedBranch 'main' `
            -OriginUrl 'git@github.com:MarkMichaelis/PSBitwarden.git'
        $plan.Action     | Should -Be 'Skip'
        $plan.Reason     | Should -Match "no 'main' branch"
        $plan.Reason     | Should -Match 'git push -u origin main'
        $plan.GhRepoArgs | Should -BeNullOrEmpty
    }

    It 'returns Proceed with --repo args derived from a GitHub origin URL' {
        $plan = Resolve-OpenSyncPRAction -RemoteHasProtectedBranch $true `
            -ProtectedBranch 'main' `
            -OriginUrl 'https://github.com/MarkMichaelis/PSBitwarden.git'
        $plan.Action                   | Should -Be 'Proceed'
        $plan.Reason                   | Should -BeNullOrEmpty
        ($plan.GhRepoArgs -join ' ')   | Should -Be '--repo MarkMichaelis/PSBitwarden'
    }

    It 'returns Proceed with --repo derived from an ssh.github.com host alias' {
        $plan = Resolve-OpenSyncPRAction -RemoteHasProtectedBranch $true `
            -ProtectedBranch 'main' `
            -OriginUrl 'git@ssh.github.com:MarkMichaelis/PSBitwarden.git'
        $plan.Action                   | Should -Be 'Proceed'
        ($plan.GhRepoArgs -join ' ')   | Should -Be '--repo MarkMichaelis/PSBitwarden'
    }

    It 'returns Proceed with empty GhRepoArgs when origin URL is not a GitHub URL' {
        $plan = Resolve-OpenSyncPRAction -RemoteHasProtectedBranch $true `
            -ProtectedBranch 'main' `
            -OriginUrl 'https://gitlab.com/Owner/Repo.git'
        $plan.Action     | Should -Be 'Proceed'
        $plan.GhRepoArgs | Should -BeNullOrEmpty
    }

    It 'returns Proceed with empty GhRepoArgs when origin URL is empty' {
        $plan = Resolve-OpenSyncPRAction -RemoteHasProtectedBranch $true `
            -ProtectedBranch 'main' `
            -OriginUrl ''
        $plan.Action     | Should -Be 'Proceed'
        $plan.GhRepoArgs | Should -BeNullOrEmpty
    }
}

Describe 'Resolve-RemoteHasProtectedBranch (issue #204)' {
    It 'returns $true when ls-remote succeeded and reported the exact branch' {
        $out = "abc123`trefs/heads/main`n"
        Resolve-RemoteHasProtectedBranch -LsRemoteOutput $out -LsRemoteSucceeded $true `
            -HasLocalTrackingRef $false -ProtectedBranch 'main' | Should -BeTrue
    }

    It 'returns $false when ls-remote succeeded but the branch is genuinely absent (first push case)' {
        Resolve-RemoteHasProtectedBranch -LsRemoteOutput '' -LsRemoteSucceeded $true `
            -HasLocalTrackingRef $false -ProtectedBranch 'main' | Should -BeFalse
    }

    It 'returns $true when ls-remote FAILED but a local origin/<branch> tracking ref exists (the reported false-negative)' {
        # The reported bug: a transient ls-remote/SSH failure returns empty output;
        # the local tracking ref proves origin/main exists, so we must not skip.
        Resolve-RemoteHasProtectedBranch -LsRemoteOutput '' -LsRemoteSucceeded $false `
            -HasLocalTrackingRef $true -ProtectedBranch 'main' | Should -BeTrue
    }

    It 'returns $true when ls-remote FAILED and there is no tracking ref (cannot determine -> do not false-block)' {
        Resolve-RemoteHasProtectedBranch -LsRemoteOutput '' -LsRemoteSucceeded $false `
            -HasLocalTrackingRef $false -ProtectedBranch 'main' | Should -BeTrue
    }

    It 'returns $true when ls-remote succeeded with no match but a local tracking ref exists' {
        Resolve-RemoteHasProtectedBranch -LsRemoteOutput '' -LsRemoteSucceeded $true `
            -HasLocalTrackingRef $true -ProtectedBranch 'main' | Should -BeTrue
    }

    It 'does not let a glob-spoof refs/heads/release/main count as main' {
        $out = "abc123`trefs/heads/release/main`n"
        Resolve-RemoteHasProtectedBranch -LsRemoteOutput $out -LsRemoteSucceeded $true `
            -HasLocalTrackingRef $false -ProtectedBranch 'main' | Should -BeFalse
    }
}

Describe 'Test-LsRemoteOutputHasExactBranch' {
    It 'returns $true when the output contains the exact refs/heads/<branch>' {
        $out = "abc123`trefs/heads/main`n"
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $out -BranchName 'main' | Should -BeTrue
    }

    It 'returns $false when the output is empty' {
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput '' -BranchName 'main' | Should -BeFalse
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $null -BranchName 'main' | Should -BeFalse
    }

    It 'returns $false for a glob-spoof refs/heads/release/main when asked for main' {
        # Regression guard: a naive [bool]$lsRemoteOutput check would let
        # `git ls-remote --heads origin main` matching refs/heads/release/main
        # bypass the missing-base-branch preflight.
        $out = "abc123`trefs/heads/release/main`n"
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $out -BranchName 'main' | Should -BeFalse
    }

    It 'returns $false for refs/heads/main-old when asked for main' {
        $out = "abc123`trefs/heads/main-old`n"
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $out -BranchName 'main' | Should -BeFalse
    }

    It 'returns $true for an exact match even when other near-misses are also present' {
        $out = "deadbeef`trefs/heads/release/main`nabc123`trefs/heads/main`ncafef00d`trefs/heads/main-old`n"
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $out -BranchName 'main' | Should -BeTrue
    }

    It 'handles CRLF line endings from Windows git output' {
        $out = "abc123`trefs/heads/main`r`n"
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $out -BranchName 'main' | Should -BeTrue
    }

    It 'is case-sensitive: refs/heads/Main is not a match for branch main' {
        # Git ref names are case-sensitive but PowerShell -eq is case-insensitive
        # by default; the helper must use -ceq so refs/heads/Main does not bypass
        # the missing-base-branch guard for protected branch "main".
        $out = "abc123`trefs/heads/Main`n"
        Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $out -BranchName 'main' | Should -BeFalse
    }
}

Describe 'Test-IsAlwaysLocalPath' {
    It 'returns $true for README.md' {
        Test-IsAlwaysLocalPath -Path 'README.md' | Should -BeTrue
    }

    It 'returns $true for readme.md (case-insensitive)' {
        Test-IsAlwaysLocalPath -Path 'readme.md' | Should -BeTrue
    }

    It 'returns $false for .gitignore (moved to merge-paths)' {
        Test-IsAlwaysLocalPath -Path '.gitignore' | Should -BeFalse
    }

    It 'returns $false for src/Foo.cs' {
        Test-IsAlwaysLocalPath -Path 'src/Foo.cs' | Should -BeFalse
    }

    It 'returns $false for CLAUDE.md' {
        Test-IsAlwaysLocalPath -Path 'CLAUDE.md' | Should -BeFalse
    }

    It 'returns $false for an empty path' {
        Test-IsAlwaysLocalPath -Path '' | Should -BeFalse
    }

    It 'tolerates a leading ./ on the path' {
        Test-IsAlwaysLocalPath -Path './README.md' | Should -BeTrue
    }

    It 'tolerates a leading .\ (backslash) on the path' {
        Test-IsAlwaysLocalPath -Path '.\README.md' | Should -BeTrue
    }

    It 'returns $true for docs/specs/ directory itself' {
        Test-IsAlwaysLocalPath -Path 'docs/specs/' | Should -BeTrue
    }

    It 'returns $true for a PRD under docs/specs/ (prefix match)' {
        Test-IsAlwaysLocalPath -Path 'docs/specs/foo-prd.md' | Should -BeTrue
    }

    It 'returns $true for docs/designs/ directory itself' {
        Test-IsAlwaysLocalPath -Path 'docs/designs/' | Should -BeTrue
    }

    It 'returns $true for a plan under docs/designs/ (prefix match)' {
        Test-IsAlwaysLocalPath -Path 'docs/designs/bar-plan.md' | Should -BeTrue
    }

    It 'returns $true for a nested path under docs/specs/' {
        Test-IsAlwaysLocalPath -Path 'docs/specs/archive/2025/old-prd.md' | Should -BeTrue
    }

    It 'returns $true for docs/README.md (the scaffolded consumer-owned file)' {
        Test-IsAlwaysLocalPath -Path 'docs/README.md' | Should -BeTrue
    }

    It 'returns $false for an unrelated file directly under docs/ (only specs/designs/README are consumer-owned)' {
        Test-IsAlwaysLocalPath -Path 'docs/whatever.md' | Should -BeFalse
    }

    It 'returns $false for any hypothetical *.template file under docs/designs/ (carve-out keeps templates upstream-managed)' {
        Test-IsAlwaysLocalPath -Path 'docs/designs/some-future.template' | Should -BeFalse
    }

    It 'returns $false for docs/specs/.gitkeep (directory anchor flows from upstream)' {
        Test-IsAlwaysLocalPath -Path 'docs/specs/.gitkeep' | Should -BeFalse
    }

    It 'does not match a path that merely starts with the letters "docs" but is not a consumer-owned directory' {
        Test-IsAlwaysLocalPath -Path 'docsy.md' | Should -BeFalse
        Test-IsAlwaysLocalPath -Path 'src/docs-runner.cs' | Should -BeFalse
    }

    It 'returns $true for a consumer-owned skill under a .github/skills/project-* directory (issue #214)' {
        Test-IsAlwaysLocalPath -Path '.github/skills/project-foo/SKILL.md' | Should -BeTrue
    }

    It 'returns $false for a bare .github/skills/project/ directory (only the hyphenated project- form is consumer-owned) (issue #214)' {
        Test-IsAlwaysLocalPath -Path '.github/skills/project/SKILL.md' | Should -BeFalse
    }

    It 'returns $true for a nested supporting file under a project-* skill (issue #214)' {
        Test-IsAlwaysLocalPath -Path '.github/skills/project-foo/scripts/helper.ps1' | Should -BeTrue
    }

    It 'returns $false for a shared upstream skill (issue #214)' {
        Test-IsAlwaysLocalPath -Path '.github/skills/behavior-first-testing/SKILL.md' | Should -BeFalse
    }

    It 'returns $false for a skill whose name merely starts with the letters "project" but not the "project-" prefix (issue #214)' {
        Test-IsAlwaysLocalPath -Path '.github/skills/projectile/SKILL.md' | Should -BeFalse
    }

    It 'returns $false for a *.template under a project-* skill (upstream can still scaffold a starter) (issue #214)' {
        Test-IsAlwaysLocalPath -Path '.github/skills/project-example/SKILL.md.template' | Should -BeFalse
    }

    It 'returns $false for .gitkeep under a project-* skill (directory anchor flows from upstream) (issue #214)' {
        Test-IsAlwaysLocalPath -Path '.github/skills/project-example/.gitkeep' | Should -BeFalse
    }

    It 'returns $true for run.ps1, run.Tests.ps1, and copilot-setup-steps.yml (consumer-owned, issue #222)' {
        Test-IsAlwaysLocalPath -Path 'run.ps1' | Should -BeTrue
        Test-IsAlwaysLocalPath -Path 'run.Tests.ps1' | Should -BeTrue
        Test-IsAlwaysLocalPath -Path '.github/workflows/copilot-setup-steps.yml' | Should -BeTrue
    }
}

Describe 'Resolve-AlwaysLocalConflicts (removed)' {
    It 'is no longer exported (subsumed by always-local op filter in diff-replay)' {
        Get-Command Resolve-AlwaysLocalConflicts -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-TemplateScaffold' {
    BeforeEach {
        $script:src = Join-Path $TestDrive 'src'
        $script:dst = Join-Path $TestDrive 'dst'
        # Clean prior test state -- TestDrive may persist within the Describe.
        if (Test-Path $script:src) { Remove-Item -Recurse -Force $script:src }
        if (Test-Path $script:dst) { Remove-Item -Recurse -Force $script:dst }
        New-Item -ItemType Directory -Path $script:src -Force | Out-Null
        New-Item -ItemType Directory -Path $script:dst -Force | Out-Null

        # Two templates the scaffolder should know about.
        New-Item -ItemType Directory -Path (Join-Path $script:src '.github/instructions') -Force | Out-Null
        Set-Content -Path (Join-Path $script:src '.github/instructions/project.instructions.md.template') -Value 'PROJECT_TEMPLATE_BODY'
        Set-Content -Path (Join-Path $script:src 'CLAUDE.project.md.template') -Value 'CLAUDE_TEMPLATE_BODY'

        $script:map = [ordered]@{
            '.github/instructions/project.instructions.md.template' = '.github/instructions/project.instructions.md'
            'CLAUDE.project.md.template'                            = 'CLAUDE.project.md'
        }
    }

    It 'creates both bare-named files when neither exists' {
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        $result.Count | Should -Be 2
        Test-Path (Join-Path $script:dst '.github/instructions/project.instructions.md') | Should -BeTrue
        Test-Path (Join-Path $script:dst 'CLAUDE.project.md') | Should -BeTrue
    }

    It 'copies template content verbatim' {
        Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map | Out-Null
        (Get-Content (Join-Path $script:dst 'CLAUDE.project.md') -Raw).Trim() | Should -Be 'CLAUDE_TEMPLATE_BODY'
    }

    It 'creates intermediate directories when missing' {
        Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map | Out-Null
        Test-Path (Join-Path $script:dst '.github/instructions') | Should -BeTrue
    }

    It 'never overwrites an existing target file' {
        $existing = Join-Path $script:dst 'CLAUDE.project.md'
        Set-Content -Path $existing -Value 'CONSUMER_OWN_CONTENT'

        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        # Only the other template should have been scaffolded.
        $result.Count | Should -Be 1
        $result | Should -Not -Contain 'CLAUDE.project.md'
        (Get-Content $existing -Raw).Trim() | Should -Be 'CONSUMER_OWN_CONTENT'
    }

    It 'returns an empty array when all targets already exist' {
        Set-Content -Path (Join-Path $script:dst 'CLAUDE.project.md') -Value 'X'
        New-Item -ItemType Directory -Path (Join-Path $script:dst '.github/instructions') -Force | Out-Null
        Set-Content -Path (Join-Path $script:dst '.github/instructions/project.instructions.md') -Value 'X'

        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        $result.Count | Should -Be 0
    }

    It 'silently skips entries whose template is missing in source' {
        Remove-Item (Join-Path $script:src 'CLAUDE.project.md.template') -Force
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:src -TargetRoot $script:dst -ScaffoldMap $script:map)
        $result.Count | Should -Be 1
        $result[0] | Should -Be '.github/instructions/project.instructions.md'
    }
}

Describe 'Invoke-TemplateScaffold same-name scaffold from git ref (issue #156)' {
    BeforeEach {
        # Build a tiny upstream-style git repo containing docs/README.md so we
        # can verify the function pulls same-name scaffold content from a ref
        # rather than from the working tree. SourceRoot doubles as the repo
        # passed to `git -C` for the `git show` lookup.
        $script:srcRepo = Join-Path $TestDrive ("samename-src-" + [guid]::NewGuid().ToString('N'))
        $script:dstRoot = Join-Path $TestDrive ("samename-dst-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:srcRepo, $script:dstRoot -Force | Out-Null

        Push-Location $script:srcRepo
        try {
            git init -q -b main
            git config user.email t@t.t
            git config user.name t
            New-Item -ItemType Directory -Path docs -Force | Out-Null
            'UPSTREAM_DOCS_README_BODY' | Out-File -Encoding utf8 docs/README.md -NoNewline
            # Also seed the issue #222 consumer-owned scaffolded files.
            'UPSTREAM_RUN_PS1_BODY' | Out-File -Encoding utf8 run.ps1 -NoNewline
            'UPSTREAM_RUN_TESTS_BODY' | Out-File -Encoding utf8 run.Tests.ps1 -NoNewline
            New-Item -ItemType Directory -Path .github/workflows -Force | Out-Null
            'UPSTREAM_SETUP_YML_BODY' | Out-File -Encoding utf8 .github/workflows/copilot-setup-steps.yml -NoNewline
            git add -A | Out-Null
            git commit -q -m 'seed'
        } finally { Pop-Location }

        $script:samenameMap = [ordered]@{ 'docs/README.md' = 'docs/README.md' }
    }

    It 'reads upstream content via git show Ref colon path when source equals target and target is missing' {
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:srcRepo -TargetRoot $script:dstRoot -ScaffoldMap $script:samenameMap -Ref HEAD)
        $result | Should -Contain 'docs/README.md'
        $written = Join-Path $script:dstRoot 'docs/README.md'
        Test-Path $written | Should -BeTrue
        (Get-Content $written -Raw).Trim() | Should -Be 'UPSTREAM_DOCS_README_BODY'
    }

    It 'leaves an existing consumer same-name target untouched (consumer edits preserved)' {
        New-Item -ItemType Directory -Path (Join-Path $script:dstRoot 'docs') -Force | Out-Null
        Set-Content -Path (Join-Path $script:dstRoot 'docs/README.md') -Value 'CONSUMER_EDITED_BODY'

        $result = @(Invoke-TemplateScaffold -SourceRoot $script:srcRepo -TargetRoot $script:dstRoot -ScaffoldMap $script:samenameMap -Ref HEAD)
        $result.Count | Should -Be 0
        (Get-Content (Join-Path $script:dstRoot 'docs/README.md') -Raw).Trim() | Should -Be 'CONSUMER_EDITED_BODY'
    }

    It 'skips silently when -Ref is omitted and the same-name source is absent from the working tree' {
        # Mirrors the "no ref provided" call path used by unit tests of the
        # other three template entries; same-name scaffold should be a no-op
        # rather than throwing.
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:dstRoot -TargetRoot $script:dstRoot -ScaffoldMap $script:samenameMap)
        $result.Count | Should -Be 0
        Test-Path (Join-Path $script:dstRoot 'docs/README.md') | Should -BeFalse
    }

    It 'scaffolds run.ps1, run.Tests.ps1, and copilot-setup-steps.yml same-name from the upstream ref when missing (issue #222)' {
        $map = [ordered]@{
            'run.ps1'                                   = 'run.ps1'
            'run.Tests.ps1'                             = 'run.Tests.ps1'
            '.github/workflows/copilot-setup-steps.yml' = '.github/workflows/copilot-setup-steps.yml'
        }
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:srcRepo -TargetRoot $script:dstRoot -ScaffoldMap $map -Ref HEAD)
        $result | Should -Contain 'run.ps1'
        $result | Should -Contain 'run.Tests.ps1'
        $result | Should -Contain '.github/workflows/copilot-setup-steps.yml'
        (Get-Content (Join-Path $script:dstRoot 'run.ps1') -Raw).Trim() | Should -Be 'UPSTREAM_RUN_PS1_BODY'
        (Get-Content (Join-Path $script:dstRoot 'run.Tests.ps1') -Raw).Trim() | Should -Be 'UPSTREAM_RUN_TESTS_BODY'
        (Get-Content (Join-Path $script:dstRoot '.github/workflows/copilot-setup-steps.yml') -Raw).Trim() | Should -Be 'UPSTREAM_SETUP_YML_BODY'
    }

    It 'leaves an existing consumer-customized run.ps1 untouched (issue #222)' {
        Set-Content -Path (Join-Path $script:dstRoot 'run.ps1') -Value 'CONSUMER_CUSTOMIZED_RUN' -NoNewline
        $map = [ordered]@{ 'run.ps1' = 'run.ps1' }
        $result = @(Invoke-TemplateScaffold -SourceRoot $script:srcRepo -TargetRoot $script:dstRoot -ScaffoldMap $map -Ref HEAD)
        $result.Count | Should -Be 0
        (Get-Content (Join-Path $script:dstRoot 'run.ps1') -Raw).Trim() | Should -Be 'CONSUMER_CUSTOMIZED_RUN'
    }
}

Describe '.gitattributes.template removal (issue #167)' {
    BeforeAll {
        $script:upstreamRoot = Resolve-Path (Join-Path $PSScriptRoot '.') | Select-Object -ExpandProperty Path
    }

    It '$script:TemplateScaffoldMap no longer maps .gitattributes.template' {
        $script:TemplateScaffoldMap.Keys | Should -Not -Contain '.gitattributes.template'
    }

    It '.gitattributes is no longer scaffolded by Pull-SDLC (owned by Initialize-GitDefaults.ps1)' {
        $script:TemplateScaffoldMap.Values | Should -Not -Contain '.gitattributes'
    }

    It '.gitattributes.template file is absent from the upstream repo root' {
        Test-Path -LiteralPath (Join-Path $script:upstreamRoot '.gitattributes.template') | Should -BeFalse
    }

    It '.gitattributes.template is not in the upstream-managed path list' {
        Test-IsUpstreamManagedPath -Path '.gitattributes.template' | Should -BeFalse
    }

    It '.gitattributes remains on the always-local list (consumer-owned, never touched by sync)' {
        Test-IsAlwaysLocalPath -Path '.gitattributes' | Should -BeTrue
    }
}
Describe 'README.md.template bootstrap (issue #158)' {
    BeforeAll {
        $script:rmRepoRoot = Resolve-Path (Join-Path $PSScriptRoot '.') | Select-Object -ExpandProperty Path
    }

    It '$script:TemplateScaffoldMap maps README.md.template -> README.md' {
        $script:TemplateScaffoldMap.Keys | Should -Contain 'README.md.template'
        $script:TemplateScaffoldMap['README.md.template'] | Should -Be 'README.md'
    }

    It 'README.md.template exists at upstream repo root' {
        Test-Path -LiteralPath (Join-Path $script:rmRepoRoot 'README.md.template') | Should -BeTrue
    }

    It 'README.md is on the always-local list (consumer-owned once placed)' {
        Test-IsAlwaysLocalPath -Path 'README.md' | Should -BeTrue
    }

    It 'README.md.template is upstream-managed (so first-time scaffold flows from upstream)' {
        Test-IsUpstreamManagedPath -Path 'README.md.template' | Should -BeTrue
    }

    It 'creates consumer README.md on first scaffold when none exists' {
        $src = Join-Path $TestDrive 'rmt-src'
        $dst = Join-Path $TestDrive 'rmt-dst1'
        New-Item -ItemType Directory -Path $src, $dst -Force | Out-Null
        Set-Content -Path (Join-Path $src 'README.md.template') -Value 'README_TEMPLATE_BODY'
        $map = [ordered]@{ 'README.md.template' = 'README.md' }
        $result = @(Invoke-TemplateScaffold -SourceRoot $src -TargetRoot $dst -ScaffoldMap $map)
        $result | Should -Contain 'README.md'
        Test-Path (Join-Path $dst 'README.md') | Should -BeTrue
        (Get-Content (Join-Path $dst 'README.md') -Raw).Trim() | Should -Be 'README_TEMPLATE_BODY'
    }

    It 'leaves an existing consumer README.md untouched' {
        $src = Join-Path $TestDrive 'rmt-src2'
        $dst = Join-Path $TestDrive 'rmt-dst2'
        New-Item -ItemType Directory -Path $src, $dst -Force | Out-Null
        Set-Content -Path (Join-Path $src 'README.md.template') -Value 'README_TEMPLATE_BODY'
        Set-Content -Path (Join-Path $dst 'README.md')          -Value 'CONSUMER_OWNED_README'
        $map = [ordered]@{ 'README.md.template' = 'README.md' }
        $result = @(Invoke-TemplateScaffold -SourceRoot $src -TargetRoot $dst -ScaffoldMap $map)
        $result.Count | Should -Be 0
        (Get-Content (Join-Path $dst 'README.md') -Raw).Trim() | Should -Be 'CONSUMER_OWNED_README'
    }

    It 'template body carries the scaffolded-by-Pull-SDLC.ai marker comment' {
        $body = Get-Content -LiteralPath (Join-Path $script:rmRepoRoot 'README.md.template') -Raw
        $body | Should -Match 'scaffolded by Pull-SDLC\.ai on first sync'
    }

    It 'template uses H2 (not H1) for top-level sections so GitHubs auto-TOC works' {
        $body = Get-Content -LiteralPath (Join-Path $script:rmRepoRoot 'README.md.template') -Raw
        # Strip fenced code blocks before counting H1s -- a `# comment` inside a
        # ```bash fence is shell syntax, not a markdown heading.
        $stripped = [regex]::Replace($body, '(?s)```.*?```', '')
        $h1Count = ([regex]::Matches($stripped, '(?m)^#\s+')).Count
        $h1Count | Should -Be 1
        $body | Should -Match '(?m)^##\s+Overview'
        $body | Should -Match '(?m)^##\s+Quick Start'
        $body | Should -Match '(?m)^##\s+Support'
        $body | Should -Match '(?m)^##\s+License'
        $body | Should -Match '(?m)^##\s+Contributing'
    }
}

Describe 'Pull-SDLC.ai.ps1 end-to-end (regression for #26)' {
    BeforeEach {
        $script:repo = Join-Path ([System.IO.Path]::GetTempPath()) ("pull-e2e-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:repo | Out-Null
        Push-Location $script:repo
        git init -q
        git config user.email 't@t.t'
        git config user.name 't'
        git remote add origin 'https://github.com/SomeOrg/SomeProject.git'
        'seed' | Out-File -Encoding utf8 _seed.txt
        # Pre-create both scaffold targets so 0 templates get scaffolded.
        New-Item -ItemType Directory -Path .github/instructions -Force | Out-Null
        Set-Content -Path .github/instructions/project.instructions.md -Value 'existing'
        Set-Content -Path CLAUDE.project.md -Value 'existing'
        git add . | Out-Null
        git commit -q -m 'initial'
        Copy-Item (Join-Path $PSScriptRoot 'Pull-SDLC.ai.ps1') .
    }

    AfterEach {
        Pop-Location
        Remove-Item -Recurse -Force -LiteralPath $script:repo -ErrorAction SilentlyContinue
    }

    It 'does not throw "Count cannot be found" when no templates need scaffolding' {
        $stdout = Join-Path $script:repo 'out.txt'
        $stderr = Join-Path $script:repo 'err.txt'
        $proc = Start-Process pwsh -ArgumentList '-NoProfile','-NonInteractive','-File',(Join-Path $script:repo 'Pull-SDLC.ai.ps1') -WorkingDirectory $script:repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru -WindowStyle Hidden
        $combined = (Get-Content $stdout -Raw) + (Get-Content $stderr -Raw)
        $combined | Should -Not -Match "property 'Count' cannot be found"
    }
}

# --- New tests for diff-replay functionality (issue #298) ---

function global:New-DiffReplayFixture {
    <#
    .SYNOPSIS
        Builds a self-contained upstream + consumer git layout in $Root.
        - $Root\upstream is a normal repo seeded with managed paths.
        - $Root\consumer is a separate repo with $RemoteName -> upstream.
        Returns @{ Upstream; Consumer; AnchorSha; UpstreamHead }.
    .DESCRIPTION
        $Seed builds the anchor commit. $Tweak (optional) runs after the
        anchor commit and before the final commit; use it to stage adds,
        modifies, renames, deletes for the next upstream commit.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][scriptblock]$Seed,
        [scriptblock]$Tweak,
        [string]$RemoteName = 'sdlc.ai'
    )
    $upstream = Join-Path $Root 'upstream'
    $consumer = Join-Path $Root 'consumer'
    New-Item -ItemType Directory -Path $upstream -Force | Out-Null
    New-Item -ItemType Directory -Path $consumer -Force | Out-Null

    Push-Location $upstream
    try {
        git init -q -b main
        git config user.email u@u.u
        git config user.name u
        & $Seed
        git add -A | Out-Null
        git commit -q -m "anchor"
        $anchorSha = (git rev-parse HEAD).Trim()
        if ($Tweak) {
            & $Tweak
            git add -A | Out-Null
            git commit -q -m "upstream change"
        }
        $upstreamHead = (git rev-parse HEAD).Trim()
    } finally { Pop-Location }

    Push-Location $consumer
    try {
        git init -q -b main
        git config user.email c@c.c
        git config user.name c
        # Seed the consumer with the upstream anchor contents so HEAD blobs match anchor.
        & $Seed
        # Ensure README.md / .gitignore exist as consumer-owned baseline.
        if (-not (Test-Path README.md)) { 'consumer readme' | Out-File -Encoding utf8 README.md -NoNewline }
        if (-not (Test-Path .gitignore)) { '*.local' | Out-File -Encoding utf8 .gitignore -NoNewline }
        git add -A | Out-Null
        git commit -q -m "seed"
        git checkout -q -b chore/sdlc-sync
        git remote add $RemoteName $upstream
        git fetch $RemoteName --quiet 2>$null | Out-Null
    } finally { Pop-Location }

    return @{
        Upstream     = $upstream
        Consumer     = $consumer
        AnchorSha    = $anchorSha
        UpstreamHead = $upstreamHead
    }
}

Describe 'Get-UpstreamOps' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("fx-" + [guid]::NewGuid().ToString('N'))
    }

    It 'returns an A row for a newly added file under a managed path' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; 'one' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline } `
            -Tweak { 'two' | Out-File -Encoding utf8 .github/agents/b.md -NoNewline }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('CLAUDE.md','.github/copilot-instructions.md','.github/agents/','.github/skills/','.github/instructions/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Op -eq 'A' -and $_.Path -eq '.github/agents/b.md' }) | Should -Not -BeNullOrEmpty
    }

    It 'returns a D row when upstream deletes a managed file' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; 'one' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline } `
            -Tweak { Remove-Item .github/agents/a.md }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('CLAUDE.md','.github/copilot-instructions.md','.github/agents/','.github/skills/','.github/instructions/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Op -eq 'D' -and $_.Path -eq '.github/agents/a.md' }) | Should -Not -BeNullOrEmpty
    }

    It 'returns an M row when upstream modifies a managed file' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'v1' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'v2 with more content to avoid break detection threshold' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('CLAUDE.md','.github/copilot-instructions.md','.github/agents/','.github/skills/','.github/instructions/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Op -eq 'M' -and $_.Path -eq 'CLAUDE.md' }) | Should -Not -BeNullOrEmpty
    }

    It 'returns an R row for an upstream rename' {
        $body = ("aaaaaaaa`nbbbbbbbb`ncccccccc`ndddddddd`neeeeeeee`n" * 4)
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; $body | Out-File -Encoding utf8 .github/agents/old.md -NoNewline } `
            -Tweak { git mv .github/agents/old.md .github/agents/new.md }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('CLAUDE.md','.github/copilot-instructions.md','.github/agents/','.github/skills/','.github/instructions/') -RepoRoot $fx.Consumer
        $r = $ops | Where-Object { $_.Op -eq 'R' }
        $r | Should -Not -BeNullOrEmpty
        $r.OldPath | Should -Be '.github/agents/old.md'
        $r.Path    | Should -Be '.github/agents/new.md'
    }

    It 'replays the Consolidate-Tasks -> Consolidate-Specs rename as an orphan-removing op when both names are managed (issue #184)' {
        # Guards the orphan-cleanup contract: the retired filename must stay in
        # ManagedPaths so the diff-replay pathspec sees both sides and removes
        # the stale Consolidate-Tasks.ps1 from consumer trees. If the old name
        # were dropped from the pathspec, git would emit an add-only op and the
        # orphan would survive -- this test would then fail.
        $body = ("aaaaaaaa`nbbbbbbbb`ncccccccc`ndddddddd`neeeeeeee`n" * 4)
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { $body | Out-File -Encoding utf8 Consolidate-Tasks.ps1 -NoNewline } `
            -Tweak { git mv Consolidate-Tasks.ps1 Consolidate-Specs.ps1 }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('Consolidate-Tasks.ps1','Consolidate-Specs.ps1') -RepoRoot $fx.Consumer
        # The old path must be removed (either as the OldPath of a rename op or
        # as a standalone delete) and the new path must be written.
        $removesOld = $ops | Where-Object { ($_.Op -eq 'R' -and $_.OldPath -eq 'Consolidate-Tasks.ps1') -or ($_.Op -eq 'D' -and $_.Path -eq 'Consolidate-Tasks.ps1') }
        $removesOld | Should -Not -BeNullOrEmpty -Because 'the stale Consolidate-Tasks.ps1 must be removed from consumer trees'
        $writesNew = $ops | Where-Object { $_.Path -eq 'Consolidate-Specs.ps1' }
        $writesNew | Should -Not -BeNullOrEmpty -Because 'the renamed Consolidate-Specs.ps1 must be delivered'
    }

    It 'returns every managed file when called with empty anchor (bootstrap)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents -Force | Out-Null
                'x' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                'y' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline
                'z' | Out-File -Encoding utf8 .github/agents/b.md -NoNewline
            }
        $ops = Get-UpstreamOps -Anchor '' -Ref 'sdlc.ai/main' -ManagedPaths @('CLAUDE.md','.github/copilot-instructions.md','.github/agents/','.github/skills/','.github/instructions/') -RepoRoot $fx.Consumer
        $paths = $ops | ForEach-Object { $_.Path } | Sort-Object
        $paths | Should -Contain 'CLAUDE.md'
        $paths | Should -Contain '.github/agents/a.md'
        $paths | Should -Contain '.github/agents/b.md'
        ($ops | Where-Object { $_.Op -ne 'A' }) | Should -BeNullOrEmpty
    }

    It 'filters out always-local paths even when upstream changed them' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'orig readme' | Out-File -Encoding utf8 README.md -NoNewline } `
            -Tweak { 'upstream readme override' | Out-File -Encoding utf8 README.md -NoNewline }
        # Include README.md explicitly in managed paths to simulate the worst case.
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('README.md') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -eq 'README.md' }) | Should -BeNullOrEmpty
    }

    It 'filters out .github/instructions/project.instructions.md (always-local under managed prefix)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/instructions -Force | Out-Null
                'should not sync' | Out-File -Encoding utf8 .github/instructions/project.instructions.md -NoNewline
            } `
            -Tweak { 'changed upstream' | Out-File -Encoding utf8 .github/instructions/project.instructions.md -NoNewline }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('CLAUDE.md','.github/copilot-instructions.md','.github/agents/','.github/skills/','.github/instructions/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -match 'project\.instructions\.md' }) | Should -BeNullOrEmpty
    }

    It 'does not enqueue an op for a consumer-owned .github/skills/project-*/ file even when upstream changed it (issue #214)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/skills/project-foo -Force | Out-Null
                'consumer skill' | Out-File -Encoding utf8 .github/skills/project-foo/SKILL.md -NoNewline
            } `
            -Tweak { 'upstream override that must be ignored' | Out-File -Encoding utf8 .github/skills/project-foo/SKILL.md -NoNewline }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('.github/skills/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -match 'project-foo' }) | Should -BeNullOrEmpty
    }

    It 'filters out an upstream delete of a consumer-owned .github/skills/project-*/ file so consumers keep their copy (issue #214)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                # File exists at the anchor (both upstream and consumer have it)...
                New-Item -ItemType Directory -Path .github/skills/project-del -Force | Out-Null
                'skill body' | Out-File -Encoding utf8 .github/skills/project-del/SKILL.md -NoNewline
            } `
            -Tweak {
                # ...and upstream deletes it. The raw diff yields a D op, but the
                # always-local rule must drop it so the consumer's copy survives.
                Remove-Item .github/skills/project-del/SKILL.md
            }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('.github/skills/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -match 'project-del' }) | Should -BeNullOrEmpty
    }

    It 'still delivers *.template / .gitkeep scaffolds under a project-* skill from upstream (issue #214)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/skills -Force | Out-Null; 'x' | Out-File -Encoding utf8 .github/skills/anchor.md -NoNewline } `
            -Tweak {
                New-Item -ItemType Directory -Path .github/skills/project-example -Force | Out-Null
                'starter' | Out-File -Encoding utf8 .github/skills/project-example/SKILL.md.template -NoNewline
                '' | Out-File -Encoding utf8 .github/skills/project-example/.gitkeep -NoNewline
            }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('.github/skills/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -eq '.github/skills/project-example/SKILL.md.template' }) | Should -Not -BeNullOrEmpty
        ($ops | Where-Object { $_.Path -eq '.github/skills/project-example/.gitkeep' }) | Should -Not -BeNullOrEmpty
    }

    It 'does not enqueue an op for consumer-owned run.ps1 / run.Tests.ps1 / copilot-setup-steps.yml even when upstream changes them (issue #222)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                'consumer runner' | Out-File -Encoding utf8 run.ps1 -NoNewline
                'consumer runner tests' | Out-File -Encoding utf8 run.Tests.ps1 -NoNewline
                New-Item -ItemType Directory -Path .github/workflows -Force | Out-Null
                'consumer setup' | Out-File -Encoding utf8 .github/workflows/copilot-setup-steps.yml -NoNewline
            } `
            -Tweak {
                'upstream override that must be ignored' | Out-File -Encoding utf8 run.ps1 -NoNewline
                'upstream tests override' | Out-File -Encoding utf8 run.Tests.ps1 -NoNewline
                'upstream setup override' | Out-File -Encoding utf8 .github/workflows/copilot-setup-steps.yml -NoNewline
            }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('run.ps1','run.Tests.ps1','.github/workflows/copilot-setup-steps.yml') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -eq 'run.ps1' }) | Should -BeNullOrEmpty
        ($ops | Where-Object { $_.Path -eq 'run.Tests.ps1' }) | Should -BeNullOrEmpty
        ($ops | Where-Object { $_.Path -eq '.github/workflows/copilot-setup-steps.yml' }) | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-UpstreamOp' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("op-" + [guid]::NewGuid().ToString('N'))
    }

    It 'A op writes the upstream blob byte-for-byte' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'baseline' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; "hello`nworld`n" | Out-File -Encoding utf8 .github/agents/new.md -NoNewline }
        Invoke-UpstreamOp -Op @{ Op = 'A'; Path = '.github/agents/new.md'; OldPath = $null } -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        Push-Location $fx.Consumer
        try {
            $local = (git hash-object -- .github/agents/new.md).Trim()
            $upstream = (git rev-parse "sdlc.ai/main:.github/agents/new.md").Trim()
            $local | Should -Be $upstream
        } finally { Pop-Location }
    }

    It 'D op removes the local file' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; 'x' | Out-File -Encoding utf8 .github/agents/old.md -NoNewline }
        Test-Path (Join-Path $fx.Consumer '.github/agents/old.md') | Should -BeTrue
        Invoke-UpstreamOp -Op @{ Op = 'D'; Path = '.github/agents/old.md'; OldPath = $null } -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        Test-Path (Join-Path $fx.Consumer '.github/agents/old.md') | Should -BeFalse
    }

    It 'R op deletes the old path and writes the new one' {
        $body = ("aaaaaaaa`nbbbbbbbb`ncccccccc`ndddddddd`neeeeeeee`n" * 4)
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; $body | Out-File -Encoding utf8 .github/agents/old.md -NoNewline } `
            -Tweak { git mv .github/agents/old.md .github/agents/new.md }
        Invoke-UpstreamOp -Op @{ Op = 'R'; Path = '.github/agents/new.md'; OldPath = '.github/agents/old.md' } -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        Test-Path (Join-Path $fx.Consumer '.github/agents/old.md') | Should -BeFalse
        Test-Path (Join-Path $fx.Consumer '.github/agents/new.md') | Should -BeTrue
    }
}

Describe 'Invoke-PullSDLC end-to-end' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("e2e-" + [guid]::NewGuid().ToString('N'))
    }

    It 'bootstraps when no anchor is present and writes the state file + sync commit' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents -Force | Out-Null
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                'aaa' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline
            }
        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch
        $rc | Should -Be 0
        Test-Path (Join-Path $fx.Consumer '.sdlc-ai-sync.json') | Should -BeTrue
        $state = Get-Content (Join-Path $fx.Consumer '.sdlc-ai-sync.json') -Raw | ConvertFrom-Json
        $state.lastSyncCommit | Should -Be $fx.UpstreamHead
        Push-Location $fx.Consumer
        try {
            (git log -1 --pretty=%s).Trim() | Should -Match '^chore: sync IntelliSDLC\.ai to'
        } finally { Pop-Location }
    }

    It 'D row deletes the file and a rerun is a no-op' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; 'will be deleted' | Out-File -Encoding utf8 .github/agents/zap.md -NoNewline } `
            -Tweak { Remove-Item .github/agents/zap.md }
        # Seed the state file with the anchor so we don't bootstrap.
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        Test-Path (Join-Path $fx.Consumer '.github/agents/zap.md') | Should -BeFalse

        # Rerun -- no ops, no new sync commit (state already current).
        $beforeSha = $null
        Push-Location $fx.Consumer
        try { $beforeSha = (git rev-parse HEAD).Trim() } finally { Pop-Location }
        $rc2 = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc2 | Should -Be 0
        Push-Location $fx.Consumer
        try {
            $afterSha = (git rev-parse HEAD).Trim()
            # A no-op rerun must create NO commit -- not even a state-file refresh
            # that only bumps `syncedAt`. On a protected branch that stray commit
            # becomes a spurious auto-worktree PR (issue #224).
            $afterSha | Should -Be $beforeSha
        } finally { Pop-Location }
    }

    It 'does not create a commit or rewrite syncedAt on an up-to-date rerun (issue #224)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'baseline' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Record the anchor already at the upstream tip, but with a deliberately
        # OLD syncedAt so that a (buggy) unconditional rewrite to "now" would
        # produce a visible diff -> commit. With the fix, an up-to-date run must
        # leave the anchor untouched.
        $statePath = Join-Path $fx.Consumer '.sdlc-ai-sync.json'
        $stale = [ordered]@{ remote = 'sdlc.ai'; ref = 'main'; lastSyncCommit = $fx.UpstreamHead; syncedAt = '2000-01-01T00:00:00Z' }
        (($stale | ConvertTo-Json) -replace "`r`n", "`n") + "`n" | Set-Content -NoNewline -Encoding utf8 $statePath
        $beforeSha = $null
        Push-Location $fx.Consumer
        try {
            git add .sdlc-ai-sync.json | Out-Null
            git commit -q -m 'seed stale state'
            $beforeSha = (git rev-parse HEAD).Trim()
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        Push-Location $fx.Consumer
        try {
            (git rev-parse HEAD).Trim() | Should -Be $beforeSha -Because 'an up-to-date sync must not create a commit'
            (git status --porcelain) | Should -BeNullOrEmpty
        } finally { Pop-Location }
        # syncedAt preserved -> Set-SdlcSyncState was not re-run on the no-op.
        # Assert against the raw text: ConvertFrom-Json coerces ISO-8601 strings
        # into [datetime] and reformats them, which would mask an untouched file.
        (Get-Content $statePath -Raw) | Should -Match '2000-01-01T00:00:00Z'
    }

    It 'pre-flight guard aborts when an upstream-managed file has local drift' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'anchor body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'upstream new body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Consumer locally edits the managed file -- policy violation.
        'consumer override' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'CLAUDE.md') -NoNewline
        Push-Location $fx.Consumer
        try { git add CLAUDE.md; git commit -q -m 'local edit to managed file' } finally { Pop-Location }
        # Set anchor.
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 2
        # CLAUDE.md should NOT have been overwritten.
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'consumer override'
    }

    It 'does not sweep a consumer''s uncommitted run.ps1 edits into the sync commit (issue #222)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                'upstream runner' | Out-File -Encoding utf8 run.ps1 -NoNewline
            } `
            -Tweak { 'upstream claude v2 with more content to sync' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Consumer has an UNCOMMITTED local edit to its (consumer-owned) run.ps1.
        'CONSUMER UNCOMMITTED EDIT' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'run.ps1') -NoNewline
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        Push-Location $fx.Consumer
        try {
            # The sync commit updated CLAUDE.md but must NOT include run.ps1.
            $syncFiles = @(git show --name-only --pretty=format: HEAD | Where-Object { $_ })
            $syncFiles | Should -Contain 'CLAUDE.md'
            $syncFiles | Should -Not -Contain 'run.ps1' -Because 'run.ps1 is consumer-owned and must never be staged into the sync commit (issue #222)'
            # The consumer's uncommitted edit survives untouched in the working tree.
            (Get-Content run.ps1 -Raw).Trim() | Should -Be 'CONSUMER UNCOMMITTED EDIT'
        } finally { Pop-Location }
    }

    It '-Force bypasses the pre-flight guard and overwrites' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'anchor body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'upstream new body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        'consumer override' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'CLAUDE.md') -NoNewline
        Push-Location $fx.Consumer
        try { git add CLAUDE.md; git commit -q -m 'local edit to managed file' } finally { Pop-Location }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -Force
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'upstream new body'
    }

    It '-WhatIf prints ops but leaves the working tree untouched' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; 'one' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline } `
            -Tweak {
                'TWO' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline
                'three' | Out-File -Encoding utf8 .github/agents/b.md -NoNewline
            }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $beforeA = (Get-Content (Join-Path $fx.Consumer '.github/agents/a.md') -Raw)
        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -WhatIf
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer '.github/agents/a.md') -Raw) | Should -Be $beforeA
        Test-Path (Join-Path $fx.Consumer '.github/agents/b.md') | Should -BeFalse
    }

    It 'README.md is immune to upstream changes' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                'consumer-baseline' | Out-File -Encoding utf8 README.md -NoNewline
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
            } `
            -Tweak {
                'UPSTREAM README OVERRIDE' | Out-File -Encoding utf8 README.md -NoNewline
                'new claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
            }
        # Make consumer README differ from upstream anchor by re-writing post-seed:
        'consumer-only readme content' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'README.md') -NoNewline
        Push-Location $fx.Consumer
        try { git add README.md; git commit -q -m 'consumer readme' } finally { Pop-Location }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'README.md') -Raw) | Should -Be 'consumer-only readme content'
        # CLAUDE.md did get updated.
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'new claude'
    }

    It 'scaffolds docs/README.md from upstream content on first sync into an empty consumer (issue #156)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                New-Item -ItemType Directory -Path docs -Force | Out-Null
                'UPSTREAM_DOCS_README_BODY' | Out-File -Encoding utf8 docs/README.md -NoNewline
            }
        # Consumer has no docs/ at all -- this is the "first sync into empty consumer" case.
        Remove-Item -Recurse -Force (Join-Path $fx.Consumer 'docs') -ErrorAction SilentlyContinue

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch
        $rc | Should -Be 0
        $scaffolded = Join-Path $fx.Consumer 'docs/README.md'
        Test-Path $scaffolded | Should -BeTrue
        (Get-Content $scaffolded -Raw).Trim() | Should -Be 'UPSTREAM_DOCS_README_BODY'
    }

    It 'preserves consumer edits to docs/README.md on subsequent sync (issue #156)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                New-Item -ItemType Directory -Path docs -Force | Out-Null
                'UPSTREAM_DOCS_README_BODY' | Out-File -Encoding utf8 docs/README.md -NoNewline
            } `
            -Tweak {
                'UPSTREAM_DOCS_README_BODY_V2' | Out-File -Encoding utf8 docs/README.md -NoNewline
            }
        # Consumer has its own edited docs/README.md tracked in git.
        New-Item -ItemType Directory -Path (Join-Path $fx.Consumer 'docs') -Force | Out-Null
        'CONSUMER_EDITED_BODY' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'docs/README.md') -NoNewline
        Push-Location $fx.Consumer
        try { git add docs/README.md; git commit -q -m 'consumer docs readme' } finally { Pop-Location }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'docs/README.md') -Raw) | Should -Be 'CONSUMER_EDITED_BODY'
    }

    It 'scaffolds README.md from README.md.template on first sync into an empty consumer (issue #158)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                'UPSTREAM_README_TEMPLATE_BODY' | Out-File -Encoding utf8 README.md.template -NoNewline
            }
        # Consumer starts with no README.md at all.
        Remove-Item (Join-Path $fx.Consumer 'README.md') -ErrorAction SilentlyContinue

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch
        $rc | Should -Be 0
        $scaffolded = Join-Path $fx.Consumer 'README.md'
        Test-Path $scaffolded | Should -BeTrue
        (Get-Content $scaffolded -Raw).Trim() | Should -Be 'UPSTREAM_README_TEMPLATE_BODY'
    }

    It 'preserves consumer-owned README.md on subsequent sync even when upstream template changes (issue #158)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                'UPSTREAM_README_TEMPLATE_BODY' | Out-File -Encoding utf8 README.md.template -NoNewline
            } `
            -Tweak {
                'UPSTREAM_README_TEMPLATE_BODY_V2' | Out-File -Encoding utf8 README.md.template -NoNewline
            }
        # Consumer has its own README.md tracked in git, plus the synced state file.
        'CONSUMER_OWNED_README' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'README.md') -NoNewline
        Push-Location $fx.Consumer
        try { git add README.md; git commit -q -m 'consumer readme' } finally { Pop-Location }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'README.md') -Raw) | Should -Be 'CONSUMER_OWNED_README'
    }
}

function global:New-StaleUpstreamFixture {
    <#
    .SYNOPSIS
        Builds an upstream whose managed path passes through three versions and a
        consumer whose HEAD holds the *oldest* upstream version -- not the recorded
        anchor. Returns @{ Upstream; Consumer; AnchorSha; UpstreamHead; Path }.
    .DESCRIPTION
        Reproduces the self-update / mis-recorded-anchor scenario: the consumer's
        committed managed file is genuine upstream content, just from a different
        commit than the recorded anchor. When -TipUnchangedFromAnchor is set the
        tip commit touches a *different* managed file, so the managed path stays at
        the anchor version through the tip -- exercising the reconciliation path
        where the anchor->tip diff emits no op for the stale managed file.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string]$Path = 'CLAUDE.md',
        [string]$OtherPath = '.github/copilot-instructions.md',
        [switch]$TipUnchangedFromAnchor,
        [string]$RemoteName = 'sdlc.ai'
    )
    $upstream = Join-Path $Root 'upstream'
    $consumer = Join-Path $Root 'consumer'
    New-Item -ItemType Directory -Path $upstream -Force | Out-Null
    New-Item -ItemType Directory -Path $consumer -Force | Out-Null

    Push-Location $upstream
    try {
        git init -q -b main
        git config user.email u@u.u; git config user.name u
        New-Item -ItemType Directory -Path (Split-Path $OtherPath) -Force | Out-Null
        'v1-old-upstream' | Out-File -Encoding utf8 $Path -NoNewline
        'instructions-v1' | Out-File -Encoding utf8 $OtherPath -NoNewline
        git add -A | Out-Null; git commit -q -m 'v1'
        'v2-anchor' | Out-File -Encoding utf8 $Path -NoNewline
        git add -A | Out-Null; git commit -q -m 'v2 anchor'
        $anchorSha = (git rev-parse HEAD).Trim()
        if ($TipUnchangedFromAnchor) {
            # Leave $Path at v2; advance a different managed file so tip != anchor.
            'instructions-v2' | Out-File -Encoding utf8 $OtherPath -NoNewline
        }
        else {
            'v3-tip' | Out-File -Encoding utf8 $Path -NoNewline
        }
        git add -A | Out-Null; git commit -q -m 'v3 tip'
        $upstreamHead = (git rev-parse HEAD).Trim()
    } finally { Pop-Location }

    Push-Location $consumer
    try {
        git init -q -b main
        git config user.email c@c.c; git config user.name c
        # Consumer HEAD holds the OLDEST upstream version of the managed file.
        New-Item -ItemType Directory -Path (Split-Path $OtherPath) -Force | Out-Null
        'v1-old-upstream' | Out-File -Encoding utf8 $Path -NoNewline
        'instructions-v1' | Out-File -Encoding utf8 $OtherPath -NoNewline
        'consumer readme' | Out-File -Encoding utf8 README.md -NoNewline
        '*.local' | Out-File -Encoding utf8 .gitignore -NoNewline
        git add -A | Out-Null; git commit -q -m 'seed'
        git checkout -q -b chore/sdlc-sync
        git remote add $RemoteName $upstream
        git fetch $RemoteName --quiet 2>$null | Out-Null
    } finally { Pop-Location }

    return @{
        Upstream     = $upstream
        Consumer     = $consumer
        AnchorSha    = $anchorSha
        UpstreamHead = $upstreamHead
        Path         = $Path
    }
}

Describe 'Invoke-PullSDLC upstream-sourced managed files are not local drift' {

    BeforeEach {
        $script:staleRoot = Join-Path $TestDrive ("stale-" + [guid]::NewGuid().ToString('N'))
    }

    It 'does not raise a policy violation when HEAD holds an older upstream version (changed at tip)' {
        $fx = New-StaleUpstreamFixture -Root $script:staleRoot
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer $fx.Path) -Raw) | Should -Be 'v3-tip'
    }

    It 'reconciles a stale managed file to the tip even when the anchor->tip diff has no op for it' {
        $fx = New-StaleUpstreamFixture -Root $script:staleRoot -TipUnchangedFromAnchor
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        # Tip never advanced $Path past the anchor version, but the consumer's
        # stale v1 must still be reconciled up to the tip's v2.
        (Get-Content (Join-Path $fx.Consumer $fx.Path) -Raw) | Should -Be 'v2-anchor'
    }
}

Describe 'Test-CommitContextAllowed' {

    BeforeEach {
        $script:ctxRoot = Join-Path $TestDrive ("ctx-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:ctxRoot -Force | Out-Null
        Push-Location $script:ctxRoot
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            'seed' | Out-File -Encoding utf8 README.md -NoNewline
            git add -A | Out-Null
            git commit -q -m 'seed'
            # Default fixture: established repo with an origin remote.
            git remote add origin https://example.invalid/owner/repo.git
        } finally { Pop-Location }
    }

    It 'blocks when HEAD is on the protected branch' {
        $r = Test-CommitContextAllowed -RepoRoot $script:ctxRoot -ProtectedBranch 'main'
        $r.Allowed | Should -BeFalse
        $r.Branch | Should -Be 'main'
        $r.Reason | Should -Match "protected branch 'main'"
    }

    It 'allows when HEAD is on a feature branch' {
        Push-Location $script:ctxRoot
        try { git checkout -q -b chore/sdlc-sync } finally { Pop-Location }
        $r = Test-CommitContextAllowed -RepoRoot $script:ctxRoot -ProtectedBranch 'main'
        $r.Allowed | Should -BeTrue
        $r.Branch | Should -Be 'chore/sdlc-sync'
    }

    It 'still blocks on protected branch even with no origin remote (no carve-out -- handled by caller via Test-IsBootstrapSync)' {
        Push-Location $script:ctxRoot
        try { git remote remove origin } finally { Pop-Location }
        $r = Test-CommitContextAllowed -RepoRoot $script:ctxRoot -ProtectedBranch 'main'
        $r.Allowed | Should -BeFalse
        $r.Branch | Should -Be 'main'
    }
}

Describe 'Test-IsBootstrapSync' {

    BeforeEach {
        $script:bsRoot = Join-Path $TestDrive ("bs-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:bsRoot -Force | Out-Null
        Push-Location $script:bsRoot
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            'seed' | Out-File -Encoding utf8 README.md -NoNewline
            git add -A | Out-Null
            git commit -q -m 'seed'
        } finally { Pop-Location }
    }

    It 'returns $true when neither state file nor prior sync commit exist' {
        Test-IsBootstrapSync -RepoRoot $script:bsRoot | Should -BeTrue
    }

    It 'returns $false when .sdlc-ai-sync.json exists' {
        $statePath = Join-Path $script:bsRoot '.sdlc-ai-sync.json'
        '{"remote":"sdlc.ai","ref":"main","lastSyncCommit":"abc","syncedAt":"2026-01-01T00:00:00Z"}' |
            Out-File -Encoding utf8 -LiteralPath $statePath -NoNewline
        Test-IsBootstrapSync -RepoRoot $script:bsRoot | Should -BeFalse
    }

    It 'returns $false when a prior chore sync commit is present in the log' {
        Push-Location $script:bsRoot
        try {
            'x' | Out-File -Encoding utf8 -LiteralPath (Join-Path $script:bsRoot 'CLAUDE.md') -NoNewline
            git add -A | Out-Null
            git commit -q -m 'chore: sync IntelliSDLC.ai @ deadbeef'
        } finally { Pop-Location }
        Test-IsBootstrapSync -RepoRoot $script:bsRoot | Should -BeFalse
    }
}

Describe 'Invoke-PullSDLC protected-branch guard' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("guard-" + [guid]::NewGuid().ToString('N'))
    }

    It 'aborts with rc=3 in steady state on main with -NoAutoWorktree (no -CommitOnMain)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Steady state: plant a state file so Test-IsBootstrapSync returns $false.
        '{"remote":"sdlc.ai","ref":"main","lastSyncCommit":"abc","syncedAt":"2026-01-01T00:00:00Z"}' |
            Out-File -Encoding utf8 -LiteralPath (Join-Path $fx.Consumer '.sdlc-ai-sync.json') -NoNewline
        # Move the consumer back onto main so the guard fires.
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git remote add origin https://example.invalid/owner/repo.git
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoWorktree
        $rc | Should -Be 3
        # Working tree must be untouched.
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'a'
    }

    It '-CommitOnMain bypasses the guard on main in steady state' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Steady state: plant a state file so Test-IsBootstrapSync returns $false.
        '{"remote":"sdlc.ai","ref":"main","lastSyncCommit":"abc","syncedAt":"2026-01-01T00:00:00Z"}' |
            Out-File -Encoding utf8 -LiteralPath (Join-Path $fx.Consumer '.sdlc-ai-sync.json') -NoNewline
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git remote add origin https://example.invalid/owner/repo.git
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -CommitOnMain
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It '-WhatIf bypasses the guard even on main (no mutation possible)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git remote add origin https://example.invalid/owner/repo.git
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -WhatIf
        $rc | Should -Be 0
        # Untouched.
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'a'
    }

    It 'commits directly on main at bootstrap by default (no flag, no state file)' {
        # Bootstrap state: no .sdlc-ai-sync.json, no prior sync commit.
        # First-time onboarding should commit on main without any flag.
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            # Origin is present -- bootstrap state alone is enough to enable
            # commit-on-main; no empty-origin carve-out needed.
            git remote add origin https://example.invalid/owner/repo.git
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It 'allows direct commit on main when no origin is configured (brand-new project, bootstrap state)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Move to main; do NOT add origin -- this is the brand-new project case.
        Push-Location $fx.Consumer
        try { git checkout -q main } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It '-CommitOnMain:$false forces auto-worktree-or-block even at bootstrap' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Bootstrap state (no state file, no prior sync commit) but user
        # explicitly opts out of commit-on-main; with -NoAutoWorktree
        # we should rc=3 instead of falling through to commit on main.
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git remote add origin https://example.invalid/owner/repo.git
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoWorktree -CommitOnMain:$false
        $rc | Should -Be 3
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'a'
    }
}

Describe 'Resolve-SyncAnchor -Bootstrap regression' {

    It 'returns bootstrap anchor even when state file is present (regression for upstream #102)' {
        $root = Join-Path $TestDrive ("anchor-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Push-Location $root
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            'x' | Out-File -Encoding utf8 README.md -NoNewline
            git add -A | Out-Null
            git commit -q -m seed
        } finally { Pop-Location }
        Set-SdlcSyncState -RepoRoot $root -Remote 'sdlc.ai' -Ref 'main' -Commit 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

        $anchor = Resolve-SyncAnchor -RepoRoot $root -Bootstrap
        $anchor.Source | Should -Be 'bootstrap'
        $anchor.Sha | Should -Be ''
    }
}

Describe 'Resolve-SyncAnchor auto-detect (issue #136)' {

    It 'auto-bootstraps silently when no state, no sync commit, and no managed files exist' {
        $root = Join-Path $TestDrive ("auto-empty-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Push-Location $root
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            'hello' | Out-File -Encoding utf8 README.md -NoNewline
            git add -A | Out-Null
            git commit -q -m initial
        } finally { Pop-Location }

        $anchor = Resolve-SyncAnchor -RepoRoot $root
        $anchor | Should -Not -BeNullOrEmpty
        $anchor.Source | Should -Be 'auto-bootstrap'
        $anchor.Sha | Should -Be ''
    }

    It 'auto-bootstraps when only consumer-owned files (e.g. README, .gitignore) are present' {
        $root = Join-Path $TestDrive ("auto-consumer-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Push-Location $root
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            'project' | Out-File -Encoding utf8 README.md -NoNewline
            'node_modules/' | Out-File -Encoding utf8 .gitignore -NoNewline
            git add -A | Out-Null
            git commit -q -m initial
        } finally { Pop-Location }

        $anchor = Resolve-SyncAnchor -RepoRoot $root
        $anchor.Source | Should -Be 'auto-bootstrap'
    }

    It 'returns null (not auto-bootstrap) when managed files are present and user declines prompt' {
        $root = Join-Path $TestDrive ("auto-managed-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Push-Location $root
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            New-Item -ItemType Directory -Path '.github' -Force | Out-Null
            'managed' | Out-File -Encoding utf8 'CLAUDE.md' -NoNewline
            'instr' | Out-File -Encoding utf8 '.github/copilot-instructions.md' -NoNewline
            git add -A | Out-Null
            git commit -q -m seed
        } finally { Pop-Location }

        # Without -NoPrompt and with managed files present, Read-Host would
        # prompt -- mock it to simulate the user typing 'n'.
        Mock -CommandName Read-Host -MockWith { 'n' }

        $anchor = Resolve-SyncAnchor -RepoRoot $root
        $anchor | Should -BeNullOrEmpty
    }

    It 'auto-bootstraps when only the bootstrap script (Pull-SDLC.ai.ps1) is present (issue #152 regression)' {
        # Reproduces the user-reported bug from issue #152: a brand-new
        # directory containing only the just-downloaded bootstrap script
        # used to fall through to the protective overwrite prompt because
        # Pull-SDLC.ai.ps1 itself was a managed path. With MetaScriptPaths
        # excluded from Test-NoManagedFilesPresent the silent auto-bootstrap
        # path fires as expected.
        $root = Join-Path $TestDrive ("auto-bootstrap-script-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Push-Location $root
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            '# stub bootstrap script' | Out-File -Encoding utf8 'Pull-SDLC.ai.ps1' -NoNewline
            git add -A | Out-Null
            git commit -q -m initial
        } finally { Pop-Location }

        $anchor = Resolve-SyncAnchor -RepoRoot $root
        $anchor.Source | Should -Be 'auto-bootstrap'
    }

    It 'falls through to -NoPrompt bootstrap when managed files exist' {
        $root = Join-Path $TestDrive ("auto-managed-noprompt-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Push-Location $root
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
            'managed' | Out-File -Encoding utf8 'CLAUDE.md' -NoNewline
            git add -A | Out-Null
            git commit -q -m seed
        } finally { Pop-Location }

        $anchor = Resolve-SyncAnchor -RepoRoot $root -NoPrompt
        $anchor.Source | Should -Be 'bootstrap'
    }
}

Describe 'Test-NoManagedFilesPresent (issue #136)' {

    It 'returns $true for an empty directory' {
        $root = Join-Path $TestDrive ("nm-empty-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Test-NoManagedFilesPresent -RepoRoot $root | Should -BeTrue
    }

    It 'returns $true when only consumer-owned files exist' {
        $root = Join-Path $TestDrive ("nm-consumer-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        'x' | Out-File -Encoding utf8 (Join-Path $root 'README.md') -NoNewline
        'y' | Out-File -Encoding utf8 (Join-Path $root 'CLAUDE.project.md') -NoNewline
        Test-NoManagedFilesPresent -RepoRoot $root | Should -BeTrue
    }

    It 'returns $false when CLAUDE.md is present' {
        $root = Join-Path $TestDrive ("nm-claude-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        'x' | Out-File -Encoding utf8 (Join-Path $root 'CLAUDE.md') -NoNewline
        Test-NoManagedFilesPresent -RepoRoot $root | Should -BeFalse
    }

    It 'returns $false when .github/agents/ contains files' {
        $root = Join-Path $TestDrive ("nm-agents-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path (Join-Path $root '.github/agents') -Force | Out-Null
        'agent' | Out-File -Encoding utf8 (Join-Path $root '.github/agents/x.agent.md') -NoNewline
        Test-NoManagedFilesPresent -RepoRoot $root | Should -BeFalse
    }

    It 'returns $true when only the bootstrap script (Pull-SDLC.ai.ps1) is present (issue #152)' {
        $root = Join-Path $TestDrive ("nm-bootstrap-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        '# stub' | Out-File -Encoding utf8 (Join-Path $root 'Pull-SDLC.ai.ps1') -NoNewline
        Test-NoManagedFilesPresent -RepoRoot $root | Should -BeTrue
    }

    It 'returns $true when only meta-scripts (Pull-SDLC.ai + Cleanup-Worktree + Consolidate-Specs) are present (issue #152)' {
        $root = Join-Path $TestDrive ("nm-meta-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        foreach ($f in 'Pull-SDLC.ai.ps1','Pull-SDLC.ai.Tests.ps1','Cleanup-Worktree.ps1','Consolidate-Specs.ps1','Consolidate-Specs.Tests.ps1') {
            '# stub' | Out-File -Encoding utf8 (Join-Path $root $f) -NoNewline
        }
        Test-NoManagedFilesPresent -RepoRoot $root | Should -BeTrue
    }

    It 'still returns $false when a meta-script AND CLAUDE.md are present (prompt must still fire to protect hand-authored content)' {
        $root = Join-Path $TestDrive ("nm-meta-plus-claude-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        '# stub' | Out-File -Encoding utf8 (Join-Path $root 'Pull-SDLC.ai.ps1') -NoNewline
        'hand-authored' | Out-File -Encoding utf8 (Join-Path $root 'CLAUDE.md') -NoNewline
        Test-NoManagedFilesPresent -RepoRoot $root | Should -BeFalse
    }
}

Describe 'Invoke-PullSDLC auto-worktree mode' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("auto-" + [guid]::NewGuid().ToString('N'))
    }

    It 'on main without -NoAutoWorktree, creates .worktrees/sdlc-sync, syncs, and pushes -NoAutoPR' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Add a fake origin pointing back to a bare clone so push has a target.
        $origin = Join-Path $fx.Consumer.._origin.git
        $origin = Join-Path (Split-Path $fx.Consumer -Parent) 'origin.git'
        git -C $fx.Consumer remote remove origin 2>$null | Out-Null
        git init --bare -q -b main $origin
        git -C $fx.Consumer remote add origin $origin
        # Push main so origin/main exists.
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git push -q origin main
        } finally { Pop-Location }

        # Invoke from main (we *are* on main after checkout above).
        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR -CommitOnMain:$false
        $rc | Should -Be 0

        # Worktree should exist at .worktrees/sdlc-sync.
        $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
        Test-Path $wt | Should -BeTrue
        # Worktree HEAD has the sync commit; main untouched.
        Push-Location $fx.Consumer
        try {
            (git rev-parse --abbrev-ref HEAD).Trim() | Should -Be 'main'
            (git log -1 --pretty=%s main).Trim() | Should -Be 'seed'
            # Pushed branch exists on origin.
            (git ls-remote --heads origin chore/sdlc-sync) | Should -Not -BeNullOrEmpty
        } finally { Pop-Location }
        Push-Location $wt
        try {
            (git rev-parse --abbrev-ref HEAD).Trim() | Should -Be 'chore/sdlc-sync'
            (git log -1 --pretty=%s).Trim() | Should -Match '^chore: sync IntelliSDLC\.ai to'
            (Get-Content (Join-Path $wt 'CLAUDE.md') -Raw) | Should -Be 'b'
        } finally { Pop-Location }
    }

    It 'auto-recovers when existing worktree has uncommitted changes' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        $origin = Join-Path (Split-Path $fx.Consumer -Parent) 'origin.git'
        git init --bare -q -b main $origin
        git -C $fx.Consumer remote remove origin 2>$null | Out-Null
        git -C $fx.Consumer remote add origin $origin
        # Pre-create a dirty worktree mimicking a prior interrupted run:
        # an untracked stray file AND a modified tracked file.
        $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git push -q origin main
            git worktree add $wt chore/sdlc-sync | Out-Null
        } finally { Pop-Location }
        'leftover from interrupted run' | Out-File -Encoding utf8 (Join-Path $wt 'STRAY.md') -NoNewline
        'half-edited' | Out-File -Encoding utf8 (Join-Path $wt 'CLAUDE.md') -NoNewline

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR -CommitOnMain:$false
        $rc | Should -Be 0
        # Stray untracked file scrubbed, tracked file reset to the sync commit's content.
        Test-Path (Join-Path $wt 'STRAY.md') | Should -BeFalse
        (Get-Content (Join-Path $wt 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It 'auto-recovers when existing worktree has stale unpushed commits' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        $origin = Join-Path (Split-Path $fx.Consumer -Parent) 'origin.git'
        git init --bare -q -b main $origin
        git -C $fx.Consumer remote remove origin 2>$null | Out-Null
        git -C $fx.Consumer remote add origin $origin
        $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git push -q origin main
            git worktree add $wt chore/sdlc-sync | Out-Null
        } finally { Pop-Location }
        # Drop a stale commit into the worktree branch (the kind that a prior
        # incomplete sync run would have left behind, never pushed).
        Push-Location $wt
        try {
            'stale' | Out-File -Encoding utf8 STALE.md -NoNewline
            git add STALE.md | Out-Null
            git -c user.email=test@example.com -c user.name=Test commit -q -m 'stale commit from prior run'
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR -CommitOnMain:$false
        $rc | Should -Be 0
        # Stale commit's file is gone; the worktree was reset before the sync ran.
        Test-Path (Join-Path $wt 'STALE.md') | Should -BeFalse
        (Get-Content (Join-Path $wt 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It 'reuses existing clean worktree' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        $origin = Join-Path (Split-Path $fx.Consumer -Parent) 'origin.git'
        git init --bare -q -b main $origin
        git -C $fx.Consumer remote remove origin 2>$null | Out-Null
        git -C $fx.Consumer remote add origin $origin
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git push -q origin main
            $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
            git worktree add $wt chore/sdlc-sync | Out-Null
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR -CommitOnMain:$false
        $rc | Should -Be 0
        $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
        (Get-Content (Join-Path $wt 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It 'recovers from a stale worktree marker pointing to a foreign / deleted gitdir (issue #180)' {
        # Reproduces the real PSBitWarden symptom: a leftover .worktrees/sdlc-sync/
        # directory whose .git file says `gitdir: <some other repo>` (or a
        # deleted path). The reuse check that only inspects the marker's
        # existence is fooled, then every git command inside the directory
        # fails with "fatal: not a git repository: (NULL)" and the auto-
        # worktree flow blows up. The fix discards the stale directory and
        # creates a fresh worktree.
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        $origin = Join-Path (Split-Path $fx.Consumer -Parent) 'origin.git'
        git init --bare -q -b main $origin
        git -C $fx.Consumer remote remove origin 2>$null | Out-Null
        git -C $fx.Consumer remote add origin $origin
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git push -q origin main
        } finally { Pop-Location }
        # Manually fabricate a stale worktree directory: a directory with a
        # .git FILE whose gitdir points somewhere this repo knows nothing about.
        $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
        New-Item -ItemType Directory -Path $wt -Force | Out-Null
        $foreignGitDir = Join-Path (Split-Path $fx.Consumer -Parent) 'foreign-repo/.git/worktrees/sdlc-sync'
        Set-Content -LiteralPath (Join-Path $wt '.git') -Value ("gitdir: $foreignGitDir") -NoNewline
        'leftover from a different repo' | Out-File -Encoding utf8 (Join-Path $wt 'STRAY.md') -NoNewline

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR -CommitOnMain:$false
        $rc | Should -Be 0
        # The worktree must now belong to this repo and carry the synced content.
        Test-Path (Join-Path $wt '.git') | Should -BeTrue
        Push-Location $wt
        try {
            $wtCommonDir = (git rev-parse --git-common-dir).Trim()
            $wtAbs = (Resolve-Path -LiteralPath $wtCommonDir).Path
        } finally { Pop-Location }
        Push-Location $fx.Consumer
        try {
            $thisCommonDir = (git rev-parse --git-common-dir).Trim()
            $thisAbs = (Resolve-Path -LiteralPath $thisCommonDir).Path
        } finally { Pop-Location }
        $wtAbs | Should -Be $thisAbs
        # Stray content from the old foreign tree is gone; sync produced new content.
        Test-Path (Join-Path $wt 'STRAY.md') | Should -BeFalse
        (Get-Content (Join-Path $wt 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It 'auto-recovers a divergent push to chore/sdlc-sync via force-with-lease retry' {
        # Reproduces the real-world divergent-scratch-branch case: a previous
        # successful run pushed commit X to origin/chore/sdlc-sync. The
        # current run resets the worktree to ProtectedBranch and replays the
        # sync, producing a new commit Y whose history does not include X.
        # The straight push is rejected non-fast-forward. Because the local
        # remote-tracking ref still matches origin (we never fetched origin
        # in between), --force-with-lease succeeds and the second run should
        # return 0 (not the warning path).
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        $origin = Join-Path (Split-Path $fx.Consumer -Parent) 'origin.git'
        git init --bare -q -b main $origin
        git -C $fx.Consumer remote remove origin 2>$null | Out-Null
        git -C $fx.Consumer remote add origin $origin
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git push -q origin main
        } finally { Pop-Location }

        # First run: seeds origin/chore/sdlc-sync with commit X.
        $rc1 = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR -CommitOnMain:$false
        $rc1 | Should -Be 0
        $shaAfterRun1 = (& git -c safe.bareRepository=all -C $origin rev-parse 'chore/sdlc-sync').Trim()
        $shaAfterRun1 | Should -Not -BeNullOrEmpty

        # Wait a moment so the second commit gets a distinct timestamp/SHA.
        Start-Sleep -Seconds 1

        # Second run: worktree resets to main, replays sync, produces commit
        # Y. Y's parent is ProtectedBranch HEAD, NOT X. Straight push is
        # non-fast-forward; auto-recovery must retry with force-with-lease.
        $rc2 = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR -CommitOnMain:$false
        $rc2 | Should -Be 0

        $shaAfterRun2 = (& git -c safe.bareRepository=all -C $origin rev-parse 'chore/sdlc-sync').Trim()
        # Force-push moved origin/chore/sdlc-sync to a new SHA that is NOT a
        # descendant of run-1's SHA (different parents -> not fast-forward).
        $shaAfterRun2 | Should -Not -Be $shaAfterRun1
        # And it really isn't fast-forward: X is not an ancestor of Y.
        & git -c safe.bareRepository=all -C $origin merge-base --is-ancestor $shaAfterRun1 $shaAfterRun2 2>$null
        $LASTEXITCODE | Should -Not -Be 0
    }
}

# --- Tests for issue #106: self-refresh + clearer Planned ops wording ---

Describe 'Test-SelfRefreshRequired' {
    BeforeEach {
        Remove-Item Env:PULL_SDLC_NO_SELF_UPDATE -ErrorAction SilentlyContinue
        $script:fakeScript = Join-Path $TestDrive 'Pull-SDLC.ai.ps1'
        Set-Content -LiteralPath $script:fakeScript -Value '# fake'
    }

    It 'returns $false when -NoSelfUpdate is set' {
        Test-SelfRefreshRequired -ScriptPath $script:fakeScript -NoSelfUpdate | Should -BeFalse
    }

    It 'returns $false when PULL_SDLC_NO_SELF_UPDATE env var is set' {
        $env:PULL_SDLC_NO_SELF_UPDATE = '1'
        try {
            Test-SelfRefreshRequired -ScriptPath $script:fakeScript | Should -BeFalse
        } finally {
            Remove-Item Env:PULL_SDLC_NO_SELF_UPDATE -ErrorAction SilentlyContinue
        }
    }

    It 'returns $false when ScriptPath is empty' {
        Test-SelfRefreshRequired -ScriptPath '' | Should -BeFalse
    }

    It 'returns $false when ScriptPath leaf is not Pull-SDLC.ai.ps1' {
        $other = Join-Path $TestDrive 'Some-Other.ps1'
        Set-Content -LiteralPath $other -Value '# other'
        Test-SelfRefreshRequired -ScriptPath $other | Should -BeFalse
    }

    It 'returns $false when running from inside .worktrees/sdlc-sync' {
        $wtPath = Join-Path $TestDrive '.worktrees/sdlc-sync/Pull-SDLC.ai.ps1'
        New-Item -ItemType Directory -Path (Split-Path $wtPath) -Force | Out-Null
        Set-Content -LiteralPath $wtPath -Value '# wt'
        Test-SelfRefreshRequired -ScriptPath $wtPath | Should -BeFalse
    }

    It 'returns $true for a normal script path with no opt-out' {
        Test-SelfRefreshRequired -ScriptPath $script:fakeScript | Should -BeTrue
    }

    It 'returns $false when the script lives in the upstream IntelliSDLC.ai repo' {
        # Initialize a git repo at the script's dir with an upstream-looking origin.
        $repoDir = Join-Path $TestDrive 'upstream-check'
        New-Item -ItemType Directory -Path $repoDir -Force | Out-Null
        $script = Join-Path $repoDir 'Pull-SDLC.ai.ps1'
        Set-Content -LiteralPath $script -Value '# upstream'
        Push-Location $repoDir
        try {
            git init -q
            git remote add origin 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git'
        } finally { Pop-Location }
        Test-SelfRefreshRequired -ScriptPath $script | Should -BeFalse
    }

    It 'returns $false when the on-disk script has uncommitted local edits (issue #202)' {
        # A consumer repo whose committed Pull-SDLC.ai.ps1 is then locally edited.
        $repoDir = Join-Path $TestDrive 'dirty-consumer'
        New-Item -ItemType Directory -Path $repoDir -Force | Out-Null
        $script = Join-Path $repoDir 'Pull-SDLC.ai.ps1'
        Push-Location $repoDir
        try {
            git init -q
            git config user.email c@c.c; git config user.name c
            git remote add origin 'https://github.com/SomeOrg/SomeConsumer.git'
            'committed body' | Out-File -Encoding utf8 $script -NoNewline
            git add Pull-SDLC.ai.ps1; git commit -q -m 'add script'
            # Local edit, not committed.
            'LOCALLY EDITED body' | Out-File -Encoding utf8 $script -NoNewline
        } finally { Pop-Location }
        Test-SelfRefreshRequired -ScriptPath $script | Should -BeFalse
    }

    It 'returns $true when a tracked on-disk script is clean (no uncommitted edits) (issue #202)' {
        $repoDir = Join-Path $TestDrive 'clean-consumer'
        New-Item -ItemType Directory -Path $repoDir -Force | Out-Null
        $script = Join-Path $repoDir 'Pull-SDLC.ai.ps1'
        Push-Location $repoDir
        try {
            git init -q
            git config user.email c@c.c; git config user.name c
            git remote add origin 'https://github.com/SomeOrg/SomeConsumer.git'
            'committed body' | Out-File -Encoding utf8 $script -NoNewline
            git add Pull-SDLC.ai.ps1; git commit -q -m 'add script'
        } finally { Pop-Location }
        Test-SelfRefreshRequired -ScriptPath $script | Should -BeTrue
    }
}

Describe 'Test-ScriptHasUncommittedEdits (issue #202)' {
    BeforeEach {
        $script:edRepo = Join-Path $TestDrive ("ed-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:edRepo -Force | Out-Null
        $script:edScript = Join-Path $script:edRepo 'Pull-SDLC.ai.ps1'
    }

    It 'returns $true for a tracked file with uncommitted working-tree changes' {
        Push-Location $script:edRepo
        try {
            git init -q; git config user.email c@c.c; git config user.name c
            'v1' | Out-File -Encoding utf8 $script:edScript -NoNewline
            git add Pull-SDLC.ai.ps1; git commit -q -m 'v1'
            'v2 local edit' | Out-File -Encoding utf8 $script:edScript -NoNewline
        } finally { Pop-Location }
        Test-ScriptHasUncommittedEdits -ScriptPath $script:edScript | Should -BeTrue
    }

    It 'returns $false for a tracked file that matches HEAD' {
        Push-Location $script:edRepo
        try {
            git init -q; git config user.email c@c.c; git config user.name c
            'v1' | Out-File -Encoding utf8 $script:edScript -NoNewline
            git add Pull-SDLC.ai.ps1; git commit -q -m 'v1'
        } finally { Pop-Location }
        Test-ScriptHasUncommittedEdits -ScriptPath $script:edScript | Should -BeFalse
    }

    It 'returns $false for an untracked file (fresh bootstrap)' {
        Push-Location $script:edRepo
        try {
            git init -q; git config user.email c@c.c; git config user.name c
            'downloaded' | Out-File -Encoding utf8 $script:edScript -NoNewline
        } finally { Pop-Location }
        Test-ScriptHasUncommittedEdits -ScriptPath $script:edScript | Should -BeFalse
    }

    It 'returns $false when the file is not inside a git repository' {
        $loose = Join-Path $TestDrive ("loose-" + [guid]::NewGuid().ToString('N') + ".ps1")
        Set-Content -LiteralPath $loose -Value 'no-git' -NoNewline
        Test-ScriptHasUncommittedEdits -ScriptPath $loose | Should -BeFalse
    }

    It 'returns $false for an EOL-only difference (CRLF vs LF normalization)' {
        Push-Location $script:edRepo
        try {
            git init -q; git config user.email c@c.c; git config user.name c
            # Commit with LF.
            [System.IO.File]::WriteAllText($script:edScript, "line1`nline2")
            git add Pull-SDLC.ai.ps1; git commit -q -m 'lf'
            # Rewrite the working tree with CRLF, same content.
            [System.IO.File]::WriteAllText($script:edScript, "line1`r`nline2")
        } finally { Pop-Location }
        Test-ScriptHasUncommittedEdits -ScriptPath $script:edScript | Should -BeFalse
    }
}

Describe 'Invoke-SelfRefresh' {
    BeforeEach {
        $script:scriptPath = Join-Path $TestDrive 'Pull-SDLC.ai.ps1'
        Set-Content -LiteralPath $script:scriptPath -Value 'original-body' -NoNewline
    }

    It 'returns empty and leaves the file unchanged when remote hash matches local' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing)
            Set-Content -LiteralPath $OutFile -Value 'original-body' -NoNewline
        }
        $result = Invoke-SelfRefresh -ScriptPath $script:scriptPath
        $result | Should -BeNullOrEmpty
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'original-body'
    }

    It 'overwrites the on-disk script with upstream content and returns a backup of the original when remote hash differs (issue #200)' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing)
            Set-Content -LiteralPath $OutFile -Value 'NEW-upstream-body' -NoNewline
        }
        $result = Invoke-SelfRefresh -ScriptPath $script:scriptPath
        $result | Should -Not -BeNullOrEmpty
        $result | Should -Match 'pull-sdlc-self-backup-.*\.ps1$'
        Test-Path -LiteralPath $result | Should -BeTrue
        # The on-disk script IS overwritten with the new upstream content (issue #200).
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'NEW-upstream-body'
        # The returned backup file holds the ORIGINAL on-disk content.
        (Get-Content -LiteralPath $result -Raw) | Should -Be 'original-body'
        # Clean up the backup the function intentionally leaves behind for the caller.
        Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
    }

    It 'returns empty and emits a warning when Invoke-WebRequest throws' {
        Mock -CommandName Invoke-WebRequest -MockWith { throw 'simulated network failure' }
        $warnings = @()
        $result = Invoke-SelfRefresh -ScriptPath $script:scriptPath -WarningVariable warnings -WarningAction SilentlyContinue
        $result | Should -BeNullOrEmpty
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'original-body'
        ($warnings -join ' ') | Should -Match 'Self-update check skipped'
    }

    It 'deletes its temp file even when $WhatIfPreference is true (no-update path)' {
        # Clean any stragglers from prior runs so this assertion is hermetic.
        Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Filter 'pull-sdlc-self-*.ps1' -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing)
            # -WhatIf:$false so the mock itself doesn't get short-circuited by the
            # caller's $WhatIfPreference; we are simulating a real network write.
            Set-Content -LiteralPath $OutFile -Value 'original-body' -NoNewline -WhatIf:$false
        }
        $WhatIfPreference = $true
        try {
            $result = Invoke-SelfRefresh -ScriptPath $script:scriptPath
        }
        finally {
            $WhatIfPreference = $false
        }
        $result | Should -BeNullOrEmpty
        $leftover = Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Filter 'pull-sdlc-self-*.ps1' -ErrorAction SilentlyContinue
        $leftover | Should -BeNullOrEmpty
    }

    It 'produces no "What if:" output when called with $WhatIfPreference = $true' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing)
            Set-Content -LiteralPath $OutFile -Value 'original-body' -NoNewline -WhatIf:$false
        }
        $transcriptPath = Join-Path $TestDrive ("transcript-" + [guid]::NewGuid().ToString('N') + ".txt")
        $WhatIfPreference = $true
        try {
            Start-Transcript -LiteralPath $transcriptPath -Force -WhatIf:$false | Out-Null
            try {
                Invoke-SelfRefresh -ScriptPath $script:scriptPath | Out-Null
            }
            finally {
                Stop-Transcript -WhatIf:$false | Out-Null
            }
        }
        finally {
            $WhatIfPreference = $false
        }
        $captured = Get-Content -LiteralPath $transcriptPath -Raw
        $captured | Should -Not -Match 'What if:.*pull-sdlc-self-'
    }

    It 'cache-busts the fetch with a query parameter to defeat Fastly stale hits' {
        $script:capturedUri = $null
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing, $Headers)
            $script:capturedUri = $Uri
            Set-Content -LiteralPath $OutFile -Value 'original-body' -NoNewline -WhatIf:$false
        }
        Invoke-SelfRefresh -ScriptPath $script:scriptPath | Out-Null
        $script:capturedUri | Should -Match '[?&]cb='
    }

    It 'emits a verbose line reporting up-to-date result with the SHA-256 short hash' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing, $Headers)
            Set-Content -LiteralPath $OutFile -Value 'original-body' -NoNewline -WhatIf:$false
        }
        $verboseMsgs = & { Invoke-SelfRefresh -ScriptPath $script:scriptPath -Verbose 4>&1 } |
            Where-Object { $_ -is [System.Management.Automation.VerboseRecord] }
        ($verboseMsgs -join ' ') | Should -Match 'Self-refresh: up-to-date'
        ($verboseMsgs -join ' ') | Should -Match '[0-9A-Fa-f]{7}'
    }

    It 'emits a verbose line reporting updated result with old and new SHA-256 short hashes' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing, $Headers)
            Set-Content -LiteralPath $OutFile -Value 'NEW-upstream-body' -NoNewline -WhatIf:$false
        }
        # Single invocation: the overwrite mutates the on-disk file, so a second
        # call would see matching hashes and report up-to-date instead.
        $verboseMsgs = & { Invoke-SelfRefresh -ScriptPath $script:scriptPath -Verbose 4>&1 } |
            Where-Object { $_ -is [System.Management.Automation.VerboseRecord] }
        ($verboseMsgs -join ' ') | Should -Match 'Self-refresh: updated'
        # The on-disk file was overwritten with the new content (issue #200).
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'NEW-upstream-body'
        # Clean up backup files produced by the invocation.
        Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Filter 'pull-sdlc-self-*.ps1' -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    It 'produces no "What if:" output from the overwrite path when $WhatIfPreference is true (issue #200)' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing, $Headers)
            Set-Content -LiteralPath $OutFile -Value 'NEW-upstream-body' -NoNewline -WhatIf:$false
        }
        $transcriptPath = Join-Path $TestDrive ("transcript-ow-" + [guid]::NewGuid().ToString('N') + ".txt")
        $WhatIfPreference = $true
        try {
            Start-Transcript -LiteralPath $transcriptPath -Force -WhatIf:$false | Out-Null
            try {
                $backup = Invoke-SelfRefresh -ScriptPath $script:scriptPath
            }
            finally {
                Stop-Transcript -WhatIf:$false | Out-Null
            }
        }
        finally {
            $WhatIfPreference = $false
        }
        $captured = Get-Content -LiteralPath $transcriptPath -Raw
        # The overwrite (Copy-Item backup + Move-Item) must be -WhatIf:$false so a
        # dry run does not print "What if:" noise or skip the in-place update.
        $captured | Should -Not -Match 'What if:'
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'NEW-upstream-body'
        if ($backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Complete-SelfReExec restore/cleanup (issue #200)' {
    BeforeEach {
        $script:reexecScript = Join-Path $TestDrive ("Pull-SDLC-" + [guid]::NewGuid().ToString('N') + ".ps1")
        $script:reexecBackup = Join-Path $TestDrive ("backup-" + [guid]::NewGuid().ToString('N') + ".ps1")
        Set-Content -LiteralPath $script:reexecScript -Value 'NEW-upstream-body' -NoNewline
        Set-Content -LiteralPath $script:reexecBackup -Value 'original-body' -NoNewline
    }

    It 'restores the original on-disk content from the backup under -RestoreOriginal (-WhatIf dry run)' {
        Complete-SelfReExec -ScriptPath $script:reexecScript -BackupPath $script:reexecBackup -RestoreOriginal
        (Get-Content -LiteralPath $script:reexecScript -Raw) | Should -Be 'original-body'
        # Backup is always cleaned up.
        Test-Path -LiteralPath $script:reexecBackup | Should -BeFalse
    }

    It 'keeps the new on-disk content (does not restore) for a normal run, and removes the backup' {
        Complete-SelfReExec -ScriptPath $script:reexecScript -BackupPath $script:reexecBackup
        (Get-Content -LiteralPath $script:reexecScript -Raw) | Should -Be 'NEW-upstream-body'
        Test-Path -LiteralPath $script:reexecBackup | Should -BeFalse
    }

    It 'is a no-op when no backup path is supplied' {
        { Complete-SelfReExec -ScriptPath $script:reexecScript -RestoreOriginal } | Should -Not -Throw
        (Get-Content -LiteralPath $script:reexecScript -Raw) | Should -Be 'NEW-upstream-body'
    }
}

Describe 'Invoke-PullSDLC self-refresh wiring' {
    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("sr-" + [guid]::NewGuid().ToString('N'))
    }

    It 'Invoke-PullSDLC no longer performs self-refresh internally (moved to script top level)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh -MockWith { return 'C:\fake\tmp.ps1' }
        Mock -CommandName Invoke-SelfReExec -MockWith { return 0 }
        # Even when self-refresh would say "go", Invoke-PullSDLC must not
        # invoke the gate -- it is the script's top-level responsibility now.
        Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch | Out-Null
        Should -Invoke -CommandName Test-SelfRefreshRequired -Times 0 -Exactly
        Should -Invoke -CommandName Invoke-SelfRefresh -Times 0 -Exactly
        Should -Invoke -CommandName Invoke-SelfReExec -Times 0 -Exactly
    }
}

Describe 'Invoke-SelfRefreshGate (issue #110)' {
    It 'short-circuits when Test-SelfRefreshRequired returns $false' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $false }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return 'C:\fake\tmp.ps1' }
        Mock -CommandName Invoke-SelfReExec    -MockWith { return 0 }
        $result = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters @{}
        $result | Should -BeFalse
        Should -Invoke -CommandName Invoke-SelfRefresh -Times 0 -Exactly
        Should -Invoke -CommandName Invoke-SelfReExec  -Times 0 -Exactly
    }

    It 'short-circuits when Invoke-SelfRefresh returns empty (hashes match / fetch failed)' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return '' }
        Mock -CommandName Invoke-SelfReExec    -MockWith { return 0 }
        $result = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters @{}
        $result | Should -BeFalse
        Should -Invoke -CommandName Invoke-SelfReExec -Times 0 -Exactly
    }

    It 're-execs via Invoke-SelfReExec when an update was applied' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return 'C:\fake\tmp.ps1' }
        $script:reExecCount = 0
        Mock -CommandName Invoke-SelfReExec -MockWith {
            $script:reExecCount++
            return 0
        }
        $null = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters @{ Branch = 'main' }
        $script:reExecCount | Should -Be 1
    }

    It 'passes the on-disk ScriptPath (not a temp file) and the backup to Invoke-SelfReExec (issue #200)' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return 'C:\Temp\pull-sdlc-self-backup-abc.ps1' }
        $script:capturedScriptPath = $null
        $script:capturedBackupPath = $null
        Mock -CommandName Invoke-SelfReExec -MockWith {
            param([string]$ScriptPath, [hashtable]$BoundParameters, [string]$BackupPath, [switch]$RestoreOriginal)
            $script:capturedScriptPath = $ScriptPath
            $script:capturedBackupPath = $BackupPath
        }
        $null = Invoke-SelfRefreshGate -ScriptPath 'C:\Consumer\Pull-SDLC.ai.ps1' -BoundParameters @{ Branch = 'main' }
        # The on-disk script (now overwritten with upstream content) is re-exec'd.
        $script:capturedScriptPath | Should -Be 'C:\Consumer\Pull-SDLC.ai.ps1'
        # The backup returned by Invoke-SelfRefresh is forwarded for restore.
        $script:capturedBackupPath | Should -Be 'C:\Temp\pull-sdlc-self-backup-abc.ps1'
    }

    It 'sets -RestoreOriginal when BoundParameters carries WhatIf=$true (issue #200)' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return 'C:\Temp\pull-sdlc-self-backup-abc.ps1' }
        $script:capturedRestore = $null
        Mock -CommandName Invoke-SelfReExec -MockWith {
            param([string]$ScriptPath, [hashtable]$BoundParameters, [string]$BackupPath, [switch]$RestoreOriginal)
            $script:capturedRestore = [bool]$RestoreOriginal
        }
        $null = Invoke-SelfRefreshGate -ScriptPath 'C:\Consumer\Pull-SDLC.ai.ps1' -BoundParameters @{ Branch = 'main'; WhatIf = $true }
        $script:capturedRestore | Should -BeTrue
    }

    It 'does NOT set -RestoreOriginal for a normal (non-WhatIf) run (issue #200)' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return 'C:\Temp\pull-sdlc-self-backup-abc.ps1' }
        $script:capturedRestore2 = $null
        Mock -CommandName Invoke-SelfReExec -MockWith {
            param([string]$ScriptPath, [hashtable]$BoundParameters, [string]$BackupPath, [switch]$RestoreOriginal)
            $script:capturedRestore2 = [bool]$RestoreOriginal
        }
        $null = Invoke-SelfRefreshGate -ScriptPath 'C:\Consumer\Pull-SDLC.ai.ps1' -BoundParameters @{ Branch = 'main' }
        $script:capturedRestore2 | Should -BeFalse
    }

    It 'forwards exactly the supplied BoundParameters to Invoke-SelfReExec (regression for #110)' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return 'C:\fake\tmp.ps1' }
        $script:capturedBound = $null
        Mock -CommandName Invoke-SelfReExec -MockWith {
            param([string]$ScriptPath, [hashtable]$BoundParameters)
            $script:capturedBound = $BoundParameters
        }
        $inputBound = @{ Branch = 'main'; RemoteName = 'sdlc.ai'; NoAutoPR = $true }
        $null = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters $inputBound
        # Captured keys must match input exactly -- no function-only leak (e.g. RemoteUrl).
        ($script:capturedBound.Keys | Sort-Object) -join ',' | Should -Be (($inputBound.Keys | Sort-Object) -join ',')
        $script:capturedBound.Keys | Should -Not -Contain 'RemoteUrl'
    }
}

Describe 'Script top-level self-refresh (issue #110 end-to-end)' {
    It 'exposes RemoteUrl as a script param (org-portability) and excludes function-only params' {
        # Issue #110 originally asserted RemoteUrl was NOT a script param so
        # PSBoundParameters at script top level couldn't leak it into the
        # re-exec hashtable. As of issue #136 RemoteUrl is intentionally a
        # top-level CLI param (so a fork in another org can override the
        # canonical URL); the re-exec path then propagates it correctly,
        # which is the desired behavior. Function-only params (RepoRoot,
        # NoFetch) remain excluded.
        $scriptCmd = Get-Command "$PSScriptRoot\Pull-SDLC.ai.ps1"
        $scriptCmd.Parameters.Keys | Should -Contain 'RemoteUrl'
        $scriptCmd.Parameters.Keys | Should -Not -Contain 'RepoRoot'
        $scriptCmd.Parameters.Keys | Should -Not -Contain 'NoFetch'
        # Sanity: outer params we expect are present.
        $scriptCmd.Parameters.Keys | Should -Contain 'Branch'
        $scriptCmd.Parameters.Keys | Should -Contain 'NoSelfUpdate'
        $scriptCmd.Parameters.Keys | Should -Contain 'NoAutoInit'
    }
}

Describe 'Planned ops output wording (issue #106)' {
    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("ops-" + [guid]::NewGuid().ToString('N'))
        $script:hostLines = New-Object System.Collections.Generic.List[string]
        Mock -CommandName Write-Host -MockWith {
            param($Object, $ForegroundColor, $NoNewline, $BackgroundColor, $Separator)
            $script:hostLines.Add([string]$Object) | Out-Null
        }
    }

    It 'renders the no-op message when count == 0' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.UpstreamHead
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -NoSelfUpdate | Out-Null
        $sha7 = $fx.UpstreamHead.Substring(0,7)
        ($script:hostLines -join "`n") | Should -Match "Files to update: 0 \(already at upstream $sha7 -- nothing to sync\)"
    }

    It 'renders the syncing message and word-coded op rows when count > 0' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents -Force | Out-Null
                'one'  | Out-File -Encoding utf8 .github/agents/keep.md -NoNewline
                'gone' | Out-File -Encoding utf8 .github/agents/zap.md -NoNewline
            } `
            -Tweak {
                'NEW'   | Out-File -Encoding utf8 .github/agents/keep.md -NoNewline
                'added' | Out-File -Encoding utf8 .github/agents/fresh.md -NoNewline
                Remove-Item .github/agents/zap.md
            }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -NoSelfUpdate -WhatIf | Out-Null
        $anchor7 = $fx.AnchorSha.Substring(0,7)
        $head7   = $fx.UpstreamHead.Substring(0,7)
        $combined = $script:hostLines -join "`n"
        $combined | Should -Match "Files to update: 3 \(syncing $anchor7 -> $head7\)"
        # Word-coded rows (8-char column, ASCII only).
        $combined | Should -Match 'add     \.github/agents/fresh\.md'
        $combined | Should -Match 'update  \.github/agents/keep\.md'
        $combined | Should -Match 'delete  \.github/agents/zap\.md'
    }
}

Describe 'Test-IsMergePath' {
    It 'returns $true for .gitignore' {
        Test-IsMergePath -Path '.gitignore' | Should -BeTrue
    }

    It 'returns $true for .GitIgnore (case-insensitive)' {
        Test-IsMergePath -Path '.GitIgnore' | Should -BeTrue
    }

    It 'tolerates a leading ./ on the path' {
        Test-IsMergePath -Path './.gitignore' | Should -BeTrue
    }

    It 'tolerates a leading .\ (backslash) on the path' {
        Test-IsMergePath -Path '.\.gitignore' | Should -BeTrue
    }

    It 'returns $false for README.md' {
        Test-IsMergePath -Path 'README.md' | Should -BeFalse
    }

    It 'returns $false for src/Foo.cs' {
        Test-IsMergePath -Path 'src/Foo.cs' | Should -BeFalse
    }

    It 'returns $false for an empty path' {
        Test-IsMergePath -Path '' | Should -BeFalse
    }
}

Describe 'ConvertTo-GitignoreChunk' {
    It 'returns an empty array for empty input' {
        $chunks = ConvertTo-GitignoreChunk -Text ''
        @($chunks).Count | Should -Be 0
    }

    It 'groups a comment block with its following entries into one chunk' {
        $text = "# header`n.evidence/`n.playwright-mcp/`n"
        $chunks = @(ConvertTo-GitignoreChunk -Text $text)
        $chunks.Count | Should -Be 1
        $chunks[0].Comments | Should -Be @('# header')
        $chunks[0].Entries  | Should -Be @('.evidence/', '.playwright-mcp/')
    }

    It 'splits chunks on blank lines' {
        $text = "# a`nfoo`n`n# b`nbar`n"
        $chunks = @(ConvertTo-GitignoreChunk -Text $text)
        $chunks.Count | Should -Be 2
        $chunks[0].Entries | Should -Be @('foo')
        $chunks[1].Entries | Should -Be @('bar')
    }

    It 'allows entries without preceding comments' {
        $text = "foo`nbar`n"
        $chunks = @(ConvertTo-GitignoreChunk -Text $text)
        $chunks.Count | Should -Be 1
        $chunks[0].Comments | Should -BeNullOrEmpty
        $chunks[0].Entries  | Should -Be @('foo', 'bar')
    }

    It 'preserves multi-line comment blocks' {
        $text = "# line 1`n# line 2`nfoo`n"
        $chunks = @(ConvertTo-GitignoreChunk -Text $text)
        $chunks[0].Comments | Should -Be @('# line 1', '# line 2')
        $chunks[0].Entries  | Should -Be @('foo')
    }
}

Describe 'Merge-FileFromUpstream (.gitignore union)' {

    BeforeAll {
        function New-MergeFixture {
            param([string]$Root, [string]$UpstreamContent, [string]$ConsumerContent)
            $upstream = Join-Path $Root 'upstream'
            $consumer = Join-Path $Root 'consumer'
            New-Item -ItemType Directory -Path $upstream -Force | Out-Null
            New-Item -ItemType Directory -Path $consumer -Force | Out-Null

            Push-Location $upstream
            try {
                git init -q -b main
                git config user.email u@u.u
                git config user.name u
                Set-Content -LiteralPath '.gitignore' -Value $UpstreamContent -NoNewline
                git add -A | Out-Null
                git commit -q -m "upstream"
            } finally { Pop-Location }

            Push-Location $consumer
            try {
                git init -q -b main
                git config user.email c@c.c
                git config user.name c
                if ($null -ne $ConsumerContent) {
                    Set-Content -LiteralPath '.gitignore' -Value $ConsumerContent -NoNewline
                    git add -A | Out-Null
                    git commit -q -m "seed"
                }
                else {
                    Set-Content -LiteralPath 'README.md' -Value 'r' -NoNewline
                    git add -A | Out-Null
                    git commit -q -m "seed"
                }
                git remote add sdlc.ai $upstream
                git fetch sdlc.ai --quiet 2>$null | Out-Null
            } finally { Pop-Location }

            return @{ Upstream = $upstream; Consumer = $consumer }
        }
    }

    BeforeEach {
        $script:mergeRoot = Join-Path $TestDrive ("merge-" + [guid]::NewGuid().ToString('N'))
    }

    It 'creates .gitignore with full upstream content when absent locally' {
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent "# header`n.evidence/`n.worktrees/`n" `
            -ConsumerContent $null
        $changed = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $changed | Should -BeTrue
        $result = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $result | Should -Match '\.evidence/'
        $result | Should -Match '\.worktrees/'
    }

    It 'appends only missing entries when local .gitignore is present' {
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent "# upstream`n.evidence/`n.worktrees/`n" `
            -ConsumerContent "*.local`n.evidence/`n"
        $changed = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $changed | Should -BeTrue
        $result = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $result | Should -Match '\*\.local'
        $result | Should -Match '\.evidence/'
        $result | Should -Match '\.worktrees/'
        ([regex]::Matches($result, '\.evidence/')).Count | Should -Be 1
    }

    It 'is idempotent -- second run produces no change' {
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent "# upstream`n.evidence/`n.worktrees/`n" `
            -ConsumerContent "*.local`n"
        $null = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $afterFirst = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $changed = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $changed | Should -BeFalse
        $afterSecond = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $afterSecond | Should -BeExactly $afterFirst
    }

    It 'skips chunks where every entry is already local' {
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent "# OS cruft.`n.DS_Store`nThumbs.db`n" `
            -ConsumerContent ".DS_Store`nThumbs.db`n"
        $changed = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $changed | Should -BeFalse
        $result = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $result | Should -Not -Match 'OS cruft'
    }

    It 'preserves CRLF line endings when local file uses CRLF' {
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent "# upstream`n.worktrees/`n" `
            -ConsumerContent "*.local`r`n"
        $null = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $fx.Consumer '.gitignore'))
        $crlfCount = 0
        for ($i = 0; $i -lt $bytes.Length - 1; $i++) {
            if ($bytes[$i] -eq 13 -and $bytes[$i + 1] -eq 10) { $crlfCount++ }
        }
        $crlfCount | Should -BeGreaterThan 0
    }

    It 'strips an upstream-only marker block so its entries never reach the consumer' {
        $upstream = @(
            '# shared header',
            '.evidence/',
            '',
            '# >>> upstream-only >>>',
            '# Upstream-only dogfood artifacts.',
            '.dogfood-output/',
            '# <<< upstream-only <<<',
            ''
        ) -join "`n"
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent $upstream `
            -ConsumerContent $null
        $null = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $result = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $result | Should -Match '\.evidence/'
        $result | Should -Not -Match '\.dogfood-output/'
        $result | Should -Not -Match 'upstream-only'
    }

    It 'treats an unterminated upstream-only marker as "rest of file is upstream-only"' {
        $upstream = @(
            '.evidence/',
            '',
            '# >>> upstream-only >>>',
            '.dogfood-output/',
            'secret-internal/'
        ) -join "`n"
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent $upstream `
            -ConsumerContent $null
        $null = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $result = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $result | Should -Match '\.evidence/'
        $result | Should -Not -Match '\.dogfood-output/'
        $result | Should -Not -Match 'secret-internal/'
    }

    It 'strips multiple non-contiguous upstream-only marker blocks' {
        $upstream = @(
            '# >>> upstream-only >>>',
            'first-private/',
            '# <<< upstream-only <<<',
            '',
            '# shared',
            '.evidence/',
            '',
            '# >>> upstream-only >>>',
            'second-private/',
            '# <<< upstream-only <<<',
            '',
            '.worktrees/'
        ) -join "`n"
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent $upstream `
            -ConsumerContent $null
        $null = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $result = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $result | Should -Match '\.evidence/'
        $result | Should -Match '\.worktrees/'
        $result | Should -Not -Match 'first-private/'
        $result | Should -Not -Match 'second-private/'
    }

    It 'matches the upstream-only marker case-insensitively' {
        $upstream = @(
            '.evidence/',
            '',
            '# >>> UPSTREAM-ONLY >>>',
            'sneaky/',
            '# <<< Upstream-Only <<<'
        ) -join "`n"
        $fx = New-MergeFixture -Root $script:mergeRoot `
            -UpstreamContent $upstream `
            -ConsumerContent $null
        $null = Merge-FileFromUpstream -Path '.gitignore' -Ref 'sdlc.ai/main' -RepoRoot $fx.Consumer
        $result = Get-Content -LiteralPath (Join-Path $fx.Consumer '.gitignore') -Raw
        $result | Should -Not -Match 'sneaky/'
    }
}

Describe 'Invoke-MainTreeCleanup' {

    BeforeAll {
        function New-CleanupFixture {
            param([string]$Root)
            $upstream = Join-Path $Root 'upstream'
            $consumer = Join-Path $Root 'consumer'
            New-Item -ItemType Directory -Path $upstream -Force | Out-Null
            New-Item -ItemType Directory -Path $consumer -Force | Out-Null

            $upstreamScript = "# upstream Pull-SDLC.ai.ps1 content`nWrite-Host 'hi'`n"

            Push-Location $upstream
            try {
                git init -q -b main
                git config user.email u@u.u
                git config user.name u
                Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value $upstreamScript -NoNewline
                git add -A | Out-Null
                git commit -q -m "upstream"
            } finally { Pop-Location }

            Push-Location $consumer
            try {
                git init -q -b main
                git config user.email c@c.c
                git config user.name c
                Set-Content -LiteralPath 'README.md' -Value 'r' -NoNewline
                git add -A | Out-Null
                git commit -q -m "seed"
                git remote add sdlc.ai $upstream
                git fetch sdlc.ai --quiet 2>$null | Out-Null
            } finally { Pop-Location }

            return @{
                Upstream         = $upstream
                Consumer         = $consumer
                UpstreamScript   = $upstreamScript
            }
        }
    }

    BeforeEach {
        $script:cleanupRoot = Join-Path $TestDrive ("cleanup-" + [guid]::NewGuid().ToString('N'))
    }

    It 'deletes an untracked-and-identical bootstrap file' {
        $fx = New-CleanupFixture -Root $script:cleanupRoot
        $target = Join-Path $fx.Consumer 'Pull-SDLC.ai.ps1'
        Set-Content -LiteralPath $target -Value $fx.UpstreamScript -NoNewline
        Test-Path -LiteralPath $target | Should -BeTrue
        Invoke-MainTreeCleanup -RepoRoot $fx.Consumer -UpstreamRef 'sdlc.ai/main' | Out-Null
        Test-Path -LiteralPath $target | Should -BeFalse
    }

    It 'preserves an untracked-modified copy and emits a warning' {
        $fx = New-CleanupFixture -Root $script:cleanupRoot
        $target = Join-Path $fx.Consumer 'Pull-SDLC.ai.ps1'
        Set-Content -LiteralPath $target -Value "# my local edits`n" -NoNewline
        Invoke-MainTreeCleanup -RepoRoot $fx.Consumer -UpstreamRef 'sdlc.ai/main' -WarningVariable warns -WarningAction SilentlyContinue | Out-Null
        Test-Path -LiteralPath $target | Should -BeTrue
        ($warns | Out-String) | Should -Match 'Pull-SDLC\.ai\.ps1'
    }

    It 'does not delete when -WhatIf is set' {
        $fx = New-CleanupFixture -Root $script:cleanupRoot
        $target = Join-Path $fx.Consumer 'Pull-SDLC.ai.ps1'
        Set-Content -LiteralPath $target -Value $fx.UpstreamScript -NoNewline
        Invoke-MainTreeCleanup -RepoRoot $fx.Consumer -UpstreamRef 'sdlc.ai/main' -WhatIf | Out-Null
        Test-Path -LiteralPath $target | Should -BeTrue
    }

    It 'does NOT revert tracked-modified file when HEAD differs from upstream (avoids silent self-refresh downgrade)' {
        # Scenario: a prior self-refresh wrote the newer upstream version into
        # the working tree, but the consumer has not yet committed it. HEAD
        # still has the older content; upstream has the newer content; working
        # tree matches upstream. The old revert path would silently downgrade
        # the working tree back to HEAD's older content. The tightened path
        # must leave the working tree alone whenever HEAD != upstream.
        $fx = New-CleanupFixture -Root $script:cleanupRoot
        Push-Location $fx.Consumer
        try {
            Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value "# old tracked content`n" -NoNewline
            git add Pull-SDLC.ai.ps1 | Out-Null
            git commit -q -m "track stale script"
            Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value $fx.UpstreamScript -NoNewline
        } finally { Pop-Location }
        Invoke-MainTreeCleanup -RepoRoot $fx.Consumer -UpstreamRef 'sdlc.ai/main' -WarningVariable warns -WarningAction SilentlyContinue | Out-Null
        $after = Get-Content -LiteralPath (Join-Path $fx.Consumer 'Pull-SDLC.ai.ps1') -Raw
        # Working tree preserved (matches upstream content), NOT reverted to old HEAD.
        $after | Should -Not -Match 'old tracked content'
        $after.TrimEnd("`r","`n") | Should -Be $fx.UpstreamScript.TrimEnd("`r","`n")
        # And no false "differs" warning either (working tree byte-matches upstream).
        ($warns | Out-String) | Should -Not -Match 'differ'
    }

    It 'does not warn "differs from upstream" when working file is byte-identical to a CRLF-stored upstream blob under autocrlf=true' {
        # Reproduces the autocrlf false-negative: upstream blob is stored with
        # raw CRLF bytes (because upstream was committed with autocrlf=false).
        # Consumer has autocrlf=true. The working-tree file has CRLF bytes
        # byte-identical to the stored blob. Without --no-filters, hash-object
        # normalises CRLF -> LF before hashing and produces a different hash,
        # causing a false "differs from upstream" warning.
        $root = $script:cleanupRoot
        $upstream = Join-Path $root 'upstream'
        $consumer = Join-Path $root 'consumer'
        New-Item -ItemType Directory -Path $upstream -Force | Out-Null
        New-Item -ItemType Directory -Path $consumer -Force | Out-Null

        $crlfBytes = [byte[]](([System.Text.Encoding]::ASCII.GetBytes("# crlf upstream content`r`nWrite-Host 'hi'`r`n")))

        Push-Location $upstream
        try {
            git init -q -b main
            git config core.autocrlf false
            git config user.email u@u.u
            git config user.name u
            [System.IO.File]::WriteAllBytes((Join-Path $upstream 'Pull-SDLC.ai.ps1'), $crlfBytes)
            git add -A | Out-Null
            git commit -q -m "upstream crlf"
        } finally { Pop-Location }

        Push-Location $consumer
        try {
            git init -q -b main
            git config core.autocrlf true
            git config user.email c@c.c
            git config user.name c
            Set-Content -LiteralPath 'README.md' -Value 'r' -NoNewline
            git add -A | Out-Null
            git commit -q -m "seed"
            git remote add sdlc.ai $upstream
            git fetch sdlc.ai --quiet 2>$null | Out-Null
            # Write the CRLF working file (untracked) byte-identical to upstream blob.
            [System.IO.File]::WriteAllBytes((Join-Path $consumer 'Pull-SDLC.ai.ps1'), $crlfBytes)
        } finally { Pop-Location }

        Invoke-MainTreeCleanup -RepoRoot $consumer -UpstreamRef 'sdlc.ai/main' -WarningVariable warns -WarningAction SilentlyContinue | Out-Null

        # No "differs" warning, and the untracked-identical file was removed.
        ($warns | Out-String) | Should -Not -Match 'differ'
        Test-Path -LiteralPath (Join-Path $consumer 'Pull-SDLC.ai.ps1') | Should -BeFalse
    }
}

Describe 'Write-NextStepsBanner (issue #149)' {

    BeforeEach {
        $script:nbRoot = Join-Path $TestDrive ("nb-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:nbRoot -Force | Out-Null
        Push-Location $script:nbRoot
        try {
            git init -q -b main
            git config user.email c@c.c
            git config user.name c
        } finally { Pop-Location }
    }

    It 'prints the banner on auto-bootstrap with a primary scaffolded file' {
        $out = Write-NextStepsBanner -RepoRoot $script:nbRoot -AnchorSource 'auto-bootstrap' -ScaffoldedFiles @('.github/instructions/project.instructions.md', 'README.md') 6>&1 | Out-String
        $out | Should -Match 'Next steps:'
        $out | Should -Match 'project\.instructions\.md'
        $out | Should -Match 'git add \.'
        $out | Should -Match 'git commit'
    }

    It 'prints the banner on explicit -Bootstrap as well' {
        $out = Write-NextStepsBanner -RepoRoot $script:nbRoot -AnchorSource 'bootstrap' -ScaffoldedFiles @() 6>&1 |
            Out-String
        $out | Should -Match 'Next steps:'
    }

    It 'is silent on steady-state sync (Source = state)' {
        $out = Write-NextStepsBanner -RepoRoot $script:nbRoot -AnchorSource 'state' -ScaffoldedFiles @() 6>&1 |
            Out-String
        $out | Should -BeNullOrEmpty
    }

    It 'is silent on grep-anchor sync (Source = grep)' {
        $out = Write-NextStepsBanner -RepoRoot $script:nbRoot -AnchorSource 'grep' -ScaffoldedFiles @() 6>&1 |
            Out-String
        $out | Should -BeNullOrEmpty
    }

    It 'shows the gh repo create hint when no origin is configured' {
        $out = Write-NextStepsBanner -RepoRoot $script:nbRoot -AnchorSource 'auto-bootstrap' -ScaffoldedFiles @() 6>&1 |
            Out-String
        $out | Should -Match 'gh repo create'
    }

    It 'hides the gh repo create hint when origin is configured' {
        Push-Location $script:nbRoot
        try { git remote add origin https://example.invalid/owner/repo.git } finally { Pop-Location }
        $out = Write-NextStepsBanner -RepoRoot $script:nbRoot -AnchorSource 'auto-bootstrap' -ScaffoldedFiles @() 6>&1 |
            Out-String
        $out | Should -Match 'Next steps:'
        $out | Should -Not -Match 'gh repo create'
    }

    It 'falls back to generic wording when project.instructions.md was not scaffolded' {
        $out = Write-NextStepsBanner -RepoRoot $script:nbRoot -AnchorSource 'auto-bootstrap' -ScaffoldedFiles @('README.md') 6>&1 | Out-String
        $out | Should -Match 'Review the scaffolded'
        $out | Should -Not -Match 'project\.instructions\.md'
    }
}

Describe 'Issue #148: bootstrap-on-main carve-out hygiene' {
    # End-to-end regression tests for the four findings raised by a user
    # who ran Pull-SDLC.ai.ps1 in a brand-new empty directory:
    #   F1: `.sdlc-ai-sync.json` could appear `modified` immediately after
    #       the sync commit (caused by CRLF newlines from ConvertTo-Json on
    #       Windows combined with a consumer `*.json text eol=lf` rule).
    #   F2: `Pull-SDLC.ai.ps1` and other meta scripts were left untracked
    #       (they were missing from $script:UpstreamManagedPaths).
    #   F3: `sync-manifest.json` was drift-prone documentation pretending
    #       to be the canonical source -- the script never read it.
    #   F4: Post-bootstrap message ("Open each file and fill in the
    #       sections, then commit them to your repo") was inaccurate and
    #       missing follow-up guidance for the fresh-init case.

    BeforeAll {
        function New-BootstrapOnMainFixture {
            <#
            .SYNOPSIS
                Builds a consumer in carve-out state (on main, no origin)
                next to a minimal upstream that ships the meta scripts that
                should be upstream-managed. Returns
                @{ Upstream; Consumer; UpstreamHead }.
            #>
            param([Parameter(Mandatory)][string]$Root)

            $upstream = Join-Path $Root 'upstream'
            $consumer = Join-Path $Root 'consumer'
            New-Item -ItemType Directory -Path $upstream -Force | Out-Null
            New-Item -ItemType Directory -Path $consumer -Force | Out-Null

            # Build the upstream repo with the bare minimum the bootstrap
            # exercises: CLAUDE.md plus the meta scripts.

            Push-Location $upstream
            try {
                git init -q -b main
                git config user.email u@u.u
                git config user.name u
                git config core.autocrlf false
                Set-Content -LiteralPath 'CLAUDE.md' -Value "upstream claude`n" -NoNewline
                # Meta scripts -- mirror real repo contents minimally.
                Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value "# upstream pull script`n" -NoNewline
                Set-Content -LiteralPath 'Cleanup-Worktree.ps1' -Value "# upstream cleanup`n" -NoNewline
                Set-Content -LiteralPath 'Consolidate-Specs.ps1' -Value "# upstream consolidate`n" -NoNewline
                Set-Content -LiteralPath 'Consolidate-Specs.Tests.ps1' -Value "# upstream consolidate tests`n" -NoNewline
                Set-Content -LiteralPath 'Pull-SDLC.ai.Tests.ps1' -Value "# upstream pull tests`n" -NoNewline
                Set-Content -LiteralPath 'run.ps1' -Value "# upstream runner`n" -NoNewline
                Set-Content -LiteralPath 'run.Tests.ps1' -Value "# upstream runner tests`n" -NoNewline
                git add -A | Out-Null
                git commit -q -m "upstream seed"
                $upstreamHead = (git rev-parse HEAD).Trim()
            } finally { Pop-Location }

            # Consumer: empty repo on main, no origin. The user's downloaded
            # copy of Pull-SDLC.ai.ps1 sits in the working tree untracked.
            Push-Location $consumer
            try {
                git init -q -b main
                git config user.email c@c.c
                git config user.name c
                # Force the autocrlf mode that caused F1 on the original
                # report so the regression repros cross-platform.
                git config core.autocrlf true
                Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value "# user-downloaded pull script`n" -NoNewline
                git remote add sdlc.ai $upstream
                git fetch sdlc.ai --quiet 2>$null | Out-Null
            } finally { Pop-Location }

            return @{
                Upstream     = $upstream
                Consumer     = $consumer
                UpstreamHead = $upstreamHead
            }
        }
    }

    BeforeEach {
        $script:carveRoot = Join-Path $TestDrive ("carve-" + [guid]::NewGuid().ToString('N'))
    }

    It 'F1: .sdlc-ai-sync.json is written with LF-only line endings (avoids phantom `modified` status under autocrlf=true + any downstream `*.json eol=lf` rule)' {
        # The user-reported symptom (`modified: .sdlc-ai-sync.json` after
        # commit) is autocrlf/env-dependent and not reliably reproducible in
        # CI. The root-cause cure -- and the one we CAN test deterministically
        # -- is: write the state file with LF-only endings so it matches any
        # `*.json text eol=lf` rule a consumer's `.gitattributes` may declare
        # (typically generated by `Initialize-GitDefaults.ps1`).
        # On Windows, ConvertTo-Json emits CRLF, which combined with
        # eol=lf produces a phantom "modified" status under some autocrlf
        # settings. LF-only output avoids the mismatch entirely.
        $probe = Join-Path $TestDrive ("f1-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $probe -Force | Out-Null
        Set-SdlcSyncState -RepoRoot $probe -Remote 'sdlc.ai' -Ref 'main' -Commit 'deadbeefcafe'
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $probe '.sdlc-ai-sync.json'))
        $crCount = @($bytes | Where-Object { $_ -eq 13 }).Count
        $crCount | Should -Be 0 -Because "the state file must be LF-only so consumer `.gitattributes` rules like `*.json text eol=lf` cannot mark it modified"
    }

    It 'F2: tracks all meta scripts (Pull-SDLC.ai.ps1, Cleanup-Worktree.ps1, Consolidate-Specs.ps1, *.Tests.ps1) after fresh bootstrap' {
        $fx = New-BootstrapOnMainFixture -Root $script:carveRoot
        Push-Location $fx.Consumer
        try {
            $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -CommitOnMain
            $rc | Should -Be 0
            $tracked = git ls-files
            $tracked | Should -Contain 'Pull-SDLC.ai.ps1' -Because 'the downloaded bootstrap script must end up tracked, not untracked'
            $tracked | Should -Contain 'Pull-SDLC.ai.Tests.ps1'
            $tracked | Should -Contain 'Cleanup-Worktree.ps1'
            $tracked | Should -Contain 'Consolidate-Specs.ps1'
            $tracked | Should -Contain 'Consolidate-Specs.Tests.ps1'
            $tracked | Should -Not -Contain 'run.ps1' -Because 'run.ps1 is consumer-owned (issue #222): it is scaffolded untracked for the consumer to commit and customize, not auto-committed as an upstream-managed meta-script'
            $tracked | Should -Not -Contain 'run.Tests.ps1' -Because 'run.Tests.ps1 is consumer-owned (issue #222), scaffolded untracked like run.ps1'
            $tracked | Should -Not -Contain 'Consolidate-Tasks.ps1' -Because 'the legacy script name was renamed and must not be re-introduced'
            $tracked | Should -Not -Contain 'Consolidate-Tasks.Tests.ps1'
        } finally { Pop-Location }
    }

    It 'F2: drift guard catches local edits to managed meta scripts (regression: ensures Pull-SDLC.ai.ps1 is a managed path)' {
        Test-IsUpstreamManagedPath -Path 'Pull-SDLC.ai.ps1' | Should -BeTrue
        Test-IsUpstreamManagedPath -Path 'Cleanup-Worktree.ps1' | Should -BeTrue
        Test-IsUpstreamManagedPath -Path 'Consolidate-Specs.ps1' | Should -BeTrue
        Test-IsUpstreamManagedPath -Path 'Consolidate-Specs.Tests.ps1' | Should -BeTrue
        Test-IsUpstreamManagedPath -Path 'Pull-SDLC.ai.Tests.ps1' | Should -BeTrue
        # run.ps1, run.Tests.ps1, and copilot-setup-steps.yml are consumer-owned
        # (issue #222): scaffolded once then always-local, so they are NOT
        # upstream-managed and never drift-gated (supersedes #206/#208).
        Test-IsUpstreamManagedPath -Path 'run.ps1' | Should -BeFalse
        Test-IsUpstreamManagedPath -Path 'run.Tests.ps1' | Should -BeFalse
        Test-IsUpstreamManagedPath -Path '.github/workflows/copilot-setup-steps.yml' | Should -BeFalse
        Test-IsAlwaysLocalPath -Path 'run.ps1' | Should -BeTrue
        Test-IsAlwaysLocalPath -Path 'run.Tests.ps1' | Should -BeTrue
        Test-IsAlwaysLocalPath -Path '.github/workflows/copilot-setup-steps.yml' | Should -BeTrue
        # All other .github/workflows/* remain consumer-owned too.
        Test-IsUpstreamManagedPath -Path '.github/workflows/validate-instructions.yml' | Should -BeFalse
        Test-IsUpstreamManagedPath -Path '.github/workflows/ci.yml' | Should -BeFalse
        # The retired filename stays managed so the rename/delete replays into
        # consumer trees on their next sync (orphan cleanup). Dropping it would
        # leave every consumer with a stale Consolidate-Tasks.ps1.
        Test-IsUpstreamManagedPath -Path 'Consolidate-Tasks.ps1' | Should -BeTrue
        Test-IsUpstreamManagedPath -Path 'Consolidate-Tasks.Tests.ps1' | Should -BeTrue
    }

    It 'F3: sync-manifest.json is not present in the upstream tree (deleted)' {
        $upstreamRoot = Resolve-Path (Join-Path $PSScriptRoot '.') | Select-Object -ExpandProperty Path
        Test-Path -LiteralPath (Join-Path $upstreamRoot 'sync-manifest.json') | Should -BeFalse -Because 'sync-manifest.json was drift-prone documentation and has been deleted in favor of the script-level lists.'
    }
}



# --- Issue #169: SSH-on-443 drift nudge removed -------------------------------

Describe 'Pull-SDLC.ai.ps1 post-sync output' {
    It 'does not invoke the SSH-on-443 drift nudge at the end of the script' {
        # Issue #169: a per-repo sync script must not lobby users to mutate
        # machine-wide SSH/git/gh configuration on every run. The opt-in
        # -SetupGitHubSsh switch remains for users who want it.
        $scriptPath = Join-Path $PSScriptRoot 'Pull-SDLC.ai.ps1'
        $scriptText = Get-Content -LiteralPath $scriptPath -Raw
        $scriptText | Should -Not -Match 'Write-GitHubSshNudge'
        $scriptText | Should -Not -Match 'Test-GitHubSshDrift'
    }
}

# --- Issue #164: GitHub SSH-on-443 setup --------------------------------------

Describe 'Test-IsCiEnvironment' {
    BeforeEach {
        Remove-Item Env:CI -ErrorAction SilentlyContinue
        Remove-Item Env:GITHUB_ACTIONS -ErrorAction SilentlyContinue
        Remove-Item Env:TF_BUILD -ErrorAction SilentlyContinue
    }
    AfterEach {
        Remove-Item Env:CI -ErrorAction SilentlyContinue
        Remove-Item Env:GITHUB_ACTIONS -ErrorAction SilentlyContinue
        Remove-Item Env:TF_BUILD -ErrorAction SilentlyContinue
    }
    It 'returns $false when no CI variables set' {
        Test-IsCiEnvironment | Should -BeFalse
    }
    It 'returns $true when $env:CI is set' {
        $env:CI = '1'
        Test-IsCiEnvironment | Should -BeTrue
    }
    It 'returns $true when $env:GITHUB_ACTIONS is set' {
        $env:GITHUB_ACTIONS = 'true'
        Test-IsCiEnvironment | Should -BeTrue
    }
}

Describe 'Add-GitConfigValueIfMissing' {
    It 'does not call git config --add when the value is already present' {
        Mock -CommandName Get-GitConfigAllValues -MockWith { @('https://github.com/') }
        Mock -CommandName git -MockWith { }
        $result = Add-GitConfigValueIfMissing -Key 'url.git@ssh.github.com:.insteadOf' -Value 'https://github.com/'
        $result | Should -BeFalse
        Should -Invoke -CommandName git -Times 0 -Exactly
    }
    It 'calls git config --add when the value is missing' {
        Mock -CommandName Get-GitConfigAllValues -MockWith { @() }
        Mock -CommandName git -MockWith { }
        $result = Add-GitConfigValueIfMissing -Key 'url.git@ssh.github.com:.insteadOf' -Value 'https://github.com/'
        $result | Should -BeTrue
        Should -Invoke -CommandName git -ParameterFilter {
            ($args -contains 'config') -and ($args -contains '--add')
        } -Times 1
    }
}

Describe 'Invoke-SetupGitHubSsh' -Skip:(-not $IsWindows) {
    BeforeEach {
        $script:gitCalls = New-Object System.Collections.Generic.List[string]
        $script:ghCalls = New-Object System.Collections.Generic.List[string]
        $script:keyPath = Join-Path $TestDrive 'id_ed25519'
        Mock -CommandName Get-GitHubSshKeyPath -MockWith { $script:keyPath }
        # Pretend key already exists so ssh-keygen is not invoked.
        New-Item -ItemType File -Path $script:keyPath -Force | Out-Null
        Set-Content -LiteralPath "$script:keyPath.pub" -Value 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz0123456789 user@host'
        Mock -CommandName Get-Service -MockWith {
            [pscustomobject]@{ Status = 'Running'; StartType = 'Automatic'; Name = 'ssh-agent' }
        } -ParameterFilter { $Name -eq 'ssh-agent' }
        Mock -CommandName Set-Service -MockWith { }
        Mock -CommandName Start-Service -MockWith { }
        Mock -CommandName ssh-add -MockWith { } -ErrorAction SilentlyContinue
        Mock -CommandName ssh-keygen -MockWith { } -ErrorAction SilentlyContinue
        Mock -CommandName Test-GhInstalled -MockWith { $true }
        Mock -CommandName Get-GhGitProtocol -MockWith { 'ssh' }
        Mock -CommandName Get-GitConfigAllValues -MockWith {
            param($Key)
            switch ($Key) {
                'url.git@ssh.github.com:.insteadOf' { return @('https://github.com/', 'git@github.com:') }
                'url.ssh://git@ssh.github.com:443/.insteadOf' { return @('ssh://git@github.com/') }
                'url.git@ssh.github.com:.pushInsteadOf' { return @() }
                default { return @() }
            }
        }
        Mock -CommandName git -MockWith { $script:gitCalls.Add(($args -join ' ')) }
        Mock -CommandName gh -MockWith { $script:ghCalls.Add(($args -join ' ')) }
    }

    It 'is idempotent: no git config --add or gh config set when everything is configured' {
        Invoke-SetupGitHubSsh -SkipKeyUpload | Out-Null
        ($script:gitCalls | Where-Object { $_ -match '--add' }) | Should -BeNullOrEmpty
        ($script:ghCalls  | Where-Object { $_ -match 'config set' }) | Should -BeNullOrEmpty
    }

    It '-SkipKeyUpload does NOT call gh ssh-key add' {
        Invoke-SetupGitHubSsh -SkipKeyUpload | Out-Null
        ($script:ghCalls | Where-Object { $_ -match 'ssh-key add' }) | Should -BeNullOrEmpty
    }

    It 'removes legacy pushInsteadOf https://github.com/ when present' {
        Mock -CommandName Get-GitConfigAllValues -MockWith {
            param($Key)
            switch ($Key) {
                'url.git@ssh.github.com:.insteadOf' { return @('https://github.com/', 'git@github.com:') }
                'url.ssh://git@ssh.github.com:443/.insteadOf' { return @('ssh://git@github.com/') }
                'url.git@ssh.github.com:.pushInsteadOf' { return @('https://github.com/') }
                default { return @() }
            }
        }
        Invoke-SetupGitHubSsh -SkipKeyUpload | Out-Null
        ($script:gitCalls | Where-Object { $_ -match 'unset-all.*pushInsteadOf' }) | Should -Not -BeNullOrEmpty
    }

    It 'adds missing url.insteadOf entries without duplicating existing ones' {
        Mock -CommandName Get-GitConfigAllValues -MockWith {
            param($Key)
            switch ($Key) {
                # Only the https value present; git@ value is missing
                'url.git@ssh.github.com:.insteadOf' { return @('https://github.com/') }
                'url.ssh://git@ssh.github.com:443/.insteadOf' { return @('ssh://git@github.com/') }
                default { return @() }
            }
        }
        Invoke-SetupGitHubSsh -SkipKeyUpload | Out-Null
        $addCalls = @($script:gitCalls | Where-Object { $_ -match '--add' })
        # The missing 'git@github.com:' value MUST be added.
        ($addCalls | Where-Object { $_ -match '\bgit@github\.com:$' }) | Should -Not -BeNullOrEmpty
        # The already-present https value must NOT be re-added.
        ($addCalls | Where-Object { $_ -match '\bhttps://github\.com/$' }) | Should -BeNullOrEmpty
    }
}

Describe 'Test-LocalDriftOnManagedPaths (issue #178: EOL false positive)' {
    BeforeEach {
        $script:driftRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("drift-eol-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:driftRepo | Out-Null
        Push-Location $script:driftRepo
        git init -q -b main
        git config user.email 't@t.t'
        git config user.name 't'
        # Disable autocrlf so the test controls blob bytes deterministically.
        git config core.autocrlf false
    }

    AfterEach {
        Pop-Location
        Remove-Item -Recurse -Force -LiteralPath $script:driftRepo -ErrorAction SilentlyContinue
    }

    It 'does NOT report drift when HEAD differs from the anchor only by CRLF/LF line endings' {
        # Anchor commit: managed file stored with LF (the upstream form).
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'CLAUDE.md'), "line one`nline two`n")
        git add -A | Out-Null
        git commit -q -m 'anchor (LF)'
        $anchor = (git rev-parse HEAD).Trim()
        # HEAD commit: identical content re-committed with CRLF (a Windows consumer).
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'CLAUDE.md'), "line one`r`nline two`r`n")
        git add -A | Out-Null
        git commit -q -m 'consumer sync (CRLF)'

        # Sanity: the raw blob SHAs really do differ (otherwise the test is vacuous).
        (git rev-parse "HEAD:CLAUDE.md").Trim() | Should -Not -Be (git rev-parse "${anchor}:CLAUDE.md").Trim()

        $drift = @(Test-LocalDriftOnManagedPaths -Anchor $anchor -ManagedPaths 'CLAUDE.md' -RepoRoot $script:driftRepo)
        $drift.Count | Should -Be 0
    }

    It 'reports drift when HEAD has a genuine content change beyond line endings' {
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'CLAUDE.md'), "line one`nline two`n")
        git add -A | Out-Null
        git commit -q -m 'anchor'
        $anchor = (git rev-parse HEAD).Trim()
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'CLAUDE.md'), "line one`nEDITED line two`n")
        git add -A | Out-Null
        git commit -q -m 'real local edit'

        $drift = @(Test-LocalDriftOnManagedPaths -Anchor $anchor -ManagedPaths 'CLAUDE.md' -RepoRoot $script:driftRepo)
        $drift.Count | Should -Be 1
        $drift[0].Path | Should -Be 'CLAUDE.md'
    }

    It 'reports drift for an upstream-deleted file the consumer still has committed' {
        # Anchor does NOT contain CLAUDE.md (simulates a file deleted upstream).
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'README.txt'), "seed`n")
        git add -A | Out-Null
        git commit -q -m 'anchor without managed file'
        $anchor = (git rev-parse HEAD).Trim()
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'CLAUDE.md'), "orphaned content`n")
        git add -A | Out-Null
        git commit -q -m 'consumer still carries deleted file'

        $drift = @(Test-LocalDriftOnManagedPaths -Anchor $anchor -ManagedPaths 'CLAUDE.md' -RepoRoot $script:driftRepo)
        $drift.Count | Should -Be 1
        $drift[0].Path | Should -Be 'CLAUDE.md'
    }

    It 'does NOT report drift for a locally-customized run.ps1 (consumer-owned, issue #222)' {
        # Reproduces the PSBitwarden POLICY VIOLATION: a consumer that customizes
        # run.ps1 must not be blocked. run.ps1 is always-local, so the drift gate
        # skips it even though its content genuinely differs from the anchor.
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'run.ps1'), "# upstream runner`n")
        git add -A | Out-Null
        git commit -q -m 'anchor'
        $anchor = (git rev-parse HEAD).Trim()
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo 'run.ps1'), "# CONSUMER-CUSTOMIZED runner with extra behavior`n")
        git add -A | Out-Null
        git commit -q -m 'consumer customizes run.ps1'

        # Sanity: a genuine content change (not just EOL) -- otherwise vacuous.
        (git rev-parse "HEAD:run.ps1").Trim() | Should -Not -Be (git rev-parse "${anchor}:run.ps1").Trim()

        $drift = @(Test-LocalDriftOnManagedPaths -Anchor $anchor -ManagedPaths 'run.ps1' -RepoRoot $script:driftRepo)
        $drift.Count | Should -Be 0 -Because 'run.ps1 is consumer-owned (always-local) and must never trip the drift gate (issue #222)'
    }

    It 'does NOT report drift for a locally-customized .github/workflows/copilot-setup-steps.yml (consumer-owned, issue #222)' {
        New-Item -ItemType Directory -Path (Join-Path $script:driftRepo '.github/workflows') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo '.github/workflows/copilot-setup-steps.yml'), "name: upstream setup`n")
        git add -A | Out-Null
        git commit -q -m 'anchor'
        $anchor = (git rev-parse HEAD).Trim()
        [System.IO.File]::WriteAllText((Join-Path $script:driftRepo '.github/workflows/copilot-setup-steps.yml'), "name: consumer-customized setup`n")
        git add -A | Out-Null
        git commit -q -m 'consumer customizes setup workflow'

        $drift = @(Test-LocalDriftOnManagedPaths -Anchor $anchor -ManagedPaths '.github/workflows/copilot-setup-steps.yml' -RepoRoot $script:driftRepo)
        $drift.Count | Should -Be 0 -Because 'copilot-setup-steps.yml is consumer-owned (always-local) and must never trip the drift gate (issue #222)'
    }
}


Describe 'Output stream assignment (issue #194)' {

    BeforeEach {
        $script:streamRoot = Join-Path $TestDrive ("stream-" + [guid]::NewGuid().ToString('N'))
    }

    # --- Category 1: fatal messages land on the error stream (rc preserved) ---

    It 'POLICY VIOLATION lands on the error stream and still returns rc=2' {
        $fx = New-DiffReplayFixture -Root $script:streamRoot `
            -Seed { 'anchor body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'upstream new body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        'consumer override' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'CLAUDE.md') -NoNewline
        Push-Location $fx.Consumer
        try { git add CLAUDE.md; git commit -q -m 'local edit to managed file' } finally { Pop-Location }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -ErrorVariable streamErr 2>$null
        $rc | Should -Be 2
        ($streamErr -join "`n") | Should -Match 'POLICY VIOLATION'
    }

    It 'ABORT commit-context lands on the error stream and still returns rc=3' {
        $fx = New-DiffReplayFixture -Root $script:streamRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        '{"remote":"sdlc.ai","ref":"main","lastSyncCommit":"abc","syncedAt":"2026-01-01T00:00:00Z"}' |
            Out-File -Encoding utf8 -LiteralPath (Join-Path $fx.Consumer '.sdlc-ai-sync.json') -NoNewline
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git remote add origin https://example.invalid/owner/repo.git
        } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoWorktree -ErrorVariable streamErr 2>$null
        $rc | Should -Be 3
        ($streamErr -join "`n") | Should -Match 'ABORT: cannot create sync commit'
    }

    It 'no git repo with -NoAutoInit lands on the error stream and still returns rc=5' {
        $empty = Join-Path $TestDrive ("nogit-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $empty -Force | Out-Null
        Push-Location $empty
        try {
            $rc = Invoke-PullSDLC -NoAutoInit -NoFetch -ErrorVariable streamErr 2>$null
        } finally { Pop-Location }
        $rc | Should -Be 5
        ($streamErr -join "`n") | Should -Match 'not inside a git repository'
    }

    # --- Category 2: non-fatal advisories land on the warning stream ---

    It 'the -Force overwrite advisory lands on the warning stream' {
        $fx = New-DiffReplayFixture -Root $script:streamRoot `
            -Seed { 'anchor body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'upstream new body' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        'consumer override' | Out-File -Encoding utf8 (Join-Path $fx.Consumer 'CLAUDE.md') -NoNewline
        Push-Location $fx.Consumer
        try { git add CLAUDE.md; git commit -q -m 'local edit to managed file' } finally { Pop-Location }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -Force -WarningVariable streamWarn -WarningAction SilentlyContinue
        $rc | Should -Be 0
        ($streamWarn -join "`n") | Should -Match '-Force in effect'
    }

    It 'Bootstrap declined lands on the warning stream and returns rc=1' {
        $fx = New-DiffReplayFixture -Root $script:streamRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Mock -CommandName Resolve-SyncAnchor -MockWith { $null }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -WarningVariable streamWarn -WarningAction SilentlyContinue
        $rc | Should -Be 1
        ($streamWarn -join "`n") | Should -Match 'Bootstrap declined'
    }

    # --- Category 3: status/progress flow through Write-Information (not Write-Host) ---

    It 'sync status messages flow through Write-Information, not Write-Host' {
        $fx = New-DiffReplayFixture -Root $script:streamRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents -Force | Out-Null
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                'aaa' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline
            }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -InformationVariable streamInfo 6>$null
        $rc | Should -Be 0

        $commitRec = $streamInfo | Where-Object { "$($_.MessageData)" -match 'Created sync commit' } | Select-Object -First 1
        $commitRec | Should -Not -BeNullOrEmpty
        # Must be a genuine Write-Information record, NOT Write-Host (which tags PSHOST).
        $commitRec.Tags | Should -Not -Contain 'PSHOST'

        $appliedRec = $streamInfo | Where-Object { "$($_.MessageData)" -match 'Applied 2 ops' } | Select-Object -First 1
        $appliedRec | Should -Not -BeNullOrEmpty
        $appliedRec.Tags | Should -Not -Contain 'PSHOST'
    }

    # --- Regression #196: blank-line separators dropped by the stream refactor ---

    It 'emits a blank-line separator immediately before the -WhatIf footer' {
        $fx = New-DiffReplayFixture -Root $script:streamRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; 'one' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline } `
            -Tweak { 'TWO' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -WhatIf -InformationVariable streamInfo 6>$null
        $rc | Should -Be 0

        $msgs = @($streamInfo | ForEach-Object { "$($_.MessageData)" })
        $idx = [array]::IndexOf($msgs, '-WhatIf specified; no changes written.')
        $idx | Should -BeGreaterThan 0
        $msgs[$idx - 1] | Should -Be ''
    }

    It 'emits a blank-line separator immediately before the up-to-date footer' {
        $fx = New-DiffReplayFixture -Root $script:streamRoot `
            -Seed { 'same' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.UpstreamHead
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch -InformationVariable streamInfo 6>$null
        $rc | Should -Be 0

        $msgs = @($streamInfo | ForEach-Object { "$($_.MessageData)" })
        $idx = [array]::IndexOf($msgs, 'Already up to date.')
        $idx | Should -BeGreaterThan 0
        $msgs[$idx - 1] | Should -Be ''
    }
}

Describe 'Test-IsUpstreamPrivatePath' {

    It 'is true for a Pester test file under .github/agents/tests/' {
        Test-IsUpstreamPrivatePath -Path '.github/agents/tests/dev-loop.Tests.ps1' | Should -BeTrue
    }

    It 'is true for a fixture under .github/agents/tests/fixtures/' {
        Test-IsUpstreamPrivatePath -Path '.github/agents/tests/fixtures/pii-planted.har' | Should -BeTrue
    }

    It 'is true for a tests directory nested under a named skill' {
        Test-IsUpstreamPrivatePath -Path '.github/skills/evidence-capture/tests/evidence.Tests.ps1' | Should -BeTrue
    }

    It 'is true for a fixtures directory nested under a named skill' {
        Test-IsUpstreamPrivatePath -Path '.github/skills/api-wrapper-scaffold/fixtures/bearer.har' | Should -BeTrue
    }

    It 'is false for a shipped agent definition' {
        Test-IsUpstreamPrivatePath -Path '.github/agents/dev-loop.agent.md' | Should -BeFalse
    }

    It 'is false for a shipped skill definition' {
        Test-IsUpstreamPrivatePath -Path '.github/skills/evidence-capture/SKILL.md' | Should -BeFalse
    }

    It 'is false for a managed instruction file' {
        Test-IsUpstreamPrivatePath -Path '.github/instructions/csharp.instructions.md' | Should -BeFalse
    }

    It 'is false for a directory merely containing "tests" in its name' {
        Test-IsUpstreamPrivatePath -Path '.github/agents/mytests/foo.md' | Should -BeFalse
    }

    It 'is false for a consumer-owned project-* skill tests directory (always-local trumps)' {
        Test-IsUpstreamPrivatePath -Path '.github/skills/project-foo/tests/bar.Tests.ps1' | Should -BeFalse
    }

    It 'is false for a consumer-owned project-* skill fixtures directory (always-local trumps)' {
        Test-IsUpstreamPrivatePath -Path '.github/skills/project-foo/fixtures/sample.har' | Should -BeFalse
    }

    It 'tolerates a ./ prefix' {
        Test-IsUpstreamPrivatePath -Path './.github/agents/tests/foo.Tests.ps1' | Should -BeTrue
    }

    It 'is false for an empty path' {
        Test-IsUpstreamPrivatePath -Path '' | Should -BeFalse
    }
}

Describe 'Get-UpstreamOps upstream-private filtering' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("fxpriv-" + [guid]::NewGuid().ToString('N'))
    }

    It 'drops an A row for a newly added upstream-private test file but keeps a normal add' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/agents -Force | Out-Null; 'one' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline } `
            -Tweak {
                New-Item -ItemType Directory -Path .github/agents/tests -Force | Out-Null
                'normal' | Out-File -Encoding utf8 .github/agents/b.md -NoNewline
                'private test' | Out-File -Encoding utf8 .github/agents/tests/new.Tests.ps1 -NoNewline
            }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('.github/agents/','.github/skills/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -eq '.github/agents/b.md' }) | Should -Not -BeNullOrEmpty
        ($ops | Where-Object { $_.Path -eq '.github/agents/tests/new.Tests.ps1' }) | Should -BeNullOrEmpty
    }

    It 'drops an M row for a modified upstream-private fixture' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents/tests/fixtures -Force | Out-Null
                'v1 payload' | Out-File -Encoding utf8 .github/agents/tests/fixtures/bearer.har -NoNewline
            } `
            -Tweak { 'v2 payload with more content to sync' | Out-File -Encoding utf8 .github/agents/tests/fixtures/bearer.har -NoNewline }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('.github/agents/','.github/skills/') -RepoRoot $fx.Consumer
        ($ops | Where-Object { $_.Path -eq '.github/agents/tests/fixtures/bearer.har' }) | Should -BeNullOrEmpty
    }

    It 'keeps an add for a consumer-owned project-* skill tests file (never treated as upstream-private)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { New-Item -ItemType Directory -Path .github/skills -Force | Out-Null; 'anchor' | Out-File -Encoding utf8 .github/skills/keep.md -NoNewline } `
            -Tweak {
                New-Item -ItemType Directory -Path .github/skills/project-foo/tests -Force | Out-Null
                'proj test' | Out-File -Encoding utf8 .github/skills/project-foo/tests/bar.Tests.ps1 -NoNewline
            }
        $ops = Get-UpstreamOps -Anchor $fx.AnchorSha -Ref 'sdlc.ai/main' -ManagedPaths @('.github/agents/','.github/skills/') -RepoRoot $fx.Consumer
        # project-* is always-local, so Get-UpstreamOps drops it as always-local
        # (not because it is upstream-private). Assert it is not shipped either way.
        ($ops | Where-Object { $_.Path -eq '.github/skills/project-foo/tests/bar.Tests.ps1' }) | Should -BeNullOrEmpty
    }
}

Describe 'Get-UpstreamPrivatePruneOps' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("fxprune-" + [guid]::NewGuid().ToString('N'))
    }

    It 'emits D ops for tracked upstream-private files and nothing else' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents/tests/fixtures -Force | Out-Null
                New-Item -ItemType Directory -Path .github/skills/evidence-capture/tests -Force | Out-Null
                New-Item -ItemType Directory -Path .github/skills/project-foo/tests -Force | Out-Null
                'agent' | Out-File -Encoding utf8 .github/agents/dev-loop.agent.md -NoNewline
                'test'  | Out-File -Encoding utf8 .github/agents/tests/foo.Tests.ps1 -NoNewline
                'har'   | Out-File -Encoding utf8 .github/agents/tests/fixtures/bar.har -NoNewline
                'skill' | Out-File -Encoding utf8 .github/skills/evidence-capture/SKILL.md -NoNewline
                'stest' | Out-File -Encoding utf8 .github/skills/evidence-capture/tests/baz.Tests.ps1 -NoNewline
                'keep'  | Out-File -Encoding utf8 .github/skills/project-foo/tests/keep.Tests.ps1 -NoNewline
            }
        $ops = @(Get-UpstreamPrivatePruneOps -RepoRoot $fx.Consumer)
        $pruned = $ops | ForEach-Object { $_.Path } | Sort-Object
        $ops | ForEach-Object { $_.Op } | Should -Not -Contain 'A'
        $pruned | Should -Be @(
            '.github/agents/tests/fixtures/bar.har',
            '.github/agents/tests/foo.Tests.ps1',
            '.github/skills/evidence-capture/tests/baz.Tests.ps1'
        )
    }

    It 'returns no ops when there are no upstream-private files present' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents -Force | Out-Null
                'agent' | Out-File -Encoding utf8 .github/agents/dev-loop.agent.md -NoNewline
            }
        @(Get-UpstreamPrivatePruneOps -RepoRoot $fx.Consumer).Count | Should -Be 0
    }

    It 'does not prune a consumer-owned project-* skill tests file' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/skills/project-foo/tests -Force | Out-Null
                'keep' | Out-File -Encoding utf8 .github/skills/project-foo/tests/keep.Tests.ps1 -NoNewline
            }
        @(Get-UpstreamPrivatePruneOps -RepoRoot $fx.Consumer).Count | Should -Be 0
    }
}

Describe 'Invoke-PullSDLC prunes upstream-private paths from consumers' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("e2eprune-" + [guid]::NewGuid().ToString('N'))
    }

    It 'removes a stale upstream-private file from the consumer and never ships a new one' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed {
                New-Item -ItemType Directory -Path .github/agents/tests -Force | Out-Null
                'baseline-claude' | Out-File -Encoding utf8 CLAUDE.md -NoNewline
                'agent one' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline
                'stale private test' | Out-File -Encoding utf8 .github/agents/tests/stale.Tests.ps1 -NoNewline
            } `
            -Tweak {
                'agent one v2 with more content to sync downstream' | Out-File -Encoding utf8 .github/agents/a.md -NoNewline
                'brand new private test' | Out-File -Encoding utf8 .github/agents/tests/new.Tests.ps1 -NoNewline
            }
        Set-SdlcSyncState -RepoRoot $fx.Consumer -Remote 'sdlc.ai' -Ref 'main' -Commit $fx.AnchorSha
        Push-Location $fx.Consumer
        try { git add .sdlc-ai-sync.json; git commit -q -m 'seed state' } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -NoFetch
        $rc | Should -Be 0
        # Stale upstream-private file pruned from the consumer working tree.
        Test-Path (Join-Path $fx.Consumer '.github/agents/tests/stale.Tests.ps1') | Should -BeFalse
        # New upstream-private file was never shipped.
        Test-Path (Join-Path $fx.Consumer '.github/agents/tests/new.Tests.ps1') | Should -BeFalse
        # Normal managed sync still applied.
        (Get-Content (Join-Path $fx.Consumer '.github/agents/a.md') -Raw).Trim() | Should -Match 'agent one v2'
        # The prune is committed (working tree clean under the managed path).
        Push-Location $fx.Consumer
        try {
            (git status --porcelain -- .github/agents) | Should -BeNullOrEmpty
        } finally { Pop-Location }
    }
}
