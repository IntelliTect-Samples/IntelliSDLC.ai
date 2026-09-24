#!/usr/bin/env node
// End-to-end behavior test for issue #511 -- the real scrub command, then the
// real gate command, over a capture the scrub alone cannot clean.
//
// Zero-dep, runs with `node sanitize-har-blunt.test.js`.
//
// The unit tests in har-blunt.test.js pin what blunting does to a document.
// This pins the CONTRACT the pipeline relies on:
//
//  1. A capture that used to be refused (gate exit 3) now comes out: the scrub
//     writes it, the UNCHANGED gate passes it, and nothing it would have
//     blocked survives in the file.
//  2. The scrub says so on one stable stdout line, `sanitize-har: blunted:`,
//     which the store batch reads -- and says nothing of the kind on a clean
//     capture.
//  3. The console output never carries the value.
//
// The fixture needs a value the scrub has no rule for AT THAT POSITION but the
// gate still blocks. A 32-hex module hash in a script-loader array is the
// real-world case that refused three captures in one store (all values here
// are synthetic).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const harBlunt = require(path.join(__dirname, 'har-blunt.js'));
const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const SANITIZE = path.join(__dirname, 'sanitize-har.js');
const VERIFY = path.join(__dirname, 'verify-scrub.js');
const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const tmp = makeTempRepo('sanitize-har-blunt-');

function run(script, args) {
    try {
        const stdout = execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
}

function capture(name, body) {
    const dir = path.join(tmp, '.har-captures', 'example.test', name);
    fs.mkdirSync(dir, { recursive: true });
    const profile = path.join(dir, '.har-profile.json');
    fs.writeFileSync(profile, JSON.stringify({ salt: 'e2e-test-salt', literals: {} }));
    const raw = path.join(dir, 'raw.har');
    fs.writeFileSync(raw, JSON.stringify({
        log: {
            version: '1.2', creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
                request: {
                    method: 'GET', url: 'https://example.test/ajax/bootloader', httpVersion: 'HTTP/1.1',
                    headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                    content: { size: body.length, mimeType: 'application/json', text: body },
                    redirectURL: '', headersSize: -1, bodySize: body.length,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    }));
    return { dir, raw, profile, out: path.join(dir, 'scrubbed.har') };
}

let passed = 0;

// 1 + 3. The capture that used to be refused.
{
    const c = capture('refused', `for (;;);{"jsmods":{"require":[["m\\u002F${HEX32}","m",[]]]},"n":1}`);
    const scrub = run(SANITIZE, ['--in', c.raw, '--out', c.out, '--profile', c.profile]);
    assert.strictEqual(scrub.code, 0, `scrub failed: ${scrub.stderr}`);

    const written = fs.readFileSync(c.out, 'utf8');
    assert.ok(!written.includes(HEX32), 'the value the gate blocks is not in the written file');
    assert.match(scrub.stdout, /^sanitize-har: blunted: 1 value\(s\), 32 byte\(s\)$/m);
    assert.ok(!scrub.stdout.includes(HEX32) && !scrub.stderr.includes(HEX32), 'no value on the console');

    const doc = JSON.parse(written);
    assert.strictEqual(doc.log[harBlunt.RECORD_KEY].values, 1);

    const gate = run(VERIFY, ['--in', c.out, '--profile', c.profile]);
    assert.strictEqual(gate.code, 0, `the unchanged gate must pass the blunted artifact: ${gate.stderr}`);
    passed++;
}

// 2. A clean capture says nothing about blunting and carries no record.
{
    const c = capture('clean', '{"ok":true,"n":1}');
    const scrub = run(SANITIZE, ['--in', c.raw, '--out', c.out, '--profile', c.profile]);
    assert.strictEqual(scrub.code, 0, scrub.stderr);
    assert.ok(!/blunted/i.test(scrub.stdout + scrub.stderr));
    assert.strictEqual(JSON.parse(fs.readFileSync(c.out, 'utf8')).log[harBlunt.RECORD_KEY], undefined);
    passed++;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`All sanitize-har-blunt tests passed (${passed})`);
