# CLAUDE.md

This file provides orientation for AI assistants working in this repository.

> **⚠️ Generic instructions — no project-specific content. Upstream-only edits.**
> These instruction files are shared across multiple projects. Never add
> project names, architecture details, domain concepts, specific dependencies,
> or hardcoded paths. All changes must be made in the
> [IntelliSDLC.ai](https://github.com/IntelliTect-Samples/IntelliSDLC.ai)
> repo and pulled into consuming projects — never edited locally and pushed back.
> Project-specific context belongs in the consuming project's own
> `CLAUDE.project.md` and `.github/instructions/project.instructions.md`.
> See `README.md` for details.

## Init Protocol for Consuming Projects

When an AI agent runs first-time setup (e.g., Claude Code's `/init`) in a project
that consumes IntelliSDLC.ai, follow this protocol:

**DO NOT modify any upstream-managed file:**

- `CLAUDE.md`
- `.github/copilot-instructions.md`
- `.github/agents/*`
- `.github/instructions/*` (except `project.instructions.md`)
- `.github/skills/*` (shared skills -- but **not** the consumer-owned `.github/skills/project-*/`)

These are pulled from IntelliSDLC.ai and any local edits will be lost
on the next sync. The Validate Instructions workflow may also flag leaks.

**DO create or extend the consumer-owned files:**

- `.github/instructions/project.instructions.md` -- copy from
  `project.instructions.md.template` if missing. Document project name,
  architecture, tech stack, build commands, key conventions, and domain
  glossary here. Read by all coding agents.
- `CLAUDE.project.md` -- copy from `CLAUDE.project.md.template` if missing.
  Auto-imported by Claude Code via the `@CLAUDE.project.md` line at the
  bottom of this file. Use for Claude-specific orientation overrides.
- `.github/skills/project-<name>/SKILL.md` -- optional per-repo skills. Any
  skill directory whose name starts with `project-` is consumer-owned: the
  sync never overwrites or deletes it and the leak-scan skips it, so it may
  contain project-specific names. No upstream change is required. (Exception:
  files named `*.template` or `.gitkeep` stay upstream-managed even inside a
  `project-*/` directory, so avoid those two filenames for consumer content.)
- `README.md` -- copy from `README.md.template` if missing. The default
  skeleton covers GitHub's five README questions (what / why / start /
  help / who) using `##` headings so GitHub auto-generates the Outline.

If a `*.template` file is present but the corresponding consumer-owned file
is not, copy the template (drop the `.template` suffix) and fill in the
sections. `Pull-SDLC.ai.ps1` does this automatically on first sync.

## GitHub Repository

Determine the repository owner and name from the git remote:

```bash
git remote get-url origin
```

When calling GitHub MCP tools, use the `owner` and `repo` values parsed from the
remote URL. Do **not** infer these values from the local directory name.

## ⛔ Before ANY Commit

**STOP and verify these before every `git commit`:**

1. **You are inside a worktree** (NOT the repo root). Run `git rev-parse --git-dir` — the
   path must differ from `git rev-parse --git-common-dir`. If they are the same, you are in
   the repo root: create a worktree immediately.
2. **You are NOT on `main`.** Run `git branch --show-current` — if it says `main`, stop
   and create a worktree/feature branch first.
3. **A GitHub issue exists** for the work you are committing. If not, create one first.
4. **You plan to open a PR** linking to that issue. Never merge to `main` directly.

A pre-commit hook (`.githooks/pre-commit`) enforces rules 1 and 2 automatically. Activate it:

```powershell
git config core.hooksPath .githooks
```

**The rule covers writes, not just commits.** "I am not committing, I am only
running a script" is how the root checkout gets polluted: tooling writes output
relative to the working directory, the files land on the protected branch where
commits are blocked, and nothing reports it. Be in a worktree before running
anything that produces files. `.githooks/check-dirty-primary-checkout` reports
a dirty primary checkout on the protected branch and can be wired into an agent
harness as an end-of-turn check. See **The Rule Covers WRITES, Not Just
Commits** in `.github/copilot-instructions.md`.

## Independent Code Review -- Reviewer != Author Model

**The invariant: before a PR merges, the diff must have been reviewed by a model
that did not write it.** That is the requirement. GitHub Copilot review is *one
way of satisfying* it -- not the requirement itself, and not the only transport.

**Substitution rule.** Run the review with a **different model than the authoring
model** (e.g. Opus authored -> Sonnet reviews) whenever either is true:

1. **Copilot review is not available** for the repository or organization, or
2. **The dev loop is running inside Claude Code** -- always, because an
   independent reviewer is available immediately by spawning a review subagent
   on a different model, with no dependency on a GitHub-side feature.

**Enforce the difference mechanically -- do not assume it.** A subagent spawned
without an explicit model override **inherits the authoring model**, which would
be self-review dressed up as independent review. Always pass an explicit model
override when launching the reviewer, and **record which model actually ran the
review** in the loop summary. "I spawned a review subagent" is not evidence the
invariant held; the reviewer's model name is.

If the runtime genuinely offers **no model other than the authoring one**, stop
and request a re-run with an eligible model rather than self-reviewing -- the
same last-resort escape as the Phase 6 independence gate.

When the substitution rule applies, **you may skip the Copilot-specific
instructions in `.github/agents/dev-loop.agent.md`**: the
`gh pr edit --add-reviewer "@copilot"` call, the `submittedAt` polling, and the
`resolveReviewThread` GraphQL loop are Copilot's *transport*, not the
requirement. What must still happen is exactly what those steps exist to
produce:

- an independent reviewer read the full diff,
- its findings were triaged (accepted or rejected with a rationale validated
  against the code -- a review is advisory, never auto-applied),
- every accepted Critical / Important finding was fixed using behavior-first
  testing,
- it ran under an explicit model override, so the reviewer was demonstrably
  not the authoring model, and
- the reviewer re-read the updated diff and reported no new accepted
  Critical / Important findings.

**Detection -- do not guess.** The Copilot reviewer request *appearing to
succeed is not evidence that it worked*: `gh pr edit --add-reviewer "@copilot"`
exits 0 and `POST /pulls/<n>/requested_reviewers` returns `200` even when
Copilot code review is disabled, and nothing registers. After requesting,
confirm it:

```bash
gh api repos/<owner>/<repo>/pulls/<pr-number>/requested_reviewers
```

An **empty** result means Copilot review is not enabled -- fall through to the
different-model path immediately rather than polling for a review that will
never arrive.

## Key References

- **Development conventions**: [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) -- code style, testing conventions, branching strategy, commit format, and workflow.
- **Skills**: [`.github/skills/`](./.github/skills/) -- reusable process definitions (behavior-first testing, refactoring, code review, debugging, functional testing, phase gates).
- **Agents**: [`.github/agents/`](./.github/agents/) -- orchestrators and interactive workflows (dev loop, planning, code review, instructions, PRD).
- **Language conventions**: [`.github/instructions/`](./.github/instructions/) -- C#, PowerShell, TypeScript, behavior-first testing principles.

## Repository Structure

Discover the project layout by examining the root directory. A typical C#/.NET project follows:

```
<RepoRoot>/
├── src/                           # Production source code
│   ├── <ProjectName>/             # Core library or application project(s)
│   └── <ProjectName>.*/           # Additional projects (API, CLI, Web, etc.)
├── tests/
│   └── unit/                      # xUnit unit tests mirroring src structure
├── docs/                          # Additional documentation
├── *.sln or *.slnx                # Solution file
└── .github/
    ├── copilot-instructions.md    # Primary dev conventions (read this first)
    ├── agents/                    # Agent prompt files (.agent.md)
    ├── skills/                    # Reusable process skills (SKILL.md)
    ├── instructions/              # Language/practice-specific instructions
    └── workflows/                 # GitHub Actions (CI setup steps)
```

## Technology Stack

| Layer | Technology |
|---|---|
| Language | C# / .NET 10+ |
| Testing | xUnit, Moq, FluentAssertions |

> Discover the full technology stack from solution/project files, `README.md`, and
> NuGet package references. Do not assume specific runtime hosts or external APIs.

## Shell Preference

Use **PowerShell** as the default shell for all commands. If PowerShell is not available, fall back to bash.

> **Encoding warning:** On Windows, the `gh` CLI garbles Unicode and collapses
> newlines when body text is passed inline. Never read an existing PR body with
> `--jq` and re-interpolate — PowerShell destroys newlines. Always construct the
> full body from scratch and use `--body-file`. See the **PR & Issue Body
> Formatting** section in `copilot-instructions.md`.

## Essential Commands

```powershell
# Build
dotnet build --no-restore

# Test
dotnet test --no-build --verbosity normal

# Format
dotnet format
```

Always run `dotnet build` and `dotnet test` after every code change. Fix all errors before proceeding.

## Development Workflow

Follow the full dev loop for any feature:

```
Sync Instructions → Brainstorm+Issue → Worktree → Plan → [TDD → Refactor → Functional Test → Code Review+Fix → PR+Independent Review+Dry Run]* → Merge → Cleanup
```

Use `@dev-loop` to orchestrate the full cycle. Phases 3-7 use an expanding loop -- each
phase is a quality gate, and any failure routes back to Phase 3 (TDD). The loop exits
only when an independent review (a reviewer that is not the authoring model)
passes with zero issues and the dry run succeeds.
See `.github/copilot-instructions.md` -> **Skills & Agents** for the complete reference.

- **Sync instructions first:** Before starting any dev loop, check whether the shared
  IntelliSDLC.ai have been updated upstream. Pull and merge the latest, then
  reload instructions so the current session uses the most recent rules.

- **Plan tracking:** Brainstorm (Phase 0) is delegated to the `@plan` agent,
  which produces the GitHub issue that captures the design. Update that issue
  with the implementation checklist in Phase 2. Link the PR with
  `Closes #<issue-number>` so merging auto-closes the issue.
- **Issue-before-implementation:** When using plan mode before a dev loop, create
  the GitHub issue at the end of planning (before implementation starts). The dev
  loop then references the existing issue instead of creating a new one.
- **Autopilot mode:** When autopilot is used to implement a plan, always use the
  Dev Loop agent (`@dev-loop`). Never skip the full quality cycle for plan work.

## Adding Command-Line Options -- Prompt First

A new command-line option (flag, switch, positional argument, or environment-variable
toggle) is a deliberate API decision, not an implementation detail. **STOP and get
explicit human approval before adding one** -- surface a recommendation (prefer changing
the default over accumulating an option) and wait for confirmation before writing the
option, its parsing, help text, or tests. This applies even in autopilot / autonomous
mode. See the canonical **Adding Command-Line Options -- Prompt First** section in
[`.github/copilot-instructions.md`](./.github/copilot-instructions.md) for the full rule.

## Surfacing Assumptions -- Report What You Decided Without Me

When you proceed without the user because they are unavailable (autopilot,
background / `bg:` tasks, or any other unattended continuation) and you resolve
an ambiguity by making your own assumption instead of asking, **record it and
surface it at the end for review**. List every such assumption with what you
assumed and the decision it drove, so the user can confirm or correct it; say
"None" when you made no autonomous assumptions. This applies to **all** cases
where you continued on your own judgment because the user could not be
consulted, and is enforced as the mandatory **Assumptions** field of the **Task
Complete Summary Format**. See the canonical **Surfacing Assumptions -- Report
What You Decided Without Me** section in
[`.github/copilot-instructions.md`](./.github/copilot-instructions.md).

## Task Complete Summaries

When calling `task_complete`, include the following fields whenever the data
exists (omit any that don't apply, e.g., a Q&A turn with no PR). The **Result
display** is the exception: it is mandatory on every dev-loop run and must not be
omitted -- only the PR link may be dropped when no PR exists. The **Assumptions**
field is **always present** in every summary -- state "None" when there were no
autonomous assumptions.

- **Issue** -- `[#NNN](https://github.com/<owner>/<repo>/issues/NNN)`
- **PR** -- `[#NNN](https://github.com/<owner>/<repo>/pull/NNN)`
- **Branch** -- `` [`<branch>`](https://github.com/<owner>/<repo>/tree/<branch>) ``
- **Test** -- exact local verification command (e.g., `dotnet test --no-build`,
  `Invoke-Pester -Path .\...`)
- **Result display** -- the actual result so the user sees the change worked
  without re-running it. **Required on every dev-loop run.** Inline (ANSI-stripped,
  fenced) captured output for CLI/markdown changes; a `file:///` link for
  UI/binary changes. Omit the inline output only when the user opted out
  (`-SkipDisplay`), and note it was skipped by user request.
- **Assumptions** -- every assumption you made while proceeding without the user
  (autopilot / unattended), each with what you assumed and the decision it drove,
  so they can be reviewed and corrected. **Always present in every summary** --
  state "None" when you made no autonomous assumptions.
- **Evidence (local)** -- clickable `file:///` URL to
  `.evidence/<phase-id>/evidence.md` (the entry-point file). Required when
  Phase 5b ran.
- **Evidence (PR)** -- PR-comment URL (or CI-artifact URL for files > 25 MB).
  Required when Phase 5b ran and the PR exists.

See the **Task Complete Summary Format** subsection of
`.github/copilot-instructions.md` for the canonical specification.

## Branching & Commits

- Never commit to `main` directly — always use a feature branch in a **worktree**.
- Create worktrees in `.worktrees/`: `git worktree add .worktrees/<issue#>-<name> -b <branch> main`.
- Branch naming: `<type>/<issue#>-<short-description>` (e.g., `feat/42-user-auth`)
- Commit format: `type(scope): description` (Conventional Commits)
- Merge to `main` only via pull request after the dev loop passes. **This repo
  only allows rebase merges** -- use `gh pr merge <pr-number> --rebase --delete-branch`.
  Never merge while CI is red.
- **All commits must come from a worktree** — the pre-commit hook blocks commits from the repo root.
  See the "Concurrent Session Safety" section in `.github/copilot-instructions.md` for details.
- **After a PR closes**, clean up the worktree and local branch. The recommended
  workflow is to run the `Cleanup-Worktree.ps1` script at the repo root, which
  performs all steps below automatically (auto-detects the branch when invoked
  from inside the worktree):

  ```powershell
  ./Cleanup-Worktree.ps1                           # targeted (auto-detect)
  ./Cleanup-Worktree.ps1 -Branch <name> -Force     # PR closed unmerged
  ./Cleanup-Worktree.ps1 -Sweep                    # + prune stale branches/refs
  ```

  Manual fallback (in order):
  1. Ensure your shell is **not** inside the worktree (e.g., `cd` back to the repo root).
  2. Unlock if needed, then remove the worktree: `git worktree unlock .worktrees/<issue#>-<name> || true; git worktree remove .worktrees/<issue#>-<name>`.
  3. Switch to `main` and pull latest: `git checkout main && git pull`.
  4. If the branch was merged, delete it safely: `git branch -d <branch-name>`.
     - If the PR was closed **without** merging and you still want to delete the branch,
       you must force‑delete it: `git branch -D <branch-name>` (this discards any unmerged work).

## Project-Specific Extensions

Project-specific orientation lives in `CLAUDE.project.md` (created by the consuming project from `CLAUDE.project.md.template`). The line below auto-imports it when present; Claude Code silently ignores the import if the file is absent.

@CLAUDE.project.md
