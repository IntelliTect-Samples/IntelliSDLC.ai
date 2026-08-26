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
generated.

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

### Phase 2 -- Probe with Playwright

- Launch chromium via Playwright (CDP attach so the user can interact).
- If a `storageState.json` was supplied, load it and skip interactive
  login.
- Capture all network traffic to a HAR file (`samples/har-original/<timestamp>.har`).
- Use the `templates/api-wrapper-scaffold/scripts/capture-cdp.js`
  template as the baseline.
- Polite crawl: respect robots.txt, throttle to ~1 req/sec on automated
  traversal, descriptive User-Agent.

#### Capturing traffic reliably

Lessons from hand-driven capture sessions against production sites -- each
of these has cost real diagnosis time when skipped.

- **`--save-har` only flushes on browser close, not on process kill.**
  Stopping the Playwright driver process orphans the browser and **discards
  everything recorded so far**. Every capture instruction to the human must
  end with, in bold: "**close the browser window** -- that is what writes
  the file." Before moving on to Phase 3, verify the HAR file exists and is
  non-trivial in size; do not attempt to analyze a HAR that was never
  flushed.
- **Never terminate the browser to end a capture.** Killing Chrome processes
  can also destroy unrelated signed-in work elsewhere on the developer's
  machine. Always end a capture by asking the human to close the window.
  If more than one capture window may exist (a prior run wasn't cleaned up,
  or the human opened a second tab), **disambiguate before the human
  acts** -- list Chrome processes by `--user-data-dir` and creation time and
  tell the user exactly which window to use (e.g. "the one that opened 4
  minutes ago"). A human posting into the wrong window produces no capture,
  and the loss is silent until they've already done the work.
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
- `verify-scrub` asserts two invariants:
  - No original PII value appears in scrubbed output.
  - Every fake in output reverses via the table.
- Output written to `samples/har/`.
- **Before the scrubbed HAR is written, verify the capture path itself is
  covered by `.gitignore`.** `samples/har-original/` (the unscrubbed
  capture) must never be committable even transiently; treat a missing
  gitignore rule as a hard stop for the phase, not a warning.

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
  [--salt <s>] [--fixed-time <iso8601>]
```

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
- `scripts/capture-cdp.js` (the Node-based Playwright helper) is now
  used **only** for the Phase 2 HAR-discovery flow during initial
  scaffold generation. It is **not** used for runtime authentication --
  the wrapper consumer never needs Node.js installed.
- `--storage-state <path>` is still supported on the HAR-capture helper
  so non-interactive runs (CI, dogfood) skip the browser during Phase 2.

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
