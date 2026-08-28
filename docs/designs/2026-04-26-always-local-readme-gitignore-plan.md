# Plan: Always-local README.md and .gitignore on upstream sync

Issue: #24
Branch: `feat/24-always-local-readme-gitignore`

## Tasks

### Task 1 (TDD) - Test-IsAlwaysLocalPath helper

- Add tests in `Pull-SDLC.ai.Tests.ps1` for a new `Test-IsAlwaysLocalPath` helper:
  - returns true for `README.md`, `readme.md`, `.gitignore`
  - returns false for `src/Foo.cs`, `CLAUDE.md`, empty string
- Watch them fail.
- Add `$script:AlwaysLocalPaths = @('README.md', '.gitignore')` and `Test-IsAlwaysLocalPath` to `Pull-SDLC.ai.ps1` near the existing script-scope state.
- Watch them pass.
- Commit: `test(sync): cover Test-IsAlwaysLocalPath helper` + `feat(sync): add always-local path predicate`.

### Task 2 (TDD) - Resolve-AlwaysLocalConflicts helper

- Add tests for a function that takes `git status --porcelain` lines and returns auto-resolved paths:
  - input `'UU README.md'`, `'UU .gitignore'`, `'UU src/Other.cs'` -> result contains the first two only.
  - empty input -> empty array.
  - non-conflict lines (e.g. `' M file.txt'`) ignored.
- Watch fail.
- Implement `Resolve-AlwaysLocalConflicts` as a pure function that parses porcelain lines and returns the list of always-local conflicted paths. Action (the actual `git checkout --ours` / `git add`) is performed by the caller; the helper just classifies, so it is unit-testable.
- Watch pass.
- Commit: `test(sync): cover Resolve-AlwaysLocalConflicts classifier` + `feat(sync): classify always-local merge conflicts`.

### Task 3 - Integrate into untracked-file flow

- In the untracked-file conflict loop, before the diff/Read-Host, check `Test-IsAlwaysLocalPath`. If true, run the existing "save local; remove file; queue restore" branch non-interactively and log a clear message; `continue` past the prompt.
- Run pester (all green).
- Commit: `feat(sync): force-keep-local for README/gitignore on untracked conflict`.

### Task 4 - Integrate into tracked UU flow

- In the post-merge porcelain loop, before the existing `UD`/`DU` switch, call `Resolve-AlwaysLocalConflicts` and for each returned path:
  - `git checkout --ours -- <path>`
  - `git add -- <path>`
  - Append to `$autoResolved`.
- The existing finalize-if-no-remaining-conflicts block then commits the merge automatically.
- Run pester.
- Commit: `feat(sync): auto-resolve UU conflicts on README/gitignore as keep-local`.

### Task 5 - Doc/synopsis update

- Update the script header comment block to note that `README.md` and `.gitignore` are always preserved local on sync.
- Commit: `docs(sync): document always-local policy in script header`.

### Phase 6/7 - Code review, PR, Copilot review.
