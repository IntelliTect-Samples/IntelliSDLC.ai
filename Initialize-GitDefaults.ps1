<#
.SYNOPSIS
    Compose .gitattributes and .gitignore for a consumer project from per-language
    upstream community templates plus a curated PowerShell block.

.DESCRIPTION
    Replaces the legacy `.gitattributes.template` static-template approach with a
    composable assembler. Language coverage today: CSharp, PowerShell,
    TypeScript, ASP.NET (depends on CSharp).

    Source authority:
      - `.gitignore`  : github/gitignore @ pinned SHA -- GitHub-org authoritative;
                        powers GitHub's UI picker; same content as `gibo`.
      - `.gitattributes` : alexkaratarakis/gitattributes @ pinned SHA -- community
                        de facto. The GitHub-org repo `github/gitattributes` does
                        not exist (verified: `gh api repos/github/gitattributes/
                        commits/main` returns 404).

    Snapshots are bundled under `.github/templates/git-defaults/` at the pinned
    SHAs and used by default. The `-Refresh` switch is reserved for a future
    network-fetch path and currently hard-errors (see .PARAMETER Refresh).

.PARAMETER Language
    Languages to include. Validated against the supported set. ASP.NET implies
    CSharp. When omitted in an interactive host a simple comma-separated picker
    runs with languages detected from the working tree (via
    Get-GitDefaultsDetectedLanguages) offered as the default. Non-interactive
    hosts and an omitted value abort with the list of supported languages.

.PARAMETER IncludeGitignore
    Compose `.gitignore`. Default: $true.

.PARAMETER IncludeGitattributes
    Compose `.gitattributes`. Default: $true.

.PARAMETER GitattributesRef
    Git SHA in alexkaratarakis/gitattributes the bundled snapshots are pinned to.
    Overriding this only makes sense alongside -Refresh (network fetch), which
    is not yet implemented; passing a non-default value without -Refresh hard-
    errors to prevent header drift.

.PARAMETER GitignoreRef
    Git SHA in github/gitignore the bundled snapshots are pinned to. Same
    override semantics as -GitattributesRef.

.PARAMETER Refresh
    RESERVED. Intended to bypass bundled snapshots and fetch fresh copies from
    GitHub over HTTPS at the requested refs. NOT YET IMPLEMENTED in this
    release; passing -Refresh hard-errors. Omit -Refresh to compose from the
    bundled snapshots at the pinned SHAs.

.PARAMETER Force
    Overwrite existing `.gitattributes` / `.gitignore` after backing the
    original up to `<file>.bak` (with a unique tick-resolution suffix if
    `.bak` already exists). Without -Force the script aborts if the target
    exists.

.EXAMPLE
    ./Initialize-GitDefaults.ps1 -Language CSharp,PowerShell -Force

.EXAMPLE
    ./Initialize-GitDefaults.ps1 -Language ASP.NET,TypeScript -Force
    # ASP.NET expands to {ASP.NET, CSharp}.

.EXAMPLE
    ./Initialize-GitDefaults.ps1
    # Interactive picker: prompts with heuristically-detected languages as
    # the default. Non-interactive hosts must pass -Language explicitly.
#>
[CmdletBinding(SupportsShouldProcess)]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'User-facing CLI output matching the project-wide convention.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Internal New-*Content / New-*Header helpers are pure string builders despite the New- verb.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns', '', Justification = 'Initialize-GitDefaults and Resolve-GitDefaultsLanguages operate on a set; plural noun matches the conceptual data shape.')]
param(
    [string[]] $Language,
    [switch]   $IncludeGitignore,
    [switch]   $IncludeGitattributes,
    [string]   $GitattributesRef = 'fddc586cf0f10ec4485028d0d2dd6f73197a4258',
    [string]   $GitignoreRef     = 'dcc0fc7bc2b5ba480cf117ad1be31bafceeaff46',
    [switch]   $Refresh,
    [switch]   $Force
)

# ----- Constants -----------------------------------------------------------

# Canonical language registry. Order of `Sections` controls divider naming.
# `Deps` lists languages this one depends on (transitively expanded).
$script:GitDefaultsLanguages = [ordered]@{
    'CSharp'     = @{ Canonical = 'CSharp';     Deps = @();         GitattrFile = 'CSharp.gitattributes'; GitignoreFile = 'VisualStudio.gitignore'; GiboName = 'visualstudio' }
    'PowerShell' = @{ Canonical = 'PowerShell'; Deps = @();         GitattrFile = $null;                  GitignoreFile = $null;                    GiboName = $null }
    'TypeScript' = @{ Canonical = 'TypeScript'; Deps = @();         GitattrFile = 'Web.gitattributes';    GitignoreFile = 'Node.gitignore';         GiboName = 'node' }
    'ASP.NET'    = @{ Canonical = 'ASP.NET';    Deps = @('CSharp'); GitattrFile = $null;                  GitignoreFile = $null;                    GiboName = 'visualstudio' }
}

$script:CuratedPowerShellGitattributes = @'
# PowerShell (curated in-script; intentionally overrides upstream
# PowerShell.gitattributes -- smaller surface, signing-aware, explicit
# linguist hints. See .github/templates/git-defaults/SOURCES.md.)
*.ps1    text eol=crlf
*.psm1   text eol=crlf
*.psd1   text eol=crlf
*.ps1xml text eol=crlf
*.pssc   text eol=crlf
*.ps1    linguist-language=PowerShell
*.psm1   linguist-language=PowerShell
*.psd1   linguist-language=PowerShell
'@

$script:CuratedPowerShellGitignore = @'
# PowerShell (curated in-script; no upstream PowerShell.gitignore exists
# in github/gitignore at the pinned SHA. See SOURCES.md.)
PSReadLine/ConsoleHost_history.txt
*.psproj.user
'@

# Authority labels surfaced in file headers and SOURCES.md.
$script:GitattributesAuthority = 'community de facto; no GitHub-org source exists'
$script:GitignoreAuthority     = 'GitHub-org authoritative'

# ----- Helpers -------------------------------------------------------------

function Get-GitDefaultsTemplateRoot {
    <#
    .SYNOPSIS
        Resolve the bundled-snapshot directory under the script root.
    #>
    [CmdletBinding()]
    param()
    return (Join-Path $PSScriptRoot '.github/templates/git-defaults')
}

function Resolve-GitDefaultsLanguages {
    <#
    .SYNOPSIS
        Normalise + validate language input and expand dependencies.
    .DESCRIPTION
        Case-insensitive lookup against the canonical registry. Unknown
        languages throw with a helpful error listing supported languages.
        Result is alphabetised and deduplicated.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)] [string[]] $Language
    )

    $canonicalMap = @{}
    foreach ($k in $script:GitDefaultsLanguages.Keys) {
        $canonicalMap[$k.ToLowerInvariant()] = $k
    }

    $resolved = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($lang in $Language) {
        if (-not $lang) { continue }
        $key = $lang.ToLowerInvariant()
        if (-not $canonicalMap.ContainsKey($key)) {
            $supported = ($script:GitDefaultsLanguages.Keys | Sort-Object) -join ', '
            throw "Unknown language '$lang'. Supported languages: $supported."
        }
        $canonical = $canonicalMap[$key]
        [void]$resolved.Add($canonical)
        foreach ($dep in $script:GitDefaultsLanguages[$canonical].Deps) {
            [void]$resolved.Add($dep)
        }
    }
    return @($resolved | Sort-Object)
}

function Get-GitDefaultsTemplateContent {
    <#
    .SYNOPSIS
        Read a bundled template snapshot from .github/templates/git-defaults/.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $FileName
    )
    $path = Join-Path (Get-GitDefaultsTemplateRoot) $FileName
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Bundled template snapshot not found: $path. Re-pull IntelliSDLC.ai (Pull-SDLC.ai.ps1) to restore the .github/templates/git-defaults/ snapshots."
    }
    return (Get-Content -LiteralPath $path -Raw)
}

function New-GitDefaultsHeader {
    <#
    .SYNOPSIS
        Build the header block printed at the top of generated files.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [ValidateSet('gitattributes','gitignore')] [string] $Kind,
        [Parameter(Mandatory)] [string[]] $Language,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [string[]] $UpstreamSections,
        [string] $GibootstrapNote
    )
    $iso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $langList = ($Language -join ', ')
    $hasPs = $Language -contains 'PowerShell'

    $lines = [System.Collections.Generic.List[string]]::new()
    [void]$lines.Add("# Generated by Initialize-GitDefaults.ps1 on $iso")
    [void]$lines.Add("# Languages: $langList")
    [void]$lines.Add('# Sources:')
    if ($Kind -eq 'gitattributes') {
        $sectionList = if ($UpstreamSections.Count -gt 0) { ($UpstreamSections -join ', ') } else { '(none)' }
        [void]$lines.Add("#   alexkaratarakis/gitattributes @ $GitattributesRef ($script:GitattributesAuthority) -> $sectionList")
    } else {
        $sectionList = if ($UpstreamSections.Count -gt 0) { ($UpstreamSections -join ', ') } else { '(none)' }
        if ($GibootstrapNote) {
            [void]$lines.Add("#   github/gitignore @ $GitignoreRef ($script:GitignoreAuthority) -> $sectionList  ($GibootstrapNote)")
        } else {
            [void]$lines.Add("#   github/gitignore @ $GitignoreRef ($script:GitignoreAuthority) -> $sectionList")
        }
    }
    if ($hasPs) {
        [void]$lines.Add('# Curated additions: PowerShell (intentional override of upstream; see SOURCES.md)')
    }
    [void]$lines.Add('# Re-run Initialize-GitDefaults.ps1 -Language ... -Force to regenerate or add languages.')
    [void]$lines.Add('')
    return ($lines -join "`n")
}

function New-GitDefaultsSectionDivider {
    <#
    .SYNOPSIS
        Render a section-divider comment naming the section + source file.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Section,
        [Parameter(Mandatory)] [string] $SourceLabel
    )
    return "`n# === $Section ($SourceLabel) ===`n"
}

function New-GitAttributesContent {
    <#
    .SYNOPSIS
        Compose a complete .gitattributes file body for the supplied languages.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string[]] $Language
    )
    $expanded = Resolve-GitDefaultsLanguages -Language $Language

    $upstreamSections = [System.Collections.Generic.List[string]]::new()
    [void]$upstreamSections.Add('Common')
    $seenFiles = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($lang in $expanded) {
        $entry = $script:GitDefaultsLanguages[$lang]
        if ($entry.GitattrFile -and $seenFiles.Add($entry.GitattrFile)) {
            $section = [System.IO.Path]::GetFileNameWithoutExtension($entry.GitattrFile)
            [void]$upstreamSections.Add($section)
        }
    }

    $header = New-GitDefaultsHeader -Kind 'gitattributes' -Language $expanded -UpstreamSections $upstreamSections

    $body = [System.Collections.Generic.List[string]]::new()
    [void]$body.Add($header)
    [void]$body.Add((New-GitDefaultsSectionDivider -Section 'Common' -SourceLabel 'Common.gitattributes'))
    [void]$body.Add((Get-GitDefaultsTemplateContent -FileName 'Common.gitattributes'))

    $emitted = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($lang in $expanded) {
        $entry = $script:GitDefaultsLanguages[$lang]
        if ($entry.GitattrFile -and $emitted.Add($entry.GitattrFile)) {
            $section = [System.IO.Path]::GetFileNameWithoutExtension($entry.GitattrFile)
            [void]$body.Add((New-GitDefaultsSectionDivider -Section $section -SourceLabel $entry.GitattrFile))
            [void]$body.Add((Get-GitDefaultsTemplateContent -FileName $entry.GitattrFile))
        } elseif ($lang -eq 'PowerShell') {
            [void]$body.Add((New-GitDefaultsSectionDivider -Section 'PowerShell' -SourceLabel 'curated in-script'))
            [void]$body.Add($script:CuratedPowerShellGitattributes)
        }
    }
    return ($body -join "`n")
}

function New-GitIgnoreContent {
    <#
    .SYNOPSIS
        Compose a complete .gitignore file body for the supplied languages.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string[]] $Language
    )
    $expanded = Resolve-GitDefaultsLanguages -Language $Language

    $upstreamSections = [System.Collections.Generic.List[string]]::new()
    $seenFiles = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($lang in $expanded) {
        $entry = $script:GitDefaultsLanguages[$lang]
        if ($entry.GitignoreFile -and $seenFiles.Add($entry.GitignoreFile)) {
            $section = [System.IO.Path]::GetFileNameWithoutExtension($entry.GitignoreFile)
            [void]$upstreamSections.Add($section)
        }
    }
    # Always include the cross-platform Backup snapshot. It is bundled
    # under .github/templates/git-defaults/Global/ for exactly this
    # purpose, and is language-independent (editor backups, OS junk).
    $backupFile = 'Global/Backup.gitignore'
    if ($seenFiles.Add($backupFile)) {
        [void]$upstreamSections.Add('Global/Backup')
    }

    $header = New-GitDefaultsHeader -Kind 'gitignore' -Language $expanded -UpstreamSections $upstreamSections

    $body = [System.Collections.Generic.List[string]]::new()
    [void]$body.Add($header)

    $emitted = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($lang in $expanded) {
        $entry = $script:GitDefaultsLanguages[$lang]
        if ($entry.GitignoreFile -and $emitted.Add($entry.GitignoreFile)) {
            $section = [System.IO.Path]::GetFileNameWithoutExtension($entry.GitignoreFile)
            [void]$body.Add((New-GitDefaultsSectionDivider -Section $section -SourceLabel $entry.GitignoreFile))
            [void]$body.Add((Get-GitDefaultsTemplateContent -FileName $entry.GitignoreFile))
        } elseif ($lang -eq 'PowerShell') {
            [void]$body.Add((New-GitDefaultsSectionDivider -Section 'PowerShell' -SourceLabel 'curated in-script'))
            [void]$body.Add($script:CuratedPowerShellGitignore)
        }
    }
    # Cross-platform editor/OS backup patterns, appended once.
    if ($emitted.Add($backupFile)) {
        [void]$body.Add((New-GitDefaultsSectionDivider -Section 'Global/Backup' -SourceLabel $backupFile))
        [void]$body.Add((Get-GitDefaultsTemplateContent -FileName $backupFile))
    }
    return ($body -join "`n")
}

function Test-GitDefaultsRepo {
    <#
    .SYNOPSIS
        Return $true if the current directory is inside a git working tree.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([string] $Path = (Get-Location).Path)
    $prev = Get-Location
    try {
        Set-Location -LiteralPath $Path
        & git rev-parse --git-dir 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        Set-Location -LiteralPath $prev
    }
}

function Backup-GitDefaultsFile {
    <#
    .SYNOPSIS
        Copy an existing file to `<file>.bak`, falling back to a
        ticks-suffixed name on collision so re-runs within the same
        second never overwrite an earlier backup.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Path
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $bak = "$Path.bak"
    if (Test-Path -LiteralPath $bak) {
        # Tick-resolution (100 ns) instead of seconds so two backups in
        # the same second still get unique names. Loop guards against an
        # absurdly fast clock or filesystem timestamp collision.
        do {
            $ticks = [DateTime]::UtcNow.Ticks
            $bak = "$Path.bak.$ticks"
        } while (Test-Path -LiteralPath $bak)
    }
    if ($PSCmdlet.ShouldProcess($Path, "Backup to $bak")) {
        Copy-Item -LiteralPath $Path -Destination $bak -Force
    }
    return $bak
}

function Write-GitDefaultsFile {
    <#
    .SYNOPSIS
        Write `$Content` to `$Path`, honouring -WhatIf and the backup/force rules.
    .DESCRIPTION
        - Aborts when `$Path` exists and -Force is not supplied (callers should
          surface the `-Force` hint in their error).
        - With -Force, backs up the original first.
        - Always writes UTF-8 without BOM, LF line endings.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Content,
        [switch] $Force
    )
    if (Test-Path -LiteralPath $Path) {
        if (-not $Force) {
            throw "$Path already exists. Re-run with -Force to back up and overwrite."
        }
        Backup-GitDefaultsFile -Path $Path | Out-Null
    }
    if ($PSCmdlet.ShouldProcess($Path, 'Write generated file')) {
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        $normalised = $Content -replace "`r`n", "`n"
        # Resolve relative paths against PowerShell's CWD because
        # [System.IO.File] uses .NET's process CWD, which can diverge.
        $resolved = if ([System.IO.Path]::IsPathRooted($Path)) { $Path }
                    else { Join-Path $PWD.Path $Path }
        [System.IO.File]::WriteAllText($resolved, $normalised, $utf8NoBom)
    }
}

function Get-GitDefaultsDetectedLanguages {
    <#
    .SYNOPSIS
        Heuristically detect candidate languages by scanning the current
        working tree for indicator files.
    .DESCRIPTION
        Conservative: only matches things we have explicit templates for.
        ASP.NET requires both a .csproj and an appsettings.json (otherwise
        the consumer is a plain console / library project and CSharp alone
        is the right pre-selection).
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([string] $Path = (Get-Location).Path)

    $detected = [System.Collections.Generic.HashSet[string]]::new()
    $hasCsproj   = @(Get-ChildItem -Path $Path -Recurse -File -Include '*.csproj','*.sln' -ErrorAction SilentlyContinue -Depth 3).Count -gt 0
    $hasPs       = @(Get-ChildItem -Path $Path -Recurse -File -Include '*.ps1','*.psm1','*.psd1' -ErrorAction SilentlyContinue -Depth 3).Count -gt 0
    $hasTs       = @(Get-ChildItem -Path $Path -Recurse -File -Include 'tsconfig.json','package.json' -ErrorAction SilentlyContinue -Depth 3).Count -gt 0
    $hasAppSets  = @(Get-ChildItem -Path $Path -Recurse -File -Filter 'appsettings*.json' -ErrorAction SilentlyContinue -Depth 3).Count -gt 0

    if ($hasCsproj)              { [void]$detected.Add('CSharp') }
    if ($hasPs)                  { [void]$detected.Add('PowerShell') }
    if ($hasTs)                  { [void]$detected.Add('TypeScript') }
    if ($hasCsproj -and $hasAppSets) { [void]$detected.Add('ASP.NET') }

    return @($detected | Sort-Object)
}

function Read-GitDefaultsLanguageSelection {
    <#
    .SYNOPSIS
        Prompt the user to pick languages when -Language was not supplied.
    .DESCRIPTION
        Used only when the host is interactive (Read-Host available). Pre-
        selects languages detected via Get-GitDefaultsDetectedLanguages.
        Non-interactive hosts return $null so the caller can throw with the
        explicit-parameter guidance.
    #>
    [CmdletBinding()]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive picker output.')]
    [OutputType([string[]])]
    param()

    if (-not [Environment]::UserInteractive -or $Host.Name -eq 'Default Host') {
        return $null
    }

    $detected = Get-GitDefaultsDetectedLanguages
    $supported = @($script:GitDefaultsLanguages.Keys | Sort-Object)

    Write-Host ''
    Write-Host 'Select languages to include (press Enter to accept the detected default):' -ForegroundColor Cyan
    if ($detected.Count -gt 0) {
        Write-Host ("  Detected: {0}" -f ($detected -join ', ')) -ForegroundColor Cyan
    } else {
        Write-Host '  Detected: (none -- nothing in this tree matches the heuristics)' -ForegroundColor DarkYellow
    }
    Write-Host ("  Supported: {0}" -f ($supported -join ', ')) -ForegroundColor DarkGray
    $defaultCsv = if ($detected.Count -gt 0) { $detected -join ',' } else { '' }
    $reply = Read-Host -Prompt "Languages (comma-separated) [$defaultCsv]"
    if ([string]::IsNullOrWhiteSpace($reply)) {
        return $detected
    }
    return @(($reply -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Initialize-GitDefaults {
    <#
    .SYNOPSIS
        Compose `.gitattributes` and/or `.gitignore` from upstream templates.
    .DESCRIPTION
        See script header for full description, sources, and authority labels.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string[]] $Language,
        [switch]   $IncludeGitignore,
        [switch]   $IncludeGitattributes,
        [string]   $GitattributesRef = 'fddc586cf0f10ec4485028d0d2dd6f73197a4258',
        [string]   $GitignoreRef     = 'dcc0fc7bc2b5ba480cf117ad1be31bafceeaff46',
        [switch]   $Refresh,
        [switch]   $Force
    )

    # Default both switches to on when neither is supplied.
    if (-not $PSBoundParameters.ContainsKey('IncludeGitignore') -and
        -not $PSBoundParameters.ContainsKey('IncludeGitattributes')) {
        $IncludeGitignore     = $true
        $IncludeGitattributes = $true
    }
    elseif (-not $PSBoundParameters.ContainsKey('IncludeGitignore')) {
        $IncludeGitignore = $true
    }
    elseif (-not $PSBoundParameters.ContainsKey('IncludeGitattributes')) {
        $IncludeGitattributes = $true
    }

    if (-not (Test-GitDefaultsRepo)) {
        throw "Current directory is not a git repository. Run 'git init' first or cd into a repo."
    }

    if ($Refresh) {
        # Honest stance: -Refresh is reserved for the network-fetch path,
        # which is not implemented in this release. Hard-fail rather than
        # silently emitting bundled content under a "refreshed" header
        # (which would mislead consumers about the actual source).
        throw '-Refresh (network fetch from upstream at -GitattributesRef/-GitignoreRef) is not yet implemented. Omit -Refresh to compose from the bundled snapshots, or open an issue to prioritise the fetch path.'
    }

    # Guard against header drift when consumers override the pinned refs:
    # the bundled snapshots are pinned to specific SHAs, so we cannot
    # honestly claim a different ref in the header without fetching.
    $defaultGitattrRef = 'fddc586cf0f10ec4485028d0d2dd6f73197a4258'
    $defaultGitignoreRef = 'dcc0fc7bc2b5ba480cf117ad1be31bafceeaff46'
    if ($GitattributesRef -ne $defaultGitattrRef -or $GitignoreRef -ne $defaultGitignoreRef) {
        throw "Overriding -GitattributesRef or -GitignoreRef requires -Refresh to actually fetch that ref, and -Refresh is not yet implemented. Use the pinned defaults ($defaultGitattrRef / $defaultGitignoreRef)."
    }

    if (-not $Language -or $Language.Count -eq 0) {
        $Language = Read-GitDefaultsLanguageSelection
        if (-not $Language -or $Language.Count -eq 0) {
            throw 'No -Language supplied. Pass -Language with one or more of: ' +
                  (($script:GitDefaultsLanguages.Keys | Sort-Object) -join ', ') + '.'
        }
    }

    $expanded = Resolve-GitDefaultsLanguages -Language $Language
    Write-Verbose ("Resolved languages: {0}" -f ($expanded -join ', '))

    # Preflight: check existence of ALL requested targets before writing
    # any file, so we never leave a partial result when -Force is omitted.
    if (-not $Force) {
        $existing = @()
        if ($IncludeGitattributes -and (Test-Path -LiteralPath '.gitattributes')) { $existing += '.gitattributes' }
        if ($IncludeGitignore     -and (Test-Path -LiteralPath '.gitignore'))     { $existing += '.gitignore' }
        if ($existing.Count -gt 0) {
            throw ("Aborting: {0} already exists. Re-run with -Force to back up and overwrite." -f ($existing -join ', '))
        }
    }

    if ($IncludeGitattributes) {
        $content = New-GitAttributesContent -Language $expanded
        Write-GitDefaultsFile -Path '.gitattributes' -Content $content -Force:$Force
        if (-not $WhatIfPreference) { Write-Host "Wrote .gitattributes ($($expanded -join ', '))" -ForegroundColor Green }
    }
    if ($IncludeGitignore) {
        $content = New-GitIgnoreContent -Language $expanded
        Write-GitDefaultsFile -Path '.gitignore' -Content $content -Force:$Force
        if (-not $WhatIfPreference) { Write-Host "Wrote .gitignore ($($expanded -join ', '))" -ForegroundColor Green }
    }
}

# Skip the rest when dot-sourced (e.g. by tests).
if ($MyInvocation.InvocationName -eq '.') { return }

$invokeArgs = @{
    GitattributesRef = $GitattributesRef
    GitignoreRef     = $GitignoreRef
    Refresh          = [bool]$Refresh
    Force            = [bool]$Force
    WhatIf           = [bool]$WhatIfPreference
}
if ($PSBoundParameters.ContainsKey('Language'))             { $invokeArgs.Language             = $Language }
if ($PSBoundParameters.ContainsKey('IncludeGitignore'))     { $invokeArgs.IncludeGitignore     = [bool]$IncludeGitignore }
if ($PSBoundParameters.ContainsKey('IncludeGitattributes')) { $invokeArgs.IncludeGitattributes = [bool]$IncludeGitattributes }

Initialize-GitDefaults @invokeArgs

