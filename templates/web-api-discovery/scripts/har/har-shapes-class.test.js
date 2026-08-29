#!/usr/bin/env node
// Behavior tests for class-tagged shape findings and waiver matching
// (issue #297, Stage 2).
//
// Zero-dep, runs with `node har-shapes-class.test.js`. Exits non-zero on first
// failure.
//
// The controlling rule, from the issue's design: shape is WEAK evidence for an
// identity and meaningfully stronger for a secret, because high entropy is
// itself evidence of secret-ness. So a secret-class shape finding gates, an
// identity-class shape finding advises, and the difference has to be carried on
// the finding itself -- both verifiers read the same list, and neither should
// be re-deriving which is which.
//
// The failure this replaces: 1134 findings, 3 real, and the artifact deleted.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-shapes-class-'));

// Values chosen to match their pattern and NOT to look like the scrubber's own
// fakes -- a fake is exempt by design, so a fake sample would pass every test
// here for the wrong reason.
const SAMPLE = {
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    hex32: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    email: 'someone@example.com',
    'credit-card': '4111111111111111',
    ssn: '123-45-6789',
};

function loadPolicy(project) {
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    if (project) {
        fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME), JSON.stringify(project));
    }
    return policyModule.loadPolicy({ startDir: dir, stopAt: dir });
}

function findOne(kind, text, policy) {
    const hits = shapes.findLeaks(text, policy).filter((l) => l.kind === kind);
    assert.strictEqual(hits.length, 1, `expected exactly one ${kind} finding, got ${hits.length}`);
    return hits[0];
}

// --- 1. Every pattern declares a class, and only the two the model has. ---
{
    for (const p of shapes.LEAK_PATTERNS) {
        assert.ok(p.class === 'secret' || p.class === 'identity',
            `1.a: pattern '${p.name}' declares class ${JSON.stringify(p.class)}; the model has ` +
            `exactly two axes, and an unclassified pattern cannot be gated or advised`);
    }
    const byName = Object.fromEntries(shapes.LEAK_PATTERNS.map((p) => [p.name, p.class]));
    assert.strictEqual(byName.jwt, 'secret', '1.b: a JWT grants access');
    assert.strictEqual(byName.bearer, 'secret', '1.c: a bearer token grants access');
    assert.strictEqual(byName.hex64, 'secret', '1.d');
    assert.strictEqual(byName.hex32, 'secret', '1.e');
    assert.strictEqual(byName['credit-card'], 'identity', '1.f: a card names a person, it grants no access here');
    assert.strictEqual(byName.ssn, 'identity', '1.g');
    assert.strictEqual(byName.phone, 'identity', '1.h');
    assert.strictEqual(byName.email, 'identity', '1.i');
}

// --- 2. The pattern table and the policy vocabulary cannot drift apart. ---
// A pattern whose kind no policy class names is ungovernable: no consumer can
// tune it and no waiver can cover it. This is the drift the issue calls out --
// pii.js scrubs 13 types while har-shapes gates 8 -- caught here as a test
// rather than as a leak.
{
    const policy = loadPolicy();
    for (const p of shapes.LEAK_PATTERNS) {
        assert.ok(Object.prototype.hasOwnProperty.call(policy.classes[p.class], p.name),
            `2.a: pattern '${p.name}' is class '${p.class}' but har-policy.default.json declares no ` +
            `'${p.name}' under classes.${p.class}, so no consumer can tune it and no waiver can cover it`);
    }
}

// --- 3. No policy means everything gates. ---
// The two verifiers call findLeaksDeep(raw) with no policy today. Until they
// pass one, the safe reading of an absent policy is the strictest one: a
// loader that quietly advised instead of gating would weaken both gates the
// moment this shipped.
{
    for (const kind of Object.keys(SAMPLE)) {
        const leak = findOne(kind, `{"v":"${SAMPLE[kind]}"}`);
        assert.strictEqual(leak.gating, true,
            `3.a: with no policy, a ${kind} finding did not gate -- absent policy must mean strictest`);
        assert.strictEqual(leak.class, kind === 'jwt' || kind === 'hex32' ? 'secret' : 'identity',
            `3.b: ${kind} finding carries the wrong class`);
    }
}

// --- 4. Under the default policy, secrets gate and identities advise. ---
{
    const policy = loadPolicy();

    const secret = findOne('hex32', `{"t":"${SAMPLE.hex32}"}`, policy);
    assert.strictEqual(secret.gating, true, '4.a: a secret-class shape finding did not gate');
    assert.strictEqual(secret.setting, 'gate', '4.b: secret finding does not report its setting');

    const identity = findOne('credit-card', `{"n":"${SAMPLE['credit-card']}"}`, policy);
    assert.strictEqual(identity.gating, false,
        '4.c: an identity-class shape finding gated under the default policy -- shape carries no ' +
        'provenance, and gating on it is what deleted 1413 trip ids');
    assert.strictEqual(identity.setting, 'advise', '4.d: identity finding does not report its setting');
}

// --- 5. A consumer may opt an identity class UP to gating. ---
{
    const policy = loadPolicy({ classes: { identity: { 'credit-card': 'gate' } } });
    const leak = findOne('credit-card', `{"n":"${SAMPLE['credit-card']}"}`, policy);
    assert.strictEqual(leak.gating, true, '5.a: an identity class opted up to gate did not gate');
    assert.strictEqual(leak.setting, 'gate', '5.b');
}

// --- 6. A disabled class still detects and reports, as a warning. ---
// "Disabled classes still detect and report as warnings. The cost of a
// loosening stays visible on every run; CI stays green." A finding that simply
// vanishes is how a repo forgets it turned something off.
{
    const policy = loadPolicy({ classes: { identity: { 'credit-card': 'off' } } });
    const leak = findOne('credit-card', `{"n":"${SAMPLE['credit-card']}"}`, policy);
    assert.strictEqual(leak.gating, false, '6.a: a disabled class gated');
    assert.strictEqual(leak.setting, 'off',
        '6.b: a disabled class stopped reporting entirely -- the cost of the loosening became invisible');
}

// --- 7. A waiver drops a finding from the gate and is counted, not erased. ---
{
    const fp = shapes.fingerprint(SAMPLE.hex32);
    const policy = loadPolicy({
        waivers: [{ kind: 'hex32', fingerprint: fp, reason: 'vendor build sha' }],
    });
    const leak = findOne('hex32', `{"t":"${SAMPLE.hex32}"}`, policy);
    assert.strictEqual(leak.waived, true, '7.a: a waived fingerprint was not marked waived');
    assert.strictEqual(leak.gating, false, '7.b: a waived finding still gated');

    // Still present in the list, so a run can say "3 waived" -- the same rule
    // as a disabled class. A waiver that erased its finding would be an
    // invisible loosening with an expiry date nobody is reminded of.
    assert.ok(shapes.findLeaks(`{"t":"${SAMPLE.hex32}"}`, policy).some((l) => l.waived),
        '7.c: a waived finding disappeared from the list entirely rather than being counted');

    // A waiver is per value: another secret of the same kind is untouched.
    const other = 'ffee0011223344556677889900aabbcc';
    const still = findOne('hex32', `{"t":"${other}"}`, policy);
    assert.strictEqual(still.gating, true,
        '7.d: a waiver for one fingerprint suppressed a different value of the same kind');
}

// --- 8. An expired waiver does not suppress. ---
{
    const fp = shapes.fingerprint(SAMPLE.hex32);
    const policy = loadPolicy({
        waivers: [{ kind: 'hex32', fingerprint: fp, reason: 'lapsed', expires: '2020-01-01' }],
    });
    const leak = findOne('hex32', `{"t":"${SAMPLE.hex32}"}`, policy);
    assert.strictEqual(leak.gating, true, '8.a: an expired waiver still suppressed the gate');
    assert.ok(!leak.waived, '8.b: an expired waiver still marked the finding waived');
}

// --- 9. The policy reaches the percent-decoded scan too. ---
// findLeaksDeep is the entry point both verifiers actually call. A policy that
// applied to the wire text but not to its decoded shadow would gate
// inconsistently depending on how the payload happened to be encoded.
{
    const fp = shapes.fingerprint(SAMPLE.hex32);
    const policy = loadPolicy({ waivers: [{ kind: 'hex32', fingerprint: fp, reason: 'vendor build sha' }] });
    const encoded = `variables=%7B%22t%22%3A%22${SAMPLE.hex32}%22%7D`;
    const hits = shapes.findLeaksDeep(encoded, policy).filter((l) => l.kind === 'hex32');
    assert.ok(hits.length > 0, '9.a: the decoded-shadow scan found nothing to test');
    assert.ok(hits.every((l) => l.waived && !l.gating),
        '9.b: the policy did not reach findings raised by the decoded-shadow scan');
}

// --- 10. A finding never carries the value. ---
{
    const policy = loadPolicy();
    for (const kind of Object.keys(SAMPLE)) {
        for (const leak of shapes.findLeaks(`{"v":"${SAMPLE[kind]}"}`, policy)) {
            const serialized = JSON.stringify(leak);
            assert.ok(!serialized.includes(SAMPLE[kind]),
                `10.a: a ${kind} finding carried the matched value -- that relocates the leak ` +
                `into the log reporting it`);
        }
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-shapes-class tests passed');
