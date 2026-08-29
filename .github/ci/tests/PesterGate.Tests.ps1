#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }

# Tests for PesterGate.psm1 -- the CI gate behind the "Pester tests (.github/)"
# job. Behavior-first: each test states an observable outcome of the gate, not
# the internal layout of the module.
#
# The bug these exist to prevent (issue #304): the job exited 0 while running
# zero tests, for two independent reasons -- Pester could not resolve the hidden
# .github directory, and the gate only asked "did any test fail?".

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\PesterGate.psm1' |
        Resolve-Path | Select-Object -ExpandProperty Path
    Import-Module $script:ModulePath -Force

    $script:TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "pester-gate-tests-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $script:TempDir | Out-Null

    # Stand-in for the object Invoke-Pester returns via -PassThru. The gate only
    # reads these four members, so a synthetic object exercises every verdict
    # without paying for a real nested Pester run.
    function script:NewResult {
        param(
            [int]$Total = 1,
            [int]$Failed = 0,
            [string]$Result = 'Passed',
            [string[]]$ContainerPath = @()
        )
        [pscustomobject]@{
            TotalCount  = $Total
            FailedCount = $Failed
            Result      = $Result
            Containers  = @($ContainerPath | ForEach-Object {
                    [pscustomobject]@{ Item = [pscustomobject]@{ FullName = $_ } }
                })
        }
    }
}

AfterAll {
    Remove-Module PesterGate -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $script:TempDir) {
        Remove-Item -LiteralPath $script:TempDir -Recurse -Force
    }
}

Describe 'Get-PesterTestFile' {

    It 'finds a test file inside a hidden directory' {
        # The exact failure in issue #304: .github is hidden on Linux, and
        # Pester's own Find-File calls Get-Item without -Force, so handing it
        # the directory resolves to nothing. Discovery must not have that flaw.
        $root = Join-Path $script:TempDir 'hidden-case'
        $hidden = Join-Path $root '.github'
        New-Item -ItemType Directory -Force -Path $hidden | Out-Null
        Set-Content -LiteralPath (Join-Path $hidden 'A.Tests.ps1') -Value '# test'
        (Get-Item -LiteralPath $hidden -Force).Attributes = 'Directory,Hidden'

        $found = @(Get-PesterTestFile -Path $hidden)

        $found.Count | Should -Be 1
        $found[0] | Should -BeLike '*A.Tests.ps1'
    }

    It 'finds test files nested below the root' {
        $root = Join-Path $script:TempDir 'nested-case'
        $deep = Join-Path $root 'a/b/c'
        New-Item -ItemType Directory -Force -Path $deep | Out-Null
        Set-Content -LiteralPath (Join-Path $deep 'Deep.Tests.ps1') -Value '# test'

        @(Get-PesterTestFile -Path $root).Count | Should -Be 1
    }

    It 'ignores files that are not *.Tests.ps1' {
        $root = Join-Path $script:TempDir 'filter-case'
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        Set-Content -LiteralPath (Join-Path $root 'Helper.ps1') -Value '# not a test'
        Set-Content -LiteralPath (Join-Path $root 'Notes.md') -Value '# not a test'

        @(Get-PesterTestFile -Path $root).Count | Should -Be 0
    }

    It 'returns absolute paths so Pester never re-resolves a hidden directory' {
        $root = Join-Path $script:TempDir 'absolute-case'
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        Set-Content -LiteralPath (Join-Path $root 'B.Tests.ps1') -Value '# test'

        foreach ($f in @(Get-PesterTestFile -Path $root)) {
            [System.IO.Path]::IsPathRooted($f) | Should -BeTrue
        }
    }

    It 'accepts several roots at once' {
        $one = Join-Path $script:TempDir 'multi-one'
        $two = Join-Path $script:TempDir 'multi-two'
        New-Item -ItemType Directory -Force -Path $one | Out-Null
        New-Item -ItemType Directory -Force -Path $two | Out-Null
        Set-Content -LiteralPath (Join-Path $one 'One.Tests.ps1') -Value '# test'
        Set-Content -LiteralPath (Join-Path $two 'Two.Tests.ps1') -Value '# test'

        @(Get-PesterTestFile -Path $one, $two).Count | Should -Be 2
    }

    It 'throws when a root does not exist rather than reporting nothing to run' {
        # A silent empty result here is how a mistyped path becomes a green
        # build. Fail loudly instead -- and name the path, so the message
        # cannot be satisfied by an unrelated failure.
        $missing = Join-Path $script:TempDir 'no-such-root'

        { Get-PesterTestFile -Path $missing } | Should -Throw -ExpectedMessage '*no-such-root*'
    }

    It 'does not follow a directory symlink back into its own tree' {
        # A reparse point pointing at an ancestor recurses until the stack
        # blows. Creating one needs privileges that CI may not have, so the
        # test skips rather than failing where it cannot be set up.
        $root = Join-Path $script:TempDir 'symlink-case'
        $inner = Join-Path $root 'inner'
        New-Item -ItemType Directory -Force -Path $inner | Out-Null
        Set-Content -LiteralPath (Join-Path $inner 'Real.Tests.ps1') -Value '# test'

        try {
            New-Item -ItemType SymbolicLink -Path (Join-Path $inner 'loop') -Target $root -ErrorAction Stop | Out-Null
        }
        catch {
            Set-ItResult -Skipped -Because 'creating a symlink requires privileges unavailable here'
            return
        }

        @(Get-PesterTestFile -Path $root).Count | Should -Be 1
    }

    It 'does not descend into .git' {
        $root = Join-Path $script:TempDir 'vcs-case'
        $git = Join-Path $root '.git'
        New-Item -ItemType Directory -Force -Path $git | Out-Null
        Set-Content -LiteralPath (Join-Path $git 'Bogus.Tests.ps1') -Value '# test'

        @(Get-PesterTestFile -Path $root).Count | Should -Be 0
    }
}

Describe 'Test-PesterGate' {

    Context 'a run that produced no result object' {
        It 'fails when the result is null' {
            # Invoke-Pester threw, so -PassThru never assigned. The old gate
            # asked $null.FailedCount -gt 0, which is $false, and passed.
            $verdict = Test-PesterGate -Result $null -ExpectedFile @('a.Tests.ps1')

            $verdict.Passed | Should -BeFalse
        }

        It 'explains that no result was produced' {
            $verdict = Test-PesterGate -Result $null -ExpectedFile @('a.Tests.ps1')

            $verdict.Reason | Should -Match 'no result'
        }
    }

    Context 'a run that executed nothing' {
        It 'fails when the total count is zero' {
            $r = script:NewResult -Total 0 -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1')).Passed |
                Should -BeFalse
        }

        It 'explains that no tests ran' {
            $r = script:NewResult -Total 0 -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1')).Reason |
                Should -Match 'no tests'
        }

        It 'fails when no test files were discovered at all' {
            $r = script:NewResult -Total 0

            (Test-PesterGate -Result $r -ExpectedFile @()).Passed | Should -BeFalse
        }

        It 'blames empty discovery, not a thrown Invoke-Pester, when nothing was found' {
            # With nothing to run there is no result object either, so both
            # checks apply. The discovery diagnosis is the accurate one; saying
            # "Invoke-Pester threw" would send a maintainer hunting a crash
            # that never happened.
            $verdict = Test-PesterGate -Result $null -ExpectedFile @()

            $verdict.Reason | Should -Match 'no test files'
        }
    }

    Context 'a run with failing tests' {
        It 'fails when any test failed' {
            $r = script:NewResult -Total 10 -Failed 2 -Result 'Failed' -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1')).Passed |
                Should -BeFalse
        }

        It 'reports how many tests failed' {
            $r = script:NewResult -Total 10 -Failed 2 -Result 'Failed' -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1')).Reason |
                Should -Match '2'
        }
    }

    Context 'a run that errored without failing a test' {
        It 'fails when the overall result is not Passed' {
            # A container that blows up during discovery leaves FailedCount at
            # 0 while Result is Failed. FailedCount alone would miss it.
            $r = script:NewResult -Total 5 -Failed 0 -Result 'Failed' -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1')).Passed |
                Should -BeFalse
        }
    }

    Context 'a run where discovery silently shrank' {
        It 'fails when a discovered file produced no container' {
            # Guards against partial collapse without a hard-coded "expect >= N
            # tests" floor: every file handed to Pester must come back as a
            # container.
            $r = script:NewResult -Total 5 -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1', 'b.Tests.ps1')).Passed |
                Should -BeFalse
        }

        It 'names the file that did not run' {
            $r = script:NewResult -Total 5 -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1', 'b.Tests.ps1')).Reason |
                Should -Match 'b\.Tests\.ps1'
        }

        It 'fails closed on a container that carries no file path' {
            # A ScriptBlock container has no FullName. It cannot satisfy any
            # discovered file, so the gate must treat the file as not run
            # rather than crashing on the missing property.
            $r = [pscustomobject]@{
                TotalCount  = 5
                FailedCount = 0
                Result      = 'Passed'
                Containers  = @([pscustomobject]@{ Item = 'a scriptblock, not a file' })
            }

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1')).Passed |
                Should -BeFalse
        }

        It 'compares container paths case-insensitively and separator-insensitively' {
            $r = script:NewResult -Total 5 -ContainerPath @('C:\repo\a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('C:/REPO/A.Tests.ps1')).Passed |
                Should -BeTrue
        }
    }

    Context 'a clean run' {
        It 'passes when tests ran and all of them passed' {
            $r = script:NewResult -Total 511 -Failed 0 -Result 'Passed' -ContainerPath @('a.Tests.ps1', 'b.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1', 'b.Tests.ps1')).Passed |
                Should -BeTrue
        }

        It 'reports the number of tests that ran' {
            $r = script:NewResult -Total 511 -Failed 0 -Result 'Passed' -ContainerPath @('a.Tests.ps1')

            (Test-PesterGate -Result $r -ExpectedFile @('a.Tests.ps1')).Reason |
                Should -Match '511'
        }
    }
}
