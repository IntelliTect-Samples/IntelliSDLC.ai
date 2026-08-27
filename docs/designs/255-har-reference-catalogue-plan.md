# HAR Reference Catalogue, Scrub Hardening, and Capture Lessons

- Issue: https://github.com/IntelliTect-Dev/IntelliSDLC.ai/issues/255
- PR:    (filled in once the PR exists)
- Slug:  255-har-reference-catalogue

## Overview

Issue #255 reports three bodies of lessons from live HAR-capture sessions:
Part A (a HAR *reference catalogue* convention), Part B (scrub hardening --
literal-value scrubbing as a control distinct from key-name scrubbing), and
Part C (17 capture/interpretation lessons).

**Part C is already shipped.** Commit `c1ae87c` ("docs(api-wrapper-scaffold):
improve HAR capture/analysis guidance") landed C.1-C.16 in
`.github/skills/api-wrapper-scaffold/SKILL.md` (sections "Capturing traffic
reliably", "Interpreting captured responses", "Verifying with capture-derived
probes", the Phase 6 generator bullets, and the Phase 8 secret inventory =
B.1). This plan therefore covers **Part A and Part B only**, plus the
A.5 tooling defects and C.17.

## Approved Design

### 0. Approved CLI design (shared across all HAR scripts)

The literal map is needed by *four* tools. Passing it as a flag to each would
add four options; instead **one gitignored operator profile** carries every
per-operator secret, auto-discovered upward from the working directory:

```json
// .har-profile.json  -- gitignored, operator-owned, NEVER committed
{
  "salt": "<project salt>",
  "literals": {
    "<account-id>":   "<AccountId>",
    "<display-name>": "<DisplayName>"
  }
}
```

Missing or empty profile -> **hard fail naming the file**. There is no default
literal map and no default salt: baking an operator's real account identifier
into a committed script is exactly what account-hygiene rules forbid, and a
maintainer who meets an awkward required input will otherwise be tempted to
helpfully supply a default.

Resulting surfaces (back-compat explicitly waived; `--salt` is retired):

| Script | Required | Optional |
|---|---|---|
| `sanitize-har.js` | `--in` | `--out` (default `samples/har/<name>.har`), `--subs`, `--pii-subs`, `--profile`, `--fixed-time` |
| `verify-scrub.js` | `--in` | `--profile` |
| `extract-har-reference.js` | `--in`, `--match` (repeatable) | `--out`, `--provider`, `--action`, `--max-response-bytes` (default 65536), `--profile` |
| `verify-har-reference.js` | -- | `--dir` (default `docs/har-reference/`), `--profile` |

`extract-har-reference.js` exits `2` with no selector and `3` when the
selector matches nothing -- it never writes an empty reference.
`Invoke-SanitizeHar.ps1` and `run-agent.js` drop `-Salt` / `--salt` and read
the profile instead (removing `run-agent.js`'s hardcoded default salt).

### 1. Part B.2 -- literal-value scrubbing (correction, not addition)

Key-name scrubbing can only redact values whose name was anticipated. Two
classes escape it: secrets nested inside a percent-encoded JSON parameter,
and the same identifier appearing under several names (one undocumented).
Fix = a **second, independent control**:

- New shared module `templates/api-wrapper-scaffold/scripts/har-literals.js`:
  - `parseLiteralMap(spec)` -- parses `literal=SENTINEL` pairs (from a file or
    inline list) into an ordered map. **No defaults, ever** -- these are the
    operator's own account identifiers and must never be committed.
  - `applyLiteralPass(serialized, map)` -- replaces each literal **and its
    percent-encoded form** over the *serialized* entry, so one sweep covers
    URLs, headers, request bodies and response bodies.
  - `decodeNestedJson(value)` -- percent-decodes a parameter value and, if it
    parses as JSON, returns the object for recursive key-name scrubbing.
- `sanitize-har.js`: run `decodeNestedJson` over form/query parameter values
  so key-name scrubbing reaches nested JSON; then apply the literal pass
  **last**, over the serialized output.
- `verify-scrub.js`: accept the same literals as **forbidden values** and fail
  on a hit **without echoing the offending value** (echoing relocates the leak
  into CI logs). Also walk decoded JSON parameter values for named secrets.

### 2. Part B.3 -- do not over-redact placeholders

A verifier that flags `client_mutation_id: "1"` or `actor_id: "0"` trains
readers to ignore it. Exempt values below a plausible minimum length
(`MIN_SECRET_LENGTH`) from the name-based checks. Shape-based patterns
(JWT/hex64/email) are unaffected -- they already imply length.

### 3. Part A -- the HAR reference catalogue

New SKILL.md section (**Phase 3.5 -- HAR Reference Catalogue**) specifying:

- `docs/har-reference/<provider>/<provider>-<action>-<yyyy-MM-dd>.har`,
  provider in the **filename** as well as the directory (the directory is
  invisible once the file is opened in a tab, attached to an issue, or
  pasted into a diff).
- Raw captures are never committed -- only trimmed, scrubbed extracts.
- `docs/har-reference/README.md` -- the catalogue: a per-provider table
  (file | actions the user performed | entry count | capture date) plus a
  per-file detail section recording the entry-by-entry sequence, what the
  capture *proves*, and the failure modes it caught. **Adding a capture has a
  final step: add the catalogue row naming what you did.** The endpoint is
  recoverable from the file; what you did to provoke it is not.
- A per-provider `README.md` carrying the scrub policy and re-capture recipe.

### 4. Part A.4/A.5 -- extractor and verifier

- New `templates/api-wrapper-scaffold/scripts/extract-har-reference.js`:
  - **Request bodies are NEVER truncated**; only response bodies are capped.
  - Emits **decoded** `postData.params[]` alongside the scrubbed wire `text`
    so a percent-encoded body is greppable by field name.
  - Refuses to run without a selector; **fails loudly on zero matches** rather
    than writing an empty reference.
  - Accepts the literal -> sentinel map supplied at capture time.
- New `templates/api-wrapper-scaffold/scripts/verify-har-reference.js` --
  a gate runnable over the whole directory and in CI, failing on:
  a truncated request body; an unredacted credential header/parameter; a
  secret nested inside a JSON-valued parameter; any caller-supplied
  forbidden literal.
- SKILL.md records both A.5 defects as cautionary: the truncated request body
  that made an authoritative-looking reference empty, and the commit message
  that overclaimed. **C.17: verify a committed reference by parsing it and
  asserting on its content -- never by trusting the generation step's report.**

## Evidence Plan

- **Change type**: CLI + documentation.
- **Artifact format**: Inline markdown (`evidence.md`) -- the real
  `extract-har-reference.js` / `verify-har-reference.js` runs against a
  synthetic fixture HAR carrying a nested-JSON secret and a literal, showing
  the leak caught before and clean after.
- **Capture command**: `node extract-har-reference.js ...` and
  `node verify-har-reference.js ...` over `tests/fixtures/har/`.
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [x] `sanitize-har.js` redacts a secret nested inside a percent-encoded JSON
      form parameter whose own name is not in any secret list.
- [x] `sanitize-har.js` replaces a caller-supplied literal in a URL, a header,
      a request body and a response body, in both raw and percent-encoded form.
- [x] `sanitize-har.js` has no default literal map and refuses to invent one.
- [x] `verify-scrub.js` fails on a forbidden literal and its message does
      **not** contain the offending value.
- [x] `verify-scrub.js` does not flag `"1"` / `"0"`-class placeholder values.
- [x] `extract-har-reference.js` never truncates a request body, caps response
      bodies, emits decoded `postData.params[]`, exits non-zero with no
      selector, and exits non-zero when the selector matches nothing.
- [x] `verify-har-reference.js` fails on each of its four gate conditions and
      passes on a clean reference directory.
- [x] SKILL.md documents the catalogue convention, the catalogue-row rule, the
      key-name-vs-literal-value distinction, the placeholder exemption, and
      "verify the artifact, not the report of it".
- [x] Instruction text stays generic (no consuming-project or domain names).

## Implementation Checklist

- [x] Task 1 -- `har-profile.js`: discovery, parse, hard-fail-when-absent,
      no-defaults guard. Node tests.
- [x] Task 2 -- `har-literals.js`: percent-encoded-aware literal pass over the
      serialized entry + nested-JSON decode helper. Node tests.
- [x] Task 3 -- wire profile + nested-JSON walk + literal pass (applied last)
      into `sanitize-har.js`; retire `--salt`; derive default paths.
- [x] Task 4 -- `verify-scrub.js`: forbidden-literal check that never echoes the
      value, nested-JSON walk, placeholder-length exemption.
- [x] Task 5 -- `extract-har-reference.js` + node tests (never truncate request
      bodies, cap responses, decoded `postData.params[]`, exit 2 / exit 3).
- [x] Task 6 -- `verify-har-reference.js` + node tests (four gate conditions).
- [x] Task 7 -- update `run-agent.js`, `Invoke-SanitizeHar.ps1`, and the three
      existing scrub test files for the retired `--salt`.
- [x] Task 8 -- SKILL.md: new "Phase 3.5 -- HAR Reference Catalogue" section;
      rewrite Phase 3 scrub guidance around the two-control model; add the
      A.5 / C.17 cautionary notes and the profile convention.
- [x] Task 9 -- Pester wrappers in `.github/agents/tests/` for the new node tests
      plus a SKILL.md structure test.
- [x] Task 10 -- full Pester + node suites green; Phase 5b evidence captured.
