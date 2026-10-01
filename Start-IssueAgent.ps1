<#
.SYNOPSIS
    Dispatches a GitHub issue to an interactive `claude` CLI session, or opens
    one to plan a brand-new issue.

.DESCRIPTION
    Two modes, one launcher:

      - `-IssueNumber <n>` (the default, positional): work an issue that
        already exists. Prompt: `@dev-loop gh issue <n>: <issue title>`,
        plus any trailing -Context, permission mode `auto`.
      - `-New <description>`: there is no issue yet. Prompt: `@plan
        <description>` plus an explicit two-step instruction -- create the
        GitHub issue via `@plan`, then implement it via `@dev-loop gh issue
        <number>` -- so -New lands in the same place as issue dispatch, one
        step earlier. Permission mode `plan`, whose approval prompt is the
        design gate before the session starts filing issues and writing code.
        No `gh` call is made by this script -- `@plan`
        (.github/agents/plan.agent.md) runs its own discovery dialogue,
        resolves the repo itself, and files the issue. One best-effort
        `git remote get-url origin` *is* made, solely to name the repository
        in the launch message; it neither requires `git` nor fails without
        it (see Get-GitOriginUrl).

    Where the session lands depends on the current shell (identical in both
    modes):

      - Already inside a Windows Terminal pane (checked via $env:WT_SESSION,
        which Windows Terminal sets on every process it hosts) and neither
        -NewTab nor an enclosing Claude Code session applies: run `claude`
        directly in the current pane (no new window/tab) -- the default for
        a human typing the command in their own shell.
      - -NewTab given, or the current process is itself running inside a
        Claude Code session (checked via $env:CLAUDECODE, set for both the
        `Bash` tool and the interactive `!` command), or not currently
        inside Windows Terminal at all: open a new `wt.exe` tab (or, if
        `wt.exe` isn't on PATH, a plain new console window). This keeps a
        Claude Code session from ever hijacking its own pane -- whether
        dispatched via its Bash tool or a user's `!Start-IssueAgent.ps1 ...`.

    Steps (the `-IssueNumber` path; `-New` skips 1-2 entirely):

      1. Resolve owner/repo from `git remote get-url origin` (never from the
         local directory name -- see CLAUDE.md), anchored on the **caller's
         current directory**: the launch directory is resolved first (step 5)
         and the slug is then read from *there*, so the issue and the session
         can never name two different repositories. This script's own
         checkout is used only when the current directory is not inside a
         repository at all.
      2. `gh issue view <IssueNumber> --json number,title` to fetch just
         enough to name the session (@dev-loop itself already fetches the
         full issue -- title, body, comments -- when given an issue number,
         per .github/agents/dev-loop.agent.md Phase 0, so this script does
         not duplicate that).
      3. Derive a session Name -- `<issue ID>: <Issue Title>`, or `new:
         <description>` under -New -- capped to 3/4 of the current console
         width (a long issue title/description would otherwise overflow the
         tab title/prompt box/resume picker), and pass it to `claude --name`
         (which also sets the terminal/tab title).
      4. Build the prompt: `@dev-loop gh issue <IssueNumber>: <Issue Title>`
         (plus any trailing -Context, below a blank line), telling the
         session to run the full dev loop starting from the existing issue
         -- no issue creation step needed; or, under -New, `@plan
         <description>` followed by the two ordered steps (create the issue,
         then `@dev-loop gh issue <number>` on it), so the session runs
         design *and* implementation instead of stopping at the design.
         The -New prompt also closes by asking the session to print a
         ready-to-paste `/rename <number>: <issue title>` line once the
         issue exists -- the `new: <description>` name is stale from that
         moment on, and only a user-typed slash command can change it (see
         New-PlanAgentPrompt for why the session cannot do it itself).
      5. Launch `claude` with CLI options first, the derived prompt last:
         `claude --name <Name> --remote-control --permission-mode <mode> -- <prompt>`
         When opening a new wt.exe tab, this command (plus a `Set-Location`
         to the working directory) is handed to a nested `pwsh
         -EncodedCommand` (base64) rather than passed as wt.exe/pwsh
         command-line arguments -- see New-EncodedClaudeCommand for why that
         matters specifically for `wt.exe`.

    The session is left to create its own git worktree/branch as part of the
    dev loop (@dev-loop) -- this script does not pre-create one. It does start
    the session in the **main worktree root of the repository the caller is
    standing in** -- not in the current tree, because a session started inside
    a linked worktree would create its own worktree nested inside that one,
    and not in whichever tree this script file happens to sit in, because a
    copy of this launcher exists in every linked worktree and in every
    consuming project. Falls back to this script's own checkout only when the
    current directory is outside any repository. See Resolve-GitCommonDir and
    Get-LaunchDirectory.

.PARAMETER IssueNumber
    The GitHub issue number to dispatch. Required for the default parameter
    set (not marked Mandatory on the parameter itself so this script can be
    dot-sourced for testing; validated at the start of Main instead).
    Mutually exclusive with -New.

.PARAMETER New
    Plan *and implement* a brand-new issue instead of dispatching an existing
    one. The value is a plain-English description of the idea, used to seed
    `@plan` -- a seed, not a spec: @plan asks its own clarifying questions
    from there. The session is then told, in the same prompt, to hand the
    issue it just created to `@dev-loop`, so -New ends where issue dispatch
    ends rather than at an unfiled design. Mutually exclusive with
    -IssueNumber.

    Pass `-New ''` for a seedless session (a bare `@plan` seed; the two
    create-then-implement steps still apply, and @plan opens the conversation
    itself). A bare valueless `-New` is a PowerShell binding error, since
    -New takes a string.

    A multi-line description needs no special form -- a here-string carries
    it natively:

        ./Start-IssueAgent.ps1 -New @'
        ...multi-line description...
        '@

.PARAMETER Context
    Optional free-text context for the session, positional and **last**, so
    the common case stays `./Start-IssueAgent.ps1 900`:

        ./Start-IssueAgent.ps1 900 "Focus on the retry path; the upload
        succeeds but the poll never terminates."

    It is appended to the prompt below the `@dev-loop` line -- context, not a
    spec: the issue itself remains the source of truth, so nothing here
    overrides it. It does **not** affect the session name, which stays
    `<issue number>: <issue title>`.

    Multi-line context needs no special form -- a PowerShell here-string
    (`@'...'@`) carries it natively.

    Issue dispatch only. Under -New the description passed to -New is already
    the free-text seed, and a second free-text value there would be two seeds
    with no rule for combining them.

.PARAMETER Repo
    Explicit `owner/repo` to pass to `gh issue view --repo`. If omitted, it is
    resolved from `git remote get-url origin` in the repository the **current
    directory** belongs to -- the same one the session is launched into. Under
    -New no issue is fetched, so -Repo there only labels the launch message.

    A -Repo that disagrees with the current directory is accepted without a
    prompt or a refusal: the issue comes from -Repo, the session still starts
    in the current repository, and the launch message prints both so the split
    is visible.

.PARAMETER PermissionMode
    Value passed to `claude --permission-mode`. Defaults to `auto` when
    dispatching an issue, and to `plan` under -New; pass it explicitly to
    override either default.

.PARAMETER NewTab
    Open a new Windows Terminal tab (or console window, if `wt.exe` isn't
    available) even when already running inside a Windows Terminal pane,
    instead of reusing the current pane.

.EXAMPLE
    ./Start-IssueAgent.ps1 123

.EXAMPLE
    # Trailing free-text context, forwarded to the session's prompt.
    ./Start-IssueAgent.ps1 900 "Focus on the retry path; the upload succeeds but the poll never terminates."

.EXAMPLE
    # Multi-line context via a here-string; the session name is unaffected.
    ./Start-IssueAgent.ps1 900 @'
    Focus on the retry path.
    The upload succeeds but the poll never terminates.
    '@

.EXAMPLE
    ./Start-IssueAgent.ps1 123 -NewTab

.EXAMPLE
    ./Start-IssueAgent.ps1 123 -PermissionMode manual

.EXAMPLE
    ./Start-IssueAgent.ps1 -IssueNumber 123 -Repo IntelliTect-Samples/IntelliSDLC.ai

.EXAMPLE
    ./Start-IssueAgent.ps1 -New "users need a way to export reports as CSV"

.EXAMPLE
    ./Start-IssueAgent.ps1 -New "spike: cache gh issue lookups" -PermissionMode auto

.EXAMPLE
    # A multi-line description via a native here-string.
    ./Start-IssueAgent.ps1 -New @'
    Review this console log, is it what you expect? Please investigate:
    <transcript pasted here>
    '@

.NOTES
    Exit code -- the contract is deliberately asymmetric, because only one of
    the three launch paths has a session outcome to report:

      - Current pane (already inside Windows Terminal, no -NewTab, not inside
        a Claude Code session): `claude` runs inline and this script exits
        with the **session's own exit code**. A caller scripting against the
        launcher can tell a failed session from a successful one only here.
      - New tab / new console window (-NewTab, no Windows Terminal, wt.exe
        missing, or dispatched from inside a Claude Code session): the session
        is launched fire-and-forget and outlives this script, so there is no
        exit code to wait for and none is invented. These exit **0 on
        successful dispatch** -- the only thing they can honestly report --
        and a non-zero exit there means the dispatch itself failed.

    A preflight failure (a required command missing from PATH, or a missing
    issue number) exits 1 in either case, and -WhatIf exits 0 having launched
    nothing.
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Issue')]
param(
    [Parameter(ParameterSetName = 'Issue', Position = 0)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$IssueNumber,

    [Parameter(ParameterSetName = 'Issue', Position = 1)]
    [AllowEmptyString()]
    [string]$Context = '',

    [Parameter(ParameterSetName = 'New')]
    [AllowEmptyString()]
    [string]$New,

    [string]$Repo,

    # No literal default -- it depends on the parameter set (see
    # Get-DefaultPermissionMode), so Main fills it in only when unbound.
    [ValidateSet('acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan')]
    [string]$PermissionMode,

    [switch]$NewTab
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-GitWithoutOverrides {
    <#
    .SYNOPSIS
        Runs `git` with -ArgumentList, with GIT_DIR / GIT_COMMON_DIR /
        GIT_WORK_TREE cleared for the duration of the call.
    .DESCRIPTION
        Those three environment variables take precedence over `git -C <path>`,
        so a leaked one (a git hook's environment, an IDE integration) silently
        resolves some *other* repository -- verified: with GIT_DIR set, a path
        outside any repository still reported that repository's common dir.

        Every `git` call this script makes goes through here, so the guard
        cannot be forgotten at the next one: the repo-slug lookup and the
        launch-directory lookup must answer for the same repository, and they
        do by construction -- the slug is read from the launch directory the
        second one returned, rather than from a second anchor that has to
        agree. That anchor is the caller's current directory, with
        $PSScriptRoot as the fallback; either way it reaches git via -C, which
        a leaked GIT_DIR would otherwise override. The guard matters *more*
        now than it did when the anchor was a fixed path, because the anchor
        varies per invocation.

        The caller's environment is saved and restored, including when git
        fails -- stderr is discarded and $LASTEXITCODE is left for the caller
        to inspect, exactly as a direct call would.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns', '',
        Justification = 'The noun names the whole set of GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE overrides cleared for the call; a singular would name only one of them.')]
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string[]]$ArgumentList)

    $overrides = 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'
    $saved = @{}
    foreach ($name in $overrides) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }

    try {
        # Remove-Item, not [Environment]::SetEnvironmentVariable($name, $null):
        # the latter hands the child process an *empty* GIT_DIR rather than
        # deleting it, and git then fails with "not a git repository: ''".
        foreach ($name in $overrides) { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }

        return (git @ArgumentList 2>$null)
    }
    finally {
        foreach ($name in $overrides) {
            if ($null -ne $saved[$name]) { Set-Item "Env:\$name" -Value $saved[$name] }
        }
    }
}

function Get-GitOriginUrl {
    <#
    .SYNOPSIS
        The `origin` remote URL of the repository at -Path, or '' when there
        isn't one (or git cannot answer).
    .DESCRIPTION
        The impure half of slug resolution, split out so -New can label its
        launch message with the repository without inheriting the issue path's
        failure contract. -New makes no `gh` call (see Get-RequiredCommand) and
        must keep working on a machine that has `claude` but no `git`: a missing
        git raises a CommandNotFoundException from the *native call*, which is
        terminating under $ErrorActionPreference 'Stop', so it is caught here and
        yields '' rather than killing the launch.

        Deliberately no $LASTEXITCODE check: git writes nothing to stdout when it
        fails -- stderr is discarded in Invoke-GitWithoutOverrides -- so empty
        output is the signal, and reading an unset $LASTEXITCODE is itself an
        error under Set-StrictMode.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Path)

    try {
        $url = Invoke-GitWithoutOverrides -ArgumentList @('-C', $Path, 'remote', 'get-url', 'origin') |
            Select-Object -First 1
    }
    catch {
        Write-Verbose "Could not read the origin remote for '$Path': $_"
        return ''
    }

    if (-not $url) { return '' }
    return $url
}

function ConvertTo-GitHubRepoSlug {
    <#
    .SYNOPSIS
        `owner/repo` parsed from a git remote URL, or '' when the URL is empty or
        is not a recognizable GitHub URL.
    .DESCRIPTION
        Parses both URL forms git remotes commonly use:
          https://github.com/OWNER/REPO.git (or without .git)
          git@github.com:OWNER/REPO.git
        Never infers owner/repo from the local directory name (CLAUDE.md).

        Returns '' rather than throwing, so the launch message can name the
        repository when it is knowable and simply omit it when it is not.
        Get-GitHubRepoSlug adds the throwing contract the issue lookup needs.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$RemoteUrl)

    if (-not $RemoteUrl) { return '' }

    if ($RemoteUrl -match 'github\.com[:/]+(?<owner>[^/]+)/(?<repo>.+?)(\.git)?$') {
        return "$($Matches.owner)/$($Matches.repo)"
    }

    return ''
}

function Get-GitHubRepoSlug {
    <#
    .SYNOPSIS
        Resolves `owner/repo` from the `origin` remote of the repository at
        -Path, throwing when it cannot.
    .DESCRIPTION
        The issue lookup needs a slug or an actionable error -- there is no
        sensible way to fetch an issue from an unknown repository -- so this
        wraps the non-throwing pair (Get-GitOriginUrl, ConvertTo-GitHubRepoSlug)
        with that contract. Both messages name -Repo as the way out.

        -Path, not this process's current directory: Main passes the
        already-resolved launch directory, so the issue is fetched from exactly
        the repository the session will start in. Which repository *that* is
        follows the caller's current directory (see Resolve-GitCommonDir); before
        that, both followed this script's own checkout and ignored the caller,
        and invoking the launcher by absolute path from another repository
        dispatched this repository's issue #N instead of that one's.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Path)

    $remoteUrl = Get-GitOriginUrl -Path $Path
    if (-not $remoteUrl) {
        throw "Could not resolve 'origin' remote. Pass -Repo explicitly (e.g. -Repo owner/repo)."
    }

    $slug = ConvertTo-GitHubRepoSlug -RemoteUrl $remoteUrl
    if (-not $slug) {
        throw "Could not parse owner/repo from origin remote '$remoteUrl'. Pass -Repo explicitly."
    }

    return $slug
}

function Get-GitHubIssue {
    <#
    .SYNOPSIS
        Fetches just an issue's number and title via `gh issue view`.
    .DESCRIPTION
        Only enough to build the session Name. The claude session itself
        (@dev-loop) fetches the full issue -- body, comments, etc. -- when
        given the issue number, so this script does not duplicate that.
    #>
    [CmdletBinding()]
    [OutputType([psobject])]
    param(
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][string]$RepoSlug
    )

    $json = gh issue view $Number --repo $RepoSlug --json number,title 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "gh issue view failed for #$Number in $RepoSlug`: $json"
    }

    return $json | ConvertFrom-Json
}

function Limit-DisplayName {
    <#
    .SYNOPSIS
        Flattens a session display name onto one line and caps it to
        -MaxLength, marking a cut with a trailing '...'.
    .DESCRIPTION
        A display name is one line -- a tab title, a prompt box, a /resume
        entry -- but its source may not be (a pasted multi-line transcript
        under -New), so every whitespace run, newlines included, collapses to
        a single space and the result is trimmed. Flatten first, then cap:
        capping the raw value would spend the budget on whitespace that is
        about to collapse.

        A name beyond -MaxLength would otherwise wrap/overflow the tab title,
        prompt box, and /resume picker. The '...' makes the cut visible rather
        than silent. -MaxLength 0 (the default) means unlimited; a -MaxLength
        too small even for the ellipsis degrades to that many dots.

        Shared by New-IssueAgentName and New-PlanAgentName so one rule
        flattens *and* caps for both modes.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value,
        [int]$MaxLength = 0
    )

    $flattened = ($Value -replace '\s+', ' ').Trim()

    if ($MaxLength -le 0 -or $flattened.Length -le $MaxLength) { return $flattened }
    if ($MaxLength -le 3) { return '.' * $MaxLength }

    return $flattened.Substring(0, $MaxLength - 3) + '...'
}

function New-IssueAgentName {
    <#
    .SYNOPSIS
        Builds the session display name for issue dispatch:
        `<issue ID>: <Issue Title>`, capped to -MaxLength.
    .DESCRIPTION
        Capping/truncation rules live in Limit-DisplayName.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the New- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][psobject]$Issue,
        [int]$MaxLength = 0
    )

    return Limit-DisplayName -Value "$($Issue.number): $($Issue.title)" -MaxLength $MaxLength
}

function New-PlanAgentName {
    <#
    .SYNOPSIS
        Builds the session display name for -New: `new: <description>`, capped
        to -MaxLength.
    .DESCRIPTION
        There is no issue number yet, so the description stands in for the
        title. An empty/whitespace description falls back to a bare
        'new issue'. Capping/truncation rules live in Limit-DisplayName.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the New- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Description,
        [int]$MaxLength = 0
    )

    # Whether the description is blank decides the fallback; flattening a
    # multi-line description onto one line is Limit-DisplayName's job, shared
    # with New-IssueAgentName.
    $trimmed = $Description.Trim()
    $fullName = if ($trimmed) { "new: $trimmed" } else { 'new issue' }

    return Limit-DisplayName -Value $fullName -MaxLength $MaxLength
}

function Get-ConsoleWidth {
    <#
    .SYNOPSIS
        Returns the current console's window width, or a sane fallback (80)
        when it can't be determined (e.g. no console attached / redirected
        output).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param()

    try {
        $width = [Console]::WindowWidth
        if ($width -gt 0) { return $width }
    }
    catch {
        Write-Verbose "Could not determine console width, falling back to 80: $_"
    }

    return 80
}

function Get-GitCommonDir {
    <#
    .SYNOPSIS
        The repository's common git directory (`<main-worktree>/.git`) as an
        absolute path, or '' when it can't be determined.
    .DESCRIPTION
        The one impure step of launch-directory resolution -- kept separate
        from Get-LaunchDirectory so the policy is testable without a repo.

        `--git-common-dir` is the *shared* git directory: it answers with the
        main worktree's `.git` from the main worktree and from every linked
        worktree alike, which `--show-toplevel` (the current tree) does not.

        Anything that goes wrong -- not a repository, git not installed, or a
        git older than 2.31 which lacks `--path-format` -- yields '' so the
        caller falls back rather than throwing.

        *Which* path it is asked about is Resolve-GitCommonDir's decision; this
        only answers for the one it is given.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Path)

    # The GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE guard lives in
    # Invoke-GitWithoutOverrides, shared with Get-GitHubRepoSlug.
    try {
        $output = Invoke-GitWithoutOverrides -ArgumentList @(
            '-C', $Path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        if ($LASTEXITCODE -ne 0) { return '' }
    }
    catch {
        Write-Verbose "Could not resolve the git common dir for '$Path', falling back: $_"
        return ''
    }

    return ($output | Select-Object -First 1)
}

function Resolve-GitCommonDir {
    <#
    .SYNOPSIS
        The common git directory of the repository to act on: the current
        directory's, falling back to the script's own checkout. '' when neither
        is in a repository.
    .DESCRIPTION
        Which repository wins, and the caller's current directory does. Invoked
        by absolute path from another repository, the launcher must fetch *that*
        repository's issue and start the session there rather than in its own
        checkout. Any subdirectory works -- `git -C <subdir> rev-parse` walks up
        -- and so does any linked worktree, because --git-common-dir answers with
        the main worktree's .git from every tree of the repository.

        -ScriptRoot is only the fallback, for a current directory that is not in
        a repository at all (a home directory, a scratch folder). That stays
        silent: it was the sole behavior before there was any choice to make.

        Where Get-GitCommonDir asks git about *one* path, this decides *which*
        path to ask about. Asking about -ScriptRoot happens only when the current
        directory produced nothing, so the common case costs one git call.

        -CurrentDirectory is allowed to be empty because a caller standing in a
        non-FileSystem provider location (Env:\, Function:\, Variable:\) has an
        empty $PWD.ProviderPath, and handing that to `git -C` is a
        parameter-binding failure -- fatal under $ErrorActionPreference 'Stop' --
        rather than something Get-GitCommonDir could turn into a fallback. A
        provider path that merely does not exist (HKLM:\ gives
        'HKEY_LOCAL_MACHINE\') needs no special case: git exits non-zero and
        Get-GitCommonDir already yields ''.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$CurrentDirectory,
        [Parameter(Mandatory)][string]$ScriptRoot
    )

    if ($CurrentDirectory -and $CurrentDirectory.Trim()) {
        $fromCurrent = Get-GitCommonDir -Path $CurrentDirectory
        if ($fromCurrent -and $fromCurrent.Trim()) { return $fromCurrent }
    }

    return (Get-GitCommonDir -Path $ScriptRoot)
}

function Get-LaunchDirectory {
    <#
    .SYNOPSIS
        The directory the claude session should start in: the main worktree
        root, falling back to $ScriptRoot.
    .DESCRIPTION
        Deliberately NOT $PSScriptRoot. Every linked worktree carries its own
        tracked copy of this script, so dispatching from
        `.worktrees/<issue-number>-<name>` would start the session inside that
        worktree, on that worktree's feature branch -- and @dev-loop's own
        `git worktree add .worktrees/<n>-<name>` resolves relative to its
        working directory, nesting a worktree inside a worktree. A dev-loop
        session works inside a worktree by definition, so this is the normal
        case, not an edge case.

        Given `<root>/.git` (what Get-GitCommonDir returns from any worktree
        of the repo), the main worktree root is its parent. A common dir whose
        leaf is not `.git` has no main worktree to point at -- a bare repo, or
        a `--separate-git-dir` checkout -- so $ScriptRoot stands, as it does
        when git reported nothing at all.

        The common dir handed in now comes from the **caller's current
        directory** (see Resolve-GitCommonDir), so "the repository" above is
        the caller's, not this file's. -ScriptRoot is only the fallback: for a
        current directory outside any repository, and for the bare /
        `--separate-git-dir` cases that have no main worktree to name.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$GitCommonDir,
        [Parameter(Mandatory)][string]$ScriptRoot
    )

    $commonDir = if ($GitCommonDir) { $GitCommonDir.Trim() } else { '' }
    if (-not $commonDir) { return $ScriptRoot }
    if ((Split-Path $commonDir -Leaf) -ne '.git') { return $ScriptRoot }

    $root = Split-Path $commonDir -Parent
    if (-not $root) { return $ScriptRoot }

    # git reports forward slashes even on Windows; normalize for the display
    # message and for Set-Location/-WorkingDirectory.
    return [IO.Path]::GetFullPath($root)
}

function Format-LaunchMessage {
    <#
    .SYNOPSIS
        The one-line launch announcement: the session name, the directory, and
        the repository when it is known.
    .DESCRIPTION
        `Launching claude session '<name>' in <dir> (<owner/repo>)`

        Naming the repository is the point. The directory alone does not say
        which repository's issue was fetched, and the launcher follows the
        caller's current directory rather than its own checkout, so "which repo?"
        is a real question at dispatch time. It also makes an explicit -Repo that
        disagrees with the current directory visible without a prompt or a
        refusal.

        -RepoSlug '' -- a repository with no origin, or a git that could not
        answer -- drops the parenthesis entirely rather than printing an empty
        one.

        Format-, not this file's New- string-builder habit: New- trips
        PSUseShouldProcessForStateChangingFunctions and would need the
        suppression attribute its siblings carry, while formatting a value for
        display is exactly what Format- names.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$RepoSlug
    )

    $message = "Launching claude session '$Name' in $Directory"
    if ($RepoSlug) { $message += " ($RepoSlug)" }
    return $message
}

function New-IssueAgentPrompt {
    <#
    .SYNOPSIS
        Builds the initial prompt handed to the claude session.
    .DESCRIPTION
        `@dev-loop` (.github/agents/dev-loop.agent.md, Phase 0) already fetches
        the full issue -- title, body, comments -- and skips straight to
        Phase 1 when given an issue number, so the prompt only needs to point
        it at the issue; it does not need the issue body inlined here.

        Phase 0 keys off "the user supplied an issue number" -- it reads the
        request as prose rather than parsing a fixed grammar -- so the number
        stays leading and unadorned, and -Title rides along after a colon:

            @dev-loop gh issue 900: Make the Video Upload work

        The title is already fetched to build the session Name; putting it here
        too makes it readable at the top of the transcript, not only in the tab
        title and the /resume picker. It is flattened onto one line for the
        same reason a display name is.

        -Context is optional free text from the command line, appended after a
        blank line. It is context, not a spec -- the issue remains the source
        of truth -- so it goes below the dev-loop line rather than into it, and
        it never touches the session name. Blank/whitespace-only context adds
        nothing at all, so the common case stays a single-line prompt.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the New- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][int]$IssueNumber,
        [AllowEmptyString()][string]$Title = '',
        [AllowEmptyString()][string]$Context = ''
    )

    $flatTitle = ($Title -replace '\s+', ' ').Trim()
    $line = if ($flatTitle) { "@dev-loop gh issue $IssueNumber`: $flatTitle" } else { "@dev-loop gh issue $IssueNumber" }

    # A here-string is the supported way to pass multi-line context, so
    # interior newlines are preserved verbatim -- only the CRLF/LF convention
    # is normalized, matching the rest of the prompt.
    $trimmedContext = ($Context -replace "`r`n", "`n").Trim()
    if (-not $trimmedContext) { return $line }

    return "$line`n`n$trimmedContext"
}

function Get-RequiredCommand {
    <#
    .SYNOPSIS
        The external commands that must be on PATH for a given parameter set.
    .DESCRIPTION
        Issue dispatch calls `gh issue view` to name the session, so `gh` must
        be installed for it. -New makes no `gh` call at all -- `@plan` resolves
        the repo and files the issue itself -- so requiring `gh` there would
        fail a machine that has `claude` but not `gh`, for a tool the run never
        invokes.

        -New does make one best-effort `git remote get-url origin`, to name the
        repository in the launch message. That does not put `git` on this list
        either: Get-GitOriginUrl yields '' when git is missing or has no answer,
        and the message simply omits the repository.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure lookup -- the Get- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][ValidateSet('Issue', 'New')][string]$ParameterSetName)

    if ($ParameterSetName -eq 'New') { return , @('claude') }

    return , @('gh', 'claude')
}

function New-PlanAgentPrompt {
    <#
    .SYNOPSIS
        Builds the initial prompt handed to a -New (plan a brand-new issue)
        claude session.
    .DESCRIPTION
        -New has the same destination as the issue-dispatch path -- an issue
        being implemented -- it just starts one step earlier, so the prompt
        spells out both steps explicitly:

          1. `@plan` (.github/agents/plan.agent.md) runs its own Socratic
             discovery -- purpose, constraints, success criteria -- proposes
             approaches, gets the design approved, and creates the GitHub
             issue as its primary output.
          2. `@dev-loop gh issue <number>` picks up that brand-new issue and
             runs the full quality cycle, exactly as `-IssueNumber` would have.

        The whole prompt is natural language read by the claude session, not a
        command line: `<number>` stays a literal placeholder the session fills
        in from the issue @plan just created. This script cannot substitute it
        -- the issue does not exist yet when the prompt is built.

        Naming step 2 in the initial prompt is what makes -New converge:
        `@plan` on its own ends at "hand off to @dev-loop" and waits, so a
        seed-only prompt left the session parked after the issue was filed --
        or, more often, parked in design dialogue having filed nothing.

        The description is a seed, not a spec: @plan asks its own clarifying
        questions from there, so nothing else needs to be inlined. An
        empty/whitespace description drops the seed line and keeps the same
        two steps, letting the agent open the conversation itself.

        The prompt then closes by asking the session to print a ready-to-paste
        `/rename <number>: <issue title>` line once the issue exists, because
        the -New session name (`new: <description>`, see New-PlanAgentName) goes
        stale the moment @plan files the issue -- it should read the same as an
        issue dispatch, `<issue number>: <issue title>`.

        Why printing, and not doing: a session cannot rename itself. Measured
        against Claude Code 2.1.251, not assumed --

          - `/rename` (alias `/name`) is a *client-side* slash command. It is
            expanded from a **user message**: `claude -p "/rename <name>"`
            renames that session and answers "Session renamed to: <name>". The
            model's own output is never scanned for slash commands -- a session
            asked to reply with the literal text `/rename <new name>` did so,
            and its name in `claude agents --json` did not change.
          - There is no `claude` subcommand that renames a session, and no
            rename tool exposed to the model.
          - Renaming a *running* session from outside is refused:
            `claude -p --resume <live session id> "/rename ..."` errors with
            "Session ... is running as a background session ... stop it first",
            and `--fork-session` would rename a copy, not the session.
          - The one non-typed path is a `rename_session` control request, which
            exists only on the remote-control/SDK transport (the phone or an
            SDK host driving the session from outside). Nothing inside the
            session can reach it.

        So the honest contract is: the session computes the exact command, the
        human presses one paste. Re-verify against a newer CLI before assuming
        this is still true.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the New- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Description)

    # The seed line ("@plan <description>", or a bare "@plan" with no
    # description) followed by the same two ordered steps either way -- the
    # steps are what make the session converge, so they are never conditional.
    $trimmed = $Description.Trim()
    $seed = if ($trimmed) { "@plan $trimmed" } else { '@plan' }

    $steps = @(
        'Two steps, in order:'
        '1. @plan: run the design dialogue and create the GitHub issue as its output.'
        ('2. As soon as that issue exists, continue in this same session with ' +
        '`@dev-loop gh issue <number>` for the issue you just created, and run the full dev loop.')
    ) -join "`n"

    # The rename hand-off. This session is named for the description because no
    # issue existed when it launched; only a typed user message can rename it
    # (see .DESCRIPTION for the measurements), so the session's job is to hand
    # over the finished command rather than to attempt the rename itself.
    $rename = @(
        ('This session is named for the description, not the issue -- there was no issue number ' +
        'when it started. Between steps 1 and 2, print this line on its own, filled in from the ' +
        'issue you just filed, so I can paste it:')
        ''
        '    /rename <number>: <issue title>'
        ''
        ('Print it, do not try to run it: /rename is a client-side slash command that only takes ' +
        'effect when a user types it, so a session cannot rename itself.')
    ) -join "`n"

    return "$seed`n`n$steps`n`n$rename"
}

function Get-DefaultPermissionMode {
    <#
    .SYNOPSIS
        The `claude --permission-mode` default for a given parameter set.
    .DESCRIPTION
        -New opens with a design conversation, so it defaults to 'plan':
        plan mode's approval prompt is the gate the user passes through
        before the session creates the issue and starts implementing it.
        Issue dispatch has no design left to approve and defaults to 'auto'
        (pass -PermissionMode auto to skip the gate under -New too). Only consulted
        when -PermissionMode was left unbound -- an explicit -PermissionMode
        always wins.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure lookup -- the Get- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][ValidateSet('Issue', 'New')][string]$ParameterSetName)

    if ($ParameterSetName -eq 'New') { return 'plan' }

    return 'auto'
}

function ConvertTo-PowerShellLiteral {
    <#
    .SYNOPSIS
        Wraps a value as a single-quoted PowerShell string literal, doubling
        any embedded single quotes so it round-trips verbatim.
    .DESCRIPTION
        Used to safely embed arbitrary values (issue titles/prompts may
        contain quotes, colons, etc.) into a script string that is later
        executed via -EncodedCommand, without any shell re-parsing risk.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the ConvertTo- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    return "'" + ($Value -replace "'", "''") + "'"
}

function New-EncodedClaudeCommand {
    <#
    .SYNOPSIS
        Base64 (UTF-16LE) encodes a `Remove-Item Env:\CLAUDE_CODE_CHILD_SESSION;
        Set-Location <dir>; & claude <args...>` invocation for
        `pwsh -EncodedCommand`.
    .DESCRIPTION
        Passing the claude invocation (and working directory) as an encoded
        command -- rather than as separate wt.exe/pwsh command-line arguments
        -- means the Name/prompt/directory survive the nested wt -> pwsh ->
        claude process chain exactly as built, regardless of embedded quotes
        or whitespace.

        This matters specifically because `wt.exe` (under WindowsApps) is an
        app execution alias: the OS's reparse-point hop that resolves it to
        the real Windows Terminal host does not reliably preserve argv
        elements containing spaces -- e.g. `--title "123: some title"` was
        observed splitting at the first space and folding the remainder into
        wt's positional commandline, launching a bogus executable. Keeping
        every wt.exe-level argument space-free (only `-w`, `0`, `new-tab`,
        `--`, `pwsh`, `-NoExit`, `-EncodedCommand`, and a base64 blob) avoids
        that entirely; the directory and Name/title move into this blob
        instead of `-d`/`--title`.

        Removing CLAUDE_CODE_CHILD_SESSION happens inside this brand-new pwsh
        process -- a separate OS process from the one that dispatched it --
        so it only affects the new tab's claude session (which would
        otherwise inherit the marker and disable transcript saving). It never
        touches $env:CLAUDE_CODE_CHILD_SESSION in the caller's own shell/tab.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the New- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )

    $literalArgs = $ArgumentList | ForEach-Object { ConvertTo-PowerShellLiteral $_ }
    $dirLiteral = ConvertTo-PowerShellLiteral $WorkingDirectory
    $scriptText = "Remove-Item Env:\CLAUDE_CODE_CHILD_SESSION -ErrorAction SilentlyContinue; " +
    "Set-Location $dirLiteral; & claude " + ($literalArgs -join ' ')
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($scriptText)
    return [Convert]::ToBase64String($bytes)
}

function Get-ClaudeLaunchMode {
    <#
    .SYNOPSIS
        Decides where the claude session should run: 'CurrentPane', 'NewTab',
        or 'NewWindow'.
    .DESCRIPTION
        Pure decision function (no environment/PATH probing itself) so the
        policy is testable without mocking $env or Get-Command:
          - -ForceNewTab, or not already inside Windows Terminal -> a new
            wt.exe tab if wt.exe is available, else a plain new console
            window.
          - Otherwise (already inside Windows Terminal, no override) ->
            reuse the current pane.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure decision function -- the Get- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [switch]$ForceNewTab,
        [Parameter(Mandatory)][bool]$InWindowsTerminal,
        [Parameter(Mandatory)][bool]$WtAvailable,
        [Parameter(Mandatory)][bool]$InClaudeCodeSession
    )

    if ($ForceNewTab -or $InClaudeCodeSession -or -not $InWindowsTerminal) {
        if ($WtAvailable) { return 'NewTab' }
        return 'NewWindow'
    }

    return 'CurrentPane'
}

function Start-ClaudeIssueSession {
    <#
    .SYNOPSIS
        Launches an interactive `claude` session per Get-ClaudeLaunchMode:
        the current pane, a new Windows Terminal tab, or a new console window.
    .DESCRIPTION
        CLI options are passed before the trailing positional prompt
        (`claude --name ... --remote-control --permission-mode ... -- <prompt>`).
        Each is its own array element -- passed straight to `claude` in the
        current pane, or safely re-embedded via -EncodedCommand for both
        out-of-pane paths -- so no manual shell-escaping of the prompt is
        needed.

        -ExitCode receives the exit code the caller should exit with: the
        session's own for 'CurrentPane', where `& claude` runs inline; 0 for
        'NewTab' / 'NewWindow', which are fire-and-forget dispatches with no
        session exit code to wait for, and 0 under -WhatIf, which launches
        nothing.

        It is a [ref] out-parameter rather than a return value on purpose:
        assigning this function's output would make PowerShell redirect the
        inline `claude`'s stdout into the pipeline, which both pollutes the
        result and takes the console away from an interactive session.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$PermissionMode,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [switch]$NewTab,
        [ref]$ExitCode
    )

    # Dispatch-succeeded is the default; only the current-pane path can
    # replace it with something the session itself reported.
    if ($ExitCode) { $ExitCode.Value = 0 }

    $claudeArgs = @(
        '--name', $Name,
        '--remote-control',
        '--permission-mode', $PermissionMode,
        '--', $Prompt
    )

    if (-not $PSCmdlet.ShouldProcess($Name, 'Launch claude session')) { return }

    $mode = Get-ClaudeLaunchMode -ForceNewTab:$NewTab `
        -InWindowsTerminal ([bool]$env:WT_SESSION) `
        -WtAvailable ([bool](Get-Command wt.exe -ErrorAction SilentlyContinue)) `
        -InClaudeCodeSession ([bool]$env:CLAUDECODE)

    switch ($mode) {
        'CurrentPane' {
            Push-Location $WorkingDirectory
            try { & claude @claudeArgs } finally { Pop-Location }

            # The only path that can honestly report the session's outcome:
            # `claude` ran inline, so its exit code is still in $LASTEXITCODE.
            if ($ExitCode) {
                $sessionExit = if (Test-Path Variable:\LASTEXITCODE) { $LASTEXITCODE } else { 0 }
                $ExitCode.Value = if ($null -eq $sessionExit) { 0 } else { [int]$sessionExit }
            }
        }
        'NewTab' {
            # `-w 0` targets "this window" when the calling process has
            # $env:WT_SESSION set (our case here), brokered by wt.exe's
            # single-instance "monarch" process. KNOWN LIMITATION: firing
            # several `wt -w 0` launches in quick succession (e.g. dispatching
            # multiple issues back-to-back) has been observed to occasionally
            # land a tab in the wrong window -- a race in that broker, not in
            # the arguments built here. No reliable scripted workaround is
            # known; avoid rapid-fire concurrent launches if it matters which
            # window the tab lands in.
            $encodedCommand = New-EncodedClaudeCommand -ArgumentList $claudeArgs -WorkingDirectory $WorkingDirectory
            $wtArgs = @(
                '-w', '0', 'new-tab',
                '--',
                'pwsh', '-NoExit', '-EncodedCommand', $encodedCommand
            )
            # Fire-and-forget: the session outlives this launcher, so there
            # is no exit code to wait for and none may be invented -- the 0
            # set above stands, reporting a successful dispatch.
            Start-Process -FilePath 'wt.exe' -ArgumentList $wtArgs
        }
        'NewWindow' {
            # Same -EncodedCommand blob as the wt.exe path rather than handing
            # $claudeArgs to Start-Process directly: a Windows argv round-trip
            # mangles arguments containing spaces, and this least-exercised
            # path -- taken whenever wt.exe is missing -- is exactly where a
            # multi-line prompt would be mangled. The blob also carries the
            # working directory and drops CLAUDE_CODE_CHILD_SESSION inside the
            # new process, so neither needs a Start-Process parameter here.
            $encodedCommand = New-EncodedClaudeCommand -ArgumentList $claudeArgs -WorkingDirectory $WorkingDirectory
            Start-Process -FilePath 'pwsh' -ArgumentList @('-NoExit', '-EncodedCommand', $encodedCommand)
        }
    }
}

# Allow dot-sourcing for testing (loads functions only)
if ($MyInvocation.InvocationName -eq '.') { return }

# --- Main ---

foreach ($cmd in (Get-RequiredCommand -ParameterSetName $PSCmdlet.ParameterSetName)) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "'$cmd' was not found on PATH. Install it before running this script."
        exit 1
    }
}

$maxNameLength = [Math]::Max(1, [int][Math]::Floor((Get-ConsoleWidth) * 0.75))

if (-not $PSBoundParameters.ContainsKey('PermissionMode')) {
    $PermissionMode = Get-DefaultPermissionMode -ParameterSetName $PSCmdlet.ParameterSetName
}

# Hoisted out of the Issue branch below: a missing issue number is a usage error,
# and the repository is now resolved before that branch, so leaving this check
# where it was would report "Could not resolve 'origin' remote" for a bare
# invocation inside a repository that has no origin.
if ($PSCmdlet.ParameterSetName -eq 'Issue' -and $IssueNumber -le 0) {
    Write-Error 'IssueNumber is required, e.g. ./Start-IssueAgent.ps1 123 (or -New "<description>" to plan a new one)'
    exit 1
}

# The CALLER's repository, not this script's: resolved from the current
# directory -- any subdirectory, any linked worktree -- with this script's own
# checkout as the silent fallback when the current directory is not in a
# repository at all. $PWD.ProviderPath, not .Path: a PSDrive-mapped or UNC
# location has to reach `git -C` as the real path it stands for.
$startDir = Get-LaunchDirectory -ScriptRoot $PSScriptRoot -GitCommonDir (
    Resolve-GitCommonDir -CurrentDirectory $PWD.ProviderPath -ScriptRoot $PSScriptRoot)

# Read FROM the launch directory, so the issue and the session can never name two
# different repositories -- one anchor by construction rather than two lookups
# that have to be passed the same argument. One assignment rather than one per
# branch, deliberately: with two, a reviewer has to verify that both use
# $startDir, which is the failure mode that cost an issue already.
$repoSlug = if ($Repo) { $Repo }
    elseif ($PSCmdlet.ParameterSetName -eq 'New') {
        # Best effort, for the launch message only: -New must not make `gh`
        # required, and must not fail on a missing origin or a missing git.
        ConvertTo-GitHubRepoSlug -RemoteUrl (Get-GitOriginUrl -Path $startDir)
    }
    else { Get-GitHubRepoSlug -Path $startDir }

if ($PSCmdlet.ParameterSetName -eq 'New') {
    # No gh call at all -- @plan resolves the repo and files the issue itself.
    $description = $New

    $name = New-PlanAgentName -Description $description -MaxLength $maxNameLength
    $prompt = New-PlanAgentPrompt -Description $description
}
else {
    $issue = Get-GitHubIssue -Number $IssueNumber -RepoSlug $repoSlug
    $name = New-IssueAgentName -Issue $issue -MaxLength $maxNameLength
    $prompt = New-IssueAgentPrompt -IssueNumber $IssueNumber -Title ([string]$issue.title) -Context $Context
}

Write-Information (Format-LaunchMessage -Name $name -Directory $startDir -RepoSlug $repoSlug) `
    -InformationAction Continue
# [ref], not a captured return value: capturing this call would redirect the
# inline claude session's stdout away from the console (see
# Start-ClaudeIssueSession).
$sessionExitCode = 0
Start-ClaudeIssueSession -Name $name -Prompt $prompt -PermissionMode $PermissionMode `
    -WorkingDirectory $startDir -NewTab:$NewTab `
    -ExitCode ([ref]$sessionExitCode)

# The session's own exit code when it ran in this pane; 0 for a successful
# out-of-pane dispatch (see .NOTES).
exit [int]$sessionExitCode
