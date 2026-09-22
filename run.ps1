<#
.SYNOPSIS
    Project-agnostic script to run or test a .NET project. Auto-discovers
    projects from the solution without hardcoding directory or project names.

.DESCRIPTION
    Scans the script's directory (or the path given by -SearchPath) for
    *.sln / *.slnx, finds projects with OutputType=Exe (or WinExe), and
    launches the appropriate one via `dotnet run`. If multiple runnable
    projects exist, auto-selects using a detection chain:

      1. .vscode/launch.json  - matches projectPath to a runnable project
      2. launchSettings.json   - selects the sole project with a Project profile
      3. Interactive prompt    - asks the user; creates a launchSettings.json
                                 for the chosen project so subsequent runs
                                 auto-select via step 2

    Supports launchSettings.json profiles and pass-through args.

    To avoid needless recompilation, run mode skips the build step whenever
    no source file is newer than the project's last build output. The first
    run - or any run after a source file changes - compiles as a separate
    `dotnet build` whose output is shown live and erased once it succeeds
    WITHOUT reporting anything; a build that failed, or that emitted an error
    or warning, keeps its entire output. The restore step inside that build is
    skipped too while no project or package file has changed since the last
    restore. The application itself always starts via `dotnet run --no-build`.

    A trailing `--no-build` - the very LAST token on the command line, after
    the application's own arguments - skips the up-to-date check and the build
    for that run, for when the caller already knows the build is current. It is
    consumed by this script and never reaches the application.

    Which launch settings and profile the run uses is reported while the
    launcher works, and erased before the application's own output begins.

    Use `./run.ps1 test` to run `dotnet test` across the entire solution.
    Use `./run.ps1 help` to show the application's own help text.

    Help flags are honored only in leading position. `./run.ps1 --help` shows
    the application's root help, while `./run.ps1 mysubcommand --help` forwards
    `--help` so the application's own parser resolves the subcommand help.
    Likewise `./run.ps1 test --help` forwards to `dotnet test --help`.

.PARAMETER Command
    Optional subcommand. Use `test` to run dotnet test on the solution.
    Omit (or use `run`) to run the application.

.PARAMETER LaunchProfile
    Name of the launch profile from launchSettings.json to use (run mode only).

.PARAMETER Project
    Explicit project path to run (bypasses auto-discovery, run mode only).

.PARAMETER SearchPath
    Directory to search for solution and project files. Defaults to the
    directory containing this script ($PSScriptRoot).

.PARAMETER Args
    Additional arguments passed through to the application (after `--`)
    or to `dotnet test` (when using `test` command). Tokens are forwarded
    verbatim; unquoted comma-separated values such as `--to a,b` survive
    intact rather than being joined with a space.

.EXAMPLE
    ./run.ps1
    ./run.ps1 -- --dry-run
    ./run.ps1 mysubcommand
    ./run.ps1 mysubcommand --help
    ./run.ps1 mysubcommand --to a,b
    ./run.ps1 mysubcommand --to a,b --no-build
    ./run.ps1 -- mysubcommand --flag
    ./run.ps1 run -- --some-flag
    ./run.ps1 -LaunchProfile https
    ./run.ps1 -Project src/MyApp/MyApp.csproj
    ./run.ps1 -SearchPath C:\Projects\MyApp
    ./run.ps1 help
    ./run.ps1 test
    ./run.ps1 test --verbosity detailed
    ./run.ps1 test --filter "FullyQualifiedName~MyTests"
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command,
    [string]$LaunchProfile,
    [string]$Project,
    [string]$SearchPath,
    [Parameter(ValueFromRemainingArguments)]
    [object[]]$Args
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Reserved subcommands handled by this script itself (not forwarded to the app).
$ReservedCommands = @('run', 'test', 'help')

# Resolve search root: where to look for solutions and projects
$SearchRoot = if ($SearchPath) { (Resolve-Path $SearchPath).Path } else { $PSScriptRoot }
if (-not $SearchRoot) { $SearchRoot = (Get-Location).Path }

function Find-Solution {
    $slnFiles = @(Get-ChildItem -Path $SearchRoot -Filter '*.sln' -File) +
                @(Get-ChildItem -Path $SearchRoot -Filter '*.slnx' -File)
    if ($slnFiles.Count -eq 0) {
        return $null
    }
    return $slnFiles[0]
}

function Get-PropertyValue {
    <#
    .SYNOPSIS
        Strict-mode-safe property accessor for PSCustomObject / hashtable values
        produced by ConvertFrom-Json. Returns $null if the property is absent.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $InputObject) { return $null }

    $psObj = $InputObject.PSObject
    if (-not $psObj) { return $null }

    $prop = $psObj.Properties[$Name]
    if (-not $prop) { return $null }

    return $prop.Value
}

# Directory names never searched for projects or sources: build output,
# version-control metadata, other checkouts, and package trees.
$script:PrunedDirectoryNames = @('bin', 'obj', '.git', '.worktrees', '.vs', 'node_modules')

function Get-TreeFile {
    <#
    .SYNOPSIS
        Enumerates files under $Root whose extension is in $Extension or whose
        name is in $FileName, never descending into a pruned directory
        (bin, obj, .git, .worktrees, .vs, node_modules).
    .DESCRIPTION
        Pruning happens DURING the walk (issue #519). Filtering the output of
        Get-ChildItem -Recurse still enumerates every excluded file first: in a
        consumer whose .worktrees/ held 270k of its 278k files, project
        discovery plus the build check took ~65s that way, and ~0.2s pruned.

        Only directories BELOW $Root are matched against the pruned names, never
        $Root itself, so a checkout that lives under .worktrees/ is still
        searched (issue #233).

        Directory reparse points (symlinks, junctions) are not followed --
        Get-ChildItem -Recurse does not follow them either -- so a link cycle
        cannot hang the walk. Unreadable directories are skipped.
    #>
    [OutputType([System.IO.FileInfo])]
    param(
        [Parameter(Mandatory)][string]$Root,
        [string[]]$Extension = @(),
        [string[]]$FileName = @()
    )

    $ignoreCase = [System.StringComparer]::OrdinalIgnoreCase
    $pruned = [System.Collections.Generic.HashSet[string]]::new([string[]]$script:PrunedDirectoryNames, $ignoreCase)
    $extensions = [System.Collections.Generic.HashSet[string]]::new([string[]]$Extension, $ignoreCase)
    $names = [System.Collections.Generic.HashSet[string]]::new([string[]]$FileName, $ignoreCase)

    $pending = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
    $pending.Push([System.IO.DirectoryInfo]::new($Root))
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        try {
            foreach ($entry in $directory.EnumerateFileSystemInfos()) {
                if ($entry -is [System.IO.DirectoryInfo]) {
                    $isLink = ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
                    if (-not $isLink -and -not $pruned.Contains($entry.Name)) { $pending.Push($entry) }
                }
                elseif ($extensions.Contains($entry.Extension) -or $names.Contains($entry.Name)) {
                    $entry
                }
            }
        }
        catch [System.IO.IOException], [System.UnauthorizedAccessException], [System.Security.SecurityException] {
            continue
        }
    }
}

function Find-RunnableProjects {
    $csprojFiles = Get-TreeFile -Root $SearchRoot -Extension '.csproj'
    $runnable = @()
    foreach ($csproj in $csprojFiles) {
        $content = Get-Content $csproj.FullName -Raw
        if ($content -match '<OutputType>\s*(Exe|WinExe)\s*</OutputType>') {
            $runnable += $csproj
        }
    }
    return $runnable
}

function Resolve-LaunchProfile {
    <#
    .SYNOPSIS
        Resolves which launchSettings.json profile the run will use, returning
        its file Path, its Name, and the Argument list for `dotnet run`.
    .DESCRIPTION
        Path and Name exist so the launcher can SAY which launch settings it is
        about to use (issue #521). `dotnet run` used to announce that itself
        ("Using launch settings from ..."), and --verbosity quiet silenced it;
        the launcher now reports it transiently instead, during the preamble.

        All three are $null/empty when the project has no launchSettings.json,
        no profile matches, or a named profile is missing -- the same cases in
        which no --launch-profile argument is passed.
    #>
    param([string]$ProjectDir, [string]$ProfileName)

    # [string[]] so Argument is an empty array rather than the $null a bare @()
    # becomes when a hashtable is converted to a pscustomobject.
    $empty = [pscustomobject]@{ Path = $null; Name = $null; Argument = [string[]]@() }

    $launchSettingsPath = Join-Path $ProjectDir 'Properties' 'launchSettings.json'
    if (-not (Test-Path $launchSettingsPath)) { return $empty }

    $settings = Get-Content $launchSettingsPath -Raw | ConvertFrom-Json
    $profiles = Get-PropertyValue $settings 'profiles'
    if (-not $profiles) { return $empty }

    $profile = $null

    if ($ProfileName) {
        $profile = Get-PropertyValue $profiles $ProfileName
        if (-not $profile) {
            Write-Warning "Launch profile '$ProfileName' not found in $launchSettingsPath"
            return $empty
        }
    }
    else {
        # Find first profile with commandName=Project
        foreach ($name in $profiles.PSObject.Properties.Name) {
            $p = $profiles.$name
            if ((Get-PropertyValue $p 'commandName') -eq 'Project') {
                $profile = $p
                $ProfileName = $name
                break
            }
        }
    }

    if (-not $profile) { return $empty }

    return [pscustomobject]@{
        Path     = $launchSettingsPath
        Name     = $ProfileName
        Argument = @('--launch-profile', $ProfileName)
    }
}

function Get-LaunchProfileArgs {
    <#
    .SYNOPSIS
        The `dotnet run` arguments for the resolved launch profile, or an empty
        array. Kept as its own function because a consumer hook may override it.
    #>
    param([string]$ProjectDir, [string]$ProfileName)

    return , @((Resolve-LaunchProfile -ProjectDir $ProjectDir -ProfileName $ProfileName).Argument)
}

function Select-Project {
    param([System.IO.FileInfo[]]$Projects)

    Write-Host ''
    Write-Host 'Multiple runnable projects found:' -ForegroundColor Cyan
    for ($i = 0; $i -lt $Projects.Count; $i++) {
        $relativePath = [System.IO.Path]::GetRelativePath($SearchRoot, $Projects[$i].FullName)
        Write-Host "  [$($i + 1)] $relativePath" -ForegroundColor White
    }
    Write-Host ''
    do {
        $choice = Read-Host "Select a project (1-$($Projects.Count))"
        $index = 0
        $valid = [int]::TryParse($choice, [ref]$index) -and $index -ge 1 -and $index -le $Projects.Count
        if (-not $valid) {
            Write-Host "  Invalid selection. Enter a number between 1 and $($Projects.Count)." -ForegroundColor Yellow
        }
    } while (-not $valid)

    return $Projects[$index - 1]
}

function Test-HasLaunchSettings {
    <#
    .SYNOPSIS
        Returns $true if the project has a launchSettings.json with a Project profile.
    #>
    param([System.IO.FileInfo]$ProjectFile)

    $launchSettingsPath = Join-Path $ProjectFile.DirectoryName 'Properties' 'launchSettings.json'
    if (-not (Test-Path $launchSettingsPath)) { return $false }

    $settings = Get-Content $launchSettingsPath -Raw | ConvertFrom-Json
    $profiles = Get-PropertyValue $settings 'profiles'
    if (-not $profiles) { return $false }

    foreach ($name in $profiles.PSObject.Properties.Name) {
        if ((Get-PropertyValue $profiles.$name 'commandName') -eq 'Project') {
            return $true
        }
    }
    return $false
}

function Ensure-LaunchSettings {
    <#
    .SYNOPSIS
        Creates a minimal launchSettings.json for the project if one does not exist.
    #>
    param([System.IO.FileInfo]$ProjectFile)

    $propsDir = Join-Path $ProjectFile.DirectoryName 'Properties'
    $launchSettingsPath = Join-Path $propsDir 'launchSettings.json'
    if (Test-Path $launchSettingsPath) { return }

    if (-not (Test-Path $propsDir)) {
        New-Item -ItemType Directory -Path $propsDir | Out-Null
    }

    $projectName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectFile.Name)
    $json = @"
{
  "profiles": {
    "$projectName": {
      "commandName": "Project"
    }
  }
}
"@
    Set-Content -Path $launchSettingsPath -Value $json -Encoding utf8NoBOM
    $relative = [System.IO.Path]::GetRelativePath($SearchRoot, $launchSettingsPath)
    Write-Host "Created $relative so this project is auto-selected on next run." -ForegroundColor DarkGray
}

function Find-VsCodeLaunchProject {
    <#
    .SYNOPSIS
        Reads .vscode/launch.json and returns the runnable project matching
        a projectPath configuration, or $null if none/ambiguous.
    #>
    param([System.IO.FileInfo[]]$Projects)

    $launchJsonPath = Join-Path $SearchRoot '.vscode' 'launch.json'
    if (-not (Test-Path $launchJsonPath)) { return $null }

    try {
        $launch = Get-Content $launchJsonPath -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }

    $configurations = Get-PropertyValue $launch 'configurations'
    if (-not $configurations) { return $null }

    foreach ($config in $configurations) {
        $projPath = Get-PropertyValue $config 'projectPath'
        if (-not $projPath) { continue }

        # Resolve ${workspaceFolder} to the search root
        $projPath = $projPath -replace '\$\{workspaceFolder\}', $SearchRoot
        $resolved = Resolve-Path $projPath -ErrorAction SilentlyContinue
        if (-not $resolved) { continue }

        foreach ($proj in $Projects) {
            if ($proj.FullName -eq $resolved.Path) {
                return $proj
            }
        }
    }

    return $null
}

function Find-LaunchSettingsProject {
    <#
    .SYNOPSIS
        Among runnable projects, returns the one with a launchSettings.json
        Project profile -- but only if exactly one has it.
    #>
    param([System.IO.FileInfo[]]$Projects)

    $withSettings = @($Projects | Where-Object { Test-HasLaunchSettings $_ })

    if ($withSettings.Count -eq 1) {
        return $withSettings[0]
    }
    return $null
}

function Get-BuiltAssembly {
    <#
    .SYNOPSIS
        Returns the most recently built output assembly (<AssemblyName>.dll) for
        a project, searching its bin directory, or $null if none has been built.
    .DESCRIPTION
        Honors an <AssemblyName> override in the project file (e.g. App.Cli.csproj
        producing app.dll) and otherwise falls back to the convention that the
        assembly name matches the project file name (App.csproj -> App.dll).
        When the resolved name still yields no output the function returns
        $null, which conservatively forces a build.
    #>
    param([System.IO.FileInfo]$ProjectFile)

    $binDir = Join-Path $ProjectFile.DirectoryName 'bin'
    if (-not (Test-Path $binDir)) { return $null }

    $assemblyName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectFile.Name)
    $projectXml = Get-Content -LiteralPath $ProjectFile.FullName -Raw -ErrorAction SilentlyContinue
    if ($projectXml -and $projectXml -match '<AssemblyName>\s*([^<$]+?)\s*</AssemblyName>') {
        $assemblyName = $Matches[1]
    }
    $candidates = @(
        Get-ChildItem -Path $binDir -Filter "$assemblyName.dll" -Recurse -File -ErrorAction SilentlyContinue
    )
    if ($candidates.Count -eq 0) { return $null }

    return $candidates | Sort-Object -Property LastWriteTimeUtc -Descending | Select-Object -First 1
}

function Get-NewestSourceWriteTime {
    <#
    .SYNOPSIS
        Returns the newest LastWriteTimeUtc among build-relevant source files
        under $Root, or $null when no such files exist.
    .DESCRIPTION
        Considers common .NET source and build files (.cs, .csproj, MSBuild
        props/targets, solution files, Razor, resources, etc.) and skips the
        pruned trees (see Get-TreeFile) so that build artifacts never make a
        project look stale.
    #>
    param([string]$Root)

    $sourceExtensions = @(
        '.cs', '.csproj', '.props', '.targets', '.sln', '.slnx',
        '.razor', '.cshtml', '.resx', '.vb', '.vbproj', '.fs', '.fsproj'
    )
    return Get-NewestWriteTime -File (Get-TreeFile -Root $Root -Extension $sourceExtensions)
}

function Get-NewestWriteTime {
    <#
    .SYNOPSIS
        Returns the newest LastWriteTimeUtc among $File, or $null when empty.
    #>
    param([AllowNull()][System.IO.FileInfo[]]$File)

    $newest = $null
    foreach ($item in @($File)) {
        if ($null -ne $item -and ($null -eq $newest -or $item.LastWriteTimeUtc -gt $newest)) {
            $newest = $item.LastWriteTimeUtc
        }
    }
    return $newest
}

# Written into the project's obj/ after a build that included restore. A
# no-op restore rewrites nothing -- not even project.assets.json -- so without
# a marker of our own a touched-but-unchanged project file would look newer
# than the last restore forever, and restore would never be skipped again.
$script:RestoreStampName = 'run.ps1.restored'

function Get-RestoreStampPath {
    param([System.IO.FileInfo]$ProjectFile)
    return Join-Path $ProjectFile.DirectoryName 'obj' $script:RestoreStampName
}

function Test-RestoreRequired {
    <#
    .SYNOPSIS
        Returns $true unless the project's last restore (as recorded by
        run.ps1) is newer than every restore input under $Root.
    .DESCRIPTION
        A restore costs ~1.5s even when it has nothing to do (issue #519), so
        the build passes --no-restore when this returns $false. Restore inputs
        are project files, MSBuild props/targets (which include
        Directory.Packages.props), nuget.config, global.json and
        packages.lock.json.

        Conservative by default: no stamp, or no project.assets.json, means a
        restore is required. A --no-restore build that still fails on missing
        restore output is retried with restore (see Test-RestoreFailure).
    #>
    param(
        [System.IO.FileInfo]$ProjectFile,
        [string]$Root
    )

    $stamp = Get-RestoreStampPath -ProjectFile $ProjectFile
    $assets = Join-Path $ProjectFile.DirectoryName 'obj' 'project.assets.json'
    if (-not (Test-Path -LiteralPath $stamp) -or -not (Test-Path -LiteralPath $assets)) { return $true }

    $inputs = Get-TreeFile -Root $Root `
        -Extension @('.csproj', '.fsproj', '.vbproj', '.props', '.targets') `
        -FileName @('nuget.config', 'global.json', 'packages.lock.json')
    $newestInput = Get-NewestWriteTime -File $inputs
    if ($null -eq $newestInput) { return $false }

    return $newestInput -gt (Get-Item -LiteralPath $stamp).LastWriteTimeUtc
}

function Save-RestoreStamp {
    <#
    .SYNOPSIS
        Records that the project was just restored. Only when obj/ already
        exists: a project whose output lives elsewhere (e.g. an artifacts
        layout) gets no stamp, and so simply keeps restoring every build.
    #>
    param([System.IO.FileInfo]$ProjectFile)

    $stamp = Get-RestoreStampPath -ProjectFile $ProjectFile
    if (-not (Test-Path -LiteralPath (Split-Path $stamp -Parent))) { return }
    Set-Content -LiteralPath $stamp -Value 'Restore output is current as of this file''s timestamp.' -Encoding utf8NoBOM
}

function Test-RestoreFailure {
    <#
    .SYNOPSIS
        Returns $true when build output shows a failure caused by missing or
        stale restore output, which a build WITH restore would fix.
    .DESCRIPTION
        NETSDK1004 assets file not found; NETSDK1005 / NETSDK1047 assets file
        lacks a target; NETSDK1064 a restored package has since been deleted.
    #>
    param([AllowNull()][string[]]$Output)

    return [bool](@($Output) -match 'NETSDK10(04|05|47|64)\b')
}

function Test-BuildDiagnostic {
    <#
    .SYNOPSIS
        Returns $true when build output contains a compiler or SDK diagnostic
        (an error or a warning), as opposed to pure progress chatter.
    .DESCRIPTION
        A build that reported nothing is erased once it succeeds; a build that
        reported something keeps its ENTIRE output on screen (issue #521), so a
        warning is never hidden by the erase.

        Matches the diagnostic CODE every MSBuild/Roslyn/SDK message carries
        before its colon -- "CS0168:", "NETSDK1004:", "MSB3021:" -- not the
        words "error" and "warning". MSBuild localizes those words through its
        satellite assemblies, so a German host prints "Warnung CS0168:" and a
        word-based test would erase a real warning there; the code does not
        change with the UI culture. Matching the code also keeps the
        "0 Warning(s)" summary line from counting as a diagnostic.
    #>
    param([AllowNull()][string[]]$Output)

    return [bool](@($Output) -match '\b[A-Za-z]{2,}\d{2,}\s*:')
}

function Get-BuildAffectingArgument {
    <#
    .SYNOPSIS
        Picks the options out of a `dotnet run` command line that change WHAT
        gets built, so the separate `dotnet build` step builds the same output
        the `dotnet run --no-build` that follows will look for.
    .DESCRIPTION
        Matters when an Invoke-ProjectPreRun hook adds, say, `-c Release`: the
        run looks for a Release build, so the build must produce one. Only
        tokens before a `--` separator are considered; after it they belong to
        the application.
    #>
    [OutputType([string[]])]
    param([AllowNull()][string[]]$DotnetArgument)

    $valued = @('-c', '--configuration', '-f', '--framework', '-r', '--runtime', '-a', '--arch', '--os')
    $tokens = @($DotnetArgument)
    $picked = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $token = $tokens[$i]
        if ($token -eq '--') { break }
        if ($token -in $valued -and $i + 1 -lt $tokens.Count) {
            $picked.Add($token)
            $picked.Add($tokens[++$i])
        }
        elseif ($token -match '^(-p|--property|/p|-property):' -or
            $token -match '^--(configuration|framework|runtime|arch|os)=') {
            $picked.Add($token)
        }
    }
    return , $picked.ToArray()
}

function Test-BuildRequired {
    <#
    .SYNOPSIS
        Returns $true when the project must be rebuilt, i.e. it has never been
        built or a source file under $Root is newer than the last build output.
    .DESCRIPTION
        Enables run mode to pass `--no-build` and skip compilation when nothing
        has changed. When the output assembly is missing (never built or cleaned)
        a rebuild is always required. When no source files are found there is
        nothing to compile, so a rebuild is not required.
    #>
    param(
        [System.IO.FileInfo]$ProjectFile,
        [string]$Root
    )

    $assembly = Get-BuiltAssembly -ProjectFile $ProjectFile
    if (-not $assembly) { return $true }

    $newestSource = Get-NewestSourceWriteTime -Root $Root
    if ($null -eq $newestSource) { return $false }

    return $newestSource -gt $assembly.LastWriteTimeUtc
}

$script:HelpFlags = @('--help', '-h', '-?')

function ConvertTo-ForwardedArgument {
    <#
    .SYNOPSIS
        Normalizes raw bound arguments into the verbatim token list forwarded to
        the child process.
    .DESCRIPTION
        PowerShell parses an unquoted comma-separated token such as `--to fb,ig`
        as an array literal @('fb','ig'). Binding that to a [string[]] parameter
        coerces the element into the single string 'fb ig' -- joined with a
        SPACE -- silently corrupting the value. Binding as [object[]] preserves
        the nested array; this function rejoins it with ',' so the token reaches
        the app exactly as the user typed it (issue #243).
    .OUTPUTS
        [string[]] one entry per original command-line token.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([object[]]$Argument)

    if (-not $Argument) { return , @() }
    return , @(foreach ($item in $Argument) {
            if ($item -is [System.Array]) { ($item -join ',') } else { [string]$item }
        })
}

function Resolve-VerbosePassthrough {
    <#
    .SYNOPSIS
        Re-injects `--verbose` into the forwarded argument list when PowerShell
        consumed the caller's `-v` before the script body ran.
    .DESCRIPTION
        `[CmdletBinding()]` gives this script the `-Verbose` common parameter,
        and PowerShell resolves the unambiguous prefix `-v` to it. So
        `./run.ps1 mycommand -v` binds -Verbose and drops `-v` from the
        remaining arguments: the application runs without verbose output and
        nothing reports that a flag was swallowed (issue #461).

        Fires only when the caller actually bound -Verbose, and is a no-op when
        a verbose flag already survived, so the flag can never be forwarded
        twice.

        Call it ONLY from the run-mode path, and only after the leading
        positional token has been folded into the argument list. See the call
        site for both reasons.

        The flag is PREPENDED. PowerShell destroyed the position information
        -- `./run.ps1 -v mycommand` and `./run.ps1 mycommand -v` arrive
        identically -- so no placement can be faithful to what the caller
        typed. Prepending is the shape proven in the consuming project this is
        backported from, and it suits a CLI whose verbose flag is a global
        option. A CLI that accepts the flag only after its subcommand is not
        served by it; such a project should handle -v itself rather than rely
        on this reconstruction.

        The parameter is $ArgList, not $Args: a parameter literally named
        $Args can be declared, but it collides with the automatic variable and
        silently binds nothing.
    .OUTPUTS
        [string[]] the argument list to forward.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [AllowNull()][string[]]$ArgList,
        [bool]$VerboseBound
    )

    if ($null -eq $ArgList) { $ArgList = @() }
    if (-not $VerboseBound) { return , $ArgList }
    if ($ArgList -contains '--verbose' -or $ArgList -contains '-v') { return , $ArgList }
    return , (@('--verbose') + $ArgList)
}

# The token that turns the build off, spelled as `dotnet run` and `dotnet test`
# spell it, and honored ONLY as the very last token on the command line.
$script:SkipBuildSwitch = '--no-build'

function Resolve-SkipBuildSwitch {
    <#
    .SYNOPSIS
        Consumes a trailing --no-build, returning whether it was present and the
        argument list without it.
    .DESCRIPTION
        Trailing position is the point (issue #521): it sits after the
        application's own arguments, so it can be appended and removed without
        touching the rest of the line -- `./run.ps1 post --to a,b --no-build`.

        Only the LAST token counts, so the same word earlier on the line still
        reaches the application. The cost, accepted and documented: an
        application whose own final argument is literally --no-build cannot be
        called without it being taken here.
    .OUTPUTS
        [pscustomobject] with SkipBuild and ArgList.
    #>
    [CmdletBinding()]
    param([AllowNull()][string[]]$ArgList)

    $tokens = @($ArgList)
    if ($tokens.Count -eq 0 -or $tokens[-1] -ne $script:SkipBuildSwitch) {
        return [pscustomobject]@{ SkipBuild = $false; ArgList = $tokens }
    }

    # NOT `$remaining = if (...) { @() } else { ... }`: a branch that yields an
    # empty array emits NOTHING to the pipeline, so the assignment lands $null
    # and `.ArgList.Count` on a fully consumed line throws under StrictMode.
    # Assigning the empty array directly keeps it an empty array.
    $remaining = [string[]]@()
    if ($tokens.Count -gt 1) { $remaining = [string[]]@($tokens[0..($tokens.Count - 2)]) }
    return [pscustomobject]@{ SkipBuild = $true; ArgList = $remaining }
}

function Test-RootHelpRequest {
    <#
    .SYNOPSIS
        Returns $true only when the LEADING command-line token requests this
        script's root help.
    .DESCRIPTION
        A help flag is honored only in leading position. A flag appearing later
        (e.g. `run.ps1 post --to fb --help`) belongs to a subcommand and must be
        forwarded so the app's own parser resolves it. Likewise a reserved
        subcommand in leading position (e.g. `test --help`) keeps ownership of
        the flag (issue #243).

        Call this AFTER the leading positional token has been folded into
        $Argument, so a non-empty $Command means a reserved subcommand.
    .OUTPUTS
        [bool]
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [string]$Command,
        [string[]]$Argument
    )

    if ($Command) { return ($Command -eq 'help' -or $Command -in $script:HelpFlags) }
    if ($Argument -and $Argument.Count -gt 0) { return ($Argument[0] -in $script:HelpFlags) }
    return $false
}

$script:TransientStatusLength = 0

# In-place status only makes sense on a live console. When output is
# redirected -- a CI log, a captured bug report, a pipe into grep -- the
# carriage returns and padding land in the file as one garbled physical
# line, because Write-Host still writes to stdout. Detect that once and
# degrade to silence: the transient messages are progress, and progress is
# exactly what a log does not need.
#
# A host can also leave output un-redirected yet have no console window to
# measure (issue #519): [Console]::WindowWidth then throws "The handle is
# invalid", and under $ErrorActionPreference = 'Stop' that would kill the run
# mid-build. Treat that host as a log too.
function Get-ConsoleWindowSize {
    <#
    .SYNOPSIS
        Returns @{ Width; Height } of the console window, or $null when the
        host has no window to measure.
    #>
    try { return @{ Width = [Console]::WindowWidth; Height = [Console]::WindowHeight } }
    catch { return $null }
}

function Test-VirtualTerminal {
    <#
    .SYNOPSIS
        Returns $true when the host understands VT escape sequences (cursor
        movement), which the multi-row transient window needs.
    #>
    return [bool]$Host.UI.SupportsVirtualTerminal
}

function Test-TransientConsole {
    <#
    .SYNOPSIS
        Returns $true when in-place status can be drawn: output reaches a live
        console whose window can be measured.
    #>
    if ([Console]::IsOutputRedirected) { return $false }
    return $null -ne (Get-ConsoleWindowSize)
}

$script:TransientStatusEnabled = Test-TransientConsole

function Write-TransientStatus {
    <#
    .SYNOPSIS
        Writes an in-place status message that a later Write-TransientStatus or
        Clear-TransientStatus call overwrites, instead of scrolling the console.
    .DESCRIPTION
        Returns the cursor to the start of the line and pads to erase leftover
        characters from a longer previous message. The status is progress, not
        output: it never survives the run, so it cannot be pasted into a bug
        report as though it were a result.

        A no-op when output is redirected (see $script:TransientStatusEnabled).
    #>
    param([string]$Message, [string]$ForegroundColor = 'DarkGray')

    if (-not $script:TransientStatusEnabled) { return }
    $pad = ''.PadRight([Math]::Max(0, $script:TransientStatusLength - $Message.Length))
    Write-Host -NoNewline "`r$Message$pad" -ForegroundColor $ForegroundColor
    $script:TransientStatusLength = $Message.Length
}

function Clear-TransientStatus {
    <#
    .SYNOPSIS
        Blanks the line written by Write-TransientStatus, leaving no trace.
        A no-op when output is redirected, or when nothing was written.
    #>
    if (-not $script:TransientStatusEnabled) { return }
    if ($script:TransientStatusLength -gt 0) {
        Write-Host -NoNewline ("`r" + ''.PadRight($script:TransientStatusLength) + "`r")
        $script:TransientStatusLength = 0
    }
}

# Rows currently drawn by Write-TransientWindow, so the next redraw or
# Clear-TransientWindow knows how far up to move.
$script:TransientWindowHeight = 0

# Most build-output lines the transient window shows at once. The window must
# stay inside the visible console: cursor-up movement cannot reach a row that
# has scrolled into history, so a taller window could not be erased.
$script:TransientWindowMaxLines = 10

function Format-TransientWindow {
    <#
    .SYNOPSIS
        Returns the rows the transient build window draws: the title, then the
        tail of the non-blank output lines, each cut to fit on one row.
    .DESCRIPTION
        Pure, so it can be tested without a console. Every row must fit in
        $Width: a row that wrapped would occupy two console lines while being
        counted as one, and the erase would leave its tail behind.
    .OUTPUTS
        [string[]]
    #>
    [OutputType([string[]])]
    param(
        [string]$Title,
        [AllowNull()][string[]]$Line,
        [int]$Width,
        [int]$Height
    )

    $width = [Math]::Max(10, $Width - 1)
    $tailSize = [Math]::Max(1, [Math]::Min($script:TransientWindowMaxLines, $Height - 3))
    $body = @(@($Line) | Where-Object { $_ -and $_.Trim() } | Select-Object -Last $tailSize)

    $rows = @($Title) + @($body | ForEach-Object { '  ' + $_.Trim() })
    return , @(foreach ($row in $rows) {
            $flat = $row -replace '\t', '    '
            if ($flat.Length -gt $width) { $flat.Substring(0, $width - 3) + '...' } else { $flat }
        })
}

function Write-TransientWindow {
    <#
    .SYNOPSIS
        Redraws a small in-place window: a title plus the latest build output
        lines. Clear-TransientWindow erases it without a trace.
    .DESCRIPTION
        While a build runs its output is what the caller wants to watch; once it
        has succeeded it is noise (issue #519). The window gives the first
        without leaving the second behind.

        Needs virtual-terminal support to move the cursor up. Without it the
        window degrades to the single-line Write-TransientStatus, showing only
        the latest line. A no-op when output is redirected.
    #>
    param([string]$Title, [AllowNull()][string[]]$Line)

    if (-not $script:TransientStatusEnabled) { return }
    $size = Get-ConsoleWindowSize
    if (-not $size) { return }
    if (-not (Test-VirtualTerminal)) {
        $latest = @(@($Line) | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1)
        $text = if ($latest.Count) { "$Title $($latest[0].Trim())" } else { $Title }
        $width = [Math]::Max(10, $size.Width - 1)
        if ($text.Length -gt $width) { $text = $text.Substring(0, $width) }
        Write-TransientStatus $text
        return
    }

    $esc = [char]27
    $rows = Format-TransientWindow -Title $Title -Line $Line -Width $size.Width -Height $size.Height
    $frame = [System.Text.StringBuilder]::new()
    if ($script:TransientWindowHeight -gt 0) { [void]$frame.Append("$esc[$($script:TransientWindowHeight)F") }
    [void]$frame.Append("`r$esc[0J")
    foreach ($row in $rows) {
        $color = if ($row -match ': error ') { 91 } elseif ($row -match ': warning ') { 93 } else { 90 }
        [void]$frame.Append("$esc[${color}m$row$esc[0m`n")
    }
    Write-Host -NoNewline $frame.ToString()
    $script:TransientWindowHeight = $rows.Count
}

function Clear-TransientWindow {
    <#
    .SYNOPSIS
        Erases the window drawn by Write-TransientWindow (or its single-line
        fallback). A no-op when output is redirected, or when nothing is drawn.
    #>
    if (-not $script:TransientStatusEnabled) { return }
    if ($script:TransientWindowHeight -gt 0) {
        $esc = [char]27
        Write-Host -NoNewline "$esc[$($script:TransientWindowHeight)F$esc[0J"
        $script:TransientWindowHeight = 0
    }
    Clear-TransientStatus
}

function Invoke-TransientBuild {
    <#
    .SYNOPSIS
        Runs `dotnet` with $Argument, showing its output live in the transient
        window and erasing it when the command finishes.
    .DESCRIPTION
        The caller decides what survives: on failure it reprints the captured
        output with Write-BuildLog. When output is redirected the lines are
        passed straight through instead, because a log wants all of them.
    .OUTPUTS
        [pscustomobject] with ExitCode and Output (every captured line).
    #>
    param([string[]]$Argument, [string]$Title)

    $captured = [System.Collections.Generic.List[string]]::new()
    # Only the latest lines can ever be shown, so only they are kept for the
    # window -- a redraw costs the same on line 5 as on line 5000.
    $tail = [System.Collections.Generic.Queue[string]]::new()
    # Redraw at most every $redrawMs: a multi-project build can emit hundreds of
    # lines in a burst, and one console redraw per line would slow the very
    # build this window is reporting on. Nothing is lost -- the window is
    # erased at the end anyway, and the full output stays in $captured.
    $redrawMs = 50
    $sinceRedraw = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        Write-TransientWindow -Title $Title -Line @()
        & dotnet @Argument 2>&1 | ForEach-Object {
            $text = "$_"
            $captured.Add($text)
            if (-not $script:TransientStatusEnabled) { Write-Host $text; return }
            if (-not $text.Trim()) { return }
            $tail.Enqueue($text)
            if ($tail.Count -gt $script:TransientWindowMaxLines) { [void]$tail.Dequeue() }
            if ($sinceRedraw.ElapsedMilliseconds -ge $redrawMs) {
                Write-TransientWindow -Title $Title -Line $tail.ToArray()
                $sinceRedraw.Restart()
            }
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        # Also on Ctrl+C: an interrupted build must not leave a half-drawn
        # window of stale output behind.
        Clear-TransientWindow
    }

    return [pscustomobject]@{ ExitCode = $exitCode; Output = $captured.ToArray() }
}

function Write-BuildLog {
    <#
    .SYNOPSIS
        Prints captured build output permanently, errors in red and warnings
        in yellow -- what a failed build leaves on screen.
    #>
    param([AllowNull()][string[]]$Line)

    foreach ($text in @($Line)) {
        if ($text -match ': error ') { Write-Host $text -ForegroundColor Red }
        elseif ($text -match ': warning ') { Write-Host $text -ForegroundColor Yellow }
        else { Write-Host $text }
    }
}

# Allow dot-sourcing for testing (loads functions only)
if ($MyInvocation.InvocationName -eq '.') { return }

# --- Main ---

# --- Consumer extension point (issue #462) ---
#
# Dot-sourced, not called: that loads run.project.ps1 into THIS script's scope,
# which is what makes the rest work. The hook can set $env: variables the child
# process inherits, append to $ReservedCommands, and OVERRIDE any function
# above by redefining it, because a later definition wins.
#
# The load point is boxed in on all four sides and every side is load-bearing:
#
#   after  $ReservedCommands is assigned  -- or the hook cannot add to it
#   after  the function definitions       -- or it cannot override them
#   after  the dot-source guard           -- or `. ./run.ps1` in a test session
#                                            would silently apply a consumer's
#                                            overrides to unrelated tests
#   before the argument-forwarding block  -- or a custom subcommand has already
#                                            been forwarded to the application
#
# Stated as landmarks, not line numbers: the numbers in this file have moved
# three times in two days, and a stale one sends the next reader to the wrong
# place with more confidence than no number at all.
#
# The consequence of sitting below the guard, accepted deliberately: hook
# behaviour cannot be tested by dot-sourcing run.ps1. It has to be exercised by
# INVOKING run.ps1 as a script against a fixture directory that contains a
# run.project.ps1 -- which is how run.Tests.ps1 covers it.
#
# Deliberately NOT scaffolded. An empty run.project.ps1 in every consumer is
# noise; absent means "no customization", which is the common case.
$projectHook = Join-Path $PSScriptRoot 'run.project.ps1'
if (Test-Path -LiteralPath $projectHook) { . $projectHook }


# Normalize forwarded arguments before anything inspects them, so array
# literals survive as typed (see ConvertTo-ForwardedArgument).
#
# Assign the result directly -- NOT `@(...)`. These helpers return `, $list`,
# whose single level of output unrolling already yields the list itself; an
# extra @() re-nests it, producing a one-element array holding the real one.
# Splatting flattened that back out, so it stayed invisible until a [string[]]
# parameter coerced the nested array to a single space-joined string (#461).
$Args = ConvertTo-ForwardedArgument -Argument $Args

# PowerShell binds positional args (even after `--`) to $Command before $Args,
# so `.\run.ps1 -- --flag ...` or `.\run.ps1 mycmd` both land with $Command
# holding the first token. Forward it into $Args if it's either a flag
# (starts with '-') or a non-reserved subcommand so the child process sees it.
# 'run' is treated as an explicit no-op keyword so callers can write
# `.\run.ps1 run -- args` when they need to force run mode.
if ($Command -and ($Command.StartsWith('-') -or $Command -notin $ReservedCommands)) {
    $Args = @($Command) + $Args
    $Command = ''
}

# --- Help mode ---
# Root help is requested only when the LEADING token is `help` or a help flag.
# `./run.ps1 post --to fb --help` forwards `--help` to the app instead.
if (Test-RootHelpRequest -Command $Command -Argument $Args) {
    $runnableProjects = @(Find-RunnableProjects)
    if ($runnableProjects.Count -eq 0) {
        Write-Error 'No runnable projects found. Ensure at least one .csproj has <OutputType>Exe</OutputType>.'
        exit 1
    }
    # Pick the first runnable project (skip interactive selection for help)
    $selectedProject = $runnableProjects[0]
    & dotnet run --project $selectedProject.FullName -- --help
    exit $LASTEXITCODE
}

# --- Project subcommand (issue #462) ---
# A command that is reserved but that upstream does not handle can only have
# come from run.project.ps1 appending to $ReservedCommands. Appending alone
# just stops the token reaching the app -- the hook has to supply
# Invoke-ProjectCommand to give it behaviour.
if ($Command -and $Command -notin @('run', 'test', 'help')) {
    if (-not (Get-Command Invoke-ProjectCommand -ErrorAction SilentlyContinue)) {
        Write-Error "'$Command' is in `$ReservedCommands but run.project.ps1 defines no Invoke-ProjectCommand to handle it."
        exit 1
    }
    # Zero $LASTEXITCODE first. It is process-wide, and a handler that never
    # shells out leaves it untouched -- so `exit $LASTEXITCODE` would report
    # whatever an unrelated earlier command in this process happened to leave
    # behind (a CI script chaining commands makes that routine), or, in a fresh
    # session where nothing has set it at all, trip Set-StrictMode with
    # "the variable '$LASTEXITCODE' cannot be retrieved because it has not been
    # set". A handler that wants a non-zero result sets it explicitly.
    #
    # `$global:` is load-bearing -- do NOT shorten this to `$LASTEXITCODE = 0`.
    # An unqualified write creates a SCRIPT-scoped shadow, while a handler
    # reporting failure writes `$global:LASTEXITCODE = N` (the natural idiom,
    # since the handler is dot-sourced into this scope). The unqualified read
    # two lines down would then resolve to the nearer shadow and silently
    # discard the handler's result, turning every failure into a success.
    $global:LASTEXITCODE = 0
    Invoke-ProjectCommand -Command $Command -Argument $Args
    exit $LASTEXITCODE
}

# --- Test mode ---
if ($Command -eq 'test') {
    $sln = Find-Solution
    $dotnetArgs = @('test')

    if ($sln) {
        $slnPath = [System.IO.Path]::GetRelativePath($SearchRoot, $sln.FullName)
        $dotnetArgs += $sln.FullName
        Write-Host ''
        Write-Host "Testing: $slnPath" -ForegroundColor Green
    }
    else {
        Write-Host ''
        Write-Host 'Testing: all projects (no solution file found)' -ForegroundColor Green
    }
    Write-Host ''

    if ($Args -and $Args.Count -gt 0) {
        $dotnetArgs += $Args
    }

    & dotnet @dotnetArgs
    exit $LASTEXITCODE
}

# --- Run mode ---

# Restore a `-v` that [CmdletBinding()] prefix-matched to -Verbose and stripped
# (issue #461).
#
# Here, not next to the fold above, because run mode is the only path that
# forwards $Args to the APPLICATION. Test mode appends them straight to
# `dotnet test`, which has no --verbose switch: injecting there turned a
# previously harmless `./run.ps1 -Verbose test` into `MSBUILD : error MSB1001:
# Unknown switch`. Help mode ignores $Args entirely.
#
# Still after the $Command fold, so a `--verbose` the caller wrote after `--`
# -- which lands in $Command while -Verbose is ALSO bound -- is visible and
# the flag is not forwarded twice.
$Args = Resolve-VerbosePassthrough -ArgList $Args -VerboseBound $PSBoundParameters.ContainsKey('Verbose')

# Run mode only, and deliberately AFTER test mode has already exited: `dotnet
# test` takes a --no-build of its own, and swallowing that one would change
# what the caller asked for.
$skipBuild = Resolve-SkipBuildSwitch -ArgList $Args
$Args = $skipBuild.ArgList

# If explicit project provided, use it directly
if ($Project) {
    if (-not (Test-Path $Project)) {
        Write-Error "Project not found: $Project"
        exit 1
    }
    $selectedProject = Get-Item $Project
}
else {
    $sln = Find-Solution
    if (-not $sln) {
        Write-Warning "No solution file (*.sln / *.slnx) found in $SearchRoot."
    }

    $runnableProjects = @(Find-RunnableProjects)

    if ($runnableProjects.Count -eq 0) {
        Write-Error 'No runnable projects found. Ensure at least one .csproj has <OutputType>Exe</OutputType>.'
        exit 1
    }
    elseif ($runnableProjects.Count -eq 1) {
        $selectedProject = $runnableProjects[0]
    }
    else {
        # Detection chain: .vscode/launch.json -> launchSettings.json -> prompt
        $selectedProject = Find-VsCodeLaunchProject -Projects $runnableProjects
        if ($selectedProject) {
            $rel = [System.IO.Path]::GetRelativePath($SearchRoot, $selectedProject.FullName)
            Write-TransientStatus "Auto-selected from .vscode/launch.json: $rel"
        }

        if (-not $selectedProject) {
            $selectedProject = Find-LaunchSettingsProject -Projects $runnableProjects
            if ($selectedProject) {
                $rel = [System.IO.Path]::GetRelativePath($SearchRoot, $selectedProject.FullName)
                Write-TransientStatus "Auto-selected from launchSettings.json: $rel"
            }
        }

        if (-not $selectedProject) {
            $selectedProject = Select-Project -Projects $runnableProjects
            Ensure-LaunchSettings -ProjectFile $selectedProject
        }
    }
}

$projectDir = $selectedProject.DirectoryName
$projectPath = [System.IO.Path]::GetRelativePath($SearchRoot, $selectedProject.FullName)

# The whole preamble collapses to ONE grey line (issues #469, #519). Everything
# before the application starts -- which project was auto-selected, whether a
# build was needed, and the build's own output -- is progress: true while it is
# on screen, worthless afterwards, and paid for on every single run. It is shown
# while it matters and then erased. What survives is one line naming what is
# about to run, in DarkGray, because it is context for the application's output
# rather than a result of its own.
#
# The launch settings are part of that preamble (issue #521). `dotnet run` used
# to announce them on every run and --verbosity quiet silenced it; saying it
# here instead keeps the information while the launcher works -- the up-to-date
# check and any build -- and takes it away before the application writes a word.
#
# Resolved through Get-LaunchProfileArgs, and the status is read back out of
# the arguments it returned -- NOT from a second, independent call to
# Resolve-LaunchProfile. A consumer hook may override Get-LaunchProfileArgs to
# pick a different profile, and a status computed alongside it rather than from
# it would then name a profile the run does not use.
# Assign the call's result FIRST, then wrap that variable in @() -- wrapping the
# CALL re-nests a hook that returns `, $list`, which is exactly what upstream's
# own Get-LaunchProfileArgs returns (see the same pattern at the pre-run hook).
$profileResult = Get-LaunchProfileArgs -ProjectDir $projectDir -ProfileName $LaunchProfile
$profileArgs = @($profileResult)
$profileIndex = [array]::IndexOf($profileArgs, '--launch-profile')
if ($profileIndex -ge 0 -and $profileIndex + 1 -lt $profileArgs.Count) {
    $launchSettings = Join-Path $projectDir 'Properties' 'launchSettings.json'
    $launchStatus = "Using launch profile: $($profileArgs[$profileIndex + 1])"
    if (Test-Path -LiteralPath $launchSettings) {
        $launchStatus = "Using launch settings from $([System.IO.Path]::GetRelativePath($SearchRoot, $launchSettings)) (profile: $($profileArgs[$profileIndex + 1]))"
    }
    Write-TransientStatus $launchStatus
}

if ($skipBuild.SkipBuild) {
    # The caller states the build is current, so neither the check nor the
    # build runs -- the check itself walks the tree and is not free.
    $buildRequired = $false
    $restoreRequired = $false
}
else {
    Write-TransientStatus 'Checking whether a build is required...'
    $buildRequired = Test-BuildRequired -ProjectFile $selectedProject -Root $SearchRoot
    $restoreRequired = $buildRequired -and (Test-RestoreRequired -ProjectFile $selectedProject -Root $SearchRoot)
}
Clear-TransientStatus

# The application always starts with --no-build: when a build is needed it runs
# first, as its own `dotnet build`, because that is the only way to know where
# the build output ends and the application's begins -- which is what lets the
# build output be erased once it succeeds. Piping `dotnet run` itself instead
# would take the console away from the application.
#
# `dotnet run` announces "Using launch settings from <abs path>..." on every
# run. --verbosity quiet silences that and MSBuild's own chatter. It also hides
# build WARNINGS, which is safe only because nothing compiles inside this
# invocation any more: the build step above it runs at normal verbosity.
#
# --no-launch-profile would silence the line too, but by DROPPING the profile
# and its environment variables with it -- a behaviour change, not a cosmetic
# one, and not acceptable in a generic launcher.
$dotnetArgs = @('run', '--project', $selectedProject.FullName, '--no-build', '--verbosity', 'quiet')

# Add launch profile if applicable (resolved above, with the status line)
$dotnetArgs += $profileArgs

# Add pass-through arguments
if ($Args -and $Args.Count -gt 0) {
    $dotnetArgs += '--'
    $dotnetArgs += $Args
}

# Last-chance mutation of the command line, and a seam after the process
# exits (issue #462). Both optional: a hook implements only what it needs.
#
# The pre-run hook sees the `dotnet run` command line and runs BEFORE the build
# step, so options it adds that change what gets built (-c, -f, -p:...) reach
# the build too (see Get-BuildAffectingArgument). There is still no hook seam
# between the build and the run; it should be its own issue if one is needed.
if (Get-Command Invoke-ProjectPreRun -ErrorAction SilentlyContinue) {
    # Assign the call's result to a variable FIRST, then wrap that variable in
    # @(). Wrapping the CALL -- `@(Invoke-ProjectPreRun ...)` -- re-nests a
    # hook that returns `, $list`, the idiom for "an array, not unrolled",
    # producing a one-element array holding the real one. Splatting flattens
    # that back out, so it looks fine until something types the value (#461).
    #
    # This is a public extension contract: consumers will write both `, $list`
    # and a plain array, and both must work. Wrapping the variable does that --
    # `, $list` has already unrolled by the time it lands in $hookResult, and a
    # plain array is unchanged by @().
    $hookResult = Invoke-ProjectPreRun -DotnetArgument $dotnetArgs -Project $selectedProject.FullName
    $dotnetArgs = @($hookResult)
}

$exitCode = $null
if ($buildRequired) {
    $buildArgs = @('build', $selectedProject.FullName, '-nologo') + (Get-BuildAffectingArgument -DotnetArgument $dotnetArgs)
    $buildTitle = "Building $projectPath..."
    $build = Invoke-TransientBuild -Argument ($buildArgs + @(if (-not $restoreRequired) { '--no-restore' })) -Title $buildTitle

    # The restore check reads timestamps under the search root only; a restore
    # that went stale some other way (a deleted package cache, an SDK change)
    # shows up as one of these errors, and a build WITH restore fixes it.
    if ($build.ExitCode -ne 0 -and -not $restoreRequired -and (Test-RestoreFailure -Output $build.Output)) {
        $restoreRequired = $true
        $build = Invoke-TransientBuild -Argument $buildArgs -Title $buildTitle
    }

    if ($build.ExitCode -ne 0) {
        # A failed build keeps its output: the errors are the result now. When
        # output is redirected it was already passed through line by line.
        if ($script:TransientStatusEnabled) { Write-BuildLog -Line $build.Output }
        Write-Host "Build failed: $projectPath" -ForegroundColor Red
        $exitCode = $build.ExitCode
    }
    else {
        # A build that reported a warning keeps its WHOLE output: erasing it
        # would hide the one thing in it worth reading (issue #521). Only a
        # build that said nothing of substance disappears. Redirected output
        # already passed through line by line.
        if ($script:TransientStatusEnabled -and (Test-BuildDiagnostic -Output $build.Output)) {
            Write-BuildLog -Line $build.Output
        }
        if ($restoreRequired) { Save-RestoreStamp -ProjectFile $selectedProject }
    }
}

if ($null -eq $exitCode) {
    Write-Host "Running $projectPath" -ForegroundColor DarkGray
    & dotnet @dotnetArgs
    $exitCode = $LASTEXITCODE
}

if (Get-Command Invoke-ProjectPostRun -ErrorAction SilentlyContinue) {
    Invoke-ProjectPostRun -ExitCode $exitCode -Project $selectedProject.FullName
}

exit $exitCode
