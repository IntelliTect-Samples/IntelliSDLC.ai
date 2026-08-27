#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the HAR reference catalogue and the two-control scrub
# (issue #255). Delegates the runtime behavior to the zero-dep Node tests and
# asserts exit code 0, then checks that SKILL.md actually documents the
# convention the tooling enforces -- a gate nobody can find is not a gate.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/api-wrapper-scaffold/scripts'
    $script:Skill      = Join-Path $script:RepoRoot '.github/skills/api-wrapper-scaffold/SKILL.md'
    $script:SkillText  = Get-Content -LiteralPath $script:Skill -Raw

    function Invoke-NodeTest {
        param([string]$FileName, [string]$SuccessPattern)
        $testJs = Join-Path $script:ScriptsDir $FileName
        Test-Path -LiteralPath $testJs | Should -BeTrue -Because "$FileName must live at the canonical path"

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match $SuccessPattern
    }
}

Describe 'Operator profile (.har-profile.json)' {
    It 'all behavioral assertions pass' {
        Invoke-NodeTest -FileName 'har-profile.test.js' -SuccessPattern 'All har-profile tests passed'
    }
}

Describe 'Literal-value scrubbing' {
    It 'unit assertions pass' {
        Invoke-NodeTest -FileName 'har-literals.test.js' -SuccessPattern 'All har-literals tests passed'
    }

    It 'end-to-end scrub assertions pass' {
        Invoke-NodeTest -FileName 'literal-scrub.test.js' -SuccessPattern 'All literal-scrub tests passed'
    }
}

Describe 'HAR reference catalogue tooling' {
    It 'extractor and verifier assertions pass' {
        Invoke-NodeTest -FileName 'har-reference.test.js' -SuccessPattern 'All har-reference tests passed'
    }

    It 'ships both scripts at the canonical path' {
        foreach ($name in 'har-profile.js', 'har-literals.js', 'har-secrets.js',
                          'extract-har-reference.js', 'verify-har-reference.js') {
            Test-Path -LiteralPath (Join-Path $script:ScriptsDir $name) |
                Should -BeTrue -Because "$name is referenced by SKILL.md"
        }
    }

    It 'every script parses' {
        foreach ($name in 'har-profile.js', 'har-literals.js', 'har-secrets.js',
                          'extract-har-reference.js', 'verify-har-reference.js') {
            & node --check (Join-Path $script:ScriptsDir $name) 2>&1 | Out-Null
            $LASTEXITCODE | Should -Be 0 -Because "$name must parse"
        }
    }
}

Describe 'SKILL.md documents the convention the tooling enforces' {
    It 'has a HAR Reference Catalogue phase' {
        $script:SkillText | Should -Match '### Phase 3\.5 -- HAR Reference Catalogue'
    }

    It 'specifies the directory and filename convention' {
        $script:SkillText | Should -Match 'docs/har-reference/'
        $script:SkillText | Should -Match '<provider>-<action>-<yyyy-MM-dd>\.har'
    }

    It 'states the catalogue-row rule -- what you did is not recoverable from the file' {
        $script:SkillText | Should -Match 'add the catalogue row'
        $script:SkillText | Should -Match 'What you did to provoke it is not'
    }

    It 'states that request bodies are never truncated' {
        $script:SkillText | Should -Match 'Request bodies are NEVER truncated'
    }

    It 'states that the artifact is verified, not the report of it' {
        $script:SkillText | Should -Match 'Verify the artifact, not the report of it'
    }

    It 'frames scrubbing as two controls, not one' {
        $script:SkillText | Should -Match 'Scrubbing is two controls, not one'
        $script:SkillText | Should -Match 'key-name scrubbing can only ever redact a value whose\s+name somebody anticipated'
    }

    It 'forbids defaulting or committing the literals' {
        $script:SkillText | Should -Match 'Never default or commit the literals'
        $script:SkillText | Should -Match '\.har-profile\.json'
    }

    It 'exempts placeholders from over-redaction' {
        $script:SkillText | Should -Match 'Do not over-redact placeholders'
    }

    It 'no longer advertises the retired --salt flag' {
        $script:SkillText | Should -Not -Match '--salt'
    }
}
