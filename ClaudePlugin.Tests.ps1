#Requires -Modules Pester

<#
    Behavior tests for the Claude Code plugin marketplace this repository
    hosts (issue #599): .claude-plugin/marketplace.json, plugin.json and
    hooks.json. The plugin root is the repository root, so the skills it
    ships are the folders that already live here.
#>

BeforeAll {
    $script:PluginDir = Join-Path $PSScriptRoot '.claude-plugin'
    $script:Manifest = Get-Content -Raw (Join-Path $PluginDir 'plugin.json') | ConvertFrom-Json
    $script:Marketplace = Get-Content -Raw (Join-Path $PluginDir 'marketplace.json') | ConvertFrom-Json
    $script:GlobalRules = Join-Path $PSScriptRoot 'GLOBAL-INSTRUCTIONS.md'

    function Get-SessionStartCommand {
        $hooksFile = Join-Path $PSScriptRoot ($Manifest.hooks -replace '^\./', '')
        $hooks = Get-Content -Raw $hooksFile | ConvertFrom-Json
        @($hooks.hooks.SessionStart.hooks | Where-Object type -EQ 'command').command
    }

    # Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} before it runs a hook
    # command, with forward slashes in a shell-form command on Windows.
    function Expand-PluginRoot([string]$Command) {
        $Command.Replace('${CLAUDE_PLUGIN_ROOT}', ($PSScriptRoot -replace '\\', '/'))
    }

    # The bash Claude Code runs shell-form hooks in: Git Bash on Windows --
    # never C:\Windows\System32\bash.exe, which is WSL. Located from git's
    # exec path, because `git` on PATH is often a shim (scoop, winget).
    function Get-HookBash {
        if (-not $IsWindows) { return (Get-Command bash -ErrorAction SilentlyContinue).Source }
        if ($env:CLAUDE_CODE_GIT_BASH_PATH -and (Test-Path -LiteralPath $env:CLAUDE_CODE_GIT_BASH_PATH)) { return $env:CLAUDE_CODE_GIT_BASH_PATH }
        $dir = & git --exec-path 2>$null
        foreach ($i in 1..4) {
            if (-not $dir) { break }
            $candidate = Join-Path $dir 'bin/bash.exe'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
            $dir = Split-Path $dir -Parent
        }
    }

    function Get-ExpectedRules {
        (Get-Content -Raw $GlobalRules) -replace "`r`n", "`n"
    }

    function ConvertTo-Text([object[]]$Lines) {
        (($Lines | ForEach-Object { "$_" }) -join "`n") -replace "`r`n", "`n"
    }
}

Describe 'Marketplace' {
    It 'offers this repository root as the plugin, so its skills install without being copied or moved' {
        $Marketplace.plugins.Count | Should -Be 1
        $Marketplace.plugins[0].name | Should -Be $Manifest.name
        $Marketplace.plugins[0].source | Should -Be './'
    }

    It 'installs under the id the README documents, which consuming repos commit to their settings' {
        $id = "$($Manifest.name)@$($Marketplace.name)"
        (Get-Content -Raw (Join-Path $PSScriptRoot 'README.md')) | Should -Match ([regex]::Escape("claude plugin install $id"))
        (Get-Content -Raw (Join-Path $PSScriptRoot 'README.md')) | Should -Match ([regex]::Escape("`"$id`": true"))
    }

    It 'passes claude plugin validate' {
        $claude = Get-Command claude -ErrorAction SilentlyContinue
        if (-not $claude) {
            # CI runs this exact check in the root-tests.yml `plugin-validate`
            # job, which installs the CLI and fails red. It is kept off this
            # suite's PATH there: a real `claude` defeats Start-IssueAgent's mocks.
            Set-ItResult -Skipped -Because 'the claude CLI is not on PATH; CI validates in the plugin-validate job'
            return
        }
        $output = & $claude.Source plugin validate $PSScriptRoot 2>&1
        $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")
        ($output -join "`n") | Should -Not -Match 'Validation failed'
    }
}

Describe 'Skills' {
    It 'ships each listed skill from a folder inside this repository that holds a SKILL.md' {
        $Manifest.skills | Should -Not -BeNullOrEmpty
        foreach ($skill in $Manifest.skills) {
            $skill | Should -Match '^\./'
            $full = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $skill))
            $full.StartsWith($PSScriptRoot, [System.StringComparison]::OrdinalIgnoreCase) | Should -BeTrue -Because "$skill must stay inside the plugin root"
            Join-Path $full 'SKILL.md' | Should -Exist
        }
    }
}

Describe 'SessionStart hook' {
    It 'is a single command that reads GLOBAL-INSTRUCTIONS.md from the installed plugin' {
        $commands = @(Get-SessionStartCommand)
        $commands.Count | Should -Be 1
        $commands[0] | Should -Match ([regex]::Escape('${CLAUDE_PLUGIN_ROOT}/GLOBAL-INSTRUCTIONS.md'))
    }

    It 'prints the global working rules unchanged under bash, where Claude Code runs it when bash is present' {
        $bash = Get-HookBash
        $bash | Should -Not -BeNullOrEmpty -Because 'Git Bash (Windows) or bash must be installed to run this hook as Claude Code does'
        $output = & $bash -c (Expand-PluginRoot (Get-SessionStartCommand))
        $LASTEXITCODE | Should -Be 0
        (ConvertTo-Text $output).TrimEnd() | Should -BeExactly (Get-ExpectedRules).TrimEnd()
    }

    It 'prints the global working rules unchanged under PowerShell, the fallback when bash is absent' {
        $shells = @('pwsh') + $(if ($IsWindows) { 'powershell' })
        foreach ($shell in $shells) {
            $output = & $shell -NoProfile -NonInteractive -Command (Expand-PluginRoot (Get-SessionStartCommand))
            $LASTEXITCODE | Should -Be 0 -Because "$shell must run the hook"
            (ConvertTo-Text $output).TrimEnd() | Should -BeExactly (Get-ExpectedRules).TrimEnd() -Because "$shell must print the file unchanged"
        }
    }
}

Describe 'Distribution' {
    BeforeAll { . (Join-Path $PSScriptRoot 'Pull-SDLC.ai.ps1') }

    It 'stays repo-private: Pull-SDLC never ships the marketplace to a consuming project' {
        foreach ($file in Get-ChildItem -LiteralPath $PluginDir -File) {
            Test-IsUpstreamManagedPath -Path ".claude-plugin/$($file.Name)" | Should -BeFalse -Because "$($file.Name) would make every consumer a marketplace"
        }
    }
}
