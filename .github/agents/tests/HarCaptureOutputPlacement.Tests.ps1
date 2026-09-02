#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for issue #377 -- where scrub output lands, what the run says
# about it, and the link back to the raw.
#
# Two jobs:
#
#  1. Delegate to the zero-dep Node suite. The wrapper is not ceremony -- CI
#     runs Pester over ./.github only, so a node test file reaches the pipeline
#     solely by being shelled out to from here. Without this file the node tests
#     pass locally and never run on a PR, and node-test-coverage.Tests.ps1 fails
#     when a suite has no wrapper.
#
#  2. Pin the two facts that live on the PowerShell side of the process
#     boundary: the front door renders no second copy of the catalogue, and it
#     does not swallow the recorder's stderr -- which is where the table, the
#     scaffold notice and every warning are written.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'
    $script:TestJs     = Join-Path $script:ScriptsDir 'capture/capture-output-destination.test.js'
    $script:Wrapper    = Join-Path $script:ScriptsDir 'capture/Invoke-HarCapture.ps1'
    $script:WrapperText = Get-Content -LiteralPath $script:Wrapper -Raw
}

Describe 'capture output placement, stamping and the reference link (issue #377)' {
    It 'test file exists at the canonical path' {
        Test-Path -LiteralPath $script:TestJs | Should -BeTrue
    }

    It 'parses without syntax errors' {
        & node --check $script:TestJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions pass' {
        $out = & node $script:TestJs 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            Write-Host ($out -join "`n")
        }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match 'All capture-output-destination tests passed'
    }
}

Describe 'Invoke-HarCapture defers the catalogue display to the recorder' {
    # The recorder is the process that actually wrote the files, so it prints
    # the table in-process and unconditionally. A table printed only from the
    # front door would depend on that process surviving long enough to reach its
    # own epilogue -- and a display that goes missing exactly when something
    # went wrong is not a result display at all. Same reasoning that already
    # puts the closing notice in the recorder (#300).

    It 'carries no second copy of the scaffold notice' {
        $script:WrapperText | Should -Not -Match 'needs its AI pass'
    }

    It 'still emits the catalogue rows as typed objects for the pipeline' {
        # `Invoke-HarCapture ... | Where-Object Status -eq Observed` is the
        # documented contract. Deferring the DISPLAY must not take the DATA
        # with it.
        $script:WrapperText | Should -Match '(?m)^\$rows\s*$'
        $script:WrapperText | Should -Match 'ConvertFrom-HarCatalogue\.ps1'
    }

    It 'captures the recorder stdout but never its stderr' {
        # stdout carries one line of JSON naming the session and catalogue this
        # run produced -- the handoff that replaced rebuilding the path from an
        # anchoring rule, now that the default output path carries a stamp.
        $script:WrapperText | Should -Match '\$recorderStdout\s*=\s*&\s*node'
        # Everything human-facing is on stderr. Redirecting it into the captured
        # stream would silence the banner, the ENTER prompt, the warnings, the
        # catalogue table and the scaffold notice all at once.
        $script:WrapperText | Should -Not -Match '&\s*node\s+\$captureJs[^\r\n]*2>'
    }

    It 'no longer rebuilds the output path from an anchoring rule' {
        # Get-DefaultOutputRoot answered "the repo root", which is exactly the
        # location this issue moved output away from. A front door still using
        # it would look for a catalogue in a directory the recorder never wrote.
        $script:WrapperText | Should -Not -Match 'Get-DefaultOutputRoot'
    }
}
