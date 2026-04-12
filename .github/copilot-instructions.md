# Copilot Workspace Instructions

> **⚠️ Generic instructions — no project-specific content. Upstream-only edits.**
> These instruction files are shared across multiple projects. Never add
> project names, architecture details, domain concepts, specific dependencies,
> or hardcoded paths. All changes must be made in the
> [IntelliAIInstructions](https://github.com/IntelliTect-Dev/IntelliAIInstructions)
> repo and pulled into consuming projects — never edited locally and pushed back.
> Project-specific context belongs in the consuming project's own
> `.github/instructions/project.instructions.md`. See `README.md` for details.

## Project Overview

This is a **C#/.NET** project. Discover the project's purpose, architecture, and full
technology stack from the solution/project files, `README.md`, and NuGet package references.

Key baseline technologies: C# / .NET 9+, xUnit, Moq.

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

- Unit test files mirror the source tree (e.g., `src/<ProjectName>/Services/FooService.cs`
  → `tests/unit/Services/FooServiceTests.cs`).
- Run tests with:
  ```bash
  dotnet build --no-restore
  dotnet test --no-build --verbosity normal
  ```
- Use **Arrange / Act / Assert** pattern in every test method.
- Use **descriptive test method names**: `MethodName_Scenario_ExpectedBehavior`.
- Mock external dependencies with Moq. Use real code paths wherever possible.
- Use **test fixtures** (saved data files in `tests/fixtures/`) for deterministic testing.
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
| Unit tests | Vitest (when configured) | `tests/unit/**/*.test.ts` |
| Functional / E2E | Playwright (when configured) | `tests/e2e/**/*.spec.ts` |

- Run tests with:
  ```bash
  npm run type-check
  npm test
  # When Vitest/Playwright are configured, also run:
  # npx vitest run
  # npx playwright test
  ```

## Product Specification

If the project maintains a living product specification (e.g., `product-spec.md`):

- **Update the spec with every feature** — when a new behavior is implemented,
  document it in the spec.
- **When a requirement changes, update the spec to reflect the final behavior** —
  do not keep outdated requirements. The spec always describes the current state
  of the product, not its history.
- **Replace superseded acceptance criteria** — if a feature's behavior is modified,
  rewrite the acceptance criteria to match the new behavior. Remove or revise any
  criteria that no longer apply.
- The spec is the single source of truth for what the application **currently** does.
- Sections: Overview, Features (with acceptance criteria), API Surface, Data Model,
  Known Limitations.
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
- Branch naming: `<type>/<issue#>-<short-description>`
  Examples: `feat/42-user-auth`, `fix/57-validation-error`.
- All work happens on the feature branch. Merge to `main` only via pull request
  after the dev loop passes.
- **Git worktrees must be placed in the `.worktrees/` subdirectory** of the repo
  root (e.g., `git worktree add .worktrees/<issue#>-<name> -b <branch> main`). This directory is
  already in `.gitignore`.
- **Clean up feature branches and their worktrees after the PR closes.**
  - First, remove any worktrees that are using the branch (the branch cannot be deleted while it is checked out):
    ```bash
    git worktree list
    git worktree unlock .worktrees/<issue#>-<worktree-name> || true
    git worktree remove .worktrees/<issue#>-<worktree-name>
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

## Concurrent Session Safety

Multiple Copilot sessions working in the repo root simultaneously will corrupt the shared
git index and overwrite each other's files. The pre-commit hook enforces worktree usage as
the primary protection, but all agents and developers must follow these rules:

- **All commits must come from a worktree** — the pre-commit hook blocks every commit made
  from the repo root. This is hard enforcement; it cannot be bypassed accidentally.
- **One worktree per issue** — name worktrees `<issue#>-<short-description>` so two sessions
  working on different issues never collide (`git` prevents the same branch from being
  checked out in two worktrees simultaneously).
- **Lock worktrees after creation** — run `git worktree lock .worktrees/<issue#>-<name>`
  immediately after `git worktree add`. This prevents accidental `git worktree prune` from
  removing an active worktree.
- **Unlock before removal** — run `git worktree unlock .worktrees/<issue#>-<name>` before
  `git worktree remove` during cleanup (Phase 8).
- **`--no-verify` escape hatch** — the hook can be bypassed with `git commit --no-verify`.
  Use this only in exceptional circumstances (e.g., a one-off hot fix directly on a branch
  that truly cannot use a worktree). Never use it to work in the repo root.
- **Concurrent work on the same issue is unsupported** — two sessions working on the same
  issue number will attempt to check out the same branch, which git will reject. Coordinate
  with other sessions before starting work.

## Plan Tracking

Every feature must be tracked as a **GitHub issue** through the full lifecycle:

- **Create the issue during Brainstorm (Phase 0)** — capture the design, intent, and
  any key decisions. Title: the feature name (e.g., "Content extraction pipeline").
- **Update the issue with the implementation plan (Phase 2)** — add a task checklist
  derived from the plan, and a link to the plan document (if saved to `docs/designs/`).
- **Update the issue** as implementation phases complete (optional but encouraged).
- **Link the PR to the issue** — include `Closes #<issue-number>` in the pull
  request description so that merging the PR automatically closes the issue.
- If a plan was created outside the Dev Loop (e.g., via `@plan` or
  manually), create the issue before or at the time the PR is opened.

## Autopilot Usage

- **When autopilot mode is used to implement a plan, always use the Dev Loop
  agent (`@dev-loop`).** This ensures the full quality cycle (TDD, refactor,
  functional test, code review) is followed — never skip it.
- Plain autopilot without Dev Loop is acceptable only for non-plan work
  (e.g., quick fixes, documentation-only changes, or single-file edits that
  do not stem from an approved plan).

## PR & Issue Body Formatting

When writing PR descriptions, issue bodies, or review comments through the CLI
(`gh pr create`, `gh pr edit`, `gh issue create`), **always use `--body-file`**
instead of inline `--body "..."`. Two problems occur with inline bodies:

1. **Collapsed newlines** -- the shell strips line breaks from multiline strings,
   producing a single-line wall of text that renders as broken markdown.
2. **CP437 mojibake** -- on Windows, the `gh` CLI converts Unicode through the
   console's OEM codepage, producing garbled characters (e.g., `ΓÇö` instead of `—`).

**Required workflow** for any `gh` command that accepts a body:

```powershell
# Write body to a temp file with explicit UTF-8 (no BOM)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$PWD/pr-body.tmp", $body, $utf8NoBom)

# Pass via --body-file
gh pr create --title "feat: ..." --body-file pr-body.tmp
# or: gh pr edit <number> --body-file pr-body.tmp
# or: gh issue create --title "..." --body-file pr-body.tmp

# Clean up
Remove-Item pr-body.tmp
```

On **Linux/macOS** (e.g., GitHub Copilot coding agent):

```bash
echo "$body" > pr-body.tmp
gh pr create --title "feat: ..." --body-file pr-body.tmp
rm -f pr-body.tmp
```

> **Never** pass body text inline via `--body "..."`. Always use `--body-file`.

**ASCII replacements** for common Unicode characters (prevents CP437 mojibake):

| Instead of | Use |
|---|---|
| `—` (em dash) | ` -- ` |
| `–` (en dash) | `-` |
| `→` (arrow) | `->` |
| `'` `'` (smart quotes) | `'` |
| `"` `"` (smart quotes) | `"` |
| `≤` `≥` | `<=` `>=` |
| `✅` `✨` (emoji) | Spell out or omit |

## Commit Messages

Follow Conventional Commits: `type(scope): description`

Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`.

## Agent Files

Dedicated agent prompts live in `.github/agents/` using the `.agent.md` format:

| Agent | Purpose |
|---|---|
| `plan.agent.md` | Design and planning — Socratic questioning, approach trade-offs, GitHub issue creation. Replaces brainstorming + SE PM agents |
| `tdd.agent.md` | Red → Green → Refactor cycle with Iron Law enforcement (no code without failing test) |
| `functional-testing.agent.md` | Generate & maintain functional / E2E tests with verification-before-completion |
| `refactor.agent.md` | Identify and remove duplication after each green step — YAGNI, simplicity first |
| `code-review.agent.md` | Independent code review using a different LLM (`gpt-4.1`) — reviews AND fixes issues directly |
| `systematic-debugging.agent.md` | 4-phase root cause investigation — no fixes without understanding the problem first |
| `dev-loop.agent.md` | Orchestrator: Brainstorm+Issue → Worktree → Plan → [TDD → Refactor → Functional Test → Code Review+Fix → PR+Copilot Review+Dry Run]* → Cleanup |
| `instructions.agent.md` | Maintain all instruction files and tooling config across platforms — lightweight workflow with consistency review |
| `prd.agent.md` | Generate comprehensive Product Requirements Documents with user stories, acceptance criteria, and optional GitHub issue creation |


### Development Workflow

Use `@dev-loop` to drive the full quality cycle for any feature. It coordinates
all other agents in order. Phases 3–7 use an expanding loop — each phase acts as a
quality gate, and any failure routes back to Phase 3 (TDD).

```
Brainstorm+Issue → Worktree → Plan → [TDD → Refactor → Functional Test → Code Review+Fix → PR+Copilot Review+Dry Run]* → Cleanup
```

#### CI Failure Restart Loop

After pushing to a PR branch, GitHub Actions runs the CI pipeline (build, test, format
checks). **If CI fails, the dev cycle restarts:**

1. **Push** — push commits to the PR branch.
2. **CI runs** — GitHub Actions executes build, test, and format checks.
3. **If CI fails** — investigate the failure logs, identify the root cause, fix the
   issues locally, and push again. Route back to step 1.
4. **If CI passes** — the PR is eligible for review and merge.

This loop applies to every push — the initial PR push, pushes after rebasing onto
`main`, and pushes after addressing code review feedback. A PR must **never** be
merged while CI is red. Treat a CI failure exactly like a failing local test: the
dev cycle is not complete until the pipeline is green.

Use `@plan` when exploring a new idea before committing to implementation.
Use `@systematic-debugging` when encountering any bug or unexpected behavior.
Use `@instructions` for any changes to agent files, instruction files, or platform config.

#### Agent Output Linking

In all agent summaries and Task Complete statements, **always use full GitHub links**
for PR numbers, issue numbers, and branch names — never plain-text references like
`#131` or `feat/126`. This makes output clickable and navigable.

| Reference type | Format |
|---|---|
| Pull request | `[#131](https://github.com/<owner>/<repo>/pull/131)` |
| Issue | `[#60](https://github.com/<owner>/<repo>/issues/60)` |
| Branch | `` [`feat/126-feature-name`](https://github.com/<owner>/<repo>/tree/feat/126-feature-name) `` |

Determine the repository's `owner` and `repo` from the git remote URL
(see `CLAUDE.md`) when constructing URLs.

##### PR Summary Formatting

When listing multiple PRs in Task Complete summaries (e.g., merge results, status
reports), use a **numbered list format** — not a markdown table. Tables render poorly
in terminal environments because the renderer sizes columns based on raw markdown
length (including hidden URLs), making link columns disproportionately wide.

Use this template for each row:

```
N. [`#NNN`](pr-url) · `branch-name-padded` · `CI-result-padded` · Result text
```

Rules:
- **Numbered list**, not a table — avoids terminal column sizing issues.
- **`·` separators** between fields for visual structure.
- **Backtick-wrap PR numbers inside links**: `` [`#150`](url) `` — ensures consistent
  code styling across all rows and preserves trailing-space padding for short numbers
  (e.g., `` [`#2  `](url) ``).
- **Pad all fields to fixed width** using trailing spaces inside backtick spans:
  - PR numbers: pad to match the widest (e.g., 4 chars for `#150`).
  - Branch names: pad to match the longest branch name.
  - CI results: pad to match the widest CI field.
- **Result text** is the final field, no padding needed.

Example:

```markdown
1. [`#150`](https://github.com/.../pull/150) · `fix/149-flat-labels              ` · `✅ 762 tests ` · Merged (clean)
2. [`#2  `](https://github.com/.../pull/2)   · `copilot/convert-to-typescript    ` · `✅ (isolated)` · Merged (draft → ready)
```

- **Issue-before-implementation:** When using plan mode before launching a dev loop,
  create the GitHub issue at the end of planning (after user approval, before
  implementation starts). This ensures the issue number is available when the feature
  branch and PR are created, enabling `Closes #<issue-number>` from the first commit.
