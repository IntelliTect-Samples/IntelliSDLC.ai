#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Wrapper for the zero-dep Node behavior tests that pin issues #367 and #366 --
# a capture that SURVIVES and can be IDENTIFIED. Pester is the only suite CI
# runs, so a Node test with no wrapper here is a test that never runs on a
# pull request.
#
#   capture-durability.test.js   the capture root anchors to the repository's
#                                MAIN working tree, so a routine
#                                `git worktree remove` cannot destroy an
#                                unrepeatable raw; the resolved path is
#                                announced while the run starts; and a
#                                recording will not begin without a non-empty
#                                --describe, while a catalogue-only re-run
#                                still does not need one.
#
# The Node suite performs a REAL `git worktree remove` against a real temporary
# repository. It is the only honest shape for the test: the defect's failure
# mode is deletion, and a test that inspected a resolved string would have
# passed both before the incident and after it.
#
# The Describe blocks below cover the PowerShell half, which the Node suite
# cannot reach: the front door's own parameter contract.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:InvokePs1  = Join-Path $script:ScriptsDir 'capture/Invoke-HarCapture.ps1'
    $script:StopPs1    = Join-Path $script:ScriptsDir 'capture/Stop-HarRecording.ps1'
    $script:CataloguePs1 = Join-Path $script:ScriptsDir 'capture/Invoke-HarCatalogue.ps1'
    $script:CaptureJs   = Join-Path $script:ScriptsDir 'capture/capture-har.js'

    function Get-ParamAst {
        param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Name)
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$errors)
        return $ast.ParamBlock.Parameters |
            Where-Object { $_.Name.VariablePath.UserPath -eq $Name }
    }
}

Describe 'a capture survives and can be identified (#367, #366)' {
    It 'runs <Name> and all of its behavioral assertions pass' -ForEach @(
        @{ Name = 'capture/capture-durability.test.js'; Expect = 'All capture-durability tests passed' }
    ) {
        $testJs = Join-Path $script:ScriptsDir $Name
        Test-Path -LiteralPath $testJs | Should -BeTrue

        & node --check $testJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0

        $out = & node $testJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match $Expect
    }
}

Describe 'Invoke-HarCapture.ps1 -Describe is required and hard-fails (#366)' {

    It 'HARD-FAILS in an interactive-capable context instead of prompting' {
        # THE FALSIFIER, and the only assertion here that could have been
        # written the lazy way and pinned nothing.
        #
        # `[Parameter(Mandatory)]` is the idiomatic PowerShell spelling of
        # "required", and it was REJECTED for this parameter: it prompts when a
        # host is attached and only hard-fails when one is not, so a human
        # recording by hand gets a different failure from an agent driving the
        # same script. capture-har.js has no prompt to offer, so the two entry
        # points would diverge at exactly the moment that matters.
        #
        # WHY THIS SPAWNS A PROCESS WITH STDIN HELD OPEN. A test run
        # `-NonInteractive`, or with stdin closed or redirected from a file,
        # exits non-zero under BOTH designs -- Mandatory degrades to an error
        # when it cannot prompt -- so it would pass either way and pin nothing.
        # That is the "satisfied by something other than what it names" pattern
        # this subsystem has already shipped six times.
        #
        # An open, silent stdin pipe is the discriminator. PowerShell treats the
        # host as prompt-capable and BLOCKS on the mandatory prompt, waiting for
        # a line that never comes; a body-level check terminates immediately.
        # Measured before this test was written: with Mandatory the child was
        # still running at 8s; without it, it exits in well under a second. So
        # the assertion is "terminates promptly", and a prompt cannot satisfy it.
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = (Get-Command pwsh).Source
        foreach ($a in @('-NoProfile', '-File', $script:InvokePs1,
                         '-Uri', 'https://example.com')) {
            [void]$psi.ArgumentList.Add($a)
        }
        # Redirected but never written and never closed: a host that WOULD
        # prompt has somewhere to prompt to, and waits there forever.
        $psi.RedirectStandardInput  = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true
        $psi.UseShellExecute = $false

        $proc = [System.Diagnostics.Process]::Start($psi)
        try {
            $exited = $proc.WaitForExit(20000)
            if (-not $exited) {
                $proc.Kill($true)
                throw ('Invoke-HarCapture blocked instead of failing: it is waiting on a ' +
                       'prompt for -Describe. The refusal must not depend on whether a ' +
                       'host is attached -- see #366.')
            }
            $err = $proc.StandardError.ReadToEnd()
            $proc.ExitCode | Should -Not -Be 0 -Because 'the refusal is a hard failure'
            $err | Should -Match '(?i)refusing to record without -Describe'
        }
        finally {
            $proc.Dispose()
        }
    }

    It 'does not declare -Describe Mandatory -- that is the prompting behaviour' {
        # The structural half of the case above. Asserted on the AST rather than
        # by grepping the source: a source match passes just as happily when the
        # attribute sits on a different parameter.
        $describe = Get-ParamAst -Path $script:InvokePs1 -Name 'Describe'
        $describe | Should -Not -BeNullOrEmpty -Because 'the parameter still exists'

        $attr = $describe.Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' }
        ($attr.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' }) |
            Should -BeNullOrEmpty -Because (
                'Mandatory prompts when a host is attached, which is the option that was ' +
                'considered and rejected: both entry points must fail identically')
    }

    It 'refuses a whitespace-only description, not only an absent one' {
        # Supplying '   ' satisfies any "was the parameter provided" test.
        # Whitespace identifies nothing, so it is refused on the same terms.
        $out = & (Get-Command pwsh).Source -NoProfile -File $script:InvokePs1 `
            -Uri 'https://example.com' -Describe '   ' 2>&1
        $LASTEXITCODE | Should -Be 2
        ($out | Out-String) | Should -Match '(?i)refusing to record without -Describe'
    }

    It 'exits with the SAME code the recorder does, not merely a non-zero one' {
        # "Fail identically" is the reason this is a hard failure rather than a
        # prompt, and the exit code is part of what a failure says. `throw` gave
        # 1 while capture-har.js gives 2 -- both non-zero, so every caller
        # testing truthiness was satisfied and the disagreement stayed invisible.
        #
        # Asserted as an EQUALITY between the two doors rather than as two
        # separate literals: pinning each to 2 independently would let them
        # drift apart later with both assertions still passing, which is the
        # shape of bug this whole suite exists to catch.
        & (Get-Command pwsh).Source -NoProfile -File $script:InvokePs1 `
            -Uri 'https://example.com' 2>&1 | Out-Null
        $frontDoor = $LASTEXITCODE

        & node $script:CaptureJs start --uri 'https://example.com' --validate-only 2>&1 | Out-Null
        $recorder = $LASTEXITCODE

        $frontDoor | Should -Be $recorder -Because (
            'the front door and the recorder must refuse on identical terms -- ' +
            "front door exited $frontDoor, recorder exited $recorder")
        $recorder | Should -Be 2 -Because 'refusing an invocation is a usage error at either door'
    }

    It 'says the same thing the Node side says, example included' {
        # The two doors fail identically or the guarantee is only half true.
        # The example is the actionable half and is the part PowerShell's error
        # renderer would eat if the paragraph were thrown rather than written.
        $out = & (Get-Command pwsh).Source -NoProfile -File $script:InvokePs1 `
            -Uri 'https://example.com' 2>&1
        $text = $out | Out-String
        $text | Should -Match 'cannot be reconstructed afterwards'
        $text | Should -Match ([regex]::Escape("Try: -Describe 'example.com:"))
    }

    It 'forwards the description unconditionally, with no truthiness test left behind' {
        # `if ($Describe) { ... }` was correct while the parameter was optional
        # and is a silent hole now: it would drop a description PowerShell had
        # already accepted, and stamp null anyway.
        $text = Get-Content -LiteralPath $script:InvokePs1 -Raw
        $text | Should -Not -Match 'if\s*\(\s*\$Describe\s*\)'
        $text | Should -Match ([regex]::Escape("@('--describe', `$Describe)"))
    }

    It 'leaves the other front doors alone -- they start no recording' {
        # Stop-HarRecording and Invoke-HarCatalogue act on a capture that
        # already exists and already carries its description. A required input
        # added to either would break recovery and re-entry, which are the
        # paths an operator reaches for when something has already gone wrong.
        foreach ($script in @($script:StopPs1, $script:CataloguePs1)) {
            Test-Path -LiteralPath $script | Should -BeTrue
            (Get-ParamAst -Path $script -Name 'Describe') |
                Should -BeNullOrEmpty -Because "$script does not start a recording"
        }
    }
}
