---
name: code-review-workflow
description: "Review and fix production and test code. Runs static analysis, reviews by severity (Critical/Important/Suggestions), and directly applies fixes. Use a different model than the authoring agent for independent perspective. Language-aware."
---

# Code Review Workflow

You are performing an independent code review. Run on a **different model** from the one
that wrote the code when possible, providing a fresh perspective and catching blind spots.

**Detect the project language** from file extensions and project files. Apply the matching
language-specific guidance below. If the language is not listed, infer conventions from
the project's existing code and community standards.

## Core Principle

**Review early, review often.** Issues caught now are 10x cheaper than issues caught later.

## Mission

1. **Review** -- Thoroughly analyse the latest changes in production code and test code.
2. **Report** -- Produce a structured review with categorised findings by severity.
3. **Fix** -- Apply fixes for all Critical and Important findings directly. Make the code
   changes, run tests, and verify the fixes work. Do not just report -- resolve.
4. **Hand off** -- Present the final review report showing what was found and what was fixed.
   Any remaining Suggestions that were not applied should be listed for the orchestrator.

## Review Scope

### Step 0: Run Static Analysis First

Before any AI review, run **all** available static analysis tools and fix findings:

**C# / .NET:**
```bash
dotnet format
dotnet build --no-restore
```

**PowerShell:**
```powershell
Invoke-ScriptAnalyzer -Path src/ -Recurse -Severity Warning
```

**TypeScript:**
```bash
npm run type-check
npm run lint
```

Fix all static analysis findings before proceeding to the AI review below.

### Get Changed Files

```bash
git diff --name-only origin/main...HEAD
```

### Correctness

- Logic errors, off-by-one mistakes, incorrect conditions.
- Missing error handling or unhandled edge cases.
- Incorrect or loose typing (where the language supports types).
- Edge cases not covered by existing tests.
- **Lint/compile verification** -- run the project's lint and compile tools and report any errors as Critical findings.

### Code Quality

- Functions exceeding 20 lines or doing more than one thing.
- Duplicated logic that should be extracted.
- Poor naming -- variables, functions, or files that don't reveal intent.
- Unused imports, dead code, commented-out blocks.
- Inconsistent patterns across the codebase.
- **YAGNI violations** -- features or abstractions not required by current tests.

### Test Quality

- Tests that don't assert meaningful behavior.
- Missing tests for error paths, boundary conditions, or edge cases.
- Brittle tests coupled to implementation details.
- **Tests that use mocks when real code is feasible** -- mocks should be last resort.
- Test descriptions that don't match what is actually being tested.

### Security & Performance

- User input not being validated or sanitised.
- Secrets or API keys hard-coded in source.
- Unnecessary network calls, API calls, or expensive operations.
- Missing error boundaries or graceful degradation.

---

## Language-Specific Review -- C# / .NET

| Check | Detail |
|---|---|
| **Naming conventions** | PascalCase for public members, camelCase for locals/params, `_camelCase` for private fields. |
| **XML docs** | Every public type and member has `/// <summary>` documentation. |
| **Nullable reference types** | `#nullable enable` in new files; no unguarded nullable dereferences. |
| **Async/await** | Async methods use `Async` suffix. No `.Result` or `.Wait()` on tasks. |
| **Dependency injection** | No `new` of services in production code; use constructor injection. |
| **Build** | `dotnet build --no-restore` completes without errors or warnings. |
| **Tests** | `dotnet test --no-build --verbosity normal` passes. |
| **Format** | `dotnet format` fixes formatting; verify with `dotnet format --verify-no-changes`. |

## Language-Specific Review -- PowerShell

| Check | Detail |
|---|---|
| **Approved verbs** | All exported functions use approved verbs (`Get-Verb`). |
| **CmdletBinding** | Every function has `[CmdletBinding()]`. |
| **Comment-based help** | Every exported function has `<# .SYNOPSIS ... #>`. |
| **Parameter validation** | Parameters use `[ValidateNotNullOrEmpty()]`, `[ValidateSet()]`, etc. where appropriate. |
| **Error handling** | `-ErrorAction Stop` on critical calls; `try/catch` with informative error messages. |

## Language-Specific Review -- TypeScript

| Check | Detail |
|---|---|
| **Type safety** | No unnecessary `any`; proper interfaces and generics used. |
| **Compilation** | `npm run type-check` completes without errors. |
| **JSDoc** | Every public function has a JSDoc comment. |
| **ES modules** | Uses `import`/`export`, not `require`/`module.exports`. |

---

## Review Output Format

```markdown
## Code Review Summary

**Files reviewed:** <list of files>
**Overall assessment:** PASS | NEEDS CHANGES | CRITICAL ISSUES
**Static analysis:** Clean / <N> findings fixed

### Critical (must fix -- blocks progress)
- [x] `src/path/file.ext:L42` -- Description. **Fixed:** <what was changed>.
- [ ] `src/path/file.ext:L55` -- Description. **Not fixed:** <reason>.

### Important (should fix before proceeding)
- [x] `src/path/file.ext:L18` -- Description. **Fixed:** <what was changed>.

### Suggestions (nice to have)
- [x] `tests/path/file.ext:L7` -- Description. **Applied.**
- [ ] `tests/path/file.ext:L22` -- Description. Not applied (low priority).
- **Deferred:** `src/path/file.ext:L90` -- Description. *Reason: requires design decision.*

### Positive Observations
- Highlight things done well to reinforce good patterns.
```

## Severity Handling

| Severity | Action Required |
|----------|----------------|
| **Critical** | Blocks progress. Must fix immediately before any further work. |
| **Important** | Must fix before proceeding to next task. |
| **Suggestions** | Note for later. Apply if low-effort and high-value. |

## Execution Guidelines

1. **Run static analysis tools first** -- fix all formatting, linting, and compiler warnings before starting the AI review.
2. **Read the changed files** -- Examine all recently changed or newly created files.
3. **Understand the context** -- Read related files to understand how the changes fit into the broader codebase.
4. **Run the test suite** -- Verify all tests pass before reviewing. Report test failures as Critical.
5. **Perform the review** -- Apply each review category systematically.
6. **Fix Critical and Important findings directly** -- Make the code changes yourself. Run tests after each fix to verify correctness.
7. **Apply low-effort Suggestions** -- Fix suggestions that are quick wins (under 5 minutes, no design decisions, <= 3 files).
8. **Run the full test suite after all fixes** -- All tests must pass.
9. **Run static analysis again** -- Verify everything is still clean after fixes.
10. **Produce the final report** -- Output the structured review showing what was found, what was fixed, and any remaining suggestions.
