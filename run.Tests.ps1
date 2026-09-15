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

Describe 'Get-BuiltAssembly with AssemblyName override' {
    BeforeEach {
        $script:ovRoot = Join-Path $TestDrive ([guid]::NewGuid())
        $script:ovProj = Join-Path $script:ovRoot 'src/App/App.csproj'
        New-Item -ItemType Directory -Path (Split-Path $script:ovProj -Parent) -Force | Out-Null
        $xml = @(
            '<Project Sdk="Microsoft.NET.Sdk">'
            '  <PropertyGroup>'
            '    <OutputType>Exe</OutputType>'
            '    <TargetFramework>net10.0</TargetFramework>'
            '    <AssemblyName>codi</AssemblyName>'
            '  </PropertyGroup>'
            '</Project>'
        ) -join [Environment]::NewLine
        Set-Content -Path $script:ovProj -Value $xml
        $script:ovDllDir = Join-Path $script:ovRoot 'src/App/bin/Debug/net10.0'
        New-Item -ItemType Directory -Path $script:ovDllDir -Force | Out-Null
    }

    It 'finds the output assembly named by AssemblyName rather than the project file' {
        Set-Content (Join-Path $script:ovDllDir 'codi.dll') 'binary'

        $result = Get-BuiltAssembly -ProjectFile (Get-Item $script:ovProj)
        $result | Should -Not -BeNullOrEmpty
        $result.Name | Should -Be 'codi.dll'
    }

    It 'does not force a rebuild when the renamed output is newer than all sources' {
        $src = Join-Path $script:ovRoot 'src/App/Program.cs'
        Set-Content $src 'class P {}'
        (Get-Item $src).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        (Get-Item $script:ovProj).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        $dll = Join-Path $script:ovDllDir 'codi.dll'
        Set-Content $dll 'binary'
        (Get-Item $dll).LastWriteTimeUtc = [datetime]::new(2020, 6, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        Test-BuildRequired -ProjectFile (Get-Item $script:ovProj) -Root $script:ovRoot | Should -BeFalse
    }
}


Describe 'Get-NewestSourceWriteTime path exclusions are relative to the root' {
    It 'still finds sources when the root path itself sits under .worktrees' {
        $root = Join-Path $TestDrive '.worktrees/366-x'
        New-Item -ItemType Directory -Path (Join-Path $root 'src/App') -Force | Out-Null
        $src = Join-Path $root 'src/App/Program.cs'
        Set-Content $src 'class P {}'
        (Get-Item $src).LastWriteTimeUtc = [datetime]::new(2022, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        Get-NewestSourceWriteTime -Root $root |
            Should -Be ([datetime]::new(2022, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))
    }

    It 'still ignores a nested .worktrees directory inside the root' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-Item -ItemType Directory -Path (Join-Path $root 'src/App') -Force | Out-Null
        $src = Join-Path $root 'src/App/Program.cs'
        Set-Content $src 'class P {}'
        (Get-Item $src).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        $nested = Join-Path $root '.worktrees/other/src'
        New-Item -ItemType Directory -Path $nested -Force | Out-Null
        $nestedSrc = Join-Path $nested 'Other.cs'
        Set-Content $nestedSrc 'class O {}'
        (Get-Item $nestedSrc).LastWriteTimeUtc = [datetime]::new(2099, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        Get-NewestSourceWriteTime -Root $root |
            Should -Be ([datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))
    }

    It 'requires a build when a source under a .worktrees root is newer than the output' {
        $root = Join-Path $TestDrive '.worktrees/366-y'
        New-Item -ItemType Directory -Path (Join-Path $root 'src/App') -Force | Out-Null
        $proj = Join-Path $root 'src/App/App.csproj'
        New-CsprojStub $proj
        $src = Join-Path $root 'src/App/Program.cs'
        Set-Content $src 'class P {}'

        $dllDir = Join-Path $root 'src/App/bin/Debug/net10.0'
        New-Item -ItemType Directory -Path $dllDir -Force | Out-Null
        $dll = Join-Path $dllDir 'App.dll'
        Set-Content $dll 'binary'
        (Get-Item $dll).LastWriteTimeUtc = [datetime]::new(2020, 6, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        (Get-Item $proj).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        (Get-Item $src).LastWriteTimeUtc = [datetime]::new(2020, 12, 1, 0, 0, 0, [System.DateTimeKind]::Utc)

        Test-BuildRequired -ProjectFile (Get-Item $proj) -Root $root | Should -BeTrue
    }
}


Describe 'ConvertTo-ForwardedArgument' {
    It 'preserves an unquoted comma-separated token as typed' {
        # PowerShell binds `--to fb,ig` as a nested array literal @('fb','ig').
        $result = ConvertTo-ForwardedArgument -Argument @('--to', @('fb', 'ig'))
        $result[1] | Should -Be 'fb,ig'
    }

    It 'does not join a comma-separated token with a space' {
        $result = ConvertTo-ForwardedArgument -Argument @('--to', @('fb', 'ig'))
        $result[1] | Should -Not -Be 'fb ig'
    }

    It 'preserves three or more comma-separated values' {
        $result = ConvertTo-ForwardedArgument -Argument @('--to', @('fb', 'ig', 'tw'))
        $result[1] | Should -Be 'fb,ig,tw'
    }

    It 'keeps space-separated tokens as distinct entries' {
        $result = ConvertTo-ForwardedArgument -Argument @('--from', 'ps', '--dry-run')
        $result.Count | Should -Be 3
        $result[0] | Should -Be '--from'
        $result[1] | Should -Be 'ps'
        $result[2] | Should -Be '--dry-run'
    }

    It 'returns an empty array for no arguments' {
        (ConvertTo-ForwardedArgument -Argument @()).Count | Should -Be 0
        (ConvertTo-ForwardedArgument -Argument $null).Count | Should -Be 0
    }

    It 'emits every element as a string' {
        $result = ConvertTo-ForwardedArgument -Argument @('--count', 3, @('a', 'b'))
        foreach ($item in $result) { $item | Should -BeOfType [string] }
    }
}

Describe 'Test-RootHelpRequest' {
    It 'treats a leading help flag as a root help request' {
        foreach ($flag in @('--help', '-h', '-?')) {
            Test-RootHelpRequest -Command '' -Argument @($flag) | Should -BeTrue -Because "'$flag' leads the command line"
        }
    }

    It 'treats the help subcommand as a root help request' {
        Test-RootHelpRequest -Command 'help' -Argument @() | Should -BeTrue
    }

    It 'does not hijack a help flag intended for a subcommand' {
        # ./run.ps1 post --to fb --help  ->  'post' has been folded into $Argument
        Test-RootHelpRequest -Command '' -Argument @('post', '--to', 'fb', '--help') |
            Should -BeFalse -Because 'the app parser must resolve `post --help` itself'
    }

    It 'does not hijack a help flag in any non-leading position' {
        Test-RootHelpRequest -Command '' -Argument @('post', '--help', '--dry-run') | Should -BeFalse
        Test-RootHelpRequest -Command '' -Argument @('post', '-h') | Should -BeFalse
    }

    It 'leaves a help flag to a reserved subcommand that leads the line' {
        # ./run.ps1 test --help  ->  'test' stays in $Command
        Test-RootHelpRequest -Command 'test' -Argument @('--help') |
            Should -BeFalse -Because 'the flag belongs to `dotnet test`, not to root help'
    }

    It 'returns false when no arguments are supplied' {
        Test-RootHelpRequest -Command '' -Argument @() | Should -BeFalse
        Test-RootHelpRequest -Command '' -Argument $null | Should -BeFalse
    }
}
Describe 'Resolve-VerbosePassthrough (issue #461)' {
    It 're-injects --verbose when PowerShell swallowed the flag' {
        # ./run.ps1 mycommand -v  ->  [CmdletBinding()] prefix-matches -v to
        # -Verbose and strips it, so the app never sees it.
        $result = Resolve-VerbosePassthrough -ArgList @('mycommand') -VerboseBound $true
        $result.Count | Should -Be 2
        $result[0] | Should -Be '--verbose'
        $result[1] | Should -Be 'mycommand'
    }

    It 'does not double the flag when --verbose is already present' {
        $result = Resolve-VerbosePassthrough -ArgList @('--verbose', 'mycommand') -VerboseBound $true
        $result.Count | Should -Be 2
        $result[0] | Should -Be '--verbose'
    }

    It 'does not double the flag when -v survived in the argument list' {
        # `./run.ps1 -- mycommand -v` keeps -v: `--` ends parameter binding.
        $result = Resolve-VerbosePassthrough -ArgList @('mycommand', '-v') -VerboseBound $true
        $result.Count | Should -Be 2
        $result[1] | Should -Be '-v'
    }

    It 'leaves the argument list alone when -Verbose was not bound' {
        $result = Resolve-VerbosePassthrough -ArgList @('mycommand') -VerboseBound $false
        $result.Count | Should -Be 1
        $result[0] | Should -Be 'mycommand'
    }

    It 'returns an array for a single-element list rather than unrolling it' {
        # The `, $ArgList` comma operator guards this; without it PowerShell
        # unrolls the one-element array to a bare string.
        $result = Resolve-VerbosePassthrough -ArgList @('mycommand') -VerboseBound $false
        , $result | Should -BeOfType [System.Array]
    }

    It 'accepts an empty or null argument list without throwing' {
        $empty = Resolve-VerbosePassthrough -ArgList @() -VerboseBound $false
        , $empty | Should -BeOfType [System.Array]
        $empty.Count | Should -Be 0

        $fromNull = Resolve-VerbosePassthrough -ArgList $null -VerboseBound $true
        $fromNull.Count | Should -Be 1
        $fromNull[0] | Should -Be '--verbose'
    }
}

Describe 'run.ps1 invoked as a script: what actually reaches dotnet (issue #461)' {
    # These exercise the MAIN BODY, which dot-sourcing cannot reach (run.ps1
    # returns early when $MyInvocation.InvocationName is '.'). That matters:
    # the argument-nesting defect #461 fixes lived at a CALL SITE, not inside
    # any function, so every function-level test passed while the script itself
    # forwarded `post --to a,b` to the app as the single token `post --to a,b`.
    #
    # `& $run ...` runs run.ps1 in a child SCOPE, not a child process, so a
    # `dotnet` function defined here shadows the real executable and captures
    # the exact argument vector run.ps1 built -- no process boundary, no
    # command-line quoting to reinterpret, and no build to wait for.

    BeforeAll {
        $script:runFixture = Join-Path ([System.IO.Path]::GetTempPath()) ("run-argv-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:runFixture -Force | Out-Null
        New-CsprojStub -Path (Join-Path $script:runFixture 'src/App/App.csproj') -OutputType 'Exe'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination (Join-Path $script:runFixture 'run.ps1')
        $script:runScript = Join-Path $script:runFixture 'run.ps1'
        $script:capturePath = Join-Path $script:runFixture 'dotnet-argv.txt'
        $script:builtFixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("run-built-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:builtFixtureRoot -Force | Out-Null

        # One scriptblock holding the shim AND the accessors, dot-sourced at
        # the top of every It so all three are defined in THAT It's scope --
        # the only scope `& $script:runScript` inherits, and the only scope an
        # It body can call a helper from. Deliberately not global: a global
        # `dotnet` shim survives Invoke-Pester (the Function provider takes no
        # scope qualifier, so `Remove-Item function:global:dotnet` silently
        # removes nothing) and every sibling suite in the same session would
        # then run against a fake dotnet.
        $escapedCapture = $script:capturePath -replace "'", "''"
        $script:UseDotnetShim = [scriptblock]::Create(@"
            `$__capture = '$escapedCapture'
            `$__log = '$escapedCapture.log'
            if (Test-Path -LiteralPath `$__capture) { Remove-Item -LiteralPath `$__capture -Force }
            if (Test-Path -LiteralPath `$__log) { Remove-Item -LiteralPath `$__log -Force }

            function dotnet {
                # Capture to a file, not a variable: no scope rule then decides
                # whether the assertion can see what the shim recorded.
                # `$__capture holds the LAST invocation; `$__log every one, in order.
                Set-Content -LiteralPath `$__capture -Value (@(`$args) -join "``n") -NoNewline
                Add-Content -LiteralPath `$__log -Value (@(`$args) -join ' ')
                `$global:LASTEXITCODE = 0
            }

            # Every dotnet invocation, one space-joined line each, in order.
            function Get-DotnetInvocation {
                if (-not (Test-Path -LiteralPath `$__log)) { return @() }
                return @(Get-Content -LiteralPath `$__log)
            }

            # These two return PLAIN arrays, never a comma-wrapped one. Their
            # callers read them through @(...), and @() around a comma-wrapped
            # return re-nests the list -- the very defect this Describe exists
            # to catch. It silently made every assertion here read as empty
            # until it was found.
            # The full argument vector run.ps1 handed to dotnet.
            function Get-CapturedDotnetArg {
                if (-not (Test-Path -LiteralPath `$__capture)) { return @() }
                `$raw = Get-Content -LiteralPath `$__capture -Raw
                if (`$null -eq `$raw -or `$raw -eq '') { return @() }
                return @(`$raw -split "``n")
            }

            # The tokens run.ps1 forwards to the app: everything after the `--`
            # separator it appends. `$null when it never appended one.
            function Get-ForwardedToken {
                `$captured = @(Get-CapturedDotnetArg)
                `$sep = [array]::IndexOf(`$captured, '--')
                if (`$sep -lt 0) { return `$null }
                # Guard the empty tail: PowerShell's .. builds a DESCENDING
                # range when the start exceeds the end, so a trailing '--'
                # would hand back the whole command line reversed.
                if (`$sep -eq (`$captured.Count - 1)) { return @() }
                return @(`$captured[(`$sep + 1)..(`$captured.Count - 1)])
            }
"@)
    }

    AfterAll {
        Remove-Item -Recurse -Force -LiteralPath $script:runFixture -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force -LiteralPath $script:builtFixtureRoot -ErrorAction SilentlyContinue
    }

    It 'keeps a comma token as one argument and does not merge it with the flag' {
        . $script:UseDotnetShim
        # Wrapping the helper call in @() re-nested the list, and a [string[]]
        # parameter then joined it into 'post --to a,b' -- undoing issue #243.
        & $script:runScript post --to a,b | Out-Null
        $forwarded = Get-ForwardedToken
        $forwarded | Should -Be @('post', '--to', 'a,b')
    }

    It 'forwards no arguments at all when the caller supplied none' {
        . $script:UseDotnetShim
        # The same nesting produced a one-element list holding an empty array,
        # which arrived at the app as a single empty argument.
        & $script:runScript | Out-Null
        $captured = @(Get-CapturedDotnetArg)
        # Prove the shim actually fired FIRST. Get-ForwardedToken reports the
        # same empty result whether run.ps1 forwarded nothing or never invoked
        # dotnet at all, so asserting only on it would stay green through a
        # regression that lost the invocation entirely.
        $captured.Count | Should -BeGreaterThan 0 -Because 'run.ps1 must have reached `& dotnet` for this assertion to mean anything'
        $captured[0] | Should -Be 'run'
        $captured | Should -Not -Contain '--' -Because 'with nothing to forward, run.ps1 must not append the separator at all'
    }

    It 'forwards --verbose when PowerShell swallowed the caller -v' {
        . $script:UseDotnetShim
        & $script:runScript mycommand -v | Out-Null
        Get-ForwardedToken | Should -Be @('--verbose', 'mycommand')
    }

    It 'does not double the flag when the caller wrote --verbose explicitly' {
        . $script:UseDotnetShim
        & $script:runScript mycommand --verbose | Out-Null
        Get-ForwardedToken | Should -Be @('mycommand', '--verbose')
    }

    It 'does not double the flag when -v survived past a -- separator' {
        . $script:UseDotnetShim
        & $script:runScript -- mycommand -v | Out-Null
        Get-ForwardedToken | Should -Be @('mycommand', '-v')
    }

    It 'does not double the flag when -Verbose binds and --verbose lands in $Command' {
        . $script:UseDotnetShim
        # `-- --verbose` still binds -Verbose AND leaves --verbose as the
        # leading positional token; only the folded list can see it.
        & $script:runScript -Verbose -- --verbose | Out-Null
        Get-ForwardedToken | Should -Be @('--verbose')
    }

    It 'silences dotnet chatter with --verbosity quiet when no build is needed (issue #469)' {
        . $script:UseDotnetShim
        # `dotnet run` prints "Using launch settings from <abs path>..." on
        # every run. --verbosity quiet silences it without dropping the launch
        # profile, and still prints compiler errors.
        # Staged inline, not via a helper: a function defined in the Describe
        # body is not visible inside an It. The shimmed `dotnet` never builds
        # anything, so an up-to-date build output has to be put on disk rather
        # than produced.
        $built = Join-Path $script:builtFixtureRoot ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $built -Force | Out-Null
        New-CsprojStub -Path (Join-Path $built 'src/App/App.csproj') -OutputType 'Exe'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination (Join-Path $built 'run.ps1')
        $outDir = Join-Path $built 'src/App/bin/Debug/net10.0'
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
        $dll = Join-Path $outDir 'App.dll'
        Set-Content -LiteralPath $dll -Value 'stub'
        # Stamp it into the future so it beats every source file.
        (Get-Item -LiteralPath $dll).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddMinutes(5)

        & (Join-Path $built 'run.ps1') -- auth | Out-Null
        $captured = @(Get-CapturedDotnetArg)
        $captured | Should -Contain '--no-build' -Because 'this fixture is deliberately up to date'
        $captured | Should -Contain 'quiet'
        $joined = $captured -join ' '
        $joined | Should -Match '--verbosity quiet'
    }

    It 'builds as its own step, then runs quietly with --no-build, when a build is required (issue #519)' {
        . $script:UseDotnetShim
        # A separate build is what lets its output be erased once it succeeds.
        # quiet still must not reach the BUILD: it hides warnings, and a
        # consumer that has not set TreatWarningsAsErrors must see them while
        # the build runs. The run compiles nothing, so quiet is safe there and
        # silences `dotnet run`'s launch-settings line.
        & $script:runScript -- auth | Out-Null
        $calls = @(Get-DotnetInvocation)
        $calls.Count | Should -Be 2 -Because 'the stub project has never been built'
        $calls[0] | Should -Match '^build '
        $calls[0] | Should -Not -Match '--verbosity quiet' -Because 'build warnings must reach a consumer that has not set TreatWarningsAsErrors'
        $calls[0] | Should -Not -Match '--no-restore' -Because 'the stub project has never been restored'
        $captured = @(Get-CapturedDotnetArg)
        $captured[0] | Should -Be 'run'
        $captured | Should -Contain '--no-build'
        ($captured -join ' ') | Should -Match '--verbosity quiet'
    }

    It 'does not run the application when the build fails, and exits with the build''s code (issue #519)' {
        . $script:UseDotnetShim
        # A later definition wins: this dotnet fails the build step only.
        function dotnet {
            Add-Content -LiteralPath $__log -Value (@($args) -join ' ')
            if ($args[0] -eq 'build') {
                'Program.cs(1,1): error CS1002: ; expected'
                $global:LASTEXITCODE = 1
                return
            }
            $global:LASTEXITCODE = 0
        }
        $out = & $script:runScript -- auth 6>&1 | Out-String
        $LASTEXITCODE | Should -Be 1
        @(Get-DotnetInvocation).Count | Should -Be 1 -Because 'a failed build must not be followed by a run'
        $out | Should -Match 'error CS1002' -Because 'a failed build keeps its output on screen'
    }

    It 'skips restore while the recorded restore is newer than every project file (issue #519)' {
        . $script:UseDotnetShim
        $root = Join-Path $script:builtFixtureRoot ([guid]::NewGuid().ToString('N'))
        New-CsprojStub -Path (Join-Path $root 'src/App/App.csproj') -OutputType 'Exe'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination (Join-Path $root 'run.ps1')
        $obj = Join-Path $root 'src/App/obj'
        New-Item -ItemType Directory -Path $obj -Force | Out-Null
        foreach ($name in 'project.assets.json', 'run.ps1.restored') {
            $file = Join-Path $obj $name
            Set-Content -LiteralPath $file -Value '{}'
            (Get-Item -LiteralPath $file).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddMinutes(5)
        }

        & (Join-Path $root 'run.ps1') -- auth | Out-Null
        @(Get-DotnetInvocation)[0] | Should -Match '^build .* --no-restore$'
    }

    It 'retries the build with restore when --no-restore fails on missing restore output (issue #519)' {
        . $script:UseDotnetShim
        function dotnet {
            Add-Content -LiteralPath $__log -Value (@($args) -join ' ')
            if ($args[0] -eq 'build' -and $args -contains '--no-restore') {
                'error NETSDK1004: Assets file ''obj\project.assets.json'' not found.'
                $global:LASTEXITCODE = 1
                return
            }
            $global:LASTEXITCODE = 0
        }
        $root = Join-Path $script:builtFixtureRoot ([guid]::NewGuid().ToString('N'))
        New-CsprojStub -Path (Join-Path $root 'src/App/App.csproj') -OutputType 'Exe'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination (Join-Path $root 'run.ps1')
        $obj = Join-Path $root 'src/App/obj'
        New-Item -ItemType Directory -Path $obj -Force | Out-Null
        foreach ($name in 'project.assets.json', 'run.ps1.restored') {
            $file = Join-Path $obj $name
            Set-Content -LiteralPath $file -Value '{}'
            (Get-Item -LiteralPath $file).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddMinutes(5)
        }

        & (Join-Path $root 'run.ps1') -- auth 6>$null | Out-Null
        $LASTEXITCODE | Should -Be 0
        $calls = @(Get-DotnetInvocation)
        $calls.Count | Should -Be 3
        $calls[0] | Should -Match '--no-restore'
        $calls[1] | Should -Match '^build '
        $calls[1] | Should -Not -Match '--no-restore'
        $calls[2] | Should -Match '^run '
    }

    It 'records the restore after a successful build that restored (issue #519)' {
        . $script:UseDotnetShim
        $root = Join-Path $script:builtFixtureRoot ([guid]::NewGuid().ToString('N'))
        New-CsprojStub -Path (Join-Path $root 'src/App/App.csproj') -OutputType 'Exe'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run.ps1') -Destination (Join-Path $root 'run.ps1')
        New-Item -ItemType Directory -Path (Join-Path $root 'src/App/obj') -Force | Out-Null

        & (Join-Path $root 'run.ps1') -- auth | Out-Null
        Join-Path $root 'src/App/obj/run.ps1.restored' | Should -Exist
    }

    It 'never injects --verbose into a dotnet test command line' {
        . $script:UseDotnetShim
        # `dotnet test` has no --verbose switch (it takes -v/--verbosity), and
        # test mode appends $Args with no `--` separator, so an injected flag
        # is parsed by the dotnet CLI itself: MSBUILD error MSB1001.
        & $script:runScript -Verbose test | Out-Null
        @(Get-CapturedDotnetArg) | Should -Not -Contain '--verbose'
        @(Get-CapturedDotnetArg)[0] | Should -Be 'test'
    }
}

Describe 'run.project.ps1 consumer hook (issue #462)' {
    # The hook loads BELOW run.ps1's dot-source guard, so `. ./run.ps1` never
    # loads it -- deliberately, so a consumer's overrides cannot leak into
    # upstream's own tests. That also means hook behaviour can only be
    # exercised by INVOKING run.ps1 as a script against a fixture that
    # contains a run.project.ps1, which is what these do.

    BeforeAll {
        $script:hookRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("run-hook-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:hookRoot -Force | Out-Null
        $script:hookTestsRoot = $PSScriptRoot

        # This Describe needs its OWN dotnet shim: the argv Describe's capture
        # file lives inside a fixture its AfterAll deletes, so reusing that
        # shim writes to a directory that no longer exists.
        $script:hookCapture = Join-Path $script:hookRoot 'dotnet-argv.txt'
        $escapedHookCapture = $script:hookCapture -replace "'", "''"
        $script:UseHookShim = [scriptblock]::Create(@"
            `$__capture = '$escapedHookCapture'
            `$__log = '$escapedHookCapture.log'
            if (Test-Path -LiteralPath `$__capture) { Remove-Item -LiteralPath `$__capture -Force }
            if (Test-Path -LiteralPath `$__log) { Remove-Item -LiteralPath `$__log -Force }

            function dotnet {
                Set-Content -LiteralPath `$__capture -Value (@(`$args) -join "``n") -NoNewline
                Add-Content -LiteralPath `$__log -Value (@(`$args) -join ' ')
                `$global:LASTEXITCODE = 0
            }

            function Get-DotnetInvocation {
                if (-not (Test-Path -LiteralPath `$__log)) { return @() }
                return @(Get-Content -LiteralPath `$__log)
            }

            function Get-CapturedDotnetArg {
                if (-not (Test-Path -LiteralPath `$__capture)) { return @() }
                `$raw = Get-Content -LiteralPath `$__capture -Raw
                if (`$null -eq `$raw -or `$raw -eq '') { return @() }
                return @(`$raw -split "``n")
            }

            function Get-ForwardedToken {
                `$captured = @(Get-CapturedDotnetArg)
                `$sep = [array]::IndexOf(`$captured, '--')
                if (`$sep -lt 0) { return `$null }
                if (`$sep -eq (`$captured.Count - 1)) { return @() }
                return @(`$captured[(`$sep + 1)..(`$captured.Count - 1)])
            }
"@)

        # Builds a fixture project + run.ps1, optionally with a
        # run.project.ps1. A scriptblock dot-sourced into each It, because a
        # function declared in a Describe body is not visible inside one.
        $script:NewHookFixture = {
            function New-HookFixture {
                param([string]$HookBody)
                $root = Join-Path $script:hookRoot ([guid]::NewGuid().ToString('N'))
                New-Item -ItemType Directory -Path $root -Force | Out-Null
                New-CsprojStub -Path (Join-Path $root 'src/App/App.csproj') -OutputType 'Exe'
                Copy-Item -LiteralPath (Join-Path $script:hookTestsRoot 'run.ps1') -Destination (Join-Path $root 'run.ps1')
                if ($PSBoundParameters.ContainsKey('HookBody')) {
                    Set-Content -LiteralPath (Join-Path $root 'run.project.ps1') -Value $HookBody
                }
                return $root
            }
        }
    }

    AfterAll {
        Remove-Item -Recurse -Force -LiteralPath $script:hookRoot -ErrorAction SilentlyContinue
    }

    It 'runs normally when no run.project.ps1 exists' {
        . $script:UseHookShim
        . $script:NewHookFixture
        $root = New-HookFixture
        & (Join-Path $root 'run.ps1') -- hello | Out-Null
        Get-ForwardedToken | Should -Be @('hello')
    }

    It 'lets the hook set an environment variable the child process inherits' {
        . $script:UseHookShim
        . $script:NewHookFixture
        $root = New-HookFixture -HookBody '$env:RUN_PROJECT_HOOK_MARKER = "set-by-hook"'
        $env:RUN_PROJECT_HOOK_MARKER = $null
        & (Join-Path $root 'run.ps1') -- hello | Out-Null
        $env:RUN_PROJECT_HOOK_MARKER | Should -Be 'set-by-hook' -Because 'the hook is dot-sourced, so it shares run.ps1 scope'
        $env:RUN_PROJECT_HOOK_MARKER = $null
    }

    It 'lets the hook override an upstream function' {
        . $script:UseHookShim
        . $script:NewHookFixture
        # Redefining ConvertTo-ForwardedArgument uppercases every forwarded
        # token -- proof that the later definition wins.
        $body = @'
function ConvertTo-ForwardedArgument {
    [OutputType([string[]])]
    param([object[]]$Argument)
    if (-not $Argument) { return , @() }
    return , @(foreach ($item in $Argument) { ([string]$item).ToUpperInvariant() })
}
'@
        $root = New-HookFixture -HookBody $body
        & (Join-Path $root 'run.ps1') -- hello | Out-Null
        Get-ForwardedToken | Should -Be @('HELLO') -Because 'a later definition wins in PowerShell'
    }

    It 'dispatches a subcommand the hook registered, instead of forwarding it' {
        . $script:UseHookShim
        . $script:NewHookFixture
        $body = @'
$ReservedCommands += 'deploy'
function Invoke-ProjectCommand {
    param([string]$Command, [string[]]$Argument)
    Write-Host "PROJECT-COMMAND:$Command($($Argument -join ','))"
    $global:LASTEXITCODE = 0
}
'@
        $root = New-HookFixture -HookBody $body
        $out = & (Join-Path $root 'run.ps1') deploy --to prod 6>&1 | Out-String
        $out | Should -Match 'PROJECT-COMMAND:deploy'
        $out | Should -Match '--to,prod'
        Get-CapturedDotnetArg | Should -BeNullOrEmpty -Because 'a dispatched subcommand must not also reach dotnet'
    }

    It 'does not report a stale exit code when the handler never sets one' {
        . $script:UseHookShim
        . $script:NewHookFixture
        # $LASTEXITCODE is process-wide. A handler that never shells out leaves
        # it untouched, so without zeroing it first run.ps1 would exit with
        # whatever an unrelated earlier command left behind.
        $body = @'
$ReservedCommands += 'deploy'
function Invoke-ProjectCommand {
    param([string]$Command, [string[]]$Argument)
    Write-Host "handled $Command"
}
'@
        $root = New-HookFixture -HookBody $body
        $global:LASTEXITCODE = 5
        & (Join-Path $root 'run.ps1') deploy 6>$null | Out-Null
        $LASTEXITCODE | Should -Be 0 -Because 'a silent handler succeeded; 5 belonged to something else entirely'
    }

    It 'reports the exit code a handler sets deliberately' {
        . $script:UseHookShim
        . $script:NewHookFixture
        $body = @'
$ReservedCommands += 'deploy'
function Invoke-ProjectCommand {
    param([string]$Command, [string[]]$Argument)
    $global:LASTEXITCODE = 3
}
'@
        $root = New-HookFixture -HookBody $body
        $global:LASTEXITCODE = 0
        & (Join-Path $root 'run.ps1') deploy 6>$null | Out-Null
        $LASTEXITCODE | Should -Be 3 -Because 'zeroing must not clobber a handler that reports failure'
    }

    It 'fails loudly when a registered subcommand has no handler' {
        . $script:UseHookShim
        . $script:NewHookFixture
        # Appending to $ReservedCommands alone only stops the token reaching
        # the app; without Invoke-ProjectCommand it would silently do nothing.
        $root = New-HookFixture -HookBody '$ReservedCommands += ''deploy'''
        # run.ps1 sets $ErrorActionPreference = 'Stop', so its Write-Error is
        # terminating and propagates out of the `&` call.
        $message = $null
        try { & (Join-Path $root 'run.ps1') deploy | Out-Null }
        catch { $message = $_.Exception.Message }
        $message | Should -Match 'defines no Invoke-ProjectCommand'
        Get-CapturedDotnetArg | Should -BeNullOrEmpty
    }

    It 'lets the hook mutate the dotnet command line before it runs' {
        . $script:UseHookShim
        . $script:NewHookFixture
        $body = @'
function Invoke-ProjectPreRun {
    param([string[]]$DotnetArgument, [string]$Project)
    return , (@($DotnetArgument) + '--added-by-hook')
}
'@
        $root = New-HookFixture -HookBody $body
        & (Join-Path $root 'run.ps1') -- hello | Out-Null
        @(Get-CapturedDotnetArg) | Should -Contain '--added-by-hook'
    }

    It 'accepts a pre-run hook that returns a plain array, not just a comma-wrapped one' {
        . $script:UseHookShim
        . $script:NewHookFixture
        # The other pre-run test returns `, $list`; this one returns a plain
        # array. Both are idiomatic PowerShell and a public contract has to
        # accept either -- wrapping the CALL in @() breaks the first.
        $body = @'
function Invoke-ProjectPreRun {
    param([string[]]$DotnetArgument, [string]$Project)
    $out = @($DotnetArgument) + '--plain-array-hook'
    return $out
}
'@
        $root = New-HookFixture -HookBody $body
        & (Join-Path $root 'run.ps1') -- hello | Out-Null
        @(Get-CapturedDotnetArg) | Should -Contain '--plain-array-hook'
        Get-ForwardedToken | Should -Contain 'hello' -Because 'the rest of the command line must survive the hook'
    }

    It 'builds the configuration a pre-run hook asks the run for (issue #519)' {
        . $script:UseHookShim
        . $script:NewHookFixture
        # The run looks for a Release build, so the separate build step has to
        # produce one -- or `--no-build` would run stale or missing output.
        $body = @'
function Invoke-ProjectPreRun {
    param([string[]]$DotnetArgument, [string]$Project)
    # Before the `--` separator: after it, the tokens belong to the app.
    $sep = [array]::IndexOf($DotnetArgument, '--')
    if ($sep -lt 0) { return , (@($DotnetArgument) + @('-c', 'Release')) }
    return , (@($DotnetArgument[0..($sep - 1)]) + @('-c', 'Release') + @($DotnetArgument[$sep..($DotnetArgument.Count - 1)]))
}
'@
        $root = New-HookFixture -HookBody $body
        & (Join-Path $root 'run.ps1') -- hello | Out-Null
        $calls = @(Get-DotnetInvocation)
        $calls[0] | Should -Match '^build .* -c Release'
        $calls[-1] | Should -Match '^run .* -c Release'
    }

    It 'calls the post-run seam with the exit code' {
        . $script:UseHookShim
        . $script:NewHookFixture
        $body = @'
function Invoke-ProjectPostRun {
    param([int]$ExitCode, [string]$Project)
    Write-Host "POST-RUN:$ExitCode"
}
'@
        $root = New-HookFixture -HookBody $body
        $out = & (Join-Path $root 'run.ps1') -- hello 6>&1 | Out-String
        $out | Should -Match 'POST-RUN:0'
    }

    It 'does NOT load the hook when run.ps1 is dot-sourced' {
        . $script:NewHookFixture
        # The guard is what stops a consumer's overrides leaking into
        # upstream's own test session. If this regresses, every suite that
        # dot-sources run.ps1 silently inherits whatever the consumer wrote.
        $root = New-HookFixture -HookBody '$global:RUN_PROJECT_HOOK_DOTSOURCED = $true'
        $global:RUN_PROJECT_HOOK_DOTSOURCED = $null
        . (Join-Path $root 'run.ps1')
        $global:RUN_PROJECT_HOOK_DOTSOURCED | Should -BeNullOrEmpty -Because 'the hook loads below the dot-source guard'
    }
}

Describe 'Transient build status (issue #249)' {

    BeforeEach {
        $script:TransientStatusLength = 0
        $script:TransientStatusEnabled = $true
    }

    AfterEach {
        $script:TransientStatusEnabled = Test-TransientConsole
        $script:TransientStatusLength = 0
    }

    It 'tracks the length of the message it wrote' {
        Write-TransientStatus 'abcd' 6>$null
        $script:TransientStatusLength | Should -Be 4
    }

    It 'pads a shorter message to erase the longer one before it' {
        # The bug this guards: 'No build required.' is shorter than
        # 'Checking whether a build is required...', so without padding the
        # tail of the longer message would stay on screen.
        Write-TransientStatus 'Checking whether a build is required...' 6>$null
        $long = $script:TransientStatusLength
        Write-TransientStatus 'No build required.' 6>$null
        $long | Should -BeGreaterThan $script:TransientStatusLength
        $script:TransientStatusLength | Should -Be 18
    }

    It 'resets the tracked length when cleared' {
        Write-TransientStatus 'something' 6>$null
        Clear-TransientStatus 6>$null
        $script:TransientStatusLength | Should -Be 0
    }

    It 'is a no-op to clear when nothing was written' {
        { Clear-TransientStatus 6>$null } | Should -Not -Throw
        $script:TransientStatusLength | Should -Be 0
    }

    It 'writes nothing when output is redirected' {
        # Redirected output is a log or a captured bug report. Carriage
        # returns and padding would land in it as one garbled physical line.
        $script:TransientStatusEnabled = $false
        Write-TransientStatus 'should not appear' 6>$null
        $script:TransientStatusLength | Should -Be 0
    }

    It 'does not clear a live status when redirected' {
        $script:TransientStatusEnabled = $true
        Write-TransientStatus 'live' 6>$null
        $script:TransientStatusEnabled = $false
        Clear-TransientStatus 6>$null
        $script:TransientStatusLength | Should -Be 4
    }
}

Describe 'Get-TreeFile (issue #519)' {
    It 'never descends into a pruned directory' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        $wanted = Join-Path $root 'src/App/Program.cs'
        New-Item -ItemType Directory -Path (Split-Path $wanted -Parent) -Force | Out-Null
        Set-Content -LiteralPath $wanted -Value 'class P {}'
        foreach ($dir in 'bin', 'obj', '.git', '.worktrees/other', '.vs', 'node_modules/pkg', 'src/App/bin/Debug', 'src/App/obj') {
            $path = Join-Path $root $dir
            New-Item -ItemType Directory -Path $path -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $path 'Hidden.cs') -Value 'class H {}'
        }

        $found = @(Get-TreeFile -Root $root -Extension '.cs')
        $found.Count | Should -Be 1
        $found[0].FullName | Should -Be ([System.IO.Path]::GetFullPath($wanted))
    }

    It 'matches by file name as well as by extension, ignoring case' {
        $root = Join-Path $TestDrive ([guid]::NewGuid())
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $root 'NuGet.Config') -Value '<configuration />'
        Set-Content -LiteralPath (Join-Path $root 'readme.md') -Value 'x'

        $found = @(Get-TreeFile -Root $root -FileName 'nuget.config')
        $found.Name | Should -Be @('NuGet.Config')
    }

    It 'returns nothing, without throwing, for a root that does not exist' {
        $missing = Join-Path $TestDrive ([guid]::NewGuid())
        @(Get-TreeFile -Root $missing -Extension '.cs').Count | Should -Be 0
    }
}

Describe 'Test-RestoreRequired (issue #519)' {
    BeforeEach {
        $script:rrRoot = Join-Path $TestDrive ([guid]::NewGuid())
        $script:rrProj = Join-Path $script:rrRoot 'src/App/App.csproj'
        New-CsprojStub -Path $script:rrProj
        (Get-Item -LiteralPath $script:rrProj).LastWriteTimeUtc = [datetime]::new(2020, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        $script:rrObj = Join-Path $script:rrRoot 'src/App/obj'
        New-Item -ItemType Directory -Path $script:rrObj -Force | Out-Null
        $script:rrStamp = [datetime]::new(2020, 6, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        foreach ($name in 'project.assets.json', 'run.ps1.restored') {
            $file = Join-Path $script:rrObj $name
            Set-Content -LiteralPath $file -Value '{}'
            (Get-Item -LiteralPath $file).LastWriteTimeUtc = $script:rrStamp
        }
    }

    It 'does not require a restore when the recorded restore is newer than every input' {
        Test-RestoreRequired -ProjectFile (Get-Item $script:rrProj) -Root $script:rrRoot | Should -BeFalse
    }

    It 'requires a restore when run.ps1 has never recorded one' {
        Remove-Item -LiteralPath (Join-Path $script:rrObj 'run.ps1.restored')
        Test-RestoreRequired -ProjectFile (Get-Item $script:rrProj) -Root $script:rrRoot | Should -BeTrue
    }

    It 'requires a restore when the restore output itself is missing' {
        Remove-Item -LiteralPath (Join-Path $script:rrObj 'project.assets.json')
        Test-RestoreRequired -ProjectFile (Get-Item $script:rrProj) -Root $script:rrRoot | Should -BeTrue
    }

    It 'requires a restore when a package file changed after the recorded restore' {
        $props = Join-Path $script:rrRoot 'Directory.Packages.props'
        Set-Content -LiteralPath $props -Value '<Project />'
        (Get-Item -LiteralPath $props).LastWriteTimeUtc = $script:rrStamp.AddDays(1)
        Test-RestoreRequired -ProjectFile (Get-Item $script:rrProj) -Root $script:rrRoot | Should -BeTrue
    }

    It 'ignores source-code changes, which a restore does not depend on' {
        $src = Join-Path $script:rrRoot 'src/App/Program.cs'
        Set-Content -LiteralPath $src -Value 'class P {}'
        (Get-Item -LiteralPath $src).LastWriteTimeUtc = $script:rrStamp.AddDays(1)
        Test-RestoreRequired -ProjectFile (Get-Item $script:rrProj) -Root $script:rrRoot | Should -BeFalse
    }
}

Describe 'Test-RestoreFailure (issue #519)' {
    It 'recognizes build errors that a restore fixes' {
        Test-RestoreFailure -Output @('x', 'error NETSDK1004: Assets file not found.') | Should -BeTrue
        Test-RestoreFailure -Output @('error NETSDK1064: Package Foo was not found.') | Should -BeTrue
    }

    It 'does not mistake an ordinary compile error for one' {
        Test-RestoreFailure -Output @('Program.cs(1,1): error CS1002: ; expected') | Should -BeFalse
        Test-RestoreFailure -Output $null | Should -BeFalse
    }
}

Describe 'Get-BuildAffectingArgument (issue #519)' {
    It 'keeps the options that change what gets built, with their values' {
        $result = Get-BuildAffectingArgument -DotnetArgument @(
            'run', '--project', 'App.csproj', '--no-build', '-c', 'Release',
            '--framework=net10.0', '-p:Foo=1', '--launch-profile', 'Default')
        $result | Should -Be @('-c', 'Release', '--framework=net10.0', '-p:Foo=1')
    }

    It 'ignores everything after the -- separator, which belongs to the application' {
        $result = Get-BuildAffectingArgument -DotnetArgument @('run', '--', '-c', 'Release')
        $result.Count | Should -Be 0
    }
}

Describe 'Format-TransientWindow (issue #519)' {
    It 'shows the title and only the latest lines, capped' {
        $lines = 1..30 | ForEach-Object { "line $_" }
        $rows = Format-TransientWindow -Title 'Building' -Line $lines -Width 120 -Height 50
        $rows.Count | Should -Be ($script:TransientWindowMaxLines + 1)
        $rows[0] | Should -Be 'Building'
        $rows[-1] | Should -Be '  line 30'
    }

    It 'stays shorter than the console so it can always be erased' {
        $lines = 1..30 | ForEach-Object { "line $_" }
        $rows = Format-TransientWindow -Title 'Building' -Line $lines -Width 120 -Height 6
        $rows.Count | Should -BeLessThan 6
    }

    It 'cuts every row to fit on one console line, so none wraps' {
        $rows = Format-TransientWindow -Title ('T' * 200) -Line @("`tindented", ('x' * 200)) -Width 40 -Height 50
        foreach ($row in $rows) { $row.Length | Should -BeLessThan 40 }
    }

    It 'skips blank output lines' {
        $rows = Format-TransientWindow -Title 'Building' -Line @('', '   ', 'real') -Width 80 -Height 50
        $rows | Should -Be @('Building', '  real')
    }
}

Describe 'Transient build window (issue #519)' {
    BeforeEach {
        $script:TransientStatusEnabled = $true
        $script:TransientWindowHeight = 0
        $script:TransientStatusLength = 0
    }

    AfterEach {
        $script:TransientStatusEnabled = Test-TransientConsole
        $script:TransientWindowHeight = 0
        $script:TransientStatusLength = 0
    }

    It 'erases every row it drew once the build finishes' -Skip:(-not $Host.UI.SupportsVirtualTerminal) {
        Mock Get-ConsoleWindowSize { @{ Width = 80; Height = 40 } }
        function dotnet { 'Determining projects to restore...'; ''; '  App -> bin/App.dll'; $global:LASTEXITCODE = 0 }

        $drawn = (Invoke-TransientBuild -Argument @('build') -Title 'Building App...' 6>&1 |
                Where-Object { $_ -is [System.Management.Automation.InformationRecord] } |
                ForEach-Object { "$($_.MessageData)" }) -join ''

        $esc = [char]27
        # The last frame held the title plus two non-blank lines.
        $drawn | Should -Match ([regex]::Escape("$esc[3F$esc[0J") + '$') -Because 'the final write must move up over all 3 rows and clear them'
        $script:TransientWindowHeight | Should -Be 0
    }

    It 'returns the exit code and every captured line' {
        Mock Get-ConsoleWindowSize { @{ Width = 80; Height = 40 } }
        function dotnet { 'one'; 'two'; $global:LASTEXITCODE = 7 }
        $result = Invoke-TransientBuild -Argument @('build') -Title 'Building' 6>$null
        $result.ExitCode | Should -Be 7
        $result.Output | Should -Be @('one', 'two')
    }

    It 'draws nothing, and does not throw, when the host has no console window to measure' {
        # [Console]::WindowWidth throws "The handle is invalid" in such a host.
        Mock Get-ConsoleWindowSize { $null }
        { Write-TransientWindow -Title 'Building' -Line @('x') 6>$null } | Should -Not -Throw
        $script:TransientWindowHeight | Should -Be 0
    }
}