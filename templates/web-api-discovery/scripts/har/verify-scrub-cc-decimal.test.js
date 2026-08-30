#!/usr/bin/env node
/**
 * Behavior tests for issue #292: verify-scrub flagged the FRACTIONAL DIGITS of
 * decimal numbers as credit-card leaks.
 *
 * `.` is a non-word character, so /\b\d{13,19}\b/ matched between a decimal
 * point and the first fractional digit. A HAR's own timing values routinely
 * carry 14 fractional digits of IEEE-754 noise ("time":168.01500000000001),
 * and ~10% of any digit run is Luhn-valid by chance -- so real captures were
 * rejected outright, and the operator was told they had leaked a card.
 *
 * The gate must still do its actual job: a genuine card is a leak.
 *
 * Zero-dep: relies only on the Node assert module. Exits non-zero on first
 * failure so it can be wired into a Pester wrapper.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const VERIFY = path.join(SCRIPTS_DIR, 'verify-scrub.js');

function tmpHarWith(value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dec-test-'));
    const har = {
        log: {
            version: '1.2',
            creator: { name: 'cc-dec-test', version: '1' },
            entries: [{
                request: { method: 'GET', url: 'https://x.invalid/', headers: [] },
                response: {
                    status: 200,
                    statusText: 'OK',
                    headers: [{ name: 'content-type', value: 'application/json' }],
                    content: { mimeType: 'application/json', text: JSON.stringify({ v: value }) }
                }
            }]
        }
    };
    const harPath = path.join(dir, 'sample.har');
    fs.writeFileSync(harPath, JSON.stringify(har));
    return harPath;
}

function runVerify(harPath) {
    try {
        execFileSync('node', [VERIFY, '--in', harPath], { stdio: 'pipe' });
        return { code: 0, stdout: '', stderr: '' };
    } catch (e) {
        return {
            code: e.status,
            stdout: (e.stdout || '').toString(),
            stderr: (e.stderr || '').toString()
        };
    }
}

function luhn(s) {
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
        let d = +s[i];
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d; alt = !alt;
    }
    return sum % 10 === 0;
}

/**
 * A Luhn-valid digit run of the requested length, carrying the Visa issuer
 * identifier (leading `4`) so that the length under test is the only thing
 * that varies. Note that only lengths Visa actually mints (13/16/19) are
 * cards at all after issue #295 -- the cases below that expect exit 0 at
 * other lengths would pass for that reason alone, which is why
 * `verify-scrub-cc-iin.test.js` re-tests the decimal lookarounds at a
 * length the issuer check does NOT already reject.
 */
function luhnRunOfLength(len) {
    let base = BigInt('49' + '0'.repeat(len - 2));
    for (let i = 0n; i < 1000n; i++) {
        const s = (base + i).toString();
        if (s.length === len && luhn(s)) return s;
    }
    throw new Error('no luhn-valid run generated for length ' + len);
}

// Since issue #297 Stage 7, a card is IDENTITY-class shape evidence: it exits
// with the ADVISORY code, not the gating one. Non-zero either way -- it is the
// ARTIFACT that survives an advisory finding, not the exit code -- but the two
// codes mean different things to capture-har.js, so these assert the exact one.
// Loosening them to "non-zero" would let the change be quietly undone by making
// credit-card gate again, which is the one repair that must not pass here.
const EXIT_ADVISORY = 4;

let passed = 0;

// ===================================================================
// Case 1: the real-world regression -- a HAR timing float whose
// fractional part is Luhn-valid. Shaped exactly like the values that
// rejected a live 148-entry capture ("time":168.01500000000001), but
// with the fractional digits derived so the precondition is guaranteed
// rather than dependent on which float happened to be sampled.
// ===================================================================
{
    const fractional = luhnRunOfLength(14);
    assert.ok(luhn(fractional), 'precondition: fractional part is Luhn-valid');
    const timing = '168.' + fractional;

    const har = tmpHarWith(timing);
    const r = runVerify(har);
    assert.strictEqual(
        r.code, 0,
        'expected exit 0 for a HAR timing float, got ' + r.code +
        '\nstderr: ' + r.stderr
    );
    passed++;
}

// ===================================================================
// Case 2: the integer part of a decimal is not a card either.
// ===================================================================
{
    const intPart = luhnRunOfLength(16);
    const har = tmpHarWith(intPart + '.45');
    const r = runVerify(har);
    assert.strictEqual(
        r.code, 0,
        'expected exit 0 for the integer part of a decimal, got ' + r.code +
        '\nstderr: ' + r.stderr
    );
    passed++;
}

// ===================================================================
// Case 3: THE GATE STILL WORKS. A genuine Luhn-valid card is a leak.
// Without this, the fix could be "suppress everything" and still pass.
// ===================================================================
{
    const card = luhnRunOfLength(16);
    assert.ok(luhn(card), 'precondition: ' + card + ' is luhn-valid');
    const har = tmpHarWith(card);
    const r = runVerify(har);
    assert.strictEqual(
        r.code, EXIT_ADVISORY,
        'expected the advisory exit for a real 16-digit credit card, got ' + r.code +
        '\nstdout: ' + r.stdout + '\nstderr: ' + r.stderr
    );
    assert.match(r.stderr, /credit-card/, 'expected credit-card leak label');
    passed++;
}

// ===================================================================
// Case 4: a card followed by SENTENCE punctuation is still caught.
// The lookahead requires a digit after the dot, not merely a dot --
// otherwise "...card 4242424242424242." would silently pass.
// ===================================================================
{
    const card = luhnRunOfLength(16);
    const har = tmpHarWith('the card on file is ' + card + '. Please remove it.');
    const r = runVerify(har);
    assert.strictEqual(
        r.code, EXIT_ADVISORY,
        'expected the advisory exit for a card followed by a period, got ' + r.code +
        '\nstderr: ' + r.stderr
    );
    passed++;
}

// ===================================================================
// Case 5: issue #87's behavior still holds -- a Unix-ms timestamp is
// not a card. Since issue #295 that follows from `17` not being an
// assigned issuer identifier rather than from a millisecond window.
// ===================================================================
{
    const ts = '1777603192214';
    assert.ok(luhn(ts), 'precondition: ' + ts + ' should be luhn-valid');
    const har = tmpHarWith(ts);
    const r = runVerify(har);
    assert.strictEqual(
        r.code, 0,
        'expected exit 0 for a recent Unix-ms timestamp, got ' + r.code +
        '\nstderr: ' + r.stderr
    );
    passed++;
}

console.log('verify-scrub-cc-decimal: ' + passed + ' case(s) passed');
