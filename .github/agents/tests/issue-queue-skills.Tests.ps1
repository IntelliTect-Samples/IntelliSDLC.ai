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
    # `blocked` instead of `hold`, or the wrong claim label, would silently
    # dispatch held or already-claimed work. The legacy claim label stays
    # excluded too, so a repository mid-migration never dispatches claimed work.
    It 'has a Step 1 fenced command block that runs gh issue list' {
        $script:query | Should -Not -BeNullOrEmpty
    }

    It 'restricts that command to open issues' {
        $script:query | Should -Match '--state open'
    }

    It 'passes exactly the operative search: not held, not claimed (current or legacy label), not blocked, oldest first' {
        $script:search | Should -BeExactly '-label:hold -label:lifecycle/active -label:in-progress -is:blocked sort:created-asc'
    }

    It 'launches sessions through the existing launcher rather than a new script' {
        Get-SkillSection -Body $script:body -Heading 'Step 6' | Should -Match 'Start-IssueAgent\.ps1'
    }
}

# Issue #517: the queue uses the Kubernetes label convention, ranked in a fixed
# order (not alphabetically), and still reads the legacy names so no queue is
# empty while a repository migrates. The rank map is EXECUTED, not grepped.
Describe '/next-issue ranks by the Kubernetes priority labels, in fixed order' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:step1 = [string](Get-SkillSection -Body $script:body -Heading 'Step 1')
        $script:rankBlock = @(Get-FencedBlocks -Text $script:step1 | Where-Object { $_ -match '\$rank\s*=' })[0]
        if ($script:rankBlock) { . ([scriptblock]::Create($script:rankBlock)) }
    }

    It 'defines the rank map in a Step 1 command block' {
        $script:rankBlock | Should -Not -BeNullOrEmpty
    }

    It 'ranks <label> as P<n>' -ForEach @(
        @{ label = 'priority/critical-urgent'; n = 0 }
        @{ label = 'priority/important-soon'; n = 1 }
        @{ label = 'priority/important-longterm'; n = 2 }
        @{ label = 'priority/backlog'; n = 3 }
        @{ label = 'priority/awaiting-more-evidence'; n = 4 }
    ) {
        $rank[$label] | Should -Be $n
        $canonical[$n] | Should -BeExactly $label
    }

    It 'still reads the legacy form <label> as P<n>' -ForEach @(
        @{ label = 'priority-0'; n = 0 }; @{ label = 'priority-1'; n = 1 }
        @{ label = 'priority-2'; n = 2 }; @{ label = 'priority-3'; n = 3 }
        @{ label = 'priority: 0'; n = 0 }; @{ label = 'priority: 1'; n = 1 }
        @{ label = 'priority: 2'; n = 2 }; @{ label = 'priority: 3'; n = 3 }
    ) {
        $rank[$label] | Should -Be $n
    }

    It 'does not treat a non-priority label as a priority' {
        foreach ($l in 'hold', 'lifecycle/active', 'area/har', 'bug', 'priority') { $rank.ContainsKey($l) | Should -BeFalse }
    }
}

Describe '/next-issue selection contract (continued)' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:step1 = Get-SkillSection -Body $script:body -Heading 'Step 1'
    }

    It 'names the canonical claim label lifecycle/active in Step 1' {
        $script:step1 | Should -Match 'lifecycle/active'
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
        # Step 1's rank map, which every Step 2 filter below depends on.
        $step1 = [string](Get-SkillSection -Body $script:body -Heading 'Step 1')
        $rankBlock = @(Get-FencedBlocks -Text $step1 | Where-Object { $_ -match '\$rank\s*=' })[0]
        if ($rankBlock) { . ([scriptblock]::Create($rankBlock)) }
        $script:unprioritizedFilter = @($script:blocks | Where-Object { $_ -match '\$unprioritized\s*=' })[0]
        $script:legacyFilter = @($script:blocks | Where-Object { $_ -match '\$toMigrate\s*=' })[0]
        $script:open = @(
            [pscustomobject]@{ number = 1; labels = @([pscustomobject]@{ name = 'priority/important-soon' }) }
            [pscustomobject]@{ number = 2; labels = @([pscustomobject]@{ name = 'bug' }) }
            [pscustomobject]@{ number = 3; labels = @([pscustomobject]@{ name = 'priority: 2' }, [pscustomobject]@{ name = 'area:har' }) }
            [pscustomobject]@{ number = 4; labels = @([pscustomobject]@{ name = 'priority-1' }) }
            [pscustomobject]@{ number = 5; labels = @([pscustomobject]@{ name = 'priority/backlog' }, [pscustomobject]@{ name = 'area/har' }) }
            [pscustomobject]@{ number = 6; labels = @([pscustomobject]@{ name = 'in-progress' }, [pscustomobject]@{ name = 'priority/backlog' }) }
        )
    }

    It 'is Step 2 -- triage comes before the pick list' {
        $script:step2 | Should -Match '(?m)^## Step 2 -- Triage'
    }

    It 'fetches open issues that are not held' {
        $script:unprioritizedSearch | Should -Not -BeNullOrEmpty
        $script:unprioritizedSearch | Should -Match '-label:hold\b'
    }

    # Executed against fixtures: only an issue with no priority label in ANY
    # form -- canonical or legacy -- is unprioritized. A legacy-labelled issue
    # is prioritized (and reported "to migrate"), never re-triaged from scratch.
    It 'treats only an issue with no priority label, in any form, as unprioritized' {
        $script:unprioritizedFilter | Should -Not -BeNullOrEmpty
        $open = $script:open
        . ([scriptblock]::Create($script:unprioritizedFilter))
        @($unprioritized.number) | Should -Be @(2)
    }

    It 'reports every issue carrying a legacy label as "to migrate"' {
        $script:legacyFilter | Should -Not -BeNullOrEmpty
        $open = $script:open
        . ([scriptblock]::Create($script:legacyFilter))
        @($toMigrate.number | Sort-Object) | Should -Be @(3, 4, 6)
        $script:step2 | Should -Match '(?i)to migrate'
    }

    It 'migrates legacy labels only with the owner''s confirmation, renaming a label in place when it can' {
        $script:step2 | Should -Match '(?is)only (after|with) the owner.{0,20}confirm'
        @($script:blocks | Where-Object { $_ -match 'gh label edit\s' -and $_ -match '--name' }).Count | Should -BeGreaterThan 0
    }

    It 'maps each legacy label to its canonical name' {
        $mapBlock = @($script:blocks | Where-Object { $_ -match 'function Get-CanonicalLabel' })[0]
        $mapBlock | Should -Not -BeNullOrEmpty
        . ([scriptblock]::Create($mapBlock))
        Get-CanonicalLabel 'priority-0' | Should -BeExactly 'priority/critical-urgent'
        Get-CanonicalLabel 'priority: 3' | Should -BeExactly 'priority/backlog'
        Get-CanonicalLabel 'in-progress' | Should -BeExactly 'lifecycle/active'
        Get-CanonicalLabel 'area:har' | Should -BeExactly 'area/har'
        Get-CanonicalLabel 'area: some thing' | Should -BeExactly 'area/some thing'
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

    # PR #513 review, finding 1 (Critical). Real claim and release comments are
    # prose PLUS a marker, so a rule that ignored only marker-only comments
    # flagged every claimed issue as "changed". The filter is executed here
    # against the real comment shapes, not read as prose.
    Context 'the changed-since filter, executed against real comment shapes' {
        BeforeAll {
            $filterBlock = @($script:blocks | Where-Object { $_ -match '\$ignore\s*=' })[0]
            $script:ignore = if ($filterBlock -match "\`$ignore\s*=\s*'([^']+)'") { $Matches[1] }
            $script:claimComment = "Claimed by ``some session`` on branch ``feat/1-x`` at 2026-01-01T00:00:00Z.`n`n" +
                '<!-- claim: session="some session" session_id="0000" host="PC" branch="feat/1-x" -->'
            $script:releaseComment = "Released by ``some session``: lost claim race.`n" +
                '<!-- release: session="some session" session_id="0000" reason="lost claim race" -->'
            $script:priorityComment = "Priority confirmed as P1 (priority/important-soon): still blocks the release.`n" +
                '<!-- priority: label="priority/important-soon" -->'
            $script:scopeComment = 'Scope change: this now also has to cover the second provider.'
            $script:changedFilter = @($script:blocks | Where-Object { $_ -match '\$ignore\s*=' })[0]

            # One page of the graphql search, shaped as `--paginate --slurp` returns it.
            function New-ChangedFixture {
                param([string]$Label, [object[]]$Comments, [string]$LabeledAt = '2026-01-01T00:00:00Z')
                $issue = @{
                    number = 7; title = 't'; lastEditedAt = $null
                    labels = @{ nodes = @(@{ name = $Label }) }
                    timelineItems = @{ nodes = @(@{ createdAt = $LabeledAt; label = @{ name = $Label } }) }
                    comments = @{ nodes = @($Comments) }
                }
                return (ConvertTo-Json -Depth 10 -InputObject @(@{ data = @{ search = @{ nodes = @($issue) } } }))
            }
        }

        # #517: repositories were relabelled in place, but the priority markers
        # already written in comments still name the OLD label. The latest
        # decision is a legacy-named marker, after the label event; mapping it
        # through the rank map is what keeps the issue from being re-flagged.
        It 'maps a legacy-named priority marker to the current label: a confirmed issue is not flagged' {
            $json = New-ChangedFixture -Label 'priority/important-soon' -Comments @(
                @{ createdAt = '2026-01-02T00:00:00Z'; lastEditedAt = $null; body = 'note, before the confirmation' }
                @{ createdAt = '2026-01-03T00:00:00Z'; lastEditedAt = $null; body = "Confirmed.`n<!-- priority: label=`"priority-1`" -->" }
            )
            $out = @(. ([scriptblock]::Create($script:changedFilter)))
            $out.Count | Should -Be 0 -Because 'the legacy marker is the latest decision for the same priority'
        }

        It 'still flags a scope comment made after the latest decision' {
            $json = New-ChangedFixture -Label 'priority/important-soon' -Comments @(
                @{ createdAt = '2026-01-03T00:00:00Z'; lastEditedAt = $null; body = "Confirmed.`n<!-- priority: label=`"priority-1`" -->" }
                @{ createdAt = '2026-01-04T00:00:00Z'; lastEditedAt = $null; body = 'Scope change.' }
            )
            $out = @(. ([scriptblock]::Create($script:changedFilter)))
            $out.Count | Should -Be 1
            $out[0].Priority | Should -BeExactly 'priority/important-soon'
        }

        It 'does not take a marker for a DIFFERENT priority as this priority''s decision' {
            $json = New-ChangedFixture -Label 'priority/important-soon' -Comments @(
                @{ createdAt = '2026-01-02T00:00:00Z'; lastEditedAt = $null; body = 'Scope change.' }
                @{ createdAt = '2026-01-03T00:00:00Z'; lastEditedAt = $null; body = "Old decision.`n<!-- priority: label=`"priority-3`" -->" }
            )
            $out = @(. ([scriptblock]::Create($script:changedFilter)))
            $out.Count | Should -Be 1 -Because 'a P3 marker says nothing about when P1 was decided'
        }

        It 'defines the ignore pattern in a Step 2 command block' {
            $script:ignore | Should -Not -BeNullOrEmpty
        }

        It 'ignores a claim comment that is prose plus a marker' {
            $script:claimComment | Should -Match $script:ignore
        }

        It 'ignores a release comment that is prose plus a marker' {
            $script:releaseComment | Should -Match $script:ignore
        }

        It 'ignores the priority decision comment itself' {
            $script:priorityComment | Should -Match $script:ignore
        }

        It 'does NOT ignore an ordinary comment that changes scope' {
            $script:scopeComment | Should -Not -Match $script:ignore
        }
    }

    It 'records each decision with a priority marker, adding the new label before removing the old one' {
        $edit = @($script:blocks | Where-Object { $_ -match 'gh issue edit' })[0]
        $edit | Should -Not -BeNullOrEmpty
        $add = $edit.IndexOf('--add-label'); $remove = $edit.IndexOf('--remove-label')
        $add | Should -BeGreaterOrEqual 0
        $remove | Should -BeGreaterThan $add -Because 'the issue must never be left without a priority, even for a moment'
        $script:step2 | Should -Match '<!-- priority: label='
    }

    It 'says removing an absent old priority label is a harmless no-op' {
        $script:step2 | Should -Match '(?i)no-op'
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

    It 're-ranks what triage relabelled before building the table' {
        $script:step3 | Should -Match '(?i)re-rank'
    }

    It 're-checks that a pick still carries a priority label before claiming it' {
        # Scoped to the re-check sentence itself: "priority label" also appears
        # in the sentence after it, which a proximity match would accept.
        $recheck = if ($script:step4 -match '(?s)re-check each pick is ([^.]*)\.') { $Matches[1] }
        $recheck | Should -Not -BeNullOrEmpty
        $recheck | Should -Match '(?i)carries a priority label'
    }

    It 'never claims or dispatches an unprioritized issue' {
        Get-SkillSection -Body $script:body -Heading 'Never' |
            Should -Match '(?i)claim or dispatch an unprioritized issue'
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

# Owner requirement on #510: a claim carries the session ID, so a crashed or
# quiet session can be resumed, or at least its transcript loaded. The ID comes
# from the harness's own substitution; nothing may guess it.
Describe 'Claims carry the session ID' {
    BeforeAll {
        $script:nextBody = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:wrapBody = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/wrap-up/SKILL.md')).Body
        $script:step3 = [string](Get-SkillSection -Body $script:nextBody -Heading 'Step 3')
        $script:step4 = [string](Get-SkillSection -Body $script:nextBody -Heading 'Step 4')
        # Lazy to the first `-->` on the line: the placeholders themselves
        # (`<session name>`) contain `>`, so a `[^>]*` class would never reach it.
        $script:claimMarker = @([regex]::Matches($script:step4, '<!-- claim:.*?-->') | ForEach-Object Value)[0]
        $ci = Get-Content -Raw -LiteralPath (Join-Path $script:repoRoot '.github/copilot-instructions.md')
        $script:claimsRule = [string]([regex]::Match([string](Get-SkillSection -Body $ci -Heading 'Issue Queue'), '(?ms)^### Claims\b.*?(?=^### |\z)').Value)
    }

    # The harness replaces EVERY occurrence of the substitution token, so a
    # second mention (say, in a sentence explaining the fallback) would be
    # rewritten into nonsense. Exactly one per skill; everything else refers
    # to it in words.
    It '<_> reads the session ID from the harness substitution exactly once' -ForEach @('next-issue', 'wrap-up') {
        $b = if ($_ -eq 'next-issue') { $script:nextBody } else { $script:wrapBody }
        [regex]::Matches($b, '\$\{CLAUDE_SESSION_ID\}').Count | Should -Be 1
        $b | Should -Match '(?i)session_id="unknown"' -Because 'when the harness supplies no ID the claim says so; it is never guessed'
    }

    It 'writes session_id and host into the claim marker' {
        $script:claimMarker | Should -Match 'session_id="'
        $script:claimMarker | Should -Match 'host="'
    }

    It 'shows the session ID, a ready-to-run resume command, and where the transcript lives' {
        $script:step3 | Should -Match '(?i)session id'
        $script:step3 | Should -Match 'claude --resume <'
        $script:step3 | Should -Match '\.claude/projects/'
        $script:step3 | Should -Match '(?i)another machine'
    }

    It 'a stale takeover quotes the previous holder''s session ID so its transcript can be loaded first' {
        $script:step4 | Should -Match '(?is)stale takeover.{0,300}session ID'
        $script:step4 | Should -Match '(?i)transcript'
    }

    It 'the shared claim protocol carries session_id and host in its marker' {
        $script:claimsRule | Should -Match '<!-- claim: session="<name>" session_id="<id>" host="<host>" branch="<branch>" -->'
    }

    It '/wrap-up puts the session ID in its release marker and its hand-off' {
        $step3 = [string](Get-SkillSection -Body $script:wrapBody -Heading 'Step 3')
        $step3 | Should -Match '<!-- release: session="[^"]*" session_id="'
        $step3 | Should -Match '(?i)\*\*Session:\*\*.{0,120}session ID'
    }
}

Describe 'The shared "Next" rule never dispatches an unprioritized issue' {
    It 'says unprioritized issues are triaged and never dispatched until they carry a priority' {
        $ci = Get-Content -Raw -LiteralPath (Join-Path $script:repoRoot '.github/copilot-instructions.md')
        $next = [regex]::Match([string](Get-SkillSection -Body $ci -Heading 'Issue Queue'), '(?ms)^\*\*Next\*\*.*?(?=\r?\n\r?\n)').Value
        $next | Should -Match '(?i)never dispatched until'
        $next | Should -Not -Match '(?i)ranks\s+last' -Because 'that reads as though an unprioritized issue is eventually dispatched'
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
        $script:filing | Should -Match '`priority/'
        $script:filing | Should -Match '`hold`'
        $script:filing | Should -Match '`area/<name>`'
        $script:filing | Should -Match '(?i)blocked.by'
        $script:filing | Should -Match '(?i)reason'
        $script:filing | Should -Match '<!-- priority: label="priority/' -Because 'the marker names the canonical label'
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

# Issue #517: the shared contract names the Kubernetes labels, carries the
# spoken P0-P4 aliases the owner uses, and the claim label is lifecycle/active
# everywhere a claim is made, listed, or released.
Describe 'The shared label contract is the Kubernetes convention, with P0-P4 aliases' {
    BeforeAll {
        $ci = Get-Content -Raw -LiteralPath (Join-Path $script:repoRoot '.github/copilot-instructions.md')
        $script:queue = [string](Get-SkillSection -Body $ci -Heading 'Issue Queue')
        $script:labels = [regex]::Match($script:queue, '(?ms)^### Labels\b.*?(?=^### |\z)').Value
        $script:claims = [regex]::Match($script:queue, '(?ms)^### Claims\b.*?(?=^### |\z)').Value
        $script:next = [regex]::Match($script:queue, '(?ms)^\*\*Next\*\*.*?(?=\r?\n\r?\n)').Value
        $script:legacy = [regex]::Match($script:queue, '(?ms)^### Legacy label names\b.*?(?=^### |\z)').Value
    }

    It 'maps P<n> to <label> in the label table' -ForEach @(
        @{ n = 0; label = 'priority/critical-urgent' }
        @{ n = 1; label = 'priority/important-soon' }
        @{ n = 2; label = 'priority/important-longterm' }
        @{ n = 3; label = 'priority/backlog' }
        @{ n = 4; label = 'priority/awaiting-more-evidence' }
    ) {
        # One table row names both the label and its spoken alias.
        $script:labels | Should -Match "(?m)^\|[^\n]*``$([regex]::Escape($label))``[^\n]*\*\*P$n\*\*"
    }

    It 'tells agents to translate the spoken aliases both ways' {
        $script:labels | Should -Match '(?i)translate'
        $script:labels | Should -Match 'P1 \(priority/important-soon\)'
    }

    It 'names lifecycle/active and the area/ labels, and keeps hold' {
        $script:labels | Should -Match '`lifecycle/active`'
        $script:labels | Should -Match '`area/<name>`'
        $script:labels | Should -Match '`hold`'
    }

    It 'orders Next by the fixed P0-P4 order, not alphabetically' {
        $script:next | Should -Match '(?i)P0.{0,40}P4'
        $script:next | Should -Match '`lifecycle/active`'
    }

    It 'claims and releases with lifecycle/active' {
        $script:claims | Should -Match '(?s)\*\*Claim\*\*.{0,200}`lifecycle/active`'
        $script:claims | Should -Match '(?s)\*\*Release\*\*.{0,200}`lifecycle/active`'
        $script:claims | Should -Not -Match '`in-progress`' -Because 'the legacy name belongs only in the legacy section'
    }

    It 'has a legacy-names section that reads old names and migrates only with the owner''s confirmation' {
        $script:legacy | Should -Not -BeNullOrEmpty
        foreach ($old in 'priority-N', 'priority: N', 'in-progress', 'area:<name>') { $script:legacy | Should -Match ([regex]::Escape($old)) }
        $script:legacy | Should -Match '(?i)confirm'
    }
}

Describe 'The skills claim and release with lifecycle/active' {
    BeforeAll {
        $script:nextBody = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
        $script:wrapBody = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/wrap-up/SKILL.md')).Body
    }

    It '/next-issue adds lifecycle/active when it claims' {
        $claimEdit = @(Get-FencedBlocks -Text ([string](Get-SkillSection -Body $script:nextBody -Heading 'Step 4')) |
                Where-Object { $_ -match 'gh issue edit' })[0]
        $claimEdit | Should -Match '--add-label lifecycle/active'
    }

    It '/wrap-up releases by removing lifecycle/active' {
        Get-SkillSection -Body $script:wrapBody -Heading 'Step 3' | Should -Match '(?s)remove.{0,40}`lifecycle/active`'
    }

    It '/wrap-up inventories claims under lifecycle/active' {
        @(Get-FencedBlocks -Text ([string](Get-SkillSection -Body $script:wrapBody -Heading 'Step 1')) |
                Where-Object { $_ -match 'gh issue list' -and $_ -match 'lifecycle/active' }).Count | Should -BeGreaterThan 0
    }

    It 'unattended, /next-issue migrates no labels' {
        Get-SkillSection -Body $script:nextBody -Heading 'When no user is present' | Should -Match '(?i)migrates nothing'
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
