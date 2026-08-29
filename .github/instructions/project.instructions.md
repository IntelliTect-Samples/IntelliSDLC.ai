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
