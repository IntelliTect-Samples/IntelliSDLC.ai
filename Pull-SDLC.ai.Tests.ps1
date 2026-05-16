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

Describe 'Test-IsAlwaysLocalPath' {
    It 'returns $true for README.md' {
        Test-IsAlwaysLocalPath -Path 'README.md' | Should -BeTrue
    }

    It 'returns $true for readme.md (case-insensitive)' {
        Test-IsAlwaysLocalPath -Path 'readme.md' | Should -BeTrue
    }

    It 'returns $true for .gitignore' {
        Test-IsAlwaysLocalPath -Path '.gitignore' | Should -BeTrue
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
}

Describe 'Resolve-AlwaysLocalConflicts' {
    It 'returns README.md and .gitignore from UU lines, ignoring other paths' {
        $porcelain = @(
            'UU README.md',
            'UU .gitignore',
            'UU src/Other.cs'
        )
        $result = @(Resolve-AlwaysLocalConflicts -Porcelain $porcelain)
        $result.Count | Should -Be 2
        $result | Should -Contain 'README.md'
        $result | Should -Contain '.gitignore'
        $result | Should -Not -Contain 'src/Other.cs'
    }

    It 'returns an empty array on empty input' {
        $result = @(Resolve-AlwaysLocalConflicts -Porcelain @())
        $result.Count | Should -Be 0
    }

    It 'ignores non-conflict porcelain lines' {
        $porcelain = @(
            ' M README.md',
            '?? .gitignore',
            'A  README.md'
        )
        $result = @(Resolve-AlwaysLocalConflicts -Porcelain $porcelain)
        $result.Count | Should -Be 0
    }

    It 'also matches AA (both added) for always-local paths' {
        $porcelain = @('AA README.md')
        $result = @(Resolve-AlwaysLocalConflicts -Porcelain $porcelain)
        $result | Should -Contain 'README.md'
    }

    It 'also matches DD (both deleted) for always-local paths' {
        $porcelain = @('DD .gitignore')
        $result = @(Resolve-AlwaysLocalConflicts -Porcelain $porcelain)
        $result | Should -Contain '.gitignore'
    }

    It 'does not return non-always-local paths even when conflicted' {
        $porcelain = @('UU CLAUDE.md', 'UU run.ps1')
        $result = @(Resolve-AlwaysLocalConflicts -Porcelain $porcelain)
        $result.Count | Should -Be 0
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

Describe 'Get-SyncManifestPaths' {
    It 'returns empty arrays on null input' {
        $r = Get-SyncManifestPaths -Json $null
        $r.Paths.Count | Should -Be 0
        $r.ConsumerOwned.Count | Should -Be 0
    }

    It 'returns empty arrays on empty/whitespace input' {
        (Get-SyncManifestPaths -Json '').Paths.Count | Should -Be 0
        (Get-SyncManifestPaths -Json "   `n  ").Paths.Count | Should -Be 0
    }

    It 'returns empty arrays on invalid JSON (with warning)' {
        $r = Get-SyncManifestPaths -Json '{ not valid' -WarningAction SilentlyContinue
        $r.Paths.Count | Should -Be 0
    }

    It 'parses paths and consumer_owned arrays' {
        $json = @'
{
  "paths": ["CLAUDE.md", ".github/agents/*.agent.md"],
  "consumer_owned": ["README.md", "CLAUDE.project.md"]
}
'@
        $r = Get-SyncManifestPaths -Json $json
        $r.Paths.Count | Should -Be 2
        $r.Paths | Should -Contain 'CLAUDE.md'
        $r.Paths | Should -Contain '.github/agents/*.agent.md'
        $r.ConsumerOwned | Should -Contain 'README.md'
        $r.ConsumerOwned | Should -Contain 'CLAUDE.project.md'
    }

    It 'tolerates missing consumer_owned key' {
        $r = Get-SyncManifestPaths -Json '{ "paths": ["CLAUDE.md"] }'
        $r.Paths.Count | Should -Be 1
        $r.ConsumerOwned.Count | Should -Be 0
    }

    It 'filters out null/whitespace path entries' {
        $r = Get-SyncManifestPaths -Json '{ "paths": ["CLAUDE.md", "", "   ", null, ".gitignore"] }'
        $r.Paths.Count | Should -Be 2
    }
}

Describe 'Convert-GlobToRegex' {
    It 'matches a literal path exactly' {
        $rx = [regex]::new((Convert-GlobToRegex -Glob 'CLAUDE.md'))
        $rx.IsMatch('CLAUDE.md')  | Should -BeTrue
        $rx.IsMatch('CLAUDExmd')  | Should -BeFalse
        $rx.IsMatch('sub/CLAUDE.md') | Should -BeFalse
    }

    It 'single * does not cross /' {
        $rx = [regex]::new((Convert-GlobToRegex -Glob '.github/agents/*.agent.md'))
        $rx.IsMatch('.github/agents/dev-loop.agent.md') | Should -BeTrue
        $rx.IsMatch('.github/agents/nested/dev-loop.agent.md') | Should -BeFalse
        $rx.IsMatch('.github/agents/dev-loop.md') | Should -BeFalse
    }

    It '** matches across path segments' {
        $rx = [regex]::new((Convert-GlobToRegex -Glob '.github/skills/foo/**'))
        $rx.IsMatch('.github/skills/foo/SKILL.md') | Should -BeTrue
        $rx.IsMatch('.github/skills/foo/helpers/Bar.ps1') | Should -BeTrue
        $rx.IsMatch('.github/skills/foo/helpers/sub/Bar.ps1') | Should -BeTrue
        $rx.IsMatch('.github/skills/bar/SKILL.md') | Should -BeFalse
    }

    It 'escapes regex metacharacters in literal segments' {
        $rx = [regex]::new((Convert-GlobToRegex -Glob 'docs/file.name+ext.md'))
        $rx.IsMatch('docs/file.name+ext.md') | Should -BeTrue
        $rx.IsMatch('docs/fileXnameXextXmd') | Should -BeFalse
    }
}

Describe 'Expand-SyncPaths' {
    BeforeAll {
        $script:tree = @(
            'CLAUDE.md',
            '.github/copilot-instructions.md',
            '.github/agents/dev-loop.agent.md',
            '.github/agents/plan.agent.md',
            '.github/agents/tests/some-test.Tests.ps1',
            '.github/skills/foo/SKILL.md',
            '.github/skills/foo/helpers/Helper.ps1',
            'templates/api-wrapper-scaffold/scripts/generate-wrapper.js',
            'docs/dogfood/report.md'
        )
    }

    It 'returns an empty array when nothing matches' {
        $r = @(Expand-SyncPaths -Patterns @('does/not/exist.md') -TreeListing $script:tree)
        $r.Count | Should -Be 0
    }

    It 'returns literal paths only when present in tree' {
        $r = @(Expand-SyncPaths -Patterns @('CLAUDE.md', 'NONEXISTENT.md') -TreeListing $script:tree)
        $r.Count | Should -Be 1
        $r | Should -Contain 'CLAUDE.md'
    }

    It 'expands a single-segment glob' {
        $r = @(Expand-SyncPaths -Patterns @('.github/agents/*.agent.md') -TreeListing $script:tree)
        $r.Count | Should -Be 2
        $r | Should -Contain '.github/agents/dev-loop.agent.md'
        $r | Should -Contain '.github/agents/plan.agent.md'
        $r | Should -Not -Contain '.github/agents/tests/some-test.Tests.ps1'
    }

    It 'expands a ** glob into a full subtree' {
        $r = @(Expand-SyncPaths -Patterns @('.github/skills/foo/**') -TreeListing $script:tree)
        $r.Count | Should -Be 2
        $r | Should -Contain '.github/skills/foo/SKILL.md'
        $r | Should -Contain '.github/skills/foo/helpers/Helper.ps1'
    }

    It 'leaves upstream-only paths absent when not in the manifest' {
        # This is the key regression assertion for upstream issue #82: junk
        # outside the manifest must stay unselected.
        $r = @(Expand-SyncPaths -Patterns @(
            'CLAUDE.md',
            '.github/agents/*.agent.md',
            '.github/skills/foo/**'
        ) -TreeListing $script:tree)
        $r | Should -Not -Contain 'templates/api-wrapper-scaffold/scripts/generate-wrapper.js'
        $r | Should -Not -Contain 'docs/dogfood/report.md'
        $r | Should -Not -Contain '.github/agents/tests/some-test.Tests.ps1'
    }

    It 'de-duplicates paths matched by multiple patterns' {
        $r = @(Expand-SyncPaths -Patterns @('CLAUDE.md', 'CLAUDE.md', '**/CLAUDE.md') -TreeListing $script:tree)
        $r.Count | Should -Be 1
    }
}

Describe 'Selective-mode integration: only manifest paths are pulled (#82)' {
    BeforeEach {
        # Create an isolated upstream + consumer pair.
        $script:root = Join-Path ([System.IO.Path]::GetTempPath()) ("sel-" + [guid]::NewGuid().ToString('N'))
        $script:upstream = Join-Path $script:root 'upstream'
        $script:consumer = Join-Path $script:root 'consumer'
        New-Item -ItemType Directory -Path $script:upstream | Out-Null
        New-Item -ItemType Directory -Path $script:consumer | Out-Null

        # --- Build upstream repo with manifest + good and junk files. ---
        Push-Location $script:upstream
        git init -q -b main
        git config user.email 't@t.t'; git config user.name 't'

        Set-Content -Path CLAUDE.md -Value 'UPSTREAM_CLAUDE'
        New-Item -ItemType Directory -Path .github/agents -Force | Out-Null
        Set-Content -Path .github/agents/dev-loop.agent.md -Value 'UPSTREAM_DEVLOOP'
        New-Item -ItemType Directory -Path templates/junk -Force | Out-Null
        Set-Content -Path templates/junk/generated.js -Value 'UPSTREAM_JUNK_GENERATED'
        New-Item -ItemType Directory -Path docs -Force | Out-Null
        Set-Content -Path docs/dogfood-report.md -Value 'UPSTREAM_DOGFOOD'

        $manifest = @'
{
  "paths": ["CLAUDE.md", ".github/agents/*.agent.md"],
  "consumer_owned": ["README.md"]
}
'@
        Set-Content -Path sync-manifest.json -Value $manifest
        Copy-Item (Join-Path $PSScriptRoot 'Pull-SDLC.ai.ps1') .
        git add . | Out-Null
        git commit -q -m 'upstream initial'
        Pop-Location

        # --- Build consumer repo. ---
        Push-Location $script:consumer
        git init -q -b main
        git config user.email 't@t.t'; git config user.name 't'
        git remote add origin 'https://github.com/SomeOrg/SomeProject.git'
        Set-Content -Path README.md -Value 'CONSUMER_README'
        Set-Content -Path CLAUDE.md -Value 'CONSUMER_OLD_CLAUDE'
        git add . | Out-Null
        git commit -q -m 'consumer initial'
        Copy-Item (Join-Path $PSScriptRoot 'Pull-SDLC.ai.ps1') .
        Pop-Location
    }

    AfterEach {
        Pop-Location -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force -LiteralPath $script:root -ErrorAction SilentlyContinue
    }

    It 'pulls only manifest paths and does not leak upstream junk' {
        Push-Location $script:consumer
        try {
            $upstreamUrl = $script:upstream -replace '\\','/'
            # Pre-wire the remote so the script's `git remote add` short-circuits.
            git remote add sdlc.ai $upstreamUrl 2>$null | Out-Null

            $stdout = Join-Path $script:consumer 'out.txt'
            $stderr = Join-Path $script:consumer 'err.txt'
            $proc = Start-Process pwsh -ArgumentList '-NoProfile','-NonInteractive','-File',
                (Join-Path $script:consumer 'Pull-SDLC.ai.ps1') `
                -WorkingDirectory $script:consumer -Wait -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            $combined = (Get-Content $stdout -Raw -ErrorAction SilentlyContinue) + (Get-Content $stderr -Raw -ErrorAction SilentlyContinue)
            $combined | Should -Match 'Selective sync mode'

            # CLAUDE.md and the agent file should be staged with upstream content.
            $staged = @(git diff --name-only --cached)
            $staged | Should -Contain 'CLAUDE.md'
            $staged | Should -Contain '.github/agents/dev-loop.agent.md'

            # Junk paths must NOT have been staged or written to working tree.
            Test-Path (Join-Path $script:consumer 'templates/junk/generated.js') | Should -BeFalse
            Test-Path (Join-Path $script:consumer 'docs/dogfood-report.md')     | Should -BeFalse
            $staged | Should -Not -Contain 'templates/junk/generated.js'
            $staged | Should -Not -Contain 'docs/dogfood-report.md'

            # README.md (consumer_owned) must be untouched.
            (Get-Content (Join-Path $script:consumer 'README.md') -Raw).Trim() | Should -Be 'CONSUMER_README'
        }
        finally {
            Pop-Location
        }
    }
}
