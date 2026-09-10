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
        props/targets, solution files, Razor, resources, etc.) and ignores
        generated output (bin, obj) and non-source trees (.git, .worktrees, .vs,
        node_modules) so that build artifacts never make a project look stale.

        Exclusions are evaluated against each file's path *relative to $Root*,
        so a checkout that itself lives under one of those names -- notably a
        git worktree under .worktrees/ -- is not excluded wholesale. Matching on
        the absolute path would find zero sources there and silently skip every
        rebuild.
    #>
    param([string]$Root)

    $sourceExtensions = @(
        '.cs', '.csproj', '.props', '.targets', '.sln', '.slnx',
        '.razor', '.cshtml', '.resx', '.vb', '.vbproj', '.fs', '.fsproj'
    )

    $sep = [System.IO.Path]::DirectorySeparatorChar
    $rootFull = [System.IO.Path]::GetFullPath($Root)
    if (-not $rootFull.EndsWith($sep)) { $rootFull += $sep }

    $sourceFiles = @(
        Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $full = $_.FullName
                $rel = if ($full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $full.Substring($rootFull.Length)
                }
                else { $full }
                # Leading separator so the [\\/]name[\\/] patterns also match a
                # directory sitting directly at the root.
                $rel = $sep + $rel
                ($rel -notmatch '[\\/]bin[\\/]') -and
                ($rel -notmatch '[\\/]obj[\\/]') -and
                ($rel -notmatch '[\\/]\.git[\\/]') -and
                ($rel -notmatch '[\\/]\.worktrees[\\/]') -and
                ($rel -notmatch '[\\/]\.vs[\\/]') -and
                ($rel -notmatch '[\\/]node_modules[\\/]') -and
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
$script:TransientStatusEnabled = -not [Console]::IsOutputRedirected

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

# Build the dotnet run command
$dotnetArgs = @('run', '--project', $selectedProject.FullName)

# Skip compilation when no source file is newer than the last build output.
#
# The whole preamble collapses to ONE grey line here (issue #469). Everything
# before it -- which project was auto-selected, and whether a build was needed
# -- is progress: true while it is on screen, worthless afterwards, and paid
# for on every single run. It flashes and is erased. What survives is one line
# naming what is about to run, in DarkGray, because it is context for the
# application's output rather than a result of its own.
Write-TransientStatus 'Checking whether a build is required...'
if (Test-BuildRequired -ProjectFile $selectedProject -Root $SearchRoot) {
    # Say "Building" up front so the compiler output that follows is explained
    # rather than appearing unannounced.
    $runStatus = "Building and running $projectPath"
}
else {
    $dotnetArgs += '--no-build'

    # `dotnet run` announces "Using launch settings from <abs path>..." on
    # every single run. --verbosity quiet silences that and MSBuild's own
    # chatter, while still printing compiler ERRORS -- verified against a
    # deliberate syntax error, where quiet and the default emit identical CS
    # diagnostics.
    #
    # ONLY on the --no-build path, and the boundary is load-bearing: quiet also
    # hides build WARNINGS. A consumer that has not set TreatWarningsAsErrors
    # must still see them, and this script is generic across many projects, so
    # it cannot assume that setting. Nothing is compiling on this path, so
    # there are no warnings to lose here -- and when a build IS running, its
    # output is exactly what the caller wants.
    #
    # The cost, accepted: `dotnet run`'s launch-settings line survives on the
    # build path. It is the only path where it still appears, so it is no
    # longer paid on every run.
    #
    # --no-launch-profile would silence the line everywhere, but by DROPPING
    # the profile and its environment variables with it -- a behaviour change,
    # not a cosmetic one, and not acceptable in a generic launcher.
    $dotnetArgs += @('--verbosity', 'quiet')

    $runStatus = "Running $projectPath"
}
Clear-TransientStatus
Write-Host $runStatus -ForegroundColor DarkGray

# Add launch profile if applicable
$profileArgs = Get-LaunchProfileArgs -ProjectDir $projectDir -ProfileName $LaunchProfile
$dotnetArgs += $profileArgs

# Add pass-through arguments
if ($Args -and $Args.Count -gt 0) {
    $dotnetArgs += '--'
    $dotnetArgs += $Args
}

# Last-chance mutation of the command line, and a seam after the process
# exits (issue #462). Both optional: a hook implements only what it needs.
#
# There is deliberately NO seam between compilation and execution. `dotnet run`
# compiles and launches in one invocation, so creating one would mean splitting
# into `dotnet build` + `dotnet run --no-build` -- two invocations with
# different error surfaces and slower startup. No known scenario needs it; it
# should be its own issue if one appears.
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

& dotnet @dotnetArgs
$exitCode = $LASTEXITCODE

if (Get-Command Invoke-ProjectPostRun -ErrorAction SilentlyContinue) {
    Invoke-ProjectPostRun -ExitCode $exitCode -Project $selectedProject.FullName
}

exit $exitCode
