# Diff-Replay Pull-SDLC.ai.ps1

## Problem

`Pull-SDLC.ai.ps1` ends with `git merge --no-ff --allow-unrelated-histories
sdlc.ai/main`. Empirically this produces rename/rename collisions on upstream
restructures and content/content conflicts on every upstream-managed file
that legitimately changed upstream since the consumer last synced. Policy
already forbids local edits to upstream-managed files, so the right answer
for those content conflicts is always "take upstream" -- a three-way merge
is the wrong tool.

## Design: replay the upstream commit log as file operations

```powershell
git diff --name-status -M -B <anchor> sdlc.ai/main -- <managed-paths>
```

Each row becomes a working-tree op:

| Row      | Action                                            |
| -------- | ------------------------------------------------- |
| `A p`    | `git show <ref>:p > p`                            |
| `M p`    | overwrite with `git show <ref>:p`                 |
| `T p`    | rewrite (mode-only) with `git show <ref>:p`       |
| `D p`    | `Remove-Item p`                                   |
| `R# a b` | `Remove-Item a; git show <ref>:b > b`             |
| `C# a b` | `git show <ref>:b > b` (do not delete the source) |

Rename detection runs against the single upstream timeline, so rename/rename
collisions are impossible. Files are written byte-for-byte from upstream;
no three-way merge means no content conflicts.

## Constants

```
$UpstreamManagedPaths = @(
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    '.github/agents/',
    '.github/skills/',
    '.github/instructions/'
)

$AlwaysLocalPaths = @(
    'README.md',
    '.gitignore',
    '.gitattributes',
    '.github/instructions/project.instructions.md',
    'CLAUDE.project.md',
    '.sdlc-ai-sync.json'
)
```

Always-local trumps managed-paths.

`.gitignore` is treated as a merge-path rather than always-local: upstream
content is union-merged into the consumer's copy. A markered "upstream-only"
block (lines between `# >>> upstream-only >>>` and `# <<< upstream-only <<<`,
case-insensitive) is stripped from the upstream text before merging, so
entries inside the markers are never propagated to consumers. An unterminated
opener drops everything from the marker to end of file (defensive).

## State file `.sdlc-ai-sync.json`

```json
{
  "remote": "sdlc.ai",
  "ref": "main",
  "lastSyncCommit": "<full sha>",
  "syncedAt": "<iso8601 UTC>"
}
```

Anchor resolution: state file -> grep `^chore.*sync.*IntelliSDLC` -> bootstrap
(prompt, or `-Bootstrap` / `-NoPrompt` to accept).

## Pre-flight policy guard

For each existing managed path, compare `git rev-parse HEAD:<path>` to
`git rev-parse <anchor>:<path>`. Mismatch => local drift; print offending
paths + introducing commit and abort unless `-Force`.

## CLI additions

- `-WhatIf`    -- print planned op list and exit.
- `-Force`     -- bypass pre-flight guard with banner warning.
- `-Bootstrap` -- accept missing anchor without prompting.

## Removed

- `git merge --no-ff --allow-unrelated-histories ...` codepath.
- Untracked-file conflict prompt + `Resolve-AlwaysLocalConflicts`-based
  merge fixups (subsumed by the always-local filter on the op list).

Kept: `Test-IsAlwaysLocalPath`, `Test-IsUpstreamRepo`, `Invoke-TemplateScaffold`.