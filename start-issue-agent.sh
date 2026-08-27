#!/usr/bin/env bash
# Forwards to Start-IssueAgent.ps1 so the same logic runs from bash or pwsh.
# Usage: ./start-issue-agent.sh <issue-number> [-Repo owner/repo] [-PermissionMode auto|...] [-NewTab]
#        ./start-issue-agent.sh -New "<description of the new issue>" [-Repo owner/repo] [-PermissionMode ...] [-NewTab]
#          (-New has @plan create the issue, then hands it to @dev-loop -- instead of
#           dispatching an issue that already exists.)
#
# For a multi-line description, use `-New -` and a heredoc -- bash has no
# equivalent of PowerShell's @'...'@ here-string, and a heredoc feeds stdin
# rather than an argument:
#
#   ./start-issue-agent.sh -New - <<'END'
#   Review this console log, is it what you expect? Please investigate:
#   <transcript pasted here>
#   END
#
# Reading stdin always opens a new tab/window: an inline `claude` in the
# current pane would inherit the drained stdin and would not be interactive.
#
# No forced -NewTab here: Start-IssueAgent.ps1 already detects $env:CLAUDECODE
# (set for both Claude Code's Bash tool and its interactive `!` command) and
# forces a new tab itself in that case, so a Claude Code session never
# hijacks its own pane. A plain human bash shell still gets the same
# reuse-current-pane default as pwsh.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v pwsh >/dev/null 2>&1; then
    echo "start-issue-agent.sh: 'pwsh' (PowerShell 7+) was not found on PATH. Install it before running this script." >&2
    exit 1
fi

exec pwsh -NoProfile -File "$script_dir/Start-IssueAgent.ps1" "$@"
