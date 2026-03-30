# Gmail Synthesizer — Copilot Workspace Instructions

## Project Overview

Gmail Synthesizer is a **C#/.NET** application that consolidates informational/newsletter-style
emails into categorized digest emails. It runs as a timer-triggered Azure Function, connects
to Gmail via the Gmail API, uses Azure OpenAI for AI-powered categorization and content
extraction, and delivers consolidated digests back into the user's Gmail inbox.

Key technologies: C# / .NET 9+, Azure Functions, Gmail API (Google.Apis.Gmail.v1),
Azure OpenAI (Azure.AI.OpenAI), MimeKit, AngleSharp, xUnit, Moq.

## Language Detection

Detect the project's primary language from its files and apply the matching guidance below.
When multiple languages coexist, apply each language's rules to the files of that language.

| Indicator files | Language |
|---|---|
| `.cs`, `.csproj`, `.sln` | C# / .NET |
| `.ps1`, `.psm1`, `.psd1` | PowerShell |
| `.ts`, `.js`, `package.json`, `tsconfig.json` | TypeScript / JavaScript |
| `.py`, `pyproject.toml`, `setup.py` | Python |
| `.go`, `go.mod` | Go |
| `.rs`, `Cargo.toml` | Rust |
| `.java`, `pom.xml`, `build.gradle` | Java |

If the language is not listed, infer conventions from the project's existing code,
README, and build files.

## Development Philosophy

1. **Test-Driven Development (TDD)** — Write tests first, always. No production code
   without a failing test.
2. **Systematic over ad-hoc** — Process over guessing. Follow structured workflows.
3. **Complexity reduction** — Simplicity as primary goal. YAGNI ruthlessly.
4. **Evidence over claims** — Verify before declaring success. Run commands, read
   output, present facts.
5. **Functional Testing** — Validate user-facing behavior with integration or
   end-to-end tests.
6. **Continuous Refactoring** — Eliminate duplication after every green step.

## Code Style — Generic (All Languages)

- Keep functions / methods small (≤ 20 lines) and single-purpose.
- Prefer immutable variables where the language supports them.
- Every public function must have a documentation comment (doc-comment, JSDoc,
  XML doc, comment-based help, etc.).
- Follow the language's established naming, formatting, and module conventions.
- Use the project's existing linter / formatter. Run it after every change.
- After **every step** (RED, GREEN, REFACTOR, or any code change), run the project's
  compile/lint command and verify there are no errors. Fix any errors before proceeding.

## Code Style — C# / .NET

- All new source files must be `.cs`. Use file-scoped namespaces.
- Follow **Microsoft C# coding conventions**: PascalCase for public members, camelCase
  for local variables and parameters, `_camelCase` for private fields.
- Use **XML documentation comments** (`/// <summary>`) for every public type and member.
- Prefer `readonly`, `const`, and immutable collections where possible.
- Use **nullable reference types** (`#nullable enable`) in all new files.
- Prefer **expression-bodied members** for single-line methods and properties.
- Use **pattern matching**, **switch expressions**, and **collection expressions** where
  they improve readability.
- Prefer **dependency injection** over static classes or service locators.
- All async methods must use the `Async` suffix and return `Task` or `Task<T>`.
- After every step, run `dotnet build` and `dotnet test` to verify there are no errors:
  ```bash
  dotnet build --no-restore
  dotnet test --no-build --verbosity normal
  ```
- Use `dotnet format` to ensure consistent formatting.

### Exceptions

- **DO** use `nameof` for the `paramName` argument in `ArgumentException`,
  `ArgumentNullException`, etc. Use `nameof(value)` in property setters.
- **DO** use `ArgumentException.ThrowIfNull()` (.NET 7+) to validate non-null parameters.
- **DO** use `throw;` (not `throw ex;`) inside catch blocks to preserve the call stack.
- **DO** use exception filters to avoid rethrowing from within a catch block.
- **DO** specify the inner exception when wrapping exceptions.
- **DO** favor `try/finally` over `try/catch` for cleanup code.
- **DO NOT** over-catch — let exceptions propagate unless you clearly know how to
  handle them programmatically.
- **DO NOT** create new exception types unless they would be handled differently
  than existing CLR exceptions.
- **DO NOT** use exceptions for normal, expected conditions.
- **DO NOT** throw exceptions from implicit conversions or operator overloads.
- **DO NOT** have public members that return exceptions as return values or `out`
  parameters.

### Dispose & Finalization

- **DO** call `GC.SuppressFinalize()` from `Dispose()`.
- **DO** ensure `Dispose()` is idempotent (safe to call multiple times).
- **DO** invoke the base class `Dispose()` when overriding.
- **DO** implement `IDisposable` on types that own disposable fields or properties,
  and dispose of them.
- **DO** implement finalizer methods only on objects with unmanaged resources that
  lack their own finalizers.
- **DO NOT** throw exceptions from finalizer methods.

### Properties & Fields

- **DO** declare all instance fields as private; expose them via properties.
- **DO** favor automatically implemented properties over fields.
- **DO** create read-only automatically implemented properties (rather than
  read-only properties with a backing field) when the value should not change.
- **DO** preserve the original property value if the property setter throws an exception.
- **DO** implement non-nullable reference type auto-properties as read-only.
- **DO** assign non-nullable reference type properties before instantiation completes.
- **DO NOT** provide set-only properties or properties where the setter has broader
  accessibility than the getter.

### Structs

- **DO NOT** define a struct unless it logically represents a single value,
  consumes ≤ 16 bytes, is immutable, and is infrequently boxed.
- **DO** use `record struct` (C# 10.0+).
- **DO** use the `readonly` modifier on struct definitions.
- **DO** ensure the default value (all zeros) of a struct is valid.
- **DO NOT** rely on default constructors or member initialization at declaration
  to run on a value type.

### Records

- **DO** use `record class` for clarity rather than the abbreviated `record` syntax.
- **DO** use records when you want equality based on data rather than identity.
- **DO** define all reference type positional parameters as nullable if not providing
  a custom property implementation that checks for null.

### Enums & Flags

- **DO NOT** use the enum type name as part of enum value names.
- **DO** provide a `None = 0` value for all enums.
- **DO** use `[Flags]` and powers of 2 for flag enums.
- **DO NOT** include sentinel values (e.g., `Maximum`).

### Collections & LINQ

- **DO** use `Any()` rather than `Count() > 0` when checking for items.
- **DO** use a collection's `Count` property instead of `Enumerable.Count()` method.
- **DO NOT** call `OrderBy()` after a prior `OrderBy()` — use `ThenBy()` for
  secondary sorting.
- **DO NOT** represent an empty collection with `null` — return an empty collection.

### Threading & Synchronization

- **DO** declare a separate, read-only `object` for synchronization targets — never
  lock on `this` or public objects.
- **DO** ensure code holding multiple locks always acquires them in the same order.
- **DO** cancel unfinished tasks rather than allowing them to run during application
  shutdown.
- **DO** encapsulate mutable static data with synchronization logic.
- **DO** use `Task`-based APIs in favor of `Thread` and `ThreadPool`.
- **DO** use `TaskCreationOptions.LongRunning` sparingly.

### ToString

- **DO** override `ToString()` whenever useful diagnostic strings can be returned.
- **DO** provide `ToString(string format)` or implement `IFormattable` if the return
  value requires formatting or is culture-sensitive.
- **DO NOT** return an empty string or `null` from `ToString()`.
- **DO NOT** throw exceptions or cause observable side effects from `ToString()`.

### Miscellaneous

- **DO** use `Environment.NewLine` rather than `\n` for cross-platform compatibility.
- **DO** use uppercase literal suffixes (e.g., `1.618033988749895M`).
- **DO** favor composite formatting over `+` concatenation when localization is possible.
- **DO NOT** provide an implicit conversion operator if the conversion is lossy.

## Code Style — PowerShell

- All new source and test files must be `.ps1` / `.psm1` / `.psd1`.
- Follow the **Verb-Noun** naming convention for functions.
- Use **comment-based help** (`<# .SYNOPSIS ... #>`) for every exported function.
- Prefer `[CmdletBinding()]` and `param()` blocks for all functions.
- Use **approved verbs** only (`Get-Verb` to list them).

## Code Style — TypeScript / JavaScript

- Favor TypeScript (`.ts`) over JavaScript (`.js`).
- After every step, run `npm run type-check` to verify there are no type errors.
- Prefer `const` / `let`; never `var`.
- Use ES modules (`import` / `export`).
- Name files in kebab-case; classes in PascalCase; functions/variables in camelCase.
- Every public function must have a JSDoc comment.

## Testing Conventions — Generic

- **Unit tests** mirror the source tree.
- **Test files live in a `tests/` directory** (or the language's conventional location).
- Use the project's established test framework. If none exists, choose the community
  standard for the language.
- Functional / integration tests are organized by feature or user flow.

## Testing Conventions — C# / .NET (xUnit)

| Layer | Tool | Location |
|---|---|---|
| Unit tests | xUnit + Moq | `tests/unit/**/*Tests.cs` |
| Integration tests | xUnit | `tests/integration/**/*Tests.cs` |
| Functional tests | xUnit | `tests/functional/**/*Tests.cs` |

- Unit test files mirror the source tree (e.g., `src/GmailSynthesizer/Services/ContentExtractor.cs`
  → `tests/unit/Services/ContentExtractorTests.cs`).
- Run tests with:
  ```bash
  dotnet build --no-restore
  dotnet test --no-build --verbosity normal
  ```
- Use **Arrange / Act / Assert** pattern in every test method.
- Use **descriptive test method names**: `MethodName_Scenario_ExpectedBehavior`.
- Mock external dependencies (Gmail API, Azure OpenAI) with Moq. Use real code paths
  wherever possible.
- Use **test fixtures** (saved EML files in `tests/fixtures/`) for deterministic testing.
- Use `IClassFixture<T>` or `ICollectionFixture<T>` for expensive shared setup.
- Prefer `FluentAssertions` for readable assertions where available.

## Testing Conventions — PowerShell (Pester)

| Layer | Tool | Location |
|---|---|---|
| Unit tests | Pester | `tests/unit/**/*.Tests.ps1` |
| Integration tests | Pester | `tests/integration/**/*.Tests.ps1` |

- Run tests with:
  ```powershell
  Invoke-Pester -Path tests/ -Output Detailed
  ```

## Testing Conventions — TypeScript / JavaScript

| Layer | Tool | Location |
|---|---|---|
| Unit tests | Vitest | `tests/unit/**/*.test.ts` |
| Functional / E2E | Playwright | `tests/e2e/**/*.spec.ts` |

- Run tests with:
  ```bash
  npx tsc && npx vitest run
  npx playwright test
  ```

## Product Specification

Maintain a living product specification in `product-spec.md`.

- **Update the spec with every feature** — when a new behavior is implemented,
  document it in the spec.
- **When a requirement changes, update the spec to reflect the final behavior** —
  do not keep outdated requirements. The spec always describes the current state
  of the product, not its history.
- **Replace superseded acceptance criteria** — if a feature's behavior is modified,
  rewrite the acceptance criteria to match the new behavior. Remove or revise any
  criteria that no longer apply.
- The spec is the single source of truth for what the application **currently** does.
- Sections: Overview, Features (with acceptance criteria), API Surface, UI Flows,
  Data Model, Known Limitations.
- Use Conventional Commits for spec changes: `docs(spec): add <feature> specification`
  or `docs(spec): update <feature> specification`.

## Tool Preferences

- **Prefer Git CLI over GitKraken MCP tools.** Use standard `git` commands in the
  terminal for common operations (add, commit, push, pull, log, diff, status, branch,
  checkout, etc.).
- **GitKraken MCP tools are acceptable** when they provide functionality not easily
  available via the Git CLI (e.g., GitKraken workspace listing, GitLens-specific
  features like launchpad, start-work, or commit composer).

## Branching Strategy

- **Never commit directly to `main`.** Always create a feature branch first.
- Branch naming: `<agent-name>/<type>/<short-description>` — prefix with the
  agent/model name.
  Examples: `Opus.4.6/feat/content-extraction`, `Opus.4.6/fix/digest-template`.
- All work happens on the feature branch. Merge to `main` only via pull request
  after the dev loop passes.
- **Git worktrees must be placed in the `.worktrees/` subdirectory** of the repo
  root (e.g., `git worktree add .worktrees/<name> <branch>`). This directory is
  already in `.gitignore`.
- **Clean up feature branches and their worktrees after the PR closes.**
  - First, remove any worktrees that are using the branch (the branch cannot be deleted while it is checked out):
    ```bash
    git worktree list
    git worktree remove .worktrees/<worktree-name>
    # Optionally prune any stale worktrees
    git worktree prune
    ```
  - Then switch to `main`, pull, and delete the branch:
    - If the PR was **merged** and you want a safe delete (only if fully merged):
      ```bash
      git checkout main
      git pull
      git branch -d <branch-name>
      ```
    - If the PR was **closed without merge** and you are sure you want to discard the branch:
      ```bash
      git checkout main
      git pull
      git branch -D <branch-name>
      ```

## Plan Tracking

Every feature must be tracked as a **GitHub issue** through the full lifecycle:

- **Create the issue during Brainstorm (Phase 0)** — capture the design, intent, and
  any key decisions. Title: the feature name (e.g., "Content extraction pipeline").
- **Update the issue with the implementation plan (Phase 2)** — add a task checklist
  derived from the plan, and a link to the plan document (if saved to `docs/plans/`).
- **Update the issue** as implementation phases complete (optional but encouraged).
- **Link the PR to the issue** — include `Closes #<issue-number>` in the pull
  request description so that merging the PR automatically closes the issue.
- If a plan was created outside the Dev Loop (e.g., via `@brainstorming` or
  manually), create the issue before or at the time the PR is opened.

## Autopilot Usage

- **When autopilot mode is used to implement a plan, always use the Dev Loop
  agent (`@dev-loop`).** This ensures the full quality cycle (TDD, refactor,
  functional test, code review) is followed — never skip it.
- Plain autopilot without Dev Loop is acceptable only for non-plan work
  (e.g., quick fixes, documentation-only changes, or single-file edits that
  do not stem from an approved plan).

## Commit Messages

Follow Conventional Commits: `type(scope): description`

Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`.

## Agent Files

Dedicated agent prompts live in `.github/agents/` using the `.agent.md` format:

| Agent | Purpose |
|---|---|
| `brainstorming.agent.md` | Socratic design refinement — explore intent, propose approaches, get approval before coding |
| `tdd.agent.md` | Red → Green → Refactor cycle with Iron Law enforcement (no code without failing test) |
| `functional-testing.agent.md` | Generate & maintain functional / E2E tests with verification-before-completion |
| `refactor.agent.md` | Identify and remove duplication after each green step — YAGNI, simplicity first |
| `code-review.agent.md` | Independent code review using a different LLM (`o4-mini`) — reviews AND fixes issues directly |
| `systematic-debugging.agent.md` | 4-phase root cause investigation — no fixes without understanding the problem first |
| `dev-loop.agent.md` | Orchestrator: Brainstorm+Issue → Worktree → Plan → [TDD → Refactor → Functional Test → Code Review+Fix → Dry Run → PR+Copilot Review]* → Cleanup |

### Development Workflow

Use `@dev-loop` to drive the full quality cycle for any feature. It coordinates
all other agents in order. Phases 3–8 use an expanding loop — each phase acts as a
quality gate, and any failure routes back to Phase 3 (TDD).

```
Brainstorm+Issue → Worktree → Plan → [TDD → Refactor → Functional Test → Code Review+Fix → Dry Run → PR+Copilot Review]* → Cleanup
```

Use `@brainstorming` when exploring a new idea before committing to implementation.
Use `@systematic-debugging` when encountering any bug or unexpected behavior.
