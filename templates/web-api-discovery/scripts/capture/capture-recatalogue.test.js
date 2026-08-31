#!/usr/bin/env node
// Behavior tests for issue #352 -- the pipeline is re-enterable at the
// CATALOGUE stage.
//
// Zero-dep, runs with `node capture-recatalogue.test.js`.
//
// The gap. `capture-har.js` had exactly three commands -- start, stop, status
// -- and the digest/catalogue phases were reachable only as a side effect of a
// full recording. Scrubbing alone was already possible (Invoke-SanitizeHar.ps1
// wraps sanitize-har.js + verify-scrub.js). Cataloguing alone was possible in
// no way at all: an operator who wanted the catalogue regenerated had to
// re-record the browser session, which for a hand-driven capture is not a
// repeat of anything.
//
// That matters since #343. A rejected scrub is now quarantined rather than
// destroyed, and an advisory finding can be waived and the run repeated -- but
// "repeat the run" meant "capture the traffic again".
//
// What is added is an ENTRY POINT, and nothing else. The `catalogue` command
// runs the SAME digest + decideCatalogueRunner path a full capture runs. It
// does not re-decide who catalogues, it does not promote or quarantine
// anything, and it does not restate a single one of #343's invariants -- those
// stay where they are.
//
// The properties pinned here:
//
//  1. The entry point exists and is reachable from the command line.
//  2. Re-entry regenerates the digest and the catalogue from an already
//     published scrubbed HAR, with nothing recorded.
//  3. Invariant 4 survives the new door: a HAR that did not pass the leak gate
//     produces NO digest and NO catalogue, whichever door it arrives at.
//  4. A session whose scrub was rejected (verify exit 3, quarantined) has
//     nothing catalogueable, and says so.
//  5. An advisory verdict (verify exit 4) still carries exit 7 through the new
//     command, exactly as it does through a full capture.
//  6. An existing catalogue is never clobbered.
//  7. The delegation decision has ONE implementation. The command routes
//     through decideCatalogueRunner rather than owning a second copy of it.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const captureJs = path.join(__dirname, 'capture-har.js');
const capture = require(captureJs);
const { initProtectedRepo } = require(path.join(__dirname, '..', 'har', 'har-test-repo.test-support.js'));

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-recatalogue-')));

const queued = [];
function test(name, fn) { queued.push({ name, fn }); }

const SCRUBBED_HAR = 'scrubbed.har';
const REJECTED_HAR = 'scrubbed.rejected.har';
const DIGEST_FILE = 'digest.json';
const CATALOGUE_FILE = 'catalogue.json';
const SESSION_FILE = 'session.json';

function entry(url, extra) {
    return Object.assign({
        startedDateTime: '2026-01-01T12:00:00Z', time: 5,
        request: {
            method: 'GET', url,
            headers: [], queryString: [], cookies: [], headersSize: 10, bodySize: 0
        },
        response: {
            status: 200, statusText: 'OK', headers: [], cookies: [], redirectURL: '',
            headersSize: 10, bodySize: 2,
            content: { size: 2, mimeType: 'application/json', text: '{}' }
        },
        cache: {}, timings: { send: 1, wait: 3, receive: 1 }
    }, extra || {});
}

const okEntry = entry('https://api.example.com/v1/thing');

// A HAR nobody scrubbed: it still carries the Authorization header a live
// session hands out. This is the "catalogue something that was never scrubbed"
// shape, and it has to be built deliberately -- a generator that cannot express
// it cannot falsify the rule that refuses it.
const rawEntry = entry('https://api.example.com/v1/thing', {
    request: {
        method: 'GET', url: 'https://api.example.com/v1/thing',
        headers: [{ name: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXBheWxvYWQ.7Qk3vZ1xY9' }],
        queryString: [], cookies: [], headersSize: 10, bodySize: 0
    }
});

// Identity evidence by SHAPE and nothing worse: verify-scrub.js exits 4 on it.
// A published, gate-passed artifact can legitimately contain this -- keeping it
// instead of shredding the capture over it is the whole of #343.
const advisoryEntry = entry('https://api.example.com/v1/thing', {
    response: {
        status: 200, statusText: 'OK', headers: [], cookies: [], redirectURL: '',
        headersSize: 10, bodySize: 2,
        content: {
            size: 2, mimeType: 'application/json',
            text: JSON.stringify({ amount_paid: '4539578763621486' })
        }
    }
});

function har(entries) {
    return { log: { version: '1.2', creator: { name: 'recat-test', version: '1' }, entries } };
}

// A repository that looks like a consumer's: the scrub refuses to write to a
// destination git will not confirm is ignored (#318).
function repo(name) {
    const dir = path.join(tmpRoot, name);
    initProtectedRepo(dir);
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'test-salt',
        literals: { 'operator@example.com': '<UserEmail>' }
    }), 'utf8');
    return dir;
}

function session(dir, stamp, entries) {
    const sessionDir = path.join(dir, '.har-captures', 'app.example.com', stamp);
    fs.mkdirSync(sessionDir, { recursive: true });
    const harPath = path.join(sessionDir, 'raw.har');
    fs.writeFileSync(harPath, JSON.stringify(har(entries || [okEntry])), 'utf8');
    const s = {
        uri: 'https://app.example.com/start',
        describe: 'the worked flow',
        sessionDir,
        harPath,
        outputPath: path.join(dir, 'docs', 'har-reference'),
        startedUtc: '2026-01-01T12:00:00Z'
    };
    fs.writeFileSync(path.join(sessionDir, SESSION_FILE), JSON.stringify(s, null, 2), 'utf8');
    return s;
}

function inDir(dir, fn) {
    const cwd = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(cwd); }
}

/** As in capture-quarantine.test.js: inject verify-scrub's verdict, run the real scrub. */
function verdict(status) {
    return (script, argv) => {
        if (!script.endsWith('verify-scrub.js')) return capture.runNode(script, argv);
        const target = argv[argv.indexOf('--in') + 1];
        if (status !== 0) {
            fs.writeFileSync(path.join(path.dirname(target), 'scrub-findings.json'), JSON.stringify({
                schemaVersion: 1,
                verdict: status === 4 ? 'advisory' : 'gating',
                findings: [{
                    disposition: status === 4 ? 'advisory' : 'gating',
                    kind: 'credit-card', class: 'identity', setting: 'advise',
                    keyPath: null, entryIndex: 0, count: 1,
                    fingerprint: '9bbef1947662', length: 16
                }],
                suggestedPolicyFragment: null
            }, null, 2), 'utf8');
        }
        return {
            ok: status === 0, status, stdout: '',
            stderr: status === 0 ? '' : `verify-scrub: ${status === 4 ? 'advisory' : 'blocking'} finding`
        };
    };
}

/** A published, gate-passed capture: exactly what a re-entry starts from. */
function published(dir, stamp, opts) {
    const s = session(dir, stamp || '2026-01-01-120000');
    const state = inDir(dir, () => capture.postProcess(s, opts || {}));
    return { session: s, state };
}

/** Capture what the command writes to stderr, which is where all of it goes. */
function withStderr(onLine, fn) {
    const original = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
        onLine(String(chunk));
        return original.call(process.stderr, chunk, ...rest);
    };
    try { return fn(); } finally { process.stderr.write = original; }
}

function withEnv(overrides, fn) {
    const saved = {};
    for (const k of Object.keys(overrides)) {
        saved[k] = process.env[k];
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    try { return fn(); } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

// The command must run with no agent env leaking in from whoever ran the
// suite: CLAUDECODE set in the ambient shell would pin every case to the
// `agent` branch and quietly stop covering the others.
const NO_AGENT = { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined };

function runCatalogue(dir, args, env) {
    return withEnv(Object.assign({}, NO_AGENT, env || {}),
        () => inDir(dir, () => capture.catalogueCommand(args)));
}

// ---------------------------------------------------------------------------
// 1 -- the entry point exists, from the command line
// ---------------------------------------------------------------------------

test('`capture-har.js catalogue` is a command, not a usage error', () => {
    const dir = repo('cli-wired');
    const { session: s } = published(dir);
    const target = path.join(s.outputPath, SCRUBBED_HAR);
    assert.ok(fs.existsSync(target), 'fixture: the capture must have published a scrubbed HAR');
    fs.rmSync(path.join(s.outputPath, DIGEST_FILE));
    fs.rmSync(path.join(s.outputPath, CATALOGUE_FILE));

    const run = spawnSync(process.execPath, [captureJs, 'catalogue', target], {
        cwd: dir, encoding: 'utf8', windowsHide: true,
        env: Object.assign({}, process.env, { CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' })
    });
    assert.notStrictEqual(run.status, 2,
        `'catalogue' must be a real command, not an unknown one:\n${run.stderr}`);
    assert.strictEqual(run.status, 0,
        `cataloguing a verified capture must succeed:\n${run.stderr}`);
    assert.ok(fs.existsSync(path.join(s.outputPath, DIGEST_FILE)),
        'the digest must be rebuilt by the command line entry point');
    assert.ok(fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)),
        'and so must the catalogue');
});

// ---------------------------------------------------------------------------
// 2 -- re-entry, with nothing recorded
// ---------------------------------------------------------------------------

test('re-entry rebuilds the digest and catalogue without recording anything', () => {
    const dir = repo('re-enter');
    const { session: s } = published(dir);
    const before = JSON.parse(fs.readFileSync(path.join(s.outputPath, DIGEST_FILE), 'utf8'));
    const rawBytes = fs.statSync(s.harPath).size;

    fs.rmSync(path.join(s.outputPath, CATALOGUE_FILE));

    const code = runCatalogue(dir, { _: [s.outputPath] });
    assert.strictEqual(code, 0, 'a verified capture catalogues cleanly');

    const after = JSON.parse(fs.readFileSync(path.join(s.outputPath, DIGEST_FILE), 'utf8'));
    assert.strictEqual(after.entryCount, before.entryCount,
        're-entry must derive the same digest from the same scrubbed capture');
    assert.deepStrictEqual(after.groups, before.groups);
    assert.strictEqual(after.capturedUtc, before.capturedUtc,
        'capturedUtc is when the RECORDING happened -- re-cataloguing must not re-date it');
    assert.strictEqual(after.uri, before.uri,
        'and the capture it came from must not be forgotten on the way through the new door');

    assert.ok(fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)));
    assert.strictEqual(fs.statSync(s.harPath).size, rawBytes,
        'nothing under .har-captures/ may be touched by a catalogue-only run');
});

test('re-entry through the session directory recovers the capture it belongs to', () => {
    // The awkward half of the same case: BOTH derived artifacts are gone, so
    // there is no previous digest to inherit from. Pointed at the session, the
    // command has session.json -- and must use it, because a digest that dates
    // the capture to the day somebody regenerated its catalogue answers "how
    // old is this evidence of their API" with the wrong number.
    const dir = repo('re-enter-session');
    const { session: s } = published(dir);
    const before = JSON.parse(fs.readFileSync(path.join(s.outputPath, DIGEST_FILE), 'utf8'));
    fs.rmSync(path.join(s.outputPath, DIGEST_FILE));
    fs.rmSync(path.join(s.outputPath, CATALOGUE_FILE));

    const code = runCatalogue(dir, { _: [s.sessionDir] });
    assert.strictEqual(code, 0);

    const after = JSON.parse(fs.readFileSync(path.join(s.outputPath, DIGEST_FILE), 'utf8'));
    assert.strictEqual(after.capturedUtc, s.startedUtc,
        'the session knows when it recorded; a re-catalogue must not re-date the capture');
    assert.strictEqual(after.uri, before.uri);
    assert.strictEqual(after.describe, s.describe,
        "and the operator's intent hint must survive the second door");
    assert.deepStrictEqual(after.groups, before.groups);
});

// ---------------------------------------------------------------------------
// 3 -- invariant 4 survives the new door
// ---------------------------------------------------------------------------

test('a HAR that was never scrubbed produces no digest and no catalogue', () => {
    // The awkward case the entry point makes possible for the first time:
    // pointing the catalogue phase at a capture the leak gate has not passed.
    // "The digest and catalogue derive from the SCRUBBED capture, and are not
    // produced when the scrub did not verify" is not a property of the capture
    // path -- it is a property of the pipeline, and it has to hold at every
    // door into it.
    const dir = repo('never-scrubbed');
    const out = path.join(dir, 'docs', 'har-reference');
    fs.mkdirSync(out, { recursive: true });
    const unscrubbed = path.join(out, 'not-scrubbed.har');
    fs.writeFileSync(unscrubbed, JSON.stringify(har([rawEntry])), 'utf8');

    const code = runCatalogue(dir, { _: [unscrubbed] });
    assert.strictEqual(code, 6,
        'a capture the leak gate refuses must fail the way a refused capture fails');
    assert.ok(!fs.existsSync(path.join(out, DIGEST_FILE)),
        'no digest may be derived from a capture that failed the leak gate');
    assert.ok(!fs.existsSync(path.join(out, CATALOGUE_FILE)),
        'and no catalogue either -- a catalogue of a leaking capture looks safe');
});

test('a session whose scrub was rejected has nothing to catalogue, and says so', () => {
    const dir = repo('rejected-session');
    const { session: s, state } = published(dir, '2026-01-01-120000', { run: verdict(3) });
    assert.ok(fs.existsSync(path.join(s.sessionDir, REJECTED_HAR)),
        'fixture: the rejection must have quarantined the candidate');
    assert.ok(!fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)),
        'fixture: and left nothing in the output path');
    assert.ok(state.errors.length);

    let said = '';
    const code = withStderr((line) => { said += line; },
        () => runCatalogue(dir, { _: [s.sessionDir] }));
    assert.notStrictEqual(code, 0,
        'cataloguing a session the gate rejected must not report success');
    // "It is not here" is not enough. The operator arrived at this door BECAUSE
    // a scrub was refused, so the answer has to name the quarantined evidence
    // #343 kept for them -- otherwise the run reads as a missing file and the
    // triage they came to do never starts.
    assert.ok(said.includes(REJECTED_HAR) && said.includes(s.sessionDir),
        `the refusal must name the quarantined artifact:
${said}`);
    assert.ok(!fs.existsSync(path.join(s.outputPath, DIGEST_FILE)));
    assert.ok(!fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)));
    assert.ok(fs.existsSync(path.join(s.sessionDir, REJECTED_HAR)),
        'and the quarantined evidence must still be there afterwards');
});

// ---------------------------------------------------------------------------
// 5 -- the advisory verdict carries through the new command unchanged
// ---------------------------------------------------------------------------

test('an advisory scrub can be re-catalogued, and still exits 7', () => {
    // The #343 loop end to end: verify exits 4, the artifact is KEPT and
    // published, and the operator re-runs the catalogue stage over it. The
    // advisory verdict must survive the second door -- a zero here would read
    // as clean to every wrapper and CI step that only asks whether this
    // succeeded.
    const dir = repo('advisory');
    const { session: s, state } = published(dir, '2026-01-01-120000', { run: verdict(4) });
    assert.ok(state.warnings.length, 'fixture: an advisory verdict warns');
    assert.ok(fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)),
        'fixture: an advisory verdict KEEPS the artifact -- that is what #343 changed');
    fs.rmSync(path.join(s.outputPath, DIGEST_FILE));
    fs.rmSync(path.join(s.outputPath, CATALOGUE_FILE));

    // The published artifact carries the value the gate advised on. The scrub
    // stage's verdict was injected above (as in capture-quarantine.test.js,
    // and for the same reason), but the CATALOGUE stage asks the real gate --
    // it has to, since a HAR arriving at this door may never have been scrubbed
    // at all. So the artifact must genuinely provoke exit 4 rather than being
    // told to: a Luhn-valid, valid-IIN 16-digit run, which is identity evidence
    // by SHAPE and is a card, a trip id, or nothing.
    fs.writeFileSync(path.join(s.outputPath, SCRUBBED_HAR),
        JSON.stringify(har([advisoryEntry])), 'utf8');

    const code = runCatalogue(dir, { _: [s.outputPath] });
    assert.strictEqual(code, 7,
        'advisory findings must not read as a clean run through the catalogue command either');
    assert.ok(fs.existsSync(path.join(s.outputPath, DIGEST_FILE)),
        'an advisory verdict still produces the digest -- the artifact was kept');
    assert.ok(fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)));
});

// ---------------------------------------------------------------------------
// 6 -- an existing catalogue is never clobbered
// ---------------------------------------------------------------------------

test('a catalogue that carries work is never replaced by a second AI pass', () => {
    // Cataloguing is an AI pass over the digest, not a recomputation: two runs
    // may group the same session differently. So a catalogue somebody reviewed
    // -- or corrected by hand, which is the case with no other copy anywhere --
    // must not be silently replaced by a fresh one.
    const dir = repo('keep-catalogue');
    const { session: s } = published(dir);
    const cataloguePath = path.join(s.outputPath, CATALOGUE_FILE);
    const finished = [{
        Action: 'list-things', Description: 'the operator listed the things',
        Methods: ['GET'], Endpoints: ['api.example.com/v1/thing'], EntryCount: 1,
        Status: 'Exercised', HarFile: 'list-things.har', CapturedUtc: '2026-01-01T12:00:00Z'
    }];
    fs.writeFileSync(cataloguePath, JSON.stringify(finished, null, 2), 'utf8');
    const digestBefore = fs.readFileSync(path.join(s.outputPath, DIGEST_FILE), 'utf8');

    let said = '';
    const code = withStderr((line) => { said += line; },
        () => runCatalogue(dir, { _: [s.outputPath] }));

    assert.strictEqual(code, 2,
        'a refusal to overwrite reviewed work must be reported, not swallowed as success');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cataloguePath, 'utf8')), finished,
        'a described catalogue must survive a catalogue-only re-run untouched');
    assert.strictEqual(fs.readFileSync(path.join(s.outputPath, DIGEST_FILE), 'utf8'), digestBefore,
        'and the run must write NOTHING, not merely spare the catalogue');
    // A refusal the operator cannot act on is an obstruction, not a safeguard.
    assert.ok(/move the existing file aside|--output-path/.test(said),
        `the refusal must say how to catalogue afresh:
${said}`);
});

test('a scaffold nobody has worked on is regenerated without comment', () => {
    // The other half, and the case this command exists for: the advisory loop
    // is capture, waive a false positive, catalogue again -- and by then a
    // scaffold is already sitting in the output path. Refusing on EXISTENCE
    // rather than on work would block the common path to protect the rare one.
    const dir = repo('scaffold-rerun');
    const { session: s } = published(dir);
    const cataloguePath = path.join(s.outputPath, CATALOGUE_FILE);
    const scaffold = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
    assert.ok(scaffold.length && scaffold.every((r) => !r.Description),
        'fixture: a scaffold is exactly a catalogue with nothing described in it');

    const code = runCatalogue(dir, { _: [s.outputPath] });
    assert.strictEqual(code, 0,
        'a scaffold carries no work, so re-cataloguing over it is not destructive');
    assert.ok(fs.existsSync(path.join(s.outputPath, DIGEST_FILE)),
        'and the run must actually do its work rather than decline');
});

// ---------------------------------------------------------------------------
// 7 -- one delegation decision, not two
// ---------------------------------------------------------------------------

test('inside Claude Code the command delegates to the calling agent', () => {
    const dir = repo('branch-agent');
    const { session: s } = published(dir);
    fs.rmSync(path.join(s.outputPath, CATALOGUE_FILE));

    let said = '';
    const code = withStderr((line) => { said += line; },
        () => runCatalogue(dir, { _: [s.outputPath] }, { CLAUDECODE: '1' }));
    assert.strictEqual(code, 0);
    // The branch actually taken, not merely an artifact both branches produce.
    // A scaffold is written by every runner, so asserting one exists cannot
    // tell 'agent' from 'none' -- and a case that cannot tell them apart is
    // not covering either.
    assert.ok(/catalogue:.*\(agent\)/.test(said),
        `the run must report that it delegated to the calling agent:
${said}`);
    const rows = JSON.parse(fs.readFileSync(path.join(s.outputPath, CATALOGUE_FILE), 'utf8'));
    assert.ok(Array.isArray(rows) && rows.length,
        'the scaffold the agent fills in must be written for it');
    assert.ok(rows.every((r) => r.Status === 'Observed'),
        'and nothing may be claimed exercised before the agent has run');
});

test('with no agent and no TTY the catalogue is left visibly pending', () => {
    const dir = repo('branch-none');
    const { session: s } = published(dir);
    fs.rmSync(path.join(s.outputPath, CATALOGUE_FILE));

    let said = '';
    const code = withStderr((line) => { said += line; },
        () => runCatalogue(dir, { _: [s.outputPath] }));
    assert.strictEqual(code, 0, 'no runner is not a failure -- the step is outstanding, not lost');
    assert.ok(fs.existsSync(path.join(s.outputPath, CATALOGUE_FILE)),
        'the scaffold is what makes the pending step visible');
    assert.ok(/catalogue:.*\(none\)/.test(said),
        `the run must report that no runner was available:
${said}`);
    assert.ok(/no AI runner available/.test(said),
        'and say so in words, so the step is visibly outstanding rather than silently dropped');
});

test("the claude-cli branch is still the decision function's to make", () => {
    const decision = capture.decideCatalogueRunner({
        env: {}, isTty: true, claudeOnPath: true
    });
    assert.strictEqual(decision.delegatedTo, 'claude-cli');
    assert.strictEqual(decision.pending, false);
    assert.ok(fs.existsSync(decision.promptPath), 'the prompt an AI reads must exist');
});

test('the delegation decision has exactly one call site', () => {
    // The two-engines defect this subsystem has spent a dozen PRs removing.
    // The catalogue command is an ENTRY POINT to code that already exists: if
    // it grows a second copy of "who runs the catalogue", the two drift and the
    // console starts disagreeing with itself about what happened.
    const src = fs.readFileSync(captureJs, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');
    // The DECLARATION matches the same shape a call does, so it is excluded
    // explicitly. A guard that counts its own subject is a guard that reports a
    // number nobody can act on.
    const calls = code.match(/(?<!function\s)decideCatalogueRunner\s*\(/g) || [];
    assert.strictEqual(calls.length, 1,
        `decideCatalogueRunner must be CALLED once (found ${calls.length}); ` +
        'the catalogue command invokes the existing path, it does not re-decide it');
    assert.ok(/function decideCatalogueRunner\s*\(/.test(code),
        'and there must be exactly one of it to call');
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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`All capture-recatalogue tests passed (${passed})`);
})();
