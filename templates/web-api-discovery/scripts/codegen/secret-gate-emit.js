// scripts/codegen/secret-gate-emit.js -- emits the gitleaks pre-commit hook,
// .gitleaks.toml ruleset, and secret-scan + ci GitHub Actions workflows
// into a generated wrapper project (issue #52). Pure-Node stdlib, deterministic.
//
// Output layout under <outDir>:
//   .githooks/pre-commit
//   .gitleaks.toml
//   .github/workflows/secret-scan.yml
//   .github/workflows/ci.yml
//
// The templates are token-free policy artifacts -- the manifest lists them with
// requiredTokens: [] so the standard manifest-parity test still applies.

'use strict';

const fs = require('fs');
const path = require('path');

function substitute(body, tokens) {
    return body.replace(/\{\{(\w+)\}\}/g, (m, k) => tokens[k] !== undefined ? tokens[k] : m);
}

function emitSecretGate(args) {
    const { outDir } = args;
    const tmplDir = path.resolve(__dirname, '..', '..', 'secret-gate');
    if (!fs.existsSync(tmplDir)) return;

    const manifestPath = path.join(tmplDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const tokens = {}; // token-free; reserved for future per-project values.

    // Templates sorted by manifest declaration order for deterministic emission.
    for (const entry of manifest.templates) {
        const src = path.join(tmplDir, entry.file);
        if (!fs.existsSync(src)) continue;
        const body = fs.readFileSync(src, 'utf8');
        const subbed = substitute(body, tokens);
        // Strip ".tmpl" and preserve the source-relative subdirectory.
        const rel = entry.file.replace(/\.tmpl$/, '');
        const destPath = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, subbed);
        // Mark git hooks executable. On Linux / macOS / WSL, Git silently
        // skips non-executable hook files, so without this the gate would
        // appear installed but be a no-op after `git config core.hooksPath`.
        // (Windows fs.chmod is a no-op for the executable bit; harmless.)
        if (rel.startsWith('.githooks/') || rel.startsWith('.githooks\\')) {
            try { fs.chmodSync(destPath, 0o755); } catch (_) { /* best-effort */ }
        }
    }
}

function secretGateReadmeSection() {
    return [
        '## Secret Scanning',
        '',
        'Every commit is scanned for secrets with [gitleaks](https://github.com/gitleaks/gitleaks) -- both locally (pre-commit hook) and in CI (`.github/workflows/secret-scan.yml`). Rules and allowlists live in `.gitleaks.toml`.',
        '',
        '### Install gitleaks',
        '',
        '- macOS: `brew install gitleaks`',
        '- Linux: `curl -sSfL https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks`',
        '- Windows: `scoop install gitleaks` or `choco install gitleaks`',
        '- Any OS: `go install github.com/gitleaks/gitleaks/v8@latest`',
        '',
        '### Activate the pre-commit hook',
        '',
        'After `git init` (or fresh clone), run once:',
        '',
        '```bash',
        'git config core.hooksPath .githooks',
        '```',
        '',
        '### Adding a new allowlist entry',
        '',
        'When you add a new deterministic test fixture, append a narrow path glob to the `[allowlist]` section of `.gitleaks.toml`. Keep entries scoped to specific paths (e.g. `tests/fixtures/MyFeature/.*\\.json$`); a blanket `**/*.json` would defeat the gate.',
        '',
        '### If a real secret was committed',
        '',
        '1. **Rotate the credential immediately** at the source (provider console).',
        '2. Remove the secret from the file and amend or revert the commit.',
        '3. Purge it from history with `git filter-repo` or BFG, then force-push.',
        '4. Audit logs at the provider to confirm no unauthorized use.',
        '5. Do NOT rely on rewriting history alone -- assume the secret is compromised.',
        '',
    ].join('\n');
}

module.exports = { emitSecretGate, secretGateReadmeSection };