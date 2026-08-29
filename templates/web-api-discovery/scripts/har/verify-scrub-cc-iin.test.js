#!/usr/bin/env node
/**
 * Behavior tests for issue #295: verify-scrub flagged an API's own numeric
 * identifiers as credit-card leaks.
 *
 * The predicate the `credit-card` slot implemented was "Luhn-valid 13-19 digit
 * run". That is not the predicate "credit card number": ~10% of ALL digit runs
 * are Luhn-valid by chance, so every long numeric id in a real JSON API --
 * trip ids, step ids, photo ids -- had a one-in-ten chance of being reported
 * as a leaked card. A rejected scrub deletes its own output, so the gate
 * produced no reference at all from any real capture.
 *
 * The fix is to tighten the predicate rather than to add another suppression
 * window: a card number also carries an ASSIGNED issuer identifier (IIN) at a
 * LENGTH that issuer actually mints. `17...` (a Unix-ms timestamp) and `98...`
 * are not assigned to anyone.
 *
 * No real card number appears in this file. Brand coverage uses the published
 * publisher TEST numbers; lengths with no published test number use a
 * deterministically derived Luhn-valid run with the documented IIN prefix.
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

const VERIFY = path.join(__dirname, 'verify-scrub.js');

function tmpHarWith(value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-iin-test-'));
    const har = {
        log: {
            version: '1.2',
            creator: { name: 'cc-iin-test', version: '1' },
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
 * The smallest Luhn-valid digit run of `len` digits starting with `prefix`.
 * Deterministic, so a failure names a reproducible value -- never a captured one.
 */
function luhnRun(prefix, len) {
    assert.ok(len > prefix.length, 'prefix must be shorter than the length');
    // padStart keeps a leading-zero prefix (e.g. "00") intact through BigInt.
    const base = BigInt(prefix + '0'.repeat(len - prefix.length));
    for (let i = 0n; i < 100n; i++) {
        const s = (base + i).toString().padStart(len, '0');
        if (s.length === len && s.startsWith(prefix) && luhn(s)) return s;
    }
    throw new Error('no Luhn-valid run for prefix ' + prefix + ' at length ' + len);
}

let passed = 0;

function expectLeak(value, why) {
    assert.ok(luhn(value), 'precondition: ' + why + ' must be Luhn-valid');
    const r = runVerify(tmpHarWith(value));
    assert.strictEqual(
        r.code, 3,
        'expected exit 3 (leak) for ' + why + ' [len ' + value.length + '], got ' + r.code +
        '\nstderr: ' + r.stderr
    );
    assert.match(r.stderr, /credit-card/, 'expected credit-card label for ' + why);
    passed++;
}

function expectClean(value, why) {
    assert.ok(luhn(value), 'precondition: ' + why + ' must be Luhn-valid (else the test is vacuous)');
    const r = runVerify(tmpHarWith(value));
    assert.strictEqual(
        r.code, 0,
        'expected exit 0 (not a card) for ' + why + ' [len ' + value.length + '], got ' + r.code +
        '\nstderr: ' + r.stderr
    );
    passed++;
}

// ===================================================================
// Case group 1: published publisher TEST card numbers are detected.
// These are the industry-published sandbox numbers, not real cards.
// ===================================================================
expectLeak('4111111111111111', 'Visa test card, 16 digits');
expectLeak('4222222222222', 'Visa test card, 13 digits');
expectLeak('5555555555554444', 'Mastercard test card, 51-55 range');
expectLeak('2223003122003222', 'Mastercard test card, 2-series range');
expectLeak('378282246310005', 'American Express test card, 34/37 at 15 digits');
expectLeak('371449635398431', 'American Express test card, 37 prefix');
expectLeak('6011111111111117', 'Discover test card, 6011 prefix');
expectLeak('3530111333300000', 'JCB test card, 3528-3589 range');
expectLeak('6200000000000005', 'UnionPay test card, 62 prefix');
expectLeak('30569309025904', 'Diners Club test card, 300-305 range at 14 digits');
expectLeak('36227206271667', 'Diners Club test card, 36 prefix');
expectLeak('38520000023237', 'Diners Club test card, 38-39 range');

// ===================================================================
// Case group 2: assigned IIN ranges and brand lengths with no published
// test number. Derived, never captured.
// ===================================================================
expectLeak(luhnRun('4', 19), 'Visa at its 19-digit length');
expectLeak(luhnRun('51', 16), 'Mastercard low edge of 51-55');
expectLeak(luhnRun('2221', 16), 'Mastercard low edge of 2221-2720');
expectLeak(luhnRun('2720', 16), 'Mastercard high edge of 2221-2720');
expectLeak(luhnRun('34', 15), 'American Express 34 prefix');
expectLeak(luhnRun('644', 16), 'Discover low edge of 644-649');
expectLeak(luhnRun('649', 16), 'Discover high edge of 644-649');
expectLeak(luhnRun('65', 19), 'Discover 65 prefix at its 19-digit length');
expectLeak(luhnRun('3528', 17), 'JCB low edge of 3528-3589 at 17 digits');
expectLeak(luhnRun('3589', 19), 'JCB high edge of 3528-3589 at 19 digits');
expectLeak(luhnRun('62', 18), 'UnionPay at 18 digits');
expectLeak(luhnRun('3095', 17), 'Diners 3095 prefix at 17 digits');
expectLeak(luhnRun('39', 19), 'Diners 38-39 range at 19 digits');

// ===================================================================
// Case group 3: the issue #295 false positives. A Luhn-valid digit run
// whose leading digits are not an assigned IIN is not a card. Only the
// leading digits and the length are recorded here -- never a captured
// value.
// ===================================================================
expectClean(luhnRun('17', 17), 'Luhn-valid 17-digit run beginning 17');
expectClean(luhnRun('98', 16), 'Luhn-valid 16-digit run beginning 98');
expectClean('1777603192214', 'a Unix-millisecond timestamp (13 digits, begins 17)');
for (const prefix of ['00', '10', '19', '70', '79', '80', '90', '99']) {
    for (const len of [13, 14, 15, 16, 17, 18, 19]) {
        expectClean(luhnRun(prefix, len), 'unassigned IIN prefix ' + prefix);
    }
}

// ===================================================================
// Case group 4: an assigned IIN at a length its issuer does not mint is
// not a card either. Length is half the predicate.
// ===================================================================
expectClean(luhnRun('4', 14), 'Visa prefix at 14 digits (Visa mints 13/16/19)');
expectClean(luhnRun('4', 15), 'Visa prefix at 15 digits');
expectClean(luhnRun('4', 17), 'Visa prefix at 17 digits');
expectClean(luhnRun('4', 18), 'Visa prefix at 18 digits');
expectClean(luhnRun('34', 16), 'Amex prefix at 16 digits (Amex mints 15)');
expectClean(luhnRun('37', 13), 'Amex prefix at 13 digits');
expectClean(luhnRun('55', 19), 'Mastercard prefix at 19 digits (Mastercard mints 16)');
expectClean(luhnRun('2221', 13), 'Mastercard 2-series prefix at 13 digits');
expectClean(luhnRun('6011', 17), 'Discover prefix at 17 digits (Discover mints 16/19)');
expectClean(luhnRun('3528', 13), 'JCB prefix at 13 digits (JCB mints 16-19)');
expectClean(luhnRun('62', 13), 'UnionPay prefix at 13 digits (UnionPay mints 16-19)');
expectClean(luhnRun('300', 13), 'Diners prefix at 13 digits (Diners mints 14-19)');

// ===================================================================
// Case group 5: adjacent-but-unassigned ranges just outside each brand.
// ===================================================================
expectClean(luhnRun('50', 16), 'just below the Mastercard 51-55 range');
expectClean(luhnRun('56', 16), 'just above the Mastercard 51-55 range');
expectClean(luhnRun('2220', 16), 'just below the Mastercard 2221-2720 range');
expectClean(luhnRun('2721', 16), 'just above the Mastercard 2221-2720 range');
expectClean(luhnRun('643', 16), 'just below the Discover 644-649 range');
expectClean(luhnRun('3527', 16), 'just below the JCB 3528-3589 range');
expectClean(luhnRun('3590', 16), 'just above the JCB 3528-3589 range');
expectClean(luhnRun('306', 16), 'just above the Diners 300-305 range');

// ===================================================================
// Case group 6: the issue #292 decimal rule, at a length and prefix the
// IIN check does NOT already reject.
//
// The existing #293 fixture derives its fractional part as a 14-digit
// run beginning `49`, which the IIN check now rejects on its own -- so
// that fixture no longer proves the decimal lookarounds do anything.
// These two cases use a fractional / integer part that IS a valid Visa
// IIN at a valid Visa length, so they fail the moment either lookaround
// is dropped. Float noise of exactly 16 fractional digits is ordinary in
// a HAR's own timing values, so this is the live case, not a contrived
// one.
// ===================================================================
{
    const fractional = luhnRun('4', 16);
    const timing = '168.' + fractional;
    const r = runVerify(tmpHarWith(timing));
    assert.strictEqual(
        r.code, 0,
        'expected exit 0 for a float whose FRACTIONAL part is a valid Visa IIN ' +
        'at a valid Visa length, got ' + r.code + '\nstderr: ' + r.stderr
    );
    passed++;
}
{
    const integer = luhnRun('4', 16);
    const r = runVerify(tmpHarWith(integer + '.45'));
    assert.strictEqual(
        r.code, 0,
        'expected exit 0 for a float whose INTEGER part is a valid Visa IIN ' +
        'at a valid Visa length, got ' + r.code + '\nstderr: ' + r.stderr
    );
    passed++;
}

console.log('All verify-scrub-cc-iin tests passed (' + passed + ').');
