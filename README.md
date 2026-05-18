# IntelliSDLC.ai

Generic AI agentic coding instructions for C#/.NET projects on GitHub. These files
configure Copilot, Claude Code, Codex, and other AI coding assistants with a
consistent development workflow (TDD, code review, dev loop orchestration, etc.).

## Usage

Two ways to consume these instructions in your project:

- **Initial copy:** clone or download this repo and copy the files into your project.
- **Ongoing sync:** use `Pull-SDLC.ai.ps1` -- it adds this repo as a git remote
  named `instructions` and merges updates. See `Pull-SDLC.ai.ps1 -?` for details.

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
