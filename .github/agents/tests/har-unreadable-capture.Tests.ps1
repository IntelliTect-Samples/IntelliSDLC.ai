#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests pinning issue #423 -- a capture
# the tooling cannot read must FAIL, never report as a capture containing
# nothing. Pester is the only suite CI runs, so a Node test with no wrapper
# here is a test that never runs on a pull request.
#
#   har-unreadable-capture.test.js   the read boundary: a file that is not a
#                                    HAR is refused by name and exits non-zero,
#                                    a genuinely empty capture still reads as
#                                    zero entries, and a mitmproxy capture
#                                    reads its full entry count.
#
# The Describe blocks below cover what the Node suite cannot state as cleanly:
# that the recognition really is shared rather than re-spelled per script, and
# that SKILL.md documents the rule the tooling enforces -- a gate nobody can
# find is not a gate.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:HarDir     = Join-Path $script:ScriptsDir 'har'
    $script:Skill      = Join-Path $script:RepoRoot '.github/skills/web-api-discovery/SKILL.md'
    $script:SkillText  = Get-Content -LiteralPath $script:Skill -Raw
}

Describe 'a capture the tooling cannot read' {
    It 'runs har/har-unreadable-capture.test.js and all of its behavioral assertions pass' {
        $testJs = Join-Path $script:ScriptsDir 'har/har-unreadable-capture.test.js'
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-unreadable-capture tests passed'
    }

    It 'ships the shared reader at the canonical path, and it parses' {
        $module = Join-Path $script:HarDir 'har-document.js'
        Test-Path -LiteralPath $module | Should -BeTrue
        & node --check $module 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'ships the mitmproxy fixture the positive case is pinned against' {
        # #423 was filed believing mitmproxy exports were an unreadable second
        # format. They are standard HAR 1.2. This fixture is the counter-example
        # that keeps a Playwright-only assumption from returning.
        $fixture = Join-Path $PSScriptRoot 'fixtures/har/mitmproxy-pretty.har'
        Test-Path -LiteralPath $fixture | Should -BeTrue
        $doc = Get-Content -LiteralPath $fixture -Raw | ConvertFrom-Json
        $doc.log.creator.name | Should -Be 'mitmproxy'
        $doc.log.entries.Count | Should -Be 3
    }

    It 'leaves no stage folding a missing entries list into an empty one' {
        # The exact expression this issue exists to remove. One survivor is
        # enough to put the silent zero back, in the stage nobody re-read.
        # Comment lines are skipped: the fix's own commentary quotes the
        # expression to explain why it is gone, and a scan that could not tell
        # a warning from the thing it warns about would make the warning
        # unwritable.
        $offenders = @()
        foreach ($file in Get-ChildItem -LiteralPath $script:HarDir -Filter '*.js' -File) {
            if ($file.Name -like '*.test.js') { continue }
            foreach ($line in (Get-Content -LiteralPath $file.FullName)) {
                if ($line -match '^\s*(//|\*|/\*)') { continue }
                if ($line -match 'log\s*&&\s*[\w.]*log\.entries\s*\)\s*\|\|\s*\[\]') {
                    $offenders += "$($file.Name): $($line.Trim())"
                }
            }
        }
        $offenders | Should -BeNullOrEmpty
    }

    It 'documents the rule in SKILL.md, where an operator can find it' {
        $script:SkillText | Should -Match 'capture the tooling cannot read'
    }
}
