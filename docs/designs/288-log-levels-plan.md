# 288 -- Level the HAR capture's console output behind `-Verbose`

- **Issue:** [#288](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/288)
- **Branch:** `feat/288-log-levels`
- **Worktree:** `.worktrees/288-log-levels`

## Design

The authoritative design lives in issue #288. This file is the implementation
breakdown; it does not restate the rationale.

Three decisions constrain everything below:

- **No new PowerShell parameter.** `-Verbose` comes free from
  `[CmdletBinding()]`. `har-recording.Tests.ps1:451-460` asserts the parameter
  list is exactly six names and that assertion is left untouched as the proof.
- **One new option on `capture-har.js`: `--log-level normal|verbose`.** It is
  internal transport between the two halves, not an operator surface.
- **Node's output is not re-routed through PowerShell.** Piping node's stdout
  would buffer the ENTER prompt and the Ctrl+C `[f]inish/[c]ancel` question in
  the very console the operator must answer.

## Where the work lands

| File | Change |
|---|---|
| `templates/web-api-discovery/scripts/capture/capture-har.js` | Leveled logger; all chatter to stderr; `--log-level`; message reclassification; one-sentence ENTER prompt |
| `templates/web-api-discovery/scripts/capture/Invoke-HarCapture.ps1` | Forward the level; `$InformationPreference` instead of pinned `-InformationAction`; `Write-Verbose` diagnostics; reworded exit-5 note |
| `templates/web-api-discovery/scripts/capture/Stop-HarRecording.ps1` | Forward the level; `Write-Verbose` the args |
| `templates/web-api-discovery/scripts/capture/capture-har.test.js` | New level-gating cases |
| `.github/agents/tests/har-recording.Tests.ps1` | New forwarding cases; existing six-param and PSSA gates stay green |
| `.github/skills/web-api-discovery/SKILL.md` | Documented output matches what the tool now prints |
| `docs/designs/281-invoke-har-capture-plan.md` | Only if it quotes banner text that changed |

## Stage 1 -- The leveled logger

1. **Test (red):** `capture-har.js status --log-level verbose` exits 0 rather
   than a usage error — the option is accepted on every command.
2. **Test (red):** `start --log-level bogus` exits 2 with a usage message
   naming the valid values.
3. Implement beside the constants (near `DEFAULT_PORT`, ~line 104):
   `LOG_LEVELS = { normal: 1, verbose: 2 }`, a module-level `currentLevel`, a
   `setLogLevel(value)` that throws on an unknown value, and
   `log.info / log.verbose / log.warn / log.error`. Every helper writes to
   **stderr**. Parse `--log-level` in `parseArgs`; add `'log-level'` to
   `START_OPTIONS` (:131).

## Stage 2 -- stdout becomes machine-only

4. **Test (red):** `start --uri … --validate-only` stdout parses as JSON at
   **both** levels. Today the banner is on stdout, so verbose output would
   corrupt it.
5. **Test (red):** `status` stdout parses as JSON at both levels.
6. Implement: move every human-facing `process.stdout.write` onto the logger —
   the start banner (:1181-1194), `reportPostProcess` (:1287-1305), the
   `stopped (<reason>)` line (:1278), the cancelled block (:1270-1275), the
   `initial navigation failed` note (:1178), and the scaffold-written note
   (:1064-1066). The two JSON emissions at :1106 and :1476 stay on stdout.

## Stage 3 -- Reclassify the messages

7. **Test (red):** at `normal` the start banner contains `recording <uri>` but
   not `profile:`, `raw:` or `cdp:`; at `verbose` it contains all of them.
8. **Test (red):** at `normal`, `reportPostProcess` output contains `scrubbed:`
   and `catalogue:` but not `raw:` or `digest:`; at `verbose`, all four.
9. **Test (red):** a rejected scrub still prints its `REJECTED` line and its
   `ERROR:` line at `normal` — a leak-gate rejection is never level-gated away.
10. Implement the table from issue #288. The judgment call worth keeping in the
    code as a comment: `scrubbed:` and `catalogue:` stay visible by default
    because they are the artifacts the operator acts on next; `raw:`, `digest:`,
    `cdp:`, `profile:` and the port are diagnostics and move to verbose.
11. Implement: `entry skipped` (:592) and `incremental flush failed` (:533)
    become `log.verbose` — they are per-request noise during a long capture.
    Errors that end the run (preflight, profile conflict, launch timeout,
    `nothing was recorded`) stay unconditional.

## Stage 4 -- One sentence about ENTER

12. **Test (red):** the start banner contains exactly one sentence recommending
    ENTER and no mention of `Ctrl+C`, `recovery` or `snapshot`.
13. Implement: replace :1193-1194 with a single info line —
    `Browse, then press ENTER here -- that writes the most complete HAR.`
14. The existing `the assembled HAR is not labelled a degraded recovery
    artifact` case (`capture-har.test.js:263`) must stay green; it is the
    regression guard that the old RECOVERY wording does not creep back.

## Stage 5 -- The PowerShell front door

15. **Test (red):** `Invoke-HarCapture -Uri … -Verbose` forwards
    `--log-level verbose`; without `-Verbose` it does not. Assert through the
    existing `--validate-only` seam — no browser launches.
16. **Test (red):** `-InformationAction SilentlyContinue` actually suppresses
    the status lines. It cannot today, because `-InformationAction Continue` is
    pinned on all four call sites.
17. Implement in `Invoke-HarCapture.ps1`:
    - Append `--log-level verbose` when `$VerbosePreference -ne 'SilentlyContinue'`
      (after :127).
    - Replace the four pinned `-InformationAction Continue` (:133, :134, :145,
      :183) with a single preference set that honours an explicit override:
      ```powershell
      if (-not $PSBoundParameters.ContainsKey('InformationAction')) {
          $InformationPreference = 'Continue'
      }
      ```
    - `Write-Verbose` the resolved `$captureArgs`, the raw `$exit` before the
      `switch` (:137), and the computed `$cataloguePath` (:162-163).
    - Collapse :133-134 to the single recommendation sentence — node prints its
      own prompt and saying it twice is half the noise.
    - Reword the exit-5 note (:145) to one plain sentence, still
      `Write-Information`.
    - Document `-Verbose` in the comment-based help `.DESCRIPTION`.
18. Implement in `Stop-HarRecording.ps1`: forward `--log-level verbose` off
    `$VerbosePreference` (after :86) and `Write-Verbose` the resolved args.

## Stage 6 -- Docs and the analyzer sweep

19. **Test (red):** zero repo references to the removed banner wording.
20. Update the capture section of `.github/skills/web-api-discovery/SKILL.md`
    and any `docs/designs/281-invoke-har-capture-plan.md` quote of the old
    banner.
21. Confirm the PSScriptAnalyzer gate (`har-recording.Tests.ps1:484-501`) stays
    green — no `Write-Host` was introduced.
22. Leak scan: instruction and template text stays generic — no consuming
    project or domain names.

## Verification

```powershell
node --test templates/web-api-discovery/scripts/capture/capture-har.test.js
Invoke-Pester -Path .github/agents/tests/har-recording.Tests.ps1,
                    .github/agents/tests/web-api-discovery.Tests.ps1
Invoke-ScriptAnalyzer -Path templates/web-api-discovery/scripts/capture -Recurse

$js = 'templates/web-api-discovery/scripts/capture/Invoke-HarCapture.ps1'
& $js https://example.com -Isolated              # terse: prompt + result
& $js https://example.com -Isolated -Verbose     # adds paths, port, phases
```

The Phase 5b evidence is the two console transcripts side by side. The whole
point of the change is what the operator sees, so the evidence has to be that,
not a passing test count.

## Acceptance criteria

Tracked verbatim on issue #288.
