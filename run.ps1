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

    To avoid needless recompilation, run mode skips the build step (passing
    `--no-build` to `dotnet run`) whenever no source file is newer than the
    project's last build output. The first run - or any run after a source
    file changes - compiles as usual; subsequent unchanged runs start without
    rebuilding.

    Use `./run.ps1 test` to run `dotnet test` across the entire solution.
    Use `./run.ps1 help` to show the application's own help text.

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
    or to `dotnet test` (when using `test` command).

.EXAMPLE
    ./run.ps1
    ./run.ps1 -- --dry-run
    ./run.ps1 mysubcommand
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
    [string[]]$Args
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Reserved subcommands handled by this script itself (not forwarded to the app).
$ReservedCommands = @('run', 'test', 'help')

# PowerShell binds positional args (even after `--`) to $Command before $Args,
# so `.\run.ps1 -- --flag ...` or `.\run.ps1 mycmd` both land with $Command
# holding the first token. Forward it into $Args if it's either a flag
# (starts with '-') or a non-reserved subcommand so the child process sees it.
# 'run' is treated as an explicit no-op keyword so callers can write
# `.\run.ps1 run -- args` when they need to force run mode.
if ($Command -and ($Command.StartsWith('-') -or $Command -notin $ReservedCommands)) {
    if ($null -eq $Args) { $Args = @() }
    $Args = @($Command) + $Args
    $Command = ''
}

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

function Find-RunnableProjects {
    $csprojFiles = Get-ChildItem -Path $SearchRoot -Filter '*.csproj' -Recurse -File |
        Where-Object {
            $full = $_.FullName
            ($full -notlike "$SearchRoot\.worktrees\*") -and
            ($full -notmatch '[\\/]bin[\\/]') -and
            ($full -notmatch '[\\/]obj[\\/]')
        }
    $runnable = @()
    foreach ($csproj in $csprojFiles) {
        $content = Get-Content $csproj.FullName -Raw
        if ($content -match '<OutputType>\s*(Exe|WinExe)\s*</OutputType>') {
            $runnable += $csproj
        }
    }
    return $runnable
}

function Get-LaunchProfileArgs {
    param([string]$ProjectDir, [string]$ProfileName)

    $launchSettingsPath = Join-Path $ProjectDir 'Properties' 'launchSettings.json'
    if (-not (Test-Path $launchSettingsPath)) { return @() }

    $settings = Get-Content $launchSettingsPath -Raw | ConvertFrom-Json
    $profiles = Get-PropertyValue $settings 'profiles'
    if (-not $profiles) { return @() }

    $profile = $null

    if ($ProfileName) {
        $profile = Get-PropertyValue $profiles $ProfileName
        if (-not $profile) {
            Write-Warning "Launch profile '$ProfileName' not found in $launchSettingsPath"
            return @()
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

    if (-not $profile) { return @() }

    $extraArgs = @('--launch-profile', $ProfileName)
    return $extraArgs
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
        Assumes the default convention that the assembly name matches the project
        file name (e.g. App.csproj -> App.dll). When a project overrides
        AssemblyName the lookup returns $null, which conservatively forces a build.
    #>
    param([System.IO.FileInfo]$ProjectFile)

    $binDir = Join-Path $ProjectFile.DirectoryName 'bin'
    if (-not (Test-Path $binDir)) { return $null }

    $assemblyName = [System.IO.Path]::GetFileNameWithoutExtension($ProjectFile.Name)
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
        props/targets, solution files, Razor, resources, etc.) and ignores
        generated output (bin, obj) and non-source trees (.git, .worktrees, .vs,
        node_modules) so that build artifacts never make a project look stale.
    #>
    param([string]$Root)

    $sourceExtensions = @(
        '.cs', '.csproj', '.props', '.targets', '.sln', '.slnx',
        '.razor', '.cshtml', '.resx', '.vb', '.vbproj', '.fs', '.fsproj'
    )

    $sourceFiles = @(
        Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $full = $_.FullName
                ($full -notmatch '[\\/]bin[\\/]') -and
                ($full -notmatch '[\\/]obj[\\/]') -and
                ($full -notmatch '[\\/]\.git[\\/]') -and
                ($full -notmatch '[\\/]\.worktrees[\\/]') -and
                ($full -notmatch '[\\/]\.vs[\\/]') -and
                ($full -notmatch '[\\/]node_modules[\\/]') -and
                ($sourceExtensions -contains $_.Extension)
            }
    )
    if ($sourceFiles.Count -eq 0) { return $null }

    return $sourceFiles |
        Sort-Object -Property LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty LastWriteTimeUtc
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

# Allow dot-sourcing for testing (loads functions only)
if ($MyInvocation.InvocationName -eq '.') { return }

# --- Main ---

# --- Help mode ---
# Handle help requests: `./run.ps1 help`, `./run.ps1 -- --help`, or help
# flags in $Args. When invoked interactively, `-- --help` puts `--help` into
# $Command (positional). With `pwsh -File`, `--help` goes into $Args.
# Use `./run.ps1 help` for the most reliable cross-invocation behavior.
$helpFlags = @('--help', '-h', '-?')
$isHelpCommand = $Command -eq 'help' -or $Command -in $helpFlags
$hasHelpFlag = $Args | Where-Object { $_ -in $helpFlags } | Select-Object -First 1

if ($isHelpCommand -or $hasHelpFlag) {
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
            Write-Host "Auto-selected from .vscode/launch.json: $rel" -ForegroundColor DarkGray
        }

        if (-not $selectedProject) {
            $selectedProject = Find-LaunchSettingsProject -Projects $runnableProjects
            if ($selectedProject) {
                $rel = [System.IO.Path]::GetRelativePath($SearchRoot, $selectedProject.FullName)
                Write-Host "Auto-selected from launchSettings.json: $rel" -ForegroundColor DarkGray
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

Write-Host ''
Write-Host "Running: $projectPath" -ForegroundColor Green
Write-Host ''

# Build the dotnet run command
$dotnetArgs = @('run', '--project', $selectedProject.FullName)

# Skip compilation when no source file is newer than the last build output.
if (Test-BuildRequired -ProjectFile $selectedProject -Root $SearchRoot) {
    Write-Host 'Source changes detected - building.' -ForegroundColor DarkGray
}
else {
    $dotnetArgs += '--no-build'
    Write-Host 'No source changes detected - skipping build.' -ForegroundColor DarkGray
}

# Add launch profile if applicable
$profileArgs = Get-LaunchProfileArgs -ProjectDir $projectDir -ProfileName $LaunchProfile
$dotnetArgs += $profileArgs

# Add pass-through arguments
if ($Args -and $Args.Count -gt 0) {
    $dotnetArgs += '--'
    $dotnetArgs += $Args
}

& dotnet @dotnetArgs
exit $LASTEXITCODE
