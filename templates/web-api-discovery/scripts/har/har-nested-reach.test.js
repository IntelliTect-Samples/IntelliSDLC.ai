#!/usr/bin/env node
// Behavior tests for NESTED-PAYLOAD REACH PARITY between the gate and the
// scrubber (issue #454).
//
// Zero-dep, runs with `node har-nested-reach.test.js`. Exits non-zero on the
// first failure.
//
// WHAT THIS PINS, and why it is not #408.
//
// There are two parity axes between `har-secrets.js` (the GATE) and
// `sanitize-har.js` (the SCRUBBER), and they fail independently:
//
//   rule parity  -- does each engine know this value is a secret?  (#395, #408)
//   reach parity -- does each engine GET to where the value sits?  (#378, #454)
//
// This file is the reach axis. Every value below is a kind BOTH engines already
// know -- `hex32` is in `sanitize-har.js`'s PATTERNS and in the gate's shape
// table; `datr` is in `secretFields` and in the gate's known-secret names. So
// #408's proposed shape-table parity test PASSES on every fixture here while
// the capture still gates. Nothing in this file can be satisfied by teaching
// either engine a new rule; only equal reach can satisfy it.
//
// THE TRAP: the scrubber has several passes that can remove a value for the
// wrong reason -- a name match on the wire text, or the PATTERNS shape pass
// running over the still-encoded bytes (hex is not percent-escaped, so a hex32
// run survives encoding intact and a flat scan finds it anyway). Section 0
// proves the one-layer case already works, so a failure below is about DEPTH
// and not about the rule; and the `datr` fixtures use a value with no
// recognisable shape at all, so only the name control reached through the
// nesting can remove them.
//
// NOTHING here is a real credential. Every value is synthetic and generated in
// this file, and no assertion message ever prints a detected value -- a failure
// report that quotes the secret merely relocates the leak into the log written
// to explain it. Presence and a count are the whole reportable fact.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const sanitize = path.join(__dirname, 'sanitize-har.js');
const verify = path.join(__dirname, 'verify-scrub.js');

// The scrub refuses a substitution-table destination git will not confirm is
// ignored (#318), so the fixture root is a real repository.
const tmp = makeTempRepo('har-nested-reach-');
const profilePath = path.join(tmp, '.har-profile.json');
fs.writeFileSync(profilePath, JSON.stringify({ salt: 'nested-reach-salt', literals: {} }, null, 2));

// --- Synthetic values, generated here. ---
// A `hex32`: a shape BOTH engines know. Used where the point is that the
// scrubber's shape pass would catch it if only it could reach it.
const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
// A `datr` value with NO recognisable shape -- deliberately not hex, not
// base64-ish enough to trip a pattern, not the right length for a token rule.
// Only the NAME control can remove this, which is what makes the `datr`
// sections evidence about reach rather than about the shape pass.
const DATR = 'AbCdEfGhIjKlMnOpQrStUvWx';

const enc = encodeURIComponent;

function makeHar(postText, mimeType) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z',
                time: 1,
                request: {
                    method: 'POST', url: 'https://example.invalid/api/graphql',
                    httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [],
                    headersSize: -1, bodySize: postText.length,
                    postData: { mimeType, text: postText },
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [],
                    cookies: [],
                    content: { size: 2, mimeType: 'application/json', text: '{}' },
                    redirectURL: '', headersSize: -1, bodySize: 2,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    };
}

function runNode(script, args) {
    try {
        const out = execFileSync(process.execPath, [script, ...args],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return {
            code: e.status ?? 1,
            stdout: e.stdout?.toString() ?? '',
            stderr: e.stderr?.toString() ?? '',
        };
    }
}

/**
 * Scrub one request body, then gate the result.
 *
 * @returns {{scrubCode:number, verifyCode:number, text:string, report:string}}
 */
function scrubAndVerify(name, postText, mimeType) {
    const harIn = path.join(tmp, `${name}.har`);
    fs.writeFileSync(harIn, JSON.stringify(makeHar(postText, mimeType), null, 2));
    const harOut = path.join(tmp, `${name}.scrubbed.har`);
    const s = runNode(sanitize, ['--in', harIn, '--out', harOut,
        '--subs', path.join(tmp, `${name}.subs.json`), '--profile', profilePath,
        '--fixed-time', '2026-01-01T00:00:00.000Z']);
    if (s.code !== 0) {
        return { scrubCode: s.code, verifyCode: -1, text: '', report: s.stderr || s.stdout };
    }
    const text = fs.readFileSync(harOut, 'utf8');
    const v = runNode(verify, ['--in', harOut, '--profile', profilePath]);
    return { scrubCode: 0, verifyCode: v.code, text, report: v.stderr || v.stdout };
}

/**
 * Did the value survive in ANY spelling the artifact might carry it in?
 *
 * A scrub that removed only the wire spelling while leaving the value live one
 * encoding layer down has not removed it -- and checking one spelling is how
 * that passes unnoticed.
 */
function survives(text, value) {
    return [value, enc(value), JSON.stringify(value).slice(1, -1)]
        .some((spelling) => text.includes(spelling));
}

function assertReportIsQuiet(label, report) {
    for (const value of [HEX32, DATR]) {
        assert.ok(!report.includes(value) && !report.includes(enc(value)),
            `${label}: the gate printed a detected value -- a report that quotes the `
            + 'secret relocates the leak into the log that reports it');
    }
}

// --- 0. THE ISOLATION. One encoding layer already works. -------------------
// GUARD, not a falsifier: it passes before and after the change. It is the
// precondition that makes every section below mean "the scrubber could not
// REACH this" rather than "the scrubber has no rule for this".
{
    const r = scrubAndVerify('L0-one-layer',
        `variables=${enc(JSON.stringify({ token: HEX32 }))}&doc_id=123`,
        'application/x-www-form-urlencoded');

    assert.strictEqual(r.scrubCode, 0, `0.a: sanitize-har failed: ${r.report}`);
    assert.ok(!survives(r.text, HEX32),
        '0.b: the scrubber cannot reach a secret ONE encoding layer down, so every '
        + 'assertion below would fail for a reason that has nothing to do with depth');
    assert.strictEqual(r.verifyCode, 0,
        `0.c: the gate refuses a correctly scrubbed one-layer body: ${r.report}`);
    // A scrub that blanked the body would satisfy 0.b while destroying the capture.
    assert.ok(r.text.includes('doc_id=123'),
        '0.d: the scrub removed a benign neighbouring parameter, so 0.b would pass '
        + 'for a rule that simply erases the body');
}

// --- 1. D1 -- form -> JSON -> urlencoded JSON. Fails CLOSED. --------------
// `sanitize-har.js:scrubString` recurses only when `looksFormEncoded(out)`
// holds, and that predicate's character class excludes `{` and `"`. So once
// the scrubber has decoded into a JSON document it can never re-enter, at any
// depth. The gate has no such limit and reports the secret it cannot remove.
//
// This is the exact finding #454 reports:
//   `hex32 [secret] at entry N (inside encoded request.postData.text)`
{
    const inner = enc(JSON.stringify({ token: HEX32 }));
    const r = scrubAndVerify('D1-form-json-urlenc-json',
        `variables=${enc(JSON.stringify({ blob: inner }))}&doc_id=123`,
        'application/x-www-form-urlencoded');

    assert.strictEqual(r.scrubCode, 0, `1.a: sanitize-har failed: ${r.report}`);
    assert.ok(!survives(r.text, HEX32),
        '1.b: a hex32 survived at JSON -> urlencoded-JSON depth. The scrubber stops at '
        + 'the first JSON document by construction; the gate descends past it. This is '
        + 'the reach gap of #454 -- the scrubber HAS the hex32 rule and never got there');
    assert.strictEqual(r.verifyCode, 0,
        `1.c: the gate still refuses the artifact after the scrub: ${r.report}`);
    assertReportIsQuiet('1.d', r.report);
}

// --- 2. D2 -- a JSON document carried as a JSON STRING value. Fails CLOSED. -
// The gate parses the inner document and matches the field name. The
// scrubber's `jsonFieldRe` sees only the ESCAPED spelling `\"datr\":\"` in the
// outer document and cannot match it.
//
// `DATR` has no recognisable shape, so the PATTERNS pass cannot remove it on
// the name control's behalf. This is the reported `known-secret: datr`.
{
    const r = scrubAndVerify('D2-json-in-json-string',
        JSON.stringify({ payload: JSON.stringify({ datr: DATR }) }),
        'application/json');

    assert.strictEqual(r.scrubCode, 0, `2.a: sanitize-har failed: ${r.report}`);
    assert.ok(!survives(r.text, DATR),
        '2.b: a known-secret FIELD survived inside a JSON document carried as a JSON '
        + 'string value. The scrubber matches only the unescaped spelling of the key');
    assert.strictEqual(r.verifyCode, 0,
        `2.c: the gate still refuses the artifact after the scrub: ${r.report}`);
    assertReportIsQuiet('2.d', r.report);
}

// --- 3. D2b -- the same, reached through a form layer first. ---------------
// Pins that the fix is a property of the traversal rather than of one entry
// point: the same nesting must be cleaned whether or not a form body wraps it.
{
    const r = scrubAndVerify('D2b-form-json-in-json',
        `variables=${enc(JSON.stringify({ payload: JSON.stringify({ datr: DATR }) }))}`,
        'application/x-www-form-urlencoded');

    assert.strictEqual(r.scrubCode, 0, `3.a: sanitize-har failed: ${r.report}`);
    assert.ok(!survives(r.text, DATR),
        '3.b: the JSON-in-JSON-string case is cleaned at the top level but not when a '
        + 'form parameter wraps it, so the fix is entry-point specific rather than a '
        + 'property of the traversal');
    assert.strictEqual(r.verifyCode, 0,
        `3.c: the gate still refuses the artifact after the scrub: ${r.report}`);
}

// --- 4. D3 -- already-decoded JSON carrying an invalid percent escape. -----
// FAILS OPEN, and is therefore the worst of the three.
//
// `har-literals.js:decodeNestedJson` percent-decodes UNCONDITIONALLY before
// parsing. A JSON document that is already decoded and contains a `%` followed
// by non-hex ("50%off") makes `decodeURIComponent` throw, so `percentDecode`
// returns null and the document is skipped -- by the GATE as well as the
// scrubber. The secret survives AND the gate reports the artifact clean, which
// is precisely the outcome the gate exists to prevent.
{
    const r = scrubAndVerify('D3-invalid-escape',
        JSON.stringify({
            note: 'discount 50%off today',
            payload: JSON.stringify({ datr: DATR }),
        }),
        'application/json');

    assert.strictEqual(r.scrubCode, 0, `4.a: sanitize-har failed: ${r.report}`);
    assert.ok(!survives(r.text, DATR),
        '4.b: a known-secret FIELD survived inside a JSON document that carries an '
        + 'invalid percent escape. `decodeNestedJson` decodes before parsing, so the '
        + 'document is unreadable to BOTH engines');
    assert.strictEqual(r.verifyCode, 0,
        `4.c: the gate refuses the artifact: ${r.report}`);
    // The whole point of D3: this is the fails-OPEN case. Before the fix 4.b
    // fails while the gate says clean; this pins that the gate was blind too,
    // so a fix that only taught the scrubber would leave the gate unable to
    // catch the next instance.
    assert.ok(r.text.includes('discount 50%off today'),
        '4.d: the benign neighbouring value was rewritten, so 4.b could pass for a '
        + 'rule that mangles any document containing a percent sign');
}

console.log('har-nested-reach.test.js: all sections passed');
