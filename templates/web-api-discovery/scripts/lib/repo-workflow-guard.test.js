#!/usr/bin/env node
// Behavior tests for repo-workflow-guard.js -- the pre-capture placement guard
// (issue #300).
//
// Zero-dep, runs with `node repo-workflow-guard.test.js`. Exits non-zero when
// anything fails.
//
// These build REAL git repositories in a temp directory rather than stubbing
// `git`. The whole subject under test is what three git probes report about a
// checkout, so a stub would pin our belief about git's output instead of git's
// actual output -- which is the very class of mistake that let the defect
// through.
//
// The controlling rules, each tied to something the issue names:
//
//  - Outside a repo the cwd default is CORRECT. The guard must be inert there,
//    not merely quiet.
//  - A worktree is the sanctioned place to work, so it never warns.
//  - The protected branch is DISCOVERED from origin/HEAD, never hardcoded.
//  - A repo that does not declare a no-work-on-main rule is not this tool's
//    business, and warning there would train operators to ignore the warning.

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require(path.join(__dirname, 'repo-workflow-guard.js'));

// .native, not plain realpathSync: on Windows os.tmpdir() is frequently the
// 8.3 short form (MARKMI~1) and only the native call expands it. git always
// reports the long form, so without this every path comparison below would fail
// on a difference that has nothing to do with the code under test.
const tmpRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'repo-guard-test-')));
let failures = 0;
let ran = 0;

function test(name, fn) {
    ran++;
    try {
        fn();
    } catch (err) {
        failures++;
        process.stderr.write('FAIL  ' + name + '\n      ' + (err && err.message) + '\n');
    }
}

function git(cwd, ...args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

// A bare origin plus a clone of it. The clone is what gives us a real
// refs/remotes/origin/HEAD -- setting one by hand would be us asserting our own
// fixture rather than the shape git actually produces.
function makeOrigin(name, opts) {
    const seed = path.join(tmpRoot, name + '-seed');
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '--initial-branch', opts.defaultBranch || 'main');
    git(seed, 'config', 'user.email', 't@example.com');
    git(seed, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
    if (opts.trackedHooks) {
        fs.mkdirSync(path.join(seed, '.githooks'), { recursive: true });
        fs.writeFileSync(
            path.join(seed, '.githooks', 'pre-commit'),
            '#!/bin/sh\n# blocks commits on the protected branch\nexit 0\n');
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '-m', 'seed');

    const bare = path.join(tmpRoot, name + '.git');
    git(tmpRoot, 'clone', '--bare', seed, bare);
    return bare;
}

function makeCheckout(name, opts) {
    opts = opts || {};
    const bare = makeOrigin(name, opts);
    const work = path.join(tmpRoot, name);
    git(tmpRoot, 'clone', bare, work);
    git(work, 'config', 'user.email', 't@example.com');
    git(work, 'config', 'user.name', 'Test');
    if (opts.hooksPath) { git(work, 'config', 'core.hooksPath', opts.hooksPath); }
    if (opts.declare !== undefined) {
        git(work, 'config', 'sdlc.protectedBranchWorkflow', String(opts.declare));
    }
    return work;
}

// ---------------------------------------------------------------------------
// Outside a repo -- the default is already correct and must not change
// ---------------------------------------------------------------------------

test('outside a repo: not inside a repo, and nothing to warn about', () => {
    const dir = path.join(tmpRoot, 'not-a-repo');
    fs.mkdirSync(dir, { recursive: true });
    const info = guard.inspectCheckout(dir);
    assert.strictEqual(info.insideRepo, false);
    assert.strictEqual(info.shouldWarn, false);
    assert.strictEqual(info.topLevel, null);
});

test('outside a repo: the default output root is the working directory', () => {
    const dir = path.join(tmpRoot, 'not-a-repo-2');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(guard.resolveDefaultOutputRoot(dir), path.resolve(dir));
});

// ---------------------------------------------------------------------------
// Primary checkout on the protected branch -- the defect
// ---------------------------------------------------------------------------

test('primary checkout on the protected branch with tracked hooks: warns', () => {
    const work = makeCheckout('declared', { trackedHooks: true, hooksPath: '.githooks' });
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.insideRepo, true, 'insideRepo');
    assert.strictEqual(info.primaryCheckout, true, 'primaryCheckout');
    assert.strictEqual(info.currentBranch, 'main', 'currentBranch');
    assert.strictEqual(info.protectedBranch, 'main', 'protectedBranch');
    assert.strictEqual(info.declaresRule, true, 'declaresRule');
    assert.strictEqual(info.ruleSource, 'hooksPath', 'ruleSource');
    assert.strictEqual(info.shouldWarn, true, 'shouldWarn');
});

test('the protected branch is discovered from origin/HEAD, not hardcoded', () => {
    const work = makeCheckout('trunk-named', {
        trackedHooks: true, hooksPath: '.githooks', defaultBranch: 'trunk'
    });
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.protectedBranch, 'trunk');
    assert.strictEqual(info.currentBranch, 'trunk');
    assert.strictEqual(info.shouldWarn, true);
});

test('a feature branch in the primary checkout does not warn', () => {
    const work = makeCheckout('feature-in-primary', {
        trackedHooks: true, hooksPath: '.githooks'
    });
    git(work, 'checkout', '-b', 'feat/x');
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.primaryCheckout, true);
    assert.strictEqual(info.shouldWarn, false);
});

// ---------------------------------------------------------------------------
// Worktrees -- the sanctioned place, never warned about
// ---------------------------------------------------------------------------

test('a worktree is not a primary checkout and never warns', () => {
    const work = makeCheckout('has-worktree', {
        trackedHooks: true, hooksPath: '.githooks'
    });
    const wt = path.join(tmpRoot, 'has-worktree-wt');
    git(work, 'worktree', 'add', wt, '-b', 'feat/y');
    const info = guard.inspectCheckout(wt);
    assert.strictEqual(info.insideRepo, true);
    assert.strictEqual(info.primaryCheckout, false, 'a worktree must not read as primary');
    assert.strictEqual(info.shouldWarn, false);
});

test('a worktree sitting at the protected branch commit still does not warn', () => {
    const work = makeCheckout('wt-on-main', { trackedHooks: true, hooksPath: '.githooks' });
    const wt = path.join(tmpRoot, 'wt-on-main-wt');
    git(work, 'worktree', 'add', '--detach', wt);
    const info = guard.inspectCheckout(wt);
    assert.strictEqual(info.primaryCheckout, false);
    assert.strictEqual(info.shouldWarn, false);
});

// ---------------------------------------------------------------------------
// Rule declaration -- and its explicit override
// ---------------------------------------------------------------------------

test('a repo with no hooksPath and no declaration does not warn', () => {
    const work = makeCheckout('undeclared', {});
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.primaryCheckout, true);
    assert.strictEqual(info.currentBranch, info.protectedBranch);
    assert.strictEqual(info.declaresRule, false);
    assert.strictEqual(info.ruleSource, null);
    assert.strictEqual(info.shouldWarn, false);
});

test('hooksPath pointing at an UNTRACKED hooks dir does not declare the rule', () => {
    // A local-only hooks directory is one developer's preference, not the
    // repository's convention, so it cannot speak for the repository.
    const work = makeCheckout('untracked-hooks', { hooksPath: '.localhooks' });
    fs.mkdirSync(path.join(work, '.localhooks'), { recursive: true });
    fs.writeFileSync(path.join(work, '.localhooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.declaresRule, false);
    assert.strictEqual(info.shouldWarn, false);
});

test('hooksPath at a tracked dir with no pre-commit does not declare the rule', () => {
    const work = makeCheckout('no-precommit', { hooksPath: '.githooks' });
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.declaresRule, false);
    assert.strictEqual(info.shouldWarn, false);
});

test('an explicit true declaration stands in for hooks', () => {
    const work = makeCheckout('declared-by-config', { declare: true });
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.declaresRule, true);
    assert.strictEqual(info.ruleSource, 'config');
    assert.strictEqual(info.shouldWarn, true);
});

test('an explicit false declaration overrides tracked hooks', () => {
    const work = makeCheckout('opted-out', {
        trackedHooks: true, hooksPath: '.githooks', declare: false
    });
    const info = guard.inspectCheckout(work);
    assert.strictEqual(info.declaresRule, false);
    assert.strictEqual(info.shouldWarn, false);
});

// ---------------------------------------------------------------------------
// Anchoring -- the default only
// ---------------------------------------------------------------------------

test('inside a repo the default output root is the toplevel, not the cwd', () => {
    const work = makeCheckout('anchoring', { trackedHooks: true, hooksPath: '.githooks' });
    const nested = path.join(work, 'docs', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(
        fs.realpathSync(guard.resolveDefaultOutputRoot(nested)),
        fs.realpathSync(work));
});

test('inside a worktree the default anchors to the worktree, not the primary', () => {
    const work = makeCheckout('wt-anchor', { trackedHooks: true, hooksPath: '.githooks' });
    const wt = path.join(tmpRoot, 'wt-anchor-wt');
    git(work, 'worktree', 'add', wt, '-b', 'feat/z');
    const nested = path.join(wt, 'docs');
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(
        fs.realpathSync(guard.resolveDefaultOutputRoot(nested)),
        fs.realpathSync(wt));
});

// ---------------------------------------------------------------------------
// The message -- what an operator has to be told in order to act
// ---------------------------------------------------------------------------

test('the warning names the detection, the cost, the fix and that it proceeds', () => {
    const work = makeCheckout('message', { trackedHooks: true, hooksPath: '.githooks' });
    const info = guard.inspectCheckout(work);
    const msg = guard.guardMessage(info);

    assert.ok(/\bmain\b/.test(msg), 'names the protected branch it detected');
    assert.ok(/git worktree add/.test(msg), 'gives the exact worktree command');
    assert.ok(/commit/i.test(msg), 'says why it matters -- commits are blocked there');
    assert.ok(/continu|proceed/i.test(msg), 'says the recording continues if ignored');
});

test('the closing notice names the real paths written and one relocate command', () => {
    const work = makeCheckout('closing', { trackedHooks: true, hooksPath: '.githooks' });
    const info = guard.inspectCheckout(work);
    const written = [path.join(work, 'app.example.com')];
    const notice = guard.relocationNotice(info, written);

    assert.ok(notice.includes('app.example.com'), 'names the path actually written');
    assert.ok(/git worktree add/.test(notice), 'gives the worktree command');
    assert.ok(/(^|\s)mv\s|Move-Item/.test(notice), 'reduces cleanup to a single move');
});

test('there is no closing notice when the guard did not fire', () => {
    const work = makeCheckout('closing-quiet', {});
    const info = guard.inspectCheckout(work);
    assert.strictEqual(guard.relocationNotice(info, [path.join(work, 'x')]), null);
});

// ---------------------------------------------------------------------------

if (failures) {
    process.stderr.write('\n' + failures + ' of ' + ran + ' repo-workflow-guard tests FAILED\n');
    process.exitCode = 1;
} else {
    process.stdout.write('All repo-workflow-guard tests passed (' + ran + ')\n');
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
