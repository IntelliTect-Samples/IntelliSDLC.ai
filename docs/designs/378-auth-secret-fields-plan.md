# 378 -- auth-flow secret field names

**Issue:** [#378](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/378)
**Branch:** `fix/378-auth-secret-fields`

## Problem

The scrub is not broken; its inputs changed. Every capture the pipeline had
seen was of an **already-authenticated session**, so `har-policy.default.json`'s
`secretFields` named only post-login state (`fb_dtsg`, `c_user`, `xs`, ...). A
capture of a **login** is a new input class, and none of the three controls can
see the credential in it:

1. **key-name** -- no `password` / `enc_password` / `sensitive_string_value` /
   `verificationCode` entry;
2. **shape** -- a client-side password envelope is prefixed, colon-delimited
   and ~120 base64 characters: not a JWT, not long hex, not bearer-shaped;
3. **literal** -- covers the operator's own identifiers, not their password.

So the gate reported `(verified)` over an output still carrying a
credential-bearing value. The `(verified)` label is the whole severity: it is
the operator's licence to commit the file.

## Design

**Only the key-name control is in scope.** A shape rule for the envelope would
live in `har-shapes.js`, which another agent owns right now.

1. **Name the auth flow in `secretFields`** (27 names): the password family,
   the provider-supplied `sensitive_string_value` wrapper, second-factor
   material, and the token names a login response hands back. Matching stays
   **exact and case-insensitive**, so `password_reset_url` and `has_password`
   are untouched. Generic names an auth flow merely reuses -- bare `code`,
   `identifier`, `queryParams` -- are deliberately **excluded**: they name
   benign data far more often than a credential, and a base name cannot be
   vetoed invisibly by a consumer (`notSecretFields` records the loosening).
   A consumer whose provider uses one appends it in
   `.har-policy.project.json`.

2. **Close a gate/scrubber drift found while testing (1).** A form BODY is one
   string of `k=v&k=v`, so its parameter names are not object keys and
   `decodeNestedJson` is handed `variables={...}` with the `variables=` still
   attached -- it returns null and the walk stops at the wire spelling. The
   **scrubber** already decodes here (`transformEncodedParams`); the **gate**
   did not. That asymmetry is the `(verified)` bug in its own right: with the
   names added but the walk unchanged, `verify-scrub` still passed a raw login
   capture as clean. `walkForUnredactedSecrets` now reuses
   `transformEncodedParams` as a read-only visitor at the same depth.

## Acceptance criteria

- [x] The policy names the auth-flow fields; matching stays exact.
- [x] The scrubber removes an envelope nested in a percent-encoded `variables`
      blob, and a plaintext `password=` form field.
- [x] `verify-scrub` **fails** on a raw login capture -- both the nested-JSON
      and the form-body spellings -- and names the field without ever printing
      the value.
- [x] Unrelated fields in the same body survive byte-identical.
- [x] No new command-line option, flag or environment toggle.
