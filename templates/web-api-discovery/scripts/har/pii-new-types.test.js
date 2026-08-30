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

    // The fake marker must not be a shape the real world uses. `02:00:00:` --
    // the first draft's marker -- is the textbook locally-administered address
    // and is what several virtualisation and sandbox tools actually emit, so
    // treating it as "already scrubbed" meant a real MAC was never reported at
    // all. Every other fake in this file is arbitrary (`@example.invalid`,
    // `4242`, `900-`); this one had picked a real convention.
    assert.strictEqual(found({ device: '02:00:00:AB:CD:EF' }, 'mac-address').length, 1,
        '3.d: a real locally-administered MAC was skipped as though it were our own fake');
}

// --- 3e. A MAC is exactly six pairs, not any six pairs inside a longer run. ---
// A TLS certificate thumbprint and an SSH host-key fingerprint are colon-
// separated hex pairs, and a HAR capture is full of them -- they are part of
// the protocol evidence the reference exists to preserve. An unanchored
// six-pair pattern carves three "MAC addresses" out of a twenty-byte
// fingerprint and the scrub then rewrites them, destroying the real value with
// no field name involved and no way to notice afterwards.
//
// This is the same defect the `sort_city` finding was: a predicate that is not
// the concept. "Six hex pairs" is not "a MAC address" if it sits inside more
// hex pairs.
{
    const fingerprint = 'AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AB:CD:EF:01';
    assert.strictEqual(found({ thumbprint: fingerprint }, 'mac-address').length, 0,
        '3e.a: a certificate fingerprint was carved into MAC addresses');
    assert.strictEqual(found({ thumbprint: fingerprint }, 'ip-address').length, 0,
        '3e.b: a certificate fingerprint was carved into IPv6 addresses');

    const har = { log: { entries: [{
        request: { method: 'GET', url: 'https://example.com/a', cookies: [], queryString: [],
            headers: [{ name: 'x-cert-fingerprint', value: fingerprint }] },
        response: { status: 200, headers: [], cookies: [], content: { mimeType: 'application/json', text: '{}' } },
    }] } };
    pii.scrubPii(har);
    assert.strictEqual(har.log.entries[0].request.headers[0].value, fingerprint,
        '3e.c: a certificate fingerprint was rewritten by the scrub');

    // The hyphen spelling extends the same way.
    assert.strictEqual(found({ fp: '3C-22-FB-8A-11-9C-DE-AD' }, 'mac-address').length, 0,
        '3e.d: a longer hyphen-separated hex run was carved into a MAC');

    // ...and a genuine MAC adjacent to other text still reports.
    assert.strictEqual(found({ note: 'device 3C:22:FB:8A:11:9C connected' }, 'mac-address').length, 1,
        '3e.e: anchoring the pattern stopped a real MAC being found');
}

// --- 3f. `key:MAC` is the ordinary spelling and must still be found. ---
// The first anchoring attempt used a hex-character lookbehind, which cannot
// tell "the last letter of an English word" from "the second digit of a hex
// pair" -- and `a` through `f` are ordinary letters. So `device:`, `mac-`,
// `id:`, `source:`, `cache:`, `trace:`, `interface:` all blocked the match,
// which is the most natural spelling in a log line or a header.
//
// Trading a corruption for a silent miss is not a fix. A MAC is a maximal run
// of EXACTLY six hex pairs; that is the concept, and it is what the pattern
// now says rather than approximating it with two characters of lookbehind.
{
    for (const value of ['device:AA:BB:CC:DD:EE:FF', 'mac-AA:BB:CC:DD:EE:FF',
        'id:AA:BB:CC:DD:EE:FF', 'source:AA:BB:CC:DD:EE:FF', 'cache:AA:BB:CC:DD:EE:FF',
        'interface:AA:BB:CC:DD:EE:FF', 'router:AA:BB:CC:DD:EE:FF',
        'device-AA-BB-CC-DD-EE-FF', 'Interface eth0 mac:AA:BB:CC:DD:EE:FF up']) {
        assert.strictEqual(found({ log: value }, 'mac-address').length, 1,
            `3f.a: a real MAC was missed in ${JSON.stringify(value)}`);
    }

    // ...while the run that is longer than six pairs is still not carved,
    // however it is introduced.
    for (const value of ['device:AA:BB:CC:DD:EE:FF:11:22', 'fingerprint:AA:BB:CC:DD:EE:FF:11:22:33:44']) {
        assert.strictEqual(found({ log: value }, 'mac-address').length, 0,
            `3f.b: a longer run was carved into a MAC in ${JSON.stringify(value)}`);
    }
}

// --- 3g. The hex-run predicate, checked as a PROPERTY rather than a list. ---
// Cases 3, 3e and 3f are a curated list of spellings, and a curated list is a
// predicate about which spellings matter. Mine has been wrong twice: it missed
// the fingerprint carving, then it missed `device:` suppressing a real match.
// Both times the list passed and the code was wrong.
//
// The property is checkable, so check the property. For a delimited hex run in
// any surrounding context:
//
//     detected as a MAC  <=>  the run is exactly six pairs
//     and the detection is the WHOLE run, never a piece of one
//
// This fails against both of my earlier attempts: the unanchored pattern
// carves matches out of the long runs, and the lookbehind-anchored one goes
// silent in every `word:` context whose word ends in a-f.
{
    // Deterministic, so a failure reproduces exactly. No external dependency.
    let seed = 20260830;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const hex = '0123456789ABCDEF';
    const pair = () => hex[rand(16)] + hex[rand(16)];

    // Words chosen so half end in a hex-valid letter -- that is the trap the
    // lookbehind fell into, and a generator that avoided them would be the
    // same blind spot one level up.
    const prefixes = ['device', 'source', 'id', 'mac', 'cache', 'trace', 'interface', 'face',
        'router', 'peer', 'gateway', 'host', 'client'];
    const contexts = [
        (r) => r,
        (r) => `${prefixes[rand(prefixes.length)]}:${r}`,
        (r) => `${prefixes[rand(prefixes.length)]}-${r}`,
        (r) => `${prefixes[rand(prefixes.length)]} ${r}`,
        (r) => `[${r}]`,
        (r) => `(${r})`,
        (r) => `value=${r};`,
        (r) => `saw ${r} on the wire`,
        (r) => `${r},next`,
        (r) => `${r}.`,
    ];

    let checked = 0;
    for (let pairCount = 1; pairCount <= 12; pairCount++) {
        for (const sep of [':', '-']) {
            for (let c = 0; c < contexts.length; c++) {
                const pairs = [];
                for (let i = 0; i < pairCount; i++) pairs.push(pair());
                const run = pairs.join(sep);
                // Skip anything that happens to wear the fake marker; that
                // exemption is case 5's subject, not this one.
                if (/^06[:-]F0[:-]0D[:-]/i.test(run)) continue;

                const text = contexts[c](run);
                const hits = pii.detectPii(bodyHar({ note: text })).filter((d) => d.type === 'mac-address');
                checked++;

                if (pairCount === 6) {
                    assert.strictEqual(hits.length, 1,
                        `3g.a: a six-pair run was not detected in ${JSON.stringify(text)}`);
                    assert.strictEqual(hits[0].value, run,
                        `3g.b: the detection was not the whole run in ${JSON.stringify(text)}`);
                } else {
                    assert.strictEqual(hits.length, 0,
                        `3g.c: a ${pairCount}-pair run produced a MAC detection in ${JSON.stringify(text)}`);
                }
            }
        }
    }
    assert.ok(checked > 200, `3g.d: only ${checked} cases generated; the property was barely exercised`);
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
