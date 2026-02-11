---
description: 'Test Driven Development (TDD) guidelines for all code development'
applyTo: '**/*'
---

# Test Driven Development (TDD)

> All code development in this repository must follow Test Driven Development practices. Write tests first, then implement the minimal code to make them pass.

## Core TDD Principles

- **Red-Green-Refactor**: Write a failing test (Red), make it pass with minimal code (Green), then improve the code (Refactor)
- **Write tests before implementation**: Never write production code without a failing test that requires it
- **Test behavior, not implementation**: Focus on what the code should do, not how it does it
- **Keep tests simple and focused**: Each test should verify one specific behavior
- **Tests are documentation**: Tests should clearly communicate the intent and expected behavior of the code

## The TDD Workflow

### 1. Red Phase - Write a Failing Test

- Start by writing a test for a single, specific behavior
- Run the test to verify it fails for the expected reason
- The test should fail because the functionality doesn't exist yet
- Ensure the failure message is clear and actionable

### 2. Green Phase - Make the Test Pass

- Write the **minimal** code needed to make the test pass
- Don't worry about perfect code yet - just make it work
- Avoid adding functionality not required by the current test
- Run the test to verify it passes
- All existing tests must continue to pass

### 3. Refactor Phase - Improve the Code

- Clean up the code while keeping all tests passing
- Remove duplication
- Improve naming and structure
- Enhance readability and maintainability
- Run all tests after each refactoring step

### 4. Repeat

- Move to the next behavior or feature
- Start again at the Red phase

## When to Write Tests

- **Before adding new features**: Write tests that define the expected behavior first
- **Before fixing bugs**: Write a test that reproduces the bug, then fix it
- **Before refactoring**: Ensure existing tests cover the code being refactored
- **When modifying existing code**: Update or add tests to cover the changes

## Test Organization

### Test File Structure

- Keep tests close to the code they test
- Use clear, descriptive test file names
- Follow existing test file naming conventions in the repository:
  - JavaScript: `test-*.js` or `*.test.js`
  - HTML test pages: `test-*.html`
  - TypeScript: `*.test.ts` or `*.spec.ts` (if added in future)

### Test Naming Conventions

- Use descriptive test names that explain the behavior being tested
- Follow the pattern: "should [expected behavior] when [condition]"
- Examples:
  - `should filter out short headlines when text is less than 15 characters`
  - `should keep valid news headlines when cleanText is called`
  - `should reject code snippets when text contains programming syntax`

### Test Structure

Use the Arrange-Act-Assert (AAA) pattern:

```javascript
// Arrange - Set up test data and preconditions
const headline = "Breaking: Major earthquake hits California coast";

// Act - Execute the code being tested
const result = cleanText(headline);

// Assert - Verify the expected outcome
assert(result !== null, "Valid headline should be kept");
assert(result === headline, "Headline should be returned unchanged");
```

## Testing Best Practices

### Test Characteristics (F.I.R.S.T.)

- **Fast**: Tests should run quickly to enable frequent execution
- **Independent**: Tests should not depend on each other or shared state
- **Repeatable**: Tests should produce the same results every time
- **Self-validating**: Tests should have clear pass/fail outcomes
- **Timely**: Write tests at the right time (before the code)

### What to Test

- **Public APIs and interfaces**: Test the contract your code exposes
- **Edge cases**: Test boundary conditions and unusual inputs
- **Error conditions**: Test how code handles invalid input and error states
- **Common scenarios**: Test typical use cases
- **Integration points**: Test how components work together

### What Not to Test

- **Third-party code**: Trust that external libraries work (unless integration testing)
- **Framework internals**: Don't test the framework's functionality
- **Simple getters/setters**: Skip trivial code that has no logic
- **Private implementation details**: Test public behavior, not internal mechanics

## Testing Patterns for This Repository

### JavaScript/Node.js Testing

This repository uses vanilla JavaScript testing with the following patterns:

```javascript
// Example: Testing a validation function
function testValidHeadlines() {
    const validHeadlines = [
        "Biden announces new infrastructure plan",
        "Stock market reaches all-time high"
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const headline of validHeadlines) {
        const result = cleanText(headline);
        if (result !== null) {
            passed++;
            console.log(`✓ PASS: ${headline}`);
        } else {
            failed++;
            console.log(`✗ FAIL: ${headline} was rejected`);
        }
    }
    
    return failed === 0;
}
```

### Running Tests

**Current repository tests:**
- Run headline tests: `node pwa/test-headlines.js`
- Run tests with AI filtering: `node pwa/test-headlines.js --ai`
- View tests in browser: Open `pwa/test-headlines.html` in a browser

**For new code:**
- Follow the existing test patterns in the repository
- Run tests before and after making changes
- Add appropriate test commands to documentation as needed

## TDD for Different Scenarios

### Adding a New Feature

1. **Write test for the simplest case**
   ```javascript
   // Test: Should return true for valid email
   const result = validateEmail("test@example.com");
   assert(result === true);
   ```

2. **Implement minimal code to pass**
   ```javascript
   function validateEmail(email) {
       return true; // Simplest code that passes
   }
   ```

3. **Write test for invalid case**
   ```javascript
   // Test: Should return false for invalid email
   const result = validateEmail("notanemail");
   assert(result === false);
   ```

4. **Update implementation**
   ```javascript
   function validateEmail(email) {
       return email.includes("@");
   }
   ```

5. **Continue adding tests and refining**

### Fixing a Bug

1. **Write a test that reproduces the bug**
   ```javascript
   // Bug: cleanText incorrectly rejects headlines with numbers
   const result = cleanText("NASA launches Artemis 3 mission");
   assert(result !== null, "Headlines with numbers should be kept");
   ```

2. **Verify the test fails**
   - Run the test to confirm it fails

3. **Fix the bug**
   - Modify the code to make the test pass

4. **Verify all tests pass**
   - Run the entire test suite

### Refactoring Code

1. **Ensure tests exist**
   - Write tests first if they don't exist

2. **Run tests to verify current behavior**
   - All tests should pass before refactoring

3. **Make incremental changes**
   - Refactor in small steps

4. **Run tests after each change**
   - Tests should continue passing

5. **Commit when tests pass**
   - Use version control to checkpoint progress

## Test Coverage Goals

- **Critical paths**: 100% coverage of core functionality
- **Public APIs**: All public functions and methods should have tests
- **Edge cases**: Cover boundary conditions and error scenarios
- **Bug fixes**: Every fixed bug should have a test preventing regression

## Integration with Development Workflow

### Before Starting Work

1. Review existing tests to understand current behavior
2. Run existing tests to ensure they pass
3. Identify what tests need to be added or modified

### During Development

1. Write a failing test for the next behavior
2. Implement minimal code to pass the test
3. Refactor if needed while keeping tests green
4. Run tests frequently (after each significant change)

### Before Committing

1. Run the complete test suite
2. Ensure all tests pass
3. Verify no tests were removed (unless intentional)
4. Commit tests and implementation together

### Before Requesting Review

1. Verify all tests pass
2. Check that new code is adequately tested
3. Ensure tests are clear and well-documented
4. Run linters and formatters if available

## Common TDD Pitfalls to Avoid

- **Writing tests after implementation**: This defeats the purpose of TDD
- **Testing implementation details**: Focus on behavior, not internals
- **Writing overly complex tests**: Keep tests simple and focused
- **Skipping the refactor step**: Always clean up after getting tests to pass
- **Not running tests frequently**: Run tests after every change
- **Ignoring failing tests**: Never commit code with failing tests
- **Writing tests that are too broad**: One test should verify one behavior
- **Not testing edge cases**: Test boundary conditions and error scenarios

## Benefits of TDD

- **Better design**: Writing tests first leads to more testable, modular code
- **Living documentation**: Tests document how the code should behave
- **Faster debugging**: Failing tests quickly identify where problems are
- **Confidence to refactor**: Tests enable safe code improvements
- **Fewer bugs**: Catching issues early reduces defects in production
- **Clearer requirements**: Writing tests clarifies what needs to be built

## Resources and References

- Kent Beck's "Test Driven Development: By Example"
- Martin Fowler's articles on testing and refactoring
- The repository's existing test files in `pwa/` directory:
  - `test-headlines.js` - Node.js test runner with console output (tests headline text filtering and validation)
  - `test-headlines.html` - Browser-based test interface (tests headline text filtering and validation)

## Compliance

All AI agents and developers working on this repository must follow these TDD guidelines. Code reviews should verify that:

- Tests were written before implementation
- New features include corresponding tests
- Bug fixes include regression tests
- All tests pass before merging
- Tests are clear, focused, and maintainable
