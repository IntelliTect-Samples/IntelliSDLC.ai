#!/usr/bin/env node
/**
 * verify-scrub.js -- CI-grade leak detector for scrubbed HAR files.
 *
 * Scans a HAR file for unredacted JWTs, long hex tokens, bearer tokens,
 * and plausible email addresses. Exits non-zero on any hit so it can be
 * wired into pre-commit and CI workflows.
 *
 * Usage:
 *   node verify-scrub.js --in <scrubbed.har>
 *
 * Exit codes:
 *   0 -- clean
 *   1 -- I/O or parse error
 *   3 -- one or more leaks detected (reported on stderr)
 */

'use strict';

const fs = require('fs');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
    }
    return out;
}

// The fake values emitted by sanitize-har.js (jwt) start with `eyJ` followed
// by 18 hex chars + `.` + 40 hex + `.` + 43 hex. Real JWTs contain base64url
// segments with mixed case and `_`/`-` and are longer. Detect anything that
// is JWT-shaped AND not the deterministic fake-shape.
const LEAK_PATTERNS = [
    {
        name: 'jwt',
        re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
        // Fake JWTs from sanitize-har.js are entirely lowercase-hex after `eyJ`.
        isFake: (m) => /^eyJ[0-9a-f]{18}\.[0-9a-f]{40}\.[0-9a-f]{43}$/.test(m)
    },
    {
        name: 'hex64',
        re: /\b[0-9a-fA-F]{64}\b/g,
        isFake: () => false
    },
    {
        name: 'bearer',
        re: /Bearer\s+(?!redacted-)[A-Za-z0-9._=+/-]{20,}/g,
        // Fake bearer values are `Bearer <40 lowercase hex>` produced by sanitize-har.js.
        isFake: (m) => /^Bearer [0-9a-f]{40}$/.test(m)
    },
    {
        name: 'email',
        re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        // Fake emails always use the @example.invalid domain.
        isFake: (m) => /@example\.invalid$/i.test(m)
    }
];

function findLeaks(text) {
    const leaks = [];
    for (const p of LEAK_PATTERNS) {
        const matches = text.match(p.re) || [];
        for (const m of matches) {
            if (p.isFake(m)) continue;
            leaks.push({ kind: p.name, sample: m.slice(0, 40) + (m.length > 40 ? '…' : '') });
        }
    }
    return leaks;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.in) {
        console.error('usage: node verify-scrub.js --in <har>');
        process.exit(1);
    }
    let raw;
    try {
        raw = fs.readFileSync(args.in, 'utf8');
    } catch (e) {
        console.error(`verify-scrub: cannot read ${args.in}: ${e.message}`);
        process.exit(1);
    }
    const leaks = findLeaks(raw);
    if (leaks.length === 0) {
        console.log(`verify-scrub: ${args.in} -- 0 leaks`);
        process.exit(0);
    }
    console.error(`verify-scrub: ${leaks.length} leak(s) detected in ${args.in}:`);
    for (const l of leaks) console.error(`  - ${l.kind}: ${l.sample}`);
    process.exit(3);
}

main();
