---
description: 'Guidelines for the GitHub Copilot coding agent running autonomously in the cloud'
applyTo: '**/*'
---

# GitHub Copilot Coding Agent

> These instructions are specific to the GitHub Copilot coding agent running autonomously
> on cloud runners. For general project conventions (code style, branching, commit format,
> agent workflow), see [`.github/copilot-instructions.md`](../copilot-instructions.md).

## Environment

- Runs on **`ubuntu-latest`** GitHub Actions runners (Ubuntu Linux, bash shell)
- **`.github/workflows/copilot-setup-steps.yml`** pre-installs the environment before
  the agent starts:
  - .NET **10.x** SDK
  - `dotnet restore GmailSynthesizer.slnx` (dependencies pre-restored)
  - Node.js **20**
  - `npm ci` (Node dependencies pre-installed)
- No Azure API keys are available — use `--stub-ai` for all dry-run validation
  (see [Dry-Run Validation](#dry-run-validation))
- The solution file is **`GmailSynthesizer.slnx`**

## Key References

Read these before starting any task:

- **[`CLAUDE.md`](../../CLAUDE.md)** — repo orientation, structure, and pre-commit checklist
- **[`product-spec.md`](../../product-spec.md)** — living product specification; update it
  with every feature change
- **[`.github/copilot-instructions.md`](../copilot-instructions.md)** — code style, testing
  conventions, branching strategy, commit format, and agent workflow
- **[`.github/instructions/tdd.instructions.md`](tdd.instructions.md)** — mandatory TDD
  process (Red → Green → Refactor)
- **[`.github/agents/dev-loop.agent.md`](../agents/dev-loop.agent.md)** — the full 8-phase
  expanding loop workflow that orchestrates all code-related work

## Build & Verify Commands

Run these commands **after every change** to keep the working tree clean:

```bash
# Format (must produce no violations)
dotnet format GmailSynthesizer.slnx

# Build (no restore needed — dependencies pre-installed)
dotnet build GmailSynthesizer.slnx --no-restore

# Test (no build needed — always run after build)
dotnet test GmailSynthesizer.slnx --no-build --verbosity normal
```

- **Never skip** format or tests before committing
- Fix all format violations and test failures before proceeding to the next step
- If `dotnet build` reports errors, resolve them before running tests

## Development Workflow (MANDATORY)

**ALL code-related work (features, bug fixes, refactoring) MUST follow the Dev Loop
defined in [`.github/agents/dev-loop.agent.md`](../agents/dev-loop.agent.md).**

The Dev Loop is an 8-phase expanding loop. Each phase is summarized below — see the
full agent file for complete phase details, exit criteria, and the expanding loop pattern.

| Phase | Name | Summary |
|---|---|---|
| 0 | **Brainstorm** | Explore the design space and get user approval. Create or reference a GitHub issue to track the work. |
| 1 | **Worktree** | Create a feature branch and git worktree in `.worktrees/`. All file changes happen inside the worktree — never on `main`. |
| 2 | **Plan** | Break the approved design into bite-sized tasks with exact file paths, test code, and test commands. Save to `docs/designs/`. |
| 3 | **TDD** | Red → Green cycle: write a failing test first, then write the minimal code to make it pass. Never skip watching the test fail. |
| 4 | **Refactor** | Eliminate duplication and simplify. All tests must stay green after every refactoring step. |
| 5 | **Functional Testing** | Validate user-facing behavior with integration or end-to-end tests. Skip only if the change is purely internal with no user-facing surface. |
| 6 | **Code Review + Fix** | Run static analysis, then invoke the code review agent. Fix all Critical/Important findings. Up to 3 review passes. |
| 7 | **PR + Copilot Review + Dry Run** | Rebase onto main, update `product-spec.md`, create PR with `Closes #N`, request Copilot review, iterate until clean, then run the dry-run smoke test. |
| 8 | **Cleanup** | Remove the worktree and delete the feature branch after the PR merges. |

**Phases 3–7 form an expanding loop** — each phase acts as a quality gate, and any
failure routes back to **Phase 3 (TDD)**. The loop exits only when Copilot review
passes with zero unresolved threads and the dry run succeeds.

**Exception:** The ONLY exception is documentation-only changes that touch no code
files (`.cs`, `.ts`, `.ps1`). For those, use the lightweight
[`@instructions`](../agents/instructions.agent.md) agent workflow instead.

See [`.github/agents/dev-loop.agent.md`](../agents/dev-loop.agent.md) for complete
phase details, exit criteria, and the expanding loop pattern.

## Agent Reference

| Agent | When to Use |
|---|---|
| [`dev-loop.agent.md`](../agents/dev-loop.agent.md) | ALL code-related work — the orchestrator |
| [`brainstorming.agent.md`](../agents/brainstorming.agent.md) | Design exploration before committing to implementation |
| [`tdd.agent.md`](../agents/tdd.agent.md) | Invoked by dev-loop for Red → Green → Refactor |
| [`refactor.agent.md`](../agents/refactor.agent.md) | Invoked by dev-loop after each green step |
| [`functional-testing.agent.md`](../agents/functional-testing.agent.md) | Invoked by dev-loop for user-facing validation |
| [`code-review.agent.md`](../agents/code-review.agent.md) | Invoked by dev-loop for independent review |
| [`systematic-debugging.agent.md`](../agents/systematic-debugging.agent.md) | Any bug or unexpected behavior |
| [`instructions.agent.md`](../agents/instructions.agent.md) | Documentation/instruction-only changes |

## Testing Expectations

Follow the full TDD conventions in [`.github/copilot-instructions.md`](../copilot-instructions.md)
and [`tdd.instructions.md`](tdd.instructions.md). Key requirements:

- Framework: **xUnit** with **Moq** for mocking
- Pattern: **Arrange / Act / Assert** in every test method
- Naming: **`MethodName_Scenario_ExpectedBehavior`**
  (e.g., `ParseEmail_WhenSubjectMissing_ReturnsEmpty`)
- Location: `tests/unit/` mirroring `src/GmailSynthesizer/`
  (e.g., `src/GmailSynthesizer/Services/Foo.cs` → `tests/unit/Services/FooTests.cs`)
- File naming: `*Tests.cs`
- Mock all external dependencies (Gmail API, Azure OpenAI) — never make real network
  calls in unit tests
- Use **`FluentAssertions`** for readable assertions where available

## Quality Bar

Every PR must satisfy all of the following before merging:

- **All tests pass** — `dotnet test` exits with code 0
- **No format violations** — `dotnet format --verify-no-changes` exits with code 0
- **XML documentation comments** (`/// <summary>`) on every public type and member
- **Methods ≤ 20 lines** — extract helpers when logic grows
- **Nullable reference types enabled** — `#nullable enable` in all new files
- No new compiler warnings introduced

## Scope Boundaries

- **Focus on:** `src/` (production code) and `tests/` (unit tests)
- **Ignore `pwa/`** — this directory exists in the repo but is not part of the active
  C# application
- Do not modify files outside the issue scope without a clear reason

## Dry-Run Validation

Validate end-to-end behavior without Azure credentials using the `--stub-ai` flag:

```bash
dotnet run --no-build --project src/GmailSynthesizer.Cli -- \
  --stub-ai \
  --input-dir SampleEmails \
  --recursive \
  --output-dir ./dry-run-output \
  --non-interactive
```

- **`--stub-ai`** replaces all Azure OpenAI calls with deterministic stubs — no API
  keys required
- Sample emails are in `SampleEmails/`; output is written to `./dry-run-output/`
- Run this after tests pass to confirm the CLI integrates correctly end-to-end

## What NOT to Do

- **Do not commit directly to `main`** — always use a feature branch and open a PR
- **Do not bypass the Dev Loop for code changes** — all code-related work must follow
  the full Dev Loop (Phases 0–8). Skipping phases produces incomplete quality coverage.
- **Do not modify workflow files** (`.github/workflows/`) — these are managed separately
- **Do not add NuGet or npm packages** without clear justification tied to the issue
  requirements
- **Do not skip tests** — never comment out, delete, or `[Skip]` tests to make the
  build green
- **Do not commit secrets** — no API keys, tokens, connection strings, or credentials
  in any file
- **Do not modify `pwa/`** unless the issue explicitly targets that directory
