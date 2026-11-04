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
# These assertions test the GUARD, not its vocabulary, and the fixture table
# below is why. Two earlier drafts were defeated by independent review:
#   1. Matching `closed`, `stop` and the field name anywhere in the section
#      passed against prose reading "a CLOSED state is informational only ...
#      not a signal to halt".
#   2. Requiring the literal word `stop` in the same sentence as CLOSED, with a
#      fixed list of neutralising phrases, still passed "does not stop the run"
#      and "never stops the run" (the neutralisers all required the article
#      "a"), and wrongly REJECTED correct guards worded with `halt` / `end the
#      run`, or split across two sentences.
# Every fixture below is a case that actually broke one of those drafts. Add to
# it rather than loosening the predicate.

BeforeDiscovery {
    $script:GuardFixtures = @(
        @{ Name = 'prose that says a closed state does not stop the run'
           Expected = $false
           Text = 'A `CLOSED` state does not stop the run; continue to Phase 1 regardless.' }
        @{ Name = 'prose that says a closed state never stops the run'
           Expected = $false
           Text = 'A `CLOSED` state never stops the run -- proceed to Phase 1 either way.' }
        @{ Name = "prose using the contracted won't stop"
           Expected = $false
           Text = "A `CLOSED` state won't stop the run; carry on to Phase 1." }
        @{ Name = 'prose calling a closed state informational only'
           Expected = $false
           Text = 'A `CLOSED` state is informational only and is not a signal to halt.' }
        @{ Name = 'a correct guard worded with halt and end the run'
           Expected = $true
           Text = 'If the result is `CLOSED`, halt immediately and end the run. Do not proceed to Phase 1.' }
        @{ Name = 'a correct guard split across two sentences'
           Expected = $true
           Text = 'The issue may come back `CLOSED`. In that case, stop the run and report it.' }
        @{ Name = 'a correct guard joined by a semicolon'
           Expected = $true
           Text = 'Read the state; a `CLOSED` result means stop the run.' }
        @{ Name = 'the unguarded Phase 0 this issue replaced'
           Expected = $false
           Text = 'If a design issue already exists, skip Phase 0 and proceed directly to Phase 1.' }
    )
}

Describe 'dev-loop.agent.md Phase 0 checks the issue state before any worktree' {
    BeforeAll {
        $stopVerb            = '(\bstops?\b|\bstopping\b|\bhalts?\b|\baborts?\b|ends?\s+the\s+run)'
        $script:StopPattern  = "(?i)($stopVerb|do(es)?\s+not\s+(proceed|continue))"
        $negator             = '(?i)(\bnot\b|\bnever\b|\bcannot\b|n''t\b|\bno\s+longer\b)'
        $script:NegatedStop  = "$negator[^.!;]{0,20}?(?i)$stopVerb"

        function Test-Phase0StateGuard {
            <#  True only when the section reads the issue state AND ties a
                CLOSED result to stopping. Negating the stop verb anywhere in
                the CLOSED sentence (or the one after it) disqualifies it, so
                keeping the vocabulary while inverting the meaning fails.  #>
            param([Parameter(Mandatory)][AllowEmptyString()][string]$Body)

            if ($Body -notmatch 'gh issue view') { return $false }
            if ($Body -notmatch '(?m)--json[^\r\n]*\bstate\b') { return $false }

            # The guard may span the CLOSED sentence and the one following it.
            $sentences = [regex]::Split($Body, '(?<=[.!])\s+')
            $windows = @()
            for ($i = 0; $i -lt $sentences.Count; $i++) {
                if ($sentences[$i] -notmatch '\bCLOSED\b') { continue }
                $w = $sentences[$i]
                if ($i + 1 -lt $sentences.Count) { $w += ' ' + $sentences[$i + 1] }
                $windows += $w
            }
            if (-not $windows) { return $false }

            foreach ($w in $windows) { if ($w -match $script:NegatedStop) { return $false } }
            foreach ($w in $windows) { if ($w -match $script:StopPattern) { return $true } }
            return $false
        }

        $script:Phase0Body = (Get-Phase0Section -Path $script:DevLoop) -join "`n"
    }

    It 'ties a CLOSED state to stopping the run' {
        Test-Phase0StateGuard -Body $script:Phase0Body | Should -BeTrue
    }

    It 'judges <Name> as <Expected>' -ForEach $script:GuardFixtures {
        # Every fixture carries the state-read preamble, so only the guard
        # sentence under test decides the verdict.
        $body = "gh issue view <n> --json state,stateReason,closedByPullRequestsReferences`n" + $Text
        Test-Phase0StateGuard -Body $body | Should -Be $Expected
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
