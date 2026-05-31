#Requires -Version 7.0

BeforeAll {
    . $PSScriptRoot/Initialize-GitDefaults.ps1

    function New-TestRepo {
        param([switch]$NoGit)
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("init-git-defaults-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $dir | Out-Null
        if (-not $NoGit) {
            & git -C $dir init --quiet 2>&1 | Out-Null
        }
        return $dir
    }
}

Describe 'Resolve-GitDefaultsLanguages' {
    It 'returns the canonical name for a known language' {
        Resolve-GitDefaultsLanguages -Language 'CSharp' | Should -Be @('CSharp')
    }

    It 'expands ASP.NET to include CSharp' {
        $result = Resolve-GitDefaultsLanguages -Language 'ASP.NET'
        $result | Should -Contain 'ASP.NET'
        $result | Should -Contain 'CSharp'
    }

    It 'deduplicates and sorts the result' {
        $result = Resolve-GitDefaultsLanguages -Language 'CSharp','PowerShell','CSharp'
        $result | Should -Be @('CSharp','PowerShell')
    }

    It 'rejects unknown languages with helpful error listing supported ones' {
        { Resolve-GitDefaultsLanguages -Language 'Bogus' } | Should -Throw -ExpectedMessage '*Bogus*'
        { Resolve-GitDefaultsLanguages -Language 'Bogus' } | Should -Throw -ExpectedMessage '*CSharp*'
    }

    It 'is case-insensitive on input but returns canonical casing' {
        Resolve-GitDefaultsLanguages -Language 'csharp','powershell' | Should -Be @('CSharp','PowerShell')
    }
}

Describe 'New-GitAttributesContent' {
    It 'includes Common section for any language' {
        $content = New-GitAttributesContent -Language @('CSharp')
        $content | Should -Match '(?m)^# === Common'
    }

    It 'includes CSharp section when CSharp is selected' {
        $content = New-GitAttributesContent -Language @('CSharp')
        $content | Should -Match '(?m)^# === CSharp'
    }

    It 'omits Web section when CSharp-only is selected' {
        $content = New-GitAttributesContent -Language @('CSharp')
        $content | Should -Not -Match '(?m)^# === Web'
    }

    It 'includes Web section when TypeScript is selected' {
        $content = New-GitAttributesContent -Language @('TypeScript')
        $content | Should -Match '(?m)^# === Web'
    }

    It 'includes curated PowerShell block verbatim when PowerShell is selected' {
        $content = New-GitAttributesContent -Language @('PowerShell')
        $content | Should -Match '\*\.ps1\s+text eol=crlf'
        $content | Should -Match '\*\.ps1\s+linguist-language=PowerShell'
    }

    It 'orders language sections alphabetically' {
        $content = New-GitAttributesContent -Language @('CSharp','PowerShell')
        $csharpIdx = $content.IndexOf('=== CSharp')
        $psIdx = $content.IndexOf('=== PowerShell')
        $csharpIdx | Should -BeGreaterThan 0
        $psIdx | Should -BeGreaterThan 0
        $csharpIdx | Should -BeLessThan $psIdx
    }

    It 'resolves ASP.NET dependency to include CSharp content' {
        $content = New-GitAttributesContent -Language @('ASP.NET')
        $content | Should -Match '(?m)^# === CSharp'
    }

    It 'header includes the pinned gitattributes SHA' {
        $content = New-GitAttributesContent -Language @('CSharp')
        $content | Should -Match 'fddc586cf0f10ec4485028d0d2dd6f73197a4258'
    }

    It 'header labels gitattributes source as community de facto' {
        $content = New-GitAttributesContent -Language @('CSharp')
        $content | Should -Match 'community de facto'
    }

    It 'header lists the selected languages' {
        $content = New-GitAttributesContent -Language @('CSharp','PowerShell')
        $content | Should -Match 'Languages:.*CSharp.*PowerShell'
    }

    It 'header announces curated additions when PowerShell is selected' {
        $content = New-GitAttributesContent -Language @('PowerShell')
        $content | Should -Match 'Curated additions:.*PowerShell'
    }
}

Describe 'New-GitIgnoreContent' {
    It 'includes VisualStudio section when CSharp is selected' {
        $content = New-GitIgnoreContent -Language @('CSharp')
        $content | Should -Match '(?m)^# === VisualStudio'
    }

    It 'includes Node section when TypeScript is selected' {
        $content = New-GitIgnoreContent -Language @('TypeScript')
        $content | Should -Match '(?m)^# === Node'
    }

    It 'includes curated PowerShell block when PowerShell is selected' {
        $content = New-GitIgnoreContent -Language @('PowerShell')
        $content | Should -Match 'PSReadLine/ConsoleHost_history\.txt'
    }

    It 'header includes the pinned gitignore SHA' {
        $content = New-GitIgnoreContent -Language @('CSharp')
        $content | Should -Match 'dcc0fc7bc2b5ba480cf117ad1be31bafceeaff46'
    }

    It 'header labels gitignore source as GitHub-org authoritative' {
        $content = New-GitIgnoreContent -Language @('CSharp')
        $content | Should -Match 'GitHub-org authoritative'
    }
}

Describe 'Initialize-GitDefaults (integration)' {
    BeforeEach {
        $script:savedLocation = Get-Location
        $script:testRepo = New-TestRepo
        Set-Location $script:testRepo
    }
    AfterEach {
        Set-Location $script:savedLocation
        Remove-Item -Recurse -Force $script:testRepo -ErrorAction SilentlyContinue
    }

    It 'aborts with a clear message when cwd is not a git repo' {
        Set-Location $script:savedLocation
        Remove-Item -Recurse -Force $script:testRepo -ErrorAction SilentlyContinue
        $script:testRepo = New-TestRepo -NoGit
        Set-Location $script:testRepo
        { Initialize-GitDefaults -Language 'CSharp' -Force -ErrorAction Stop } |
            Should -Throw -ExpectedMessage '*not a git repository*'
    }

    It 'writes both files end-to-end with -Force' {
        Initialize-GitDefaults -Language 'CSharp','PowerShell' -Force
        Test-Path '.gitattributes' | Should -BeTrue
        Test-Path '.gitignore' | Should -BeTrue
        (Get-Content '.gitattributes' -Raw) | Should -Match '(?m)^# === CSharp'
        (Get-Content '.gitignore' -Raw) | Should -Match '(?m)^# === VisualStudio'
    }

    It 'aborts on existing file without -Force and leaves it unchanged' {
        Set-Content -Path '.gitattributes' -Value 'PRE-EXISTING' -NoNewline
        { Initialize-GitDefaults -Language 'CSharp' -ErrorAction Stop } |
            Should -Throw -ExpectedMessage '*-Force*'
        (Get-Content '.gitattributes' -Raw) | Should -Be 'PRE-EXISTING'
    }

    It 'backs up the existing file with -Force' {
        Set-Content -Path '.gitattributes' -Value 'PRE-EXISTING' -NoNewline
        Initialize-GitDefaults -Language 'CSharp' -Force
        Test-Path '.gitattributes.bak' | Should -BeTrue
        (Get-Content '.gitattributes.bak' -Raw) | Should -Be 'PRE-EXISTING'
    }

    It 'suffixes a timestamp when .bak already exists' {
        Set-Content -Path '.gitattributes' -Value 'V1' -NoNewline
        Set-Content -Path '.gitattributes.bak' -Value 'OLD' -NoNewline
        Initialize-GitDefaults -Language 'CSharp' -Force
        (Get-Content '.gitattributes.bak' -Raw) | Should -Be 'OLD'
        $extras = Get-ChildItem -Filter '.gitattributes.bak.*' -Force
        $extras.Count | Should -BeGreaterThan 0
    }

    It 'honours -WhatIf and writes nothing' {
        Initialize-GitDefaults -Language 'CSharp' -Force -WhatIf
        Test-Path '.gitattributes' | Should -BeFalse
        Test-Path '.gitignore' | Should -BeFalse
    }

    It 'composes full target stack: CSharp + PowerShell + TypeScript + ASP.NET' {
        Initialize-GitDefaults -Language 'CSharp','PowerShell','TypeScript','ASP.NET' -Force
        $ga = Get-Content '.gitattributes' -Raw
        $gi = Get-Content '.gitignore' -Raw
        $ga | Should -Match '(?m)^# === CSharp'
        $ga | Should -Match '(?m)^# === Web'
        $ga | Should -Match '\*\.ps1\s+text eol=crlf'
        $gi | Should -Match '(?m)^# === VisualStudio'
        $gi | Should -Match '(?m)^# === Node'
        $gi | Should -Match 'PSReadLine/ConsoleHost_history\.txt'
    }
}