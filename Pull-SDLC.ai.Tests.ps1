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
            # Allow a state-file refresh commit (syncedAt timestamp changes) but
            # never a content commit.
            $changed = git diff --name-only "$beforeSha..HEAD"
            $changed | Where-Object { $_ -ne '.sdlc-ai-sync.json' } | Should -BeNullOrEmpty
        } finally { Pop-Location }
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
}
