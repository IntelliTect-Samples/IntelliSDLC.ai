# Plan: Unify Spec Storage Under tasks/ and Fix PRD Write Capability

Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/121
Branch: feat/121-unify-spec-storage-tasks

## Commits

1. `feat(agents): fix PRD agent tools and write target` -- add filesystem/runCommands/terminalLastCommand, reorder frontmatter, change save path to tasks/, add read-existing step.
2. `feat(agents): route dev-loop Phase 2 and plan agent to tasks/` -- update dev-loop Phase 2 save path and ingest step; add tasks/ scan to plan agent.
3. `feat(sync): scaffold tasks/README.md and grant sync immunity` -- add template, register in TemplateScaffoldMap and AlwaysLocalPaths (prefix matching), sync-manifest.json.
4. `feat(scripts): add Consolidate-Tasks.ps1 migration tool` -- SupportsShouldProcess, hybrid move/copy, repo-scoped session import, manifest output. Pester tests. Register in propagation list.
5. `chore: dogfood-ignore tasks/* in upstream repo` -- .gitignore additions.
6. `test: sync-immunity Pester test for tasks/` -- in Pull-SDLC.ai.Tests.ps1.

Each commit carries:
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
