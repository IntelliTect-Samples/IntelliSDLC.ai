#!/usr/bin/env node
// Behavior tests for capture-size.js -- the one place that knows how large a
// capture may be before the whole-document tooling cannot read it at all, and
// what to SAY about it (issue #528).
//
// Zero-dep, runs with `node capture-size.test.js`. Exits non-zero when
// anything fails.
//
// WHY THESE TESTS PASS NUMBERS RATHER THAN MAKING FILES. The size being
// guarded is roughly 512 MB, and a suite that had to produce one would be a
// suite nobody runs. The decision is therefore kept pure -- bytes in, verdict
// out -- and the callers do the one `statSync` each. The file-shaped half of
// the behavior is pinned in the callers' own suites, where a sparse file makes
// an oversized input cost milliseconds.
//
// WHAT THE ISSUE ACTUALLY ASKED FOR, and so what is asserted here:
//
//  - The limit is NODE'S, discovered, not a copied hex literal. `0x1fffffe8`
//    written by hand is a number that silently stops being true; the whole
//    point of one module is that there is one definition and it is the
//    runtime's own.
//  - A message NAMES the file, its size, and the limit. The reported defect is
//    not that the scrub failed -- it is that `Cannot create a string longer
//    than 0x1fffffe8 characters` names neither the file, nor its size, nor the
//    limit, and requires the reader to already know it is a Node string cap to
//    interpret it at all.
//  - There is a WARN band below the refusal band. A capture that can still be
//    processed but is approaching the ceiling is the only state in which the
//    operator can still act -- stop, split the session, narrow the filter --
//    and it is the state the recorder reports during recording.
//  - Node's own RangeError is RECOGNISED wherever it can still escape, because
//    a byte count is an upper bound on a string length and serialization
//    inflates a document past the size it was read at. The preflight closes
//    the common case; recognition closes the rest rather than pretending the
//    ceiling can be computed exactly in advance.

'use strict';

const assert = require('assert');
const path = require('path');

const size = require(path.join(__dirname, 'capture-size.js'));

let failures = 0;
let ran = 0;

function test(name, fn) {
    ran++;
    try {
        fn();
    } catch (e) {
        failures++;
        process.stderr.write('FAIL: ' + name + '\n  ' + e.message + '\n');
        if (e.stack) process.stderr.write(e.stack.split('\n').slice(1, 4).join('\n') + '\n');
    }
}

const LIMIT = require('buffer').constants.MAX_STRING_LENGTH;

// ---------------------------------------------------------------------------
// The limit itself
// ---------------------------------------------------------------------------

test('the limit is the running Node\'s own maximum string length', () => {
    assert.strictEqual(size.MAX_STRING_LENGTH, LIMIT,
        'the module must read the limit from the runtime, not carry a copy');
});

test('the warn threshold sits below the limit and above zero', () => {
    assert.ok(size.WARN_BYTES > 0, 'a threshold of zero would warn about every capture');
    assert.ok(size.WARN_BYTES < size.MAX_STRING_LENGTH,
        'a threshold at or above the limit warns only once it is too late to act');
});

// ---------------------------------------------------------------------------
// The three bands
// ---------------------------------------------------------------------------

test('an ordinary capture is ok and says nothing', () => {
    const verdict = size.assessCaptureSize(12 * 1024 * 1024, 'raw.har');
    assert.strictEqual(verdict.status, 'ok');
    assert.strictEqual(verdict.message, null,
        'a capture nowhere near the ceiling must not produce noise');
});

test('a capture approaching the limit warns rather than refusing', () => {
    const verdict = size.assessCaptureSize(size.WARN_BYTES + 1, 'raw.har');
    assert.strictEqual(verdict.status, 'warn');
    assert.ok(verdict.message, 'the warn band exists to be reported');
});

test('a capture over the limit is refused', () => {
    const verdict = size.assessCaptureSize(size.MAX_STRING_LENGTH + 1, 'raw.har');
    assert.strictEqual(verdict.status, 'exceeds');
});

test('the boundaries belong to the band below them', () => {
    // Exactly at the limit is still readable; exactly at the threshold has not
    // yet crossed it. Off-by-one here is the difference between a capture that
    // processes and one that is refused for no reason.
    assert.strictEqual(size.assessCaptureSize(size.MAX_STRING_LENGTH, 'r.har').status, 'warn');
    assert.strictEqual(size.assessCaptureSize(size.WARN_BYTES, 'r.har').status, 'ok');
});

// ---------------------------------------------------------------------------
// What the messages say -- the actual reported defect
// ---------------------------------------------------------------------------

test('the refusal names the file, its size and the limit', () => {
    const bytes = 816 * 1024 * 1024;
    const m = size.assessCaptureSize(bytes, '/captures/2026-09-17/raw.har').message;
    assert.ok(/raw\.har/.test(m), 'names the file: ' + m);
    assert.ok(m.includes(String(bytes)), 'names the exact size in bytes: ' + m);
    assert.ok(m.includes(String(size.MAX_STRING_LENGTH)), 'names the exact limit: ' + m);
    assert.ok(/816/.test(m), 'names the size in units a human reads: ' + m);
});

test('the refusal explains itself without assuming Node internals are known', () => {
    const m = size.assessCaptureSize(size.MAX_STRING_LENGTH * 2, 'raw.har').message;
    assert.ok(/string/i.test(m),
        'the reason is a string-length ceiling and the message has to say so: ' + m);
    assert.ok(!/0x1fffffe8/.test(m),
        'the hex constant is the unreadable form the issue is about: ' + m);
});

test('the warning names the file and the limit it is approaching', () => {
    const bytes = size.WARN_BYTES + 5 * 1024 * 1024;
    const m = size.assessCaptureSize(bytes, 'raw.ndjson').message;
    assert.ok(/raw\.ndjson/.test(m), 'names the file: ' + m);
    assert.ok(m.includes(String(size.MAX_STRING_LENGTH)), 'names the limit: ' + m);
    assert.ok(!/cannot/i.test(m),
        'a capture in the warn band still processes; saying otherwise is false: ' + m);
});

test('sizes are rendered in units a human reads, with the exact bytes kept', () => {
    const rendered = size.formatSize(816 * 1024 * 1024);
    assert.ok(/816/.test(rendered), rendered);
    assert.ok(/MB|GB/.test(rendered), 'a unit is named: ' + rendered);
    assert.ok(rendered.includes(String(816 * 1024 * 1024)),
        'the exact byte count survives, so the number can be compared: ' + rendered);
});

// ---------------------------------------------------------------------------
// Recognising Node's own failure, for the band a byte count cannot predict
// ---------------------------------------------------------------------------

// THESE ERRORS ARE PROVOKED, NOT WRITTEN. An earlier version of this suite
// hand-constructed a RangeError carrying Node's read-path wording and asserted
// that it was recognised. It passed, and it was worthless: V8 does NOT use that
// wording when a serialization overflows -- it raises a plain
// `RangeError: Invalid string length` -- so the branch the test was standing in
// for was dead code that re-threw the raw error after the whole scrub had run.
// A hand-written error only ever pins what its author already believed.
//
// So each case below makes the RUNTIME raise the real thing. Neither costs
// memory: V8 rejects an impossible length before allocating anything.
//
// AND THERE IS DELIBERATELY NO FULL END-TO-END VERSION -- no scrub run over a
// document that reads and then overflows when it is written. That needs around
// half a gigabyte of real data and minutes of walking, for a call site that is
// a single `if (isStringTooLongError(e))` with no scale-dependent logic. If you
// come to add one, do not "simplify" it by constructing the error instead:
// that is precisely the trap these two cases exist to have escaped.

function errorFromOverlongRepeat() {
    try {
        // Far beyond any ceiling, so it is refused on the length check alone.
        'x'.repeat(Number.MAX_SAFE_INTEGER);
    } catch (e) {
        return e;
    }
    throw new Error('the runtime accepted an impossible string length');
}

function errorFromOverlongSerialize() {
    try {
        // JSON.stringify of a value whose output cannot exist. Same ceiling,
        // and this is the exact call the scrub makes over the whole document.
        JSON.stringify({ padding: 'x'.repeat(Number.MAX_SAFE_INTEGER) });
    } catch (e) {
        return e;
    }
    throw new Error('the runtime accepted an impossible serialization');
}

test('the error this runtime raises for an impossible string length is recognised', () => {
    const e = errorFromOverlongRepeat();
    assert.strictEqual(size.isStringTooLongError(e), true,
        'unrecognised: ' + e.constructor.name + ' / ' + e.code + ' / ' + e.message);
});

test('the error a real serialization overflow raises is recognised', () => {
    // The path the scrub takes when pretty-printing inflates a document past
    // the size it was read at. Its wording differs from the read path's, and
    // that difference is what made the branch dead.
    const e = errorFromOverlongSerialize();
    assert.strictEqual(size.isStringTooLongError(e), true,
        'unrecognised: ' + e.constructor.name + ' / ' + e.code + ' / ' + e.message);
});

test('Node\'s coded read-path error is recognised too', () => {
    // The read path is the one the issue was reported from. Provoking it for
    // real costs a 512 MB read, which is what the scrub suite does end to end;
    // here the coded shape is asserted directly so both spellings are pinned in
    // the module that claims to know them.
    const e = new RangeError('Cannot create a string longer than 0x1fffffe8 characters');
    e.code = 'ERR_STRING_TOO_LONG';
    assert.strictEqual(size.isStringTooLongError(e), true);
});

test('unrelated errors are not mistaken for it', () => {
    assert.strictEqual(size.isStringTooLongError(new Error('ENOENT: no such file')), false);
    assert.strictEqual(size.isStringTooLongError(null), false);
    assert.strictEqual(size.isStringTooLongError(undefined), false);
    // V8's wording is generic enough to be worth narrowing: something that
    // merely says so without being the runtime's own RangeError is not it.
    assert.strictEqual(size.isStringTooLongError(new TypeError('Invalid string length')), false);
});

test('a recognised failure is described by file, size and limit too', () => {
    const m = size.describeStringLimitFailure({
        filePath: '/captures/raw.har',
        bytes: 700 * 1024 * 1024,
        stage: 'serializing the scrubbed document'
    });
    assert.ok(/raw\.har/.test(m), 'names the file: ' + m);
    assert.ok(m.includes(String(size.MAX_STRING_LENGTH)), 'names the limit: ' + m);
    assert.ok(/serializing the scrubbed document/.test(m),
        'names the stage, because "reading" and "serializing" fail for different sizes: ' + m);
});

test('a recognised failure is describable when the size is unknown', () => {
    // The stage that fails is not always one that has a file size to hand.
    // Dropping the whole message for a missing number would put the raw Node
    // text back on the operator's screen.
    const m = size.describeStringLimitFailure({
        filePath: '/captures/raw.har',
        stage: 'reading the capture'
    });
    assert.ok(/raw\.har/.test(m), m);
    assert.ok(m.includes(String(size.MAX_STRING_LENGTH)), m);
    assert.ok(!/NaN|undefined/.test(m), 'no placeholder leaks into operator text: ' + m);
});

// ---------------------------------------------------------------------------

if (failures) {
    process.stderr.write('\n' + failures + ' of ' + ran + ' capture-size tests FAILED\n');
    process.exitCode = 1;
} else {
    process.stdout.write('All capture-size tests passed (' + ran + ')\n');
}
