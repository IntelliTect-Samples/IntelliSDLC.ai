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
        default:        return `<REDACTED-${h.slice(0, 8)}>`;
    }
}

// Patterns ordered most-specific first so JWTs match before hex64.
const PATTERNS = [
    { kind: 'jwt',    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    { kind: 'email',  re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { kind: 'uuid',   re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
    { kind: 'hex64',  re: /\b[0-9a-fA-F]{64}\b/g },
    { kind: 'hex32',  re: /\b[0-9a-fA-F]{32}\b/g },
];

function scrubString(s, subs, salt) {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s;
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
    // For Cookie / Set-Cookie headers, replace anything after '=' that looks token-ish.
    return value.replace(/=([^;,\s]{16,})/g, (_m, tok) => {
        const key = `cookie:${tok}`;
        if (!subs[key]) subs[key] = fakeFor('cookie', tok, salt);
        return `=${subs[key]}`;
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

