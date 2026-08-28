# 281 -- `Invoke-HarCapture`: record, scrub, and catalogue as one pipeline

- **Issue:** [#281](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/281)
- **Branch:** `feat/281-invoke-har-capture`
- **Worktree:** `.worktrees/281-invoke-har-capture`

## Design

The authoritative design lives in issue #281. This file is the implementation
breakdown; it does not restate the rationale.

## Where the work lands

| File | Change |
|---|---|
| `templates/web-api-discovery/scripts/capture/capture-har.js` | The bulk: recorder rework, port fallback, preflight, endings, post-process phases, digest, exit codes |
| `templates/web-api-discovery/scripts/capture/Invoke-HarCapture.ps1` | **New.** Six-parameter front door emitting catalogue objects |
| `templates/web-api-discovery/scripts/capture/Start-HarRecording.ps1` | **Deleted.** No alias, no shim |
| `templates/web-api-discovery/scripts/capture/HarCapture.Format.ps1xml` | **New.** Default display members for the catalogue type |
| `templates/web-api-discovery/scripts/capture/Stop-HarRecording.ps1` | Waits for `postProcess`; reports both paths |
| `.github/skills/web-api-discovery/SKILL.md` | One-command capture; catalogue required; observed-not-exercised |
| `templates/web-api-discovery/README.md` | Tree listing |
| `.gitignore` | Comment no longer describes a redirectable raw directory |
| `.github/agents/tests/har-recording.Tests.ps1` | Rewritten around the new contract |
| `.github/agents/tests/web-api-discovery.Tests.ps1` | `Start-HarRecording` -> `Invoke-HarCapture` |
| `Pull-SDLC.ai.Tests.ps1` | Carve-out path fixtures |

## Stage 1 -- The incremental recorder becomes full-fidelity

`SnapshotRecorder` / `attachSnapshot` become `IncrementalRecorder` /
`attachRecorder`.

1. **Test (red):** an entry built from a `requestfailed` event survives into
   `raw.har`. Today failures are dropped entirely.
2. **Test (red):** a non-UTF8 response body round-trips -- the assembled entry
   carries `content.encoding === 'base64'` and the decoded bytes equal the
   original.
3. **Test (red):** a body over 256 KB is present in full (cap removed).
4. Implement: listen on `requestfinished` and `requestfailed` instead of
   `response`; take timings from `request.timing()`; drop
   `MAX_SNAPSHOT_BODY_BYTES`; use `request.postDataBuffer()`; fill
   `queryString`, `cookies`, `httpVersion`, `headersSize`/`bodySize`,
   `redirectURL`; flush on `context.on('close')`.

No test may launch a browser, so the handler body is extracted into a pure
`buildEntry({ request, response, timing, body, failure })` exported for direct
unit testing, with the Playwright wiring a thin adapter over it.

## Stage 2 -- One artifact: `raw.har` always

5. **Test (red):** assembling the incremental log writes `raw.har`, and the
   document carries **no** `RECOVERY ARTIFACT` banner and no
   `recoveredFromSnapshot` field.
6. **Test (red):** a session assembled from the log exits **5**, and its
   `raw.har` parses as HAR 1.2.
7. Implement: delete `SNAPSHOT_HAR`; `assembleSnapshot` becomes
   `assembleFromLog`, writing to `harPath`; delete the banner;
   `session.assembledFromLog` replaces `recoveredFromSnapshot`. A clean driver
   close still wins and deletes the log.

## Stage 3 -- Raw captures are confined; `-OutputPath` carries only safe artifacts

8. **Test (red):** `--output-path` does not move `raw.har`; the raw stays under
   `.har-captures/`.
9. Implement: `capturesRoot()` is fixed (`.har-captures`, overridable **only**
   by `HAR_CAPTURES_DIR` for the test harness, never by a user-facing flag);
   `--dir` is removed from `start`; `--output-path` (default
   `docs/har-reference/`) receives scrubbed HARs, `digest.json`, and
   `catalogue.json`.

`stop` and `status` keep `--dir`: they resolve an existing session, and the
tests already depend on pointing them at a temp root.

## Stage 4 -- Port auto-fallback; profile-in-use stays fatal

10. **Test (red):** with the requested port occupied, `start --validate-only`
    reports the **next free** port in `session.json` instead of failing.
11. **Test (red):** the resolved `cdpEndpoint` matches the chosen port, so an
    agent reads it rather than assuming 9333.
12. Implement: `findFreePort(startPort)` probes by binding a `net` server. A CDP
    probe answering on the original port no longer aborts the run; the
    persistent-profile conflict (a launch timeout, or a live session already
    recorded against the same `profileDir`) stays a hard error and names the
    running capture's session directory.

## Stage 5 -- Storage state auto-discovery; preflight profile gate

13. **Test (red):** a `.har-storage-state.json` placed above the working
    directory is discovered and recorded in `session.json`; its absence is not
    an error.
14. **Test (red):** with no `.har-profile.json` and no TTY, `start` fails before
    launching a browser and prints the `HOWTO`.
15. Implement: reuse `har-profile.js` for both walks -- add an exported
    `findUpward(startDir, filename)` and re-express `findProfilePath` over it.
    Drop `--storage-state`. Preflight runs before the port probe.

## Stage 6 -- Endings

16. **Test (red):** a non-TTY SIGINT cancels -- `postProcess` is absent and
    `raw.har` is kept.
17. Implement: on a TTY, Ctrl+C prompts (`cancel` / `finish`); without one it
    cancels. `Stop-HarRecording` still writes only the `STOP` sentinel. Every
    non-cancel ending falls through to the same post-process tail.

## Stage 7 -- Post-process: scrub, verify, digest

18. **Test (red):** after a stop, `session.json` carries
    `postProcess.scrubbed.verified` and `postProcess.digest.path`.
19. **Test (red):** a scrub failure yields exit **6** with `raw.har` intact.
20. Implement: `postProcess(session)` shells to `sanitize-har.js` then
    `verify-scrub.js` via `spawnSync` (reuse, never reimplement). It emits
    `digest.json` -- entries grouped by host / method / path template / status,
    inter-entry timing gaps, content types, payload shapes -- and a
    `catalogue.json` scaffold with one row per group at `Status: 'Observed'`,
    which the AI phase promotes to `Exercised` as it extracts.

## Stage 7b -- Who runs the catalogue phase

Cataloguing is AI work, and the two ways the command gets launched need
different handling. Detection drives it; **no new flag** is added.

- **An agent already drives the session** (`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`
  set). The driver stops at the `Observed` scaffold and reports
  `postProcess.catalogue.pending`. The agent reads the digest and catalogues, as
  SKILL.md requires -- shelling out to a second AI from inside one would be
  absurd.
- **A human ran it interactively** and the `claude` CLI is on `PATH`. The driver
  shells out: `claude -p <prompt>` with the working directory set to the session,
  so the catalogue completes without the human having to know it was an AI step.
- **Neither.** The scaffold stands, and the driver prints the exact prompt plus
  the command to run it, so the step is never silently dropped.

The prompt is a single source of truth, not a string literal buried in the
driver: `scripts/capture/catalogue-prompt.md`. The shell-out reads it, and
SKILL.md's Phase 3.5 points an agent at the same file.

31. **Test (red):** `catalogue-prompt.md` exists and names the digest, the
    per-action `extract-har-reference.js` run, the "Observed, not exercised"
    section, and the `verify-har-reference.js` gate.
32. **Test (red):** with `CLAUDECODE` set, post-processing does **not** shell
    out; `postProcess.catalogue.pending` is true.
33. **Test (red):** with no `claude` on `PATH` and no agent, the driver reports
    the prompt path rather than reporting a catalogue it never wrote.
34. Implement: `runCatalogue(session)` after the digest, resolving one of the
    three branches above and recording which one in
    `postProcess.catalogue.delegatedTo` (`agent` | `claude-cli` | `none`).

A catalogue failure is a post-process failure -- exit **6**, `raw.har` intact.

## Stage 8 -- `Invoke-HarCapture.ps1` and the object surface

21. **Test (red):** `Invoke-HarCapture` exists, takes `-Uri` positionally, and
    exposes exactly `Uri, OutputPath, Describe, Profile, Isolated, Port`.
22. **Test (red):** `Start-HarRecording.ps1` no longer exists.
23. **Test (red):** the emitted objects carry
    `PSTypeName = 'IntelliSDLC.HarCapture.CatalogueEntry'` and survive
    `ConvertTo-Json` with no status text in the pipeline.
24. **Test (red):** `Invoke-ScriptAnalyzer` reports no `PSAvoidUsingWriteHost`
    across `scripts/capture/`.
25. Implement: status goes to `Write-Information`; catalogue rows are read from
    `catalogue.json` and emitted as objects; `HarCapture.Format.ps1xml`
    registers the default display members, applied with `Update-FormatData`.

## Stage 9 -- `Stop-HarRecording` waits for post-processing

26. **Test (red):** against a session with `endedUtc` but no `postProcess`,
    `stop` reports post-processing as still running rather than claiming done.
27. Implement: after `endedUtc`, poll for `postProcess.completedUtc` up to the
    stop timeout, then report the raw path and the `-OutputPath` artifacts.

## Stage 10 -- Docs and the reference sweep

28. **Test (red):** zero repo-wide references to `Start-HarRecording` remain.
29. Update SKILL.md (Phase 2 one-command capture, Phase 3.5 catalogue required,
    an "Observed, not exercised" section), `templates/web-api-discovery/README.md`,
    the `.gitignore` comment, `.github/agents/web-api-discovery.agent.md`, and
    the `Pull-SDLC.ai.Tests.ps1` carve-out fixtures.
30. Leak scan: instruction text stays generic -- no consuming-project or domain
    names.

## Verification

```powershell
Invoke-Pester -Path .github/agents/tests/har-recording.Tests.ps1,
                    .github/agents/tests/web-api-discovery.Tests.ps1,
                    Pull-SDLC.ai.Tests.ps1
Invoke-ScriptAnalyzer -Path templates/web-api-discovery/scripts/capture -Recurse
```

## Acceptance criteria

Tracked verbatim on issue #281.
