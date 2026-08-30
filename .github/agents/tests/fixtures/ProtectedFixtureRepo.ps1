#Requires -Version 7.0

<#
.SYNOPSIS
    Fixture helper: a temp directory the HAR scrub will actually run in.

.DESCRIPTION
    Since issue #318 the scrub refuses to write a substitution table to a
    destination git will not confirm is ignored, so a bare temp directory is no
    longer somewhere it runs. Suites whose subject is something else entirely --
    PII detection, secret field names, the PowerShell wrapper -- need a project
    that looks like a real consumer's so the scrub gets far enough to exercise
    what they are actually testing.

    This is the PowerShell twin of templates/web-api-discovery/scripts/har/
    har-test-repo.js. The entries are the subset of generate-wrapper.js's
    SCAFFOLD_GITIGNORE_ENTRIES that protects the tables; a fixture wants a
    protected repo, not a copy of whatever that list happens to say.

    Dot-source it from a suite's BeforeAll:
        . (Join-Path $PSScriptRoot 'fixtures/ProtectedFixtureRepo.ps1')
#>

function New-ProtectedFixtureRepo {
    [CmdletBinding()]
    param(
        # Created if absent.
        [Parameter(Mandatory)][string]$Path
    )

    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    & git -C $Path init --quiet 2>&1 | Out-Null
    Set-Content -LiteralPath (Join-Path $Path '.gitignore') -Encoding utf8 -Value @(
        '.har-profile.json'
        '.har-substitutions.json'
        '.substitutions.json'
        '.har-captures/'
    )
    $Path
}
