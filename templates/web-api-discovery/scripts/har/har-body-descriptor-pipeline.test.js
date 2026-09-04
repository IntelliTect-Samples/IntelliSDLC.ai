#!/usr/bin/env node
// End-to-end: an unretained-request-body descriptor (#442) through the REAL
// `sanitize-har.js` and the REAL gate, over a planted `raw.har`.
//
// Zero-dep, runs with `node har-body-descriptor-pipeline.test.js`.
//
// The browser leg is not exercisable here -- Playwright is not a dependency of
// this repository and no Chrome is launched in CI -- so this exercises the
// ASSEMBLY path over a planted fixture, the way #377's lane does. What is
// pinned is the part of the pipeline that does not need a browser and is where
// the hazard lives: does a value that arrives ONLY through the descriptor get
// scrubbed, and does the gate see it?
//
// SYNTHETIC values throughout. Nothing here was ever anybody's file.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));
const { DESCRIPTOR_KEY: KEY } = require(path.join(__dirname, '..', 'capture', 'request-body-descriptor.js'));

const sanitize = path.join(__dirname, 'sanitize-har.js');
const verify = path.join(__dirname, 'verify-scrub.js');
const tmp = makeTempRepo('har-442-pipeline-');

// A token-shaped filename: what the scrub's own patterns fire on, placed where
// ONLY the descriptor carries it.
const TOKEN_FILENAME = 'deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef.jpg';
const EMAIL_FILENAME = 'syntheticperson@example.invalid.png';

function runNode(script, args) {
    try {
        return { code: 0, stdout: execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8', cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'],
        }), stderr: '' };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
}

function plantedRaw() {
    const upload = {
        startedDateTime: '2026-09-04T09:27:59.000Z',
        time: 12,
        request: {
            method: 'POST',
            url: 'https://i.instagram.invalid/rupload_igphoto/1234',
            httpVersion: 'HTTP/1.1',
            headers: [
                { name: 'content-length', value: '203573' },
                { name: 'content-type', value: 'multipart/form-data; boundary=B7' },
            ],
            queryString: [],
            cookies: [],
            headersSize: 120,
            bodySize: -1,
            [KEY]: {
                bodyRetained: false,
                declaredLength: 203573,
                retainedLength: 0,
                mimeType: 'multipart/form-data; boundary=B7',
                parts: [
                    { order: 0, fieldName: 'caption', filename: null, contentType: null, length: 17, complete: true },
                    { order: 1, fieldName: 'upload_file', filename: TOKEN_FILENAME, contentType: 'image/jpeg', length: 203100, complete: true },
                    { order: 2, fieldName: 'thumb', filename: EMAIL_FILENAME, contentType: 'image/png', length: 4210, complete: true },
                ],
            },
        },
        response: {
            status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
            headers: [], cookies: [], content: { size: 2, mimeType: 'application/json', text: '{}' },
            redirectURL: '', headersSize: 40, bodySize: 2,
        },
        cache: {}, timings: { send: 1, wait: 10, receive: 1 },
    };
    // A genuinely bodyless GET, present so the pipeline is asked about both.
    const get = {
        startedDateTime: '2026-09-04T09:28:00.000Z', time: 3,
        request: {
            method: 'GET', url: 'https://i.instagram.invalid/feed', httpVersion: 'HTTP/1.1',
            headers: [], queryString: [], cookies: [], headersSize: 30, bodySize: 0,
        },
        response: {
            status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
            content: { size: 2, mimeType: 'application/json', text: '{}' }, redirectURL: '',
            headersSize: 40, bodySize: 2,
        },
        cache: {}, timings: { send: 1, wait: 1, receive: 1 },
    };
    return { log: { version: '1.2', creator: { name: 'capture-har.js', version: '2.0' }, pages: [], entries: [upload, get] } };
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

fs.writeFileSync(path.join(tmp, '.har-profile.json'),
    JSON.stringify({ salt: 'synthetic-442-salt', literals: {} }, null, 2), 'utf8');
const rawPath = path.join(tmp, 'raw.har');
fs.writeFileSync(rawPath, JSON.stringify(plantedRaw(), null, 2), 'utf8');
const outPath = path.join(tmp, 'scrubbed.har');
const scrub = runNode(sanitize, ['--in', rawPath, '--out', outPath, '--profile', path.join(tmp, '.har-profile.json')]);

test('the scrub runs to completion over a HAR carrying a descriptor', () => {
    assert.strictEqual(scrub.code, 0, `sanitize-har failed:\n${scrub.stderr}`);
    assert.ok(fs.existsSync(outPath));
});

test('FALSIFIER: a token-shaped filename reaching the pipeline ONLY through the descriptor is scrubbed', () => {
    const text = fs.readFileSync(outPath, 'utf8');
    assert.ok(!text.includes(TOKEN_FILENAME),
        'the descriptor is a channel that bypasses the scrub');
    assert.ok(!text.includes('syntheticperson@example.invalid'),
        'an email survived inside the descriptor');
});

test('GUARD: the scrubbed file still says the body was not retained, and how long it was', () => {
    const har = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const d = har.log.entries[0].request[KEY];
    assert.strictEqual(d.bodyRetained, false);
    assert.strictEqual(d.declaredLength, 203573);
    assert.strictEqual(har.log.entries[0].request.bodySize, -1);
    assert.deepStrictEqual(d.parts.map((p) => [p.order, p.fieldName, p.length]),
        [[0, 'caption', 17], [1, 'upload_file', 203100], [2, 'thumb', 4210]]);
});

test('GUARD: the bodyless GET still reports having no body at all', () => {
    const har = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(har.log.entries[1].request.bodySize, 0);
    assert.strictEqual(har.log.entries[1].request[KEY], undefined);
});

test('FALSIFIER: the gate reports a leak that sits only inside the descriptor', () => {
    // Verify a HAR whose descriptor still carries the token -- the gate must
    // not report it clean.
    const dirty = path.join(tmp, 'dirty.har');
    fs.writeFileSync(dirty, JSON.stringify(plantedRaw(), null, 2), 'utf8');
    const gate = runNode(verify, ['--in', dirty]);
    const said = gate.stdout + gate.stderr;
    assert.ok(said.includes(KEY),
        `the gate never named the descriptor node; it reported:\n${said.slice(0, 1200)}`);
    // Locations, never values -- the gate must not have printed the filename.
    assert.ok(!said.includes(TOKEN_FILENAME), 'the gate printed a captured value');
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
console.log(`${tests.length - failed}/${tests.length} passed`);
if (!failed) console.log('All har-body-descriptor-pipeline tests passed');
process.exit(failed ? 1 : 0);
