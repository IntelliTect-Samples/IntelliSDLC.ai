#!/usr/bin/env node
// Behavior tests for classifying a substitution-table destination (issue #318).
//
// #294 moved the substitution tables out of the committable output path and
// into a `.har-captures/` directory. That proved the destination was *named*
// `.har-captures`; it proved nothing about the destination being gitignored,
// which is the property #294 actually needs. This module answers the property
// question, and these tests pin the four answers it can give.
//
// No fixture here contains a credential; the tests assert on classification
// and message text only.
//
// Zero-dep, runs with `node subs-destination.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
    classifyDestination,
    refusalMessage,
    IGNORED,
    NOT_IGNORED,
    OUTSIDE_WORK_TREE,
    UNVERIFIABLE,
} = require(path.join(__dirname, 'subs-destination.js'));

// realpath because os.tmpdir() can hand back an 8.3 short path on Windows,
// which git resolves differently than node does. Comparing a short path
// against git's long-path answer is a test bug, not a behavior.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subs-dest-')));

function makeDir(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function makeRepo(name, gitignore) {
    const dir = makeDir(name);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    if (gitignore !== undefined) {
        fs.writeFileSync(path.join(dir, '.gitignore'), gitignore, 'utf8');
    }
    return dir;
}

// --- 1. A path an entry covers is ignored. ---
{
    const repo = makeRepo('covered', '.har-captures/\n');
    const target = path.join(repo, '.har-captures', 'host', 'session', '.substitutions.json');
    assert.strictEqual(classifyDestination(target), IGNORED,
        '1.a: a path under an ignored directory did not classify as ignored');
}

// --- 2. The property is the entry, not the directory name. ---
{
    // The near-miss spelling from the issue: `har-captures`, no leading dot.
    // The scaffold's .gitignore ignores the table FILENAMES at any depth, so
    // this destination genuinely is protected and must be accepted on that
    // basis -- the point of checking the property instead of the name.
    const repo = makeRepo('near-miss-but-covered', '.substitutions.json\n.har-substitutions.json\n');
    const target = path.join(repo, 'har-captures', 'host', 'session', '.substitutions.json');
    assert.strictEqual(classifyDestination(target), IGNORED,
        '2.a: a covered filename under a near-miss directory name was not accepted');
}

// --- 3. Inside a repo with nothing covering it. ---
{
    const repo = makeRepo('uncovered', '# nothing relevant\n');
    const target = path.join(repo, '.har-captures', 'host', 'session', '.substitutions.json');
    assert.strictEqual(classifyDestination(target), NOT_IGNORED,
        '3.a: an unignored path inside a work tree did not classify as not-ignored');
}

// --- 4. A directory named .har-captures proves nothing on its own. ---
{
    // This is the #318 defect stated as a classification: the name matches,
    // the property does not hold.
    const repo = makeRepo('name-only', '');
    const target = path.join(repo, '.har-captures', 'host', 'session', '.substitutions.json');
    assert.strictEqual(classifyDestination(target), NOT_IGNORED,
        '4.a: the .har-captures name alone was treated as protection');
}

// --- 5. No git work tree above the path at all. ---
{
    const bare = makeDir('no-repo');
    const target = path.join(bare, 'har-captures', 'host', 'session', '.substitutions.json');
    assert.strictEqual(classifyDestination(target), OUTSIDE_WORK_TREE,
        '5.a: a path outside any work tree did not classify as outside-work-tree');
}

// --- 6. The destination directory does not exist yet. ---
{
    // The scrub creates the tables' directory itself, so classification runs
    // against a path whose parents are still missing. Probing from the
    // nearest EXISTING ancestor is what makes that work; a naive cwd would
    // throw ENOENT and the gate would misreport.
    const repo = makeRepo('deep-missing', '.har-captures/\n');
    const target = path.join(repo, '.har-captures', 'a', 'b', 'c', 'd', '.substitutions.json');
    assert.ok(!fs.existsSync(path.dirname(target)), '6.a: fixture precondition -- parent must not exist');
    assert.strictEqual(classifyDestination(target), IGNORED,
        '6.b: a not-yet-created destination was not classified');

    const bare = makeDir('deep-missing-no-repo');
    const outside = path.join(bare, 'x', 'y', 'z', '.substitutions.json');
    assert.strictEqual(classifyDestination(outside), OUTSIDE_WORK_TREE,
        '6.c: a not-yet-created destination outside a work tree was not classified');
}

// --- 7. Every non-ignored status produces an actionable refusal. ---
{
    const target = path.join(tmp, 'anywhere', '.substitutions.json');

    assert.strictEqual(refusalMessage(target, IGNORED, '--pii-subs'), null,
        '7.a: an ignored destination produced a refusal');

    for (const status of [NOT_IGNORED, OUTSIDE_WORK_TREE, UNVERIFIABLE]) {
        const msg = refusalMessage(target, status, '--pii-subs');
        assert.ok(typeof msg === 'string' && msg.length > 0,
            `7.b: ${status} produced no refusal message`);
        assert.ok(msg.includes(target),
            `7.c: the ${status} refusal does not name the path it refused:\n${msg}`);
        assert.ok(msg.includes('--pii-subs'),
            `7.d: the ${status} refusal does not name the flag that overrides it:\n${msg}`);
    }

    // The remedy differs by status, and saying the wrong one wastes the
    // operator's time: a missing .gitignore entry and a missing repository
    // are not fixed the same way.
    assert.ok(/\.gitignore/.test(refusalMessage(target, NOT_IGNORED, '--subs')),
        '7.e: the not-ignored refusal does not mention .gitignore');
    assert.ok(/git/.test(refusalMessage(target, OUTSIDE_WORK_TREE, '--subs')),
        '7.f: the outside-work-tree refusal does not mention git');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All subs-destination tests passed');
