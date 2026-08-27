BeforeAll {
    . "$PSScriptRoot/Start-IssueAgent.ps1"
}

Describe 'Get-GitHubRepoSlug' {
    It 'parses an https origin remote' {
        Mock -CommandName git -MockWith { 'https://github.com/IntelliTect-Dev/IntelliSDLC.ai.git' }
        Get-GitHubRepoSlug | Should -Be 'IntelliTect-Dev/IntelliSDLC.ai'
    }

    It 'parses an https origin remote without a .git suffix' {
        Mock -CommandName git -MockWith { 'https://github.com/IntelliTect-Dev/IntelliSDLC.ai' }
        Get-GitHubRepoSlug | Should -Be 'IntelliTect-Dev/IntelliSDLC.ai'
    }

    It 'parses an ssh origin remote' {
        Mock -CommandName git -MockWith { 'git@github.com:IntelliTect-Dev/IntelliSDLC.ai.git' }
        Get-GitHubRepoSlug | Should -Be 'IntelliTect-Dev/IntelliSDLC.ai'
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

Describe 'New-IssueAgentPrompt' {
    It 'delegates to @dev-loop by issue number, without inlining the issue body' {
        New-IssueAgentPrompt -IssueNumber 42 | Should -Be '@dev-loop gh issue 42'
    }
}

Describe 'New-PlanAgentPrompt' {
    It 'delegates to @plan with the description as a seed' {
        New-PlanAgentPrompt -Description 'users need CSV export' | Should -Be '@plan users need CSV export'
    }

    It 'trims surrounding whitespace from the description' {
        New-PlanAgentPrompt -Description '  users need CSV export  ' | Should -Be '@plan users need CSV export'
    }

    It 'yields the bare @plan for an empty description' {
        New-PlanAgentPrompt -Description '' | Should -Be '@plan'
    }

    It 'yields the bare @plan for a whitespace-only description' {
        New-PlanAgentPrompt -Description "  `t " | Should -Be '@plan'
    }

    It 'passes a description containing a single quote through verbatim' {
        New-PlanAgentPrompt -Description "it's broken" | Should -Be "@plan it's broken"
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
