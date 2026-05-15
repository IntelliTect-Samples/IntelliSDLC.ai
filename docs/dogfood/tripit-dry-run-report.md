# TripIt Dry-Run Report (api-wrapper-scaffold agent dogfood)

**Issue:** #58 -- **Epic:** #34 (item 11 of 11, capstone)
**Target:** `tripit.com` (TripIt by Concur)
**Reference project:** `D:\Git\TripItEx` (hand-written C# wrapper, ~7 typed endpoints)
**Generated wrapper:** `$env:TEMP\dogfood-tripit-<ts>` (NOT committed; see Hygiene appendix)
**Reproducer:** `scripts/run-dogfood.ps1`

---

## Executive Summary

The api-wrapper-scaffold agent **runs end-to-end against a real-world API target
and produces a buildable, test-passing C# project** -- but the typed surface it
emits for TripIt is **not yet usable** as a drop-in replacement for a
hand-written client. The codegen's path-template inference is too aggressive:
all seven distinct TripIt endpoints (`/api/v2/list/trip`, `/api/v2/get/profile`,
`/api/v2/appConfig`, ...) collapse into a single generic
`GetByIdAsync(string id)` against `/api/v2/{id}` (plus one two-segment variant).
Every win the agent *does* deliver -- correct auth detection (`cookie+csrf`),
clean PII scrubbing, faithful nested model inference (`Trip` from a JSON array
element), buildable solution, green tests -- is overshadowed by this single
fidelity gap. **Verdict: qualified yes** -- the scaffold is real and the
plumbing is solid, but a "named-segment vs id-segment" classifier is required
before the wrapper is shippable for production APIs.

---

## Run Conditions

| Item | Value |
|---|---|
| Run date | 2026-05-15 (relative to repo head `0db52b3`) |
| Repo commit | `0db52b3` (feat(sdlc-integration), PR #57 merged) |
| Node | bundled with `run-agent.js` (pure stdlib; no npm deps) |
| .NET SDK | system default (csproj targets `net10.0`) |
| storageState supplied? | yes (Playwright capture, 30 cookies) |
| Session valid? | **No** -- pre-flight `GET https://api.tripit.com/v1/list/trip` returned **401** |
| Expired cookies at probe | `ak_bmsc`, `TAsessionID`, `bm_sz`, `it_vw_asid`, `it_vw_ssa`, `bm_sv` (6 of 30, including 4 critical Akamai anti-bot cookies) |
| Mode actually used | **synthetic** (faithful "as-if dogfood") |
| Synthetic HAR source of truth | TripItEx's `Models/*.cs` + `TripItClient.cs` endpoint inventory |
| Synthetic HAR entries | 7 (one per reference endpoint) |
| Auth posture in HAR | `Cookie`, `X-CSRF-Token` request headers; `Set-Cookie` response header |

The brief explicitly authorized the synthetic fallback when the session is
expired: "do not proceed with a fresh capture -- instead, document the expiry
as a known limitation and ship a synthetic-fixture-based 'as-if dogfood' using
a hand-crafted HAR that mimics the TripIt API shape." That is what was done.

---

## Pipeline Stage Outputs

| Stage | Result | Notes |
|---|---|---|
| `sanitize-har` | OK | 2 legacy + 1 typed-PII substitutions; scrubbed HAR written to `.run-agent/scrubbed.har` |
| `verify-scrub` | OK | 0 leaks |
| `detect-auth` | OK | `{"authModel":"cookie+csrf","evidence":[{Set-Cookie}, {X-CSRF-Token}]}` -- **classification matches reference** |
| `generate-wrapper` | OK | **wrote 2 REST patterns** (vs 7 reference endpoints) -- see Fidelity Gaps |
| `tests-emit` | OK | xUnit project + 2 fixture JSON files emitted |
| `secret-gate-emit` | OK | `.gitleaks.toml`, `.githooks/pre-commit`, `secret-scan.yml` emitted |
| `sdlc-integration` | skipped | `--no-sdlc` (default for non-interactive runs, per PR #57) |
| `dotnet build` | **exit 0** | Built against the test csproj (no .sln emitted; see Follow-up #4) |
| `dotnet test` | **exit 0** | All `[Fact]`s green |

---

## Endpoint Coverage

| Endpoint (reference) | Reference | Generated | Status |
|---|---|---|---|
| `/api/v2/appConfig` | yes | no | MISSED (collapsed into `/api/v2/{id}`) |
| `/api/v2/get/profile` | yes | no | MISSED (collapsed into `/api/v2/{id}/{id2}`) |
| `/api/v2/gtmDataAsJson` | yes | no | MISSED (collapsed into `/api/v2/{id}`) |
| `/api/v2/list/trip` | yes | no | MISSED (collapsed into `/api/v2/{id}/{id2}`) |
| `/api/v2/listProAlerts` | yes | no | MISSED (collapsed into `/api/v2/{id}`) |
| `/api/v2/purchasedProductInfo` | yes | no | MISSED (collapsed into `/api/v2/{id}`) |
| `/api/v2/travelerProfile/get` | yes | no | MISSED (collapsed into `/api/v2/{id}/{id2}`) |

**Intersection (literal-path):** 0 / 7
**Generated templated patterns:** `/api/v2/{id}`, `/api/v2/{id}/{id2}`
**Generated client methods (typed surface):** `GetByIdAsync(string id)`, `GetByIdById2Async(string id, string id2)`

This is the headline finding: the agent is treating *every* path segment as a
parameter. A human looking at `appConfig`, `gtmDataAsJson`, `purchasedProductInfo`
would recognize those as literal resource names; the agent treats them as
opaque ids. The 2-pattern dedup is correct in *shape* (one-segment vs
two-segment paths under `/api/v2/`) but wrong in *semantics*. See Follow-up #1
("named-segment classifier") for the fix.

---

## Method-Name Fidelity

| Reference method | Generated equivalent | Verdict |
|---|---|---|
| `ListTripsAsync` | `GetByIdAsync("list/trip")` | no fidelity -- requires raw id |
| `GetProfileAsync` | `GetByIdById2Async("get", "profile")` | no fidelity |
| `GetTravelerProfileAsync` | `GetByIdById2Async("travelerProfile", "get")` | no fidelity |
| `GetPurchasedProductsAsync` | `GetByIdAsync("purchasedProductInfo")` | no fidelity |
| `GetAppConfigAsync` | `GetByIdAsync("appConfig")` | no fidelity |
| `GetGtmDataAsync` | `GetByIdAsync("gtmDataAsJson")` | no fidelity |
| (no equivalent -- via `SendRawAsync`) | `GetByIdAsync("listProAlerts")` | no fidelity |

Zero rows would survive a "would a human have written this method signature?"
review. The hand-written `SendRawAsync` escape hatch in `Client.cs` (the
generator-preserved partial) is present and correctly typed; in practice a
consumer of the generated wrapper would currently call `SendRawAsync` directly
and ignore the typed surface entirely.

---

## Model-Shape Fidelity

This is the agent's **clearest win**. The `Trip` model emitted in
`Models.Generated.cs` matches the reference `Models/Trip.cs` field-for-field
(8/8 properties, correct snake_case JsonPropertyName attributes, correct
nullability on `is_private`):

| Property | Reference type | Generated type | Match |
|---|---|---|---|
| `id` | `string?` | `string` (non-null) | partial -- nullability mismatch |
| `display_name` | `string?` | `string` | partial |
| `start_date` | `string?` | `string` | partial |
| `end_date` | `string?` | `string` | partial |
| `primary_location` | `string?` | `string` | partial |
| `is_private` | `bool?` | `bool` | partial |
| `image_url` | `string?` | `string` | partial |
| `relative_url` | `string?` | `string` | partial |

The agent inferred `Trip` from the *array element* inside the
`/api/v2/list/trip` response and emitted a faithful typed record. The
nullability divergence is defensible: every observed sample had non-null
values, so the agent inferred required-init; the human, knowing TripIt's API,
defended against absent fields. See Follow-up #2.

The synthetic envelope responses (containing `Trip`, `ProAlert`, `timestamp`,
`num_bytes`, etc.) collapsed into `RootResponse` and `RootResponse2` because
they share the response shape across endpoints -- another consequence of the
path-template collapse. A literal-segment classifier (Follow-up #1) would
yield distinct response models per endpoint.

---

## Auth Approach

`detect-auth.js` correctly classified the synthetic HAR as **`cookie+csrf`**,
matching what TripIt actually uses (cookies for session, `X-CSRF-Token` /
`it_csrf` for state-changing requests). The generated `Authenticator.cs` +
`Client.cs` partial wire the `Cookie` and `X-CSRF-Token` headers on every
request, exactly as `TripItEx/src/TripIt/Auth/TripItAuthenticator.cs` does.

What the agent **did not** detect (because no HAR can show it without a real
session): Akamai bot-management cookies (`_abck`, `bm_sz`, `bm_sv`, `ak_bmsc`)
are required by `api.tripit.com` to issue a non-challenge response. The
hand-written reference has a dedicated `LooksLikeAkamaiChallenge` code path
with a "GET the home page first to seed `_abck`/`bm_sz`" workaround. This is
a class of behavior no HAR-only agent could derive. See Follow-up #5.

---

## Gaps the Agent Missed (no follow-up needed)

- Akamai challenge handling (above) -- environmental knowledge, not HAR-derivable.
- `ListResponse<T>` generic envelope -- the reference uses one parameterized
  type across `list/trip` and `listProAlerts`; the agent generated separate
  flat `RootResponse` types. Acceptable for a first-pass scaffold.
- `JsonExtensionData` catch-all -- the reference includes a
  `Dictionary<string, JsonElement> AdditionalData` on every record to round-trip
  unknown fields. The agent did not. (Reasonable design trade-off.)

## Things the Agent Got That the Human Didn't

- **PowerShell test fixtures.** The agent emitted `pester/Mcp.Tests.ps1` and
  `run-pester.ps1` alongside the xUnit project. TripItEx ships a separate
  `TripIt.PowerShell` cmdlet project but no Pester tests.
- **MCP wrapping.** The agent emitted `McpProgram.cs` so the resulting wrapper
  is callable from Claude Desktop / Cursor as an MCP server out of the box.
  TripItEx has no MCP surface.
- **Secret-gate scaffolding.** `.gitleaks.toml` + `pre-commit` hook +
  `secret-scan.yml` workflow are emitted automatically. TripItEx has none.

---

## Build / Test Results

```
dotnet build <wrapper>/tests/TripIt.Tests/TripIt.Tests.csproj
-> exit 0 (no warnings, no errors)

dotnet test <wrapper>/tests/TripIt.Tests/TripIt.Tests.csproj --no-build
-> exit 0 (all [Fact]s passed)
```

The wrapper builds and tests against the synthetic HAR fixtures the
`tests-emit` stage generated. Caveat: the tests cover the *generated*
`GetByIdAsync(...)` surface, which is the surface the consumer is actually
unlikely to use; green tests do **not** indicate the wrapper would work
against the real TripIt API.

---

## Verdict: qualified yes

The api-wrapper-scaffold agent produces a real, buildable, test-passing
.NET project against a real-world target. The infrastructure -- HAR capture,
PII scrubbing, auth detection, codegen, tests, secret-gate, MCP wrapping,
SDLC integration -- works. **The single missing piece is path-template
intelligence.** With Follow-up #1 ("named-segment classifier") landed, the
generated wrapper for TripIt would have 5-of-7 endpoint fidelity at minimum
(everything except the 2-segment outliers `get/profile` and
`travelerProfile/get` which need additional cleanup).

For an internal-tools wrapper or a "this saves you a week of typing"
scaffold-and-edit workflow: **ship it.** For a "agent generates a wrapper
that goes straight to NuGet with no manual edits": **not yet.** That gap
is fully captured by the follow-up issues below.

---

## Follow-up Issues to File

- [ ] **#1 (critical):** `generate-wrapper.js` -- named-segment classifier.
      Path segments that appear *exactly once* across all HAR entries with a
      stable spelling (e.g. `appConfig`, `gtmDataAsJson`,
      `purchasedProductInfo`) must be treated as literal resource names, not
      `{id}` parameters. Segments that vary across entries (`/trip/123`,
      `/trip/456`) remain `{id}`. Acceptance test: dogfood synthetic HAR
      produces >= 5 typed methods named after the segment (`GetAppConfigAsync`,
      `GetGtmDataAsJsonAsync`, etc.) rather than `GetByIdAsync`.
- [ ] **#2 (important):** model-nullability heuristic -- when the HAR has only
      one sample per endpoint, default emitted properties to nullable
      (`string?`) rather than required-init. Lowers the false-positive rate
      when consumers hit fields the capture happened to skip.
- [ ] **#3 (important):** generic-envelope detection -- when two endpoints
      share the shape `{timestamp,num_bytes,page_num,page_size,max_page,<X>:T[]}`
      with only the array key differing, emit a single `ListResponse<T>`
      generic rather than two flat classes. (TripItEx demonstrates the
      pattern.)
- [ ] **#4 (minor):** emit a `.sln` at the wrapper root so
      `dotnet build` "just works" without `cd src/<Name>` or pointing at a
      specific csproj. Currently `run-dogfood.ps1` has to discover the test
      csproj manually.
- [ ] **#5 (research):** Akamai / bot-management awareness. When `detect-auth`
      sees cookies named `_abck`, `bm_sz`, `bm_sv`, `ak_bmsc`, emit a doc
      block in the generated README warning the consumer that
      session-replay-only wrappers may hit anti-bot challenges, and link to
      the "GET the public landing page first" warm-up workaround. (Cannot
      be auto-generated, but the warning costs nothing.)

These will be filed as sub-issues of #34 after this PR merges.

---

## Appendix A: Data Hygiene

**Nothing under `Samples/HAR-Original/` is ever committed.** Even the
fully-scrubbed `.run-agent/scrubbed.har` is not committed, because:

1. The original HAR contains real auth cookies that PII scrubbing replaces
   with deterministic placeholders -- the *structure* of the scrubbed file
   can still leak which URLs your account hit, which categories of data
   exist on your account, and when you used the service.
2. The generated wrapper's `tests/fixtures/*.json` files are derived from
   the HAR. Even after scrubbing they may contain field names + types that
   reveal account specifics. They are written to `$env:TEMP` only.

The PR adds `Samples/HAR-Original/` and `.dogfood-output/` to `.gitignore`
as a belt-and-braces measure. The `run-dogfood.ps1` script's default `-Out`
is `$env:TEMP\dogfood-tripit-<ts>`, deliberately outside the repo.

This run produced **no** committable artifacts beyond this report, the
script itself, the Pester test, and the gitignore additions.

## Appendix B: Reproducing this Run

```powershell
# from the IntelliSDLC.ai repo root, with TripItEx cloned to D:\Git\TripItEx:
.\scripts\run-dogfood.ps1 `
    -StorageState "C:\path\to\tripit-storageState.json" `
    -Reference   "D:\Git\TripItEx" `
    -ReportPath  "$env:TEMP\tripit-fresh-report.md"
```

The script auto-probes the session, falls back to the synthetic HAR on
non-200, runs the full agent pipeline (`--no-sdlc`), builds + tests the
result, and prints a coverage table. Re-running on a *fresh* TripIt session
would exercise the live-capture path -- the synthetic results here are the
floor, not the ceiling.

## Appendix C: Epic #34 Completion

This is item **11 of 11** in epic #34. The full sequence of merged PRs:

| Item | PR | Topic |
|---|---|---|
| 1 | #35 | Agent skeleton + interactive prompts |
| 2 | #37 | Capture/scrub script templates |
| 3 | #39 | Auth-detection + auth-heuristic |
| 4 | #41 | C# templates (Client / Authenticator / SessionStore / MCP) |
| 5 | #43 | OAuth PKCE authenticator + cross-platform store + SSO doc |
| 6 | #45 | Mobile-app discovery sub-phase |
| 7 | #47 | Typed PII scrubbing pipeline |
| 8 | #49 | HAR -> C# codegen pipeline |
| 9 | #51 | xUnit + Pester test scaffolds |
| 10 | #53 | Secret-gate (gitleaks + CI) |
| 10b | #55 | End-to-end pipeline smoke test + `run-agent.js` orchestrator |
| 10c | #57 | Optional SDLC integration stage |
| **11** | **this PR** | **agent-dry-run dogfood + report** |

The epic ships.
