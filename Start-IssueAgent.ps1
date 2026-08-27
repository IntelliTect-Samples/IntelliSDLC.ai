<#
.SYNOPSIS
    Dispatches a GitHub issue to an interactive `claude` CLI session, or opens
    one to plan a brand-new issue.

.DESCRIPTION
    Two modes, one launcher:

      - `-IssueNumber <n>` (the default, positional): work an issue that
        already exists. Prompt: `@dev-loop gh issue <n>`, permission mode
        `auto`.
      - `-New <description>`: there is no issue yet. Prompt: `@plan
        <description>`, permission mode `plan`. No `gh`/`git remote` call is
        made -- `@plan` (.github/agents/plan.agent.md) runs its own discovery
        dialogue, resolves the repo itself, and files the issue as its primary
        output. `-New -` reads the description from stdin so a bash heredoc
        works; see .PARAMETER New.

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
         local directory name -- see CLAUDE.md).
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
      4. Build the prompt: `@dev-loop gh issue <IssueNumber>`, telling the
         session to run the full dev loop starting from the existing issue
         -- no issue creation step needed; or, under -New, `@plan
         <description>`, which starts at design and ends by creating the
         issue.
      5. Launch `claude` with CLI options first, the derived prompt last:
         `claude --name <Name> --remote-control --permission-mode <mode> -- <prompt>`
         When opening a new wt.exe tab, this command (plus a `Set-Location`
         to the working directory) is handed to a nested `pwsh
         -EncodedCommand` (base64) rather than passed as wt.exe/pwsh
         command-line arguments -- see New-EncodedClaudeCommand for why that
         matters specifically for `wt.exe`.

    The session is left to create its own git worktree/branch as part of the
    dev loop (@dev-loop) -- this script does not pre-create one.

    Runnable from both pwsh and bash: use start-issue-agent.sh from bash,
    which forwards its arguments to `pwsh -File Start-IssueAgent.ps1`
    (the $env:CLAUDECODE / $env:WT_SESSION detection above applies the same
    way regardless of which shell launched it).

.PARAMETER IssueNumber
    The GitHub issue number to dispatch. Required for the default parameter
    set (not marked Mandatory on the parameter itself so this script can be
    dot-sourced for testing; validated at the start of Main instead).
    Mutually exclusive with -New.

.PARAMETER New
    Plan a brand-new issue instead of dispatching an existing one. The value
    is a plain-English description of the idea, used to seed `@plan` -- a
    seed, not a spec: @plan asks its own clarifying questions from there.
    Mutually exclusive with -IssueNumber.

    Pass `-New ''` for a seedless planning session (prompt: just `@plan`). A
    bare valueless `-New` is a PowerShell binding error, since -New takes a
    string.

    Pass `-New -` to read the description from stdin instead. This exists for
    bash, which has no equivalent of PowerShell's `@'...'@` here-string: a
    heredoc feeds stdin, not an argument, so `-New -` is what lets a bare
    heredoc work --

        ./start-issue-agent.sh -New - <<'END'
        Review this console log, is it what you expect? Please investigate:
        <transcript pasted here>
        END

    From PowerShell prefer the native here-string, which needs no stdin:

        ./Start-IssueAgent.ps1 -New @'
        ...multi-line description...
        '@

    Reading stdin always opens a new tab/window even inside Windows Terminal:
    an inline `claude` in the current pane would inherit the drained stdin and
    would not be interactive. Empty stdin is an error, not a seedless session.

.PARAMETER Repo
    Explicit `owner/repo` to pass to `gh issue view --repo`. If omitted, it is
    resolved from `git remote get-url origin` in the current directory.
    Unused under -New (no issue is fetched).

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
    ./Start-IssueAgent.ps1 123 -NewTab

.EXAMPLE
    ./Start-IssueAgent.ps1 123 -PermissionMode manual

.EXAMPLE
    ./Start-IssueAgent.ps1 -IssueNumber 123 -Repo IntelliTect-Dev/IntelliSDLC.ai

.EXAMPLE
    ./Start-IssueAgent.ps1 -New "users need a way to export reports as CSV"

.EXAMPLE
    ./Start-IssueAgent.ps1 -New "spike: cache gh issue lookups" -PermissionMode auto

.EXAMPLE
    # PowerShell: a multi-line description via a native here-string.
    ./Start-IssueAgent.ps1 -New @'
    Review this console log, is it what you expect? Please investigate:
    <transcript pasted here>
    '@

.EXAMPLE
    # bash: the same, via a heredoc on stdin.
    ./start-issue-agent.sh -New - <<'END'
    Review this console log, is it what you expect? Please investigate:
    <transcript pasted here>
    END
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Issue')]
param(
    [Parameter(ParameterSetName = 'Issue', Position = 0)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$IssueNumber,

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

function Get-GitHubRepoSlug {
    <#
    .SYNOPSIS
        Resolves `owner/repo` from the current directory's `origin` remote.
    .DESCRIPTION
        Parses both URL forms git remotes commonly use:
          https://github.com/OWNER/REPO.git (or without .git)
          git@github.com:OWNER/REPO.git
        Never infers owner/repo from the local directory name (CLAUDE.md).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    $remoteUrl = git remote get-url origin 2>$null
    if (-not $remoteUrl) {
        throw "Could not resolve 'origin' remote. Pass -Repo explicitly (e.g. -Repo owner/repo)."
    }

    if ($remoteUrl -match 'github\.com[:/]+(?<owner>[^/]+)/(?<repo>.+?)(\.git)?$') {
        return "$($Matches.owner)/$($Matches.repo)"
    }

    throw "Could not parse owner/repo from origin remote '$remoteUrl'. Pass -Repo explicitly."
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
        Caps a session display name to -MaxLength, marking a cut with a
        trailing '...'.
    .DESCRIPTION
        A name beyond -MaxLength would otherwise wrap/overflow the tab title,
        prompt box, and /resume picker. The '...' makes the cut visible rather
        than silent. -MaxLength 0 (the default) means unlimited; a -MaxLength
        too small even for the ellipsis degrades to that many dots.

        Shared by New-IssueAgentName and New-PlanAgentName so both modes cap
        identically.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value,
        [int]$MaxLength = 0
    )

    if ($MaxLength -le 0 -or $Value.Length -le $MaxLength) { return $Value }
    if ($MaxLength -le 3) { return '.' * $MaxLength }

    return $Value.Substring(0, $MaxLength - 3) + '...'
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

    # A description may be many lines (a pasted transcript via -New -), but a
    # tab title / resume-picker entry is one line: collapse every whitespace
    # run -- newlines included -- to a single space before capping.
    $trimmed = ($Description -replace '\s+', ' ').Trim()
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

function New-IssueAgentPrompt {
    <#
    .SYNOPSIS
        Builds the initial prompt handed to the claude session.
    .DESCRIPTION
        `@dev-loop` (.github/agents/dev-loop.agent.md, Phase 0) already fetches
        the full issue -- title, body, comments -- and skips straight to
        Phase 1 when given an issue number, so the prompt only needs to point
        it at the issue; it does not need the issue body inlined here.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the New- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][int]$IssueNumber)

    return "@dev-loop gh issue $IssueNumber"
}

function New-PlanAgentPrompt {
    <#
    .SYNOPSIS
        Builds the initial prompt handed to a -New (plan a brand-new issue)
        claude session.
    .DESCRIPTION
        `@plan` (.github/agents/plan.agent.md) runs its own Socratic discovery
        -- purpose, constraints, success criteria -- proposes approaches, gets
        the design approved, and only then creates the GitHub issue. The
        description is therefore a seed, not a spec: nothing else needs to be
        inlined here. An empty/whitespace description yields the bare `@plan`,
        letting the agent open the conversation itself.
    #>
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Pure string builder -- the New- verb here names output shape, not state change.')]
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Description)

    $trimmed = $Description.Trim()
    if (-not $trimmed) { return '@plan' }

    return "@plan $trimmed"
}

function Read-DescriptionFromStdin {
    <#
    .SYNOPSIS
        Reads the -New description from stdin (the `-New -` form).
    .DESCRIPTION
        Exists for bash, which has no equivalent of PowerShell's `@'...'@`
        here-string: a heredoc feeds stdin rather than an argument, so
        `-New -` is what lets a bare heredoc carry a multi-line description.

        CRLF is normalized to LF and trailing newlines are trimmed, so the
        prompt does not end in blank lines. Stdin that is not redirected, or
        that is empty/whitespace-only, is an error rather than a silent
        seedless session -- a blank `@plan` prompt would look like the
        description was accepted when it was lost.

        -Reader / -IsInputRedirected are test seams (same pattern as
        Publish-Evidence.ps1's -GhInvoker); both default to the real console.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [scriptblock]$Reader = { [Console]::In.ReadToEnd() },
        [bool]$IsInputRedirected = [Console]::IsInputRedirected
    )

    if (-not $IsInputRedirected) {
        throw "-New - reads the description from stdin, but stdin is not redirected. " +
        "Pipe it in (bash: ./start-issue-agent.sh -New - <<'END' ... END), or pass the " +
        "description inline as -New '<description>'."
    }

    $text = [string](& $Reader)
    $text = ($text -replace "`r`n", "`n").TrimEnd("`n")

    if (-not $text.Trim()) {
        throw "-New - read an empty description from stdin. Supply the description on " +
        "stdin, or pass it inline as -New '<description>'."
    }

    return $text
}

function Get-DefaultPermissionMode {
    <#
    .SYNOPSIS
        The `claude --permission-mode` default for a given parameter set.
    .DESCRIPTION
        -New opens a design conversation, so it defaults to 'plan'; issue
        dispatch runs the full dev loop and defaults to 'auto'. Only consulted
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
          - -StdinConsumed forces the same: the description was read from a
            redirected stdin (the `-New -` form), so an inline `claude` in
            the current pane would inherit that drained stdin and would not
            be interactive.
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
        [Parameter(Mandatory)][bool]$InClaudeCodeSession,
        [bool]$StdinConsumed = $false
    )

    if ($ForceNewTab -or $InClaudeCodeSession -or $StdinConsumed -or -not $InWindowsTerminal) {
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
        Each is its own array element -- passed straight to `claude` for the
        current-pane/fallback-window paths, or safely re-embedded via
        -EncodedCommand for the wt.exe path -- so no manual shell-escaping of
        the prompt is needed.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$PermissionMode,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [switch]$NewTab,
        [switch]$StdinConsumed
    )

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
        -InClaudeCodeSession ([bool]$env:CLAUDECODE) `
        -StdinConsumed ([bool]$StdinConsumed)

    switch ($mode) {
        'CurrentPane' {
            Push-Location $WorkingDirectory
            try { & claude @claudeArgs } finally { Pop-Location }
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
            Start-Process -FilePath 'wt.exe' -ArgumentList $wtArgs
        }
        'NewWindow' {
            # -Environment overrides just this one variable for the new claude
            # process; it does not touch $env:CLAUDE_CODE_CHILD_SESSION in the
            # caller's own shell/tab (requires PowerShell 7.4+).
            Start-Process -FilePath 'claude' -ArgumentList $claudeArgs -WorkingDirectory $WorkingDirectory `
                -Environment @{ CLAUDE_CODE_CHILD_SESSION = $null }
        }
    }
}

# Allow dot-sourcing for testing (loads functions only)
if ($MyInvocation.InvocationName -eq '.') { return }

# --- Main ---

foreach ($cmd in 'gh', 'claude') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "'$cmd' was not found on PATH. Install it before running this script."
        exit 1
    }
}

$maxNameLength = [Math]::Max(1, [int][Math]::Floor((Get-ConsoleWidth) * 0.75))

if (-not $PSBoundParameters.ContainsKey('PermissionMode')) {
    $PermissionMode = Get-DefaultPermissionMode -ParameterSetName $PSCmdlet.ParameterSetName
}

$stdinConsumed = $false

if ($PSCmdlet.ParameterSetName -eq 'New') {
    # No gh/git call at all -- @plan resolves the repo and files the issue itself.
    $description = $New
    if ($New -eq '-') {
        $description = Read-DescriptionFromStdin
        $stdinConsumed = $true
    }

    $name = New-PlanAgentName -Description $description -MaxLength $maxNameLength
    $prompt = New-PlanAgentPrompt -Description $description
}
else {
    if ($IssueNumber -le 0) {
        Write-Error 'IssueNumber is required, e.g. ./Start-IssueAgent.ps1 123 (or -New "<description>" to plan a new one)'
        exit 1
    }

    $repoSlug = if ($Repo) { $Repo } else { Get-GitHubRepoSlug }
    $issue = Get-GitHubIssue -Number $IssueNumber -RepoSlug $repoSlug
    $name = New-IssueAgentName -Issue $issue -MaxLength $maxNameLength
    $prompt = New-IssueAgentPrompt -IssueNumber $IssueNumber
}

$startDir = $PSScriptRoot

Write-Information "Launching claude session '$name' in $startDir" -InformationAction Continue
Start-ClaudeIssueSession -Name $name -Prompt $prompt -PermissionMode $PermissionMode `
    -WorkingDirectory $startDir -NewTab:$NewTab -StdinConsumed:$stdinConsumed
