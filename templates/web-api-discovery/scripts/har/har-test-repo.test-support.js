'use strict';

/**
 * har-test-repo.test-support.js -- fixture helper: a temp directory the scrub will run in.
 *
 * Since #318 the scrub refuses to write a substitution table to a destination
 * git will not confirm is ignored, which means a bare `fs.mkdtempSync()`
 * directory is no longer a place the scrub runs. Suites whose subject is
 * something else entirely -- literal scrubbing, secret field names, hex
 * sentinels -- need a project that looks like a real consumer's so the scrub
 * gets far enough to exercise what they are actually testing.
 *
 * The entries below are the subset of generate-wrapper.js's
 * SCAFFOLD_GITIGNORE_ENTRIES that protects the tables. It is deliberately not
 * imported from there: these fixtures want a protected repo, not a copy of
 * whatever that list happens to say, and substitution-table-gitignore.test.js
 * is where the real scaffold list is pinned against the operator's experience.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROTECTIVE_GITIGNORE_ENTRIES = [
    '.har-profile.json',
    '.har-substitutions.json',
    '.substitutions.json',
    '.har-captures/',
];

/**
 * Make `dir` a git repository whose .gitignore covers the substitution tables.
 *
 * @param {string} dir created if absent
 * @returns {string} dir, for chaining
 */
function initProtectedRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, '.gitignore'),
        PROTECTIVE_GITIGNORE_ENTRIES.join('\n') + '\n', 'utf8');
    return dir;
}

/**
 * `fs.mkdtempSync` + `initProtectedRepo`, with the realpath that Windows needs.
 *
 * os.tmpdir() can hand back an 8.3 short path, which git resolves differently
 * than node does; comparing one against the other is a fixture bug, not a
 * behavior.
 */
function makeTempRepo(prefix) {
    const os = require('os');
    return initProtectedRepo(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
}

module.exports = { initProtectedRepo, makeTempRepo, PROTECTIVE_GITIGNORE_ENTRIES };
