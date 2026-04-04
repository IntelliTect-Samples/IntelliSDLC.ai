# CLAUDE.md — Gmail Synthesizer

This file provides orientation for AI assistants working in this repository.

## GitHub Repository

- **Owner:** `IntelliTect-Samples`
- **Repo:** `GmailNewsClient`
- **URL:** https://github.com/IntelliTect-Samples/GmailNewsClient

When calling GitHub MCP tools, always use `owner: "IntelliTect-Samples"` and `repo: "GmailNewsClient"`.
Do **not** infer these values from the local directory name.

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

## Key References

- **Product requirements**: [`product-spec.md`](./product-spec.md) — the single source of truth for what the application does. Update it with every feature change.
- **Development conventions**: [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) — code style, testing conventions, branching strategy, commit format, and agent workflow.
- **TDD guidelines**: [`.github/instructions/tdd.instructions.md`](./.github/instructions/tdd.instructions.md) — mandatory Red→Green→Refactor process.
- **TypeScript/JS conventions**: [`.github/instructions/typescript.instructions.md`](./.github/instructions/typescript.instructions.md)
- **Agent prompts**: [`.github/agents/`](./.github/agents/) — specialized agents for brainstorming, TDD, refactoring, code review, debugging, orchestration, and instruction maintenance.

## Repository Structure

```
GmailNewsClient/
├── src/
│   ├── GmailSynthesizer/          # Core library (services, models, config)
│   │   ├── Services/              # Business logic & external API wrappers
│   │   ├── Models/                # Domain models & DTOs
│   │   └── Configuration/         # App configuration types
│   └── GmailSynthesizer.Cli/      # CLI entry point and setup utilities
├── tests/
│   └── unit/                      # xUnit unit tests mirroring src structure
├── docs/                          # Additional documentation
├── SampleEmails/                  # Sample EML files for testing
├── product-spec.md                # Living product specification (PRD)
├── GMAIL_SETUP.md                 # Gmail OAuth setup instructions
├── sample-appsettings.json        # Config template
└── .github/
    ├── copilot-instructions.md    # Primary dev conventions (read this first)
    ├── agents/                    # Agent prompt files (.agent.md)
    ├── instructions/              # Language/practice-specific instructions
    └── workflows/                 # GitHub Actions (CI setup steps)
```

> **Note**: The `pwa/` folder exists in the repository but is not part of the current development focus. Ignore it when working on the C# application.

## Technology Stack

| Layer | Technology |
|---|---|
| Language | C# / .NET 9+ |
| Runtime | Azure Functions (timer-triggered) |
| Email API | Gmail API (`Google.Apis.Gmail.v1`) |
| AI | Azure OpenAI (`Azure.AI.OpenAI`, GPT-4o) |
| Email parsing | MimeKit, AngleSharp |
| Testing | xUnit, Moq, FluentAssertions |
| CLI | `GmailSynthesizer.Cli` project |

## Shell Preference

Use **PowerShell** as the default shell for all commands. If PowerShell is not available, fall back to bash.

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
Brainstorm+Issue → Worktree → Plan → [TDD → Refactor → Functional Test → Code Review+Fix → PR+Copilot Review+Dry Run]* → Cleanup
```

Use `@dev-loop` to orchestrate the full cycle. Phases 3–7 use an expanding loop — each
phase is a quality gate, and any failure routes back to Phase 3 (TDD). The loop exits
only when Copilot review passes with zero issues and the dry run succeeds.
See `.github/copilot-instructions.md` → **Agent Files** for the complete agent reference.

- **Plan tracking:** Create a GitHub issue during Brainstorm (Phase 0) to capture
  the design. Update it with the implementation checklist in Phase 2. Link the PR
  with `Closes #<issue-number>` so merging auto-closes the issue.
- **Issue-before-implementation:** When using plan mode before a dev loop, create
  the GitHub issue at the end of planning (before implementation starts). The dev
  loop then references the existing issue instead of creating a new one.
- **Autopilot mode:** When autopilot is used to implement a plan, always use the
  Dev Loop agent (`@dev-loop`). Never skip the full quality cycle for plan work.

## Branching & Commits

- Never commit to `main` directly — always use a feature branch in a **worktree**.
- Create worktrees in `.worktrees/`: `git worktree add .worktrees/<issue#>-<name> -b <branch> main`.
- Branch naming: `<type>/<issue#>-<short-description>` (e.g., `feat/42-digest-template`)
- Commit format: `type(scope): description` (Conventional Commits)
- Merge to `main` only via pull request after the dev loop passes.
- **All commits must come from a worktree** — the pre-commit hook blocks commits from the repo root.
  See the "Concurrent Session Safety" section in `.github/copilot-instructions.md` for details.
- **After a PR closes**, clean up the worktree and local branch in this order:
  1. Ensure your shell is **not** inside the worktree (e.g., `cd` back to the repo root).
  2. Unlock if needed, then remove the worktree: `git worktree unlock .worktrees/<issue#>-<name> || true; git worktree remove .worktrees/<issue#>-<name>`.
  3. Switch to `main` and pull latest: `git checkout main && git pull`.
  4. If the branch was merged, delete it safely: `git branch -d <branch-name>`.
     - If the PR was closed **without** merging and you still want to delete the branch,
       you must force‑delete it: `git branch -D <branch-name>` (this discards any unmerged work).
