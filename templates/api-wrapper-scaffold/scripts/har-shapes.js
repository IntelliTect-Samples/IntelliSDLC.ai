#!/usr/bin/env node
/**
 * har-shapes.js -- shape-based leak detection, shared by both verifiers.
 *
 * These patterns catch credentials by what they LOOK like -- a JWT, a long
 * hex token, a bearer header, an email, a phone number. They are the third
 * control, alongside key-name and literal-value scrubbing, and they are the
 * only one that catches a secret nobody named and nobody declared: a
 * per-session bearer token, a third party's email in a response body.
 *
 * `verify-scrub.js` gates the scrubbed HAR and `verify-har-reference.js`
 * gates the committed reference. The reference is the file that actually
 * ships, so it must be gated at least as hard -- one list, both callers.
 *
 * Findings NEVER carry the matched text. A report that quotes the value it
 * found relocates the leak into the CI log that reports it; callers get the
 * kind and a short non-reversible fingerprint, which is enough to tell two
 * findings apart and to confirm a fix without ever printing the secret.
 */

'use strict';

const crypto = require('crypto');

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
        // Bounded to stay linear over long non-matching runs (see pii.js).
        re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g,
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
            leaks.push({ kind: p.name, fingerprint: fingerprint(m), length: m.length });
        }
    }
    return leaks;
}


/**
 * A short, non-reversible tag for a matched value: enough to distinguish two
 * findings and to confirm one is gone, without ever printing the value.
 */
function fingerprint(value) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** Render a finding for a human, with no part of the value in it. */
function describeLeak(leak) {
    return `${leak.kind} (fingerprint ${leak.fingerprint}, ${leak.length} chars)`;
}

module.exports = {
    LEAK_PATTERNS,
    findLeaks,
    fingerprint,
    describeLeak,
    luhnValid,
    isPlausibleRecentUnixMs,
};
