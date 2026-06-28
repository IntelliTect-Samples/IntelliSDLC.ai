#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for the code-review agent (issue #72).
#
# The code-review agent must be a thin orchestrator that delegates to
# the canonical code-review-workflow skill. These tests guard against
# the agent body drifting back into restating skill content.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:AgentPath  = Join-Path $script:RepoRoot '.github/agents/code-review.agent.md'
    $script:SkillPath  = Join-Path $script:RepoRoot '.github/skills/code-review-workflow/SKILL.md'
    $script:AgentText  = Get-Content -LiteralPath $script:AgentPath -Raw
    $script:AgentLines = (Get-Content -LiteralPath $script:AgentPath).Count
    # Isolate the YAML frontmatter block (between the first two `---` fences) so
    # frontmatter assertions do not match incidental body content.
    $script:AgentFrontmatter = if ($script:AgentText -match '(?s)^---\r?\n(.*?)\r?\n---') { $Matches[1] } else { '' }
    $script:SkillText  = Get-Content -LiteralPath $script:SkillPath  -Raw
}

Describe 'code-review.agent.md is a thin orchestrator' {

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:AgentPath | Should -BeTrue
    }

    It 'preserves frontmatter (name, tools, description)' {
        $script:AgentText | Should -Match '(?m)^name:\s*"Code Review"'
        $script:AgentText | Should -Match '(?m)^tools:\s*\['
        $script:AgentText | Should -Match '(?m)^description:\s*"'
    }

    It 'does not freeze the review to a pinned model version' {
        # The review must run on the latest non-author model, not a frozen
        # version. Neither a `model:` pin nor the previously frozen version may
        # appear in the agent's YAML frontmatter.
        $script:AgentFrontmatter | Should -Not -Match '(?m)^model:\s*'
        $script:AgentFrontmatter | Should -Not -Match '(?i)gpt-4\.1'
    }

    It 'instructs selecting the latest model and emitting a Model selection block' {
        $script:AgentText | Should -Match '(?i)latest'
        $script:AgentText | Should -Match '(?i)Model selection'
    }

    It 'is collapsed to a thin orchestrator (15-60 lines)' {
        $script:AgentLines | Should -BeGreaterOrEqual 15
        $script:AgentLines | Should -BeLessOrEqual 60
    }

    It 'links explicitly to the code-review-workflow SKILL.md' {
        $script:AgentText | Should -Match '\.\./skills/code-review-workflow/SKILL\.md'
    }

    It 'instructs invocation of the code-review-workflow skill' {
        $script:AgentText | Should -Match '(?i)code-review-workflow'
        $script:AgentText | Should -Match '(?i)invoke'
    }

    It 'names the independent-reviewer role and different-model framing' {
        $script:AgentText | Should -Match '(?i)independent'
        $script:AgentText | Should -Match '(?i)different model'
    }

    It 'mentions fixing Critical and Important findings (Mission handoff)' {
        $script:AgentText | Should -Match '(?i)Critical'
        $script:AgentText | Should -Match '(?i)Important'
    }
}

Describe 'code-review-workflow SKILL.md remains the canonical source' {

    It 'contains the four Mission bullets: Review / Report / Fix / Hand off' {
        $script:SkillText | Should -Match '(?m)^\d+\.\s+\*\*Review\*\*'
        $script:SkillText | Should -Match '(?m)^\d+\.\s+\*\*Report\*\*'
        $script:SkillText | Should -Match '(?m)^\d+\.\s+\*\*Fix\*\*'
        $script:SkillText | Should -Match '(?m)^\d+\.\s+\*\*Hand off\*\*'
    }

    It 'retains the Static Analysis step' {
        $script:SkillText | Should -Match '(?i)Step 0: Run Static Analysis'
    }

    It 'retains severity-tier handling (Critical / Important / Suggestions)' {
        $script:SkillText | Should -Match '\*\*Critical\*\*'
        $script:SkillText | Should -Match '\*\*Important\*\*'
        $script:SkillText | Should -Match '\*\*Suggestions\*\*'
    }

    It 'defines a Model Selection rubric (independence gate + latest/recency + per-vendor block)' {
        $script:SkillText | Should -Match '(?im)^#+\s*Model Selection'
        $script:SkillText | Should -Match '(?i)independence'
        $script:SkillText | Should -Match '(?i)latest'
        $script:SkillText | Should -Match '(?i)Model selection'   # the per-vendor output block
        $script:SkillText | Should -Match '(?i)vendor'
    }

    It 'defines a Triage & Convergence protocol' {
        $script:SkillText | Should -Match '(?im)^#+\s*Triage'
        $script:SkillText | Should -Match '(?i)consolidate'
        $script:SkillText | Should -Match '(?i)accept'
        $script:SkillText | Should -Match '(?i)reject'
        $script:SkillText | Should -Match '(?i)rationale'
        $script:SkillText | Should -Match '(?i)behavior-first'
        $script:SkillText | Should -Match '(?i)convergence'
    }

    It 'routes accepted high-effort work to issues rather than inline fixes' {
        $script:SkillText | Should -Match '(?i)high-effort|high-impact'
        $script:SkillText | Should -Match '(?i)issue'
    }
}
