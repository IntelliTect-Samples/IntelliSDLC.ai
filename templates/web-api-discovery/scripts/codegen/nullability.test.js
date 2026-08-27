#!/usr/bin/env node
// Behavior tests for the nullability heuristic on generated record properties (issue #63).
// Zero-dep, runs with `node nullability.test.js`. Exits non-zero on first failure.
'use strict';

const assert = require('assert');
const path = require('path');
const {
    inferShape,
    mergeShapes,
    registerModel,
    emitModels,
} = require(path.join(__dirname, 'generate-wrapper.js'));

function mergeAll(samples) {
    let acc = null;
    for (const s of samples) {
        const inferred = inferShape(s);
        acc = acc ? mergeShapes(acc, inferred) : inferred;
    }
    return acc;
}

function emitFor(name, samples) {
    const merged = mergeAll(samples);
    const map = new Map();
    registerModel(map, name, merged);
    return emitModels(map);
}

// ---- Test 1: present and non-null in every sample -> non-nullable string ----
{
    const cs = emitFor('Person', [
        { name: 'alice' },
        { name: 'bob' },
    ]);
    assert.ok(/public string Name \{ get; init; \}/.test(cs),
        'Test 1 failed: Name should be non-nullable string. Got:\n' + cs);
    assert.ok(!/public string\? Name \{/.test(cs),
        'Test 1 failed: Name should NOT be nullable. Got:\n' + cs);
}

// ---- Test 2: null in at least one sample -> nullable string ----
{
    const cs = emitFor('Person', [
        { name: 'alice' },
        { name: null },
    ]);
    assert.ok(/public string\? Name \{ get; init; \}/.test(cs),
        'Test 2 failed: Name should be string? when null observed. Got:\n' + cs);
}

// ---- Test 3: absent from at least one sample -> nullable string ----
{
    const cs = emitFor('Person', [
        { name: 'alice' },
        { },
    ]);
    assert.ok(/public string\? Name \{ get; init; \}/.test(cs),
        'Test 3 failed: Name should be string? when absent in a sample. Got:\n' + cs);
}

// ---- Test 4: mixed (null, present, absent) -> nullable ----
{
    const cs = emitFor('Person', [
        { name: 'alice' },
        { name: null },
        { },
        { name: 'carol' },
    ]);
    assert.ok(/public string\? Name \{ get; init; \}/.test(cs),
        'Test 4 failed: Name should be string? under mixed evidence. Got:\n' + cs);
}

// ---- Test 5: value-type int -> int? when null observed ----
{
    const cs = emitFor('Item', [
        { count: 5 },
        { count: null },
    ]);
    assert.ok(/public int\? Count \{ get; init; \}/.test(cs),
        'Test 5 failed: Count should be int? when null observed. Got:\n' + cs);
}

// ---- Test 6: value-type bool -> bool? when absent in a sample ----
{
    const cs = emitFor('Flag', [
        { active: true },
        { },
    ]);
    assert.ok(/public bool\? Active \{ get; init; \}/.test(cs),
        'Test 6 failed: Active should be bool? when absent. Got:\n' + cs);
}

// ---- Test 7: value-type double/decimal-like -> double? when null observed ----
{
    const cs = emitFor('Measure', [
        { ratio: 1.5 },
        { ratio: null },
    ]);
    assert.ok(/public double\? Ratio \{ get; init; \}/.test(cs),
        'Test 7 failed: Ratio should be double? when null observed. Got:\n' + cs);
}

// ---- Test 8: value-type int -> stays int when present-non-null in every sample ----
{
    const cs = emitFor('Item', [
        { count: 5 },
        { count: 7 },
    ]);
    assert.ok(/public int Count \{ get; init; \}/.test(cs) && !/public int\? Count/.test(cs),
        'Test 8 failed: Count should be plain int when always present and non-null. Got:\n' + cs);
}

// ---- Test 9: multiple fields, mixed nullability profiles ----
{
    const cs = emitFor('Trip', [
        { id: 'a', title: 'X', notes: 'hi' },
        { id: 'b', title: 'Y', notes: null },
        { id: 'c', title: 'Z' },
    ]);
    assert.ok(/public string Id \{ get; init; \}/.test(cs) && !/public string\? Id/.test(cs),
        'Test 9 failed: Id should be non-nullable. Got:\n' + cs);
    assert.ok(/public string Title \{ get; init; \}/.test(cs) && !/public string\? Title/.test(cs),
        'Test 9 failed: Title should be non-nullable. Got:\n' + cs);
    assert.ok(/public string\? Notes \{ get; init; \}/.test(cs),
        'Test 9 failed: Notes should be nullable (null in one, absent in another). Got:\n' + cs);
}

// ---- Test 10: nested object null in some samples -> nullable, real shape preserved ----
{
    const cs = emitFor('Account', [
        { user: { name: 'alice' } },
        { user: null },
    ]);
    // The User record should still be emitted (real shape preserved).
    assert.ok(/public sealed partial class User\b/.test(cs),
        'Test 10 failed: nested User record should still be emitted. Got:\n' + cs);
    // The Account.User property should be User? (nullable reference type), NOT JsonElement.
    assert.ok(/public User\? User \{ get; init; \}/.test(cs),
        'Test 10 failed: Account.User should be User? (nullable record reference). Got:\n' + cs);
    assert.ok(!/public JsonElement\b[^?]/.test(cs.replace(/JsonElement\?/g, '')),
        'Test 10 failed: should not fall back to JsonElement when only nullability differs. Got:\n' + cs);
}

// ---- Test 11: array null in some samples -> IReadOnlyList<...>? (array kept nullable) ----
{
    const cs = emitFor('Account', [
        { tags: ['a', 'b'] },
        { tags: null },
    ]);
    assert.ok(/public IReadOnlyList<string>\? Tags \{ get; init; \}/.test(cs),
        'Test 11 failed: Tags should be IReadOnlyList<string>? when array null in one sample. Got:\n' + cs);
}

// ---- Test 12: array absent in some samples -> IReadOnlyList<...>? ----
{
    const cs = emitFor('Account', [
        { tags: ['a'] },
        { },
    ]);
    assert.ok(/public IReadOnlyList<string>\? Tags \{ get; init; \}/.test(cs),
        'Test 12 failed: Tags should be IReadOnlyList<string>? when array absent in one sample. Got:\n' + cs);
}

console.log('All nullability tests passed (12/12).');
