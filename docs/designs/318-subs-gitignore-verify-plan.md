# 318 -- Verify the substitution-table destination is gitignored, do not infer it from its name

- **Issue:** [#318](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/318)
- **Branch:** `fix/318-subs-gitignore-verify`
- **Worktree:** `.worktrees/318-subs-gitignore-verify`
- **Related:** [#294](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/294) (the original defect), [#298](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/298) (`.har-captures/` added to `SCAFFOLD_GITIGNORE_ENTRIES`)

## Design

The authoritative statement of the defect lives in issue #318. In short:
`deriveSubsDir()` proves the destination is **named** `.har-captures`; #294
needs it to **be gitignored**. Those are different properties, and the name is
a proxy that fails outside a scaffolded repo and on any near-miss spelling.

The fix adopted here is the issue's option (1) plus (2): **check the actual
property, and fail closed when it does not hold**, in the same style as the
existing missing-`.har-profile.json` failure -- refuse, and say what to do.
Option (3) (case-insensitive / near-miss name matching) is deliberately **not**
implemented: it moves the boundary of the same bug rather than removing it.

### The rule

A substitution-table destination is acceptable when **either**:

- the operator named it explicitly (`--subs` / `--pii-subs`) -- writing a
  reverse-lookup table to a chosen path is a deliberate act; or
- the derived default path is confirmed gitignored by `git check-ignore`.

Anything else is refused before a single byte is written.

The check is on the **file paths**, not on the directory. That is what makes it
a property check: `SCAFFOLD_GITIGNORE_ENTRIES` ignores `.substitutions.json`
and `.har-substitutions.json` by name at any depth as well as `.har-captures/`,
so a hand-made `har-captures` tree inside a properly scaffolded repo is
*accepted on its merits*, while the same tree in `C:\temp` is refused.

### Failure states, all closed

| Probe result | Behavior |
|---|---|
| `git check-ignore` says ignored | write |
| in a work tree, not ignored | refuse -- name the path, say which `.gitignore` entry would fix it |
| not inside a git work tree | refuse -- say to run inside the repo or pass `--subs` explicitly |
| `git` not on PATH / probe errors | refuse -- the property could not be verified, so it is not assumed |

Fail-fast ordering: paths are classified **immediately after they are derived**,
before the input HAR is read and before `--out` is written. A refused run leaves
the filesystem untouched -- no partial scrubbed output, and no created
`.har-captures/` directory.

## Where the work lands

| File | Change |
|---|---|
| `templates/web-api-discovery/scripts/har/subs-destination.js` | **new** -- `classifyDestination()` (git probes) + `refusalMessage()` |
| `templates/web-api-discovery/scripts/har/subs-destination.test.js` | **new** -- unit behavior of the classifier over real temp repos |
| `templates/web-api-discovery/scripts/har/sanitize-har.js` | Gate the derived defaults; fail-fast before any write; usage text |
| `templates/web-api-discovery/scripts/har/substitution-table-gitignore.test.js` | **new** -- end-to-end CLI behavior of the gate |
| `templates/web-api-discovery/scripts/har/substitution-table-location.test.js` | Existing #294 tests get real repos + `.gitignore`, so they still describe a supported configuration |
| `.github/agents/tests/subs-destination.Tests.ps1` | **new** -- Pester wrapper (CI runs Pester over `./.github` only) |
| `.github/agents/tests/substitution-table-gitignore.Tests.ps1` | **new** -- Pester wrapper |
| `.github/skills/web-api-discovery/SKILL.md` | Correct "gitignored by construction" to "verified gitignored"; document the refusal |

---

## Stage 1 -- The classifier (`subs-destination.js`)

**Task 1.1 (test-first).** `subs-destination.test.js`: a path inside a temp
repo whose `.gitignore` covers it classifies `ignored`; the same path with no
matching entry classifies `not-ignored`; a path in a temp directory with no
`.git` anywhere above it classifies `outside-work-tree`; a path whose parent
directory does not exist yet still classifies correctly (the tables' directory
is created by the scrub, so the probe must not require it to exist).
Watch each fail.

**Task 1.2.** Implement `classifyDestination(filePath)`:

- walk up from `path.dirname(filePath)` to the nearest **existing** ancestor,
  and use it as `cwd` for the probes (the destination directory typically does
  not exist yet);
- probe 1 `git rev-parse --is-inside-work-tree` -> `outside-work-tree` when it
  does not answer `true`;
- probe 2 `git check-ignore -q <absolute path>` -> exit 0 `ignored`,
  exit 1 `not-ignored`, anything else `unverifiable`;
- `git` missing / spawn failure -> `unverifiable`.

Follow the `git(cwd, args)` helper style already in
`scripts/lib/repo-workflow-guard.js`: plain probes, plain answers, no
heuristics. Each function stays under 20 lines.

**Task 1.3.** Implement `refusalMessage(filePath, status, flagName)` returning
the operator-facing text (or `null` for `ignored`), in the tone of
`har-profile.js`'s `HOWTO`: what is wrong, why it matters (the table's keys are
the plaintext values the scrub replaced), and the two ways out (add the
`.gitignore` entry, or pass the flag explicitly).

**Commit:** `feat(web-api-discovery): classify a substitution-table destination by whether git ignores it`

---

## Stage 2 -- Gate the scrub (`sanitize-har.js`)

**Task 2.1 (test-first).** `substitution-table-gitignore.test.js`, driving the
CLI end to end:

1. **Repro from the issue.** Input under a `har-captures` tree (no leading dot)
   in a non-repo temp directory, `--out` elsewhere -> exit 1, stderr names the
   refused path, and **nothing** is written: no nested `.har-captures/`, no
   tables, and no `--out` file.
2. **In a repo, entry missing** -> exit 1, stderr names the `.gitignore` entry
   that would fix it, nothing written.
3. **In a repo with `.har-captures/` ignored** -> exit 0, both tables land in
   the session directory (the #294 behavior, now earned rather than assumed).
4. **Property over name.** A `har-captures` tree (no dot) inside a repo whose
   `.gitignore` carries the `SCAFFOLD_GITIGNORE_ENTRIES` filenames -> exit 0,
   because the destination genuinely is ignored.
5. **Explicit destination outside a repo** -> exit 0; `--subs` / `--pii-subs`
   are a deliberate act and are not gated.
6. **Mixed** -- explicit `--subs` only, derived `--pii-subs` unignored -> exit
   1, and the message names `--pii-subs`.

Watch them fail against the current implementation (today 1, 2 and 6 pass a
scrub and write the tables).

**Task 2.2.** Wire `classifyDestination` into `main()` directly after
`subsPath` / `piiSubsPath` are computed and before `fs.readFileSync(args.in)`.
Gate only the derived paths. On refusal print `sanitize-har: <message>` to
stderr and `process.exit(1)`.

**Task 2.3.** Update the `usage()` text and the `deriveSubsDir` doc comment: the
default is the `.har-captures` session directory **and it is verified
gitignored before use**, not assumed to be.

**Commit:** `fix(web-api-discovery): refuse to write substitution tables to an unverified destination`

---

## Stage 3 -- Bring the #294 tests onto real repos

**Task 3.1.** `substitution-table-location.test.js` currently runs its projects
in bare temp directories, which the new gate correctly refuses. Give
`makeProject()` a `git init` plus a `.gitignore` carrying the scaffold entries,
so each case describes a configuration the tooling actually supports. Case 3
(explicit paths) and case 4 (usage text) are unaffected in substance.

**Task 3.2.** Run both node suites plus the full Pester run; confirm green.

**Commit:** `test(web-api-discovery): run the #294 location tests in real repositories`

---

## Stage 4 -- Wrappers and docs

**Task 4.1.** Add `.github/agents/tests/subs-destination.Tests.ps1` and
`.github/agents/tests/substitution-table-gitignore.Tests.ps1`, modelled on
`substitution-table-location.Tests.ps1` (exists / `node --check` / assertions
pass). Without a wrapper the node tests never run in CI.

**Task 4.2.** `SKILL.md`: line ~111's "confined to the gitignored
`.har-captures/` **by construction**" is the claim #318 disproves for the
tables. Restate it accurately -- the raw capture is confined by construction;
the substitution tables are **verified** gitignored, and the scrub refuses
rather than writing them somewhere unprotected. Note the refusal and its two
remedies near the `.har-substitutions.json` discussion around line 911.

**Commit:** `docs(web-api-discovery): say the table destination is verified, not assumed`

---

## Acceptance criteria

- The exact command from the issue's Reproduction section, run against a
  `har-captures` tree in a non-repo directory, exits non-zero and creates
  nothing.
- The same command inside a scaffolded consumer repo still succeeds and still
  writes both tables into the gitignored session directory.
- An explicit `--subs` / `--pii-subs` continues to work anywhere, including
  the temp working directories `extract-har-reference.js` and `run-agent.js`
  use.
- Refusal messages name the offending path and the remedy; no message echoes a
  substituted value.
- Both node suites are zero-dep and reachable from Pester.
