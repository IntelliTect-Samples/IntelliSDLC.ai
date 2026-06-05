# Adopt standard docs/ spec structure, retire tasks/ convention

- Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/182
- Slug:  182-docs-spec-convention

## Goal

Replace the bespoke `tasks/` durable-spec-archive convention with the
industry-standard `docs/` structure: `docs/specs/` (PRDs / the *what*),
`docs/designs/` (implementation plans / the *how*), and a consumer-owned
`docs/README.md` guide.

## Mapping

| Old | New |
|---|---|
| `tasks/<issue#>-<slug>-prd.md`  | `docs/specs/<issue#>-<slug>-prd.md` |
| `tasks/<issue#>-<slug>-plan.md` | `docs/designs/<issue#>-<slug>-plan.md` |
| `tasks/README.md`               | `docs/README.md` |
| `tasks/MIGRATION.md`            | `docs/MIGRATION.md` |

## Tasks (behavior-first)

1. Update Pester tests (Red) in `Pull-SDLC.ai.Tests.ps1` and
   `Consolidate-Tasks.Tests.ps1` to encode the new behavior.
2. Update `Pull-SDLC.ai.ps1`: `TemplateScaffoldMap` (`docs/README.md`),
   `UpstreamManagedPaths` (`docs/README.md`), `AlwaysLocalPaths`
   (`docs/specs/`, `docs/designs/`, `docs/README.md`), carve-out comments.
3. Invert `Consolidate-Tasks.ps1`: destinations `docs/specs/`/`docs/designs/`;
   sources add `tasks/*` and `docs/prd/*`, drop `docs/designs/*` as source;
   manifest -> `docs/MIGRATION.md`. Keep filename.
4. `git mv tasks/README.md docs/README.md`; rewrite content; remove
   `tasks/.gitkeep` + empty `tasks/`.
5. Update agents (`prd`, `plan`, `dev-loop`), `README.md`, `.gitignore`.
6. Run full Pester suites green; preserve CRLF; open PR; rebase-merge.