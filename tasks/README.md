# tasks/  AI-Replay Spec Archive

This directory is the **durable spec archive** for this project. It holds the
product requirements documents (PRDs) and implementation plans produced by the
AI agents that ship with IntelliSDLC.ai. Hand this directory to a fresh AI
session and the project can be reconstructed from these files alone.

> This `README.md` is **consumer-owned**. The upstream copy is scaffolded
> into your project on first sync and is never overwritten by
> `Pull-SDLC.ai.ps1` afterwards. Customize it freely for your project.

## Filename Convention

One feature per slug. Each slug matches its branch name
(`feat/<issue#>-<feature>`), so the PRD, plan, GitHub issue, branch, and PR
all share an identifier.

| File                          | Written by               | Purpose                                              |
|-------------------------------|--------------------------|------------------------------------------------------|
| `<feature>-prd.md`            | `@prd` agent             | Product requirements: user stories, acceptance criteria, metrics. |
| `<feature>-plan.md`           | `@dev-loop` Phase 2      | Implementation plan: ordered tasks with file paths, code snippets, commit messages. |
| `MIGRATION.md`                | `Consolidate-Tasks.ps1`  | Audit trail of files imported from legacy locations. |

## Cross-Referencing

Each artifact should link to its companion GitHub issue and PR. Recommended
top-of-file header:

```markdown
# <Feature Title>

- Issue: https://github.com/<owner>/<repo>/issues/<n>
- PR:    https://github.com/<owner>/<repo>/pull/<m>
- Slug:  <feature>
```

When a PRD or plan references stories or tasks by identifier, prefer the
GitHub issue number once it exists; use a local `<feature>-NN` form only
until the issues are filed.

## Sync Immunity

`tasks/` is listed in `$script:AlwaysLocalPaths` inside `Pull-SDLC.ai.ps1`,
so its contents are **never** touched by upstream sync. Edit freely; the next
`Pull-SDLC.ai.ps1` run will leave this directory alone.

## Migrating Legacy Spec Files

The repo-root script `Consolidate-Tasks.ps1` imports historical spec
artifacts into this directory:

- `docs/designs/*.md`  -> moved (`git mv`) and renamed to `<date>-<feature>-plan.md`
- `docs/prd/*.md`      -> moved (`git mv`) and renamed to `<date>-<feature>-prd.md`
- Root `PRD.md`, `plan.md`, `IMPLEMENTATION_PLAN.md` -> moved
- `~/.copilot/session-state/*/plan.md` -> copied (repo-scoped via the session-store DB), default ON
- `~/.claude/...` session notes -> copied, opt-in (`-IncludeClaudeSessions`)

Every imported destination is **date-prefixed** so the `tasks/` listing sorts
chronologically. The date is resolved in order: a leading `YYYY-MM-DD-` prefix
already present in the source name; else the date of the most recent git commit
that modified the file; else the file's last-write time. Pass
`-InsertDatePrefix:$false` to suppress synthesized prefixes (an embedded prefix
in the source name is always preserved). The resolved date is also recorded in
the `Source Date` column of `tasks/MIGRATION.md`.

> This date convention applies only to **migrated legacy artifacts**, whose
> original ordering would otherwise be lost. Newly created `@prd` / `@plan`
> files keep the bare `<feature>-prd.md` / `<feature>-plan.md` slug so the
> agents can resolve them by exact path.

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