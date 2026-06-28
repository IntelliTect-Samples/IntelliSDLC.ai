---
name: code-review-workflow
description: "Review production and test code with a parallel panel of models from non-author vendors. Runs static analysis, reviews by severity (Critical/Important/Suggestions), then consolidates/dedupes, triages (accept/reject), and converges across the panel. Language-aware."
---

# Code Review Workflow

You are orchestrating an independent code review. Run it as a **parallel panel of models
from different vendors than the one that wrote the code**, providing a fresh perspective and
catching blind spots a single model (or the authoring model) would miss.

**Detect the project language** from file extensions and project files. Apply the matching
language-specific guidance below. If the language is not listed, infer conventions from
the project's existing code and community standards.

## Review Panel

**Do not review with a single model, and do not freeze the review to one model version.**
Run the review as a **parallel panel**: dispatch the **best code-review model from each
available non-author vendor** concurrently, so different vendors catch different classes of
issues. Target **three** non-author vendors; degrade gracefully to however many are
available (minimum one).

**Selecting the panel:**

1. **Independence (hard gate).** Exclude the **author's vendor entirely** -- every panelist
   must come from a *different vendor* than the one that wrote the code, and no panelist may
   be the authoring model.
2. **Availability (hard gate).** Only consider vendors/models actually offered by the
   current runtime / platform. The panel is the best non-author model from each available
   vendor, up to three.
3. **Best model per vendor.** For each chosen vendor, pick its **latest** flagship (not a
   mini / flash tier) with the strongest code reasoning, largest context window, and best
   instruction-following for the project's primary language.
4. **Dispatch in parallel.** Launch the panelists concurrently (e.g., parallel review
   subagents, one per vendor/model), each producing an independent **advisory** report.

Begin the consolidated review with a **Review panel** block:

```markdown
### Review panel
- **Panelists (best model per non-author vendor):** <vendor A>: <model>, <vendor B>: <model>, <vendor C>: <model>
- **Author model (excluded):** <author vendor/model>.
- **Vendors available / used:** <N available> / <M used (target 3)>.
- **Rationale:** <one line: independence confirmed, latest flagship per vendor, why this panel>.
```

Source the per-vendor candidates from the runtime's available-model list where possible;
otherwise use your stated knowledge (note that it may be stale). If fewer than three
non-author vendors are available, run the panel with those available and record the count.
If the host fixes the session model so only one model can run, document the assigned model
and confirm it satisfies the independence gate. **If a would-be panelist fails a hard gate**
(e.g., it is the same model that wrote the code, or it is unavailable), **drop it from the
panel**; if that leaves no eligible panelist, **stop and request a re-run with an eligible
model** rather than reviewing with an ineligible one.

## Core Principle

**Review early, review often.** Issues caught now are 10x cheaper than issues caught later.

## Mission

1. **Review** -- Dispatch the parallel panel (best non-author model per available vendor)
   to analyse the latest changes in production code and test code.
2. **Report** -- Produce a structured review with categorised findings by severity,
   leading with the Review panel block.
3. **Triage** -- The current/authoring model consolidates and **dedupes** the findings from
   all panelists and **accepts or rejects each one with a written rationale, validated
   against the code**. A review is advisory: do **not** auto-apply whatever it says.
4. **Fix** -- For accepted **Critical / Important** findings, fix using **behavior-first
   testing**. Apply accepted **low-effort** suggestions directly. For accepted
   **high-effort / high-impact** work, **create a GitHub issue** instead of fixing inline.
5. **Converge** -- Re-submit the updated diff to the **same panel** and iterate until
   convergence (re-review by every panelist surfaces no new accepted Critical / Important
   findings).
6. **Hand off** -- Present the final review report showing what was found, the triage
   verdict for each item, what was fixed, and any issues filed for deferred work.

See the **Triage & Convergence** section below for the full loop.

## When to Review

**Mandatory:**
- After each task in the development loop.
- After completing a major feature.
- Before merge to main.

**Optional but valuable:**
- When stuck (fresh perspective).
- Before refactoring (baseline check).
- After fixing a complex bug.

## Review Scope

### Step 0: Run Static Analysis First

Before any AI review, run **all** available static analysis tools. The **independent
reviewer** runs these read-only to surface findings; the **authoring model** applies the
fixes (static-analysis fixes are part of triage/convergence, not the reviewer's job):

**C# / .NET:**
```bash
dotnet format --verify-no-changes
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

The **authoring model** fixes all static analysis findings before the change is
re-submitted for review.

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
- **Test compliance** -- assess behavior-first testing by checking: (a) a test ships with each behavior change in the same commit / PR, (b) tests assert observable behavior rather than mirroring implementation, (c) the production change, when mentally reverted, would cause the test to fail with an *assertion* failure (not a compile/import error), (d) implementations do not hard-code the literal values used in the test (collusion), (e) test names follow `MethodName_Scenario_ExpectedBehavior` convention and use Arrange/Act/Assert. *Limitation:* test-first ordering cannot be verified from a diff alone -- only co-presence, structure, and collusion signals can be assessed.

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
| **Module loads** | `Import-Module ... -Force -ErrorAction Stop` succeeds. |
| **Pester tests** | `Invoke-Pester -Path tests/ -Output Detailed` passes. |

## Language-Specific Review -- TypeScript

| Check | Detail |
|---|---|
| **Type safety** | No unnecessary `any`; proper interfaces and generics used. |
| **Compilation** | `npm run type-check` completes without errors. |
| **JSDoc** | Every public function has a JSDoc comment. |
| **ES modules** | Uses `import`/`export`, not `require`/`module.exports`. |
| **Vitest** | `npx vitest run` passes. |
| **Playwright** | `npx playwright test` passes (if E2E tests exist). |

## Language-Specific Review -- Generic (Any Language)

1. **Run the project's lint tool** and report any issues.
2. **Run the project's test suite** and report any failures.
3. **Check naming conventions** match the language's community standards.
4. **Verify documentation comments** exist on public APIs.
5. **Check error handling** follows the language's idiomatic patterns.

---

## Triage & Convergence

A review is **advisory, not auto-applied**. After the **panel** reports findings, the
current/authoring model owns how they are consumed:

1. **Consolidate & dedupe.** Merge the findings from **all panelists** into one list and
   **dedupe** overlapping findings (multiple vendors often flag the same issue) so each real
   issue is triaged once. Note when several panelists independently agree -- that raises
   confidence.
2. **Triage.** For each finding, **accept or reject it with a written rationale**, after
   **validating it against the actual code**. Confirm the issue is real before acting; any
   panelist can be wrong (see Red Flags).
3. **Fix accepted Critical / Important** findings using **behavior-first testing** -- ship
   a test that fails for a behavioral reason when the fix is reverted, then implement.
4. **Apply accepted low-effort suggestions** directly (quick wins, no design decisions).
5. **File issues for accepted high-effort / high-impact** work instead of fixing inline;
   capture the rationale and scope in the issue and link it in the report.
6. **Re-submit & converge.** Send the updated diff back to the **same panel** (every
   panelist) and iterate from step 1. The loop exits at **convergence** -- re-review by
   **every panelist** surfaces no new **accepted** Critical / Important findings. (Rejected
   or nitpick findings do not block convergence.)

Record the triage verdict (accepted / rejected + rationale) for every finding in the
report below.

## Review Output Format

Each **panelist** produces a **findings-only** advisory report (descriptions + severity) --
panelists do **not** write the Review panel block or triage markers, since those require
knowing the whole panel. The **authoring model** produces the consolidated summary below:
it writes the Review panel block, the file list, the assessment, and the deduped findings,
and -- during the Triage & Convergence loop -- the **triage markers** (`Accepted` /
`Rejected` / `Issue filed`) and the `Convergence` line.

```markdown
## Code Review Summary

### Review panel
- **Panelists (best model per non-author vendor):** <vendor A>: <model>, <vendor B>: <model>, <vendor C>: <model>
- **Author model (excluded):** <author vendor/model>.
- **Vendors available / used:** <N> / <M (target 3)>.
- **Rationale:** <one line: independence confirmed, latest flagship per vendor>.

**Files reviewed:** <list of files>
**Overall assessment:** PASS | NEEDS CHANGES | CRITICAL ISSUES
**Static analysis:** Clean / <N> findings (fixes recorded by the authoring model during convergence)
**Convergence:** Converged after <N> round(s) -- no new accepted Critical/Important from any panelist / In progress

### Critical (must fix -- blocks progress)
- [x] `src/path/file.ext:L42` -- Description. **Accepted.** **Fixed:** <what was changed>.
- `src/path/file.ext:L55` -- Description. **Rejected:** <rationale validated vs code>.

### Important (should fix before proceeding)
- [x] `src/path/file.ext:L18` -- Description. **Accepted.** **Fixed:** <what was changed>.

### Suggestions (nice to have)
- [x] `tests/path/file.ext:L7` -- Description. **Accepted (low-effort).** **Applied.**
- `tests/path/file.ext:L22` -- Description. **Rejected:** <rationale>.
- **Issue filed:** `src/path/file.ext:L90` -- Description. *High-effort -> #<issue>.*

### Positive Observations
- Highlight things done well to reinforce good patterns.
```

## Severity Handling

| Severity | Action Required |
|----------|----------------|
| **Critical** | If accepted, blocks progress. Fix immediately (behavior-first) before further work. |
| **Important** | If accepted, fix (behavior-first) before proceeding to the next task. |
| **Suggestions** | If accepted and low-effort, apply. High-effort/high-impact -> file an issue. |

Every finding is first **triaged (accept/reject with rationale)**; only accepted findings
are acted on.

## Execution Guidelines

Steps 1-5 are performed by **each panelist** (independent reviewers producing advisory
reports, in parallel). Steps 6-12 -- consolidation, triage, fix, convergence -- are
performed by the **authoring model**; a panelist stops after step 5 and hands its report
off.

1. **Run static analysis tools first** -- run all formatters, linters, and compilers read-only and report any formatting, linting, or compiler warnings (the authoring model fixes them during triage).
2. **Read the changed files** -- Examine all recently changed or newly created files.
3. **Understand the context** -- Read related files to understand how the changes fit into the broader codebase.
4. **Run the test suite** -- Verify all tests pass before reviewing. Report test failures as Critical.
5. **Perform the review and report** -- Apply each review category systematically and produce the advisory report (findings only), leaving triage markers blank.
6. **(Authoring model) Consolidate & triage every finding** -- Merge and dedupe findings from all panelists, then accept or reject each with a rationale validated against the code. Do not auto-apply the review.
7. **(Authoring model) Fix accepted Critical and Important findings (behavior-first)** -- Ship a failing test first, then implement. Run tests after each fix to verify correctness.
8. **(Authoring model) Apply accepted low-effort Suggestions; file issues for high-effort work** -- **Low-effort** means: changes that can be made in under 5 minutes with no design decisions -- renaming, adding missing null checks, fixing typos, adding missing XML docs, extracting a method of <= 10 lines. Anything requiring design choices or touching > 3 files is high-effort -- create a GitHub issue instead.
9. **(Authoring model) Run the full test suite after all fixes** -- All tests must pass.
10. **(Authoring model) Run static analysis again** -- Verify everything is still clean after fixes.
11. **(Authoring model) Re-submit to the same panel and iterate until convergence** (every panelist surfaces no new accepted Critical / Important findings).
12. **(Authoring model) Produce the final report** -- Output the structured review (led by the Review panel block) showing the triage verdict per finding, what was fixed, and any issues filed.

## Red Flags

**Never:**
- Skip review because "it's simple".
- Ignore Critical issues.
- Proceed with unfixed Important issues.
- Argue with valid technical feedback without evidence.

**If reviewer is wrong:**
- Push back with technical reasoning.
- Show code/tests that prove it works.
- Request clarification.

## Review Checklist

- [ ] Review panel selected (best non-author model per available vendor, target 3); Review panel block recorded.
- [ ] Static analysis tools run (panelists) and findings fixed (authoring model).
- [ ] All changed files examined.
- [ ] Lint/compile runs without errors.
- [ ] Tests run and results noted.
- [ ] Panel findings consolidated and deduped across panelists.
- [ ] Every finding triaged (accepted/rejected with rationale validated vs code).
- [ ] Correctness issues identified and accepted ones fixed (behavior-first).
- [ ] Code quality issues identified and accepted ones fixed.
- [ ] Test quality issues identified and accepted ones fixed.
- [ ] Security concerns flagged and accepted ones fixed.
- [ ] High-effort/high-impact accepted work filed as issues.
- [ ] YAGNI compliance verified.
- [ ] All tests pass after fixes.
- [ ] Static analysis re-run and clean after fixes.
- [ ] Re-submitted to the same panel; every panelist converged.
- [ ] Review report produced in structured format with triage verdicts and fix status.
