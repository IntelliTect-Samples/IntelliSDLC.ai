#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for the dev-loop / plan agent boundary (issue #73).
# Asserts that dev-loop.agent.md Phase 0 delegates the design dialogue to the
# Plan agent rather than duplicating the Socratic-question recipe, and that
# plan.agent.md still contains that recipe.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:DevLoop    = Join-Path $script:RepoRoot '.github/agents/dev-loop.agent.md'
    $script:PlanAgent  = Join-Path $script:RepoRoot '.github/agents/plan.agent.md'

    # Extract the body of the '### Phase 0' section: lines after the header
    # up to (but not including) the next '### ' header.
    function Get-Phase0Section {
        param([string]$Path)
        $lines = Get-Content -LiteralPath $Path
        $start = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^###\s+Phase\s+0\b') { $start = $i; break }
        }
        if ($start -lt 0) { return $null }
        $end = $lines.Count
        for ($j = $start + 1; $j -lt $lines.Count; $j++) {
            if ($lines[$j] -match '^###\s') { $end = $j; break }
        }
        return ,($lines[$start..($end - 1)])
    }
}

Describe 'dev-loop.agent.md Phase 0 delegates to Plan agent' {
    BeforeAll {
        $script:Phase0 = Get-Phase0Section -Path $script:DevLoop
    }

    It 'has a Phase 0 section' {
        $script:Phase0 | Should -Not -BeNullOrEmpty
    }

    It 'Phase 0 section is shorter than 50 lines (delegate, not recipe)' {
        $script:Phase0.Count | Should -BeLessThan 50
    }

    It 'Phase 0 section references the Plan agent (plan.agent.md or @plan)' {
        $body = $script:Phase0 -join "`n"
        ($body -match 'plan\.agent\.md' -or $body -match '@plan') | Should -BeTrue
    }

    It 'Phase 0 section mentions the skip-if-issue-exists short-circuit' {
        $body = $script:Phase0 -join "`n"
        $body | Should -Match '(?i)(skip|already exists|existing issue)'
    }
}

Describe 'plan.agent.md preserves the core Socratic-question recipe' {
    BeforeAll {
        $script:PlanText = Get-Content -LiteralPath $script:PlanAgent -Raw
    }

    It 'mentions asking questions one at a time' {
        $script:PlanText | Should -Match '(?i)one\s+(question\s+)?(at\s+a\s+time|per\s+message)'
    }

    It 'mentions proposing 2-3 approaches with trade-offs' {
        $script:PlanText | Should -Match '(?i)2-3\s+(different\s+)?approaches'
        $script:PlanText | Should -Match '(?i)trade-?offs'
    }

    It 'mentions creating a GitHub issue as the primary output' {
        $script:PlanText | Should -Match '(?i)GitHub\s+issue'
    }

    It 'mentions multiple choice question preference' {
        $script:PlanText | Should -Match '(?i)multiple\s+choice'
    }
}

# Issue #589: a dispatch hand-off is a durable string that can be replayed days
# after it was composed, by which time its issue may be closed and its work
# merged. The dispatcher validates at claim time and then exits, so only the
# receiver can catch a stale hand-off. Phase 0 must therefore check the issue
# state before Phase 1 creates a worktree.
#
# These assertions deliberately test the GUARD, not its vocabulary. An earlier
# draft matched `closed`, `stop` and the field name anywhere in the section,
# which passed against prose stating the opposite ("a CLOSED state is
# informational only ... not a signal to halt"). Test-Phase0StateGuard below is
# therefore polarity-aware, and 'rejects prose that inverts the guard' holds it
# to that.

Describe 'dev-loop.agent.md Phase 0 checks the issue state before any worktree' {
    BeforeAll {
        # Phrases that neutralise the guard while keeping its vocabulary.
        $script:Neutralisers = @(
            '(?i)never\s+a\s+stop'
            '(?i)not\s+a\s+(signal\s+to\s+halt|stop)'
            '(?i)informational\s+only'
            '(?i)for\s+context\s+only'
            '(?i)no\s+stop\s+condition'
        )

        function Test-Phase0StateGuard {
            <#  True only when the section reads the issue state AND ties a
                CLOSED state to stopping, with no phrase undoing that.  #>
            param([Parameter(Mandatory)][AllowEmptyString()][string]$Body)

            if ($Body -notmatch 'gh issue view') { return $false }
            if ($Body -notmatch '(?m)--json[^\r\n]*\bstate\b') { return $false }

            foreach ($n in $script:Neutralisers) {
                if ($Body -match $n) { return $false }
            }

            # The sentence that introduces CLOSED must itself say stop.
            $sentences = [regex]::Split($Body, '(?<=[.!])\s+')
            $closed = @($sentences | Where-Object { $_ -match '\bCLOSED\b' })
            if (-not $closed) { return $false }
            return [bool](@($closed | Where-Object { $_ -match '(?i)\bstop' }).Count)
        }

        $script:Phase0Body = (Get-Phase0Section -Path $script:DevLoop) -join "`n"
    }

    It 'ties a CLOSED state to stopping the run' {
        Test-Phase0StateGuard -Body $script:Phase0Body | Should -BeTrue
    }

    It 'rejects prose that inverts the guard while keeping its vocabulary' {
        # Guards the assertion above against becoming vacuous.
        $inverted = @'
A `CLOSED` state is informational only. You may run
`gh issue view <n> --json state,stateReason,closedByPullRequestsReferences`
for context. There is never a stop condition here, and
`closedByPullRequestsReferences` is not a signal to halt. Always continue
before Phase 1 creates a worktree.
'@
        Test-Phase0StateGuard -Body $inverted | Should -BeFalse
    }

    It 'reads the state before instructing the run to continue' {
        $check = $script:Phase0Body.IndexOf('gh issue view')
        $skip  = [regex]::Match($script:Phase0Body, '(?i)skip Phase 0').Index
        $check | Should -BeGreaterThan -1
        $skip  | Should -BeGreaterThan $check
    }

    It 'says what to report when a closed issue has no closing pull request' {
        $script:Phase0Body | Should -Match 'closedByPullRequestsReferences'
        $script:Phase0Body | Should -Match '(?i)(empty|without one)'
        $script:Phase0Body | Should -Match 'stateReason'
    }

    It 'treats an unreadable issue as a stop, not as permission to proceed' {
        $script:Phase0Body | Should -Match '(?i)(command itself fails|cannot read|deleted, transferred)'
        $script:Phase0Body | Should -Match '(?i)also a stop'
    }
}
