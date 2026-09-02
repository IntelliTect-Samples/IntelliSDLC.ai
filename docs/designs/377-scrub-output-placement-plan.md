# #377 -- scrub output placement, stamping, and the link back to the raw

Implementation plan for
[issue #377](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/377).
The issue is the specification; this file records what was built, the one
decision the issue deliberately left open, and how each assertion was falsified.

## The defect, restated

`resolveDefaultOutputRoot` anchored the default output path to the top level of
whichever work tree the recorder was run from. Run from a checkout root, a
capture created an untracked, un-gitignored `<host>/` directory there holding
`scrubbed.har`, `digest.json` and `catalogue.json`. The comment above that
function already conceded the gap: anchoring makes placement **predictable, not
correct**. The recorder warned; the files landed anyway.

Three defects lived in the same place:

- the output was **unstamped**, so a second capture against one host silently
  overwrote the first's scrubbed artifact;
- nothing linked a committed reference back to the raw it came from (an audit
  in a consuming project found **0 of 29** references adjudicable);
- `current.json` was a **single shared pointer** at the captures root, in a
  store several agent sessions record into at once.

## What was built

| # | Change | Where |
|---|---|---|
| 1 | Default output path becomes the run's own **stamped session directory** | `capture-har.js` `resolveSessionPaths` |
| 2 | An explicit `--output-path` inside a work tree and not gitignored **warns**, names the resolved path, says why, and proceeds | `outputDestinationWarning`, reusing `classifyDestination()` |
| 3 | The capture store must be gitignored before anything records: prompt when interactive, **hard-fail** when not | `ensureCapturesRootIgnored`, reusing `ensureRepoRootGitignoreHasScaffoldEntries` |
| 4 | `current.json` removed; `resolveSession` prefers the newest **live** session, else the newest stamp | `resolveSession` |
| 5 | The recorder **prints the catalogue table** and the "still a scaffold" notice | `catalogueTableLines`, `isScaffoldOnly` |
| 6 | The run prints a ready-to-paste `extract-har-reference.js` command and the suggested catalogue row, and writes nothing into the reference tree | `describeReference`, `referenceNoticeLines` |
| 7 | The intended reference path is recorded in `catalogue.json`'s existing `HarFile`, as `<provider>/<filename>` | `buildCatalogueScaffold`, `referenceRelativePath` |
| 8 | The front door defers the display to the recorder and reads the catalogue path from a one-line JSON handoff on stdout | `Invoke-HarCapture.ps1` |

Nothing new is written under an existing `.har-captures/` other than the run's
own session directory, and `publishFile` short-circuits when source and
destination are now the same path.

## The one open question, and how it was settled

The issue's second comment left `§5` **undecided**: `extract-har-reference.js`
refuses to run without `--match`, and an automatic promote step has no selector
to give it. Three options were listed, with a stated leaning toward the second
or third.

**Option 2 was taken: the run PRINTS the ready-to-paste command and stops.**

- Option 3 ("promote when a selector is supplied") requires a new
  command-line option, which needs explicit human approval and was not
  available.
- Option 1 (derive selectors from `digest.json`) is the option the issue itself
  warns about: a selector that "looks right" is plausible, unverifiable, and
  wrong in a way nobody notices until somebody relies on it.
- Option 2 needs no new option, commits no multi-hundred-megabyte file where a
  20 KB extract belongs, and keeps the human holding the one decision a machine
  cannot make well.

`§6`'s consequence was handled by recording the **deterministic** reference
path (`<provider>/<provider>-<action>-<yyyy-MM-dd>.har`, exactly what the
extractor writes and where it writes it) in `HarFile` at scaffold time.
`catalogue.json` now lives in the gitignored session directory, so the field
names the file the printed command produces rather than making a claim inside a
committed artifact.

## The layout: NESTED, decided after #379 and #382 landed

While this branch was open, #379 (a committed, structured per-host
`catalogue.json` with a generated `README.md`) and #382 (a generated
per-provider `api.json`) merged. The two descriptions of the reference tree had
to be reconciled, and the resolved layout is **nested**:

```
.har-captures/<host>/<stamp>/        gitignored -- the run's own record
  raw.har  scrubbed.har  digest.json  catalogue.json

docs/har-reference/<host>/           tracked -- trimmed extracts only
  catalogue.json                     committed source of truth (#379)
  README.md                          generated from catalogue.json (#379)
  <provider>/
    README.md                        provider scrub policy + re-capture recipe
    api.json                         generated server description (#382)
    <provider>-<action>-<yyyy-MM-dd>.har
```

Both halves of the reconciliation are load-bearing: this issue's
gitignored/tracked split applies (`scrubbed.har` is **never** committed -- a
reference runs 3 KB - 60 KB against captures of 277 MB - 1.6 GB), and #379/#382's
provider nesting applies (one host routinely spans several third-party APIs, and
#382 reads a provider directory as one API).

### `HarFile` records `<provider>/<filename>`, not the bare filename

The field exists so a committed reference can be paired back to the capture it
came from, which means the value has to still be correct **after** promotion
into `docs/har-reference/<host>/catalogue.json`. #379 already defines `HarFile`
as a path relative to that catalogue, and `verify-har-catalogue.js` resolves it
with `path.join(<catalogue dir>, HarFile)` against `listReferences()`, which
walks provider subdirectories and yields forward-slashed `<provider>/<file>`.

A bare filename therefore would not resolve at all -- the extract sits one level
below the catalogue -- and would be ambiguous the moment a host carries two
providers. The provider still appears in the filename as well, for the reason
the reference README already gives: the directory is invisible once the file is
opened, attached to an issue, or pasted into a diff.

Forward slash, always: this is a JSON value read on every platform, matching the
existing note in `har-catalogue.js` that `HarFile` values "are not Windows
paths".

### No collision with #379 or #382

- `verify-har-catalogue.js` (#379) already handles both layouts explicitly --
  `listReferences()` documents provider subdirectories as "today's upstream
  shape". Nesting is what it expects.
- `generate-api-document.js` (#382) is pointed at a **provider** directory and
  reads the flat `*.har` files in it. Nesting is what makes that directory hold
  exactly one provider's references.

Neither file was modified.

## Verification

`.github/agents/tests/HarCaptureOutputPlacement.Tests.ps1` (CI wrapper) ->
`templates/web-api-discovery/scripts/capture/capture-output-destination.test.js`
(23 assertions: 12 falsifiers, plus guards).

Every falsifier was **ablated**: the behaviour it names was broken, the suite
was watched to fail on that assertion, and the change restored. Twenty mutants,
twenty killed, none surviving. The F11 mutant needed a support hook (a
`sampleUrl` on the digest group) because without one the mutation would have
changed nothing -- which is the "absent test wearing a green tick" trap this
subsystem has already produced.

## Not in scope

The committed catalogue format and README generation (**#379**), the
per-provider `api.json` (**#382**), in-artifact scrub provenance (**#381**), and
pruning `.har-captures/` for size. Nothing here writes `catalogue.json` or
`api.json` into a reference directory.
