# Issue #63 -- Nullability Heuristic for Generated Record Properties

## Problem
`generate-wrapper.js` infers C# record properties as non-nullable even when JSON evidence shows the value can be `null` or the key can be absent across samples.

## Approach
Track nullability at the **field level** on object shapes (independent of the primitive `shape.nullable` flag). Emit a `?` on the C# property when either:
- The field was absent in at least one sample (`f.optional === true`), OR
- The field value was `null` in at least one sample (`f.nullable === true`).

## Changes to `templates/api-wrapper-scaffold/scripts/generate-wrapper.js`

1. `inferShape` (object branch): set `fields[k].nullable = val[k] === null`.
2. `mergeShapes` (object branch): propagate `nullable` via OR across both sides; default to current side's value when only one is present.
3. `shapeSignature`: include `nullable` so distinct-nullability records do not get deduped.
4. `emitModels`: append `?` to the C# type when `f.optional || f.nullable` (preserving the existing endsWith check).
5. Export `registerModel` and `emitModels` for tests.

## TDD
- New file: `templates/api-wrapper-scaffold/scripts/nullability.test.js` (Node `assert`, zero-dep).
  - All-present-non-null -> non-nullable.
  - Null in >=1 sample -> nullable (string).
  - Absent in >=1 sample -> nullable.
  - Mixed (some null, some present, some absent) -> nullable.
  - Value types (int, bool) follow same rule -> `int?`, `bool?`.
- New file: `.github/agents/tests/nullability-heuristic.Tests.ps1` (Pester wrapper that runs the Node test).

## Evidence (Phase 5b)
Run `scripts/run-dogfood.ps1` with the TripIt synthetic HAR, capture before/after counts of nullable properties on Profile / Trip records.

## Branch + PR
- Branch `feat/63-nullability-heuristic`
- PR title `feat(api-wrapper-scaffold): nullability heuristic for record properties`
- Body `Closes #63`
- Merge: rebase-only.
