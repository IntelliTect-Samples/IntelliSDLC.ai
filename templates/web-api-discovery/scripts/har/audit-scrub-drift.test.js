#!/usr/bin/env node
/**
 * Behavior tests for issue #335 -- the scrub-drift AUDIT.
 *
 * The tool answers, for committed references: which fields hold a fake that was
 * substituted for something the tightened predicate says was never a card? It
 * reports; it never repairs.
 *
 * These tests exist in the shape they do because of a specific failure recorded
 * on the issue: a generator that cannot express a shape cannot falsify it. A
 * differential that only produced the overlap its author imagined shipped a PII
 * leak, and a measurement fixture that could not express a decimal scored 560
 * corruptions as correct detection. So the awkward shapes are built here
 * DELIBERATELY and first -- a missing raw, TWO candidate captures, two captures
 * with an identical `describe`, a replacement occurring naturally, a table entry
 * matching nothing in the raw, and a value that really is a card.
 *
 * No real captured data. The digits are the published Visa test number
 * 4111111111111111 and Luhn-valid Unix-ms timestamps, as used by the
 * verify-scrub suite next door.
 *
 * Zero-dep: Node's own assert. Exits non-zero on the first failure so the Pester
 * wrapper can shell out to it.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AUDIT = path.join(__dirname, 'audit-scrub-drift.js');
const pii = require(path.join(__dirname, 'pii.js'));

let passed = 0;

// ---------------------------------------------------------------------------
// values. Published test numbers only -- nothing captured, nothing real.
// ---------------------------------------------------------------------------

// The published Visa test number: an assigned issuer identifier, Luhn-valid, 16
// digits. The tightened predicate calls this a card, so it must come back CLEAN
// when it sits in a field the policy does not call an identifier.
const REAL_CARD = '4111111111111111';

// A Unix-millisecond timestamp that is Luhn-valid by arithmetic accident. `17`
// is not an assigned issuer identifier, so the tightened predicate says this was
// never a card -- the exact class the loose predicate was overwriting.
const TIMESTAMP = '1777603192214';

// A second Luhn-valid non-card, so two fixtures can hold different corrupted
// values without sharing a hash.
const TIMESTAMP_2 = '1777603192222';

function luhn(s) {
    let sum = 0;
    let alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
        let d = s.charCodeAt(i) - 48;
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        alt = !alt;
    }
    return sum % 10 === 0;
}
assert.ok(luhn(REAL_CARD), 'precondition: REAL_CARD must be Luhn-valid');
assert.ok(luhn(TIMESTAMP), 'precondition: TIMESTAMP must be Luhn-valid');
assert.ok(luhn(TIMESTAMP_2), 'precondition: TIMESTAMP_2 must be Luhn-valid');

const fakeOf = (v) => pii.fakeFor('credit-card', v);
const hashOf = (v) => pii.hashPrefix(v);

// ---------------------------------------------------------------------------
// fixture construction
// ---------------------------------------------------------------------------

function tmpRoot(tag) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-drift-' + tag + '-')));
    fs.mkdirSync(path.join(dir, 'captures'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    return dir;
}

/** A one-entry HAR whose JSON response body is `body`. */
function har(body) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'audit-drift-test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z',
                request: {
                    method: 'GET', url: 'https://example.invalid/x',
                    headers: [], queryString: [], cookies: []
                },
                response: {
                    status: 200,
                    statusText: 'OK',
                    headers: [{ name: 'content-type', value: 'application/json' }],
                    cookies: [],
                    content: { mimeType: 'application/json', text: JSON.stringify(body) }
                }
            }]
        }
    };
}

/**
 * Write one capture session, and optionally the reference it published.
 *
 * `raw` is the document that sits in the preserved raw; `reference` is what was
 * committed. Keeping them separate is what lets a fixture express the awkward
 * cases -- a reference whose fake corresponds to nothing in its own raw, or a
 * raw with no reference at all.
 */
function writeSession(root, opts) {
    const sessionDir = path.join(root, 'captures', opts.host || 'example.invalid', opts.stamp);
    fs.mkdirSync(sessionDir, { recursive: true });
    const outputPath = path.resolve(opts.outputPath || path.join(root, 'out', opts.stamp));
    fs.mkdirSync(outputPath, { recursive: true });

    if (opts.raw !== undefined && opts.writeRaw !== false) {
        fs.writeFileSync(path.join(sessionDir, 'raw.har'), JSON.stringify(har(opts.raw), null, 2));
    }
    if (opts.substitutions !== undefined) {
        fs.writeFileSync(
            path.join(sessionDir, '.substitutions.json'),
            JSON.stringify({ substitutions: opts.substitutions }, null, 2));
    }
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
        uri: 'https://example.invalid/',
        describe: opts.describe || null,
        sessionDir,
        harPath: path.join(sessionDir, 'raw.har'),
        outputPath
    }, null, 2));

    let referencePath = null;
    if (opts.reference !== undefined) {
        referencePath = path.join(outputPath, opts.referenceName || 'reference.har');
        fs.writeFileSync(referencePath, JSON.stringify(har(opts.reference), null, 2));
    }
    return { sessionDir, outputPath, referencePath };
}

/** A `{ type, originalHash, replacement }` row for `value`, as the scrub records it. */
function subFor(value) {
    return {
        type: 'credit-card',
        originalHash: hashOf(value),
        replacement: fakeOf(value),
        locations: []
    };
}

// ---------------------------------------------------------------------------
// running the tool
// ---------------------------------------------------------------------------

function run(args) {
    try {
        const stdout = execFileSync('node', [AUDIT, ...args], { stdio: 'pipe', encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return {
            code: e.status,
            stdout: (e.stdout || '').toString(),
            stderr: (e.stderr || '').toString()
        };
    }
}

function audit(root, ...refs) {
    const r = run([path.join(root, 'captures'), ...refs]);
    let report = null;
    try {
        report = JSON.parse(r.stdout);
    } catch (x) {
        throw new Error('tool did not emit parseable JSON on stdout (exit ' + r.code + ')'
            + '\nstdout: ' + r.stdout.slice(0, 400)
            + '\nstderr: ' + r.stderr.slice(0, 800));
    }
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, report, ref: report.references[0] };
}

/** Every file under `dir`, with its bytes hashed -- a read-only tripwire. */
function snapshot(dir) {
    const out = {};
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        }
    })(dir);
    return out;
}

// ===========================================================================
// Case 1: usage. Input paths and nothing else -- there is no `--fix`, and an
// audit that can also rewrite is one nobody can safely point at a corpus.
// ===========================================================================
{
    assert.strictEqual(run([]).code, 3, 'no arguments should be a usage error');
    assert.strictEqual(run(['only-one-path']).code, 3,
        'a captures root with no reference is a usage error');

    const root = tmpRoot('usage');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { card_number: REAL_CARD },
        substitutions: [subFor(REAL_CARD)],
        reference: { card_number: fakeOf(REAL_CARD) }
    });
    const flagged = run([path.join(root, 'captures'), referencePath, '--fix']);
    assert.strictEqual(flagged.code, 3, 'an option-shaped argument must be refused, not ignored');
    assert.ok(/no options/i.test(flagged.stderr),
        'the refusal should say the tool takes no options, got: ' + flagged.stderr);
    passed++;
}

// ===========================================================================
// Case 2: CLEAN. The raw holds a value the tightened predicate still calls a
// card, in a field the merged policy does not call an identifier. Nothing was
// corrupted; the substitution did its job.
// ===========================================================================
{
    const root = tmpRoot('clean');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { card_number: REAL_CARD },
        substitutions: [subFor(REAL_CARD)],
        reference: { card_number: fakeOf(REAL_CARD) }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a real card in a non-identifier field is CLEAN, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.code, 0, 'an all-CLEAN run exits 0, got ' + a.code);
    assert.strictEqual(a.report.summary.references.CLEAN, 1);
    assert.strictEqual(a.report.summary.references.CORRUPTED, 0);
    assert.strictEqual(a.report.summary.references.UNADJUDICABLE, 0);
    passed++;
}

// ===========================================================================
// Case 3: CORRUPTED, because the raw was never a card. A Luhn-valid timestamp
// with an unassigned issuer prefix -- the class the loose predicate rewrote.
// ===========================================================================
{
    const root = tmpRoot('corrupt');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP },
        substitutions: [subFor(TIMESTAMP)],
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CORRUPTED',
        'a Luhn-valid non-card is CORRUPTED, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.code, 1, 'a CORRUPTED finding exits 1, got ' + a.code);
    const f = a.ref.findings[0];
    assert.strictEqual(f.reason, 'raw-value-was-never-a-card', 'unexpected reason ' + f.reason);
    assert.strictEqual(f.originalHash, hashOf(TIMESTAMP), 'the finding must carry the table hash');
    assert.ok(f.locations.length >= 1, 'a finding must carry at least one location');
    assert.strictEqual(f.locations[0].entryIndex, 0, 'a location must name the entry index');
    assert.ok(/started_at_ms/.test(f.locations[0].keyPath),
        'a location must carry the JSON key path, got ' + f.locations[0].keyPath);
    passed++;
}

// ===========================================================================
// Case 4: CORRUPTED even though the tightened predicate says "card".
//
// This is the 859-value measurement on the issue: values with a real issuer
// prefix that pass Luhn, in a corpus with no real cards. A predicate-only test
// calls every one of them CLEAN. The merged policy's `identifierFields` is what
// separates them, and the audit must consult it.
// ===========================================================================
{
    const root = tmpRoot('idfield');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { media_id: REAL_CARD },
        substitutions: [subFor(REAL_CARD)],
        reference: { media_id: fakeOf(REAL_CARD) }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CORRUPTED',
        'a card-shaped value under an identifier field is CORRUPTED, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.ref.findings[0].reason, 'identifier-field-rewritten',
        'unexpected reason ' + a.ref.findings[0].reason);
    passed++;
}

// ===========================================================================
// Case 5: UNADJUDICABLE -- the raw is gone. The question cannot be answered, and
// folding that into CLEAN would reproduce inside the audit the silent false
// negative the audit was written to find.
// ===========================================================================
{
    const root = tmpRoot('noraw');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP },
        writeRaw: false,
        substitutions: [subFor(TIMESTAMP)],
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'UNADJUDICABLE',
        'a missing raw is UNADJUDICABLE, got ' + a.ref.outcome);
    assert.strictEqual(a.ref.reason, 'raw-missing', 'unexpected reason ' + a.ref.reason);
    assert.strictEqual(a.code, 2, 'an UNADJUDICABLE run with nothing corrupted exits 2, got ' + a.code);
    passed++;
}

// ===========================================================================
// Case 6: UNADJUDICABLE -- TWO candidate captures.
//
// This is the one a tool resolves silently by picking the nearest, and it does
// not look like a decision from the inside. Both sessions recorded the SAME
// output path, so both explicitly claim the reference and neither claim is
// stronger. Refuse.
// ===========================================================================
{
    const root = tmpRoot('twocands');
    const shared = path.join(root, 'out', 'shared');
    writeSession(root, {
        stamp: '2026-01-01-000001', outputPath: shared,
        raw: { started_at_ms: TIMESTAMP }, substitutions: [subFor(TIMESTAMP)]
    });
    const second = writeSession(root, {
        stamp: '2026-01-01-235959', outputPath: shared,
        raw: { started_at_ms: TIMESTAMP_2 }, substitutions: [subFor(TIMESTAMP_2)],
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    const a = audit(root, second.referencePath);
    assert.strictEqual(a.ref.outcome, 'UNADJUDICABLE',
        'two claiming captures must be UNADJUDICABLE, got ' + a.ref.outcome);
    assert.strictEqual(a.ref.reason, 'ambiguous-capture-link', 'unexpected reason ' + a.ref.reason);
    assert.strictEqual(a.ref.candidateCaptures.length, 2, 'both candidates must be reported');
    assert.strictEqual(a.ref.findings.length, 0,
        'an unlinked reference yields no adjudicated findings -- reporting one means a raw was chosen');
    passed++;
}

// ===========================================================================
// Case 7: UNADJUDICABLE -- correct session, WRONG ATTEMPT.
//
// The same session routinely produces several captures with an identical
// `describe`. Every cheap sanity check passes: same provider, same describe,
// same operator, plausible timestamp. Neither the describe nor the ordering may
// break the tie, and the report must not name a winner.
// ===========================================================================
{
    const root = tmpRoot('sameattempt');
    const shared = path.join(root, 'out', 'polar');
    const DESCRIBE = 'create a step with one video, then delete it';
    const first = writeSession(root, {
        stamp: '2026-01-01-100000', outputPath: shared, describe: DESCRIBE,
        raw: { started_at_ms: TIMESTAMP }, substitutions: [subFor(TIMESTAMP)]
    });
    const second = writeSession(root, {
        stamp: '2026-01-01-110000', outputPath: shared, describe: DESCRIBE,
        raw: { started_at_ms: TIMESTAMP }, substitutions: [subFor(TIMESTAMP)],
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    // Make the ordering an active temptation: the later directory finished first,
    // exactly as the two real orderings interleave.
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(second.sessionDir, 'session.json'), past, past);

    const a = audit(root, second.referencePath);
    assert.strictEqual(a.ref.outcome, 'UNADJUDICABLE',
        'identical describes must not be disambiguated, got ' + a.ref.outcome);
    assert.strictEqual(a.ref.reason, 'ambiguous-capture-link', 'unexpected reason ' + a.ref.reason);
    assert.strictEqual(a.ref.linkedCapture, null,
        'no capture may be selected when two claim the reference');
    assert.ok(a.ref.candidateCaptures.some(c => c.sessionDir === first.sessionDir),
        'the first attempt must be listed for a human to adjudicate');
    assert.ok(a.ref.candidateCaptures.some(c => c.sessionDir === second.sessionDir),
        'the second attempt must be listed for a human to adjudicate');
    passed++;
}

// ===========================================================================
// Case 8: UNADJUDICABLE -- nothing links this reference to any capture. Time
// proximity and directory ordering are not links, so a reference outside every
// recorded output path has no candidate at all.
// ===========================================================================
{
    const root = tmpRoot('nolink');
    writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP }, substitutions: [subFor(TIMESTAMP)]
    });
    const orphan = path.join(root, 'elsewhere');
    fs.mkdirSync(orphan, { recursive: true });
    const refPath = path.join(orphan, 'reference.har');
    fs.writeFileSync(refPath, JSON.stringify(har({ started_at_ms: fakeOf(TIMESTAMP) })));

    const a = audit(root, refPath);
    assert.strictEqual(a.ref.outcome, 'UNADJUDICABLE',
        'a reference no capture claims is UNADJUDICABLE, got ' + a.ref.outcome);
    assert.strictEqual(a.ref.reason, 'no-linked-capture', 'unexpected reason ' + a.ref.reason);
    passed++;
}

// ===========================================================================
// Case 9: UNADJUDICABLE -- a table entry matching nothing in the linked raw.
//
// A raw exists and does not hold the value the table says was replaced. That is
// a stronger and more surprising statement than "the raw is gone", and worth
// telling apart when a repair decides what to do with each.
// ===========================================================================
{
    const root = tmpRoot('orphansub');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { unrelated: 'nothing here' },
        substitutions: [subFor(TIMESTAMP)],
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'UNADJUDICABLE', 'got ' + a.ref.outcome);
    assert.strictEqual(a.ref.findings[0].reason, 'original-not-in-linked-raw',
        'unexpected reason ' + a.ref.findings[0].reason);
    passed++;
}

// ===========================================================================
// Case 10: UNADJUDICABLE -- the linked capture has no substitution table, so
// there is no way to know whether the reference holds a substitution at all.
// That is ignorance, not health.
// ===========================================================================
{
    const root = tmpRoot('notable');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP },
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'UNADJUDICABLE', 'got ' + a.ref.outcome);
    assert.strictEqual(a.ref.reason, 'substitution-table-missing',
        'unexpected reason ' + a.ref.reason);
    passed++;
}

// ===========================================================================
// Case 11: a replacement's digits sitting INSIDE a longer digit run are a
// different value that was never substituted. Counting it would put a reviewer
// in front of a field with nothing wrong with it -- and false positives are what
// produced this issue, so an audit that adds its own has no standing.
// ===========================================================================
{
    const root = tmpRoot('embedded');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP },
        substitutions: [subFor(TIMESTAMP)],
        reference: { sequence: '99' + fakeOf(TIMESTAMP) + '77' }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'an embedded run is not an occurrence, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.ref.findings.length, 0, 'no finding should be raised');
    passed++;
}

// ===========================================================================
// Case 12: a replacement string occurring NATURALLY in unrelated text.
//
// The fake is in the reference as a whole run, so it is a candidate -- but the
// linked raw holds no value with that hash, so the tool cannot show a
// substitution ever happened there. It must refuse rather than call it CLEAN,
// which would silently bless a field it did not adjudicate.
// ===========================================================================
{
    const root = tmpRoot('natural');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP, note: 'no other digits' },
        substitutions: [subFor(TIMESTAMP), subFor(TIMESTAMP_2)],
        reference: {
            started_at_ms: fakeOf(TIMESTAMP),
            prose: 'order ' + fakeOf(TIMESTAMP_2) + ' shipped'
        }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CORRUPTED',
        'the genuine corruption still dominates the reference verdict, got ' + a.ref.outcome);
    const natural = a.ref.findings.find(f => f.originalHash === hashOf(TIMESTAMP_2));
    assert.ok(natural, 'the naturally-occurring replacement must still be reported');
    assert.strictEqual(natural.outcome, 'UNADJUDICABLE',
        'a candidate the raw cannot corroborate is UNADJUDICABLE, got ' + natural.outcome);
    assert.strictEqual(natural.reason, 'original-not-in-linked-raw');
    passed++;
}

// ===========================================================================
// Case 13: locations and counts, NEVER values. A tool written to find leaked
// identifiers that prints them has relocated the leak into its own report.
// ===========================================================================
{
    const root = tmpRoot('novalues');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP, card_number: REAL_CARD },
        substitutions: [subFor(TIMESTAMP), subFor(REAL_CARD)],
        reference: { started_at_ms: fakeOf(TIMESTAMP), card_number: fakeOf(REAL_CARD) }
    });
    const a = audit(root, referencePath);
    const all = a.stdout + '\n' + a.stderr;
    const forbidden = [
        ['raw timestamp', TIMESTAMP],
        ['raw card', REAL_CARD],
        ['fake timestamp', fakeOf(TIMESTAMP)],
        ['fake card', fakeOf(REAL_CARD)]
    ];
    for (const [label, v] of forbidden) {
        assert.ok(!all.includes(v), 'the report must not contain the ' + label + ' value');
    }
    assert.ok(all.includes(hashOf(TIMESTAMP)), 'the report should carry the table hash instead');
    passed++;
}

// ===========================================================================
// Case 14: READ-ONLY, and demonstrably so. Not one byte under the captures root
// or at the reference may differ after a run.
// ===========================================================================
{
    const root = tmpRoot('readonly');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP },
        substitutions: [subFor(TIMESTAMP)],
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    const before = snapshot(root);
    assert.ok(Object.keys(before).includes(referencePath),
        'precondition: the snapshot must cover the reference');
    audit(root, referencePath);
    assert.deepStrictEqual(snapshot(root), before, 'the audit modified, added or removed a file');
    passed++;
}

// ===========================================================================
// Case 15: the walk descends a link. `find` does not follow a junction, and the
// capture store is routinely one; the last session to hit this lost three runs
// diagnosing what presented as a dead CDP endpoint.
// ===========================================================================
{
    const root = tmpRoot('junction');
    const real = tmpRoot('junction-target');
    const { referencePath } = writeSession(real, {
        stamp: '2026-01-01-000001',
        raw: { started_at_ms: TIMESTAMP },
        substitutions: [subFor(TIMESTAMP)],
        reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    let linked = true;
    try {
        fs.symlinkSync(path.join(real, 'captures'), path.join(root, 'captures', 'linked'), 'junction');
    } catch {
        // No privilege to create one on this machine. The walk is still exercised
        // by every other case; this one only adds the link.
        linked = false;
    }
    if (linked) {
        const a = audit(root, referencePath);
        assert.strictEqual(a.ref.outcome, 'CORRUPTED',
            'a session behind a junction must be discovered, got ' + a.ref.outcome
            + ' (' + a.ref.reason + ')');
        assert.ok(a.report.captures.length >= 1, 'the linked session must appear in the capture list');
    }
    passed++;
}

// ===========================================================================
// Case 16: all three outcomes are counted, and the human summary says which
// columns are provisional. The UNADJUDICABLE count is the headline result of a
// run today, not a failure -- and it is the one number that is NOT provisional.
// ===========================================================================
{
    const root = tmpRoot('summary');
    const clean = writeSession(root, {
        stamp: '2026-01-01-000001', raw: { card_number: REAL_CARD },
        substitutions: [subFor(REAL_CARD)], reference: { card_number: fakeOf(REAL_CARD) }
    });
    const corrupt = writeSession(root, {
        stamp: '2026-01-01-000002', raw: { started_at_ms: TIMESTAMP },
        substitutions: [subFor(TIMESTAMP)], reference: { started_at_ms: fakeOf(TIMESTAMP) }
    });
    const unadj = writeSession(root, {
        stamp: '2026-01-01-000003', raw: { started_at_ms: TIMESTAMP_2 }, writeRaw: false,
        substitutions: [subFor(TIMESTAMP_2)], reference: { started_at_ms: fakeOf(TIMESTAMP_2) }
    });
    const r = run([path.join(root, 'captures'),
        clean.referencePath, corrupt.referencePath, unadj.referencePath]);
    const report = JSON.parse(r.stdout);
    assert.deepStrictEqual({
        CLEAN: report.summary.references.CLEAN,
        CORRUPTED: report.summary.references.CORRUPTED,
        UNADJUDICABLE: report.summary.references.UNADJUDICABLE
    }, { CLEAN: 1, CORRUPTED: 1, UNADJUDICABLE: 1 },
    'expected one of each outcome, got ' + JSON.stringify(report.summary.references));
    assert.strictEqual(r.code, 1, 'CORRUPTED outranks UNADJUDICABLE in the exit code');
    assert.strictEqual(report.provisional.CLEAN, true, 'CLEAN must be marked provisional');
    assert.strictEqual(report.provisional.CORRUPTED, true, 'CORRUPTED must be marked provisional');
    assert.strictEqual(report.provisional.UNADJUDICABLE, false,
        'the UNADJUDICABLE count is not provisional');
    assert.ok(/provisional/i.test(r.stderr),
        'the human summary must say the verdict columns are provisional');
    assert.ok(/identifierFields/.test(r.stderr),
        'the summary must name what those columns are waiting on');
    assert.ok(/UNADJUDICABLE/.test(r.stderr), 'the summary must report the UNADJUDICABLE count');
    assert.ok(/read-only/i.test(r.stderr), 'the summary must say the run modified nothing');
    passed++;
}

// ===========================================================================
// Case 17: a capture with NO substitutions is not pruned. Ten of one session's
// twenty-three captures were preserved FAILURES, several with no mutations at
// all -- one 10 MB capture whose entire value is that the driver refused to act.
// A capture's worth is not proportional to what it changed.
// ===========================================================================
{
    const root = tmpRoot('nomutations');
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001',
        raw: { note: 'the driver refused to act' },
        substitutions: [],
        reference: { note: 'the driver refused to act' }
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.report.captures.length, 1, 'a mutation-free capture must still be listed');
    assert.strictEqual(a.report.captures[0].candidateSubstitutions, 0);
    assert.strictEqual(a.ref.outcome, 'CLEAN', 'got ' + a.ref.outcome + ' (' + a.ref.reason + ')');
    passed++;
}

console.log('All audit-scrub-drift tests passed (' + passed + ').');
