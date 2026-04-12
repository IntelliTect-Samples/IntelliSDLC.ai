# IntelliAIInstructions

Generic AI agentic coding instructions for C#/.NET projects on GitHub. These files
configure Copilot, Claude Code, Codex, and other AI coding assistants with a
consistent development workflow (TDD, code review, dev loop orchestration, etc.).

## Usage

Copy these instruction files into your project repository. The files are designed
to be **project-agnostic** — they work for any C#/.NET project without modification.

## ⚠️ No Project-Specific Content

**These instruction files must never contain project-specific information.**

Project-specific content includes:

- Project names, solution file names, or namespace names
- Architecture details (e.g., "this is an Azure Function" or "this is a CLI app")
- Domain concepts (e.g., "email processing", "payment gateway")
- Specific external dependencies or API references
- Hardcoded file paths from a particular project
- Repository owner/org names or URLs

This rule exists because multiple projects reference these instructions and may
pull updates. Project-specific content would be overwritten or would contaminate
other projects.

### Where Does Project-Specific Content Go?

Project-specific instructions belong in the **consuming project's own files**,
not in these shared instruction files. Recommended locations:

| Content Type | Where to Put It |
|---|---|
| Project architecture, tech stack, domain context | `CLAUDE.md` in your project (add project-specific sections below the generic ones) |
| Project-specific coding rules or conventions | `.github/instructions/project.instructions.md` in your project |
| Feature plans and implementation checklists | GitHub Issues (created by the `@plan` agent) |
| Product requirements and specifications | `product-spec.md` or similar in your project |
| Project-specific CI/CD configuration | `.github/workflows/` in your project |

When your project copies these instructions, it can extend `CLAUDE.md` and add a
`project.instructions.md` file. Those files are owned by the project and won't be
overwritten when pulling instruction updates.

## File Inventory

| File | Purpose |
|---|---|
| `CLAUDE.md` | Root orientation for Claude Code |
| `.github/copilot-instructions.md` | Primary Copilot workspace instructions |
| `.github/agents/*.agent.md` | Specialized agent definitions (dev loop, TDD, refactor, etc.) |
| `.github/instructions/*.instructions.md` | Language/practice-specific instructions |
| `.github/workflows/copilot-setup-steps.yml` | GitHub Actions setup for Copilot coding agent |
| `.claude/settings.json` | Claude Code permission settings |
| `.claude/hooks/session-start.sh` | Claude Code session initialization |
