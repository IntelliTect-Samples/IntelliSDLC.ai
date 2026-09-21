# 475 -- the scrub leaves values its own substitution table says to replace

Issue: #475. Branch: `fix/475-substitution-survivors`.

## The defect, restated

`sanitize-har.js` writes `{key -> replacement}` into the legacy substitution
table. A key exists only because the scrub decided that value must be replaced.
The scrub then leaves occurrences of that same value standing in the output --
119 occurrences of one cookie value, 116 replaced, 3 left inside a 5.38 MB
response body; 128 occurrences of one field value, 1 replaced.

Nothing checks the output against the table. `verify-scrub.js` asks about
SHAPES and about profile LITERALS, and neither question reaches a value whose
only evidence is "the scrubber already said so".

## Two deliverables, not one

1. **The sweep (the fix).** After every other pass, replace every remaining
   occurrence of every original this run substituted, wherever it appears in
   the document. The survivors are bare values carrying no name and no shape,
   so no name-reach fix (#484, #330, #487) can ever reach them: only the
   scrubber's own record of the value can.
2. **The post-condition (the guard).** Assert that no original this run
   substituted survives in the document it is about to write. On a survivor,
   write NOTHING and exit non-zero. A guard alone would refuse every affected
   capture forever; a sweep alone would regress silently.

Plus the second, narrower defect: report non-reversible substitutions -- two
distinct originals collapsing onto one replacement.

## Design decisions

- **The check lives in `sanitize-har.js`, not `verify-scrub.js`.** The tables
  are written beside the RAW capture; the verifier only ever receives the
  scrubbed path, so it structurally cannot find them. Giving it a `--subs`
  option would be a new command-line option, which needs owner approval.
- **Originals are RECORDED, never parsed back out of keys.** Key spellings
  differ per call site (`kind:name:value`, `kind:match`) and values contain
  colons, so parsing is wrong by construction. A parallel in-process map from
  key to original is exact.
- **This run's table only, never the merged historical table.** The merged
  table holds other captures' credentials -- a different question with a
  different false-positive profile.
- **Parsed string leaves, not serialized text.** JSON escaping would defeat a
  literal match, and the walk yields entry index and JSON key path for free.
- **One length floor (8) for sweep and check**, named once. Shorter values stay
  name- and shape-scrubbed only.
- **Encoded axes are out of scope** for both. A value that survives only inside
  a percent-encoded or base64 blob belongs to the gate's shape checks.
- **Values, never printed.** Findings carry kind, key namespace, entry index,
  JSON path, length and count. The table's keys are the plaintext credential
  store; iterating them is fine, emitting them is not.

## Tasks

- [x] `har/subs-survivors.js` -- record/sweep/check/collision, pure, importable.
- [x] `sanitize-har.js` -- record originals at each substitution site; run the
      sweep after the typed-PII pass; run the check before any write; refuse.
- [x] `har/subs-survivors.test.js` -- behavior-first, zero-dep.
- [x] `.github/agents/tests/subs-survivors.Tests.ps1` -- Pester wrapper.
- [x] Evidence: before/after on a fixture reproducing the datr survivor.

## Changed during implementation

The floor is **16**, not the issue's suggested 8. An independent review of the
first cut found the sweep rewriting ordinary prose: the scrub captures a value
by its field NAME, and #529 records a locale bundle whose `"Password"` key
holds the UI label `"Password"`. Sweeping an eight-character English word
globally turns `Forgot Password?` into a redaction sentinel -- this issue's own
fix re-creating #529's defect on the axis it did not consider. Sixteen is
`COOKIE_TOKEN_MIN_LENGTH`, this tree's existing "token-ish or prose" answer,
and both survivors #475 measured are longer (17 and 24).

The **typed-PII table is out of scope** and now says so in both files. `pii.js`
returns hash prefixes rather than originals -- deliberately, so its table is
safe to commit -- so its substitutions cannot feed either half of this check.
The same class of survivor remains unguarded for typed PII.
