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

Describe '.gitattributes.template bootstrap (issue #119)' {
    BeforeAll {
        $script:repoRoot = Resolve-Path (Join-Path $PSScriptRoot '.') | Select-Object -ExpandProperty Path
    }

    It '$script:TemplateScaffoldMap maps .gitattributes.template -> .gitattributes' {
        $script:TemplateScaffoldMap.Keys | Should -Contain '.gitattributes.template'
        $script:TemplateScaffoldMap['.gitattributes.template'] | Should -Be '.gitattributes'
    }

    It '.gitattributes.template exists at upstream repo root' {
        Test-Path -LiteralPath (Join-Path $script:repoRoot '.gitattributes.template') | Should -BeTrue
    }

    It '.gitattributes is on the always-local list (consumer-owned once placed)' {
        Test-IsAlwaysLocalPath -Path '.gitattributes' | Should -BeTrue
    }

    It 'creates consumer .gitattributes on first scaffold when none exists' {
        $src = Join-Path $TestDrive 'gabt-src'
        $dst = Join-Path $TestDrive 'gabt-dst1'
        New-Item -ItemType Directory -Path $src, $dst -Force | Out-Null
        Set-Content -Path (Join-Path $src '.gitattributes.template') -Value '* text=auto'
        $map = [ordered]@{ '.gitattributes.template' = '.gitattributes' }
        $result = @(Invoke-TemplateScaffold -SourceRoot $src -TargetRoot $dst -ScaffoldMap $map)
        $result | Should -Contain '.gitattributes'
        Test-Path (Join-Path $dst '.gitattributes') | Should -BeTrue
    }

    It 'leaves an existing consumer .gitattributes untouched' {
        $src = Join-Path $TestDrive 'gabt-src2'
        $dst = Join-Path $TestDrive 'gabt-dst2'
        New-Item -ItemType Directory -Path $src, $dst -Force | Out-Null
        Set-Content -Path (Join-Path $src '.gitattributes.template') -Value '* text=auto'
        Set-Content -Path (Join-Path $dst '.gitattributes')          -Value 'CONSUMER_OWNED'
        $map = [ordered]@{ '.gitattributes.template' = '.gitattributes' }
        $result = @(Invoke-TemplateScaffold -SourceRoot $src -TargetRoot $dst -ScaffoldMap $map)
        $result.Count | Should -Be 0
        (Get-Content (Join-Path $dst '.gitattributes') -Raw).Trim() | Should -Be 'CONSUMER_OWNED'
    }

    It 'template content includes the baseline rules (LF for .sh, CRLF for .ps1, .png binary)' {
        $body = Get-Content -LiteralPath (Join-Path $script:repoRoot '.gitattributes.template') -Raw
        $body | Should -Match '(?m)^\*\.sh\s+text\s+eol=lf'
        $body | Should -Match '(?m)^\*\.ps1\s+text\s+eol=crlf'
        $body | Should -Match '(?m)^\*\.bat\s+text\s+eol=crlf'
        $body | Should -Match '(?m)^\*\.png\s+binary'
        $body | Should -Match '(?m)^\*\s+text=auto'
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
}

Describe 'Invoke-PullSDLC protected-branch guard' {

    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("guard-" + [guid]::NewGuid().ToString('N'))
    }

    It 'aborts with rc=3 when invoked on main with -NoAutoWorktree (no -AllowDefaultBranch)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Move the consumer back onto main so the guard fires.
        Push-Location $fx.Consumer
        try { git checkout -q main } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoWorktree
        $rc | Should -Be 3
        # Working tree must be untouched.
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'a'
        Test-Path (Join-Path $fx.Consumer '.sdlc-ai-sync.json') | Should -BeFalse
    }

    It '-AllowDefaultBranch bypasses the guard on main' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Push-Location $fx.Consumer
        try { git checkout -q main } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -AllowDefaultBranch
        $rc | Should -Be 0
        (Get-Content (Join-Path $fx.Consumer 'CLAUDE.md') -Raw) | Should -Be 'b'
    }

    It '-WhatIf bypasses the guard even on main (no mutation possible)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Push-Location $fx.Consumer
        try { git checkout -q main } finally { Pop-Location }

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -WhatIf
        $rc | Should -Be 0
        # Untouched.
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
        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR
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

    It 'aborts rc=5 when existing worktree has uncommitted changes' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline } `
            -Tweak { 'b' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        # Pre-create the worktree with a dirty file.
        # Fixture leaves consumer on chore/sdlc-sync; switch to main, then check out branch into a worktree.
        $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
        Push-Location $fx.Consumer
        try {
            git checkout -q main
            git worktree add $wt chore/sdlc-sync | Out-Null
        } finally { Pop-Location }
        'dirty work' | Out-File -Encoding utf8 (Join-Path $wt 'README.md') -NoNewline

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR
        $rc | Should -Be 5
        # Dirty file untouched.
        (Get-Content (Join-Path $wt 'README.md') -Raw) | Should -Be 'dirty work'
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

        $rc = Invoke-PullSDLC -RepoRoot $fx.Consumer -RemoteName 'sdlc.ai' -Bootstrap -NoFetch -NoAutoPR
        $rc | Should -Be 0
        $wt = Join-Path $fx.Consumer '.worktrees/sdlc-sync'
        (Get-Content (Join-Path $wt 'CLAUDE.md') -Raw) | Should -Be 'b'
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
}

Describe 'Invoke-SelfRefresh' {
    BeforeEach {
        $script:scriptPath = Join-Path $TestDrive 'Pull-SDLC.ai.ps1'
        Set-Content -LiteralPath $script:scriptPath -Value 'original-body' -NoNewline
    }

    It 'returns $false and leaves the file unchanged when remote hash matches local' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing)
            Set-Content -LiteralPath $OutFile -Value 'original-body' -NoNewline
        }
        $result = Invoke-SelfRefresh -ScriptPath $script:scriptPath
        $result | Should -BeFalse
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'original-body'
    }

    It 'returns $true and overwrites the local file when remote hash differs' {
        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $OutFile, $TimeoutSec, $UseBasicParsing)
            Set-Content -LiteralPath $OutFile -Value 'NEW-upstream-body' -NoNewline
        }
        $result = Invoke-SelfRefresh -ScriptPath $script:scriptPath
        $result | Should -BeTrue
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'NEW-upstream-body'
    }

    It 'returns $false and emits a warning when Invoke-WebRequest throws' {
        Mock -CommandName Invoke-WebRequest -MockWith { throw 'simulated network failure' }
        $warnings = @()
        $result = Invoke-SelfRefresh -ScriptPath $script:scriptPath -WarningVariable warnings -WarningAction SilentlyContinue
        $result | Should -BeFalse
        (Get-Content -LiteralPath $script:scriptPath -Raw) | Should -Be 'original-body'
        ($warnings -join ' ') | Should -Match 'Self-update check skipped'
    }

    It 'deletes its temp file even when $WhatIfPreference is true' {
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
        $result | Should -BeFalse
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
}

Describe 'Invoke-PullSDLC self-refresh wiring' {
    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ("sr-" + [guid]::NewGuid().ToString('N'))
    }

    It 'Invoke-PullSDLC no longer performs self-refresh internally (moved to script top level)' {
        $fx = New-DiffReplayFixture -Root $script:fixtureRoot `
            -Seed { 'a' | Out-File -Encoding utf8 CLAUDE.md -NoNewline }
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh -MockWith { return $true }
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
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return $true }
        Mock -CommandName Invoke-SelfReExec    -MockWith { return 0 }
        $result = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters @{}
        $result | Should -BeFalse
        Should -Invoke -CommandName Invoke-SelfRefresh -Times 0 -Exactly
        Should -Invoke -CommandName Invoke-SelfReExec  -Times 0 -Exactly
    }

    It 'short-circuits when Invoke-SelfRefresh returns $false (hashes match / fetch failed)' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return $false }
        Mock -CommandName Invoke-SelfReExec    -MockWith { return 0 }
        $result = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters @{}
        $result | Should -BeFalse
        Should -Invoke -CommandName Invoke-SelfReExec -Times 0 -Exactly
    }

    It 're-execs via Invoke-SelfReExec when an update was applied' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return $true }
        $script:reExecCount = 0
        Mock -CommandName Invoke-SelfReExec -MockWith {
            $script:reExecCount++
            return 0
        }
        $null = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters @{ Branch = 'main' }
        $script:reExecCount | Should -Be 1
    }

    It 'forwards exactly the supplied BoundParameters to Invoke-SelfReExec (regression for #110)' {
        Mock -CommandName Test-SelfRefreshRequired -MockWith { return $true }
        Mock -CommandName Invoke-SelfRefresh   -MockWith { return $true }
        $script:capturedBound = $null
        $script:capturedScriptPath = $null
        Mock -CommandName Invoke-SelfReExec -MockWith {
            param([string]$ScriptPath, [hashtable]$BoundParameters)
            $script:capturedScriptPath = $ScriptPath
            $script:capturedBound = $BoundParameters
        }
        $inputBound = @{ Branch = 'main'; RemoteName = 'sdlc.ai'; NoAutoPR = $true }
        $null = Invoke-SelfRefreshGate -ScriptPath 'C:\fake\Pull-SDLC.ai.ps1' -BoundParameters $inputBound
        $script:capturedScriptPath | Should -Be 'C:\fake\Pull-SDLC.ai.ps1'
        # Captured keys must match input exactly -- no function-only leak (e.g. RemoteUrl).
        ($script:capturedBound.Keys | Sort-Object) -join ',' | Should -Be (($inputBound.Keys | Sort-Object) -join ',')
        $script:capturedBound.Keys | Should -Not -Contain 'RemoteUrl'
    }
}

Describe 'Script top-level self-refresh (issue #110 end-to-end)' {
    It 'the script has no RemoteUrl parameter, so re-exec with script PSBoundParameters cannot leak it' {
        # The bug fired because Invoke-PullSDLC's $PSBoundParameters
        # contained 'RemoteUrl' (a function-only param). Moving the
        # gate to script top level means $PSBoundParameters there is
        # bounded by the script's own param block, which by assertion
        # does not declare RemoteUrl.
        $scriptCmd = Get-Command "$PSScriptRoot\Pull-SDLC.ai.ps1"
        $scriptCmd.Parameters.Keys | Should -Not -Contain 'RemoteUrl'
        $scriptCmd.Parameters.Keys | Should -Not -Contain 'RepoRoot'
        $scriptCmd.Parameters.Keys | Should -Not -Contain 'NoFetch'
        # Sanity: outer params we expect are present.
        $scriptCmd.Parameters.Keys | Should -Contain 'Branch'
        $scriptCmd.Parameters.Keys | Should -Contain 'NoSelfUpdate'
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
            $upstreamManifest = '{"paths":[]}'

            Push-Location $upstream
            try {
                git init -q -b main
                git config user.email u@u.u
                git config user.name u
                Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value $upstreamScript -NoNewline
                Set-Content -LiteralPath 'sync-manifest.json' -Value $upstreamManifest -NoNewline
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
                UpstreamManifest = $upstreamManifest
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

    It 'reverts a tracked-modified-to-upstream-identical file via git checkout' {
        $fx = New-CleanupFixture -Root $script:cleanupRoot
        Push-Location $fx.Consumer
        try {
            Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value "# old tracked content`n" -NoNewline
            git add Pull-SDLC.ai.ps1 | Out-Null
            git commit -q -m "track stale script"
            Set-Content -LiteralPath 'Pull-SDLC.ai.ps1' -Value $fx.UpstreamScript -NoNewline
        } finally { Pop-Location }
        Invoke-MainTreeCleanup -RepoRoot $fx.Consumer -UpstreamRef 'sdlc.ai/main' | Out-Null
        $reverted = Get-Content -LiteralPath (Join-Path $fx.Consumer 'Pull-SDLC.ai.ps1') -Raw
        $reverted | Should -Match 'old tracked content'
    }
}

