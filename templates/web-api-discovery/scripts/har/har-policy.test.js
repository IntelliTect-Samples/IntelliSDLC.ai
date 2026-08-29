#!/usr/bin/env node
// Behavior tests for har-policy.js -- the merged scrub policy that the
// scrubber and both verifiers will consume (issue #297, Stage 1).
//
// Zero-dep, runs with `node har-policy.test.js`. Exits non-zero on first
// failure.
//
// The controlling rules, from the issue's design:
//
//   * Three inputs, one merge: a synced stringent default, a committed
//     project override, and the gitignored operator profile (literals only,
//     loaded elsewhere -- this file owns rules, never values).
//   * The secret floor is enforced by the LOADER, not by callers: a caller
//     cannot forget a check it never makes.
//   * A waiver is keyed on a non-reversible fingerprint and must carry a
//     reason, so a reviewer sees THAT something was waived and why without
//     the value ever entering the repo.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policyModule = require(path.join(__dirname, 'har-policy.js'));
const secrets = require(path.join(__dirname, 'har-secrets.js'));
const pii = require(path.join(__dirname, 'pii.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-policy-'));

function writeProject(dir, content) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, policyModule.POLICY_FILENAME);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return p;
}

// Every load is bounded by `stopAt` so a stray .har-policy.project.json
// anywhere above the temp directory cannot change a result.
function load(dir, opts) {
    return policyModule.loadPolicy(Object.assign({ startDir: dir, stopAt: dir }, opts));
}

function expectThrows(fn, matcher, label) {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    assert.ok(threw, `${label}: expected a throw, got none`);
    assert.ok(matcher.test(threw.message), `${label}: message did not match ${matcher}:\n${threw.message}`);
    return threw;
}

// --- 1. The canonical filenames. ---
{
    assert.strictEqual(policyModule.POLICY_FILENAME, '.har-policy.project.json',
        '1.a: project policy filename is not the documented .har-policy.project.json');
    assert.strictEqual(policyModule.DEFAULT_POLICY_FILENAME, 'har-policy.default.json',
        '1.b: default policy filename is not the documented har-policy.default.json');
}

// --- 2. The default alone loads, validates, and is stringent. ---
{
    const dir = path.join(tmp, 'default-only');
    fs.mkdirSync(dir, { recursive: true });
    const p = load(dir);

    assert.strictEqual(p.path, null, '2.a: reported a project policy path when no project file exists');
    assert.ok(typeof p.version === 'string' && p.version.length > 0,
        '2.b: merged policy carries no version string');

    for (const kind of Object.keys(p.classes.secret)) {
        assert.strictEqual(p.classes.secret[kind], 'gate',
            `2.c: default policy does not gate the secret class '${kind}'`);
    }
    assert.ok(Object.keys(p.classes.identity).length > 0,
        '2.d: default policy declares no identity classes');

    // Frozen: a caller that mutates the policy would silently change the rules
    // for every other caller sharing the object.
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.classes) && Object.isFrozen(p.secretFields),
        '2.e: merged policy is not deeply frozen');
    assert.throws(() => { p.secretFields.push('x'); }, '2.f: secretFields array is mutable');
}

// --- 3. The default is a faithful lift of the constants it replaces. ---
// Task 1.2 is a pure data lift: behaviour must not change. Anything the old
// module-level constants covered must still be covered by the policy, or the
// lift silently narrows the scrub.
{
    const dir = path.join(tmp, 'lift');
    fs.mkdirSync(dir, { recursive: true });
    const p = load(dir);

    for (const name of secrets.KNOWN_SECRET_FIELD_NAMES) {
        assert.ok(p.secretFields.includes(name),
            `3.a: secret field '${name}' was dropped by the lift into har-policy.default.json`);
    }
    for (const name of secrets.KNOWN_SECRET_HEADER_NAMES) {
        assert.ok(p.secretHeaders.includes(name),
            `3.b: secret header '${name}' was dropped by the lift into har-policy.default.json`);
    }
    for (const type of Object.keys(pii.FIELD)) {
        assert.ok(Array.isArray(p.piiFields[type]),
            `3.c: PII field dictionary '${type}' was dropped by the lift`);
        for (const key of pii.FIELD[type]) {
            assert.ok(p.piiFields[type].includes(key),
                `3.d: PII field name '${key}' (${type}) was dropped by the lift`);
        }
    }
}

// --- 4. A project file merges over the default. ---
{
    const dir = path.join(tmp, 'merge');
    writeProject(dir, {
        secretFields: ['x-my-app-token'],
        notSecretFields: ['x-asbd-id', 'x-my-app-token'],
        identifierFields: ['trip_id'],
        classes: { identity: { 'credit-card': 'off' } },
    });
    const p = load(dir);

    assert.strictEqual(p.path, path.join(dir, policyModule.POLICY_FILENAME),
        '4.a: resolved project policy path not reported');

    // Names append...
    assert.ok(p.secretFields.includes('fb_dtsg'),
        '4.b: a project file REPLACED the default secret-field list instead of appending to it');
    assert.ok(p.identifierFields.includes('trip_id'),
        '4.c: project identifierFields not merged');

    // ...and notSecretFields subtracts AFTER the append, so it can remove a
    // default name and can veto a name the same file just added.
    //
    // Subtracting a DEFAULT name is deliberate, not a hole: the issue's own
    // policy sketch removes `x-asbd-id`, and requirement 4 exists because a
    // name list has false positives -- "cookies redacted by name + entropy,
    // not wholesale; a cookie can carry configuration". Test 12 pins what
    // stops that being a silent loosening.
    assert.ok(!p.secretHeaders.includes('x-asbd-id'),
        '4.d: notSecretFields did not subtract a default secret header');
    assert.ok(!p.secretFields.includes('x-my-app-token'),
        '4.e: notSecretFields did not subtract after the append');

    // classes.* replaces the single setting, leaving its siblings alone.
    assert.strictEqual(p.classes.identity['credit-card'], 'off',
        '4.f: project class setting not applied');
    assert.strictEqual(p.classes.identity.email, 'advise',
        '4.g: a project class setting clobbered a sibling identity class');
}

// --- 5. An unknown key is a hard error, never a silent ignore. ---
// A typo in a committed policy that quietly does nothing is how a repo ends up
// believing it loosened (or tightened) a gate it never touched.
{
    const dir = path.join(tmp, 'unknown-top');
    writeProject(dir, { secretFeilds: ['oops'] });
    expectThrows(() => load(dir), /secretFeilds/, '5.a');

    const kindDir = path.join(tmp, 'unknown-kind');
    writeProject(kindDir, { classes: { identity: { 'crdit-card': 'off' } } });
    expectThrows(() => load(kindDir), /crdit-card/, '5.b');

    const classDir = path.join(tmp, 'unknown-class');
    writeProject(classDir, { classes: { confidential: { email: 'off' } } });
    expectThrows(() => load(classDir), /confidential/, '5.c');

    const valueDir = path.join(tmp, 'unknown-setting');
    writeProject(valueDir, { classes: { identity: { email: 'maybe' } } });
    expectThrows(() => load(valueDir), /maybe/, '5.d');

    const jsonDir = path.join(tmp, 'bad-json');
    writeProject(jsonDir, '{ not json');
    expectThrows(() => load(jsonDir), /parse|json/i, '5.e');
}

// --- 6. The floor: a consumer may loosen identity, never secret. ---
{
    const offDir = path.join(tmp, 'secret-off');
    writeProject(offDir, { classes: { secret: { hex32: 'off' } } });
    const e = expectThrows(() => load(offDir), /hex32/, '6.a');
    assert.strictEqual(e.name, 'PolicyError', '6.b: the floor did not raise a PolicyError');

    // `advise` is `off` wearing a hat: a secret finding that does not gate is
    // a secret finding that ships. The sanctioned escape is a waiver, which
    // is per-value, reasoned, and expires.
    const adviseDir = path.join(tmp, 'secret-advise');
    writeProject(adviseDir, { classes: { secret: { jwt: 'advise' } } });
    expectThrows(() => load(adviseDir), /jwt/, '6.c');

    // Identity is the consumer's call.
    const idDir = path.join(tmp, 'identity-off');
    writeProject(idDir, { classes: { identity: { 'person-name': 'off' } } });
    const p = load(idDir);
    assert.strictEqual(p.classes.identity['person-name'], 'off',
        '6.d: a consumer could not disable an identity class');
}

// --- 7. Waivers are reasoned, fingerprinted, and expire. ---
{
    const dir = path.join(tmp, 'waivers');
    writeProject(dir, {
        waivers: [
            { kind: 'hex32', fingerprint: 'a1b2c3d4e5f6', reason: 'vendor build sha', expires: '2999-01-01' },
            { kind: 'hex64', fingerprint: '0123456789ab', reason: 'static asset digest' },
            { kind: 'hex32', fingerprint: 'ffffffffffff', reason: 'lapsed', expires: '2020-01-01' },
        ],
    });
    const p = load(dir);

    assert.strictEqual(policyModule.isWaived(p, 'hex32', 'a1b2c3d4e5f6'), true,
        '7.a: an in-date waiver did not match');
    assert.strictEqual(policyModule.isWaived(p, 'hex64', '0123456789ab'), true,
        '7.b: a waiver with no expiry did not match');
    assert.strictEqual(policyModule.isWaived(p, 'hex32', 'ffffffffffff'), false,
        '7.c: an EXPIRED waiver still matched -- a waiver that never lapses is a permanent hole');
    assert.strictEqual(policyModule.isWaived(p, 'hex64', 'a1b2c3d4e5f6'), false,
        '7.d: a waiver matched a different kind -- the fingerprint alone is not the key');
    assert.strictEqual(policyModule.isWaived(p, 'hex32', 'A1B2C3D4E5F6'), true,
        '7.e: fingerprint matching is case-sensitive');

    // A waiver with no reason is rejected: the whole point of committing one
    // is that a reviewer can see why.
    const noReason = path.join(tmp, 'waiver-no-reason');
    writeProject(noReason, { waivers: [{ kind: 'hex32', fingerprint: 'a1b2c3d4e5f6' }] });
    expectThrows(() => load(noReason), /reason/i, '7.f');

    // A fingerprint that is not the 12-hex form har-shapes emits is a typo,
    // and a waiver that matches nothing is worse than none: it reads as cover.
    const badPrint = path.join(tmp, 'waiver-bad-print');
    writeProject(badPrint, { waivers: [{ kind: 'hex32', fingerprint: 'not-a-fingerprint', reason: 'x' }] });
    expectThrows(() => load(badPrint), /fingerprint/i, '7.g');

    const badDate = path.join(tmp, 'waiver-bad-date');
    writeProject(badDate, { waivers: [{ kind: 'hex32', fingerprint: 'a1b2c3d4e5f6', reason: 'x', expires: 'soon' }] });
    expectThrows(() => load(badDate), /expires/i, '7.h');

    // A waiver may never cover a value nobody classified.
    const badKind = path.join(tmp, 'waiver-bad-kind');
    writeProject(badKind, { waivers: [{ kind: 'hex128', fingerprint: 'a1b2c3d4e5f6', reason: 'x' }] });
    expectThrows(() => load(badKind), /hex128/, '7.i');
}

// --- 8. The version identifies the MERGED document, not the default. ---
// Stage 10 stamps this into every reference so a later policy change makes it
// knowable which references need re-extraction.
{
    const bare = path.join(tmp, 'version-bare');
    fs.mkdirSync(bare, { recursive: true });
    const baseVersion = load(bare).version;
    assert.strictEqual(load(bare).version, baseVersion, '8.a: version is not stable for identical input');

    const overridden = path.join(tmp, 'version-overridden');
    writeProject(overridden, { identifierFields: ['trip_id'] });
    assert.notStrictEqual(load(overridden).version, baseVersion,
        '8.b: an overridden policy carries the same version as the bare default');
}

// --- 9. An explicit path overrides discovery. ---
{
    const dir = path.join(tmp, 'explicit');
    const p = writeProject(dir, { identifierFields: ['step_id'] });
    const loaded = policyModule.loadPolicy({ policyPath: p, startDir: os.tmpdir(), stopAt: os.tmpdir() });
    assert.ok(loaded.identifierFields.includes('step_id'), '9.a: explicit policy path ignored');

    expectThrows(() => policyModule.loadPolicy({ policyPath: path.join(dir, 'nope.json') }),
        /nope\.json/, '9.b');
}

// --- 10. Discovery walks upward from wherever the script happens to run. ---
// The realistic shape: the policy sits at the consuming repo's root and the
// scripts run several directories below it. A loader that only looked in
// `startDir` would silently apply the stringent default to a project that had
// deliberately loosened it -- and every symptom of that is a false positive
// nobody can turn off, which is the failure this whole issue exists to end.
{
    const repoRoot = path.join(tmp, 'consumer-repo');
    const deep = path.join(repoRoot, 'scripts', 'har', 'nested');
    fs.mkdirSync(deep, { recursive: true });
    writeProject(repoRoot, { identifierFields: ['trip_id'], classes: { identity: { 'credit-card': 'off' } } });

    const found = policyModule.loadPolicy({ startDir: deep, stopAt: repoRoot });
    assert.strictEqual(found.path, path.join(repoRoot, policyModule.POLICY_FILENAME),
        '10.a: upward discovery did not find the project policy at the repo root');
    assert.strictEqual(found.classes.identity['credit-card'], 'off',
        '10.b: the discovered project policy was not applied');

    // The nearest policy wins, so a nested project (or a test fixture) can
    // override without editing the root.
    const inner = path.join(repoRoot, 'scripts', 'har');
    writeProject(inner, { classes: { identity: { 'credit-card': 'advise' } } });
    const nearest = policyModule.loadPolicy({ startDir: deep, stopAt: repoRoot });
    assert.strictEqual(nearest.path, path.join(inner, policyModule.POLICY_FILENAME),
        '10.c: a nearer project policy did not win over the one at the root');
    assert.strictEqual(nearest.classes.identity['credit-card'], 'advise',
        '10.d: the nearer policy was found but not applied');
    assert.ok(!nearest.identifierFields.includes('trip_id'),
        '10.e: two project policies were merged -- exactly one may apply, or which rules ' +
        'are in force depends on where the script was invoked from');
}

// --- 11. The shipped default policy is the one the loader really loads. ---
// Test 3 pins the lift; this pins that the file is FOUND -- a loader that
// silently fell back to an empty baseline would pass every merge test above
// while gating nothing at all.
{
    const shipped = path.join(__dirname, policyModule.DEFAULT_POLICY_FILENAME);
    assert.ok(fs.existsSync(shipped),
        `11.a: ${policyModule.DEFAULT_POLICY_FILENAME} does not ship beside har-policy.js`);

    const dir = path.join(tmp, 'shipped-default');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(load(dir).defaultPath, shipped,
        '11.b: the loader did not load the default policy shipped beside it');

    expectThrows(
        () => policyModule.loadPolicy({ defaultPath: path.join(dir, 'absent.json'), startDir: dir, stopAt: dir }),
        /absent\.json/, '11.c');
}

// --- 12. A subtraction that guts a secret class is recorded, not silent. ---
// `named-credential` has no shape backup: `sessionid`, `csrftoken`, `fb_dtsg`
// are caught by NAME or not at all. So `notSecretFields` is the one input that
// can hollow out a secret class while `classes.secret` still reads `gate` --
// the floor checks the setting, and the setting is not where that class lives.
//
// Forbidding the subtraction is not the answer: the issue's own sketch removes
// `x-asbd-id`, and a name list without an escape hatch is the undisableable
// gate this whole issue exists to replace. What must not happen is the
// loosening being INVISIBLE, so the loader records every default secret name a
// project removed and the gates report it on every run.
{
    const dir = path.join(tmp, 'gutted');
    writeProject(dir, {
        secretFields: ['x-my-app-token'],
        notSecretFields: ['sessionid', 'csrftoken', 'fb_dtsg', 'x-asbd-id', 'x-my-app-token'],
    });
    const p = load(dir);

    assert.strictEqual(p.classes.secret['named-credential'], 'gate',
        '12.a: precondition -- the class setting still reads gate');
    assert.ok(!p.secretFields.includes('sessionid'),
        '12.b: precondition -- the subtraction took effect');

    assert.deepStrictEqual(p.loosenedSecretNames, ['sessionid', 'csrftoken', 'fb_dtsg', 'x-asbd-id'],
        '12.c: the default secret names a project removed are not recorded, so a policy can ' +
        'hollow out the named-credential class while every floor check still reports "gate"');

    // A name the project itself added and then vetoed was never a default, so
    // removing it loosens nothing and must not read as a loosening -- a report
    // that cries wolf is the failure mode this issue measured at 1134 findings.
    assert.ok(!p.loosenedSecretNames.includes('x-my-app-token'),
        '12.d: vetoing a project-added name was reported as a loosening of the default');

    // Nothing removed, nothing to report.
    const clean = path.join(tmp, 'not-loosened');
    writeProject(clean, { secretFields: ['x-my-app-token'] });
    assert.deepStrictEqual(load(clean).loosenedSecretNames, [],
        '12.e: a policy that removed nothing still reported a loosening');

    // The record is part of the policy, so the version changes when a project
    // loosens -- a reference stamped with it says which rules produced it.
    assert.notStrictEqual(load(dir).version, load(clean).version,
        '12.f: loosening the secret name list did not change the policy version');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-policy tests passed');
