---
description: 'Project-specific instructions for the IntelliSDLC.ai repository itself. Never synced to consuming projects.'
applyTo: '**/*'
---

<!--
This file is the CONSUMING PROJECT's own instructions file. In this repository
the "consuming project" is IntelliSDLC.ai itself, so this is where guidance
about *this* repo lives.

It is on $script:AlwaysLocalPaths in Pull-SDLC.ai.ps1, so Get-UpstreamOps drops
it before emitting a sync op: consumers never receive this copy. They get their
own, scaffolded from project.instructions.md.template. That is exactly why
repo-specific guidance belongs here and not in CLAUDE.md or
.github/copilot-instructions.md, both of which ARE synced downstream.

It is also excluded from the workflow's project-content leak scan by basename,
so it may name this repository and its files freely.
-->

# Project Instructions

## Project Overview

IntelliSDLC.ai is a **template repository**. Its content is the product: agent
definitions, skills, and language instructions that `Pull-SDLC.ai.ps1` syncs
into consuming projects. There is no application here — the "build output" is
what lands in someone else's repo.

That inverts the usual bias. In a normal project an extra file is untidy; here
an extra file that ships is **shipped to every consumer, forever**. Before
adding anything, decide which side of the upstream/consumer line it sits on.

## The Upstream / Consumer Split

Three categories, and every new file belongs to exactly one:

| Category | Reaches consumers? | Examples |
|---|---|---|
| **Shipped** | Yes | `CLAUDE.md`, `.github/agents/*.agent.md`, `.github/skills/*/SKILL.md`, `templates/**` |
| **Upstream-private** | No | Anything under a `tests/` or `fixtures/` directory in `.github/`; `.github/ci/`; this repo's CI workflow |
| **Consumer-owned** | Scaffolded once, then theirs | `README.md`, `CLAUDE.project.md`, this file, `run.ps1`, `docs/specs/`, `docs/designs/` |

The rules live in `Pull-SDLC.ai.ps1` as `$script:UpstreamManagedPaths`,
`$script:UpstreamPrivatePrefixes`, and `$script:AlwaysLocalPaths`. Do not
reason about sync behaviour from the file's location — **ask the predicates**:

```powershell
. .\Pull-SDLC.ai.ps1 -WhatIf *> $null
Test-IsAlwaysLocalPath     -Path '.github/ci/PesterGate.psm1'
Test-IsUpstreamPrivatePath -Path '.github/ci/tests/PesterGate.Tests.ps1'
```

## Where Repo-Private Tooling and Tests Go

Tests that exercise *this repo's own* internals must never land in a consumer
tree. Put them in a `tests/` (or `fixtures/`) directory under `.github/`, which
`$script:UpstreamPrivatePrefixes` treats as upstream-private at any depth:

```
.github/ci/PesterGate.psm1          <- tooling, not on the manifest
.github/ci/tests/PesterGate.Tests.ps1   <- upstream-private by pattern
```

Two independent guards, deliberately. Absence from `$script:UpstreamManagedPaths`
alone is protection by *omission* — a later decision to add a `.github` subtree
to the manifest would silently start shipping test files. The pattern rule holds
regardless of the manifest.

**Do not widen the upstream-private pattern past `.github/`.** A `tests/`
directory under `templates/` holds test-project *templates* the generator emits
into the consumer's own solution; those must keep shipping.

Note the asymmetry with the root: `Pull-SDLC.ai.Tests.ps1`,
`Consolidate-Specs.Tests.ps1`, `Consolidate-Tasks.Tests.ps1` and
`Start-IssueAgent.Tests.ps1` sit on `$script:UpstreamManagedPaths` and match no
private prefix, so they **do** ship today. That is a known wart, not a pattern
to copy — new tests go under `.github/`.

## Tech Stack

| Layer | Technology |
|---|---|
| Sync engine + repo tooling | PowerShell 7 (`Pull-SDLC.ai.ps1`, `Cleanup-Worktree.ps1`, `Start-IssueAgent.ps1`, `.github/ci/`) |
| Tests | Pester 5/6 (`*.Tests.ps1`) -- the only test framework here |
| Skill tooling under `templates/` | Node 20 (`capture-har.js`, `run-agent.js`), plus `*.test.js` |
| Emitted code templates | C# / .NET 10 `*.tmpl` files -- generated *into consumers*, never compiled here |
| CI | GitHub Actions (`.github/workflows/validate-instructions.yml`) |

There is no compiler and no application. `dotnet` appears in CI only to exercise the
project the generator emits.

## Domain Glossary -- the sync vocabulary

These terms are not interchangeable, and the distinctions decide whether a file reaches
a consumer's repo. All are defined in `Pull-SDLC.ai.ps1`.

| Term | Variable | Meaning |
|---|---|---|
| **Upstream-managed** | `$script:UpstreamManagedPaths` | Upstream owns it; changes are diff-replayed into consumers. An explicit allowlist -- a path not on it is invisible to the sync. |
| **Consumer-owned** / **always-local** | `$script:AlwaysLocalPaths`, `$script:AlwaysLocalPrefixes` | The consumer owns it. Never overwritten or deleted. **Trumps upstream-managed**, so a consumer-owned file can live inside a managed tree (this file does). |
| **Upstream-private** | `$script:UpstreamPrivatePrefixes` | Exists upstream, never ships. Filtered out of the op list *and* delete-replayed into consumers that received it before the carve-out. |
| **Merge-managed** | `$script:MergePaths` | Union-merged rather than overwritten: the consumer keeps its entries, new upstream entries are appended. Today only `.gitignore`. |
| **Scaffold** | `$script:TemplateScaffoldMap` | Seeded once from a `*.template` (or same-name) source if absent, then never touched again. How a consumer gets its own `README.md`, `CLAUDE.project.md`, and this file. |
| **Meta-script** | `$script:MetaScriptPaths` | Managed scripts whose mere presence must not be read as "this consumer already has managed content" -- they arrive via `iwr` to *perform* the bootstrap. |
| **Anchor** | -- | The last-synced upstream SHA in `.sdlc-ai-sync.json`. Sync is `git diff --name-status <anchor> <ref>`, so the anchor decides what counts as a change. `(empty tree)` means a full refresh. |
| **Diff-replay** | -- | Applying that anchor-to-tip diff as file ops (`A`/`M`/`D`/`R`) instead of merging, which is why a file unchanged since the anchor generates no op even if it should now be deleted. |

**Two traps this vocabulary sets, both hit for real:**

1. **"Not shipped" is not the same as "upstream-private."** A path absent from the
   managed allowlist does not ship *today*, but nothing records that intent -- adding its
   tree to the manifest later silently starts shipping it. Upstream-private is the
   guarantee that survives a manifest edit. Use both (issue #304).
2. **Upstream-private must agree with what gets pruned.** `Get-UpstreamPrivatePruneOps`
   inventories files to delete from consumers. When its scope was narrower than
   `$script:UpstreamPrivatePrefixes`, a file could be both never-shipped and
   never-deleted -- retained forever, and no longer diff-replayed, so it silently drifted.

**Never infer any of this from a file's location.** Ask the predicates:

```powershell
. .\Pull-SDLC.ai.ps1 -WhatIf *> $null
Test-IsAlwaysLocalPath     -Path '<repo-relative/path>'
Test-IsUpstreamPrivatePath -Path '<repo-relative/path>'
```

## The upstream remote is named `sdlc.ai`

`Pull-SDLC.ai.ps1` defaults `-RemoteName` to `sdlc.ai`, creates that remote on first
sync, and records it in `.sdlc-ai-sync.json` as `"remote": "sdlc.ai"`. That is the one
canonical name; use it in any new instruction or script.

Do **not** rename it. Every existing consumer has both the git remote and the recorded
manifest entry, so a rename is a migration (detect, rename, rewrite the manifest), not an
edit.

In *this* repository the remote is vestigial -- upstream does not sync into itself, and
the dev-loop pre-flight explicitly skips when run here.

## Build, Test, Format

There is no compiler. The suite is Pester, and CI runs it through the gate:

```powershell
# What CI runs (resolves test files itself; see below)
pwsh -File .github/ci/Invoke-PesterSuite.ps1 -Path ./.github

# A single file, while iterating
Invoke-Pester -Path (Resolve-Path .\.github\ci\tests\PesterGate.Tests.ps1).Path
```

**Never run `Invoke-Pester -Path ./.github`.** `.github` is hidden on Linux
(dot-prefix) and Pester's `Find-File` calls `Get-Item` without `-Force`, so the
path resolves to nothing. Every Pester 5.x and 6.x release behaves this way — a
version pin does not help. `Invoke-PesterSuite.ps1` resolves the files itself
and passes those. This is issue #304: the job reported success while running
zero tests for three months.

The root-level `*.Tests.ps1` are not covered by the CI job and must be run by
hand: `Invoke-Pester -Path (Resolve-Path .\Pull-SDLC.ai.Tests.ps1).Path`.

## Key Conventions

- **CI gate logic gets extracted and unit-tested.** Inline YAML cannot be
  tested, which is how a gate that never ran a test stayed green for months. If
  a workflow step makes a pass/fail decision, it belongs in `.github/ci/` with
  tests beside it.
- **A gate must detect its own absence.** "Did anything fail?" is not enough;
  ask "did anything run?" too. `$null.FailedCount -gt 0` is `$false`.
- **Editing a shipped file is editing every consumer's repo.** Prefer changing a
  default over adding an option, and keep project-specific names out entirely —
  the workflow's leak scan enforces this on shipped files only.

## Known Limitations / Don'ts

- Do not edit shipped instruction files to solve a problem local to this repo;
  that is what this file is for.
- Do not assume a new file under `.github/` is automatically synced *or*
  automatically private — check with the predicates above.
- `Pull-SDLC.ai.Tests.ps1` drives real `git push` against fixture remotes; its
  output is noisy by design. Read the final Pester summary, not the chatter.
