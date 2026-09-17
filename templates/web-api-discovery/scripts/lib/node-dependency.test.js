#!/usr/bin/env node
// Behavior tests for node-dependency.js -- where the recorder looks for a
// module, and what it says when it cannot find one (issue #512).
//
// Zero-dep, runs with `node node-dependency.test.js`. Exits non-zero when
// anything fails.
//
// These build REAL `node_modules` trees in a temp directory and resolve
// through Node's own `require.resolve`, rather than injecting a fake resolver.
// The defect being pinned IS Node's resolution semantics -- a bare
// `require('playwright')` searches upward from the SCRIPT's directory, not from
// the operator's -- so a stubbed resolver would pin our belief about those
// semantics instead of the semantics themselves. That is exactly how the bug
// survived: everyone believed the remedy in the error message worked.
//
// The two kinds of location are NOT interchangeable and the tests keep them
// apart deliberately:
//
//  - An UPWARD location is a starting directory. Node walks it and every
//    ancestor looking for `node_modules/<name>`. The operator's folder and the
//    recorder's own folder are both this kind.
//  - A CONTAINER location is itself a `node_modules`-shaped directory holding
//    packages by name, with no walk. npm's global root and every NODE_PATH
//    entry are this kind.
//
// Resolving a container by starting an upward walk inside it would look for
// `<container>/node_modules/<name>` and find nothing -- a location that
// reports "searched" while being incapable of ever matching is worse than one
// that is not searched at all.
//
// The controlling rules, each tied to something the issue names:
//
//  - The OPERATOR'S folder is asked first. Running the upstream recorder
//    against a folder that installed its own copy must use that copy.
//  - The recorder's own install still answers, so a consumer repo that synced
//    the skill is unchanged.
//  - The machine default answers with nothing set, so one install per machine
//    is enough.
//  - NODE_PATH still participates -- Node's own pointing mechanism, and no new
//    option or environment variable is introduced.
//  - A failure names every location it searched, by absolute path, and the
//    remedy it prints has to be one that works from where the operator stands.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dep = require(path.join(__dirname, 'node-dependency.js'));

const tmpRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'node-dependency-test-')));
let failures = 0;
let ran = 0;

function test(name, fn) {
    ran++;
    try {
        fn();
    } catch (e) {
        failures++;
        process.stderr.write('FAIL: ' + name + '\n  ' + e.message + '\n');
        if (e.stack) process.stderr.write(e.stack.split('\n').slice(1, 4).join('\n') + '\n');
    }
}

// A package name nothing on the machine can supply. Using 'playwright' here
// would make every assertion depend on whether the box happens to have it.
const PKG = 'fake-dep-under-test';

function dir(...parts) {
    const d = path.join(tmpRoot, ...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

// Plant a real, resolvable package inside `<where>/node_modules`. Returns the
// container directory, which is what a CONTAINER location points at.
function plant(where, name) {
    const container = path.join(where, 'node_modules');
    const pkg = path.join(container, name || PKG);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'),
        JSON.stringify({ name: name || PKG, version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = ' +
        JSON.stringify(where) + ';\n');
    return container;
}

// Every location supplied explicitly, so a test says exactly what it is
// asking about and nothing leaks in from the machine running it.
function opts(over) {
    return Object.assign({
        cwd: dir('empty-cwd'),
        toolDir: dir('empty-tool'),
        globalRoot: path.join(dir('empty-global'), 'node_modules'),
        nodePath: '',
        delimiter: path.delimiter
    }, over);
}

// ---------------------------------------------------------------------------
// Order: the operator's folder is asked first
// ---------------------------------------------------------------------------

test('the operator folder wins over the recorder own install', () => {
    // THE DEFECT, stated as a test. Both folders have the module; a bare
    // `require` would take the tool's copy because that is where the script
    // lives. The operator's must win, or "npm install playwright" in the
    // folder you are standing in remains advice that does nothing.
    const cwd = dir('order-cwd');
    const tool = dir('order-tool');
    plant(cwd);
    plant(tool);

    const r = dep.resolveDependency(PKG, opts({ cwd, toolDir: tool }));
    assert.ok(r.found, 'resolved');
    assert.strictEqual(r.location, 'cwd', 'the operator folder answered');
    // Asserted on what the resolved module EXPORTS -- the directory it was
    // planted in -- not on a substring of its path. Two copies of a package
    // named the same differ only by location, so a path match written the
    // loose way passes against either one.
    assert.strictEqual(require(r.path), cwd, 'it is the operator copy that loads');
});

test('the recorder own install still answers when the operator folder has none', () => {
    // A consumer repo that synced the skill has node_modules beside the
    // script. That case must be untouched by this change.
    const cwd = dir('tool-only-cwd');
    const tool = dir('tool-only-tool');
    plant(tool);

    const r = dep.resolveDependency(PKG, opts({ cwd, toolDir: tool }));
    assert.ok(r.found, 'resolved');
    assert.strictEqual(r.location, 'tool');
    assert.strictEqual(require(r.path), tool);
});

test('the machine global root answers with nothing else set', () => {
    // The owner's question: "Is there a default machine location we could
    // use?" One global install, and every folder works.
    const home = dir('global-home');
    const globalRoot = plant(home);

    const r = dep.resolveDependency(PKG, opts({ globalRoot }));
    assert.ok(r.found, 'resolved');
    assert.strictEqual(r.location, 'global');
    assert.strictEqual(require(r.path), home);
});

test('NODE_PATH still participates, and is asked last', () => {
    const home = dir('nodepath-home');
    const container = plant(home);

    const r = dep.resolveDependency(PKG, opts({ nodePath: container }));
    assert.ok(r.found, 'resolved');
    assert.strictEqual(r.location, 'node-path');
    assert.strictEqual(require(r.path), home);
});

test('NODE_PATH with several entries searches each of them', () => {
    const home = dir('nodepath-multi-home');
    const container = plant(home);
    const nodePath = [path.join(dir('nodepath-multi-empty'), 'node_modules'), container]
        .join(path.delimiter);

    const r = dep.resolveDependency(PKG, opts({ nodePath }));
    assert.ok(r.found, 'resolved from the second entry');
    assert.strictEqual(r.location, 'node-path');
});

test('an earlier location beats a later one at every step', () => {
    // Order is the whole contract, so it is pinned as a sequence rather than
    // by one pairwise case. Step i plants the package in locations i and
    // after, and location i has to be the one that answers.
    //
    // A FRESH PACKAGE NAME PER STEP, and fresh directories with it. The
    // obvious shape -- plant everywhere, then delete the winner and re-ask --
    // is wrong here: Node caches resolved module paths per process, so the
    // deleted copy keeps being returned and the test passes against a stale
    // answer while proving nothing about order.
    const expected = ['cwd', 'tool', 'global', 'node-path'];
    for (let i = 0; i < expected.length; i++) {
        const name = PKG + '-cascade-' + i;
        const homes = expected.map((key) => dir('cascade-' + i + '-' + key));
        for (let j = i; j < homes.length; j++) { plant(homes[j], name); }

        const r = dep.resolveDependency(name, opts({
            cwd: homes[0],
            toolDir: homes[1],
            globalRoot: path.join(homes[2], 'node_modules'),
            nodePath: path.join(homes[3], 'node_modules')
        }));
        assert.ok(r.found, 'step ' + i + ' resolved');
        assert.strictEqual(r.location, expected[i], 'step ' + i + ' expected ' + expected[i]);
        assert.strictEqual(require(r.path), homes[i], 'step ' + i + ' loaded the right copy');
    }
});

// ---------------------------------------------------------------------------
// The two kinds of location behave differently, on purpose
// ---------------------------------------------------------------------------

test('an operator folder is searched UPWARD, so a parent install counts', () => {
    // npm installs at the project root; captures are taken from a subfolder.
    // Without the upward walk that is a miss.
    const root = dir('upward-root');
    plant(root);
    const deep = dir('upward-root', 'a', 'b', 'c');

    const r = dep.resolveDependency(PKG, opts({ cwd: deep }));
    assert.ok(r.found, 'a parent install is found from a subfolder');
    assert.strictEqual(r.location, 'cwd');
    assert.strictEqual(require(r.path), root);
});

test('a container location is NOT walked upward', () => {
    // THE FALSIFIER for treating the two kinds alike. npm's global root is a
    // node_modules directory; starting an upward walk there looks for
    // `<root>/node_modules/<name>`. If a container were implemented as an
    // upward start, this planted package -- which sits in the container the
    // honest way -- would not be found, and a package planted the wrong way
    // would be. Both halves are asserted.
    const home = dir('container-kind');
    const globalRoot = plant(home);

    assert.ok(dep.resolveDependency(PKG, opts({ globalRoot })).found,
        'a package sitting directly in the container is found');

    // And the shape an upward walk would have needed: one level deeper.
    const wrong = dir('container-kind-wrong');
    const wrongRoot = path.join(wrong, 'node_modules');
    fs.mkdirSync(wrongRoot, { recursive: true });
    plant(wrongRoot);
    assert.ok(!dep.resolveDependency(PKG, opts({ globalRoot: wrongRoot })).found,
        'a container is not walked upward or downward into a nested node_modules');
});

// ---------------------------------------------------------------------------
// What was searched is reported
// ---------------------------------------------------------------------------

test('every location is reported with an absolute path, in order', () => {
    const cwd = dir('report-cwd');
    const tool = dir('report-tool');
    const globalRoot = path.join(dir('report-global'), 'node_modules');
    const nodePath = path.join(dir('report-nodepath'), 'node_modules');

    const r = dep.resolveDependency(PKG, opts({ cwd, toolDir: tool, globalRoot, nodePath }));
    assert.ok(!r.found, 'nothing has it');
    assert.deepStrictEqual(r.searched.map((s) => s.key),
        ['cwd', 'tool', 'global', 'node-path'],
        'all four, in the documented order');
    for (const s of r.searched) {
        assert.ok(path.isAbsolute(s.dir), s.key + ' reports an absolute path');
        assert.strictEqual(s.found, false);
        assert.ok(s.label && s.label.length > 0, s.key + ' has something to call itself');
    }
    assert.deepStrictEqual(r.searched.map((s) => s.dir), [cwd, tool, globalRoot, nodePath]);
});

test('an unset NODE_PATH is reported as unset, not as a bogus directory', () => {
    // Printing an empty or cwd-relative path under a NODE_PATH heading would
    // send the operator to a folder that has nothing to do with anything.
    const r = dep.resolveDependency(PKG, opts({ nodePath: '' }));
    const np = r.searched.filter((s) => s.key === 'node-path');
    assert.strictEqual(np.length, 1, 'it is still listed -- silence would hide an option');
    assert.strictEqual(np[0].dir, null, 'with no directory, because there is none');
    assert.ok(/unset|not set/i.test(np[0].label), 'and says so: ' + np[0].label);
});

test('a location that answered is the only one marked found', () => {
    const cwd = dir('found-flag-cwd');
    plant(cwd);
    const r = dep.resolveDependency(PKG, opts({ cwd }));
    assert.deepStrictEqual(r.searched.map((s) => s.found), [true, false, false, false],
        'the search stops at the winner and says which one it was');
});

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

test('the failure names every searched folder by absolute path', () => {
    const cwd = dir('msg-cwd');
    const tool = dir('msg-tool');
    const globalRoot = path.join(dir('msg-global'), 'node_modules');
    const nodePath = path.join(dir('msg-nodepath'), 'node_modules');
    const r = dep.resolveDependency(PKG, opts({ cwd, toolDir: tool, globalRoot, nodePath }));

    const msg = dep.describeMissing(PKG, r, { browser: true });
    for (const d of [cwd, tool, globalRoot, nodePath]) {
        assert.ok(msg.includes(d), 'names ' + d + '\n--- message ---\n' + msg);
    }
});

test('the remedy is one that works from where the operator stands', () => {
    // The whole point of the issue. The old message said `npm install
    // playwright`, which installs into the operator's folder -- a folder the
    // old resolver never searched. Now that folder IS searched, so that
    // command works; and the machine default is offered as the one-install
    // answer.
    const r = dep.resolveDependency(PKG, opts());
    const msg = dep.describeMissing(PKG, r, { browser: true });
    assert.ok(msg.includes('npm install -g ' + PKG),
        'offers the machine-default install\n' + msg);
    assert.ok(new RegExp('npm install ' + PKG + '\\b').test(msg),
        'and the install-here option, which now resolves\n' + msg);
});

test('a missing browser is reported separately from a missing module', () => {
    // Installing the module does not install the browser. A message that
    // conflates them sends the operator to the wrong command and they run it,
    // see it succeed, and fail again.
    const r = dep.resolveDependency(PKG, opts());
    const bothMissing = dep.describeMissing(PKG, r, { browser: false });
    const moduleOnly = dep.describeMissing(PKG, r, { browser: true });

    assert.ok(/npx playwright install chromium/.test(bothMissing),
        'names the browser install when the browser is absent\n' + bothMissing);
    assert.ok(!/npx playwright install chromium/.test(moduleOnly),
        'and does not when the browser is already there\n' + moduleOnly);
});

test('the message does not invent a NODE_PATH directory when none is set', () => {
    const r = dep.resolveDependency(PKG, opts({ nodePath: '' }));
    const msg = dep.describeMissing(PKG, r, { browser: true });
    assert.ok(/NODE_PATH/.test(msg), 'NODE_PATH is still mentioned as an option');
    assert.ok(/NODE_PATH[^\n]*(unset|not set)/i.test(msg),
        'and is described as unset\n' + msg);
});

// ---------------------------------------------------------------------------
// The browser binary, and the machine default
// ---------------------------------------------------------------------------

test('the chromium check honours PLAYWRIGHT_BROWSERS_PATH', () => {
    const custom = dir('browsers-custom');
    fs.mkdirSync(path.join(custom, 'chromium-1148'), { recursive: true });
    assert.strictEqual(
        dep.chromiumPresent({ env: { PLAYWRIGHT_BROWSERS_PATH: custom } }), true);
});

test('an empty browsers directory is absent, not present', () => {
    // The directory exists after any playwright install attempt, so existence
    // of the FOLDER proves nothing. A check written that way reports success
    // and the browser launch fails minutes later.
    const empty = dir('browsers-empty');
    assert.strictEqual(
        dep.chromiumPresent({ env: { PLAYWRIGHT_BROWSERS_PATH: empty } }), false);
    fs.mkdirSync(path.join(empty, 'firefox-1489'), { recursive: true });
    assert.strictEqual(
        dep.chromiumPresent({ env: { PLAYWRIGHT_BROWSERS_PATH: empty } }), false,
        'another browser is not chromium');
});

test('a missing browsers directory is absent, and does not throw', () => {
    assert.strictEqual(
        dep.chromiumPresent({ env: { PLAYWRIGHT_BROWSERS_PATH: path.join(tmpRoot, 'nope') } }),
        false);
});

test('the browsers path falls back to the per-machine default', () => {
    const appdata = dir('browsers-localappdata');
    fs.mkdirSync(path.join(appdata, 'ms-playwright', 'chromium-1'), { recursive: true });
    assert.strictEqual(dep.chromiumPresent({
        env: { LOCALAPPDATA: appdata }, platform: 'win32'
    }), true, 'Windows: %LOCALAPPDATA%\\ms-playwright');

    const home = dir('browsers-home');
    fs.mkdirSync(path.join(home, '.cache', 'ms-playwright', 'chromium-1'), { recursive: true });
    assert.strictEqual(dep.chromiumPresent({
        env: {}, platform: 'linux', homedir: home
    }), true, 'elsewhere: ~/.cache/ms-playwright');
});

test('the machine default global root is npm own, and needs no subprocess', () => {
    // Deliberately computed rather than shelled out to. `npm root -g` costs
    // most of a second and this runs on the way in to every capture; the
    // default location is documented and stable, and the subprocess is kept
    // for the failure path where a second is already being spent printing an
    // error.
    assert.strictEqual(
        dep.defaultGlobalRoot({ env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, platform: 'win32' }),
        path.join('C:\\Users\\x\\AppData\\Roaming', 'npm', 'node_modules'));
    assert.strictEqual(
        dep.defaultGlobalRoot({ env: {}, platform: 'linux', execPath: '/usr/local/bin/node' }),
        path.join('/usr/local', 'lib', 'node_modules'));
});

test('the machine default is null when it cannot be worked out', () => {
    // Null, not a half-built path. A location reported as searched must be a
    // place that was actually searched.
    assert.strictEqual(dep.defaultGlobalRoot({ env: {}, platform: 'win32' }), null);
    const r = dep.resolveDependency(PKG, opts({ globalRoot: null }));
    const g = r.searched.filter((s) => s.key === 'global')[0];
    assert.strictEqual(g.dir, null);
    assert.ok(/unknown|not set|unset/i.test(g.label), 'and says so: ' + g.label);
});

// ---------------------------------------------------------------------------

if (failures) {
    process.stderr.write('\n' + failures + ' of ' + ran + ' node-dependency tests FAILED\n');
    process.exitCode = 1;
} else {
    process.stdout.write('All node-dependency tests passed (' + ran + ')\n');
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
