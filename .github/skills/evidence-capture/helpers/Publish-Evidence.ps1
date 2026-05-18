#Requires -Version 5.1

<#
.SYNOPSIS
    Publishes an evidence artifact to a GitHub pull request comment.

.DESCRIPTION
    Used by the evidence-capture skill to deliver the captured artifact to the
    PR for human review and persistence.

    Behavior depends on the artifact type:

      * Markdown (.md) under the inline size limit: the file's contents are
        posted as a single PR comment via `gh pr comment --body-file`.

      * Markdown over the size limit or any binary file (.png, .mp4, .html,
        .webm, etc.): printed instructions for uploading as a GitHub Actions
        workflow artifact, plus a stub PR comment with the actions-artifact
        URL. The binary itself is NOT uploaded by this script -- the CI
        workflow's `actions/upload-artifact` step is responsible for that.

    The size threshold defaults to 25 MB (GitHub's PR-comment inline limit).

.PARAMETER ArtifactPath
    Path to the evidence artifact file. May be relative or absolute.

.PARAMETER PullRequest
    Pull request number to post the comment on.

.PARAMETER Repo
    Repository in `owner/repo` form. If omitted, inferred from the current
    working directory via `gh repo view`.

.PARAMETER MaxInlineSizeBytes
    Files at or below this size and of markdown type are posted inline.
    Default: 25 MB.

.PARAMETER GhInvoker
    Test seam. A scriptblock that takes a string array of arguments and
    invokes gh. Default: real `gh` on PATH.

.PARAMETER LocalOnly
    Skip the PR comment entirely. The script still resolves the artifact,
    formats the comment body (for caller preview), and emits the clickable
    `file://` URL on stdout. Use during dev-loop iterations (Phase 5b) so the
    PR isn't spammed with intermediate captures; the final artifact is posted
    during Phase 7 with this switch omitted.

.OUTPUTS
    [pscustomobject] with:
      Mode       -- 'Inline' | 'ArtifactReference' | 'LocalOnly'
      Comment    -- the rendered comment body (string)
      ArtifactPath -- absolute path to the artifact
      Bytes      -- size in bytes

.EXAMPLE
    Publish-Evidence -ArtifactPath .evidence/phase-5b/evidence.md -PullRequest 42

    Posts the markdown content as a PR comment on PR #42.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$ArtifactPath,

    [Parameter(Mandatory)]
    [int]$PullRequest,

    [string]$Repo,

    [int]$MaxInlineSizeBytes = 25 * 1024 * 1024,

    [scriptblock]$GhInvoker = { param([string[]]$GhArgs) & gh @GhArgs },

    [switch]$LocalOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-FileUri {
    <#
    .SYNOPSIS
        Format an absolute path as a clickable file:/// URI with forward
        slashes so modern terminals (Windows Terminal, VS Code) render it as
        a hyperlink.
    #>
    param([Parameter(Mandatory)][string]$Path)
    $forward = $Path -replace '\\', '/'
    if ($forward.StartsWith('/')) {
        return "file://$forward"
    }
    return "file:///$forward"
}

function Get-ArtifactMode {
    param(
        [string]$Path,
        [long]$SizeBytes,
        [long]$MaxInlineBytes
    )
    $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($extension -eq '.md' -and $SizeBytes -le $MaxInlineBytes) {
        return 'Inline'
    }
    return 'ArtifactReference'
}

function Format-InlineComment {
    param([string]$MarkdownBody)
    return $MarkdownBody
}

function Format-ArtifactReferenceComment {
    param(
        [string]$ArtifactFileName,
        [long]$SizeBytes
    )
    $sizeMb = [math]::Round($SizeBytes / 1MB, 2)
    return @"
### Evidence artifact

A binary or large evidence artifact was produced for this change:

- **File:** ``$ArtifactFileName``
- **Size:** $sizeMb MB

This file exceeds the inline limit (or is non-markdown) and must be downloaded
from the CI workflow artifacts page for this PR. Look for the artifact named
``evidence-$ArtifactFileName`` on the most recent workflow run.

See ``.github/skills/evidence-capture/SKILL.md`` for the full lifecycle.
"@
}

function Get-CommentBody {
    param(
        [string]$Mode,
        [string]$ResolvedPath,
        [System.IO.FileInfo]$FileInfo,
        [long]$SizeBytes
    )
    if ($Mode -eq 'Inline') {
        return Format-InlineComment -MarkdownBody (Get-Content -LiteralPath $ResolvedPath -Raw)
    }
    return Format-ArtifactReferenceComment -ArtifactFileName $FileInfo.Name -SizeBytes $SizeBytes
}

# Main flow ------------------------------------------------------------------

$resolvedPath = (Resolve-Path -LiteralPath $ArtifactPath).ProviderPath
$fileInfo = Get-Item -LiteralPath $resolvedPath
$sizeBytes = $fileInfo.Length

# Always classify the artifact (Inline vs ArtifactReference) so callers
# get a previewable comment body even in LocalOnly mode.
$classifiedMode = Get-ArtifactMode -Path $resolvedPath -SizeBytes $sizeBytes -MaxInlineBytes $MaxInlineSizeBytes
$comment = Get-CommentBody -Mode $classifiedMode -ResolvedPath $resolvedPath `
    -FileInfo $fileInfo -SizeBytes $sizeBytes

# Surface a clickable file:/// URL on stdout regardless of post mode. This is
# the local-link contract from .github/skills/evidence-capture/SKILL.md --
# the reviewer's primary entry point is the local file, not the PR comment.
$fileUri = ConvertTo-FileUri -Path $resolvedPath
Write-Host "Evidence (local): $fileUri"

if ($LocalOnly) {
    return [pscustomobject]@{
        Mode         = 'LocalOnly'
        Comment      = $comment
        ArtifactPath = $resolvedPath
        Bytes        = $sizeBytes
    }
}

$mode = $classifiedMode

if ($PSCmdlet.ShouldProcess("PR #$PullRequest", "post evidence comment ($mode)")) {
    # Write the comment body to a temp file -- per repo conventions
    # (copilot-instructions.md > PR & Issue Body Formatting) we must NEVER
    # pass body text inline on Windows; always --body-file with UTF-8 no-BOM.
    $tempBody = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(),
        "evidence-comment-$([guid]::NewGuid().ToString('N')).md")
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempBody, $comment, $utf8NoBom)

    try {
        $ghArgs = @('pr', 'comment', "$PullRequest", '--body-file', $tempBody)
        if ($Repo) {
            $ghArgs += @('--repo', $Repo)
        }
        & $GhInvoker $ghArgs | Out-Null
    } finally {
        if (Test-Path -LiteralPath $tempBody) {
            Remove-Item -LiteralPath $tempBody -Force
        }
    }
}

[pscustomobject]@{
    Mode         = $mode
    Comment      = $comment
    ArtifactPath = $resolvedPath
    Bytes        = $sizeBytes
}
