#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for numbering the items in an end-of-turn report
# (issues #509, #523).
#
# A user answering a report could not point at one item ("re 3"), and open
# questions were lost across a multi-turn iteration because they were
# unnumbered bullets. The owner-approved scheme: a section letter plus a number
# (R Results, A Assumptions, N Needs you); N numbers are stable for the whole
# session -- never reused, re-listed while open, marked resolved when answered;
# R and A restart in each end-of-turn report; no report.item numbering; other
# lists get plain numbers. The Results list is distinct from the single-item
# Result display, which is not R-numbered. These tests pin each clause, scoped
# to the section that states it, so a revert of either file fails here.
#
# #523: the rule was attached to the task-complete summary format, so it was
# silently dropped when a harness-level output style imposed its own report
# layout -- a layout that lives in personal machine configuration and cannot be
# reached from any repository. The rule now binds the report itself, names the
# imposed-layout case, and requires an honest note when a layout cannot carry
# the numbers.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ClaudeMd   = Join-Path $script:RepoRoot 'CLAUDE.md'
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

    $script:Format    = Get-Section -Path $script:CopilotIns -HeadingPattern 'Task\s+Complete\s+Summary\s+Format'
    $script:Numbering = Get-Section -Path $script:CopilotIns -HeadingPattern 'Numbering\s+Report\s+Items'
    $script:ClaudeSec = Get-Section -Path $script:ClaudeMd   -HeadingPattern 'Task\s+Complete\s+Summaries'

    # One field-table row, by field name.
    function Get-FieldRow {
        param([string]$Section, [string]$Field)
        $m = [regex]::Match($Section, "(?m)^\|\s*\*\*$Field\*\*\s*\|[^\r\n]*")
        if ($m.Success) { return $m.Value } else { return $null }
    }
}

Describe 'Task Complete Summary Format -- numbered report items (issue #509)' {

    It 'the canonical section exists' {
        $script:Format | Should -Not -BeNullOrEmpty
    }

    It 'carries a Needs you field in its field table' {
        Get-FieldRow -Section $script:Format -Field 'Needs you' | Should -Not -BeNullOrEmpty
    }

    It 'carries a Results list field, distinct from the Result display, numbered R1, R2' {
        $row = Get-FieldRow -Section $script:Format -Field 'Results'
        $row | Should -Not -BeNullOrEmpty
        $row | Should -Match '`R1`'
        $row | Should -Match '(?i)not the \*\*Result display\*\*'
    }

    It 'points the Assumptions field at the numbering rule, as Needs you does' {
        Get-FieldRow -Section $script:Format -Field 'Assumptions' | Should -Match '\*\*Numbering Report Items\*\*'
        Get-FieldRow -Section $script:Format -Field 'Needs you'   | Should -Match '\*\*Numbering Report Items\*\*'
    }

    It 'holds the numbering rule as a subsection of the format, not elsewhere' {
        $script:Numbering | Should -Not -BeNullOrEmpty
        $script:Format    | Should -Match '(?m)^#{6}\s+Numbering\s+Report\s+Items'
    }

    It 'maps each summary section to its letter prefix' {
        $script:Numbering | Should -Match '`R`\s*--\s*\*\*Results'
        $script:Numbering | Should -Match '`A`\s*--\s*\*\*Assumptions'
        $script:Numbering | Should -Match '`N`\s*--\s*\*\*Needs you'
    }

    It 'excludes the Result display from R numbering' {
        $script:Numbering | Should -Match '(?i)\*\*Result display\*\*[^.]*is not `R`-numbered'
    }

    It 'keeps Needs you numbers stable for the whole session and never reuses one' {
        $script:Numbering | Should -Match '(?i)stable for the whole session'
        $script:Numbering | Should -Match '(?i)never reused'
    }

    It 're-lists open items under the same number in every report, including ones left unanswered' {
        $script:Numbering | Should -Match '(?i)every end-of-turn report re-lists every open item under its same number'
        $script:Numbering | Should -Match '(?i)left unanswered'
    }

    It 'marks an answered item resolved rather than renumbering' {
        $script:Numbering | Should -Match '(?i)marked \*\*resolved\*\*[^.]*never renumbered'
    }

    It 'restarts Results and Assumptions numbers in each end-of-turn report' {
        $script:Numbering | Should -Match '(?i)`R` and `A` numbers restart at 1 in each end-of-turn report'
    }

    It 'uses the instructions'' term "end-of-turn report", not a bare "reply", for the agent''s output' {
        $script:Numbering | Should -Not -Match '(?i)\b(?:each|every|next|that) reply\b'
    }

    It 'forbids report.item numbering' {
        $script:Numbering | Should -Match '(?i)no `X\.Y`'
    }

    It 'gives other lists plain numbers' {
        $script:Numbering | Should -Match '(?i)other lists[^.]*plain numbers'
    }

    It 'shows R-, A- and N-numbered items in the worked example' {
        $script:Format | Should -Match '\*\*Results\*\*:\s*\r?\n\s*-\s*\*\*R1\.\*\*[^\r\n]*\r?\n\s*-\s*\*\*R2\.\*\*'
        $script:Format | Should -Match '\*\*Assumptions\*\*:\s*\r?\n\s*-\s*\*\*A1\.\*\*'
        $script:Format | Should -Match '\*\*Needs you\*\*:\s*\r?\n\s*-\s*\*\*N1\.\*\*'
    }
}

Describe 'Numbering survives an imposed report layout (issue #523)' {

    It 'binds the numbering to every end-of-turn report, not only a task-complete summary' {
        $script:Numbering | Should -Match '(?i)every end-of-turn report, not only'
        $script:Numbering | Should -Match '(?i)whatever[^.]*layout'
    }

    It 'names the harness-level sources of an imposed layout' {
        $script:Numbering | Should -Match '(?i)output style'
        $script:Numbering | Should -Match '(?i)persona'
        $script:Numbering | Should -Match '(?i)harness-level instruction'
    }

    It 'requires the letters to be carried into the imposed layout rather than dropped' {
        $script:Numbering | Should -Match '(?i)carries the numbers into it|carry the letters into'
    }

    It 'denies a bullet-list layout as an exemption' {
        $script:Numbering | Should -Match '(?i)bullet list is not an exemption'
    }

    It 'requires saying so in the report when a layout cannot carry the numbers' {
        $script:Numbering | Should -Match '(?i)cannot carry the numbers, say so in the\s+report'
        $script:Numbering | Should -Match '(?i)rather than silently\s+omitting'
    }

    It 'keeps the settled rules from issue #509 intact' {
        $script:Numbering | Should -Match '(?i)stable for the whole session'
        $script:Numbering | Should -Match '(?i)`R` and `A` numbers restart at 1 in each end-of-turn report'
        $script:Numbering | Should -Match '(?i)no `X\.Y`'
    }
}

Describe 'CLAUDE.md mirrors the numbering rule (issue #509)' {

    It 'the Task Complete Summaries section exists' {
        $script:ClaudeSec | Should -Not -BeNullOrEmpty
    }

    It 'lists the Needs you field' {
        $script:ClaudeSec | Should -Match '(?m)^-\s+\*\*Needs you\*\*\s+--'
    }

    It 'lists the Results field, distinct from the Result display' {
        $script:ClaudeSec | Should -Match '(?m)^-\s+\*\*Results\*\*\s+--[^\r\n]*\r?\n?[^-]*not the \*\*Result display\*\*'
    }

    It 'states the letter prefixes and the session-stable Needs you numbers' {
        $script:ClaudeSec | Should -Match '`R1`.*`A1`.*`N1`'
        $script:ClaudeSec | Should -Match '(?i)stable for the whole session'
        $script:ClaudeSec | Should -Match '(?i)restart at 1 in each end-of-turn report'
    }

    It 'states that the Result display is not numbered' {
        $script:ClaudeSec | Should -Match '(?i)\*\*Result display\*\* is not numbered'
    }

    It 'points at the canonical Numbering Report Items rule' {
        $script:ClaudeSec | Should -Match '\*\*Numbering Report Items\*\*'
    }

    It 'states that the numbering applies to every end-of-turn report (issue #523)' {
        $script:ClaudeSec | Should -Match '(?i)every end-of-turn report\*\*, not only'
    }

    It 'covers an imposed report layout and forbids dropping the numbers silently (issue #523)' {
        $script:ClaudeSec | Should -Match '(?i)output style'
        $script:ClaudeSec | Should -Match '(?i)carry the letters into that layout'
        $script:ClaudeSec | Should -Match '(?i)bullet list is not an\s+exemption'
        $script:ClaudeSec | Should -Match '(?i)say so in the\s+report rather than dropping them silently'
    }
}
