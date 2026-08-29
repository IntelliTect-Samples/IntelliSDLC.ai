#!/usr/bin/env node
// Behavior tests for national phone spellings and cookie walking
// (issue #297, Stage 6, Tasks 6.3 and 6.4).
//
// Zero-dep, runs with `node pii-phone-cookies.test.js`.
//
// Two gaps the issue names:
//
//   * `RE.phone` was `/\+\d{10,15}\b/` -- E.164 only. `(555) 123-4567`,
//     `555-123-4567` and a bare `5551234567` all survived the scrub, and those
//     are how a US API actually spells a phone number.
//   * `detectPii()` never walked `request.cookies` / `response.cookies`. The
//     raw `Cookie` HEADER sweep caught some of it incidentally, which is not
//     the same as covering the structured arrays.
//
// The bare ten-digit case is the dangerous one and is deliberately gated on
// field name. An unqualified ten-digit run is an order id, a timestamp in
// centiseconds, a product code -- this is the credit-card mistake waiting to
// happen in a new column, and a scrub false positive corrupts the artifact.

'use strict';

const assert = require('assert');
const path = require('path');

const pii = require(path.join(__dirname, 'pii.js'));

function detect(har) {
    return pii.detectPii(har);
}

function types(detections, type) {
    return detections.filter((d) => d.type === type);
}

function bodyHar(obj) {
    return { log: { entries: [{
        request: { method: 'GET', url: 'https://example.com/a', headers: [], cookies: [], queryString: [] },
        response: { status: 200, headers: [], cookies: [],
            content: { mimeType: 'application/json', text: JSON.stringify(obj) } },
    }] } };
}

// --- 1. The E.164 form still works. ---
{
    const d = types(detect(bodyHar({ contact: '+14155559876' })), 'phone');
    assert.strictEqual(d.length, 1, '1.a: the E.164 form stopped being detected');
}

// --- 2. National spellings are detected, context-free. ---
// These carry their own punctuation, which is what makes them safe to match
// without a field name: a run of digits grouped 3-3-4 with separators is a
// phone number far more often than it is anything else.
{
    for (const value of ['(555) 123-4567', '555-123-4567', '555.123.4567',
        '(555)123-4567', '+1 (555) 123-4567', '1-555-123-4567']) {
        const d = types(detect(bodyHar({ contact: value })), 'phone');
        assert.strictEqual(d.length, 1, `2.a: ${JSON.stringify(value)} was not detected as a phone`);
    }
}

// --- 3. A bare ten-digit run needs a phone-named field. ---
// This is the credit-card lesson applied before it bites: an unqualified digit
// run has no provenance. `order_id: 5551234567` is not a phone number, and
// scrubbing it writes a fake number over a real identifier.
{
    const named = types(detect(bodyHar({ phone: '5551234567' })), 'phone');
    assert.strictEqual(named.length, 1, '3.a: a bare run in a `phone` field was not detected');

    for (const key of ['order_id', 'transaction_id', 'sequence', 'timestamp', 'sku']) {
        const d = types(detect(bodyHar({ [key]: '5551234567' })), 'phone');
        assert.strictEqual(d.length, 0,
            `3.b: a bare ten-digit run in \`${key}\` was scrubbed as a phone number`);
    }
}

// --- 4. The phone field names cover the usual spellings. ---
{
    for (const key of ['phone', 'phone_number', 'phoneNumber', 'mobile', 'mobile_number',
        'cell', 'cell_phone', 'telephone', 'tel', 'home_phone', 'work_phone', 'contact_phone']) {
        const d = types(detect(bodyHar({ [key]: '5551234567' })), 'phone');
        assert.strictEqual(d.length, 1, `4.a: \`${key}\` did not gate a bare run as a phone`);
    }
}

// --- 5. A number the scrubber already faked is not re-detected. ---
// The exemption is the EXACT emitted shape, `+1555XXXXXXX`, and nothing wider.
// Normalising punctuation away before the test would turn a real
// `+1 (555) 123-4567` into that shape and exempt it -- an exemption is a hole
// by construction, so it must recognise our own output and not one character
// more.
//
// ACCEPTED BLIND SPOT: a real number written exactly as `+1555XXXXXXX` is
// indistinguishable from the fake and is not detected. 555 is the NANP range
// reserved for fiction, so a genuine one is vanishingly unlikely -- but it is a
// gap, not an absence of one, and the alternative (a fake that is not
// recognisable as fake) would make every re-scrub report its own output.
{
    const fake = pii.fakeFor('phone', 'anything');
    assert.ok(/^\+1555\d{7}$/.test(fake), `5.pre: the fake shape changed (${fake})`);
    assert.strictEqual(types(detect(bodyHar({ contact: fake })), 'phone').length, 0,
        `5.a: the scrubber re-detected its own fake (${fake})`);

    // A punctuated 555 number is NOT the emitted shape, and is still detected.
    assert.strictEqual(types(detect(bodyHar({ contact: '+1 (555) 123-4567' })), 'phone').length, 1,
        '5.b: a real punctuated 555 number was exempted as though it were our own fake');
}

// --- 6. A phone number is not also reported as a credit card. ---
// `5551234567` is ten digits; the card predicate needs an assigned issuer
// identifier at a length that issuer mints, so this must not double-report.
{
    const d = detect(bodyHar({ phone: '5551234567' }));
    assert.strictEqual(types(d, 'credit-card').length, 0,
        '6.a: a phone number was also reported as a credit card');
}

// --- 7. Cookies are walked, in both directions. ---
// The raw Cookie header sweep caught some of this incidentally. Incidentally
// is not a control: a structured cookie array is where a scrubber should look,
// and `response.cookies` was never scanned at all.
{
    const har = { log: { entries: [{
        request: {
            method: 'GET', url: 'https://example.com/a', headers: [], queryString: [],
            cookies: [{ name: 'user_email', value: 'someone@realdomain.example' }],
        },
        response: {
            status: 200, headers: [], content: { mimeType: 'application/json', text: '{}' },
            cookies: [{ name: 'contact', value: '(555) 123-4567' }],
        },
    }] } };
    const d = detect(har);
    assert.strictEqual(types(d, 'email').length, 1,
        '7.a: PII in request.cookies[] was not detected');
    assert.strictEqual(types(d, 'phone').length, 1,
        '7.b: PII in response.cookies[] was not detected');
}

// --- 8. A cookie NAME can gate its value, like any other field. ---
{
    const har = { log: { entries: [{
        request: {
            method: 'GET', url: 'https://example.com/a', headers: [], queryString: [],
            cookies: [{ name: 'billing_city', value: 'Springfield' }],
        },
        response: { status: 200, headers: [], cookies: [], content: { mimeType: 'application/json', text: '{}' } },
    }] } };
    assert.strictEqual(types(detect(har), 'city').length, 1,
        '8.a: a cookie whose NAME denotes a PII field was not classified by it');
}

// --- 9. A session cookie is not mistaken for PII. ---
// `_ga`, `sessionid` and friends are opaque handles. They are secrets by name
// (har-secrets.js covers them) and must not be run through the PII faker,
// which would replace a session token with a fake city.
{
    const har = { log: { entries: [{
        request: {
            method: 'GET', url: 'https://example.com/a', headers: [], queryString: [],
            cookies: [
                { name: '_ga', value: 'GA1.2.1234567890.1234567890' },
                { name: 'sessionid', value: 'abc123def456ghi789' },
                { name: 'csrftoken', value: 'zzzzYYYYxxxx1111' },
            ],
        },
        response: { status: 200, headers: [], cookies: [], content: { mimeType: 'application/json', text: '{}' } },
    }] } };
    for (const t of ['person-name', 'city', 'street-address', 'region', 'country', 'postal-code']) {
        assert.strictEqual(types(detect(har), t).length, 0,
            `9.a: a session cookie was classified as ${t}`);
    }
}

// --- 10. Scrubbing actually replaces what is detected in a cookie. ---
// Detection that never reaches the scrub is a report nobody acts on.
{
    const har = { log: { entries: [{
        request: {
            method: 'GET', url: 'https://example.com/a', headers: [], queryString: [],
            cookies: [{ name: 'user_email', value: 'someone@realdomain.example' }],
        },
        response: { status: 200, headers: [], cookies: [], content: { mimeType: 'application/json', text: '{}' } },
    }] } };
    pii.scrubPii(har);
    const value = har.log.entries[0].request.cookies[0].value;
    assert.ok(!value.includes('realdomain'),
        `10.a: a detected cookie value was reported but never scrubbed (still ${JSON.stringify(value)})`);
}

console.log('All pii-phone-cookies tests passed');
