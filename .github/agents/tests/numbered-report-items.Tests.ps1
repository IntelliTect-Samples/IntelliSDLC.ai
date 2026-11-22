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
#
# #604: numbered Needs-you items still arrived as a number plus a handle
# ("N4. #212 -- approve?"), and a re-listed one shrank to "N4 (unchanged)", so
# the owner had to scroll back, open the issue, or search to learn what was
# asked. Every N item must now stand on its own -- what is being decided and why
# it needs the user, the options, the recommendation, and how to answer -- and
# a re-listed item repeats all of it. Pinned in the canonical subsection, its
# pointers, the worked example, CLAUDE.md and the global floor.
#
# #606: the exact commands a report hands the owner arrived one block per
# command -- the desktop app's own default -- so the owner copied and pasted each
# one, and a failure part-way through went unnoticed. The preference had been
# saved only to per-project memory, so it never reached other repositories or
# machines. The global floor now says: all of them in one block, stop at the
# first failure, ask before each command when not all may be wanted, and launch
# an elevated part from inside the same block.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ClaudeMd   = Join-Path $script:RepoRoot 'CLAUDE.md'
    $script:CopilotIns = Join-Path $script:RepoRoot '.github/copilot-instructions.md'
    $script:GlobalIns  = Join-Path $script:RepoRoot 'GLOBAL-INSTRUCTIONS.md'

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
    $script:Standalone = Get-Section -Path $script:CopilotIns -HeadingPattern 'Self-Contained\s+Needs-You\s+Items'
    $script:GlobalRep  = Get-Section -Path $script:GlobalIns  -HeadingPattern 'Reporting'

    # One field-table row, by field name.
    function Get-FieldRow {
        param([string]$Section, [string]$Field)
        $m = [regex]::Match($Section, "(?m)^\|\s*\*\*$Field\*\*\s*\|[^\r\n]*")
        if ($m.Success) { return $m.Value } else { return $null }
    }

    # One top-level bullet of a markdown list, by its bold lead-in, up to the
    # next top-level bullet or blank line.
    function Get-Bullet {
        param([string]$Text, [string]$LeadIn)
        $m = [regex]::Match([string]$Text, "(?ms)^-\s+\*\*$LeadIn.*?(?=^-\s|^\s*$|\z)")
        if ($m.Success) { return $m.Value } else { return $null }
    }

    # The worked example's N1 item: from its marker up to the next field bullet.
    $script:ExampleN1 = ([regex]::Match([string]$script:Format, '(?s)-\s*\*\*N1\.\*\*.*?(?=\n\s*-\s*\*\*Evidence)')).Value
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

    It 'names the harness-level sources inside the sentence that imposes the obligation' {
        # Presence of the words is not the rule: they must appear in the clause
        # that says such a layout SUPPLIES a layout the letters go into. Text
        # that named the same sources to EXEMPT them would not match.
        # Anchored on the obligation itself, so a negation placed in front of
        # "When an output style ..." falls outside the span and fails here
        # rather than relying on a sibling assertion to catch it.
        $script:Numbering | Should -Match '(?is)carries the numbers into it\.\*\*\s+When an output style,[^.]*persona,[^.]*harness-level instruction\s+supplies its own report layout'
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

Describe 'The containing section does not re-narrow the scope (issue #523)' {

    It 'the task-complete format section says the numbering rule is scoped wider than itself' {
        $script:Format | Should -Match '(?is)scoped wider than this\s+section'
        $script:Format | Should -Match '(?is)binds every end-of-turn report, whatever the harness calls it'
    }

    It 'CLAUDE.md''s summaries section says the same before listing task_complete fields' {
        $script:ClaudeSec | Should -Match '(?is)scoped wider than the section\s+itself'
        $script:ClaudeSec | Should -Match '(?is)binds every end-of-turn report, whatever layout the harness imposes'
    }

    It 'bounds the cannot-carry escape hatch so it is not a routine exit' {
        $script:Numbering | Should -Match '(?is)near-never'
        $script:Numbering | Should -Match '(?is)reformat the item'
        $script:Numbering | Should -Match '(?is)merely makes the numbers inconvenient is not a layout that cannot\s+carry them'
    }

    It 'CLAUDE.md bounds the escape hatch too' {
        $script:ClaudeSec | Should -Match '(?is)near-never'
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
        $script:ClaudeSec | Should -Match '(?i)binds[\s*]*every end-of-turn report[\s*]*,?\s*not only'
    }

    It 'covers an imposed report layout and forbids dropping the numbers silently (issue #523)' {
        $script:ClaudeSec | Should -Match '(?i)output style'
        $script:ClaudeSec | Should -Match '(?i)carry the letters into that layout'
        $script:ClaudeSec | Should -Match '(?i)bullet list is not an\s+exemption'
        $script:ClaudeSec | Should -Match '(?i)say so in the\s+report rather than dropping them silently'
    }
}

Describe 'Every Needs-you item stands on its own (issue #604)' {

    BeforeAll {
        # The numbered list of what every item carries, up to the blank line
        # that ends it -- so a clause stated anywhere else does not count.
        $script:Carries = ([regex]::Match([string]$script:Standalone, '(?ms)^1\.\s+\*\*.*?(?=\n\s*\n)')).Value
        # The sentence that forbids the shortcuts.
        $script:Never = ([regex]::Match([string]$script:Standalone, '(?is)Never\s+write\s+.*?in\s+its\s+place\.')).Value
        # The section's fenced examples, in order: the handle-only item first,
        # then the self-contained one.
        $script:Examples = @([regex]::Matches([string]$script:Standalone, '(?ms)^```[^\n]*\n(.*?)^```') |
                ForEach-Object { $_.Groups[1].Value })
    }

    It 'is a subsection of the summary format, beside the numbering rule' {
        $script:Standalone | Should -Not -BeNullOrEmpty
        $script:Format     | Should -Match '(?m)^#{6}\s+Self-Contained\s+Needs-You\s+Items'
    }

    It 'requires that the user can decide from the item alone, without looking anything up' {
        $script:Standalone | Should -Match '(?is)decide\s+from\s+the\s+item\s+alone'
        $script:Standalone | Should -Match '(?is)scrolling\s+back'
        $script:Standalone | Should -Match '(?is)opening\s+an\s+issue'
        $script:Standalone | Should -Match '(?is)searching'
    }

    It 'says a number, an issue or PR reference, or a label is a handle, not context' {
        $script:Standalone | Should -Match '(?is)a\s+number,\s+an\s+issue\s+or\s+PR\s+reference,\s+a\s+short\s+label'
        $script:Standalone | Should -Match '(?is)a\s+handle\s+is\s+not\s+context'
    }

    It 'lets a link accompany the explanation but never replace it' {
        $script:Standalone | Should -Match '(?is)link\s+may\s+accompany\s+the\s+explanation,\s+but\s+it\s+never\s+replaces\s+it'
    }

    It 'lists what is being decided and why it needs the user, in plain words, first' {
        $script:Carries | Should -Match '(?is)\A1\.\s+\*\*What\s+is\s+being\s+decided,\s+and\s+why\s+it\s+needs\s+the\s+user\*\*,\s+in\s+plain\s+words'
    }

    It 'lists the options, each with what it does, and the exact command for an action the user takes' {
        $script:Carries | Should -Match '(?im)^2\.\s+\*\*The\s+options\*\*,\s+each\s+with\s+what\s+it\s+does'
        $script:Carries | Should -Match '(?is)the\s+user\s+must\s+take\s+themselves,\s+the\s+exact\s+command\s+or\s+steps'
    }

    It 'lists the recommendation and why' {
        $script:Carries | Should -Match '(?im)^3\.\s+\*\*The\s+recommendation\s+and\s+why\*\*'
    }

    It 'lists what the answer unblocks and how to answer' {
        $script:Carries | Should -Match '(?im)^4\.\s+\*\*What\s+the\s+answer\s+unblocks,\s+and\s+how\s+to\s+answer\*\*'
    }

    It 'requires a re-listed item to repeat its full explanation, every time' {
        $script:Standalone | Should -Match '(?is)\*\*A\s+re-listed\s+item\s+repeats\s+its\s+full\s+explanation,\s+every\s+time\.\*\*'
    }

    It 'forbids each shortcut by name' {
        $script:Never | Should -Not -BeNullOrEmpty
        $script:Never | Should -Match '"unchanged"'
        $script:Never | Should -Match '(?s)"as\s+explained\s+earlier"'
        $script:Never | Should -Match '(?s)"see\s+above"'
        $script:Never | Should -Match '(?s)the\s+number\s+plus\s+a\s+terse\s+label'
    }

    It 'asks for the shortest item that is still complete' {
        $script:Standalone | Should -Match '(?is)as\s+short\s+as\s+it\s+can\s+be\s+while\s+still\s+complete'
    }

    It 'binds every end-of-turn report, whatever layout the harness imposes' {
        $script:Standalone | Should -Match '(?is)binds\s+every\s+end-of-turn\s+report'
        $script:Standalone | Should -Match '(?is)whatever\s+layout\s+the\s+harness\s+imposes'
    }

    It 'contrasts a handle-only item with a self-contained one' {
        $script:Examples.Count | Should -BeGreaterOrEqual 2
        $script:Examples[0] | Should -Match '\*\*N\d+\.\*\*\s+#\d+\s+--'
        $script:Examples[1] | Should -Match 'Options:'
        $script:Examples[1] | Should -Match 'Recommend'
        $script:Examples[1] | Should -Match 'Reply\s+`N\d+:'
        $script:Examples[1] | Should -Match '(?s)`gh\s[^`]+`' -Because 'its action is one the user takes, so it carries the exact command'
    }
}

Describe 'The summary format points at the self-contained rule (issue #604)' {

    It 'the format preamble scopes this rule, too, wider than the section' {
        $script:Format | Should -Match '(?s)scoped\s+wider\s+than\s+this\s+section[^|]*?\*\*Self-Contained\s+Needs-You\s+Items\*\*'
    }

    It 'the Needs you field row points at the rule' {
        Get-FieldRow -Section $script:Format -Field 'Needs you' | Should -Match '\*\*Self-Contained Needs-You Items\*\*'
    }

    It 'the numbering rule says a re-listed item is written out in full' {
        $script:Numbering | Should -Match '(?is)re-listed\s+item\s+is\s+written\s+out\s+in\s+full'
        $script:Numbering | Should -Match '(?s)\*\*Self-Contained\s+Needs-You\s+Items\*\*'
    }

    It 'the worked example''s N1 stands on its own' {
        $script:ExampleN1 | Should -Not -BeNullOrEmpty
        $script:ExampleN1 | Should -Match 'Options:'
        $script:ExampleN1 | Should -Match 'Recommend'
        $script:ExampleN1 | Should -Match 'Reply\s+`N1:'
    }
}

Describe 'CLAUDE.md summarizes the self-contained rule (issue #604)' {

    BeforeAll {
        $script:ClaudeNeeds = Get-Bullet -Text $script:ClaudeSec -LeadIn 'Needs you'
    }

    It 'the Needs you bullet says what each item carries' {
        $script:ClaudeNeeds | Should -Match '(?is)self-contained'
        $script:ClaudeNeeds | Should -Match '(?is)what\s+is\s+being\s+decided\s+and\s+why\s+it\s+needs\s+the\s+user'
        $script:ClaudeNeeds | Should -Match '(?is)is\s+not\s+context'
        $script:ClaudeNeeds | Should -Match '(?is)the\s+options\s+and\s+what\s+each\s+does'
        $script:ClaudeNeeds | Should -Match '(?is)exact\s+command'
        $script:ClaudeNeeds | Should -Match '(?is)the\s+recommendation\s+and\s+why'
        $script:ClaudeNeeds | Should -Match '(?is)what\s+the\s+answer\s+unblocks\s+and\s+how\s+to\s+answer'
    }

    It 'says a re-listed item repeats its full explanation, and names the shortcuts' {
        $script:ClaudeSec | Should -Match '(?is)re-listed\s+item\s+repeats\s+its\s+full\s+explanation'
        $script:ClaudeSec | Should -Match '"unchanged"'
        $script:ClaudeSec | Should -Match '(?s)"see\s+above"'
    }

    It 'binds it to every end-of-turn report, and points at the canonical rule' {
        $script:ClaudeSec | Should -Match '(?is)Every\s+Needs-you\s+item\s+stands\s+on\s+its\s+own.{0,400}every\s+end-of-turn\s+report'
        $script:ClaudeSec | Should -Match '(?s)\*\*Self-Contained\s+Needs-You\s+Items\*\*'
    }
}

Describe 'The global floor carries the self-contained rule (issue #604)' {

    BeforeAll {
        $script:GlobalNeeds = Get-Bullet -Text $script:GlobalRep -LeadIn 'Every Needs-you item stands on its own'
    }

    It 'has a Reporting bullet saying every Needs-you item stands on its own' {
        $script:GlobalRep   | Should -Not -BeNullOrEmpty
        $script:GlobalNeeds | Should -Not -BeNullOrEmpty
    }

    It 'says what each item carries' {
        $script:GlobalNeeds | Should -Match '(?is)decide\s+from\s+the\s+item\s+alone'
        $script:GlobalNeeds | Should -Match '(?is)is\s+not\s+context'
        $script:GlobalNeeds | Should -Match '(?is)the\s+options\s+and\s+what\s+each\s+does'
        $script:GlobalNeeds | Should -Match '(?is)exact\s+command'
        $script:GlobalNeeds | Should -Match '(?is)recommendation\s+and\s+why'
        $script:GlobalNeeds | Should -Match '(?is)what\s+the\s+answer\s+unblocks\s+and\s+how\s+to\s+answer'
    }

    It 'requires a re-listed item to repeat its full explanation' {
        $script:GlobalNeeds | Should -Match '(?is)re-listed\s+item\s+repeats\s+its\s+full\s+explanation'
        $script:GlobalNeeds | Should -Match '"unchanged"'
    }
}

Describe 'The global floor gives commands to run in one block (issue #606)' {

    BeforeAll {
        $script:GlobalBlock = Get-Bullet -Text $script:GlobalRep -LeadIn 'Commands to run go in one block'
    }

    It 'has a Reporting bullet saying commands to run go in one block' {
        $script:GlobalRep   | Should -Not -BeNullOrEmpty
        $script:GlobalBlock | Should -Not -BeNullOrEmpty
    }

    It 'puts every command in one block the user pastes once, over a one-block-per-command default' {
        $script:GlobalBlock | Should -Match '(?is)more\s+than\s+one\s+command'
        $script:GlobalBlock | Should -Match '(?is)copy\s+once\s+and\s+paste\s+once'
        $script:GlobalBlock | Should -Match '(?is)one\s+block\s+per\s+command'
    }

    It 'makes the block stop at the first failure' {
        $script:GlobalBlock | Should -Match '(?is)stops?\s+at\s+the\s+first\s+failure'
    }

    It 'asks before each command when the user may not want them all' {
        $script:GlobalBlock | Should -Match '(?is)ask\s+before\s+each'
        $script:GlobalBlock | Should -Match 'Set-PSDebug -Step'
    }

    It 'launches an elevated part from inside the same block and says where to paste it' {
        $script:GlobalBlock | Should -Match '(?is)elevat'
        $script:GlobalBlock | Should -Match '-Verb RunAs'
        $script:GlobalBlock | Should -Match '(?is)which\s+window'
    }
}
