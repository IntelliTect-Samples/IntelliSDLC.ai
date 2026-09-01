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

Describe 'Invoke-HarCapture.ps1 -Describe is mandatory (#366)' {

    It 'declares -Describe Mandatory, so a recording cannot start unidentified' {
        # Asserted on the AST rather than by grepping the source: a source match
        # passes just as happily when the attribute is on the wrong parameter.
        $describe = Get-ParamAst -Path $script:InvokePs1 -Name 'Describe'
        $describe | Should -Not -BeNullOrEmpty

        $attr = $describe.Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' }
        ($attr.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' }) |
            Should -Not -BeNullOrEmpty -Because 'a capture nobody can identify is a capture nobody can use'
    }

    It 'rejects a whitespace-only description rather than stamping it' {
        # Mandatory alone accepts '   ': PowerShell only checks that the
        # parameter was supplied. Whitespace identifies nothing.
        $describe = Get-ParamAst -Path $script:InvokePs1 -Name 'Describe'
        ($describe.Attributes | Where-Object {
            $_.TypeName.Name -match 'ValidateNotNullOrWhiteSpace'
        }) | Should -Not -BeNullOrEmpty
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
