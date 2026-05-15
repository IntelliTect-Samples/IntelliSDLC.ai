# 2026-05-15 -- Named-segment classifier in generate-wrapper.js (Issue #62)

## Problem

`dedupePatterns` in `templates/api-wrapper-scaffold/scripts/generate-wrapper.js` treats
*any* path segment that varies across HAR entries as `{id}`. On the TripIt dogfood
synthetic HAR, all 7 endpoints collapse into 2 templated patterns -> 0 typed methods.

## Approach

1. Introduce two helpers in `generate-wrapper.js`:
   - `isOpaqueIdLike(seg)` -- numeric, hex, UUID, long hex, or base64-ish noise lacking
     vowels.
   - `isNamedSegment(seg)` -- `^[A-Za-z][A-Za-z0-9]{2,}$` AND not opaque.
2. Refactor `dedupePatterns` so each (method, host, segCount) group is processed by a
   recursive helper:
   - If any varying segment index has values where at least one is a named segment and
     none are opaque -- split the group by that segment value and recurse for each
     subgroup (each becomes its own pattern with literal segments at that index).
   - Otherwise build segDescs as before (intrinsic param / single literal / opaque
     varying -> `{id}`).
3. Leave `methodNameFor` unchanged -- it already produces `GetAppConfigAsync` etc.
   for literal-only patterns.

## Tasks

- **A.** Add `templates/api-wrapper-scaffold/scripts/dedupe-patterns.test.js` -- a
  zero-dep Node `assert`-based test that loads the module, feeds a synthetic 7-entry
  TripIt-shaped pattern list, and asserts `>= 5` patterns whose segments are all
  literal. **Watch it FAIL.**
- **B.** Implement `isOpaqueIdLike`, `isNamedSegment`, and the group-splitting recursion
  in `dedupePatterns`. **Watch the test PASS.** Run full Pester suite for
  `codegen-pipeline.Tests.ps1` to confirm no regression.
- **C.** Wire the JS test into Pester: add `.github/agents/tests/dedupe-patterns.Tests.ps1`
  that shells out to `node dedupe-patterns.test.js` and asserts exit 0.
- **D.** Phase 5b evidence: run `scripts/run-dogfood.ps1 -Mode synthetic -Reference <stub>`
  capturing before/after endpoint coverage.

## Files touched

- `templates/api-wrapper-scaffold/scripts/generate-wrapper.js` (modify `dedupePatterns`)
- `templates/api-wrapper-scaffold/scripts/dedupe-patterns.test.js` (new)
- `.github/agents/tests/dedupe-patterns.Tests.ps1` (new)

## Acceptance

- Node test asserts >= 5 literal-only patterns; exits 0.
- `codegen-pipeline.Tests.ps1` still green.
- Dogfood synthetic HAR produces >= 5 typed methods named after the segment.
