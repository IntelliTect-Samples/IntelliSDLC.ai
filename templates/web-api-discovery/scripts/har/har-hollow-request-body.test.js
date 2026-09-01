#!/usr/bin/env node
// Behavior tests for gate 7 -- a request body PRESENT but replaced by a
// placeholder (issue #358).
//
// Zero-dep, runs with `node har-hollow-request-body.test.js`.
//
// The measured defect, from the issue: 4 entries across 3 committed reference
// files carried a 29-character placeholder where a form body used to be. Gate 1
// catches a body that was SHORTENED (a truncation marker); audit-scrub-drift
// reads `request.postData.text` only to scan for fake values, never to judge
// whether the body is still a body. The two checks bracket the case without
// covering it, so those files passed every gate and were catalogued as
// documenting request-side behaviour they contain none of.
//
// Everything here drives the real `verify-har-reference.js` over real files on
// disk, so a finding proves the shipped gate bites -- not that a helper
// function returns true.
//
// A NOTE ON HOW THIS SUITE COULD LIE, since the issue calls out the class: in
// the consuming project the equivalent guard degraded twice while being
// written, and both times a regex that failed to compile surfaced through the
// runner as a FAILING ASSERTION -- visually identical to the guard having found
// a real defect. Here the gate's patterns are regex LITERALS in
// verify-har-reference.js, so a pattern that cannot compile is a SyntaxError
// for the whole file: `node --check` fails, the script exits non-zero before
// reading anything, and test 1 below (a structured body must PASS, exit 0)
// fails in the opposite direction from a real finding. The wrapper runs
// `node --check` on both files for the same reason.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const verifyRef = path.join(__dirname, 'verify-har-reference.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-hollow-body-'));

// spawnSync, not execFileSync -- and NOT because the suite needs it today.
// Every finding this gate makes goes through `report()`, which pushes a
// violation and therefore forces a non-zero exit, so the one state
// execFileSync cannot see -- output on stderr alongside a SUCCESS exit --
// does not arise here. A reviewer checked exactly that, swapping a faithful
// execFileSync back in, and all assertions still passed.
//
// It stays because "a finding implies a non-zero exit" is a fact about this
// gate's current design and not about the script's interface: the first
// ADVISORY finding added to it (gate 5 already emits some) would make an
// execFileSync harness silently blind, and the test that noticed would be the
// one asserting a clean reference is clean. spawnSync reads both streams
// unconditionally and costs nothing.
function runNode(script, args, cwd) {
    const r = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function project(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'hollow-body-test-salt', literals: {},
    }, null, 2));
    return dir;
}

// A request entry. Bodies below are deliberately scrub-INERT -- no field name
// any PII dictionary claims, no value any shape detector matches -- so a
// finding in this suite can only have come from gate 7. A fixture two gates
// both touch cannot isolate either.
function entry(postData) {
    const request = {
        method: postData ? 'POST' : 'GET',
        url: 'https://example.invalid/api/thing',
        httpVersion: 'HTTP/1.1',
        headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
    };
    if (postData) request.postData = postData;
    return {
        startedDateTime: '2026-08-31T00:00:00.000Z', time: 1,
        request,
        response: {
            status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
            content: { size: 2, mimeType: 'application/json', text: '{}' },
            redirectURL: '', headersSize: -1, bodySize: 2,
        },
        cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    };
}

const body = (text, mimeType) => ({
    mimeType: mimeType || 'application/x-www-form-urlencoded', text,
});

// A multipart body, assembled rather than pasted, so the preamble and the
// leading-CRLF variants differ from the plain one in exactly one way each.
const multipartBody = ({ boundary = "b1", preamble = "", leadingCrlf = false } = {}) =>
    (leadingCrlf ? '\r\n' : '') + preamble
    + `--${boundary}\r\nContent-Disposition: form-data; name="alpha"\r\n\r\none\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="beta"\r\n\r\ntwo\r\n`
    + `--${boundary}--\r\n`;

function writeHar(dir, name, entries) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({
        log: { version: '1.2', creator: { name: 't', version: '1' }, entries },
    }, null, 2));
}

// Gate 7's findings, by entry index. Identified by the gate's own words, so a
// truncation finding on the same entry is not miscounted as this gate's.
const GATE7_FINDING = /entry (\d+): request body is present but carries NO payload structure/g;

function hollowIndexes(output) {
    const found = [];
    let m;
    GATE7_FINDING.lastIndex = 0;
    while ((m = GATE7_FINDING.exec(output)) !== null) found.push(Number(m[1]));
    return found.sort((a, b) => a - b);
}

function verify(dir) {
    const r = runNode(verifyRef, ['--dir', dir], dir);
    return { ...r, out: r.stdout + r.stderr };
}

// The shapes, and the verdict each must get.
//
// A case list covers the inputs somebody imagined; these are the shapes ONE
// STEP SIDEWAYS from the placeholder that prompted the gate, which is where
// the gaps in this subsystem have always been. Putting them in one HAR means
// the assertion is on the exact SET of entry indexes reported -- so a shape
// wrongly cleared and a shape wrongly reported both fail, and the entry index
// itself is under test rather than assumed.
//
// `[1,2]` earns its place: it contains none of `=`, `&`, `{`, `:` -- the four
// characters the issue text names -- so a gate built from that list alone would
// have called a JSON array a placeholder.
const SHAPES = [
    // --- structured: must PASS ---
    { label: 'json object', hollow: false, post: body('{"alpha":"one","beta":"two"}') },
    { label: 'empty json object', hollow: false, post: body('{}') },
    { label: 'empty json array', hollow: false, post: body('[]') },
    { label: 'json array of numbers', hollow: false, post: body('[1,2]') },
    { label: 'minimal form body', hollow: false, post: body('a=1') },
    { label: 'form body', hollow: false, post: body('alpha=one&beta=two') },
    // VERDICT CHANGED, deliberately. `alpha: one` is character-for-character
    // the same shape as `REDACTED: form body`, which must fail -- one word, a
    // colon, more words. Nothing structural tells them apart, so they cannot
    // get opposite verdicts, and `alpha: one` is not a member of any wire
    // grammar a capture carries. It goes on the reported side.
    { label: 'one word, a colon, more words', hollow: true, post: body('alpha: one') },
    { label: 'multipart, boundary declared in mimeType', hollow: false,
        post: body(multipartBody({ boundary: 'xYz123' }),
            'multipart/form-data; boundary=xYz123') },
    // A MIME preamble before the first delimiter is legal. A check keyed to
    // the first line is blind to the whole body, not just the preamble.
    { label: 'multipart with a preamble', hollow: false,
        post: body(multipartBody({ preamble: 'this preamble is legal and ignored\r\n' })) },
    { label: 'multipart with a leading CRLF', hollow: false,
        post: body(multipartBody({ leadingCrlf: true })) },
    // No mimeType at all: a hand-edited reference may have lost it, and the
    // body still declares its own delimiter.
    { label: 'multipart with no declared mimeType', hollow: false,
        post: { text: multipartBody({ boundary: 'noMime' }) } },
    // THE PRICE OF RECOGNISING XML, pinned rather than hidden. A placeholder
    // written as a well-formed element belongs to the markup grammar and is
    // cleared. No structural test separates it from a real one-element body,
    // because there is no structural difference -- the same trade
    // `body=redacted` makes against the form grammar. This fixture asserts the
    // CURRENT behaviour, so anyone who later tightens the recogniser finds out
    // here rather than in a consumer's capture.
    { label: 'placeholder written as a well-formed element', hollow: false,
        post: body('<REDACTED>body was removed</REDACTED>') },
    // The self-closing root, the other side of the same limit: not recognised,
    // so it IS reported.
    { label: 'self-closing root element', hollow: true, post: body('<redacted/>') },
    // X4 -- a document must START with its root. Without the `^` anchor an
    // element found ANYWHERE would clear the body, so a note that happens to
    // mention markup would pass. Found by mutation: nothing else in the suite
    // pinned the anchor.
    { label: 'prose that happens to contain an element', hollow: true,
        post: body('body removed, see <note>docs</note>') },
    // M6 -- recognised ONLY through the declared boundary. A legal MIME
    // epilogue after the closing delimiter defeats derivation from the body,
    // so a gate that ignored the mimeType would report this real body.
    { label: 'multipart with an epilogue, boundary only in mimeType', hollow: false,
        post: body(multipartBody({ boundary: 'epi7' }) + 'epilogue after the close\r\n',
            'multipart/form-data; boundary=epi7') },
    {
        label: 'multipart body', hollow: false,
        post: body('--b\r\nContent-Disposition: form-data; name="alpha"\r\n\r\none\r\n--b--'),
    },
    // A single form field with an EMPTY value. The `=` lands at the last
    // position, so a rule reading only INTERIOR punctuation calls this a
    // placeholder. It is a real minimal form body and the form grammar clears
    // it -- this is the false positive the review measured at entry 9.
    { label: 'form pair with an empty value', hollow: false, post: body('token=') },
    // A REAL bracketed field name. Without this the bracket rule could quietly
    // become a flat ban on brackets and every test would still pass.
    { label: 'form pair with a bracketed name', hollow: false, post: body('user[name]=x&user[id]=2') },
    // XML is a recognised grammar. It occurred ZERO times in 755 sampled
    // bodies, and that is a fact about the three JSON-era providers sampled
    // rather than about XML: this template ships to consumers nobody sampled,
    // and one wrapping a SOAP API would meet a gate firing on 100% of its
    // traffic. The root element must be CLOSED, which is the whole of the
    // test -- see the negatives below.
    { label: 'markup with a closing tag', hollow: false, post: body('<root><a>1</a></root>') },
    { label: 'xml with a declaration', hollow: false,
        post: body('<?xml version="1.0" encoding="utf-8"?><a>one</a>') },
    { label: 'namespaced soap envelope', hollow: false,
        post: body('<soap:Envelope xmlns:soap="http://example.invalid/e">'
            + '<soap:Body><op>one</op></soap:Body></soap:Envelope>') },
    // RAW GraphQL source stays on the reported side, and it looks like a
    // bigger gap than it is: GraphQL over HTTP is conventionally POSTed as
    // `{"query": "..."}`, which is composite JSON and already cleared by
    // recogniser 1. A raw body like this one needs `application/graphql`,
    // which is genuinely uncommon -- so this is a rare accepted residual, not
    // an oversight.
    { label: 'raw graphql source body', hollow: true, post: body('query { me { id } }') },
    { label: 'newline-delimited json', hollow: false, post: body('{"a":1}\n{"b":2}') },

    // --- not a body at all: must PASS ---
    { label: 'GET, no postData', hollow: false, post: null },
    { label: 'postData present, text empty', hollow: false, post: body('') },
    { label: 'postData present, text whitespace only', hollow: false, post: body('   ') },
    {
        label: 'postData present, no text key, params only', hollow: false,
        post: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'alpha', value: 'one' }] },
    },

    // --- hollow: must FAIL ---
    { label: 'the sentinel from the issue', hollow: true, post: body('REDACTED_FORM_URLENCODED_BODY') },
    { label: 'bare token', hollow: true, post: body('SCRUBBED') },
    { label: 'bare token with hyphens', hollow: true, post: body('redacted-request-body') },
    { label: 'bare token with underscores', hollow: true, post: body('redacted_request_body') },
    { label: 'bracket-wrapped token', hollow: true, post: body('[REDACTED]') },
    { label: 'angle-wrapped token', hollow: true, post: body('<redacted>') },
    { label: 'brace-wrapped token', hollow: true, post: body('{SCRUBBED}') },
    { label: 'asterisks', hollow: true, post: body('***') },
    { label: 'one json string literal', hollow: true, post: body('"REDACTED"') },
    { label: 'prose placeholder', hollow: true, post: body('body removed by operator') },
    // The four the review measured against the first predicate. Every one is
    // ONE STEP SIDEWAYS from a shape the first fixture list covered, and every
    // one is a MORE natural thing for a hand to write than the bare token:
    // a single colon, or a single apostrophe, defeated the gate.
    { label: 'wrapped token with an interior colon', hollow: true, post: body('[REDACTED: form body]') },
    { label: 'angle-wrapped token with a colon', hollow: true, post: body('<redacted:body>') },
    { label: 'prose with an apostrophe', hollow: true, post: body("it's been redacted for privacy") },
    { label: 'token then a dash then prose', hollow: true, post: body('REDACTED - see notes') },
    // The six the round-2 review measured. The first four each carry TWO
    // punctuation marks, which is exactly what a hand-written note reaches:
    // a colon introducing the reason, then a comma or semicolon inside it.
    // They are why counting marks was abandoned rather than retuned.
    { label: 'wrapped note, colon and comma', hollow: true, post: body('[REDACTED: form body, unused]') },
    { label: 'prose, apostrophe and comma', hollow: true, post: body("it's, redacted") },
    { label: 'note, colon and semicolon', hollow: true, post: body('redacted: value; omitted') },
    { label: 'note, colon and parentheses', hollow: true, post: body('body: (removed)') },
    // The other two cleared the FORM recogniser: `[redacted` really does
    // read as a field name until you ask whether its bracket ever closes.
    { label: 'bracket-wrapped pseudo-pair', hollow: true, post: body('[redacted=x]') },
    { label: 'angle-wrapped pseudo-pair', hollow: true, post: body('<redacted=x>') },
    // A bare `null` body. It is the reason the composite check needs no null
    // clause -- the leading-character gate excludes it -- and this fixture is
    // what makes that gate load-bearing rather than merely present, since
    // `typeof null === "object"` would otherwise clear it.
    { label: 'bare json null', hollow: true, post: body('null') },
    { label: 'bare json number', hollow: true, post: body('42') },
    // One lone real pair beside a placeholder is not a form body; 26 real
    // pairs beside one valueless flag IS one, and that case is generated in
    // property B1 rather than pinned here.
    { label: 'lone delimiter that nominates itself', hollow: true, post: body('--redacted--') },
    // --- the five mutants that SURVIVED the previous ablation matrix ---
    //
    // Each of these was added because a mutation of the shipped code changed
    // no verdict in the suite. A rule nothing pins is a rule that can be
    // deleted by accident, so the gap is the finding, not the mutation.
    //
    // F5 -- a name whose brackets do not balance is not the `user[name]=x`
    // shape, in either direction: one that opens and never closes, and one
    // that closes without opening.
    { label: 'form name with an unclosed bracket', hollow: true, post: body('user[name=x') },
    { label: 'form name with a stray closing bracket', hollow: true, post: body('redacted]=x') },
    // M4 -- delimiters but no closing delimiter at all. A multipart body that
    // stops mid-stream is not a multipart body.
    //
    // The mimeType MUST declare the boundary here, and that is the whole point
    // of the fixture. With no declared boundary the gate derives one FROM the
    // closing delimiter, so a body without one is rejected before the closing
    // check is ever consulted -- the first version of this fixture omitted the
    // mimeType and so exercised a branch it never entered, which is why
    // deleting the closing check changed nothing and that mutation SURVIVED.
    { label: 'multipart with no closing delimiter', hollow: true,
        post: body('--b9\r\nContent-Disposition: form-data; name="alpha"\r\n\r\none\r\n--b9\r\n',
            'multipart/form-data; boundary=b9') },
    // N3 -- two non-empty lines that are not JSON. Without this, NDJSON
    // degrades to "has more than one line", which every prose note satisfies.
    { label: 'two lines of prose', hollow: true, post: body('body removed\nsee notes') },
    // The two below exist because an ablation SURVIVED without them: the form
    // recogniser could be loosened in two ways and nothing failed. Both are
    // about how much a body has to look like a form before it counts as one.
    //
    // A form name never carries a raw space -- it percent-encodes it -- so the
    // space is what stops a hand-written note with an equals sign in it from
    // passing itself off as a field.
    { label: 'a note containing an equals sign', hollow: true, post: body('body = redacted') },
    // EVERY `&`-part must be a pair, not merely one of them: a single real
    // field does not make the rest of a half-scrubbed body into a payload.
    { label: 'one real field beside a bare token', hollow: true, post: body('REDACTED&token=') },
];

// --- 1. The classification, over adjacent shapes, in ONE file. ---
{
    const dir = project('shapes');
    writeHar(dir, 'reference.har', SHAPES.map((s) => entry(s.post)));
    const r = verify(dir);

    const expected = SHAPES.map((s, i) => (s.hollow ? i : -1)).filter((i) => i >= 0);
    const actual = hollowIndexes(r.out);

    const missed = expected.filter((i) => !actual.includes(i));
    const spurious = actual.filter((i) => !expected.includes(i));
    assert.deepStrictEqual(missed, [],
        `1.a: gate 7 cleared a body with no payload structure: ` +
        `${missed.map((i) => `entry ${i} (${SHAPES[i].label})`).join(', ')}`);
    assert.deepStrictEqual(spurious, [],
        `1.b: gate 7 reported a body that DOES carry payload structure: ` +
        `${spurious.map((i) => `entry ${i} (${SHAPES[i] ? SHAPES[i].label : '?'})`).join(', ')}`);
    assert.strictEqual(r.code, 3,
        `1.c: a reference carrying ${expected.length} placeholder bodies exited ${r.code}, not 3`);
}

// --- 2. A clean reference still passes. ---
// The direction that catches a gate which fires on everything -- and the one a
// pattern that cannot compile fails, since the script would exit non-zero
// before reading a file.
{
    const dir = project('clean');
    writeHar(dir, 'reference.har',
        SHAPES.filter((s) => !s.hollow).map((s) => entry(s.post)));
    const r = verify(dir);
    assert.strictEqual(r.code, 0,
        `2.a: a reference of structured and absent bodies did not pass (exit ${r.code}): ${r.out}`);
    assert.deepStrictEqual(hollowIndexes(r.out), [],
        `2.b: gate 7 reported a finding against a clean reference: ${r.out}`);
}

// --- 3. A planted violation names the REAL file and the REAL entry index. ---
// The issue asks for this explicitly: plant one and watch it name the file and
// the entry before trusting the gate green. Two files, so a gate that reported
// the first file it opened -- or reported a relative path from the wrong root
// -- fails here rather than passing on a one-file fixture.
{
    const dir = project('planted');
    writeHar(dir, 'aaa-innocent.har', [entry(body('alpha=one')), entry(body('{"beta":"two"}'))]);
    writeHar(dir, 'zzz-guilty.har', [
        entry(body('alpha=one')),
        entry(null),
        entry(body('REDACTED_FORM_URLENCODED_BODY')),
        entry(body('{"gamma":"three"}')),
    ]);
    const r = verify(dir);

    assert.strictEqual(r.code, 3, `3.a: the planted placeholder did not fail the run (exit ${r.code})`);
    assert.ok(/zzz-guilty\.har: entry 2: request body is present but carries NO payload structure/.test(r.out),
        `3.b: the finding did not name the guilty file AND entry 2 together: ${r.out}`);
    assert.ok(!/aaa-innocent\.har: entry \d+: request body is present but carries NO/.test(r.out),
        `3.c: the gate reported the innocent file as well: ${r.out}`);
    assert.strictEqual(hollowIndexes(r.out).length, 1,
        `3.d: one planted placeholder produced ${hollowIndexes(r.out).length} findings: ${r.out}`);
}

// --- 4. The message says REPLACED, and does not send the reader after a
// truncation marker that is not there. ---
{
    const dir = project('message');
    writeHar(dir, 'reference.har', [entry(body('REDACTED_FORM_URLENCODED_BODY'))]);
    const out = verify(dir).out;
    assert.ok(/REPLACEMENT/.test(out),
        `4.a: the finding never says the body was replaced: ${out}`);
    assert.ok(/not a truncation|no truncation marker/i.test(out),
        `4.b: the finding does not tell the reader there is no truncation marker to find: ${out}`);
    assert.ok(/re-extract/i.test(out),
        `4.c: the finding names no repair: ${out}`);
}

// --- 5. The finding quotes NOTHING of the body. ---
// The standing rule for this whole pipeline: a report that echoes what it found
// relocates the leak into the log that reports it. The tension is specific here
// -- the message must name a file and an entry index without naming the body --
// so the fixture uses a placeholder AND a distinctive token that would only
// appear in output if the body were echoed.
{
    const dir = project('no-echo');
    const secretish = 'ZZQUOTEDBODYTOKENZZ';
    writeHar(dir, 'reference.har', [entry(body(secretish))]);
    const out = verify(dir).out;
    assert.ok(/carries NO payload structure/.test(out), '5.a: the fixture did not trip gate 7 at all');
    assert.ok(!out.includes(secretish),
        '5.b: the finding echoed the body content it matched');
}

// --- 6. A truncated request body stays gate 1's, and is not double-reported. ---
// Gate 1 already owns the shortened body. If gate 7 also fired on it the
// operator would get two contradictory repairs for one entry, and the second
// one would be wrong.
{
    const dir = project('truncated');
    writeHar(dir, 'reference.har', [
        entry({ mimeType: 'application/json', text: '[request body truncated]', truncated: true }),
    ]);
    const r = verify(dir);
    assert.strictEqual(r.code, 3, '6.a: a truncated request body stopped failing the run');
    assert.ok(/entry 0: request body is marked truncated/.test(r.out),
        `6.b: gate 1 no longer reports the truncated request body: ${r.out}`);
    assert.deepStrictEqual(hollowIndexes(r.out), [],
        `6.c: gate 7 double-reported an entry gate 1 already reported as truncated: ${r.out}`);
}

// --- 6b. An INLINE truncation marker in a REQUEST body is gate 1's too. ---
//
// This body has no structural `truncated` flag -- the consumer-side exporter
// writes the marker into the payload instead -- and it also has no payload
// structure, so gate 7 would happily claim it. It must not: gate 7's message
// says "there is no truncation marker to go looking for", and here the marker
// is sitting in the body. That is not a mislabel, it is an affirmatively false
// statement that sends an operator away with confidence in the wrong direction.
// Gate 1 already owns this spelling on the RESPONSE side; the request side is
// the same defect and takes the same finding.
{
    const dir = project('inline-request-marker');
    writeHar(dir, 'reference.har', [
        entry({ mimeType: 'application/json', text: '[request body truncated]' }),
    ]);
    const r = verify(dir);
    assert.strictEqual(r.code, 3, '6b.a: an inline-truncated request body did not fail the run');
    assert.ok(/entry 0: request body carries an INLINE truncation marker/.test(r.out),
        `6b.b: gate 1 does not claim the inline marker on the request side: ${r.out}`);
    assert.deepStrictEqual(hollowIndexes(r.out), [],
        `6b.c: gate 7 claimed an inline-truncated body and told the reader there is no marker: ${r.out}`);
    assert.ok(!/no truncation marker to go looking for/.test(r.out),
        `6b.d: the run still tells the reader there is no marker while one is in the body: ${r.out}`);
}

// --- 7. The property, over a generator, in both directions. ---
//
// A case list covers what its author imagined; a generator covers shapes
// nobody sat down and listed. But A GENERATOR IS A PREDICATE TOO, and this one
// has twice been wrong in the same direction as the code it was meant to
// falsify. First it paired a clean token with a wrapper and never put
// punctuation inside the wrapped text, so it could not express
// `[REDACTED: form body]`. Then it injected AT MOST ONE mark, so it could not
// express `[REDACTED: form body, unused]` -- and a two-mark rule shipped. A
// shape a generator cannot express is a shape it cannot falsify.
//
// It now injects UP TO THREE marks, which is not a third guess at the right
// number: the predicate no longer counts punctuation at all, so no quantity of
// marks should change a verdict. That is the property.
//
//   A.  A bare token under any wrapper a redaction sentinel is conventionally
//       written with, carrying ANY number of punctuation marks, is reported.
//   B1. A well-formed form-urlencoded body is never reported -- including a
//       single pair, a pair with an empty value, and the measured real case of
//       one valueless flag segment among several real pairs.
//   B2. A JSON composite is never reported, down to `{}` and `[]`.
//   B3. A multipart body is never reported -- with and without a declared
//       boundary, with and without a preamble, with and without a leading
//       CRLF. This is the false-positive guard most likely to break.
//   B4. An NDJSON body is never reported.
//
// B1-B4 are claims about real wire formats rather than restatements of the
// predicate: each names a grammar the sampled captures actually contained,
// and together they are 100% of 755 real request bodies.
//
// `=` is deliberately NOT among the marks injected in A. A token carrying an
// `=` may legitimately BE a form pair, so generating one under property A
// would assert a falsehood.
//
// Deterministic PRNG so a failure is reproducible rather than a rumour.
{
    let seed = 358;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = (xs) => xs[Math.floor(rnd() * xs.length) % xs.length];

    const WORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.';
    const TOKEN_CHARS = WORD_CHARS + ' *';
    const draw = (alphabet, max) => {
        const n = 1 + Math.floor(rnd() * max);
        let s = '';
        for (let i = 0; i < n; i++) s += pick(alphabet.split(''));
        return s;
    };
    // A leading or trailing space would be trimmed away; keep the token the
    // thing under test rather than the trimmer.
    const token = () => draw(TOKEN_CHARS, 30).trim() || 'REDACTED';
    const word = () => draw(WORD_CHARS, 12);

    const WRAPPERS = [['', ''], ['[', ']'], ['<', '>'], ['{', '}'], ['(', ')'], ['"', '"'],
        ["'", "'"], ['*', '*'], ['**', '**'], ['--', '--']];
    const MARKS = [':', ';', ',', "'", '"', '<', '>', '(', ')', '{', '}', '[', ']', '&', '/', '|', '!', '?'];

    const hollowCases = [];
    for (let i = 0; i < 90; i++) {
        const [open, close] = pick(WRAPPERS);
        let inner = token();
        const marks = Math.floor(rnd() * 4);
        for (let m = 0; m < marks; m++) inner += pick(MARKS) + token();
        hollowCases.push(open + inner + close);
    }

    const dirA = project('property-hollow');
    writeHar(dirA, 'reference.har', hollowCases.map((t) => entry(body(t))));
    const gotA = hollowIndexes(verify(dirA).out);
    const missedA = hollowCases.map((_, i) => i).filter((i) => !gotA.includes(i));
    assert.deepStrictEqual(missedA, [],
        `7.a: a wrapped bare token went unreported at ${missedA.length} of ${hollowCases.length} `
        + 'generated shapes -- the gate is keyed to a spelling, or punctuation still buys a pass');

    // B1 -- form-urlencoded, the grammar `a=1` and `token=` both belong to.
    const formPosts = [];
    for (let i = 0; i < 40; i++) {
        const pairs = 1 + Math.floor(rnd() * 3);
        const parts = [];
        // Every third pair carries an empty value: `token=` is a real minimal
        // body and the gate must not call it a placeholder.
        for (let p = 0; p < pairs; p++) parts.push(word() + '=' + (p % 3 === 2 ? '' : word()));
        formPosts.push(body(parts.join('&')));
    }
    // The measured real case: one valueless flag segment among real pairs. 7 of
    // 755 sampled bodies look like this, so requiring EVERY part to be a pair
    // would report them.
    for (let i = 0; i < 10; i++) {
        const parts = [word() + '=' + word(), word(), word() + '=' + word(), word() + '=' + word()];
        formPosts.push(body(parts.join('&')));
    }

    // B2 -- JSON composites, including the two empty ones.
    const jsonPosts = [body('{}'), body('[]')];
    for (let i = 0; i < 38; i++) {
        const value = rnd() < 0.5
            ? Object.fromEntries(Array.from({ length: 1 + Math.floor(rnd() * 3) },
                () => [word(), word()]))
            : Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => word());
        jsonPosts.push(body(JSON.stringify(value)));
    }

    // B3 -- multipart, across the four axes that break a first-line check.
    const multipartPosts = [];
    for (let i = 0; i < 32; i++) {
        const boundary = word() + word();
        const text = multipartBody({
            boundary,
            preamble: rnd() < 0.5 ? '' : `${token()}\r\n`,
            leadingCrlf: rnd() < 0.5,
        });
        multipartPosts.push(rnd() < 0.5
            ? body(text, `multipart/form-data; boundary=${boundary}`)
            : body(text));
    }

    // B4 -- NDJSON. 13 of the 14 sampled declared `text/plain`, so the
    // recogniser must not consult the mimeType; half of these declare it and
    // half do not.
    const ndjsonPosts = [];
    for (let i = 0; i < 20; i++) {
        const lines = 2 + Math.floor(rnd() * 4);
        const text = Array.from({ length: lines },
            () => JSON.stringify({ [word()]: word() })).join('\n');
        ndjsonPosts.push(rnd() < 0.5 ? body(text, 'text/plain') : body(text));
    }

    // B5 -- XML documents: with and without a declaration, with and without a
    // namespace prefix, with and without attributes. Never gated on the
    // mimeType, for the reason NDJSON already established.
    const xmlPosts = [];
    for (let i = 0; i < 24; i++) {
        const prefix = rnd() < 0.5 ? '' : `${draw('abcdefghijklmnopqrstuvwxyz', 5)}:`;
        const tag = prefix + draw('abcdefghijklmnopqrstuvwxyz', 8);
        const attr = rnd() < 0.5 ? ` id="${word()}"` : '';
        const decl = rnd() < 0.5 ? '<?xml version="1.0"?>' : '';
        const text = `${decl}<${tag}${attr}><item>${word()}</item></${tag}>`;
        xmlPosts.push(rnd() < 0.5 ? body(text, 'application/xml') : body(text));
    }

    for (const [label, posts, why] of [
        ['7.b', formPosts, 'well-formed form-urlencoded bodies -- it swallows real minimal payloads'],
        ['7.c', jsonPosts, 'JSON composites -- it swallows the commonest request body there is'],
        ['7.d', multipartPosts, 'multipart bodies -- 10.9% of real traffic, and the delimiter is not always on line one'],
        ['7.e', ndjsonPosts, 'NDJSON bodies -- and most of them do not declare a JSON mimeType'],
        ['7.f', xmlPosts, 'XML documents -- a consumer wrapping a SOAP API would meet a gate firing on all of its traffic'],
    ]) {
        const dir = project(`property-${label.replace('.', '-')}`);
        writeHar(dir, 'reference.har', posts.map((post) => entry(post)));
        const got = hollowIndexes(verify(dir).out);
        assert.deepStrictEqual(got, [],
            `${label}: the gate reported ${got.length} of ${posts.length} ${why}`);
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-hollow-request-body tests passed');
