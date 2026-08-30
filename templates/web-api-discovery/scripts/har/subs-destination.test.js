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
const { execFileSync, spawnSync } = require('child_process');

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

// --- 8. An inherited GIT_DIR / GIT_WORK_TREE cannot answer for another repo. ---
{
    // Demonstrated false pass: with both variables exported, git answers about
    // the repository they name rather than the one containing the destination.
    // Point GIT_WORK_TREE at an unprotected tree and put the ignore rule in the
    // *other* repo's info/exclude, and `check-ignore` returns 0 -- "ignored" --
    // for a path nothing protects. The tables would have been written there.
    //
    // A question about the wrong repository is worse than no answer, because it
    // is a confident one, so the probes run with those variables stripped.
    const holder = makeRepo('env-holder', '');
    fs.appendFileSync(path.join(holder, '.git', 'info', 'exclude'),
        '\n.substitutions.json\n', 'utf8');

    const unprotected = makeDir('env-unprotected');
    const target = path.join(unprotected, 'har-captures', 'h', 's', '.substitutions.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const hostile = Object.assign({}, process.env, {
        GIT_DIR: path.join(holder, '.git'),
        GIT_WORK_TREE: unprotected,
    });
    const leaked = spawnSync('git', ['check-ignore', '-q', '--', target],
        { cwd: path.dirname(target), env: hostile, encoding: 'utf8', stdio: 'ignore' });
    assert.strictEqual(leaked.status, 0,
        '8.a: fixture precondition -- a leaked env must make raw git answer "ignored" here');

    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(holder, '.git');
    process.env.GIT_WORK_TREE = unprotected;
    try {
        assert.strictEqual(classifyDestination(target), OUTSIDE_WORK_TREE,
            '8.b: an inherited GIT_DIR/GIT_WORK_TREE answered for a different repository');
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

// --- 9. Inherited git config injection cannot manufacture an "ignored". ---
{
    // The second vector, and the reason the fix strips the whole GIT_ namespace
    // rather than the names known to be dangerous: GIT_CONFIG_COUNT with a
    // KEY/VALUE pair sets core.excludesFile for the child process alone, so a
    // repository whose real .gitignore does not cover the destination reports
    // it ignored anyway.
    //
    // That "ignored" is a claim about nothing -- config bound to this
    // subprocess does not bind the operator's later `git add`, which is what
    // the answer is supposed to predict.
    const repo = makeRepo('cfg-injection', '# nothing relevant\n');
    const target = path.join(repo, '.har-captures', 'h', 's', '.substitutions.json');
    const excludes = path.join(tmp, 'evil-excludes');
    fs.writeFileSync(excludes, '*\n', 'utf8');

    const inject = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.excludesFile',
        GIT_CONFIG_VALUE_0: excludes,
    };
    const leaked = spawnSync('git', ['check-ignore', '-q', '--', target], {
        cwd: repo, env: Object.assign({}, process.env, inject), stdio: 'ignore',
    });
    assert.strictEqual(leaked.status, 0,
        '9.a: fixture precondition -- injected config must make raw git answer "ignored" here');

    const saved = {};
    for (const k of Object.keys(inject)) saved[k] = process.env[k];
    Object.assign(process.env, inject);
    try {
        assert.strictEqual(classifyDestination(target), NOT_IGNORED,
            '9.b: inherited git config injection manufactured an "ignored" verdict');
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

// --- 10. A poisoned home directory cannot manufacture an "ignored" either. ---
{
    // The third vector, and the one that refuted the reasoning for keeping
    // these: global config is persistent, so it was argued that unlike a
    // per-invocation GIT_CONFIG_* it binds the operator's later `git add` too,
    // making its answer true rather than forged. What is persistent is the
    // config FILE; the path to it is named by an environment variable, and
    // `HOME=<somewhere> node sanitize-har.js` scopes that to one invocation
    // just as cheaply.
    //
    // Each variable below was confirmed to produce a false "ignored" before
    // the strip. HOMEDRIVE/HOMEPATH only bite when HOME is unset -- which is
    // the normal state of a Windows process -- so testing HOME alone would
    // have missed them.
    const evil = path.join(tmp, 'poison-excludes');
    fs.writeFileSync(evil, '*\n', 'utf8');
    const cfg = '[core]\n\texcludesFile = ' + evil.replace(/\\/g, '/') + '\n';

    const fakeHome = makeDir('poison-home');
    fs.writeFileSync(path.join(fakeHome, '.gitconfig'), cfg, 'utf8');
    const fakeXdg = makeDir('poison-xdg');
    fs.mkdirSync(path.join(fakeXdg, 'git'), { recursive: true });
    fs.writeFileSync(path.join(fakeXdg, 'git', 'config'), cfg, 'utf8');

    const repo = makeRepo('home-poisoned', '# nothing relevant\n');
    const target = path.join(repo, '.har-captures', 'h', 's', '.substitutions.json');

    const vectors = [
        { HOME: fakeHome },
        { XDG_CONFIG_HOME: fakeXdg },
        { HOME: undefined, HOMEDRIVE: fakeHome.slice(0, 2), HOMEPATH: fakeHome.slice(2) },
        { HOME: undefined, USERPROFILE: fakeHome },
    ];

    for (const vector of vectors) {
        const saved = {};
        for (const k of Object.keys(vector)) saved[k] = process.env[k];
        for (const [k, v] of Object.entries(vector)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        try {
            assert.strictEqual(classifyDestination(target), NOT_IGNORED,
                '10.a: a poisoned home (' + Object.keys(vector).join('+') +
                ') manufactured an "ignored" verdict');
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All subs-destination tests passed');
