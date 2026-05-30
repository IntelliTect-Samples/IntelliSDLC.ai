# IntelliSDLC.ai

Generic AI agentic coding instructions for C#/.NET projects on GitHub. These files
configure Copilot, Claude Code, Codex, and other AI coding assistants with a
consistent development workflow (TDD, code review, dev loop orchestration, etc.).

## Onboarding

Pick the recipe that matches your starting state. All three end at the same
place: an `sdlc.ai` git remote pointing at this repo, all upstream-managed
files in place, consumer-owned templates scaffolded with bare names, and a
`chore(sdlc): sync` commit recording the anchor for future incremental syncs.

### A. Existing repo (already has files, history, and `origin`)

The most common case. From the repo root:

```powershell
iwr https://raw.githubusercontent.com/IntelliTect-Samples/IntelliSDLC.ai/main/Pull-SDLC.ai.ps1 -OutFile Pull-SDLC.ai.ps1
./Pull-SDLC.ai.ps1
```

The script auto-detects the from-zero state (no `.sdlc-ai-sync.json`, no
prior `chore(sdlc): sync` commit, no upstream-managed files) and proceeds
without prompting. **First-time sync commits directly on the current
branch** -- tooling onboarding is not a reviewable change. **Subsequent
syncs** detect the prior state file and route through an auto-worktree
(`.worktrees/sdlc-sync`) + PR for review. Pass `-CommitOnMain` to force
direct-on-`main` even on a steady-state sync, or `-CommitOnMain:$false`
to force the auto-worktree path on the first sync.

What the script does:

- Adds an `sdlc.ai` git remote pointing at this repo and fetches `main`.
- Lays down all upstream-managed files (`CLAUDE.md`,
  `.github/copilot-instructions.md`, `.github/agents/*`, `.github/skills/*`,
  generic `.github/instructions/*`, `.claude/*`).
- Scaffolds consumer-owned files **only if missing** (`CLAUDE.project.md`,
  `.github/instructions/project.instructions.md`, `.gitattributes`) from
  their `*.template` counterparts. Existing copies are never overwritten.
- Extends `.gitignore` with required entries; never replaces it.
- Lands a `chore(sdlc): sync` commit and writes `.sdlc-ai-sync.json`
  recording the anchor for future incremental syncs.
- Leaves your `origin` remote untouched.

### B. Brand-new project (no files, no repo, no `origin`)

Create a directory, then run the same one-liner. The script auto-runs
`git init -b main` if it detects no git repository, so you do not need to
initialize git first.

```powershell
mkdir my-new-project; cd my-new-project
iwr https://raw.githubusercontent.com/IntelliTect-Samples/IntelliSDLC.ai/main/Pull-SDLC.ai.ps1 -OutFile Pull-SDLC.ai.ps1
./Pull-SDLC.ai.ps1
gh repo create --source=. --public --push
```

The script detects the bootstrap state (no `.sdlc-ai-sync.json`, no
prior sync commit) and commits the first sync directly on `main`. Once
the project has been synced once, subsequent runs route through the
auto-worktree + PR path automatically.

`-NoAutoInit` disables the auto-`git init` step if you prefer to set up the
repo manually first.

### C. Brand-new project from a fork in another org

If you maintain a fork of this repo in your own org (say `Acme/IntelliSDLC.ai`),
point the sync at it explicitly via `-RemoteUrl`:

```powershell
mkdir my-new-project; cd my-new-project
iwr https://raw.githubusercontent.com/Acme/IntelliSDLC.ai/main/Pull-SDLC.ai.ps1 -OutFile Pull-SDLC.ai.ps1
./Pull-SDLC.ai.ps1 -RemoteUrl https://github.com/Acme/IntelliSDLC.ai.git
```

The default `-RemoteUrl` is the canonical IntelliTect-Samples copy.

## Updating an Onboarded Repo

Once `.sdlc-ai-sync.json` exists, simply re-run the script with no flags:

```powershell
./Pull-SDLC.ai.ps1
```

It pulls upstream changes, replays them as a diff against your recorded
anchor, and lands a new `chore(sdlc): sync` commit. The pre-flight drift
guard refuses to run if any upstream-managed file shows local edits since
the last sync; pass `-Force` to override (and explain why in the commit
message).

## Template Scaffolding

On first sync the script copies these `*.template` files to their bare
names if the bare name is missing:

| Template | Bare name | Purpose |
|---|---|---|
| `.github/instructions/project.instructions.md.template` | `.github/instructions/project.instructions.md` | Project-specific conventions read by all agents |
| `CLAUDE.project.md.template` | `CLAUDE.project.md` | Claude-specific orientation overrides |
| `.gitattributes.template` | `.gitattributes` | Recommended baseline (LF for `*.sh`, CRLF for `*.ps1` / `*.bat`) |
| `tasks/README.md.template` | `tasks/README.md` | Onboarding for the `tasks/` plan directory |

Existing bare-name files are never overwritten. Once placed, all four are
fully consumer-owned -- edit them freely.

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
