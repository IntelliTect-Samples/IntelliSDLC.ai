#!/usr/bin/env node
// End-to-end behavior tests for issue #346: a class set to `off` must govern
// the SCRUB, not only the gate -- and it must mean exactly what it already
// means on the gate.
//
// THE DEFECT. #297 requirement 1 is "consumers can override the scrub";
// requirement 2 accepts a stringent default GIVEN a working override path.
// `classes` was a working override for the gate only. `pii.js` never consulted
// it, so `detectPii` found a value and `scrubPii` replaced it whatever the
// project's policy said. Measured on a travel-domain corpus (three captures,
// counts published in #346): country 37,431, geo-coordinates 37,422,
// person-name 19,617, city 17,966, region 12,843 -- over 125,000 CORRECT
// detections replaced by fakes in captures where place names and coordinates
// ARE the payload the artifact exists to document.
//
// THE SEMANTIC. `off` means DETECT, REPORT, DO NOT ACT. That is not a new
// meaning invented here: it is what `off` already means in `har-shapes.js`,
// where `findLeaks` still returns a disabled finding carrying
// `setting: 'off'`, `gating: false`, and `blocksLeak` returns false. The
// scrubber now agrees with the gate rather than holding a second definition --
// the divergence that produced every other defect in this subsystem (the card
// predicate, the fake markers, `piiFields`, `cardIssuers`).
//
// THE FLOOR. A secret is removed unconditionally. The loader refuses a project
// file that lowers a secret class; the scrubber must not honour such a setting
// even if a policy object were constructed directly, bypassing the loader.
//
// WHY EVERY CASE RUNS THE REAL PATH. A predecessor test in this area asserted
// `typeof pii.fieldTypeFor === 'function'` with the message "a project cannot
// extend it". That tests the CAPABILITY, not the REACHABILITY, and an entirely
// inert feature satisfied it through five review rounds. So every policy case
// below writes a real `.har-policy.project.json`, runs `sanitize-har.js`, and
// asserts on the SCRUBBED FILE -- as a PAIR: the value IS replaced without the
// setting and IS NOT replaced with it.
//
// No captured value appears in this file. Every fixture value is invented.
//
// Zero-dep, runs with `node pii-class-scrub-override.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { initProtectedRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const pii = require(path.join(__dirname, 'pii.js'));
const harPolicy = require(path.join(__dirname, 'har-policy.js'));
const sanitize = path.join(__dirname, 'sanitize-har.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pii-class-scrub-')));

// Invented fixture values, chosen so a substring match is unambiguous.
const CITY = 'Zzyzxvale';
const COUNTRY_NAME = 'Qwertzland';
const PERSON = 'Vesper Quillon';
const REGION = 'Blorenshire';
// A JWT-shaped run: `eyJ` + three dot-separated segments of 8+ chars, which is
// the `jwt` secret pattern both `sanitize-har.js` and `har-shapes.js` carry.
// Payload decodes to `{"sub":"test"}`; signature is filler.
const JWT_SHAPED = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlZmlsbGVy';

// The #297 reference case, as a policy document: loosen to credentials,
// tokens, secrets and display name (including tags) only. Everything in the
// identity axis goes `off` EXCEPT `person-name`, which is the display name the
// downstream repo still wanted removed. The secret axis is untouched, and
// cannot be touched -- see case 5.
const IDENTITY_KINDS = Object.keys(harPolicy.loadDefaultPolicy().classes.identity);
const REFERENCE_CASE_POLICY = {
    schemaVersion: 1,
    classes: {
        identity: Object.fromEntries(
            IDENTITY_KINDS.filter((k) => k !== 'person-name').map((k) => [k, 'off'])),
    },
};

let failures = 0;
let passes = 0;
function check(label, fn) {
    try { fn(); passes++; } catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
}

// `spawnSync`, not `execFileSync`: the announcement this change adds goes to
// STDERR on a SUCCESSFUL run, and `execFileSync` hands back stdout only unless
// the child fails. Capturing stderr only on failure would have made case 6
// untestable in the one situation that matters.
function runSanitize(harPath, cwd) {
    const r = spawnSync(process.execPath, [sanitize, '--in', harPath], {
        encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject(name, projectPolicy) {
    const dir = path.join(tmp, name);
    initProtectedRepo(dir);
    fs.mkdirSync(path.join(dir, 'samples', 'har-original'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'),
        JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));
    if (projectPolicy) {
        fs.writeFileSync(path.join(dir, '.har-policy.project.json'),
            JSON.stringify(projectPolicy, null, 2));
    }
    return dir;
}

function harWithBody(body) {
    return {
        log: {
            version: '1.2', creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
                request: {
                    method: 'GET', url: 'https://example.invalid/api', httpVersion: 'HTTP/1.1',
                    headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
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

/**
 * Scrub a one-entry HAR whose JSON response body is `body`.
 * Returns the scrubbed text plus the run's own stderr, because "the run says
 * plainly that PII is being shipped" is part of what this change delivers.
 */
function scrub(name, projectPolicy, body) {
    const dir = makeProject(name, projectPolicy);
    const harPath = path.join(dir, 'samples', 'har-original', 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify(harWithBody(body), null, 2));
    const r = runSanitize(harPath, dir);
    assert.strictEqual(r.code, 0, `sanitize failed in ${name}: ${r.stderr}`);
    return {
        text: fs.readFileSync(path.join(dir, 'samples', 'har', 'capture.har'), 'utf8'),
        stderr: r.stderr,
        stdout: r.stdout,
    };
}

// ---------------------------------------------------------------------------
// 1. The pair that #346 measured. A class set to `off` stops the REPLACE.
// ---------------------------------------------------------------------------

const PLACES_BODY = { city: CITY, country: COUNTRY_NAME };

check('1.a default policy replaces city and country', () => {
    const { text } = scrub('places-default', null, PLACES_BODY);
    assert.ok(!text.includes(CITY), 'city should be replaced by the shipped default');
    assert.ok(!text.includes(COUNTRY_NAME), 'country should be replaced by the shipped default');
});

check('1.b classes.identity city/country = off leaves both values in place', () => {
    const { text } = scrub('places-off', {
        schemaVersion: 1,
        classes: { identity: { city: 'off', country: 'off' } },
    }, PLACES_BODY);
    assert.ok(text.includes(CITY), 'city must NOT be replaced when its class is off');
    assert.ok(text.includes(COUNTRY_NAME), 'country must NOT be replaced when its class is off');
});

// ---------------------------------------------------------------------------
// 2. A disabled type does not disable its siblings.
// ---------------------------------------------------------------------------

const SIBLING_BODY = { city: CITY, full_name: PERSON, region: REGION };

check('2.a with city off, a sibling identity type is still replaced', () => {
    const { text } = scrub('sibling-off', {
        schemaVersion: 1,
        classes: { identity: { city: 'off' } },
    }, SIBLING_BODY);
    assert.ok(text.includes(CITY), 'city is off, so it stays');
    assert.ok(!text.includes(PERSON), 'person-name is still on, so it must be replaced');
    assert.ok(!text.includes(REGION), 'region is still on, so it must be replaced');
});

check('2.b without the policy, all three are replaced', () => {
    const { text } = scrub('sibling-default', null, SIBLING_BODY);
    assert.ok(!text.includes(CITY));
    assert.ok(!text.includes(PERSON));
    assert.ok(!text.includes(REGION));
});

// ---------------------------------------------------------------------------
// 3. The same value under a disabled type AND an enabled one.
//
// The replacement set is keyed on the VALUE, not on the location, so a value
// that is replaceable anywhere is replaced everywhere. That is the safe
// direction and it is deliberate: the alternative -- rewriting one occurrence
// and leaving the identical string next to it -- would ship the value while
// reporting it as removed. A retained-count must not claim otherwise either.
// ---------------------------------------------------------------------------

check('3. a value that is also an enabled type is still replaced', () => {
    const { text } = scrub('overlap-off', {
        schemaVersion: 1,
        classes: { identity: { city: 'off' } },
    }, { city: CITY, full_name: CITY });
    assert.ok(!text.includes(CITY),
        'the value is detected as person-name too, which is enabled, so it must go');
});

check('3.b scrubPii does not count a replaced value as retained', () => {
    const har = harWithBody({ city: CITY, full_name: CITY });
    const policy = harPolicy.loadDefaultPolicy();
    const loosened = JSON.parse(JSON.stringify(policy));
    loosened.classes.identity.city = 'off';
    const result = pii.scrubPii(har, loosened);
    const city = result.retained.find((r) => r.kind === 'city');
    assert.ok(!city, 'the value was replaced via person-name, so nothing of it was retained');
});

// ---------------------------------------------------------------------------
// 4. THE FLOOR. A disabled identity type whose value also matches a SECRET
//    pattern. The secret must still be removed.
// ---------------------------------------------------------------------------

check('4.a a JWT sitting in a disabled city field is still removed', () => {
    const { text } = scrub('secret-in-off-field', {
        schemaVersion: 1,
        classes: { identity: { city: 'off' } },
    }, { city: JWT_SHAPED, town: CITY });
    assert.ok(!text.includes(JWT_SHAPED),
        'a secret is removed unconditionally; no identity setting may keep it');
    assert.ok(text.includes(CITY), 'the ordinary city value is still retained by the setting');
});

check('4.b the loader rejects a project file that lowers a secret class', () => {
    const dir = makeProject('secret-lowered', {
        schemaVersion: 1,
        classes: { secret: { jwt: 'off' } },
    });
    const harPath = path.join(dir, 'samples', 'har-original', 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify(harWithBody(PLACES_BODY), null, 2));
    const r = runSanitize(harPath, dir);
    assert.notStrictEqual(r.code, 0, 'lowering a secret class must be a load-time failure');
    assert.match(r.stderr, /secret class "jwt"/,
        'the failure must name the class the project tried to lower');
});

check('4.c a directly-constructed policy cannot switch a secret class off in the scrubber', () => {
    // The loader would refuse this document. Construct it anyway, bypassing the
    // loader entirely, and require the scrub side to hold the floor on its own:
    // a caller cannot forget a check it never makes, so the check lives here.
    for (const kind of Object.keys(harPolicy.loadDefaultPolicy().classes.secret)) {
        assert.strictEqual(
            pii.scrubSettingFor({ classes: { secret: { [kind]: 'off' } } }, kind), 'gate',
            `secret class ${kind} must resolve to gate on the scrub side`);
        assert.strictEqual(
            pii.scrubSettingFor({ classes: { identity: { [kind]: 'off' } } }, kind), 'gate',
            `secret class ${kind} must resolve to gate even if named on the identity axis`);
    }
});

check('4.d an identity setting is read from the identity axis only', () => {
    // `city` on the secret axis is not a thing the vocabulary allows, so a file
    // like this never loads. Constructed directly it must still not loosen:
    // the scrub setting for an identity type comes from `classes.identity`.
    assert.strictEqual(
        pii.scrubSettingFor({ classes: { secret: { city: 'off' } } }, 'city'), 'gate');
});

// ---------------------------------------------------------------------------
// 5. `off` means DETECT and REPORT, not "do not detect" -- the same meaning the
//    gate already gives it.
// ---------------------------------------------------------------------------

check('5.a detection still fires for a disabled class', () => {
    const policy = JSON.parse(JSON.stringify(harPolicy.loadDefaultPolicy()));
    policy.classes.identity.city = 'off';
    const found = pii.detectPii(harWithBody({ city: CITY }), policy);
    assert.ok(found.some((d) => d.type === 'city'),
        'a disabled class is detected; it has left the scrub, not the report');
});

check('5.b scrubPii reports what it retained, in the gate\'s vocabulary', () => {
    const policy = JSON.parse(JSON.stringify(harPolicy.loadDefaultPolicy()));
    policy.classes.identity.city = 'off';
    const result = pii.scrubPii(harWithBody({ city: CITY, town: CITY, locality: 'Grondwold' }), policy);
    const city = result.retained.find((r) => r.kind === 'city');
    assert.ok(city, 'a retained class must be reported');
    assert.strictEqual(city.class, 'identity');
    assert.strictEqual(city.setting, 'off');
    assert.strictEqual(city.occurrences, 3);
    assert.strictEqual(city.distinct, 2);
    const asJson = JSON.stringify(result.retained);
    assert.ok(!asJson.includes(CITY) && !asJson.includes('Grondwold'),
        'a report never carries the value');
});

check('5.c nothing is retained when no class is disabled', () => {
    const result = pii.scrubPii(harWithBody(PLACES_BODY), harPolicy.loadDefaultPolicy());
    assert.deepStrictEqual(result.retained, []);
});

check('5.d disabledIdentityClasses names exactly what the project turned off', () => {
    const policy = JSON.parse(JSON.stringify(harPolicy.loadDefaultPolicy()));
    policy.classes.identity.city = 'off';
    policy.classes.identity.country = 'off';
    assert.deepStrictEqual(pii.disabledIdentityClasses(policy), ['city', 'country']);
    assert.deepStrictEqual(pii.disabledIdentityClasses(harPolicy.loadDefaultPolicy()), []);
    assert.deepStrictEqual(pii.disabledIdentityClasses(null), []);
});

// ---------------------------------------------------------------------------
// 6. The run SAYS SO. `off` means real personal data ships in the artifact,
//    and that is a standing decision to publish -- not a line of advisory noise.
// ---------------------------------------------------------------------------

check('6.a the run announces the disabled classes and that values remain', () => {
    const { stderr } = scrub('announce-off', {
        schemaVersion: 1,
        classes: { identity: { city: 'off', country: 'off' } },
    }, PLACES_BODY);
    assert.match(stderr, /IDENTITY DATA IS BEING PUBLISHED/,
        'the loosening must be named as what it is');
    assert.match(stderr, /\bcity\b/);
    assert.match(stderr, /\bcountry\b/);
    assert.match(stderr, /NOT replaced/);
    assert.ok(!stderr.includes(CITY) && !stderr.includes(COUNTRY_NAME),
        'the announcement never echoes a value');
});

check('6.b a run with no disabled class says nothing of the kind', () => {
    const { stderr } = scrub('announce-default', null, PLACES_BODY);
    assert.ok(!/IDENTITY DATA IS BEING PUBLISHED/.test(stderr),
        'a report that fires when nothing was loosened is the noise this subsystem died of');
});

check('6.c the announcement fires even when the capture happens to carry none', () => {
    const { stderr } = scrub('announce-empty', {
        schemaVersion: 1,
        classes: { identity: { city: 'off' } },
    }, { sku: 'AB-1200' });
    assert.match(stderr, /IDENTITY DATA IS BEING PUBLISHED/,
        'the decision stands whether or not this capture exercised it');
});

// ---------------------------------------------------------------------------
// 7. THE WORKED OVERRIDE -- #297's own reference case, end to end.
//    Loosen to credentials, tokens, secrets and display name (including tags).
// ---------------------------------------------------------------------------

const REFERENCE_BODY = {
    city: CITY,
    country: COUNTRY_NAME,
    region: REGION,
    lat: 64.1466,
    lng: -21.9426,
    display_name: PERSON,
    session_token: JWT_SHAPED,
};

check('7.a without the override, every one of these is rewritten', () => {
    const { text } = scrub('reference-default', null, REFERENCE_BODY);
    for (const v of [CITY, COUNTRY_NAME, REGION, PERSON, JWT_SHAPED]) {
        assert.ok(!text.includes(v), `${v.slice(0, 4)}... should be replaced by default`);
    }
    assert.ok(!text.includes('64.1466') && !text.includes('-21.9426'),
        'coordinates should be replaced by default');
});

check('7.b with the override, place data survives, the person and the token do not', () => {
    const { text, stderr } = scrub('reference-override', REFERENCE_CASE_POLICY, REFERENCE_BODY);
    assert.ok(text.includes(CITY), 'city survives');
    assert.ok(text.includes(COUNTRY_NAME), 'country survives');
    assert.ok(text.includes(REGION), 'region survives');
    assert.ok(text.includes('64.1466') && text.includes('-21.9426'), 'coordinates survive');
    assert.ok(!text.includes(PERSON), 'display name is still removed -- the reference case keeps it on');
    assert.ok(!text.includes(JWT_SHAPED), 'the token is removed; secrets are not negotiable');
    assert.match(stderr, /IDENTITY DATA IS BEING PUBLISHED/,
        'and the run says so, every time');
});

if (failures > 0) {
    console.error(`${failures} pii-class-scrub-override case(s) failed`);
    process.exit(1);
}
console.log(`All pii-class-scrub-override tests passed (${passes}).`);
