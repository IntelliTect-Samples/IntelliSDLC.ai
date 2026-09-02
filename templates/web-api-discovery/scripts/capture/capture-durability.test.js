#!/usr/bin/env node
// Behavior tests for issues #367 and #366 -- a capture that SURVIVES and can be
// IDENTIFIED. Zero-dep; runs with `node capture-durability.test.js`.
//
// These are one file because they are one incident. A 71 MB, 666-entry raw
// capture was destroyed during a routine worktree cleanup, and nobody could say
// what it had been for, because it had been recorded with no --describe.
// Neither failure was noticed until the data was already gone.
//
// WHY NO WARNING WAS POSSIBLE, which is the part worth carrying forward. The
// deleting session checked twice before it deleted, and both checks were
// structurally incapable of seeing the capture:
//
//   * it inventoried the directory with a listing that HIDES dot-directories,
//     so `.har-captures/` could not have appeared; and
//   * it read `git status --porcelain` as clean and concluded the tree held
//     nothing worth keeping. IGNORED CONTENT NEVER APPEARS THERE. The capture
//     store is gitignored, so the standard "what would I lose?" check is blind
//     to the only thing in the directory that mattered.
//
// That is why this is fixed by placing the bytes correctly and not by warning
// louder: the tools an operator reaches for cannot see what is at stake.
//
// ## What is being tested, and why it is tested this way
//
// THE FAILURE MODE IS A DELETION, SO THE TEST IS A DELETION. The durability
// tests below do not inspect a resolved string and declare it acceptable: they
// put bytes at the path the recorder resolves, delete the worktree for real --
// by `git worktree remove` AND by a plain recursive delete, which is what
// actually finished the job when git's own removal failed on a locked file --
// and assert the bytes are still there afterwards. A string-inspecting test
// would have passed before the incident and after it, which is the definition
// of a test that is not about the failure.
//
// A note on what the fixture supplies. The recorder cannot be made to record
// without a browser, so the marker file is written by the test at the path the
// RECORDER chose -- reported by `start --validate-only`, which is the recorder's
// own resolution and not a reimplementation of it. The path is the subject; the
// deletion is real; the bytes stand in for a raw.
//
// FALSIFIERS (fail on main, pass after the fix):
//   D1  a capture written from a worktree survives `git worktree remove`
//   D1b it survives a plain recursive delete of the worktree, which is what
//       actually destroyed the reported one
//   D2  the capture root resolves under the MAIN working tree, not the worktree
//   D3  the resolved root is ANNOUNCED while the run starts, not only filed
//       away in session.json
//   D3b it is announced even when nothing moved, including outside a repository
//   D4  `start` refuses to record with no --describe, and exits non-zero
//   D5  whitespace-only --describe is refused too
//   D6  the description reaches session.json, trimmed
//   D7  the resolution creates no link inside the worktree -- a junction there
//       would be worse than the defect, see the case for why
//   P1  the property below, over every generated shape
//   P1b an operator-placed symlinked root is followed rather than re-pointed
//
// All eleven were confirmed FAILING against main before the fix, and passing
// after it. The five below were confirmed PASSING against main -- they are
// guards on behaviour that must not change, which is worth pinning and is not
// evidence for either fix:
//   G1  outside any repository the root stays relative to the working directory
//   G2  in a primary checkout nothing is redirected away from the repository
//   G3  a catalogue-only re-run does NOT demand --describe (the regression #366
//       is most likely to cause)
//   G4  `--dir` is still refused with its own message -- the new requirement
//       does not shadow an existing rejection
//   G6  a capture already on disk under the old root is still FOUND, and is
//       neither moved nor deleted
//
// THE PROPERTY, stated once and generated over adjacent shapes rather than
// enumerated as cases: for nested worktrees, a worktree whose path contains a
// space, a detached-HEAD worktree, a subdirectory of the primary checkout, a
// `.git` that is a file, a linked worktree of a BARE repository, a submodule
// working tree, and a directory outside any repository -- the resolved capture
// root is NEVER inside a linked worktree, and IS inside the main working tree
// whenever the repository has one.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const captureJs = path.join(__dirname, 'capture-har.js');
const repoGuard = require(path.join(__dirname, '..', 'lib', 'repo-workflow-guard.js'));

const CAPTURES_DIR = '.har-captures';
/**
 * `fs.realpathSync` does NOT expand a Windows 8.3 short name, and os.tmpdir()
 * hands one back (`C:\Users\MARKMI~1\...`) while git answers in the long form.
 * Comparing one against the other is a fixture bug wearing a behavior's
 * clothes, so every fixture path goes through the native resolver.
 */
function real(p) {
    try { return fs.realpathSync.native(p); } catch (e) { void e; return fs.realpathSync(p); }
}

const tmpRoot = real(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-durability-')));

const queued = [];
function test(name, fn) { queued.push({ name, fn }); }

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function git(cwd, args, opts) {
    return execFileSync('git', args, Object.assign({
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    }, opts || {})).trim();
}

let seq = 0;
function scratch(name) {
    const dir = path.join(tmpRoot, `${name}-${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    return real(dir);
}

/**
 * A repository with one commit and `.har-captures/` ignored -- the shape a
 * consuming project has, which is what makes the deletion below the REAL
 * deletion: git reports nothing to lose, so `git worktree remove` does not
 * even ask.
 */
function makeRepo(name) {
    const dir = scratch(name);
    git(dir, ['init', '--quiet', '-b', 'main']);
    fs.writeFileSync(path.join(dir, '.gitignore'), CAPTURES_DIR + '/\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
    git(dir, ['add', '.gitignore', 'README.md']);
    git(dir, [
        '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
        'commit', '--quiet', '-m', 'init'
    ]);
    return dir;
}

function addWorktree(repo, relPath, branch, flags, commitish) {
    const target = path.join(repo, relPath);
    git(repo, [
        'worktree', 'add', ...(flags || []),
        ...(branch ? ['-b', branch] : []),
        target,
        ...(commitish ? [commitish] : [])
    ]);
    return real(target);
}

/** `start --validate-only` from `cwd`: the recorder's own path resolution. */
function resolveViaRecorder(cwd, args) {
    const r = spawnSync(process.execPath, [
        captureJs, 'start', '--uri', 'https://example.com',
        '--describe', 'durability fixture', '--validate-only', ...(args || [])
    ], { cwd, encoding: 'utf8', windowsHide: true });
    return {
        status: r.status,
        stderr: r.stderr || '',
        session: r.status === 0 ? JSON.parse(r.stdout) : null
    };
}

function runCapture(cwd, argv) {
    const r = spawnSync(process.execPath, [captureJs, ...argv],
        { cwd, encoding: 'utf8', windowsHide: true });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Bytes standing in for a raw, at whatever path the recorder resolved. */
function plantCapture(harPath) {
    fs.mkdirSync(path.dirname(harPath), { recursive: true });
    fs.writeFileSync(harPath, '{"log":{"version":"1.2","entries":[]}}', 'utf8');
    fs.writeFileSync(path.join(path.dirname(harPath), 'session.json'),
        JSON.stringify({ uri: 'https://example.com', harPath }), 'utf8');
    return harPath;
}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// D1 -- THE FALSIFIER. A real worktree removal, against real bytes.
// ---------------------------------------------------------------------------

test('D1: a capture recorded from a worktree survives `git worktree remove`', () => {
    const repo = makeRepo('deletion');
    const wt = addWorktree(repo, path.join('.worktrees', 'feature'), 'feat/x');

    const resolved = resolveViaRecorder(wt);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    const harPath = plantCapture(resolved.session.harPath);
    assert.ok(fs.existsSync(harPath), 'fixture: the capture must exist before the cleanup');

    // The cleanup that destroyed the real one. NOT --force: the point is that
    // an ordinary, correct removal succeeds without a prompt, because a
    // gitignored capture is invisible to git and there is nothing to warn
    // about. If this throws, the fixture stopped reproducing the incident.
    git(repo, ['worktree', 'remove', wt]);
    assert.ok(!fs.existsSync(wt), 'fixture: the worktree must actually be gone');

    assert.ok(fs.existsSync(harPath),
        'the raw capture was destroyed by a routine worktree cleanup -- this is #367: ' +
        `it was written to ${harPath}, inside a directory one command away from deletion`);
    assert.ok(isInside(harPath, repo) && !isInside(harPath, path.join(repo, '.worktrees')),
        'and it survived only because it was never inside the worktree');
});

test('D1b: it survives a plain recursive delete of the worktree, too', () => {
    // WHAT ACTUALLY HAPPENED. `git worktree remove` FAILED on the real
    // incident -- a locked DLL -- and the operator finished the job with a
    // recursive directory delete. A test that only exercised the git path
    // would have passed while the mechanism that destroyed the data went
    // untested, so both are pinned.
    //
    // Nothing above git's own path can be relied on here: a recursive delete
    // asks permission from nobody and consults no ignore rules. Which is the
    // whole argument for the fix being about WHERE the bytes are, and not
    // about warning louder.
    const repo = makeRepo('deletion-rmrf');
    const wt = addWorktree(repo, path.join('.worktrees', 'feature'), 'feat/rmrf');

    const resolved = resolveViaRecorder(wt);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    const harPath = plantCapture(resolved.session.harPath);

    fs.rmSync(wt, { recursive: true, force: true });
    assert.ok(!fs.existsSync(wt), 'fixture: the worktree directory must be gone');

    assert.ok(fs.existsSync(harPath),
        'a recursive delete of the worktree took the raw capture with it -- which is ' +
        `precisely how the reported one was lost. It was at ${harPath}`);
});

test('D2: the capture root resolves under the MAIN working tree, not the worktree', () => {
    const repo = makeRepo('anchor');
    const wt = addWorktree(repo, path.join('.worktrees', 'feature'), 'feat/y');

    const resolved = resolveViaRecorder(wt);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    const harPath = resolved.session.harPath;

    assert.ok(isInside(harPath, path.join(repo, CAPTURES_DIR)),
        `expected the raw under ${path.join(repo, CAPTURES_DIR)}, got ${harPath}`);
    assert.ok(!isInside(harPath, wt),
        'the raw must not be inside the linked worktree -- that is the disposable directory');

    // The scrubbed output used to follow the WORKTREE, on the reasoning that it
    // is committable and so belongs on the branch being worked on. #377 reversed
    // that: the root of whichever work tree the operator is standing in is not a
    // place artifacts belong, and a run from a checkout root dropped an
    // untracked host directory there. The default is the run's own session
    // directory now -- gitignored, stamped, and beside the raw. Promotion into a
    // committable directory is a separate, deliberate step.
    assert.strictEqual(resolved.session.outputPath, path.dirname(harPath),
        'the scrubbed artifacts belong beside the raw, in the run own session directory');
    assert.ok(!isInside(resolved.session.outputPath, wt),
        'and never inside the disposable worktree');
});

test('D3: the resolved capture root is announced while the run starts', () => {
    const repo = makeRepo('announce');
    const wt = addWorktree(repo, path.join('.worktrees', 'feature'), 'feat/z');

    const resolved = resolveViaRecorder(wt);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    // session.json recorded the doomed path perfectly and nobody read it in
    // time. The console is where a path can still be questioned.
    assert.ok(resolved.stderr.includes(path.join(repo, CAPTURES_DIR)),
        'the absolute capture root must be printed on the run, not only filed in ' +
        `session.json. stderr was:\n${resolved.stderr}`);
    assert.ok(/worktree/i.test(resolved.stderr),
        'and it must say WHY it moved, or the operator reads a path they did not expect ' +
        'and has no way to tell whether it is correct');
});

test('D3b: the root is announced even when nothing was redirected', () => {
    // A notice that appeared only in the interesting case would make "no line"
    // mean both "unchanged" and "this version does not tell you" -- and the
    // second is the one the operator would be relying on.
    for (const cwd of [makeRepo('announce-primary'), scratch('announce-no-repo')]) {
        const resolved = resolveViaRecorder(cwd);
        assert.strictEqual(resolved.status, 0, resolved.stderr);
        assert.ok(resolved.stderr.includes(path.join(cwd, CAPTURES_DIR)),
            `the resolved root must be printed from ${cwd}; stderr was:\n${resolved.stderr}`);
    }
});

// ---------------------------------------------------------------------------
// D4 / D5 -- #366. A capture nobody can identify.
// ---------------------------------------------------------------------------

test('D4: start refuses to record without --describe, and writes nothing', () => {
    const repo = makeRepo('describe-required');
    const r = runCapture(repo, ['start', '--uri', 'https://example.com', '--validate-only']);

    assert.notStrictEqual(r.status, 0, 'a recording with no description must not start');
    assert.ok(/--describe/.test(r.stderr), 'and must name the flag it wants');
    assert.ok(/Try: --describe/.test(r.stderr),
        'with an example -- a refusal that does not show the fix is a refusal that gets guessed at');
    assert.ok(!fs.existsSync(path.join(repo, CAPTURES_DIR)),
        'a refused start must leave no capture root behind');
});

test('D5: a whitespace-only --describe is empty, and is refused', () => {
    const repo = makeRepo('describe-blank');
    for (const blank of ['   ', '\t', '\n ']) {
        const r = runCapture(repo,
            ['start', '--uri', 'https://example.com', '--describe', blank, '--validate-only']);
        assert.notStrictEqual(r.status, 0,
            `--describe ${JSON.stringify(blank)} identifies nothing and must be refused`);
        assert.ok(/--describe/.test(r.stderr));
    }
});

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

test('G1: outside any repository the root stays relative to the working directory', () => {
    const plain = scratch('no-repo');
    const resolved = resolveViaRecorder(plain);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    assert.ok(isInside(resolved.session.harPath, path.join(plain, CAPTURES_DIR)),
        `standalone use must be byte-for-byte unchanged; got ${resolved.session.harPath}`);
});

test('G2: in a primary checkout the root is the repository root, unredirected', () => {
    const repo = makeRepo('primary');
    const resolved = resolveViaRecorder(repo);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    assert.ok(isInside(resolved.session.harPath, path.join(repo, CAPTURES_DIR)),
        `expected ${path.join(repo, CAPTURES_DIR)}, got ${resolved.session.harPath}`);
});

test('G3: a catalogue-only re-run does NOT demand --describe', () => {
    // THE REGRESSION #366 IS MOST LIKELY TO CAUSE. Re-entering at the catalogue
    // stage carries the description through from the previous session, so
    // demanding the flag again would ask the operator to re-supply something
    // that already exists -- and would break the one door #352 opened for
    // recovering a capture without re-recording it.
    const repo = makeRepo('recatalogue');
    const outputPath = path.join(repo, 'example.com');
    fs.mkdirSync(outputPath, { recursive: true });
    // Deliberately NOT a valid scrubbed HAR: this asserts what the command
    // demands of its ARGUMENTS, and it must get past argument handling to
    // complain about content. A --describe complaint here would be the
    // regression.
    fs.writeFileSync(path.join(outputPath, 'scrubbed.har'), '{"log":{"entries":[]}}', 'utf8');

    const r = runCapture(repo, ['catalogue', outputPath]);
    const said = r.stdout + r.stderr;
    assert.ok(!/--describe/.test(said),
        'the catalogue command must never ask for --describe: the description already ' +
        `exists on the capture being re-entered. It said:\n${said}`);
});

test('G4: --dir is still refused with its own message', () => {
    // Ordering matters: the describe requirement sits AFTER option validation,
    // so an operator who passes a dropped flag is told about THAT flag rather
    // than being answered with a complaint about a different one.
    const repo = makeRepo('dir-rejected');
    const r = runCapture(repo,
        ['start', '--uri', 'https://example.com', '--dir', repo, '--validate-only']);
    assert.strictEqual(r.status, 2);
    assert.ok(/confined to \.har-captures/i.test(r.stderr),
        `--dir must still be answered on its own terms; got:\n${r.stderr}`);
});

test('D6: the description reaches the session, trimmed', () => {
    const repo = makeRepo('describe-carried');
    const r = runCapture(repo, [
        'start', '--uri', 'https://example.com',
        '--describe', '  example.com: create a post, then delete it  ', '--validate-only'
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).describe,
        'example.com: create a post, then delete it');
});

test('G6: a capture under the OLD root is still found, and is not moved or deleted', () => {
    // Relocating anything already on disk is the one operation this pipeline
    // will not perform on a raw. So the old location is READ, never emptied.
    const repo = makeRepo('legacy');
    const wt = addWorktree(repo, path.join('.worktrees', 'feature'), 'feat/legacy');
    const legacyDir = path.join(wt, CAPTURES_DIR, 'example.com', '2026-01-01-120000');
    const legacyHar = plantCapture(path.join(legacyDir, 'raw.har'));

    const r = runCapture(wt, ['status']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('2026-01-01-120000'),
        `a capture written before the anchoring changed must still be findable:\n${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(legacyHar), 'and it must still be exactly where it was');
});

// ---------------------------------------------------------------------------
// P1 -- the property, over adjacent shapes
// ---------------------------------------------------------------------------

/**
 * Every generated shape answers the same two questions, so the invariant is
 * stated once rather than being restated per case:
 *
 *   the resolved root is never inside a LINKED worktree, and
 *   it is inside the main working tree whenever the repository has one.
 */
function shapes() {
    const out = [];

    {
        const repo = makeRepo('p-nested');
        const outer = addWorktree(repo, path.join('.worktrees', 'outer'), 'p/outer');
        // A worktree added FROM a worktree still belongs to the same repository,
        // so the answer must not depend on where the operator was standing.
        const inner = addWorktree(outer, path.join('.worktrees', 'inner'), 'p/inner');
        out.push({ name: 'nested worktrees', cwd: inner, main: repo, linked: [outer, inner] });
    }
    {
        const repo = makeRepo('p-space');
        const wt = addWorktree(repo, path.join('work trees', 'a branch'), 'p/space');
        out.push({ name: 'worktree path containing spaces', cwd: wt, main: repo, linked: [wt] });
    }
    {
        const repo = makeRepo('p-detached');
        const head = git(repo, ['rev-parse', 'HEAD']);
        const wt = addWorktree(repo, path.join('.worktrees', 'detached'), null, ['--detach'], head);
        out.push({ name: 'detached-HEAD worktree', cwd: wt, main: repo, linked: [wt] });
    }
    {
        const repo = makeRepo('p-subdir');
        const sub = path.join(repo, 'src', 'deep');
        fs.mkdirSync(sub, { recursive: true });
        out.push({ name: 'subdirectory of the primary checkout', cwd: sub, main: repo, linked: [] });
    }
    {
        // A `.git` FILE rather than a directory. Every linked worktree has one;
        // this shape asserts the resolution never assumes a directory.
        const repo = makeRepo('p-gitfile');
        const wt = addWorktree(repo, path.join('.worktrees', 'gitfile'), 'p/gitfile');
        assert.ok(fs.statSync(path.join(wt, '.git')).isFile(),
            'fixture: a linked worktree must have a .git file');
        out.push({ name: '.git is a file, not a directory', cwd: wt, main: repo, linked: [wt] });
    }
    {
        // A BARE main repository has no working tree to anchor to. Falling back
        // to the working directory is today's behaviour and the only honest
        // answer -- so the property asks only that nothing is invented.
        const source = makeRepo('p-bare-source');
        const bare = path.join(scratch('p-bare'), 'repo.git');
        git(path.dirname(bare), ['clone', '--bare', '--quiet', source, bare]);
        const wt = path.join(scratch('p-bare-wt'), 'checkout');
        git(bare, ['worktree', 'add', '--quiet', wt, 'main']);
        out.push({
            name: 'linked worktree of a bare repository',
            cwd: real(wt), main: null, linked: []
        });
    }
    {
        // A submodule is its own repository with its own primary checkout, and
        // is not removable by `git worktree remove`. It must anchor to itself,
        // not to the superproject and not to `.git/modules/...`.
        const superRepo = makeRepo('p-super');
        const child = makeRepo('p-sub-source');
        try {
            git(superRepo, ['-c', 'protocol.file.allow=always', 'submodule', '--quiet',
                'add', child.replace(/\\/g, '/'), 'vendor/lib']);
            const subDir = real(path.join(superRepo, 'vendor', 'lib'));
            out.push({ name: 'submodule working tree', cwd: subDir, main: subDir, linked: [] });
        } catch (e) {
            // Some git builds refuse local-path submodules outright. A skipped
            // shape is reported, never silently dropped.
            process.stderr.write(`  (shape skipped: submodule -- ${e.message.split('\n')[0]})\n`);
        }
    }
    {
        const plain = scratch('p-outside');
        out.push({ name: 'directory outside any repository', cwd: plain, main: null, linked: [] });
    }

    return out;
}

test('P1: no shape ever anchors a capture root inside a linked worktree', () => {
    let checked = 0;
    for (const shape of shapes()) {
        const placement = repoGuard.resolveCaptureRoot(shape.cwd, CAPTURES_DIR);
        const root = placement.root;

        assert.ok(path.isAbsolute(root), `${shape.name}: the root must be absolute (${root})`);
        assert.strictEqual(path.basename(root), CAPTURES_DIR,
            `${shape.name}: the folder NAME is fixed and nothing may change it`);

        for (const linked of shape.linked) {
            assert.ok(!isInside(root, linked),
                `${shape.name}: the capture root landed in the disposable worktree ${linked} ` +
                `(${root}) -- one \`git worktree remove\` from deletion`);
        }
        if (shape.main) {
            // EXACT, not `isInside`. The disjunct this replaces --
            // `isInside(root, shape.main) || path.dirname(root) === shape.main`
            // -- admitted precisely what the assertion exists to forbid. For the
            // `subdirectory of the primary checkout` shape, the OLD
            // working-directory answer `repo/sub/deep/.har-captures` IS inside
            // `repo`, so it satisfied the first disjunct and the case passed
            // while the behaviour it names was broken. Reverting only the
            // subdirectory half of the anchoring left all 16 tests green.
            //
            // Every shape carrying a main working tree wants the same thing --
            // the root sits DIRECTLY in it -- so one exact equality serves them
            // all and there is nothing here to split.
            assert.strictEqual(root, path.join(shape.main, CAPTURES_DIR),
                `${shape.name}: the root must sit directly in the main working tree ` +
                `${shape.main}, not merely somewhere beneath it; got ${root}`);
        } else {
            // No main working tree exists, so the working directory is the only
            // answer -- and inventing one would be worse than keeping today's.
            assert.strictEqual(root, path.join(shape.cwd, CAPTURES_DIR),
                `${shape.name}: with no main working tree the root must stay where it was`);
        }
        checked++;
    }
    assert.ok(checked >= 7, `expected the generator to produce shapes, got ${checked}`);
});

test('D7: nothing in the resolution creates a link into the capture store', () => {
    // A LINK IS NOT A SAFE SUBSTITUTE FOR THE ANCHORING, on Windows especially.
    // A worktree whose `.har-captures` is a JUNCTION to the real store survives
    // `git worktree remove`, but Windows PowerShell 5.1's `Remove-Item -Recurse`
    // follows a directory junction and deletes the TARGET's contents -- so the
    // same recursive delete that motivated D1b would take the whole store, not
    // one capture. pwsh 7 does not have that bug; `powershell.exe` is still on
    // PATH on a normal Windows box, and nothing guarantees which one the next
    // piece of cleanup tooling shells out to.
    //
    // So the fix places the bytes correctly rather than pointing at them, and
    // this pins that: recording from a worktree must create nothing inside it.
    const repo = makeRepo('no-link');
    const wt = addWorktree(repo, path.join('.worktrees', 'feature'), 'feat/nolink');

    const resolved = resolveViaRecorder(wt);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    plantCapture(resolved.session.harPath);

    const inWorktree = path.join(wt, CAPTURES_DIR);
    assert.ok(!fs.existsSync(inWorktree),
        `${inWorktree} must not exist -- neither as a directory nor as a link. A junction ` +
        'here would put the whole store one 5.1 `Remove-Item -Recurse` from deletion.');
});

test('P1b: an operator-placed symlinked capture root is followed, not re-pointed', () => {
    // A consuming project may park the store on another volume. Nothing here
    // resolves the link away, so the capture lands where the operator pointed
    // it -- and the anchoring decides the LINK's location, not the target's.
    //
    // The fixture creates the link; the code under test never does (see D7).
    const repo = makeRepo('p-symlink');
    const elsewhere = scratch('p-symlink-target');
    let linked = false;
    try {
        fs.symlinkSync(elsewhere, path.join(repo, CAPTURES_DIR), 'junction');
        linked = true;
    } catch (e) {
        process.stderr.write(`  (symlink shape skipped -- ${e.message.split('\n')[0]})\n`);
    }
    if (!linked) return;

    const wt = addWorktree(repo, path.join('.worktrees', 'sym'), 'p/sym');
    const resolved = resolveViaRecorder(wt);
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    assert.ok(resolved.session.harPath.startsWith(path.join(repo, CAPTURES_DIR)),
        `expected the root at the link in the main checkout, got ${resolved.session.harPath}`);
});

// ---------------------------------------------------------------------------

// Every case runs even after one fails, unlike the fail-fast runners elsewhere
// in this directory. Ablation is the reason: breaking one line of the
// resolution has to show WHICH assertions notice, and a runner that stops at
// the first failure answers "at least one" every time.
(async () => {
    let passed = 0;
    const failures = [];
    for (const { name, fn } of queued) {
        try { await fn(); passed++; } catch (e) {
            failures.push(name);
            process.stderr.write(`FAIL: ${name}\n  ${e.message}\n`);
            if (e.stack) process.stderr.write(e.stack.split('\n').slice(1, 3).join('\n') + '\n');
        }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (failures.length) {
        process.stderr.write(
            `\n${failures.length} of ${queued.length} capture-durability tests FAILED:\n` +
            failures.map((f) => `  - ${f}\n`).join(''));
        process.exit(1);
    }
    console.log(`All capture-durability tests passed (${passed})`);
})();
