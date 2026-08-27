#!/usr/bin/env node
/**
 * Behavior test for issue #90.a: generated README must contain a
 * mobile-app coverage section that points at templates/api-wrapper-
 * scaffold/scripts/codegen/import-mobile-app.js, so a project user knows how to
 * add mobile traffic to an already-scaffolded wrapper.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const RUN_AGENT = path.join(SCRIPTS_DIR, 'run-agent.js');
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..', '..', '..', '..');
const FIXTURE_HAR = path.join(REPO_ROOT, '.github', 'agents', 'tests', 'fixtures', 'har', 'e2e-rest.har');

function scaffold() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-mobile-test-'));
    fs.rmSync(out, { recursive: true, force: true });
    // The pipeline reads its salt and literal -> sentinel map from the
    // operator's gitignored `.har-profile.json` (issue #255) and refuses to
    // run without one, so a test project has to declare its own.
    fs.mkdirSync(out, { recursive: true });
    const profile = path.join(out, '.har-profile.json');
    fs.writeFileSync(profile, JSON.stringify({ salt: 'readme-mobile-test', literals: {} }, null, 2));
    execFileSync('node', [
        RUN_AGENT,
        '--har', FIXTURE_HAR,
        '--out', out,
        '--profile', profile,
        '--project', 'SampleEx',
        '--namespace', 'SampleEx',
        '--base-url', 'https://sample.invalid',
        '--no-sdlc'
    ], { stdio: 'pipe' });
    return out;
}

const out = scaffold();
const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');

// 1. Section heading is present.
assert.match(
    readme,
    /^##\s+Adding mobile-app coverage\b/m,
    'README must contain a "## Adding mobile-app coverage" section'
);

// 2. Section references the canonical import script.
assert.match(
    readme,
    /import-mobile-app\.js/,
    'README must reference import-mobile-app.js'
);

// 3. Section advertises both proxy and decompile capture modes.
assert.match(readme, /--mode=proxy|proxy capture|mitmproxy|Charles/i,
    'README must mention proxy capture');
assert.match(readme, /--mode=decompile|decompile|jadx|class-dump/i,
    'README must mention decompile capture');

// 4. Section mentions both supported platforms.
assert.match(readme, /\bios\b/i, 'README must mention iOS');
assert.match(readme, /\bandroid\b/i, 'README must mention Android');

// 5. Section warns about the legal constraint on decompilation.
assert.match(
    readme,
    /terms of service|legally permitted|permitted to inspect/i,
    'README must surface the legal/ToS warning for decompilation'
);

console.log('All readme-mobile-import-section tests passed (5/5).');
