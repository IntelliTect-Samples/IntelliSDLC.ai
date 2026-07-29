function global:Initialize-RunTests {
    <#
    .SYNOPSIS
        Defines test helper functions (New-CsprojStub, New-LaunchSettingsStub,
        New-VsCodeLaunchStub) in global scope.

        For manual use, also dot-source run.ps1 first:
            . ./run.ps1; . ./run.Tests.ps1; Initialize-RunTests
    #>

    # Helper: create a minimal .csproj stub with the given OutputType
    function global:New-CsprojStub {
        param(
            [string]$Path,
            [string]$OutputType = 'Exe'
        )
        $dir = Split-Path $Path -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

        if ($OutputType) {
            $xml = @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>$OutputType</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
"@
        }
        else {
            $xml = @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
"@
        }
        Set-Content -Path $Path -Value $xml
    }

    # Helper: create a minimal launchSettings.json with a Project profile
    function global:New-LaunchSettingsStub {
        param([string]$ProjectDir, [string]$ProfileName = 'Default')
        $propsDir = Join-Path $ProjectDir 'Properties'
        if (-not (Test-Path $propsDir)) { New-Item -ItemType Directory -Path $propsDir -Force | Out-Null }
        $json = @"
{
  "profiles": {
    "$ProfileName": {
      "commandName": "Project"
    }
  }
}
"@
        Set-Content -Path (Join-Path $propsDir 'launchSettings.json') -Value $json
    }

    # Helper: create a .vscode/launch.json with a projectPath
    function global:New-VsCodeLaunchStub {
        param([string]$RootDir, [string]$ProjectPath)
        $vsCodeDir = Join-Path $RootDir '.vscode'
        if (-not (Test-Path $vsCodeDir)) { New-Item -ItemType Directory -Path $vsCodeDir -Force | Out-Null }
        $json = @"
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch App",
      "type": "coreclr",
      "request": "launch",
      "projectPath": "$($ProjectPath -replace '\\', '/')"
    }
  ]
}
"@
        Set-Content -Path (Join-Path $vsCodeDir 'launch.json') -Value $json
    }
}

# Standalone scenario function — calls Initialize-RunTests if helpers aren't loaded
function global:New-RunTestScenario {
    <#
    .SYNOPSIS
        Creates a temp directory with 2 Exe + 1 Library project stubs
        for manually testing run.ps1's detection chain.
    .DESCRIPTION
        Generates project stubs under $env:Temp\IntelliSDLC.ai-<guid>.
        No launch config files are created -- add them as needed with
        New-LaunchSettingsStub or New-VsCodeLaunchStub.

        Automatically calls Initialize-RunTests if helpers are not yet loaded.
    .OUTPUTS
        [string] The full path to the created scenario directory.
    .EXAMPLE
        . ./run.ps1; . ./run.Tests.ps1
        $dir = New-RunTestScenario
        cd $dir; .\run.ps1
    #>
    if (-not (Get-Command New-CsprojStub -ErrorAction SilentlyContinue)) {
        Initialize-RunTests
    }

    $guid = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
    $dir = Join-Path $env:Temp "IntelliSDLC.ai-$guid"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    # Copy run.ps1 into the scenario root so it can be tested directly
    $runScript = Join-Path $PSScriptRoot 'run.ps1'
    if (Test-Path $runScript) {
        Copy-Item $runScript -Destination $dir
    }

    New-CsprojStub (Join-Path $dir 'src' 'WebApp' 'WebApp.csproj') -OutputType 'Exe'
    New-CsprojStub (Join-Path $dir 'src' 'ConsoleApp' 'ConsoleApp.csproj') -OutputType 'Exe'
    New-CsprojStub (Join-Path $dir 'src' 'SharedLib' 'SharedLib.csproj') -OutputType ''

    Write-Host "Created test scenario at: $dir" -ForegroundColor Green
    Write-Host "  run.ps1                           (script)" -ForegroundColor White
    Write-Host "  src\WebApp\WebApp.csproj         (Exe)" -ForegroundColor White
    Write-Host "  src\ConsoleApp\ConsoleApp.csproj  (Exe)" -ForegroundColor White
    Write-Host "  src\SharedLib\SharedLib.csproj     (Library)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Usage:  cd '$dir'; .\run.ps1" -ForegroundColor Cyan
    Write-Host "Cleanup: Remove-Item -Recurse '$dir'" -ForegroundColor DarkGray

    return $dir
}

BeforeAll {
    . $PSScriptRoot/run.ps1
    Initialize-RunTests
}

Describe 'Find-RunnableProjects' {
    It 'finds Exe projects and ignores library projects' {
        New-CsprojStub "$TestDrive/src/AppA/AppA.csproj" -OutputType 'Exe'
        New-CsprojStub "$TestDrive/src/AppB/AppB.csproj" -OutputType 'Exe'
        New-CsprojStub "$TestDrive/src/Lib/Lib.csproj" -OutputType ''

        $SearchRoot = $TestDrive
        $result = @(Find-RunnableProjects)
        $result.Count | Should -Be 2
        $result.Name | Should -Contain 'AppA.csproj'
        $result.Name | Should -Contain 'AppB.csproj'
    }

    It 'excludes projects inside .worktrees directory' {
        $testRoot = Join-Path $TestDrive 'worktree-test'
        New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

        New-CsprojStub "$testRoot/src/App/App.csproj" -OutputType 'Exe'
        New-CsprojStub "$testRoot/.worktrees/feat-123/src/App/App.csproj" -OutputType 'Exe'

        $SearchRoot = $testRoot
        $result = @(Find-RunnableProjects)
        $result.Count | Should -Be 1
        $result[0].FullName | Should -Not -BeLike '*\.worktrees\*'
    }
}

Describe 'Test-HasLaunchSettings' {
    It 'returns true when launchSettings.json has a Project profile' {
        New-CsprojStub "$TestDrive/src/App/App.csproj"
        New-LaunchSettingsStub "$TestDrive/src/App" -ProfileName 'App'

        $proj = Get-Item "$TestDrive/src/App/App.csproj"
        Test-HasLaunchSettings $proj | Should -BeTrue
    }

    It 'returns false when no launchSettings.json exists' {
        New-CsprojStub "$TestDrive/src/NoLaunch/NoLaunch.csproj"

        $proj = Get-Item "$TestDrive/src/NoLaunch/NoLaunch.csproj"
        Test-HasLaunchSettings $proj | Should -BeFalse
    }
}

Describe 'Find-LaunchSettingsProject' {
    It 'returns the sole project with launchSettings.json' {
        New-CsprojStub "$TestDrive/src/AppA/AppA.csproj"
        New-CsprojStub "$TestDrive/src/AppB/AppB.csproj"
        New-LaunchSettingsStub "$TestDrive/src/AppA" -ProfileName 'AppA'

        $projects = @(Get-Item "$TestDrive/src/AppA/AppA.csproj", "$TestDrive/src/AppB/AppB.csproj")
        $result = Find-LaunchSettingsProject -Projects $projects
        $result | Should -Not -BeNullOrEmpty
        $result.Name | Should -Be 'AppA.csproj'
    }

    It 'returns null when no projects have launchSettings.json' {
        New-CsprojStub "$TestDrive/src/X/X.csproj"
        New-CsprojStub "$TestDrive/src/Y/Y.csproj"

        $projects = @(Get-Item "$TestDrive/src/X/X.csproj", "$TestDrive/src/Y/Y.csproj")
        Find-LaunchSettingsProject -Projects $projects | Should -BeNullOrEmpty
    }

    It 'returns null when multiple projects have launchSettings.json' {
        New-CsprojStub "$TestDrive/src/M/M.csproj"
        New-CsprojStub "$TestDrive/src/N/N.csproj"
        New-LaunchSettingsStub "$TestDrive/src/M" -ProfileName 'M'
        New-LaunchSettingsStub "$TestDrive/src/N" -ProfileName 'N'

        $projects = @(Get-Item "$TestDrive/src/M/M.csproj", "$TestDrive/src/N/N.csproj")
        Find-LaunchSettingsProject -Projects $projects | Should -BeNullOrEmpty
    }
}

Describe 'Find-VsCodeLaunchProject' {
    It 'matches projectPath from .vscode/launch.json' {
        New-CsprojStub "$TestDrive/src/AppA/AppA.csproj"
        New-CsprojStub "$TestDrive/src/AppB/AppB.csproj"
        New-VsCodeLaunchStub $TestDrive "`${workspaceFolder}/src/AppB/AppB.csproj"

        $SearchRoot = $TestDrive
        $projects = @(Get-Item "$TestDrive/src/AppA/AppA.csproj", "$TestDrive/src/AppB/AppB.csproj")
        $result = Find-VsCodeLaunchProject -Projects $projects
        $result | Should -Not -BeNullOrEmpty
        $result.Name | Should -Be 'AppB.csproj'
    }

    It 'returns null when .vscode/launch.json does not exist' {
        New-CsprojStub "$TestDrive/src/App/App.csproj"

        $SearchRoot = $TestDrive
        $projects = @(Get-Item "$TestDrive/src/App/App.csproj")
        Find-VsCodeLaunchProject -Projects $projects | Should -BeNullOrEmpty
    }

    It 'returns null (no throw) when configurations use program instead of projectPath' {
        New-CsprojStub "$TestDrive/src/App/App.csproj"
        $vsCodeDir = Join-Path $TestDrive '.vscode'
        New-Item -ItemType Directory -Path $vsCodeDir -Force | Out-Null
        $json = @'
{
  "version": "0.2.0",
  "configurations": [
    { "name": "Launch DLL", "type": "coreclr", "request": "launch", "program": "${workspaceFolder}/src/App/bin/Debug/net10.0/App.dll" }
  ]
}
'@
        Set-Content -Path (Join-Path $vsCodeDir 'launch.json') -Value $json

        $SearchRoot = $TestDrive
        $projects = @(Get-Item "$TestDrive/src/App/App.csproj")
        { Find-VsCodeLaunchProject -Projects $projects } | Should -Not -Throw
        Find-VsCodeLaunchProject -Projects $projects | Should -BeNullOrEmpty
    }

    It 'returns null (no throw) when launch.json has no configurations property' {
        New-CsprojStub "$TestDrive/src/App/App.csproj"
        $vsCodeDir = Join-Path $TestDrive '.vscode'
        New-Item -ItemType Directory -Path $vsCodeDir -Force | Out-Null
        Set-Content -Path (Join-Path $vsCodeDir 'launch.json') -Value '{ "version": "0.2.0" }'

        $SearchRoot = $TestDrive
        $projects = @(Get-Item "$TestDrive/src/App/App.csproj")
        { Find-VsCodeLaunchProject -Projects $projects } | Should -Not -Throw
        Find-VsCodeLaunchProject -Projects $projects | Should -BeNullOrEmpty
    }
}

Describe 'Ensure-LaunchSettings' {
    It 'creates Properties/launchSettings.json with a Project profile' {
        New-CsprojStub "$TestDrive/src/NewApp/NewApp.csproj"
        $proj = Get-Item "$TestDrive/src/NewApp/NewApp.csproj"

        $SearchRoot = $TestDrive
        Mock Write-Host {}
        Ensure-LaunchSettings -ProjectFile $proj

        $path = "$TestDrive/src/NewApp/Properties/launchSettings.json"
        Test-Path $path | Should -BeTrue

        $content = Get-Content $path -Raw | ConvertFrom-Json
        $content.profiles.NewApp.commandName | Should -Be 'Project'
    }

    It 'does not overwrite an existing launchSettings.json' {
        New-CsprojStub "$TestDrive/src/Existing/Existing.csproj"
        New-LaunchSettingsStub "$TestDrive/src/Existing" -ProfileName 'Custom'

        $proj = Get-Item "$TestDrive/src/Existing/Existing.csproj"
        $before = Get-Content "$TestDrive/src/Existing/Properties/launchSettings.json" -Raw

        Ensure-LaunchSettings -ProjectFile $proj

        $after = Get-Content "$TestDrive/src/Existing/Properties/launchSettings.json" -Raw
        $after | Should -Be $before
    }
}

Describe 'Integration: detection chain with two projects' {
    It 'first run: prompts user and creates launchSettings; second run: auto-selects' {
        # Arrange: two Exe projects, neither has launchSettings.json
        New-CsprojStub "$TestDrive/src/Alpha/Alpha.csproj"
        New-CsprojStub "$TestDrive/src/Beta/Beta.csproj"

        $SearchRoot = $TestDrive
        $projects = @(Find-RunnableProjects)
        $projects.Count | Should -Be 2

        # --- First run: no launch config, detection returns null ---
        Find-LaunchSettingsProject -Projects $projects | Should -BeNullOrEmpty

        # Simulate user selecting project 1 (mock Read-Host)
        Mock Read-Host { '1' }
        Mock Write-Host {}
        $selected = Select-Project -Projects $projects

        # Create launchSettings for the selected project
        Ensure-LaunchSettings -ProjectFile $selected

        $launchPath = Join-Path $selected.DirectoryName 'Properties' 'launchSettings.json'
        Test-Path $launchPath | Should -BeTrue

        # --- Second run: detection should find the project ---
        $autoSelected = Find-LaunchSettingsProject -Projects $projects
        $autoSelected | Should -Not -BeNullOrEmpty
        $autoSelected.FullName | Should -Be $selected.FullName
    }
}

Describe 'Get-BuiltAssembly' {
    It 'returns the built assembly matching the project name' {
        New-CsprojStub "$TestDrive/src/App/App.csproj"
        $dllDir = Join-Path $TestDrive 'src/App/bin/Debug/net10.0'
        New-Item -ItemType Directory -Path $dllDir -Force | Out-Null
        Set-Content (Join-Path $dllDir 'App.dll') 'binary'

        $proj = Get-Item "$TestDrive/src/App/App.csproj"
        $result = Get-BuiltAssembly -ProjectFile $proj
        $result | Should -Not -BeNullOrEmpty
        $result.Name | Should -Be 'App.dll'
    }

    It 'returns null when the project has never been built' {
        New-CsprojStub "$TestDrive/src/Unbuilt/Unbuilt.csproj"
        $proj = Get-Item "$TestDrive/src/Unbuilt/Unbuilt.csproj"
        Get-BuiltAssembly -ProjectFile $proj | Should -BeNullOrEmpty
    }
}

Describe 'Get-NewestSourceWriteTime' {
    It 'returns the newest LastWriteTimeUtc among source files' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-CsprojStub "$root/src/App/App.csproj"
        $old = "$root/src/App/Old.cs"
        $new = "$root/src/App/New.cs"
        Set-Content $old 'class O {}'
        Set-Content $new 'class N {}'
        (Get-Item $old).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        (Get-Item $new).LastWriteTimeUtc = [datetime]::new(2021, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        (Get-Item "$root/src/App/App.csproj").LastWriteTimeUtc = [datetime]::new(2019, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        Get-NewestSourceWriteTime -Root $root |
            Should -Be ([datetime]::new(2021, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))
    }

    It 'ignores generated files under bin and obj directories' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-CsprojStub "$root/src/App/App.csproj"
        $src = "$root/src/App/Program.cs"
        Set-Content $src 'class P {}'
        (Get-Item $src).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        (Get-Item "$root/src/App/App.csproj").LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        $objDir = Join-Path $root 'src/App/obj'
        New-Item -ItemType Directory -Path $objDir -Force | Out-Null
        $generated = Join-Path $objDir 'App.AssemblyInfo.cs'
        Set-Content $generated 'class G {}'
        (Get-Item $generated).LastWriteTimeUtc = [datetime]::new(2099, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        Get-NewestSourceWriteTime -Root $root |
            Should -Be ([datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))
    }

    It 'returns null when there are no source files' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Get-NewestSourceWriteTime -Root $root | Should -BeNullOrEmpty
    }
}

Describe 'Test-BuildRequired' {
    It 'requires a build when the project has never been built' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-CsprojStub "$root/src/App/App.csproj"
        Set-Content "$root/src/App/Program.cs" 'class P {}'

        $proj = Get-Item "$root/src/App/App.csproj"
        Test-BuildRequired -ProjectFile $proj -Root $root | Should -BeTrue
    }

    It 'does not require a build when the output is newer than all sources' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-CsprojStub "$root/src/App/App.csproj"
        $src = "$root/src/App/Program.cs"
        Set-Content $src 'class P {}'
        (Get-Item $src).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        (Get-Item "$root/src/App/App.csproj").LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        $dllDir = Join-Path $root 'src/App/bin/Debug/net10.0'
        New-Item -ItemType Directory -Path $dllDir -Force | Out-Null
        $dll = Join-Path $dllDir 'App.dll'
        Set-Content $dll 'binary'
        (Get-Item $dll).LastWriteTimeUtc = [datetime]::new(2020, 6, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        $proj = Get-Item "$root/src/App/App.csproj"
        Test-BuildRequired -ProjectFile $proj -Root $root | Should -BeFalse
    }

    It 'requires a build when a source file changed after the last build' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-CsprojStub "$root/src/App/App.csproj"
        $src = "$root/src/App/Program.cs"
        Set-Content $src 'class P {}'
        (Get-Item "$root/src/App/App.csproj").LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        $dllDir = Join-Path $root 'src/App/bin/Debug/net10.0'
        New-Item -ItemType Directory -Path $dllDir -Force | Out-Null
        $dll = Join-Path $dllDir 'App.dll'
        Set-Content $dll 'binary'
        (Get-Item $dll).LastWriteTimeUtc = [datetime]::new(2020, 6, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        # Source edited after the build output was produced
        (Get-Item $src).LastWriteTimeUtc = [datetime]::new(2020, 12, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        $proj = Get-Item "$root/src/App/App.csproj"
        Test-BuildRequired -ProjectFile $proj -Root $root | Should -BeTrue
    }
}
