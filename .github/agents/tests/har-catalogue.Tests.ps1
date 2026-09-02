#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests that pin issue #379 -- the
# committed reference catalogue is STRUCTURED, so a row's claims can be checked
# against the file rather than against the row's own existence. Pester is the
# only suite CI runs, so a Node test with no wrapper here is a test that never
# runs on a pull request.
#
#   har-catalogue.test.js         measurement: a row's factual half computed
#                                 FROM the .har it names, including the
#                                 placeholder-is-not-a-body rule the falsifier
#                                 rests on.
#   har-catalogue-render.test.js  the README table is a rendering: idempotent,
#                                 deterministically ordered, and hand-written
#                                 prose outside the markers survives.
#   har-catalogue-verify.test.js  the guard: every declared fact recomputed,
#                                 coverage both ways, the request-side
#                                 falsifier, and the staleness check.
#
# The Describe blocks below cover what the Node suite cannot reach: the
# PowerShell half (ConvertFrom-HarCatalogue.ps1 and the format file), and
# whether SKILL.md documents the convention the tooling enforces -- a gate
# nobody can find is not a gate.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:ConvertPs1 = Join-Path $script:ScriptsDir 'capture/ConvertFrom-HarCatalogue.ps1'
    $script:FormatXml  = Join-Path $script:ScriptsDir 'capture/HarCapture.Format.ps1xml'
    $script:Skill      = Join-Path $script:RepoRoot '.github/skills/web-api-discovery/SKILL.md'
    $script:SkillText  = Get-Content -LiteralPath $script:Skill -Raw

    function New-Sandbox {
        $dir = Join-Path ([IO.Path]::GetTempPath()) ("har-catalogue-" + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        return $dir
    }
}

Describe 'the committed catalogue is structured and checkable' {
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'har/har-catalogue.test.js';        Expect = 'All har-catalogue tests passed' }
        @{ Name = 'har/har-catalogue-render.test.js'; Expect = 'All har-catalogue-render tests passed' }
        @{ Name = 'har/har-catalogue-verify.test.js'; Expect = 'All har-catalogue-verify tests passed' }
    ) {
        $testJs = Join-Path $script:ScriptsDir $Name
        Test-Path -LiteralPath $testJs | Should -BeTrue -Because "$Name must live at the canonical path"

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match $Expect
    }

    It 'ships <Name> at the canonical path, and it parses' -ForEach @(
        @{ Name = 'har/har-catalogue.js' }
        @{ Name = 'har/render-har-catalogue.js' }
        @{ Name = 'har/verify-har-catalogue.js' }
    ) {
        $script = Join-Path $script:ScriptsDir $Name
        Test-Path -LiteralPath $script | Should -BeTrue -Because "$Name is referenced by SKILL.md"
        & node --check $script 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }
}

Describe 'ConvertFrom-HarCatalogue.ps1 surfaces the measured half' {
    It 'is valid PowerShell (parses without syntax errors)' {
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $script:ConvertPs1, [ref]$null, [ref]$errors) | Out-Null
        @($errors).Count | Should -Be 0
    }

    It 'emits the measured fields, so a PowerShell caller can check a row too' {
        # The whole point of #379 is that a row carries facts a script can
        # compare against the artifact. A PowerShell surface that dropped them
        # would leave every PowerShell consumer back on the prose table.
        $sandbox = New-Sandbox
        try {
            $catalogue = Join-Path $sandbox 'catalogue.json'
            $row = [pscustomobject]@{
                Action              = 'create-post'
                Description         = 'Published one post with two people tagged'
                Provider            = 'example'
                Methods             = @('POST')
                Endpoints           = @('api.example.invalid/v1/posts')
                EntryCount          = 1
                RequestBodies       = 1
                RequestBytes        = 61
                ResponseBytes       = 2
                RequestBodiesAbsent = $null
                Status              = 'Exercised'
                HarFile             = 'example/example-create-post-2026-08-26.har'
                Related             = @(379)
                CapturedUtc         = '2026-08-26T00:00:00.000Z'
            }
            Set-Content -LiteralPath $catalogue -Value (ConvertTo-Json @($row) -Depth 6) -Encoding utf8

            $entries = @(& $script:ConvertPs1 -Path $catalogue)
            $entries.Count | Should -Be 1
            $entries[0].RequestBodies | Should -Be 1
            $entries[0].RequestBytes  | Should -Be 61
            $entries[0].ResponseBytes | Should -Be 2
            $entries[0].Provider      | Should -Be 'example'
            # @() around Related, so a single issue number does not arrive as a
            # scalar whose .Count is a character count.
            @($entries[0].Related).Count | Should -Be 1
        }
        finally { Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'keeps an unmeasured row NULL rather than coercing it to zero' {
        # A scaffold row describes a digest group; no reference has been
        # extracted for it. Rendering that as 0 would state "this reference has
        # no request bodies" about a reference that does not exist -- the defect
        # in miniature.
        $sandbox = New-Sandbox
        try {
            $catalogue = Join-Path $sandbox 'catalogue.json'
            $row = [pscustomobject]@{
                Action = 'post-v1-posts'; Description = $null; Provider = $null
                Methods = @('POST'); Endpoints = @('api.example.invalid/v1/posts')
                EntryCount = 3; RequestBodies = $null; RequestBytes = $null
                ResponseBytes = $null; RequestBodiesAbsent = $null
                Status = 'Observed'; HarFile = $null; Related = @()
                CapturedUtc = '2026-08-26T00:00:00.000Z'
            }
            Set-Content -LiteralPath $catalogue -Value (ConvertTo-Json @($row) -Depth 6) -Encoding utf8

            $entry = @(& $script:ConvertPs1 -Path $catalogue)[0]
            $entry.RequestBodies | Should -BeNullOrEmpty
            $entry.RequestBodies | Should -Not -Be 0
        }
        finally { Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'HarCapture.Format.ps1xml' {
    It 'is well-formed XML that PowerShell will load' {
        # A malformed format file does not fail loudly -- Update-FormatData is
        # called with -ErrorAction SilentlyContinue, so the console silently
        # falls back to the default rendering and nobody notices.
        { [xml](Get-Content -LiteralPath $script:FormatXml -Raw) } | Should -Not -Throw
    }

    It 'puts the request-body count in the table' {
        # The column that makes a hollow reference visible at a glance, beside
        # the entry count: a row describing what a client sent, against a file
        # whose entries carry none, reads as `1  0`.
        $xml = [xml](Get-Content -LiteralPath $script:FormatXml -Raw)
        $labels = $xml.SelectNodes('//TableColumnHeader/Label') | ForEach-Object { $_.InnerText }
        $labels | Should -Contain 'ReqBodies'
    }
}

Describe 'SKILL.md documents the convention the tooling enforces' {
    It 'names <Needle>' -ForEach @(
        @{ Needle = 'catalogue.json' }
        @{ Needle = 'render-har-catalogue.js' }
        @{ Needle = 'verify-har-catalogue.js' }
        @{ Needle = 'RequestBodiesAbsent' }
        @{ Needle = 'BEGIN GENERATED CATALOGUE' }
    ) {
        $script:SkillText | Should -Match ([regex]::Escape($Needle))
    }
}
