BeforeAll {
    . "$PSScriptRoot/Start-IssueAgent.ps1"
}

Describe 'Get-GitHubRepoSlug' {
    It 'parses an https origin remote' {
        Mock -CommandName git -MockWith { 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git' }
        Get-GitHubRepoSlug | Should -Be 'IntelliTect-Samples/IntelliSDLC.ai'
    }

    It 'parses an https origin remote without a .git suffix' {
        Mock -CommandName git -MockWith { 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai' }
        Get-GitHubRepoSlug | Should -Be 'IntelliTect-Samples/IntelliSDLC.ai'
    }

    It 'parses an ssh origin remote' {
        Mock -CommandName git -MockWith { 'git@github.com:IntelliTect-Samples/IntelliSDLC.ai.git' }
        Get-GitHubRepoSlug | Should -Be 'IntelliTect-Samples/IntelliSDLC.ai'
    }

    It 'throws when there is no origin remote' {
        Mock -CommandName git -MockWith { $null }
        { Get-GitHubRepoSlug } | Should -Throw "*Pass -Repo explicitly*"
    }

    It 'throws when the remote is not a recognizable GitHub URL' {
        Mock -CommandName git -MockWith { 'https://example.com/not-github' }
        { Get-GitHubRepoSlug } | Should -Throw "*Pass -Repo explicitly*"
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
            [Environment]::SetEnvironmentVariable('GIT_DIR', $savedGitDir)
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

    It 'falls back to a plain new console window when wt.exe is unavailable and not in Windows Terminal' {
        $env:WT_SESSION = $null
        Mock -CommandName Get-Command -ParameterFilter { $Name -eq 'wt.exe' } -MockWith { $null }
        Mock -CommandName Start-Process -MockWith { }

        Start-ClaudeIssueSession -Name '42: Add widget support' -Prompt '@dev-loop gh issue 42' `
            -PermissionMode 'auto' -WorkingDirectory 'C:\repo'

        Should -Invoke Start-Process -Times 1 -ParameterFilter {
            $FilePath -eq 'claude' -and
            $WorkingDirectory -eq 'C:\repo' -and
            $ArgumentList.Count -eq 7 -and
            $ArgumentList[0] -eq '--name' -and
            $ArgumentList[1] -eq '42: Add widget support' -and
            $ArgumentList[2] -eq '--remote-control' -and
            $ArgumentList[3] -eq '--permission-mode' -and
            $ArgumentList[4] -eq 'auto' -and
            $ArgumentList[5] -eq '--' -and
            $ArgumentList[6] -eq '@dev-loop gh issue 42' -and
            # Overrides CLAUDE_CODE_CHILD_SESSION for just this new process,
            # without touching $env:CLAUDE_CODE_CHILD_SESSION in the caller.
            $Environment.ContainsKey('CLAUDE_CODE_CHILD_SESSION') -and
            $null -eq $Environment['CLAUDE_CODE_CHILD_SESSION']
        }
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
