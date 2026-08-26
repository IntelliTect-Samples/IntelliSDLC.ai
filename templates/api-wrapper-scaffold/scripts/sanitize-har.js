#!/usr/bin/env node
/**
 * sanitize-har.js -- deterministic HAR scrubber for the api-wrapper-scaffold agent.
 *
 * Reads a captured HAR file, redacts secrets / PII, and writes a scrubbed
 * HAR plus a hash -> fake substitution map. The substitution table is
 * HMAC-SHA256-keyed by the project salt so the same original value
 * always maps to the same fake within a project. Format-preserving:
 * an email becomes a fake email, a 64-char hex token becomes a 64-char
 * fake hex string, etc.
 *
 * Usage:
 *   node sanitize-har.js --in <input.har> --out <output.har> --subs <subs.json> --salt <salt>
 *
 * Exit codes:
 *   0  -- scrubbed HAR + subs map written successfully
 *   1  -- I/O or parse error
 *   2  -- usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pii = require(path.join(__dirname, 'pii.js'));

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            out[a.slice(2)] = argv[i + 1];
            i++;
        }
    }
    return out;
}

function usage() {
    console.error('usage: node sanitize-har.js --in <in.har> --out <out.har> --subs <subs.json> --salt <salt> [--pii-subs <.substitutions.json>] [--fixed-time <iso8601>]');
    process.exit(2);
}

// Format-preserving fake generators keyed by HMAC(salt, original).
// hex64 and hex32 fakes get a deterministic sentinel prefix so verify-scrub.js
// can distinguish a fake from a real (non-scrubbed) source value (issue #85).
const HEX64_FAKE_PREFIX = 'f00ded'; //  6 hex chars  -> 58 hex follow
const HEX32_FAKE_PREFIX = 'deaf00'; //  6 hex chars  -> 26 hex follow

function fakeFor(kind, original, salt) {
    const h = crypto.createHmac('sha256', salt).update(original).digest('hex');
    switch (kind) {
        case 'jwt': {
            // header.payload.signature -- three base64url-ish chunks of plausible length
            const seg = (n, offset) => h.slice(offset, offset + n);
            return `eyJ${seg(18, 0)}.${seg(40, 18)}.${seg(43, 58)}`;
        }
        case 'hex64':   return HEX64_FAKE_PREFIX + h.slice(0, 64 - HEX64_FAKE_PREFIX.length);
        case 'hex32':   return HEX32_FAKE_PREFIX + h.slice(0, 32 - HEX32_FAKE_PREFIX.length);
        case 'email':   return `user-${h.slice(0, 8)}@example.invalid`;
        case 'bearer':  return `Bearer ${h.slice(0, 40)}`;
        case 'uuid':    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
        case 'cookie':  return `redacted-${h.slice(0, 24)}`;
        case 'field':   return `redacted-${h.slice(0, 16)}`;
        case 'upload-handle': return `1:redacted-${h.slice(0, 16)}:application/octet-stream:redacted-${h.slice(16, 24)}:e:0:redacted-${h.slice(24, 32)}`;
        default:        return `<REDACTED-${h.slice(0, 8)}>`;
    }
}

// Patterns ordered most-specific first so JWTs match before hex64.
const PATTERNS = [
    // Upload/session handle tokens, e.g. {"h":"1:<base64>:video/mp4:<token>:e:<expiry>:<sig>"}
    // (issue #253) -- these are credentials returned in a response body, not
    // a request header, so the header-name based scrub never sees them.
    { kind: 'upload-handle', re: /\b1:[A-Za-z0-9+/=_-]{6,}:[\w./+-]+:[A-Za-z0-9+/=_-]{4,}:e:\d+:[A-Za-z0-9+/=_-]{4,}\b/g },
    { kind: 'jwt',    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    { kind: 'email',  re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { kind: 'uuid',   re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
    { kind: 'hex64',  re: /\b[0-9a-fA-F]{64}\b/g },
    { kind: 'hex32',  re: /\b[0-9a-fA-F]{32}\b/g },
];

// Field/header names that are secrets by identity, not by shape (issue #253).
// These are short, non-hex, non-JWT tokens (CSRF/session-signing values,
// upload handles) that the shape-based PATTERNS above never match, so they
// need to be redacted by name instead. Matched case-insensitively against
// the JSON key or header name, ignoring any leading/trailing punctuation.
const KNOWN_SECRET_FIELD_NAMES = new Set([
    // request-signing / CSRF-adjacent body & query params
    'fb_dtsg', 'lsd', 'jazoest',
    '__spin_r', '__spin_b', '__spin_t', '__hs', '__hsi', '__csr', '__hsdp', '__req', '__rev',
    // session cookies too short to hit the 16-char cookie-value heuristic
    'c_user', 'xs', 'datr', 'fr', 'sb', 'mid', 'ig_did', 'ds_user_id',
    'sessionid', 'csrftoken',
]);
const KNOWN_SECRET_HEADER_NAMES = new Set([
    'x-fb-lsd', 'x-asbd-id', 'x-ig-app-id', 'x-instagram-rupload-params',
]);

function isKnownSecretField(key) {
    if (typeof key !== 'string') return false;
    return KNOWN_SECRET_FIELD_NAMES.has(key.toLowerCase());
}

// Escaped alternation of known secret field names, used to catch them by
// identity inside form-encoded bodies (`fb_dtsg=...&lsd=...`) and inline
// JSON text (`"lsd":"..."`) -- shapes that PATTERNS never matches because
// these values are short and neither hex- nor JWT-shaped.
const KNOWN_FIELD_NAME_ALT = Array.from(KNOWN_SECRET_FIELD_NAMES)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
const FORM_FIELD_RE = new RegExp(`\\b(${KNOWN_FIELD_NAME_ALT})=([^&\\s"';,]+)`, 'gi');
const JSON_FIELD_RE = new RegExp(`("(?:${KNOWN_FIELD_NAME_ALT})"\\s*:\\s*")([^"]*)(")`, 'gi');

function scrubKnownFields(s, subs, salt) {
    let out = s.replace(FORM_FIELD_RE, (_m, name, val) => {
        const key = `field:${name.toLowerCase()}:${val}`;
        if (!subs[key]) subs[key] = fakeFor('field', val, salt);
        return `${name}=${subs[key]}`;
    });
    out = out.replace(JSON_FIELD_RE, (_m, pre, val, post) => {
        const key = `field:${pre.toLowerCase()}:${val}`;
        if (!subs[key]) subs[key] = fakeFor('field', val, salt);
        return `${pre}${subs[key]}${post}`;
    });
    return out;
}

function scrubString(s, subs, salt) {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = scrubKnownFields(s, subs, salt);
    for (const { kind, re } of PATTERNS) {
        out = out.replace(re, (match) => {
            const key = `${kind}:${match}`;
            if (!subs[key]) subs[key] = fakeFor(kind, match, salt);
            return subs[key];
        });
    }
    return out;
}

function scrubCookieHeader(value, subs, salt) {
    if (typeof value !== 'string') return value;
    // For Cookie / Set-Cookie headers, replace the value of any pair whose
    // value looks token-ish (16+ chars) OR whose cookie name is a known
    // secret (session cookies like `mid` / `sb` can be short).
    return value.replace(/([^;,\s=]+)=([^;,\s]+)/g, (m, name, tok) => {
        if (tok.length < 16 && !isKnownSecretField(name)) return m;
        const key = `cookie:${name.toLowerCase()}:${tok}`;
        if (!subs[key]) subs[key] = fakeFor('cookie', tok, salt);
        return `${name}=${subs[key]}`;
    });
}

function scrubHeaders(headers, subs, salt) {
    if (!Array.isArray(headers)) return headers;
    for (const h of headers) {
        if (!h || typeof h.value !== 'string') continue;
        const lname = (h.name || '').toLowerCase();
        if (lname === 'cookie' || lname === 'set-cookie') {
            h.value = scrubCookieHeader(h.value, subs, salt);
        }
        if (lname === 'authorization') {
            // Replace bearer-style: "Bearer <token>"
            h.value = h.value.replace(/Bearer\s+(\S+)/i, (_m, tok) => {
                const key = `bearer:${tok}`;
                if (!subs[key]) subs[key] = `Bearer ${fakeFor('hex64', tok, salt).slice(0, 40)}`;
                return subs[key];
            });
        }
        if (KNOWN_SECRET_HEADER_NAMES.has(lname)) {
            const key = `field:${lname}:${h.value}`;
            if (!subs[key]) subs[key] = fakeFor('field', h.value, salt);
            h.value = subs[key];
        }
        h.value = scrubString(h.value, subs, salt);
    }
    return headers;
}

function walk(node, subs, salt) {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') return scrubString(node, subs, salt);
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = walk(node[i], subs, salt);
        return node;
    }
    if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
            if (k === 'headers') {
                node[k] = scrubHeaders(node[k], subs, salt);
            } else {
                node[k] = walk(node[k], subs, salt);
            }
        }
        return node;
    }
    return node;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.in || !args.out || !args.subs || !args.salt) usage();

    let raw;
    try {
        raw = fs.readFileSync(args.in, 'utf8');
    } catch (e) {
        console.error(`sanitize-har: cannot read ${args.in}: ${e.message}`);
        process.exit(1);
    }

    let har;
    try {
        har = JSON.parse(raw);
    } catch (e) {
        console.error(`sanitize-har: invalid JSON in ${args.in}: ${e.message}`);
        process.exit(1);
    }

    const subs = {};
    walk(har, subs, args.salt);

    // Typed-PII pass (issue #46): runs after legacy regex scrub so that
    // anything still in the HAR (emails in custom-named fields, phones,
    // SSNs, credit-cards, IPs, plus context-driven name/address/dob/geo)
    // gets a deterministic, obviously-fake replacement. The returned
    // substitutions array contains only hash prefixes of originals so the
    // file is safe to commit.
    const piiResult = pii.scrubPii(har);

    // Stable key order in output JSON for byte-for-byte determinism.
    const sortedSubs = {};
    for (const k of Object.keys(subs).sort()) sortedSubs[k] = subs[k];

    fs.writeFileSync(args.out, JSON.stringify(har, null, 2), 'utf8');
    fs.writeFileSync(args.subs, JSON.stringify(sortedSubs, null, 2), 'utf8');

    if (args['pii-subs']) {
        const createdAt = args['fixed-time'] || new Date().toISOString();
        const store = {
            version: 1,
            createdAt,
            substitutions: piiResult.substitutions
        };
        fs.writeFileSync(args['pii-subs'], JSON.stringify(store, null, 2), 'utf8');
    }

    const piiCount = piiResult.substitutions.length;
    console.log(`sanitize-har: wrote ${args.out} (${Object.keys(subs).length} legacy + ${piiCount} typed-PII substitutions)`);
    process.exit(0);
}

main();

