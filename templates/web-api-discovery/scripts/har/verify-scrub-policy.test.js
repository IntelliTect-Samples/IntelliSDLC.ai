#!/usr/bin/env node
// End-to-end behavior tests for verify-scrub under a project policy
// (issue #297, Stage 4 -- the wiring).
//
// Zero-dep, runs with `node verify-scrub-policy.test.js`.
//
// This is the contract a consuming project actually depends on: which findings
// stop a capture, which are merely reported, and whether a loosening the
// project chose is visible in the output. The unit tests pin the predicates;
// this pins what the exit code does, because that is what capture-har.js reads
// -- and today a non-zero exit still DELETES the scrubbed artifact.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const verify = path.join(__dirname, 'verify-scrub.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scrub-policy-'));

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';   // hex32 -- secret class
const CARD = '4111111111111111';                      // credit-card -- identity

function project(name, policy, harBody) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    if (policy) {
        fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME), JSON.stringify(policy, null, 2));
    }
    const harPath = path.join(dir, 'scrubbed.har');
    fs.writeFileSync(harPath, JSON.stringify(harBody));
    return harPath;
}

function run(harPath) {
    const r = spawnSync(process.execPath, [verify, '--in', harPath], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function harWith(value) {
    return { log: { version: '1.2', entries: [{
        request: { method: 'GET', url: 'https://example.com/a', headers: [], cookies: [], queryString: [] },
        response: { status: 200, headers: [], cookies: [],
            content: { mimeType: 'application/json', text: JSON.stringify({ v: value }) } },
    }] } };
}

// --- 1. A secret-class shape finding blocks. ---
{
    const r = run(project('secret', null, harWith(SECRET)));
    assert.strictEqual(r.code, 3, `1.a: a leaked secret did not block:\n${r.out}`);
    assert.ok(!r.out.includes(SECRET), '1.b: the verifier echoed the secret value');
}

// --- 2. An identity finding still blocks today, and says it is advisory. ---
// The design's end state is "reports, non-zero exit, artifact kept" -- it is
// the ARTIFACT that survives, not the exit code. Until Stage 7 adds the
// quarantine, a non-zero exit is what stops a leaking capture being committed,
// so downgrading this to a pass would turn a real card into a silent one.
{
    const r = run(project('identity', null, harWith(CARD)));
    assert.strictEqual(r.code, 3, `2.a: a leaked card stopped blocking:\n${r.out}`);
    assert.ok(/advisory/.test(r.out),
        `2.b: the finding did not say it is identity-shape evidence rather than a certainty:\n${r.out}`);
}

// --- 3. A waiver stops the failure. ---
// A waiver that did not stop the failure would be decoration.
{
    const r = run(project('waived', {
        waivers: [{ kind: 'hex32', fingerprint: shapes.fingerprint(SECRET), reason: 'vendor build sha' }],
    }, harWith(SECRET)));
    assert.strictEqual(r.code, 0, `3.a: a waived fingerprint still failed the run:\n${r.out}`);
    assert.ok(/WAIVED/i.test(r.out), `3.b: the waiver was applied silently:\n${r.out}`);

    // A waived secret is not "advisory" -- somebody signed for it, with a
    // reason and an expiry. Reporting the two the same way is how a report
    // stops meaning anything.
    assert.ok(/\[secret waived\]/.test(r.out),
        `3.c: a waived secret was labelled as though shape evidence had merely advised it:\n${r.out}`);
}

// --- 4. An expired waiver does not. ---
{
    const r = run(project('waiver-lapsed', {
        waivers: [{ kind: 'hex32', fingerprint: shapes.fingerprint(SECRET), reason: 'lapsed', expires: '2020-01-01' }],
    }, harWith(SECRET)));
    assert.strictEqual(r.code, 3, `4.a: an expired waiver still suppressed the failure:\n${r.out}`);
}

// --- 5. A disabled identity class reports without failing. ---
{
    const r = run(project('disabled', { classes: { identity: { 'credit-card': 'off' } } }, harWith(CARD)));
    assert.strictEqual(r.code, 0, `5.a: a class the project disabled still failed the run:\n${r.out}`);
    assert.ok(/credit-card/.test(r.out),
        `5.b: a disabled class stopped reporting entirely -- the cost of the loosening became invisible:\n${r.out}`);
}

// --- 6. A removed upstream secret name is announced on every run. ---
// `named-credential` is caught by name or not at all, so removing a name
// hollows the class out while its setting still reads `gate`. Saying so on a
// CLEAN run is the point: that is when nobody is looking.
{
    const r = run(project('loosened', { notSecretFields: ['sessionid', 'csrftoken'] }, harWith('nothing to see')));
    assert.strictEqual(r.code, 0, `6.a: the clean capture failed:\n${r.out}`);
    assert.ok(/sessionid/.test(r.out) && /csrftoken/.test(r.out),
        `6.b: a project that removed upstream secret names was not told so on a clean run:\n${r.out}`);
}

// --- 7. A malformed project policy fails loudly, not silently. ---
{
    const r = run(project('typo', { secretFeilds: ['x'] }, harWith('clean')));
    assert.strictEqual(r.code, 1, `7.a: a typo in a committed policy did not stop the run:\n${r.out}`);
    assert.ok(/secretFeilds/.test(r.out), `7.b: the error did not name the offending key:\n${r.out}`);
}

// --- 8. A project may opt an identity class UP, and it then gates. ---
{
    const r = run(project('opted-up', { classes: { identity: { 'credit-card': 'gate' } } }, harWith(CARD)));
    assert.strictEqual(r.code, 3, `8.a: an identity class opted up to gate did not block:\n${r.out}`);
    assert.ok(!/advisory/.test(r.out.split('\n').find((l) => l.includes('credit-card')) || ''),
        '8.b: a gating finding was still labelled advisory');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All verify-scrub-policy tests passed');
