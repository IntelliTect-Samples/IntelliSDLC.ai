# tasks/  AI-Replay Spec Archive

This directory is the **durable spec archive** for this project. It holds the
product requirements documents (PRDs) and implementation plans produced by the
AI agents that ship with IntelliSDLC.ai. Hand this directory to a fresh AI
session and the project can be reconstructed from these files alone.

> This `README.md` is **consumer-owned**. The upstream copy is scaffolded
> into your project on first sync and is never overwritten by
> `Pull-SDLC.ai.ps1` afterwards. Customize it freely for your project.

## Filename Convention

One feature per `<issue#>-<slug>` identifier, shared by the PRD, plan, GitHub
issue, branch (`feat/<issue#>-<slug>`), and PR:

- `<issue#>` -- the GitHub issue number; the leading token is identical to the
  branch name, so `tasks/` sorts naturally by issue number.
- `<slug>` -- a short kebab-case description.

| File                          | Written by               | Purpose                                              |
|-------------------------------|--------------------------|------------------------------------------------------|
| `<issue#>-<slug>-prd.md`      | `@prd` agent             | Product requirements: user stories, acceptance criteria, metrics. |
| `<issue#>-<slug>-plan.md`     | `@dev-loop` Phase 2      | Implementation plan: ordered tasks with file paths, code snippets, commit messages. |
| `MIGRATION.md`                | `Consolidate-Tasks.ps1`  | Audit trail of files imported from legacy locations. |

A PRD spike filed before an issue exists may use the bare `<slug>-prd.md` and
get renamed to add the `<issue#>-` prefix once the issue is created. Legacy
files predating this convention may also appear as a bare `<slug>-{prd,plan}.md`.

## Cross-Referencing

Each artifact should link to its companion GitHub issue and PR. Recommended
top-of-file header:

```markdown
# <Feature Title>

- Issue: https://github.com/<owner>/<repo>/issues/<n>
- PR:    https://github.com/<owner>/<repo>/pull/<m>
- Slug:  <issue#>-<slug>
```

When a PRD or plan references stories or tasks by identifier, prefer the
GitHub issue number once it exists; use a local `<issue#>-<slug>-NN` form only
until the issues are filed.

## Sync Immunity

`tasks/` is listed in `$script:AlwaysLocalPaths` inside `Pull-SDLC.ai.ps1`,
so its contents are **never** touched by upstream sync. Edit freely; the next
`Pull-SDLC.ai.ps1` run will leave this directory alone.

## Migrating Legacy Spec Files

The repo-root script `Consolidate-Tasks.ps1` imports historical spec
artifacts into this directory:

- `docs/designs/*.md`  -> moved (`git mv`) and renamed to `<slug>-plan.md`
- `docs/prd/*.md`      -> moved (`git mv`) and renamed to `<slug>-prd.md`
- Root `PRD.md`, `plan.md`, `IMPLEMENTATION_PLAN.md` -> moved
- `~/.copilot/session-state/*/plan.md` -> copied (repo-scoped via the session-store DB), default ON
- `~/.claude/...` session notes -> copied, opt-in (`-IncludeClaudeSessions`)

It uses the standard PowerShell `SupportsShouldProcess` pattern:

```powershell
# Dry run -- prints planned actions, writes nothing:
./Consolidate-Tasks.ps1 -WhatIf

# Actually perform the migration without per-action prompts:
./Consolidate-Tasks.ps1 -Confirm:$false
```

The script is idempotent (re-runs are no-ops) and writes a manifest to
`tasks/MIGRATION.md` recording each action.

See the inline comment-based help (`Get-Help ./Consolidate-Tasks.ps1 -Full`)
for the full switch list.