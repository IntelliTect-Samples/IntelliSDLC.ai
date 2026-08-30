#!/usr/bin/env node
// Behavior tests for JSON-body key-path resolution and the `identifierFields`
// policy mechanism (issue #297).
//
// Zero-dep, runs with `node har-identifier-fields.test.js`. Exits non-zero on
// the first failure.
//
// Measured motivation, from an 8.6 GB / 79-HAR field corpus in which the
// operator confirmed there are NO real card numbers:
//
//   * 176 residual `credit-card` findings from 16 distinct values -- provider
//     object ids echoed everywhere.
//   * 135 of the 176 reported only `response.content.text`, with no resolved
//     key path, so the `identifierFields` mechanism -- which keys on the FIELD
//     NAME, and is therefore stable across captures -- had nothing to test
//     against and the operator had to hand-write a per-VALUE waiver instead.
//
// Two properties are pinned here, and the second is the dangerous one:
//
//   1. A finding inside a JSON body reports the key path of the field that
//      holds it, including when the body carries a big integer the parser
//      cannot represent, an anti-hijacking prefix, or a nested JSON string.
//   2. `identifierFields` downgrades IDENTITY-class shape findings ONLY. A
//      high-entropy token under a field called `session_id` is still a secret;
//      suppressing it because the key ends in `_id` would be a catastrophic
//      false negative.
//
// A key name is PROVENANCE and is legitimate evidence. The value's shape is
// not, and nothing here decides safety by looking at a value.
//
// No finding, message or assertion in this file prints a detected value.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ident-'));

// Visa, 16 digits, Luhn-valid, assigned IIN -- survives JSON.parse intact.
const CARD = '4111111111111111';
// Visa, 19 digits: past 2^53, so the PARSER cannot represent it. This is the
// shape a provider object id actually takes in the field.
const LONG_CARD = '4000000000000000006';
// hex32 -- SECRET class. The negative control for the whole feature.
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function loadPolicy(project) {
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    if (project) {
        fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME), JSON.stringify(project));
    }
    return policyModule.loadPolicy({ startDir: dir, stopAt: dir });
}

function bodyHar(text, mimeType) {
    return {
        log: {
            version: '1.2',
            entries: [{
                request: { method: 'GET', url: 'https://example.com/api', headers: [], cookies: [], queryString: [] },
                response: {
                    status: 200, headers: [], cookies: [],
                    content: { mimeType: mimeType || 'application/json', text },
                },
            }],
        },
    };
}

function only(findings, kind) {
    const hits = findings.filter((f) => f.kind === kind);
    assert.strictEqual(hits.length, 1,
        `expected exactly one ${kind} finding, got ${hits.length}: ` +
        JSON.stringify(hits.map((h) => h.keyPath)));
    return hits[0];
}

// =====================================================================
// Part 1 -- key paths inside a JSON body
// =====================================================================

// --- 1. The field measurement's own shape, reproduced. ---
// Nested object -> array -> object -> array -> object, with the value at a
// big-integer leaf the parser rounds. This is the exact case that produced
// `response.content.text` and nothing more.
{
    const text = JSON.stringify({
        data: { edges: [{ node: { carousel_media: [{ pk: '@PK@' }] } }] },
    }).replace('"@PK@"', LONG_CARD);
    const f = only(shapes.findLeaksInHar(bodyHar(text)), 'credit-card');
    assert.strictEqual(f.keyPath, 'response.content.text.data.edges[0].node.carousel_media[0].pk',
        `1.a: key path is ${JSON.stringify(f.keyPath)} -- a finding located only at the body blob ` +
        'cannot be matched against a field-name policy, which is why the operator had to write ' +
        'a per-value waiver instead');
}

// --- 1b. ...and the count is still one occurrence, not two. ---
{
    const text = `{"media_id":${LONG_CARD}}`;
    assert.strictEqual(only(shapes.findLeaksInHar(bodyHar(text)), 'credit-card').count, 1,
        '1b.a: resolving a key path double-counted the occurrence');
}

// --- 2. An anti-hijacking prefix does not cost the body its key paths. ---
// `for (;;);` and `)]}'` are ordinary armour on JSON APIs. A body carrying one
// is not JSON at offset zero, so a parse anchored at offset zero fails and the
// whole body degrades to a blob -- silently, for every response the provider
// sends.
{
    for (const prefix of ['for (;;);', ")]}'\n", 'while(1);']) {
        const text = `${prefix}{"media_id":"${CARD}"}`;
        const f = only(shapes.findLeaksInHar(bodyHar(text)), 'credit-card');
        assert.strictEqual(f.keyPath, 'response.content.text.media_id',
            `2.a: a body behind the ${JSON.stringify(prefix)} prefix resolved no key path`);
    }
}

// --- 2b. A prefix-skipped parse must be COMPLETE to be believed. ---
// Skipping leading bytes to find a `{` is a guess. It is safe only when the
// remainder parses end to end; applied to prose or markup that merely contains
// a brace it would attach confident-looking key paths to nothing.
{
    const text = `not json at all { "media_id": "${CARD}" and then some prose`;
    const f = only(shapes.findLeaksInHar(bodyHar(text, 'text/plain')), 'credit-card');
    assert.strictEqual(f.keyPath, 'response.content.text',
        '2b.a: a partial parse of non-JSON text was reported as a resolved key path');
}

// --- 3. A JSON document nested inside a JSON string is walked too. ---
// Double-encoded payloads are how a provider ships a serialised sub-document.
{
    const inner = JSON.stringify({ items: [{ user_id: CARD }] });
    const text = JSON.stringify({ payload: inner });
    const f = only(shapes.findLeaksInHar(bodyHar(text)), 'credit-card');
    assert.strictEqual(f.keyPath, 'response.content.text.payload.items[0].user_id',
        `3.a: key path is ${JSON.stringify(f.keyPath)} -- the nested document was left as a blob`);
}

// --- 4. Degradation, never a throw and never a hang. ---
// Every one of these must report the finding at the body node, exactly as
// today, rather than failing the walk.
{
    const cases = {
        truncated: `{"data":{"media_id":"${CARD}","next":"`,
        'not json': `<html><body>${CARD}</body></html>`,
        'ndjson (trailing document)': `{"a":1}\n{"media_id":"${CARD}"}`,
        'bare value': `${CARD}`,
    };
    for (const label of Object.keys(cases)) {
        const started = Date.now();
        let found;
        assert.doesNotThrow(() => { found = shapes.findLeaksInHar(bodyHar(cases[label], 'text/plain')); },
            `4.a: the walk threw on a ${label} body`);
        assert.strictEqual(found.filter((f) => f.kind === 'credit-card').length, 1,
            `4.b: a ${label} body lost its finding entirely -- degrading must cost the key path, not the gate`);
        assert.ok(Date.now() - started < 5000, `4.c: a ${label} body took too long`);
    }
}

// --- 4b. A truncated body keeps the paths it resolved before the cut. ---
// HAR bodies are truncated in the field. Paths emitted before the malformation
// were computed from well-formed input and are worth keeping.
{
    const text = `{"data":{"media_id":"${CARD}"},"rest":"unterminat`;
    assert.strictEqual(only(shapes.findLeaksInHar(bodyHar(text)), 'credit-card').keyPath,
        'response.content.text.data.media_id',
        '4b.a: a key path resolved before the truncation point was discarded');
}

// --- 5. Pathological input is bounded by construction. ---
{
    // 5a. Deep nesting must not blow the JS stack.
    const deep = `${'['.repeat(20000)}"${CARD}"${']'.repeat(20000)}`;
    let found;
    assert.doesNotThrow(() => { found = shapes.findLeaksInHar(bodyHar(deep)); },
        '5.a: 20k-deep nesting threw -- a gate that crashes fails open in whatever catches it');
    assert.strictEqual(found.filter((f) => f.kind === 'credit-card').length, 1,
        '5.b: a deeply nested body lost its finding');

    // 5b. A body over the structural budget skips the walk and still gates.
    const limits = shapes.STRUCTURAL_LIMITS;
    assert.ok(limits && limits.maxChars > 0, '5.c: the structural budget is not exposed');
    const huge = `{"pad":"${'!'.repeat(limits.maxChars)}","media_id":"${CARD}"}`;
    const started = Date.now();
    const hugeFound = shapes.findLeaksInHar(bodyHar(huge));
    assert.strictEqual(hugeFound.filter((f) => f.kind === 'credit-card').length, 1,
        '5.d: an over-budget body lost its finding -- the budget may cost precision, never coverage');
    assert.strictEqual(only(hugeFound, 'credit-card').keyPath, 'response.content.text',
        '5.e: an over-budget body claimed a key path the walk never computed');
    assert.ok(Date.now() - started < 60000, '5.f: an over-budget body was not bounded');
}

// =====================================================================
// Part 2 -- identifierFields
// =====================================================================

// --- 6. The shipped default carries shape-agnostic identifier patterns. ---
{
    const policy = loadPolicy();
    assert.ok(Array.isArray(policy.identifierFields) && policy.identifierFields.length > 0,
        '6.a: the default policy ships no identifier patterns, so the mechanism has nothing to match');
    for (const pattern of policy.identifierFields) {
        assert.ok(pattern.includes('*'),
            `6.b: default identifier entry ${JSON.stringify(pattern)} is a literal name -- the ` +
            'upstream default carries generic patterns only; a specific name is a consumer concept');
        assert.ok(!/^\//.test(pattern),
            `6.c: default identifier entry ${JSON.stringify(pattern)} is a regular expression -- ` +
            'the accepted language is a restricted segment matcher, precisely so a policy cannot ' +
            'carry a pattern that backtracks');
    }
}

// --- 7. An identity finding under an identifier-named key is downgraded. ---
{
    const policy = loadPolicy();
    for (const key of ['media_id', 'pk', 'id', 'user_ids', 'objectId', 'item-id', 'uuid']) {
        const doc = bodyHar(JSON.stringify({ data: { [key]: CARD } }));
        const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
        assert.strictEqual(f.identifierField, true,
            `7.a: a card-shaped value at key ${JSON.stringify(key)} was not recognised as identifier-shaped`);
        assert.strictEqual(f.gating, false, `7.b: an identifier-shaped finding at ${key} still gates`);
    }
}

// --- 7b. ...and an ordinary key is untouched. ---
{
    const policy = loadPolicy();
    const doc = bodyHar(JSON.stringify({ billing: { card_number: CARD } }));
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    assert.notStrictEqual(f.identifierField, true,
        '7b.a: a value at a key that is not identifier-named was downgraded anyway');
}

// --- 7c. A word merely ENDING in the letters "id" is not an identifier. ---
// `valid`, `paid`, `android` all end in `id`. A pattern that matched them
// would silence findings across most of a payload.
{
    const policy = loadPolicy();
    for (const key of ['valid', 'paid', 'android', 'covid']) {
        const doc = bodyHar(JSON.stringify({ [key]: CARD }));
        const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
        assert.notStrictEqual(f.identifierField, true,
            `7c.a: the key ${JSON.stringify(key)} was read as an identifier field`);
    }
}

// --- 8. THE BOUNDARY. A secret under an identifier-named key STILL GATES. ---
// This is the one that must never regress. A high-entropy token sitting under
// `session_id` is a session token; downgrading it because the key ends in
// `_id` would suppress exactly the class of finding this gate exists for.
{
    const policy = loadPolicy();
    for (const key of ['session_id', 'id', 'pk', 'auth_id', 'tokenId']) {
        const doc = bodyHar(JSON.stringify({ [key]: TOKEN }));
        const f = only(shapes.findLeaksInHar(doc, policy), 'hex32');
        assert.strictEqual(f.class, 'secret', '8.pre: the control is not a secret-class finding');
        assert.notStrictEqual(f.identifierField, true,
            `8.a: a SECRET at key ${JSON.stringify(key)} was marked identifier-shaped -- ` +
            'identifierFields is an identity-class mechanism only');
        assert.strictEqual(f.gating, true,
            `8.b: a hex32 at key ${JSON.stringify(key)} stopped gating -- catastrophic false negative`);
    }
}

// --- 9. Downgraded, not dropped. ---
// The finding stays in the report, marked, exactly as a waiver does. A
// loosening that made findings vanish would be an invisible one.
{
    const policy = loadPolicy();
    const doc = bodyHar(JSON.stringify({ media_id: CARD }));
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    const rendered = shapes.describeLeak(f);
    assert.ok(/identifier/i.test(rendered),
        `9.a: the rendered finding does not say why it was downgraded: ${rendered}`);
    assert.ok(!rendered.includes(CARD), '9.b: the rendered finding carried the value');
    assert.strictEqual(shapes.blocksLeak(f), false, '9.c: an identifier-shaped finding still blocks');
}

// --- 10. A project may add exact names; the default keeps its patterns. ---
{
    const policy = loadPolicy({ identifierFields: ['trip_slug'] });
    const doc = bodyHar(JSON.stringify({ trip_slug: CARD, media_id: CARD }));
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    assert.strictEqual(f.identifierField, true,
        '10.a: a project-declared identifier name did not match');

    const other = bodyHar(JSON.stringify({ trip_slug: CARD }));
    assert.strictEqual(only(shapes.findLeaksInHar(other, policy), 'credit-card').identifierField, true,
        '10.b: appending a project name discarded nothing, but the name itself did not match');

    // The appended name must not have replaced the shipped patterns.
    const stillDefault = bodyHar(JSON.stringify({ media_id: CARD }));
    assert.strictEqual(only(shapes.findLeaksInHar(stillDefault, policy), 'credit-card').identifierField, true,
        '10.c: a project identifierFields list replaced the upstream patterns instead of appending');
}

// --- 11. An unparseable pattern is a hard error, not a silent no-match. ---
// A policy that loads and does not mean what its author wrote is worse than
// one that fails: the author reads the file and believes it is in force.
{
    for (const bad of ['/(unclosed/', 'has space', 'two**stars', '*', '**', 'trailing_', '']) {
        assert.throws(() => loadPolicy({ identifierFields: [bad] }),
            (e) => e instanceof policyModule.PolicyError && /identifierFields/.test(e.message),
            `11.a: the invalid identifier pattern ${JSON.stringify(bad)} loaded silently`);
    }
}

// --- 12. No policy means no downgrade. ---
// The strictest reading is the only safe default; a missing policy file must
// never be the thing that quietly loosens a gate.
{
    const doc = bodyHar(JSON.stringify({ media_id: CARD }));
    const f = only(shapes.findLeaksInHar(doc), 'credit-card');
    assert.notStrictEqual(f.identifierField, true,
        '12.a: an absent policy downgraded a finding');
}

// --- 13. The downgrade is decided by the ENCLOSING key, not by any ancestor. ---
// `data.ids[3].card_number` holds a card under a field called `card_number`.
// Matching any segment of the path would silence it because an ancestor is an
// id collection.
{
    const policy = loadPolicy();
    const doc = bodyHar(JSON.stringify({ ids: [{ card_number: CARD }] }));
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    assert.notStrictEqual(f.identifierField, true,
        '13.a: an ancestor key named `ids` downgraded a finding at `card_number`');
}

// --- 13b. ...but an array element inherits the array's own name. ---
// `media_ids[4]` has no key of its own; the field holding it is `media_ids`.
{
    const policy = loadPolicy();
    const doc = bodyHar(JSON.stringify({ media_ids: ['1', CARD] }));
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    assert.strictEqual(f.identifierField, true,
        '13b.a: a value inside an identifier-named array was not downgraded');
}

// --- 13c. One occurrence at an id field does not make the VALUE an id. ---
// Findings are grouped by fingerprint, so the downgrade must not be decided by
// whichever occurrence happened to be seen first. The same digits echoed at
// `card_number` are evidence the field-name downgrade was wrong.
{
    const policy = loadPolicy();
    const doc = bodyHar(JSON.stringify({ media_id: CARD, billing: { card_number: CARD } }));
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    assert.notStrictEqual(f.identifierField, true,
        '13c.a: a value also present at a non-identifier field stayed downgraded');
    assert.strictEqual(f.keyPath, 'response.content.text.billing.card_number',
        '13c.b: the promoted finding still points at the benign-looking location');
    assert.strictEqual(f.count, 2, '13c.c: promotion lost the occurrence count');
}

// --- 14. A finding with no resolved key path is never downgraded. ---
// The percent-decoded view has no structural path. Guessing one from the
// enclosing HAR node would downgrade on no evidence at all.
{
    const policy = loadPolicy();
    const doc = {
        log: {
            version: '1.2',
            entries: [{
                request: {
                    method: 'POST', url: 'https://example.com/api', headers: [], cookies: [], queryString: [],
                    postData: {
                        mimeType: 'application/x-www-form-urlencoded',
                        params: [{ name: 'media_id', value: `%7B%22v%22%3A%22${CARD}%22%7D` }],
                    },
                },
                response: { status: 200, headers: [], cookies: [], content: { mimeType: 'application/json', text: '{}' } },
            }],
        },
    };
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    assert.strictEqual(f.keyPath, null, '14.pre: the control resolved a key path after all');
    assert.notStrictEqual(f.identifierField, true,
        '14.a: a finding with no resolved key path was downgraded on the enclosing node name');
}

// --- 16. The pattern language cannot express catastrophic backtracking. ---
// `identifierFields` runs a POLICY-supplied pattern against field names lifted
// out of a CAPTURED body -- third-party data, in a tool whose whole purpose is
// capturing third-party APIs. While the pattern was an arbitrary regular
// expression, an ordinary anti-pattern in a policy file plus a long field name
// in a response hung both verifiers.
//
// Detecting the bad ones was tried and abandoned. Probing a compiled regex for
// backtracking means deriving an adversarial alphabet, and character classes,
// `\w`, `\d`, backreferences and lookaround each defeat that in a different
// way -- a whack-a-mole nobody wins. These two reproductions were measured
// against a probe that looked convincing:
//
//   /(?:12345678)?(a+)+b/                     loaded in  9 ms, then  83,949 ms
//   /^(stripe|square|adyen|klarna)_(\w+)+id$/i loaded in 12 ms, then   6,243 ms
//
// The second is what a project author actually writes to catch several
// providers' id-suffixed fields. It hangs on a 38-character field name, well
// inside the length cap.
//
// So the language is restricted instead, and the vulnerability is
// unrepresentable rather than detected. Both must be refused as INVALID
// SYNTAX at load -- not merely bounded at match time.
{
    const reproductions = [
        '/(?:12345678)?(a+)+b/',
        '/^(stripe|square|adyen|klarna)_(\w+)+id$/i',
    ];
    for (const pattern of reproductions) {
        assert.throws(() => loadPolicy({ identifierFields: [pattern] }),
            (e) => e instanceof policyModule.PolicyError && /identifierFields/.test(e.message),
            `16.a: ${JSON.stringify(pattern)} was accepted. A regular expression is not in the ` +
            'accepted language, and the reason it is not is that this one hangs the gate.');
    }
}

// --- 16a2. ...and the whole regex family goes with it. ---
{
    for (const pattern of ['/(a+)+b/', '/(a|a)+b/', '/(.*)*c/', '/(x+x+)+y/', '/^(\w+\s?)*$/']) {
        assert.throws(() => loadPolicy({ identifierFields: [pattern] }),
            (e) => e instanceof policyModule.PolicyError,
            `16a2.a: the regular expression ${JSON.stringify(pattern)} was accepted`);
    }
}

// --- 16a3. Everything the language DOES accept is bounded, by construction. ---
// The property that replaces the probe: there is nothing in the accepted
// language to backtrack over, so an accepted pattern against a worst-case
// field name at the cap costs no more than reading it.
{
    const accepted = ['*id', '*ids', '*pk', '*uuid', 'trip_slug', 'user*', 'stripe*id', '*media*'];
    const policy = loadPolicy({ identifierFields: accepted });
    const cap = policyModule.IDENTIFIER_LIMITS.maxFieldNameChars;
    const adversarial = [
        'a'.repeat(cap),
        'a'.repeat(cap - 1) + 'b',
        ('a_'.repeat(cap)).slice(0, cap),
        ('aB'.repeat(cap)).slice(0, cap),
        'stripe_' + 'x'.repeat(cap - 8) + 'y',
        'user_' + '1'.repeat(cap - 6) + 'z',
    ];
    const started = Date.now();
    for (let round = 0; round < 200; round++) {
        for (const key of adversarial) policyModule.isIdentifierField(policy, key);
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000,
        `16a3.a: ${200 * adversarial.length} matches of ${accepted.length} accepted patterns ` +
        `against cap-length adversarial names took ${elapsed} ms. An accepted pattern must be ` +
        'linear in the length of the name -- if this is slow, the language grew something that ' +
        'backtracks.');
}

// --- 16a4. A long pattern list cannot make the LOAD expensive either. ---
// The probe had unbounded aggregate cost across a policy's pattern list: 100
// near-threshold patterns took 3,868 ms before refusing. Compiling a
// restricted pattern is a parse, so the cost is linear in the list.
{
    const many = Array.from({ length: 200 }, (_, i) => `*seg${i}`);
    const started = Date.now();
    loadPolicy({ identifierFields: many });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000,
        `16a4.a: loading 200 identifier patterns took ${elapsed} ms`);
}

// --- 16b. The key-length cap, pinned directly. ---
// Independent of any pattern analysis: past the cap, nothing is matched at all.
{
    const limits = policyModule.IDENTIFIER_LIMITS;
    assert.ok(limits && limits.maxFieldNameChars > 0, '16b.a: the identifier key cap is not exposed');

    // An exact pattern that is itself cap-length, so the ONLY thing separating
    // the two names below is the cap.
    const atCap = 'a'.repeat(limits.maxFieldNameChars);
    const pastCap = 'a'.repeat(limits.maxFieldNameChars + 1);
    const policy = loadPolicy({ identifierFields: [atCap, pastCap] });
    assert.strictEqual(policyModule.isIdentifierField(policy, atCap), true,
        '16b.b: a name at the cap was refused -- the cap must be a ceiling, not an off-by-one');
    assert.strictEqual(policyModule.isIdentifierField(policy, pastCap), false,
        '16b.c: a name past the cap was matched -- the cap is the one defence that cannot be gamed');
}

// --- 16c. The cap short-circuits before any pattern runs. ---
{
    const policy = loadPolicy();
    const absurd = 'a'.repeat(1000000);
    const started = Date.now();
    assert.strictEqual(policyModule.isIdentifierField(policy, absurd), false, '16c.a');
    assert.ok(Date.now() - started < 500, '16c.b: a megabyte-long name reached the patterns');
}

// --- 17. Known imprecision: a value that is also a JSON KEY. ---
// The raw-text pass and the structural pass are correlated by sighting order,
// and the structural pass never emits KEY text -- only values. So a digit run
// appearing as a key as well as a value shifts the correlation by one and the
// last occurrence falls back to the body node.
//
// This is a LOCATION and COUNT imprecision, not a gate bypass: every path in
// the map is a genuine path, the identifier promotion is one-directional (a
// finding can only move back TOWARDS blocking), and the count is still
// correct. Pinned here so the behaviour is documented rather than discovered.
{
    const policy = loadPolicy();
    const doc = bodyHar(`{"${CARD}":1,"media_id":"${CARD}","amount2":"${CARD}"}`);
    const f = only(shapes.findLeaksInHar(doc, policy), 'credit-card');
    assert.strictEqual(f.count, 3, '17.a: the occurrence count is wrong');
    assert.notStrictEqual(f.identifierField, true,
        '17.b: an occurrence outside an identifier field must still promote the finding back');
    assert.strictEqual(shapes.blocksLeak(f), true, '17.c: the finding stopped blocking');
}

// --- 15. No finding carries the value, downgraded or not. ---
{
    const policy = loadPolicy();
    const doc = bodyHar(JSON.stringify({ media_id: CARD, session_id: TOKEN }));
    for (const f of shapes.findLeaksInHar(doc, policy)) {
        const s = JSON.stringify(f);
        assert.ok(!s.includes(CARD) && !s.includes(TOKEN), '15.a: a finding carried the matched value');
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-identifier-fields tests passed');
