# Scrubbing must clean secrets, not refuse the artifact

- Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/454
- PR:    https://github.com/IntelliTect-Samples/IntelliSDLC.ai/pull/472
- Slug:  454-scrub-clean-not-gate

## Overview

`Invoke-HarCapture.ps1`'s verify-scrub step gated 3 of 3 real captures in one
day. **None of the gated values was unremovable** — the scrubber already had a
rule for every one of them. It never descended to where they sat. This change
gives the gate and the scrubber **one** nested-payload traversal, so their
reach is equal by construction rather than by two walks happening to agree.

## Root cause — three reach gaps, each reproduced before any code was written

**D1 — fails CLOSED.** `sanitize-har.js:401` recursed only when
`looksFormEncoded(out)` held. That predicate's character class
`[^=&\s{[\]}"]` excludes `{` and `"`, so once the scrubber decoded a form
parameter and landed on a JSON document it could never re-enter, at any depth.
`har-secrets.js:322` had no such limit. Reported as
`hex32 [secret] at entry N (inside encoded request.postData.text)`.

**D2 — fails CLOSED.** A JSON document carried as a JSON *string* value. The
gate parses it; the scrubber's `jsonFieldRe` sees only the escaped spelling
`\"datr\":\"` and cannot match it. Reported as `known-secret: datr`.

**D3 — fails OPEN, and therefore worst.** `har-literals.js:162` percent-decoded
unconditionally before parsing, so an already-decoded JSON document containing
a bare `%` was unreadable — to **both** engines. The secret survived the scrub
*and* the gate reported the artifact clean.

## The axis distinction that governs scope

|  | gate | scrubber | direction |
|---|---|---|---|
| #378 | did NOT decode form params | already decoded them | fails open |
| #395 | detects `pwd-envelope` | no shape rule for it | fails closed |
| **#454** | descends past JSON | stops at one form-body layer | fails closed |

Two parity axes; #408 names only one:

- **rule parity** — does each engine know this is a secret? (#395, #408)
- **reach parity** — does each engine get to where it sits? (#378, #454)

**#408's shape-table test passes on every fixture here** while the capture
still gates, because `hex32` and `datr` are already in both tables. #408 stays
open for the rule axis; #439 and #441 are rule-axis and stay out.

## Approved Design (as built)

1. **`har-nested.js` — one traversal, two modes.** `transformNested(text,
   visit, opts)` walks the encoding layers inside one string: form body → JSON
   document → wholly percent-encoded payload. Read-only mode is a caller whose
   `visit` returns its input, so the gate shares the walk without gaining the
   ability to rewrite.
   - **Byte preservation** — an unchanged subtree returns its ORIGINAL bytes.
   - **One exported `MAX_DEPTH` (8)**, used by both. The parity guarantee.
     Hitting it fires `onDepthLimit`, which the gate turns into a finding —
     a traversal that stops early in silence is a gate that fails open.
   - **A `{name, value}` pair is keyed by its SIBLING.** Resolved in the
     traversal, not in either caller, so both engines act on it.
2. **Both engines adopt it.** `har-secrets.js` re-exports `looksFormEncoded`
   from the traversal rather than keeping a second definition.
3. **`decodeNestedJson` parses first**, percent-decodes only as a fallback.

### Deliberately rejected

The issue's literal item 3 — "label the leaky file and let policy decide" —
puts a credential-bearing file in the committable output path behind a label.
A bulk `git add` beats a label, and the file still cannot be shared.

### Deliberately deferred — the blunting fallback

Blocked on **#456**'s `verify-scrub.js` row. The fallback needs the
gating-vs-advisory classification, which lives inside `verify-scrub.js`'s
`main()` (`blocks`, `isAdvisory`, the split at line 245) — a bare `main()` with
no `require.main` guard and no exports. Building it now means a second copy of
the gating classification in the scrubber, which is the drift class this change
exists to close. Recorded on #456.

All three gating causes actually reported on #454 are fixed without it.

## Evidence Plan

- **Change type**: bug fix (CLI / library)
- **Artifact format**: markdown — before/after on the same fixture, exit 3 → 0
- **Capture command**: `Publish-Evidence.ps1` with the stock bug-fix template
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [x] `hex32` at JSON → urlencoded JSON is scrubbed; verify exits 0 (D1)
- [x] `datr` inside a JSON document carried as a JSON string is scrubbed (D2)
- [x] Already-decoded JSON containing `%XX` is detected **and** scrubbed (D3)
- [x] Gate and scrubber derive one exported `MAX_DEPTH`
- [x] A nested `{name, value}` pair is removed, and the gate accepts the result
- [x] `sanitize-har.js` carries no private `looksFormEncoded`
- [x] Full existing suite green — 47/47 node suites
- [ ] Blunting fallback — deferred to #456, see above

## Implementation Checklist

- [x] **Stage 0** — D1/D2/D3 pinned as failing tests, each watched fail
- [x] **Stage 1** — `decodeNestedJson` parses before decoding
- [x] **Stage 2** — `har-nested.js` + exported `MAX_DEPTH`
- [x] **Stage 3** — gate adopts it in visitor mode
- [x] **Stage 4** — scrubber adopts it; private predicate deleted
- [x] **Stage 5** — Pester wrapper so the suite reaches CI
- [ ] **Stage 6-7** — blunting fallback + advisory-exclusion test (blocked on #456)
- [x] **Stage 8** — evidence + docs

## Ablations

| Ablation | Observed |
|---|---|
| Shared descent removed from the scrubber | fails at `0.b` |
| `decodeNestedJson` decodes before parsing again | fails at `4.b`, alone |
| `{name, value}` keyed by its own key | fails at `5.b` |
