#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Structural tests for the api-wrapper-scaffold agent (issue #34).
#
# These tests do not exercise the agent's runtime behavior (it is invoked
# by humans / Copilot, not a script). They verify the agent definition file
# and template-folder layout stay internally consistent so a consumer
# always finds the assets the agent claims exist.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:AgentPath = Join-Path $script:RepoRoot '.github/agents/api-wrapper-scaffold.agent.md'
    $script:TemplateRoot = Join-Path $script:RepoRoot 'templates/api-wrapper-scaffold'
    $script:AgentText = Get-Content -LiteralPath $script:AgentPath -Raw
}

Describe 'api-wrapper-scaffold.agent.md' {

    It 'exists at the canonical path' {
        Test-Path -LiteralPath $script:AgentPath | Should -BeTrue
    }

    It 'has YAML frontmatter with name and description' {
        $script:AgentText | Should -Match '(?m)^---\s*$'
        $script:AgentText | Should -Match '(?m)^name:\s*"[^"]+"'
        $script:AgentText | Should -Match '(?m)^description:\s*"'
    }

    It 'declares the 11 ordered phases' {
        1..11 | ForEach-Object {
            $script:AgentText | Should -Match "Phase $_ --"
        }
    }

    It 'enumerates every supported auth classification' {
        $expected = @(
            'cookie',
            'cookie\+csrf',
            'bearer',
            'sso-google',
            'sso-microsoft',
            'sso-facebook',
            'oauth2-pkce'
        )
        foreach ($auth in $expected) {
            $script:AgentText | Should -Match $auth
        }
    }

    It 'requires user confirmation before any filesystem mutation' {
        $script:AgentText | Should -Match '(?i)Hard Gate'
        $script:AgentText | Should -Match '(?i)Confirmed (the target URL|a project name)'
    }

    It 'references the evidence-capture skill (Phase 5b)' {
        $script:AgentText | Should -Match 'evidence-capture'
        $script:AgentText | Should -Match 'Phase 5b'
    }
}

Describe 'templates/api-wrapper-scaffold/' {

    It 'has the documented subdirectory layout' {
        foreach ($d in 'scripts', 'csharp', 'powershell', 'config') {
            Test-Path -LiteralPath (Join-Path $script:TemplateRoot $d) -PathType Container | Should -BeTrue
        }
    }

    It 'has a README documenting tokens and layout' {
        $readmePath = Join-Path $script:TemplateRoot 'README.md'
        Test-Path -LiteralPath $readmePath | Should -BeTrue
        $readme = Get-Content -LiteralPath $readmePath -Raw
        # Every token the README documents must appear in the agent's
        # Phase 6 / Phase 9 description, since the agent is the canonical
        # consumer of the templates.
        $tokenMatches = [regex]::Matches($readme, '\{\{(\w+)\}\}')
        $tokenMatches.Count | Should -BeGreaterThan 0
        foreach ($m in $tokenMatches) {
            $token = $m.Groups[1].Value
            # ProjectSalt and NowIso are runtime-only and may legitimately
            # only appear in the README, so skip those.
            if ($token -in @('ProjectSalt', 'NowIso')) { continue }
            $script:AgentText | Should -Match $token
        }
    }
}
