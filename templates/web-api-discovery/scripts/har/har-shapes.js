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
const harPolicy = require('./har-policy.js');

// The fake values emitted by sanitize-har.js (jwt) start with `eyJ` followed
// by 18 hex chars + `.` + 40 hex + `.` + 43 hex. Real JWTs contain base64url
// segments with mixed case and `_`/`-` and are longer. Detect anything that
// is JWT-shaped AND not the deterministic fake-shape.
const LEAK_PATTERNS = [
    {
        name: 'jwt',
        class: 'secret',
        re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
        // Fake JWTs from sanitize-har.js are entirely lowercase-hex after `eyJ`.
        isFake: (m) => /^eyJ[0-9a-f]{18}\.[0-9a-f]{40}\.[0-9a-f]{43}$/.test(m)
    },
    {
        name: 'hex64',
        class: 'secret',
        re: /\b[0-9a-fA-F]{64}\b/g,
        // Fake hex64 values produced by sanitize-har.js start with the `f00ded`
        // sentinel (issue #85). Real source values do not.
        isFake: (m) => /^f00ded[0-9a-f]{58}$/.test(m)
    },
    {
        name: 'hex32',
        class: 'secret',
        re: /\b[0-9a-fA-F]{32}\b/g,
        // Fake hex32 values start with the `deaf00` sentinel.
        isFake: (m) => /^deaf00[0-9a-f]{26}$/.test(m)
    },
    {
        name: 'bearer',
        class: 'secret',
        re: /Bearer\s+(?!redacted-)[A-Za-z0-9._=+/-]{20,}/g,
        // Fake bearer values are `Bearer <40 lowercase hex>` produced by sanitize-har.js.
        isFake: (m) => /^Bearer [0-9a-f]{40}$/.test(m)
    },
    {
        name: 'email',
        class: 'identity',
        // Bounded to stay linear over long non-matching runs (see pii.js).
        re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g,
        // Fake emails always use the @example.invalid domain.
        isFake: (m) => /@example\.invalid$/i.test(m)
    },
    {
        // E.164-shaped phone numbers (issue #46). Fakes use the 555 area code.
        name: 'phone',
        class: 'identity',
        re: /\+\d{10,15}\b/g,
        isFake: (m) => /^\+1555\d{7}$/.test(m)
    },
    {
        // US SSN. Fakes use the 9XX prefix that the SSA never issues.
        name: 'ssn',
        class: 'identity',
        re: /\b\d{3}-\d{2}-\d{4}\b/g,
        isFake: (m) => /^9\d{2}-/.test(m)
    },
    {
        // Credit-card numbers. Fakes are Luhn-valid too (so we can't use
        // validity as the fake marker); instead, fakes always start with the
        // 4242 IIN test prefix.
        // The lookarounds keep a digit run that is part of a DECIMAL NUMBER
        // out of the card slot. `.` is a non-word character, so a bare
        // /\b\d{13,19}\b/ matches between the decimal point and the first
        // fractional digit -- and a HAR's own timing values routinely carry 14
        // fractional digits of IEEE-754 noise ("time":168.01500000000001),
        // ~10% of which are Luhn-valid by chance. That rejected real captures
        // outright and told the operator they had leaked a card (issue #292).
        //
        //   (?<!\d\.)  drops a fractional part:      168.[01500000000001]
        //   (?!\.\d)   drops a float's integer part: [1234567890123].45
        //
        // A genuine card followed by sentence punctuation is still caught: the
        // lookahead requires a DIGIT after the dot, not merely a dot.
        name: 'credit-card',
        class: 'identity',
        re: /(?<!\d\.)\b\d{13,19}\b(?!\.\d)/g,
        isFake: (m) => /^4242/.test(m),
        precheck: (m) => hasAssignedIin(m) && luhnValid(m)
    }
];

/**
 * Issuer identification numbers, as DATA.
 *
 * `Luhn-valid 13-19 digit run` is not the predicate "credit card number" --
 * ~10% of ALL digit runs are Luhn-valid by chance, so a real JSON API's own
 * numeric identifiers (13-19 digits, everywhere, by the hundred) were reported
 * as leaked cards and the gate deleted its own output (issue #295). A card
 * number also carries an ASSIGNED issuer identifier at a LENGTH that issuer
 * actually mints; a trip id or a Unix-ms timestamp does not.
 *
 * `prefixes` are numeric ranges over the leading digits, matched at the width
 * of the range's own bounds, so `[51, 55]` is "the first two digits are 51-55"
 * and `[2221, 2720]` is "the first four are 2221-2720". Both bounds inclusive;
 * a single value is written as an equal pair.
 *
 * This is deliberately a table and not a chain of `if`s: the rules change when
 * the card networks change them, and a table is edited without re-reading any
 * control flow.
 */
const CARD_ISSUERS = [
    { brand: 'visa',       prefixes: [[4, 4]],                                   lengths: [13, 16, 19] },
    { brand: 'mastercard', prefixes: [[51, 55], [2221, 2720]],                   lengths: [16] },
    { brand: 'amex',       prefixes: [[34, 34], [37, 37]],                       lengths: [15] },
    { brand: 'discover',   prefixes: [[6011, 6011], [644, 649], [65, 65]],       lengths: [16, 19] },
    { brand: 'jcb',        prefixes: [[3528, 3589]],                             lengths: [16, 17, 18, 19] },
    { brand: 'unionpay',   prefixes: [[62, 62]],                                 lengths: [16, 17, 18, 19] },
    { brand: 'diners',     prefixes: [[300, 305], [3095, 3095], [36, 36], [38, 39]], lengths: [14, 15, 16, 17, 18, 19] }
];

/**
 * True when `s` begins with an assigned issuer identification number AND is a
 * length that issuer mints. Both halves are required: `4` at 17 digits is no
 * more a Visa than `98` at 16 digits is anything at all.
 */
function hasAssignedIin(s) {
    for (const issuer of CARD_ISSUERS) {
        if (!issuer.lengths.includes(s.length)) continue;
        for (const [low, high] of issuer.prefixes) {
            // Range bounds are written at their own digit width, and that
            // width is how many leading digits the comparison consumes.
            const width = String(high).length;
            const head = Number(s.slice(0, width));
            if (head >= low && head <= high) return true;
        }
    }
    return false;
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

/**
 * What a policy says about one class of finding: `gate`, `advise` or `off`.
 *
 * An ABSENT policy means `gate`, for every kind. Both verifiers call in
 * without one today, and the strictest reading is the only safe default: a
 * missing policy file must never be the thing that quietly downgrades a gate.
 * The same applies to a kind the policy does not name -- a pattern nobody
 * classified is not thereby exempt. (`har-shapes-class.test.js` case 2 stops
 * that going unnoticed: every pattern must be named by the default policy.)
 */
function settingFor(policy, cls, kind) {
    if (!policy || !policy.classes || !policy.classes[cls]) return 'gate';
    const setting = policy.classes[cls][kind];
    return setting === undefined ? 'gate' : setting;
}

/**
 * Scan `text` for leaked values, classified.
 *
 * A finding carries `{ kind, class, setting, gating, waived, fingerprint,
 * length }` and never the value. `gating` is the single field a caller needs
 * in order to decide whether to fail; `setting` and `waived` are what it needs
 * in order to REPORT, which matters just as much:
 *
 *   * A `secret` gates unconditionally -- the policy loader refuses to let a
 *     project lower a secret class, so this needs no special case here.
 *   * An `identity` gates only where the consumer asked for it. Shape carries
 *     no provenance: a Luhn-valid 16-digit run is a card, a trip id, or ~10%
 *     of digit runs by chance, and gating on that deleted 1413 trip ids and
 *     the artifact with them.
 *   * A waived or disabled finding is still RETURNED, marked. It has left the
 *     gate, not the report. A finding that vanished outright would be an
 *     invisible loosening -- the same failure the policy loader's
 *     `loosenedSecretNames` exists to prevent, and the reason a lapsing waiver
 *     is worth anything at all.
 */
function findLeaks(text, policy) {
    const leaks = [];
    for (const p of LEAK_PATTERNS) {
        const matches = text.match(p.re) || [];
        for (const m of matches) {
            if (p.precheck && !p.precheck(m)) continue;
            if (p.isFake(m)) continue;
            const print = fingerprint(m);
            const setting = settingFor(policy, p.class, p.name);
            const waived = policy ? harPolicy.isWaived(policy, p.name, print) : false;
            leaks.push({
                kind: p.name,
                class: p.class,
                setting,
                waived,
                gating: !waived && setting === 'gate',
                fingerprint: print,
                length: m.length,
            });
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
 * Scan `text` AND a percent-decoded view of it.
 *
 * An email inside a `variables=<percent-encoded JSON>` blob is spelled
 * `%40`, so a scan of the wire text alone never sees it. Both verifiers use
 * this, so the gate on the committed reference is not weaker than the gate on
 * the intermediate it came from.
 */
function findLeaksDeep(text, policy) {
    const leaks = findLeaks(text, policy);
    const shadow = decodedShadow(text);
    if (shadow === text) return leaks;

    const seen = new Set(leaks.map((l) => `${l.kind}:${l.fingerprint}`));
    for (const l of findLeaks(shadow, policy)) {
        if (!seen.has(`${l.kind}:${l.fingerprint}`)) leaks.push(l);
    }
    return leaks;
}

/**
 * A short, non-reversible tag for a matched value: enough to distinguish two
 * findings and to confirm one is gone, without ever printing the value.
 */
function fingerprint(value) {
    // 12 hex characters, not 8: findings are deduplicated by this tag, and a
    // 32-bit prefix is small enough to make an accidental merge of two
    // genuinely different secrets conceivable.
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** Render a finding for a human, with no part of the value in it. */
function describeLeak(leak) {
    return `${leak.kind} (fingerprint ${leak.fingerprint}, ${leak.length} chars)`;
}

module.exports = {
    LEAK_PATTERNS,
    settingFor,
    findLeaks,
    findLeaksDeep,
    decodedShadow,
    fingerprint,
    describeLeak,
    luhnValid,
    CARD_ISSUERS,
    hasAssignedIin,
};
