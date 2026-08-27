#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for the independent-code-review invariant (issue #259).
# The requirement is that every change is reviewed by a model that did not
# write it. Copilot review is one transport for that; a review subagent on a
# different model is another. These tests assert the instruction files state
# the invariant, the substitution rule, the detection step, and the merge
# precondition in invariant terms -- so the three files cannot drift apart.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ClaudeMd   = Join-Path $script:RepoRoot 'CLAUDE.md'
    $script:DevLoop    = Join-Path $script:RepoRoot '.github/agents/dev-loop.agent.md'
    $script:CopilotIns = Join-Path $script:RepoRoot '.github/copilot-instructions.md'

    # Extract a '### Phase <n>' section body: the header line plus every line
    # up to (but not including) the next '### ' header.
    function Get-PhaseSection {
        param([string]$Path, [string]$Phase)
        $lines = Get-Content -LiteralPath $Path
        $start = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^###\s+Phase\s+$Phase\b") { $start = $i; break }
        }
        if ($start -lt 0) { return $null }
        $end = $lines.Count
        for ($j = $start + 1; $j -lt $lines.Count; $j++) {
            if ($lines[$j] -match '^###\s') { $end = $j; break }
        }
        return ($lines[$start..($end - 1)]) -join "`n"
    }
}

Describe 'CLAUDE.md carries the independent-review step' {
    BeforeAll {
        $script:ClaudeText = Get-Content -LiteralPath $script:ClaudeMd -Raw
    }

    It 'has a dedicated independent code review section' {
        $script:ClaudeText | Should -Match '(?im)^##\s.*Independent\s+Code\s+Review'
    }

    It 'states the invariant as reviewer-is-not-the-authoring-model' {
        $script:ClaudeText | Should -Match '(?i)did\s+not\s+write\s+(it|the\s+code)'
        $script:ClaudeText | Should -Match '(?i)different\s+model\s+than\s+the\s+authoring\s+model|different\s+model\s+from\s+the\s+authoring\s+model'
    }

    It 'names Copilot review as one way to satisfy the invariant, not the only one' {
        $script:ClaudeText | Should -Match '(?i)Copilot\s+review\s+is\s+one\s+way|one\s+way\s+of\s+satisfying'
    }

    It 'fires the substitution both when Copilot is unavailable and inside Claude Code' {
        $script:ClaudeText | Should -Match '(?i)Copilot\s+review\s+is\s+(not\s+available|unavailable)'
        $script:ClaudeText | Should -Match '(?i)(inside|within|running\s+in)\s+Claude\s+Code'
    }

    It 'grants explicit permission to skip the Copilot-specific mechanics' {
        $script:ClaudeText | Should -Match '(?i)skip\s+the\s+Copilot'
        $script:ClaudeText | Should -Match 'dev-loop\.agent\.md'
    }

    It 'documents the requested_reviewers detection call' {
        $script:ClaudeText | Should -Match 'requested_reviewers'
    }
}

Describe 'dev-loop.agent.md Phase 6 independence gate allows a different model' {
    BeforeAll {
        $script:Phase6 = Get-PhaseSection -Path $script:DevLoop -Phase '6'
    }

    It 'has a Phase 6 section' {
        $script:Phase6 | Should -Not -BeNullOrEmpty
    }

    It 'does not read as give-up inside Claude Code' {
        $script:Phase6 | Should -Match '(?i)Claude\s+Code'
        $script:Phase6 | Should -Match '(?i)different\s+(Anthropic\s+)?model'
    }

    It 'still keeps stop-and-re-run as the last resort only' {
        $script:Phase6 | Should -Match '(?i)only\s+(when|if)\s+.*no\s+model'
    }
}

Describe 'dev-loop.agent.md Phase 7 detects an unregistered Copilot request' {
    BeforeAll {
        $script:Phase7 = Get-PhaseSection -Path $script:DevLoop -Phase '7'
    }

    It 'has a Phase 7 section' {
        $script:Phase7 | Should -Not -BeNullOrEmpty
    }

    It 'confirms the reviewer registered via requested_reviewers instead of polling forever' {
        $script:Phase7 | Should -Match 'requested_reviewers'
        $script:Phase7 | Should -Match '(?i)empty'
    }

    It 'falls through to a different-model reviewer when Copilot is not enabled' {
        $script:Phase7 | Should -Match '(?i)different\s+(Anthropic\s+)?model'
    }

    It 'marks the Copilot GraphQL/polling mechanics as Copilot transport only' {
        $script:Phase7 | Should -Match '(?i)resolveReviewThread'
        $script:Phase7 | Should -Match '(?i)transport'
    }

    It 'states exit criteria in invariant terms rather than naming only Copilot' {
        $script:Phase7 | Should -Match '(?i)Exit\s+criteria.*'
        $script:Phase7 | Should -Match '(?i)independent\s+review'
    }
}

Describe 'dev-loop.agent.md Phase 8 merge precondition uses the invariant' {
    BeforeAll {
        $script:Phase8 = Get-PhaseSection -Path $script:DevLoop -Phase '8'
    }

    It 'has a Phase 8 section' {
        $script:Phase8 | Should -Not -BeNullOrEmpty
    }

    It 'requires an independent review rather than a Copilot review specifically' {
        $script:Phase8 | Should -Match '(?i)independent\s+review'
        $script:Phase8 | Should -Not -Match '(?i)latest\s+Copilot\s+review\s+introduced\s+zero\s+new\s+threads'
    }
}

Describe 'copilot-instructions.md merge step stays in sync' {
    BeforeAll {
        $script:CopilotText = Get-Content -LiteralPath $script:CopilotIns -Raw
    }

    It 'no longer names Copilot review as the sole merge precondition' {
        $script:CopilotText | Should -Not -Match '(?i)latest\s+Copilot\s+review\s+introduced\s+zero\s+new\s+threads'
    }

    It 'states the merge precondition in invariant terms' {
        $script:CopilotText | Should -Match '(?i)independent\s+review'
    }

    It 'points back to the CLAUDE.md independent-review section' {
        $script:CopilotText | Should -Match '(?i)CLAUDE\.md'
    }
}

Describe 'the phase label reads as Independent Review across all three files' {
    It 'dev-loop.agent.md no longer labels Phase 7 as Copilot Review' {
        $text = Get-Content -LiteralPath $script:DevLoop -Raw
        $text | Should -Not -Match 'PR\+Copilot Review\+Dry Run'
        $text | Should -Match '(?i)###\s+Phase\s+7\s+--\s+PR\s+\+\s+Independent\s+Review'
    }

    It 'CLAUDE.md loop diagram uses the Independent Review label' {
        $text = Get-Content -LiteralPath $script:ClaudeMd -Raw
        $text | Should -Not -Match 'PR\+Copilot Review\+Dry Run'
        $text | Should -Match 'PR\+Independent Review\+Dry Run'
    }

    It 'copilot-instructions.md loop diagram uses the Independent Review label' {
        $text = Get-Content -LiteralPath $script:CopilotIns -Raw
        $text | Should -Not -Match 'PR\+Copilot Review\+Dry Run'
        $text | Should -Match 'PR\+Independent Review\+Dry Run'
    }
}
