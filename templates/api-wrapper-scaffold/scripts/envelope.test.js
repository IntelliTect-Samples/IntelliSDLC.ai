#!/usr/bin/env node
// Behavior tests for envelope detection / unwrap heuristic (issue #64).
// Zero-dep, runs with `node envelope.test.js`. Exits non-zero on first failure.
'use strict';

const assert = require('assert');
const path = require('path');
const {
    inferShape,
    mergeShapes,
    detectEnvelope,
} = require(path.join(__dirname, 'generate-wrapper.js'));

function mergeAll(samples) {
    let acc = null;
    for (const s of samples) {
        const inferred = inferShape(s);
        acc = acc ? mergeShapes(acc, inferred) : inferred;
    }
    return acc;
}

// --- 1. Classic { data: T, meta: {...} } -> unwraps to T (object) ---
{
    const samples = [
        { data: { id: 1, name: 'a' }, meta: { count: 1, page: 1 } },
        { data: { id: 2, name: 'b' }, meta: { count: 1, page: 2 } },
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, true, '1: should unwrap classic data/meta envelope');
    assert.strictEqual(r.payloadField, 'data', '1: payload field should be data');
    assert.strictEqual(r.payloadShape.kind, 'object', '1: payload shape kind');
}

// --- 2. { result: T, errors: [] } -> unwraps to T ---
{
    const samples = [
        { result: { id: 1, value: 'x' }, errors: [] },
        { result: { id: 2, value: 'y' }, errors: [] },
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, true, '2: should unwrap result/errors envelope');
    assert.strictEqual(r.payloadField, 'result', '2: payload field should be result');
}

// --- 3. { items: T[], count: N } -> unwraps to array shape ---
{
    const samples = [
        { items: [{ id: 1 }, { id: 2 }], count: 2 },
        { items: [{ id: 3 }], count: 1 },
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, true, '3: should unwrap items/count envelope');
    assert.strictEqual(r.payloadField, 'items', '3: payload field should be items');
    assert.strictEqual(r.payloadShape.kind, 'array', '3: payload shape should be array');
}

// --- 4. Two equally-substantial fields { user: {...}, profile: {...} } -> NO unwrap ---
{
    const samples = [
        { user: { id: 1, name: 'a' }, profile: { bio: 'hi', verified: true } },
        { user: { id: 2, name: 'b' }, profile: { bio: 'yo', verified: false } },
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, false, '4: should NOT unwrap when two substantial siblings');
}

// --- 5. Single field, no siblings -> still unwraps when count==1 and shape is non-trivial ---
{
    const samples = [
        { payload: { id: 1, value: 'a' } },
        { payload: { id: 2, value: 'b' } },
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, true, '5: should unwrap single-field envelope');
    assert.strictEqual(r.payloadField, 'payload', '5: payload field should be payload');
}

// --- 6. Field name conflict (payload PascalCase clashes with sibling) -> no unwrap ---
//     e.g., { data: {...}, Data: 5 } -> both PascalCase to "Data"; abstain.
{
    const samples = [
        { data: { id: 1 }, Data: 'x' },
        { data: { id: 2 }, Data: 'y' },
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, false, '6: should NOT unwrap when payload name collides with sibling');
}

// --- 7. Defensive: array (not object) top-level -> no unwrap ---
{
    const r = detectEnvelope(inferShape([{ id: 1 }, { id: 2 }]));
    assert.strictEqual(r.envelope, false, '7: top-level array is not an envelope');
}

// --- 8. Defensive: empty object -> no unwrap ---
{
    const r = detectEnvelope(inferShape({}));
    assert.strictEqual(r.envelope, false, '8: empty object is not an envelope');
}

// --- 9. Too many fields (>5) -> no unwrap ---
{
    const r = detectEnvelope(inferShape({
        data: { id: 1 }, count: 1, page: 1, cursor: 'a', next: 'b', has_more: false,
    }));
    assert.strictEqual(r.envelope, false, '9: should NOT unwrap when >5 top-level fields');
}

// --- 10. Single primitive field -> NOT substantial, no unwrap ---
{
    const r = detectEnvelope(inferShape({ status: 'ok' }));
    assert.strictEqual(r.envelope, false, '10: single primitive field is not a substantial payload');
}

// --- 11. Array of metadata-named primitives at top level -> still metadata sibling ---
{
    const samples = [
        { results: [{ id: 1 }], errors: ['x', 'y'] },
        { results: [{ id: 2 }], errors: [] },
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, true, '11: errors[] array w/ metadata key is metadata, unwrap results');
    assert.strictEqual(r.payloadField, 'results', '11: payload should be results');
}

// --- 12. Stable-name rule: payload only present in some samples -> no unwrap ---
//     This protects against dedupe-collapsed patterns where two distinct endpoints
//     were merged and only one sample carries the candidate field.
{
    const samples = [
        { items: [{ id: 1 }, { id: 2 }] },
        { id: 1, name: 'a' }, // no 'items' field
    ];
    const r = detectEnvelope(mergeAll(samples));
    assert.strictEqual(r.envelope, false, '12: should NOT unwrap when payload absent from some samples');
}

console.log('All envelope tests passed');
