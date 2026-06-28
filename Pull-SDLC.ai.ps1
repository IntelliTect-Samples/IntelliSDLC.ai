<#
.SYNOPSIS
    Syncs shared AI instruction files from IntelliSDLC.ai into this project.

.DESCRIPTION
    Replays the upstream commit history as a sequence of file-system
    operations (add / modify / delete / rename / copy / type-change) against
    the consumer working tree. Conflict-free by construction: rename
    detection runs against the single upstream timeline, and files are
    written byte-for-byte from upstream blobs (no three-way merge).

    Upstream-managed paths are listed in $script:UpstreamManagedPaths.
    Consumer-owned paths (immune to upstream replay) are listed in
    $script:AlwaysLocalPaths; that list trumps the managed-paths list.

    State is tracked in .sdlc-ai-sync.json at the repo root (always-local,
    committed). Schema:

        { "remote": "sdlc.ai", "ref": "main",
          "lastSyncCommit": "<sha>", "syncedAt": "<iso8601-utc>" }

    A pre-flight guard refuses to run if any upstream-managed file shows
    local drift from the recorded anchor (catches policy violations before
    they get overwritten). Pass -Force to override.

.PARAMETER Branch
    Upstream branch to sync from. Default: main.

.PARAMETER RemoteName
    Local name for the upstream git remote. Default: sdlc.ai.

.PARAMETER RemoteUrl
    URL of the upstream IntelliSDLC.ai git remote. Default: the canonical
    IntelliTect-Samples copy. Override when running from a fork or mirror
    (e.g. an org-portable bootstrap that points at a same-org sibling).

.PARAMETER WhatIf
    Print the planned op list and exit without modifying the working tree.

.PARAMETER Force
    Bypass the pre-flight drift guard. A warning banner is printed.

.PARAMETER Bootstrap
    Explicitly accept the empty-tree anchor (full refresh from upstream
    HEAD) without prompting. Usually unnecessary -- the script auto-detects
    an unambiguous bootstrap state (no .sdlc-ai-sync.json, no prior sync
    commit, AND no upstream-managed files present) and proceeds silently.
    Use this flag to force a full refresh even when managed files are
    already present (will overwrite them).

.PARAMETER NoPrompt
    Suppress the bootstrap prompt in ambiguous cases. Equivalent to
    -Bootstrap when no anchor is found; never prompts. Use in CI.

.PARAMETER NoAutoInit
    When the current directory is not a git repository, do NOT run
    `git init` automatically. Default behavior is to initialize the repo
    on the configured branch so the sync can proceed.

.PARAMETER CommitOnMain
    Commit the sync directly on the protected branch (typically `main`)
    instead of routing through the auto-worktree + PR path.

    Default is state-driven:
    * Bootstrap (no `.sdlc-ai-sync.json` AND no prior sync commit in the
      git log) -> on. The first sync of a repo is tooling onboarding,
      not a reviewable change; commit it directly.
    * Steady state (the consumer has been synced before) -> off. Route
      through the auto-worktree workflow so `main` stays clean and each
      sync is reviewed.

    Pass `-CommitOnMain` to force commit-on-main even in steady state
    (the rare "trusted maintenance commit" case). Pass
    `-CommitOnMain:$false` to force the auto-worktree path even at
    bootstrap.

.PARAMETER NoAutoWorktree
    When on the protected branch with a gate, do NOT auto-create a worktree.
    Restores the previous behavior: print remediation and exit rc=3.

.PARAMETER NoAutoPR
    During auto-worktree mode, commit + push but do NOT open a pull request.
    Useful in CI or when gh is misconfigured.

.PARAMETER NoSelfUpdate
    Skip the start-of-run self-refresh check that pulls the latest
    Pull-SDLC.ai.ps1 from upstream raw.githubusercontent.com. Also honored
    via the PULL_SDLC_NO_SELF_UPDATE environment variable. The re-exec path
    always passes this flag to prevent an infinite refresh loop.

.PARAMETER SetupGitHubSsh
    Run the GitHub-over-SSH-on-port-443 workstation setup and exit. Generates
    an ed25519 keypair, ensures the Windows ssh-agent service is running and
    set to Automatic startup, installs the three `url.insteadOf` rewrites that
    transparently route GitHub HTTPS clones through SSH on port 443 (works
    behind corporate firewalls that block port 22), sets `gh config
    git_protocol ssh`, and uploads the public key to GitHub via `gh ssh-key
    add`. Idempotent and safe to re-run; every step prints `[skip]` when
    already configured. Windows only -- issue #164.

.PARAMETER SkipKeyUpload
    With `-SetupGitHubSsh`, do NOT call `gh ssh-key add`. Useful when the key
    has already been registered out-of-band, or for unattended runs without
    `gh auth`. All other setup steps still run.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Branch = 'main',
    [string]$RemoteName = 'sdlc.ai',
    [string]$RemoteUrl = 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git',
    [switch]$Force,
    [switch]$Bootstrap,
    [switch]$NoPrompt,
    [switch]$NoAutoInit,
    [switch]$CommitOnMain,
    [switch]$NoAutoWorktree,
    [switch]$NoAutoPR,
    [switch]$NoSelfUpdate,
    [switch]$SetupGitHubSsh,
    [switch]$SkipKeyUpload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Status/progress is emitted via Write-Information (stream 6) per the
# "Output & Streams" guidance. The Information stream defaults to
# SilentlyContinue, so opt it into visible-by-default here to preserve the
# script's historical console output. Callers can still silence or capture it
# with -InformationAction / 6>.
$InformationPreference = 'Continue'

# --- Sync semantics --------------------------------------------------------
#
# The four script-level lists below ($script:TemplateScaffoldMap,
# $script:UpstreamManagedPaths, $script:AlwaysLocalPaths, $script:MergePaths)
# are the single canonical source of truth for what this script syncs and
# how. There is no separate manifest file -- everything the sync engine
# needs to know lives here.
#
# Path matching:
#   - Entries ending with '/' match any path under that directory prefix
#     (case-insensitive, ./ and .\ prefixes tolerated). All other entries
#     are exact filename matches against the repo-relative path.
#   - Paths are matched against the upstream tree via
#     `git diff --name-status -M -B <anchor> <ref> -- <paths>`.
#
# Precedence (high -> low):
#   1. $script:AlwaysLocalPaths -- consumer-owned. NEVER overwritten,
#      regardless of whether they also sit under a managed prefix.
#      Example: .github/instructions/project.instructions.md lives under
#      the managed .github/instructions/ tree but is filtered out of the
#      op list.
#   2. $script:MergePaths       -- union-merged. Upstream content is merged
#      INTO the consumer's copy so the consumer keeps any local entries
#      while gaining any new upstream ones. The .gitignore merge supports
#      an "upstream-only" marker block (lines between
#      '# >>> upstream-only >>>' and '# <<< upstream-only <<<',
#      case-insensitive) that Merge-FileFromUpstream strips before
#      propagation so entries in the block never reach consumers.
#   3. $script:UpstreamManagedPaths -- diff-replayed from upstream/<Branch>.
#      Local edits trigger the drift guard and abort the sync unless
#      -Force is passed.
#
# Template scaffolding:
#   $script:TemplateScaffoldMap maps <upstream template> -> <bare consumer
#   target>. Templates are scaffolded to the bare name only on first sync
#   (when the bare target does not yet exist); the bare name is
#   consumer-owned thereafter (it appears on $script:AlwaysLocalPaths).

# Map of <template path> -> <bare target path> used to scaffold consumer-owned
# files on first sync.
$script:TemplateScaffoldMap = [ordered]@{
    '.github/instructions/project.instructions.md.template' = '.github/instructions/project.instructions.md'
    'CLAUDE.project.md.template'                            = 'CLAUDE.project.md'
    'README.md.template'                                    = 'README.md'
    'docs/README.md'                                        = 'docs/README.md'
}

# Paths (file or directory prefixes) that upstream owns. Anything under one
# of these is subject to diff-replay against upstream/<Branch>.
$script:UpstreamManagedPaths = @(
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    'README.md.template',
    '.github/agents/',
    '.github/skills/',
    '.github/instructions/',
    # The consumer-owned spec-archive guide. Sync-managed so the same-name
    # scaffold delivers `docs/README.md` on first sync and the file is
    # reconciled against upstream until the consumer takes ownership (it is
    # also on $script:AlwaysLocalPaths, which trumps once it exists locally).
    'docs/README.md',
    # Meta-scripts: the bootstrap script the user downloads via `iwr` and
    # its siblings. Sync-managed so the user's local copy is reconciled
    # against upstream on every run (including the very first carve-out
    # path), instead of being left untracked in the consumer's working
    # tree (issue #148).
    'Pull-SDLC.ai.ps1',
    'Pull-SDLC.ai.Tests.ps1',
    'Cleanup-Worktree.ps1',
    'Consolidate-Specs.ps1',
    'Consolidate-Specs.Tests.ps1',
    # Retired filename (renamed to Consolidate-Specs.ps1 in issue #184). Kept on
    # the managed-path list so the rename/delete replays into consumer trees on
    # their next sync -- Get-UpstreamOps filters the diff by this pathspec, so
    # the old path must appear here or consumers keep a stale orphan copy.
    'Consolidate-Tasks.ps1',
    'Consolidate-Tasks.Tests.ps1',
    # The project-agnostic .NET runner and its tests. Sync-managed so consumers
    # receive and keep it reconciled with upstream like the other meta-scripts
    # (issue #206). Not bootstrap-downloaded, so it is intentionally absent from
    # $script:MetaScriptPaths.
    'run.ps1',
    'run.Tests.ps1',
    # The Copilot cloud-agent environment setup workflow. Sync-managed as a
    # single explicit file (NOT the whole .github/workflows/ tree) so consumers
    # receive and reconcile it while keeping their own workflows -- and the
    # upstream-only validate-instructions.yml -- consumer-owned (issue #208).
    '.github/workflows/copilot-setup-steps.yml'
)

# Subset of UpstreamManagedPaths whose mere presence in the consumer's working
# tree does NOT indicate "consumer already has managed content." These are the
# meta-scripts the user downloads (via `iwr`) to *perform* the bootstrap, so
# they are guaranteed to exist at bootstrap time -- treating them as a signal
# of prior managed content would mean every from-zero bootstrap that started
# with `iwr Pull-SDLC.ai.ps1 ...` triggers the protective overwrite prompt,
# defeating the unambiguous auto-bootstrap path (issue #152). They remain in
# UpstreamManagedPaths so sync still reconciles them against upstream.
$script:MetaScriptPaths = @(
    'Pull-SDLC.ai.ps1',
    'Pull-SDLC.ai.Tests.ps1',
    'Cleanup-Worktree.ps1',
    'Consolidate-Specs.ps1',
    'Consolidate-Specs.Tests.ps1'
)

# Paths that are inherently consumer-owned. Always-local trumps managed-paths
# (e.g. .github/instructions/project.instructions.md sits under the managed
# .github/instructions/ tree but is filtered out of the op list).
$script:AlwaysLocalPaths = @(
    'README.md',
    '.github/instructions/project.instructions.md',
    'CLAUDE.project.md',
    '.gitattributes',
    '.sdlc-ai-sync.json',
    # The standard spec archive: PRDs (the *what*) under docs/specs/,
    # implementation plans (the *how*) under docs/designs/, and the
    # consumer-owned archive guide docs/README.md. All consumer-owned so
    # sync never overwrites a project's requirements corpus.
    'docs/specs/',
    'docs/designs/',
    'docs/README.md'
)

# Paths whose upstream content is union-merged into the consumer's copy rather
# than overwritten (managed-paths) or left alone (always-local). The consumer
# keeps any local entries; any new upstream entries are appended. Today this is
# used only for .gitignore -- upstream is the single source of truth for
# sdlc.ai-mandated ignore patterns (.evidence/, .playwright-mcp/, .worktrees/,
# etc.) and consumers receive new patterns automatically as upstream evolves.
$script:MergePaths = @(
    '.gitignore'
)

$script:SdlcSyncStateFile = '.sdlc-ai-sync.json'

function ConvertTo-RepoRelativePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $n = $Path -replace '\\', '/'
    if ($n.StartsWith('./')) { $n = $n.Substring(2) }
    return $n
}

function Test-IsAlwaysLocalPath {
    <#
    .SYNOPSIS
        Returns $true if the given repo-relative path is on the always-local
        list. Entries ending in '/' are treated as directory prefixes
        (anything under them is consumer-owned), with one carve-out: files
        whose leaf name ends in '.template' or is exactly '.gitkeep' are
        upstream-managed even when they live inside a consumer-owned
        directory prefix (so first-time scaffolds and directory anchors can
        still flow from upstream). Other entries match exactly.
        Comparison is case-insensitive and tolerates ./ or .\ prefix.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    foreach ($candidate in $script:AlwaysLocalPaths) {
        $cc = $candidate -replace '\\', '/'
        if ($cc.EndsWith('/')) {
            if ($n.StartsWith($cc, [System.StringComparison]::OrdinalIgnoreCase)) {
                $leaf = Split-Path -Leaf $n
                if ($leaf.EndsWith('.template', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                if ([string]::Equals($leaf, '.gitkeep', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                return $true
            }
        }
        else {
            if ([string]::Equals($n, $cc, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
    }
    return $false
}

function Test-IsUpstreamManagedPath {
    <#
    .SYNOPSIS
        Returns $true if the given path is under an upstream-managed prefix
        AND not on the always-local or merge-paths list. Always-local and
        merge-paths trump managed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    if (Test-IsAlwaysLocalPath -Path $n) { return $false }
    if (Test-IsMergePath -Path $n) { return $false }
    foreach ($p in $script:UpstreamManagedPaths) {
        $pp = $p -replace '\\', '/'
        if ($pp.EndsWith('/')) {
            if ($n.StartsWith($pp, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        else {
            if ([string]::Equals($n, $pp, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
    }
    return $false
}

function Test-IsMergePath {
    <#
    .SYNOPSIS
        Returns $true if the given repo-relative path is on the merge-paths
        list (upstream content union-merged into the consumer's copy).
        Comparison is case-insensitive and tolerates ./ or .\ prefix.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    $n = ConvertTo-RepoRelativePath -Path $Path
    if (-not $n) { return $false }
    foreach ($candidate in $script:MergePaths) {
        if ([string]::Equals($n, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Test-IsUpstreamRepo {
    [CmdletBinding()]
    param([string]$RemoteUrl = (git remote get-url origin 2>$null))
    if (-not $RemoteUrl) { return $false }
    return $RemoteUrl -match 'IntelliSDLC\.ai(\.git)?/?$'
}

function ConvertTo-GitHubRepoSlug {
    <#
    .SYNOPSIS
        Parses a git remote URL and returns the GitHub <owner>/<repo> slug.

    .DESCRIPTION
        Accepts the URL forms git remote get-url normally emits:
          https://github.com/Owner/Repo.git
          https://github.com/Owner/Repo
          git@github.com:Owner/Repo.git
          ssh://git@github.com/Owner/Repo.git
          git@ssh.github.com:Owner/Repo.git
        Returns the canonical "Owner/Repo" string (no .git suffix). Returns
        $null for empty input or URLs that are not GitHub.

        Used to pass --repo explicitly to gh so it does not depend on
        `gh repo set-default`, which is unset on fresh consumer clones with
        multiple remotes (origin + sdlc.ai).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([string]$RemoteUrl)
    if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { return $null }
    $u = $RemoteUrl.Trim()
    # Normalize SSH forms (with or without the ssh:// prefix and with or
    # without an ssh.* host alias) and HTTPS forms into a single regex match
    # on the trailing "<owner>/<repo>" pair.
    $patterns = @(
        '^https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$',
        '^ssh://git@(?:[^/]*\.)?github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$',
        '^git@(?:[^:]*\.)?github\.com:([^/]+)/([^/]+?)(?:\.git)?/?$'
    )
    foreach ($p in $patterns) {
        $m = [regex]::Match($u, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($m.Success) { return "$($m.Groups[1].Value)/$($m.Groups[2].Value)" }
    }
    return $null
}

function Test-LsRemoteOutputHasExactBranch {
    <#
    .SYNOPSIS
        Returns $true iff the given `git ls-remote` output contains an exact
        match for refs/heads/<BranchName>.

    .DESCRIPTION
        `git ls-remote --heads <remote> <pattern>` matches <pattern> as a
        shell-style glob against the tail of each ref. That means passing
        a bare name like "main" can spuriously match "refs/heads/release/main"
        (or "refs/heads/main-old", depending on glob behavior across git
        versions), bypassing the missing-base-branch guard in
        Invoke-AutoWorktreeSync.

        Callers should pass `refs/heads/<BranchName>` to ls-remote (which
        avoids the tail glob entirely) AND verify the captured output via
        this helper so the check stays exact even if upstream git changes
        its globbing rules.

        Accepts the raw multi-line ls-remote output (string or string[]).
        Each ls-remote line is "<sha>\t<refname>". Trailing whitespace and
        empty lines are ignored.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [string]$LsRemoteOutput,
        [Parameter(Mandatory)][string]$BranchName
    )
    if ([string]::IsNullOrWhiteSpace($LsRemoteOutput)) { return $false }
    $target = "refs/heads/$BranchName"
    foreach ($line in ($LsRemoteOutput -split "`r?`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        # Format: "<sha>\t<refname>"; split on TAB. Use -ceq because git ref
        # names are case-sensitive but PowerShell's -eq is case-insensitive
        # by default, which would treat refs/heads/Main as a match for "main".
        $parts = $trimmed -split "`t", 2
        if ($parts.Count -eq 2 -and $parts[1].Trim() -ceq $target) { return $true }
    }
    return $false
}

function Resolve-RemoteHasProtectedBranch {
    <#
    .SYNOPSIS
        Pure decision: does origin have the protected base branch? Combines the
        `git ls-remote` result, whether that query SUCCEEDED, and whether a local
        remote-tracking ref exists -- so a transient ls-remote / network failure is
        never misread as "branch absent" (issue #204).
    .DESCRIPTION
        Returns $true when:
          - ls-remote succeeded and reported the exact refs/heads/<branch>, OR
          - a local remote-tracking ref (refs/remotes/origin/<branch>) exists, OR
          - ls-remote FAILED (we cannot determine; do not false-block the PR).
        Returns $false only when ls-remote SUCCEEDED, reported no exact match, AND
        there is no local tracking ref -- the genuine "never pushed origin/<branch>"
        case that warrants the push remediation.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [AllowEmptyString()][AllowNull()][string]$LsRemoteOutput,
        [Parameter(Mandatory)][bool]$LsRemoteSucceeded,
        [Parameter(Mandatory)][bool]$HasLocalTrackingRef,
        [Parameter(Mandatory)][string]$ProtectedBranch
    )
    if (Test-LsRemoteOutputHasExactBranch -LsRemoteOutput $LsRemoteOutput -BranchName $ProtectedBranch) {
        return $true
    }
    if ($HasLocalTrackingRef) { return $true }
    if (-not $LsRemoteSucceeded) { return $true }
    return $false
}

function Resolve-OpenSyncPRAction {
    <#
    .SYNOPSIS
        Decides whether (and how) Invoke-AutoWorktreeSync should call gh to open the sync PR.

    .DESCRIPTION
        Pure decision helper extracted from Invoke-AutoWorktreeSync so the
        two failure modes that originally broke `gh pr create` on consumer
        repos are unit-testable without mocking git or gh:

          1. origin lacks the protected base branch entirely (first-time
             consumer clones that never `git push -u origin main`) ->
             return Action='Skip' with a remediation Reason.
          2. origin URL parses to a GitHub owner/repo slug -> return
             GhRepoArgs=@('--repo', '<slug>') so gh does not depend on
             `gh repo set-default` (often unset with two remotes).

        Returns a hashtable: @{ Action='Skip'|'Proceed'; Reason=<string>; GhRepoArgs=<string[]> }.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][bool]$RemoteHasProtectedBranch,
        [Parameter(Mandatory)][string]$ProtectedBranch,
        [string]$OriginUrl
    )
    if (-not $RemoteHasProtectedBranch) {
        return @{
            Action     = 'Skip'
            Reason     = "origin has no '$ProtectedBranch' branch yet; push it first: git push -u origin $ProtectedBranch"
            GhRepoArgs = @()
        }
    }
    $slug = ConvertTo-GitHubRepoSlug -RemoteUrl $OriginUrl
    $args = @()
    if ($slug) { $args = @('--repo', $slug) }
    return @{
        Action     = 'Proceed'
        Reason     = $null
        GhRepoArgs = $args
    }
}

function Invoke-TemplateScaffold {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$TargetRoot,
        [Parameter(Mandatory)][System.Collections.IDictionary]$ScaffoldMap,
        # When set, same-name scaffold entries (where the map key equals the
        # value) read upstream content via `git -C $SourceRoot show $Ref:$key`
        # instead of copying from the working tree. This is how
        # `docs/README.md` (issue #156) -- a committed-in-upstream consumer
        # first-draft file that lives under the consumer-owned `docs/`
        # always-local prefixes -- is delivered on first sync.
        [string]$Ref
    )
    $scaffolded = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $ScaffoldMap.GetEnumerator()) {
        $target = Join-Path $TargetRoot $entry.Value
        if (Test-Path -LiteralPath $target) { continue }
        $targetDir = Split-Path -Parent $target
        if ($targetDir -and -not (Test-Path -LiteralPath $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }

        $isSameName = [string]::Equals($entry.Key, $entry.Value, [System.StringComparison]::OrdinalIgnoreCase)
        if ($isSameName) {
            # Same-name scaffold: the upstream content does NOT live in the
            # consumer working tree (the bare path is on $AlwaysLocalPaths and
            # therefore filtered out of diff-replay), so we must read it from
            # the upstream ref via `git show`. Without -Ref this case is a
            # silent no-op -- preserves the historical "missing source = skip"
            # behavior and keeps unit tests that don't supply a ref simple.
            if (-not $Ref) { continue }
            $spec = $Ref + ':' + $entry.Key
            $content = & git -C $SourceRoot show $spec 2>$null
            if ($LASTEXITCODE -ne 0 -or $null -eq $content) { continue }
            # `git show` emits an array of lines on PowerShell; rejoin with LF
            # so the on-disk file matches the upstream blob byte-for-byte
            # (modulo the trailing newline that Out-File would add).
            $text = if ($content -is [array]) { ($content -join "`n") } else { [string]$content }
            [System.IO.File]::WriteAllText($target, $text)
        }
        else {
            $template = Join-Path $SourceRoot $entry.Key
            if (-not (Test-Path -LiteralPath $template)) { continue }
            Copy-Item -LiteralPath $template -Destination $target -Force
        }
        $scaffolded.Add($entry.Value) | Out-Null
    }
    return $scaffolded.ToArray()
}

function ConvertTo-GitignoreChunk {
    <#
    .SYNOPSIS
        Parses .gitignore text into ordered chunks. Each chunk is a contiguous
        run of comment lines (lines beginning with '#') followed by a
        contiguous run of entry lines (non-blank, non-comment). Blank lines
        and EOF terminate a chunk. A chunk may have only comments, only
        entries, or both -- but the comments always precede the entries.
    .OUTPUTS
        Array of hashtables: @{ Comments = [string[]]; Entries = [string[]] }.
        Order matches input order.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $lines = $Text -split "`r?`n"
    $chunks = New-Object System.Collections.Generic.List[hashtable]
    $current = @{ Comments = [System.Collections.Generic.List[string]]::new(); Entries = [System.Collections.Generic.List[string]]::new() }
    $flush = {
        if ($current.Comments.Count -gt 0 -or $current.Entries.Count -gt 0) {
            $chunks.Add(@{
                Comments = $current.Comments.ToArray()
                Entries  = $current.Entries.ToArray()
            }) | Out-Null
        }
        $script:__convertCurrent = @{ Comments = [System.Collections.Generic.List[string]]::new(); Entries = [System.Collections.Generic.List[string]]::new() }
    }
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if (-not $trim) {
            & $flush
            $current = $script:__convertCurrent
            continue
        }
        if ($trim.StartsWith('#')) {
            if ($current.Entries.Count -gt 0) {
                & $flush
                $current = $script:__convertCurrent
            }
            $current.Comments.Add($line) | Out-Null
        }
        else {
            $current.Entries.Add($line) | Out-Null
        }
    }
    & $flush
    Remove-Variable -Name __convertCurrent -Scope Script -ErrorAction SilentlyContinue
    return $chunks.ToArray()
}

function Get-GitignoreLineEnding {
    <#
    .SYNOPSIS
        Detects whether the file at $Path uses CRLF or LF line endings.
        Returns "`r`n" or "`n". Default LF when the file is missing, empty,
        or contains no line breaks.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return "`n" }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return "`n" }
    # CRLF detection: any CR (0x0D) followed by LF (0x0A) in the file.
    for ($i = 0; $i -lt $bytes.Length - 1; $i++) {
        if ($bytes[$i] -eq 13 -and $bytes[$i + 1] -eq 10) { return "`r`n" }
    }
    return "`n"
}

function Remove-UpstreamOnlyMarkerBlocks {
    <#
    .SYNOPSIS
        Strips upstream-only marker blocks from .gitignore text before it is
        propagated to a consumer. A block starts with a comment line matching
        `^#\s*>>>\s*upstream-only\s*>>>` and ends with the matching closer
        `^#\s*<<<\s*upstream-only\s*<<<` (case-insensitive). The markers and
        every line between them are dropped. If the closing marker is missing,
        everything from the opening marker to end of file is dropped
        (defensive: never leak upstream-only entries downstream just because
        someone forgot the closer).
    .OUTPUTS
        [string] the input text with all upstream-only blocks removed.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $openRe  = '^\s*#\s*>>>\s*upstream-only\s*>>>'
    $closeRe = '^\s*#\s*<<<\s*upstream-only\s*<<<'
    $opts = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    $lines = $Text -split "`r?`n"
    $out = New-Object System.Collections.Generic.List[string]
    $inBlock = $false
    foreach ($line in $lines) {
        if (-not $inBlock) {
            if ([regex]::IsMatch($line, $openRe, $opts)) {
                $inBlock = $true
                continue
            }
            $out.Add($line) | Out-Null
        }
        else {
            if ([regex]::IsMatch($line, $closeRe, $opts)) {
                $inBlock = $false
            }
            # else: still inside block, drop the line.
        }
    }
    return ($out -join "`n")
}

function Merge-FileFromUpstream {
    <#
    .SYNOPSIS
        Union-merges an upstream file's content into the consumer's copy.
        Today only supports .gitignore (chunked comment-block + entry
        semantics). Creates the local file if absent. Idempotent.
    .DESCRIPTION
        Reads the upstream file via `git show $Ref:$Path`. Parses both the
        upstream and the local copy into (comment-block + entry) chunks.
        For each upstream chunk: drops any entries already present in the
        local file; if no entries remain, drops the whole chunk. Surviving
        chunks are appended to the local file (or written as the new file
        if no local copy existed).

        Upstream-only marker blocks (lines between `# >>> upstream-only >>>`
        and `# <<< upstream-only <<<`, case-insensitive) are stripped from
        the upstream text before chunking, so entries inside the markers
        are never propagated to the consumer. An unterminated marker drops
        everything from the opener to end of file.

        Line endings are preserved -- if the local file uses CRLF, the
        appended content uses CRLF; otherwise LF.
    .OUTPUTS
        [bool] $true if the local file was modified (or created); $false
        when no changes were needed (already in sync).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    Push-Location $RepoRoot
    try {
        $upstreamRaw = & git show "${Ref}:${Path}" 2>$null
        if ($LASTEXITCODE -ne 0 -or $null -eq $upstreamRaw) { return $false }
    }
    finally { Pop-Location }

    $upstreamText = if ($upstreamRaw -is [array]) { $upstreamRaw -join "`n" } else { [string]$upstreamRaw }
    $upstreamText = Remove-UpstreamOnlyMarkerBlocks -Text $upstreamText
    $upstreamChunks = ConvertTo-GitignoreChunk -Text $upstreamText

    $localAbs = Join-Path $RepoRoot $Path
    $localExists = Test-Path -LiteralPath $localAbs
    $localText = if ($localExists) { Get-Content -LiteralPath $localAbs -Raw } else { '' }
    if ($null -eq $localText) { $localText = '' }
    $localChunks = ConvertTo-GitignoreChunk -Text $localText

    $localEntrySet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($chunk in $localChunks) {
        foreach ($entry in $chunk.Entries) {
            $localEntrySet.Add($entry.Trim()) | Out-Null
        }
    }

    $additions = New-Object System.Collections.Generic.List[string]
    foreach ($chunk in $upstreamChunks) {
        if ($chunk.Entries.Count -eq 0) { continue }   # comment-only chunk -- skip
        $missing = New-Object System.Collections.Generic.List[string]
        foreach ($entry in $chunk.Entries) {
            if (-not $localEntrySet.Contains($entry.Trim())) {
                $missing.Add($entry) | Out-Null
            }
        }
        if ($missing.Count -eq 0) { continue }
        if ($additions.Count -gt 0 -or $localExists) {
            $additions.Add('') | Out-Null
        }
        foreach ($c in $chunk.Comments) { $additions.Add($c) | Out-Null }
        foreach ($e in $missing) { $additions.Add($e) | Out-Null }
    }

    if ($additions.Count -eq 0) { return $false }

    $eol = Get-GitignoreLineEnding -Path $localAbs
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $trimmedLocal = if ($localExists) { $localText.TrimEnd("`r", "`n") } else { '' }
    $newContent = if ($trimmedLocal) {
        $trimmedLocal + $eol + ($additions -join $eol) + $eol
    } else {
        ($additions -join $eol) + $eol
    }
    $localDir = Split-Path -Parent $localAbs
    if ($localDir -and -not (Test-Path -LiteralPath $localDir)) {
        New-Item -ItemType Directory -Path $localDir -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($localAbs, $newContent, $utf8NoBom)
    return $true
}

function Invoke-MainTreeCleanup {
    <#
    .SYNOPSIS
        Restores a parent (typically `main`) working tree to a clean state
        after a successful auto-worktree sync. For every manifest path that
        the user dropped into the parent tree to bootstrap the script
        (Pull-SDLC.ai.ps1, Cleanup-Worktree.ps1, etc.), if the local copy is
        byte-identical to upstream the script either deletes it (untracked
        case -- PR merge will restore as tracked) or `git checkout`s it
        (tracked-but-modified case). When local content differs from
        upstream, the file is left in place and a warning is printed.
    .OUTPUTS
        Array of strings describing each action taken (for caller logging /
        test inspection). Empty when nothing needed cleanup.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$UpstreamRef,
        [string[]]$Candidates = @(
            'Pull-SDLC.ai.ps1',
            'Pull-SDLC.ai.Tests.ps1',
            'Cleanup-Worktree.ps1',
            'Consolidate-Specs.ps1',
            'Consolidate-Specs.Tests.ps1'
        )
    )
    $actions = New-Object System.Collections.Generic.List[string]
    Push-Location $RepoRoot
    try {
        $porcelain = git status --porcelain 2>$null
        $untracked = @()
        $modified = @()
        foreach ($line in $porcelain) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            if ($line.Length -lt 4) { continue }
            $xy = $line.Substring(0, 2)
            $path = $line.Substring(3).Trim('"')
            if ($xy -eq '??') { $untracked += $path }
            elseif ($xy[1] -eq 'M' -or $xy[0] -eq 'M') { $modified += $path }
        }

        foreach ($path in $Candidates) {
            $abs = Join-Path $RepoRoot $path
            if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { continue }
            $isUntracked = ($untracked -contains $path)
            $isModified = ($modified -contains $path)
            if (-not ($isUntracked -or $isModified)) { continue }

            $upstreamSha = (& git rev-parse "${UpstreamRef}:${path}" 2>$null)
            if (-not $upstreamSha -or $LASTEXITCODE -ne 0) { continue }
            # --no-filters compares raw bytes to raw bytes, bypassing
            # core.autocrlf text conversion. Without it, on Windows with
            # autocrlf=true and a CRLF-stored upstream blob, hash-object
            # normalises CRLF -> LF before hashing and produces a hash that
            # never matches the raw upstream blob, yielding a spurious
            # "differs from upstream" warning even when bytes are identical.
            $localSha = (& git hash-object --no-filters -- $abs 2>$null)
            if (-not $localSha) { continue }

            if ($localSha.Trim() -eq $upstreamSha.Trim()) {
                if ($isUntracked) {
                    if ($PSCmdlet.ShouldProcess($path, 'Remove untracked-and-identical file')) {
                        Remove-Item -LiteralPath $abs -Force
                        $msg = "Cleanup: removed untracked '$path' (byte-identical to upstream; PR merge will restore tracked)."
                        Write-Information $msg
                        $actions.Add($msg) | Out-Null
                    }
                }
                else {
                    # Only revert when HEAD also matches upstream -- i.e. the
                    # working-tree edits are truly redundant. If HEAD differs
                    # from upstream, the working tree may legitimately hold a
                    # newer version (e.g. a self-refresh just rewrote
                    # Pull-SDLC.ai.ps1 to upstream's newer bytes but the new
                    # version has not yet been committed). Reverting in that
                    # case would silently downgrade the file back to HEAD's
                    # older content.
                    $headSha = (& git rev-parse "HEAD:${path}" 2>$null)
                    if ($headSha -and $LASTEXITCODE -eq 0 -and $headSha.Trim() -eq $upstreamSha.Trim()) {
                        if ($PSCmdlet.ShouldProcess($path, 'Revert tracked-and-modified-to-identical file')) {
                            & git checkout -- $path 2>$null | Out-Null
                            $msg = "Cleanup: reverted '$path' to HEAD (working tree was modified but identical to upstream)."
                            Write-Information $msg
                            $actions.Add($msg) | Out-Null
                        }
                    }
                    # else: HEAD differs from upstream; the working tree may
                    # legitimately contain a newer self-refreshed version.
                    # Leave it alone (no warning -- this is a normal pending
                    # update awaiting commit).
                }
            }
            else {
                $msg = "Cleanup: '$path' has local changes that differ from upstream; left in place."
                Write-Warning $msg
                $actions.Add($msg) | Out-Null
            }
        }
    }
    finally { Pop-Location }
    return $actions.ToArray()
}

function Get-SdlcSyncState {
    <#
    .SYNOPSIS
        Reads .sdlc-ai-sync.json from $RepoRoot. Returns $null when absent.
    #>
    [CmdletBinding()]
    param([string]$RepoRoot = '.')
    $path = Join-Path $RepoRoot $script:SdlcSyncStateFile
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
    }
    catch {
        throw "Failed to parse $path : $($_.Exception.Message)"
    }
}

function Set-SdlcSyncState {
    <#
    .SYNOPSIS
        Writes .sdlc-ai-sync.json with the given remote/ref/commit + UTC now.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Remote,
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][string]$Commit
    )
    $obj = [ordered]@{
        remote         = $Remote
        ref            = $Ref
        lastSyncCommit = $Commit
        syncedAt       = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    # Normalize to LF-only. ConvertTo-Json on Windows emits CRLF inside the
    # JSON body which, combined with a consumer `.gitattributes` rule like
    # `*.json text eol=lf`, can cause `git status` to flag the file as
    # modified immediately after the sync commit under some autocrlf
    # settings (issue #148).
    $json = (($obj | ConvertTo-Json) -replace "`r`n", "`n") + "`n"
    $absPath = Join-Path $RepoRoot $script:SdlcSyncStateFile
    [System.IO.File]::WriteAllText($absPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Test-NoManagedFilesPresent {
    <#
    .SYNOPSIS
        Returns $true if the working tree contains NO files matching any
        upstream-managed path or prefix. Used by Resolve-SyncAnchor to
        detect an unambiguous bootstrap state (an empty repo, or a repo
        with only consumer-owned content). Always-local and merge-paths
        are excluded so e.g. a stray README.md or .gitignore does not
        block auto-detect.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [string[]]$ManagedPaths = $script:UpstreamManagedPaths
    )
    foreach ($p in $ManagedPaths) {
        # Skip meta-scripts: the bootstrap script and its siblings are
        # guaranteed to be present when the user runs `iwr Pull-SDLC.ai.ps1`
        # in an otherwise empty directory, so their presence is not a signal
        # of pre-existing managed content (issue #152).
        if ($script:MetaScriptPaths -contains $p) { continue }
        $rel = $p -replace '/', [System.IO.Path]::DirectorySeparatorChar
        $abs = Join-Path $RepoRoot $rel
        if ($p.EndsWith('/')) {
            if (-not (Test-Path -LiteralPath $abs -PathType Container)) { continue }
            $files = Get-ChildItem -LiteralPath $abs -Recurse -File -Force -ErrorAction SilentlyContinue
            foreach ($f in $files) {
                $r = $f.FullName.Substring($RepoRoot.Length).TrimStart('\','/') -replace '\\', '/'
                if (Test-IsUpstreamManagedPath -Path $r) { return $false }
            }
        }
        else {
            if (Test-Path -LiteralPath $abs -PathType Leaf) {
                if (Test-IsUpstreamManagedPath -Path $p) { return $false }
            }
        }
    }
    return $true
}

function Resolve-SyncAnchor {
    <#
    .SYNOPSIS
        Determines the anchor SHA. Returns @{ Sha = <sha or empty>; Source = <state|grep|bootstrap|auto-bootstrap> }.
        Returns $null if no anchor could be determined and the user
        declines the prompt in the ambiguous case.
    .DESCRIPTION
        Resolution order:
        1. -Bootstrap explicit override -> bootstrap.
        2. .sdlc-ai-sync.json state file -> state anchor.
        3. `chore.*sync.*IntelliSDLC` commit in git log -> grep anchor.
        4. Auto-detect: no managed files in working tree -> silent
           auto-bootstrap with banner (the unambiguous from-zero case).
        5. -NoPrompt -> bootstrap (CI mode).
        6. Otherwise prompt the user.
    #>
    [CmdletBinding()]
    param(
        [string]$RepoRoot = '.',
        [switch]$Bootstrap,
        [switch]$NoPrompt
    )
    if ($Bootstrap) {
        return @{ Sha = ''; Source = 'bootstrap' }
    }
    $state = Get-SdlcSyncState -RepoRoot $RepoRoot
    if ($null -ne $state -and $state.PSObject.Properties.Name -contains 'lastSyncCommit' -and $state.lastSyncCommit) {
        return @{ Sha = $state.lastSyncCommit; Source = 'state' }
    }
    Push-Location $RepoRoot
    try {
        $grep = git log --grep '^chore.*sync.*IntelliSDLC' --pretty=format:%H -n 1 2>$null
    }
    finally { Pop-Location }
    if ($grep) {
        Write-Information "Anchor: using commit $grep (matched 'chore: sync IntelliSDLC...' in git log)."
        return @{ Sha = ($grep | Select-Object -First 1).Trim(); Source = 'grep' }
    }
    $absRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
    if (Test-NoManagedFilesPresent -RepoRoot $absRepoRoot) {
        Write-Information ''
        Write-Information '[Bootstrap] No prior sync detected and no upstream-managed files present.'
        Write-Information '[Bootstrap] Performing initial sync from upstream HEAD (empty-tree anchor).'
        return @{ Sha = ''; Source = 'auto-bootstrap' }
    }
    if ($NoPrompt) {
        return @{ Sha = ''; Source = 'bootstrap' }
    }
    Write-Warning 'No .sdlc-ai-sync.json and no prior sync commit found.'
    Write-Warning 'Existing upstream-managed files were detected; bootstrap will overwrite them.'
    Write-Warning 'Bootstrap will perform a full refresh from upstream HEAD (empty-tree anchor).'
    $ans = Read-Host 'Proceed with bootstrap? [y/N]'
    if ($ans -match '^[Yy]') {
        return @{ Sha = ''; Source = 'bootstrap' }
    }
    return $null
}

function Get-UpstreamOps {
    <#
    .SYNOPSIS
        Parses `git diff --name-status -M -B <anchor> <ref> -- <paths>` into
        a list of op hashtables: @{ Op = A|M|D|T|R|C; Path = ...; OldPath = ... }.
    .DESCRIPTION
        Empty $Anchor means "empty tree" (full refresh). Always-local paths
        are filtered out (regardless of which side they appear on).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Anchor,
        [Parameter(Mandatory)][string]$Ref,
        [Parameter(Mandatory)][string[]]$ManagedPaths,
        [string]$RepoRoot = '.'
    )
    Push-Location $RepoRoot
    try {
        $left = if ([string]::IsNullOrWhiteSpace($Anchor)) {
            # Empty-tree SHA, hard-coded by git.
            '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
        } else { $Anchor }

        $argv = @('diff', '--name-status', '-M', '-B', $left, $Ref, '--')
        $argv += $ManagedPaths
        $raw = & git @argv 2>$null
    }
    finally { Pop-Location }

    $ops = New-Object System.Collections.Generic.List[hashtable]
    if (-not $raw) { return @() }
    foreach ($line in $raw) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "`t"
        if ($parts.Count -lt 2) { continue }
        $code = $parts[0]
        # First character is the op; trailing digits are similarity / break score.
        $op = $code.Substring(0, 1).ToUpperInvariant()
        $entry = $null
        switch ($op) {
            'R' {
                if ($parts.Count -lt 3) { continue }
                $entry = @{ Op = 'R'; OldPath = $parts[1]; Path = $parts[2] }
            }
            'C' {
                if ($parts.Count -lt 3) { continue }
                $entry = @{ Op = 'C'; OldPath = $parts[1]; Path = $parts[2] }
            }
            default {
                if ('A','M','D','T' -notcontains $op) { continue }
                $entry = @{ Op = $op; Path = $parts[1]; OldPath = $null }
            }
        }
        if ($null -eq $entry) { continue }
        # Drop ops whose primary path is always-local or merge-managed. For
        # R/C, also drop if the OldPath is always-local or merge-managed
        # (don't delete consumer-owned or merged files).
        if (Test-IsAlwaysLocalPath -Path $entry.Path) { continue }
        if (Test-IsMergePath -Path $entry.Path) { continue }
        if ($entry.OldPath -and (Test-IsAlwaysLocalPath -Path $entry.OldPath)) { continue }
        if ($entry.OldPath -and (Test-IsMergePath -Path $entry.OldPath)) { continue }
        $ops.Add($entry) | Out-Null
    }
    return $ops.ToArray()
}

function Invoke-UpstreamOp {
    <#
    .SYNOPSIS
        Applies one op (A/M/T/D/R/C) to the working tree at $RepoRoot,
        reading file contents from $Ref via `git show`.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Op,
        [Parameter(Mandatory)][string]$Ref,
        [string]$RepoRoot = '.'
    )
    $write = {
        param($relPath)
        $abs = Join-Path $RepoRoot $relPath
        $dir = Split-Path -Parent $abs
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        # Capture raw bytes via System.Diagnostics.Process to avoid PowerShell
        # pipeline newline normalization (preserves byte-for-byte equivalence
        # with the upstream blob).
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'git'
        $psi.ArgumentList.Add('show') | Out-Null
        $psi.ArgumentList.Add("${Ref}:${relPath}") | Out-Null
        $psi.WorkingDirectory = $RepoRoot
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $proc = [System.Diagnostics.Process]::Start($psi)
        $ms = New-Object System.IO.MemoryStream
        $proc.StandardOutput.BaseStream.CopyTo($ms)
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        if ($proc.ExitCode -ne 0) {
            throw "git show ${Ref}:${relPath} failed (exit $($proc.ExitCode)): $stderr"
        }
        [System.IO.File]::WriteAllBytes($abs, $ms.ToArray())
    }
    $remove = {
        param($relPath)
        $abs = Join-Path $RepoRoot $relPath
        if (Test-Path -LiteralPath $abs) {
            Remove-Item -LiteralPath $abs -Force
        }
    }
    switch ($Op.Op) {
        'A' { & $write $Op.Path }
        'M' { & $write $Op.Path }
        'T' { & $write $Op.Path }
        'D' { & $remove $Op.Path }
        'R' { & $remove $Op.OldPath; & $write $Op.Path }
        'C' { & $write $Op.Path }
        default { throw "Unsupported op: $($Op.Op)" }
    }
}

function Test-PathContentInUpstreamHistory {
    <#
    .SYNOPSIS
        Returns $true when the consumer's HEAD content of $Path matches any version
        of that path in the upstream ref's history -- byte-for-byte or modulo
        CR-at-EOL. Used to tell upstream-sourced-but-stale content (a self-update or
        an older/newer sync that left the recorded anchor out of step with the file)
        apart from a genuine consumer-authored local edit.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Blob,
        [Parameter(Mandatory)][string]$UpstreamRef,
        [string]$RepoRoot = '.'
    )
    Push-Location $RepoRoot
    try {
        # Fast path: exact blob match anywhere in the path's upstream history.
        $hit = & git log $UpstreamRef --find-object=$Blob --max-count=1 --pretty=format:%H -- $Path 2>$null
        if ($hit) { return $true }
        # CRLF-tolerant fallback: a Windows consumer may have committed CRLF where
        # upstream stores LF, so exact blob SHAs differ for identical content.
        # Compare against each distinct upstream blob for the path, ignoring
        # CR-at-EOL. Distinct blobs are far fewer than commits, so this is bounded.
        $commits = @(& git log $UpstreamRef --pretty=format:%H -- $Path 2>$null)
        $seen = New-Object System.Collections.Generic.HashSet[string]
        foreach ($c in $commits) {
            $upBlob = (& git rev-parse "${c}:$Path" 2>$null)
            if (-not $upBlob) { continue }
            if (-not $seen.Add($upBlob)) { continue }
            & git diff --quiet --ignore-cr-at-eol $Blob $upBlob 2>$null
            if ($LASTEXITCODE -eq 0) { return $true }
        }
        return $false
    }
    finally { Pop-Location }
}

function Test-LocalDriftOnManagedPaths {
    <#
    .SYNOPSIS
        For each upstream-managed path that currently exists at HEAD, compares
        its HEAD blob to the same path's blob at $Anchor. Returns an array of
        @{ Path = ...; Commit = '<sha> <subject>' } for drift entries.
    .DESCRIPTION
        A fast blob-SHA comparison is used as a pre-filter. Because blob SHAs are
        end-of-line sensitive, a Windows consumer whose git committed the synced
        files with CRLF will have HEAD blobs that differ from the upstream LF
        blobs even though the content is identical. To avoid this false positive,
        any path whose blobs differ is confirmed with an EOL-insensitive content
        diff (git diff --ignore-cr-at-eol); only paths that still differ after
        ignoring CR-at-EOL are reported as drift. Genuine divergence -- including
        upstream-deleted files the consumer still has committed -- is preserved.

        When -UpstreamRef is supplied, a path whose HEAD content differs from the
        anchor but still matches some version of that path in the upstream ref's
        history is treated as upstream-sourced-but-stale (e.g. a self-update that
        advanced the script ahead of the recorded anchor, or an older/newer sync)
        and is NOT reported as drift. Only content that exists nowhere upstream is
        a genuine consumer local edit.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Anchor,
        [Parameter(Mandatory)][string[]]$ManagedPaths,
        [string]$UpstreamRef,
        [string]$RepoRoot = '.'
    )
    Push-Location $RepoRoot
    try {
        # Only ls-tree paths that actually exist at HEAD; trailing-slash directory
        # pathspecs are fine but a non-existent file path makes ls-tree no-op.
        $headPaths = & git ls-tree -r --name-only HEAD -- @ManagedPaths 2>$null
        $headPaths = @($headPaths)
        if ($headPaths.Count -eq 0) { return @() }
        $drift = New-Object System.Collections.Generic.List[hashtable]
        foreach ($p in $headPaths) {
            if (Test-IsAlwaysLocalPath -Path $p) { continue }
            $headSha = (& git rev-parse "HEAD:$p" 2>$null)
            $anchorSha = (& git rev-parse "${Anchor}:$p" 2>$null)
            if ($headSha -and $headSha -ne $anchorSha) {
                # Blobs differ. Confirm this is a real content change and not just
                # CRLF/LF normalization before flagging it as a policy violation.
                & git diff --quiet --ignore-cr-at-eol $Anchor HEAD -- $p 2>$null
                if ($LASTEXITCODE -eq 0) { continue }
                # Content that exists somewhere in the upstream history for this
                # path is upstream-sourced, not a consumer edit -- never a violation.
                if ($UpstreamRef -and (Test-PathContentInUpstreamHistory -Path $p -Blob $headSha -UpstreamRef $UpstreamRef -RepoRoot $RepoRoot)) {
                    continue
                }
                $log = (& git log -1 --pretty='%h %s' -- $p 2>$null) -join ''
                $drift.Add(@{ Path = $p; Commit = $log }) | Out-Null
            }
        }
        return $drift.ToArray()
    }
    finally { Pop-Location }
}

function Test-CommitContextAllowed {
    <#
    .SYNOPSIS
        Returns @{ Allowed = $true/$false; Reason = <string>; Branch = <branch> }.
        Used by Invoke-PullSDLC to fail fast before mutating the working tree when
        the consumer is on the protected branch (typically 'main'), which would
        cause the sync commit to fail (either via .githooks/pre-commit policy or
        a remote branch-protection rule on push).
    .DESCRIPTION
        This is a pure protected-branch check. The caller (Invoke-PullSDLC)
        decides when to invoke it based on the effective -CommitOnMain
        setting; this function does not know about sync state or origin
        configuration.
    #>
    [CmdletBinding()]
    param(
        [string]$RepoRoot = '.',
        [string]$ProtectedBranch = 'main'
    )
    Push-Location $RepoRoot
    try {
        $branch = (git symbolic-ref --short HEAD 2>$null)
        if ($branch -eq $ProtectedBranch) {
            return @{ Allowed = $false; Reason = "on protected branch '$ProtectedBranch'"; Branch = $branch }
        }
        return @{ Allowed = $true; Reason = $null; Branch = $branch }
    }
    finally { Pop-Location }
}

function Test-IsBootstrapSync {
    <#
    .SYNOPSIS
        Returns $true when the consumer has not been synced from
        IntelliSDLC.ai before -- i.e. there is no .sdlc-ai-sync.json
        state file AND no prior `chore: sync IntelliSDLC...` commit in
        the git log. This is the signal Invoke-PullSDLC uses to default
        -CommitOnMain to $true (first-time tooling onboarding).
    #>
    [CmdletBinding()]
    param([string]$RepoRoot = '.')
    if (Get-SdlcSyncState -RepoRoot $RepoRoot) { return $false }
    Push-Location $RepoRoot
    try {
        $grep = git log --grep '^chore.*sync.*IntelliSDLC' --pretty=format:%H -n 1 2>$null
    }
    finally { Pop-Location }
    return [string]::IsNullOrWhiteSpace(($grep | Out-String))
}

function Invoke-AutoWorktreeSync {
    <#
    .SYNOPSIS
        Auto-worktree workflow: create or reuse .worktrees/sdlc-sync on
        branch chore/sdlc-sync, re-invoke the sync inside it, push, and
        (unless -NoAutoPR) open a PR via gh. The sdlc-sync worktree is
        treated as pure scratch: any dirty state or stale unpushed commits
        from a prior interrupted run are discarded by an unconditional
        reset-hard + clean to ProtectedBranch before the sync replays.
    .DESCRIPTION
        Returns an integer status code:
            0 = success (PR opened OR push done with manual PR URL printed)
            6 = sync inside worktree returned non-zero (passed through)
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$ProtectedBranch,
        [string]$WorktreePath = '.worktrees/sdlc-sync',
        [string]$SyncBranch = 'chore/sdlc-sync',
        [switch]$NoAutoPR,
        [hashtable]$SyncArgs = @{}
    )
    $absWorktree = Join-Path $RepoRoot $WorktreePath
    Push-Location $RepoRoot
    try {
        # The sdlc-sync worktree is pure scratch -- every file in it is
        # regenerated from upstream on each run. So when reusing an existing
        # worktree we unconditionally reset it to ProtectedBranch and clean
        # untracked files. This makes Pull-SDLC.ai.ps1 self-healing across
        # interrupted prior runs, stale unpushed commits, half-applied
        # patches, etc. The branch HEAD will be rebuilt by the sync run that
        # follows; if a PR is already open against origin/$SyncBranch, the
        # subsequent push will simply update it.
        # A worktree directory always contains a .git FILE (not directory).
        $worktreeMarker = Join-Path $absWorktree '.git'
        $markerExists = (Test-Path $worktreeMarker -PathType Leaf)
        $reusing = $false
        if ($markerExists) {
            # Validate that the marker actually belongs to THIS repo. A
            # leftover .worktrees/sdlc-sync/ directory can carry a .git file
            # whose `gitdir:` line points to a different repo's (or a
            # deleted) gitdir -- e.g. a copied tree, or a worktree directory
            # that survived after the owning repo was relocated/removed.
            # Trusting the marker in that case yields "fatal: not a git
            # repository: (NULL)" for every subsequent git call inside the
            # worktree (issue #180). Probe with `git rev-parse
            # --git-common-dir` and compare against this repo's common-dir.
            $thisCommonDir = (git rev-parse --git-common-dir 2>$null)
            $thisCommonDirResolved = if ($thisCommonDir) { try { (Resolve-Path -LiteralPath $thisCommonDir -ErrorAction Stop).Path } catch { $null } } else { $null }
            $reusing = $false
            Push-Location $absWorktree
            try {
                $wtCommonDir = (git rev-parse --git-common-dir 2>$null)
                if ($LASTEXITCODE -eq 0 -and $wtCommonDir) {
                    $wtCommonDirResolved = try { (Resolve-Path -LiteralPath $wtCommonDir -ErrorAction Stop).Path } catch { $null }
                    if ($wtCommonDirResolved -and $thisCommonDirResolved -and
                        ([string]::Equals($wtCommonDirResolved, $thisCommonDirResolved, [System.StringComparison]::OrdinalIgnoreCase))) {
                        $reusing = $true
                    }
                }
            }
            finally { if ((Get-Location).Path -eq $absWorktree) { Pop-Location } }

            if (-not $reusing) {
                Write-Information "Discarding stale worktree directory '$WorktreePath' (marker does not belong to this repo)."
                # Try a clean git-worktree removal first (works when this repo
                # has a stale registration for the path). Fall back to a raw
                # filesystem delete when the directory is orphaned.
                git worktree remove --force $absWorktree 2>&1 | Out-Null
                git worktree prune 2>&1 | Out-Null
                if (Test-Path -LiteralPath $absWorktree) {
                    Remove-Item -LiteralPath $absWorktree -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
        if ($reusing) {
            Push-Location $absWorktree
            try {
                $dirty = git status --porcelain
                $aheadOfMain = git log "$ProtectedBranch..HEAD" --oneline 2>$null
                if ($dirty -or $aheadOfMain) {
                    Write-Information "Resetting reused worktree '$WorktreePath' to '$ProtectedBranch' (scratch area; prior state discarded)."
                    git reset --hard $ProtectedBranch 2>&1 | Out-Null
                    git clean -fdx 2>&1 | Out-Null
                } else {
                    Write-Information "Reusing existing worktree '$WorktreePath' (clean)."
                }
            } finally { if ((Get-Location).Path -eq $absWorktree) { Pop-Location } }
        }
        else {
            Write-Information "Creating worktree '$WorktreePath' on '$SyncBranch' from '$ProtectedBranch' ..."
            $branchListing = git branch --list $SyncBranch 2>$null
            $branchExists = $branchListing -ne $null -and ("$branchListing".Trim() -ne '')
            if ($branchExists) {
                git worktree add $absWorktree $SyncBranch | Out-Null
            } else {
                git worktree add -b $SyncBranch $absWorktree $ProtectedBranch | Out-Null
            }
        }
    }
    finally { Pop-Location }

    Push-Location $absWorktree
    try {
        Write-Information "Running sync inside worktree (branch '$SyncBranch') ..."
        $args = @{} + $SyncArgs
        $args['RepoRoot'] = $absWorktree
        $rc = Invoke-PullSDLC @args
        if ($rc -ne 0) {
            Write-Error "Worktree sync returned rc=$rc. Aborting auto-PR." -ErrorAction Continue
            return 6
        }

        # Anything to push?
        $unpushed = git log "origin/$SyncBranch..HEAD" --oneline 2>$null
        $needsPush = $true
        $remoteHasBranch = (git ls-remote --heads origin $SyncBranch 2>$null)
        if ($remoteHasBranch -and -not $unpushed) {
            # No new commits vs remote.
            $needsPush = $false
        }
        $newCommits = git log "$ProtectedBranch..HEAD" --oneline 2>$null
        if (-not $newCommits) {
            Write-Information 'No new commits to push (worktree already in sync with main). Nothing to PR.'
            return 0
        }

        if ($needsPush) {
            Write-Information "Pushing '$SyncBranch' to origin ..."
            git push -u origin $SyncBranch 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                # 'chore/sdlc-sync' is a pure scratch branch: every run
                # regenerates it from ProtectedBranch, so prior remote state
                # has no value (same scratch rationale as the worktree reset
                # above). When the straight push is rejected (typically
                # non-fast-forward, because a prior run advanced the remote
                # ref past our local history), retry once with
                # --force-with-lease. We use --force-with-lease (NOT plain
                # --force) so we still abort if a *different* writer pushed
                # to the remote since we last fetched.
                Write-Information "Remote '$SyncBranch' diverged; force-pushing scratch branch ..."
                git push --force-with-lease -u origin $SyncBranch 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning 'git push failed (including --force-with-lease retry); PR step skipped.'
                    return 0
                }
            }
        }

        if ($NoAutoPR) {
            Write-Information "Skipping PR creation (-NoAutoPR)."
            Write-Warning "Open one manually: gh pr create --base $ProtectedBranch --head $SyncBranch"
            return 0
        }

        $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
        if (-not $ghCmd) {
            Write-Warning 'gh CLI not found; skipping automatic PR creation.'
            $remoteUrl = (git remote get-url origin).Trim()
            $compareUrl = $remoteUrl -replace '\.git$','' -replace '^git@github\.com:','https://github.com/'
            Write-Warning "Open one manually: $compareUrl/compare/${ProtectedBranch}...${SyncBranch}?expand=1"
            return 0
        }

        # Decide whether to call gh, and with what --repo args, via the
        # pure helper Resolve-OpenSyncPRAction (unit-tested separately).
        # Handles two failure modes that originally broke `gh pr create` on
        # consumer repos:
        #   (1) origin lacks the protected base branch entirely -> Skip
        #       with a remediation, instead of letting gh return the cryptic
        #       "Base ref must be a branch" error.
        #   (2) When the origin URL parses to a GitHub owner/repo slug,
        #       pass it as --repo so gh does not depend on
        #       `gh repo set-default` (frequently unset on consumer clones
        #       with two GitHub remotes, which yielded blank head/base
        #       shas). If the URL is not a GitHub URL or is unparseable,
        #       Resolve-OpenSyncPRAction returns empty GhRepoArgs and we
        #       fall back to gh's own default-repo behavior.
        # Pass the fully-qualified ref to ls-remote so the pattern is matched
        # exactly (a bare branch name like "main" is treated as a shell glob
        # by ls-remote and can spuriously match e.g. "refs/heads/release/main"),
        # then verify the output contains the exact ref via the unit-tested
        # helper Test-LsRemoteOutputHasExactBranch.
        $lsRemoteOut = (git ls-remote --heads origin "refs/heads/$ProtectedBranch" 2>$null | Out-String)
        $lsRemoteOk = ($LASTEXITCODE -eq 0)
        # Fall back to the local remote-tracking ref so a transient ls-remote /
        # network failure (empty output, swallowed by 2>$null) is not misread as
        # "origin has no <branch>" and does not skip the PR (issue #204).
        git rev-parse --verify --quiet "refs/remotes/origin/$ProtectedBranch" 2>$null | Out-Null
        $hasLocalTrackingRef = ($LASTEXITCODE -eq 0)
        $hasProtected = Resolve-RemoteHasProtectedBranch -LsRemoteOutput $lsRemoteOut `
            -LsRemoteSucceeded $lsRemoteOk -HasLocalTrackingRef $hasLocalTrackingRef -ProtectedBranch $ProtectedBranch
        $originUrlForGh = (git remote get-url origin 2>$null)
        $prPlan = Resolve-OpenSyncPRAction `
            -RemoteHasProtectedBranch $hasProtected `
            -ProtectedBranch $ProtectedBranch `
            -OriginUrl $originUrlForGh
        if ($prPlan.Action -eq 'Skip') {
            Write-Warning "Cannot open PR: $($prPlan.Reason)"
            return 0
        }
        $ghRepoArgs = $prPlan.GhRepoArgs

        # Is there already an open PR for this branch?
        $existingPr = gh @ghRepoArgs pr list --head $SyncBranch --base $ProtectedBranch --state open --json url 2>$null | ConvertFrom-Json
        if ($existingPr -and $existingPr.Count -gt 0) {
            Write-Information "Existing PR updated: $($existingPr[0].url)"
            return 0
        }

        $title = "chore: sync IntelliSDLC.ai content"
        $bodyText = "Automated sync from upstream IntelliSDLC.ai. See commit log for replayed ops.`n`nGenerated by Pull-SDLC.ai.ps1 auto-worktree mode."
        $bodyFile = Join-Path $absWorktree '.sdlc-sync-pr-body.tmp'
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($bodyFile, $bodyText, $utf8NoBom)
        try {
            $prUrl = gh @ghRepoArgs pr create --base $ProtectedBranch --head $SyncBranch --title $title --body-file $bodyFile 2>&1 | Select-Object -Last 1
            if ($LASTEXITCODE -eq 0 -and $prUrl) {
                Write-Information "Opened PR: $prUrl"
            } else {
                Write-Warning "PR creation failed: $prUrl"
            }
        }
        finally { Remove-Item $bodyFile -ErrorAction SilentlyContinue }

        return 0
    }
    finally { Pop-Location }
}

function Test-ScriptHasUncommittedEdits {
    <#
    .SYNOPSIS
        Returns $true only when $ScriptPath is tracked by git AND has uncommitted
        working-tree modifications relative to HEAD (content edits, ignoring
        CR-at-EOL normalization). Returns $false for clean, untracked, or non-git
        files -- i.e. cases where a self-update overwrite cannot lose committed work.
    .DESCRIPTION
        Used to guard the self-update: overwriting an on-disk script that carries
        uncommitted local edits would destroy them irrecoverably (they exist in no
        commit). Clean files are recoverable from git, untracked files are fresh
        bootstrap downloads, and non-git files have no baseline to compare -- none
        of those should block the self-update.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$ScriptPath
    )
    $scriptDir = Split-Path -Parent $ScriptPath
    $leaf = Split-Path -Leaf $ScriptPath
    if ([string]::IsNullOrWhiteSpace($scriptDir)) { return $false }
    Push-Location $scriptDir
    try {
        # Must be inside a work tree with the file tracked; otherwise there is no
        # committed baseline that an overwrite could lose.
        $inWorkTree = (git rev-parse --is-inside-work-tree 2>$null)
        if ($inWorkTree -ne 'true') { return $false }
        & git ls-files --error-unmatch -- $leaf 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $false }
        # EOL-insensitive working-tree-vs-HEAD diff: exit 0 == clean, 1 == edited.
        & git diff --quiet --ignore-cr-at-eol HEAD -- $leaf 2>$null
        return ($LASTEXITCODE -ne 0)
    }
    catch { return $false }
    finally { Pop-Location -ErrorAction SilentlyContinue }
}

function Test-SelfRefreshRequired {
    <#
    .SYNOPSIS
        Decides whether Invoke-PullSDLC should attempt a network self-refresh
        of Pull-SDLC.ai.ps1 from upstream raw.githubusercontent.com.
    .DESCRIPTION
        Skips the refresh when any opt-out applies: -NoSelfUpdate parameter,
        $env:PULL_SDLC_NO_SELF_UPDATE, missing/empty ScriptPath, ScriptPath
        leaf is not 'Pull-SDLC.ai.ps1', running from inside .worktrees/sdlc-sync,
        running from the upstream IntelliSDLC.ai repo itself (so upstream
        developers and tests don't have their working copy clobbered), or the
        on-disk script has uncommitted local edits (so the self-update overwrite
        does not silently destroy un-saved work -- issue #202).
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyString()][AllowNull()][string]$ScriptPath,
        [switch]$NoSelfUpdate
    )
    if ($NoSelfUpdate) { return $false }
    if ($env:PULL_SDLC_NO_SELF_UPDATE) { return $false }
    if ([string]::IsNullOrWhiteSpace($ScriptPath)) { return $false }
    if (-not (Test-Path -LiteralPath $ScriptPath)) { return $false }
    if ((Split-Path -Leaf $ScriptPath) -ne 'Pull-SDLC.ai.ps1') { return $false }
    $normalized = ($ScriptPath -replace '\\', '/')
    if ($normalized -match '\.worktrees/sdlc-sync(/|$)') { return $false }
    # Never self-refresh when the script lives in the upstream repo itself.
    $scriptDir = Split-Path -Parent $ScriptPath
    if ($scriptDir) {
        $originUrl = $null
        try {
            Push-Location $scriptDir
            $originUrl = (git remote get-url origin 2>$null)
        } catch { }
        finally { Pop-Location -ErrorAction SilentlyContinue }
        if ($originUrl -and (Test-IsUpstreamRepo -RemoteUrl $originUrl)) { return $false }
    }
    # Protect uncommitted local edits from being clobbered by the overwrite.
    if (Test-ScriptHasUncommittedEdits -ScriptPath $ScriptPath) {
        Write-Warning "Self-update skipped: '$ScriptPath' has uncommitted local edits. Commit, stash, or revert them (or pass -NoSelfUpdate) to avoid losing work."
        return $false
    }
    return $true
}

function Invoke-SelfRefresh {
    <#
    .SYNOPSIS
        Fetches the upstream Pull-SDLC.ai.ps1 and, if its SHA256 differs from
        the local copy, overwrites the on-disk $ScriptPath in place with the new
        content so the user always runs the newest version. Returns the path to a
        backup copy of the ORIGINAL on-disk content (so the caller can restore it
        after a -WhatIf dry run); empty string when no update was applied.
    .DESCRIPTION
        The fetch is cache-busted on every call (per-invocation query parameter
        plus Cache-Control / Pragma no-cache headers) to defeat Fastly stale
        hits on raw.githubusercontent.com -- otherwise a refresh issued within
        the CDN's TTL of a fresh upstream merge would silently no-op against
        the previous body.

        The on-disk script is overwritten in place (issue #200) so a single
        invocation always runs the newest upstream version. Before overwriting,
        the original content is copied to a backup temp file; the caller restores
        it after a -WhatIf dry run (via Complete-SelfReExec) so dry runs leave no
        net change. A normal run keeps the new content on disk.

        Every outcome is logged on the Verbose stream so '-Verbose' makes
        "did the refresh run, and what did it see?" answerable from the
        output without grepping for a missing line.
    .OUTPUTS
        [string] Absolute path to a backup file holding the ORIGINAL on-disk
        content, when an update was applied (the on-disk script now holds the new
        upstream content). Empty string when hashes match, the fetch failed, or
        any error occurred.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string]$Url = 'https://raw.githubusercontent.com/IntelliTect-Samples/IntelliSDLC.ai/main/Pull-SDLC.ai.ps1',
        [int]$TimeoutSec = 15
    )
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pull-sdlc-self-" + [guid]::NewGuid().ToString('N') + ".ps1")
    # Cache-bust: query parameter forces a distinct cache key on most CDNs;
    # no-cache headers force revalidation when the CDN honors them.
    $separator = if ($Url.Contains('?')) { '&' } else { '?' }
    $cbUrl = "${Url}${separator}cb=$([DateTime]::UtcNow.Ticks)"
    $headers = @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' }
    try {
        Invoke-WebRequest -Uri $cbUrl -OutFile $tmp -TimeoutSec $TimeoutSec -UseBasicParsing -Headers $headers | Out-Null
    }
    catch {
        Write-Warning "Self-update check skipped: $($_.Exception.Message)"
        Write-Verbose "Self-refresh: skipped (fetch failed: $($_.Exception.Message))"
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false }
        return ''
    }
    try {
        $remoteHash = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash
        $localHash = (Get-FileHash -LiteralPath $ScriptPath -Algorithm SHA256).Hash
        if ($remoteHash -eq $localHash) {
            Write-Verbose "Self-refresh: up-to-date (sha256=$($localHash.Substring(0,7)))"
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false
            return ''
        }
        # Back up the original on-disk content so a -WhatIf dry run can restore it,
        # then overwrite the on-disk script with the new upstream content. Both
        # operations force -WhatIf:$false so a dry run still self-updates (and is
        # restored afterward) without emitting "What if:" noise.
        $backup = Join-Path ([System.IO.Path]::GetTempPath()) ("pull-sdlc-self-backup-" + [guid]::NewGuid().ToString('N') + ".ps1")
        Copy-Item -LiteralPath $ScriptPath -Destination $backup -Force -WhatIf:$false -Confirm:$false
        Move-Item -LiteralPath $tmp -Destination $ScriptPath -Force -WhatIf:$false -Confirm:$false
        Write-Information ("Self-updated Pull-SDLC.ai.ps1 from {0} to {1}; re-running with original args" -f $localHash.Substring(0, 7), $remoteHash.Substring(0, 7))
        Write-Verbose "Self-refresh: updated $($localHash.Substring(0,7)) -> $($remoteHash.Substring(0,7))"
        return $backup
    }
    catch {
        Write-Warning "Self-update check skipped: $($_.Exception.Message)"
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false }
        return ''
    }
}

function Complete-SelfReExec {
    <#
    .SYNOPSIS
        Finalizes a self-update re-exec: under a -WhatIf dry run, restores the
        original on-disk script from $BackupPath so the run leaves no net change;
        always removes the backup file. Separated from Invoke-SelfReExec (which
        calls `exit`) so the restore/cleanup logic is unit-testable.
    .DESCRIPTION
        A normal (non-dry-run) self-update keeps the new upstream content on disk
        (the desired self-overwrite). A -WhatIf dry run restores the original so
        the working tree is left exactly as found. The backup temp file is removed
        in both cases. A no-op when no backup path is supplied.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string]$BackupPath,
        [switch]$RestoreOriginal
    )
    if (-not $BackupPath) { return }
    if (-not (Test-Path -LiteralPath $BackupPath)) { return }
    if ($RestoreOriginal) {
        Copy-Item -LiteralPath $BackupPath -Destination $ScriptPath -Force -WhatIf:$false -Confirm:$false
    }
    Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false
}

function Invoke-SelfReExec {
    <#
    .SYNOPSIS
        Re-invokes the freshly self-updated on-disk Pull-SDLC.ai.ps1 with the
        caller's original bound parameters, force-adding -NoSelfUpdate to prevent
        loops. Under a -WhatIf dry run (-RestoreOriginal), restores the original
        on-disk content from -BackupPath after the child exits so the dry run is
        side-effect-free. Exits the host process with the child's exit code.
    .DESCRIPTION
        $ScriptPath is the on-disk script, already overwritten with the new
        upstream content by Invoke-SelfRefresh. $BackupPath holds the original
        content; it is restored only when -RestoreOriginal is set and is always
        removed afterward (see Complete-SelfReExec).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [hashtable]$BoundParameters = @{},
        [string]$BackupPath,
        [switch]$RestoreOriginal
    )
    $reArgs = @{} + $BoundParameters
    $reArgs['NoSelfUpdate'] = $true
    try {
        & $ScriptPath @reArgs
        $childExit = $LASTEXITCODE
    }
    finally {
        Complete-SelfReExec -ScriptPath $ScriptPath -BackupPath $BackupPath -RestoreOriginal:$RestoreOriginal
    }
    exit $childExit
}

function Write-NextStepsBanner {
    <#
    .SYNOPSIS
        Print "Next steps" guidance after a successful from-zero
        bootstrap so the user is not left at a dirty working tree
        wondering what to do next. Issue #149.
    .DESCRIPTION
        Only printed when the run was an actual bootstrap (anchor
        Source = 'bootstrap' or 'auto-bootstrap'). Lists the most
        valuable consumer file to edit first, the commit incantation,
        and -- when no `origin` is configured -- the `gh repo create`
        hint for brand-new projects.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
        Justification = 'Decorative interactive "Next steps" banner -- sanctioned host UX per powershell.instructions.md Output & Streams.')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][AllowEmptyString()][string]$AnchorSource,
        [string[]]$ScaffoldedFiles = @()
    )
    if ($AnchorSource -notin @('bootstrap', 'auto-bootstrap')) { return }

    Push-Location $RepoRoot
    try {
        $originUrl = git remote get-url origin 2>$null
    }
    finally { Pop-Location }

    Write-Host ''
    Write-Host 'Next steps:' -ForegroundColor Cyan
    $primary = '.github/instructions/project.instructions.md'
    if ($ScaffoldedFiles -contains $primary) {
        Write-Host "  1. Start with $primary -- fill in the project-specific" -ForegroundColor Cyan
        Write-Host '     architecture, tech stack, and conventions sections.' -ForegroundColor Cyan
    }
    else {
        Write-Host '  1. Review the scaffolded consumer-owned files listed above.' -ForegroundColor Cyan
    }
    Write-Host '  2. Commit the scaffolded files and the bootstrap script:' -ForegroundColor Cyan
    Write-Host '       git add .' -ForegroundColor Cyan
    Write-Host '       git commit -m "chore: scaffold IntelliSDLC.ai consumer files"' -ForegroundColor Cyan
    if (-not $originUrl) {
        Write-Host '  3. If this is a brand-new project with no remote yet, create it on GitHub:' -ForegroundColor Cyan
        Write-Host '       gh repo create --source=. --public --push' -ForegroundColor Cyan
    }
}

function Invoke-SelfRefreshGate {
    <#
    .SYNOPSIS
        Top-level self-refresh check for Pull-SDLC.ai.ps1. If an upstream
        update is available and successfully applied, re-execs the script
        with the supplied bound parameters and never returns.
    .DESCRIPTION
        Must be called from the script's top level (NOT from inside
        Invoke-PullSDLC). The `$BoundParameters` argument must be the
        script's outer `$PSBoundParameters` so every key is, by
        definition, bindable to the freshly-downloaded script on re-exec.

        See issue #110: invoking this from inside Invoke-PullSDLC caused
        function-only parameters such as `RemoteUrl` to leak into the
        splat, breaking re-exec on the outer script (which has no
        `RemoteUrl` parameter).
    .OUTPUTS
        [bool] $true if a re-exec was attempted (in production this path
        never returns; mocks may return synchronously). $false if no
        update was needed or the refresh failed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$ScriptPath,
        [hashtable]$BoundParameters = @{},
        [switch]$NoSelfUpdate
    )
    if (Test-SelfRefreshRequired -ScriptPath $ScriptPath -NoSelfUpdate:$NoSelfUpdate) {
        # Invoke-SelfRefresh overwrites the on-disk script in place and returns a
        # backup of the original. Re-exec the (now-updated) on-disk script; under
        # a -WhatIf dry run, restore the original afterward so the run leaves no
        # net change.
        $backupPath = Invoke-SelfRefresh -ScriptPath $ScriptPath
        if ($backupPath) {
            $restore = [bool]($BoundParameters.ContainsKey('WhatIf') -and $BoundParameters['WhatIf'])
            Invoke-SelfReExec -ScriptPath $ScriptPath -BoundParameters $BoundParameters -BackupPath $backupPath -RestoreOriginal:$restore
            return $true
        }
    }
    return $false
}

function Test-IsCiEnvironment {
    <#
    .SYNOPSIS
        Returns $true when the host is a CI runner (CI, GITHUB_ACTIONS, TF_BUILD).
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param()
    return [bool]($env:CI -or $env:GITHUB_ACTIONS -or $env:TF_BUILD)
}

function Get-GitHubSshKeyPath {
    <#
    .SYNOPSIS
        Returns the canonical path to the user's GitHub ed25519 private key.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    return (Join-Path $HOME '.ssh/id_ed25519')
}

function Test-GitHubSshAgentRunning {
    <#
    .SYNOPSIS
        Returns $true when the Windows ssh-agent service is in the Running state.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param()
    try {
        $svc = Get-Service -Name ssh-agent -ErrorAction Stop
        return ($svc.Status -eq 'Running')
    }
    catch {
        return $false
    }
}

function Test-GhInstalled {
    <#
    .SYNOPSIS
        Returns $true when the gh CLI is available on PATH.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param()
    return [bool](Get-Command gh -ErrorAction SilentlyContinue)
}

function Get-GitConfigAllValues {
    <#
    .SYNOPSIS
        Returns all values for a multi-valued global git config key. Empty
        array when the key is unset. Wrapped as a helper so tests can mock it.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string]$Key)
    $vals = & git config --global --get-all $Key 2>$null
    if ($null -eq $vals) { return @() }
    return @($vals | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}

function Get-GhGitProtocol {
    <#
    .SYNOPSIS
        Returns the value of `gh config get git_protocol`, or '' on failure.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    try {
        $val = (& gh config get git_protocol 2>$null)
        if ($null -eq $val) { return '' }
        return "$val".Trim()
    }
    catch { return '' }
}

function Add-GitConfigValueIfMissing {
    <#
    .SYNOPSIS
        Idempotently `git config --global --add $Key $Value` -- only adds when
        the value is not already present. Returns $true when an add happened,
        $false when the value already existed.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
        Justification = 'Decorative [skip]/[add] setup transcript -- sanctioned host UX per powershell.instructions.md Output & Streams.')]
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Value
    )
    $current = @(Get-GitConfigAllValues -Key $Key)
    if ($current -contains $Value) {
        Write-Host "  [skip] $Key already contains '$Value'" -ForegroundColor DarkGray
        return $false
    }
    if ($PSCmdlet.ShouldProcess("$Key += '$Value'", 'git config --global --add')) {
        & git config --global --add $Key $Value
        Write-Host "  [add]  $Key += '$Value'" -ForegroundColor Green
    }
    return $true
}

function Invoke-SetupGitHubSsh {
    <#
    .SYNOPSIS
        Idempotently configures the local Windows workstation for
        GitHub-over-SSH-on-443: ed25519 keypair, ssh-agent service,
        three url.insteadOf rewrites, gh git_protocol = ssh, and (unless
        -SkipKeyUpload) uploads the public key to GitHub via gh.

        Safe to re-run. Every step prints `[skip]` when already configured
        and `[add]` / `[del]` when it changed something. Removes the legacy
        `url.git@ssh.github.com:.pushInsteadOf=https://github.com/` entry
        if present (superseded by the symmetric insteadOf pair).

        Non-admin shells cannot set ssh-agent startup to Automatic; the
        function warns and continues. Linux/macOS hosts print a notice
        and exit early (out of scope; issue #164).
    .PARAMETER SkipKeyUpload
        Do not call `gh ssh-key add`. Useful when the key is already
        registered out-of-band, or for CI/test scenarios.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
        Justification = 'Decorative [skip]/[add]/[warn] setup transcript -- sanctioned host UX per powershell.instructions.md Output & Streams.')]
    [CmdletBinding(SupportsShouldProcess)]
    param([switch]$SkipKeyUpload)

    if (-not $IsWindows) {
        Write-Warning 'Invoke-SetupGitHubSsh: non-Windows host -- out of scope (issue #164). Skipping.'
        return
    }

    Write-Host 'GitHub SSH-on-443 setup:' -ForegroundColor Cyan

    # 1. SSH keypair
    $keyPath = Get-GitHubSshKeyPath
    if (Test-Path -LiteralPath $keyPath) {
        Write-Host "  [skip] SSH keypair already exists at $keyPath" -ForegroundColor DarkGray
    }
    else {
        $sshDir = Split-Path -Parent $keyPath
        if (-not (Test-Path -LiteralPath $sshDir)) {
            New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
        }
        if ($PSCmdlet.ShouldProcess($keyPath, 'ssh-keygen -t ed25519')) {
            & ssh-keygen -t ed25519 -f $keyPath -N '' -C "$env:USERNAME@$env:COMPUTERNAME" -q
            Write-Host "  [add]  Generated ed25519 keypair at $keyPath" -ForegroundColor Green
        }
    }

    # 2. ssh-agent service
    $svc = Get-Service -Name ssh-agent -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host '  [warn] ssh-agent service not found. Install the OpenSSH Client optional feature and re-run.' -ForegroundColor Yellow
    }
    else {
        if ($svc.StartType -ne 'Automatic') {
            try {
                if ($PSCmdlet.ShouldProcess('ssh-agent', 'Set-Service -StartupType Automatic')) {
                    Set-Service -Name ssh-agent -StartupType Automatic -ErrorAction Stop
                    Write-Host '  [add]  Set ssh-agent startup to Automatic' -ForegroundColor Green
                }
            }
            catch {
                Write-Host '  [warn] Could not set ssh-agent startup to Automatic (requires admin shell). Continuing.' -ForegroundColor Yellow
            }
        }
        else {
            Write-Host '  [skip] ssh-agent startup already Automatic' -ForegroundColor DarkGray
        }
        if ($svc.Status -ne 'Running') {
            try {
                if ($PSCmdlet.ShouldProcess('ssh-agent', 'Start-Service')) {
                    Start-Service -Name ssh-agent -ErrorAction Stop
                    Write-Host '  [add]  Started ssh-agent service' -ForegroundColor Green
                }
            }
            catch {
                Write-Host '  [warn] Could not start ssh-agent service. Continuing.' -ForegroundColor Yellow
            }
        }
        else {
            Write-Host '  [skip] ssh-agent service already Running' -ForegroundColor DarkGray
        }
        if ((Test-Path -LiteralPath $keyPath) -and (Get-Command ssh-add -ErrorAction SilentlyContinue)) {
            & ssh-add $keyPath 2>&1 | Out-Null
        }
    }

    # 3. Git insteadOf rewrites (multi-valued, idempotent)
    Add-GitConfigValueIfMissing -Key 'url.git@ssh.github.com:.insteadOf' -Value 'https://github.com/' | Out-Null
    Add-GitConfigValueIfMissing -Key 'url.git@ssh.github.com:.insteadOf' -Value 'git@github.com:' | Out-Null
    Add-GitConfigValueIfMissing -Key 'url.ssh://git@ssh.github.com:443/.insteadOf' -Value 'ssh://git@github.com/' | Out-Null

    # 4. Remove legacy pushInsteadOf (superseded by symmetric insteadOf pair)
    $legacyKey = 'url.git@ssh.github.com:.pushInsteadOf'
    $legacy = @(Get-GitConfigAllValues -Key $legacyKey)
    if ($legacy -contains 'https://github.com/') {
        if ($PSCmdlet.ShouldProcess($legacyKey, 'git config --global --unset-all')) {
            & git config --global --unset-all $legacyKey 2>$null
            Write-Host "  [del]  Removed legacy $legacyKey" -ForegroundColor Green
        }
    }

    # 5. gh git_protocol
    if (-not (Test-GhInstalled)) {
        Write-Host '  [warn] gh CLI not installed. Install from https://cli.github.com/ then re-run -SetupGitHubSsh.' -ForegroundColor Yellow
        return
    }
    if ((Get-GhGitProtocol) -ne 'ssh') {
        if ($PSCmdlet.ShouldProcess('gh git_protocol', 'gh config set git_protocol ssh')) {
            & gh config set git_protocol ssh
            Write-Host '  [add]  Set gh git_protocol to ssh' -ForegroundColor Green
        }
    }
    else {
        Write-Host '  [skip] gh git_protocol already ssh' -ForegroundColor DarkGray
    }

    # 6. Upload public key to GitHub
    if ($SkipKeyUpload) {
        Write-Host '  [skip] gh ssh-key add (--SkipKeyUpload)' -ForegroundColor DarkGray
        return
    }
    $pubPath = "$keyPath.pub"
    if (-not (Test-Path -LiteralPath $pubPath)) {
        Write-Host "  [warn] Public key $pubPath not found; cannot upload to GitHub." -ForegroundColor Yellow
        return
    }
    $pubText = (Get-Content -LiteralPath $pubPath -Raw).Trim()
    $remoteKeys = & gh ssh-key list 2>$null
    $alreadyUploaded = $false
    if ($remoteKeys) {
        # gh ssh-key list output contains the base64 body of each key.
        $body = ($pubText -split '\s+')[1]
        if ($body -and ("$remoteKeys" -match [regex]::Escape($body.Substring(0, [Math]::Min(40, $body.Length))))) {
            $alreadyUploaded = $true
        }
    }
    if ($alreadyUploaded) {
        Write-Host '  [skip] SSH public key already registered on GitHub' -ForegroundColor DarkGray
    }
    else {
        $title = "$env:COMPUTERNAME ($env:USERNAME)"
        if ($PSCmdlet.ShouldProcess($pubPath, "gh ssh-key add --title '$title'")) {
            & gh ssh-key add $pubPath --title $title
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [add]  Uploaded SSH public key to GitHub (title: $title)" -ForegroundColor Green
            }
            else {
                Write-Host '  [warn] gh ssh-key add failed (auth?). Upload manually if needed.' -ForegroundColor Yellow
            }
        }
    }
}

function Write-PlannedOpsPreview {
    <#
    .SYNOPSIS
        Renders the decorative "Files to update" dry-run preview (header,
        per-op-kind counts, and word-coded op rows) to the host.
    .DESCRIPTION
        This is the sanctioned `Write-Host` exception from the "Output &
        Streams" guidance: an intentional, colorized, interactive console
        preview that is never meant to be captured as pipeline data. Keeping
        it in a dedicated helper lets the PSAvoidUsingWriteHost suppression
        stay narrowly scoped to the preview instead of the whole sync engine.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
        Justification = 'Decorative colorized dry-run preview -- sanctioned host UX per powershell.instructions.md Output & Streams.')]
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Ops,
        [Parameter(Mandatory)][string]$AnchorLabel,
        [Parameter(Mandatory)][string]$UpstreamLabel
    )
    Write-Host ''
    if ($Ops.Count -eq 0) {
        Write-Host "Files to update: 0 (already at upstream $UpstreamLabel -- nothing to sync)" -ForegroundColor Cyan
    }
    else {
        Write-Host "Files to update: $($Ops.Count) (syncing $AnchorLabel -> $UpstreamLabel)" -ForegroundColor Cyan
    }
    $grouped = $Ops | Group-Object { $_.Op } | Sort-Object Name
    foreach ($g in $grouped) {
        Write-Host ("  {0}: {1}" -f $g.Name, $g.Count) -ForegroundColor Cyan
    }
    foreach ($op in $Ops) {
        $word = switch -Regex ($op.Op) {
            '^A$' { 'add' ; break }
            '^M$' { 'update' ; break }
            '^D$' { 'delete' ; break }
            '^R'  { 'rename' ; break }
            '^C'  { 'copy' ; break }
            default { $op.Op }
        }
        $col = $word.PadRight(8)
        $label = if ($op.Op -like 'R*' -or $op.Op -like 'C*') {
            "{0}{1} -> {2}" -f $col, $op.OldPath, $op.Path
        }
        else {
            "{0}{1}" -f $col, $op.Path
        }
        Write-Host "    $label" -ForegroundColor DarkGray
    }
}

function Invoke-PullSDLC {
    <#
    .SYNOPSIS
        Runs the full sync (fetch -> drift guard -> compute ops -> apply ->
        commit). Returns nothing; throws on hard errors. Honors -WhatIf.
    .OUTPUTS
        An integer status code: 0 = success, 1 = bootstrap declined,
        2 = drift detected without -Force.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string]$Branch = 'main',
        [string]$RemoteName = 'sdlc.ai',
        [string]$RemoteUrl = 'https://github.com/IntelliTect-Samples/IntelliSDLC.ai.git',
        [string]$RepoRoot,
        [switch]$Force,
        [switch]$Bootstrap,
        [switch]$NoPrompt,
        [switch]$NoFetch,
        [switch]$NoAutoInit,
        [switch]$CommitOnMain,
        [switch]$NoAutoWorktree,
        [switch]$NoAutoPR,
        [switch]$NoSelfUpdate
    )

    if (-not $RepoRoot) {
        $topLevel = git rev-parse --show-toplevel 2>$null
        if (-not $topLevel) {
            if ($NoAutoInit) {
                Write-Error 'ERROR: not inside a git repository and -NoAutoInit specified. Run `git init` first or omit -NoAutoInit.' -ErrorAction Continue
                return 5
            }
            Write-Information "[Bootstrap] No git repository detected. Running 'git init -b $Branch' in the current directory..."
            git init -b $Branch | Out-Null
            $topLevel = git rev-parse --show-toplevel 2>$null
            if (-not $topLevel) {
                Write-Error 'ERROR: git init failed; cannot continue.' -ErrorAction Continue
                return 5
            }
        }
        $RepoRoot = $topLevel.Trim()
    }

    # Determine the effective -CommitOnMain setting.
    # Explicit -CommitOnMain (or -CommitOnMain:$false) always wins.
    # Otherwise default is on for first-time bootstrap, off in steady state.
    if ($PSBoundParameters.ContainsKey('CommitOnMain')) {
        $commitOnMainEffective = [bool]$CommitOnMain
    }
    else {
        $commitOnMainEffective = Test-IsBootstrapSync -RepoRoot $RepoRoot
    }

    if (-not $commitOnMainEffective -and -not $WhatIfPreference) {
        $ctx = Test-CommitContextAllowed -RepoRoot $RepoRoot -ProtectedBranch $Branch
        if (-not $ctx.Allowed) {
            if ($NoAutoWorktree) {
                Write-Error "ABORT: cannot create sync commit -- $($ctx.Reason)." -ErrorAction Continue
                Write-Information ''
                Write-Information 'Create a worktree first:'
                Write-Information '  git worktree add .worktrees/sdlc-sync -b chore/sdlc-sync main'
                Write-Information '  cd .worktrees/sdlc-sync'
                Write-Information '  ../../Pull-SDLC.ai.ps1'
                Write-Information ''
                Write-Information 'Or rerun with -CommitOnMain to commit the sync directly on the protected branch.'
                Write-Information 'Use -WhatIf to preview ops without committing.'
                return 3
            }

            Write-Information "On protected branch '$($ctx.Branch)'. Switching to auto-worktree workflow ..."
            $syncArgs = @{
                Branch         = $Branch
                RemoteName     = $RemoteName
                Force          = [bool]$Force
                Bootstrap      = [bool]$Bootstrap
                NoPrompt       = [bool]$NoPrompt
                NoFetch        = [bool]$NoFetch
                NoAutoWorktree = $true
            }
            $rc = Invoke-AutoWorktreeSync -RepoRoot $RepoRoot -ProtectedBranch $Branch -NoAutoPR:$NoAutoPR -SyncArgs $syncArgs
            if ($rc -eq 0) {
                # After a successful worktree sync, clean up the parent tree:
                # delete untracked-and-identical bootstrap files (PR merge will
                # restore them tracked), revert tracked-modified-to-identical
                # files, leave real local edits alone with a warning.
                $null = Invoke-MainTreeCleanup -RepoRoot $RepoRoot -UpstreamRef "$RemoteName/$Branch"
            }
            return $rc
        }
    }

    Push-Location $RepoRoot
    try {
        $existingUrl = git remote get-url $RemoteName 2>$null
        if (-not $existingUrl) {
            Write-Information "Adding remote '$RemoteName' -> $RemoteUrl"
            git remote add $RemoteName $RemoteUrl
        }
        if (-not $NoFetch) {
            Write-Information "Fetching $RemoteName ..."
            git fetch $RemoteName --quiet
        }
    }
    finally { Pop-Location }

    $mergeRef = "$RemoteName/$Branch"

    $anchorInfo = Resolve-SyncAnchor -RepoRoot $RepoRoot -Bootstrap:$Bootstrap -NoPrompt:$NoPrompt
    if ($null -eq $anchorInfo) {
        Write-Warning 'Bootstrap declined. Nothing to do.'
        return 1
    }
    $anchorSha = $anchorInfo.Sha

    if ($anchorSha) {
        $drift = @(Test-LocalDriftOnManagedPaths -Anchor $anchorSha -ManagedPaths $script:UpstreamManagedPaths -UpstreamRef $mergeRef -RepoRoot $RepoRoot)
        if ($drift.Count -gt 0) {
            if (-not $Force) {
                $violation = New-Object System.Text.StringBuilder
                [void]$violation.AppendLine('POLICY VIOLATION: upstream-managed files have local edits since last sync.')
                foreach ($d in $drift) {
                    [void]$violation.AppendLine("  - $($d.Path)   (introduced by: $($d.Commit))")
                }
                [void]$violation.Append('Rerun with -Force to overwrite these with upstream contents, or revert the edits.')
                Write-Error $violation.ToString() -ErrorAction Continue
                return 2
            }
            else {
                Write-Warning '-Force in effect. The following local edits to upstream-managed files will be OVERWRITTEN:'
                foreach ($d in $drift) {
                    Write-Warning "  - $($d.Path)   (was: $($d.Commit))"
                }
            }
        }
    }

    $ops = @(Get-UpstreamOps -Anchor $anchorSha -Ref $mergeRef -ManagedPaths $script:UpstreamManagedPaths -RepoRoot $RepoRoot)

    # Reconcile managed files whose HEAD content diverged from the upstream tip
    # without being a genuine local edit -- e.g. a self-update or a mis-recorded
    # anchor left HEAD out of step with the recorded anchor. The anchor->tip diff
    # above misses any such file that did not change between the anchor and the
    # tip, so add an explicit HEAD->tip op to bring it current. In the normal case
    # (HEAD == anchor) these ops duplicate the anchor->tip set and are dropped.
    # Genuine local edits only reach here under -Force (otherwise the drift gate
    # already returned), where overwriting is the intended behavior.
    if ($anchorSha) {
        $reconcileOps = @(Get-UpstreamOps -Anchor 'HEAD' -Ref $mergeRef -ManagedPaths $script:UpstreamManagedPaths -RepoRoot $RepoRoot)
        if ($reconcileOps.Count -gt 0) {
            $covered = @{}
            foreach ($o in $ops) {
                $covered[$o.Path] = $true
                if ($o.OldPath) { $covered[$o.OldPath] = $true }
            }
            foreach ($r in $reconcileOps) {
                if ($covered.ContainsKey($r.Path)) { continue }
                if ($r.OldPath -and $covered.ContainsKey($r.OldPath)) { continue }
                $ops += $r
            }
        }
    }

    Push-Location $RepoRoot
    try { $upstreamHead = (git rev-parse $mergeRef).Trim() }
    finally { Pop-Location }

    $anchorLabel = if ($anchorSha) { $anchorSha.Substring(0, 7) } else { '(empty tree)' }
    $upstreamLabel = $upstreamHead.Substring(0, 7)
    Write-PlannedOpsPreview -Ops $ops -AnchorLabel $anchorLabel -UpstreamLabel $upstreamLabel

    if ($WhatIfPreference) {
        Write-Information ''
        Write-Information '-WhatIf specified; no changes written.'
        return 0
    }

    if ($ops.Count -eq 0) {
        Write-Information ''
        Write-Information 'Already up to date.'
    }
    else {
        foreach ($op in $ops) {
            Invoke-UpstreamOp -Op $op -Ref $mergeRef -RepoRoot $RepoRoot
        }
        Write-Information "Applied $($ops.Count) ops."
    }

    # Union-merge merge-managed files (today: .gitignore). Done after the
    # main op loop so the merge always sees the latest upstream blob. The
    # merge is idempotent -- a no-op when local already contains every
    # upstream entry.
    $mergedPaths = New-Object System.Collections.Generic.List[string]
    foreach ($mp in $script:MergePaths) {
        if (Merge-FileFromUpstream -Path $mp -Ref $mergeRef -RepoRoot $RepoRoot) {
            $mergedPaths.Add($mp) | Out-Null
            Write-Information "Merged upstream entries into $mp"
        }
    }

    Set-SdlcSyncState -RepoRoot $RepoRoot -Remote $RemoteName -Ref $Branch -Commit $upstreamHead

    Push-Location $RepoRoot
    try {
        # Only include pathspecs that actually exist in the working tree --
        # `git add` aborts the entire operation on a missing pathspec. We add
        # both upstream-managed paths and any merge-managed file we touched.
        $addPaths = @()
        foreach ($p in @($script:UpstreamManagedPaths + $script:SdlcSyncStateFile + $mergedPaths.ToArray())) {
            if (Test-Path -LiteralPath $p) { $addPaths += $p }
        }
        if ($addPaths.Count -gt 0) {
            $addArgs = @('add', '-A', '--') + $addPaths
            & git @addArgs | Out-Null
        }
        $pending = git status --porcelain
        if ($pending) {
            $msg = "chore: sync IntelliSDLC.ai to $($upstreamHead.Substring(0,7))`n`nReplayed $($ops.Count) ops from upstream $mergeRef.`n`nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
            $headBefore = (git rev-parse HEAD 2>$null).Trim()
            git commit -m $msg | Out-Null
            $headAfter = (git rev-parse HEAD 2>$null).Trim()
            if ($headBefore -eq $headAfter) {
                Write-Error 'ERROR: git commit did not advance HEAD. The commit was likely blocked by a pre-commit hook or branch protection.' -ErrorAction Continue
                Write-Warning 'Working tree changes have been left in place for inspection. Resolve the policy violation and rerun.'
                return 4
            }
            Write-Information "Created sync commit: $(git rev-parse --short HEAD)"
        }
        else {
            Write-Information 'Nothing to commit.'
        }
    }
    finally { Pop-Location }

    # Scaffold consumer-owned files from templates (first sync only).
    $scaffolded = @()
    # Scope the upstream-repo detection to $RepoRoot rather than the shell's
    # CWD; otherwise tests (and any caller invoked from inside the upstream
    # repo) misclassify a consumer fixture as the upstream repo and skip
    # scaffolding.
    $originUrl = (& git -C $RepoRoot remote get-url origin 2>$null)
    if (Test-IsUpstreamRepo -RemoteUrl $originUrl) {
        Write-Information "Detected upstream repo (origin -> IntelliSDLC.ai). Skipping template scaffolding."
    }
    else {
        $scaffolded = @(Invoke-TemplateScaffold -SourceRoot $RepoRoot -TargetRoot $RepoRoot -ScaffoldMap $script:TemplateScaffoldMap -Ref $mergeRef)
        if ($scaffolded.Count -gt 0) {
            Write-Information 'Scaffolded consumer-owned files from templates:'
            foreach ($f in $scaffolded) { Write-Information "  + $f" }
            Write-Information 'Open each file and fill in the sections, then commit them to your repo.'
        }
    }

    Write-NextStepsBanner -RepoRoot $RepoRoot -AnchorSource $anchorInfo.Source -ScaffoldedFiles $scaffolded

    return 0
}

# Skip the rest of the script when dot-sourced (e.g. by tests).
if ($MyInvocation.InvocationName -eq '.') { return }

# Setup mode: configure GitHub SSH-on-443 and exit (issue #164).
if ($SetupGitHubSsh) {
    Invoke-SetupGitHubSsh -SkipKeyUpload:$SkipKeyUpload
    exit 0
}

# Self-refresh check at script top level (issue #110). `$PSBoundParameters`
# here is the script's outer bound params, so every key is guaranteed to be
# bindable to the freshly-downloaded script on re-exec.
if (Invoke-SelfRefreshGate -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -NoSelfUpdate:$NoSelfUpdate) {
    exit $LASTEXITCODE
}

$invokeArgs = @{
    Branch         = $Branch
    RemoteName     = $RemoteName
    RemoteUrl      = $RemoteUrl
    Force          = [bool]$Force
    Bootstrap      = [bool]$Bootstrap
    NoPrompt       = [bool]$NoPrompt
    NoAutoInit     = [bool]$NoAutoInit
    NoAutoWorktree = [bool]$NoAutoWorktree
    NoAutoPR       = [bool]$NoAutoPR
    NoSelfUpdate   = [bool]$NoSelfUpdate
    WhatIf         = [bool]$WhatIfPreference
}
# Only forward -CommitOnMain when the user explicitly passed it, so
# Invoke-PullSDLC's $PSBoundParameters.ContainsKey check accurately
# reflects user intent vs. state-driven default.
if ($PSBoundParameters.ContainsKey('CommitOnMain')) {
    $invokeArgs.CommitOnMain = [bool]$CommitOnMain
}
$exitCode = Invoke-PullSDLC @invokeArgs

exit $exitCode