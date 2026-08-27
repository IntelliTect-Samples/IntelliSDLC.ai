#!/usr/bin/env node
/**
 * verify-scrub.js -- CI-grade leak detector for scrubbed HAR files.
 *
 * Scans a HAR file for unredacted JWTs, long hex tokens, bearer tokens,
 * and plausible email addresses. Exits non-zero on any hit so it can be
 * wired into pre-commit and CI workflows.
 *
 * Three checks, matching the three ways a value escapes a scrub:
 *
 *   1. Shape patterns -- JWTs, long hex, bearer tokens, emails, PII.
 *   2. Known secret names, INCLUDING inside percent-encoded parameters. A
 *      form body carrying `variables=<percent-encoded JSON>` hides tokens
 *      where no flat pattern reaches them.
 *   3. Forbidden literals from the operator profile -- the operator's own
 *      identifiers, which escape (1) and (2) whenever they travel under a
 *      name nobody anticipated.
 *
 * Check 3 needs `.har-profile.json`, which is gitignored and therefore
 * absent in CI. When no profile is found the literal check is reported as
 * skipped rather than silently passing; checks 1 and 2 still gate.
 *
 * No failure message ever echoes the offending value -- that would merely
 * relocate the leak into the log that reports it.
 *
 * Usage:
 *   node verify-scrub.js --in <scrubbed.har> [--profile <path>]
 *
 * Exit codes:
 *   0 -- clean
 *   1 -- I/O or parse error
 *   3 -- one or more leaks detected (reported on stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const harProfile = require(path.join(__dirname, 'har-profile.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));

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
        // Fake hex64 values produced by sanitize-har.js start with the `f00ded`
        // sentinel (issue #85). Real source values do not.
        isFake: (m) => /^f00ded[0-9a-f]{58}$/.test(m)
    },
    {
        name: 'hex32',
        re: /\b[0-9a-fA-F]{32}\b/g,
        // Fake hex32 values start with the `deaf00` sentinel.
        isFake: (m) => /^deaf00[0-9a-f]{26}$/.test(m)
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
    },
    {
        // E.164-shaped phone numbers (issue #46). Fakes use the 555 area code.
        name: 'phone',
        re: /\+\d{10,15}\b/g,
        isFake: (m) => /^\+1555\d{7}$/.test(m)
    },
    {
        // US SSN. Fakes use the 9XX prefix that the SSA never issues.
        name: 'ssn',
        re: /\b\d{3}-\d{2}-\d{4}\b/g,
        isFake: (m) => /^9\d{2}-/.test(m)
    },
    {
        // Luhn-valid credit-card-shaped digit runs. Fakes are Luhn-valid too
        // (so we can't use validity as the fake marker); instead, fakes always
        // start with the 4242 IIN test prefix.
        name: 'credit-card',
        re: /\b\d{13,19}\b/g,
        isFake: (m) => /^4242/.test(m),
        precheck: (m) => luhnValid(m) && !isPlausibleRecentUnixMs(m)
    }
];

// A 13-digit numeric run that ALSO parses as a Unix-millisecond timestamp
// between year 2010 and year 2050 is overwhelmingly more likely to be a
// timestamp than a credit-card number, even when it happens to be Luhn-valid
// (~10% of 13-digit numbers are). Suppress this slot so embedded API
// timestamps do not produce false-positive credit-card leaks (issue #87).
//
// Bounds (UTC):
//   2010-01-01 00:00:00.000 -> 1262304000000
//   2050-01-01 00:00:00.000 -> 2524608000000
//
// Both bounds are 13-digit values, so this exclusion is naturally scoped to
// the 13-digit length only; 14-19 digit credit-card-shaped numbers are
// outside the window and continue to be flagged.
function isPlausibleRecentUnixMs(s) {
    if (s.length !== 13) return false;
    const n = Number(s);
    return n >= 1262304000000 && n <= 2524608000000;
}

function luhnValid(s) {
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
        let d = s.charCodeAt(i) - 48;
        if (d < 0 || d > 9) return false;
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d; alt = !alt;
    }
    return sum % 10 === 0;
}

function findLeaks(text) {
    const leaks = [];
    for (const p of LEAK_PATTERNS) {
        const matches = text.match(p.re) || [];
        for (const m of matches) {
            if (p.precheck && !p.precheck(m)) continue;
            if (p.isFake(m)) continue;
            leaks.push({ kind: p.name, sample: m.slice(0, 40) + (m.length > 40 ? '...' : '') });
        }
    }
    return leaks;
}

// Percent-decode every escape sequence in place, so a secret nested inside an
// encoded parameter is scanned by the same patterns as one on the wire. Two
// passes, because a value inside an already-encoded parameter is encoded twice.
function decodedShadow(text) {
    let out = text;
    for (let pass = 0; pass < 2; pass++) {
        out = out.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
            try { return decodeURIComponent(m); } catch { return m; }
        });
    }
    return out;
}

/**
 * Walk the parsed HAR for a known secret name whose value is still readable.
 * Reports the NAME only -- the value is what we are trying not to spread.
 */
function findNamedSecretLeaks(node, leaks, seen) {
    if (node === null || typeof node !== 'object') return leaks;
    if (seen.has(node)) return leaks;
    seen.add(node);

    if (Array.isArray(node)) {
        for (const item of node) findNamedSecretLeaks(item, leaks, seen);
        return leaks;
    }

    // HAR name/value pairs: headers, cookies, queryString, postData.params.
    if (typeof node.name === 'string' && typeof node.value === 'string') {
        if (harSecrets.isUnredactedSecret(node.name, node.value)) {
            leaks.push({ kind: 'known-secret', sample: node.name });
        }
    }

    for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value === 'string') {
            if (harSecrets.isUnredactedSecret(key, value)) {
                leaks.push({ kind: 'known-secret', sample: key });
            }
            // A percent-encoded parameter can carry a whole JSON document
            // whose inner keys never appear in the outer parameter list.
            const nested = harLiterals.decodeNestedJson(value);
            if (nested) findNamedSecretLeaks(nested, leaks, seen);
        } else {
            findNamedSecretLeaks(value, leaks, seen);
        }
    }
    return leaks;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.in) {
        console.error('usage: node verify-scrub.js --in <har> [--profile <path>]');
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

    const shadow = decodedShadow(raw);
    if (shadow !== raw) {
        const seenSamples = new Set(leaks.map((l) => `${l.kind}:${l.sample}`));
        for (const l of findLeaks(shadow)) {
            if (!seenSamples.has(`${l.kind}:${l.sample}`)) leaks.push(l);
        }
    }

    try {
        findNamedSecretLeaks(JSON.parse(raw), leaks, new Set());
    } catch {
        // Not parseable as JSON -- the text-level checks above still apply.
    }

    // Forbidden literals. The profile is gitignored, so it is absent in CI;
    // say so rather than reporting a check that never ran as a pass.
    let literalStatus = 'skipped (no profile)';
    try {
        const profile = harProfile.loadProfile({ profilePath: args.profile });
        for (const hit of harLiterals.findLiteralHits(raw, profile.literals)) {
            leaks.push({ kind: 'forbidden-literal', sample: `${hit.sentinel} (x${hit.count})` });
        }
        literalStatus = `${profile.literals.length} literal(s)`;
    } catch (e) {
        if (args.profile) {
            console.error(`verify-scrub: ${e.message}`);
            process.exit(1);
        }
    }

    if (leaks.length === 0) {
        console.log(`verify-scrub: ${args.in} -- 0 leaks (literal check: ${literalStatus})`);
        process.exit(0);
    }
    console.error(`verify-scrub: ${leaks.length} leak(s) detected in ${args.in}:`);
    for (const l of leaks) console.error(`  - ${l.kind}: ${l.sample}`);
    process.exit(3);
}

main();
