#!/usr/bin/env node
// Behavior tests for the during-recording size warning (issue #528).
//
// Zero-dep, runs with `node capture-size-warning.test.js`. Exits non-zero when
// anything fails.
//
// THE POINT OF WARNING WHILE THE BROWSER IS STILL OPEN. This recorder is
// `Invoke-`, not `Start-`, precisely because the scrub, the verify, the digest
// and the catalogue all run AFTER the browser exits. So an operator who
// records past the size the scrub can read learns it only once the expensive,
// unrepeatable part -- a human-paced sequence of real writes and reads on a
// live account -- is already spent, and what they are left holding is the
// credential-bearing raw that must not be shared.
//
// The recorder is the only component that knows the capture's size WHILE the
// operator can still act on it: stop, split the session, narrow the filter.
// Nothing else in the pipeline gets that chance. So the warning is not a
// nicety attached to a failure that happens anyway -- on its own, before any
// streaming work lands, it converts a lost session into a decision.
//
// AND IT WARNS EXACTLY ONCE. The recorder flushes on an interval for the whole
// length of a session, so a warning re-emitted per flush would bury the
// browsing console in the minutes after it first appeared, and an operator who
// has decided to continue anyway would be nagged until they stopped reading
// warnings at all -- including the ones that are not about size.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const captureHar = require(path.join(__dirname, 'capture-har.js'));
const captureSize = require(path.join(__dirname, '..', 'lib', 'capture-size.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-size-warn-')));

let failures = 0;
let ran = 0;
let seq = 0;

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

/**
 * A recorder writing to its own log, with the threshold lowered so the suite
 * can cross it.
 *
 * The threshold's real VALUE is asserted separately, against the shared
 * module. Crossing it for real would mean producing hundreds of megabytes,
 * which is how a suite stops being run at all -- and the behavior under test
 * is what happens at the crossing, not where the crossing sits.
 */
function recorderWithWarnAt(warnAtBytes) {
    const warnings = [];
    const logPath = path.join(tmp, `log-${seq++}.ndjson`);
    const recorder = new captureHar.IncrementalRecorder(logPath, 60000, {
        warnAtBytes,
        onSizeWarning: (text) => warnings.push(text),
    });
    return { recorder, warnings, logPath };
}

// An entry big enough that a couple of flushes cross a small threshold.
function bulkyEntry() {
    return { request: { url: 'https://example.invalid/', padding: 'x'.repeat(4096) } };
}

// --- 1. Quiet below the threshold. ---

test('a recording well below the threshold says nothing', () => {
    const { recorder, warnings } = recorderWithWarnAt(10 * 1024 * 1024);
    for (let i = 0; i < 20; i++) recorder.add(bulkyEntry());
    recorder.flush();
    assert.deepStrictEqual(warnings, [],
        'an ordinary capture must not be interrupted about its size');
});

// --- 2. Crossing it warns, in terms the operator can act on. ---

test('crossing the threshold warns while the session is still live', () => {
    const { recorder, warnings } = recorderWithWarnAt(8 * 1024);
    for (let i = 0; i < 10; i++) recorder.add(bulkyEntry());
    recorder.flush();

    assert.strictEqual(warnings.length, 1, 'the crossing is reported: ' + warnings.join(' | '));
    const text = warnings[0];
    assert.ok(text.includes(String(captureSize.MAX_STRING_LENGTH)),
        'names the limit being approached: ' + text);
    assert.ok(/\bbytes\b/.test(text), 'names how large the recording already is: ' + text);
});

test('the warning says what the operator can still do, and why it matters now', () => {
    const { recorder, warnings } = recorderWithWarnAt(8 * 1024);
    for (let i = 0; i < 10; i++) recorder.add(bulkyEntry());
    recorder.flush();

    const text = warnings[0];
    assert.ok(/split|smaller|narrow|stop/i.test(text),
        'names an action that is still available: ' + text);
    assert.ok(/scrub/i.test(text),
        'names what will fail later, which is the whole reason to act now: ' + text);
    assert.ok(!/0x1fffffe8/.test(text),
        'the hex constant is the unreadable form this issue is about: ' + text);
});

// --- 3. Once, not once per flush. ---

test('the warning is not repeated on every later flush', () => {
    const { recorder, warnings } = recorderWithWarnAt(8 * 1024);
    for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 10; i++) recorder.add(bulkyEntry());
        recorder.flush();
    }
    assert.strictEqual(warnings.length, 1,
        'a per-flush warning would bury the console it is trying to reach: ' +
        warnings.length + ' warnings');
});

test('stopping the recorder does not re-announce it', () => {
    const { recorder, warnings } = recorderWithWarnAt(8 * 1024);
    for (let i = 0; i < 10; i++) recorder.add(bulkyEntry());
    recorder.flush();
    recorder.add(bulkyEntry());
    recorder.stop();
    assert.strictEqual(warnings.length, 1, 'still exactly one: ' + warnings.length);
});

// --- 4. The threshold is the shared one, and the log is still written. ---

test('the default threshold comes from the shared size module', () => {
    const { recorder } = recorderWithWarnAt(undefined);
    assert.strictEqual(recorder.warnAtBytes, captureSize.WARN_BYTES,
        'a second, local threshold is a second thing to keep true');
});

test('a recorder attached to an existing log counts what is already there', () => {
    // The log is append-only. A recorder that started its count at zero would
    // sit hundreds of megabytes below the truth, and a warning that arrives
    // after the ceiling has been passed is the defect, not the fix.
    const logPath = path.join(tmp, `preexisting-${seq++}.ndjson`);
    fs.writeFileSync(logPath, 'x'.repeat(50 * 1024), 'utf8');
    const recorder = new captureHar.IncrementalRecorder(logPath, 60000, { warnAtBytes: 60 * 1024 });
    assert.strictEqual(recorder.bytes, 50 * 1024, 'the existing log counts');

    const warnings = [];
    recorder.onSizeWarning = (t) => warnings.push(t);
    for (let i = 0; i < 3; i++) recorder.add(bulkyEntry());
    recorder.flush();
    assert.strictEqual(warnings.length, 1,
        'so a small further append crosses the threshold, as it should');
});

test('a broken warning channel cannot take the recording down with it', () => {
    // THE FAILURE THIS FORBIDS IS THE ONE THE WHOLE FEATURE EXISTS TO PREVENT.
    // Flushes run from a `setInterval` callback and nothing in the recorder's
    // process handles an uncaught exception, so a throw that escapes `flush`
    // does not fail a flush -- it kills the recorder, orphans the browser and
    // discards an unrepeatable live session. And `log.warn` writes to stderr,
    // which throws EPIPE as soon as the recorder's output is piped into
    // something that stops reading. A size warning is not worth a capture.
    const logPath = path.join(tmp, `throwing-${seq++}.ndjson`);
    const recorder = new captureHar.IncrementalRecorder(logPath, 60000, {
        warnAtBytes: 8 * 1024,
        onSizeWarning: () => { throw new Error('warning channel is broken'); },
    });
    for (let i = 0; i < 10; i++) recorder.add(bulkyEntry());

    assert.doesNotThrow(() => recorder.flush(),
        'the throw must not escape the flush that a timer callback invokes');
    assert.strictEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 10,
        'and every entry was still written');
});

test('containment holds when the output channel itself is the thing that is broken', () => {
    // THE APOLOGY MUST NOT REPRODUCE THE CRASH. An earlier fix reported the
    // failed warning through `log.verbose` -- which writes to stderr, the
    // channel that had just failed, with no containment of its own. Under
    // `--log-level verbose` that line throws the same error straight back out
    // of `flush`, into the unguarded timer callback, and ends the capture.
    //
    // A persistently broken stderr is how EPIPE behaves once the reader is
    // gone, so every write throws, not just the first.
    const logPath = path.join(tmp, `broken-stderr-${seq++}.ndjson`);
    const realWrite = process.stderr.write;
    const realLevel = 'normal';
    try {
        captureHar.setLogLevel('verbose');
        const recorder = new captureHar.IncrementalRecorder(logPath, 60000, {
            warnAtBytes: 8 * 1024,
            onSizeWarning: () => { throw new Error('write EPIPE'); },
        });
        for (let i = 0; i < 10; i++) recorder.add(bulkyEntry());
        process.stderr.write = () => { throw new Error('write EPIPE'); };
        try {
            assert.doesNotThrow(() => recorder.flush(),
                'a recovery message written to the broken channel re-raises the failure');
        } finally {
            process.stderr.write = realWrite;
        }
    } finally {
        process.stderr.write = realWrite;
        captureHar.setLogLevel(realLevel);
    }
    assert.strictEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 10,
        'and the entries were written regardless');
});

test('the process survives it when the real interval fires, not just a direct flush', () => {
    // A SEPARATE PROCESS, BECAUSE THE HARM IS TO THE PROCESS. The assertion
    // above holds `flush` to its contract, which is a claim about a function. It
    // cannot see the thing that actually goes wrong: an exception thrown inside
    // a `setInterval` callback is uncaught, and Node ends the process. In here
    // that would take the test runner with it, so the only oracle that can
    // distinguish "contained" from "fatal" is a child that is asked to survive
    // its own timer and report back.
    const child = path.join(tmp, `timer-child-${seq++}.js`);
    const logPath = path.join(tmp, `timer-${seq++}.ndjson`).replace(/\\/g, '\\\\');
    fs.writeFileSync(child, `
        const captureHar = require(${JSON.stringify(path.join(__dirname, 'capture-har.js'))});
        const r = new captureHar.IncrementalRecorder('${logPath}', 5, {
            warnAtBytes: 8 * 1024,
            onSizeWarning: () => { throw new Error('warning channel is broken'); },
        });
        r.start();
        for (let i = 0; i < 10; i++) r.add({ request: { url: 'u', padding: 'x'.repeat(4096) } });
        // Long enough for the interval to fire repeatedly on its own.
        setTimeout(() => { r.stop(); process.stdout.write('survived'); }, 200);
    `, 'utf8');

    const out = execFileSync(process.execPath, [child], { encoding: 'utf8', timeout: 20000 });

    assert.strictEqual(out.trim(), 'survived',
        'a throw escaping the interval callback ends the recorder and orphans the browser');
    assert.strictEqual(fs.readFileSync(logPath.replace(/\\\\/g, '\\'), 'utf8').trim().split('\n').length, 10,
        'and the entries were recorded throughout');
});

test('warning does not disturb the recording itself', () => {
    // The warning exists to protect the capture. A warning path that dropped,
    // duplicated or corrupted an entry would cost the thing it is defending.
    const { recorder, logPath } = recorderWithWarnAt(8 * 1024);
    for (let i = 0; i < 10; i++) recorder.add(bulkyEntry());
    recorder.flush();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 10, 'every entry was written');
    assert.strictEqual(recorder.written, 10, 'and counted');
    for (const line of lines) JSON.parse(line);
});

// ---------------------------------------------------------------------------

if (failures) {
    process.stderr.write('\n' + failures + ' of ' + ran + ' capture size-warning tests FAILED\n');
    process.exitCode = 1;
} else {
    process.stdout.write('All capture size-warning tests passed (' + ran + ')\n');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { void err; }
