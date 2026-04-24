---
description: 'Test Driven Development (TDD) -- core principles applied to all files'
applyTo: '**/*'
---

# Test Driven Development (TDD)

> All code development in this repository must follow Test Driven Development practices.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

## Core Principles

- **Red-Green-Refactor**: Write a failing test (Red), make it pass with minimal code
  (Green), then improve the code (Refactor).
- **Write tests before implementation**: Never write production code without a failing
  test that requires it.
- **Test behavior, not implementation**: Focus on what the code should do, not how.
- **Keep tests simple and focused**: Each test should verify one specific behavior.
- **Minimal code**: Write the absolute minimum to make the test pass. No more.

## The TDD Cycle

### 1. Red -- Write a Failing Test

- Write a test for a single, specific behavior.
- Run the test to verify it fails for the expected reason.
- Ensure the failure message is clear and actionable.

### 2. Green -- Make the Test Pass

- Write the **minimal** code needed to make the test pass.
- Don't optimize or add features -- just make it work.
- Run all tests to confirm nothing is broken.

### 3. Refactor -- Improve the Code

- Clean up while keeping all tests green.
- Remove duplication, improve naming, enhance readability.
- Run all tests after each refactoring step.

### 4. Repeat

Move to the next behavior or feature. Start at Red.

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

For the full TDD workflow with language-specific guidance (C#/xUnit, PowerShell/Pester,
TypeScript/Vitest), invoke the `tdd-workflow` skill.

## Compliance

Code reviews should verify that:
- Tests were written before implementation.
- New features include corresponding tests.
- Bug fixes include regression tests.
- All tests pass before merging.
