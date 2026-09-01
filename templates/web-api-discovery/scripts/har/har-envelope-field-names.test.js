#!/usr/bin/env node
// Behavior tests for issue #369 -- the gate must not read a HAR ENVELOPE
// property name as a captured field name.
//
// Zero-dep, runs with `node har-envelope-field-names.test.js`. Reports every
// check and exits non-zero when any failed.
//
// The defect: `findLeaksInHar` walks the WHOLE entry, so a finding in a
// header, a cookie, a query parameter or the URL carries a path naming HAR's
// own structure -- `request.headers[0].value`, `request.url`. Deriving a
// "field name" from those yields `value` and `url`, which are properties of
// the FILE FORMAT and not keys any captured document chose. A project
// declaring `identifierFields: ["*value"]` is reasoning about its own
// payloads, and had no way to know the pattern also switched off gate
// reporting for every header, cookie and query parameter in the corpus.
//
// Why it is urgent rather than tidy: once the scrubber consults
// `identifierFields` (#360), it DECLINES to replace values it cannot
// adjudicate, and the gate is the backstop that refuses to pass them. A gate
// that wrongly suppresses is then a leak path, not a reporting nuisance.
//
// The fix is provenance at the walk, not a denylist of envelope names: only a
// path that descends INTO a parsed body names a captured field, and the walk
// is the only place that knows. A denylist would be a predicate approximating
// the concept, and it would miss the next envelope property.
//
// THE OVER-CORRECTION THIS MUST NOT MAKE: a card-shaped value at a genuine
// BODY field named `value`, under `*value`, must STILL be suppressed. Guards
// G1-G3 and the property both pin it.
//
// HARNESS NOTE, from a false negative this cost during investigation: a merged
// policy is FROZEN, and its compiled matchers are additionally cached in a
// WeakMap keyed on the policy object, so a policy that were mutated in place
// would keep answering with the matchers it was loaded with.
//
// WHERE THAT ACTUALLY BITES, stated precisely, because the imprecise version
// invites the next reader to delete the guard. In a file like this one, which
// declares `'use strict'`, `policy.identifierFields = [...]` THROWS -- strict
// mode turns the frozen-object write into a TypeError, and the mistake is
// loud. The silent no-op is a SLOPPY-MODE failure, and sloppy mode is exactly
// where this kind of probing happens: an ad hoc `node -e` one-liner has no
// directive, so the assignment is discarded without a word and the run
// measures the SHIPPED DEFAULT while its author believes it measured a
// project's. That is how a real defect was nearly cleared.
//
// So the guard is not there to catch an assignment in this file. It is there
// so that whatever route a policy arrives by -- including one lifted out of a
// throwaway probe -- the suite refuses to draw a conclusion until it has
// watched the patterns bite. Every policy here comes from the loader with a
// real project file, and `livePolicy` ASSERTS that before any case runs.
//
// No finding, message or assertion in this file prints a detected value.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-envelope-'));

// Visa, 16 digits, Luhn-valid, assigned IIN. IDENTITY class.
const CARD = '4111111111111111';
// A second one, for documents that need a value the case is not about.
const CARD_B = '4012888888881881';
// hex32 -- SECRET class. The negative control for the whole feature.
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

let failures = 0;
let checks = 0;

function test(label, fn) {
    checks++;
    try {
        fn();
        console.log('  ok   ' + label);
    } catch (err) {
        failures++;
        console.log('  FAIL ' + label + '\n       ' + err.message);
    }
}

/**
 * Load a policy through the LOADER, from a real project file, and assert the
 * patterns actually bite.
 *
 * `expect` is a list of `[fieldName, matches]` pairs checked against
 * `harPolicy.isIdentifierField`. This is a harness assertion, not a courtesy:
 * a frozen policy silently ignores mutation, so a suite that built its
 * policies by assignment would run every case against the shipped default and
 * report this defect fixed.
 */
function livePolicy(project, expect) {
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME), JSON.stringify(project));
    const policy = policyModule.loadPolicy({ startDir: dir, stopAt: dir });
    for (const [field, matches] of expect) {
        assert.strictEqual(
            policyModule.isIdentifierField(policy, field), matches,
            'harness: policy is not live -- isIdentifierField(' + JSON.stringify(field) + ') '
            + 'should be ' + matches + '. A frozen policy was probably mutated instead of loaded.');
    }
    return policy;
}

function defaultPolicy() {
    const dir = fs.mkdtempSync(path.join(tmp, 'd-'));
    return policyModule.loadPolicy({ startDir: dir, stopAt: dir });
}

// ---------------------------------------------------------------- HAR builder

function entryWith(parts) {
    return {
        request: {
            method: 'GET',
            url: parts.url || 'https://example.test/api/resource',
            headers: parts.requestHeaders || [],
            cookies: parts.requestCookies || [],
            queryString: parts.queryString || [],
        },
        response: {
            status: 200,
            headers: parts.responseHeaders || [],
            cookies: parts.responseCookies || [],
            content: { mimeType: parts.mimeType || 'application/json', text: parts.body || '{}' },
        },
    };
}

function harOf(entryParts) {
    return { log: { version: '1.2', entries: entryParts.map(entryWith) } };
}

function har(parts) {
    return harOf([parts]);
}

/**
 * Did the gate REPORT the value, and does it BLOCK the run?
 *
 * Reporting is asserted separately and first. "does not block" is the same
 * observation whether the gate suppressed the finding or never made it, and
 * conflating the two is how a case list certifies a detector that quietly
 * stopped detecting.
 */
function verdict(document, policy) {
    const hits = shapes.findLeaksInHar(document, policy).filter((f) => f.kind === 'credit-card');
    return { reported: hits.length, blocks: hits.some(shapes.blocksLeak) };
}

function assertBlocks(document, policy, why) {
    const seen = verdict(document, policy);
    assert.ok(seen.reported > 0, why + ': nothing was reported at all, so "blocks" would be vacuous');
    assert.strictEqual(seen.blocks, true, why + ': the gate did not block');
}

function assertSuppressed(document, policy, why) {
    const seen = verdict(document, policy);
    assert.ok(seen.reported > 0, why + ': the finding must still be REPORTED, not removed');
    assert.strictEqual(seen.blocks, false, why + ': the gate blocked, so the declared field was not honoured');
}

// A policy declaring the HAR envelope's own property names. Every one of these
// is an ordinary thing for a project to write about its own payloads, and no
// project can be expected to know which of them HAR also uses.
const ENVELOPE_NAMES = {
    schemaVersion: 1,
    identifierFields: ['*value', '*url', '*name', '*text'],
};
const ENVELOPE_EXPECT = [
    ['value', true], ['url', true], ['name', true], ['text', true],
    ['media_id', true],          // from the shipped default, which is appended to
    ['price_note', false],
];

console.log('\nFALSIFIERS -- these fail on main and pass with the fix. This is the evidence.\n');

test('F1 a card-shaped value in a REQUEST HEADER blocks under `*value`', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ requestHeaders: [{ name: 'x-echo', value: CARD }] }), policy,
        'request.headers[].value is a HAR property, not a captured field');
});

test('F2 a card-shaped value in a RESPONSE HEADER blocks under `*value`', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ responseHeaders: [{ name: 'x-echo', value: CARD }] }), policy,
        'response.headers[].value is a HAR property, not a captured field');
});

test('F3 a card-shaped COOKIE VALUE blocks under `*value`', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ requestCookies: [{ name: 'sid', value: CARD }] }), policy,
        'request.cookies[].value is a HAR property, not a captured field');
});

test('F4 a card-shaped COOKIE NAME blocks under `*name`', () => {
    // The cookie NAME and the cookie VALUE sit one property apart in the same
    // envelope object, and the defect reads both as field names.
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ requestCookies: [{ name: CARD, value: 'x' }] }), policy,
        'request.cookies[].name is a HAR property, not a captured field');
});

test('F5 a card-shaped QUERY-STRING VALUE blocks under `*value`', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ queryString: [{ name: 'ref', value: CARD }] }), policy,
        'request.queryString[].value is a HAR property, not a captured field');
});

test('F6 a query parameter actually NAMED `value` still blocks under `*value`', () => {
    // The adjacent shape, and the one that looks like an over-correction until
    // it is followed through: the parameter's own name really is `value`, so
    // the envelope path and the plausible captured name coincide.
    //
    // It still blocks, because the identifier rule is scoped to a RESOLVED
    // KEY PATH and a query parameter has none -- its name is a wire-format
    // label the HAR writer put in a `name` property, not a key in a parsed
    // document. That is the same scoping the scrubber applies, which reaches
    // the detectors for a query value with no key at all. (Note what that
    // does NOT say: the scrubber never DECLINES here, it always replaces, so
    // there is no scrub decline for the gate to back up. The two engines agree
    // on the constraint, not on the outcome.)
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ queryString: [{ name: 'value', value: CARD }] }), policy,
        'a query parameter is not a JSON key, whatever it is named');
});

test('F7 a card-shaped value embedded in the URL blocks under `*url`', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ url: 'https://example.test/api/orders/' + CARD + '/items' }), policy,
        'request.url is a HAR property, not a captured field');
});

test('F8 a TOP-LEVEL ARRAY body element blocks under `*text`', () => {
    // `[V]` resolves to `response.content.text[0]`. Stripping the subscript
    // walks back onto the envelope node, so the element inherits `text` -- a
    // field name it does not have. An array element has no key of its own.
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ body: JSON.stringify([CARD]) }), policy,
        'a top-level array element has no captured field name');
});

test('F9 THE COMPOSITION CASE: at a body id field AND echoed in a header, blocks', () => {
    // The scenario the aligned scrubber produces: mixed evidence, so it
    // declines to replace and the value ships in the artifact unchanged with
    // the gate promised as the backstop. Both occurrences must not look like
    // identifier hits, or the promotion rule
    // (`existing.identifierField && !identifierField`) never sees a `false`
    // and the run passes while an unredacted value sits in the reference.
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({
        body: JSON.stringify({ media_id: CARD }),
        requestHeaders: [{ name: 'x-echo', value: CARD }],
    }), policy, 'the header echo is the evidence the body downgrade was wrong');
});

test('F10 the same composition with the HEADER seen first still blocks', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(harOf([
        { requestHeaders: [{ name: 'x-echo', value: CARD }] },
        { body: JSON.stringify({ media_id: CARD }) },
    ]), policy, 'grouping order must not decide the verdict');
});

console.log('\nGUARDS -- these pass on arrival. Welcome, and not evidence.\n');

test('G1 a card at a genuine BODY field named `value` is still suppressed under `*value`', () => {
    // The over-correction this fix must not make. `value` here is a key the
    // captured document chose, and the project declared it.
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertSuppressed(har({ body: JSON.stringify({ value: CARD }) }), policy,
        'a body field named `value` is captured data');
});

test('G2 a NESTED body path ending in `.value` is still suppressed under `*value`', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertSuppressed(har({ body: JSON.stringify({ outer: { inner: { value: CARD } } }) }), policy,
        'depth does not change whose key it is');
});

test('G3 a body ARRAY under a declared field is still suppressed', () => {
    // `media_ids[0]` is held by `media_ids`; the element has no key of its
    // own, so the array field is the field that holds it.
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertSuppressed(har({ body: JSON.stringify({ media_ids: [CARD] }) }), policy,
        'an array element inside a body is held by the array field');
});

test('G4 a card at `media_id` is still suppressed under the SHIPPED DEFAULT', () => {
    assertSuppressed(har({ body: JSON.stringify({ media_id: CARD }) }), defaultPolicy(),
        'the shipped `*id` behaviour is untouched');
});

test('G5 a card in a header BLOCKS under the shipped default', () => {
    assertBlocks(har({ requestHeaders: [{ name: 'x-echo', value: CARD }] }), defaultPolicy(),
        'no default pattern matches an envelope property name');
});

test('G6 a SECRET-class value at a body field named `value` still blocks under `*value`', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    const hits = shapes.findLeaksInHar(har({ body: JSON.stringify({ value: TOKEN }) }), policy)
        .filter((f) => f.class === 'secret');
    assert.ok(hits.length > 0, 'the secret was not reported at all');
    assert.ok(hits.some(shapes.blocksLeak), 'a field name does not argue entropy away');
});

test('G7 a PERCENT-DECODED finding, which has no structural path, blocks', () => {
    // Only the decoded view sees this value, so it is pushed with no key path
    // at all and the enclosing node is named instead. Nothing may read that
    // node's name as a field.
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    const encoded = CARD.slice(0, 8) + '%3' + CARD[8] + '%3' + CARD[9] + CARD.slice(10);
    assertBlocks(har({ body: 'payload=' + encoded, mimeType: 'text/plain' }), policy,
        'a decoded finding has no field name to consult');
});

test('G9 a TOP-LEVEL ARRAY OF OBJECTS keeps its captured keys (declared -> suppressed)', () => {
    // What a list endpoint returns. `response.content.text[0].media_id` names
    // a key the document chose just as plainly as `…text.media_id` does, and
    // treating the subscript as a wall would put spurious blocks on a
    // project's own legitimately declared object ids. Noise, not a leak -- and
    // noise is what cost this gate its authority the first time.
    assertSuppressed(har({ body: JSON.stringify([{ media_id: CARD }, { other: 'x' }]) }),
        defaultPolicy(), 'a key inside a top-level array element is captured data');
});

test('G10 a NESTED ARRAY inside a top-level array element is held by its field', () => {
    // `…text[0].media_ids[0]`: two subscripts, one on each side of the key.
    assertSuppressed(har({ body: JSON.stringify([{ media_ids: [CARD] }]) }),
        defaultPolicy(), 'the array field holds its elements at any depth');
});

test('G11 a top-level array element at an UNDECLARED field still blocks', () => {
    // The other half of G9: skipping the subscript must reach the real key,
    // not wave the whole element through.
    assertBlocks(har({ body: JSON.stringify([{ price_note: CARD }]) }),
        defaultPolicy(), 'an undeclared key is an undeclared key wherever it sits');
});

test('G12 a top-level array element under `*text` is not rescued by the ENVELOPE name', () => {
    // The dangerous direction of the same shape: `*text` matches the envelope
    // node, and no amount of descending into a top-level array may make that
    // name reachable.
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);
    assertBlocks(har({ body: JSON.stringify([{ price_note: CARD }]) }), policy,
        'response.content.text is a HAR property however deep the walk goes');
});

test('G8 capturedFieldName refuses every envelope node it is handed', () => {
    const cases = [
        ['request.url', 'request.url', null],
        ['request.headers[0].value', 'request.headers[0].value', null],
        ['response.content.text', 'response.content.text', null],
        ['response.content.text[0]', 'response.content.text', null],
        ['response.content.text[0][3]', 'response.content.text', null],
        // A subscript IMMEDIATELY after the envelope node: a top-level array
        // of objects, which is what a list endpoint returns. The key follows
        // the subscript instead of preceding it, and it is still a key the
        // captured document chose.
        ['response.content.text[0].media_id', 'response.content.text', 'media_id'],
        ['response.content.text[2].a.b.value', 'response.content.text', 'value'],
        ['response.content.text[0].media_ids[4]', 'response.content.text', 'media_ids'],
        ['response.content.text[0][1].media_id', 'response.content.text', 'media_id'],
        // A sibling whose NAME merely starts with the base is still refused;
        // skipping subscripts must not open that door.
        ['response.content.textual.value', 'response.content.text', null],
        ['response.content.text.value', 'response.content.text', 'value'],
        ['response.content.text.a.b.value', 'response.content.text', 'value'],
        ['response.content.text.media_ids[4]', 'response.content.text', 'media_ids'],
        ['response.content.text.a[1].b', 'response.content.text', 'b'],
        ['request.headers[0].value.media_id', 'request.headers[0].value', 'media_id'],
        [null, 'response.content.text', null],
        ['somewhere.else', 'response.content.text', null],
    ];
    for (const entry of cases) {
        assert.strictEqual(shapes.capturedFieldName(entry[0], entry[1]), entry[2],
            'capturedFieldName(' + JSON.stringify(entry[0]) + ', ' + JSON.stringify(entry[1]) + ')');
    }
});

console.log('\nTHE PROPERTY -- over generated documents, not a case list.\n');

/**
 * A card-shaped IDENTITY value is suppressed IFF EVERY occurrence of it sits
 * at a CAPTURED field name the policy declares.
 *
 * The oracle is `harPolicy.isIdentifierField` applied to the key the captured
 * document actually carried -- and applied to nothing at all for a header, a
 * cookie, a query parameter, the URL or a top-level array element, because
 * those carry no captured key. A case list would be a claim about which
 * envelope properties matter, and the whole defect is that the next one was
 * never imagined.
 *
 * The generator is seeded with ADJACENT shapes rather than exotic ones:
 * `value`, `url`, `name` and `text` appear on both sides of the line, as body
 * keys a project declared and as properties HAR happens to use.
 */
/**
 * Does the BUILT document really carry this site?
 *
 * Asked of the document, never of the plan. A generator-coverage guard that
 * reads its own plan is the "boundary guard whose function never executed"
 * shape: the builder can silently drop a shape and the guard stays green.
 */
function holderIn(body, site) {
    let node = body;
    for (const key of site.chain) node = (node && node[key]) || {};
    return node;
}

function builtCarries(document, site) {
    const entry = document.log.entries[0];
    const body = JSON.parse(entry.response.content.text);
    const some = (list, fn) => (list || []).some(fn);
    switch (site.kind) {
        case 'body-key': return holderIn(body, site)[site.field] === CARD;
        case 'body-nested': return holderIn(body, site)[site.field] === CARD;
        case 'body-top-scalar': return Array.isArray(body) && body[site.index] === CARD;
        case 'body-array': {
            const held = holderIn(body, site)[site.field];
            return Array.isArray(held) && held.indexOf(CARD) >= 0;
        }
        case 'header': return some(entry.request.headers, (h) => h.value === CARD);
        case 'response-header': return some(entry.response.headers, (h) => h.value === CARD);
        case 'request-cookie':
            return some(entry.request.cookies, (c) => c.value === CARD && c.name === site.field);
        case 'response-cookie':
            return some(entry.response.cookies, (c) => c.value === CARD && c.name === site.field);
        case 'cookie-name': return some(entry.request.cookies, (c) => c.name === CARD);
        case 'query-value':
            return some(entry.request.queryString, (q) => q.value === CARD && q.name === site.field);
        case 'url': return entry.request.url.indexOf(CARD) >= 0;
        default: throw new Error('unreachable site kind in coverage: ' + site.kind);
    }
}

test('P1 suppressed iff every occurrence is at a declared CAPTURED field', () => {
    const policy = livePolicy(ENVELOPE_NAMES, ENVELOPE_EXPECT);

    let seed = 20250831;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    const pick = (list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

    const stems = ['media', 'order', 'account', 'primary'];
    const idTails = ['_id', '_ids', '_uuid', 'Id', '_value', 'Value', '_name', '_url', '_text'];
    const plainTails = ['_note', '_ref', '_label', '_code'];

    // Kinds whose site sits at a key the CAPTURED document chose. Everything
    // else -- envelope properties, and an array element, which has no key of
    // its own wherever the array sits -- carries no captured name.
    const BODY_KINDS = ['body-key', 'body-nested', 'body-array'];
    const KINDS = BODY_KINDS.concat(['body-top-scalar', 'header', 'response-header',
        'request-cookie', 'response-cookie', 'cookie-name', 'query-value', 'url']);

    const producedKinds = new Set();
    let mixedDocs = 0;
    let allDeclaredDocs = 0;

    for (let n = 0; n < 400; n++) {
        const siteCount = 1 + Math.floor(rand() * 3);
        const sites = [];
        for (let s = 0; s < siteCount; s++) {
            const declared = rand() < 0.5;
            sites.push({
                kind: pick(KINDS),
                field: pick(stems) + (declared ? pick(idTails) : pick(plainTails)),
            });
        }

        // THE ORACLE. Only a body key is a captured field name. Every other
        // kind carries none -- an envelope property because the captured
        // document contributed no key, a bare array element because an
        // element has no key of its own -- and a site with no name is never
        // declared. Note this is INDEPENDENT of the body root: a key inside an
        // element of a top-level array is still a key the document chose.
        const declaredHere = (site) => BODY_KINDS.indexOf(site.kind) >= 0
            && policyModule.isIdentifierField(policy, site.field);

        const parts = { requestHeaders: [], responseHeaders: [], requestCookies: [], queryString: [] };

        // THE BODY ROOT IS GENERATED, not fixed. A top-level ARRAY is what a
        // list endpoint returns and is one of the most ordinary response
        // shapes there is; a generator that always builds `{}` cannot express
        // it, and a shape a generator cannot express is a shape it can never
        // falsify. This half of the corpus is what catches an index sitting
        // IMMEDIATELY after the envelope node -- `response.content.text[0].id`
        // -- where the captured key follows the subscript instead of
        // preceding it.
        const arrayRooted = rand() < 0.4;
        const bodyRoot = arrayRooted ? [] : {};

        // Each body site gets its own container, so two sites in one document
        // cannot overwrite each other and quietly reduce the corpus to
        // single-site shapes. The chain is recorded -- keys and array indices
        // alike -- so the coverage guard can find the site in the BUILT
        // document.
        let bodySlots = 0;
        const container = (site) => {
            if (arrayRooted) {
                const index = bodyRoot.length;
                bodyRoot.push({});
                site.chain = [index];
                return bodyRoot[index];
            }
            if (bodySlots++ === 0) { site.chain = []; return bodyRoot; }
            const key = 'group' + bodySlots;
            bodyRoot[key] = bodyRoot[key] || {};
            site.chain = [key];
            return bodyRoot[key];
        };
        let anyBodySite = false;
        for (const site of sites) {
            switch (site.kind) {
                case 'body-key': {
                    anyBodySite = true;
                    container(site)[site.field] = CARD;
                    break;
                }
                case 'body-nested': {
                    anyBodySite = true;
                    const parent = container(site);
                    parent.deeper = parent.deeper || {};
                    parent.deeper[site.field] = CARD;
                    site.chain = site.chain.concat(['deeper']);
                    break;
                }
                case 'body-array': {
                    anyBodySite = true;
                    container(site)[site.field] = [CARD];
                    break;
                }
                case 'body-top-scalar': {
                    // A bare scalar element. Only a top-level array can hold
                    // one with no key above it; in an object-rooted document
                    // the nearest equivalent is an element of a named array,
                    // which IS held by that field, so this kind degrades to a
                    // header rather than pretending to be something it is not.
                    if (!arrayRooted) {
                        parts.requestHeaders.push({ name: 'x-echo', value: CARD });
                        site.kind = 'header';
                        break;
                    }
                    anyBodySite = true;
                    site.index = bodyRoot.length;
                    bodyRoot.push(CARD);
                    break;
                }
                case 'response-cookie':
                    parts.responseCookies = parts.responseCookies || [];
                    parts.responseCookies.push({ name: site.field, value: CARD });
                    break;
                case 'header':
                    parts.requestHeaders.push({ name: 'x-echo', value: CARD });
                    break;
                case 'response-header':
                    parts.responseHeaders.push({ name: 'x-echo', value: CARD });
                    break;
                case 'request-cookie':
                    parts.requestCookies.push({ name: site.field, value: CARD });
                    break;
                case 'cookie-name':
                    parts.requestCookies.push({ name: CARD, value: 'x' });
                    break;
                case 'query-value':
                    parts.queryString.push({ name: site.field, value: CARD });
                    break;
                case 'url':
                    parts.url = 'https://example.test/api/' + CARD + '/detail';
                    break;
                default: throw new Error('unreachable site kind');
            }
        }
        if (!anyBodySite) {
            if (arrayRooted) bodyRoot.push({ unrelated_note: CARD_B });
            else bodyRoot.unrelated_note = CARD_B;
        }
        parts.body = JSON.stringify(bodyRoot);

        // Coverage is read off the BUILT document rather than off the plan: a
        // builder that silently dropped a shape would otherwise leave the
        // coverage assertion green while no document ever carried it.
        const document = har(parts);
        for (const site of sites) {
            assert.ok(builtCarries(document, site),
                'document ' + n + ': the ' + site.kind + ' site was planned but never built');
            producedKinds.add(site.kind);
        }

        const expectSuppressed = sites.every(declaredHere);
        const seen = verdict(document, policy);
        assert.ok(seen.reported > 0, 'document ' + n + ': nothing reported, the property would be vacuous');
        assert.strictEqual(!seen.blocks, expectSuppressed,
            'document ' + n + ': expected suppressed=' + expectSuppressed
            + ', sites=' + JSON.stringify(sites));

        if (expectSuppressed) allDeclaredDocs++;
        else if (sites.some(declaredHere)) mixedDocs++;
    }

    // Neither half of the iff is vacuous, and the generator produced every
    // shape it claims to cover.
    assert.ok(allDeclaredDocs >= 20,
        'only ' + allDeclaredDocs + ' documents were fully declared; the suppression half is thin');
    assert.ok(mixedDocs >= 20,
        'only ' + mixedDocs + ' documents mixed a declared field with a non-captured site');
    for (const kind of KINDS) {
        assert.ok(producedKinds.has(kind), 'the generator never produced a ' + kind + ' site');
    }
});

console.log('');
if (failures > 0) {
    console.log(failures + ' of ' + checks + ' checks FAILED');
    process.exit(1);
}
console.log('All har-envelope-field-names tests passed (' + checks + ' checks)');
