# CLAUDE.md — Gmail Synthesizer

This file provides orientation for AI assistants working in this repository.

## Key References

- **Product requirements**: [`product-spec.md`](./product-spec.md) — the single source of truth for what the application does. Update it with every feature change.
- **Development conventions**: [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) — code style, testing conventions, branching strategy, commit format, and agent workflow.
- **TDD guidelines**: [`.github/instructions/tdd.instructions.md`](./.github/instructions/tdd.instructions.md) — mandatory Red→Green→Refactor process.
- **TypeScript/JS conventions**: [`.github/instructions/typescript.instructions.md`](./.github/instructions/typescript.instructions.md)
- **Agent prompts**: [`.github/agents/`](./.github/agents/) — specialized agents for brainstorming, TDD, refactoring, code review, debugging, and orchestration.

## Repository Structure

```
GmailNewsClient/
├── src/
│   ├── GmailSynthesizer/          # Core library (services, models, config)
│   │   ├── Services/              # Business logic & external API wrappers
│   │   ├── Models/                # Domain models & DTOs
│   │   └── Configuration/         # App configuration types
│   └── GmailSynthesizer.Cli/      # CLI entry point and setup utilities
├── tests/
│   └── unit/                      # xUnit unit tests mirroring src structure
├── docs/                          # Additional documentation
├── SampleEmails/                  # Sample EML files for testing
├── product-spec.md                # Living product specification (PRD)
├── GMAIL_SETUP.md                 # Gmail OAuth setup instructions
├── sample-appsettings.json        # Config template
└── .github/
    ├── copilot-instructions.md    # Primary dev conventions (read this first)
    ├── agents/                    # Agent prompt files (.agent.md)
    ├── instructions/              # Language/practice-specific instructions
    └── workflows/                 # GitHub Actions (CI setup steps)
```

> **Note**: The `pwa/` folder exists in the repository but is not part of the current development focus. Ignore it when working on the C# application.

## Technology Stack

| Layer | Technology |
|---|---|
| Language | C# / .NET 9+ |
| Runtime | Azure Functions (timer-triggered) |
| Email API | Gmail API (`Google.Apis.Gmail.v1`) |
| AI | Azure OpenAI (`Azure.AI.OpenAI`, GPT-4o) |
| Email parsing | MimeKit, AngleSharp |
| Testing | xUnit, Moq, FluentAssertions |
| CLI | `GmailSynthesizer.Cli` project |

## Essential Commands

```bash
# Build
dotnet build --no-restore

# Test
dotnet test --no-build --verbosity normal

# Format
dotnet format
```

Always run `dotnet build` and `dotnet test` after every code change. Fix all errors before proceeding.

## Development Workflow

Follow the full dev loop for any feature:

```
Brainstorm → Plan → TDD (Red→Green→Refactor) → Functional Test → Verify → Code Review → Fix → Re-Review
```

Use `@dev-loop` to orchestrate the full cycle. See `.github/copilot-instructions.md` → **Agent Files** for the complete agent reference.

## Branching & Commits

- Never commit to `main` directly — always use a feature branch.
- Branch naming: `<agent-name>/<type>/<short-description>` (e.g., `Sonnet.4.6/feat/digest-template`)
- Commit format: `type(scope): description` (Conventional Commits)
- Merge to `main` only via pull request after the dev loop passes.
- Git worktrees go in `.worktrees/` (already in `.gitignore`).
