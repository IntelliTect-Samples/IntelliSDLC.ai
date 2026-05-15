#!/usr/bin/env node
// Behavior tests for dedupePatterns named-segment classifier (issue #62).
// Zero-dep, runs with `node dedupe-patterns.test.js`.
'use strict';

const assert = require('assert');
const path = require('path');
const { dedupePatterns, methodNameFor } = require(path.join(__dirname, 'generate-wrapper.js'));

function har(method, url) {
    // Match the structure dedupePatterns receives from restEntries:
    // { entry: { request: { method, url } } }
    return { entry: { request: { method, url } } };
}

function isAllLiteral(p) {
    return p.segments.length > 0 && p.segments.every((s) => s.literal && !s.param);
}

// ---- Test 1: TripIt synthetic 7-endpoint HAR -> >= 5 literal-only patterns ----
{
    const entries = [
        har('GET', 'https://api.tripit.com/api/v2/appConfig'),
        har('GET', 'https://api.tripit.com/api/v2/gtmDataAsJson'),
        har('GET', 'https://api.tripit.com/api/v2/purchasedProductInfo'),
        har('GET', 'https://api.tripit.com/api/v2/listProAlerts'),
        har('GET', 'https://api.tripit.com/api/v2/get/profile'),
        har('GET', 'https://api.tripit.com/api/v2/travelerProfile/get'),
        har('GET', 'https://api.tripit.com/api/v2/list/trip'),
    ];
    const patterns = dedupePatterns(entries);
    const literalOnly = patterns.filter(isAllLiteral);
    assert.ok(
        literalOnly.length >= 5,
        `Expected >= 5 literal-only patterns from TripIt synthetic HAR, got ${literalOnly.length}. ` +
        `Patterns: ${JSON.stringify(patterns.map((p) => p.segments), null, 2)}`
    );
    // Method names should be named after the segment, not GetByIdAsync.
    const names = literalOnly.map(methodNameFor);
    assert.ok(names.includes('GetAppConfigAsync'),
        `Expected GetAppConfigAsync in: ${names.join(', ')}`);
    assert.ok(names.includes('GetGtmDataAsJsonAsync'),
        `Expected GetGtmDataAsJsonAsync in: ${names.join(', ')}`);
    assert.ok(names.includes('GetPurchasedProductInfoAsync'),
        `Expected GetPurchasedProductInfoAsync in: ${names.join(', ')}`);
    assert.ok(!names.includes('GetByIdAsync'),
        `GetByIdAsync should not appear for named segments: ${names.join(', ')}`);
    console.log('PASS: TripIt 7-endpoint HAR yields >= 5 literal-only patterns (' + literalOnly.length + ').');
}

// ---- Test 2: Truly opaque varying segments still collapse to {id} ----
{
    const entries = [
        har('GET', 'https://api.example.com/api/v2/trip/123'),
        har('GET', 'https://api.example.com/api/v2/trip/456'),
        har('GET', 'https://api.example.com/api/v2/trip/789'),
    ];
    const patterns = dedupePatterns(entries);
    assert.strictEqual(patterns.length, 1, 'Opaque varying segments should still merge into one pattern');
    const p = patterns[0];
    assert.ok(p.segments.some((s) => s.param === 'id'),
        'Opaque numeric segment should classify as {id}: ' + JSON.stringify(p.segments));
    console.log('PASS: opaque numeric varying segments still collapse to {id}.');
}

// ---- Test 3: UUIDs are opaque ----
{
    const entries = [
        har('GET', 'https://api.example.com/v1/user/550e8400-e29b-41d4-a716-446655440000'),
        har('GET', 'https://api.example.com/v1/user/6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    ];
    const patterns = dedupePatterns(entries);
    assert.strictEqual(patterns.length, 1);
    assert.ok(patterns[0].segments.some((s) => s.param === 'id'),
        'UUID segments should classify as {id}');
    console.log('PASS: UUID varying segments collapse to {id}.');
}

// ---- Test 4: Mixed -- named + opaque -- at same index splits by named values ----
{
    const entries = [
        har('GET', 'https://api.example.com/api/v2/appConfig'),
        har('GET', 'https://api.example.com/api/v2/gtmDataAsJson'),
    ];
    const patterns = dedupePatterns(entries);
    assert.strictEqual(patterns.length, 2,
        'Two distinct named-segment endpoints must NOT merge: got ' +
        JSON.stringify(patterns.map((p) => p.segments)));
    assert.ok(patterns.every(isAllLiteral),
        'Both patterns should be literal-only');
    console.log('PASS: distinct named-segment endpoints remain separate patterns.');
}

console.log('\nAll dedupe-patterns tests passed.');
