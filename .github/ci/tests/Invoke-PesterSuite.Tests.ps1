#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }

# End-to-end tests for Invoke-PesterSuite.ps1 -- the entry point the CI job
# calls. PesterGate.Tests.ps1 covers discovery and verdict logic directly; these
# tests cover the wiring, and specifically the contract CI depends on: the
# process exit code.
#
# Each case runs the script in a child pwsh against a throwaway fixture tree, so
# a real Invoke-Pester run happens without nesting inside this one.

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..\Invoke-PesterSuite.ps1' |
        Resolve-Path | Select-Object -ExpandProperty Path

    $script:Pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $script:Pwsh) {
        $script:Pwsh = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    }

    $script:TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "invoke-pester-suite-tests-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $script:TempDir | Out-Null

    # Creates a fixture tree containing one test file with the given body.
    function script:NewFixture {
        param(
            [Parameter(Mandatory)][string]$Name,
            [Parameter(Mandatory)][string]$Body,
            [switch]$Hidden
        )
        $root = Join-Path $script:TempDir $Name
        $inner = if ($Hidden) { Join-Path $root '.github' } else { Join-Path $root 'suite' }
        New-Item -ItemType Directory -Force -Path $inner | Out-Null
        Set-Content -LiteralPath (Join-Path $inner 'Fixture.Tests.ps1') -Value $Body
        if ($Hidden) {
            (Get-Item -LiteralPath $inner -Force).Attributes = 'Directory,Hidden'
        }
        return $inner
    }

    # Runs the entry script in a child pwsh and returns its exit code + output.
    function script:InvokeGate {
        param([Parameter(Mandatory)][string[]]$TargetPath)
        $argsList = @('-NoProfile', '-File', $script:ScriptPath, '-Path') + $TargetPath
        $output = & $script:Pwsh @argsList 2>&1 | Out-String
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    }

    $script:PassingBody = 'Describe "fixture" { It "passes" { 1 | Should -Be 1 } }'
    $script:FailingBody = 'Describe "fixture" { It "fails" { 1 | Should -Be 2 } }'
}

AfterAll {
    if ($script:TempDir -and (Test-Path -LiteralPath $script:TempDir)) {
        Remove-Item -LiteralPath $script:TempDir -Recurse -Force
    }
}

Describe 'Invoke-PesterSuite' {

    Context 'a suite living in a hidden directory' {
        BeforeAll {
            $fixture = script:NewFixture -Name 'hidden-pass' -Body $script:PassingBody -Hidden
            $script:HiddenRun = script:InvokeGate -TargetPath $fixture
        }

        It 'exits zero' {
            # The regression test for issue #304. Before the fix, Invoke-Pester
            # could not resolve a hidden directory at all.
            $script:HiddenRun.ExitCode | Should -Be 0
        }

        It 'reports that a test actually ran' {
            $script:HiddenRun.Output | Should -Match '1 test'
        }
    }

    Context 'a suite with a failing test' {
        BeforeAll {
            $fixture = script:NewFixture -Name 'failing' -Body $script:FailingBody
            $script:FailRun = script:InvokeGate -TargetPath $fixture
        }

        It 'exits non-zero' {
            $script:FailRun.ExitCode | Should -Not -Be 0
        }

        It 'annotates the failure for GitHub Actions' {
            $script:FailRun.Output | Should -Match '::error::'
        }
    }

    Context 'a root containing no test files' {
        BeforeAll {
            $empty = Join-Path $script:TempDir 'no-tests'
            New-Item -ItemType Directory -Force -Path $empty | Out-Null
            Set-Content -LiteralPath (Join-Path $empty 'Readme.md') -Value 'nothing here'
            $script:EmptyRun = script:InvokeGate -TargetPath $empty
        }

        It 'exits non-zero rather than reporting a vacuous success' {
            $script:EmptyRun.ExitCode | Should -Not -Be 0
        }

        It 'says no test files were discovered' {
            $script:EmptyRun.Output | Should -Match 'no test files'
        }
    }

    Context 'a root that does not exist' {
        BeforeAll {
            $script:MissingRun = script:InvokeGate -TargetPath (Join-Path $script:TempDir 'absent')
        }

        It 'exits non-zero' {
            $script:MissingRun.ExitCode | Should -Not -Be 0
        }

        It 'names the missing root' {
            $script:MissingRun.Output | Should -Match 'absent'
        }
    }

    Context 'a clean suite' {
        BeforeAll {
            $fixture = script:NewFixture -Name 'clean' -Body $script:PassingBody
            $script:CleanRun = script:InvokeGate -TargetPath $fixture
        }

        It 'exits zero' {
            $script:CleanRun.ExitCode | Should -Be 0
        }
    }

    Context 'the environment the suite runs in' {
        It 'does not impose StrictMode on the tests it runs' {
            # The gate shares a session with the suite, so anything it sets
            # leaks into every test. Set-StrictMode -Version Latest in the entry
            # script turned six unrelated, previously-passing tests red -- a
            # gate that changes the outcome it is measuring is worthless.
            #
            # Under StrictMode Latest, reading an absent property throws; without
            # it, the property is $null. So this fixture passes only if the gate
            # left the mode alone.
            $body = 'Describe "strict" { It "treats a missing property as null" { ' +
            '([pscustomobject]@{}).Nope | Should -BeNullOrEmpty } }'
            $fixture = script:NewFixture -Name 'strictmode' -Body $body

            (script:InvokeGate -TargetPath $fixture).ExitCode | Should -Be 0
        }

        It 'still reaches a verdict when a test unloads the gate module' {
            # PesterGate's own tests import the module and remove it in AfterAll.
            # Running them through the gate unloaded the very functions the gate
            # needed next, and it died after the suite had already passed.
            $body = 'Describe "unload" { ' +
            'AfterAll { Remove-Module PesterGate -Force -ErrorAction SilentlyContinue }; ' +
            'It "passes" { 1 | Should -Be 1 } }'
            $fixture = script:NewFixture -Name 'unload-module' -Body $body

            $run = script:InvokeGate -TargetPath $fixture

            $run.ExitCode | Should -Be 0
            $run.Output | Should -Not -Match 'not recognized'
        }
    }
}
