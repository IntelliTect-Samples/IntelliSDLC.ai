#!/usr/bin/env node
// Behavior tests for policy-extendable issuer identification numbers
// (issue #297, Stage 1 carry-forward).
//
// Zero-dep, runs with `node har-card-issuers.test.js`. Exits non-zero on the
// first failure.
//
// Why this exists. #295 replaced "Luhn-valid 13-19 digit run" with "an ASSIGNED
// issuer identifier at a length that issuer mints", which is what stopped 1413
// trip ids being reported as leaked cards. That table is a public payment-network
// standard, so it correctly lives in code -- but a consumer in a Maestro or
// RuPay market has cards the shipped table does not name, and patching upstream
// is not an override path. So the table is EXTENDED by the merged policy.
//
// Two properties this pins, and they pull in opposite directions:
//
//   * a project may ADD a range, and the addition takes effect;
//   * a project may not SUBTRACT one -- the policy list appends to the shipped
//     standard rather than replacing it. Loosening card detection is done by
//     lowering `classes.identity.credit-card`, which is visible as a setting,
//     not by quietly deleting the range that would have caught it.
//
// And the regression guard: Maestro is deliberately NOT in the default. Its
// range (50, 56-69) overlaps Discover and UnionPay at lengths 12-19 and would
// reopen exactly the false-positive surface #295 closed.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-card-issuers-'));

// Luhn-valid, and chosen so the DEFAULT table does not claim it: 16 digits
// beginning `50` is Maestro's range and nobody else's. `4111...` is a Visa the
// default has always claimed, and is here to prove an addition does not
// displace the standard.
const MAESTRO_16 = '5012777777777770';
const VISA_16 = '4111777777777773';
const MAESTRO_ADDITION = { brand: 'maestro', prefixes: [[50, 50]], lengths: [16] };

function loadPolicy(project) {
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    if (project) {
        fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME), JSON.stringify(project));
    }
    return policyModule.loadPolicy({ startDir: dir, stopAt: dir });
}

function cardKinds(text, policy) {
    return shapes.findLeaks(text, policy).filter((l) => l.kind === 'credit-card');
}

function rejects(project, what) {
    assert.throws(
        () => loadPolicy(project),
        (e) => e instanceof policyModule.PolicyError,
        `${what}: expected a PolicyError -- a malformed issuer range that loads is a ` +
        `detector nobody can reason about`);
}

// --- 1. `cardIssuers` is part of the policy vocabulary, and ships empty. ---
// Empty is the point: the shipped standard stays in har-shapes.js, where the
// requirement says it correctly lives. The policy carries ADDITIONS only.
{
    const policy = loadPolicy();
    assert.ok(Array.isArray(policy.cardIssuers),
        '1.a: the merged policy must expose cardIssuers as an array');
    assert.strictEqual(policy.cardIssuers.length, 0,
        '1.b: the default policy adds no issuer ranges of its own');
}

// --- 2. Maestro is NOT detected by the default. The #295 regression guard. ---
{
    assert.strictEqual(cardKinds(MAESTRO_16, loadPolicy()).length, 0,
        '2.a: a 16-digit run beginning 50 must not be a card under the shipped default -- ' +
        'adding Maestro upstream overlaps Discover and UnionPay and reopens #295');
    assert.strictEqual(shapes.hasAssignedIin(MAESTRO_16), false,
        '2.b: and the predicate agrees when called with no policy at all');
}

// --- 3. A project ADDS a range, and the addition takes effect. ---
{
    const policy = loadPolicy({ cardIssuers: [MAESTRO_ADDITION] });
    const hits = cardKinds(MAESTRO_16, policy);
    assert.strictEqual(hits.length, 1,
        '3.a: a consumer in a Maestro market must be able to add the range without ' +
        'patching upstream code');
    assert.strictEqual(hits[0].class, 'identity', '3.b: an added range is still identity-class');
    assert.strictEqual(shapes.hasAssignedIin(MAESTRO_16, policy), true, '3.c');
}

// --- 4. The addition is a length-AND-prefix rule, not a prefix alone. ---
// `50` at 19 digits is no more a Maestro than `4` at 17 is a Visa. An addition
// that widened the predicate to "starts with 50" would be a new false-positive
// surface, which is the whole thing being avoided.
{
    const policy = loadPolicy({ cardIssuers: [MAESTRO_ADDITION] });
    const nineteen = '5012777777777777776';
    assert.strictEqual(shapes.luhnValid(nineteen), true, '4.a: sample is Luhn-valid');
    assert.strictEqual(cardKinds(nineteen, policy).length, 0,
        '4.b: the project declared length 16 only, so 19 digits is not its card');
}

// --- 5. An addition never displaces the shipped standard. ---
{
    const policy = loadPolicy({ cardIssuers: [MAESTRO_ADDITION] });
    assert.strictEqual(cardKinds(VISA_16, policy).length, 1,
        '5.a: a project list APPENDS -- naming one issuer must not silently drop the ' +
        'six the standard ships, which would be an invisible loosening');
    assert.strictEqual(policy.cardIssuers.length, 1,
        '5.b: and the merged policy reports exactly what the project added');
}

// --- 6. A malformed range is a hard error, not a shrug. ---
// Bounds are matched at the width of the range's own bounds, so mismatched
// widths do not mean what their author thinks: `[5, 69]` would compare the
// first TWO digits against a low bound of 5, claiming everything from 05 to 69.
{
    rejects({ cardIssuers: [{ brand: 'x', prefixes: [[5, 69]], lengths: [16] }] },
        '6.a: bounds of differing digit width');
    rejects({ cardIssuers: [{ brand: 'x', prefixes: [[69, 50]], lengths: [16] }] },
        '6.b: low bound above high');
    rejects({ cardIssuers: [{ brand: '', prefixes: [[50, 50]], lengths: [16] }] },
        '6.c: an unnamed brand');
    rejects({ cardIssuers: [{ prefixes: [[50, 50]], lengths: [16] }] },
        '6.d: a missing brand');
    rejects({ cardIssuers: [{ brand: 'x', prefixes: [[50, 50]], lengths: [16.5] }] },
        '6.e: a non-integer length');
    rejects({ cardIssuers: [{ brand: 'x', prefixes: [[50, 50]], lengths: [] }] },
        '6.f: no lengths at all -- matches nothing, and reads as though it does');
    rejects({ cardIssuers: [{ brand: 'x', prefixes: [], lengths: [16] }] },
        '6.g: no prefixes at all');
    rejects({ cardIssuers: [{ brand: 'x', prefixes: [[50, 50]], lengths: [4] }] },
        '6.h: a length outside the 12-19 the card pattern can even see');
    rejects({ cardIssuers: [{ brand: 'x', prefixes: [[50, 50]], lengths: [16], note: 'hi' }] },
        '6.i: an unknown key inside an issuer entry');
    rejects({ cardIssuers: { brand: 'x' } },
        '6.j: cardIssuers that is not an array');
}

// --- 7. The version hash tracks an issuer addition. ---
// Stage 10 stamps this version into a reference so it is knowable which
// references need re-extraction. A rule change the version does not move is a
// re-extraction nobody knows to run.
{
    assert.notStrictEqual(
        loadPolicy({ cardIssuers: [MAESTRO_ADDITION] }).version,
        loadPolicy().version,
        '7.a: adding an issuer range must change the merged policy version');
}

console.log('All har-card-issuers tests passed');
