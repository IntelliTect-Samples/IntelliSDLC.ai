# Structured HAR reference catalogue

- Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/379
- PR:    (filled in once the PR exists)
- Slug:  379-structured-catalogue

## Overview

The committed HAR reference catalogue is prose in a `README.md` table, so a row's
claims about a reference can only be checked for *existence*, never for *truth*.
Make the committed catalogue structured (`catalogue.json`), generate the
human-facing table from it, and add a guard that recomputes each row's facts from
the `.har` it names.

## Approved Design

### 1. The catalogue is `catalogue.json`, and its entries stay flat

`buildCatalogueScaffold` already emits the row shape and
`ConvertFrom-HarCatalogue.ps1` / `HarCapture.Format.ps1xml` already consume it.
Keep those top-level fields and **add** the missing machine-checkable ones rather
than nesting a new `Evidence` block, which would duplicate three fields that
already exist and churn the PowerShell surface for nothing.

| Field | Half | Recomputed by the guard |
|---|---|---|
| `Action` | human | no |
| `Description` | human | no |
| `Status` (`Observed` / `Exercised`) | human | no |
| `Provider` | human | no (checked against the `HarFile` path) |
| `Related` (issue numbers) | human | no |
| `HarFile` (path relative to the catalogue) | link | existence only |
| `CapturedUtc` | provenance | no |
| `Methods` | fact | **yes** |
| `Endpoints` | fact | **yes** |
| `EntryCount` | fact | **yes** |
| `RequestBodies` | fact | **yes** |
| `RequestBytes` / `ResponseBytes` | fact | **yes** |
| `RequestBodiesAbsent` (written reason) | human | escape hatch, see 3 |

`HarFile` is relative to `catalogue.json`, so the same catalogue works whether the
references sit in provider subdirectories (today's upstream layout) or flat beside
it (the layout drawn in the issue).

### 2. The README table is a rendering, and only the table

`render-har-catalogue.js --dir <catalogue dir>` writes the table between markers:

```
<!-- BEGIN GENERATED CATALOGUE -- edit catalogue.json, not this table -->
<!-- END GENERATED CATALOGUE -->
```

Everything outside the markers is hand-written and never touched: the naming
convention, the provenance notes, the re-capture recipe, the
"Observed, not exercised" prose.

- README absent -> create it with the markers and the table.
- README present **without** markers -> **fail loudly** and name the file. Do not
  guess where the table goes; guessing is how a generator eats a paragraph.
- Rendering is deterministic (rows sorted by `Provider`, then `Action`, then
  `CapturedUtc`), so regenerating an unchanged catalogue is byte-identical.

### 3. `verify-har-catalogue.js --dir <catalogue dir>` is the guard

It carries both checks, so a consumer wires ONE command into CI. This issue owns
the staleness mechanism; #382 reuses it for `api.json` rather than growing a
second one.

**Truth check** -- for each entry:

- a. `HarFile` names a file that exists (else fail).
- b. every `.har` under the directory is named by exactly one entry (else fail --
     a reference with no row, or two rows claiming one file).
- c. `Methods`, `Endpoints`, `EntryCount`, `RequestBodies`, `RequestBytes`,
     `ResponseBytes` are **recomputed from the file** and must match what the row
     declares. This is the assertion the prose table could never make.
- d. **The falsifier.** A row whose recomputed `Methods` include a body-bearing
     method (`POST` / `PUT` / `PATCH`) while `RequestBodies == 0` FAILS, unless
     the entry carries `RequestBodiesAbsent: "<reason>"`. Derived from the file,
     not self-declared, and not matched against prose. This is what the four
     hollow entries fail on.

     The escape hatch is not politeness: `POST /logout` with no body is legal
     traffic, and SKILL.md already records that a gate firing on real captures
     gets disabled, costing every other check it carries. Silencing it costs a
     human a written sentence.

**Staleness check** -- re-render the README from the committed `catalogue.json`
and fail if it differs from what is committed. A re-scrubbed reference cannot
leave a generated table describing the previous one.

"Has a request body" reuses `bodyCarriesPayloadStructure()` from
`verify-har-reference.js` -- the grammar recogniser written for gate 7 -- rather
than a second opinion about what a body is. It moves to the shared library so both
callers share one definition.

### 4. Not in this PR

- **Placement consolidation.** Whether the guard eventually folds into
  `verify-har-reference.js` as gate 8 -> follow-up issue.
- **The promote seam.** #377 promotes the `.har` and prints the suggested row;
  replacing that print with generation is a small follow-up once both are on
  `main`. Building it here would couple this PR to an unmerged branch.
- **Consumer migration.** The four provider READMEs and their four hollow
  entries are the consuming project's #862.

### New command-line options (require approval before implementation)

| Script | Options |
|---|---|
| `render-har-catalogue.js` | `--dir <path>` (default `.`) |
| `verify-har-catalogue.js` | `--dir <path>` (default `.`) |

No other flags. The staleness check is not a flag on the renderer -- it lives in
the verifier, so CI runs one command and the renderer stays a writer.

## Evidence Plan

- **Change type**: CLI (Node scripts) + library
- **Artifact format**: Inline -- `cli-evidence.md`, the guard run against a
  fixture directory holding one honest reference and one hollow one, showing the
  hollow row failing and the honest one passing
- **Capture command**: `node verify-har-catalogue.js --dir <fixture>` and
  `node render-har-catalogue.js --dir <fixture>`
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [ ] A catalogue entry declaring `POST` on a reference with zero request bodies
      FAILS the guard (the falsifier).
- [ ] The same entry PASSES once `RequestBodiesAbsent` carries a written reason.
- [ ] A declared `EntryCount` / `Methods` / `Endpoints` / `RequestBodies` /
      `RequestBytes` / `ResponseBytes` that disagrees with the file FAILS
      (one assertion each).
- [ ] A `.har` on disk named by no entry FAILS.
- [ ] An entry naming a `.har` that does not exist FAILS.
- [ ] Two entries naming the same `.har` FAIL.
- [ ] Regenerating the README from an unchanged catalogue is byte-identical.
- [ ] Hand-written prose outside the markers survives regeneration untouched
      (ablated specifically).
- [ ] A README with no markers FAILS rather than being rewritten.
- [ ] A committed README that does not match a re-render FAILS (staleness).
- [ ] Every assertion above is ablated -- break what it checks, watch it fail,
      restore -- and the ablation reported per assertion.

## Implementation Checklist

- [ ] Task 1 -- `har/har-catalogue.js`: read/normalise a catalogue, `measureReference()`
      (facts from a `.har`), `renderTable()`. Move `bodyCarriesPayloadStructure`
      here and have `verify-har-reference.js` require it.
- [ ] Task 2 -- `har/render-har-catalogue.js` + marker handling (create, replace,
      fail on missing markers).
- [ ] Task 3 -- `har/verify-har-catalogue.js`: coverage both ways, recomputed-fact
      comparison, the falsifier + escape hatch, staleness.
- [ ] Task 4 -- extend `buildCatalogueScaffold` (capture-har.js) to emit the new
      fields; extend `ConvertFrom-HarCatalogue.ps1` and `HarCapture.Format.ps1xml`.
- [ ] Task 5 -- zero-dep node tests: `har-catalogue.test.js`,
      `har-catalogue-render.test.js`, `har-catalogue-verify.test.js`.
- [ ] Task 6 -- Pester wrapper `.github/agents/tests/har-catalogue.Tests.ps1`
      (Pester is the only suite CI runs; a node test with no wrapper never runs).
- [ ] Task 7 -- SKILL.md Phase 3.5 and `catalogue-prompt.md`: the catalogue is the
      source of truth, the README is generated, the guard is the gate.
- [ ] Task 8 -- ablation pass over every assertion, recorded in the evidence.
- [ ] Task 9 -- file the follow-up issue for guard placement consolidation.
