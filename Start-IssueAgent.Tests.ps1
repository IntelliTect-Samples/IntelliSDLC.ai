BeforeAll {
    . "$PSScriptRoot/Start-IssueAgent.ps1"
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
        # repository: Get-LaunchDirectory anchors on $PSScriptRoot, so this
        # must too, or an absolute-path invocation from another repo names the
        # session from that repo's issue #N while launching into this one.
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
        # The -New path resolves nothing itself -- @plan does its own repo
        # discovery and files the issue -- so gh need not be installed.
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

Describe 'Read-DescriptionFromStdin' {
    It 'returns the text read from stdin' {
        Read-DescriptionFromStdin -Reader { 'users need CSV export' } -IsInputRedirected $true |
            Should -Be 'users need CSV export'
    }

    It 'preserves interior newlines and blank lines of a pasted transcript' {
        $heredoc = "Review this log:`n`nwarning: CRLF will be replaced by LF`nPlease investigate"
        Read-DescriptionFromStdin -Reader { $heredoc }.GetNewClosure() -IsInputRedirected $true |
            Should -Be $heredoc
    }

    It 'normalizes CRLF to LF' {
        Read-DescriptionFromStdin -Reader { "line one`r`nline two" } -IsInputRedirected $true |
            Should -Be "line one`nline two"
    }

    It 'trims the trailing newline a heredoc always adds' {
        Read-DescriptionFromStdin -Reader { "the description`n`n" } -IsInputRedirected $true |
            Should -Be 'the description'
    }

    It 'preserves embedded single quotes verbatim' {
        Read-DescriptionFromStdin -Reader { "it's broken" } -IsInputRedirected $true |
            Should -Be "it's broken"
    }

    It 'throws when stdin is not redirected, rather than blocking on the console' {
        { Read-DescriptionFromStdin -Reader { 'unused' } -IsInputRedirected $false } |
            Should -Throw '*stdin is not redirected*'
    }

    It 'throws on empty stdin rather than launching a seedless session' {
        { Read-DescriptionFromStdin -Reader { '' } -IsInputRedirected $true } |
            Should -Throw '*empty description*'
    }

    It 'throws on whitespace-only stdin' {
        { Read-DescriptionFromStdin -Reader { "  `n`t " } -IsInputRedirected $true } |
            Should -Throw '*empty description*'
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

    It 'opens a new tab when stdin was consumed, even inside Windows Terminal without -NewTab' {
        # An inline claude in the current pane would inherit the drained stdin.
        Get-ClaudeLaunchMode -InWindowsTerminal $true -WtAvailable $true -InClaudeCodeSession $false `
            -StdinConsumed $true | Should -Be 'NewTab'
    }

    It 'falls back to a new window when stdin was consumed but wt.exe is unavailable' {
        Get-ClaudeLaunchMode -InWindowsTerminal $true -WtAvailable $false -InClaudeCodeSession $false `
            -StdinConsumed $true | Should -Be 'NewWindow'
    }

    It 'still reuses the current pane when stdin was NOT consumed (the default)' {
        Get-ClaudeLaunchMode -InWindowsTerminal $true -WtAvailable $true -InClaudeCodeSession $false `
            -StdinConsumed $false | Should -Be 'CurrentPane'
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

    It 'opens a new tab when -StdinConsumed is passed, even in Windows Terminal without -NewTab' {
        $env:WT_SESSION = 'some-guid'
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }
        Mock -CommandName claude -MockWith { }

        Start-ClaudeIssueSession -Name 'new: Review this log' -Prompt "@plan Review this log:`nwarning: CRLF" `
            -PermissionMode 'plan' -WorkingDirectory 'C:\repo' -StdinConsumed

        Should -Invoke Start-Process -Times 1 -ParameterFilter { $FilePath -eq 'wt.exe' }
        Should -Invoke claude -Times 0
    }

    It 'round-trips a multi-line prompt through the -EncodedCommand blob intact' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { [pscustomobject]@{ Name = 'wt.exe' } }
        Mock -CommandName Start-Process -MockWith { }

        $multiline = "@plan Review this log:`nwarning: it's CRLF again`n`nPlease investigate"
        Start-ClaudeIssueSession -Name 'new: Review this log' -Prompt $multiline `
            -PermissionMode 'plan' -WorkingDirectory 'C:\repo' -StdinConsumed

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
