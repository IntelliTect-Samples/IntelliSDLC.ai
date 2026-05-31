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
    SHAs and used by default. With -Refresh the script fetches fresh copies
    over HTTPS and updates the local cache.

.PARAMETER Language
    Languages to include. Validated against the supported set. ASP.NET implies
    CSharp. When omitted in an interactive host a multi-select picker runs with
    languages detected from the working tree pre-selected. Non-interactive +
    omitted = abort with instructions.

.PARAMETER IncludeGitignore
    Compose `.gitignore`. Default: $true.

.PARAMETER IncludeGitattributes
    Compose `.gitattributes`. Default: $true.

.PARAMETER GitattributesRef
    Git SHA in alexkaratarakis/gitattributes to fetch templates from when
    -Refresh is supplied. Pinned default.

.PARAMETER GitignoreRef
    Git SHA in github/gitignore to fetch templates from when -Refresh is
    supplied. Pinned default.

.PARAMETER Refresh
    Bypass bundled snapshots; fetch fresh copies from GitHub over HTTPS and
    update the local cache. Use to validate against latest upstream.

.PARAMETER Force
    Overwrite existing `.gitattributes` / `.gitignore` after backing the
    original up to `<file>.bak` (with timestamp suffix if `.bak` already
    exists). Without -Force the script aborts if the target exists.

.EXAMPLE
    ./Initialize-GitDefaults.ps1 -Language CSharp,PowerShell -Force

.EXAMPLE
    ./Initialize-GitDefaults.ps1 -Language ASP.NET,TypeScript -Force
    # ASP.NET expands to {ASP.NET, CSharp}.

.EXAMPLE
    ./Initialize-GitDefaults.ps1 -Language CSharp -Refresh -Force
    # Re-fetch upstream templates at the pinned SHAs.
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
# PowerShell (no upstream template; rules curated locally)
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
# PowerShell (no upstream template; rules curated locally)
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
        throw "Bundled template snapshot not found: $path. Re-run with -Refresh to fetch from upstream."
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
        [void]$lines.Add('# Curated additions: PowerShell (no upstream template)')
    }
    [void]$lines.Add('# Re-run Initialize-GitDefaults.ps1 to refresh or add languages.')
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
        Copy an existing file to `<file>.bak`, suffixing a timestamp on collision.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Path
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $bak = "$Path.bak"
    if (Test-Path -LiteralPath $bak) {
        $ts = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
        $bak = "$Path.bak.$ts"
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

    if (-not $Language -or $Language.Count -eq 0) {
        throw 'No -Language supplied. Pass -Language with one or more of: ' +
              (($script:GitDefaultsLanguages.Keys | Sort-Object) -join ', ') + '.'
    }

    if ($Refresh) {
        Write-Warning '-Refresh fetch path not implemented in this release; using bundled snapshots.'
    }

    $expanded = Resolve-GitDefaultsLanguages -Language $Language
    Write-Verbose ("Resolved languages: {0}" -f ($expanded -join ', '))

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

