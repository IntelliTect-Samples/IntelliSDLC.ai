#!/usr/bin/env node
// Behavior tests for the structural HAR walk (issue #297, Stage 3).
//
// Zero-dep, runs with `node har-shapes-walk.test.js`. Exits non-zero on first
// failure.
//
// Two defects motivate this, both measured in the consuming repo:
//
//   1. A finding was `credit-card (fingerprint 4f2a..., 13 chars)` x1413 with
//      the file deleted. No location, so nothing could be triaged -- the
//      operator could not tell 1413 trip ids from one real card.
//   2. `findLeaksDeep` regexed the whole serialized document, so `log.comment`
//      and `log.creator` -- fields WE wrote -- were scanned as if they were
//      wire data. A documented source of the 1134 findings.
//
// A location is not a secret. Only the value is, and no finding carries one.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-walk-'));

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';        // hex32, secret class
const SECRET2 = 'ffee0011223344556677889900aabbcc';
const CARD = '4111111111111111';                            // identity class

function loadPolicy(project) {
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    if (project) {
        fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME), JSON.stringify(project));
    }
    return policyModule.loadPolicy({ startDir: dir, stopAt: dir });
}

function har(entries, extra) {
    return { log: Object.assign({ version: '1.2', entries }, extra) };
}

function entry(over) {
    return Object.assign({
        request: { method: 'GET', url: 'https://example.com/api', headers: [], cookies: [], queryString: [] },
        response: { status: 200, headers: [], cookies: [], content: { mimeType: 'application/json', text: '{}' } },
    }, over);
}

function only(findings, kind) {
    const hits = findings.filter((f) => f.kind === kind);
    assert.strictEqual(hits.length, 1, `expected exactly one ${kind} finding, got ${hits.length}: ` +
        JSON.stringify(hits.map((h) => h.keyPath)));
    return hits[0];
}

// --- 1. A finding in a response body reports its JSON key path and entry. ---
{
    const doc = har([
        entry(),
        entry({
            response: {
                status: 200, headers: [], cookies: [],
                content: { mimeType: 'application/json', text: JSON.stringify({ data: { user: { token: SECRET } } }) },
            },
        }),
    ]);
    const f = only(shapes.findLeaksInHar(doc), 'hex32');
    assert.strictEqual(f.entryIndex, 1, '1.a: wrong entry index');
    assert.strictEqual(f.keyPath, 'response.content.text.data.user.token',
        `1.b: key path is ${JSON.stringify(f.keyPath)}; a finding with no location cannot be triaged`);
}

// --- 2. Array positions are part of the path. ---
{
    const doc = har([entry({
        response: {
            status: 200, headers: [], cookies: [],
            content: { mimeType: 'application/json', text: JSON.stringify({ users: [{ id: 1 }, { key: SECRET }] }) },
        },
    })]);
    assert.strictEqual(only(shapes.findLeaksInHar(doc), 'hex32').keyPath,
        'response.content.text.users[1].key', '2.a: array index missing from the key path');
}

// --- 3. The HAR envelope is never scanned -- we wrote it. ---
// This is the one that manufactured findings out of our own annotations.
{
    const doc = har([entry()], {
        comment: `scrubbed with token ${SECRET}`,
        creator: { name: `tool-${SECRET2}`, version: '1.0' },
        pages: [{ id: 'p1', comment: `page ${SECRET}` }],
    });
    assert.deepStrictEqual(shapes.findLeaksInHar(doc), [],
        '3.a: a value in log.comment / log.creator / log.pages[].comment was reported -- those are ' +
        'fields we wrote, not wire data, and scanning them is a documented source of the 1134');
}

// --- 4. Every wire-carrying node is walked. ---
{
    const places = {
        'request.headers[0].value': entry({
            request: { method: 'GET', url: 'https://example.com/api', cookies: [], queryString: [],
                headers: [{ name: 'x-trace', value: SECRET }] },
        }),
        'request.cookies[0].value': entry({
            request: { method: 'GET', url: 'https://example.com/api', headers: [], queryString: [],
                cookies: [{ name: 'sid', value: SECRET }] },
        }),
        'request.queryString[0].value': entry({
            request: { method: 'GET', url: 'https://example.com/api', headers: [], cookies: [],
                queryString: [{ name: 'k', value: SECRET }] },
        }),
        'request.postData.text': entry({
            request: { method: 'POST', url: 'https://example.com/api', headers: [], cookies: [], queryString: [],
                postData: { mimeType: 'text/plain', text: SECRET } },
        }),
        'request.postData.params[0].value': entry({
            request: { method: 'POST', url: 'https://example.com/api', headers: [], cookies: [], queryString: [],
                postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'k', value: SECRET }] } },
        }),
        'response.headers[0].value': entry({
            response: { status: 200, cookies: [], content: { mimeType: 'application/json', text: '{}' },
                headers: [{ name: 'x-set', value: SECRET }] },
        }),
        'response.cookies[0].value': entry({
            response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{}' },
                cookies: [{ name: 'sid', value: SECRET }] },
        }),
    };
    for (const expected of Object.keys(places)) {
        const f = only(shapes.findLeaksInHar(har([places[expected]])), 'hex32');
        assert.strictEqual(f.keyPath, expected, `4.a: expected key path ${expected}, got ${f.keyPath}`);
    }
}

// --- 5. The request URL is wire data too. ---
{
    const doc = har([entry({
        request: { method: 'GET', url: `https://example.com/api?token=${SECRET}`, headers: [], cookies: [], queryString: [] },
    })]);
    assert.strictEqual(only(shapes.findLeaksInHar(doc), 'hex32').keyPath, 'request.url',
        '5.a: a secret in the request URL was not found');
}

// --- 6. A percent-encoded payload still reports, naming what encloses it. ---
// The decoded view has no structural path of its own -- the offset is inside a
// string, not at a JSON key -- so keyPath is null and the enclosing node is
// named instead. Silence here is not an option: this is the layer the real
// `fb_dtsg` leak hid in.
{
    const doc = har([entry({
        request: {
            method: 'POST', url: 'https://example.com/api', headers: [], cookies: [], queryString: [],
            postData: {
                mimeType: 'application/x-www-form-urlencoded',
                params: [{ name: 'variables', value: `%7B%22t%22%3A%22${SECRET}%22%7D` }],
            },
        },
    })]);
    const f = only(shapes.findLeaksInHar(doc), 'hex32');
    assert.strictEqual(f.keyPath, null, '6.a: a decoded-shadow finding claimed a structural key path it cannot have');
    assert.strictEqual(f.enclosing, 'request.postData.params[0].value',
        '6.b: a decoded-shadow finding did not name the parameter enclosing it');
    assert.strictEqual(f.entryIndex, 0, '6.c');
}

// --- 7. Occurrences are grouped by fingerprint and counted. ---
// 1413 identical findings is not 1413 problems. One finding with a count is
// triageable; 1413 lines is what taught readers to ignore the gate.
{
    const doc = har([
        entry({ request: { method: 'GET', url: 'https://example.com/a', cookies: [], queryString: [],
            headers: [{ name: 'x-a', value: SECRET }] } }),
        entry({ request: { method: 'GET', url: 'https://example.com/b', cookies: [], queryString: [],
            headers: [{ name: 'x-b', value: SECRET }] } }),
        entry({ response: { status: 200, headers: [], cookies: [],
            content: { mimeType: 'application/json', text: JSON.stringify({ t: SECRET }) } } }),
    ]);
    const findings = shapes.findLeaksInHar(doc);
    const f = only(findings, 'hex32');
    assert.strictEqual(f.count, 3, `7.a: expected an occurrence count of 3, got ${f.count}`);
    assert.strictEqual(f.entryIndex, 0, '7.b: the reported location is not the first occurrence');
    assert.strictEqual(f.keyPath, 'request.headers[0].value', '7.c');

    // Two DIFFERENT values of the same kind stay two findings.
    const two = har([entry({ request: { method: 'GET', url: 'https://example.com/a', cookies: [], queryString: [],
        headers: [{ name: 'x-a', value: SECRET }, { name: 'x-b', value: SECRET2 }] } })]);
    assert.strictEqual(shapes.findLeaksInHar(two).filter((l) => l.kind === 'hex32').length, 2,
        '7.d: two distinct secrets of the same kind were collapsed into one finding');
}

// --- 8. The policy governs the walk exactly as it governs a text scan. ---
{
    const doc = har([entry({ response: { status: 200, headers: [], cookies: [],
        content: { mimeType: 'application/json', text: JSON.stringify({ card: CARD, tok: SECRET }) } } })]);

    const def = shapes.findLeaksInHar(doc, loadPolicy());
    assert.strictEqual(only(def, 'credit-card').gating, false, '8.a: identity shape gated by default');
    assert.strictEqual(only(def, 'hex32').gating, true, '8.b: secret shape did not gate');

    const waived = loadPolicy({ waivers: [{ kind: 'hex32', fingerprint: shapes.fingerprint(SECRET), reason: 'vendor sha' }] });
    assert.strictEqual(only(shapes.findLeaksInHar(doc, waived), 'hex32').waived, true,
        '8.c: a waiver did not reach the structural walk');

    // No policy still means strictest, as in findLeaks.
    assert.strictEqual(only(shapes.findLeaksInHar(doc), 'credit-card').gating, true,
        '8.d: an absent policy downgraded the walk');
}

// --- 9. A non-JSON body is still scanned, as text. ---
{
    const doc = har([entry({ response: { status: 200, headers: [], cookies: [],
        content: { mimeType: 'text/html', text: `<script>var k="${SECRET}"</script>` } } })]);
    assert.strictEqual(only(shapes.findLeaksInHar(doc), 'hex32').keyPath, 'response.content.text',
        '9.a: a body that is not JSON was skipped -- asset and JS bodies carry protocol constants');
}

// --- 10. No finding ever carries the value. ---
{
    const doc = har([entry({ response: { status: 200, headers: [], cookies: [],
        content: { mimeType: 'application/json', text: JSON.stringify({ card: CARD, tok: SECRET }) } } })]);
    for (const f of shapes.findLeaksInHar(doc)) {
        const s = JSON.stringify(f);
        assert.ok(!s.includes(SECRET) && !s.includes(CARD),
            '10.a: a finding carried the matched value');
    }
}

// --- 11. A malformed HAR yields no findings rather than throwing. ---
// The walk runs inside a gate. A gate that crashes on an odd document fails
// open in whatever wrapper catches it, which is worse than reporting nothing.
{
    for (const bad of [null, {}, { log: null }, { log: {} }, { log: { entries: null } }, { log: { entries: [null] } }]) {
        assert.deepStrictEqual(shapes.findLeaksInHar(bad), [],
            `11.a: findLeaksInHar threw or reported on ${JSON.stringify(bad)}`);
    }
}

// --- 12. An entry field nobody anticipated is still wire data. ---
// The scoping fix is about PROVENANCE, not about a list of interesting nodes.
// An allowlist of the fields somebody thought of is how a secret in a capture
// tool's custom field walks through a gate that then reports itself clean.
{
    const doc = har([entry({ _customCapture: { note: SECRET } })]);
    assert.strictEqual(only(shapes.findLeaksInHar(doc), 'hex32').keyPath, '_customCapture.note',
        '12.a: a secret in an unanticipated entry field was skipped');
}

// --- 13. ...but the entry's OWN bookkeeping fields are not. ---
{
    const doc = har([entry({ comment: `scrubbed ${SECRET}`, timings: { note: SECRET }, cache: { note: SECRET } })]);
    assert.deepStrictEqual(shapes.findLeaksInHar(doc), [],
        '13.a: an entry field we wrote ourselves was reported as a leak');
}

// --- 14. The skip is structural, never a key name matched at any depth. ---
// `comment` is our field on an entry and somebody's actual content in a
// response body. A gate that confused the two would hide real data under the
// most ordinary field name on the internet.
{
    const doc = har([entry({
        response: { status: 200, headers: [], cookies: [], content: { mimeType: 'application/json',
            text: JSON.stringify({ post: { comment: SECRET, cache: SECRET2 } }) } },
    })]);
    const found = shapes.findLeaksInHar(doc).map((f) => f.keyPath).sort();
    assert.deepStrictEqual(found,
        ['response.content.text.post.cache', 'response.content.text.post.comment'],
        '14.a: a body field named `comment` or `cache` was skipped as if it were our own bookkeeping');
}

// --- 15. A value that is not quoted in the JSON is still a value. ---
// Replacing a text sweep with a structural walk is exactly where coverage
// gets narrowed by accident: walking only STRING leaves means a card an API
// serialises as a bare JSON number is never looked at, while the old
// whole-document regex found it because quoting is invisible to a regex.
//
// JSON number syntax means this can only ever hide the digit-run patterns --
// a JWT or a hex token could not parse as a number -- but `credit-card` is
// precisely a digit run, and a project may opt that class up to `gate`.
{
    const doc = har([entry({
        response: { status: 200, headers: [], cookies: [],
            content: { mimeType: 'application/json', text: '{"card":4111111111111111}' } },
    })]);
    const f = only(shapes.findLeaksInHar(doc), 'credit-card');
    assert.strictEqual(f.keyPath, 'response.content.text.card',
        '15.a: a card stored as an unquoted JSON number was not found by the structural walk');
}

// --- 16. ...and a float is still not a card. ---
// The lookarounds that keep a decimal's fractional part out of the card slot
// (issues #292/#293) must survive the change: a HAR is full of floats, ~10% of
// whose digit runs are Luhn-valid by chance, and re-reporting them would undo
// the fix that made this gate usable at all.
{
    const doc = har([entry({
        response: { status: 200, headers: [], cookies: [],
            content: { mimeType: 'application/json', text: '{"elapsed":168.01500000000001,"ratio":0.4111111111111111}' } },
    })]);
    assert.deepStrictEqual(shapes.findLeaksInHar(doc), [],
        '16.a: a decimal number was reported as a credit card again');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-shapes-walk tests passed');
