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
        $script:ClaudeText | Should -Match '(?i)one\s+way\s+of\s+satisfying'
        $script:ClaudeText | Should -Match '(?i)not\s+the\s+only\s+transport|not\s+the\s+requirement\s+itself'
    }

    It 'fires the substitution both when Copilot is unavailable and inside Claude Code' {
        $script:ClaudeText | Should -Match '(?i)Copilot\s+review\s+is\s+(not\s+available|unavailable)'
        $script:ClaudeText | Should -Match '(?i)(inside|within|running\s+in)\s+Claude\s+Code'
    }

    It 'grants explicit permission to skip the Copilot-specific mechanics' {
        $script:ClaudeText | Should -Match '(?i)skip\s+the\s+Copilot'
        $script:ClaudeText | Should -Match 'dev-loop\.agent\.md'
    }

    It 'lists the model override inside the what-must-still-happen checklist' {
        # The checklist reads as complete ('exactly what those steps exist to
        # produce'), so anything absent from it is silently skippable. The
        # override is the one item that stops self-review, so it belongs here
        # and not only in the paragraph above.
        $script:ClaudeText | Should -Match '(?i)-\s+it\s+ran\s+under\s+an\s+explicit\s+model\s+override'
        # The bullet must stand on its own. A positional pointer would rot the
        # moment the section is reordered -- the same failure this file guards
        # against for the skip-permission paragraph.
        $script:ClaudeText | Should -Not -Match '(?i)per\s+the\s+paragraph\s+above'
    }

    It 'names the trigger for the skip permission instead of a bare pronoun' {
        # A pronoun ('In that case') silently detaches from its antecedent the
        # moment a paragraph is inserted above it, which is exactly what
        # happened once the enforcement caveat landed in between.
        $script:ClaudeText | Should -Match '(?i)When\s+the\s+substitution\s+rule\s+applies,\s+\*\*you\s+may\s+skip'
        $script:ClaudeText | Should -Not -Match '(?i)In\s+that\s+case,\s+\*\*you\s+may\s+skip'
    }

    It 'documents the requested_reviewers detection call' {
        $script:ClaudeText | Should -Match 'requested_reviewers'
    }

    It 'requires an explicit model override so the reviewer cannot inherit the author model' {
        $script:ClaudeText | Should -Match '(?i)explicit\s+model\s+override'
        $script:ClaudeText | Should -Match '(?i)inherits?\s+the\s+authoring\s+model'
    }

    It 'requires recording which model actually ran the review' {
        $script:ClaudeText | Should -Match '(?i)record\s+which\s+model'
    }

    It 'keeps a last-resort escape when no other model exists' {
        $script:ClaudeText | Should -Match '(?i)no\s+model\s+other\s+than\s+the\s+authoring\s+one'
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
        # Anchor to the exit-criteria paragraph itself -- 'independent review'
        # appears earlier in Phase 7, so an unscoped match would pass even if
        # this line still demanded a Copilot review.
        $exit = [regex]::Match($script:Phase7, '(?is)\*\*Exit\s+criteria:\*\*.*?(?:(?:\r?\n){2}|\s*$)').Value
        $exit | Should -Not -BeNullOrEmpty
        $exit | Should -Match '(?i)independent\s+review'
        $exit | Should -Not -Match '(?i)latest\s+Copilot\s+review'
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

    It 'qualifies thread resolution as Copilot-transport-only so it is not vacuously required' {
        $script:Phase8 | Should -Match '(?i)review\s+threads\s+resolved\s+\*\*when\s+the\s+review'
    }
}

Describe 'dev-loop-phase-gate skill stays in sync with the invariant' {
    BeforeAll {
        $script:GateSkill = Join-Path $script:RepoRoot '.github/skills/dev-loop-phase-gate/SKILL.md'
        $script:GateText  = Get-Content -LiteralPath $script:GateSkill -Raw
    }

    It 'labels the Phase 7 checklist as Independent Review' {
        $script:GateText | Should -Match '(?i)After\s+Phase\s+7\s+\(PR\s+\+\s+Independent\s+Review\)'
    }

    It 'no longer requires a Copilot review specifically' {
        $script:GateText | Should -Not -Match '(?i)Latest\s+Copilot\s+review\s+introduced\s+zero\s+new\s+threads'
    }

    It 'checks the invariant and the recorded reviewing model' {
        $script:GateText | Should -Match '(?i)not\*{0,2}\s+the\s+authoring\s+model'
        $script:GateText | Should -Match '(?i)reviewing\s+model\s+is\s+recorded'
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
