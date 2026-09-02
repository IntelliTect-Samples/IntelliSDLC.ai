#!/usr/bin/env node
/**
 * Behavior tests for issue #375 -- the scrub-drift AUDIT's envelope/field-name
 * confusion.
 *
 * `audit-scrub-drift.js` emits envelope strings with paths of the form
 * `${ctx}.headers.${h.name}`, `${ctx}.cookies.${c.name}` and
 * `request.queryString.${q.name}`. The path's LAST SEGMENT is the header,
 * cookie or query-parameter's OWN NAME -- captured data, but not a JSON field
 * name. Feeding that name to `harPolicy.isIdentifierField` is a category
 * error: a header genuinely named `X-Media-Id` is exactly where a provider's
 * object id travels, and a card-shaped value seen only there was wrongly
 * adjudicated CORRUPTED / identifier-field-rewritten when the correct verdict
 * is CLEAN / raw-value-is-a-card.
 *
 * This is NOT #369/#374 (the GATE's envelope-property defect on
 * `har-shapes.js`). This is the AUDIT, on `audit-scrub-drift.js`, and the two
 * fixes are one function call apart but never the same file.
 *
 * No real captured data. The digits are the published Visa test number
 * 4111111111111111 and a Luhn-valid Unix-ms timestamp, as used by the
 * audit-scrub-drift suite next door.
 *
 * Zero-dep: Node's own assert. Exits non-zero on the first failure so the
 * Pester wrapper can shell out to it.
 */

'use strict';

const assert = require('assert');
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

// The published Visa test number: an assigned issuer identifier, Luhn-valid,
// 16 digits. The tightened predicate calls this a card, so it must come back
// CLEAN whenever the only field-shaped evidence against it is an envelope
// name, not a real JSON field.
const REAL_CARD = '4111111111111111';

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

const fakeOf = (v) => pii.fakeFor('credit-card', v);
const hashOf = (v) => pii.hashPrefix(v);

// ---------------------------------------------------------------------------
// fixture construction -- full control over headers, cookies, query and body,
// which the shared audit-scrub-drift.test.js fixture (body-only) cannot give.
// ---------------------------------------------------------------------------

function tmpRoot(tag) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-envelope-' + tag + '-')));
    fs.mkdirSync(path.join(dir, 'captures'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    return dir;
}

/**
 * A one-entry HAR with full control over where a value sits: a request or
 * response header, a cookie, a query-string parameter, or a JSON body field --
 * any combination, so a fixture can place the SAME value at an envelope name
 * and a real field at once (issue #375's mixed case).
 */
function harEntry(opts) {
    const o = opts || {};
    return {
        log: {
            version: '1.2',
            creator: { name: 'audit-envelope-test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z',
                request: {
                    method: 'GET',
                    url: o.url || 'https://example.invalid/x',
                    headers: o.requestHeaders || [],
                    cookies: o.requestCookies || [],
                    queryString: o.query || []
                },
                response: {
                    status: 200,
                    statusText: 'OK',
                    headers: o.responseHeaders || [{ name: 'content-type', value: 'application/json' }],
                    cookies: o.responseCookies || [],
                    content: {
                        mimeType: 'application/json',
                        // `bodyText`, when given, is used VERBATIM -- for a body that is
                        // deliberately not valid JSON, which `JSON.stringify` can never
                        // produce.
                        text: o.bodyText !== undefined ? o.bodyText : JSON.stringify(o.body !== undefined ? o.body : {})
                    }
                }
            }]
        }
    };
}

function writeSession(root, opts) {
    const sessionDir = path.join(root, 'captures', 'example.invalid', opts.stamp);
    fs.mkdirSync(sessionDir, { recursive: true });
    const outputPath = path.resolve(path.join(root, 'out', opts.stamp));
    fs.mkdirSync(outputPath, { recursive: true });

    fs.writeFileSync(path.join(sessionDir, 'raw.har'), JSON.stringify(opts.rawHar, null, 2));
    fs.writeFileSync(
        path.join(sessionDir, '.substitutions.json'),
        JSON.stringify({ substitutions: opts.substitutions }, null, 2));
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
        uri: 'https://example.invalid/',
        describe: null,
        sessionDir,
        harPath: path.join(sessionDir, 'raw.har'),
        outputPath
    }, null, 2));

    const referencePath = path.join(outputPath, 'reference.har');
    fs.writeFileSync(referencePath, JSON.stringify(opts.referenceHar, null, 2));
    return { sessionDir, outputPath, referencePath };
}

/** A `{ type, originalHash, replacement }` row for `value`, as the scrub records it. */
function subFor(value) {
    return { type: 'credit-card', originalHash: hashOf(value), replacement: fakeOf(value), locations: [] };
}

// ---------------------------------------------------------------------------
// running the tool
// ---------------------------------------------------------------------------

function run(args) {
    try {
        const stdout = execFileSync('node', [AUDIT, ...args], { stdio: 'pipe', encoding: 'utf8' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
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

// ===========================================================================
// Case 1 (FALSIFIER): a card-shaped value present ONLY in a request header
// named like a declared identifier pattern (`X-Media-Id` -> segments
// `['x','media','id']` -> matches the shipped default's `*id`) must NOT be
// adjudicated CORRUPTED / identifier-field-rewritten. It carries no JSON field
// name at all, so it falls through to the shape test: the raw is a real card,
// so the correct verdict is CLEAN / raw-value-is-a-card.
// ===========================================================================
{
    const root = tmpRoot('header-id');
    const raw = harEntry({ requestHeaders: [{ name: 'X-Media-Id', value: REAL_CARD }] });
    const reference = harEntry({ requestHeaders: [{ name: 'X-Media-Id', value: fakeOf(REAL_CARD) }] });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a card-shaped value seen only in an id-shaped header must be CLEAN, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.ref.findings[0].reason, 'raw-value-is-a-card',
        'unexpected reason ' + a.ref.findings[0].reason);
    passed++;
}

// ===========================================================================
// Case 2 (FALSIFIER): the same, on a RESPONSE header.
// ===========================================================================
{
    const root = tmpRoot('response-header-id');
    const raw = harEntry({ responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'X-Object-Id', value: REAL_CARD }
    ] });
    const reference = harEntry({ responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'X-Object-Id', value: fakeOf(REAL_CARD) }
    ] });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a card-shaped value seen only in an id-shaped response header must be CLEAN, got '
        + a.ref.outcome + ' (' + JSON.stringify(a.ref.findings) + ')');
    passed++;
}

// ===========================================================================
// Case 3 (FALSIFIER): a card-shaped value present ONLY in a COOKIE named like
// a declared identifier pattern.
// ===========================================================================
{
    const root = tmpRoot('cookie-id');
    const raw = harEntry({ requestCookies: [{ name: 'session_uuid', value: REAL_CARD }] });
    const reference = harEntry({ requestCookies: [{ name: 'session_uuid', value: fakeOf(REAL_CARD) }] });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a card-shaped value seen only in an id-shaped cookie must be CLEAN, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    passed++;
}

// ===========================================================================
// Case 4 (FALSIFIER): a card-shaped value present ONLY in a QUERY-STRING
// parameter named like a declared identifier pattern.
// ===========================================================================
{
    const root = tmpRoot('query-id');
    const raw = harEntry({ query: [{ name: 'parent_guid', value: REAL_CARD }] });
    const reference = harEntry({ query: [{ name: 'parent_guid', value: fakeOf(REAL_CARD) }] });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a card-shaped value seen only in an id-shaped query parameter must be CLEAN, got '
        + a.ref.outcome + ' (' + JSON.stringify(a.ref.findings) + ')');
    passed++;
}

// ===========================================================================
// Case 5 (GUARD -- the over-correction to avoid): a card-shaped value at a
// genuine BODY field named `media_id` must still be adjudicated CORRUPTED /
// identifier-field-rewritten, exactly as before. The fix must not blind the
// audit to real field-name evidence.
// ===========================================================================
{
    const root = tmpRoot('body-id-field');
    const raw = harEntry({ body: { media_id: REAL_CARD } });
    const reference = harEntry({ body: { media_id: fakeOf(REAL_CARD) } });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CORRUPTED',
        'a card-shaped value at a genuine body identifier field must still be CORRUPTED, got '
        + a.ref.outcome + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.ref.findings[0].reason, 'identifier-field-rewritten',
        'unexpected reason ' + a.ref.findings[0].reason);
    passed++;
}

// ===========================================================================
// Case 6 (GUARD -- the mixed case): the SAME value sits under an id-shaped
// HEADER *and* a genuine, identifier-named BODY field at once. The header
// contributes NO evidence either way, so the verdict is decided entirely by
// the body field -- CORRUPTED, same as if the header were not there at all.
// This is what tells apart "the envelope name is filtered out" from "the
// envelope name is merely downgraded to weaker evidence": if it still counted
// as a second (identifying) site, the two agreeing sites would still read
// CORRUPTED, but a bug that instead let the header count as a NON-identifying
// site would flip this to UNADJUDICABLE / conflicting-field-context.
// ===========================================================================
{
    const root = tmpRoot('mixed-header-and-body');
    const raw = harEntry({
        requestHeaders: [{ name: 'X-Media-Id', value: REAL_CARD }],
        body: { media_id: REAL_CARD }
    });
    const reference = harEntry({
        requestHeaders: [{ name: 'X-Media-Id', value: fakeOf(REAL_CARD) }],
        body: { media_id: fakeOf(REAL_CARD) }
    });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CORRUPTED',
        'an envelope name must contribute no evidence, leaving the body field to decide alone, got '
        + a.ref.outcome + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.ref.findings[0].reason, 'identifier-field-rewritten',
        'unexpected reason ' + a.ref.findings[0].reason);
    passed++;
}

// ===========================================================================
// Case 7 (FALSIFIER, not GUARD -- mislabelled): the same mixed shape, but the
// body field is NOT identifier-named. The header must still contribute
// nothing, so the verdict falls to the shape test alone -- CLEAN, since the
// raw is a real card. Unlike case 6, this one DOES discriminate pre-fix from
// post-fix code: before #375's fix, the header's own name (`X-Media-Id`) was
// run through `isIdentifierField` and matched, so the header counted as an
// IDENTIFYING site while the body field counted as a NON-identifying one --
// one field of two agreeing, which `verdictFor` calls UNADJUDICABLE /
// conflicting-field-context, not CLEAN. This case fails against pre-fix code
// (confirmed by ablation against the pre-#375 revision of
// `audit-scrub-drift.js`) and so is a falsifier of the bug the fix addresses,
// not a guard against an unrelated regression.
// ===========================================================================
{
    const root = tmpRoot('mixed-header-and-plain-body');
    const raw = harEntry({
        requestHeaders: [{ name: 'X-Media-Id', value: REAL_CARD }],
        body: { billing_reference: REAL_CARD }
    });
    const reference = harEntry({
        requestHeaders: [{ name: 'X-Media-Id', value: fakeOf(REAL_CARD) }],
        body: { billing_reference: fakeOf(REAL_CARD) }
    });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a non-identifying body field paired with an envelope name must be CLEAN, got '
        + a.ref.outcome + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.ref.findings[0].reason, 'raw-value-is-a-card',
        'unexpected reason ' + a.ref.findings[0].reason);
    passed++;
}

// ===========================================================================
// Case 8 (FALSIFIER): `request.url` is an envelope property too --
// `enclosingFieldName('request.url')` would otherwise report the field name
// `url`, and a PROJECT policy is free to declare `*url` as an identifier
// pattern (a provider whose resource urls embed a numeric id, say). A
// card-shaped value seen only in the URL text must still be CLEAN.
//
// The policy is built LIVE, through the loader against a real
// `.har-policy.project.json` on disk -- never a frozen object mutated in
// place, which the merged policy's own `identifierMatchers` WeakMap cache
// would silently no-op against and report a false negative (per the issue's
// own warning).
// ===========================================================================
{
    const root = tmpRoot('url-id');
    fs.writeFileSync(path.join(root, '.har-policy.project.json'),
        JSON.stringify({ identifierFields: ['*url'] }, null, 2));

    const raw = harEntry({ url: 'https://example.invalid/x/' + REAL_CARD });
    const reference = harEntry({ url: 'https://example.invalid/x/' + fakeOf(REAL_CARD) });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.report.policy.projectPolicyFound, true,
        'precondition: the live project policy must actually be discovered, got '
        + JSON.stringify(a.report.policy));
    // `projectPolicyFound === true` alone does not prove THIS case's policy was
    // the one resolved -- `findUpward` walking to the wrong candidate would
    // still report `true`. Pin the actual resolved path so a wrong-directory
    // regression cannot silently stop testing anything.
    assert.strictEqual(a.report.policy.path, path.join(root, '.har-policy.project.json'),
        'precondition: the resolved project policy is not the one this case wrote, got '
        + JSON.stringify(a.report.policy));
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a card-shaped value seen only in the URL must be CLEAN even when a project policy '
        + 'declares *url as an identifier pattern, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    passed++;
}

// ===========================================================================
// Case 9 (FALSIFIER): a TOP-LEVEL ARRAY OF SCALARS in the body has no key of
// its own -- `response.content[0]` names nothing, the same as an array
// element anywhere else in a body (`har-shapes.capturedFieldName`'s own
// documented rule). A naive "strip the base prefix and take the last dotted
// segment" reading instead resolves this to `content` -- the HAR envelope's
// OWN property name for where a response body sits, not a captured field --
// and a project policy is free to declare an identifier pattern that matches
// it. This must not happen even then.
// ===========================================================================
{
    const root = tmpRoot('array-of-scalars');
    fs.writeFileSync(path.join(root, '.har-policy.project.json'),
        JSON.stringify({ identifierFields: ['*content'] }, null, 2));

    const raw = harEntry({ body: [REAL_CARD] });
    const reference = harEntry({ body: [fakeOf(REAL_CARD)] });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.report.policy.projectPolicyFound, true,
        'precondition: the live project policy must actually be discovered, got '
        + JSON.stringify(a.report.policy));
    // See case 8: `projectPolicyFound === true` does not prove this case's own
    // policy was the one resolved. Pin the path.
    assert.strictEqual(a.report.policy.path, path.join(root, '.har-policy.project.json'),
        'precondition: the resolved project policy is not the one this case wrote, got '
        + JSON.stringify(a.report.policy));
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a card-shaped value as a top-level array element must be CLEAN even when a project '
        + 'policy declares *content as an identifier pattern, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    passed++;
}

// ===========================================================================
// Case 10 (FALSIFIER): a NON-JSON body. `emitBody`'s fallback reports the
// location at the body's OWN node (`response.content`), never inventing a
// `.text` suffix that could collide with a genuine JSON field of that name --
// so it must carry no field name even when a project policy declares an
// identifier pattern that would otherwise have matched a naively-invented
// suffix.
// ===========================================================================
{
    const root = tmpRoot('non-json-body');
    fs.writeFileSync(path.join(root, '.har-policy.project.json'),
        JSON.stringify({ identifierFields: ['*text'] }, null, 2));

    const raw = harEntry({ bodyText: 'plain text report ' + REAL_CARD });
    const reference = harEntry({ bodyText: 'plain text report ' + fakeOf(REAL_CARD) });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.report.policy.projectPolicyFound, true,
        'precondition: the live project policy must actually be discovered, got '
        + JSON.stringify(a.report.policy));
    // See case 8: pin the resolved path, not just its presence.
    assert.strictEqual(a.report.policy.path, path.join(root, '.har-policy.project.json'),
        'precondition: the resolved project policy is not the one this case wrote, got '
        + JSON.stringify(a.report.policy));
    assert.strictEqual(a.ref.outcome, 'CLEAN',
        'a card-shaped value in a non-JSON body must be CLEAN even when a project policy '
        + 'declares *text as an identifier pattern, got ' + a.ref.outcome
        + ' (' + JSON.stringify(a.ref.findings) + ')');
    passed++;
}

// ===========================================================================
// Case 11 (GUARD -- the untested half of the collision claim case 10 warns
// about): a genuine JSON body field literally NAMED `text` must still resolve
// to the captured field "text" and adjudicate normally. Case 10's non-JSON
// fallback reports the location at the body's OWN node (`response.content`,
// never `${base}.text`) precisely so it cannot be mistaken for a real JSON
// field called `text` -- but nothing pinned the other half of that claim: that
// a genuine `text` field is NOT collateral damage of the fix and still gets a
// real field name. Without this case, a fix that blinded the audit to any
// field literally named `text` (an over-correction) would make case 10 pass
// for the wrong reason and leave this claim unverified.
// ===========================================================================
{
    const root = tmpRoot('genuine-text-field');
    fs.writeFileSync(path.join(root, '.har-policy.project.json'),
        JSON.stringify({ identifierFields: ['*text'] }, null, 2));

    const raw = harEntry({ body: { text: REAL_CARD } });
    const reference = harEntry({ body: { text: fakeOf(REAL_CARD) } });
    const { referencePath } = writeSession(root, {
        stamp: '2026-01-01-000001', rawHar: raw, referenceHar: reference,
        substitutions: [subFor(REAL_CARD)]
    });
    const a = audit(root, referencePath);
    assert.strictEqual(a.report.policy.projectPolicyFound, true,
        'precondition: the live project policy must actually be discovered, got '
        + JSON.stringify(a.report.policy));
    assert.strictEqual(a.report.policy.path, path.join(root, '.har-policy.project.json'),
        'precondition: the resolved project policy is not the one this case wrote, got '
        + JSON.stringify(a.report.policy));
    assert.strictEqual(a.ref.outcome, 'CORRUPTED',
        'a genuine JSON body field literally named "text" must still resolve as field "text" '
        + 'and adjudicate CORRUPTED under a policy declaring *text as an identifier pattern, got '
        + a.ref.outcome + ' (' + JSON.stringify(a.ref.findings) + ')');
    assert.strictEqual(a.ref.findings[0].reason, 'identifier-field-rewritten',
        'unexpected reason ' + a.ref.findings[0].reason);
    passed++;
}

console.log('All audit-envelope-field-names tests passed (' + passed + ').');
