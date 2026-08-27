# Rename the skill to `web-api-discovery` and group its scripts by concern

- Issue: https://github.com/IntelliTect-Dev/IntelliSDLC.ai/issues/279
- PR:    (filled in once the PR exists)
- Slug:  279-web-api-discovery

## Overview

Two cleanups deferred from #270, done together because they touch the same
files and doing them separately pays the reference-rewrite cost twice.

1. **Rename** `api-wrapper-scaffold` -> `web-api-discovery` across the skill,
   the agent stub, and the template tree, and reword the description so it
   leads with *recording* and treats codegen as the continuation.
2. **Regroup** the 36 flat files under `templates/<skill>/scripts/` into
   `scripts/{capture,har,codegen}/`.

This is a pure move-and-rewrite refactor. No script behavior changes.

## Approved Design

### 1. Naming

| Old | New |
|---|---|
| `.github/skills/api-wrapper-scaffold/` | `.github/skills/web-api-discovery/` |
| `.github/agents/api-wrapper-scaffold.agent.md` | `.github/agents/web-api-discovery.agent.md` |
| `templates/api-wrapper-scaffold/` | `templates/web-api-discovery/` |

Skill/agent `name:` becomes `web-api-discovery` / `"Web API Discovery"`. The
`description:` is rewritten to lead with recording:

> Record a web session to a HAR, scrub it, and extract a reviewable API
> reference from the observed traffic -- then optionally generate a buildable
> .NET wrapper project from it. Use when the user asks to record/capture a
> site's network traffic or HAR, discover an undocumented API, wrap an API,
> or generate a client from a website.

A capture that stops at the catalogue is a first-class outcome, so codegen
appears after "then optionally".

### 2. Script grouping

Grouped by **concern**, tests **co-located with their subject** (decision
below), giving three folders and no fourth `tests/` heap:

```
templates/web-api-discovery/scripts/
├── capture/   4 src,  0 test
├── har/      12 src,  7 test
└── codegen/   8 src,  5 test
```

| folder | source files |
|---|---|
| `capture/` | `capture-har.js`, `capture-cdp.js`, `Start-HarRecording.ps1`, `Stop-HarRecording.ps1` |
| `har/` | `sanitize-har.js`, `verify-scrub.js`, `Invoke-SanitizeHar.ps1`, `pii.js`, `pii-enrich.js`, `har-secrets.js`, `har-shapes.js`, `har-literals.js`, `har-profile.js`, `extract-har-reference.js`, `verify-har-reference.js`, `detect-auth.js` |
| `codegen/` | `generate-wrapper.js`, `generate-wrapper-helpers.js`, `tests-emit.js`, `sln-emit.js`, `secret-gate-emit.js`, `sdlc-integration.js`, `run-agent.js`, `import-mobile-app.js` |

| folder | co-located tests |
|---|---|
| `har/` | `har-literals`, `har-profile`, `har-reference`, `known-secret-fields`, `literal-scrub`, `scrubber-hex-isfake`, `verify-scrub-cc-timestamp` |
| `codegen/` | `dedupe-patterns`, `envelope`, `gitignore-bootstrap`, `nullability`, `readme-mobile-import-section` |

Only two `require`s cross a folder boundary after the move:

- `codegen/generate-wrapper.js` -> `../har/detect-auth.js`
- `codegen/run-agent.js` -> `../har/har-profile.js`

Every PowerShell wrapper stays in the same folder as the `.js` it shells to:
`Invoke-SanitizeHar.ps1` -> `sanitize-har.js` / `verify-scrub.js` (both
`har/`); `Start-`/`Stop-HarRecording.ps1` -> `capture-har.js` (both
`capture/`).

### 3. Decisions taken during planning

**Tests are co-located, not gathered into `scripts/tests/`.** The existing
carve-out in `$script:UpstreamPrivatePrefixes` is

```
'^templates/(?:[^/]+/)*[^/]+\.test\.js$'
```

which matches on **filename at any depth**, not on a `tests/` directory. Under
co-location it keeps working untouched at the new paths, and the subtlety the
issue flags -- that `templates/<skill>/csharp/tests/` holds test-project
templates the generator must emit into a consumer's own solution -- never
arises, because that rule is deliberately narrower than the `tests|fixtures`
directory rule above it. Both halves are pinned by test regardless.

**No old paths are added to `$script:UpstreamManagedPaths`.** The issue
proposed following the `Consolidate-Tasks.ps1` retired-filename precedent.
That precedent exists for **root-level files with no covering prefix** --
`Get-UpstreamOps` passes the managed paths to `git diff --name-status -M -B`
as *pathspecs*, so a root file that is not itself listed is invisible to the
diff. All three renamed trees already sit under directory prefixes that are
on the list (`.github/skills/`, `.github/agents/`, `templates/`), so the
rename is already inside the pathspec on both sides. Separately, the user
confirmed **no consumer ever received the old paths**, so no
backwards-compatibility replay is required at all. Adding the entries would
be dead configuration.

Consequence for the issue's acceptance list: the "test that the skill rename
replays into a consumer tree" item is dropped as moot. The
`$script:UpstreamPrivatePrefixes` both-halves test replaces it as the sync
coverage for this change.

## Implementation Checklist

- [ ] **T1 (red).** `Pull-SDLC.ai.Tests.ps1`: pin both halves of the
      `*.test.js` carve-out at the *new* paths --
      `templates/web-api-discovery/scripts/har/har-literals.test.js` is
      upstream-private; `templates/web-api-discovery/csharp/tests/ClientTests.cs.tmpl`
      is **not**. Fails before the move (paths do not exist / stale name).
- [ ] **T2.** `git mv` the three trees to the `web-api-discovery` name.
- [ ] **T3.** `git mv` the 36 script files into `capture/`, `har/`, `codegen/`.
- [ ] **T4.** Fix intra-tree references: `require(...)` paths (incl. the two
      cross-folder ones), `Join-Path $PSScriptRoot`/`$scriptDir` in the three
      `.ps1` wrappers, and any `__dirname`-relative spawns inside the tests.
- [ ] **T5.** Rewrite external references: `.github/copilot-instructions.md`
      (skills + agents tables), the agent stub, `SKILL.md` self-references,
      `.github/agents/tests/*.Tests.ps1` (`$script:ScriptsDir` roots),
      `templates/web-api-discovery/README.md`, `csharp/tests/manifest.json`,
      `scripts/run-dogfood.ps1`, `Pull-SDLC.ai.ps1` comments.
- [ ] **T6.** Update skill + agent `name:` and `description:` frontmatter.
- [ ] **T7 (green).** `Invoke-Pester ./Pull-SDLC.ai.Tests.ps1`,
      `Invoke-Pester .github/agents/tests/`, and every `node scripts/**/*.test.js`.
- [ ] **T8.** `grep -rn "api-wrapper-scaffold"` returns only `docs/` history.

## Acceptance

- [ ] `Invoke-Pester ./Pull-SDLC.ai.Tests.ps1` green, incl. the both-halves
      carve-out test at the new paths
- [ ] `Invoke-Pester .github/agents/tests/` green
- [ ] Every node `*.test.js` green after the moves
- [ ] `grep -rn "api-wrapper-scaffold"` returns only historical docs under `docs/`
- [ ] A dry-run sync into a scratch consumer receives the renamed tree, the
      regrouped scripts, and no `*.test.js`
