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

    It 'tick-suffixed backups never collide on rapid successive runs (Copilot review #161)' {
        Set-Content -Path '.gitattributes' -Value 'V1' -NoNewline
        Initialize-GitDefaults -Language 'CSharp' -Force         # .gitattributes.bak
        Set-Content -Path '.gitattributes' -Value 'V2' -NoNewline
        Initialize-GitDefaults -Language 'CSharp' -Force         # .gitattributes.bak.<ticks>
        Set-Content -Path '.gitattributes' -Value 'V3' -NoNewline
        Initialize-GitDefaults -Language 'CSharp' -Force         # second .gitattributes.bak.<ticks>
        $baks = Get-ChildItem -Filter '.gitattributes.bak*' -Force
        $baks.Count | Should -BeGreaterOrEqual 3
        # Each .bak* must have a distinct name
        ($baks | Select-Object -ExpandProperty Name | Sort-Object -Unique).Count | Should -Be $baks.Count
    }
}

Describe 'Get-GitDefaultsDetectedLanguages (Copilot review #161)' {
    BeforeEach {
        $script:detRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("detect-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $script:detRepo | Out-Null
    }
    AfterEach {
        Remove-Item -Recurse -Force $script:detRepo -ErrorAction SilentlyContinue
    }

    It 'detects CSharp from a .csproj file' {
        Set-Content -Path (Join-Path $script:detRepo 'App.csproj') -Value '<Project/>'
        Get-GitDefaultsDetectedLanguages -Path $script:detRepo | Should -Contain 'CSharp'
    }

    It 'detects PowerShell from a .psm1 file' {
        Set-Content -Path (Join-Path $script:detRepo 'tool.psm1') -Value '# m'
        Get-GitDefaultsDetectedLanguages -Path $script:detRepo | Should -Contain 'PowerShell'
    }

    It 'detects TypeScript from a tsconfig.json' {
        Set-Content -Path (Join-Path $script:detRepo 'tsconfig.json') -Value '{}'
        Get-GitDefaultsDetectedLanguages -Path $script:detRepo | Should -Contain 'TypeScript'
    }

    It 'detects ASP.NET only when both .csproj AND appsettings*.json are present' {
        Set-Content -Path (Join-Path $script:detRepo 'App.csproj') -Value '<Project/>'
        Get-GitDefaultsDetectedLanguages -Path $script:detRepo | Should -Not -Contain 'ASP.NET'
        Set-Content -Path (Join-Path $script:detRepo 'appsettings.json') -Value '{}'
        Get-GitDefaultsDetectedLanguages -Path $script:detRepo | Should -Contain 'ASP.NET'
    }

    It 'always includes the cross-platform Global/Backup section (Copilot review #161 round 2)' {
        $content = New-GitIgnoreContent -Language @('CSharp')
        $content | Should -Match '(?m)^# === Global/Backup'
    }

    It 'includes Backup section even when only PowerShell (no upstream gitignore) is selected' {
        $content = New-GitIgnoreContent -Language @('PowerShell')
        $content | Should -Match '(?m)^# === Global/Backup'
    }

    It 'header mentions the curated PowerShell block as an intentional override (Copilot review #161 round 2)' {
        $content = New-GitAttributesContent -Language @('PowerShell','CSharp')
        $content | Should -Match 'intentional override'
        $content | Should -Not -Match 'no upstream template'
    }

    It 'preflight aborts BEFORE writing any file when one of multiple targets exists (Copilot review #161 round 2)' {
        $repo = Join-Path ([System.IO.Path]::GetTempPath()) ("pf-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $repo | Out-Null
        & git -C $repo init --quiet 2>&1 | Out-Null
        Push-Location $repo
        try {
            Set-Content -Path '.gitignore' -Value 'pre-existing' -NoNewline
            { Initialize-GitDefaults -Language 'CSharp' -ErrorAction Stop } | Should -Throw -ExpectedMessage '*already exists*'
            Test-Path '.gitattributes' | Should -BeFalse
            (Get-Content '.gitignore' -Raw) | Should -Be 'pre-existing'
        } finally {
            Pop-Location
            Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Copilot review #161 round 3: no-Language code path' {
    Context 'when the picker declines (non-interactive host simulated via Mock)' {
        BeforeEach {
            Mock -CommandName 'Read-GitDefaultsLanguageSelection' -MockWith { return $null }
            $script:nlRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("nl-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $script:nlRepo | Out-Null
            & git -C $script:nlRepo init --quiet 2>&1 | Out-Null
            Push-Location $script:nlRepo
        }
        AfterEach {
            Pop-Location
            Remove-Item -Recurse -Force $script:nlRepo -ErrorAction SilentlyContinue
        }

        It 'throws a helpful error naming the supported languages when -Language is omitted' {
            { Initialize-GitDefaults -ErrorAction Stop } | Should -Throw -ExpectedMessage '*No -Language supplied*'
            Test-Path '.gitattributes' | Should -BeFalse
            Test-Path '.gitignore'     | Should -BeFalse
            Assert-MockCalled -CommandName 'Read-GitDefaultsLanguageSelection' -Times 1 -Scope It
        }

        It 'error message enumerates all supported languages so the user knows valid inputs' {
            { Initialize-GitDefaults -ErrorAction Stop } | Should -Throw -ExpectedMessage '*CSharp*'
            { Initialize-GitDefaults -ErrorAction Stop } | Should -Throw -ExpectedMessage '*PowerShell*'
            { Initialize-GitDefaults -ErrorAction Stop } | Should -Throw -ExpectedMessage '*TypeScript*'
            { Initialize-GitDefaults -ErrorAction Stop } | Should -Throw -ExpectedMessage '*ASP.NET*'
        }
    }

    Context 'when the picker returns languages (interactive host simulated via Mock)' {
        BeforeEach {
            Mock -CommandName 'Read-GitDefaultsLanguageSelection' -MockWith { return @('CSharp','PowerShell') }
            $script:nlRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("nl2-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $script:nlRepo | Out-Null
            & git -C $script:nlRepo init --quiet 2>&1 | Out-Null
            Push-Location $script:nlRepo
        }
        AfterEach {
            Pop-Location
            Remove-Item -Recurse -Force $script:nlRepo -ErrorAction SilentlyContinue
        }

        It 'composes generated files from the picker result without -Language being passed' {
            Initialize-GitDefaults -Force
            Assert-MockCalled -CommandName 'Read-GitDefaultsLanguageSelection' -Times 1 -Scope It
            (Get-Content '.gitattributes' -Raw) | Should -Match '(?m)^# === CSharp'
            (Get-Content '.gitattributes' -Raw) | Should -Match '\*\.ps1\s+text eol=crlf'
            (Get-Content '.gitignore'     -Raw) | Should -Match '(?m)^# === VisualStudio'
            (Get-Content '.gitignore'     -Raw) | Should -Match '(?m)^# === Global/Backup'
        }
    }

    Context 'detection heuristics feed the picker default' {
        It 'pre-selects every supported language in a kitchen-sink tree' {
            $repo = Join-Path ([System.IO.Path]::GetTempPath()) ("ks-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $repo | Out-Null
            try {
                Set-Content -Path (Join-Path $repo 'App.csproj')       -Value '<Project/>'
                Set-Content -Path (Join-Path $repo 'appsettings.json') -Value '{}'
                Set-Content -Path (Join-Path $repo 'tsconfig.json')    -Value '{}'
                Set-Content -Path (Join-Path $repo 'tool.psm1')        -Value '# m'
                $detected = Get-GitDefaultsDetectedLanguages -Path $repo
                $detected | Should -Contain 'CSharp'
                $detected | Should -Contain 'PowerShell'
                $detected | Should -Contain 'TypeScript'
                $detected | Should -Contain 'ASP.NET'
            } finally {
                Remove-Item -Recurse -Force $repo -ErrorAction SilentlyContinue
            }
        }
    }
}

Describe 'Copilot review #161 round 3: kind-aware curated PowerShell header' {
    It 'gitattributes header attributes the PowerShell block as an intentional override of upstream' {
        $content = New-GitAttributesContent -Language @('PowerShell','CSharp')
        $content | Should -Match 'intentional override of upstream PowerShell\.gitattributes'
    }

    It 'gitignore header attributes the PowerShell block to absence of upstream PowerShell.gitignore' {
        $content = New-GitIgnoreContent -Language @('PowerShell','CSharp')
        $content | Should -Match 'no upstream PowerShell\.gitignore exists'
        $content | Should -Not -Match 'intentional override'
    }
}

Describe 'Copilot review #161 round 4: -Refresh implementation' {
    Context 'fetches from upstream and writes through to disk' {
        BeforeEach {
            $script:r4Repo = Join-Path ([System.IO.Path]::GetTempPath()) ("r4-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $script:r4Repo | Out-Null
            & git -C $script:r4Repo init --quiet 2>&1 | Out-Null
            Push-Location $script:r4Repo
            $script:fetchedUrls = [System.Collections.Generic.List[string]]::new()
            Mock -CommandName 'Invoke-WebRequest' -MockWith {
                $script:fetchedUrls.Add($Uri)
                # Return distinctive sentinel content per file so we can
                # detect that it landed in the generated output.
                $name = Split-Path $Uri -Leaf
                return [PSCustomObject]@{ Content = "# SENTINEL FOR $name`n" }
            }
        }
        AfterEach {
            Pop-Location
            Remove-Item -Recurse -Force $script:r4Repo -ErrorAction SilentlyContinue
        }

        It '-Refresh fetches every required template from raw.githubusercontent.com' {
            Initialize-GitDefaults -Language 'CSharp' -Refresh -Force
            Assert-MockCalled -CommandName 'Invoke-WebRequest' -Scope It -Times 1 -ParameterFilter { $Uri -like '*alexkaratarakis/gitattributes*Common.gitattributes' }
            Assert-MockCalled -CommandName 'Invoke-WebRequest' -Scope It -Times 1 -ParameterFilter { $Uri -like '*alexkaratarakis/gitattributes*CSharp.gitattributes' }
            Assert-MockCalled -CommandName 'Invoke-WebRequest' -Scope It -Times 1 -ParameterFilter { $Uri -like '*github/gitignore*VisualStudio.gitignore' }
            Assert-MockCalled -CommandName 'Invoke-WebRequest' -Scope It -Times 1 -ParameterFilter { $Uri -like '*github/gitignore*Global/Backup.gitignore' }
        }

        It 'composes generated files from the fetched sentinel content (-Refresh writes through)' {
            Initialize-GitDefaults -Language 'CSharp' -Refresh -Force
            (Get-Content '.gitattributes' -Raw) | Should -Match 'SENTINEL FOR Common.gitattributes'
            (Get-Content '.gitattributes' -Raw) | Should -Match 'SENTINEL FOR CSharp.gitattributes'
            (Get-Content '.gitignore'     -Raw) | Should -Match 'SENTINEL FOR VisualStudio.gitignore'
            (Get-Content '.gitignore'     -Raw) | Should -Match 'SENTINEL FOR Backup.gitignore'
        }

        It 'header records "fetched from upstream" when -Refresh is used' {
            Initialize-GitDefaults -Language 'CSharp' -Refresh -Force
            (Get-Content '.gitattributes' -Raw) | Should -Match 'Source mode: fetched from upstream'
            (Get-Content '.gitignore'     -Raw) | Should -Match 'Source mode: fetched from upstream'
        }

        It 'header records "bundled snapshot" when -Refresh is omitted' {
            Initialize-GitDefaults -Language 'CSharp' -Force
            (Get-Content '.gitattributes' -Raw) | Should -Match 'Source mode: bundled snapshot'
            Assert-MockCalled -CommandName 'Invoke-WebRequest' -Scope It -Times 0
        }

        It 'overriding -GitattributesRef changes the URL the fetcher hits' {
            Initialize-GitDefaults -Language 'CSharp' -GitattributesRef 'cafebabe1234567890abcdef0987654321fedcba' -Refresh -Force
            Assert-MockCalled -CommandName 'Invoke-WebRequest' -Scope It -Times 1 -ParameterFilter {
                $Uri -like '*alexkaratarakis/gitattributes/cafebabe1234567890abcdef0987654321fedcba/*'
            }
        }
    }

    Context 'falls back to the on-disk cache when the network fetch fails' {
        BeforeEach {
            $script:r4Repo = Join-Path ([System.IO.Path]::GetTempPath()) ("r4f-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $script:r4Repo | Out-Null
            & git -C $script:r4Repo init --quiet 2>&1 | Out-Null
            Push-Location $script:r4Repo

            # Seed the cache for one specific file at a synthetic ref so we
            # can prove "fetch fails -> cache hit -> compose continues".
            $fakeRef = 'unit-test-ref-' + [System.Guid]::NewGuid().ToString('N').Substring(0,8)
            $script:fakeRef = $fakeRef
            $cacheDir = Join-Path (Get-GitDefaultsCacheRoot) "alexkaratarakis/gitattributes/$fakeRef"
            New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
            Set-Content -Path (Join-Path $cacheDir 'Common.gitattributes') -Value "# CACHED COMMON`n" -NoNewline
            Set-Content -Path (Join-Path $cacheDir 'CSharp.gitattributes') -Value "# CACHED CSHARP`n" -NoNewline
            $giCacheDir = Join-Path (Get-GitDefaultsCacheRoot) "github/gitignore/$fakeRef"
            New-Item -ItemType Directory -Force -Path $giCacheDir | Out-Null
            New-Item -ItemType Directory -Force -Path (Join-Path $giCacheDir 'Global') | Out-Null
            Set-Content -Path (Join-Path $giCacheDir 'VisualStudio.gitignore') -Value "# CACHED VS`n" -NoNewline
            Set-Content -Path (Join-Path $giCacheDir 'Global/Backup.gitignore') -Value "# CACHED BACKUP`n" -NoNewline

            Mock -CommandName 'Invoke-WebRequest' -MockWith { throw 'simulated network failure' }
        }
        AfterEach {
            Pop-Location
            Remove-Item -Recurse -Force $script:r4Repo -ErrorAction SilentlyContinue
            Remove-Item -Recurse -Force (Join-Path (Get-GitDefaultsCacheRoot) "alexkaratarakis/gitattributes/$script:fakeRef") -ErrorAction SilentlyContinue
            Remove-Item -Recurse -Force (Join-Path (Get-GitDefaultsCacheRoot) "github/gitignore/$script:fakeRef") -ErrorAction SilentlyContinue
        }

        It 'uses cached content when network fetch fails AND cache hit exists' {
            Initialize-GitDefaults -Language 'CSharp' -Refresh -Force -GitattributesRef $script:fakeRef -GitignoreRef $script:fakeRef -WarningAction SilentlyContinue
            (Get-Content '.gitattributes' -Raw) | Should -Match 'CACHED COMMON'
            (Get-Content '.gitattributes' -Raw) | Should -Match 'CACHED CSHARP'
            (Get-Content '.gitignore'     -Raw) | Should -Match 'CACHED BACKUP'
        }

        It 'throws clearly when network fails AND no cache exists' {
            $unseededRef = 'never-cached-' + [System.Guid]::NewGuid().ToString('N').Substring(0,8)
            { Initialize-GitDefaults -Language 'CSharp' -Refresh -Force -GitattributesRef $unseededRef -GitignoreRef $unseededRef -ErrorAction Stop } |
                Should -Throw -ExpectedMessage '*no cached copy*'
        }
    }
}

Describe 'Copilot review #161 round 4: include-switch one-file invocations' {
    BeforeEach {
        $script:swRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("sw-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $script:swRepo | Out-Null
        & git -C $script:swRepo init --quiet 2>&1 | Out-Null
        Push-Location $script:swRepo
    }
    AfterEach {
        Pop-Location
        Remove-Item -Recurse -Force $script:swRepo -ErrorAction SilentlyContinue
    }

    It '-IncludeGitignore:$false writes .gitattributes only and leaves an existing .gitignore untouched' {
        Set-Content -Path '.gitignore' -Value 'consumer-owned' -NoNewline
        Initialize-GitDefaults -Language 'CSharp' -IncludeGitignore:$false -Force
        Test-Path '.gitattributes' | Should -BeTrue
        (Get-Content '.gitignore' -Raw) | Should -Be 'consumer-owned'
        # No .bak should have been created for .gitignore
        Test-Path '.gitignore.bak' | Should -BeFalse
    }

    It '-IncludeGitattributes:$false writes .gitignore only and leaves an existing .gitattributes untouched' {
        Set-Content -Path '.gitattributes' -Value '* text=auto' -NoNewline
        Initialize-GitDefaults -Language 'CSharp' -IncludeGitattributes:$false -Force
        Test-Path '.gitignore' | Should -BeTrue
        (Get-Content '.gitattributes' -Raw) | Should -Be '* text=auto'
        Test-Path '.gitattributes.bak' | Should -BeFalse
    }

    It '-IncludeGitignore:$false with no existing .gitignore does not create one' {
        Initialize-GitDefaults -Language 'CSharp' -IncludeGitignore:$false -Force
        Test-Path '.gitignore' | Should -BeFalse
    }
}

Describe 'Copilot review #161 round 5: atomicity + -WhatIf cache safety' {
    Context 'compose-then-write is atomic across both targets' {
        BeforeEach {
            $script:atRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("at-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $script:atRepo | Out-Null
            & git -C $script:atRepo init --quiet 2>&1 | Out-Null
            Push-Location $script:atRepo
            # Mock Invoke-WebRequest to succeed for gitattributes URLs and
            # fail for gitignore URLs, so the second compose throws AFTER
            # the first compose succeeded. The atomic guard must prevent
            # .gitattributes from being written.
            Mock -CommandName 'Invoke-WebRequest' -MockWith {
                if ($Uri -like '*github/gitignore*') {
                    throw 'simulated gitignore-only fetch failure'
                }
                $name = Split-Path $Uri -Leaf
                return [PSCustomObject]@{ Content = "# OK $name`n" }
            }
        }
        AfterEach {
            Pop-Location
            Remove-Item -Recurse -Force $script:atRepo -ErrorAction SilentlyContinue
        }

        It 'fails the whole operation without writing either file when the second compose throws' {
            $uniq = 'atom-' + [System.Guid]::NewGuid().ToString('N').Substring(0,8)
            { Initialize-GitDefaults -Language 'CSharp' -Refresh -Force -GitignoreRef $uniq -ErrorAction Stop } |
                Should -Throw -ExpectedMessage '*gitignore*'
            Test-Path '.gitattributes' | Should -BeFalse
            Test-Path '.gitignore'     | Should -BeFalse
        }
    }

    Context '-WhatIf does not mutate the on-disk cache' {
        BeforeEach {
            $script:atRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("wi-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $script:atRepo | Out-Null
            & git -C $script:atRepo init --quiet 2>&1 | Out-Null
            Push-Location $script:atRepo
            $script:whatIfRef = 'whatif-' + [System.Guid]::NewGuid().ToString('N').Substring(0,8)
            Mock -CommandName 'Invoke-WebRequest' -MockWith {
                $name = Split-Path $Uri -Leaf
                return [PSCustomObject]@{ Content = "# WHATIF $name`n" }
            }
        }
        AfterEach {
            Pop-Location
            Remove-Item -Recurse -Force $script:atRepo -ErrorAction SilentlyContinue
            $a = Join-Path (Get-GitDefaultsCacheRoot) "alexkaratarakis/gitattributes/$script:whatIfRef"
            $b = Join-Path (Get-GitDefaultsCacheRoot) "github/gitignore/$script:whatIfRef"
            Remove-Item -Recurse -Force $a -ErrorAction SilentlyContinue
            Remove-Item -Recurse -Force $b -ErrorAction SilentlyContinue
        }

        It 'leaves no cached file behind under -WhatIf with -Refresh' {
            Initialize-GitDefaults -Language 'CSharp' -Refresh -Force -GitattributesRef $script:whatIfRef -GitignoreRef $script:whatIfRef -WhatIf
            $a = Join-Path (Get-GitDefaultsCacheRoot) "alexkaratarakis/gitattributes/$script:whatIfRef"
            $b = Join-Path (Get-GitDefaultsCacheRoot) "github/gitignore/$script:whatIfRef"
            Test-Path $a | Should -BeFalse
            Test-Path $b | Should -BeFalse
            Test-Path '.gitattributes' | Should -BeFalse
            Test-Path '.gitignore'     | Should -BeFalse
        }
    }
}
