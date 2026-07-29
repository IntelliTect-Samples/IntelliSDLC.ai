#Requires -Version 7.0
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
    SHAs and used by default. Pass `-Refresh` to fetch fresh copies from
    GitHub raw at the requested refs into a local cache and use those
    instead (with cache fallback if the network is unavailable).

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
    Git SHA in alexkaratarakis/gitattributes used when fetching with
    `-Refresh`. The bundled snapshot is pinned to this same SHA by default;
    overriding it without `-Refresh` is allowed (the header still names this
    ref) but the on-disk bytes come from the bundled snapshot.

.PARAMETER GitignoreRef
    Git SHA in github/gitignore used when fetching with `-Refresh`. Same
    bundled-vs-fetched semantics as `-GitattributesRef`.

.PARAMETER Refresh
    Fetch fresh copies of each upstream template file from
    `raw.githubusercontent.com/<repo>/<ref>/<file>` into the local cache
    (`$env:LOCALAPPDATA/IntelliSDLC.ai/git-defaults-cache/`) and compose
    from those instead of the bundled snapshots. Falls back to the cached
    copy if a fetch fails. Generated-file headers say "fetched from
    upstream" when this is set, "bundled snapshot" otherwise. Note: the
    curated PowerShell block is always emitted in-script and is unaffected
    by `-Refresh`.

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

.EXAMPLE
    ./Initialize-GitDefaults.ps1 -Language CSharp,PowerShell -Refresh -Force
    # Fetch upstream templates fresh from raw.githubusercontent.com at the
    # pinned SHAs into the local cache, then compose .gitattributes and
    # .gitignore from them.
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

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ----- Constants -----------------------------------------------------------

# Canonical language registry. Order of `Sections` controls divider naming.
# `Deps` lists languages this one depends on (transitively expanded).
$script:GitDefaultsLanguages = [ordered]@{
    'CSharp'     = @{ Canonical = 'CSharp';     Deps = @();         GitattrFile = 'CSharp.gitattributes'; GitignoreFile = 'VisualStudio.gitignore' }
    'PowerShell' = @{ Canonical = 'PowerShell'; Deps = @();         GitattrFile = $null;                  GitignoreFile = $null }
    'TypeScript' = @{ Canonical = 'TypeScript'; Deps = @();         GitattrFile = 'Web.gitattributes';    GitignoreFile = 'Node.gitignore' }
    'ASP.NET'    = @{ Canonical = 'ASP.NET';    Deps = @('CSharp'); GitattrFile = $null;                  GitignoreFile = $null }
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

# Always-emitted curated block for IntelliSDLC.ai-required paths. These
# entries used to reach consumers via Pull-SDLC.ai's union-merge of
# .gitignore; once Initialize-GitDefaults.ps1 replaces the consumer's
# .gitignore (with -Force) those entries would disappear and tracked
# generated artifacts would slip into commits. Emitted regardless of
# language selection. Copilot review #161 round 9.
$script:CuratedIntelliSDLCGitignore = @'
# IntelliSDLC.ai-required (always emitted by Initialize-GitDefaults.ps1
# so that running this script with -Force after a Pull-SDLC.ai sync does
# not strip these entries from the consumer's .gitignore). See Pull-SDLC.ai.ps1
# and .github/skills/evidence-capture/SKILL.md.
.evidence/
.playwright-mcp/
.worktrees/
testResults.xml
'@

# Authority labels surfaced in file headers and SOURCES.md.
$script:GitattributesAuthority = 'community de facto; no GitHub-org source exists'
$script:GitignoreAuthority     = 'GitHub-org authoritative'

# Pinned SHA defaults. Mirror the top-level param defaults so internal
# composers can be called without explicit refs (tests, library use).
$script:DefaultGitattributesRef = 'fddc586cf0f10ec4485028d0d2dd6f73197a4258'
$script:DefaultGitignoreRef     = 'dcc0fc7bc2b5ba480cf117ad1be31bafceeaff46'

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
        # Reject empty/whitespace inputs explicitly. Silently skipping
        # them lets `-Language ''` or `-Language @('')` slip past
        # validation and compose an empty selection. Copilot review #161
        # round 9.
        if ([string]::IsNullOrWhiteSpace($lang)) {
            $supported = ($script:GitDefaultsLanguages.Keys | Sort-Object) -join ', '
            throw "Language entries must be non-empty. Supported languages: $supported."
        }
        $trimmed = $lang.Trim()
        $key = $trimmed.ToLowerInvariant()
        if (-not $canonicalMap.ContainsKey($key)) {
            $supported = ($script:GitDefaultsLanguages.Keys | Sort-Object) -join ', '
            throw "Unknown language '$trimmed'. Supported languages: $supported."
        }
        $canonical = $canonicalMap[$key]
        [void]$resolved.Add($canonical)
        foreach ($dep in $script:GitDefaultsLanguages[$canonical].Deps) {
            [void]$resolved.Add($dep)
        }
    }
    if ($resolved.Count -eq 0) {
        $supported = ($script:GitDefaultsLanguages.Keys | Sort-Object) -join ', '
        throw "No valid languages were supplied. Supported languages: $supported."
    }
    return @($resolved | Sort-Object)
}

function Get-GitDefaultsCacheRoot {
    <#
    .SYNOPSIS
        Local on-disk cache for fetched upstream snapshots.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA }
            elseif ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME }
            elseif ($env:HOME) { Join-Path $env:HOME '.cache' }
            else { [System.IO.Path]::GetTempPath() }
    return (Join-Path $base 'IntelliSDLC.ai/git-defaults-cache')
}

function Resolve-GitDefaultsSourceRepo {
    <#
    .SYNOPSIS
        Map a template file name to (Repo, Ref) using the supplied defaults.
        '.gitattributes' files come from alexkaratarakis/gitattributes;
        '.gitignore' files come from github/gitignore.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)] [string] $FileName,
        [Parameter(Mandatory)] [string] $GitattributesRef,
        [Parameter(Mandatory)] [string] $GitignoreRef
    )
    if ($FileName -like '*.gitattributes') {
        return @{ Repo = 'alexkaratarakis/gitattributes'; Ref = $GitattributesRef }
    }
    if ($FileName -like '*.gitignore') {
        return @{ Repo = 'github/gitignore'; Ref = $GitignoreRef }
    }
    throw "Cannot infer source repo for template file '$FileName' (expected *.gitattributes or *.gitignore)."
}

function Get-GitDefaultsRefreshedContent {
    <#
    .SYNOPSIS
        Fetch a template file from raw.githubusercontent.com at the requested
        ref, write it to the local cache, and return its content. Falls back
        to a previously-cached copy if the network fetch fails.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidOverwritingBuiltInCmdlets', '', Justification = 'Helper internal to this script.')]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $FileName,
        [Parameter(Mandatory)] [string] $Repo,
        [Parameter(Mandatory)] [string] $Ref
    )
    $cacheDir  = Join-Path (Get-GitDefaultsCacheRoot) "$Repo/$Ref"
    $cachePath = Join-Path $cacheDir $FileName
    $cacheParent = Split-Path -Parent $cachePath
    $url = "https://raw.githubusercontent.com/$Repo/$Ref/$FileName"
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -ErrorAction Stop
    } catch {
        # Fetch failed -- fall back to a previously-cached copy if any.
        if (Test-Path -LiteralPath $cachePath) {
            Write-Warning "Refresh fetch failed ($($_.Exception.Message)); using cached copy at $cachePath."
            return (Get-Content -LiteralPath $cachePath -Raw)
        }
        throw "Refresh of '$FileName' from $url failed and no cached copy exists at $cachePath. Original error: $($_.Exception.Message)"
    }
    $content = if ($resp.Content -is [byte[]]) {
        [System.Text.Encoding]::UTF8.GetString($resp.Content)
    } else {
        [string]$resp.Content
    }
    # The fetch succeeded -- always return the fresh content even if we
    # cannot persist it. Cache update failures must NOT discard a good
    # download or be silently replaced with a stale cached copy. Copilot
    # review #161 round 6.
    if ($PSCmdlet.ShouldProcess($cachePath, "Cache fetched template")) {
        try {
            if (-not (Test-Path -LiteralPath $cacheParent)) {
                New-Item -ItemType Directory -Force -Path $cacheParent -ErrorAction Stop | Out-Null
            }
            [System.IO.File]::WriteAllText($cachePath, $content, [System.Text.UTF8Encoding]::new($false))
        } catch {
            Write-Warning "Refresh fetched '$FileName' but failed to update the cache at $cachePath ($($_.Exception.Message)); returning the freshly fetched content."
        }
    }
    return $content
}

function Get-GitDefaultsTemplateContent {
    <#
    .SYNOPSIS
        Return the body of a template file -- either the bundled snapshot
        (default) or a fresh copy fetched from upstream when -Refresh is set.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $FileName,
        [string] $GitattributesRef,
        [string] $GitignoreRef,
        [switch] $Refresh
    )
    if ($Refresh) {
        $src = Resolve-GitDefaultsSourceRepo -FileName $FileName -GitattributesRef $GitattributesRef -GitignoreRef $GitignoreRef
        return (Get-GitDefaultsRefreshedContent -FileName $FileName -Repo $src.Repo -Ref $src.Ref)
    }
    $path = Join-Path (Get-GitDefaultsTemplateRoot) $FileName
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Bundled template snapshot not found: $path. Re-pull IntelliSDLC.ai (Pull-SDLC.ai.ps1) to restore the .github/templates/git-defaults/ snapshots, or pass -Refresh to fetch from upstream."
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
        [string] $GitattributesRef = $script:DefaultGitattributesRef,
        [string] $GitignoreRef     = $script:DefaultGitignoreRef,
        [string] $GibootstrapNote,
        [ValidateSet('bundled','fetched')] [string] $SourceMode = 'bundled'
    )
    $iso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $langList = ($Language -join ', ')
    $hasPs = $Language -contains 'PowerShell'
    $modeLabel = if ($SourceMode -eq 'fetched') { 'fetched from upstream' } else { 'bundled snapshot' }

    $lines = [System.Collections.Generic.List[string]]::new()
    [void]$lines.Add("# Generated by Initialize-GitDefaults.ps1 on $iso")
    [void]$lines.Add("# Languages: $langList")
    [void]$lines.Add("# Source mode: $modeLabel")
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
        if ($Kind -eq 'gitattributes') {
            # alexkaratarakis/gitattributes DOES ship PowerShell.gitattributes;
            # we intentionally override it with a smaller curated block.
            [void]$lines.Add('# Curated additions: PowerShell (intentional override of upstream PowerShell.gitattributes; see SOURCES.md)')
        } else {
            # github/gitignore does NOT ship a PowerShell.gitignore at the
            # pinned SHA; the curated block fills that gap.
            [void]$lines.Add('# Curated additions: PowerShell (no upstream PowerShell.gitignore exists in github/gitignore; see SOURCES.md)')
        }
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
        [Parameter(Mandatory)] [string[]] $Language,
        [string] $GitattributesRef = $script:DefaultGitattributesRef,
        [string] $GitignoreRef = $script:DefaultGitignoreRef,
        [switch] $Refresh
    )
    $expanded = Resolve-GitDefaultsLanguages -Language $Language
    $fetchSplat = @{ GitattributesRef = $GitattributesRef; GitignoreRef = $GitignoreRef; Refresh = [bool]$Refresh }

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

    $header = New-GitDefaultsHeader -Kind 'gitattributes' -Language $expanded -UpstreamSections $upstreamSections -GitattributesRef $GitattributesRef -GitignoreRef $GitignoreRef -SourceMode $(if ($Refresh) { 'fetched' } else { 'bundled' })

    $body = [System.Collections.Generic.List[string]]::new()
    [void]$body.Add($header)
    [void]$body.Add((New-GitDefaultsSectionDivider -Section 'Common' -SourceLabel 'Common.gitattributes'))
    [void]$body.Add((Get-GitDefaultsTemplateContent -FileName 'Common.gitattributes' @fetchSplat))

    $emitted = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($lang in $expanded) {
        $entry = $script:GitDefaultsLanguages[$lang]
        if ($entry.GitattrFile -and $emitted.Add($entry.GitattrFile)) {
            $section = [System.IO.Path]::GetFileNameWithoutExtension($entry.GitattrFile)
            [void]$body.Add((New-GitDefaultsSectionDivider -Section $section -SourceLabel $entry.GitattrFile))
            [void]$body.Add((Get-GitDefaultsTemplateContent -FileName $entry.GitattrFile @fetchSplat))
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
        [Parameter(Mandatory)] [string[]] $Language,
        [string] $GitattributesRef = $script:DefaultGitattributesRef,
        [string] $GitignoreRef = $script:DefaultGitignoreRef,
        [switch] $Refresh
    )
    $expanded = Resolve-GitDefaultsLanguages -Language $Language
    $fetchSplat = @{ GitattributesRef = $GitattributesRef; GitignoreRef = $GitignoreRef; Refresh = [bool]$Refresh }

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

    $header = New-GitDefaultsHeader -Kind 'gitignore' -Language $expanded -UpstreamSections $upstreamSections -GitattributesRef $GitattributesRef -GitignoreRef $GitignoreRef -SourceMode $(if ($Refresh) { 'fetched' } else { 'bundled' })

    $body = [System.Collections.Generic.List[string]]::new()
    [void]$body.Add($header)

    $emitted = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($lang in $expanded) {
        $entry = $script:GitDefaultsLanguages[$lang]
        if ($entry.GitignoreFile -and $emitted.Add($entry.GitignoreFile)) {
            $section = [System.IO.Path]::GetFileNameWithoutExtension($entry.GitignoreFile)
            [void]$body.Add((New-GitDefaultsSectionDivider -Section $section -SourceLabel $entry.GitignoreFile))
            [void]$body.Add((Get-GitDefaultsTemplateContent -FileName $entry.GitignoreFile @fetchSplat))
        } elseif ($lang -eq 'PowerShell') {
            [void]$body.Add((New-GitDefaultsSectionDivider -Section 'PowerShell' -SourceLabel 'curated in-script'))
            [void]$body.Add($script:CuratedPowerShellGitignore)
        }
    }
    # Cross-platform editor/OS backup patterns, appended once.
    if ($emitted.Add($backupFile)) {
        [void]$body.Add((New-GitDefaultsSectionDivider -Section 'Global/Backup' -SourceLabel $backupFile))
        [void]$body.Add((Get-GitDefaultsTemplateContent -FileName $backupFile @fetchSplat))
    }
    # IntelliSDLC.ai-required block (Copilot review #161 round 9). Always
    # emitted so a -Force run does not strip entries that Pull-SDLC.ai's
    # union-merge would have put in place.
    [void]$body.Add((New-GitDefaultsSectionDivider -Section 'IntelliSDLC.ai' -SourceLabel 'curated in-script'))
    [void]$body.Add($script:CuratedIntelliSDLCGitignore)
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

    # Files installed by IntelliSDLC.ai itself that must NOT signal
    # consumer language usage (Copilot review #161 round 7). A consumer
    # who has only synced this tooling but writes no PowerShell of their
    # own should not have PowerShell pre-selected.
    $ownPsFiles = @(
        'Pull-SDLC.ai.ps1', 'Pull-SDLC.ai.Tests.ps1',
        'Initialize-GitDefaults.ps1', 'Initialize-GitDefaults.Tests.ps1',
        'Cleanup-Worktree.ps1',
        'Consolidate-Tasks.ps1', 'Consolidate-Tasks.Tests.ps1',
        'run.ps1', 'run.Tests.ps1'
    )
    $isOwnPs = { param($f)
        # Only filter at the repo root -- IntelliSDLC.ai tools never live
        # in subdirectories of the consumer repo. Normalize the path
        # separator: GetRelativePath emits backslashes on Windows so the
        # `.github/` match must accept both. Copilot review #161 round 8.
        $rel = [System.IO.Path]::GetRelativePath($Path, $f.FullName) -replace '\\','/'
        ($ownPsFiles -contains $rel) -or ($rel -like '.github/*')
    }

    $hasCsproj   = @(Get-ChildItem -Path $Path -Recurse -File -Include '*.csproj','*.sln','*.slnx' -ErrorAction SilentlyContinue -Depth 3).Count -gt 0
    $psFiles     = @(Get-ChildItem -Path $Path -Recurse -File -Include '*.ps1','*.psm1','*.psd1' -ErrorAction SilentlyContinue -Depth 3 | Where-Object { -not (& $isOwnPs $_) })
    $hasPs       = $psFiles.Count -gt 0
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

    if (-not $IncludeGitignore -and -not $IncludeGitattributes) {
        # Both targets explicitly disabled => the script has nothing to do.
        # Treat as an automation/configuration error, not a silent success.
        # Copilot review #161 round 9.
        throw "Both -IncludeGitignore and -IncludeGitattributes are disabled; nothing to generate. Enable at least one."
    }

    if (-not (Test-GitDefaultsRepo)) {
        throw "Current directory is not a git repository. Run 'git init' first or cd into a repo."
    }

    # Resolve to the repository top-level so a subdirectory invocation
    # (./../Initialize-GitDefaults.ps1, or run from within tests/, src/,
    # etc.) writes a single root-level .gitattributes / .gitignore pair
    # instead of nested files alongside cwd. Copilot review #161 round 9.
    $repoRoot = (& git rev-parse --show-toplevel 2>$null)
    if (-not $repoRoot) {
        throw "Unable to resolve repository root via 'git rev-parse --show-toplevel'."
    }
    $repoRoot = $repoRoot.Trim()
    if ((Resolve-Path -LiteralPath $repoRoot).Path -ne (Resolve-Path -LiteralPath (Get-Location).Path).Path) {
        Write-Verbose "Operating on repository root '$repoRoot' (invoked from '$((Get-Location).Path)')."
    }
    Push-Location -LiteralPath $repoRoot
    try {

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

    $composeSplat = @{ GitattributesRef = $GitattributesRef; GitignoreRef = $GitignoreRef; Refresh = [bool]$Refresh }

    # Compose ALL requested outputs before writing ANY, so a failure
    # during the second compose (network/cache miss under -Refresh,
    # template-snapshot-missing, etc.) leaves the repo unchanged rather
    # than half-updated. Copilot review #161 round 5.
    $pending = [ordered]@{}
    if ($IncludeGitattributes) {
        $pending['.gitattributes'] = New-GitAttributesContent -Language $expanded @composeSplat
    }
    if ($IncludeGitignore) {
        $pending['.gitignore'] = New-GitIgnoreContent -Language $expanded @composeSplat
    }

    foreach ($path in $pending.Keys) {
        Write-GitDefaultsFile -Path $path -Content $pending[$path] -Force:$Force
        if (-not $WhatIfPreference) {
            Write-Host "Wrote $path ($($expanded -join ', '))" -ForegroundColor Green
        }
    }
    } finally { Pop-Location }
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

