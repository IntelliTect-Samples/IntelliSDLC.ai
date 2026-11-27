#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for "command-line tools and scripts never block waiting for
# input when they run non-interactively" (issue #608).
#
# Nothing in the instruction set said a tool must not wait for input it cannot
# get. An agent session, a CI job, a scheduled task or a pipe has no one at the
# keyboard, so a prompt there does not fail -- it hangs until something kills
# the run, and nothing reports why. Measured while writing the rule: an
# unguarded Read-Host, or an unbound Mandatory parameter, in a child pwsh whose
# stdin is an open pipe never returns; under -NonInteractive the same Read-Host
# writes a non-terminating error, the script carries on with an empty answer,
# and exits 0.
#
# These tests pin the rule in the global floor, the canonical section, its
# CLAUDE.md summary, the PowerShell guidance and every pointer to it, so a
# revert of any one file fails here. The PowerShell guidance's interactivity
# check is also RUN, so a sample that no longer parses or no longer says "not
# interactive" for redirected input fails too.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '../../..') | Select-Object -ExpandProperty Path

    # Everything this file writes goes under $TestDrive. A stray write into the
    # Pester install once broke every Invoke-Pester on a machine, so hash it now
    # and prove at the end that the run left it unchanged.
    function script:Get-PesterInstallHash {
        $base = (Get-Module Pester).ModuleBase
        Get-ChildItem -LiteralPath $base -Recurse -File |
            Sort-Object FullName |
            ForEach-Object { '{0}|{1}' -f $_.FullName.Substring($base.Length), (Get-FileHash -LiteralPath $_.FullName).Hash }
    }
    $script:PesterHashBefore = @(Get-PesterInstallHash)

    function script:Read([string] $Relative) {
        Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot $Relative)
    }

    # A section is its heading line plus every line up to the next heading of
    # the same or a higher level. Fenced code is skipped when looking for that
    # next heading, so a '# comment' inside a code block does not end it.
    function script:Get-Section {
        param([string]$Relative, [string]$HeadingPattern)
        $lines = Get-Content -LiteralPath (Join-Path $script:RepoRoot $Relative)
        $start = -1; $level = 0
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^(#{1,6})\s+$HeadingPattern") {
                $start = $i; $level = $Matches[1].Length; break
            }
        }
        if ($start -lt 0) { return $null }
        $end = $lines.Count; $inFence = $false
        for ($j = $start + 1; $j -lt $lines.Count; $j++) {
            if ($lines[$j] -match '^\s*```') { $inFence = -not $inFence; continue }
            if (-not $inFence -and $lines[$j] -match '^(#{1,6})\s' -and $Matches[1].Length -le $level) { $end = $j; break }
        }
        return ($lines[$start..($end - 1)]) -join "`n"
    }

    $script:RuleName = 'Non-Interactive\s+Runs\s+--\s+Never\s+Block\s+on\s+Input'
    $script:Global   = Get-Section -Relative 'GLOBAL-INSTRUCTIONS.md' -HeadingPattern $script:RuleName
    $script:Rule     = Get-Section -Relative '.github/copilot-instructions.md' -HeadingPattern $script:RuleName
    $script:Claude   = Get-Section -Relative 'CLAUDE.md' -HeadingPattern $script:RuleName
    $script:PwshSec  = Get-Section -Relative '.github/instructions/powershell.instructions.md' -HeadingPattern 'Non-Interactive\s+Runs\s*$'
}

Describe 'the global floor states the rule, briefly (issue #608)' {

    It 'has a Non-Interactive Runs -- Never Block on Input section' {
        $script:Global | Should -Not -BeNullOrEmpty
    }

    It 'stays short, because it is loaded in every repository' {
        @($script:Global -split "`n").Count | Should -BeLessOrEqual 14
    }

    It 'forbids waiting for input the tool cannot get' {
        $script:Global | Should -Match '(?is)never\s+wait\s+for\s+input\s+it\s+cannot\s+get'
    }

    It 'requires a non-interactive path or a fast failure that names what to use instead' {
        $script:Global | Should -Match '(?is)non-interactive\s+path\s+or\s+fails\s+fast'
        $script:Global | Should -Match '(?is)naming\s+the\s+flag\s+or\s+command\s+to\s+use\s+instead'
    }

    It 'names what "not interactive" covers' {
        $script:Global | Should -Match '(?is)stdin\s+redirected\s+or\s+piped'
        $script:Global | Should -Match '-NonInteractive'
        $script:Global | Should -Match '`CI`'
        $script:Global | Should -Match '(?is)scheduled\s+task\s+or\s+service'
        $script:Global | Should -Match '(?is)cannot\s+prompt'
    }

    It 'asks for guarded prompts, non-interactive child flags, an equivalent for each interactive feature, and a test' {
        $script:Global | Should -Match '(?is)guard\s+every\s+prompt'
        $script:Global | Should -Match '--yes'
        $script:Global | Should -Match '(?is)documented\s+non-interactive\s+equivalent'
        $script:Global | Should -Match '(?is)test\s+that\s+path\s+with\s+input\s+redirected'
    }

    It 'does not contradict the Reporting rule that hands the user a block with Read-Host in it' {
        $script:Global | Should -Match '(?is)command\s+block\s+handed\s+to\s+(a\s+person|the\s+user)[^.]*interactive\s+by\s+definition'
    }
}

Describe 'copilot-instructions.md holds the canonical rule (issue #608)' {

    It 'has the section, right after Adding Command-Line Options' {
        $script:Rule | Should -Not -BeNullOrEmpty
        Read '.github/copilot-instructions.md' |
            Should -Match '(?s)## Adding Command-Line Options -- Prompt First.*?\n## Non-Interactive Runs -- Never Block on Input'
    }

    It 'says why: an unattended prompt hangs rather than fails' {
        $script:Rule | Should -Match '(?is)never\s+wait\s+for\s+input\s+it\s+cannot\s+get'
        $script:Rule | Should -Match '(?is)hangs'
    }

    It 'requires a non-interactive path or a fast failure that names the flag or command' {
        $script:Rule | Should -Match '(?is)take\s+a\s+non-interactive\s+path\s+or\s+fail\s+fast'
        $script:Rule | Should -Match '(?is)names\s+the\s+flag\s+or\s+command\s+to\s+use\s+instead'
    }

    It 'lists each way a run is not interactive' {
        $script:Rule | Should -Match '(?im)^-\s+stdin\s+is\s+redirected\s+or\s+piped'
        $script:Rule | Should -Match '(?im)^-\s+PowerShell\s+was\s+started\s+with\s+`-NonInteractive`'
        $script:Rule | Should -Match '(?im)^-\s+it\s+runs\s+in\s+CI\s+\(`CI`\s+is\s+set\)'
        $script:Rule | Should -Match '(?im)^-\s+it\s+runs\s+as\s+a\s+scheduled\s+task\s+or\s+a\s+service'
        $script:Rule | Should -Match '(?im)^-\s+the\s+host\s+cannot\s+prompt'
        $script:Rule | Should -Match '(?is)output\s+is\s+not\s+attached\s+to\s+(a|one)\b'
    }

    It 'forbids a prompting API without an interactivity guard, and prefers parameters' {
        $script:Rule | Should -Match '(?is)never\s+call\s+a\s+prompting\s+API\s+without\s+an\s+interactivity\s+guard'
        $script:Rule | Should -Match '(?is)prefer\s+explicit\s+parameters\s+and\s+switches\s+over\s+prompts'
    }

    It 'names the PowerShell APIs that prompt' {
        foreach ($api in 'Read-Host', '\$Host\.UI\.PromptForChoice', 'Get-Credential', '\[Console\]::ReadKey',
                         'Out-GridView', '`pause`', 'ShouldContinue', "ConfirmImpact = 'High'", '`Mandatory`') {
            $script:Rule | Should -Match $api
        }
    }

    It 'says UserInteractive alone is not enough, because it is $true in an agent session' {
        $script:Rule | Should -Match '(?is)UserInteractive\]?`?\s+alone\s+is\s+not\s+enough[^.]*agent\s+session'
    }

    It 'passes native tools their non-interactive flags, so a child cannot block' {
        foreach ($flag in '`-y`', '`--yes`', '`--silent`', '`--accept-\*`', '`--non-interactive`', '`--no-input`') {
            $script:Rule | Should -Match $flag
        }
        $script:Rule | Should -Match '(?is)child\s+process\s+cannot\s+block'
        $script:Rule | Should -Match '(?is)no\s+stdin\s+to\s+wait\s+on'
    }

    It 'welcomes interactive features but requires a documented non-interactive equivalent' {
        $script:Rule | Should -Match '(?is)every\s+interactive\s+feature\s+has\s+a\s+documented\s+non-interactive\s+equivalent'
    }

    It 'keeps a new flag for that equivalent under the prompt-first rule' {
        $script:Rule | Should -Match '\*\*Adding Command-Line Options -- Prompt First\*\*'
    }

    It 'requires a test of the non-interactive path, with input redirected, under a timeout' {
        $script:Rule | Should -Match '(?is)test\s+the\s+non-interactive\s+path'
        $script:Rule | Should -Match '(?is)input\s+redirected'
        $script:Rule | Should -Match '(?is)timeout'
        $script:Rule | Should -Match '(?is)returns\s+or\s+fails\s+promptly'
    }

    It 'points at the concrete PowerShell guidance' {
        $script:Rule | Should -Match '(?s)\*\*Non-Interactive Runs\*\*.{0,40}powershell\.instructions\.md'
    }

    It 'scopes out a command block handed to a person to paste' {
        $script:Rule | Should -Match '(?is)command\s+block\s+handed\s+to\s+a\s+person[^.]*interactive\s+by\s+definition'
    }
}

Describe 'CLAUDE.md summarizes the rule and points at it (issue #608)' {

    It 'has the section' {
        $script:Claude | Should -Not -BeNullOrEmpty
    }

    It 'states the rule in brief' {
        $script:Claude | Should -Match '(?is)never\s+wait\s+for\s+input\s+it\s+cannot\s+get'
        $script:Claude | Should -Match '(?is)non-interactive\s+path\s+or\s+fails\s+fast'
        $script:Claude | Should -Match '(?is)documented\s+non-interactive\s+equivalent'
    }

    It 'points at the canonical section' {
        $script:Claude | Should -Match "\*\*$script:RuleName\*\*"
        $script:Claude | Should -Match 'copilot-instructions\.md'
    }
}

Describe 'powershell.instructions.md gives the concrete PowerShell guidance (issue #608)' {

    It 'has a Non-Interactive Runs section that points at the canonical rule' {
        $script:PwshSec | Should -Not -BeNullOrEmpty
        $script:PwshSec | Should -Match "\*\*$script:RuleName\*\*"
    }

    It 'names every PowerShell API that prompts' {
        foreach ($api in 'Read-Host', '\$Host\.UI\.PromptForChoice', 'Get-Credential', '\[Console\]::ReadKey',
                         'Out-GridView', '`pause`', 'ShouldContinue', "ConfirmImpact = 'High'", '`Mandatory`') {
            $script:PwshSec | Should -Match $api
        }
    }

    It 'says an unguarded prompt hangs on an open pipe' {
        $script:PwshSec | Should -Match '(?is)open\s+pipe[^.]*hangs'
    }

    It 'warns that -NonInteractive alone lets Read-Host carry on with an empty answer' {
        $script:PwshSec | Should -Match '(?is)`-NonInteractive`\s+alone\s+is\s+not\s+the\s+fix'
        $script:PwshSec | Should -Match '(?is)non-terminating\s+error'
        $script:PwshSec | Should -Match '(?is)empty\s+answer'
    }

    It 'prefers parameters to prompts and fails naming the parameter' {
        $script:PwshSec | Should -Match '(?is)prefer\s+parameters\s+to\s+prompts'
        $script:PwshSec | Should -Match '(?is)naming\s+the\s+parameter'
        $script:PwshSec | Should -Match ([regex]::Escape('-Confirm:$false'))
    }

    It 'gives an interactivity check built from every signal' {
        $script:PwshSec | Should -Match ([regex]::Escape('[Environment]::UserInteractive'))
        $script:PwshSec | Should -Match ([regex]::Escape('[Console]::IsInputRedirected'))
        $script:PwshSec | Should -Match ([regex]::Escape('[Environment]::GetCommandLineArgs()'))
        $script:PwshSec | Should -Match ([regex]::Escape('$Host.Name'))
        $script:PwshSec | Should -Match ([regex]::Escape('$env:CI'))
    }

    It 'warns that UserInteractive alone is $true inside an agent session' {
        $script:PwshSec | Should -Match '(?is)UserInteractive\]?`?\s+alone\s+is\s+not\s+enough[^.]*agent\s+session'
    }

    It 'gives native commands their flags, or no stdin to wait on' {
        $script:PwshSec | Should -Match '--yes'
        $script:PwshSec | Should -Match ([regex]::Escape('$null |'))
    }

    It 'shows a test that runs the script with stdin an open pipe, under a timeout' {
        $script:PwshSec | Should -Match '(?is)mock\s+`Test-Interactive`'
        $script:PwshSec | Should -Match ([regex]::Escape('RedirectStandardInput = $true'))
        $script:PwshSec | Should -Match 'WaitForExit\(\d+\)'
        $script:PwshSec | Should -Match '(?s)finally.*Kill'
    }

    It 'points the state-changing guidance at it, since a High confirm impact prompts' {
        Get-Section -Relative '.github/instructions/powershell.instructions.md' -HeadingPattern 'State-Changing\s+Functions' |
            Should -Match '\*\*Non-Interactive Runs\*\*'
    }
}

Describe 'the PowerShell interactivity check works as written (issue #608)' {

    BeforeAll {
        $fence = [regex]::Match([string]$script:PwshSec, '(?ms)^\s*```powershell\s*\n(\s*function Test-Interactive\b.*?)^\s*```')
        $script:CheckSource = $fence.Groups[1].Value

        # Runs the check in a child pwsh whose stdin is an open pipe nobody
        # writes to -- the agent / CI case -- and returns what it printed.
        function script:Invoke-Check([string[]] $ExtraArgs = @()) {
            $file = Join-Path $TestDrive 'Test-Interactive.ps1'
            Set-Content -LiteralPath $file -Value ($script:CheckSource + "`nTest-Interactive")
            $psi = [System.Diagnostics.ProcessStartInfo]::new('pwsh')
            @('-NoProfile') + $ExtraArgs + @('-File', $file) | ForEach-Object { $psi.ArgumentList.Add($_) }
            $psi.RedirectStandardInput = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            # Drop CI so a CI runner proves the input signal, not just the CI one.
            [void]$psi.Environment.Remove('CI')
            $proc = [System.Diagnostics.Process]::Start($psi)
            try {
                $out = $proc.StandardOutput.ReadToEndAsync()
                $err = $proc.StandardError.ReadToEndAsync()
                $proc.WaitForExit(60000) | Should -BeTrue -Because 'the check itself must never wait for input'
                $err.Result | Should -BeNullOrEmpty
                return $out.Result.Trim()
            } finally {
                if (-not $proc.HasExited) { $proc.Kill($true) }
            }
        }
    }

    It 'is in the section as a fenced powershell block' {
        $script:CheckSource | Should -Not -BeNullOrEmpty
    }

    It 'says not interactive when stdin is redirected' {
        Invoke-Check | Should -Be 'False'
    }

    It 'says not interactive under -NonInteractive' {
        Invoke-Check -ExtraArgs '-NonInteractive' | Should -Be 'False'
    }
}

Describe 'every other place that covers prompts points at the rule (issue #608)' -ForEach @(
    @{ File = '.github/instructions/console-ui.instructions.md' }
    @{ File = '.github/skills/code-review-workflow/SKILL.md' }
) {
    It '<File> names Non-Interactive Runs -- Never Block on Input' {
        Read $File | Should -Match "\*\*$script:RuleName\*\*"
    }
}

Describe 'code review lists an unguarded prompt as a finding (issue #608)' {
    It 'names a prompt with no non-interactive path in the Correctness checks' {
        Get-Section -Relative '.github/skills/code-review-workflow/SKILL.md' -HeadingPattern 'Correctness' |
            Should -Match '(?is)prompt[^.\n]*no\s+interactivity\s+guard'
    }
}

Describe 'this file leaves the Pester install unchanged (issue #608)' {
    It 'hashes every file of the loaded Pester module the same as before the run' {
        @(Get-PesterInstallHash) | Should -Be $script:PesterHashBefore
    }
}
