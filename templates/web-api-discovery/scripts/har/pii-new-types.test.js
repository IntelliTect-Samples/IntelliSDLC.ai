#!/usr/bin/env node
// Behavior tests for the PII types added in Stage 6 (issue #297, Task 6.5):
// IBAN, MAC address, and the mobile advertising identifiers.
//
// Zero-dep, runs with `node pii-new-types.test.js`.
//
// The plan says these land "behind policy flags, off in no release before
// their detectors are tested". This file is that condition.
//
// The three are deliberately NOT alike, and the difference is the whole point:
//
//   IBAN         has a mod-97 checksum. Shape plus arithmetic is strong
//                evidence, so it matches context-free.
//   MAC address  has a distinctive punctuated shape that nothing else wears.
//                Context-free.
//   IDFA / GAID  are PLAIN UUIDs, and a UUID is the most common identifier
//                shape in any API -- request ids, trace ids, idempotency keys.
//                Matching that shape would be the credit-card mistake for a
//                third time, so it is gated on the FIELD NAME and never on
//                shape alone.

'use strict';

const assert = require('assert');
const path = require('path');

const pii = require(path.join(__dirname, 'pii.js'));
const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

function bodyHar(obj) {
    return { log: { entries: [{
        request: { method: 'GET', url: 'https://example.com/a', headers: [], cookies: [], queryString: [] },
        response: { status: 200, headers: [], cookies: [],
            content: { mimeType: 'application/json', text: JSON.stringify(obj) } },
    }] } };
}

function found(obj, type) {
    return pii.detectPii(bodyHar(obj)).filter((d) => d.type === type);
}

// A real, checksum-valid IBAN from the ECB's own published examples.
const IBAN = 'GB82WEST12345698765432';
const MAC = '3C:22:FB:8A:11:9C';
const IDFA = '6D92078A-8246-4BA4-AE5B-76104861E7DC';

// --- 1. IBAN: matched context-free, because the checksum carries evidence. ---
{
    assert.strictEqual(found({ account: IBAN }, 'iban').length, 1,
        '1.a: a checksum-valid IBAN was not detected');
    assert.strictEqual(found({ iban: IBAN }, 'iban').length, 1, '1.b');
}

// --- 2. ...and a string that merely LOOKS like one is not. ---
// The mod-97 check is what separates an IBAN from any other run of letters and
// digits. Without it this becomes another "Luhn-valid digit run" -- a shape
// that fires on identifiers the API just happens to mint.
{
    for (const notIban of ['GB82WEST12345698765433', 'ZZ00NOTANIBANATALL1234', 'AA11BBBB22223333444455']) {
        assert.strictEqual(found({ account: notIban }, 'iban').length, 0,
            `2.a: ${notIban} passed as an IBAN without a valid checksum`);
    }
    // A long alphanumeric token is not an IBAN.
    assert.strictEqual(found({ token: 'AB12CDEF34567890ABCDEF' }, 'iban').length, 0, '2.b');
}

// --- 3. MAC address: the punctuated shape is distinctive on its own. ---
{
    assert.strictEqual(found({ device: MAC }, 'mac-address').length, 1,
        '3.a: a colon-separated MAC was not detected');
    assert.strictEqual(found({ device: '3c-22-fb-8a-11-9c' }, 'mac-address').length, 1,
        '3.b: a hyphen-separated MAC was not detected');
    // Six hex pairs with no separators is just a hex12; that is not a MAC.
    assert.strictEqual(found({ device: '3C22FB8A119C' }, 'mac-address').length, 0,
        '3.c: an unpunctuated hex run was claimed as a MAC address');
}

// --- 4. An advertising id needs its field name. THIS IS THE POINT. ---
// IDFA and GAID are ordinary UUIDs. So are request ids, trace ids, idempotency
// keys, message ids and half the primary keys in a modern API. Matching the
// UUID shape would scrub all of them -- the credit-card failure, third
// occurrence, and this one drives a REPLACE.
{
    for (const key of ['idfa', 'gaid', 'aaid', 'advertising_id', 'advertisingIdentifier', 'ad_id', 'idfv']) {
        assert.strictEqual(found({ [key]: IDFA }, 'device-id').length, 1,
            `4.a: \`${key}\` did not gate a UUID as an advertising identifier`);
    }
    for (const key of ['request_id', 'trace_id', 'correlation_id', 'idempotency_key',
        'message_id', 'session_uuid', 'id', 'uuid']) {
        assert.strictEqual(found({ [key]: IDFA }, 'device-id').length, 0,
            `4.b: a plain UUID in \`${key}\` was scrubbed as an advertising identifier`);
    }
}

// --- 5. The fakes are recognisable as fakes, and not re-detected. ---
// A fake the detector reports is a gate that fails on its own output, which is
// how a scrub loop never terminates and how a report loses its authority.
{
    for (const [type, key] of [['iban', 'account'], ['mac-address', 'device'], ['device-id', 'idfa']]) {
        const fake = pii.fakeFor(type, 'seed-value');
        assert.ok(typeof fake === 'string' && fake.length > 0, `5.a: no fake for ${type}`);
        assert.strictEqual(found({ [key]: fake }, type).length, 0,
            `5.b: the scrubber re-detected its own ${type} fake (${fake})`);
    }
}

// --- 6. The fakes are deterministic. ---
// Same input, same fake, or a re-scrub of the same capture produces a diff.
{
    for (const type of ['iban', 'mac-address', 'device-id']) {
        assert.strictEqual(pii.fakeFor(type, 'x'), pii.fakeFor(type, 'x'), `6.a: ${type} fake is not deterministic`);
        assert.notStrictEqual(pii.fakeFor(type, 'x'), pii.fakeFor(type, 'y'), `6.b: ${type} fake ignores its input`);
    }
}

// --- 7. Scrubbing replaces them. ---
{
    const har = bodyHar({ account: IBAN, device: MAC, idfa: IDFA });
    pii.scrubPii(har);
    const text = har.log.entries[0].response.content.text;
    for (const [label, value] of [['IBAN', IBAN], ['MAC', MAC], ['IDFA', IDFA]]) {
        assert.ok(!text.includes(value), `7.a: the ${label} was detected but never scrubbed`);
    }
}

// --- 8. The gate knows the same three types the scrubber does. ---
// The issue opens by complaining that `pii.js` scrubs 13 types while
// `har-shapes.js` gates 8, so a type can be scrubbed and never gated. Adding a
// type to one and not the other would re-open exactly that gap.
{
    const kinds = shapes.LEAK_PATTERNS.map((p) => p.name);
    for (const kind of ['iban', 'mac-address']) {
        assert.ok(kinds.includes(kind),
            `8.a: the scrubber removes '${kind}' but no gate pattern would catch it if the scrub missed`);
    }

    // Every pattern must be named by the policy, or it is ungovernable --
    // no consumer can tune it and no waiver can cover it.
    const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'pii-new-types-'));
    const policy = policyModule.loadPolicy({ startDir: dir, stopAt: dir });
    for (const p of shapes.LEAK_PATTERNS) {
        assert.ok(Object.prototype.hasOwnProperty.call(policy.classes[p.class], p.name),
            `8.b: pattern '${p.name}' is not declared under classes.${p.class} in the default policy`);
    }
    require('fs').rmSync(dir, { recursive: true, force: true });

    // `device-id` is deliberately NOT a shape pattern: a UUID has no shape
    // evidence, so gating on it would report every request id in the capture.
    assert.ok(!kinds.includes('device-id'),
        '8.c: device-id was added as a SHAPE pattern -- a UUID is not evidence of anything, ' +
        'and gating on it would fire on every request and trace id in the capture');
}

// --- 9. The new classes are identity, and advisory by default. ---
{
    const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'pii-new-classes-'));
    const policy = policyModule.loadPolicy({ startDir: dir, stopAt: dir });
    for (const kind of ['iban', 'mac-address', 'device-id']) {
        assert.strictEqual(policy.classes.identity[kind], 'advise',
            `9.a: '${kind}' is not an advisory identity class in the default policy`);
    }
    require('fs').rmSync(dir, { recursive: true, force: true });
}

console.log('All pii-new-types tests passed');
