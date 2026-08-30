#!/usr/bin/env node
// Behavior tests for response-body truncation (issue #297, Stage 8).
//
// Zero-dep, runs with `node har-truncation.test.js`.
//
// The measured defect, from the issue: `capResponses` truncated response bodies
// to 65536 bytes BY DEFAULT, and that silently removed a minified JS asset
// carrying the only documentation of how photo upload works. The file's own
// header argues against exactly this for request bodies and then does it to
// responses.
//
// Requirement 7 says scrub by SENSITIVITY, not by size. A response body is not
// dangerous because it is large -- asset and JS bodies carry the protocol
// constants a reference exists to preserve.
//
// The audit half matters as much as the cap. Measured on the consuming repo's
// committed references: a structured scan for `content.truncated` returned ZERO
// across all 12, while a scan for the consumer tool's INLINE marker found 27
// truncated entries across 6 files. The structured marker was a false negative
// because the other tool never wrote one -- and the inline marker cut bodies
// mid-string, so the payload was no longer valid JSON.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const extract = path.join(__dirname, 'extract-har-reference.js');
const verifyRef = path.join(__dirname, 'verify-har-reference.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-truncation-'));

function runNode(script, args, cwd) {
    try {
        const out = execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
}

// A body big enough to trip the old 65536 default, shaped like the thing the
// issue says was lost: a minified asset carrying protocol constants.
// Deliberately scrub-INERT: no field name any PII dictionary claims and no
// value any shape detector matches. The first draft used `name`, which Stage 6
// correctly scrubs as a person name -- so the body changed length and the test
// could not tell truncation from scrubbing. A fixture that two features both
// touch cannot isolate either.
const BIG_BODY = JSON.stringify({
    variants: Array.from({ length: 4000 }, (_, i) => ({
        variantKey: `variant_${i}`, w: 100 + i, h: 200 + i, q: 85,
    })),
});

function project(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'truncation-test-salt', literals: {},
    }, null, 2));
    return dir;
}

function harWith(bodyText) {
    return {
        log: {
            version: '1.2', creator: { name: 't', version: '1' },
            entries: [{
                startedDateTime: '2026-08-30T00:00:00.000Z', time: 1,
                request: {
                    method: 'GET', url: 'https://example.invalid/assets/app.js', httpVersion: 'HTTP/1.1',
                    headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                    content: { size: bodyText.length, mimeType: 'application/json', text: bodyText },
                    redirectURL: '', headersSize: -1, bodySize: bodyText.length,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    };
}

function extractTo(dir, args) {
    const input = path.join(dir, 'capture.har');
    fs.writeFileSync(input, JSON.stringify(harWith(BIG_BODY)));
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const r = runNode(extract, ['--in', input, '--match', 'assets/app',
        '--provider', 'example', '--action', 'asset-fetch',
        '--out', path.join(outDir, 'reference.har'), ...(args || [])], dir);
    return { r, outDir };
}

function soleReference(outDir) {
    const found = fs.readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.har'));
    assert.strictEqual(found.length, 1, `expected one reference, got ${found.length}: ${found.join(', ')}`);
    return JSON.parse(fs.readFileSync(path.join(outDir, found[0]), 'utf8'));
}

// --- 1. With no flag, nothing is truncated. ---
// This is the behaviour change requirement 7 asks for. A 64 KB default meant
// the tool silently discarded the largest bodies, which are exactly the asset
// and JS payloads that document a protocol.
{
    const dir = project('default-no-cap');
    const { r, outDir } = extractTo(dir);
    assert.strictEqual(r.code, 0, `1.a: extraction failed: ${r.stderr}`);

    const ref = soleReference(outDir);
    const content = ref.log.entries[0].response.content;
    assert.ok(!content.truncated,
        '1.b: a response body was truncated with no --max-response-bytes given');
    assert.strictEqual(content.text.length, BIG_BODY.length,
        `1.c: the body was shortened from ${BIG_BODY.length} to ${content.text.length} with no cap asked for`);
    // The structural check is the one that matters: every entry survived, not
    // merely that the byte count happens to match.
    assert.strictEqual(JSON.parse(content.text).variants.length, 4000,
        '1.d: entries were dropped from the untruncated body');
}

// --- 2. With the flag, the cut is recorded structurally. ---
{
    const dir = project('explicit-cap');
    const { r, outDir } = extractTo(dir, ['--max-response-bytes', '4096']);
    assert.strictEqual(r.code, 0, `2.a: extraction failed: ${r.stderr}`);

    const content = soleReference(outDir).log.entries[0].response.content;
    assert.ok(content.truncated, '2.b: an explicitly capped body carries no truncation marker');
    assert.strictEqual(content.truncated.keptBytes, 4096, '2.c');
    assert.strictEqual(content.truncated.originalBytes, BIG_BODY.length, '2.d');
    assert.strictEqual(content.text.length, 4096, '2.e: the body was not cut to the requested size');
}

// --- 3. The marker is STRUCTURAL. Nothing is written into the payload. ---
// The consumer-side tool appended `...[response body truncated for reference
// use]` INSIDE the body text. That does two bad things at once: it corrupts
// the payload's own format -- `JSON.parse` then fails with "Unterminated
// string" -- and it evades a structured audit, which is why a scan for
// `content.truncated` found zero while the inline marker found 27.
{
    const dir = project('no-inline-marker');
    const { outDir } = extractTo(dir, ['--max-response-bytes', '4096']);
    const content = soleReference(outDir).log.entries[0].response.content;

    assert.ok(!/truncated for reference use/i.test(content.text),
        '3.a: an inline truncation marker was written into the payload');
    assert.ok(!/\[\s*truncated/i.test(content.text), '3.b: some other inline marker was written');
    assert.strictEqual(content.text, BIG_BODY.slice(0, 4096),
        '3.c: the kept bytes are not a verbatim prefix of the original -- something was inserted');
}

// --- 4. The reference gate fails a truncated RESPONSE, not just a request. ---
// The gate already refused a truncated request body, on exactly the right
// reasoning. The same rule applied to responses would have caught all 27
// truncated entries in the consuming repo at commit time.
{
    const dir = project('gate-response');
    const ref = harWith(BIG_BODY);
    ref.log.entries[0].response.content.text = BIG_BODY.slice(0, 4096);
    ref.log.entries[0].response.content.truncated = { originalBytes: BIG_BODY.length, keptBytes: 4096 };
    fs.writeFileSync(path.join(dir, 'reference.har'), JSON.stringify(ref));

    const r = runNode(verifyRef, ['--dir', dir], dir);
    assert.strictEqual(r.code, 3,
        `4.a: a reference with a truncated RESPONSE body was accepted: ${r.stdout}${r.stderr}`);
    const out = r.stdout + r.stderr;
    assert.ok(/truncat/i.test(out), `4.b: the violation did not name truncation: ${out}`);
    assert.ok(/response/i.test(out), `4.c: the violation did not say which half was truncated: ${out}`);
}

// --- 5. An untruncated reference still passes. ---
{
    const dir = project('gate-clean');
    fs.writeFileSync(path.join(dir, 'reference.har'), JSON.stringify(harWith('{"ok":true}')));
    const r = runNode(verifyRef, ['--dir', dir], dir);
    assert.strictEqual(r.code, 0, `5.a: a clean reference was rejected: ${r.stdout}${r.stderr}`);
}

// --- 6. The gate also catches the INLINE marker the other tool writes. ---
// A structured scan alone is a false negative for any reference produced by
// `Export-HarReference.ps1`, which is where all 27 real cases came from. Until
// both tools emit the same structured marker, the gate has to recognise the
// other spelling -- otherwise "zero truncated references" keeps meaning "zero
// that this tool truncated".
{
    const dir = project('gate-inline');
    const ref = harWith(BIG_BODY);
    ref.log.entries[0].response.content.text =
        BIG_BODY.slice(0, 4000) + '...[response body truncated for reference use]';
    fs.writeFileSync(path.join(dir, 'reference.har'), JSON.stringify(ref));

    const r = runNode(verifyRef, ['--dir', dir], dir);
    assert.strictEqual(r.code, 3,
        `6.a: a reference carrying the inline marker was accepted: ${r.stdout}${r.stderr}`);
    assert.ok(/truncat/i.test(r.stdout + r.stderr), '6.b: the violation did not name truncation');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-truncation tests passed');
