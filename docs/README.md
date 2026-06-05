# docs/  AI-Replay Spec Archive

This directory is the **durable spec archive** for this project -- the standard
`docs/` structure that holds the product requirements documents (PRDs) and
implementation plans produced by the AI agents that ship with IntelliSDLC.ai.
Hand `docs/` to a fresh AI session and the project can be reconstructed from
these files alone.

The archive is split into two standard subfolders:

- **`docs/specs/`** -- PRDs / requirements: *what* to build (user stories,
  acceptance criteria, metrics). Written by the `@prd` agent.
- **`docs/designs/`** -- implementation plans: *how* to build it (ordered
  tasks, file paths, code snippets, commit messages). Written by `@dev-loop`
  Phase 2 (the `@plan` agent seeds them).

> This `README.md` is **consumer-owned**. The upstream copy is scaffolded
> into your project on first sync and is never overwritten by
> `Pull-SDLC.ai.ps1` afterwards. Customize it freely for your project.

## Filename Convention

One feature per `<issue#>-<slug>` identifier, shared by the PRD, plan, GitHub
issue, branch (`feat/<issue#>-<slug>`), and PR:

- `<issue#>` -- the GitHub issue number; the leading token is identical to the
  branch name, so each folder sorts naturally by issue number.
- `<slug>` -- a short kebab-case description.

| File                                  | Written by               | Purpose                                              |
|---------------------------------------|--------------------------|------------------------------------------------------|
| `docs/specs/<issue#>-<slug>-prd.md`   | `@prd` agent             | Product requirements: user stories, acceptance criteria, metrics. |
| `docs/designs/<issue#>-<slug>-plan.md`| `@dev-loop` Phase 2      | Implementation plan: ordered tasks with file paths, code snippets, commit messages. |
| `docs/MIGRATION.md`                   | `Consolidate-Tasks.ps1`  | Audit trail of files imported from legacy locations. |

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

`docs/specs/`, `docs/designs/`, and this `docs/README.md` are listed in
`$script:AlwaysLocalPaths` inside `Pull-SDLC.ai.ps1`, so their contents are
**never** touched by upstream sync. Edit freely; the next `Pull-SDLC.ai.ps1`
run will leave your requirements corpus alone.

## Migrating Legacy Spec Files

The repo-root script `Consolidate-Tasks.ps1` imports historical spec
artifacts into this archive:

- `tasks/*-prd.md`  -> moved (`git mv`) into `docs/specs/<slug>-prd.md`
- `tasks/*-plan.md` -> moved (`git mv`) into `docs/designs/<slug>-plan.md`
- `docs/prd/*.md`   -> moved (`git mv`) into `docs/specs/<slug>-prd.md`
- Root `PRD.md` -> `docs/specs/legacy-prd.md`; `plan.md` / `IMPLEMENTATION_PLAN.md` -> `docs/designs/legacy-plan.md`
- `~/.copilot/session-state/*/plan.md` -> copied into `docs/designs/` (repo-scoped via the session-store DB), default ON
- `~/.claude/...` session notes -> copied into `docs/designs/`, opt-in (`-IncludeClaudeSessions`)

It uses the standard PowerShell `SupportsShouldProcess` pattern:

```powershell
# Dry run -- prints planned actions, writes nothing:
./Consolidate-Tasks.ps1 -WhatIf

# Actually perform the migration without per-action prompts:
./Consolidate-Tasks.ps1 -Confirm:$false
```

The script is idempotent (re-runs are no-ops) and writes a manifest to
`docs/MIGRATION.md` recording each action.

See the inline comment-based help (`Get-Help ./Consolidate-Tasks.ps1 -Full`)
for the full switch list.