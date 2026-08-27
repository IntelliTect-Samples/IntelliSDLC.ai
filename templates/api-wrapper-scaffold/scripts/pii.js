#!/usr/bin/env node
/**
 * pii.js -- shared typed-PII detection + deterministic faker for the
 * api-wrapper-scaffold scrub pipeline (issue #46).
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
            const target = replacements.find(r => r.type === pickContextType(fType) && r.value === node);
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

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAll(text, replacements) {
    let out = text;
    for (const r of replacements) {
        // Only do raw text replace for value-like types we can safely substring-match.
        // Context-typed values (person-name etc.) may have very short literals
        // (e.g. "Alice") that risk false-positive matches inside unrelated text.
        // For the JSON-body codepath those are handled by replaceInJson above;
        // for the raw-text codepath we still need them, so we apply with word
        // boundaries when the value is purely alphabetic.
        const v = String(r.value);
        if (v.length === 0) continue;
        let re;
        if (/^[A-Za-z]+( [A-Za-z]+)*$/.test(v)) {
            re = new RegExp(`\\b${escapeRe(v)}\\b`, 'g');
        } else {
            re = new RegExp(escapeRe(v), 'g');
        }
        out = out.replace(re, r.replacement);

        // The same value can appear percent-encoded in the very same entry:
        // detection reads the decoded `queryString` pair, while the `url`
        // carries `phone=%2B1...`. Replacing only the raw spelling leaves the
        // encoded copy readable -- one value, several spellings, which is the
        // failure literal-value scrubbing exists to close (see har-literals.js).
        const encoded = encodeURIComponent(v);
        if (encoded !== v && out.includes(encoded)) {
            out = out.split(encoded).join(encodeURIComponent(r.replacement));
        }
    }
    return out;
}

module.exports = {
    PII_TYPES,
    detectPii,
    fakeFor,
    scrubPii,
    hashPrefix,
    luhnOk
};
