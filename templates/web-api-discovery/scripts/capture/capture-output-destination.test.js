#!/usr/bin/env node
// Behavior tests for issue #377 -- where scrub output lands, what the run says
// about it, and the link back to the raw.
//
// Zero-dep, runs with `node capture-output-destination.test.js`.
//
// THE DEFECT. A capture run in a consuming project wrote `scrubbed.har`,
// `catalogue.json` and `digest.json` to the REPOSITORY ROOT as an untracked,
// un-gitignored host directory. `resolveDefaultOutputRoot` anchored the default
// to whichever work tree the operator happened to be standing in, and the
// comment above it already conceded the gap: anchoring makes placement
// PREDICTABLE, not correct. The recorder warned. The files landed anyway.
//
// Three more defects lived in the same place: the output was unstamped, so a
// second capture against one host silently overwrote the first's scrubbed
// artifact; nothing linked a committed reference back to the raw it came from;
// and `current.json` was one shared pointer file in a store several agent
// sessions record into at once.
//
// FALSIFIERS are numbered to the issue and each one fails on `main`. GUARDS
// pass on arrival: they are here so a fix to the above cannot quietly take them
// with it, and they are NOT evidence that anything was fixed.

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capture = require(path.join(__dirname, 'capture-har.js'));
const { initProtectedRepo } = require(path.join(__dirname, '..', 'har', 'har-test-repo.test-support.js'));

// realpathSync.NATIVE, not realpathSync. On Windows os.tmpdir() frequently
// hands back the 8.3 short form (MARKMI~1) and plain realpathSync keeps it,
// while git always answers with the long one -- so a path this file built and
// a path git reported would differ for a reason that is a fixture bug rather
// than a behavior.
const tmpRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'capture-destination-')));

const queued = [];
function test(name, fn) { queued.push({ name, fn }); }

const CAPTURE_JS = path.join(__dirname, 'capture-har.js');
const SCRUBBED_HAR = 'scrubbed.har';
const CATALOGUE_FILE = 'catalogue.json';
const DIGEST_FILE = 'digest.json';

// ---------------------------------------------------------------------------
// Fixtures
//
// The repositories are REAL git repositories, never stubs. The subject under
// test is what git actually reports about a checkout -- `git check-ignore` and
// `git status` -- so a stub would pin our belief about git's answers instead of
// git's answers.
// ---------------------------------------------------------------------------

/** A repository that looks like a scaffolded consumer's: the capture store is ignored. */
function repo(name) {
    const dir = path.join(tmpRoot, name);
    initProtectedRepo(dir);
    writeProfile(dir);
    return dir;
}

/** The same, with NO .gitignore at all -- the case the run must refuse. */
function unprotectedRepo(name) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    writeProfile(dir);
    return dir;
}

function writeProfile(dir) {
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'test-salt',
        literals: { 'operator@example.com': '<UserEmail>' }
    }), 'utf8');
}

function entry(url, bodyText) {
    return {
        startedDateTime: '2026-01-01T12:00:00Z', time: 5,
        request: {
            method: 'GET', url,
            headers: [], queryString: [], cookies: [], headersSize: 10, bodySize: 0
        },
        response: {
            status: 200, statusText: 'OK', headers: [], cookies: [], redirectURL: '',
            headersSize: 10, bodySize: 2,
            content: { size: 2, mimeType: 'application/json', text: bodyText || '{}' }
        },
        cache: {}, timings: { send: 1, wait: 3, receive: 1 }
    };
}

function har(entries) {
    return { log: { version: '1.2', creator: { name: 'd-test', version: '1' }, entries } };
}

/**
 * A session whose paths come from resolveSessionPaths itself -- the function
 * under test -- rather than from hand-built strings. A fixture that assembled
 * its own output path could not observe the default moving.
 */
function session(dir, opts = {}) {
    const paths = inDir(dir, () => capture.resolveSessionPaths({
        uri: opts.uri || 'https://app.example.com/start',
        cwd: dir,
        outputPath: opts.outputPath,
        stamp: opts.stamp || '2026-01-01-120000'
    }));
    fs.mkdirSync(paths.sessionDir, { recursive: true });
    fs.writeFileSync(paths.harPath,
        JSON.stringify(har(opts.entries || [entry('https://api.example.com/v1/thing')])), 'utf8');
    return Object.assign({}, paths, {
        uri: opts.uri || 'https://app.example.com/start',
        describe: opts.describe === undefined
            ? 'example: create a thing, then delete it'
            : opts.describe,
        startedUtc: '2026-01-01T12:00:00Z'
    });
}

function inDir(dir, fn) {
    const cwd = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(cwd); }
}

/** verify-scrub.js stands aside and reports clean; sanitize-har.js runs for real. */
function cleanGate(script, argv) {
    if (script.endsWith('verify-scrub.js')) return { ok: true, status: 0, stdout: '', stderr: '' };
    return capture.runNode(script, argv);
}

/** verify-scrub.js refuses. The leak-gate rejection path. */
function rejectingGate(script, argv) {
    if (!script.endsWith('verify-scrub.js')) return capture.runNode(script, argv);
    const target = argv[argv.indexOf('--in') + 1];
    fs.writeFileSync(path.join(path.dirname(target), 'scrub-findings.json'), JSON.stringify({
        schemaVersion: 1, verdict: 'gating', findings: [{
            kind: 'credit-card', class: 'identity', disposition: 'gating',
            entryIndex: 0, count: 1, fingerprint: 'abc123def456'
        }], suggestedPolicyFragment: null
    }), 'utf8');
    return { ok: false, status: 3, stdout: '', stderr: 'verify-scrub: blocking finding' };
}

function porcelain(dir) {
    return execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
}

/** Every file under `root`, relative and sorted -- for before/after comparison. */
function treeOf(root) {
    const out = [];
    (function walk(dir, prefix) {
        let names;
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        for (const name of names.sort()) {
            const full = path.join(dir, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            if (fs.statSync(full).isDirectory()) walk(full, rel);
            else out.push(rel);
        }
    }(root, ''));
    return out.sort();
}

function renderNormal(session) {
    return capture.renderLines(capture.postProcessLines(session), 'normal');
}

// ===========================================================================
// FALSIFIER 1 -- a run from a checkout root leaves no untracked <host>/
// ===========================================================================

test('F1: a capture run from a checkout root leaves the work tree clean', () => {
    const dir = repo('f1-checkout-root');
    const s = session(dir);
    // Compared before against after rather than against empty: the fixture's
    // own .gitignore is untracked (git init, no commit), and what is under test
    // is what the CAPTURE adds.
    const before = porcelain(dir);

    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    assert.ok(state.scrubbed && state.scrubbed.path, 'precondition: the scrub must have produced something');

    // THE DEFECT, stated as an assertion. Before this, running from a checkout
    // root created `<repo>/app.example.com/` holding scrubbed.har, digest.json
    // and catalogue.json -- untracked, un-gitignored, and one `git add -A` from
    // a commit nobody intended.
    assert.strictEqual(porcelain(dir), before,
        'a capture must add nothing that git can see');
    assert.ok(!fs.existsSync(path.join(dir, 'app.example.com')),
        'no host-named directory may appear at the checkout root');
});

// ===========================================================================
// FALSIFIER 2 -- two captures against one host do not overwrite each other
// ===========================================================================

test('F2: a second capture against the same host cannot overwrite the first', () => {
    const dir = repo('f2-two-captures');
    const first = session(dir, {
        stamp: '2026-01-01-120000',
        entries: [entry('https://api.example.com/v1/first')]
    });
    const second = session(dir, {
        stamp: '2026-01-02-090000',
        entries: [entry('https://api.example.com/v1/second')]
    });

    inDir(dir, () => capture.postProcess(first, { run: cleanGate }));
    inDir(dir, () => capture.postProcess(second, { run: cleanGate }));

    assert.notStrictEqual(first.outputPath, second.outputPath,
        'the output path must carry the run stamp, or the second run lands on the first');

    const one = fs.readFileSync(path.join(first.outputPath, SCRUBBED_HAR), 'utf8');
    const two = fs.readFileSync(path.join(second.outputPath, SCRUBBED_HAR), 'utf8');
    assert.ok(one.includes('/v1/first'),
        "the first capture's scrubbed artifact must survive the second capture");
    assert.ok(two.includes('/v1/second'));
    assert.ok(!one.includes('/v1/second'), 'and the two must not be the same file');
});

// ===========================================================================
// FALSIFIER 3 -- the promote step names the conventional reference path
// ===========================================================================

test('F3: the run names docs/har-reference/<host>/<provider>/<provider>-<action>-<date>.har', () => {
    const dir = repo('f3-promote');
    const s = session(dir, { describe: 'example: create a thing, then delete it' });
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));

    const reference = state.reference;
    assert.ok(reference, 'a verified capture must be told how to become a reference');
    // NESTED: <host>/<provider>/. The host directory carries the committed
    // catalogue.json and its generated README (#379); the provider directory
    // carries that provider's extracts and its api.json (#382). Flat would put
    // two providers' references in the directory #382 reads as one API.
    assert.strictEqual(path.basename(path.dirname(reference.path)), 'example',
        'the reference sits in the PROVIDER directory');
    assert.strictEqual(path.basename(path.dirname(path.dirname(reference.path))),
        'app.example.com', 'which sits under the directory keyed on the captured host');
    assert.strictEqual(
        path.basename(path.dirname(path.dirname(path.dirname(reference.path)))),
        'har-reference');
    assert.match(reference.fileName, /^example-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.har$/,
        'the filename is <provider>-<action>-<yyyy-MM-dd>.har, provider first');
    assert.ok(reference.fileName.startsWith('example-create-thing'),
        'the action slug comes from --describe, trimmed to something a human would write, ' +
        `got ${reference.fileName}`);
    // The provider is repeated in the filename ON PURPOSE: the directory is
    // invisible once the file is opened, attached to an issue, or pasted into
    // a diff.
    assert.strictEqual(reference.relativePath, `example/${reference.fileName}`,
        'the catalogue-relative path is <provider>/<filename>');

    // And it is PRINTED, with the command that writes it. The extract is what
    // gets committed -- a trimmed selection of entries, not the whole scrubbed
    // capture -- so the run hands over the existing extractor rather than
    // copying hundreds of megabytes into a tracked directory.
    const printed = renderNormal(Object.assign({}, s, { postProcess: state }));
    assert.ok(printed.includes(reference.path), 'the reference path must be printed');
    assert.ok(printed.includes('extract-har-reference.js'),
        'the run must name the tool that already implements this convention');
    assert.ok(printed.includes('--match'),
        'and the selector the extractor requires, since a machine cannot choose it');
});

test('F3b: nothing is written into the reference directory by the run itself', () => {
    const dir = repo('f3b-no-write');
    const s = session(dir);
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    assert.ok(state.reference, 'precondition');
    // A reference is a TRIMMED extract (kilobytes) of a capture (hundreds of
    // megabytes). Copying scrubbed.har here would commit the wrong artifact,
    // and choosing the entries is the judgement the reference exists to record.
    assert.ok(!fs.existsSync(state.reference.path),
        'the promote step describes, it does not perform');
    assert.ok(!fs.existsSync(path.join(dir, 'docs')),
        'and it creates no part of the reference tree');
});

// ===========================================================================
// FALSIFIER 4 -- re-scrubbing overwrites the same file, byte for byte
// ===========================================================================

test('F4: a re-scrub overwrites one artifact rather than growing a second', () => {
    const dir = repo('f4-rescrub');
    const s = session(dir);
    inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    const firstBytes = fs.readFileSync(path.join(s.outputPath, SCRUBBED_HAR));

    inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    const againBytes = fs.readFileSync(path.join(s.outputPath, SCRUBBED_HAR));

    const hars = fs.readdirSync(s.outputPath).filter((n) => n.endsWith('.har')).sort();
    assert.deepStrictEqual(hars, ['raw.har', SCRUBBED_HAR],
        'a re-scrub must not leave a scrubbed.2.har beside the first -- the previous ' +
        `version is in the session's own history, not in a uniquified sibling: ${hars}`);
    // The scrub seeds every fake from a hash of the original, so an unchanged
    // policy over an unchanged raw produces identical bytes. That determinism
    // is what makes overwrite semantics safe: a diff means the policy changed.
    assert.ok(firstBytes.equals(againBytes),
        'the same raw under the same policy must re-scrub to identical bytes');
});

// ===========================================================================
// FALSIFIER 5 -- an explicit --output-path into a non-ignored directory warns
// ===========================================================================

test('F5: an explicit --output-path that git can see warns, names the path, and writes', () => {
    const dir = repo('f5-explicit');
    const target = path.join(dir, 'docs', 'har-reference');
    const s = session(dir, { outputPath: target });

    const warning = inDir(dir, () => capture.outputDestinationWarning(s));
    assert.ok(warning, 'a committable destination must be reported');
    assert.ok(warning.includes(s.outputPath),
        'the warning must name the RESOLVED path -- an operator cannot act on "somewhere"');
    assert.ok(/not gitignored/i.test(warning) && /untracked/i.test(warning),
        `the warning must say WHY, not merely that something is wrong: ${warning}`);

    // Warn, not refuse. Hard-failing was right while the DEFAULT was the
    // hazard; the only route here now is a destination the operator named.
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    assert.ok(fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)),
        'the run must proceed and write where it was told');
    assert.ok(fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)));
    assert.strictEqual(state.errors.length, 0, 'and it is not an error');
});

// ===========================================================================
// FALSIFIER 6 -- non-interactive with an unignored capture store hard-fails
// ===========================================================================

test('F6: a non-interactive run refuses an unignored capture store', async () => {
    const dir = unprotectedRepo('f6-unignored');
    const placement = inDir(dir, () => capture.resolveSessionPaths({
        uri: 'https://app.example.com/', cwd: dir, stamp: '2026-01-01-120000'
    })).capturePlacement;

    const refused = await capture.ensureCapturesRootIgnored(placement, { isTty: false });
    assert.strictEqual(refused.ok, false,
        'an unscrubbed, credential-bearing capture inside a visible work tree must stop the run');
    assert.ok(refused.message.includes(placement.root),
        'the refusal must name the resolved absolute path');
    assert.ok(/\.har-captures\//.test(refused.message),
        'and the rule to add');

    // The same store, once ignored, is accepted -- so the refusal is about the
    // repository's answer and not about the fixture being new.
    fs.writeFileSync(path.join(dir, '.gitignore'), '.har-captures/\n', 'utf8');
    const accepted = await capture.ensureCapturesRootIgnored(placement, { isTty: false });
    assert.strictEqual(accepted.ok, true);
});

test('F6b: an interactive run offers to add the rule, and re-asks git afterwards', async () => {
    const dir = unprotectedRepo('f6b-prompt');
    const placement = inDir(dir, () => capture.resolveSessionPaths({
        uri: 'https://app.example.com/', cwd: dir, stamp: '2026-01-01-120000'
    })).capturePlacement;

    let asked = null;
    const accepted = await capture.ensureCapturesRootIgnored(placement, {
        isTty: true,
        ask: (question) => { asked = question; return Promise.resolve('y'); }
    });
    assert.ok(asked && asked.includes(placement.root),
        'the prompt must name the resolved absolute path');
    assert.ok(/main working tree/i.test(asked),
        'and say the store belongs to the MAIN checkout, not the worktree the operator is in');
    assert.strictEqual(accepted.ok, true);
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('.har-captures/'));
    // Not a blanket *.har: docs/har-reference/**/*.har are the committed
    // artifacts, and a blanket rule makes a NEW reference un-committable until
    // somebody remembers `git add -f`.
    assert.ok(!/^\s*\*\.har\s*$/m.test(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')),
        'no blanket *.har rule may be added');

    const declined = await capture.ensureCapturesRootIgnored(
        inDir(unprotectedRepo('f6b-decline'), () => capture.resolveSessionPaths({
            uri: 'https://app.example.com/',
            cwd: path.join(tmpRoot, 'f6b-decline'),
            stamp: '2026-01-01-120000'
        })).capturePlacement,
        { isTty: true, ask: () => Promise.resolve('n') });
    assert.strictEqual(declined.ok, false, 'declining must stop the run, not proceed anyway');
});

// ===========================================================================
// FALSIFIER 7 -- the promoted reference path reaches catalogue.json's HarFile
// ===========================================================================

test('F7: the reference path is recorded in the catalogue HarFile field', () => {
    const dir = repo('f7-harfile');
    const s = session(dir, { describe: 'example: create a thing, then delete it' });
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));

    const rows = JSON.parse(fs.readFileSync(path.join(s.outputPath, CATALOGUE_FILE), 'utf8'));
    assert.ok(rows.length, 'precondition: the scaffold must have rows');
    // Without this link a committed reference cannot be paired back to the raw
    // it came from -- which is why an audit found 0 of 29 references adjudicable.
    assert.strictEqual(rows[0].HarFile, state.reference.relativePath,
        'every scaffold row must name the reference this capture would be extracted into');
    // <provider>/<filename>, NOT a bare filename. #379 resolves HarFile against
    // the committed catalogue's own directory (docs/har-reference/<host>/),
    // which is one level ABOVE the provider directory the extract lands in, so
    // a bare filename would not resolve there at all -- and would be ambiguous
    // the moment one host carries two providers.
    assert.strictEqual(rows[0].HarFile, 'example/' + state.reference.fileName,
        'HarFile is the path relative to the committed catalogue, provider directory included');
    assert.ok(!rows[0].HarFile.includes(String.fromCharCode(92)),
        'forward slashes: this is a JSON value read on every platform, not a Windows path');
});

test('F7b: the printed catalogue row names the same catalogue-relative path', () => {
    const dir = repo('f7b-row');
    const s = session(dir, { describe: 'example: create a thing, then delete it' });
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    const printed = renderNormal(Object.assign({}, s, { postProcess: state }));
    // The suggested row is pasted into the COMMITTED catalogue, so the cell it
    // offers has to be the value that catalogue accepts -- not the bare
    // filename, which verify-har-catalogue.js would report as missing.
    assert.ok(printed.includes(`| ${state.reference.relativePath} |`),
        'the suggested row must offer the catalogue-relative path');
});

// ===========================================================================
// FALSIFIER 8 -- no current.json, and stop still resolves the right session
// ===========================================================================

test('F8: there is no current.json pointer anywhere in the recorder', () => {
    // Structural, deliberately. The pointer was WRITTEN by `start`, which needs
    // a browser, so the only honest way to assert its absence without launching
    // one is to assert the name is gone from the recorder entirely.
    const source = fs.readFileSync(CAPTURE_JS, 'utf8');
    const writes = source.split('\n').filter((line) =>
        /current\.json|CURRENT_FILE/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    assert.deepStrictEqual(writes, [],
        `the shared pointer file must be gone, not merely unused: ${writes.join(' | ')}`);
});

test('F8b: stop with no --session ends the newest LIVE capture', () => {
    const root = path.join(tmpRoot, 'f8-store', '.har-captures');
    const mk = (host, stamp, session) => {
        const dir = path.join(root, host, stamp);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session), 'utf8');
        return dir;
    };
    // A live recording, and a NEWER one that has already ended. The pointer
    // file used to answer this; without it the answer must still be the
    // recording the operator is sitting in front of.
    const live = mk('a.example.com', '2026-01-01-120000', { pid: process.pid, uri: 'https://a/' });
    mk('b.example.com', '2026-01-02-120000',
        { pid: process.pid, uri: 'https://b/', endedUtc: '2026-01-02T12:05:00Z' });
    assert.strictEqual(capture.resolveSession({ dir: root }), live,
        'a live capture outranks a newer dead one');

    // Two live captures: the newest by stamp, deterministically -- strictly
    // better than "whichever run wrote the shared file last".
    const newerLive = mk('c.example.com', '2026-01-03-120000', { pid: process.pid, uri: 'https://c/' });
    assert.strictEqual(capture.resolveSession({ dir: root }), newerLive);

    // And with nothing live, the newest on disk, so `catalogue` still works
    // after every session has ended.
    const dead = path.join(tmpRoot, 'f8-dead', '.har-captures');
    fs.mkdirSync(path.join(dead, 'd.example.com', '2026-01-04-120000'), { recursive: true });
    fs.writeFileSync(path.join(dead, 'd.example.com', '2026-01-04-120000', 'session.json'),
        JSON.stringify({ pid: 1, uri: 'https://d/', endedUtc: '2026-01-04T12:05:00Z' }), 'utf8');
    assert.strictEqual(capture.resolveSession({ dir: dead }),
        path.join(dead, 'd.example.com', '2026-01-04-120000'));
});

// ===========================================================================
// FALSIFIER 9 -- the recorder prints the catalogue, not just its path
// ===========================================================================

test('F9: the run prints the catalogue rows on completion', () => {
    const dir = repo('f9-print');
    const s = session(dir, {
        entries: [
            entry('https://api.example.com/v1/thing'),
            entry('https://api.example.com/v1/thing')
        ]
    });
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    const printed = renderNormal(Object.assign({}, s, { postProcess: state }));

    // The five columns the PowerShell formatter already renders, so the two
    // entry points agree about what a catalogue looks like.
    for (const column of ['Status', 'Action', 'Methods', 'Entries', 'Endpoints']) {
        assert.ok(printed.includes(column), `the ${column} column must be printed`);
    }
    assert.ok(printed.includes('Observed'), 'and the rows themselves');
    assert.ok(printed.includes('GET'));
    assert.ok(printed.includes('api.example.com/v1/thing'));
    assert.ok(/\b2\b/.test(printed), 'including the entry count');
    // A path is not a result: the operator must not have to open a file to see
    // what was captured.
    assert.ok(printed.split('\n').length > 6,
        'a single "catalogue: <path>" line is what this replaces');
});

// ===========================================================================
// FALSIFIER 10 -- a scaffold-only catalogue says so
// ===========================================================================

test('F10: a scaffold-only catalogue says so on the recorder entry point', () => {
    const dir = repo('f10-scaffold');
    const s = session(dir);
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    const printed = renderNormal(Object.assign({}, s, { postProcess: state }));
    assert.ok(/needs its AI pass/i.test(printed),
        'an untouched scaffold read as a finished catalogue is the confusion this removes');

    // Keyed on Description, NOT on Status: a real AI pass may legitimately find
    // every group merely Observed, and telling that operator the catalogue never
    // ran would be wrong.
    const rows = JSON.parse(fs.readFileSync(path.join(s.outputPath, CATALOGUE_FILE), 'utf8'));
    rows[0].Description = 'creates a thing';
    fs.writeFileSync(path.join(s.outputPath, CATALOGUE_FILE), JSON.stringify(rows), 'utf8');
    assert.ok(rows.every((r) => r.Status === 'Observed'), 'precondition: still all Observed');
    const after = renderNormal(Object.assign({}, s, { postProcess: state }));
    assert.ok(!/needs its AI pass/i.test(after),
        'a described row means the AI pass happened, whatever the Status column says');
});

test('F10b: the catalogue command prints the same table and the same notice', () => {
    // The second node entry point. `catalogue` re-enters the pipeline against a
    // capture recorded some other time, and an operator who came in that way
    // needs the same result display.
    const dir = repo('f10b-catalogue');
    const s = session(dir);
    inDir(dir, () => capture.postProcess(s, { run: cleanGate }));

    const stderr = runCapturingStderr(dir, ['catalogue', s.sessionDir]);
    assert.ok(stderr.includes('Endpoints'), 'the catalogue command must render the table too');
    assert.ok(/needs its AI pass/i.test(stderr));
});

function runCapturingStderr(cwd, argv) {
    const r = require('child_process').spawnSync(process.execPath, [CAPTURE_JS].concat(argv), {
        cwd, encoding: 'utf8', windowsHide: true
    });
    return r.stderr || '';
}

// ===========================================================================
// FALSIFIER 11 -- no captured value reaches the printed catalogue
// ===========================================================================

test('F11: the printed catalogue carries structure and intent, never a value', () => {
    const dir = repo('f11-values');
    // Sentinels the scrubber does NOT recognise, on purpose. If the scrub were
    // what kept them off the console, this test would pass while asserting
    // nothing about the printer -- which is the shape of a mutation that
    // changes nothing.
    const s = session(dir, {
        describe: 'example: read one order',
        entries: [entry(
            'https://api.example.com/v1/users/12345/orders?token=ZZQUERYSENTINEL',
            '{"cardholder":"ZZBODYSENTINEL"}')]
    });
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    const printed = renderNormal(Object.assign({}, s, { postProcess: state }));

    assert.ok(fs.readFileSync(s.harPath, 'utf8').includes('ZZQUERYSENTINEL'),
        'precondition: the sentinels really are in the capture');

    for (const secret of ['ZZQUERYSENTINEL', 'ZZBODYSENTINEL', '12345']) {
        assert.ok(!printed.includes(secret),
            `a captured value reached the console: ${secret}`);
    }
    // What DOES appear is the template, which is the safe field the digest
    // groups on -- so the assertion above is not passing because nothing was
    // printed at all.
    assert.ok(printed.includes('api.example.com/v1/users/{id}/orders'),
        'the path TEMPLATE is what a catalogue row is for');
});

// ===========================================================================
// FALSIFIER 12 -- printed once, not twice
// ===========================================================================

test('F12: the recorder renders the catalogue table exactly once per run', () => {
    const dir = repo('f12-once');
    const s = session(dir);
    const state = inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    const printed = renderNormal(Object.assign({}, s, { postProcess: state }));
    const headers = printed.split('\n').filter((l) => /^\s*Status\s+Action\s+Methods/.test(l));
    assert.strictEqual(headers.length, 1,
        `the table must be rendered once, got ${headers.length}`);
    const notices = printed.split('\n').filter((l) => /needs its AI pass/i.test(l));
    assert.strictEqual(notices.length, 1);
});

test('F12b: the PowerShell front door renders no second copy', () => {
    // The wrapper defers to the recorder, exactly as it already does for the
    // closing notice: the recorder is the process that wrote the files, and a
    // table printed only from the wrapper would depend on that process
    // surviving long enough to reach its own epilogue.
    //
    // What the wrapper still owes its callers is the DATA -- `$rows` on the
    // success stream, which `... | ConvertTo-Json` and `... | Where-Object`
    // depend on -- not a second copy of text the operator has already read.
    const wrapper = fs.readFileSync(path.join(__dirname, 'Invoke-HarCapture.ps1'), 'utf8');
    assert.ok(!/needs its AI pass/i.test(wrapper),
        'the scaffold notice belongs to the recorder now, and must not be duplicated here');
    assert.ok(/\$rows\s*$/m.test(wrapper),
        'the pipeline contract stays: the wrapper still emits typed rows');
    assert.ok(!/&\s*node\s+\$captureJs[^\n]*2>/.test(wrapper),
        "the recorder's stderr must reach the operator, or its table and notice vanish");
});

test('F3c: the provider is the registrable label, never the suffix', () => {
    // `example.co.uk` giving `co-...har` would name every UK provider the same
    // thing, which is the collision the provider name exists to prevent.
    assert.strictEqual(capture.providerSlug('www.facebook.com'), 'facebook');
    assert.strictEqual(capture.providerSlug('example.co.uk'), 'example');
    assert.strictEqual(capture.providerSlug('api.shop.example.org'), 'example');
    assert.strictEqual(capture.providerSlug('localhost'), 'localhost');
});

test('F6c: git declining to answer is refused, and said so in its own words', async () => {
    // "not gitignored" and "git could not be asked" are different facts. Told
    // the first when the second happened, an operator edits a .gitignore that
    // was never the problem. Both refuse -- an unverified destination is not
    // assumed to be a safe one -- but they must not read the same.
    const dir = unprotectedRepo('f6c-unverifiable');
    const placement = { root: path.join(dir, '.har-captures'), mainWorkingTree: dir };
    const saved = process.env.PATH;
    const savedP = process.env.Path;
    process.env.PATH = dir;
    process.env.Path = dir;
    let result;
    try {
        result = await capture.ensureCapturesRootIgnored(placement, { isTty: true, ask: () => {
            throw new Error('must not prompt: appending a rule cannot fix an unreadable answer');
        } });
    } finally {
        process.env.PATH = saved;
        process.env.Path = savedP;
    }
    assert.strictEqual(result.ok, false);
    assert.ok(/did not answer/i.test(result.message),
        `the refusal must name the real reason: ${result.message}`);
});

// ===========================================================================
// GUARDS -- these pass on arrival. They are not evidence of a fix; they exist
// so the fix above cannot quietly take them with it.
// ===========================================================================

test('GUARD: an explicit --output-path still resolves against the working directory', () => {
    const nested = path.join(tmpRoot, 'guard-relative', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const resolved = capture.resolveSessionPaths({
        uri: 'https://app.example.com/',
        outputPath: 'refs',
        cwd: nested,
        capturesRoot: path.join(tmpRoot, 'guard-relative', '.har-captures'),
        stamp: '2026-01-01-120000'
    });
    assert.strictEqual(resolved.outputPath, path.join(nested, 'refs', 'app.example.com'));
});

test('GUARD: outside a git work tree, behaviour is unchanged', async () => {
    const plain = path.join(tmpRoot, 'guard-no-repo');
    fs.mkdirSync(plain, { recursive: true });
    const paths = capture.resolveSessionPaths({
        uri: 'https://app.example.com/', cwd: plain, stamp: '2026-01-01-120000'
    });
    assert.ok(paths.sessionDir.startsWith(path.join(plain, '.har-captures')),
        'the captures root falls back to the working directory');
    const guard = await capture.ensureCapturesRootIgnored(paths.capturePlacement, { isTty: false });
    assert.strictEqual(guard.ok, true,
        'there is no repository for `git add` to take the capture into, so nothing is refused');
});

test('GUARD: raw placement is unchanged from #367', () => {
    const dir = repo('guard-raw');
    const paths = inDir(dir, () => capture.resolveSessionPaths({
        uri: 'https://app.example.com/login',
        outputPath: path.join(dir, 'elsewhere'),
        cwd: dir,
        stamp: '2026-01-01-120000'
    }));
    assert.ok(paths.harPath.startsWith(path.join(dir, '.har-captures')),
        'no option moves the raw capture');
    assert.ok(!paths.harPath.startsWith(path.join(dir, 'elsewhere')));
});

test('GUARD: a rejected scrub quarantines in the session directory and promotes nothing', () => {
    const dir = repo('guard-reject');
    const s = session(dir);
    const state = inDir(dir, () => capture.postProcess(s, { run: rejectingGate }));
    assert.ok(fs.existsSync(path.join(s.sessionDir, 'scrubbed.rejected.har')),
        'the refused candidate is kept, where triage can reach it');
    assert.ok(!fs.existsSync(path.join(s.sessionDir, SCRUBBED_HAR)),
        'and nothing is promoted under the name that means "verified"');
    assert.ok(!fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)));
    assert.ok(!state.reference,
        'a capture the leak gate refused must not be offered for promotion');
});

test('GUARD: nothing under an existing .har-captures/ is touched but this run own session', () => {
    const dir = repo('guard-store');
    const store = path.join(dir, '.har-captures');
    // A neighbouring capture, complete with the artifacts a real one holds.
    const neighbour = path.join(store, 'other.example.com', '2025-12-31-235959');
    fs.mkdirSync(neighbour, { recursive: true });
    for (const name of ['raw.har', 'raw.ndjson', 'scrubbed.har', 'session.json']) {
        fs.writeFileSync(path.join(neighbour, name), `pinned-${name}`, 'utf8');
    }
    const before = treeOf(store);

    const s = session(dir);
    inDir(dir, () => capture.postProcess(s, { run: cleanGate }));

    const after = treeOf(store);
    const removed = before.filter((f) => !after.includes(f));
    assert.deepStrictEqual(removed, [], `files disappeared from the store: ${removed}`);
    for (const name of ['raw.har', 'raw.ndjson', 'scrubbed.har', 'session.json']) {
        assert.strictEqual(fs.readFileSync(path.join(neighbour, name), 'utf8'), `pinned-${name}`,
            `${name} in a neighbouring capture was rewritten`);
    }
    const outside = after.filter((f) =>
        !before.includes(f) && !f.startsWith('app.example.com/2026-01-01-120000/'));
    assert.deepStrictEqual(outside, [],
        `the run wrote outside its own session directory: ${outside}`);
});

test('GUARD: the digest still lands beside the catalogue', () => {
    const dir = repo('guard-digest');
    const s = session(dir);
    inDir(dir, () => capture.postProcess(s, { run: cleanGate }));
    assert.ok(fs.existsSync(path.join(s.outputPath, DIGEST_FILE)));
    assert.ok(fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)));
});

(async () => {
    let passed = 0;
    for (const { name, fn } of queued) {
        try { await fn(); passed++; } catch (e) {
            process.stderr.write(`FAIL: ${name}\n  ${e.message}\n`);
            if (e.stack) process.stderr.write(e.stack.split('\n').slice(1, 4).join('\n') + '\n');
            process.exit(1);
        }
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { void e; }
    console.log(`All capture-output-destination tests passed (${passed})`);
})();
