# 2026-05-15 -- envelope unwrap (issue #64) implementation plan

## Scope
Add envelope detection + unwrap to the api-wrapper-scaffold codegen so generated
typed methods return the inner payload (`T` or `IReadOnlyList<T>`) when the
response is a simple single-payload envelope.

## Files
- ADD `templates/api-wrapper-scaffold/scripts/envelope.test.js` -- zero-dep node tests
- MODIFY `templates/api-wrapper-scaffold/scripts/generate-wrapper.js`
  - add `detectEnvelope(shape)` near JSON shape inference section
  - export it from module.exports
  - use it in the `run()` per-pattern loop to set `p.envelope` and adjust
    `p.responseModel` while keeping the wrapper model registered
  - update `emitClient` typed-method body to deserialize wrapper then return the
    PascalCase property when `p.envelope` is present
- ADD `.github/agents/tests/envelope-unwrap.Tests.ps1` -- pester wrapper

## Heuristic
Field classification:
- substantial: object with >=1 field (non-metadata-shaped), or array of objects,
  or array of primitives whose KEY does not match metadata-name regex.
- metadata: primitive scalar; object whose every field is a primitive scalar;
  array whose key matches metadata-name regex; key matches metadata-name regex.

Metadata-name regex (case-insensitive, word-anchored):
`^(count|total|page|pages|cursor|next|prev|previous|has_?more|timestamp|status|offset|limit|size|per_?page|total_?pages|total_?count|page_?size|errors?|meta|pagination|links?|info)$`

Conservatism:
- exactly ONE substantial field required
- top-level field count in [1, 5]
- pascalCase(payloadField) must not collide with pascalCase of any sibling key
- if any field is non-trivial but not classified as metadata AND isn't the
  payload candidate, abstain
