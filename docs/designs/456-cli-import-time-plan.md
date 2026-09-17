# Five more CLI entry points still run work at import time

- Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/456
- PR:    (filled in at Phase 7)
- Slug:  456-cli-import-time

## Overview

#446 / PR #455 fixed `har/sanitize-har.js`: it called `main()` unconditionally
at the bottom, so `require()`ing it performed a live scrub and exited the
requiring process. Five non-test scripts still do exactly that and export
nothing:

| File | Why it matters |
|---|---|
| `har/verify-scrub.js` | the scrub's own leak gate; the other half of the pair #408 wants parity across, and the reason #395's test compares source text |
| `har/extract-har-reference.js` | runs a full reference extraction on import |
| `har/pii-enrich.js` | |
| `codegen/run-agent.js` | the pipeline driver; PR #455's section 5 could not reach it |
| `capture/capture-cdp.js` | |

This is a **packaging** change. No new command-line option. Every existing
invocation must behave identically.

## The fix, one file at a time

```js
if (require.main === module) main();
module.exports = { /* the pure surface */ };
```

`capture-cdp.js`'s `main` is async, so its guard keeps the existing
`.catch()` rejection handler inside the guard rather than at top level.

Export surfaces (the pure pieces a caller would otherwise re-derive):

- `verify-scrub.js` — `main`, `parseArgs`, `isAdvisory`, `reportableFinding`,
  `waiverFragment`, `writeFindingsReport`, `EXIT_GATING`, `EXIT_ADVISORY`,
  `FINDINGS_FILENAME`
- `extract-har-reference.js` — `main`, `parseArgs`, `slug`, `entryText`,
  `capResponses`, `addDecodedParams`, `REFERENCE_ROOT`
- `pii-enrich.js` — `main`, `parseArgs`
- `run-agent.js` — `main`, `parseArgs`
- `capture-cdp.js` — `main`, `parseArgs`

## Why the invocation sites are safe

Every call site in the tree spawns a fresh `node` with the script as its
argument — `capture-har.js:1649` (verify-scrub), `capture-har.js:1771`
(extract-har-reference), `run-agent.js`'s own `runStage`, and the Pester
wrappers. None uses `require`, `-r`, or a shim, so `require.main === module`
holds wherever they are actually invoked. Verified before writing code.

## Verification — both directions, per file

One new zero-dep suite, `lib/cli-entry-points-importable.test.js`, plus its
Pester wrapper (CI runs Pester over `./.github` only, so a node test with no
wrapper never runs on the PR — see `node-test-coverage.Tests.ps1`).

**FALSIFIER (per script).** Requiring the module, from inside a project where
everything the script needs is present and in reach, and with the very argv
that drives a real run: exit 0, no stdout, no file written, input untouched,
`main` exported as a callable. Fails if the guard's condition is removed.

**GUARD (per script).** Invoked as a command it still does what it did. Fails
if `main()` is never called — the failure mode a careless fix produces, and
the one that reads as "no leaks found":

| Script | Guard assertion |
|---|---|
| `verify-scrub.js` | clean HAR -> exit 0 + "0 blocking leaks"; HAR with a bearer token -> exit 3 + the leak named; the 0/3/4 codes are load-bearing for `capture-har.js` |
| `extract-har-reference.js` | writes the reference file, exit 0, entry count reported |
| `pii-enrich.js` | no args -> exit 2 + usage; `LLM_PROVIDER=stub --out` -> file copied, exit 0 |
| `run-agent.js` | real HAR + out dir, no profile -> exit 2 **and `.run-agent/transcript.log` exists**, so main is proven to have reached real work, not just argument parsing |
| `capture-cdp.js` | `--validate-only` with a missing storage-state -> exit 2; with a present one -> exit 0 (no browser launched) |

**BEHAVIOURAL IDENTITY.** Run the same fixtures through each script on `main`
and on the branch; compare exit code, stdout, stderr and the sha256 of every
file written. PR #455's harness, re-pointed at five scripts.

**ABLATIONS.** For each script, both directions: remove the guard condition
and watch the falsifier fail; make the entry point unreachable
(`if (false) main();`) and watch the guard fail.

## Tasks

1. `lib/cli-entry-points-importable.test.js` — falsifier + guard halves, RED.
2. `.github/agents/tests/cli-entry-points-importable.Tests.ps1` wrapper.
3. Guard + exports in each of the five scripts, GREEN.
4. Ablate both directions on all five; record observed failures.
5. Behavioural-identity harness main vs branch; record hashes.
6. Full Pester run; evidence; PR.
