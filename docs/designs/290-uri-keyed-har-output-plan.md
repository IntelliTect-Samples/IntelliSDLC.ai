# 290 -- Key the HAR capture output locations on the captured URI

- **Issue:** [#290](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/290)
- **Branch:** `feat/290-uri-keyed-har-output`
- **Worktree:** `.worktrees/290-uri-keyed-har-output`

## Design

The authoritative design lives in issue #290. This file is the implementation
breakdown; it does not restate the rationale.

The shape being introduced, for a capture of `https://app.example.com/login`:

```
./.har-captures/app.example.com/2026-08-27-141500/   <- raw, gitignored
    raw.har
    raw.ndjson
    session.json
./app.example.com/                                    <- committable output
    scrubbed.har
    digest.json
    catalogue.json
```

## Where the work lands

| File | Change |
|---|---|
| `templates/web-api-discovery/scripts/capture/capture-har.js` | `uriFolder()`; both roots re-pointed; the two flat-root scans fixed |
| `templates/web-api-discovery/scripts/capture/capture-har.test.js` | Path assertions rewritten; new `uriFolder` and newest-session cases |
| `templates/web-api-discovery/scripts/capture/Invoke-HarCapture.ps1` | Stop recomputing the catalogue path; read it from the recorder |
| `templates/web-api-discovery/scripts/capture/Stop-HarRecording.ps1` | `-CapturesDirectory` help describes the two-level root |
| `templates/web-api-discovery/scripts/har/extract-har-reference.js` | `REFERENCE_ROOT` -> `.` (fixes the pre-existing path doubling) |
| `templates/web-api-discovery/scripts/har/verify-har-reference.js` | `DEFAULT_DIR` -> `.`; error text follows |
| `templates/web-api-discovery/scripts/har/har-reference.test.js` | Follows the two above |
| `templates/web-api-discovery/scripts/capture/catalogue-prompt.md` | `--out` guidance and verifier invocation |
| `.github/skills/web-api-discovery/SKILL.md` | Convention statement, two-directory explanation, `-OutputPath` row, trees |
| `templates/web-api-discovery/README.md` | Tree listing |
| `.github/agents/tests/har-recording.Tests.ps1` | Raw/output separation, gitignore depth, catalogue path |
| `.github/agents/tests/har-reference-catalogue.Tests.ps1` | SKILL.md text assertion |
| `.github/agents/tests/web-api-discovery.Tests.ps1` | SKILL.md text assertions |

## Stage 1 -- `uriFolder()` and the two roots

**Task 1.1 (test-first).** Add `uriFolder` cases to `capture-har.test.js`:
`https://app.example.com/login?t=SECRET` -> `app.example.com` (and the folder
name contains neither `SECRET` nor `login`); `https://localhost:5001/` ->
`localhost_5001`; `HTTPS://APP.Example.COM/` -> `app.example.com`;
`http://[::1]:8080/` produces a path with no `[`, `]` or `:`; `not-a-url`
throws. Watch them fail.

**Task 1.2.** Implement `uriFolder(uri)` beside `originOf()` (line 683) and
export it. `new URL(uri).hostname` lowercased, `_<port>` appended when
`url.port` is non-empty, then every character outside `[a-z0-9._-]` replaced
with `_`. Throw a named error when the URL does not parse. Watch pass.

**Task 1.3 (test-first).** Rewrite the Stage 3 path assertions
(`capture-har.test.js:297-313`) to expect
`<tmp>/.har-captures/<host>/<stamp>/raw.har` and `<tmp>/<host>` as
`outputPath`, and add the `--output-path D:\refs` -> `D:\refs\<host>` case.
**Keep the negative assertion** that the raw never lands under the output
path -- that is the leak invariant and it must survive the restructure.

**Task 1.4.** `DEFAULT_OUTPUT_PATH` -> `'.'`; `resolveSessionPaths()` accepts
the URI and builds `path.join(root, segment, stamp)` and
`path.resolve(opts.outputPath || DEFAULT_OUTPUT_PATH, segment)`; `start()`
(line 1073) passes `uri: args.uri`. Update the `capturesRoot()` comment block
(240-247) to describe the two-level shape without weakening the
"nothing an operator passes can move the raw" argument.

Commit: `test(web-api-discovery): pin URI-keyed capture paths` then
`feat(web-api-discovery): key capture output on the captured URI`.

## Stage 2 -- The flat-root scans

**Task 2.1 (test-first).** Add the regression case: two sessions under
different hosts where the lexicographically-later host holds the *older*
stamp; `status` must resolve the newer one. Add a `findProfileConflict` case
where the live session is nested. Watch both fail.

**Task 2.2.** Add `listSessionDirs(root)` returning `{ dir, stamp }` for every
`<host>/<stamp>` holding a `session.json`. Use it from `findProfileConflict()`
(1316) and `resolveSession()` (1352); sort by `stamp`, not by joined path.
Watch pass.

Commit: `fix(web-api-discovery): resolve sessions under the nested captures root`.

## Stage 3 -- The reference-root doubling

**Task 3.1 (test-first).** `har-reference.test.js` -- assert a reference
written with `--provider`/`--action` and no `--out` lands at
`<cwd>/<provider>/<provider>-<action>-<date>.har`, and that the verifier
defaults to the current directory.

**Task 3.2.** `REFERENCE_ROOT` -> `'.'` in `extract-har-reference.js` (59) and
`DEFAULT_DIR` -> `'.'` in `verify-har-reference.js` (54), with the error text
at 94-96 following. `slug()` keeps its dash behaviour -- provider/action naming
is a separate convention.

Commit: `fix(web-api-discovery): stop doubling the reference root under the output path`.

## Stage 4 -- PowerShell front door

**Task 4.1.** `Invoke-HarCapture.ps1:162-163` reads the catalogue path from the
recorder's session record instead of rebuilding `docs/har-reference` in
PowerShell -- one implementation of the rule, not two. Update `-OutputPath`
help (42) and the "TWO DIRECTORIES" block (28-35).

**Task 4.2.** `Stop-HarRecording.ps1:47-49` help wording.

Commit: `refactor(web-api-discovery): read the catalogue path from the recorder`.

## Stage 5 -- Docs and their assertions

**Task 5.1.** `SKILL.md` 58-61, 104-108, 222, 487-511, 531, 889-896;
`catalogue-prompt.md` 40-48 and 79; `templates/web-api-discovery/README.md`
20-35. Examples stay generic (`app.example.com`) -- these are shared upstream
files and must carry no project-specific names.

**Task 5.2.** Update the SKILL.md text assertions in
`har-reference-catalogue.Tests.ps1:72` and `web-api-discovery.Tests.ps1:92-118`
to match.

Commit: `docs(web-api-discovery): describe the URI-keyed output layout`.

## Acceptance criteria

- A capture of `https://example.com` writes its raw to
  `.har-captures/example.com/<stamp>/raw.har` and its scrubbed artifacts to
  `./example.com/`.
- `--uri https://localhost:5001/` yields `localhost_5001`.
- `--output-path D:\refs` yields `D:\refs\example.com`.
- No URL path or query component ever appears in a directory name.
- Raw never lands under the output path (unchanged invariant).
- `status` resolves the newest session across hosts, not the
  lexicographically-last one.
- All existing suites green.

## Verification

```powershell
node --test templates/web-api-discovery/scripts/capture/capture-har.test.js
node --test templates/web-api-discovery/scripts/har/har-reference.test.js
Invoke-Pester -Path .github/agents/tests/har-recording.Tests.ps1
Invoke-Pester -Path .github/agents/tests/har-reference-catalogue.Tests.ps1, .github/agents/tests/web-api-discovery.Tests.ps1
```

Evidence (Phase 5b) is the `--validate-only` JSON for three URIs
(`https://example.com`, `https://localhost:5001/`, and one with a token in the
query), captured inline -- it prints the resolved paths without launching a
browser.
