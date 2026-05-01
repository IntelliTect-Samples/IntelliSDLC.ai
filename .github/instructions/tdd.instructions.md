---
description: 'Behavior-first testing -- core principles applied to all files'
applyTo: '**/*'
---

# Behavior-First Testing

> All code development in this repository must ship with tests that prove the
> behavior changed. Test-first (the classic Red-Green-Refactor cycle) is the
> default path; this document defines the rule the tests must satisfy and the
> narrow exceptions that allow deferring test-first.

## The Two-Part Rule

Every behavior change must satisfy **both** of these:

1. **A test ships with the change.** No production behavior change without a
   corresponding test in the same commit (or earlier in the same PR).
2. **The test must fail for a behavioral reason when the change is reverted.**
   That means an assertion failure -- not a compile error, not an import error,
   not a missing-symbol error. If reverting the production code only breaks
   compilation, the test is collusion, not verification.

This replaces the prior "Iron Law" wording. The rule is stronger because it
constrains the *quality* of the test, not just its presence.

## Core Principles

- **Red-Green-Refactor is the default cycle**: Write a failing test (Red),
  make it pass with the smallest honest implementation (Green), then improve
  the code (Refactor).
- **Test behavior, not implementation**: Assert observable outcomes. Tests
  must not mirror the structure of the code they cover.
- **Keep tests simple and focused**: Each test should verify one specific
  behavior.
- **Smallest honest implementation**: Write the smallest code that genuinely
  implements the behavior. Do **not** hard-code the test's input-to-output
  mapping just to make a single test pass -- that is collusion, not progress.

## The TDD Cycle (default path)

### 1. Red -- Write a Failing Test

- Write a test for a single, specific behavior.
- Run the test to verify it fails for the expected reason.
- The failure must be a **behavioral** failure (assertion), not a compile or
  import error. Fix any setup errors first, then re-run until the failure
  message clearly describes the missing behavior.

### 2. Green -- Smallest Honest Implementation

- Write the smallest code that genuinely implements the behavior under test.
- Do **not** hard-code test inputs (e.g., `if input == "foo" return "bar"`)
  just to make the assertion pass. If the implementation only works for the
  literal values in the test, it is collusion -- add a second test that
  forces a real implementation, or write the real implementation now.
- Run all tests to confirm nothing else broke.

### 3. Refactor -- Improve the Code

- Clean up while keeping all tests green.
- Remove duplication, improve naming, enhance readability.
- Run all tests after each refactoring step.

### 4. Repeat

Move to the next behavior or feature. Start at Red.

## When test-first does not apply (spike clause)

Test-first may be deferred for **exploratory spikes** -- short investigations
whose goal is to discover the right shape of an API or algorithm, not to
deliver behavior. The rules for spikes are:

- **Spike code must not reach `main` untested.** Before merge, every spike
  is either:
  1. **Deleted** and re-implemented test-first against the lessons learned, or
  2. **Retro-fitted** with behavior-first tests that satisfy the two-part
     rule above (each test must fail for a behavioral reason when its
     corresponding spike code is reverted).
- **Spike work must be visibly marked** while in progress (branch name,
  commit message, or PR draft state) so reviewers do not mistake it for
  finished work.
- **Spike duration is bounded.** If a spike outgrows its question, stop and
  re-plan -- do not let undeclared spike work accumulate.

This is the *only* sanctioned exception to test-first. "I'll test after",
"too simple to test", and "already manually tested" remain rationalizations.

## Anti-collusion guardrail

A test is collusion (not verification) when any of these are true:

- Reverting the production change only causes a compile/import error, not an
  assertion failure.
- The test asserts an internal call sequence or implementation structure
  that would be equally valid if implemented differently.
- The production code returns hard-coded values keyed off the literal test
  inputs.
- The test was written after the implementation and never observed to fail.

Treat collusion findings as defects. Fix by either tightening the assertion
to an observable behavior, or replacing the hard-coded implementation with
one that generalizes.

## When to Write Tests

- **Before adding new features**: Define expected behavior first.
- **Before fixing bugs**: Write a test that reproduces the bug, then fix it.
- **Before refactoring**: Ensure tests cover the code being changed.

## Test Quality (F.I.R.S.T.)

- **Fast**: Tests should run quickly.
- **Independent**: Tests should not depend on each other.
- **Repeatable**: Same results every time.
- **Self-validating**: Clear pass/fail outcomes.
- **Timely**: Written before the code.

## Detailed Process

For the full behavior-first workflow with language-specific guidance (C#/xUnit,
PowerShell/Pester, TypeScript/Vitest), invoke the `behavior-first-testing` skill.

## Compliance

Code reviews should verify that:
- A test ships with every behavior change.
- Each test fails for a behavioral reason when the change is reverted
  (not just a compile/import error).
- Tests assert observable behavior, not implementation structure.
- Implementations do not hard-code test inputs.
- Spike code has been deleted or retro-fitted with behavior-first tests
  before merge.
- All tests pass before merging.
