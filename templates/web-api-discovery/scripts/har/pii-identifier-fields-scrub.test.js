#!/usr/bin/env node
// Behavior tests for issue #360: the SCRUBBER must consult `identifierFields`
// the way the GATE already does.
//
// The gap. `har-shapes.js` marks a finding `identifierField` when an IDENTITY
// value sits at a field the policy declares to hold object ids, and
// `blocksLeak` then declines to fail the run. `pii.js` never asked the
// question, so the same value the gate had agreed was an object id was still
// REPLACED with a generated fake. Beat 5 of the design doc, on the half where a
// false positive is silent and permanent rather than noisy and reversible.
//
// WHAT THESE TESTS ARE. The headline case is a PROPERTY over generated
// documents, not a list of field names -- three review rounds on the gate side
// each found a name a curated list had not imagined:
//
//   a card-shaped IDENTITY value survives the scrub if and only if every
//   occurrence of it the detector resolves to a JSON key sits at a field the
//   policy declares to hold ids, and it resolves at least one.
//
// The generator is seeded with the ADJACENT shapes rather than exotic ones,
// because that is where the gaps got through before:
//
//   * the same value at an identifier field in one place and a plain field in
//     another, within one document (the promotion case),
//   * an identifier field holding an ARRAY, so the value's path carries a
//     subscript (`media_ids[4]`) that `enclosingFieldName` must strip,
//   * a header, a query parameter and the URL, which reach `detectInString`
//     with no resolved key at all,
//   * a SECRET-class value under an `*id` name, which must STILL be replaced.
//
// The oracle is `harPolicy.isIdentifierField` -- the matcher the change is
// required to CONSUME rather than re-implement. That makes these cases a test
// of the wiring and its scope, which is what #360 changes; the matcher itself
// is tested in `har-identifier-fields.test.js`.
//
// NO DETECTED VALUE IS PRINTED. Every generated value is synthetic and no
// assertion message carries one -- kind, class, field name and site count
// only. A failure message that quotes the value relocates the leak into the
// report.
//
// Zero-dep, runs with `node pii-identifier-fields-scrub.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { initProtectedRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const pii = require(path.join(__dirname, 'pii.js'));
const harPolicy = require(path.join(__dirname, 'har-policy.js'));
const harShapes = require(path.join(__dirname, 'har-shapes.js'));
const sanitize = path.join(__dirname, 'sanitize-har.js');

const POLICY = harPolicy.loadDefaultPolicy();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pii-idfields-')));

let failures = 0;
let ran = 0;
function check(label, fn) {
    ran++;
    try { fn(); } catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
}

// --- generator ----------------------------------------------------------
//
// Seeded, so a run is not a different test every time and a failure is
// reproducible from the case index printed with it.
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 0x100000000;
    };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length) % xs.length];

// Neutral stems -- none is a `piiFields` name, so the field-TYPE path is not
// what decides any of these cases.
const STEMS = ['media', 'trip', 'order', 'ledger', 'actor', 'widget', 'basket',
    'shipment', 'listing', 'thread', 'roster', 'parcel'];
// Tails from both sides of the line, GENERATED into names rather than asserted
// about: the point is that the oracle and the scrubber agree on whatever the
// generator produced, not that this list is the right list.
const TAILS = ['id', 'ids', 'pk', 'pks', 'uuid', 'uuids', 'guid', 'guids',
    'ref', 'refs', 'code', 'slug', 'number', 'handle', ''];

function fieldName(r) {
    const stem = pick(r, STEMS);
    const tail = pick(r, TAILS);
    if (tail === '') return stem;
    switch (Math.floor(r() * 3)) {
        case 0: return stem + '_' + tail;
        case 1: return stem + '-' + tail;
        default: return stem + tail.charAt(0).toUpperCase() + tail.slice(1);
    }
}

/** A card-shaped IDENTITY value: assigned issuer prefix, minted length, Luhn. */
function cardShaped(r) {
    let digits = '4';                       // Visa: assigned, and 16 is minted
    while (digits.length < 15) digits += String(Math.floor(r() * 10));
    if (digits.startsWith('4242')) digits = '4143' + digits.slice(4);
    let sum = 0;
    [...digits].reverse().forEach((d, i) => {
        let n = Number(d);
        if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
        sum += n;
    });
    return digits + String((10 - (sum % 10)) % 10);
}

const PLACEMENTS = ['field', 'array', 'header', 'query', 'cookie', 'url'];

/**
 * One HAR whose single entry carries `value` at each of `sites`.
 *
 * A header, a cookie and a query parameter take the SAME generated name as a
 * body field would. That is deliberate and it is the point of the scope cases:
 * `media_id` is a declared identifier field, and it must decide nothing at all
 * when it is a header name rather than a resolved JSON key. Naming these
 * `x-echo-0` instead would have made the scope cases unfalsifiable -- an
 * ablation that reads the header name would still have passed them.
 */
function harWith(value, sites) {
    const body = {};
    const headers = [];
    const query = [];
    const cookies = [];
    let url = 'https://example.invalid/api';
    sites.forEach((site) => {
        if (site.where === 'field') body[site.name] = value;
        else if (site.where === 'array') body[site.name] = ['keep-me', value];
        else if (site.where === 'header') headers.push({ name: site.name, value });
        else if (site.where === 'query') query.push({ name: site.name, value });
        else if (site.where === 'cookie') cookies.push({ name: site.name, value });
        else if (site.where === 'url') url = 'https://example.invalid/api/' + value;
    });
    return {
        log: {
            version: '1.2', creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
                request: {
                    method: 'GET', url, httpVersion: 'HTTP/1.1',
                    headers, queryString: query, cookies, headersSize: -1, bodySize: 0,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                    content: { size: 0, mimeType: 'application/json', text: JSON.stringify(body) },
                    redirectURL: '', headersSize: -1, bodySize: 0,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    };
}

/** How many places in the serialised HAR the value literally occurs. */
function siteCount(har, value) {
    return JSON.stringify(har).split(value).length - 1;
}

/**
 * The ORACLE. A site suppresses only when it resolves to a JSON key the policy
 * declares to hold ids; a header, a query parameter and the URL resolve to no
 * key at all. The value survives only when every site suppresses.
 */
function shouldSurvive(sites) {
    if (sites.length === 0) return false;
    return sites.every(s => (s.where === 'field' || s.where === 'array')
        && harPolicy.isIdentifierField(POLICY, s.name));
}

function generateCase(r) {
    const n = 1 + Math.floor(r() * 3);
    const sites = [];
    for (let i = 0; i < n; i++) {
        sites.push({ where: pick(r, PLACEMENTS), name: fieldName(r) });
    }
    return { value: cardShaped(r), sites };
}

// --- 1. THE PROPERTY ----------------------------------------------------
check('1.a survival matches the identifier-field oracle over generated documents', () => {
    const r = rng(0x360C0DE);
    let identifierOnly = 0;
    let mixed = 0;
    for (let i = 0; i < 400; i++) {
        const { value, sites } = generateCase(r);
        const har = harWith(value, sites);
        const before = siteCount(har, value);
        if (before === 0) continue;
        const expected = shouldSurvive(sites);
        if (expected) identifierOnly++; else mixed++;
        const result = pii.scrubPii(har, POLICY);
        const after = siteCount(har, value);
        const shape = sites.map(s => s.where + ':' + s.name).join('+');
        assert.strictEqual(after > 0, expected,
            'case ' + i + ' (' + shape + '): expected the card-shaped identity value to '
            + (expected ? 'SURVIVE' : 'be REPLACED') + '; ' + after + '/' + before
            + ' sites remain');
        if (expected) {
            assert.strictEqual(after, before,
                'case ' + i + ' (' + shape + '): a suppressed value must survive at EVERY '
                + 'site, not only the one that earned the mark');
            assert.ok(!result.substitutions.some(s => s.type === 'credit-card'),
                'case ' + i + ' (' + shape + '): the substitution table gained an entry for '
                + 'a value the scrub declined to replace');
        }
    }
    assert.ok(identifierOnly >= 20 && mixed >= 20,
        'the generator must exercise BOTH directions; got ' + identifierOnly
        + ' identifier-only and ' + mixed + ' mixed/plain documents');
});

// A generator that cannot express a shape cannot falsify it. These pin the
// adjacent shapes, so a later edit to the generator cannot quietly stop
// producing them and leave 1.a passing on a narrower population.
check('1.b the generator actually produces every adjacent shape', () => {
    const r = rng(0x360C0DE);
    const seen = new Set();
    let staggered = 0;
    let subscripted = 0;
    let idNamedPathless = 0;
    for (let i = 0; i < 400; i++) {
        const { value, sites } = generateCase(r);
        for (const s of sites) seen.add(s.where);
        const ids = sites.filter(s => (s.where === 'field' || s.where === 'array')
            && harPolicy.isIdentifierField(POLICY, s.name));
        if (ids.length && ids.length < sites.length) staggered++;
        if (sites.some(s => s.where === 'array'
            && harPolicy.isIdentifierField(POLICY, s.name))) subscripted++;
        // The shape that makes the SCOPE constraint testable at all: a site
        // with no resolved key path whose NAME is nonetheless a declared
        // identifier field. Without it, 1.a would pass an implementation that
        // read the header, cookie or query-parameter name.
        //
        // READ OFF THE BUILT DOCUMENT, not off the plan. Asking `sites` here
        // measures what the generator INTENDED; if `harWith` dropped the name
        // on the floor, the plan would still say the shape was covered while
        // no document ever carried it. That is the shape of the boundary guard
        // whose function never executed, and mutating `harWith` is what caught
        // it.
        const req = harWith(value, sites).log.entries[0].request;
        const pathless = [...req.headers, ...req.queryString, ...req.cookies];
        if (pathless.some(x => x.value === value
            && harPolicy.isIdentifierField(POLICY, x.name))) idNamedPathless++;
    }
    for (const where of PLACEMENTS) {
        assert.ok(seen.has(where), 'the generator never produced a "' + where + '" site');
    }
    assert.ok(staggered >= 10,
        'the generator never staggered an identifier field against a plain one: ' + staggered);
    assert.ok(subscripted >= 10,
        'the generator never put an identifier field around an ARRAY: ' + subscripted);
    assert.ok(idNamedPathless >= 10,
        'the generator never gave a pathless site an identifier-field NAME: ' + idNamedPathless);
});

// --- 2. THE PROMOTION RULE, stated as its own case ----------------------
//
// One occurrence at an id field does not make the VALUE an id. The replacement
// set is keyed on the value, so the alternative -- rewriting one occurrence and
// leaving the identical string beside it -- publishes the value it claims to
// have removed. This is the rule `findLeaksInHar` already states on the gate.
check('2.a a value echoed at a plain field is replaced at the id field too', () => {
    const value = cardShaped(rng(7));
    const har = harWith(value, [
        { where: 'field', name: 'media_id' },
        { where: 'field', name: 'ledger_ref' },
    ]);
    pii.scrubPii(har, POLICY);
    assert.strictEqual(siteCount(har, value), 0,
        'the value was echoed at a field with no id declaration, which promotes it back');
});

check('2.b the same value at TWO id fields survives at both', () => {
    const value = cardShaped(rng(7));
    const har = harWith(value, [
        { where: 'field', name: 'media_id' },
        { where: 'array', name: 'trip_uuids' },
    ]);
    const before = siteCount(har, value);
    assert.strictEqual(before, 2, 'the fixture must place the value twice');
    pii.scrubPii(har, POLICY);
    assert.strictEqual(siteCount(har, value), before,
        'a value seen only at declared identifier fields must not be rewritten');
});

// --- 3. SCOPE: no resolved key path, no suppression ----------------------
check('3.a a header value is unaffected by the identifier rule', () => {
    const value = cardShaped(rng(11));
    const har = harWith(value, [{ where: 'header', name: 'media_id' }]);
    pii.scrubPii(har, POLICY);
    assert.strictEqual(siteCount(har, value), 0,
        'a header carries no structural key, so nothing licenses declining the replace');
});

check('3.b a query parameter named like an id field is still replaced', () => {
    const value = cardShaped(rng(12));
    const har = harWith(value, [{ where: 'query', name: 'media_id' }]);
    pii.scrubPii(har, POLICY);
    assert.strictEqual(siteCount(har, value), 0,
        'a query parameter name is not a resolved JSON key path');
});

check('3.c a value in the URL is still replaced', () => {
    const value = cardShaped(rng(13));
    const har = harWith(value, [{ where: 'url', name: 'unused' }]);
    pii.scrubPii(har, POLICY);
    assert.strictEqual(siteCount(har, value), 0,
        'the URL reaches the detectors under the enclosing HAR node name, which is '
        + 'not evidence about any field');
});

check('3.d a cookie named like an id field is still replaced', () => {
    const value = cardShaped(rng(14));
    const har = harWith(value, [{ where: 'cookie', name: 'media_id' }]);
    pii.scrubPii(har, POLICY);
    assert.strictEqual(siteCount(har, value), 0,
        'a cookie name is not a resolved JSON key path');
});

// --- 4. SUPPRESS THE REPLACE, NOT THE REPORT -----------------------------
check('4.a the detection survives, marked, when the replace is declined', () => {
    const value = cardShaped(rng(21));
    const har = harWith(value, [{ where: 'field', name: 'media_id' }]);
    const found = pii.detectPii(har, POLICY).filter(d => d.type === 'credit-card');
    assert.strictEqual(found.length, 1, 'the finding must not vanish');
    assert.strictEqual(found[0].identifierField, true,
        'the finding must carry the same mark the gate puts on it');
});

check('4.b scrubPii reports it in `retained`, in the gate vocabulary', () => {
    const value = cardShaped(rng(22));
    const har = harWith(value, [{ where: 'field', name: 'media_id' }]);
    const result = pii.scrubPii(har, POLICY);
    const row = result.retained.find(x => x.kind === 'credit-card');
    assert.ok(row, 'a declined replacement must be reported');
    assert.strictEqual(row.identifierField, true, 'the row must say WHY it was declined');
    assert.strictEqual(row.class, 'identity', 'identity class only');
    assert.strictEqual(row.setting, 'gate',
        'the class is not off -- reporting `off` would claim a policy decision nobody made');
    assert.strictEqual(row.occurrences, 1);
    assert.strictEqual(row.distinct, 1);
    assert.ok(!JSON.stringify(result.retained).includes(value),
        'the report must never carry the value');
});

check('4.c the substitution table gains no entry for a declined value', () => {
    const value = cardShaped(rng(23));
    const har = harWith(value, [{ where: 'field', name: 'media_id' }]);
    const result = pii.scrubPii(har, POLICY);
    assert.deepStrictEqual(result.substitutions, [],
        'a value that is never rewritten must not be enrolled as a substitution');
});

// --- 5. SECRET CLASS NEVER ----------------------------------------------
//
// The guard rests on a fact about the shape detectors, so the fact is pinned
// rather than assumed: every type `detectInString` can emit is on the IDENTITY
// axis of the shipped policy, and none is on the secret axis. Point a shape
// detector at a secret kind and this fails.
check('5.a every shape detector emits an identity kind and never a secret one', () => {
    const secretKinds = new Set(Object.keys(POLICY.classes.secret));
    const identityKinds = new Set(Object.keys(POLICY.classes.identity));
    const value = cardShaped(rng(31));
    const har = harWith(value, []);
    har.log.entries[0].response.content.text = JSON.stringify({
        ledger_ref: value,
        note_a: 'someone@example.test',
        note_b: '+14155550123',
        note_c: '123-45-6789',
        note_d: 'GB82WEST12345698765432',
        note_e: 'AA:BB:CC:DD:EE:F0',
        note_f: '203.0.113.9',
        note_g: '2001:0db8:0000:0000:0000:ff00:0042:8329',
    });
    const types = new Set(pii.detectPii(har, POLICY).map(d => d.type));
    assert.ok(types.size >= 6,
        'the fixture must exercise the shape detectors; it reached ' + types.size);
    for (const t of types) {
        assert.ok(!secretKinds.has(t), 'a shape detector emitted the SECRET kind "' + t + '"');
        assert.ok(identityKinds.has(t), '"' + t + '" is on neither axis of the shipped policy');
    }
});

check('5.b a secret-class value under an *id name is still removed end to end', () => {
    const dir = path.join(tmp, 'secret-at-id');
    initProtectedRepo(dir);
    fs.mkdirSync(path.join(dir, 'samples', 'har-original'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'),
        JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));
    // 64 hex characters -- the `hex64` SECRET kind. `session_id` is a declared
    // identifier field, which is exactly the trap: a field name does not argue
    // entropy away.
    const SECRET = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
    const har = harWith('x', []);
    har.log.entries[0].response.content.text = JSON.stringify({ session_id: SECRET });
    const harPath = path.join(dir, 'samples', 'har-original', 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
    execFileSync(process.execPath, [sanitize, '--in', harPath],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.readFileSync(path.join(dir, 'samples', 'har', 'capture.har'), 'utf8');
    assert.ok(!out.includes(SECRET),
        'a secret-class value survived because its field name ends in `_id`');
});

// --- 6. The pipeline SAYS it declined ------------------------------------
check('6.a sanitize-har reports the declined replacements on the run', () => {
    const dir = path.join(tmp, 'says-so');
    initProtectedRepo(dir);
    fs.mkdirSync(path.join(dir, 'samples', 'har-original'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'),
        JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));
    const value = cardShaped(rng(41));
    const har = harWith(value, [{ where: 'field', name: 'media_id' }]);
    const harPath = path.join(dir, 'samples', 'har-original', 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
    const run = spawnSync(process.execPath, [sanitize, '--in', harPath],
        { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(run.status, 0, 'sanitize-har did not complete');
    const said = (run.stderr || '') + (run.stdout || '');
    assert.ok(/NOT replaced/.test(said) && /credit-card x1/.test(said),
        'the run must SAY it declined a replacement -- an invisible loosening is '
        + 'how this gate lost its authority');
    assert.ok(!said.includes(value), 'the run output must never carry the value');
    const out = fs.readFileSync(path.join(dir, 'samples', 'har', 'capture.har'), 'utf8');
    assert.ok(out.includes(value),
        'the value the run said it kept must actually still be there');
});

check('6.b the gate exports the identifier predicate the scrub consumes', () => {
    assert.strictEqual(typeof harShapes.isIdentifierShaped, 'function',
        'har-shapes.js must own and export the identifier decision');
    // ...and it decides the way the scrub needs it to. A signature test proves
    // nothing on its own, which is why every other case here drives the scrub.
    assert.strictEqual(
        harShapes.isIdentifierShaped({ class: 'identity' }, 'media_ids[4]', POLICY), true,
        'an identifier field holding an array must still be one');
    assert.strictEqual(
        harShapes.isIdentifierShaped({ class: 'secret' }, 'media_id', POLICY), false,
        'a secret-class finding must never be downgraded by a field name');
});

if (failures) {
    console.error('pii-identifier-fields-scrub: ' + failures + ' case(s) failed');
    process.exit(1);
}
console.log('All pii-identifier-fields-scrub tests passed (' + ran + ').');
