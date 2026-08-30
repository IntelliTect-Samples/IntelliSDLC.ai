#!/usr/bin/env node
// Behavior tests for issue #297, Stage 7, tasks 7.1 and 7.2 -- non-destructive
// rejection.
//
// Zero-dep, runs with `node capture-quarantine.test.js`.
//
// What this replaces. capture-har.js used to `fs.unlinkSync` the scrubbed HAR
// whenever the leak gate refused it, so ONE false positive destroyed the whole
// capture: no scrubbed artifact, no digest, no catalogue, exit 6 and a missing
// file. The reasoning behind the delete was sound -- a known-leaking file must
// not sit in the committable output path, where `git add -A` beats an exit
// code -- and it is preserved here. The fix is WHERE the file goes, not
// whether it survives.
//
// Three properties:
//
//  1. A rejected scrub is quarantined into the session's gitignored
//     `.har-captures/` directory as `scrubbed.rejected.har`, with its findings
//     report beside it, and nothing of it reaches the output path.
//  2. Nothing under `.har-captures/` is ever destroyed -- not the raw capture,
//     and not an earlier quarantine from a previous run.
//  3. An ADVISORY-only verdict (identity class by shape) is not a rejection.
//     The artifact is verified enough to proceed: digest and catalogue are
//     produced, the artifact stays in the output path, and the findings are
//     surfaced as a warning the operator can triage or waive. A false positive
//     then costs a review step instead of the capture.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capture = require(path.join(__dirname, 'capture-har.js'));
const { initProtectedRepo } = require(path.join(__dirname, '..', 'har', 'har-test-repo.test-support.js'));

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-quarantine-')));

const queued = [];
function test(name, fn) { queued.push({ name, fn }); }

const REJECTED_HAR = 'scrubbed.rejected.har';
const FINDINGS = 'scrub-findings.json';
const SCRUBBED_HAR = 'scrubbed.har';

const okEntry = {
    startedDateTime: '2026-01-01T12:00:00Z', time: 5,
    request: {
        method: 'GET', url: 'https://api.example.com/v1/thing',
        headers: [], queryString: [], cookies: [], headersSize: 10, bodySize: 0
    },
    response: {
        status: 200, statusText: 'OK', headers: [], cookies: [], redirectURL: '',
        headersSize: 10, bodySize: 2,
        content: { size: 2, mimeType: 'application/json', text: '{}' }
    },
    cache: {}, timings: { send: 1, wait: 3, receive: 1 }
};

function har(entries) {
    return { log: { version: '1.2', creator: { name: 'q-test', version: '1' }, entries } };
}

// A repository that looks like a consumer's: the scrub refuses to write to a
// destination git will not confirm is ignored (#318), so a bare temp directory
// is not a place postProcess runs.
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
    const sessionDir = path.join(dir, '.har-captures', stamp);
    fs.mkdirSync(sessionDir, { recursive: true });
    const harPath = path.join(sessionDir, 'raw.har');
    fs.writeFileSync(harPath, JSON.stringify(har(entries || [okEntry])), 'utf8');
    return {
        uri: 'https://app.example.com/start',
        describe: null,
        sessionDir,
        harPath,
        outputPath: path.join(dir, 'docs', 'har-reference'),
        startedUtc: '2026-01-01T12:00:00Z'
    };
}

function inDir(dir, fn) {
    const cwd = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(cwd); }
}

/**
 * A stand-in for verify-scrub.js that returns a chosen verdict AND writes the
 * findings report the real one writes.
 *
 * The verdict is injected rather than provoked. sanitize-har.js and
 * verify-scrub.js apply deliberately different detectors on purpose, so a
 * value they disagree about exists -- but pinning THIS behavior to whichever
 * value currently splits them would test sanitize-har.js's pattern list rather
 * than the decision under test, and would silently stop covering it the day
 * that list grows. What verify-scrub.js actually emits is pinned next door, in
 * verify-scrub-findings.test.js; this stub only stands in for its verdict.
 *
 * sanitize still runs for real, so a scrubbed file is genuinely written and
 * "it was moved, not destroyed" has something to be wrong about.
 */
function verdict(status, findings) {
    return (script, argv) => {
        if (!script.endsWith('verify-scrub.js')) return capture.runNode(script, argv);
        const target = argv[argv.indexOf('--in') + 1];
        if (status !== 0) {
            const found = findings || [{
                kind: 'credit-card', class: 'identity', setting: 'advise',
                disposition: status === 4 ? 'advisory' : 'gating',
                keyPath: 'response.content.text.amount_paid', entryIndex: 0,
                count: 3, fingerprint: '9bbef1947662', length: 16
            }];
            const identity = found.filter((f) => f.class === 'identity');
            fs.writeFileSync(path.join(path.dirname(target), FINDINGS), JSON.stringify({
                schemaVersion: 1,
                verdict: status === 4 ? 'advisory' : 'gating',
                findings: found,
                suggestedPolicyFragment: identity.length
                    ? { waivers: identity.map((f) => ({ kind: f.kind, fingerprint: f.fingerprint, reason: '' })) }
                    : null
            }, null, 2), 'utf8');
        }
        return {
            ok: status === 0, status,
            stdout: '',
            stderr: status === 0 ? '' : `verify-scrub: ${status === 4 ? 'advisory' : 'blocking'} finding`
        };
    };
}

// ---------------------------------------------------------------------------
// 7.1 -- a rejected scrub is quarantined, not shredded
// ---------------------------------------------------------------------------

test('a rejected scrub is moved into the session directory, not deleted', () => {
    const dir = repo('reject');
    const s = session(dir, '2026-01-01-120000');
    const state = inDir(dir, () => capture.postProcess(s, { run: verdict(3) }));

    const quarantined = path.join(s.sessionDir, REJECTED_HAR);
    assert.ok(fs.existsSync(quarantined),
        'the rejected scrub must survive, under the gitignored captures root');
    const doc = JSON.parse(fs.readFileSync(quarantined, 'utf8'));
    assert.ok(doc.log && Array.isArray(doc.log.entries),
        'the quarantined file must be the scrubbed HAR itself, not a stub');

    assert.ok(fs.existsSync(path.join(s.sessionDir, FINDINGS)),
        'the findings report must land beside the quarantined artifact');

    assert.ok(!fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)),
        'a scrub the gate rejected must not be left in the committable output path');
    assert.ok(!fs.existsSync(path.join(s.outputPath, 'digest.json')),
        'no digest may be derived from a capture that failed the leak gate');
    assert.ok(!fs.existsSync(path.join(s.outputPath, 'catalogue.json')));

    assert.ok(fs.existsSync(s.harPath), 'the raw capture is always kept');
    assert.ok(state.errors.length, 'and the rejection must be reported');
    assert.strictEqual(state.scrubbed.path, null, 'no committable artifact is claimed');
    assert.strictEqual(state.scrubbed.quarantined, quarantined,
        'the state must name where the artifact went, or the operator cannot find it');
    assert.strictEqual(state.scrubbed.findings, path.join(s.sessionDir, FINDINGS));
});

test('the console names the quarantine and the findings report', () => {
    const dir = repo('reject-lines');
    const s = session(dir, '2026-01-01-120000');
    const state = inDir(dir, () => capture.postProcess(s, { run: verdict(3) }));

    const lines = capture.postProcessLines(Object.assign({}, s, { postProcess: state }));
    const text = lines.map((l) => l[1]).join('\n');
    assert.ok(!/deleted/i.test(text),
        'the summary still claims the artifact was deleted');
    assert.ok(text.includes(REJECTED_HAR),
        `the summary must name the quarantined file:\n${text}`);
    assert.ok(text.includes(FINDINGS),
        `the summary must name the findings report:\n${text}`);
    assert.ok(lines.some((l) => l[0] === 'warn' && l[1].includes(REJECTED_HAR)),
        'a rejected scrub must be announced at warn level, which no threshold suppresses');
});

test('an earlier quarantine is never overwritten', () => {
    // Nothing under .har-captures/ is ever destroyed. A second rejection in a
    // session that already holds one must add a file, not replace one -- the
    // first is the evidence for whatever the operator is still triaging.
    const dir = repo('reject-twice');
    const s = session(dir, '2026-01-01-120000');
    const first = path.join(s.sessionDir, REJECTED_HAR);
    fs.writeFileSync(first, '{"log":{"entries":[],"comment":"an earlier rejection"}}', 'utf8');
    const before = fs.readFileSync(first, 'utf8');

    const state = inDir(dir, () => capture.postProcess(s, { run: verdict(3) }));

    assert.strictEqual(fs.readFileSync(first, 'utf8'), before,
        'the earlier quarantine was clobbered');
    assert.ok(state.scrubbed.quarantined !== first,
        'the new quarantine must take a distinct name');
    assert.ok(fs.existsSync(state.scrubbed.quarantined),
        'and it must actually be there');
    assert.strictEqual(path.dirname(state.scrubbed.quarantined), s.sessionDir,
        'the quarantine stays inside the session directory');
});

test('a rejected re-capture leaves an earlier verified artifact intact', () => {
    // The awkward one. A previously good scrubbed.har, digest and catalogue
    // already sit in the output path. A re-capture whose scrub is rejected
    // must neither overwrite them with a leaking file nor orphan the digest by
    // taking the artifact away.
    const dir = repo('reject-over-good');
    const good = session(dir, '2026-01-01-120000');
    const clean = inDir(dir, () => capture.postProcess(good));
    assert.strictEqual(clean.errors.length, 0, 'precondition: the first capture is clean');
    const artifact = path.join(good.outputPath, SCRUBBED_HAR);
    assert.ok(fs.existsSync(artifact), 'precondition: a verified artifact exists');
    const kept = fs.readFileSync(artifact, 'utf8');
    const digest = fs.readFileSync(path.join(good.outputPath, 'digest.json'), 'utf8');

    const again = session(dir, '2026-01-02-120000');
    const state = inDir(dir, () => capture.postProcess(again, { run: verdict(3) }));

    assert.strictEqual(fs.readFileSync(artifact, 'utf8'), kept,
        'the rejected re-capture overwrote a verified artifact');
    assert.strictEqual(fs.readFileSync(path.join(good.outputPath, 'digest.json'), 'utf8'), digest,
        'the digest that describes the surviving artifact was disturbed');
    assert.ok(fs.existsSync(state.scrubbed.quarantined),
        'and the rejected scrub is still quarantined for triage');
});

// ---------------------------------------------------------------------------
// Advisory-only -- the artifact survives in place
// ---------------------------------------------------------------------------

test('an advisory-only verdict keeps the artifact and still produces the catalogue', () => {
    const dir = repo('advisory');
    const s = session(dir, '2026-01-01-120000');
    const state = inDir(dir, () => capture.postProcess(s, { run: verdict(4) }));

    assert.ok(fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)),
        'an advisory finding must not cost the operator the artifact');
    assert.ok(fs.existsSync(path.join(s.outputPath, 'digest.json')),
        'nor the digest -- an identity shape is evidence, not a certainty');
    assert.ok(fs.existsSync(path.join(s.outputPath, 'catalogue.json')),
        'nor the catalogue, which is the deliverable');
    assert.ok(!fs.existsSync(path.join(s.sessionDir, REJECTED_HAR)),
        'nothing was rejected, so nothing is quarantined');
    assert.strictEqual(state.scrubbed.advisory, true);
    assert.deepStrictEqual(state.errors, [],
        'an advisory finding is a warning, not a failure');
    assert.ok((state.warnings || []).length,
        'but it must not be silent either');
});

test('the advisory warning is triageable -- kind, location, count and the escape', () => {
    // "credit-card, 1413 occurrences" with no location is the report that
    // taught operators to ignore the gate. With a key path, an entry index and
    // a count it is one pass of triage.
    const dir = repo('advisory-lines');
    const s = session(dir, '2026-01-01-120000');
    const state = inDir(dir, () => capture.postProcess(s, { run: verdict(4) }));

    const lines = capture.postProcessLines(Object.assign({}, s, { postProcess: state }));
    const text = lines.map((l) => l[1]).join('\n');
    assert.ok(/credit-card/.test(text), `the kind is missing:\n${text}`);
    assert.ok(/amount_paid/.test(text), `the key path is missing:\n${text}`);
    assert.ok(/entry 0/.test(text), `the entry index is missing:\n${text}`);
    assert.ok(/x3|\bx?3\b/.test(text), `the occurrence count is missing:\n${text}`);
    assert.ok(/9bbef1947662/.test(text), `the fingerprint is missing:\n${text}`);
    assert.ok(/waive|\.har-policy\.project\.json/.test(text),
        `the escape hatch is not named, so the warning is not actionable:\n${text}`);
    assert.ok(lines.some((l) => l[0] === 'warn' && /credit-card/.test(l[1])),
        'advisory findings must be announced at warn level');
});

test('the findings report is copied beside the artifact it describes', () => {
    const dir = repo('advisory-report');
    const s = session(dir, '2026-01-01-120000');
    const state = inDir(dir, () => capture.postProcess(s, { run: verdict(4) }));
    assert.ok(fs.existsSync(path.join(s.outputPath, FINDINGS)),
        'the operator reads the report next to the artifact, not by hunting the session dir');
    assert.strictEqual(state.scrubbed.findings, path.join(s.outputPath, FINDINGS));
});

test('a clean re-capture clears the previous run\'s findings report', () => {
    // A report describes one run. Left in the committable path by a re-capture
    // that came back clean, it still reads as current -- the same disease as a
    // digest built from an unverified capture: it looks like information.
    const dir = repo('stale-report');
    const first = session(dir, '2026-01-01-120000');
    inDir(dir, () => capture.postProcess(first, { run: verdict(4) }));
    assert.ok(fs.existsSync(path.join(first.outputPath, FINDINGS)), 'precondition');

    const again = session(dir, '2026-01-02-120000');
    const state = inDir(dir, () => capture.postProcess(again));
    assert.strictEqual(state.scrubbed.verified, true, 'precondition: the re-capture is clean');
    assert.ok(!fs.existsSync(path.join(again.outputPath, FINDINGS)),
        'a stale findings report survived a clean re-capture');
});

test('a gating finding alongside an advisory one still quarantines', () => {
    // The verdict is not a majority vote. A capture carrying both must be
    // treated as the worse of the two, or a live secret rides out on the
    // lenient branch.
    const dir = repo('both');
    const s = session(dir, '2026-01-01-120000');
    const state = inDir(dir, () => capture.postProcess(s, {
        run: verdict(3, [
            {
                kind: 'hex32', class: 'secret', setting: 'gate', disposition: 'gating',
                keyPath: 'response.content.text.blob', entryIndex: 0, count: 1,
                fingerprint: 'aaaaaaaaaaaa', length: 32
            },
            {
                kind: 'credit-card', class: 'identity', setting: 'advise',
                disposition: 'advisory', keyPath: 'response.content.text.amount_paid',
                entryIndex: 0, count: 1, fingerprint: 'bbbbbbbbbbbb', length: 16
            }
        ])
    }));

    assert.ok(fs.existsSync(state.scrubbed.quarantined),
        'a secret in the same capture must still send the artifact to quarantine');
    assert.ok(!fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)));
    assert.ok(!fs.existsSync(path.join(s.outputPath, 'catalogue.json')));
});

// ---------------------------------------------------------------------------
// The exit code the wrapper reads
// ---------------------------------------------------------------------------

test('advisory findings do not report as success, and are not reported as failure', () => {
    assert.strictEqual(capture.postProcessExitCode({ errors: [], warnings: [] }, false), 0);
    assert.strictEqual(capture.postProcessExitCode({ errors: ['boom'], warnings: [] }, false), 6,
        'a rejected scrub is still a failure');
    assert.strictEqual(capture.postProcessExitCode({ errors: [], warnings: ['card?'] }, false), 7,
        'an advisory finding must not read as a clean capture to a CI step');
    assert.strictEqual(capture.postProcessExitCode({ errors: ['boom'], warnings: ['card?'] }, false), 6,
        'a failure outranks a warning');
    assert.strictEqual(capture.postProcessExitCode({ errors: [], warnings: [] }, true), 5,
        'and the assembled-from-log signal survives');
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
    console.log(`All capture-quarantine tests passed (${passed})`);
})();
