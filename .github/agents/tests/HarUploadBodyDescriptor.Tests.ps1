#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Behavior tests for the unretained-request-body descriptor (issue #442).
# Delegates to three zero-dep Node suites:
#
#   scripts/capture/request-body-descriptor.test.js
#       the descriptor itself, and its attachment to BOTH `raw.har` paths.
#   scripts/har/har-body-descriptor-scrub.test.js
#       the descriptor reaches the scrub, the gate and the audit -- and none of
#       them mistakes one of its own keys for a captured field name.
#   scripts/har/har-body-descriptor-pipeline.test.js
#       the same, end to end, through the real `sanitize-har.js` and the real
#       gate over a planted `raw.har`.
#
# What it pins. A request body a capture never retained used to be reported as
# `bodySize: 0` with no `postData` -- the identical text a genuinely bodyless
# GET produces -- so an Instagram POST that carried a 52 MB video was
# indistinguishable from a GET that carried nothing. Now the recorder writes a
# descriptor saying the body was NOT retained, with its declared length, mime
# type and (for multipart) each part's order, field name, filename, content
# type and byte length. Never the bytes, never a hash, never a prefix.
#
# The `node --check` steps are not boilerplate. `request-body-descriptor.js` is
# required BY `pii.js` and `audit-scrub-drift.js`, so a syntax error in it takes
# the scrub and the audit down with it, and that reaches a runner looking like a
# genuine finding rather than like a broken file.
#
# The browser leg is not exercised: Playwright is not a dependency of this
# repository and no Chrome is launched in CI. The assembly path is exercised
# over planted fixtures instead, as #377's lane does.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'

    $script:DescriptorJs = Join-Path $script:ScriptsDir 'capture/request-body-descriptor.js'
    $script:CaptureJs    = Join-Path $script:ScriptsDir 'capture/capture-har.js'
    $script:PiiJs        = Join-Path $script:ScriptsDir 'har/pii.js'
    $script:AuditJs      = Join-Path $script:ScriptsDir 'har/audit-scrub-drift.js'

    $script:Suites = @(
        @{ Name = 'request-body-descriptor'
           Path = (Join-Path $script:ScriptsDir 'capture/request-body-descriptor.test.js') }
        @{ Name = 'har-body-descriptor-scrub'
           Path = (Join-Path $script:ScriptsDir 'har/har-body-descriptor-scrub.test.js') }
        @{ Name = 'har-body-descriptor-pipeline'
           Path = (Join-Path $script:ScriptsDir 'har/har-body-descriptor-pipeline.test.js') }
    )
}

Describe 'web-api-discovery unretained request body descriptor (#442)' {

    It 'the module the scrub and the audit both import parses without syntax errors' {
        & node --check $script:DescriptorJs 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0 -Because (
            'pii.js and audit-scrub-drift.js require this file, so a SyntaxError here ' +
            'takes the whole scrub down while looking like a failed assertion')
    }

    It 'every file this change touched parses without syntax errors' -ForEach @(
        @{ Which = 'capture-har.js' }
        @{ Which = 'pii.js' }
        @{ Which = 'audit-scrub-drift.js' }
    ) {
        $target = switch ($Which) {
            'capture-har.js'        { $script:CaptureJs }
            'pii.js'                { $script:PiiJs }
            'audit-scrub-drift.js'  { $script:AuditJs }
        }
        & node --check $target 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'the Node suite <Name> exists at its canonical path' -ForEach @(
        @{ Name = 'request-body-descriptor';      File = 'capture/request-body-descriptor.test.js' }
        @{ Name = 'har-body-descriptor-scrub';    File = 'har/har-body-descriptor-scrub.test.js' }
        @{ Name = 'har-body-descriptor-pipeline'; File = 'har/har-body-descriptor-pipeline.test.js' }
    ) {
        Test-Path -LiteralPath (Join-Path $script:ScriptsDir $File) | Should -BeTrue
    }

    It 'the Node suite <Name> parses without syntax errors' -ForEach @(
        @{ Name = 'request-body-descriptor';      File = 'capture/request-body-descriptor.test.js' }
        @{ Name = 'har-body-descriptor-scrub';    File = 'har/har-body-descriptor-scrub.test.js' }
        @{ Name = 'har-body-descriptor-pipeline'; File = 'har/har-body-descriptor-pipeline.test.js' }
    ) {
        & node --check (Join-Path $script:ScriptsDir $File) 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'all behavioral assertions of <Name> pass' -ForEach @(
        @{ Name = 'request-body-descriptor';      File = 'capture/request-body-descriptor.test.js' }
        @{ Name = 'har-body-descriptor-scrub';    File = 'har/har-body-descriptor-scrub.test.js' }
        @{ Name = 'har-body-descriptor-pipeline'; File = 'har/har-body-descriptor-pipeline.test.js' }
    ) {
        $out = & node (Join-Path $script:ScriptsDir $File) 2>&1
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { Write-Host ($out -join "`n") }
        $exit | Should -Be 0
        ($out -join "`n") | Should -Match "All $Name tests passed"
    }
}
