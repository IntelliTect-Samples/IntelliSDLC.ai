#!/usr/bin/env node
// Behavior tests for issue #297, Stage 7, task 7.3 -- the findings report and
// the advisory/gating split in the exit code.
//
// Zero-dep, runs with `node verify-scrub-findings.test.js`.
//
// Two properties, and they are not the same property:
//
//  1. A finding that only ADVISES must still exit non-zero. The artifact is
//     what survives an advisory finding, not the exit code. Exiting 0 would
//     turn a genuine card into a silent pass for every wrapper, hook and CI
//     step that asks "did verify-scrub succeed".
//  2. It must exit non-zero DIFFERENTLY, because capture-har.js switches on
//     the code: a gating leak quarantines the artifact, an advisory-only run
//     keeps it and warns. One shared non-zero code cannot express that, and
//     the alternative -- a flag -- would let a caller ask for the lenient
//     branch, which is the one thing the caller must not be able to do.
//
// And the report has one absolute rule: it never contains a value. A findings
// report that quotes the value it found has relocated the leak into the
// document that reports it.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const VERIFY = path.join(__dirname, 'verify-scrub.js');
const FINDINGS = 'scrub-findings.json';

// Exit codes under test. Named, because the whole point of Stage 7 is that
// these two numbers mean different things to capture-har.js.
const EXIT_GATING = 3;
const EXIT_ADVISORY = 4;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-scrub-findings-'));

// A hex32 -- secret class, gates unconditionally, and a project may not lower
// it. Synthetic: 32 hex characters typed here, not captured anywhere.
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
// The canonical Visa test card -- identity class, shape evidence, advises.
const CARD = '4111111111111111';

let passed = 0;

function project(name, policy, body) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    if (policy) {
        fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME),
            JSON.stringify(policy, null, 2), 'utf8');
    }
    const harPath = path.join(dir, 'scrubbed.har');
    fs.writeFileSync(harPath, JSON.stringify(body), 'utf8');
    return harPath;
}

function run(harPath) {
    const r = spawnSync(process.execPath, [VERIFY, '--in', harPath], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// One entry per named field, so a finding has a key path to report and the
// awkward "one gating and one advisory in the same capture" shape is
// expressible rather than assumed away.
function harWith(fields) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'verify-scrub-findings.test', version: '1' },
            entries: Object.entries(fields).map(([key, value]) => ({
                request: {
                    method: 'GET', url: 'https://example.invalid/a',
                    headers: [], cookies: [], queryString: []
                },
                response: {
                    status: 200, headers: [], cookies: [],
                    content: {
                        mimeType: 'application/json',
                        text: JSON.stringify({ [key]: value })
                    }
                }
            }))
        }
    };
}

function readFindings(harPath) {
    const p = path.join(path.dirname(harPath), FINDINGS);
    assert.ok(fs.existsSync(p), `expected a findings report at ${p}`);
    const text = fs.readFileSync(p, 'utf8');
    return { path: p, text, doc: JSON.parse(text) };
}

// ===================================================================
// 1. An identity finding by shape advises: non-zero, and its OWN code.
// ===================================================================
{
    const harPath = project('advisory', null, harWith({ amount_paid: CARD }));
    const r = run(harPath);
    assert.strictEqual(r.code, EXIT_ADVISORY,
        `1.a: an advisory-only run must exit ${EXIT_ADVISORY}, got ${r.code}\n${r.out}`);
    assert.ok(!r.out.includes(CARD), '1.b: the verifier echoed the value');
    passed++;
}

// ===================================================================
// 2. A secret keeps the gating code, so capture-har still quarantines.
// ===================================================================
{
    const harPath = project('gating', null, harWith({ blob: SECRET }));
    const r = run(harPath);
    assert.strictEqual(r.code, EXIT_GATING,
        `2.a: a secret-class leak must keep exit ${EXIT_GATING}, got ${r.code}\n${r.out}`);
    passed++;
}

// ===================================================================
// 3. Gating AND advisory in one capture: the gating verdict wins.
//
// The awkward shape. A run that reported the advisory code because an
// advisory finding existed would tell capture-har to keep an artifact that
// also carries a live secret.
// ===================================================================
{
    const harPath = project('both', null, harWith({ blob: SECRET, amount_paid: CARD }));
    const r = run(harPath);
    assert.strictEqual(r.code, EXIT_GATING,
        `3.a: a capture with both must exit ${EXIT_GATING}, got ${r.code}\n${r.out}`);

    const { doc } = readFindings(harPath);
    assert.strictEqual(doc.verdict, 'gating', '3.b: the verdict must name the worst finding');
    const kinds = doc.findings.map((f) => f.kind);
    assert.ok(kinds.includes('hex32'), `3.c: the secret finding is missing: ${kinds}`);
    assert.ok(kinds.includes('credit-card'), `3.d: the advisory finding is missing: ${kinds}`);
    assert.ok(doc.findings.some((f) => f.disposition === 'gating')
        && doc.findings.some((f) => f.disposition === 'advisory'),
        '3.e: the report must say which findings blocked and which merely advised');
    passed++;
}

// ===================================================================
// 4. The report carries a location, a count and a fingerprint -- never
//    a value.
// ===================================================================
{
    const harPath = project('located', null, harWith({ amount_paid: CARD }));
    run(harPath);
    const { text, doc } = readFindings(harPath);

    assert.ok(!text.includes(CARD), '4.a: the findings report contains the value it found');
    const f = doc.findings.find((x) => x.kind === 'credit-card');
    assert.ok(f, '4.b: no credit-card finding was recorded');
    assert.strictEqual(f.class, 'identity', '4.c: the class is missing');
    assert.strictEqual(f.entryIndex, 0, '4.d: the entry index is missing');
    assert.match(f.keyPath || '', /amount_paid/, '4.e: the key path is missing');
    assert.strictEqual(f.count, 1, '4.f: the occurrence count is missing');
    assert.strictEqual(f.fingerprint, shapes.fingerprint(CARD), '4.g: the fingerprint is wrong');

    // Whitelist, not blacklist: a report that grew a `sample` or `value` key
    // upstream would leak silently, and the leak would be in the file whose
    // entire purpose is to be safe to read.
    const allowed = new Set(['kind', 'class', 'setting', 'disposition', 'waived',
        'identifierField', 'keyPath', 'entryIndex', 'enclosing', 'count',
        'fingerprint', 'length', 'field', 'sentinel']);
    for (const finding of doc.findings) {
        for (const key of Object.keys(finding)) {
            assert.ok(allowed.has(key),
                `4.h: unexpected key "${key}" in a findings report -- it may carry a value`);
        }
    }
    passed++;
}

// ===================================================================
// 5. A clean capture leaves no report behind.
// ===================================================================
{
    const harPath = project('clean', null, harWith({ note: 'nothing to see' }));
    const r = run(harPath);
    assert.strictEqual(r.code, 0, `5.a: a clean capture failed:\n${r.out}`);
    assert.ok(!fs.existsSync(path.join(path.dirname(harPath), FINDINGS)),
        '5.b: a clean run must not litter the output path with an empty report');
    passed++;
}

// ===================================================================
// 6. The waiver fragment is paste-ready, identity-only, and forces the
//    operator to write the reason.
// ===================================================================
{
    const harPath = project('fragment', null, harWith({ blob: SECRET, amount_paid: CARD }));
    const r = run(harPath);
    const print = shapes.fingerprint(CARD);

    assert.ok(r.out.includes(policyModule.POLICY_FILENAME),
        `6.a: the run never named the file the fragment goes into:\n${r.out}`);
    assert.ok(r.out.includes(print),
        `6.b: the fragment does not carry the identity fingerprint:\n${r.out}`);
    assert.ok(!r.out.includes(shapes.fingerprint(SECRET))
        || !new RegExp(`"kind"\\s*:\\s*"hex32"`).test(r.out),
        '6.c: a secret was offered as waivable boilerplate -- a secret waiver is a '
        + 'deliberate act, not a suggestion');
    assert.ok(/"reason"\s*:\s*""/.test(r.out),
        `6.d: the fragment must leave "reason" empty so the operator fills it in:\n${r.out}`);

    const { doc } = readFindings(harPath);
    assert.ok(doc.suggestedPolicyFragment, '6.e: the report must carry the same fragment');
    assert.deepStrictEqual(
        doc.suggestedPolicyFragment.waivers.map((w) => w.kind), ['credit-card'],
        '6.f: the fragment must cover the identity findings and only those');
    assert.strictEqual(doc.suggestedPolicyFragment.waivers[0].reason, '',
        '6.g: the emitted reason must be empty');
    passed++;
}

// ===================================================================
// 7. The emitted fragment, once a reason is filled in, actually works.
//
// A fragment the policy loader rejects would be worse than none: the
// operator would be told to paste something and then told it is invalid.
// ===================================================================
{
    const harPath = project('round-trip', null, harWith({ amount_paid: CARD }));
    run(harPath);
    const { doc } = readFindings(harPath);

    const fragment = JSON.parse(JSON.stringify(doc.suggestedPolicyFragment));
    fragment.waivers[0].reason = 'trip id, not a card -- issue #297';
    fs.writeFileSync(
        path.join(path.dirname(harPath), policyModule.POLICY_FILENAME),
        JSON.stringify(fragment, null, 2), 'utf8');

    const after = run(harPath);
    assert.strictEqual(after.code, 0,
        `7.a: the emitted fragment did not clear the finding it was emitted for:\n${after.out}`);
    assert.ok(/WAIVED/i.test(after.out),
        `7.b: the waiver was applied silently -- a waiver must stay visible:\n${after.out}`);
    passed++;
}

// ===================================================================
// 8. An unwaived reason is refused, so the fragment cannot be pasted
//    and forgotten.
// ===================================================================
{
    const harPath = project('empty-reason', null, harWith({ amount_paid: CARD }));
    run(harPath);
    const { doc } = readFindings(harPath);
    fs.writeFileSync(
        path.join(path.dirname(harPath), policyModule.POLICY_FILENAME),
        JSON.stringify(doc.suggestedPolicyFragment, null, 2), 'utf8');

    const after = run(harPath);
    assert.strictEqual(after.code, 1,
        `8.a: a waiver pasted with no reason was accepted:\n${after.out}`);
    assert.match(after.out, /reason/,
        `8.b: the error did not say what was missing:\n${after.out}`);
    passed++;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`All verify-scrub-findings tests passed (${passed})`);
