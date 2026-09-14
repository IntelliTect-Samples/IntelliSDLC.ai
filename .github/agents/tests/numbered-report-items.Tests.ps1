#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for numbering the items in an end-of-turn report (issue #509).
#
# A user answering a report could not point at one item ("re 3"), and open
# questions were lost across a multi-turn iteration because they were
# unnumbered bullets. The owner-approved scheme: a section letter plus a number
# (R Result, A Assumption, N Needs you); N numbers are stable for the whole
# session -- never reused, re-listed while open, marked resolved when answered;
# R and A restart each reply; no turn.item numbering; other lists get plain
# numbers. These tests pin each clause, scoped to the section that states it,
# so a revert of either file fails here.

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
}

Describe 'Task Complete Summary Format -- numbered report items (issue #509)' {

    It 'the canonical section exists' {
        $script:Format | Should -Not -BeNullOrEmpty
    }

    It 'carries a Needs you field in its field table' {
        $script:Format | Should -Match '(?m)^\|\s*\*\*Needs you\*\*\s*\|'
    }

    It 'holds the numbering rule as a subsection of the format, not elsewhere' {
        $script:Numbering | Should -Not -BeNullOrEmpty
        $script:Format    | Should -Match '(?m)^#{6}\s+Numbering\s+Report\s+Items'
    }

    It 'maps each summary section to its letter prefix' {
        $script:Numbering | Should -Match '`R`\s*--\s*\*\*Result'
        $script:Numbering | Should -Match '`A`\s*--\s*\*\*Assumptions'
        $script:Numbering | Should -Match '`N`\s*--\s*\*\*Needs you'
    }

    It 'keeps Needs you numbers stable for the whole session and never reuses one' {
        $script:Numbering | Should -Match '(?i)stable for the whole session'
        $script:Numbering | Should -Match '(?i)never reused'
    }

    It 're-lists open items under the same number, including ones a reply left unanswered' {
        $script:Numbering | Should -Match '(?i)re-list(?:s|ed)? every (?:still-)?open item under its same number'
        $script:Numbering | Should -Match '(?i)left unanswered'
    }

    It 'marks an answered item resolved rather than renumbering' {
        $script:Numbering | Should -Match '(?i)marked \*\*resolved\*\*[^.]*never renumbered'
    }

    It 'restarts Result and Assumption numbers each reply' {
        $script:Numbering | Should -Match '(?i)`R` and `A` numbers restart at 1 in each reply'
    }

    It 'forbids turn.item numbering' {
        $script:Numbering | Should -Match '(?i)no `X\.Y`'
    }

    It 'gives other lists plain numbers' {
        $script:Numbering | Should -Match '(?i)other lists[^.]*plain numbers'
    }

    It 'shows the scheme in the worked example' {
        $script:Format | Should -Match '\*\*Assumptions\*\*:\s*\r?\n\s*-\s*\*\*A1\.\*\*'
        $script:Format | Should -Match '\*\*Needs you\*\*:\s*\r?\n\s*-\s*\*\*N1\.\*\*'
    }
}

Describe 'CLAUDE.md mirrors the numbering rule (issue #509)' {

    It 'the Task Complete Summaries section exists' {
        $script:ClaudeSec | Should -Not -BeNullOrEmpty
    }

    It 'lists the Needs you field' {
        $script:ClaudeSec | Should -Match '(?m)^-\s+\*\*Needs you\*\*\s+--'
    }

    It 'states the letter prefixes and the session-stable Needs you numbers' {
        $script:ClaudeSec | Should -Match '`R1`.*`A1`.*`N1`'
        $script:ClaudeSec | Should -Match '(?i)stable for the whole session'
        $script:ClaudeSec | Should -Match '(?i)restart[^.]*each reply'
    }

    It 'points at the canonical Numbering Report Items rule' {
        $script:ClaudeSec | Should -Match '\*\*Numbering Report Items\*\*'
    }
}
