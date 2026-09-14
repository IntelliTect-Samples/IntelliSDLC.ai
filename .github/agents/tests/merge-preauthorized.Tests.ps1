#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for "merging a finished PR is pre-authorized" (issue #499).
#
# Sessions stopped at the end of a finished dev loop to ask permission to merge,
# even though Phase 8 was already autonomous. Three causes: no explicit durable
# authorization (so a harness's confirm-outward-actions default won), a CI gate
# that cannot be met when hosted CI cannot run at all, and the mandatory review
# being conflated with an optional permission. These tests pin the statement of
# each fix in all three instruction files, scoped to the section that carries
# it, so a revert of any one file fails here.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ClaudeMd   = Join-Path $script:RepoRoot 'CLAUDE.md'
    $script:DevLoop    = Join-Path $script:RepoRoot '.github/agents/dev-loop.agent.md'
    $script:CopilotIns = Join-Path $script:RepoRoot '.github/copilot-instructions.md'

    # A section is its heading line plus every line up to the next heading of
    # the same or a higher level.
    function Get-Section {
        param([string]$Path, [string]$HeadingPattern)
        $lines = Get-Content -LiteralPath $Path
        $start = -1; $level = 0
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^(#{1,6})\s+$HeadingPattern") {
                $start = $i; $level = $Matches[1].Length; break
            }
        }
        if ($start -lt 0) { return $null }
        $end = $lines.Count
        for ($j = $start + 1; $j -lt $lines.Count; $j++) {
            if ($lines[$j] -match '^(#{1,6})\s' -and $Matches[1].Length -le $level) { $end = $j; break }
        }
        return ($lines[$start..($end - 1)]) -join "`n"
    }

    # The three places a session reads the merge rule, each scoped to the
    # section that states it.
    $script:Sections = @{
        'CLAUDE.md merge section'               = Get-Section -Path $script:ClaudeMd   -HeadingPattern 'Merging\s+a\s+Finished\s+PR\s+Is\s+Pre-Authorized'
        'copilot-instructions.md Merge Step'    = Get-Section -Path $script:CopilotIns -HeadingPattern 'Merge\s+Step'
        'dev-loop.agent.md Phase 8'             = Get-Section -Path $script:DevLoop    -HeadingPattern 'Phase\s+8\b'
    }
}

Describe 'each merge rule states the authorization, the report, and the exceptions' -ForEach @(
    @{ Name = 'CLAUDE.md merge section' }
    @{ Name = 'copilot-instructions.md Merge Step' }
    @{ Name = 'dev-loop.agent.md Phase 8' }
) {
    BeforeAll { $script:Text = $script:Sections[$Name] }

    It '<Name> exists' {
        $script:Text | Should -Not -BeNullOrEmpty
    }

    It '<Name> states merging is pre-authorized, without asking' {
        $script:Text | Should -Match '(?i)pre-authori[sz]ed'
        $script:Text | Should -Match '(?i)without\s+asking'
    }

    It '<Name> replaces the permission prompt with a report' {
        $script:Text | Should -Match '(?i)then\s+report'
        $script:Text | Should -Match '(?i)Task\s+Complete\s+Summary'
    }

    It '<Name> keeps the independent review mandatory while dropping the permission' {
        $script:Text | Should -Match '(?i)independent\s+review\s+is\s+(still\s+)?mandatory'
        $script:Text | Should -Match '(?i)permission\s+is\s+not'
    }

    It '<Name> names the hold label as a reason to stop' {
        $script:Text | Should -Match '`hold`'
    }

    It '<Name> names missing reviewer-model evidence as a reason to stop' {
        $script:Text | Should -Match '(?i)reviewer(''s)?\s+model\s+(is\s+)?not\s+recorded|reviewing\s+model\s+(is\s+)?not\s+recorded'
    }

    It '<Name> names another session''s or author''s PR as a reason to stop' {
        $script:Text | Should -Match '(?i)another\s+session'
    }

    It '<Name> names an out-of-design change as a reason to stop' {
        $script:Text | Should -Match '(?i)outside\s+the\s+approved\s+design'
    }

    It '<Name> lets a developer-confirmed local CI run stand in when hosted CI cannot run' {
        $script:Text | Should -Match '(?i)hosted\s+CI\s+(cannot|can''t)\s+run'
        $script:Text | Should -Match '(?i)developer-confirmed'
        $script:Text | Should -Match '(?i)real\s+counts'
    }

    It '<Name> keeps a hosted CI run that failed as a hard stop' {
        $script:Text | Should -Match '(?i)hosted\s+CI\s+ran\s+and\s+failed'
        $script:Text | Should -Match '(?i)pre-existing\s+on\s+`?main`?'
    }
}

Describe 'no bare "CI is red" rule survives without the hosted-CI qualification' {
    # A bare "never merge while CI is red" is the rule a session could not
    # satisfy when hosted CI cannot run at all. Every paragraph that still says
    # it must also say what hosted CI being unavailable means.
    It '<File> qualifies every CI-is-red paragraph' -ForEach @(
        @{ File = 'CLAUDE.md' }
        @{ File = '.github/copilot-instructions.md' }
        @{ File = '.github/agents/dev-loop.agent.md' }
    ) {
        $raw = Get-Content -LiteralPath (Join-Path $script:RepoRoot $File) -Raw
        $paragraphs = $raw -split '(?:\r?\n){2,}'
        $offending = @($paragraphs | Where-Object { $_ -match '(?i)CI\s+is\s+red' -and $_ -notmatch '(?i)hosted\s+CI' })
        $offending | Should -BeNullOrEmpty -Because "each 'CI is red' paragraph in $File must say how an unavailable hosted CI is handled"
    }
}
