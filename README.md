# IntelliSDLC.ai

Generic AI agentic coding instructions for C#/.NET projects on GitHub. These files
configure Copilot, Claude Code, Codex, and other AI coding assistants with a
consistent development workflow (TDD, code review, dev loop orchestration, etc.).

## Onboarding

Pick the recipe that matches your starting state:

### A. Existing repo (already has files, history, and `origin`)

Most common case. From the repo root:

```powershell
iwr https://raw.githubusercontent.com/IntelliTect-Samples/IntelliSDLC.ai/main/Pull-SDLC.ai.ps1 -OutFile Pull-SDLC.ai.ps1
./Pull-SDLC.ai.ps1 -Bootstrap -NoSelfUpdate
```

What happens:

- Adds `sdlc.ai` remote pointing at this repo and fetches `main`.
- Lays down all upstream-managed files (`CLAUDE.md`, `.github/copilot-instructions.md`,
  `.github/agents/*`, `.github/skills/*`, generic `.github/instructions/*`, `.claude/*`).
- **Scaffolds consumer-owned files only if missing** (`CLAUDE.project.md`,
  `.github/instructions/project.instructions.md`, `.gitattributes`) from their
  `*.template` counterparts. Existing copies are never overwritten.
- **Extends `.gitignore`** with required entries; does not replace it.
- `origin` is untouched.
- Lands a `chore(sdlc): sync` commit with `.sdlc-ai-sync.json` recording the
  anchor for future incremental syncs.

If you are on `main` and the repo has a pre-commit policy active, the script
**auto-creates a worktree** (`.worktrees/sdlc-sync`), commits there, pushes,
and opens a PR. Review and merge it like any other PR.

For subsequent updates: re-run `./Pull-SDLC.ai.ps1` (no flags). Bootstrap is
a one-time event; ongoing syncs are incremental.

> **Why `-Bootstrap` and `-NoSelfUpdate`?** `-Bootstrap` accepts the empty-tree
> anchor non-interactively (no prompt). `-NoSelfUpdate` works around an
> upstream issue ([#135](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/135))
> where the script's self-refresh feature can leave the bootstrap script
> showing as `modified`. Both flags will become unnecessary once
> [#136](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/136)
> ships auto-detect.

### B. Brand-new project (no files, no repo, no `origin`)

Create a directory, initialize git, then run the same one-liner:

```powershell
mkdir my-new-project; cd my-new-project; git init
iwr https://raw.githubusercontent.com/IntelliTect-Samples/IntelliSDLC.ai/main/Pull-SDLC.ai.ps1 -OutFile Pull-SDLC.ai.ps1
./Pull-SDLC.ai.ps1 -Bootstrap -NoSelfUpdate -AllowDefaultBranch
gh repo create --source=. --public --push
```

`-AllowDefaultBranch` is needed because a fresh repo has no pre-commit hook
installed yet, so the auto-worktree path does not apply.

### C. Brand-new project via GitHub template (planned)

Once issue [#136](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/136)
ships, a thin-shell template repo at `IntelliTect-Samples/IntelliSDLC.ai-template`
will provide a one-step path:

```powershell
gh repo create my-new-project --template IntelliTect-Samples/IntelliSDLC.ai-template --public --clone
cd my-new-project
./bootstrap.ps1
```

Until then, use recipe **B** above.

## Updating an Onboarded Repo

Once `.sdlc-ai-sync.json` exists, simply re-run the script with no flags:

```powershell
./Pull-SDLC.ai.ps1
```

It pulls upstream changes, replays them as a diff against your recorded
anchor, and lands a new `chore(sdlc): sync` commit. The pre-flight drift
guard refuses to run if any upstream-managed file shows local edits since
the last sync; pass `-Force` to override (and explain why in the commit).

## Usage Reference

- **Initial copy:** clone or download this repo and copy the files into your project.
- **Ongoing sync:** use `Pull-SDLC.ai.ps1` -- it adds this repo as a git remote
  named `sdlc.ai` and merges updates. See `Pull-SDLC.ai.ps1 -?` for details.

On first sync, `Pull-SDLC.ai.ps1` also scaffolds the consumer-owned files
(`.github/instructions/project.instructions.md`, `CLAUDE.project.md`, and
`.gitattributes`) from their `*.template` counterparts. They are never
overwritten on subsequent syncs. The `.gitattributes.template` ships a
recommended baseline (LF for `*.sh`, CRLF for `*.ps1` and `*.bat`, binaries
left alone) -- once placed it is fully consumer-owned, so projects can edit
or replace it without upstream interference.

## File Ownership

Files belong to one of two tiers:

| Tier | Files | Edit rule |
|---|---|---|
| **Upstream** (managed here) | `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/agents/*`, generic `.github/instructions/*` (`tdd`, `csharp`, `powershell`, `typescript`, `copilot-coding-agent`), `.github/skills/*`, `.claude/*` | Never edit in a consumer project. Edits go upstream and pull down. |
| **Consumer** (owned by your project) | `CLAUDE.project.md`, `.github/instructions/project.instructions.md`, `product-spec.md`, project's own `README.md`, `.gitignore`, `.gitattributes`, project-specific `.github/workflows/*` | Owned by your project. Never touched by `Pull-SDLC.ai.ps1`. |

## Init Protocol for Consuming Projects

When an AI agent runs first-time setup (e.g., Claude Code's `/init`, or you
manually onboard a new repo) in a project that consumes IntelliSDLC.ai:

**DO NOT modify any upstream-managed file** (see table above). They are pulled
from this repo and any local edits will be lost on the next sync. The
`validate-instructions.yml` workflow also scans for project-specific content
leaks in upstream files.

**DO create or extend the consumer-owned files:**

- `.github/instructions/project.instructions.md` -- copy from
  `project.instructions.md.template` if missing. Document project name,
  architecture, tech stack, build commands, key conventions, and domain
  glossary here. Read by all coding agents.
- `CLAUDE.project.md` -- copy from `CLAUDE.project.md.template` if missing.
  Auto-imported by Claude Code via the `@CLAUDE.project.md` line at the bottom
  of `CLAUDE.md`. Use for Claude-specific orientation overrides.

`Pull-SDLC.ai.ps1` performs the template-to-bare-name copy automatically
on first sync. You only need to fill in the sections.

## Why the strict separation?

Multiple projects pull these instructions and may sync updates concurrently.
Project-specific content in upstream files would be overwritten on the next
sync or would contaminate other projects. Keeping the two tiers disjoint means:

- Updates to shared workflow rules flow downstream cleanly.
- Project-specific knowledge is preserved across syncs.
- The `validate-instructions.yml` leak-scanner can statically guarantee no
  consumer-specific names slip into upstream files.

If you discover an improvement to the shared workflow while working in a
consumer project, either:

1. Come back to this repo, make the change here, then pull the update into
   your project; or
2. Cherry-pick the instruction-only commit from your project into this repo
   (verify no project-specific content comes along).

## File Inventory

| File | Purpose |
|---|---|
| `CLAUDE.md` | Root orientation for Claude Code; ends with `@CLAUDE.project.md` import |
| `CLAUDE.project.md.template` | Template for consumer's Claude orientation file |
| `.github/copilot-instructions.md` | Primary Copilot workspace instructions |
| `.github/agents/*.agent.md` | Specialized agent definitions (dev loop, plan, code review, etc.) |
| `.github/instructions/*.instructions.md` | Language/practice-specific instructions (generic) |
| `.github/instructions/project.instructions.md.template` | Template for consumer's project instructions |
| `.github/skills/*/SKILL.md` | Reusable process skills (TDD, refactor, debugging, security review, etc.) |
| `.github/workflows/copilot-setup-steps.yml` | GitHub Actions setup for Copilot coding agent |
| `.github/workflows/validate-instructions.yml` | CI: leak-scanner + structural checks for instruction files |
| `.claude/settings.json` | Claude Code permission settings |
| `.claude/hooks/session-start.sh` | Claude Code session initialization |
| `Pull-SDLC.ai.ps1` | Sync this repo into a consumer project; scaffolds templates on first run |
| `run.ps1` / `run.Tests.ps1` | Project-agnostic .NET runner (used by both this repo and consumers) |
