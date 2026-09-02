#Requires -Version 7.0

# Availability guard for the gitleaks-backed secret-detection tests (issue #312).
#
# Three tests that assert the secret gate actually detects secrets -- and that it
# does NOT flag the deterministic fake markers from PR #47 -- skipped themselves
# on every platform because gitleaks was never installed anywhere, CI included.
# A suite that reports green while its only secret-detection assertions have
# never once executed is the same false assurance #304 removed from the Pester
# gate itself.
#
# A skip is still correct on a developer laptop: requiring every contributor to
# install gitleaks to run the suite is a poor trade. In CI it is not, because CI
# is the run whose green anyone actually relies on. So the guard is keyed off the
# standard CI environment variable rather than a new option of our own.

function Test-GitleaksRequired {
    <#
    .SYNOPSIS
        True when a missing gitleaks must fail rather than skip.
    .PARAMETER CiValue
        The value of the CI environment variable. Callers pass $env:CI; the
        parameter exists so the decision is testable without mutating the
        ambient environment of the test process.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$CiValue
    )

    if ([string]::IsNullOrWhiteSpace($CiValue)) { return $false }
    # GitHub Actions sets CI=true. Treat an explicit 'false' as not-CI so a
    # developer can opt out locally without unsetting a variable other tools read.
    return $CiValue -ne 'false'
}

function Assert-GitleaksAvailable {
    <#
    .SYNOPSIS
        Returns $true when gitleaks can be invoked, $false when the caller should
        skip, and throws when it is absent in CI.
    .PARAMETER Gitleaks
        The result of Get-Command gitleaks, or $null when it is not on PATH.
    .PARAMETER CiValue
        The value of the CI environment variable (see Test-GitleaksRequired).
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [AllowNull()]
        $Gitleaks,

        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$CiValue
    )

    if ($null -ne $Gitleaks) { return $true }

    if (Test-GitleaksRequired -CiValue $CiValue) {
        $message = 'gitleaks is not on PATH, but this is a CI run. ' +
            'The secret-detection tests must not silently skip in CI -- a green suite ' +
            'would then carry no evidence that the secret gate detects anything. ' +
            'Install gitleaks in the workflow (see the "Install gitleaks" step in ' +
            '.github/workflows/validate-instructions.yml) or fix PATH.'
        throw $message
    }

    return $false
}
