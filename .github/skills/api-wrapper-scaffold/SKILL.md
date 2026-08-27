---
name: api-wrapper-scaffold
description: "Probe a target website with Playwright, capture HAR traffic, and generate a complete buildable .NET API-wrapper project (typed client + PowerShell module + MCP server + tests + security gates). Companion to the dev-loop. Use when the user asks to 'wrap an API', 'generate a client from a website', or names a target site they want to automate."
---

# API Wrapper Scaffold

You generate a complete, buildable .NET API-wrapper project from a target
website by probing the site with Playwright, scrubbing the captured traffic,
and code-generating typed clients, a PowerShell module, an MCP server, and
tests around the observed endpoints.

This is a **generation** skill, not a maintenance skill. After the first
successful run the resulting project owns its own dev-loop (via the standard
`@dev-loop` agent). Re-running this skill against the same project updates
only generated artifacts (`*.g.cs`) and HAR samples; user-edited code in
sibling partial classes is preserved.

> Every internal change to this skill itself must follow Phase 5b of
> [`dev-loop.agent.md`](../../agents/dev-loop.agent.md) (Evidence & Verify)
> -- see [`../evidence-capture/SKILL.md`](../evidence-capture/SKILL.md).

## When to invoke

- The user asks to "wrap an API", "generate a client from a website", or
  names a target site they want to automate.
- A new external integration is needed and the API surface must be
  discovered from observed traffic rather than from a published spec.

Do not invoke for:

- Maintenance of an already-scaffolded wrapper project -- that lives under
  the standard `@dev-loop` agent in the generated project.
- API surfaces that already ship an OpenAPI / GraphQL schema -- prefer the
  upstream generator in that case.

## Hard Gate

**Do not run any phase that mutates the user's filesystem until you have:**

1. Confirmed the target URL with the user.
2. Confirmed a project name + .NET namespace + output directory.
3. Confirmed the auth model (or accepted "let the detector decide").
4. **Asked the user whether the target service has a mobile app to include**
   (Phase 1.5). The agent must ask -- the user may still answer no.
5. **Asked the user whether to seed the project with the IntelliSDLC.ai
   instructions and add the `sdlc.ai` remote** (Phase 10.5). The agent
   must ask -- the user may still answer no.
6. Created a GitHub issue (or referenced an existing one) that describes
   the scope of the wrapper.

## Inputs (asked one at a time)

| # | Prompt | Default | Token | Notes |
|---|---|---|---|---|
| 1 | Target site URL | none | `{{BaseUrl}}` | Must be HTTPS. Reject obvious junk. |
| 2 | Project / wrapper name | URL host's primary label, PascalCased + `Ex` (e.g., `tripit.com` -> `TripItEx`) | `{{ProjectName}}` | Used for solution name, namespace root, and MCP tool prefix. |
| 3 | Output directory | `D:\Git\{{ProjectName}}` on Windows, `~/git/{{ProjectName}}` elsewhere | -- | Must not already exist. |
| 4 | Auth model | autodetect | `{{AuthModel}}` | One of: `cookie`, `cookie+csrf`, `bearer`, `sso-google`, `sso-microsoft`, `sso-facebook`, `oauth2-pkce`, `autodetect`. |
| 5 | OAuth client_id / client_secret | none | -- | Only asked when (4) is `oauth2-pkce`. Stored in user-secrets, never on disk in plaintext. |
| 6 | Seed IntelliSDLC.ai? | yes | -- | If yes, the agent runs `git init` and pulls upstream instructions (Phases 10.5 + 11). |
| 7 | Pre-captured Playwright `storageState.json`? | none | -- | When present, the capture phase skips interactive login and replays the storage state. Required for non-interactive dogfood runs. |
| -- | .NET root namespace | `{{ProjectName}}` | `{{Namespace}}` | Asked only when the user wants to override the default. |
| -- | IdP friendly name | derived from `{{AuthModel}}` | `{{IdpName}}` | `Google` / `Microsoft` / `Facebook` -- substituted into the generated README's re-auth section. |

Ask one at a time. After (1) and (2), echo back a one-line preview of
what will be generated before asking (3).

## Phases

The skill executes phases 1-11 strictly in order. Failure in any phase
halts the run with a clear remediation message; nothing is "partially"
generated. Phase 3.5 (HAR Reference Catalogue) runs whenever a capture is
worth keeping, which is most of the time.

### Phase 1 -- Discover

- Validate URL reachable.
- Fetch `/.well-known/openid-configuration` and `/robots.txt`.
- Record observed OAuth IdP redirect hosts (`accounts.google.com`,
  `login.microsoftonline.com`, `facebook.com/v*/dialog/oauth`) for the
  auth-style heuristic.

### Phase 1.5 -- Mobile App Discovery (required prompt)

Many target services have a mobile app whose backend API differs from --
or is a superset of -- the website's API. Mobile-app endpoints frequently
expose richer data, internal APIs not visible on the web, and different
auth shapes. Including mobile traffic produces a more complete wrapper.

The agent **must** prompt for this phase on every run. The developer may
answer N, but skipping the prompt silently is a hard regression -- the
choice to exclude mobile coverage has to be an informed one. After
Phase 1 completes, ask the user exactly:

> Does the target service have a mobile app (iOS or Android)? Including it
> can reveal additional API surface. [y/N]

If the answer is `N` (default), record the decision in the run transcript
and continue with Phase 2 (web-only). On `y`, collect three follow-up
inputs:

| Input | Values | Notes |
|---|---|---|
| Platform | `ios` / `android` / `both` | Drives the instruction set printed by `import-mobile-app.js`. |
| Capture mode | `download` / `proxy` / `decompile` / `both` | `download` (recommended first step) prints platform-specific instructions for acquiring the `.apk` (Android) or `.ipa` (iOS) binary. `proxy` (mitmproxy / Charles) captures live traffic. `decompile` (jadx / class-dump) extracts endpoint strings statically; it requires the binary, so `download` is a prerequisite. |
| Proxy capture path | default `Samples/HAR-Original/mobile-<platform>-<timestamp>.har` | Where the captured HAR is exported. |
| Binary path | `Samples/MobileApp-Binaries/<platform>-<package>.{apk,ipa}` | Where downloaded binaries land. Always gitignored; never commit. |

Then run the guided importer (it prints commands and waits for the user
to confirm each step; it never invokes proxies or decompilers itself):

```pwsh
node templates/api-wrapper-scaffold/scripts/import-mobile-app.js \
  --platform=<ios|android|both> --mode=<proxy|decompile|both>
```

The script's outputs feed the same downstream pipeline as web HARs:

- **Proxy mode** produces `Samples/HAR-Original/mobile-<platform>-*.har`,
  which is fed through `sanitize-har.js` + `verify-scrub.js` (Phase 3)
  exactly like web HARs. The resulting scrubbed HAR is then classified by
  `detect-auth.js` -- pass `--source-label=mobile-<platform>` so the
  `evidence[]` array records which traffic source each auth signal came
  from.
- **Decompile mode** produces `Samples/MobileApp-Discovered/<platform>-endpoints.txt`,
  a sorted-unique URL list. Phase 5 (Endpoint Deduplication) merges this
  list into the endpoint catalog before code generation.

The generator records `{{HasMobileCoverage}} = "true"` and
`{{MobileHarPaths}} = <newline-joined list>` in the manifest token set so
the emitted `README.MobileDiscovery.md` lists exactly which mobile sources
contributed to `Client.cs`.

**Legal constraint.** Decompilation must only be performed against apps
the user is legally permitted to inspect (their own account, or where the
app's Terms of Service permit security research). The skill must surface
this warning before running `import-mobile-app.js --mode=decompile` and
must not proceed without explicit user acknowledgement.

### Phase 2 -- Record the session

The operator's entire surface is a URL:

```powershell
Start-HarRecording https://example.com    # browse, then press ENTER
```

`templates/api-wrapper-scaffold/scripts/capture-har.js` owns the browser
context; `Start-HarRecording.ps1` / `Stop-HarRecording.ps1` are its PowerShell
front doors. It opens system Chrome on a **dedicated capture profile** that
stays signed in between sessions -- never the operator's daily profile, which
holds live sessions this must not disturb -- and records every request. Pass
`-Isolated` for bundled Chromium with a throwaway profile (CI), optionally with
`-StorageState`.

**A human ends the recording with ENTER. An AI ends it with
`Stop-HarRecording`.** Both perform the same close, and that close is what
writes the HAR. Ctrl+C is trapped and does the same thing rather than killing
the capture.

**Never end a recording by closing the browser window.** Playwright serializes
`recordHar` during a close the driver performs; when the window goes first,
Chrome exits before that can happen and **no HAR is written at all**. This is
measured, not theoretical. A snapshot of finished requests is therefore flushed
every few seconds to `raw.snapshot.ndjson`, and a lost driver is recovered into
`raw.snapshot.har` -- a genuine recovery artifact, with best-effort response
bodies and no timings. Prefer a clean re-capture whenever one is affordable.

**Driving the browser as an AI.** `Start-HarRecording` prints a CDP endpoint.
`chromium.connectOverCDP(endpoint).contexts()[0]` **is** the recording context,
so anything the agent does there lands in the same HAR -- there is no second
context and no second capture. Detaching (`browser.close()` on the CDP side)
does *not* end the recording; only ENTER, `Stop-HarRecording`, or the window
does.

A persistent profile is single-instance, so a second recording against the same
profile cannot start while one is live. The script detects this and says so
rather than hanging; end the running capture, or use `--port <other> --isolated`.

- Capture is **unfiltered**: no HAR glob, ever, on a first pass.
- If a `storageState.json` was supplied, load it and skip interactive login.
- Polite crawl: respect robots.txt, throttle to ~1 req/sec on automated
  traversal, descriptive User-Agent.
- The raw capture is gitignored and never committed. Phase 3.5 turns it into a
  committable reference.

#### Capturing traffic reliably

Lessons from hand-driven capture sessions against production sites -- each
of these has cost real diagnosis time when skipped.

- **The HAR is written by the driver's close, and by nothing else.** Playwright
  buffers the whole session and serializes it during a client-initiated
  `context.close()`. Two endings therefore produce nothing at all: killing the
  driver process, and **closing the browser window** -- Chrome exits first and
  the close never runs. Instruct the human to press **ENTER** in the recording
  terminal; `Stop-HarRecording` is the equivalent for an agent. (Earlier
  guidance here said to close the window: that is correct for the
  `playwright open --save-har` CLI, whose own process closes the context on
  exit, and wrong for a driver that owns the context. It cost a capture to
  learn.) Before moving on to Phase 3, verify the HAR exists and is non-trivial
  in size; never analyze a HAR that was never flushed.
- **Never terminate the browser to end a capture.** Killing Chrome processes
  can also destroy unrelated signed-in work elsewhere on the developer's
  machine, and it discards the recording besides. Always end a capture by
  asking the human to press ENTER in the recording terminal. If more than one
  capture may be live (a prior run wasn't ended, or a second terminal is open),
  **disambiguate before the human acts** -- `node capture-har.js status` names
  what is recording and where, and the launch itself refuses to start a second
  capture against a profile that is already in use. A human acting on the wrong
  window produces no capture, and the loss is silent until they've already done
  the work.
- **The first capture is always unfiltered.** Do not scope `--save-har-glob`
  to a guessed path on the first pass, even when the target mutation looks
  like it obviously belongs to one API family (e.g. GraphQL). Media upload
  protocols in particular routinely run over entirely separate hosts and
  paths (`vupload2.<host>`, `rupload-<region>.up.<host>`,
  `i.<host>/rupload_<kind>`) that a premature glob silently discards. Narrow
  the glob only on a second pass, once the endpoints actually in play are
  known -- an oversized HAR is cheap; a capture that silently omits the
  thing you were hunting is not.
- **Deliberately capture failure paths, not just the happy path.** Ask the
  human to also reproduce cancel, retry, invalid-input, and rapid-repeat
  flows. Failure captures are frequently the highest-value entries in a
  session -- they establish the platform's real error taxonomy (see
  "Interpreting captured responses" below) and can reveal genuine platform
  limitations (e.g. "this field cannot be edited after publish") that save
  a future engineer from building a feature that cannot work. Never discard
  a "mistake" run without scanning it first.
- **Plan for very large HARs.** Video/media captures commonly land in the
  hundreds of MB; a mistaken large-file capture can push into multiple GB.
  Whole-file JSON parsing at that size is slow and memory-hungry. Analyze
  in two stages:
  1. **Discovery** -- `grep` / stream-scan the raw file for URL and
     friendly-name patterns. Works at any size.
  2. **Extraction** -- only after narrowing, parse and pull the specific
     entries of interest.

  A mistaken oversized capture (e.g. a large-file upload run by accident)
  is usually best discarded rather than flushed and parsed.
- **Building an authenticated capture context from stored secrets.** Rather
  than making the human log in inside the capture browser every time,
  construct a Playwright `storageState.json` from already-stored
  credentials and pass it via `--load-storage` / the skill's Input 7. Two
  gotchas:
  - **Secret key casing is not consistent** across secret stores (e.g.
    `Facebook:datr` vs. `Facebook:Workspaces:<alias>:Datr`). Look secrets
    up case-insensitively.
  - **Include every session cookie the platform needs**, not just the
    primary auth token -- a partial cookie set produces confusing,
    non-obvious failures rather than a clean "not authenticated" error.

### Phase 3 -- Scrub

- Run `templates/api-wrapper-scaffold/scripts/sanitize-har.js` and
  `verify-scrub.js`.
- Replace tokens, cookies, session ids, and PII with angle-bracket
  placeholders (`<GoogleAccessToken>`, `<UserEmail>`, `<BookingReference>`).
- Apply the deterministic faker substitution table (HMAC-SHA256 keyed
  with the project salt) so the same original value always maps to the
  same fake. Faker types are format-preserving (phone stays phone, IATA
  stays 3 letters).
- Persist hash -> fake mapping to `.har-substitutions.json` (git-ignored).
- Output written to `samples/har/`.
- **Before the scrubbed HAR is written, verify the capture path itself is
  covered by `.gitignore`.** `samples/har-original/` (the unscrubbed
  capture) must never be committable even transiently; treat a missing
  gitignore rule as a hard stop for the phase, not a warning.

#### Scrubbing is two controls, not one

This is the part that is easy to get wrong, because the first control looks
sufficient right up until it isn't.

**Control 1 -- key-name scrubbing.** Shape patterns (JWT, long hex, email)
plus the known-secret field and header lists in Phase 8. It redacts a value
because of the name it travels under.

**Control 2 -- literal-value scrubbing.** A pass over the specific
identifiers the operator knows they are exposing -- their account id,
display name, email -- applied **last**, over the **serialized** entry, so
one sweep covers URLs, headers, request bodies and response bodies together.

You need both, because key-name scrubbing can only ever redact a value whose
name somebody anticipated. Two whole classes escape it:

- **A field whose name and value are not adjacent.** A multipart body puts
  the name in a `Content-Disposition` header and the value on its own line
  after a blank line, so neither `name=value` nor `"name":"value"` matches --
  and the tokens on a name list are short and non-hex by nature, so no shape
  pattern catches them either. The value survives the scrub *and* every
  verifier: a silent bypass, which is worse than no scrub, because the file
  looks checked. Scrub multipart fields by name explicitly, anchoring on the
  boundary the body itself declares -- and find that delimiter anywhere in
  the body, not on the first line. A leading CRLF or a MIME preamble is legal
  and common enough that keying off line one blinds the control for the
  *whole* body, which is a worse failure than mis-parsing one field.

  > **Known limitation, accepted deliberately.** A split heuristic is not a
  > MIME parser. A preamble containing a bare `--...` line, or a boundary
  > token that also occurs inside a field value, will mis-scope the split for
  > that body. Both need an uncommon shape and fail toward a missed redaction
  > that the literal-value and shape controls still cover. Write a real
  > parser if these start appearing in real captures; do not stack another
  > heuristic on top.
- **A secret nested inside an encoded JSON parameter.** A form body carries
  `variables=<percent-encoded JSON>` and the per-request tokens live *inside*
  that JSON. No flat pattern over the wire body matches them -- the body is
  percent-encoded -- and the inner key never appears in the form's own
  parameter list. The scrubber must decode parameter values and walk the
  decoded document. (It writes a value back only when scrubbing changed it,
  so untouched parameters keep their original bytes and a reference still
  diffs cleanly against a fresh capture.)
- **The same value under several names, one of them undocumented.** An
  account identifier observed as a nested object field, as a permalink query
  parameter, and as an undocumented `target_id=` -- one value, three names.
  The display name leaked the same way through response bodies. No extension
  of a key list catches this reliably, because the failure is that *you do
  not know all the names*.

Implementation rules that mattered in practice:

- Replace the raw literal, its percent-encoded spelling, **and its
  JSON-escaped spelling**. The pass runs over the serialized document, where a
  quote is a backslash-escaped quote and a non-ASCII character may be a
  backslash-u escape -- and a JSON body stored as a string inside the HAR is
  escaped a second time. A literal containing any of those never appears raw
  in the text being scanned, and names -- the most common literal after an
  id -- routinely contain them.
- **Apply the longest literal first**, whatever order the operator declared
  them in. A short literal that runs first consumes its own substring out of a
  longer one: replacing a surname inside a full name strands the given name
  next to a sentinel, and the longer literal records no hit, so nothing
  reports the partial name that just leaked.
- Also replace both spellings The same
  applies to values the typed-PII pass already found: detection reads the
  decoded `queryString` pair while the URL carries `phone=%2B1...`, and
  replacing only the raw spelling leaves the encoded copy readable.
- **Never default or commit the literals.** They are the operator's own
  account identifiers, and baking a real identifier into a committed script
  is exactly what account hygiene forbids. They live in a gitignored
  `.har-profile.json` alongside the salt, auto-discovered by every HAR
  script, and an absent profile is a **hard failure that names the file** --
  not a quietly empty map. Say why in a comment: a future maintainer meeting
  an awkward required input will otherwise be tempted to helpfully add a
  default.
- **No finding may quote the value it found** -- not the literal ones, and not
  the shape-based ones either. A leak report that prints the matched email or
  bearer token relocates the leak into the CI log that reports it. Name the
  sentinel, name the field, or emit a short non-reversible fingerprint.
- The verifier accepts the same literals as forbidden values and must **not**
  echo the offending value in its failure message. That just relocates the
  leak into the CI log that reports it -- name the sentinel instead.
- The profile is gitignored and therefore absent in CI, where the literal
  check cannot run. Report it as **skipped**, never as a silent pass.

#### Do not over-redact placeholders

A verifier that flags `client_mutation_id: "1"` or `actor_id: "0"` trains its
readers to ignore it, and an ignored gate is worse than no gate. Exempt
values below a plausible minimum length from the name-based checks; counters
and placeholders are not credentials. Shape-based patterns are unaffected --
they already imply length.

#### Keep the scan linear

Capture bodies run to hundreds of KB. An unbounded `[chars]+@` local part
backtracks quadratically over a long run that never reaches an `@`: bounding
it to RFC 5321's limits turned a 68-second scrub of a 200 KB body into a
60-millisecond one. Any pattern with an unbounded quantifier before a
required literal deserves the same treatment before it meets a real capture.

`verify-scrub` asserts:

- No original PII value appears in scrubbed output, **including** in a
  percent-decoded view of the file.
- Every fake in output reverses via the table.
- No known secret name carries a readable value, at any nesting depth,
  including inside a decoded JSON parameter and inside a multipart body.
- A cookie is checked in the structured `cookies[]` array as well as in the
  `Cookie` header -- the HAR spec lets them diverge.
- No forbidden literal survives.

### Phase 3.5 -- HAR Reference Catalogue

A HAR captured to solve one bug gets thrown away, and six weeks later
somebody re-drives the same flow by hand to answer the same question. The
capture is the single most valuable artifact of the session -- it is the only
thing in the repo that is **ground truth about someone else's API** -- and it
is worth keeping permanently.

The payoff is concrete: when a provider rotates an id or changes a payload,
the correct fix is **re-capture and diff against the stored reference**. One
publishing outage was diagnosed exactly that way -- the generated client sent
26 provider flags where the capture had 32, and the six missing flags
corresponded one-for-one to six "missing required variable" errors. That diff
is only possible because the capture was kept.

#### 1. A per-provider directory of committed, scrubbed references

```
docs/har-reference/
├── README.md              <- the catalogue (see 3)
├── <provider-a>/
│   ├── README.md          <- provider scrub policy + re-capture recipe
│   └── <provider-a>-<action>-<yyyy-MM-dd>.har
└── <provider-b>/
```

**Raw captures are never committed.** They run to hundreds of MB and carry
live credentials. Only trimmed, scrubbed extracts go in-tree.

#### 2. Filenames carry provider AND action

`<provider>-<action>-<yyyy-MM-dd>.har`

The provider appears in the **filename** as well as the directory. That looks
redundant and is not: the directory is invisible the moment the file is
opened in an editor tab, attached to an issue, pasted into a diff, or
downloaded. `<action>` names the operation a **human performed** to record it
(`login-flow-2fa`, `composer-story-create`, `video-upload`). The date
disambiguates re-captures of the same operation, which is the normal case
when an API drifts.

#### 3. A catalogue mapping each capture to what the human did

This is the highest-value half of the convention, and the half a filename
cannot carry. A file named `<provider>-video-upload-<date>.har` **cannot**
say:

- that the first finalize call came back `400` and succeeded on a
  byte-identical retry;
- that the capture contains *two* upload cycles and *five* transcode polls,
  not one;
- that two trailing entries are a *failed* edit that established a platform
  limitation;
- that every video required a separate cover upload reusing the video's own
  upload id.

Those are exactly what someone opening the file is looking for, and they
otherwise survive only in whichever issue thread happened to mention them.

`docs/har-reference/README.md` carries:

- a table per provider: **file | actions the user performed | entry count |
  capture date**;
- a per-file detail section: the entry-by-entry sequence, what the capture
  *proves*, and the failure modes it caught;
- the excerpt fragments (partial captures that are not full HAR documents)
  mapped the same way;
- a pointer to the scrub policy and the verification command.

> **The rule that makes it stick:** adding a capture has a final step --
> *add the catalogue row, naming what you did*. The endpoint is recoverable
> from the file. What you did to provoke it is not.

Cataloguing is not clerical work: doing it forced a re-read of the files
rather than the prose about them, and surfaced four facts nobody had written
down -- including that two `202` responses meant "retry", not "failure", and
that an identical retry after a `400` succeeded.

#### 4. Tooling: extract, then verify

Two scripts, because the manual version of each shipped a defect (see 5).

**`extract-har-reference.js`** selects entries from a raw capture by URL
and/or body pattern, scrubs them, and writes the reference. Non-negotiable
behaviours:

- **Request bodies are NEVER truncated.** Only response bodies are capped,
  and a capped response records what was dropped.
- Emits **decoded** `postData.params[]` alongside the scrubbed wire `text`.
  A percent-encoded form body is not greppable; the decoded copy is what
  makes the reference searchable for a field name.
- Refuses to run without a selector, and **fails loudly when nothing
  matches** rather than writing an empty reference.
- Re-checks its own output for forbidden literals **before writing**, and
  fails rather than writing. Its post-processing can reveal a literal the
  scrub never saw -- decoding a parameter to emit `params[]` peels a layer of
  encoding off it. Printing a warning and exiting `0` is not a gate: an
  automated caller reads the exit code, sees success, and commits the file.
- Takes the literal -> sentinel map from the capture-time profile
  (see Phase 3).

**`verify-har-reference.js`** is a gate, runnable over the whole directory
and in CI. It fails on:

- a truncated request body;
- an unredacted credential header, parameter, or multipart field;
- a secret nested inside a JSON-valued parameter;
- any caller-supplied forbidden literal;
- a **shape-detected** secret -- a JWT, a long hex token, a bearer header, an
  email. The other gates only catch what somebody named or declared; a
  per-session token belongs to neither set. Share one pattern list with the
  gate on the scrubbed HAR: the reference is the file that actually ships, so
  it must be checked at least as hard as the intermediate it came from.

Both ship with tests, each pinned to a failure that actually shipped.

#### 5. The two defects that motivated the tooling

Both are the kind of thing that passes review:

- **(a) Request bodies truncated to nothing.** An extraction capped *all*
  bodies at a fixed size. Response bodies survived usefully; request bodies
  -- the half that says what the client actually sent -- were cut to
  fragments. The resulting file looked authoritative and proved nothing: it
  could be neither replayed nor diffed.
- **(b) A commit message that overclaimed.** The same commit stated
  "structure and ALL keys preserved verbatim", which was false for the
  truncated file. The defect was found by checking the artifact, not by
  reading the description of it.

> **Verify the artifact, not the report of it.** Confirm a committed
> reference by parsing it and asserting on its content -- never by trusting
> the generation step's own report of what it did. The same rule applies to
> any capture-derived probe (see "Verifying with capture-derived probes").

### Phase 4 -- Classify Auth

Run the heuristic on the scrubbed HAR:

| Signal | Classification |
|---|---|
| `Set-Cookie` only, no Authorization header | `cookie` |
| Cookie + `X-CSRF-Token` (or `X-Requested-With`) | `cookie+csrf` |
| `Authorization: Bearer ...` with no IdP redirect | `bearer` |
| Redirect chain through `accounts.google.com` -> bearer | `sso-google` |
| Redirect chain through `login.microsoftonline.com` -> bearer | `sso-microsoft` |
| Redirect chain through `facebook.com/v*/dialog/oauth` -> bearer | `sso-facebook` |
| Discovery doc + PKCE params + `code_challenge_method=S256` | `oauth2-pkce` |

Emit a JSON manifest the codegen step consumes.

### Phase 5 -- Endpoint Deduplication

- Group HAR entries by `(method, path-template)` where UUIDs / numeric
  ids / known dynamic segments normalize to `{id}`.
- Merge response shapes across samples; fields seen in some-but-not-all
  samples are marked nullable/optional.
- Detect GraphQL: POST to `*/graphql*` with `{query, variables}`. When
  detected, emit a single `QueryAsync<T>` client plus typed convenience
  methods per observed `operationName`.

#### Interpreting captured responses

The single highest-value lesson from dogfooding this skill: **HTTP status
alone does not tell you whether a request succeeded.** Real platforms mix
these patterns in the same session, and a naively generated client gets all
three wrong:

| Observed | Actually means | Naive client reports |
|---|---|---|
| `200` + `{"errors":[{"severity":"CRITICAL"}]}` | **Failure** (e.g. GraphQL) | success |
| `202` + `{"message":"...not finished yet.","status":"fail"}` | **Retry** (async processing still running) | failure |
| `400` + `{"message":"feedback_required", ...throttle marker}` | **Throttled -- retry later** | malformed request |

The throttling case is the most expensive to misdiagnose: the identical
payload succeeds on retry, so an engineer can burn real time "fixing" a
request that was never wrong. Classify outcomes from **status + body
shape**, not status alone, and have the generator emit distinct
result/exception types for `retryable-transient`, `retryable-throttled`,
and `permanent` failure. Add a detection pass over the endpoint catalog
that flags any endpoint observed returning the same body shape under
multiple status codes -- that's the signature of this problem.

Two more parsing gotchas that show up as opaque failures if unhandled:

- **Vendor JSON prefixes.** Some AJAX endpoints prefix bodies with a
  guard string such as `for (;;);` before the JSON payload.
- **Encoded bodies.** Some probe/status endpoints (e.g. resumable-upload
  polling) return **base64-encoded** JSON rather than JSON directly.

Maintain a known-prefix / known-encoding table and have the generated
deserializer strip/decode these before parsing, instead of surfacing a raw
JSON-parse error.

**Publishing/creation can return before the resource is usable.** Async
media processing (transcode, indexing) means a create call can return
success while the resource isn't yet readable -- this races any immediate
read-back, follow-up edit, or cleanup delete performed right after. The
generated client should expose an explicit "wait until usable" step (poll
with backoff), generated functional tests must poll rather than assume
immediate availability, and cleanup logic must not interpret "not visible
yet" as "nothing to delete."

### Phase 6 -- Code Generation

Emit, into the output directory:

```
<Name>/
├── <Name>.slnx
├── Directory.Build.props
├── .gitignore                              # consumer-root: appended with Samples/HAR-Original/ + Samples/MobileApp-Binaries/ (idempotent)
├── .githooks/pre-commit                    # gitleaks
├── .gitleaks.toml                          # HAR-aware rules
├── .github/workflows/ci.yml                # build + test + gitleaks
├── samples/
│   ├── har-original/.gitkeep
│   └── har/<timestamp>.har                 # scrubbed
├── src/
│   ├── <Name>/                             # typed client + DTOs
│   │   ├── <Name>Client.cs                 # user-editable
│   │   ├── <Name>Client.g.cs               # generated, do not edit
│   │   ├── Models/*.g.cs
│   │   └── Authentication/
│   │       ├── ISessionStore.cs
│   │       ├── DpapiSessionStore.cs        # Windows
│   │       ├── UserSecretsSessionStore.cs  # cross-platform
│   │       ├── <Name>Authenticator.cs
│   │       └── OAuthAuthenticator.cs       # only if oauth2-pkce
│   ├── <Name>.Mcp/                         # MCP server
│   └── <Name>.PowerShell/                  # PowerShell module
└── tests/
    ├── <Name>.FunctionalTests/             # xUnit + SkippableFact
    ├── <Name>.UnitTests/                   # xUnit + Moq
    └── <Name>.PowerShell.Tests/            # Pester 5
```

Generated rules:

- All generated files end in `*.g.cs` and contain
  `// <auto-generated/>`. Re-running the skill only rewrites these.
- Removed endpoints get `[Obsolete]` markers, not deletion.
- Public types get XML doc comments (Phase 6 inserts placeholder
  `/// <summary>TODO</summary>` where it can't infer better).
- POST / PUT / DELETE wrappers are decorated `[Experimental]` until the
  user marks them stable.
- MCP tool descriptions are first-drafted from `(method, path-template,
  response keys, query params)` with `// TODO: refine`.
- **Emit the full browser header set on every generated request by
  default**, not just cookies. Modern anti-bot stacks gate authenticated
  GETs on Sec-Fetch / client-hint headers (`sec-ch-ua*`, `sec-fetch-dest`,
  `sec-fetch-mode`, `sec-fetch-site`, `sec-fetch-user`,
  `upgrade-insecure-requests`) as well as the session cookie. A bare `400`
  with a small, generic body when replaying a captured request is the
  signature of a missing-header problem, not a stale-credential problem --
  document this explicitly in the generated troubleshooting notes so it
  isn't misdiagnosed as a re-auth bug.
- **Detect and model multi-step resumable upload protocols** rather than
  assuming a single-request wrapper. Media upload endpoints commonly follow
  a five-phase shape: (1) start session -> returns an upload/video id plus
  a byte-offset range, (2) a resume probe (GET) that returns the current
  offset, (3) byte upload (POST) carrying offset / entity-length /
  entity-name / entity-type headers with raw bytes as the body, (4) a
  receive/finish call confirming the offset range is complete, (5) poll
  for transcode completion, then attach the resulting id to the
  create/configure call. Detect this shape by offset-bearing headers or a
  URL containing an `-<start>-<end>` range or an `upload_id`/`video_id`,
  and generate a resumable uploader -- not a single POST -- when detected.
  Resume support is not optional for large files.
- **Never hardcode API version identifiers scraped from a single
  capture** (e.g. a GraphQL `doc_id`). These rotate over time, and a
  hardcoded default going stale breaks the wrapper completely. Generated
  clients must (a) prefer a scraped/refreshed value over a baked-in
  constant, (b) treat "document/version not found" as a dedicated,
  self-describing error that names the refresh procedure, and (c) carry an
  explicit warning that a rotation may change the *payload schema*, not
  merely the identifier -- a second failure (e.g. a newly required
  variable) can appear only after the id is refreshed.
- **Copy the whole captured variables/payload blob verbatim**, parameterizing
  only fields proven to vary across multiple captures, rather than
  hand-picking the fields that look meaningful. Real mutations can carry
  dozens of internal provider flags and tracking/session fields that are
  silently required; omitting them produces a "missing required variable"
  error that does not say which variable is missing. Fields shaped like
  `idempotence_token` / `client_mutation_id` are the one exception: they
  must be **regenerated per request**, never replayed from the capture.
- **Do not hardcode upload/API hosts.** Hosts are commonly region-sharded
  (e.g. multiple distinct upload hosts observed within a single session).
  The start-session response names the host to use for subsequent steps --
  read it from there rather than baking in a constant.
- **Generate realistic media fixtures**, not trivially small synthetic
  files -- some platforms accept a near-empty sample file while others
  reject it outright, and a tiny file transcodes instantly, which hides
  the async-transcode race the client actually needs to handle (see
  "Interpreting captured responses" above). A representative fixture
  recipe:

  ```bash
  ffmpeg -f lavfi -i "testsrc=size=1080x1920:rate=30:duration=6" \
         -f lavfi -i "sine=frequency=440:duration=6" \
         -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k \
         -shortest -movflags +faststart out.mp4
  ```

  Generated clients must also send probed media metadata (duration,
  height, width) with the upload rather than guessing it.

**Authenticator contract (issue #97).** The generated
`<Name>Authenticator.cs` must use `Microsoft.Playwright` directly to run
the interactive sign-in ceremony. It must **never**:

- Accept a username / password parameter -- the wrapper never sees the
  user's credentials.
- POST credentials to a `/login` endpoint over `HttpClient`.
- Shell out to `node scripts/capture-cdp.js` for runtime auth.

The required shape is:

1. `using Microsoft.Playwright;`
2. `Playwright.CreateAsync` -> `playwright.Chromium.LaunchAsync(new
   BrowserTypeLaunchOptions { Headless = false, Channel = "chrome" })`.
3. `context.NewPageAsync().GotoAsync(BaseUrl)`.
4. Print a console prompt asking the user to complete sign-in (any IdP,
   any 2FA flow -- it's a real browser) and press Enter on the console.
5. After the user signals completion, capture session credentials from
   the live browser context: `context.CookiesAsync()` (joined as the
   `Cookie` header) plus a best-effort CSRF token via
   `page.EvaluateAsync<string?>(...)`. Persist via `ISessionStore`.

The generated csproj declares `<PackageReference Include="Microsoft.Playwright" />`.

Reference implementation pattern:
`D:\Git\CodiwomplerSocialMedia\src\CodiwomplerSocialMedia.Cli\PlaywrightCredentialSetup.cs`.

### Phase 7 -- Tests

Generate:

- `tests/<Name>.UnitTests/` -- HTTP roundtrip via `HttpMessageHandler`
  mock asserting URL, method, and request DTO serialization.
- `tests/<Name>.FunctionalTests/` -- one `SkippableFact` per endpoint
  group; skipped when no live cookie is in user-secrets or env. Loads
  fixtures from `tests/fixtures/` (anonymized resource IDs captured in
  Phase 2).
- `tests/<Name>.PowerShell.Tests/` -- Pester 5, one `Describe` per cmdlet.

#### Verifying with capture-derived probes

Any verification probe built from a capture (a functional test's
"is this page in the expected state" check, a dogfood smoke test, etc.)
must have a **positive control** -- proof it's actually looking at the
right thing -- or it will produce false results in both directions. The
concrete failure mode observed: a detector fetched a page and reported
"clean" when a marker string was absent -- and reported "clean" for a
**400 error page**, because the marker was absent for entirely the wrong
reason. After the fetch itself was fixed, the same detector then reported
a false positive for pages that were plainly fine, because the marker also
occurred in unrelated page chrome.

Require every capture-derived probe to:

- refuse to emit a verdict unless the response is `200`, exceeds a
  plausible minimum size, **and** matches a positive control proving the
  intended page/resource actually loaded (not merely that an error page
  loaded successfully);
- emit an explicit `Unknown` result -- never a negative verdict -- when
  the positive control can't be evaluated;
- scope the search to the entity under test rather than the whole
  document/response, since page chrome and admin UI routinely repeat the
  same identifiers as the content under test.

### Phase 8 -- Security Gates

- `.githooks/pre-commit` invokes gitleaks; activated via
  `git config core.hooksPath .githooks`.
- `.gitleaks.toml` adds HAR-aware rules (JWT, long hex, email,
  Bearer-token regex).
- `.github/workflows/ci.yml` runs gitleaks on PRs and **fails on hit**.
- `samples/har-original/` is gitignored. The CI workflow includes a
  belt-and-suspenders step that fails if any file under that path is
  present in the commit tree.
- `.har-profile.json` is gitignored. It carries the operator's salt and
  their literal -> sentinel map -- their own account identifiers -- and is
  an operator secret, not project configuration.
- `.har-substitutions.json` is gitignored **by name**. The legacy
  substitution map is keyed by `<kind>:<original>`, so its *keys* are the
  secrets, and it is written beside the scrubbed HAR -- inside a committed
  directory. Ignoring only the directory is not enough. (The typed-PII store
  `.substitutions.json` is different: it records hash prefixes, not values,
  and is safe to commit.)
- CI runs `verify-har-reference.js` over `docs/har-reference/` when that
  directory exists, so a committed reference is gated on every PR, not only
  when it was written. (The script exits non-zero on a missing or empty
  reference directory: being pointed at nothing is a wiring mistake, not a
  pass.)
  The literal check reports as skipped there (the profile is gitignored and
  absent in CI); the truncation, credential and nested-secret gates all run.
- `sanitize-har.js` (Phase 3) must treat at least the following as
  secrets, in addition to its pattern-based JWT/hex/UUID/email scrubbing --
  all of these have been observed in plaintext in real captures and are
  not caught by generic token-shape patterns alone:
  - **Cookies:** any session cookie (`c_user`, `xs`, `datr`, `fr`, `sb`,
    `sessionid`, `ds_user_id`, `csrftoken`, `mid`, `ig_did`, and
    equivalents for other platforms).
  - **Body/param fields:** CSRF-adjacent and request-signing fields such
    as `fb_dtsg`, `lsd`, `jazoest`, and `__spin_r` / `__spin_b` /
    `__spin_t` / `__hs` / `__hsi` / `__csr` / `__hsdp` / `__req` /
    `__rev`-shaped fields -- these are short and don't match a hex/UUID
    pattern, so they need field-name-based scrubbing, not just
    pattern-based.
  - **Headers:** platform request-signing headers such as `x-fb-lsd`,
    `x-asbd-id`, `x-ig-app-id`, and upload-parameter headers that embed an
    id (`x-instagram-rupload-params` and equivalents).
  - **Response fields:** upload/session handle tokens returned in
    response bodies (e.g. a `{"h": "1:<base64>:<mime>:<token>:e:<expiry>:<sig>"}`
    shaped handle) -- these are credentials even though they never touch a
    request header.

### Pipeline entry point: `run-agent.js`

Once a HAR has been captured (Phase 2), the entire downstream pipeline
(Phases 3 - 8) can be invoked through a single zero-dependency orchestrator:

```pwsh
node templates/api-wrapper-scaffold/scripts/run-agent.js `
  --har <path/to/captured.har> `
  --out <output-dir> `
  --project <Name> `
  --namespace <Namespace> `
  [--base-url <https://x>] `
  [--authors <s>] [--description <s>] `
  [--repository-url <s>] [--package-tags <s>] `
  [--profile <path>] [--fixed-time <iso8601>]
```

`--profile` defaults to the nearest `.har-profile.json` at or above `--out`.
There is no default salt and no default literal map: without a profile the
run stops and names the file it needs.

`run-agent.js` prints a clear stage banner (`==> Stage: <name>`) before each
step and chains them in order:

1. `sanitize-har.js`  -- regex + typed-PII scrub; writes
   `<out>/.run-agent/scrubbed.har` and `substitutions.json`.
2. `verify-scrub.js`  -- asserts no plaintext PII / token leaked.
3. `detect-auth.js`   -- classifies the HAR; result lands in
   `<out>/.run-agent/auth.json` and is fed to the next stage.
4. `generate-wrapper.js` -- emits the complete buildable project tree.

The runner exits with the first failing stage's exit code (fail-fast), so a
regression anywhere in the pipeline produces an obvious banner pointing at
the broken stage.

### End-to-end smoke test

The executable spec for this skill is
[`.github/agents/tests/agent-e2e.Tests.ps1`](../../agents/tests/agent-e2e.Tests.ps1).
It runs `run-agent.js` against the synthetic HAR fixtures
`tests/fixtures/har/e2e-rest.har` and `tests/fixtures/har/e2e-graphql.har`,
then asserts the emitted project:

- contains the canonical file tree (Client.cs, *.Generated.cs, Authenticator,
  session stores, McpProgram.cs, secret-gate files, tests project),
- builds with `dotnet build` -- 0 warnings, 0 errors,
- passes `dotnet test` -- every emitted `[Fact]` green,
- passes the emitted Pester smoke (`tests/<Name>.Tests/pester/Mcp.Tests.ps1`),
- is byte-identical on a second run (determinism),
- has `GraphQLAsync<T>` (not REST methods) when the input HAR is GraphQL.

A regression in any prior pipeline script causes this single test to fail
with a clear stage banner -- treat it as the skill's regression detector.

### Phase 9 -- Capture Helper

Runtime authentication is handled by the C# `<Name>Authenticator`
generated in Phase 6, which uses `Microsoft.Playwright` directly (see
the Authenticator contract above). This phase only generates a thin
PowerShell convenience wrapper:

- `scripts/connect-<name>.ps1` -- invokes the wrapper's `Connect-<Name>`
  cmdlet, which calls `<Name>Authenticator.BrowserLoginAsync` and
  persists the result via `ISessionStore` (DPAPI on Windows, file-mode
  0600 on POSIX).
- Subsequent runs: if a fresh stored session exists, the wrapper uses it
  silently; otherwise it re-launches the Playwright browser for
  re-authentication.
- `scripts/capture-har.js` (the Node-based Playwright recorder behind
  `Start-HarRecording`) is used **only** for the Phase 2 recording flow
  during initial scaffold generation. It is **not** used for runtime
  authentication -- the wrapper consumer never needs Node.js installed.
  `scripts/capture-cdp.js` is its predecessor: a single launch-and-wait
  helper with no stop, no snapshot, and no CDP attach. Prefer
  `capture-har.js` for anything new.
- `--storage-state <path>` is still supported on the recorder so
  non-interactive runs (CI, dogfood) skip interactive login during Phase 2.

### Phase 10 -- Generated README

Per-endpoint recipe section in the project README:

- One `curl` example.
- One PowerShell `Invoke-RestMethod` example (and the corresponding
  generated cmdlet).
- Sample request / response taken from the scrubbed HAR.
- For SSO / OAuth projects, explicit text identifying the IdP and the
  re-auth procedure (re-run `connect-<name>.ps1`).
- Polite-crawl override documentation.
- NuGet packaging notes (Description, Authors, RepositoryUrl,
  PackageLicenseExpression, version-from-git already filled in).

### Phase 10.5 -- Initialize git repository

Before Phase 11 runs, the agent **must** initialize the generated project
as a git repository:

```pwsh
cd <output-dir>
git init -b main
git add -A
git commit -m "chore: initial scaffold from api-wrapper-scaffold skill"
```

The initial commit is what `Pull-SDLC.ai.ps1` merges into during Phase 11,
so this step is mandatory whether or not the developer opts into the SDLC
pull. Skipping `git init` leaves the project in a fragile, unversioned
state and forces a manual remediation step on the developer.

### Phase 11 -- IntelliSDLC.ai Seed (required prompt; user may decline)

Immediately after Phase 10.5 (`git init`), the agent **must** prompt:

> Pull the IntelliSDLC.ai shared instructions, skills, and agents into
> this project and add an `sdlc.ai` git remote? [Y/n]

Default is `Y`. On `Y`, run `Pull-SDLC.ai.ps1` from the project root --
this adds a remote called `sdlc.ai` pointing at the IntelliSDLC.ai
repository, merges the upstream `main` into the project's initial
commit (using `--allow-unrelated-histories` on first sync), and
materializes `CLAUDE.project.md` and `project.instructions.md` from
their templates. Populate the identity sections of both files from the
project name and namespace.

On `n`, print the manual-run hint (`git clone ... ; Pull-SDLC.ai.ps1`)
so the developer can opt in later without re-running the agent.

## Output

The skill's final user-visible output is:

```markdown
**Generated**: D:\Git\<Name>
**Solution**: <Name>.slnx
**Auth**: <classification>
**Endpoints wrapped**: <count> (GET <n> / POST <n> / DELETE <n>)
**Build**: dotnet build  -> PASS
**Tests**: dotnet test   -> <n>/<n> pass
**Gitleaks**: 0 hits
**Next**: cd D:\Git\<Name>; @dev-loop
```

## Anti-patterns

- **Do not** invent endpoints not present in the captured HAR.
- **Do not** ship a project that fails `dotnet build`.
- **Do not** commit anything in `samples/har-original/` -- this is a
  hard CI failure on the generated project.
- **Do not** commit a `.har-profile.json`. It holds the operator's real
  identifiers; it is gitignored for the same reason `samples/har-original/`
  is.
- **Do not** give the literal map or the salt a default value so the tooling
  "just runs". An absent profile must fail loudly and name the file.
- **Do not** trust a generation step's report of what it wrote. Verify a
  committed reference by parsing it and asserting on its content.
- **Do not** hardcode the user's real cookies / tokens / OAuth secrets
  anywhere except DPAPI / user-secrets.
- **Do not** generate per-endpoint POST/PUT/DELETE wrappers without the
  `[Experimental]` attribute on first scaffold.

## Reference projects

The skill's templates are derived from two manually-scaffolded
reference projects:

- `D:\Git\TripItEx` (cookie + CSRF, federated SSO via Google)
- `D:\Git\GoogleVoiceEx` (cookie + bearer, federated SSO via Google)

The dogfood validation (see issue #34, `agent-dry-run` todo) re-runs
this skill against `tripit.com` using a pre-captured
`storageState.json` and diffs the generated tree against the manual
reference. A successful run is the acceptance gate for promoting the
skill out of `@experimental`.
