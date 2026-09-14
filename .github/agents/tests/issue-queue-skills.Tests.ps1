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
}

Describe '/next-issue selection contract' {
    BeforeAll {
        $script:body = (Get-SkillFrontmatter -Path (Join-Path $script:repoRoot '.claude/skills/next-issue/SKILL.md')).Body
    }

    # The labels are the only shared contract between the skill, the claim
    # protocol in the instructions, and /wrap-up. A skill that excluded
    # `blocked` instead of `hold`, or claimed with `claimed` instead of
    # `in-progress`, would silently dispatch held or already-claimed work.
    It 'excludes the <_> label from selection' -ForEach @('hold', 'in-progress') {
        $script:body | Should -Match ([regex]::Escape("-label:$_"))
    }

    It 'excludes issues with an open blocked-by dependency' {
        $script:body | Should -Match ([regex]::Escape('-is:blocked'))
    }

    It 'ranks by the priority-0..priority-3 labels' {
        foreach ($p in 0..3) { $script:body | Should -Match "priority-$p" }
    }

    It 'launches sessions through the existing launcher rather than a new script' {
        $script:body | Should -Match 'Start-IssueAgent\.ps1'
    }
}
