# Recorder dependency resolution, and protecting a non-repo capture folder

- Issue: https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/512
- PR:    (filled in once the PR exists)
- Slug:  512-playwright-resolution

## Overview

The recorder resolves `playwright` with a bare `require`, which searches
upward from the SCRIPT's own directory, so running the upstream checkout's
recorder against a fresh folder fails and the printed remedy (`npm install
playwright` in that folder) cannot work. Separately, a capture folder outside
a git work tree gets no `.gitignore`, so a later `git init && git add -A`
would commit the salt and the raw captures.

## Approved Design

### 1. A dependency resolver module -- `scripts/lib/node-dependency.js`

One place that answers "where is this module, and what did I search?".

`resolveDependency(name, { cwd, toolDir, globalRoot, nodePath, resolve })`
returns `{ found, path, location, searched }`, where `searched` is an ordered
list of `{ label, root, found }` for the four locations, in this order:

1. **the folder you are in** -- `cwd`, searching upward
2. **the tool's own install** -- the script's directory, searching upward
   (today's behaviour, so a consumer repo that synced the skill is unchanged)
3. **the machine default** -- npm's global root (`npm root -g`, cached; on
   Windows `%APPDATA%\npm\node_modules`)
4. **`NODE_PATH`** -- Node's own existing pointing mechanism, already named in
   today's error text

Resolution is `require.resolve(name, { paths: [root] })` per location, one
location at a time, so the winner is known and reportable. No new
command-line option and no new environment variable (prompt-first rule):
`NODE_PATH` already exists and is already documented.

`describeMissing(name, searched, { browser })` renders the failure: every
location named with its absolute path, then a remedy that works from where
the operator stands.

`chromiumPresent({ browsersPath })` reports whether Playwright's browser
binaries exist at its per-machine default (`PLAYWRIGHT_BROWSERS_PATH`, else
`%LOCALAPPDATA%\ms-playwright` on Windows / `~/.cache/ms-playwright` else).
The module check and the browser check are separate facts, because installing
the module does not install the browser, and a message that conflates them
sends the operator to the wrong command.

### 2. Preflight before any prompt -- `capture-har.js`

A new `preflightDependencies({ isTty, ask })` runs at the **top of
`start()`**, ahead of the output-placement guard, the profile scaffold prompt,
the port scan and the browser. A missing dependency becomes the first line,
not the last, and nothing is scaffolded or opened before it is satisfied.

- **Present:** returns ok, run continues unchanged.
- **Missing, interactive:** prints the four searched locations, then offers to
  install into the machine default -- `npm install -g playwright`, plus
  `npx playwright install chromium` when the browser is absent. Declining
  prints those exact commands and exits 1.
- **Missing, non-interactive:** prints the same locations and commands and
  exits 1. No prompt, matching every other guard in this file.

`requirePlaywright()` is rewritten over the resolver so the non-`start` entry
points get the same four-location search and the same message.
`capture-cdp.js`'s bare `require('playwright')` is routed through it too.

### 3. Protect a non-repo capture folder -- `ensureCapturesRootIgnored`

`OUTSIDE_WORK_TREE` currently returns "nothing to do". It becomes "nothing
git can do yet, so leave the rule behind for when there is": write (or append
only the missing lines to) a `.gitignore` in the capture root's parent
directory covering the existing `CAPTURE_GITIGNORE_ENTRIES` -- `.har-captures/`,
`.har-profile.json` and the two substitution tables -- using the scaffolder's
existing idempotent append, and say so at info level.

Not a prompt: there is no repository, so nothing git tracks is being modified,
and the failure this prevents is silent and unrecoverable. It stays inside the
existing guard so it runs on every recording, not only the one that happened to
scaffold a profile.

### 4. Documentation

`SKILL.md` Phase 2 gains a short "Is a repository required?" answer: no for
recording; yes for where references get committed later; the recorder
protects either case. The dependency preflight and the four searched
locations are named in the same place.

## Evidence Plan

- **Change type**: CLI / bug fix
- **Artifact format**: Inline, ANSI-stripped captured output
- **Capture command**: run the recorder from the upstream checkout against an
  empty non-repo temporary folder, capturing (a) the preflight failure with
  playwright absent, (b) the resulting `.gitignore` and a `git init && git add -A
  && git status` showing neither the profile nor the captures staged
- **Entry-point file**: `.evidence/<phase-id>/evidence.md`

## Acceptance Criteria

- [ ] Run from the upstream checkout in an empty non-repo folder with
      playwright installed there, the recorder resolves it.
- [ ] With playwright installed only globally, the recorder resolves it with
      nothing set.
- [ ] `NODE_PATH` still participates and overrides where nothing earlier has it.
- [ ] With playwright absent, the preflight fails **before** any prompt, names
      all four searched locations, and gives a remedy that works when followed.
- [ ] The missing-browser case is reported separately from the missing-module
      case.
- [ ] A non-repo capture folder gets a `.gitignore` covering `.har-captures/`
      and `.har-profile.json`; `git init && git add -A` afterwards stages
      neither. Idempotent on a second run.
- [ ] SKILL.md answers "is a repo required?".
- [ ] No new command-line option or environment variable is introduced.

## Implementation Checklist

- [ ] **T1** Write `scripts/lib/node-dependency.test.js` (RED): four-location
      order; each location can win; `searched` reports every location with its
      absolute path; `NODE_PATH` participates; `describeMissing` names all four
      and contains a working remedy; `chromiumPresent` honours
      `PLAYWRIGHT_BROWSERS_PATH`. Injected `resolve`/`fs` so no real install
      is needed. Commit `test(capture): pin four-location dependency resolution`.
- [ ] **T2** Write `scripts/lib/node-dependency.js` (GREEN).
      Commit `feat(capture): resolve node dependencies where the operator stands`.
- [ ] **T3** Test (RED) that `capture-har.js` preflight refuses before the
      profile scaffold prompt when playwright is absent, and that the message
      names the searched locations; non-interactive exits 1 without prompting.
      Commit `test(capture): pin the dependency preflight ahead of every prompt`.
- [ ] **T4** Add `preflightDependencies` to `capture-har.js`, call it at the
      top of `start()`, rewrite `requirePlaywright()` over the resolver, route
      `capture-cdp.js` through it (GREEN).
      Commit `fix(capture): preflight playwright before scaffolding or prompting`.
- [ ] **T5** Test (RED) that a capture root outside a work tree gets a
      `.gitignore` beside it with the capture entries, that a real
      `git init && git add -A` then stages neither `.har-profile.json` nor
      `.har-captures/`, and that a second run appends nothing.
      Commit `test(capture): pin non-repo capture folder protection`.
- [ ] **T6** Extend `ensureCapturesRootIgnored` for the `OUTSIDE_WORK_TREE`
      branch (GREEN). Commit `fix(capture): gitignore a non-repo capture folder`.
- [ ] **T7** Pester wrapper `.github/agents/tests/capture-dependency-preflight.Tests.ps1`
      so CI runs the new Node suites. Commit `test(ci): run the new capture suites`.
- [ ] **T8** SKILL.md "Is a repository required?" + preflight documentation.
      Commit `docs(skill): answer whether a repo is required to record`.
- [ ] **T9** Refactor pass, full suite, evidence capture, review, PR.
