# Issue #498 / #500: the /next-issue and /wrap-up Claude Code skills.
#
# Claude Code turns .claude/skills/<name>/SKILL.md into the slash command
# /<name> only when the file opens with YAML frontmatter carrying a `name`
# that matches its directory and a `description` (the text the model uses to
# decide when the skill applies). A skill that fails either is silently not a
# command -- nothing errors -- so these are pinned against the parsed
# frontmatter, not by searching the file for a string.
#
# The skills ship to every consumer, so they must also stay project-agnostic
# and must never name a repository: owner/repo comes from the git remote.
#
# The procedure assertions are SCOPED: each reads one section, or one fenced
# command block inside a section, never "anywhere in the file". A qualifier
# that appears only in prose is not part of the command the model runs, so a
# whole-file match would pass for a skill whose actual query is wrong.

BeforeDiscovery {
    $script:skillNames = @('next-issue', 'wrap-up')
}

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path

    function Get-SkillFrontmatter {
        param([Parameter(Mandatory)][string]$Path)
        $lines = Get-Content -LiteralPath $Path
        if ($lines.Count -lt 3 -or $lines[0].TrimEnd() -ne '---') { return $null }
        $end = -1
        for ($i = 1; $i -lt $lines.Count; $i++) {
            if ($lines[$i].TrimEnd() -eq '---') { $end = $i; break }
        }
        if ($end -lt 0) { return $null }
        $map = @{}
        foreach ($line in $lines[1..($end - 1)]) {
            if ($line -match '^([A-Za-z][\w-]*):\s*(.*)$') {
                $map[$Matches[1]] = $Matches[2].Trim().Trim("'").Trim('"')
            }
        }
        return [pscustomobject]@{ Fields = $map; Body = ($lines[($end + 1)..($lines.Count - 1)] -join "`n") }
    }

    # Both helpers are regex-based with no loop control flow: Pester 6 fails a
    # whole block when it sees a `break`/`continue` it cannot attribute to a
    # loop, and a helper invoked from a pipeline inside BeforeAll tripped it.

    function Get-SkillSection {
        # The text of the level-2 section whose heading starts with $Heading,
        # up to (not including) the next level-2 heading. $null when absent.
        param([Parameter(Mandatory)][string]$Body, [Parameter(Mandatory)][string]$Heading)
        $m = [regex]::Match($Body, "(?ms)^## $([regex]::Escape($Heading))\b.*?(?=^## |\z)")
        if ($m.Success) { return $m.Value } else { return $null }
    }

    function Get-FencedBlocks {
        # The contents of every fenced code block in $Text, in order.
        param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
        return @([regex]::Matches($Text, '(?ms)^[ \t]*```[^\n]*\n(.*?)^[ \t]*```') |
                ForEach-Object { $_.Groups[1].Value })
    }
}

Describe 'Queue skill <_>' -ForEach $script:skillNames {
    BeforeAll {
        $script:name = $_
        $script:path = Join-Path $script:repoRoot ".claude/skills/$($script:name)/SKILL.md"
        $script:fm = if (Test-Path -LiteralPath $script:path) { Get-SkillFrontmatter -Path $script:path }
    }

    It 'exists where Claude Code discovers project skills' {
        Test-Path -LiteralPath $script:path | Should -BeTrue
    }

    It 'opens with parseable YAML frontmatter' {
        $script:fm | Should -Not -BeNullOrEmpty -Because 'without frontmatter Claude Code does not register the command'
    }

    It 'names itself after its directory, so the command is /<_>' {
        $script:fm.Fields['name'] | Should -BeExactly $script:name
    }

    It 'carries a description the model can route on' {
        $script:fm.Fields['description'] | Should -Not -BeNullOrEmpty
        $script:fm.Fields['description'].Length | Should -BeGreaterThan 40
    }

    It 'never hardcodes an owner/repo -- it resolves it from the git remote' {
        $script:fm.Body | Should -Match 'git remote get-url origin'
        $script:fm.Body | Should -Not -Match 'github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+' `
            -Because 'a shipped skill naming a repository would act on that repository from every consumer'
    }

    It 'cites no issue or PR number -- in a consumer repository it would point at something else' {
        $script:fm.Body | Should -Not -Match '(?<![\w&])#\d+\b' `
            -Because 'upstream issue numbers mean nothing (or the wrong thing) in every repository this skill ships to'
    }
}

Describe '/next-issue selection contract' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:step1 = Get-SkillSection -Body $script:body -Heading 'Step 1'
        # The operative query: the fenced block in Step 1 that runs `gh issue list`.
        $script:query = @(Get-FencedBlocks -Text ([string]$script:step1) |
                Where-Object { $_ -match 'gh issue list' })[0]
        $script:search = if ($script:query -match '--search\s+"([^"]*)"') { $Matches[1] }
    }

    # The labels are the only shared contract between the skill, the claim
    # protocol in the instructions, and /wrap-up. A query that excluded
    # `blocked` instead of `hold`, or `claimed` instead of `in-progress`,
    # would silently dispatch held or already-claimed work.
    It 'has a Step 1 fenced command block that runs gh issue list' {
        $script:query | Should -Not -BeNullOrEmpty
    }

    It 'restricts that command to open issues' {
        $script:query | Should -Match '--state open'
    }

    It 'passes exactly the operative search: not held, not claimed, not blocked, oldest first' {
        $script:search | Should -BeExactly '-label:hold -label:in-progress -is:blocked sort:created-asc'
    }

    It 'ranks by the priority-0..priority-3 labels in Step 1' {
        foreach ($p in 0..3) { $script:step1 | Should -Match "priority-$p" }
    }

    It 'launches sessions through the existing launcher rather than a new script' {
        Get-SkillSection -Body $script:body -Heading 'Step 6' | Should -Match 'Start-IssueAgent\.ps1'
    }
}

# Issue #510: the owner picks from a list; triage happens before the list is
# shown, so a new or changed issue gets a priority decision the next time
# anyone asks what is next -- not whenever someone happens to notice.
Describe '/next-issue triages before it lists' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:step2 = [string](Get-SkillSection -Body $script:body -Heading 'Step 2')
        $script:blocks = @(Get-FencedBlocks -Text $script:step2)
        $script:unprioritized = @($script:blocks | Where-Object { $_ -match 'gh issue list' })[0]
        $script:unprioritizedSearch = if ($script:unprioritized -match '--search\s+"([^"]*)"') { $Matches[1] }
        $script:changedQuery = @($script:blocks | Where-Object { $_ -match 'graphql' })[0]
    }

    It 'is Step 2 -- triage comes before the pick list' {
        $script:step2 | Should -Match '(?m)^## Step 2 -- Triage'
    }

    It 'finds unprioritized issues with a search excluding every priority label and hold' {
        $script:unprioritizedSearch | Should -Not -BeNullOrEmpty
        foreach ($p in 0..3) { $script:unprioritizedSearch | Should -Match "-label:priority-$p\b" }
        $script:unprioritizedSearch | Should -Match '-label:hold\b'
    }

    It 'detects "changed since prioritized" from the label event against issue edits and comments' {
        $script:changedQuery | Should -Match 'LABELED_EVENT'
        $script:changedQuery | Should -Match 'lastEditedAt'
        $script:changedQuery | Should -Match 'comments'
    }

    It 'marks newly unblocked issues from the closed time of their blockers' {
        $script:step2 | Should -Match '(?i)newly unblocked'
        @($script:blocks | Where-Object { $_ -match 'dependencies/blocked_by' }).Count | Should -BeGreaterThan 0
    }

    It 'asks the owner to confirm or change a priority, and writes the reason comment' {
        $script:step2 | Should -Match '(?is)confirm.{0,40}or change'
        $script:step2 | Should -Match '(?i)reason'
    }
}

Describe '/next-issue lets the owner pick, and shows who holds what' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:step3 = [string](Get-SkillSection -Body $script:body -Heading 'Step 3')
        $script:step4 = [string](Get-SkillSection -Body $script:body -Heading 'Step 4')
    }

    It 'shows the top candidates, 5 by default' {
        $script:step3 | Should -Match '(?i)default \*\*5\*\*'
    }

    It 'asks through a multi-select choice prompt' {
        $script:step3 | Should -Match 'multiSelect'
    }

    It 'claims only the issues the owner picked' {
        $script:step4 | Should -Match '(?i)only the picked'
    }

    It 'lists every live claim with session, branch, claimed-at, last activity, and stale state' {
        foreach ($field in 'session', 'branch', 'claimed-at', 'last activity', 'stale') {
            $script:step3 | Should -Match "(?i)$([regex]::Escape($field))"
        }
        $script:step3 | Should -Match '<!-- claim:' -Because 'the view is read from the claim markers the protocol already writes'
    }
}

Describe '/next-issue when no user is present' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:unattended = [string](Get-SkillSection -Body $script:body -Heading 'When no user is present')
    }

    It 'has its own section' {
        $script:unattended | Should -Not -BeNullOrEmpty
    }

    It 'claims the top N instead of asking, and says so' {
        $script:unattended | Should -Match '(?i)claim the top'
        $script:unattended | Should -Match '(?i)say so'
    }

    It 'labels nothing, and lists triage findings under Needs you' {
        $script:unattended | Should -Match '(?i)labels nothing'
        $script:unattended | Should -Match '\*\*Needs you\*\*'
    }
}

Describe 'Issues arrive prioritized -- the filing rule' {
    BeforeAll {
        $read = { param($rel) Get-Content -Raw -LiteralPath (Join-Path $script:repoRoot $rel) }
        $script:queue = [string](Get-SkillSection -Body (& $read '.github/copilot-instructions.md') -Heading 'Issue Queue')
        $m = [regex]::Match($script:queue, '(?ms)^### Filing an issue\b.*?(?=^### |\z)')
        $script:filing = if ($m.Success) { $m.Value }
        $script:planStep = ([regex]::Match((& $read '.github/agents/plan.agent.md'), '(?m)^6\. \*\*Create GitHub issue\*\*.*$')).Value
        $script:devLoopFile = ([regex]::Match((& $read '.github/agents/dev-loop.agent.md'), '(?s)\*\*file issues\*\*.{0,200}')).Value
        $wrapBody = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/wrap-up/SKILL.md')).Body
        $script:wrapStep4 = [string](Get-SkillSection -Body $wrapBody -Heading 'Step 4')
    }

    It 'has a "Filing an issue" subsection in the Issue Queue section' {
        $script:filing | Should -Not -BeNullOrEmpty
    }

    It 'requires a priority or hold, an area label, blocked-by links, and a reason comment at creation' {
        $script:filing | Should -Match 'priority-N'
        $script:filing | Should -Match '`hold`'
        $script:filing | Should -Match 'area:'
        $script:filing | Should -Match '(?i)blocked.by'
        $script:filing | Should -Match '(?i)reason'
    }

    It '@plan applies it when it creates the issue' {
        $script:planStep | Should -Match 'Filing an issue'
    }

    It 'the dev loop applies it to the follow-up issues it files' {
        $script:devLoopFile | Should -Match 'Filing an issue'
    }

    It '/wrap-up applies it to loose ends' {
        $script:wrapStep4 | Should -Match 'Filing an issue'
    }
}

Describe '/wrap-up merges only on an authorization the instructions actually grant' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/wrap-up/SKILL.md')).Body
        $script:step2 = [string](Get-SkillSection -Body $script:body -Heading 'Step 2')
    }

    # Merge-without-asking is a property of the consuming repository's shared
    # instructions, and a repository whose instructions do not grant it must
    # still get a correct wrap-up. So Step 2 must CHECK for the grant, not
    # assert it -- and must say what to do when it is absent.
    It 'has a Step 2' {
        $script:step2 | Should -Not -BeNullOrEmpty
    }

    It 'does not assert that merging is pre-authorized as a fact' {
        $script:step2 | Should -Not -Match '(?i)merging a finished PR is\s+pre-authorized by' `
            -Because 'whether the instructions grant it varies by repository and by version'
    }

    It 'tells the session to check the shared instructions for the authorization' {
        $script:step2 | Should -Match '(?is)check.{0,120}instructions.{0,200}pre-authori[sz]'
    }

    It 'without the authorization, lists the PR under Needs you as ready to merge, with its evidence' {
        $script:step2 | Should -Match '(?is)\*\*Needs you\*\*.{0,200}ready to merge'
        $script:step2 | Should -Match '(?i)evidence'
    }

    It 'without the authorization, does not merge' {
        $script:step2 | Should -Match '(?i)do(es)? not merge'
    }
}
