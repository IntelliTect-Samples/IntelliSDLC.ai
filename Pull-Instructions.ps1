<#
.SYNOPSIS
    Syncs shared AI instruction files from IntelliAIInstructions into this project.

.DESCRIPTION
    Adds IntelliTect-Dev/IntelliAIInstructions as a git remote named 'instructions'
    (if not already present) and merges the latest changes from its main branch.

    Uses --allow-unrelated-histories for the initial merge, and --no-ff to keep
    a clear merge commit on subsequent syncs.

.PARAMETER Branch
    The upstream branch to merge from. Default: main.

.PARAMETER RemoteName
    Name for the git remote. Default: instructions.

.EXAMPLE
    ./sync-instructions.ps1

.EXAMPLE
    ./sync-instructions.ps1 -Branch develop
#>
[CmdletBinding()]
param(
    [string]$Branch = 'main',
    [string]$RemoteName = 'instructions'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RemoteUrl = 'https://github.com/IntelliTect-Dev/IntelliAIInstructions.git'

# Add remote if it doesn't exist
$existingUrl = git remote get-url $RemoteName 2>$null
if (-not $existingUrl) {
    Write-Host "Adding remote '$RemoteName' -> $RemoteUrl"
    git remote add $RemoteName $RemoteUrl
}

git fetch $RemoteName
git merge "$RemoteName/$Branch" --no-ff --allow-unrelated-histories
