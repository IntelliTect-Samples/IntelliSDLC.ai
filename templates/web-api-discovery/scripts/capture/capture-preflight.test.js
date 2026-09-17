#!/usr/bin/env node
// Behavior tests for the recorder's dependency preflight and for what it does
// with a capture folder that is not in a repository (issue #512).
//
// Zero-dep, runs with `node capture-preflight.test.js`. Exits non-zero when
// anything fails.
//
// The owner's report is the specification. Starting a brand-new site from an
// empty, non-repo folder, running the recorder out of the upstream checkout:
// the run scaffolded a profile, announced a capture root, and THEN failed on
// the browser dependency with a remedy that could not work. Two defects in one
// transcript, and this file pins both.
//
//  - THE PREFLIGHT COMES FIRST. A missing dependency is the first line, not
//    the last. Nothing is scaffolded, nothing is prompted and no browser is
//    opened before it is satisfied -- because every one of those is work the
//    operator has to undo when the run cannot proceed anyway.
//  - `--validate-only` STAYS dependency-free. It resolves paths and opens
//    nothing, so requiring a browser to run it would break the one command
//    that exists to answer questions without side effects.
//  - A NON-REPO CAPTURE FOLDER IS PROTECTED. The skill's own pipeline runs
//    `git init && git add -A` in that folder later. Without a rule left behind
//    now, that commit takes the salt and the unscrubbed raw captures with it,
//    and nobody is watching when it happens.
//
// The subprocess cases drive the REAL recorder. The ordering claim is about
// what has happened to the filesystem by the time the process exits, and only
// running it can answer that.

'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capture = require(path.join(__dirname, 'capture-har.js'));
const harProfile = require(path.join(__dirname, '..', 'har', 'har-profile.js'));

const captureJs = path.join(__dirname, 'capture-har.js');

/**
 * Does any ancestor of `start` hold a playwright install?
 *
 * Node's upward walk does not stop at a temp directory, and a stray
 * `node_modules` in a home directory is an ordinary thing to find on a
 * developer machine -- this issue was reported from one. A fixture placed
 * underneath such a folder resolves playwright from it, and then every "the
 * module is absent" case below silently tests nothing.
 */
function ancestorHasPlaywright(start) {
    let d = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(d, 'node_modules', 'playwright'))) return true;
        const up = path.dirname(d);
        if (up === d) return false;
        d = up;
    }
}

/**
 * Somewhere to put fixtures that no playwright install sits above.
 *
 * Tried in order of politeness: the system temp directory, then the root of
 * the volume it lives on, then the repository itself. A machine where none of
 * them is usable fails the precondition test loudly rather than running a
 * suite whose absence cases cannot fail.
 */
function cleanRoot() {
    const candidates = [
        os.tmpdir(),
        path.parse(os.tmpdir()).root,
        path.join(__dirname, '..', '..', '..', '..')
    ];
    for (const base of candidates) {
        if (ancestorHasPlaywright(base)) continue;
        try {
            // .native for the same reason repo-workflow-guard.test.js gives: on
            // Windows os.tmpdir() is often the 8.3 short form and git reports
            // the long one.
            return fs.realpathSync.native(
                fs.mkdtempSync(path.join(base, 'capture-preflight-test-')));
        } catch (e) { void e; }
    }
    return null;
}

const tmpRoot = cleanRoot();

const queued = [];
function test(name, fn) { queued.push({ name, fn }); }

let failures = 0;
async function run() {
    let ran = 0;
    for (const { name, fn } of queued) {
        ran++;
        try {
            await fn();
        } catch (e) {
            failures++;
            process.stderr.write('FAIL: ' + name + '\n  ' + e.message + '\n');
            if (e.stack) process.stderr.write(e.stack.split('\n').slice(1, 4).join('\n') + '\n');
        }
    }
    return ran;
}

function dir(...parts) {
    const d = path.join(tmpRoot, ...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

/**
 * A resolvable package standing in for playwright, in the folder the operator
 * is standing in. Not the real one: the assertion is about WHERE the recorder
 * looks, and a real install would make every result depend on what the machine
 * happens to have.
 */
function plantPlaywright(where) {
    const pkg = path.join(where, 'node_modules', 'playwright');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'playwright', version: '0.0.0-fixture', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = { chromium: {} };\n');
    return where;
}

/** A browsers directory Playwright would accept, and one it would not. */
function plantChromium(where) {
    fs.mkdirSync(path.join(where, 'chromium-9999'), { recursive: true });
    return where;
}

/**
 * The child's view of the machine, with every location the resolver consults
 * pointed somewhere this test owns.
 *
 * APPDATA and PLAYWRIGHT_BROWSERS_PATH are npm's and Playwright's OWN
 * variables, not switches invented for testing -- the same reason NODE_PATH is
 * the fourth search location rather than a new one.
 */
function childEnv(over) {
    return Object.assign({}, process.env, {
        APPDATA: dir('machine-empty-appdata'),
        NODE_PATH: '',
        PLAYWRIGHT_BROWSERS_PATH: dir('machine-empty-browsers')
    }, over);
}

function runCapture(cwd, argv, env) {
    const r = spawnSync(process.execPath, [captureJs, ...argv], {
        cwd, encoding: 'utf8', windowsHide: true, env: env || childEnv()
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

// Every in-process preflight case below pins the platform to Windows.
//
// Not because the behaviour is Windows-specific, but because npm's default
// global root is derived DIFFERENTLY per platform -- `%APPDATA%\npm\node_modules`
// on Windows, `<prefix>/lib/node_modules` elsewhere. A fixture that sets
// APPDATA and lets the host platform decide controls the machine default on a
// Windows runner and not on a Linux one, where the REAL global root would be
// searched instead: the assertions would then depend on what the runner
// happens to have installed. Pinning makes one fixture mean the same thing
// everywhere. The per-platform derivation itself is pinned separately, on both
// branches, in node-dependency.test.js.
const WIN = 'win32';

// npm is silenced in every in-process case. The refinement spawns a REAL
// `npm root -g` against the machine running the test, and a box that has ever
// run `npm install -g playwright` would then supply the module to cases whose
// whole point is that nothing supplies it. The refinement has its own case,
// with an injected answer, in this file; the real subprocess is exercised in
// node-dependency.test.js where it is the subject rather than a dependency.
const NO_NPM = () => null;

// The suite's preconditions, asserted rather than assumed. Every "the module
// is absent" case below depends on nothing above the fixtures -- or above the
// recorder itself -- holding a playwright install. On a machine where one
// does, those cases would pass while testing nothing, which is the exact
// failure mode this whole issue is about.
test('PRECONDITION: no playwright install sits above the fixtures', () => {
    assert.ok(tmpRoot,
        'No usable fixture location was found: every candidate has a playwright install ' +
        'above it, or could not be written to. The absence cases cannot be trusted here.');
    assert.ok(!ancestorHasPlaywright(tmpRoot), 'fixture root is clean: ' + tmpRoot);
    assert.ok(!ancestorHasPlaywright(__dirname),
        "the recorder's own directory is clean, so the tool location cannot answer either");

    // And the machine's REAL global root, which the subprocess cases cannot
    // point elsewhere: they spawn the recorder, so they get the host platform's
    // derivation whatever APPDATA says. A globally installed playwright would
    // make "nothing is scaffolded when the dependency is missing" pass by
    // never reaching the branch it names.
    const nodeDep = require(path.join(__dirname, '..', 'lib', 'node-dependency.js'));
    const globalRoot = nodeDep.defaultGlobalRoot({});
    if (globalRoot) {
        assert.ok(!fs.existsSync(path.join(globalRoot, 'playwright')),
            'this machine has no global playwright install (' + globalRoot + '), so the ' +
            'subprocess absence cases reach the branch they name');
    }
});

// ---------------------------------------------------------------------------
// The preflight, in process
// ---------------------------------------------------------------------------

test('the preflight passes when the module and the browser are both there', async () => {
    const cwd = plantPlaywright(dir('pf-ok'));
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd, toolDir: dir('pf-ok-tool'), isTty: false,
        env: { APPDATA: dir('pf-ok-appdata'), PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-ok-browsers')) }
    });
    assert.strictEqual(r.ok, true, r.message);
});

test('a missing module is refused without prompting when there is no terminal', async () => {
    let asked = 0;
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd: dir('pf-nomod'), toolDir: dir('pf-nomod-tool'), isTty: false,
        ask: () => { asked++; return Promise.resolve('y'); },
        env: { APPDATA: dir('pf-nomod-appdata'), PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-nomod-browsers')) }
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(asked, 0, 'an agent or a CI run has nowhere to answer a prompt');
    assert.ok(/npm install -g playwright/.test(r.message), r.message);
});

test('the refusal names every folder it searched', async () => {
    const cwd = dir('pf-named-cwd');
    const toolDir = dir('pf-named-tool');
    const appdata = dir('pf-named-appdata');
    const nodePathDir = dir('pf-named-nodepath');
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd, toolDir, isTty: false,
        // npm silenced, so the location named is the one this test set up.
        // The refinement has its own case below.
        npmGlobalRoot: () => null,
        env: {
            APPDATA: appdata,
            NODE_PATH: nodePathDir,
            PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-named-browsers'))
        }
    });
    assert.strictEqual(r.ok, false);
    for (const d of [cwd, toolDir, path.join(appdata, 'npm', 'node_modules'), nodePathDir]) {
        assert.ok(r.message.includes(d), 'names ' + d + '\n--- message ---\n' + r.message);
    }
});

test('the folder named as the global root is the one npm actually reports', () => {
    // The default location is computed to keep the happy path off a
    // subprocess, and a computed guess can be wrong -- an `npm config set
    // prefix` moves it. On the way OUT, where a second is already being spent
    // on an error, npm is asked and the answer replaces the guess. Naming a
    // folder the operator does not use is how a correct message still sends
    // somebody to the wrong place.
    const guessed = dir('refine-appdata');
    const real = path.join(dir('refine-real'), 'node_modules');
    const r = capture.resolvePlaywright({
        cwd: dir('refine-cwd'), toolDir: dir('refine-tool'),
        env: { APPDATA: guessed }, platform: 'win32',
        npmGlobalRoot: () => real
    });
    assert.strictEqual(r.found, false);
    const global = r.searched.filter((s) => s.key === 'global')[0];
    assert.strictEqual(global.dir, real, 'npm had the last word');
});

test('a present module with a missing browser asks for the browser, not the module', async () => {
    // Two different facts. Telling an operator who already has the module to
    // `npm install` it is advice they will follow, watch succeed, and fail
    // again on the same line.
    const cwd = plantPlaywright(dir('pf-nobrowser'));
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd, toolDir: dir('pf-nobrowser-tool'), isTty: false,
        env: {
            APPDATA: dir('pf-nobrowser-appdata'),
            PLAYWRIGHT_BROWSERS_PATH: dir('pf-nobrowser-browsers')
        }
    });
    assert.strictEqual(r.ok, false);
    assert.ok(/npx playwright install chromium/.test(r.message), r.message);
    assert.ok(!/npm install -g playwright/.test(r.message),
        'the module is present -- do not send them to install it\n' + r.message);
});

test('with a terminal it offers to install, and declining prints the commands', async () => {
    const asked = [];
    let installs = 0;
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd: dir('pf-decline'), toolDir: dir('pf-decline-tool'), isTty: true,
        ask: (q) => { asked.push(q); return Promise.resolve('n'); },
        install: () => { installs++; return { ok: true }; },
        env: {
            APPDATA: dir('pf-decline-appdata'),
            PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-decline-browsers'))
        }
    });
    assert.strictEqual(asked.length, 1, 'asked once');
    assert.strictEqual(installs, 0, 'declining installs nothing');
    assert.strictEqual(r.ok, false);
    assert.ok(/npm install -g playwright/.test(r.message),
        'and they are left with the command to run themselves\n' + r.message);
});

test('accepting runs the install into the machine default, then re-checks', async () => {
    // The owner's ask: "If the default location is missing, we can point it
    // somewhere" -- answered by installing into npm's global root, after which
    // every folder on the machine works.
    const appdata = dir('pf-accept-appdata');
    const commands = [];
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd: dir('pf-accept'), toolDir: dir('pf-accept-tool'), isTty: true,
        ask: () => Promise.resolve('y'),
        install: (cmd, args) => {
            commands.push([cmd].concat(args).join(' '));
            // The install is what makes the module resolvable. Modelled the
            // way a real one would be: it puts the package in npm's global
            // root, and the SAME resolver then has to find it there.
            plantPlaywright(path.join(appdata, 'npm'));
            return { ok: true };
        },
        env: {
            APPDATA: appdata,
            PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-accept-browsers'))
        }
    });
    assert.deepStrictEqual(commands, ['npm install -g playwright']);
    assert.strictEqual(r.ok, true, 'the re-check finds what the install put there: ' + r.message);
});

test('the re-check is a real re-resolution, not a trust of the exit code', async () => {
    // An install that reports success and produces nothing is the case worth
    // catching: believing it hands the operator a browser launch failure
    // several steps later, with no mention of the install that did not work.
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd: dir('pf-liar'), toolDir: dir('pf-liar-tool'), isTty: true,
        ask: () => Promise.resolve('y'),
        install: () => ({ ok: true }),
        env: {
            APPDATA: dir('pf-liar-appdata'),
            PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-liar-browsers'))
        }
    });
    assert.strictEqual(r.ok, false, 'still missing, so still refused');
});

test('an installer that never started is not described as having run', async () => {
    // On Windows, Node refuses to spawn npm's batch shim without a shell and
    // fails before any process exists -- spawnSync reports that in `error`
    // rather than throwing, so it is easy to swallow. "The install ran and it
    // still is not resolvable" then sends the operator to debug an install
    // that never began, which is this issue's own defect in a new place.
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd: dir('pf-nostart'), toolDir: dir('pf-nostart-tool'), isTty: true,
        ask: () => Promise.resolve('y'),
        install: () => ({ ok: false, started: false }),
        env: {
            APPDATA: dir('pf-nostart-appdata'),
            PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-nostart-browsers'))
        }
    });
    assert.strictEqual(r.ok, false);
    assert.ok(/could not be started at all/.test(r.message),
        'says no process was created\n' + r.message);
    assert.ok(!/The install ran/.test(r.message),
        'and does not claim it ran\n' + r.message);
});

test('an installer that ran without producing a module does not blame the install', async () => {
    // The other side of the same distinction -- otherwise the new wording
    // could be produced by always saying "never started", which would be just
    // as misleading in the opposite direction.
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd: dir('pf-ranfailed'), toolDir: dir('pf-ranfailed-tool'), isTty: true,
        ask: () => Promise.resolve('y'),
        install: () => ({ ok: false, started: true }),
        env: {
            APPDATA: dir('pf-ranfailed-appdata'),
            PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('pf-ranfailed-browsers'))
        }
    });
    assert.strictEqual(r.ok, false);
    assert.ok(/did not produce a usable module/.test(r.message), r.message);
    assert.ok(!/could not be started at all/.test(r.message), r.message);
    // On Windows `started` only reports that the INTERPRETER started: npm
    // missing from PATH still exits normally through cmd.exe. So this branch
    // must not claim the install ran -- it cannot know that.
    assert.ok(/not be on PATH/.test(r.message),
        'names the possibility it cannot rule out\n' + r.message);
});

test('accepting also fetches the browser when the browser is what is missing', async () => {
    const browsers = dir('pf-browser-accept-browsers');
    const commands = [];
    const r = await capture.preflightDependencies({
        platform: WIN,
        npmGlobalRoot: NO_NPM,
        cwd: plantPlaywright(dir('pf-browser-accept')), toolDir: dir('pf-browser-accept-tool'),
        isTty: true,
        ask: () => Promise.resolve('y'),
        install: (cmd, args) => {
            commands.push([cmd].concat(args).join(' '));
            plantChromium(browsers);
            return { ok: true };
        },
        env: {
            APPDATA: dir('pf-browser-accept-appdata'),
            PLAYWRIGHT_BROWSERS_PATH: browsers
        }
    });
    assert.deepStrictEqual(commands, ['npx playwright install chromium']);
    assert.strictEqual(r.ok, true, r.message);
});

// ---------------------------------------------------------------------------
// The preflight runs BEFORE anything else -- the real recorder
// ---------------------------------------------------------------------------

test('nothing is scaffolded when the dependency is missing', () => {
    // THE OWNER'S TRANSCRIPT, inverted. There, the run prompted, wrote
    // .har-profile.json, announced a capture root, and only then said the
    // module was missing. Here the module is checked first, so the folder is
    // untouched -- which is the whole difference between a failure you can
    // re-run and one you have to clean up after.
    const cwd = dir('order-empty');
    const r = runCapture(cwd, ['start', '--uri', 'https://example.com',
        '--describe', 'preflight fixture']);

    assert.strictEqual(r.status, 1, r.stderr);
    assert.ok(/playwright/.test(r.stderr), 'it is the dependency that is reported\n' + r.stderr);
    assert.ok(!fs.existsSync(path.join(cwd, harProfile.PROFILE_FILENAME)),
        'no profile was scaffolded');
    assert.ok(!fs.existsSync(path.join(cwd, '.har-captures')),
        'no capture store was created');
    assert.ok(!/Scaffold one here now/.test(r.stderr),
        'and no prompt was reached\n' + r.stderr);
});

test('the recorder finds a playwright installed in the operator folder', () => {
    // The acceptance criterion, driven end to end: run the UPSTREAM recorder
    // from a folder that installed its own copy, and the dependency preflight
    // is satisfied. Proven by the run getting past it to the next gate, which
    // is the operator profile -- a different complaint entirely.
    const cwd = plantPlaywright(dir('operator-install'));
    const r = runCapture(cwd, ['start', '--uri', 'https://example.com',
        '--describe', 'preflight fixture'],
    childEnv({ PLAYWRIGHT_BROWSERS_PATH: plantChromium(dir('operator-install-browsers')) }));

    assert.ok(!/the playwright module was not found/.test(r.stderr),
        'the operator folder answered\n' + r.stderr);
    assert.ok(new RegExp(harProfile.PROFILE_FILENAME.replace('.', '\\.')).test(r.stderr),
        'and the run advanced to the profile gate\n' + r.stderr);
});

test('--validate-only still answers without any browser dependency', () => {
    // It resolves paths and opens nothing. Gating it on a browser install
    // would break the one command that exists to answer questions without
    // side effects -- and several suites use it for exactly that.
    const cwd = dir('validate-only');
    fs.writeFileSync(path.join(cwd, harProfile.PROFILE_FILENAME),
        JSON.stringify({ salt: 'a'.repeat(48), literals: {} }), 'utf8');
    const r = runCapture(cwd, ['start', '--uri', 'https://example.com',
        '--describe', 'preflight fixture', '--port', '0', '--validate-only']);

    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!/the playwright module was not found/.test(r.stderr), r.stderr);
    assert.ok(JSON.parse(r.stdout).sessionDir, 'it still reports the resolved session');
});

// ---------------------------------------------------------------------------
// A capture folder that is not a repository
// ---------------------------------------------------------------------------

test('a non-repo capture folder gets the ignore rules left behind', async () => {
    const root = dir('nonrepo-plain');
    const capturesRoot = path.join(root, '.har-captures');
    const r = await capture.ensureCapturesRootIgnored(
        { root: capturesRoot, currentWorkingTree: null, mainWorkingTree: null },
        { isTty: false });

    assert.strictEqual(r.ok, true, 'there is no repository, so nothing is refused');
    const ignore = path.join(root, '.gitignore');
    assert.ok(fs.existsSync(ignore), 'the rule is written beside the store');
    const text = fs.readFileSync(ignore, 'utf8');
    for (const entry of ['.har-captures/', '.har-profile.json']) {
        assert.ok(text.split(/\r?\n/).map((l) => l.trim()).includes(entry),
            'covers ' + entry + '\n' + text);
    }
});

test('a later git init cannot sweep the salt or the raw captures in', async () => {
    // THE FALSIFIER, and the only assertion here that could not be satisfied
    // by writing a file with the right words in it. The skill's own pipeline
    // runs `git init && git add -A` in this folder later; what matters is what
    // git then stages, so git is the one asked.
    const root = dir('nonrepo-sweep');
    fs.mkdirSync(path.join(root, '.har-captures', 'app.example.com'), { recursive: true });
    fs.writeFileSync(path.join(root, '.har-captures', 'app.example.com', 'raw.har'),
        '{"log":{"version":"1.2","entries":[]}}', 'utf8');
    fs.writeFileSync(path.join(root, harProfile.PROFILE_FILENAME),
        JSON.stringify({ salt: 'b'.repeat(48), literals: {} }), 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');

    await capture.ensureCapturesRootIgnored(
        { root: path.join(root, '.har-captures'), currentWorkingTree: null, mainWorkingTree: null },
        { isTty: false });

    git(root, ['init', '--quiet', '-b', 'main']);
    git(root, ['add', '-A']);
    const staged = git(root, ['diff', '--cached', '--name-only'])
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    assert.ok(staged.includes('README.md'), 'ordinary files still stage: ' + staged.join(', '));
    assert.ok(!staged.some((f) => f.startsWith('.har-captures/')),
        'the unscrubbed raw stayed out: ' + staged.join(', '));
    assert.ok(!staged.includes(harProfile.PROFILE_FILENAME),
        'the salt stayed out: ' + staged.join(', '));
});

test('writing the rules is idempotent', async () => {
    const root = dir('nonrepo-idempotent');
    const placement = {
        root: path.join(root, '.har-captures'), currentWorkingTree: null, mainWorkingTree: null
    };
    await capture.ensureCapturesRootIgnored(placement, { isTty: false });
    const first = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    await capture.ensureCapturesRootIgnored(placement, { isTty: false });
    assert.strictEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), first,
        'a second recording appends nothing');
});

test('an existing .gitignore keeps its own content', async () => {
    // Append-only. The folder may already be somebody's, and a recorder that
    // rewrote their file would be a worse problem than the one it is fixing.
    const root = dir('nonrepo-existing');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n*.log\n', 'utf8');
    await capture.ensureCapturesRootIgnored(
        { root: path.join(root, '.har-captures'), currentWorkingTree: null, mainWorkingTree: null },
        { isTty: false });

    const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
        .split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes('node_modules/'), 'their rules survive');
    assert.ok(lines.includes('*.log'), 'all of them');
    assert.ok(lines.includes('.har-captures/'), 'and ours are added');
});

test('it never prompts about a folder that has no repository', async () => {
    // There is nothing to ask about: no repository exists, so no tracked file
    // is being changed, and the leak this prevents is silent. A prompt here
    // would also make every agent-driven capture in a fresh folder refuse.
    let asked = 0;
    const root = dir('nonrepo-quiet');
    const r = await capture.ensureCapturesRootIgnored(
        { root: path.join(root, '.har-captures'), currentWorkingTree: null, mainWorkingTree: null },
        { isTty: true, ask: () => { asked++; return Promise.resolve('n'); } });
    assert.strictEqual(asked, 0);
    assert.strictEqual(r.ok, true);
});

test('a folder inside a repository is left to the existing guard', async () => {
    // The in-repo path is unchanged: git is asked, and an unignored store is
    // still refused or prompted. Writing a .gitignore into somebody's
    // repository without asking is exactly what that guard exists to avoid.
    const repo = dir('inrepo');
    git(repo, ['init', '--quiet', '-b', 'main']);
    const capturesRoot = path.join(repo, '.har-captures');
    fs.mkdirSync(capturesRoot, { recursive: true });

    const r = await capture.ensureCapturesRootIgnored(
        { root: capturesRoot, currentWorkingTree: repo, mainWorkingTree: repo },
        { isTty: false });

    assert.strictEqual(r.ok, false, 'an unignored store inside a repo is still refused');
    assert.ok(!fs.existsSync(path.join(repo, '.gitignore')),
        'and nothing was written into the repository unasked');
});

// ---------------------------------------------------------------------------

run().then((ran) => {
    if (failures) {
        process.stderr.write('\n' + failures + ' of ' + ran + ' capture-preflight tests FAILED\n');
        process.exitCode = 1;
    } else {
        process.stdout.write('All capture-preflight tests passed (' + ran + ')\n');
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
});
