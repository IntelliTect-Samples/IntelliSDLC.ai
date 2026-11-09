# Consolidate-Specs keeps the date prefix and chronological order

- Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/174
- PR:    https://github.com/IntelliTect-Samples/IntelliSDLC.ai/pull/595
- Slug:  174-consolidate-specs-date-order

## Overview

`Consolidate-Specs.ps1` strips a leading `YYYY-MM-DD-` prefix from every
imported legacy spec (`Get-FeatureSlug`, line 57), so a corpus of dated design
notes lands in `docs/specs/` and `docs/designs/` under undated names. The date
was the only chronological signal those files carried, and it is recorded
nowhere. This ports the fix from PR #175, which cannot be rebased: all three
files it edits were renamed or retired (#182, #184).

## Approved Design

The owner's decision on #175 (2026-09-06): revive, as a port rather than a
rebase. Scope is the issue's own Fix list, re-pointed at the renamed script.

1. **Keep the embedded date.** `Get-FeatureSlug` no longer strips a leading
   `YYYY-MM-DD-`, so `tasks/2026-04-12-foo-plan.md` lands at
   `docs/designs/2026-04-12-foo-plan.md`. Undated sources keep today's names.
2. **Record a Source Date.** A new `Get-SourceDate` resolves, in order: the
   embedded prefix; else the author date of the commit that **first added**
   the file (following renames); else the file's last-write time (UTC). Every
   migration record carries it, and `docs/MIGRATION.md` gains a leading
   `Source Date` column with rows sorted by it (undated last, then by source).
3. **Docs.** Comment-based help and the upstream `docs/README.md` migration
   section describe both.

Decisions:

- **The first-added date, not the last-modified one** (#175 used the most
  recent commit). A bulk rename or reformat commit gives every file the same
  last-modified date, which would erase the ordering this fixes; the #184
  rename itself is such a commit. The first-added date also means the same
  thing as an embedded prefix: when the note was written.
- **No `-InsertDatePrefix` switch.** #175 added one to synthesize filename
  prefixes for undated sources. A new command-line option needs owner approval
  first, and synthesizing names was not in this issue's Fix list. Undated
  sources get their date in the manifest instead, which is where the issue
  puts it.
- **New `@prd` / `@plan` files are out of scope, and already settled.** #175
  asked whether they should carry a sortable prefix. The #182 convention names
  them `<issue#>-<slug>`, and `plan.agent.md` / `prd.agent.md` already fall
  back to a `*-<slug>-*.md` glob, which also finds a dated legacy file.

## Evidence Plan

- **Change type**: CLI script output plus a generated markdown file.
- **Artifact format**: captured console output and the generated
  `docs/MIGRATION.md`, from a real run against a throwaway git repo seeded
  with dated, undated, and renamed legacy specs.
- **Capture command**: a scratch script that builds the repo, runs
  `Consolidate-Specs.ps1 -Confirm:$false` against it, and prints the
  destination listing and the manifest.
- **Entry-point file**: `.evidence/174-consolidate-specs-date-order/evidence.md`

## Acceptance Criteria

- [x] `tasks/2026-05-12-alpha-plan.md` is moved to `docs/designs/2026-05-12-alpha-plan.md`.
- [x] An undated source keeps its current destination name.
- [x] Every record has a `SourceDate`: embedded prefix > first-added git author date (across a rename) > last-write time.
- [x] A file outside any git repository, untracked inside one, or whose git call throws, falls back to its last-write time without error.
- [x] `docs/MIGRATION.md` has a `Source Date` column and lists rows oldest first, even when discovery order differs.
- [x] Session copies record their plan's last-write date.
- [x] Existing behavior holds: `-WhatIf` writes nothing, re-runs are idempotent, collisions get a hash suffix.

## Implementation Checklist

- [x] Red: update the `Get-FeatureSlug` tests that pin the stripped date; add `Get-SourceDate`, integration and manifest-ordering tests.
- [x] Green: stop stripping in `Get-FeatureSlug`; add `Get-SourceDate`; thread `SourceDate` through `New-MigrationRecord`, both import helpers, and `Write-MigrationManifest`.
- [x] Docs: script help and `docs/README.md`.
- [x] Full Pester run of the repo-root suites; functional run against a throwaway repo.
- [x] Independent review (Sonnet 5.5): git-throws fallback accepted and fixed test-first; re-review clean.
