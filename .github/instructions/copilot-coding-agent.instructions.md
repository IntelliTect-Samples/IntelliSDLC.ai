---
description: 'Guidelines for the GitHub Copilot coding agent running autonomously in the cloud'
applyTo: '**/*'
---

# GitHub Copilot Coding Agent — Repository Guide

> These instructions are for the GitHub Copilot coding agent running autonomously in the cloud.
> Read this file alongside `CLAUDE.md` and `.github/copilot-instructions.md` for full project context.

## 1. Environment

- **Runner**: Ubuntu Linux (GitHub Actions `ubuntu-latest`)
- **Shell**: bash
- **.NET**: 10.x (pre-installed via `copilot-setup-steps.yml`)
- **Node.js**: 20.x (pre-installed via `copilot-setup-steps.yml`)
- **Dependencies**: `dotnet restore` and `npm ci` are run during setup — do not re-run them unless necessary

## 2. Key References

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Repository orientation: structure, branching, workflow, essential commands |
| `product-spec.md` | Living product specification — the source of truth for what the app does |
| `.github/copilot-instructions.md` | Full coding conventions, style rules, testing practices |
| `sample-appsettings.json` | Configuration template showing all required keys |
| `GMAIL_SETUP.md` | Gmail OAuth setup (not needed for stub-ai dry runs) |

## 3. Build & Verify Commands

Run these commands after **every** code change, in order:

```bash
# Format (must produce no changes)
dotnet format IntelliAIInstructions.slnx

# Build
dotnet build IntelliAIInstructions.slnx --no-restore

# Test
dotnet test IntelliAIInstructions.slnx --no-build --verbosity normal
```

Fix all format violations and test failures before committing. Never commit with failing tests or format errors.

## 4. Workflow

1. **Read the issue** — understand the acceptance criteria and implementation checklist fully before writing any code.
2. **TDD** — write a failing test first (Red), then implement the minimal code to pass it (Green), then refactor (Refactor). See `.github/instructions/tdd.instructions.md`.
3. **Implement** — make changes in `src/` and `tests/` only (see Scope Boundaries below).
4. **Format** — run `dotnet format IntelliAIInstructions.slnx` and fix any violations.
5. **Commit** — use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description` (e.g., `feat(renderer): add Gmail source links`).
6. **PR** — open a pull request with `Closes #<issue-number>` in the description so the issue is auto-closed on merge.

## 5. Testing Expectations

- **Framework**: xUnit + Moq + FluentAssertions
- **Location**: `tests/unit/Services/` (mirror `src/IntelliAIInstructions/Services/`)
- **Pattern**: Arrange / Act / Assert in every test method
- **Naming**: `MethodName_Scenario_ExpectedBehavior` (e.g., `GetMessageUrl_NullInput_ThrowsArgumentNullException`)
- **Isolation**: mock external dependencies (Gmail API, Azure OpenAI) with Moq; use real code paths for unit logic
- **Fixtures**: deterministic test data lives in `tests/unit/Services/Fixtures/` (saved `.eml` files)

## 6. Quality Bar

All of the following must be true before opening a PR:

- All tests pass (`dotnet test --no-build --verbosity normal`)
- No format violations (`dotnet format --verify-no-changes`)
- XML documentation comments (`/// <summary>`) on every public type and member
- Methods <= 20 lines; single-purpose functions
- Nullable reference types enabled (`#nullable enable`) in all new files
- No new warnings introduced
- PR body uses ASCII-only text (no em dashes, smart quotes, arrows -- see `copilot-instructions.md`)

## 7. Scope Boundaries

| Directory | Action |
|-----------|--------|
| `src/IntelliAIInstructions/` | ✅ Core library — primary work area |
| `src/IntelliAIInstructions.Cli/` | ✅ CLI entry point — modify when adding CLI flags |
| `tests/unit/` | ✅ Unit tests — always update alongside production code |
| `product-spec.md` | ✅ Update when adding or changing features |
| `pwa/` | ❌ Ignore — not part of the active C# application |
| `.github/workflows/` | ❌ Do not modify CI/CD workflows |
| `node_modules/` | ❌ Do not modify; managed by `npm ci` |

## 8. Dry-Run Validation

Validate CLI output without any Azure or Gmail credentials:

```bash
dotnet run --no-build --project src/IntelliAIInstructions.Cli -- \
  --stub-ai --input-dir SampleEmails --recursive \
  --output-dir ./dry-run-output --non-interactive
```

- `--stub-ai` uses a local stub instead of Azure OpenAI — no API keys needed
- `--input-dir SampleEmails` processes the checked-in sample `.eml` files
- `--output-dir ./dry-run-output` writes digest output to a local directory instead of sending email
- Check `./dry-run-output/` for generated HTML digests and `digest-preview.md`

## 9. What NOT to Do

- **Don't modify `.github/workflows/`** — CI/CD workflows are managed separately and changes can break the pipeline
- **Don't add NuGet or npm packages** without explicit justification in the issue; prefer existing dependencies
- **Don't skip tests** — every new behavior must have a corresponding test; never commit with failing tests
- **Don't commit secrets** — no API keys, credentials, or tokens in source code; use `sample-appsettings.json` as a template only
- **Don't run `dotnet restore` or `npm ci`** during development — dependencies are pre-installed in the runner environment
- **Don't touch `pwa/`** — the Progressive Web App directory is out of scope for C# application work
- **Don't use `throw ex;`** inside catch blocks — use `throw;` to preserve the call stack
