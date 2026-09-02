# Per-provider server API document (`api.json`)

- Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/382
- PR:    (filled in once the PR exists)
- Slug:  382-api-document

## Overview

Aggregate a provider's committed HAR references into one generated
`api.json` that describes the **server** — endpoints, methods, observed
statuses, request/response field names, persisted-operation ids, and which
credentials a request must carry — with every claim naming the reference and
entry that witnesses it. Drift then shows up as a diff instead of as a
discovery.

## Approved Design

### One script, three jobs

`templates/web-api-discovery/scripts/har/generate-api-document.js`

```
node generate-api-document.js --dir <provider-dir> [--check]
```

- **default** — regenerate `api.json` in `<provider-dir>` from every `*.har`
  in it (non-recursive) and write it.
- **`--check`** — write nothing; fail if the committed `api.json` is missing,
  differs byte-for-byte from a fresh regeneration, or contains a claim the
  references do not witness.

Exit codes match the family (`verify-har-reference.js`): `0` clean, `1` I/O or
parse error, `2` usage error, `3` a check violation.

### The document

Bespoke schema. OpenAPI is an awkward fit for GraphQL-over-POST, which is most
of this traffic, and forcing it would make the fit itself the thing under
review.

```jsonc
{
  "schemaVersion": 1,
  "provider": "www.example.com",          // the directory's own name
  "references": [
    { "harFile": "example-composer-2026-01-01.har", "entryCount": 12 }
  ],
  "endpoints": [
    {
      "host": "www.example.com",
      "method": "POST",
      "pathTemplate": "/api/graphql/",     // pathTemplate() from capture-har.js
      "statuses": [200, 400],
      "requestContentTypes": ["application/x-www-form-urlencoded"],
      "responseContentTypes": ["application/json"],
      "credentialFields": [                // NAMES only, never values
        { "name": "cookie", "in": "header", "witnesses": [...] }
      ],
      "operations": [                      // persisted queries
        { "persistedId": "1234567890", "name": "ComposerCreate", "witnesses": [...] }
      ],
      "requestFields": [ { "name": "variables", "witnesses": [...] } ],
      "responseFields": [ { "name": "data", "witnesses": [...] } ],
      "witnesses": [ { "harFile": "example-composer-2026-01-01.har", "entry": 3 } ]
    }
  ]
}
```

A **witness** is `{ harFile, entry }` — the reference filename and the
zero-based index of the entry in that file's `log.entries`. Every endpoint,
field, credential and persisted id carries at least one.

**At most one witness per reference per claim** — the first entry in that file
that carries it. A field appearing in five hundred entries does not need five
hundred citations, and a document whose size tracked entry count rather than
API surface would stop being reviewable, which is half of why it exists. What a
reader needs is *which reference* witnesses a claim, and one checkable entry per
reference is exactly that.

### Decisions the issue left open, and the reason for each

- **A field seen in one capture and absent in another is neither "optional"
  nor "provider-changed".** It is recorded with the witnesses it actually has,
  and nothing else. Two captures are not a sample; labelling from them is the
  inference this document exists to replace.
- **Unexercised error shapes are absent, not "unknown".** `statuses` lists
  what was observed. An entry the references do not contain is not described.
- **Fields are named at the top level only** — form-parameter names, plus
  top-level JSON keys of request and response bodies. Same depth as
  `digest.json`'s `payloadShape`, and the depth at which every claim stays
  cheap to re-check against an entry. Deepening is a later issue, not a
  quietly wider claim now.
- **Credentials are named, never valued.** The list comes from
  `har-secrets.js` (`isKnownSecretHeader` / `isKnownSecretField`), so this
  document and the leak gate agree about what a credential is.

### Determinism

Every array has an explicit total order — references by `harFile`; endpoints
by `(host, pathTemplate, method)`; fields, operations and credentials by name;
witnesses by `(harFile, entry)`; statuses ascending — and the file is
`JSON.stringify(doc, null, 2) + '\n'`, matching `writeJson` elsewhere in the
pipeline. Without this the gate below cries wolf on every run and gets
disabled.

### The staleness gate

`--check` is the gate the comment on #382 asks for: regenerate, compare, fail
on any difference, **whole-provider** — every reference in the directory is
re-read, so re-scrubbing one reference is caught even when a different one was
the file edited.

`--check` additionally verifies the committed document against the references
*independently of the generator*: for each claim it opens the named reference,
reads the named entry, and confirms that entry actually carries the claim.
That is what makes a hand-planted claim fail, and it is a different code path
from the aggregation, so it is not the generator marking its own homework.

Three failures, each its own message:

1. a claim whose witness names a missing file, an out-of-range entry, or an
   entry that does not carry it;
2. a reference file in the directory with no representation in the document;
3. a regenerated document that differs from the committed one.

### What this does not touch

`catalogue.json` and the generated `README.md` table are #379's artifacts. The
same `--check` shape fits them and #379 is welcome to reuse it, but nothing
here reads or writes them, so the two changes do not collide.

## Evidence Plan

- **Change type**: CLI (a Node script with a check mode)
- **Artifact format**: Inline — `evidence.md` carrying the real command output
  from generating and then checking a fixture provider directory, including
  the failure output of a planted claim
- **Capture command**: `node generate-api-document.js --dir <fixture>` then
  `--check` clean, then `--check` after planting an unwitnessed claim
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [ ] `--dir` with references writes `api.json` describing every endpoint in
      them.
- [ ] Regenerating over an unchanged directory produces a byte-identical file.
- [ ] Ablating the sort order makes the idempotence test fail.
- [ ] Every endpoint, field, credential and persisted id carries a witness
      naming a reference and entry that contains it.
- [ ] A planted claim with no witness makes `--check` fail and names the claim.
- [ ] A witness naming a reference file that does not exist makes `--check`
      fail.
- [ ] A reference present in the directory with no representation in the
      document makes `--check` fail.
- [ ] Editing one reference and not regenerating makes `--check` fail, and the
      message names `api.json` as stale.
- [ ] Regeneration leaves every other file in the directory — `README.md` and
      the references themselves — byte-identical.
- [ ] No credential value reaches `api.json`; a reference carrying a redacted
      credential yields the field NAME only.
- [ ] Missing `--dir`, a missing directory, and a directory with no `*.har`
      each fail with the documented exit code rather than writing an empty
      document.

## Implementation Checklist

- [ ] Task 1 — `api-document.test.js`: red test for aggregation over two
      fixture references (endpoints, methods, statuses, fields).
- [ ] Task 2 — `generate-api-document.js`: arg parsing, directory walk,
      aggregation, deterministic write. Green.
- [ ] Task 3 — idempotence test + ablation of the sort order.
- [ ] Task 4 — witnesses on every claim; test that each names a real entry.
- [ ] Task 5 — `--check`: regeneration equality, with the stale-artifact test
      (edit reference B, check fails).
- [ ] Task 6 — `--check`: independent witness verification, with the planted
      claim and the missing-file falsifiers.
- [ ] Task 7 — `--check`: unrepresented reference falsifier.
- [ ] Task 8 — prose-safety test: README.md byte-identical after regeneration.
- [ ] Task 9 — usage / empty-directory / missing-directory exit codes.
- [ ] Task 10 — credential names only, never values.
- [ ] Task 11 — Pester wrapper `.github/agents/tests/api-document.Tests.ps1`
      so the Node test runs in CI (node-test-coverage guard).
- [x] Task 12 — document the phase and the CI gate in
      `.github/skills/web-api-discovery/SKILL.md`.

## Ablation log

The issue asks for every assertion to be ablated — break what it checks, watch
it fail, restore — and reported per assertion. The sweep is scripted so it can
be re-run, and its table is reproduced in the evidence artifact. Three
assertions failed that exercise on the first sweep and were strengthened rather
than explained away:

- **request-field order** was unfalsifiable because the fixture's parameters
  happened to be alphabetical;
- **`--check` writes nothing** could not fail, because on a clean directory the
  regenerated bytes equal the committed ones — replaced by the assertion that a
  check leaves a *stale* document unrepaired;
- **credentials are never valued** needed a compound ablation: the value has to
  be both collected and emitted before it can leak, so no single mutation
  reaches it.
