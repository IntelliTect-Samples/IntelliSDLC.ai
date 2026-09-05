#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests pinning issue #435 -- trimming a
# raw capture to its API traffic WITHOUT scrubbing it. Pester is the only suite
# CI runs, so a Node test with no wrapper here is a test that never runs on a
# pull request.
#
#   har-trim.test.js   the trim command: it never touches the input, never
#                      overwrites an output, never writes an empty capture, and
#                      never drops an entry carrying a request body.
#
# The Describe blocks below cover what the Node suite cannot state as cleanly:
# that the classifier really is shared rather than duplicated, and that SKILL.md
# documents the rule the tooling enforces -- a gate nobody can find is not a gate.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:HarDir     = Join-Path $script:ScriptsDir 'har'
    $script:Skill      = Join-Path $script:RepoRoot '.github/skills/web-api-discovery/SKILL.md'
    $script:SkillText  = Get-Content -LiteralPath $script:Skill -Raw
}

Describe 'trimming a raw capture to its API traffic' {
    It 'runs har/har-trim.test.js and all of its behavioral assertions pass' {
        $testJs = Join-Path $script:ScriptsDir 'har/har-trim.test.js'
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All har-trim tests passed'
    }

    It 'ships <Name> at the canonical path, and it parses' -ForEach @(
        @{ Name = 'har/trim-har-capture.js' }
        @{ Name = 'har/har-entry-class.js' }
    ) {
        $script = Join-Path $script:ScriptsDir $Name
        Test-Path -LiteralPath $script | Should -BeTrue
        & node --check $script 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }
}

Describe 'the classifier is shared, not duplicated' {
    It 'both commands import har-entry-class.js rather than carrying their own copy' {
        # Two implementations that agree today are how a filter and the thing it
        # feeds drift into disagreeing about what a beacon is. This is the whole
        # reason the module exists.
        foreach ($name in 'har/extract-har-reference.js', 'har/trim-har-capture.js') {
            $text = Get-Content -LiteralPath (Join-Path $script:ScriptsDir $name) -Raw
            $text | Should -Match 'har-entry-class' -Because "$name must import the shared classifier"
        }
    }

    It 'neither command defines its own category list' {
        # A second KEPT_CATEGORIES anywhere is the drift starting.
        foreach ($name in 'har/extract-har-reference.js', 'har/trim-har-capture.js') {
            $text = Get-Content -LiteralPath (Join-Path $script:ScriptsDir $name) -Raw
            $text | Should -Not -Match "const KEPT_CATEGORIES\s*=" `
                -Because "$name must take the categories from har-entry-class.js"
        }
    }
}

Describe 'SKILL.md documents what the tooling enforces' {
    It 'names <Needle>' -ForEach @(
        @{ Needle = 'trim-har-capture.js' }
        @{ Needle = 'har-entry-class.js' }
        @{ Needle = 'Trim raws, never references' }
    ) {
        $script:SkillText | Should -Match ([regex]::Escape($Needle))
    }
}
