BeforeAll {
    . "$PSScriptRoot/Start-IssueAgent.ps1"

    function New-GitFixture {
        <#  A real repository in a temp directory, optionally with a real origin
            remote. Real git rather than a mocked one: several suites below turn
            on what git actually reports from a subdirectory and from a linked
            worktree, which a mock would only assert back at itself. #>
        param([string]$Slug, [switch]$NoOrigin, [switch]$NotARepo)

        $root = Join-Path ([IO.Path]::GetTempPath()) ('sia-fixture-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        if ($NotARepo) { return $root }

        git init -q -b main $root 2>&1 | Out-Null
        if (-not $NoOrigin) {
            git -C $root remote add origin "https://github.com/$Slug.git" 2>&1 | Out-Null
        }
        # An empty commit so `git worktree add <path> main` has a main to branch
        # from; user.email/user.name inline so a machine without a global git
        # identity can still run the suite.
        git -C $root -c user.email=test@example.com -c user.name=Test `
            commit -q --allow-empty -m init 2>&1 | Out-Null
        return $root
    }

    function Remove-GitFixture {
        param([string]$Path)

        if ($Path -and (Test-Path $Path)) {
            # Prune first: a fixture that gained a linked worktree leaves
            # administrative files behind that otherwise outlive the directory.
            git -C $Path worktree prune 2>&1 | Out-Null
            Remove-Item $Path -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    function Get-FixtureRoot {
        # git's own answer on both sides of a path assertion, so an 8.3 short
        # path or temp-directory casing cannot skew the comparison.
        param([string]$Path)

        return [IO.Path]::GetFullPath(
            (git -C $Path rev-parse --path-format=absolute --show-toplevel | Select-Object -First 1).Trim())
    }

    function Get-FixtureCommonDir {
        param([string]$Path)

        return [IO.Path]::GetFullPath(
            (git -C $Path rev-parse --path-format=absolute --git-common-dir | Select-Object -First 1).Trim())
    }
}

Describe 'Get-GitHubRepoSlug' {
    It 'parses an https origin remote' {
        Mock -CommandName git -MockWith { 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git' }
        Get-GitHubRepoSlug -Path 'C:\repo' | Should -Be 'IntelliTect-Samples/IntelliSDLC.ai'
    }

    It 'parses an https origin remote without a .git suffix' {
        Mock -CommandName git -MockWith { 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai' }
        Get-GitHubRepoSlug -Path 'C:\repo' | Should -Be 'IntelliTect-Samples/IntelliSDLC.ai'
    }

    It 'parses an ssh origin remote' {
        Mock -CommandName git -MockWith { 'git@github.com:IntelliTect-Samples/IntelliSDLC.ai.git' }
        Get-GitHubRepoSlug -Path 'C:\repo' | Should -Be 'IntelliTect-Samples/IntelliSDLC.ai'
    }

    It 'throws when there is no origin remote' {
        Mock -CommandName git -MockWith { $null }
        { Get-GitHubRepoSlug -Path 'C:\repo' } | Should -Throw "*Pass -Repo explicitly*"
    }

    It 'throws when the remote is not a recognizable GitHub URL' {
        Mock -CommandName git -MockWith { 'https://example.com/not-github' }
        { Get-GitHubRepoSlug -Path 'C:\repo' } | Should -Throw "*Pass -Repo explicitly*"
    }

    It 'asks git for the remote of -Path, not of the current directory' {
        # The issue lookup and the launch directory must resolve the same
        # repository, and Main achieves that by passing the already-resolved
        # launch directory here -- so this must honor -Path rather than reading
        # the process's own location. Which repository that is follows the
        # caller's current directory (issue #571); before that both followed the
        # launcher's own checkout, and an absolute-path invocation from another
        # repo dispatched this repo's issue #N instead of that one's.
        Mock -CommandName git -MockWith { 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git' }

        Get-GitHubRepoSlug -Path 'C:\some\other\repo' | Out-Null

        Should -Invoke git -Times 1 -ParameterFilter {
            ($args -join ' ') -eq '-C C:\some\other\repo remote get-url origin'
        }
    }

    It 'ignores a leaked GIT_DIR, which git honors over -C' {
        # Same exposure Get-GitCommonDir guards against: an inherited GIT_DIR
        # silently resolves some *other* repository's remote.
        $expected = Get-GitHubRepoSlug -Path $PSScriptRoot
        $expected | Should -Not -BeNullOrEmpty

        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('repo-slug-' + [guid]::NewGuid().ToString('N'))
        $savedGitDir = [Environment]::GetEnvironmentVariable('GIT_DIR')

        try {
            git init -q -b main $tempRoot 2>&1 | Out-Null
            git -C $tempRoot remote add origin 'https://github.com/leaked/leaked.git' 2>&1 | Out-Null
            $env:GIT_DIR = Join-Path $tempRoot '.git'

            Get-GitHubRepoSlug -Path $PSScriptRoot | Should -Be $expected

            # The caller's environment is left exactly as it was found.
            $env:GIT_DIR | Should -Be (Join-Path $tempRoot '.git')
        }
        finally {
            # Remove-Item, not SetEnvironmentVariable($null): the latter leaves
            # an *empty* GIT_DIR behind, and git then fails every later call
            # with "not a git repository: ''".
            if ($null -eq $savedGitDir) { Remove-Item Env:\GIT_DIR -ErrorAction SilentlyContinue }
            else { $env:GIT_DIR = $savedGitDir }
            if (Test-Path $tempRoot) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

Describe 'Invoke-GitWithoutOverrides' {
    BeforeEach {
        $script:savedOverrides = @{}
        foreach ($name in 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE') {
            $script:savedOverrides[$name] = [Environment]::GetEnvironmentVariable($name)
        }
    }

    AfterEach {
        foreach ($name in 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE') {
            # Remove-Item, not SetEnvironmentVariable($null) -- see above.
            if ($null -eq $script:savedOverrides[$name]) { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:\$name" -Value $script:savedOverrides[$name] }
        }
    }

    It 'passes its arguments through to git and returns the output' {
        Mock -CommandName git -MockWith { 'output line' }

        Invoke-GitWithoutOverrides -ArgumentList @('-C', 'C:\repo', 'rev-parse') | Should -Be 'output line'

        Should -Invoke git -Times 1 -ParameterFilter { ($args -join ' ') -eq '-C C:\repo rev-parse' }
    }

    It 'clears GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE for the duration of the call' {
        # They take precedence over -C, so a leaked one resolves the wrong repo.
        $env:GIT_DIR = 'C:\leaked\.git'
        $env:GIT_COMMON_DIR = 'C:\leaked\.git'
        $env:GIT_WORK_TREE = 'C:\leaked'
        Mock -CommandName git -MockWith {
            "[$([Environment]::GetEnvironmentVariable('GIT_DIR'))]" +
            "[$([Environment]::GetEnvironmentVariable('GIT_COMMON_DIR'))]" +
            "[$([Environment]::GetEnvironmentVariable('GIT_WORK_TREE'))]"
        }

        Invoke-GitWithoutOverrides -ArgumentList @('rev-parse') | Should -Be '[][][]'
    }

    It 'restores the caller environment afterwards, even when git fails' {
        $env:GIT_DIR = 'C:\leaked\.git'
        Mock -CommandName git -MockWith { throw 'boom' }

        { Invoke-GitWithoutOverrides -ArgumentList @('rev-parse') } | Should -Throw

        $env:GIT_DIR | Should -Be 'C:\leaked\.git'
    }
}

Describe 'Get-GitHubIssue' {
    It 'returns the parsed issue on success' {
        Mock -CommandName gh -MockWith {
            $global:LASTEXITCODE = 0
            '{"number":123,"title":"Fix the thing"}'
        }
        $issue = Get-GitHubIssue -Number 123 -RepoSlug 'o/r'
        $issue.number | Should -Be 123
        $issue.title | Should -Be 'Fix the thing'
    }

    It 'throws with gh output when the call fails' {
        Mock -CommandName gh -MockWith {
            $global:LASTEXITCODE = 1
            'issue not found'
        }
        { Get-GitHubIssue -Number 999 -RepoSlug 'o/r' } | Should -Throw "*issue not found*"
    }
}

Describe 'Limit-DisplayName' {
    It 'does not truncate when -MaxLength is 0 (unlimited, the default)' {
        Limit-DisplayName -Value ('x' * 200) | Should -Be ('x' * 200)
    }

    It 'does not truncate when the value already fits within -MaxLength' {
        Limit-DisplayName -Value 'short' -MaxLength 100 | Should -Be 'short'
    }

    It 'truncates with a trailing "..." when the value exceeds -MaxLength' {
        $result = Limit-DisplayName -Value 'a value that is far too long' -MaxLength 10
        $result.Length | Should -Be 10
        $result | Should -Be 'a value...'
    }

    It 'handles a -MaxLength too small even for the ellipsis' {
        Limit-DisplayName -Value 'anything' -MaxLength 2 | Should -Be '..'
    }

    It 'handles an empty value' {
        Limit-DisplayName -Value '' -MaxLength 10 | Should -Be ''
    }

    It 'collapses every whitespace run to a single space -- a display name is one line' {
        Limit-DisplayName -Value "first line`nsecond`tline" | Should -Be 'first line second line'
    }

    It 'trims surrounding whitespace' {
        Limit-DisplayName -Value "  padded  " | Should -Be 'padded'
    }

    It 'caps the flattened value, not the raw one' {
        # Flatten first, then cap: capping the raw value would spend the budget
        # on whitespace that is about to collapse.
        Limit-DisplayName -Value "a`n`n`nvalue that is far too long" -MaxLength 10 | Should -Be 'a value...'
    }
}

Describe 'New-IssueAgentName' {
    It 'formats as "issue number: issue title"' {
        $issue = [pscustomobject]@{ number = 42; title = 'Add widget support' }
        New-IssueAgentName -Issue $issue | Should -Be '42: Add widget support'
    }

    It 'does not truncate when -MaxLength is 0 (unlimited, the default)' {
        $issue = [pscustomobject]@{ number = 42; title = 'x' * 200 }
        (New-IssueAgentName -Issue $issue).Length | Should -Be 204 # '42: ' (4 chars) + 200 x's
    }

    It 'does not truncate when the name already fits within -MaxLength' {
        $issue = [pscustomobject]@{ number = 42; title = 'Add widget support' }
        New-IssueAgentName -Issue $issue -MaxLength 100 | Should -Be '42: Add widget support'
    }

    It 'truncates with a trailing "..." when the name exceeds -MaxLength' {
        $issue = [pscustomobject]@{ number = 42; title = 'Add widget support with a very long description' }
        $result = New-IssueAgentName -Issue $issue -MaxLength 20
        $result.Length | Should -Be 20
        $result | Should -BeLike '*...'
        $result | Should -Be '42: Add widget su...'
    }

    It 'handles a -MaxLength too small even for the ellipsis' {
        $issue = [pscustomobject]@{ number = 42; title = 'Add widget support' }
        New-IssueAgentName -Issue $issue -MaxLength 2 | Should -Be '..'
    }

    It 'flattens a multi-line title onto one line, exactly as the -New name builder does' {
        $issue = [pscustomobject]@{ number = 42; title = "Add widget`nsupport" }
        New-IssueAgentName -Issue $issue | Should -Be '42: Add widget support'
    }
}

Describe 'New-PlanAgentName' {
    It 'formats as "new: description"' {
        New-PlanAgentName -Description 'users need CSV export' | Should -Be 'new: users need CSV export'
    }

    It 'trims surrounding whitespace from the description' {
        New-PlanAgentName -Description '  users need CSV export  ' | Should -Be 'new: users need CSV export'
    }

    It 'falls back to a bare "new issue" for an empty description' {
        New-PlanAgentName -Description '' | Should -Be 'new issue'
    }

    It 'falls back to a bare "new issue" for a whitespace-only description' {
        New-PlanAgentName -Description "  `t " | Should -Be 'new issue'
    }

    It 'collapses a multi-line description onto one line -- a tab title is one line' {
        $desc = "Review this log:`nwarning: CRLF will be replaced by LF`n`nPlease investigate"
        New-PlanAgentName -Description $desc |
            Should -Be 'new: Review this log: warning: CRLF will be replaced by LF Please investigate'
    }

    It 'truncates a long description with a trailing "..." at -MaxLength' {
        $result = New-PlanAgentName -Description 'users need a way to export reports as CSV' -MaxLength 20
        $result.Length | Should -Be 20
        $result | Should -Be 'new: users need a...'
    }
}

Describe 'Get-ConsoleWidth' {
    It 'returns a positive integer' {
        Get-ConsoleWidth | Should -BeGreaterThan 0
    }
}

Describe 'Get-LaunchDirectory' {
    BeforeAll {
        # Paths only -- nothing here touches the filesystem. git always reports
        # forward slashes, including on Windows, so that is what is fed in.
        $script:RepoRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'launch-dir-repo')
        $script:ScriptRoot = [IO.Path]::Combine($script:RepoRoot, '.worktrees', '42-some-branch')
        $script:ExpectedRoot = [IO.Path]::GetFullPath($script:RepoRoot)
    }

    It 'resolves the main worktree root from the common git dir' {
        $commonDir = ($script:RepoRoot -replace '\\', '/') + '/.git'

        Get-LaunchDirectory -GitCommonDir $commonDir -ScriptRoot $script:ScriptRoot |
            Should -Be $script:ExpectedRoot
    }

    It 'ignores where the script itself lives -- a worktree copy still yields the main root' {
        $commonDir = ($script:RepoRoot -replace '\\', '/') + '/.git'

        $fromWorktree = Get-LaunchDirectory -GitCommonDir $commonDir -ScriptRoot $script:ScriptRoot
        $fromRoot = Get-LaunchDirectory -GitCommonDir $commonDir -ScriptRoot $script:RepoRoot

        # git reports the same common dir from either tree, so both land on the
        # main worktree root -- that is the whole point of the resolution.
        $fromWorktree | Should -Be $fromRoot
    }

    It 'trims the trailing newline git leaves on its output' {
        $commonDir = ($script:RepoRoot -replace '\\', '/') + "/.git`n"

        Get-LaunchDirectory -GitCommonDir $commonDir -ScriptRoot $script:ScriptRoot |
            Should -Be $script:ExpectedRoot
    }

    It 'falls back to the script root when git reported nothing (not a repo / git missing)' {
        Get-LaunchDirectory -GitCommonDir '' -ScriptRoot $script:ScriptRoot |
            Should -Be $script:ScriptRoot
    }

    It 'falls back to the script root for a null common dir' {
        Get-LaunchDirectory -GitCommonDir $null -ScriptRoot $script:ScriptRoot |
            Should -Be $script:ScriptRoot
    }

    It 'falls back to the script root for a bare repo (no main worktree to launch in)' {
        Get-LaunchDirectory -GitCommonDir 'C:/git/some-repo.git' -ScriptRoot $script:ScriptRoot |
            Should -Be $script:ScriptRoot
    }

    It 'falls back to the script root for a --separate-git-dir checkout' {
        Get-LaunchDirectory -GitCommonDir 'C:/gitdirs/some-repo' -ScriptRoot $script:ScriptRoot |
            Should -Be $script:ScriptRoot
    }
}

Describe 'Get-GitCommonDir' {
    It 'reports a .git common dir for a real repository' {
        # This test file lives in a git repo (the checkout under test), so the
        # real git call is the assertion -- it guards the --path-format flag and
        # the exit-code handling that the pure resolver above cannot cover.
        $commonDir = Get-GitCommonDir -Path $PSScriptRoot

        $commonDir | Should -Not -BeNullOrEmpty
        (Split-Path $commonDir.Trim() -Leaf) | Should -Be '.git'
    }

    It 'resolves a linked worktree to its main worktree root -- the #275 defect' {
        # A real throwaway repo with a real linked worktree: the pure resolver
        # above cannot prove that git actually reports the main worktree's .git
        # from inside a linked one, and that is the whole premise of the fix.
        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('launch-dir-' + [guid]::NewGuid().ToString('N'))
        $mainTree = Join-Path $tempRoot 'main'
        $linkedTree = Join-Path $tempRoot 'linked'

        try {
            git init -q -b main $mainTree 2>&1 | Out-Null
            git -C $mainTree -c user.email=test@example.com -c user.name=Test commit -q --allow-empty -m init 2>&1 | Out-Null
            git -C $mainTree worktree add -q -b feature $linkedTree main 2>&1 | Out-Null

            # Both sides come from git, so neither is skewed by 8.3 short paths
            # or casing in the temp directory.
            $expected = [IO.Path]::GetFullPath(
                (git -C $mainTree rev-parse --path-format=absolute --show-toplevel | Select-Object -First 1))

            Get-LaunchDirectory -GitCommonDir (Get-GitCommonDir -Path $linkedTree) -ScriptRoot $linkedTree |
                Should -Be $expected
        }
        finally {
            if (Test-Path $tempRoot) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    It 'ignores a leaked GIT_DIR, which git honors over -C' {
        # Reproduced before fixing: with GIT_DIR set, git reported that
        # repository's common dir even for a path outside any repository.
        $expected = Get-GitCommonDir -Path $PSScriptRoot
        # Guards against the assertion below passing vacuously by comparing one
        # broken (empty) result against another.
        $expected | Should -Not -BeNullOrEmpty

        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('launch-dir-' + [guid]::NewGuid().ToString('N'))
        $savedGitDir = [Environment]::GetEnvironmentVariable('GIT_DIR')

        try {
            git init -q -b main $tempRoot 2>&1 | Out-Null
            $env:GIT_DIR = Join-Path $tempRoot '.git'

            Get-GitCommonDir -Path $PSScriptRoot | Should -Be $expected

            # The caller's environment is left exactly as it was found.
            $env:GIT_DIR | Should -Be (Join-Path $tempRoot '.git')
        }
        finally {
            # Remove-Item, not SetEnvironmentVariable($null): the latter leaves
            # an *empty* GIT_DIR behind, which git rejects on every later call.
            if ($null -eq $savedGitDir) { Remove-Item Env:\GIT_DIR -ErrorAction SilentlyContinue }
            else { $env:GIT_DIR = $savedGitDir }
            if (Test-Path $tempRoot) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    It 'returns an empty string outside a repository rather than throwing' {
        Get-GitCommonDir -Path ([IO.Path]::GetTempPath()) | Should -BeNullOrEmpty
    }
}

Describe 'New-IssueAgentPrompt' {
    It 'delegates to @dev-loop by issue number, without inlining the issue body' {
        New-IssueAgentPrompt -IssueNumber 42 | Should -Be '@dev-loop gh issue 42'
    }

    It 'puts the issue title on the opening line, after the number' {
        # dev-loop.agent.md Phase 0 keys off "user supplied an issue number";
        # the number stays leading, and the title rides along so it is readable
        # at the top of the transcript, not only in the tab title.
        New-IssueAgentPrompt -IssueNumber 900 -Title 'Make the Video Upload work' |
            Should -Be '@dev-loop gh issue 900: Make the Video Upload work'
    }

    It 'omits the separator when there is no title' {
        New-IssueAgentPrompt -IssueNumber 900 -Title '' | Should -Be '@dev-loop gh issue 900'
    }

    It 'omits the separator for a whitespace-only title' {
        New-IssueAgentPrompt -IssueNumber 900 -Title "  `t " | Should -Be '@dev-loop gh issue 900'
    }

    It 'flattens a multi-line title so the dev-loop line stays one line' {
        New-IssueAgentPrompt -IssueNumber 900 -Title "Make the Video`nUpload work" |
            Should -Be '@dev-loop gh issue 900: Make the Video Upload work'
    }

    It 'appends trailing context below the dev-loop line, separated by a blank line' {
        $prompt = New-IssueAgentPrompt -IssueNumber 900 -Title 'Make the Video Upload work' `
            -Context 'Focus on the retry path; the upload succeeds but the poll never terminates.'

        $prompt | Should -Be (
            "@dev-loop gh issue 900: Make the Video Upload work`n`n" +
            'Focus on the retry path; the upload succeeds but the poll never terminates.')
    }

    It 'keeps a multi-line context intact -- a here-string is the supported form' {
        $context = "first note`n`nsecond note"
        $prompt = New-IssueAgentPrompt -IssueNumber 900 -Title 'A title' -Context $context

        $prompt | Should -Be "@dev-loop gh issue 900: A title`n`n$context"
    }

    It 'normalizes CRLF in the context so the prompt has one newline convention' {
        New-IssueAgentPrompt -IssueNumber 900 -Title 'A title' -Context "line one`r`nline two" |
            Should -Be "@dev-loop gh issue 900: A title`n`nline one`nline two"
    }

    It 'trims surrounding whitespace from the context' {
        New-IssueAgentPrompt -IssueNumber 900 -Title 'A title' -Context "  a note`n`n" |
            Should -Be "@dev-loop gh issue 900: A title`n`na note"
    }

    It 'emits no trailing blank line when no context is given' {
        New-IssueAgentPrompt -IssueNumber 900 -Title 'A title' |
            Should -Be '@dev-loop gh issue 900: A title'
    }

    It 'emits no context block for a whitespace-only context' {
        New-IssueAgentPrompt -IssueNumber 900 -Title 'A title' -Context "  `n`t " |
            Should -Be '@dev-loop gh issue 900: A title'
    }

    It 'passes context containing a single quote through verbatim' {
        New-IssueAgentPrompt -IssueNumber 900 -Title 'A title' -Context "it's the retry path" |
            Should -Be "@dev-loop gh issue 900: A title`n`nit's the retry path"
    }
}

Describe 'Get-RequiredCommand' {
    It 'requires gh and claude when dispatching an existing issue' {
        (Get-RequiredCommand -ParameterSetName 'Issue') -join ',' | Should -Be 'gh,claude'
    }

    It 'requires only claude under -New, which makes no gh call' {
        # -New calls no gh -- @plan does its own repo discovery and files the
        # issue -- so gh need not be installed. Its one best-effort
        # `git remote get-url origin`, for the launch message, does not make git
        # a requirement either: Get-GitOriginUrl yields '' instead of throwing.
        (Get-RequiredCommand -ParameterSetName 'New') -join ',' | Should -Be 'claude'
    }

    It 'rejects an unknown parameter set name' {
        { Get-RequiredCommand -ParameterSetName 'Nope' } | Should -Throw
    }
}

Describe 'New-PlanAgentPrompt' {
    It 'seeds @plan with the description on the first line' {
        $prompt = New-PlanAgentPrompt -Description 'users need CSV export'

        ($prompt -split "`n")[0] | Should -Be '@plan users need CSV export'
    }

    It 'tells the session to create the GitHub issue via @plan' {
        $prompt = New-PlanAgentPrompt -Description 'users need CSV export'

        $prompt | Should -Match '1\. @plan: .*create the GitHub issue'
    }

    It 'tells the session to implement the new issue via @dev-loop once it exists' {
        $prompt = New-PlanAgentPrompt -Description 'users need CSV export'

        $prompt | Should -Match '2\. .*@dev-loop gh issue <number>'
    }

    It 'trims surrounding whitespace from the description' {
        $prompt = New-PlanAgentPrompt -Description '  users need CSV export  '

        ($prompt -split "`n")[0] | Should -Be '@plan users need CSV export'
    }

    It 'seeds a bare @plan for an empty description' {
        $prompt = New-PlanAgentPrompt -Description ''

        ($prompt -split "`n")[0] | Should -Be '@plan'
    }

    It 'seeds a bare @plan for a whitespace-only description' {
        $prompt = New-PlanAgentPrompt -Description "  `t "

        ($prompt -split "`n")[0] | Should -Be '@plan'
    }

    It 'keeps the create-then-implement steps for a seedless description' {
        $seedless = New-PlanAgentPrompt -Description ''
        $seeded = New-PlanAgentPrompt -Description 'users need CSV export'

        # Everything after the seed line is identical in both forms.
        ($seedless -split "`n`n", 2)[1] | Should -Be ($seeded -split "`n`n", 2)[1]
    }

    It 'passes a description containing a single quote through verbatim' {
        $prompt = New-PlanAgentPrompt -Description "it's broken"

        ($prompt -split "`n")[0] | Should -Be "@plan it's broken"
    }

    It 'keeps a multi-line description intact ahead of the steps' {
        $prompt = New-PlanAgentPrompt -Description "first line`nsecond line"

        $prompt | Should -BeLike "@plan first line`nsecond line`n`nTwo steps*"
    }
}

Describe 'Issue #325: the -New prompt hands the rename back to the user' {
    # The session launches as `new: <description>` because no issue number
    # exists yet, and that name is stale the moment @plan files the issue.
    # A session cannot rename itself -- /rename is expanded from a *user*
    # message, never from model output (measured against Claude Code 2.1.251;
    # see New-PlanAgentPrompt's .DESCRIPTION) -- so the prompt's job is to
    # produce a command the user can paste in one keystroke.
    It 'gives the paste-ready /rename template with the issue-dispatch name shape' {
        $prompt = New-PlanAgentPrompt -Description 'users need CSV export'

        $prompt | Should -Match '/rename <number>: <issue title>'
    }

    It 'asks for the rename line once the issue exists, before the dev loop starts' {
        $prompt = New-PlanAgentPrompt -Description 'users need CSV export'

        $prompt | Should -Match '(?s)Between steps 1 and 2, print this line'
    }

    It 'tells the session to print the command rather than attempt to run it' {
        $prompt = New-PlanAgentPrompt -Description 'users need CSV export'

        $prompt | Should -Match 'Print it, do not try to run it'
        $prompt | Should -Match 'a session cannot rename itself'
    }

    It 'hands the rename back for a seedless -New too' {
        # -New '' still files an issue, so its name goes stale the same way.
        New-PlanAgentPrompt -Description '' | Should -Match '/rename <number>: <issue title>'
    }

    It 'keeps the rename hand-off last, after the two ordered steps' {
        $prompt = New-PlanAgentPrompt -Description 'users need CSV export'

        $prompt.IndexOf('@dev-loop gh issue <number>') |
            Should -BeLessThan $prompt.IndexOf('/rename <number>: <issue title>')
    }

    It 'records in the doc comment why the rename is manual' {
        # Matched to a boolean rather than asserted with -Match: a failure
        # message that dumps the whole 900-line script is unreadable.
        $help = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Start-IssueAgent.ps1')
        ($help -match '(?s)client-side.*slash command') |
            Should -BeTrue -Because 'the finding must outlive this spike'
        ($help -match 'rename_session') |
            Should -BeTrue -Because 'the one non-typed path -- and why it is out of reach -- is the finding'
    }
}

Describe 'Issue #324: -New has exactly one description source' {
    # start-issue-agent.sh -- the bash forwarder -- is gone, and with it the
    # only reason -New ever read a description from stdin: bash has no
    # equivalent of PowerShell's @'...'@ here-string, so `-New -` plus a
    # heredoc was the workaround. From pwsh a here-string carries a multi-line
    # description natively, so -New now takes a description and nothing else.
    # A leftover stdin path would be a second acquisition route with no caller.

    It 'defines no stdin reader' {
        Get-Command -Name 'Read-DescriptionFromStdin' -CommandType Function -ErrorAction SilentlyContinue |
            Should -BeNullOrEmpty -Because 'the -New - stdin path was removed with the bash forwarder'
    }

    It 'decides the launch mode without a StdinConsumed input' {
        (Get-Command Get-ClaudeLaunchMode).Parameters.Keys |
            Should -Not -Contain 'StdinConsumed' -Because 'nothing can drain stdin any more'
    }

    It 'launches a session without a StdinConsumed input' {
        (Get-Command Start-ClaudeIssueSession).Parameters.Keys |
            Should -Not -Contain 'StdinConsumed'
    }

    It 'still carries a multi-line -New description through a here-string' {
        # The replacement for the heredoc, asserted rather than assumed.
        $description = @'
Review this console log, is it what you expect? Please investigate:
warning: CRLF will be replaced by LF
'@
        New-PlanAgentPrompt -Description $description |
            Should -BeLike "@plan Review this console log*warning: CRLF will be replaced by LF*Two steps*"
    }

    It 'documents no bash entry point and no stdin form' {
        # Matched to a boolean rather than asserted with -Match: a failure
        # message that dumps the whole 900-line script is unreadable.
        $help = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Start-IssueAgent.ps1')
        ($help -match 'start-issue-agent\.sh') |
            Should -BeFalse -Because 'the bash forwarder no longer exists to point at'
        ($help -match '(?i)stdin') |
            Should -BeFalse -Because 'no documented form of -New reads stdin'
    }
}

Describe 'Get-DefaultPermissionMode' {
    It 'defaults the -New parameter set to plan mode' {
        Get-DefaultPermissionMode -ParameterSetName 'New' | Should -Be 'plan'
    }

    It 'defaults issue dispatch to auto' {
        Get-DefaultPermissionMode -ParameterSetName 'Issue' | Should -Be 'auto'
    }

    It 'rejects an unknown parameter set name' {
        { Get-DefaultPermissionMode -ParameterSetName 'Nope' } | Should -Throw
    }
}

Describe 'ConvertTo-PowerShellLiteral' {
    It 'wraps a plain value in single quotes' {
        ConvertTo-PowerShellLiteral 'auto' | Should -Be "'auto'"
    }

    It 'doubles embedded single quotes so the literal round-trips' {
        ConvertTo-PowerShellLiteral "it's a test" | Should -Be "'it''s a test'"
    }

    It 'handles an empty string' {
        ConvertTo-PowerShellLiteral '' | Should -Be "''"
    }
}

Describe 'New-EncodedClaudeCommand' {
    It 'base64/UTF-16LE-encodes a Remove-Item/Set-Location/claude invocation with literal-quoted args' {
        $encoded = New-EncodedClaudeCommand -ArgumentList @('--name', "42: Fix it's thing", '--remote-control') `
            -WorkingDirectory 'C:\repo'
        $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))

        $decoded | Should -Be (
            'Remove-Item Env:\CLAUDE_CODE_CHILD_SESSION -ErrorAction SilentlyContinue; ' +
            "Set-Location 'C:\repo'; & claude '--name' '42: Fix it''s thing' '--remote-control'"
        )
    }
}

Describe 'Get-ClaudeLaunchMode' {
    It 'reuses the current pane when already in Windows Terminal and no override' {
        Get-ClaudeLaunchMode -InWindowsTerminal $true -WtAvailable $true -InClaudeCodeSession $false | Should -Be 'CurrentPane'
    }

    It 'opens a new tab when -ForceNewTab is passed even inside Windows Terminal' {
        Get-ClaudeLaunchMode -ForceNewTab -InWindowsTerminal $true -WtAvailable $true -InClaudeCodeSession $false | Should -Be 'NewTab'
    }

    It 'opens a new tab when inside a Claude Code session, even inside Windows Terminal and without -NewTab' {
        Get-ClaudeLaunchMode -InWindowsTerminal $true -WtAvailable $true -InClaudeCodeSession $true | Should -Be 'NewTab'
    }

    It 'opens a new tab when not in Windows Terminal but wt.exe is available' {
        Get-ClaudeLaunchMode -InWindowsTerminal $false -WtAvailable $true -InClaudeCodeSession $false | Should -Be 'NewTab'
    }

    It 'falls back to a new window when not in Windows Terminal and wt.exe is unavailable' {
        Get-ClaudeLaunchMode -InWindowsTerminal $false -WtAvailable $false -InClaudeCodeSession $false | Should -Be 'NewWindow'
    }

    It 'falls back to a new window when -ForceNewTab is passed but wt.exe is unavailable' {
        Get-ClaudeLaunchMode -ForceNewTab -InWindowsTerminal $true -WtAvailable $false -InClaudeCodeSession $false | Should -Be 'NewWindow'
    }

    It 'falls back to a new window when inside a Claude Code session but wt.exe is unavailable' {
        Get-ClaudeLaunchMode -InWindowsTerminal $true -WtAvailable $false -InClaudeCodeSession $true | Should -Be 'NewWindow'
    }
}

Describe 'Start-ClaudeIssueSession' {
    BeforeEach {
        $script:originalWtSession = $env:WT_SESSION
        $script:originalClaudeCode = $env:CLAUDECODE
        # This test suite itself may be running inside a Claude Code session
        # (CLAUDECODE=1 already set) -- default it off per-test so tests that
        # exercise the "not in a Claude Code session" branch aren't at the
        # mercy of the outer environment; tests exercising the Claude Code
        # branch set it back to '1' explicitly.
        $env:CLAUDECODE = $null
    }

    AfterEach {
        $env:WT_SESSION = $script:originalWtSession
        $env:CLAUDECODE = $script:originalClaudeCode
    }

    It 'opens a wt.exe tab with the claude command passed via -EncodedCommand when not already in Windows Terminal' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }

        Start-ClaudeIssueSession -Name '42: Add widget support' -Prompt '@dev-loop gh issue 42' `
            -PermissionMode 'auto' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 1 -ParameterFilter {
            # Every wt.exe-level argument here is deliberately space-free (see
            # New-EncodedClaudeCommand's doc comment): wt.exe is an app
            # execution alias, and an argument containing spaces (a prior
            # --title/-d design) was observed getting mis-split across that
            # reparse-point hop.
            if ($FilePath -ne 'wt.exe') { return $false }
            if ($ArgumentList.Count -ne 8) { return $false }
            if ($ArgumentList[0] -ne '-w') { return $false }
            if ($ArgumentList[1] -ne '0') { return $false }
            if ($ArgumentList[2] -ne 'new-tab') { return $false }
            if ($ArgumentList[3] -ne '--') { return $false }
            if ($ArgumentList[4] -ne 'pwsh') { return $false }
            if ($ArgumentList[5] -ne '-NoExit') { return $false }
            if ($ArgumentList[6] -ne '-EncodedCommand') { return $false }

            $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ArgumentList[7]))
            $decoded -eq (
                'Remove-Item Env:\CLAUDE_CODE_CHILD_SESSION -ErrorAction SilentlyContinue; ' +
                "Set-Location 'C:\repo'; & claude '--name' '42: Add widget support' '--remote-control' " +
                "'--permission-mode' 'auto' '--' '@dev-loop gh issue 42'"
            )
        }
    }

    It 'carries a -New session (plan mode, @plan prompt) through to claude intact' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }

        Start-ClaudeIssueSession -Name 'new: users need CSV export' -Prompt '@plan users need CSV export' `
            -PermissionMode 'plan' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 1 -ParameterFilter {
            if ($FilePath -ne 'wt.exe') { return $false }

            $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ArgumentList[7]))
            $decoded -eq (
                'Remove-Item Env:\CLAUDE_CODE_CHILD_SESSION -ErrorAction SilentlyContinue; ' +
                "Set-Location 'C:\repo'; & claude '--name' 'new: users need CSV export' '--remote-control' " +
                "'--permission-mode' 'plan' '--' '@plan users need CSV export'"
            )
        }
    }

    It 'round-trips a multi-line prompt through the -EncodedCommand blob intact' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }

        $multiline = "@plan Review this log:`nwarning: it's CRLF again`n`nPlease investigate"
        Start-ClaudeIssueSession -Name 'new: Review this log' -Prompt $multiline `
            -PermissionMode 'plan' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 1 -ParameterFilter {
            $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ArgumentList[7]))
            # Newlines survive inside the single-quoted PS literal; the lone
            # quote in "it's" is doubled by ConvertTo-PowerShellLiteral.
            $decoded.Contains("'@plan Review this log:`nwarning: it''s CRLF again`n`nPlease investigate'")
        }
    }

    It 'falls back to a new console window that also goes through -EncodedCommand' {
        # The least-exercised path used to hand $claudeArgs straight to
        # Start-Process, with none of the argv-mangling protection the wt.exe
        # path has -- and it is exactly the path a multi-line prompt takes on a
        # machine without wt.exe.
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { $null }
        Mock -CommandName Start-Process -MockWith { }

        Start-ClaudeIssueSession -Name '42: Add widget support' -Prompt '@dev-loop gh issue 42' `
            -PermissionMode 'auto' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 1 -ParameterFilter {
            if ($FilePath -ne 'pwsh') { return $false }
            if ($ArgumentList.Count -ne 3) { return $false }
            if ($ArgumentList[0] -ne '-NoExit') { return $false }
            if ($ArgumentList[1] -ne '-EncodedCommand') { return $false }

            $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ArgumentList[2]))
            # The blob carries the working directory and drops
            # CLAUDE_CODE_CHILD_SESSION inside the new process, so neither needs
            # a Start-Process parameter of its own.
            $decoded -eq (
                'Remove-Item Env:\CLAUDE_CODE_CHILD_SESSION -ErrorAction SilentlyContinue; ' +
                "Set-Location 'C:\repo'; & claude '--name' '42: Add widget support' '--remote-control' " +
                "'--permission-mode' 'auto' '--' '@dev-loop gh issue 42'"
            )
        }
    }

    It 'round-trips a multi-line prompt through the new-window path intact' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { $null }
        Mock -CommandName Start-Process -MockWith { }

        $multiline = "@dev-loop gh issue 42: A title`n`nit's the retry path`nthat never terminates"
        Start-ClaudeIssueSession -Name '42: A title' -Prompt $multiline `
            -PermissionMode 'auto' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 1 -ParameterFilter {
            $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ArgumentList[2]))
            $decoded.Contains("'@dev-loop gh issue 42: A title`n`nit''s the retry path`nthat never terminates'")
        }
    }

    It 'reports the session exit code when it ran in the current pane' {
        $env:WT_SESSION = 'some-guid'
        Mock -CommandName Push-Location -MockWith { }
        Mock -CommandName Pop-Location -MockWith { }
        Mock -CommandName claude -MockWith { $global:LASTEXITCODE = 42 }

        # Seeded with -1 so the assertion proves the function wrote the value.
        $exitCode = -1
        Start-ClaudeIssueSession -Name 'n' -Prompt 'p' -PermissionMode 'auto' `
            -WorkingDirectory 'C:\repo' -ExitCode ([ref]$exitCode)

        $exitCode | Should -Be 42
    }

    It 'reports 0 for a current-pane session that ended successfully' {
        $env:WT_SESSION = 'some-guid'
        Mock -CommandName Push-Location -MockWith { }
        Mock -CommandName Pop-Location -MockWith { }
        Mock -CommandName claude -MockWith { $global:LASTEXITCODE = 0 }

        $exitCode = -1
        Start-ClaudeIssueSession -Name 'n' -Prompt 'p' -PermissionMode 'auto' `
            -WorkingDirectory 'C:\repo' -ExitCode ([ref]$exitCode)

        $exitCode | Should -Be 0
    }

    It 'emits nothing on the pipeline -- capturing it would redirect the inline session stdout' {
        # The exit code travels by [ref] precisely so no caller has to assign
        # this function's output: assigning it makes PowerShell redirect the
        # inline `claude`'s stdout into the pipeline, taking the console away
        # from an interactive session (and mixing its output into the result).
        $env:WT_SESSION = 'some-guid'
        Mock -CommandName Push-Location -MockWith { }
        Mock -CommandName Pop-Location -MockWith { }
        Mock -CommandName claude -MockWith { $global:LASTEXITCODE = 42; 'session chatter' }

        $exitCode = -1
        $output = Start-ClaudeIssueSession -Name 'n' -Prompt 'p' -PermissionMode 'auto' `
            -WorkingDirectory 'C:\repo' -ExitCode ([ref]$exitCode)

        $output | Should -Be 'session chatter'
        $exitCode | Should -Be 42
    }

    It 'reports 0 after dispatching a new tab -- there is no session exit code to wait for' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }

        $exitCode = -1
        Start-ClaudeIssueSession -Name 'n' -Prompt 'p' -PermissionMode 'auto' `
            -WorkingDirectory 'C:\repo' -ExitCode ([ref]$exitCode)

        $exitCode | Should -Be 0
    }

    It 'reports 0 after dispatching a new window -- fire and forget by design' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { $null }
        Mock -CommandName Start-Process -MockWith { }

        $exitCode = -1
        Start-ClaudeIssueSession -Name 'n' -Prompt 'p' -PermissionMode 'auto' `
            -WorkingDirectory 'C:\repo' -ExitCode ([ref]$exitCode)

        $exitCode | Should -Be 0
    }

    It 'reports 0 under -WhatIf, having launched nothing' {
        $env:WT_SESSION = 'some-guid'
        Mock -CommandName claude -MockWith { $global:LASTEXITCODE = 42 }

        $exitCode = -1
        Start-ClaudeIssueSession -Name 'n' -Prompt 'p' -PermissionMode 'auto' `
            -WorkingDirectory 'C:\repo' -WhatIf -ExitCode ([ref]$exitCode)

        $exitCode | Should -Be 0
    }

    It 'reuses the current pane -- runs claude inline -- when already in Windows Terminal and -NewTab is not passed' {
        $env:WT_SESSION = 'some-guid'
        Mock -CommandName Start-Process -MockWith { }
        Mock -CommandName Push-Location -MockWith { }
        Mock -CommandName Pop-Location -MockWith { }
        Mock -CommandName claude -MockWith { }

        Start-ClaudeIssueSession -Name '42: Add widget support' -Prompt '@dev-loop gh issue 42' `
            -PermissionMode 'auto' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 0
        Should -Invoke Push-Location -Times 1 -ParameterFilter { $Path -eq 'C:\repo' }
        Should -Invoke Pop-Location -Times 1
        Should -Invoke claude -Times 1 -ParameterFilter {
            ($args -join '|') -eq (
                @('--name', '42: Add widget support', '--remote-control', '--permission-mode', 'auto', '--', '@dev-loop gh issue 42') -join '|'
            )
        }
    }

    It 'opens a new tab even when already in Windows Terminal if -NewTab is passed' {
        $env:WT_SESSION = 'some-guid'
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }

        Start-ClaudeIssueSession -Name '42: Add widget support' -Prompt '@dev-loop gh issue 42' `
            -PermissionMode 'auto' -WorkingDirectory 'C:\repo' -NewTab

        Should -Invoke Start-Process -Times 1 -ParameterFilter { $FilePath -eq 'wt.exe' }
    }

    It 'opens a new tab even when already in Windows Terminal if invoked from a Claude Code session (CLAUDECODE), without -NewTab' {
        $env:WT_SESSION = 'some-guid'
        $env:CLAUDECODE = '1'
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }
        Mock -CommandName claude -MockWith { }

        Start-ClaudeIssueSession -Name '42: Add widget support' -Prompt '@dev-loop gh issue 42' `
            -PermissionMode 'auto' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 1 -ParameterFilter { $FilePath -eq 'wt.exe' }
        Should -Invoke claude -Times 0
    }

    It 'does not launch anything when -WhatIf is passed' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }

        Start-ClaudeIssueSession -Name 'n' -Prompt 'p' -PermissionMode 'auto' `
            -WorkingDirectory 'C:\repo' -WhatIf

        Should -Invoke Start-Process -Times 0
    }
}

Describe 'Start-IssueAgent.ps1 command-line contract' {
    BeforeAll {
        $script:ScriptPath = "$PSScriptRoot/Start-IssueAgent.ps1"
        $script:Command = Get-Command $script:ScriptPath
    }

    It 'takes free-text context positionally, immediately after the issue number' {
        $context = $script:Command.Parameters['Context']

        $context.ParameterType | Should -Be ([string])
        $context.ParameterSets['Issue'].Position | Should -Be 1
    }

    It 'keeps the common case a bare issue number -- context is not mandatory' {
        $script:Command.Parameters['Context'].ParameterSets['Issue'].IsMandatory | Should -BeFalse
    }

    It 'does not offer -Context under -New, whose description already carries the free text' {
        # -New <description> is itself the free-text seed; a second free-text
        # parameter there would be two seeds with no rule for combining them.
        $script:Command.Parameters['Context'].ParameterSets.Keys | Should -Be 'Issue'
    }

    It 'documents the asymmetric exit-code contract in its comment-based help' {
        $helpText = Get-Help $script:ScriptPath -Full | Out-String

        $helpText | Should -Match '(?s)exit code.*current pane'
        $helpText | Should -Match '(?s)-NewTab.*dispatch|dispatch.*new tab'
    }
}

Describe 'Start-IssueAgent.ps1: which repository the session works on (issue #571)' {
    # These exercise MAIN, which dot-sourcing cannot reach (the script returns
    # early when $MyInvocation.InvocationName is '.'). That matters here for the
    # same reason it did for run.ps1's argument nesting: the defect lives at a
    # CALL SITE, not inside any function, so a suite of function-level tests can
    # be entirely green while the script still resolves the wrong repository.
    #
    # Pester's Mock reaches a script invoked with `& $path` (verified: an
    # over-narrow Get-Command mock surfaced inside the script's own PATH
    # preflight), so `gh` and `Start-Process` are observed directly -- no
    # child-scope shim files needed.
    #
    # The launcher itself is NOT copied to a fixture: the bug is "the script
    # lives in repository A while the caller stands in repository B", and this
    # checkout already is a real repository distinct from any temp fixture.

    BeforeAll {
        $script:Launcher = Join-Path $PSScriptRoot 'Start-IssueAgent.ps1'

        # The launcher's own repository, the anchor the defect wrongly used.
        $script:LauncherRoot = [IO.Path]::GetFullPath(
            (Split-Path (
                Invoke-GitWithoutOverrides -ArgumentList @(
                    '-C', $PSScriptRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir') |
                    Select-Object -First 1).Trim() -Parent))

    }

    BeforeEach {
        $script:originalWtSession = $env:WT_SESSION
        $script:originalClaudeCode = $env:CLAUDECODE
        # Out-of-pane dispatch, so `claude` is never executed: the working
        # directory is observed from the launch message and the encoded command
        # instead of from a Push-Location around a live session.
        $env:WT_SESSION = $null
        $env:CLAUDECODE = $null
    }

    AfterEach {
        $env:WT_SESSION = $script:originalWtSession
        $env:CLAUDECODE = $script:originalClaudeCode
    }

    It 'fetches the issue from the repository the caller is standing in, not the launcher''s own checkout' {
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        try {
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $caller
            try { & $script:Launcher 7 6>&1 | Out-Null } finally { Pop-Location }

            # The value after --repo, not a joined argv: the launcher passes
            # `--json number,title`, which PowerShell binds as an ARRAY, so
            # ($args -join ' ') renders that element as "System.Object[]" and no
            # whole-vector string can ever match. Asserting the --repo value is
            # also the behavior this test is about.
            Should -Invoke gh -Times 1 -ParameterFilter {
                $i = [Array]::IndexOf($args, '--repo')
                $i -ge 0 -and $args[$i + 1] -eq 'caller-owner/caller-repo'
            }
        }
        finally { Remove-GitFixture $caller }
    }

    It 'starts the session in the caller''s repository, not the launcher''s' {
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        try {
            $expected = Get-FixtureRoot $caller
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $caller
            try { $out = & $script:Launcher 7 6>&1 } finally { Pop-Location }

            ($out | Out-String) | Should -Match ([regex]::Escape(" in $expected"))
            $expected | Should -Not -Be $script:LauncherRoot -Because 'the fixture must differ from the launcher''s own repo or the assertion is vacuous'
        }
        finally { Remove-GitFixture $caller }
    }

    It 'hands the session the caller''s repository as its working directory' {
        # The launch message and the directory the session actually starts in are
        # two different things; this asserts the second, from the encoded command.
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        try {
            $expected = Get-FixtureRoot $caller
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $caller
            try { & $script:Launcher 7 6>&1 | Out-Null } finally { Pop-Location }

            Should -Invoke Start-Process -Times 1 -ParameterFilter {
                $encodedIndex = [Array]::IndexOf($ArgumentList, '-EncodedCommand')
                if ($encodedIndex -lt 0) { return $false }
                $decoded = [Text.Encoding]::Unicode.GetString(
                    [Convert]::FromBase64String($ArgumentList[$encodedIndex + 1]))
                $decoded -match [regex]::Escape("Set-Location '$expected'")
            }
        }
        finally { Remove-GitFixture $caller }
    }

    It 'resolves the caller''s repository root from a deep subdirectory of it' {
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        try {
            $expected = Get-FixtureRoot $caller
            $deep = Join-Path $caller 'src/nested/deep'
            New-Item -ItemType Directory -Path $deep -Force | Out-Null
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $deep
            try { $out = & $script:Launcher 7 6>&1 } finally { Pop-Location }

            ($out | Out-String) | Should -Match ([regex]::Escape(" in $expected"))
            Should -Invoke gh -Times 1 -ParameterFilter {
                $i = [Array]::IndexOf($args, '--repo')
                $i -ge 0 -and $args[$i + 1] -eq 'caller-owner/caller-repo'
            }
        }
        finally { Remove-GitFixture $caller }
    }

    It 'launches in the main worktree root when the caller is inside a linked worktree of their repo' {
        # Issue #275's rule, re-anchored: @dev-loop's `git worktree add
        # .worktrees/<n>-<name>` is relative, so starting a session inside a
        # linked worktree nests a worktree in a worktree. An implementation that
        # used --show-toplevel on the current directory passes every other test
        # here and fails only this one.
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        $linked = $null
        try {
            $expected = Get-FixtureRoot $caller
            $linked = Join-Path ([IO.Path]::GetTempPath()) ('sia-571-wt-' + [guid]::NewGuid().ToString('N'))
            git -C $caller worktree add -q -b feature $linked main 2>&1 | Out-Null
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $linked
            try { $out = & $script:Launcher 7 6>&1 } finally { Pop-Location }

            $rendered = $out | Out-String
            $rendered | Should -Match ([regex]::Escape(" in $expected"))
            $rendered | Should -Not -Match ([regex]::Escape($linked))
        }
        finally {
            if ($linked -and (Test-Path $linked)) { Remove-Item $linked -Recurse -Force -ErrorAction SilentlyContinue }
            Remove-GitFixture $caller
        }
    }

    It 'uses -Repo for the issue lookup while still launching in the caller''s repository' {
        # Decision: a -Repo that disagrees with the current directory is accepted
        # silently -- no prompt, no refusal. The launch message prints both.
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        try {
            $expected = Get-FixtureRoot $caller
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $caller
            try { $out = & $script:Launcher 7 -Repo 'other-owner/other-repo' 6>&1 } finally { Pop-Location }

            Should -Invoke gh -Times 1 -ParameterFilter {
                $i = [Array]::IndexOf($args, '--repo')
                $i -ge 0 -and $args[$i + 1] -eq 'other-owner/other-repo'
            }
            ($out | Out-String) | Should -Match ([regex]::Escape(" in $expected"))
        }
        finally { Remove-GitFixture $caller }
    }

    It 'falls back to the launcher''s own checkout when the caller is not in a git repository' {
        # -Repo so the assertion never depends on this checkout having an origin.
        $outside = New-GitFixture -NotARepo
        try {
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $outside
            try { $out = & $script:Launcher 7 -Repo 'o/r' 6>&1 } finally { Pop-Location }

            ($out | Out-String) | Should -Match ([regex]::Escape(" in $script:LauncherRoot"))
        }
        finally { Remove-GitFixture $outside }
    }

    It 'falls back instead of crashing when the caller stands in a non-FileSystem location' {
        # Set-Location Env:\ leaves $PWD.ProviderPath EMPTY (measured -- also for
        # Function:\ and Variable:\), and `git -C ''` is a parameter-binding
        # failure, fatal under $ErrorActionPreference = 'Stop'. So this must not
        # throw, and must land on the launcher's own checkout.
        Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
        Mock -CommandName Start-Process -MockWith { }

        Push-Location Env:\
        try { $out = & $script:Launcher 7 -Repo 'o/r' 6>&1 } finally { Pop-Location }

        ($out | Out-String) | Should -Match ([regex]::Escape(" in $script:LauncherRoot"))
    }
}

Describe 'Start-IssueAgent.ps1: naming the resolved repository before launch (issue #571)' {
    # The directory alone does not say which repository's issue was fetched, and
    # the launcher now follows the caller's current directory rather than its own
    # checkout -- so "which repo?" is a real question at dispatch time. Naming it
    # also makes a -Repo that disagrees with the current directory visible
    # without a prompt or a refusal.

    BeforeAll {
        $script:Launcher = Join-Path $PSScriptRoot 'Start-IssueAgent.ps1'

    }

    BeforeEach {
        $script:originalWtSession = $env:WT_SESSION
        $script:originalClaudeCode = $env:CLAUDECODE
        $env:WT_SESSION = $null
        $env:CLAUDECODE = $null
    }

    AfterEach {
        $env:WT_SESSION = $script:originalWtSession
        $env:CLAUDECODE = $script:originalClaudeCode
    }

    It 'names the resolved repository in the launch message when dispatching an issue' {
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        try {
            $expected = Get-FixtureRoot $caller
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $caller
            try { $out = & $script:Launcher 7 6>&1 } finally { Pop-Location }

            ($out | Out-String).Trim() | Should -Be "Launching claude session '7: Fixture issue' in $expected (caller-owner/caller-repo)"
        }
        finally { Remove-GitFixture $caller }
    }

    It 'names the resolved repository under -New, which makes no gh call at all' {
        $caller = New-GitFixture -Slug 'caller-owner/caller-repo'
        try {
            $expected = Get-FixtureRoot $caller
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"Fixture issue"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $caller
            try { $out = & $script:Launcher -New 'users need CSV export' 6>&1 } finally { Pop-Location }

            ($out | Out-String).Trim() | Should -Be "Launching claude session 'new: users need CSV export' in $expected (caller-owner/caller-repo)"
            Should -Invoke gh -Times 0 -Because '-New resolves nothing through gh; @plan files the issue itself'
        }
        finally { Remove-GitFixture $caller }
    }

    It 'omits the repository rather than printing an empty one when the caller''s repo has no origin' {
        # Degrade, do not throw: -New made no git remote call before this change,
        # so a repository without an origin must still dispatch.
        $caller = New-GitFixture -NoOrigin
        try {
            $expected = Get-FixtureRoot $caller
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $caller
            try { $out = & $script:Launcher -New 'an idea' 6>&1 } finally { Pop-Location }

            ($out | Out-String).Trim() | Should -Be "Launching claude session 'new: an idea' in $expected"
            Should -Invoke Start-Process -Times 1 -Because 'it must still dispatch, just without naming a repository'
        }
        finally { Remove-GitFixture $caller }
    }
}

Describe 'Format-LaunchMessage' {
    It 'names the session, the directory and the repository' {
        Format-LaunchMessage -Name '7: Add widget support' -Directory 'C:\repo' -RepoSlug 'owner/name' |
            Should -Be "Launching claude session '7: Add widget support' in C:\repo (owner/name)"
    }

    It 'omits the parenthesis entirely for an unknown repository rather than printing an empty one' {
        Format-LaunchMessage -Name '7: Add widget support' -Directory 'C:\repo' -RepoSlug '' |
            Should -Be "Launching claude session '7: Add widget support' in C:\repo"
    }

    It 'omits the parenthesis for a null repository' {
        Format-LaunchMessage -Name 'new: an idea' -Directory 'C:\repo' -RepoSlug $null |
            Should -Be "Launching claude session 'new: an idea' in C:\repo"
    }
}

Describe 'ConvertTo-GitHubRepoSlug' {
    It 'parses an https remote' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'https://github.com/some-owner/some-repo.git' |
            Should -Be 'some-owner/some-repo'
    }

    It 'parses an https remote without a .git suffix' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'https://github.com/some-owner/some-repo' |
            Should -Be 'some-owner/some-repo'
    }

    It 'parses an ssh remote' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'git@github.com:some-owner/some-repo.git' |
            Should -Be 'some-owner/some-repo'
    }

    It 'returns empty for a remote that is not a recognizable GitHub URL' {
        ConvertTo-GitHubRepoSlug -RemoteUrl 'https://example.com/not-github' | Should -BeNullOrEmpty
    }

    It 'returns empty for an empty remote' {
        ConvertTo-GitHubRepoSlug -RemoteUrl '' | Should -BeNullOrEmpty
    }

    It 'returns empty for a null remote' {
        ConvertTo-GitHubRepoSlug -RemoteUrl $null | Should -BeNullOrEmpty
    }
}

Describe 'Get-GitOriginUrl' {
    It 'reports the origin remote of the repository at -Path' {
        $root = Join-Path ([IO.Path]::GetTempPath()) ('sia-571o-' + [guid]::NewGuid().ToString('N'))
        try {
            git init -q -b main $root 2>&1 | Out-Null
            git -C $root remote add origin 'https://github.com/o/n.git' 2>&1 | Out-Null

            (Get-GitOriginUrl -Path $root).Trim() | Should -Be 'https://github.com/o/n.git'
        }
        finally { Remove-GitFixture $root }
    }

    It 'returns empty rather than throwing for a repository with no origin' {
        $root = Join-Path ([IO.Path]::GetTempPath()) ('sia-571o-' + [guid]::NewGuid().ToString('N'))
        try {
            git init -q -b main $root 2>&1 | Out-Null

            Get-GitOriginUrl -Path $root | Should -BeNullOrEmpty
        }
        finally { Remove-GitFixture $root }
    }

    It 'returns empty rather than throwing when git is not installed' {
        # The one mock here: a machine without git is impractical to arrange for
        # real, and this is the contract that keeps -New working on a machine
        # that has claude but no git -- CommandNotFoundException comes from the
        # native call, not from a throw, so a -Quiet switch would not cover it.
        Mock -CommandName git -MockWith { throw [Management.Automation.CommandNotFoundException]::new('git not found') }

        Get-GitOriginUrl -Path 'C:\repo' | Should -BeNullOrEmpty
    }

    It 'asks git about -Path, not about the current directory' {
        Mock -CommandName git -MockWith { 'https://github.com/o/n.git' }

        Get-GitOriginUrl -Path 'C:\some\other\repo' | Out-Null

        Should -Invoke git -Times 1 -ParameterFilter {
            ($args -join ' ') -eq '-C C:\some\other\repo remote get-url origin'
        }
    }
}

Describe 'Resolve-GitCommonDir' {
    # Real repositories, no mocks: the premise under test is what git actually
    # reports from a subdirectory and from a linked worktree, which a mock would
    # simply assert back at itself.

    It 'answers for the repository the current directory belongs to, not the script''s' {
        $caller = New-GitFixture -NoOrigin
        try {
            $expected = Get-FixtureCommonDir $caller

            $resolved = Resolve-GitCommonDir -CurrentDirectory $caller -ScriptRoot $PSScriptRoot

            [IO.Path]::GetFullPath($resolved.Trim()) | Should -Be $expected
        }
        finally { Remove-GitFixture $caller }
    }

    It 'answers the same from a deep subdirectory of that repository' {
        $caller = New-GitFixture -NoOrigin
        try {
            $expected = Get-FixtureCommonDir $caller
            $deep = Join-Path $caller 'a/b/c'
            New-Item -ItemType Directory -Path $deep -Force | Out-Null

            $resolved = Resolve-GitCommonDir -CurrentDirectory $deep -ScriptRoot $PSScriptRoot

            [IO.Path]::GetFullPath($resolved.Trim()) | Should -Be $expected
        }
        finally { Remove-GitFixture $caller }
    }

    It 'answers the main worktree''s git dir from inside a linked worktree -- #275 still holds' {
        $caller = New-GitFixture -NoOrigin
        $linked = $null
        try {
            $expected = Get-FixtureCommonDir $caller
            $linked = Join-Path ([IO.Path]::GetTempPath()) ('sia-571r-wt-' + [guid]::NewGuid().ToString('N'))
            git -C $caller worktree add -q -b feature $linked main 2>&1 | Out-Null

            $resolved = Resolve-GitCommonDir -CurrentDirectory $linked -ScriptRoot $PSScriptRoot

            [IO.Path]::GetFullPath($resolved.Trim()) | Should -Be $expected
        }
        finally {
            if ($linked -and (Test-Path $linked)) { Remove-Item $linked -Recurse -Force -ErrorAction SilentlyContinue }
            Remove-GitFixture $caller
        }
    }

    It 'falls back to the script''s own repository when the current directory is not in one' {
        $outside = New-GitFixture -NotARepo
        try {
            $expected = Get-FixtureCommonDir $PSScriptRoot

            $resolved = Resolve-GitCommonDir -CurrentDirectory $outside -ScriptRoot $PSScriptRoot

            [IO.Path]::GetFullPath($resolved.Trim()) | Should -Be $expected
        }
        finally { Remove-GitFixture $outside }
    }

    It 'falls back for an empty current directory -- a non-FileSystem location has no path git can use' {
        # Set-Location Env:\ (also Function:\ and Variable:\) leaves
        # $PWD.ProviderPath empty, and `git -C ''` is a parameter-binding failure,
        # fatal under $ErrorActionPreference 'Stop' -- not something the git edge
        # could turn into a fallback. So the guard belongs here, before the call.
        $expected = Get-FixtureCommonDir $PSScriptRoot

        $fromEmpty = Resolve-GitCommonDir -CurrentDirectory '' -ScriptRoot $PSScriptRoot
        $fromNull = Resolve-GitCommonDir -CurrentDirectory $null -ScriptRoot $PSScriptRoot

        [IO.Path]::GetFullPath($fromEmpty.Trim()) | Should -Be $expected
        [IO.Path]::GetFullPath($fromNull.Trim()) | Should -Be $expected
    }

    It 'returns empty when neither the current directory nor the script root is in a repository' {
        $outside = New-GitFixture -NotARepo
        try {
            # '' is what Get-LaunchDirectory needs in order to fall back to its
            # -ScriptRoot rather than deriving a directory from nothing.
            Resolve-GitCommonDir -CurrentDirectory $outside -ScriptRoot $outside | Should -BeNullOrEmpty
        }
        finally { Remove-GitFixture $outside }
    }
}

Describe 'Start-IssueAgent.ps1: a missing issue number is a usage error (issue #571)' {
    BeforeAll {
        $script:Launcher = Join-Path $PSScriptRoot 'Start-IssueAgent.ps1'
    }

    BeforeEach {
        $script:originalWtSession = $env:WT_SESSION
        $script:originalClaudeCode = $env:CLAUDECODE
        $env:WT_SESSION = $null
        $env:CLAUDECODE = $null
    }

    AfterEach {
        $env:WT_SESSION = $script:originalWtSession
        $env:CLAUDECODE = $script:originalClaudeCode
    }

    It 'reports the missing issue number before resolving a repository or calling gh' {
        # The check is hoisted above repository resolution on purpose: below it, a
        # bare invocation inside a repository without an origin would report
        # "Could not resolve 'origin' remote" instead of what the caller got wrong.
        $bare = Join-Path ([IO.Path]::GetTempPath()) ('sia-571u-' + [guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Path $bare -Force | Out-Null
            git init -q -b main $bare 2>&1 | Out-Null   # a repository with NO origin
            Mock -CommandName gh -MockWith { $global:LASTEXITCODE = 0; '{"number":7,"title":"x"}' }
            Mock -CommandName Start-Process -MockWith { }

            Push-Location $bare
            try {
                # Write-Error is terminating here: the script sets
                # $ErrorActionPreference = 'Stop', so `exit 1` is never reached and
                # the error surfaces to the caller.
                { & $script:Launcher } | Should -Throw '*IssueNumber is required*'
            }
            finally { Pop-Location }

            Should -Invoke gh -Times 0
            Should -Invoke Start-Process -Times 0
        }
        finally { if (Test-Path $bare) { Remove-Item $bare -Recurse -Force -ErrorAction SilentlyContinue } }
    }
}

Describe 'Start-IssueAgent.ps1: the comment-based help states which repository wins (issue #571)' {
    # The old help asserted the opposite rule as deliberate, in eight places. A
    # reader who trusts it would reach the wrong conclusion about a defect, so
    # the wording is part of the change rather than a tidy-up after it.

    BeforeAll {
        $script:HelpText = Get-Help (Join-Path $PSScriptRoot 'Start-IssueAgent.ps1') -Full | Out-String
    }

    It 'says the repository follows the caller''s current directory' {
        $script:HelpText | Should -Match "(?s)current directory"
    }

    It 'no longer claims the anchor is this script''s own directory' {
        $script:HelpText | Should -Not -Match "anchored on this script's own"
    }

    It 'still explains why the launch directory is the main worktree root (issue #275)' {
        $script:HelpText | Should -Match '(?s)main worktree root'
        $script:HelpText | Should -Match '(?s)nested inside that one'
    }

    It 'documents that -New makes no gh call while still naming the repository' {
        $script:HelpText | Should -Not -Match 'No `gh`/`git remote` call is made'
        $script:HelpText | Should -Match '(?s)launch message'
    }
}
