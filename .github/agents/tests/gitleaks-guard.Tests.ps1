#Requires -Version 7.0
#Requires -Modules @{ ModuleName = "Pester"; ModuleVersion = "5.0.0" }

# Behavior tests for the gitleaks availability guard (issue #312).
#
# These pin the decision the guard makes, not the mechanism: absent gitleaks is a
# skip on a laptop and a failure in CI. Without that second half, the three
# secret-detection tests report green in CI having never executed.

BeforeAll {
    . (Join-Path $PSScriptRoot 'GitleaksGuard.ps1')
}

Describe 'Test-GitleaksRequired -- when a missing gitleaks must fail (issue #312)' {
    It 'requires gitleaks when CI=true' {
        Test-GitleaksRequired -CiValue 'true' | Should -BeTrue
    }

    It 'requires gitleaks for any non-false CI value' {
        Test-GitleaksRequired -CiValue '1' | Should -BeTrue
    }

    It 'does not require gitleaks when CI is unset' {
        Test-GitleaksRequired -CiValue $null | Should -BeFalse
    }

    It 'does not require gitleaks when CI is empty' {
        Test-GitleaksRequired -CiValue '' | Should -BeFalse
    }

    It 'does not require gitleaks when CI is explicitly false' {
        Test-GitleaksRequired -CiValue 'false' | Should -BeFalse
    }
}

Describe 'Assert-GitleaksAvailable -- skip locally, fail in CI (issue #312)' {
    It 'throws when gitleaks is absent in CI' {
        { Assert-GitleaksAvailable -Gitleaks $null -CiValue 'true' } |
            Should -Throw -ExpectedMessage '*gitleaks is not on PATH*'
    }

    It 'names the workflow step to fix in the CI failure message' {
        { Assert-GitleaksAvailable -Gitleaks $null -CiValue 'true' } |
            Should -Throw -ExpectedMessage '*validate-instructions.yml*'
    }

    It 'reports not-available (skip) when gitleaks is absent outside CI' {
        Assert-GitleaksAvailable -Gitleaks $null -CiValue $null | Should -BeFalse
    }

    It 'does not throw when gitleaks is absent outside CI' {
        { Assert-GitleaksAvailable -Gitleaks $null -CiValue $null } | Should -Not -Throw
    }

    It 'reports available when gitleaks is present, in CI' {
        Assert-GitleaksAvailable -Gitleaks ([pscustomobject]@{ Name = 'gitleaks' }) -CiValue 'true' |
            Should -BeTrue
    }

    It 'reports available when gitleaks is present, outside CI' {
        Assert-GitleaksAvailable -Gitleaks ([pscustomobject]@{ Name = 'gitleaks' }) -CiValue $null |
            Should -BeTrue
    }
}
