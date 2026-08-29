# 297 -- Replace the shape-based scrub gate with a class/evidence policy model

- **Issue:** [#297](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/297)
- **Supersedes (detection half):** [#295](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/295)
- **Adjacent:** [#294](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/294) -- shares the root cause, fixed here
- **Branch:** `feat/297-scrub-policy`
- **Worktree:** `.worktrees/297-scrub-policy`

## Design

The authoritative design lives in issue #297. This file is the implementation
breakdown; it does not restate the rationale.

The two axes, for reference while reading the stages:

| | gates (blocks) | advises (reports, non-zero exit, artifact kept) |
|---|---|---|
| **secret** -- grants access | name, literal, shape | -- |
| **identity** -- names a person | literal | shape |

The three inputs and where they merge:

```
har-policy.default.json      synced, stringent    -.
.har-policy.project.json     consumer, committed  -+-> merged policy -> scrubber
.har-profile.json            operator, gitignored -'                     + both gates
```

## Where the work lands

| File | Change |
|---|---|
| `templates/web-api-discovery/scripts/har/har-policy.js` | **new** -- loader, merge, validation, waiver matching |
| `templates/web-api-discovery/scripts/har/har-policy.default.json` | **new** -- the stringent baseline |
| `templates/web-api-discovery/scripts/har/har-policy.test.js` | **new** -- merge order, floor enforcement, waiver expiry |
| `templates/web-api-discovery/scripts/har/har-shapes.js` | Patterns gain `class`; IIN validation; findings gain location |
| `templates/web-api-discovery/scripts/har/har-secrets.js` | Value-aware sentinel recognition; names from policy |
| `templates/web-api-discovery/scripts/har/pii.js` | Key-tail matching; phone patterns; cookies; new types |
| `templates/web-api-discovery/scripts/har/verify-scrub.js` | Class-aware exit; findings report; policy fragment emission |
| `templates/web-api-discovery/scripts/har/verify-har-reference.js` | Response-truncation gate; substitution-table gate |
| `templates/web-api-discovery/scripts/har/extract-har-reference.js` | Cap becomes opt-in; structured marker only; policy stamp |
| `templates/web-api-discovery/scripts/har/sanitize-har.js` | Substitution tables move out of the output path |
| `templates/web-api-discovery/scripts/capture/capture-har.js` | Quarantine instead of `unlinkSync` |
| `templates/web-api-discovery/scripts/codegen/generate-wrapper.js` | `.gitignore` block gains `.substitutions.json` |
| `.github/skills/web-api-discovery/SKILL.md` | Policy file, override story, dedicated-account rule |
| `templates/web-api-discovery/README.md` | Tree listing, policy file |
| `.github/agents/tests/pii-scrubbing.Tests.ps1` | Follows |
| `.github/agents/tests/scrub-scripts.Tests.ps1` | Follows |

Suggested PR boundaries are marked at each stage. Stages 1-4 are the
foundation and should land together; 5 onward are independently shippable.

---

## Stage 1 -- The policy loader (`har-policy.js`)

**Task 1.1 (test-first).** `har-policy.test.js`: the default alone loads and
validates; a project file merges over it; an unknown key is a hard error, not a
silent ignore; a project file that disables a **secret** class is rejected by
name; a project file that disables an **identity** class is accepted; a waiver
past its `expires` date does not match; a waiver with no `reason` is rejected.

**Task 1.2.** Write `har-policy.default.json` with every class enabled at its
stringent setting, the upstream `secretFields` / `secretHeaders` lists moved out
of `har-secrets.js`, and the `pii.js` `FIELD` dictionaries moved out as key-tail
patterns. This is a pure data lift; behaviour must not change yet.

**Task 1.3.** Implement `loadPolicy({ startDir, policyPath })`. Reuse
`harProfile.findUpward` for discovery of `.har-policy.project.json` -- one walk
rule, not a second copy. Merge semantics: scalars replace, arrays of *names*
append, `notSecretFields` subtracts after the append, `classes.*` replaces.
Return a frozen object plus a `version` string derived from a hash of the merged
document, for Stage 10.

**Task 1.4.** Floor enforcement lives in the loader, not the callers: a project
file setting any `classes.secret.*` to `off` throws a `PolicyError` naming the
class. Callers cannot forget a check they never make.

> **PR 1** ends here. No caller consumes the policy yet; the lift is verifiable
> in isolation.

## Stage 2 -- Class-tagged shapes and waivers

**Task 2.1 (test-first).** `har-shapes` cases: each pattern reports its class;
a secret-class finding is `gating: true`; an identity-class finding is
`gating: false`; a fingerprint on the waiver list is dropped and counted as
waived.

**Task 2.2.** Add `class: 'secret' | 'identity'` to every entry in
`LEAK_PATTERNS`. `jwt`, `bearer`, `hex64`, `hex32` are secret; `credit-card`,
`ssn`, `phone`, `email` are identity.

**Task 2.3.** `findLeaks(text, policy)` returns findings carrying
`{ kind, class, gating, fingerprint, length }`. Waiver matching happens here so
both verifiers inherit it.

## Stage 3 -- Structural walk, key paths, payload scoping

**Task 3.1 (test-first).** A finding inside `response.content.text` reports its
JSON key path and entry index. A value inside `log.comment` produces **no**
finding. A value inside a percent-encoded parameter still produces a finding,
with `keyPath: null` and the enclosing parameter named.

**Task 3.2.** Replace the whole-document text sweep with a walk over
`log.entries[]` only, descending request/response headers, cookies, query
string, `postData` and `content`. Keep the decoded-shadow sweep, scoped to the
same nodes. HAR envelope fields (`log.comment`, `log.creator`, `log.version`,
`log.pages[].comment`) are never scanned -- we wrote them.

**Task 3.3.** Findings gain `keyPath`, `entryIndex` and an occurrence `count`
after grouping by fingerprint. No finding ever carries the value.

## Stage 4 -- Value-aware secret checks

**Task 4.1 (test-first).** `har-secrets`: a value of `REDACTED`, `redacted`,
`<Redacted>` or `redacted-abc123` under a known secret name produces **no**
finding. A live-looking value under the same name still does.

**Task 4.2.** Replace the case-sensitive `REDACTION_PREFIXES.some(startsWith)`
with a sentinel test that is case-insensitive and recognises both the
`redacted-` and the `<Sentinel>` forms, plus a bare `REDACTED`.

**Task 4.3.** Source `KNOWN_SECRET_FIELD_NAMES` / `KNOWN_SECRET_HEADER_NAMES`
from the merged policy rather than module constants.

> **PR 2** ends here: the gate now classifies, locates, and stops crying wolf on
> its own redactions. Expect the 1134-finding measurement to collapse.

## Stage 5 -- Credit-card precision

**Task 5.1 (test-first).** Known-good cards per brand are detected. A Luhn-valid
17-digit run beginning `17` is **not**. A Luhn-valid 16-digit run beginning `98`
is **not**. The seven distinct false positives from the #295 measurement are
**not** (record their prefixes in the fixture; the values themselves must not be
committed).

**Task 5.2.** Add issuer-identifier + brand-length validation to the
`credit-card` precheck: Visa `4` at 13/16/19; Mastercard `51-55`, `2221-2720` at
16; Amex `34`, `37` at 15; Discover `6011`, `644-649`, `65` at 16/19; JCB
`3528-3589` at 16-19; UnionPay `62` at 16-19; Diners `300-305`, `3095`, `36`,
`38-39` at 14-19.

**Task 5.3.** Delete `isPlausibleRecentUnixMs` (#87) and re-test the #293
decimal lookarounds. A 13-digit Unix-ms value starts `17`, which is not an
assigned IIN, so the timestamp window should now be dead code. Keep the #293
lookarounds only if a test still fails without them; a carve-out that no longer
carves anything is a future maintainer's trap.

## Stage 6 -- PII coverage

**Task 6.1 (test-first).** `first_name`, `user_name`, `billing_city`,
`shipping_address_1`, `date_of_birth` are all recognised. `(555) 123-4567`,
`555-123-4567` and a bare 10-digit run in a `phone`-named field are all
scrubbed. A PII value in `request.cookies[]` is scrubbed.

**Task 6.2.** `fieldType()` matches on key **tail** with separator awareness
(split on `_`, `-` and camel-case boundaries), which is what its comment already
claims. Patterns come from the policy.

**Task 6.3.** Phone detection gains the common national spellings, gated on
field-name context for the bare-digit-run case so it does not become the next
credit-card.

**Task 6.4.** `detectPii()` walks `request.cookies` / `response.cookies`.

**Task 6.5.** New types behind policy flags, off in no release before their
detectors are tested: IBAN, MAC address, advertising/device id (IDFA/GAID).
Passport, driver's licence and non-US national ids are **deferred** -- they have
no reliable shape and belong to the literal mechanism.

## Stage 7 -- Non-destructive rejection

**Task 7.1 (test-first).** `capture-har.js`: a rejected scrub leaves no file in
`outputPath`, writes `scrubbed.rejected.har` under the session's
`.har-captures/` directory, and exits non-zero. A findings report lands beside
it.

**Task 7.2.** Replace the `unlinkSync` at `capture-har.js:1030` with a move into
the session directory. The `-OutputPath`-receives-only-verified-artifacts
invariant is preserved by *where it goes*, not by deleting it.

**Task 7.3.** `verify-scrub.js` writes `scrub-findings.json` (kind, class,
keyPath, entryIndex, count, fingerprint -- never a value) and prints a
paste-ready `.har-policy.project.json` fragment for the identity-class findings,
with `reason` left empty so the operator must fill it in.

## Stage 8 -- Truncation

**Task 8.1 (test-first).** `extract-har-reference.js` with no `--max-response-bytes`
truncates nothing. With the flag, the body is cut and
`content.truncated = { originalBytes, keptBytes }` is set, and the body text
itself is unmodified apart from the cut -- **no inline marker**.
`verify-har-reference.js` fails a reference containing any `content.truncated`.

**Task 8.2.** Remove the `65536` default (`extract-har-reference.js:207`). The
cap becomes opt-in, per requirement 7.

**Task 8.3.** Extend the existing request-body gate in `verify-har-reference.js`
to responses. This is the single highest-value change relative to its size: it
would have caught all 27 truncated entries in the consuming repo at commit time.

**Task 8.4.** Document the marker contract in `SKILL.md` so the consumer-side
`Export-HarReference.ps1` can converge on it. Its inline
`...[response body truncated for reference use]` marker corrupts the payload's
JSON *and* evades a structured audit; a second marker format must not survive.

## Stage 9 -- #294, substitution tables

**Task 9.1 (test-first).** `sanitize-har.js` writes neither `.substitutions.json`
nor `.har-substitutions.json` into the output directory.
`verify-har-reference.js --dir` fails when either is present.

**Task 9.2.** Default both paths into the session's `.har-captures/` directory
(`sanitize-har.js:304-305`). Gitignored by construction, and not redirectable by
`-OutputPath`.

**Task 9.3.** Add `.substitutions.json` to `SCAFFOLD_GITIGNORE_ENTRIES`
(`generate-wrapper.js`). `.har-substitutions.json` is already there. This
protects consumers who have the files sitting in a tracked directory today.

## Stage 10 -- Provenance

**Task 10.1 (test-first).** A written reference records the merged policy
version; `verify-har-reference.js` reports when a reference was produced under a
different policy version than the current one (report, not fail).

**Task 10.2.** Stamp `_scrubPolicy: { version, generatedAt }` into
`digest.json` and the reference's `log.comment`. Requirement 6 exists so a later
policy change makes it knowable which references need re-extraction from the
preserved raws.

**Task 10.3 (test-first).** The stamp also records `rawAvailable` -- the session
directory the reference was extracted from, and whether it still exists.
Requirement 6 protects captures taken from now on; it says nothing about
references already committed, and in the consuming repo none of the preserved
raws produced the 12 committed references (raws are 2026-08-27 or later, the
references are 08-26). A reference whose raw is gone is re-creatable only by
re-capturing against the live provider, which is a different and far more
expensive operation than re-extracting. The verifier must be able to answer
"what would it cost to regenerate this?" without a human going to look.

## Stage 12 -- Operation identity in the digest

**Task 12.1 (test-first).** Two GraphQL POSTs to the same URL with different
`fb_api_req_friendly_name` values produce **two** digest groups. Two calls with
the same friendly name and different `doc_id` values produce **one**. A body
with a `query { ... }` document and no friendly name groups on the document's
operation name. An endpoint with none of the above groups exactly as today.

**Task 12.2.** `buildDigest()` (`capture-har.js:838`) currently keys on
`host|method|pathTemplate|status`, which is a single bucket for RPC-over-HTTP:
every Facebook GraphQL call collapses into `POST facebook.com /api/graphql/ 200`.
Add a stable operation name to the key, resolved in precedence order:

1. `fb_api_req_friendly_name` (form parameter or header)
2. GraphQL `operationName` from a JSON body
3. the first named operation in a `query` / `mutation` document
4. absent -- fall back to today's key

The source list comes from the policy, not from a hardcoded provider list.

**Task 12.3.** `doc_id` is explicitly **not** a fallback, and neither is an id
embedded in a URL. Facebook rotates `doc_id` between captures; a coverage check
keyed on it reported four operations as having zero recurrence -- including
`ComposerStoryCreateMutation` -- when each in fact recurs 31 times under its
friendly name. The failure direction is under-reporting, which manufactures
false alarms about missing captures. Grouping coarsely is better than grouping
on a value that changes between captures; add a test that pins this.

## Stage 11 -- Documentation

**Task 11.1.** `SKILL.md`: the three files and what each may contain; the
values-vs-rules rule; the secret floor; the override worked example (loosen to
credentials/tokens/secrets/display-name); the quarantine path; the truncation
contract.

**Task 11.2.** `SKILL.md` capture phase: captures are recorded as a **dedicated
test account**, never a personal or default workspace (requirement 8). State it
as a precondition of starting a recording, not as advice.

**Task 11.3.** `templates/web-api-discovery/README.md` tree listing gains
`har-policy.default.json` and `.har-policy.project.json`.

**Task 11.4.** `project.instructions.md.template` gains a stub pointing at
`.har-policy.project.json` as the place a consuming project declares its scrub
posture.

## Deferred

- **Salt relocation.** Moving `salt` from `.har-profile.json` to the project
  policy makes a reference reproducible across a team, but publishes the input
  that makes a low-entropy fake brute-forceable. It is only safe once Stage 9
  guarantees the substitution table is never committed. Revisit after Stage 9,
  not before.
- **`~/.har-profile.json`.** `findUpward` already permits it; the change is
  documentation plus a test. Worth doing, but independent of this issue.
- **Assisted literal discovery.** Surfacing recurring authenticated-request
  values as candidates for human confirmation. A separate issue -- it changes
  the capture UX, not the policy model.
- **AI scrub pass.** Requirement 5 says the gate must never depend on model
  judgment. The policy model leaves room for a pass that only *adds*
  redactions, but nothing in this plan implements one.
