#!/usr/bin/env node
/**
 * pii.js -- shared typed-PII detection + deterministic faker for the
 * web-api-discovery scrub pipeline (issue #46).
 *
 * Exports:
 *   detectPii(har)              -> [{ type, value, location }]
 *   fakeFor(type, original)     -> string (deterministic, obviously-fake)
 *   scrubPii(har)               -> { substitutions: [...] }  (mutates har)
 *   PII_TYPES                   -> array of supported type strings
 *
 * Determinism: seed = SHA-256(original).hexSlice(0, 16). Same input always
 * yields same fake. No external dependencies; pure Node stdlib.
 *
 * Substitutions returned by scrubPii contain only { type, originalHash,
 * replacement, locations }. The originalHash is the first 8 hex chars of
 * the SHA-256 -- never the plaintext original -- so the resulting
 * .substitutions.json file is safe to commit.
 */

'use strict';

const crypto = require('crypto');

const PII_TYPES = [
    'email', 'phone', 'person-name', 'street-address',
    'city', 'region', 'postal-code', 'country',
    'dob', 'ssn', 'credit-card', 'ip-address', 'geo-coordinates'
];

// --- minimal embedded word lists (no external dependencies) ---
const FIRST_NAMES = [
    'Avery','Blair','Casey','Dakota','Emery','Finley','Gray','Hayden','Ira','Jules',
    'Kai','Lane','Morgan','Nico','Oakley','Parker','Quinn','Reese','Sage','Tatum',
    'Umi','Vesper','Wren','Xen','Yarrow','Zion','Ash','Briar','Cleo','Darcy',
    'Elliot','Frey','Gale','Harper','Indigo','Jess','Kit','Lior','Marin','Niles',
    'Olin','Pax','Rio','Sasha','Tyne','Uriah','Vance','Wynn','Yale','Zephyr'
];
const SURNAMES = [
    'Archer','Brooks','Carter','Doyle','Ellis','Fisher','Grant','Hayes','Irving','Jensen',
    'Kerr','Lowell','Mercer','Nash','Oates','Pratt','Quincy','Reeves','Stone','Tate',
    'Underwood','Vega','Walsh','Xiong','York','Zimmer','Abram','Blake','Crane','Dean',
    'Emerson','Frost','Gibson','Hale','Inman','Jordan','Knox','Lyle','Monroe','Noble',
    'Orton','Paige','Quill','Rhodes','Sterling','Thorne','Underhill','Vail','Wilde','Yates'
];
const STREETS = [
    'Birch','Cedar','Dogwood','Elm','Forest','Garnet','Hawthorn','Ivy','Juniper','Kestrel',
    'Larch','Maple','Nutmeg','Oak','Poplar','Quince','Rowan','Sycamore','Tamarack','Umbra',
    'Vine','Willow','Yarrow','Zephyr','Acacia','Beech','Cypress','Dunwood','Elderberry','Fern',
    'Greenway','Hollow','Iron','Jasper','Knoll','Linden','Mulberry','Northgate','Olive','Pinecrest',
    'Quail','Redwood','Spruce','Thistle','Upland','Violet','Wisteria','Yew','Zinnia','Aspen'
];
const CITIES = [
    'Aldenbrook','Bramblefield','Cinderwood','Dunmoor','Everwillow','Fallowcrest','Glenhaven','Hartshollow','Inglevale','Junipercove',
    'Kettlebrook','Larchmount','Mistford','Northwillow','Oakhurst','Pinecliff','Quietford','Ravenstead','Stonebriar','Thornehaven',
    'Underglen','Vesperton','Wickburn','Yarrowfield','Zephyrport','Ashendell','Briarholt','Cresthollow','Drystwood','Elderfen'
];
const REGIONS = ['ZZ','XA','XB','XC','XD','XE','XF','XG','XH','XI'];

// --- field-name dictionaries (case-insensitive match on JSON key tail) ---
const FIELD = {
    'person-name':    new Set(['name','firstname','lastname','fullname','displayname','givenname','familyname','surname']),
    'street-address': new Set(['address','street','addressline1','addressline2','streetaddress','streetname']),
    'city':           new Set(['city','town','locality']),
    'region':         new Set(['region','state','province','administrativearea']),
    'postal-code':    new Set(['postalcode','postal','zip','zipcode','postcode']),
    'country':        new Set(['country','countrycode']),
    'dob':            new Set(['dob','dateofbirth','birthdate','birthday']),
    'geo-lat':        new Set(['lat','latitude','geolat']),
    'geo-lng':        new Set(['lng','longitude','geolng','lon','long'])
};

function fieldType(key) {
    if (typeof key !== 'string') return null;
    const k = key.toLowerCase();
    for (const t of Object.keys(FIELD)) {
        if (FIELD[t].has(k)) return t;
    }
    return null;
}

// --- regex detectors (context-free) ---
// Email is already handled by sanitize-har.js's legacy pattern, but we also
// detect it here so detectPii() reports it for the substitutions store.
const RE = {
    // RFC 5321 caps the local part at 64 characters and the domain at 255.
    // The bounds are not pedantry: an unbounded `[chars]+@` backtracks
    // quadratically over a long run that never reaches an `@`, and capture
    // bodies are routinely hundreds of KB.
    email:        /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g,
    phone:        /\+\d{10,15}\b/g,
    ssn:          /\b\d{3}-\d{2}-\d{4}\b/g,
    creditDigits: /\b\d{13,19}\b/g,
    ipv4:         /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
    ipv6:         /\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b/g,
    isoDate:      /^\d{4}-\d{2}-\d{2}$/
};

function luhnOk(s) {
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
        let d = s.charCodeAt(i) - 48;
        if (d < 0 || d > 9) return false;
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d; alt = !alt;
    }
    return sum % 10 === 0;
}

function hashOf(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function hashPrefix(s) { return hashOf(s).slice(0, 8); }
function seed(s) { return hashOf(s); }
function intFromHex(hex, start, len) {
    return parseInt(hex.slice(start, start + len), 16);
}

// --- deterministic faker ---
function fakeFor(type, original) {
    const h = seed(String(original));
    switch (type) {
        case 'email':
            return `user-${h.slice(0, 8)}@example.invalid`;
        case 'phone': {
            const tail = (intFromHex(h, 0, 8) % 10000000).toString().padStart(7, '0');
            return `+1555${tail}`;
        }
        case 'ssn': {
            const a = 900 + (intFromHex(h, 0, 4) % 100);   // 900-999
            const b = (intFromHex(h, 4, 4) % 100).toString().padStart(2, '0');
            const c = (intFromHex(h, 8, 4) % 10000).toString().padStart(4, '0');
            return `${a}-${b}-${c}`;
        }
        case 'credit-card': {
            // Build 15-digit body then compute Luhn check digit -> 16 total.
            let body = '4242';
            for (let i = 0; i < 11; i++) {
                body += ((intFromHex(h, i * 2, 2)) % 10).toString();
            }
            // Compute Luhn check digit for body + '0', then derive correct check.
            let sum = 0, alt = true;
            for (let i = body.length - 1; i >= 0; i--) {
                let d = body.charCodeAt(i) - 48;
                if (alt) { d *= 2; if (d > 9) d -= 9; }
                sum += d; alt = !alt;
            }
            const check = (10 - (sum % 10)) % 10;
            return body + String(check);
        }
        case 'person-name': {
            const f = FIRST_NAMES[intFromHex(h, 0, 4) % FIRST_NAMES.length];
            const l = SURNAMES[intFromHex(h, 4, 4) % SURNAMES.length];
            return `${f} ${l}`;
        }
        case 'street-address': {
            const num = 100 + (intFromHex(h, 0, 4) % 9900);
            const street = STREETS[intFromHex(h, 4, 4) % STREETS.length];
            return `${num} ${street} St`;
        }
        case 'city':
            return CITIES[intFromHex(h, 0, 4) % CITIES.length];
        case 'region':
            return REGIONS[intFromHex(h, 0, 4) % REGIONS.length];
        case 'postal-code':
            return (90000 + (intFromHex(h, 0, 4) % 10000)).toString();
        case 'country':
            return 'ZZ';
        case 'dob': {
            const year = 1950 + (intFromHex(h, 0, 4) % 50);
            const month = 1 + (intFromHex(h, 4, 4) % 12);
            const day = 1 + (intFromHex(h, 8, 4) % 28);
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
        case 'ip-address': {
            // 192.0.2.0/24 is RFC 5737 TEST-NET-1, never routable.
            return `192.0.2.${intFromHex(h, 0, 2) % 254 + 1}`;
        }
        case 'geo-coordinates':
            return 0;
        default:
            return `<REDACTED-${h.slice(0, 8)}>`;
    }
}

// --- detection ---
function pushDetection(out, type, value, location) {
    out.push({ type, value, location });
}

function detectInString(str, entryIndex, loc, out) {
    if (typeof str !== 'string' || str.length === 0) return;
    // emails
    (str.match(RE.email) || []).forEach(m => {
        // skip already-fake markers
        if (/@example\.invalid$/i.test(m)) return;
        pushDetection(out, 'email', m, { entryIndex, ...loc });
    });
    // phones
    (str.match(RE.phone) || []).forEach(m => {
        if (/^\+1555\d{7}$/.test(m)) return;
        pushDetection(out, 'phone', m, { entryIndex, ...loc });
    });
    // ssn
    (str.match(RE.ssn) || []).forEach(m => {
        if (/^9\d{2}-/.test(m)) return;
        pushDetection(out, 'ssn', m, { entryIndex, ...loc });
    });
    // credit card (Luhn)
    (str.match(RE.creditDigits) || []).forEach(m => {
        if (!luhnOk(m)) return;
        pushDetection(out, 'credit-card', m, { entryIndex, ...loc });
    });
    // ipv4
    (str.match(RE.ipv4) || []).forEach(m => {
        if (/^192\.0\.2\./.test(m)) return; // fake range
        pushDetection(out, 'ip-address', m, { entryIndex, ...loc });
    });
    // ipv6
    (str.match(RE.ipv6) || []).forEach(m => {
        pushDetection(out, 'ip-address', m, { entryIndex, ...loc });
    });
}

function detectInValue(value, key, entryIndex, loc, out) {
    const fType = fieldType(key);
    // Context-driven detections (run first; do not also report as raw email/etc.)
    if (fType && typeof value === 'string' && value.length > 0) {
        if (fType === 'person-name') {
            pushDetection(out, 'person-name', value, { entryIndex, ...loc });
            return true;
        }
        if (fType === 'street-address') {
            pushDetection(out, 'street-address', value, { entryIndex, ...loc });
            return true;
        }
        if (fType === 'city')        { pushDetection(out, 'city',        value, { entryIndex, ...loc }); return true; }
        if (fType === 'region')      { pushDetection(out, 'region',      value, { entryIndex, ...loc }); return true; }
        if (fType === 'postal-code') { pushDetection(out, 'postal-code', value, { entryIndex, ...loc }); return true; }
        if (fType === 'country')     { pushDetection(out, 'country',     value, { entryIndex, ...loc }); return true; }
        if (fType === 'dob' && RE.isoDate.test(value)) {
            pushDetection(out, 'dob', value, { entryIndex, ...loc });
            return true;
        }
    }
    if ((fType === 'geo-lat' || fType === 'geo-lng') && typeof value === 'number') {
        const ok = fType === 'geo-lat' ? (value >= -90 && value <= 90)
                                        : (value >= -180 && value <= 180);
        if (ok && value !== 0) {
            pushDetection(out, 'geo-coordinates', value, { entryIndex, ...loc, axis: fType === 'geo-lat' ? 'lat' : 'lng' });
            return true;
        }
    }
    return false;
}

function walkJsonForDetect(node, key, entryIndex, jsonPath, out) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
        const handled = detectInValue(node, key, entryIndex, { jsonPath }, out);
        if (!handled) detectInString(node, entryIndex, { jsonPath }, out);
        return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
        detectInValue(node, key, entryIndex, { jsonPath }, out);
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((v, i) => walkJsonForDetect(v, key, entryIndex, `${jsonPath}[${i}]`, out));
        return;
    }
    if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
            walkJsonForDetect(node[k], k, entryIndex, jsonPath ? `${jsonPath}.${k}` : k, out);
        }
    }
}

function detectPii(har) {
    const out = [];
    const entries = (har && har.log && har.log.entries) || [];
    entries.forEach((entry, entryIndex) => {
        // headers
        const allHeaders = [
            ...((entry.request && entry.request.headers) || []).map(h => ({ ...h, _ctx: 'request' })),
            ...((entry.response && entry.response.headers) || []).map(h => ({ ...h, _ctx: 'response' }))
        ];
        for (const h of allHeaders) {
            if (!h || typeof h.value !== 'string') continue;
            detectInString(h.value, entryIndex, { headerName: h.name, headerCtx: h._ctx }, out);
        }
        // query string
        const qs = (entry.request && entry.request.queryString) || [];
        for (const q of qs) {
            if (!q || typeof q.value !== 'string') continue;
            detectInString(q.value, entryIndex, { queryParam: q.name }, out);
        }
        // request URL
        if (entry.request && typeof entry.request.url === 'string') {
            detectInString(entry.request.url, entryIndex, { jsonPath: 'request.url' }, out);
        }
        // request body
        if (entry.request && entry.request.postData && typeof entry.request.postData.text === 'string') {
            tryWalkJsonText(entry.request.postData.text, entryIndex, 'request.postData', out);
        }
        // response body
        if (entry.response && entry.response.content && typeof entry.response.content.text === 'string') {
            tryWalkJsonText(entry.response.content.text, entryIndex, 'response.content', out);
        }
    });
    return out;
}

function tryWalkJsonText(text, entryIndex, basePath, out) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (parsed !== null && typeof parsed === 'object') {
        walkJsonForDetect(parsed, null, entryIndex, basePath, out);
    } else {
        detectInString(text, entryIndex, { jsonPath: basePath }, out);
    }
}

// --- scrubbing: apply faker substitutions in-place on the HAR ---
function scrubPii(har) {
    const detections = detectPii(har);
    if (detections.length === 0) return { substitutions: [] };

    // Group by (type, original value) so we record one substitution per unique original.
    const byKey = new Map();
    for (const d of detections) {
        const key = `${d.type}\u0001${d.value}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                type: d.type,
                value: d.value,
                replacement: fakeFor(d.type, d.value),
                originalHash: hashPrefix(d.value),
                locations: []
            });
        }
        // Sanitize location: never include the raw value.
        byKey.get(key).locations.push(d.location);
    }

    // Build replacement set sorted longest-first to avoid partial-overlap issues
    // (e.g. "Alice Marie Johnson" before "Alice").
    const replacements = Array.from(byKey.values()).sort((a, b) => {
        return String(b.value).length - String(a.value).length;
    });

    const entries = (har && har.log && har.log.entries) || [];
    for (const entry of entries) {
        applyReplacementsToEntry(entry, replacements);
    }

    // Strip raw values out of the returned substitutions (safe-store schema).
    const safe = replacements.map(r => ({
        type: r.type,
        originalHash: r.originalHash,
        replacement: r.replacement,
        locations: r.locations
    }));
    safe.sort((a, b) => {
        if (a.type !== b.type) return a.type < b.type ? -1 : 1;
        return a.originalHash < b.originalHash ? -1 : 1;
    });
    return { substitutions: safe };
}

function applyReplacementsToEntry(entry, replacements) {
    // headers
    for (const ctx of ['request', 'response']) {
        const hs = entry[ctx] && entry[ctx].headers;
        if (Array.isArray(hs)) {
            for (const h of hs) {
                if (typeof h.value === 'string') h.value = replaceAll(h.value, replacements);
            }
        }
    }
    // query string
    const qs = entry.request && entry.request.queryString;
    if (Array.isArray(qs)) {
        for (const q of qs) {
            if (typeof q.value === 'string') q.value = replaceAll(q.value, replacements);
        }
    }
    // url
    if (entry.request && typeof entry.request.url === 'string') {
        entry.request.url = replaceAll(entry.request.url, replacements);
    }
    // bodies (request/response)
    if (entry.request && entry.request.postData && typeof entry.request.postData.text === 'string') {
        entry.request.postData.text = replaceJsonOrText(entry.request.postData.text, replacements);
    }
    if (entry.response && entry.response.content && typeof entry.response.content.text === 'string') {
        entry.response.content.text = replaceJsonOrText(entry.response.content.text, replacements);
    }
}

function replaceJsonOrText(text, replacements) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (parsed !== null && typeof parsed === 'object') {
        const rebuilt = replaceInJson(parsed, null, replacements);
        return JSON.stringify(rebuilt);
    }
    return replaceAll(text, replacements);
}

function replaceInJson(node, parentKey, replacements) {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') {
        // Honor field-typed replacements: if the parent key declares a context
        // type, swap the entire value out for the matching fake.
        const fType = fieldType(parentKey);
        if (fType && fType !== 'geo-lat' && fType !== 'geo-lng') {
            // Find a matching replacement by exact original value, since detection
            // already enrolled this exact string.
            const target = indexFor(replacements).byTypeValue.get(`${pickContextType(fType)}${node}`);
            if (target) return target.replacement;
        }
        return replaceAll(node, replacements);
    }
    if (typeof node === 'number') {
        const fType = fieldType(parentKey);
        if (fType === 'geo-lat' || fType === 'geo-lng') {
            return 0;
        }
        return node;
    }
    if (Array.isArray(node)) {
        return node.map(v => replaceInJson(v, parentKey, replacements));
    }
    if (typeof node === 'object') {
        const out = {};
        for (const k of Object.keys(node)) {
            out[k] = replaceInJson(node[k], k, replacements);
        }
        return out;
    }
    return node;
}

function pickContextType(fType) {
    // map fieldType labels to detection types
    if (fType === 'geo-lat' || fType === 'geo-lng') return 'geo-coordinates';
    return fType; // 'person-name', 'street-address', 'city', 'region', 'postal-code', 'country', 'dob'
}

// --- single-pass replacement index (issue #326) -------------------------
//
// The replacement pass used to loop the whole replacement list for EVERY
// string it touched, building an escaped pattern and a fresh RegExp each time
// and scanning the string once per value. Distinct detected values grow with
// body size, so the two factors multiplied and the pass went quadratic: on a
// real capture a single 6.3 MB JSON list response took over 45 s while the
// other 314 entries together took ~10 s, and a 27.8 MB capture did not finish
// in 420 s. A profile put ~67% of self time in `replaceAll` and a further ~21%
// in `escapeRe` -- the escape ran once per (value, string) pair.
//
// The values are literals, not patterns, so a literal matcher does the whole
// job in ONE walk of each string regardless of how many values there are. The
// index below is a trie over every needle, built once per replacement list and
// memoised on that list, so the per-string cost is O(string) instead of
// O(string x values).
//
// PRIORITY IS INSERTION ORDER, and reproducing it exactly is the whole
// difficulty. `scrubPii` sorts the replacement list longest value first, and
// the sequential loop turned that into a guarantee: a longer value was
// replaced EVERYWHERE before a shorter one was even considered.
//
// Preferring the earliest-enrolled needle among those starting at the current
// character is NOT that guarantee, and the difference leaks PII. Two values can
// overlap in two ways:
//
//   NESTED      "Alice Marie Johnson" and "Alice" share a start position. A
//               left-to-right scanner picks the longer one there and is right.
//   STAGGERED   "Ann Marie" and "Marie Louise Johnson" inside
//               "contacted Ann Marie Louise Johnson yesterday" share characters
//               at DIFFERENT start positions, and the SHORTER one starts first.
//               A left-to-right scanner matches "Ann Marie", consumes the
//               "Marie" the longer value needed, and never scans its tail --
//               so "Louise Johnson", real detected PII, ships in the clear and
//               the substitutions table records a fake that is nowhere in the
//               body.
//
// So arbitration cannot be per start position. This collects EVERY match in one
// walk, then resolves them in priority order: each match claims its span unless
// a higher-priority match already holds part of it. A longer value therefore
// wins wherever it occurs no matter what starts earlier, which is exactly what
// the priority-ordered global replace did.
//
// What is deliberately NOT reproduced is that loop scanning its own output.
// Because each pass ran over text already carrying earlier fakes, a value
// occurring inside an emitted fake overwrote part of it, leaving a string that
// was neither an original nor the recorded replacement. Resolving against the
// ORIGINAL text drops that, which is the one intended behaviour change here.

// The trie is keyed by UTF-16 code UNIT, matching `` and keeping surrogate
// pairs consistent with the rest of the file. Codes rather than one-character
// strings: `text[i]` allocates a string per character, and this walks every
// character of every body.
function isWordCode(code) {
    // NaN (index past either end of the string) fails every comparison, which
    // is what `` wants at a boundary of the text.
    return (code >= 48 && code <= 57)
        || (code >= 97 && code <= 122)
        || (code >= 65 && code <= 90)
        || code === 95;
}

function newNode() {
    return { next: new Map(), hit: null };
}

function addNeedle(root, needle, replacement, boundary, priority) {
    if (!needle) return;
    let node = root;
    for (let k = 0; k < needle.length; k++) {
        const ch = needle.charCodeAt(k);
        let child = node.next.get(ch);
        if (!child) { child = newNode(); node.next.set(ch, child); }
        node = child;
    }
    // First enrolment wins: the same literal can be detected under two types,
    // and the sequential loop applied whichever came first in the list.
    if (node.hit === null) {
        node.hit = { length: needle.length, replacement, boundary, priority };
    }
}

// Keyed on the replacement list itself, which holds because `scrubPii` finishes
// building that array before any replacing starts and never touches it again.
// That is a convention, not something the type enforces: anyone who later
// appends to a live replacement list must invalidate this entry, or the new
// values will silently go unscrubbed.
const INDEX_CACHE = new WeakMap();

function indexFor(replacements) {
    let idx = INDEX_CACHE.get(replacements);
    if (idx) return idx;

    const root = newNode();
    const byTypeValue = new Map();
    let priority = 0;

    for (const r of replacements) {
        const v = String(r.value);
        const typeKey = `${r.type}${v}`;
        if (!byTypeValue.has(typeKey)) byTypeValue.set(typeKey, r);
        if (v.length === 0) continue;

        // Context-typed values (person-name etc.) may have very short literals
        // (e.g. "Alice") that risk false-positive matches inside unrelated
        // text, so a purely alphabetic value only matches on word boundaries.
        const boundary = /^[A-Za-z]+( [A-Za-z]+)*$/.test(v);
        addNeedle(root, v, r.replacement, boundary, priority++);

        // The same value can appear percent-encoded in the very same entry:
        // detection reads the decoded `queryString` pair, while the `url`
        // carries `phone=%2B1...`. Replacing only the raw spelling leaves the
        // encoded copy readable -- one value, several spellings, which is the
        // failure literal-value scrubbing exists to close (see har-literals.js).
        const encoded = encodeURIComponent(v);
        if (encoded !== v) {
            addNeedle(root, encoded, encodeURIComponent(r.replacement), false, priority++);
        }
    }

    // Direct dispatch for the ASCII first character, so the overwhelmingly
    // common case -- a character that begins no needle at all -- costs an array
    // index rather than a Map lookup.
    const rootAscii = new Array(128);
    for (const [code, node] of root.next) {
        if (code < 128) rootAscii[code] = node;
    }

    idx = { root, rootAscii, byTypeValue, empty: root.next.size === 0 };
    INDEX_CACHE.set(replacements, idx);
    return idx;
}

// One walk of the text, recording EVERY needle that matches anywhere -- nested
// and overlapping matches included. Arbitration happens afterwards, because a
// match cannot be judged against a competitor that has not been found yet.
//
// Matches are held as two parallel arrays rather than objects. This runs over
// every character of every body, and a per-match object is an allocation the
// garbage collector then has to chase; the `hit` records already live in the
// trie, so a reference plus a start offset is the whole match.
function collectMatches(text, idx, outStarts, outHits) {
    const root = idx.root;
    const rootAscii = idx.rootAscii;
    const n = text.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
        const code = text.charCodeAt(i);
        let node = code < 128 ? rootAscii[code] : root.next.get(code);
        if (node === undefined) continue;
        let j = i;
        for (;;) {
            const hit = node.hit;
            if (hit !== null
                && (!hit.boundary
                    || (!isWordCode(text.charCodeAt(i - 1))
                        && !isWordCode(text.charCodeAt(i + hit.length))))) {
                outStarts[count] = i;
                outHits[count] = hit;
                count++;
            }
            j++;
            if (j >= n) break;
            const child = node.next.get(text.charCodeAt(j));
            if (child === undefined) break;
            node = child;
        }
    }
    return count;
}

// Scratch buffers reused across calls. `replaceAll` runs once per string leaf
// and never re-enters itself, so a single set is safe, and reusing them keeps
// a body of many small leaves from allocating two typed arrays per leaf.
let CLAIMED = new Uint8Array(0);
let ACCEPTED = new Uint8Array(0);

function scratch(buf, need) {
    if (buf.length < need) return new Uint8Array(need < 1024 ? 1024 : need * 2);
    buf.fill(0, 0, need);
    return buf;
}

function replaceAll(text, replacements) {
    const idx = indexFor(replacements);
    if (idx.empty || text.length === 0) return text;

    const starts = [];
    const hits = [];
    const count = collectMatches(text, idx, starts, hits);
    if (count === 0) return text;

    // Resolve highest priority first; ties (the same needle occurring more than
    // once) left to right, the order the global replace visited them in. The
    // order array is sorted, not the match arrays, so the matches stay in
    // ascending start order for the emit pass below and need no second sort.
    const order = new Array(count);
    for (let k = 0; k < count; k++) order[k] = k;
    order.sort((a, b) => (hits[a].priority - hits[b].priority) || (starts[a] - starts[b]));

    CLAIMED = scratch(CLAIMED, text.length);
    ACCEPTED = scratch(ACCEPTED, count);
    const claimed = CLAIMED;
    const accepted = ACCEPTED;

    // Each match takes its span unless a higher-priority one already holds part
    // of it -- so a longer value wins wherever it occurs, whatever starts first.
    for (let k = 0; k < count; k++) {
        const m = order[k];
        const from = starts[m];
        const to = from + hits[m].length;
        let free = true;
        for (let q = from; q < to; q++) {
            if (claimed[q]) { free = false; break; }
        }
        if (!free) continue;
        for (let q = from; q < to; q++) claimed[q] = 1;
        accepted[m] = 1;
    }

    let out = '';
    let copiedTo = 0;   // everything before this index is already in `out`
    for (let k = 0; k < count; k++) {
        if (!accepted[k]) continue;
        const from = starts[k];
        out += text.slice(copiedTo, from) + hits[k].replacement;
        copiedTo = from + hits[k].length;
    }
    return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

module.exports = {
    PII_TYPES,
    FIELD,
    detectPii,
    fakeFor,
    scrubPii,
    hashPrefix,
    luhnOk
};
