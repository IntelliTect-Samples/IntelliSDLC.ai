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
// Promotion is atomic -- the destination name never shows a partial write
// ---------------------------------------------------------------------------

// The invariant this whole change rests on is "a file that exists at
// outputPath has already been judged". A plain read-and-write copy breaks it
// in two ways that a rename cannot: a process killed mid-copy leaves a
// TRUNCATED scrubbed.har under the name that means "verified", with nothing
// marking it incomplete; and two captures of the same site publishing at once
// interleave their writes into one corrupted file rather than one of them
// simply winning.
//
// HOW THIS IS TESTED, and why this form. A real kill between two syscalls is
// not reproducible in-process, so the race itself is not what is asserted.
// What is asserted is the property the race would violate, driven by the one
// failure that IS inducible: publication is made to fail after the bytes have
// been written and before they take the destination name. Under a copy the
// destination has already been overwritten by then, so the previous artifact
// is gone and the assertions below fail; under write-then-rename the
// destination has never been touched. That is the same distinction a kill
// would expose, without depending on timing.
//
// fs.renameSync is patched rather than any private hook, and only for the
// published artifact's own name, so every other rename in the run still
// happens for real.
function failingPublishRename(publishedName) {
    const real = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (path.basename(to) === publishedName) throw new Error('induced: rename failed');
        return real(from, to);
    };
    return () => { fs.renameSync = real; };
}

test('a publication that fails before the rename leaves the previous artifact intact', () => {
    const dir = repo('publish-atomic');
    const first = session(dir, '2026-01-01-120000');
    inDir(dir, () => capture.postProcess(first));
    const artifact = path.join(first.outputPath, SCRUBBED_HAR);
    const kept = fs.readFileSync(artifact, 'utf8');

    // The second capture carries different traffic, so a partial or completed
    // overwrite is distinguishable from the artifact that was already there.
    const other = JSON.parse(JSON.stringify(okEntry));
    other.request.url = 'https://api.example.com/v2/somewhere-else';
    const again = session(dir, '2026-01-02-120000', [other]);

    const restore = failingPublishRename(SCRUBBED_HAR);
    let state;
    try { state = inDir(dir, () => capture.postProcess(again)); } finally { restore(); }

    assert.strictEqual(fs.readFileSync(artifact, 'utf8'), kept,
        'the destination name observed a write that never completed -- a reader, '
        + 'or `git add -A`, cannot tell that from a verified artifact');
    assert.ok(state.errors.length,
        'a publication that did not happen must be reported, not passed over');
    assert.strictEqual(state.scrubbed.path, null,
        'and the state must not claim an artifact it did not publish');
    assert.deepStrictEqual(
        fs.readdirSync(again.outputPath).sort(),
        ['catalogue.json', 'digest.json', SCRUBBED_HAR].sort(),
        'a failed publication left working files behind in a committable directory');
});

test('a successful publication leaves nothing but the artifacts', () => {
    // The mirror. Without it, "clean up the temp on failure" could be
    // implemented as "never write one" and the test above would still pass.
    const dir = repo('publish-clean');
    const s = session(dir, '2026-01-01-120000');
    inDir(dir, () => capture.postProcess(s));
    assert.deepStrictEqual(
        fs.readdirSync(s.outputPath).sort(),
        ['catalogue.json', 'digest.json', SCRUBBED_HAR].sort(),
        'publication litter survived a successful run');
});

test('a temporary file abandoned by an earlier crash is swept, a live one is not', () => {
    // Crash litter in a committable directory is the same defect class this
    // change exists to end. But a blind sweep would delete the in-flight
    // temporary of a CONCURRENT capture -- reintroducing the corruption from
    // the other side -- so only an abandoned one goes.
    const dir = repo('publish-sweep');
    const s = session(dir, '2026-01-01-120000');
    fs.mkdirSync(s.outputPath, { recursive: true });

    const stale = path.join(s.outputPath, `${capture.PUBLISH_TEMP_PREFIX}crashed`);
    const live = path.join(s.outputPath, `${capture.PUBLISH_TEMP_PREFIX}inflight`);
    fs.writeFileSync(stale, 'half a har', 'utf8');
    fs.writeFileSync(live, 'another capture, publishing right now', 'utf8');
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(stale, longAgo, longAgo);

    inDir(dir, () => capture.postProcess(s));

    assert.ok(!fs.existsSync(stale), 'an abandoned temporary was left in the output path');
    assert.ok(fs.existsSync(live),
        'a concurrent capture\'s in-flight temporary was deleted out from under it');
});

// ---------------------------------------------------------------------------
// The rename retries a transient Windows lock, and only a transient one
// ---------------------------------------------------------------------------

// Atomicity is not free on Windows, and the asymmetry is real: POSIX
// rename(2) replaces a destination even while another process holds it open,
// while Windows refuses with EPERM unless that handle was opened with
// FILE_SHARE_DELETE. A plain copy did not care. So moving to a rename bought
// the correctness guarantee at the cost of availability on the platform this
// repo primarily runs on -- real-time antivirus scanning the file that was
// just written is the everyday trigger, and an editor or a git command
// holding scrubbed.har for a moment does it too.
//
// The condition clears on its own in milliseconds, so a capture that would
// have succeeded must not be lost to it. A bounded retry recovers the
// availability without giving back the guarantee: every attempt is still a
// rename, so there is still no state in which the destination exists and is
// incomplete.
//
// The race is not what is asserted -- holding a real handle open with the
// right share mode is not reproducible across platforms. What is asserted is
// the retry itself: a rename that fails transiently N times and then succeeds,
// one that never succeeds, and one that fails for a reason that is not
// transient at all.
function countingRename(publishedName, plan) {
    const real = fs.renameSync;
    const state = { attempts: 0 };
    fs.renameSync = (from, to) => {
        if (path.basename(to) !== publishedName) return real(from, to);
        state.attempts++;
        const code = plan(state.attempts);
        if (!code) return real(from, to);
        throw Object.assign(new Error(`induced ${code}`), { code });
    };
    state.restore = () => { fs.renameSync = real; };
    return state;
}

test('a rename that is briefly locked is retried until it succeeds', () => {
    const dir = repo('rename-retry');
    const s = session(dir, '2026-01-01-120000');

    // Fails for every attempt but the last one the bound allows, so the retry
    // is exercised to its limit and still recovers the capture.
    const failures = capture.PUBLISH_RENAME_ATTEMPTS - 1;
    const rename = countingRename(SCRUBBED_HAR, (n) => (n <= failures ? 'EPERM' : null));
    let state;
    try { state = inDir(dir, () => capture.postProcess(s)); } finally { rename.restore(); }

    assert.strictEqual(rename.attempts, capture.PUBLISH_RENAME_ATTEMPTS,
        'the retry gave up before the bound it advertises');
    assert.deepStrictEqual(state.errors, [],
        'a capture was lost to a lock that cleared on its own');
    assert.ok(fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)));
    assert.strictEqual(state.scrubbed.path, path.join(s.outputPath, SCRUBBED_HAR));
    assert.deepStrictEqual(
        fs.readdirSync(s.outputPath).sort(),
        ['catalogue.json', 'digest.json', SCRUBBED_HAR].sort(),
        'a retried publication left its temporary behind');
});

test('a rename locked forever gives up, reports, and keeps the previous artifact', () => {
    // The bound is the point. Retrying until the lock clears would hang a
    // capture on a file somebody left open in an editor, which is a worse
    // failure than the one being avoided: at least an error can be read.
    const dir = repo('rename-forever');
    const first = session(dir, '2026-01-01-120000');
    inDir(dir, () => capture.postProcess(first));
    const artifact = path.join(first.outputPath, SCRUBBED_HAR);
    const kept = fs.readFileSync(artifact, 'utf8');

    const other = JSON.parse(JSON.stringify(okEntry));
    other.request.url = 'https://api.example.com/v2/elsewhere';
    const again = session(dir, '2026-01-02-120000', [other]);

    const rename = countingRename(SCRUBBED_HAR, () => 'EBUSY');
    const startedAt = Date.now();
    let state;
    try { state = inDir(dir, () => capture.postProcess(again)); } finally { rename.restore(); }
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(rename.attempts, capture.PUBLISH_RENAME_ATTEMPTS,
        'the retry is not bounded by the count it advertises');
    assert.ok(elapsed < 30000,
        `a permanently locked destination took ${elapsed}ms to surface -- an error `
        + 'nobody waits for is not an error anybody reads');
    assert.ok(state.errors.length, 'the failure must be reported');
    assert.strictEqual(fs.readFileSync(artifact, 'utf8'), kept,
        'the previous artifact was disturbed by a publication that never happened');
    assert.deepStrictEqual(
        fs.readdirSync(again.outputPath).sort(),
        ['catalogue.json', 'digest.json', SCRUBBED_HAR].sort(),
        'the temporary survived a failed publication');
});

test('a rename that fails for a non-transient reason is not retried', () => {
    // Backoff must not paper over a real permission problem. EACCES is a
    // standing condition -- waiting 400ms and asking again changes nothing
    // except how long the operator waits to be told.
    const dir = repo('rename-eacces');
    const s = session(dir, '2026-01-01-120000');

    const rename = countingRename(SCRUBBED_HAR, () => 'EACCES');
    let state;
    try { state = inDir(dir, () => capture.postProcess(s)); } finally { rename.restore(); }

    assert.strictEqual(rename.attempts, 1,
        'a non-transient error was retried, delaying the report of a real fault');
    assert.ok(state.errors.some((e) => /EACCES/.test(e)),
        `the underlying error must reach the operator: ${JSON.stringify(state.errors)}`);
    assert.ok(!fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)),
        'nothing may be published when the publication failed');
});

// ---------------------------------------------------------------------------
// A sidecar that cannot be published degrades LOUDLY, not silently
// ---------------------------------------------------------------------------

test('a findings report that cannot be published says where it actually is', () => {
    // A locked sidecar must not fail the capture -- the report is a triage aid,
    // not the gate. But the degradation has to carry a signal, and it did not:
    // the run ended with no error, no warning and scrubbed.findings null, which
    // is byte-for-byte how a CLEAN run ends. Nothing in the output path, the
    // exit code or the state distinguished "no report was needed" from
    // "advisory findings exist and their report did not make it" -- while the
    // front door went on telling the operator to read a file that was not
    // there. An agent reading the artifacts afterwards, with no console to
    // consult, could not tell the two apart at all.
    //
    // The report is not lost in this state. It is sitting complete in the
    // gitignored session directory; nothing was pointed at it.
    const dir = repo('findings-locked');
    const s = session(dir, '2026-01-01-120000');
    const rename = countingRename(FINDINGS, () => 'EBUSY');
    let state;
    try {
        state = inDir(dir, () => capture.postProcess(s, { run: verdict(4) }));
    } finally { rename.restore(); }

    // The capture itself is unharmed: artifact, digest and catalogue all land.
    assert.deepStrictEqual(state.errors, [],
        'a sidecar that could not be copied must not fail the capture');
    assert.ok(fs.existsSync(path.join(s.outputPath, SCRUBBED_HAR)));
    assert.ok(fs.existsSync(path.join(s.outputPath, 'catalogue.json')));
    assert.strictEqual(capture.postProcessExitCode(state, false), 7,
        'advisory findings still exist, so the run still reports them');

    const sessionReport = path.join(s.sessionDir, FINDINGS);
    assert.ok(state.warnings.some((w) => w.includes(sessionReport)),
        `the run must say where the report actually is: ${JSON.stringify(state.warnings)}`);
    assert.ok(state.warnings.some((w) => /could not be published/i.test(w)),
        'and must say that publishing it FAILED -- a generic warning reads like '
        + 'any other advisory notice, which is what made this invisible');
    assert.strictEqual(state.scrubbed.findings, sessionReport,
        'the state must point at the surviving report, not at nothing');

    // The console block is what the operator acts on. It was omitted entirely,
    // taking the fingerprint, the key path and the waiver guidance with it.
    const text = capture.renderLines(
        capture.postProcessLines(Object.assign({}, s, { postProcess: state })), 'normal');
    assert.ok(text.includes(sessionReport),
        `the summary must name the fallback location:\n${text}`);
    assert.ok(/credit-card/.test(text) && /amount_paid/.test(text),
        `the findings themselves must still reach the operator:\n${text}`);
    assert.ok(/\.har-policy\.project\.json|waive/.test(text),
        `and so must the escape hatch:\n${text}`);
});

// ---------------------------------------------------------------------------
// The stale findings report is removed on provenance, not on filename
// ---------------------------------------------------------------------------

test('a clean re-capture does not delete a file it did not write', () => {
    // Clearing the previous run's report keys on the report BEING one: a file
    // that merely occupies the name is somebody else's, and the output path
    // being documented as tool-owned is a convention, not a check.
    const dir = repo('foreign-report');
    const s = session(dir, '2026-01-01-120000');
    fs.mkdirSync(s.outputPath, { recursive: true });
    const foreign = path.join(s.outputPath, FINDINGS);
    fs.writeFileSync(foreign, '{"notes":"hand-written by the operator"}', 'utf8');

    inDir(dir, () => capture.postProcess(s));

    assert.ok(fs.existsSync(foreign),
        'a file the tool did not write was deleted because it had the right name');
    assert.strictEqual(JSON.parse(fs.readFileSync(foreign, 'utf8')).notes,
        'hand-written by the operator', 'and its contents must be untouched');
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
