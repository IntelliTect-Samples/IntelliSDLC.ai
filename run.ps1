<#
.SYNOPSIS
    Project-agnostic script to run or test a .NET project. Auto-discovers
    projects from the solution without hardcoding directory or project names.

.DESCRIPTION
    Scans the current directory for *.sln / *.slnx, finds projects with
    OutputType=Exe (or WinExe), and launches the appropriate one via
    `dotnet run`. If multiple runnable projects exist, prompts the user
    to choose. Supports launchSettings.json profiles and pass-through args.

    Use `./run.ps1 test` to run `dotnet test` across the entire solution.

.PARAMETER Command
    Optional subcommand. Use `test` to run dotnet test on the solution.
    Omit (or use `run`) to run the application.

.PARAMETER LaunchProfile
    Name of the launch profile from launchSettings.json to use (run mode only).

.PARAMETER Project
    Explicit project path to run (bypasses auto-discovery, run mode only).

.PARAMETER Args
    Additional arguments passed through to the application (after `--`)
    or to `dotnet test` (when using `test` command).

.EXAMPLE
    ./run.ps1
    ./run.ps1 -- --dry-run
    ./run.ps1 -LaunchProfile https
    ./run.ps1 -Project src/MyApp/MyApp.csproj
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
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$Args
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-Solution {
    $slnFiles = @(Get-ChildItem -Path . -Filter '*.sln' -File) +
                @(Get-ChildItem -Path . -Filter '*.slnx' -File)
    if ($slnFiles.Count -eq 0) {
        return $null
    }
    return $slnFiles[0]
}

function Find-RunnableProjects {
    $csprojFiles = Get-ChildItem -Path . -Filter '*.csproj' -Recurse -File
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
    if (-not $settings.profiles) { return @() }

    $profiles = $settings.profiles
    $profile = $null

    if ($ProfileName) {
        $profile = $profiles.$ProfileName
        if (-not $profile) {
            Write-Warning "Launch profile '$ProfileName' not found in $launchSettingsPath"
            return @()
        }
    }
    else {
        # Find first profile with commandName=Project
        foreach ($name in $profiles.PSObject.Properties.Name) {
            $p = $profiles.$name
            if ($p.commandName -eq 'Project') {
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
        $relativePath = Resolve-Path -Relative $Projects[$i].FullName
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

# --- Main ---

# --- Test mode ---
if ($Command -eq 'test') {
    $sln = Find-Solution
    $dotnetArgs = @('test')

    if ($sln) {
        $slnPath = Resolve-Path -Relative $sln.FullName
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
        Write-Warning 'No solution file (*.sln / *.slnx) found in current directory.'
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
        $selectedProject = Select-Project -Projects $runnableProjects
    }
}

$projectDir = $selectedProject.DirectoryName
$projectPath = Resolve-Path -Relative $selectedProject.FullName

Write-Host ''
Write-Host "Running: $projectPath" -ForegroundColor Green
Write-Host ''

# Build the dotnet run command
$dotnetArgs = @('run', '--project', $selectedProject.FullName)

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
