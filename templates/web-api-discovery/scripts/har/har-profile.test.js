#!/usr/bin/env node
// Behavior tests for har-profile.js -- the single gitignored operator profile
// that carries the HMAC salt and the literal -> sentinel map for every HAR
// script (issue #255, Part B.2).
//
// Zero-dep, runs with `node har-profile.test.js`. Exits non-zero on first
// failure.
//
// The controlling rule: the literal map holds the operator's own account
// identifiers. It must never be defaulted and never committed, so an absent
// or malformed profile is a hard failure that names the file -- see the
// "Scrubbing is two controls, not one" guidance in
// `.github/skills/web-api-discovery/SKILL.md`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = require(path.join(__dirname, 'har-profile.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-profile-'));

function writeProfile(dir, content) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, profile.PROFILE_FILENAME);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return p;
}

function expectThrows(fn, matcher, label) {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    assert.ok(threw, `${label}: expected a throw, got none`);
    assert.ok(matcher.test(threw.message), `${label}: message did not match ${matcher}:\n${threw.message}`);
    return threw;
}

// --- 1. The canonical filename is the gitignored operator profile. ---
{
    assert.strictEqual(profile.PROFILE_FILENAME, '.har-profile.json',
        '1: profile filename is not the documented .har-profile.json');
}

// --- 2. A valid profile yields the salt and an ordered literal list. ---
{
    const dir = path.join(tmp, 'valid');
    writeProfile(dir, {
        salt: 'project-salt',
        literals: { '100000123456789': '<AccountId>', 'Ada Lovelace': '<DisplayName>' },
    });
    const p = profile.loadProfile({ startDir: dir });
    assert.strictEqual(p.salt, 'project-salt', '2.a: salt not read from profile');
    assert.deepStrictEqual(
        p.literals.map((l) => [l.literal, l.sentinel]),
        [['100000123456789', '<AccountId>'], ['Ada Lovelace', '<DisplayName>']],
        '2.b: literals not returned in declaration order');
    assert.strictEqual(p.path, path.join(dir, profile.PROFILE_FILENAME), '2.c: resolved path not reported');
}

// --- 3. Discovery walks upward from the working directory. ---
{
    const root = path.join(tmp, 'walk');
    writeProfile(root, { salt: 's', literals: { 'abcdefgh': '<Id>' } });
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    const p = profile.loadProfile({ startDir: deep });
    assert.strictEqual(p.path, path.join(root, profile.PROFILE_FILENAME),
        '3: discovery did not walk upward to the nearest profile');
}

// --- 4. An absent profile is a hard failure that names the file. ---
{
    const dir = path.join(tmp, 'absent-root');
    fs.mkdirSync(dir, { recursive: true });
    const e = expectThrows(() => profile.loadProfile({ startDir: dir, stopAt: dir }),
        /\.har-profile\.json/, '4.a');
    assert.ok(/gitignore/i.test(e.message), '4.b: failure does not say the profile must be gitignored');
}

// --- 5. There is no default salt and no default literal map. ---
{
    const src = fs.readFileSync(path.join(__dirname, 'har-profile.js'), 'utf8');
    assert.ok(!/DEFAULT_SALT|defaultSalt|default-salt/i.test(src),
        '5.a: har-profile.js appears to carry a default salt');
    assert.ok(!/DEFAULT_LITERALS|defaultLiterals/i.test(src),
        '5.b: har-profile.js appears to carry a default literal map');

    const dir = path.join(tmp, 'no-salt');
    writeProfile(dir, { literals: { abcdefgh: '<Id>' } });
    expectThrows(() => profile.loadProfile({ startDir: dir, stopAt: dir }), /salt/i, '5.c');

    const dir2 = path.join(tmp, 'no-literals');
    writeProfile(dir2, { salt: 's' });
    expectThrows(() => profile.loadProfile({ startDir: dir2, stopAt: dir2 }), /literals/i, '5.d');
}

// --- 6. An explicitly empty literal map is allowed -- silence is not. ---
{
    const dir = path.join(tmp, 'empty-literals');
    writeProfile(dir, { salt: 's', literals: {} });
    const p = profile.loadProfile({ startDir: dir, stopAt: dir });
    assert.deepStrictEqual(p.literals, [], '6: an explicit empty literal map should load');
}

// --- 7. Malformed entries are rejected loudly, not silently dropped. ---
{
    const shortDir = path.join(tmp, 'short-literal');
    writeProfile(shortDir, { salt: 's', literals: { '12': '<Id>' } });
    expectThrows(() => profile.loadProfile({ startDir: shortDir, stopAt: shortDir }),
        /too short/i, '7.a');

    const sentDir = path.join(tmp, 'bad-sentinel');
    writeProfile(sentDir, { salt: 's', literals: { abcdefgh: 'REDACTED' } });
    expectThrows(() => profile.loadProfile({ startDir: sentDir, stopAt: sentDir }),
        /sentinel/i, '7.b');

    const jsonDir = path.join(tmp, 'bad-json');
    writeProfile(jsonDir, '{ not json');
    expectThrows(() => profile.loadProfile({ startDir: jsonDir, stopAt: jsonDir }),
        /parse|json/i, '7.c');
}

// --- 8. Failure messages never echo a literal value. ---
{
    const dir = path.join(tmp, 'echo-check');
    writeProfile(dir, { salt: 's', literals: { 'supersecretaccountid': 'REDACTED' } });
    const e = expectThrows(() => profile.loadProfile({ startDir: dir, stopAt: dir }), /sentinel/i, '8.a');
    assert.ok(!e.message.includes('supersecretaccountid'),
        '8.b: failure message echoed the literal value -- that relocates the leak into CI logs');
}

// --- 9. An explicit --profile path overrides discovery. ---
{
    const dir = path.join(tmp, 'explicit');
    const p = writeProfile(dir, { salt: 'explicit-salt', literals: { abcdefgh: '<Id>' } });
    const loaded = profile.loadProfile({ profilePath: p, startDir: os.tmpdir() });
    assert.strictEqual(loaded.salt, 'explicit-salt', '9.a: explicit profile path ignored');

    expectThrows(() => profile.loadProfile({ profilePath: path.join(dir, 'nope.json') }),
        /nope\.json/, '9.b');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-profile tests passed');
