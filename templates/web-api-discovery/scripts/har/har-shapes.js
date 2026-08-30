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
        precheck: (m, policy) => hasAssignedIin(m, policy) && luhnValid(m)
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
 *
 * It stays in CODE rather than in `har-policy.default.json` because it is a
 * public payment-network standard, not anybody's project concept -- an
 * editorial decision, not a technical constraint. Nothing prevents the move:
 * `har-shapes.js` requires `har-policy.js` one-way, `har-policy.js` requires
 * nothing back, and a JSON data file requires nothing at all. Said plainly so
 * a maintainer does not go looking for an obstacle that is not there. What IS a
 * project concept is which markets a consumer operates in, so the merged
 * policy's `cardIssuers` appends further ranges to this table -- Maestro and
 * RuPay being the obvious ones. Maestro is deliberately absent from the shipped
 * table: its range (50, 56-69) at lengths 12-19 overlaps Discover and UnionPay
 * and would reopen the false-positive surface #295 closed, so a repo that needs
 * it declares it and owns the consequence.
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
 *
 * `policy` may add ranges and can never remove one, so an absent policy is the
 * shipped standard and nothing weaker -- the same rule the loader applies to the
 * secret classes, for the same reason: a missing policy file must never be the
 * thing that quietly downgrades a detector.
 */
function hasAssignedIin(s, policy) {
    const issuers = policy && Array.isArray(policy.cardIssuers) && policy.cardIssuers.length
        ? [...CARD_ISSUERS, ...policy.cardIssuers]
        : CARD_ISSUERS;
    for (const issuer of issuers) {
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
            if (p.precheck && !p.precheck(m, policy)) continue;
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

/**
 * Render a finding for a human, with no part of the value in it.
 *
 * The location is the part that makes a finding actionable. What this
 * replaced read `credit-card (fingerprint 4f2a..., 13 chars)` -- repeated 1413
 * times, with the file already deleted, which is a report that tells its
 * reader nothing except that the tool is angry.
 */
function describeLeak(leak) {
    // Why it is not blocking matters as much as that it is not. A waived
    // secret is not "advisory" -- somebody signed for it, with a reason and an
    // expiry -- and a disabled class is not either: the project turned it off.
    // Collapsing all three into one word is how a report stops meaning
    // anything, which is the disease this whole issue treats.
    const parts = [`${leak.kind}`];
    if (leak.class) {
        let why = '';
        if (leak.waived) why = ' waived';
        else if (leak.identifierField) why = ' identifier-shaped';
        else if (leak.setting === 'off') why = ' class disabled';
        else if (leak.gating === false) why = ' advisory';
        parts.push(`[${leak.class}${why}]`);
    }
    if (leak.entryIndex !== undefined) {
        parts.push(`at entry ${leak.entryIndex} ${leak.keyPath || `(inside encoded ${leak.enclosing})`}`);
    }
    const counted = leak.count > 1 ? `, x${leak.count}` : '';
    const waived = leak.waived ? ', WAIVED' : '';
    parts.push(`(fingerprint ${leak.fingerprint}, ${leak.length} chars${counted}${waived})`);
    return parts.join(' ');
}

/**
 * HAR-spec fields inside an entry that WE wrote, skipped by the entry walk.
 *
 * The scoping fix is about provenance, not about a list of interesting nodes.
 * The whole-document sweep reported our own annotations -- `log.comment`,
 * `log.creator`, a fingerprint the scrubber had itself recorded -- as leaks in
 * the file it had just scrubbed. Walking `log.entries[]` removes the envelope;
 * this removes the handful of our-own fields that live inside an entry.
 *
 * Everything else in an entry IS scanned, including fields no spec mentions. A
 * capture tool that adds one is adding wire data, and an allowlist of the
 * nodes somebody thought of is how a secret in an unanticipated field walks
 * straight through a gate that reports itself clean.
 *
 * This skip applies ONLY to the entry's own structure. It is never applied
 * inside a parsed body: `comment` is our field on an entry and somebody's
 * actual content in a response, and confusing the two would hide real data.
 */
const ENTRY_OWN_FIELDS = new Set(['comment', 'timings', 'cache']);

function collectEntryStrings(entry, emit) {
    for (const key of Object.keys(entry)) {
        if (ENTRY_OWN_FIELDS.has(key)) continue;
        walkJsonStrings(entry[key], key, emit, 0);
    }
}

/**
 * Walk a parsed JSON value, reporting each string with its key path appended
 * to `base`, so a finding in a response body says WHICH field held it.
 */
function walkJsonStrings(value, base, emit, depth) {
    if (depth > 40) return;
    if (typeof value === 'string') { emit(base, value); return; }
    // A scalar that is not a string is still a value somebody sent, and it is
    // emitted here so it gets a precise key path rather than only being caught
    // by the raw-text pass at body level.
    //
    // But ONLY when the parser's copy is faithful. An integer past 2^53 comes
    // back rounded, and rounding is wrong in both directions: it drops real
    // cards longer than 16 digits, and it invents them -- `4560847124165743100`
    // is not a card, yet it parses to `4560847124165743000`, which carries an
    // assigned issuer identifier and passes Luhn. Reporting that would hand the
    // operator a fingerprint matching no bytes in the file: unfindable,
    // unverifiable, and not even waivable, since a waiver keys on a value that
    // was never there. Lossy numbers are left to the raw-text pass, which reads
    // what was actually on the wire.
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return;
        emit(base, String(value));
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((v, i) => walkJsonStrings(v, `${base}[${i}]`, emit, depth + 1));
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            walkJsonStrings(value[key], `${base}.${key}`, emit, depth + 1);
        }
    }
}

/**
 * Budgets for the structural walk over a body's SOURCE TEXT.
 *
 * The walk runs over multi-hundred-megabyte bodies in the field, so every
 * dimension that can grow without bound has a ceiling. Exceeding one costs
 * PRECISION and never COVERAGE: the raw-text pass runs regardless, so an
 * over-budget body still gates, it just reports at the body node instead of at
 * a key path -- which is exactly today's behaviour.
 */
const STRUCTURAL_LIMITS = Object.freeze({
    // Above this the structural walk is skipped outright. A single linear pass
    // is cheap per character, but "cheap per character" is not a bound.
    maxChars: 32 * 1024 * 1024,
    // Scalars emitted. A body can be small and still describe a million leaves.
    maxNodes: 500000,
    // Nesting. Also what keeps a recursive descent off the JS stack limit: a
    // 20k-deep array of arrays is a two-line body and a stack overflow.
    maxDepth: 60,
    // How many times a JSON document may be found serialised inside a JSON
    // string. Providers ship one such layer routinely; three is generous.
    maxNestedDocs: 3,
    // Shortest value any pattern can match (an email, `a@b.co`). Below it the
    // patterns cannot fire, so running eight regexes over the scalar is pure
    // cost -- and most leaves in a real payload are shorter than this.
    minScalarChars: 6,
    // How far in to look for the opening brace of a body behind an
    // anti-hijacking prefix (`for (;;);`, `)]}'`).
    prefixScanChars: 16,
    // Structural key paths remembered per distinct value. A value echoed a
    // thousand times must not cost a thousand strings; past the cap the extra
    // occurrences report at the body node, which is where they used to report.
    maxPathsPerValue: 64,
});

const LITERAL_END = new Set([',', '}', ']', ' ', '\t', '\n', '\r']);
const LITERAL_RE = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?|true|false|null)$/;

/** Thrown when a budget is exhausted; caught with the syntax errors. */
class ScanBudgetError extends Error {}

/**
 * Walk a JSON document as SOURCE TEXT, emitting `(keyPath, scalarText)`.
 *
 * Not `JSON.parse`. The parser is not a faithful copy of the wire: an integer
 * past 2^53 comes back rounded, which is every provider object id above 16
 * digits -- and those ids are precisely the values being located. Reading them
 * through the parser meant the walk had to skip them (a rounded value's
 * fingerprint matches no bytes in the file), so they never got a key path, and
 * 135 of 176 field findings reported only `response.content.text`. A scan over
 * the source text emits the digits that are actually there.
 *
 * It also never materialises the document, which is what makes a
 * hundred-megabyte body a linear scan rather than a heap allocation.
 *
 * Returns true when the document was consumed end to end.
 */
function scanJsonSource(text, start, base, emit, budget, nestDepth) {
    let i = start;
    const n = text.length;

    const fail = () => { throw new SyntaxError('not json'); };

    function ws() {
        while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break;
        }
    }

    function readString() {
        const from = i;
        i++;
        while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 92) { i += 2; continue; }          // escape: skip the pair
            if (c === 34) {
                i++;
                try { return JSON.parse(text.slice(from, i)); } catch { return fail(); }
            }
            if (c < 0x20) fail();                         // control char: not a JSON string
            i++;
        }
        return fail();
    }

    function emitScalar(keyPath, value) {
        if (++budget.nodes > STRUCTURAL_LIMITS.maxNodes) throw new ScanBudgetError('nodes');
        emit(keyPath, value);
    }

    // A string that is itself a JSON document is walked as one, so a
    // double-encoded payload names its own fields instead of reporting the
    // blob that carries it. The nested walk must succeed COMPLETELY before its
    // paths are believed -- a half-parsed guess would attach confident key
    // paths to a string that merely starts with a brace.
    function emitStringValue(keyPath, value) {
        if (nestDepth < STRUCTURAL_LIMITS.maxNestedDocs
            && value.length <= STRUCTURAL_LIMITS.maxChars
            && /^\s*[[{]/.test(value)) {
            const buffered = [];
            const nested = scanJsonSource(value, 0, keyPath, (p, v) => buffered.push([p, v]),
                budget, nestDepth + 1);
            if (nested) {
                for (const [p, v] of buffered) emit(p, v);
                return;
            }
        }
        emitScalar(keyPath, value);
    }

    function value(keyPath, depth) {
        if (depth > STRUCTURAL_LIMITS.maxDepth) throw new ScanBudgetError('depth');
        ws();
        if (i >= n) fail();
        const c = text[i];
        if (c === '{') return object(keyPath, depth);
        if (c === '[') return array(keyPath, depth);
        if (c === '"') return emitStringValue(keyPath, readString());
        const from = i;
        while (i < n && !LITERAL_END.has(text[i])) i++;
        const raw = text.slice(from, i);
        // A number is emitted as the DIGITS THAT ARE THERE, not as a reparsed
        // double -- see the header. `true`/`false`/`null` come through as
        // themselves and match nothing, which is correct and costs nothing.
        if (!LITERAL_RE.test(raw)) fail();
        return emitScalar(keyPath, raw);
    }

    function object(keyPath, depth) {
        i++;
        ws();
        if (text[i] === '}') { i++; return; }
        for (;;) {
            ws();
            if (text[i] !== '"') fail();
            const key = readString();
            ws();
            if (text[i] !== ':') fail();
            i++;
            value(`${keyPath}.${key}`, depth + 1);
            ws();
            if (text[i] === ',') { i++; continue; }
            if (text[i] === '}') { i++; return; }
            fail();
        }
    }

    function array(keyPath, depth) {
        i++;
        ws();
        if (text[i] === ']') { i++; return; }
        for (let index = 0; ; index++) {
            value(`${keyPath}[${index}]`, depth + 1);
            ws();
            if (text[i] === ',') { i++; continue; }
            if (text[i] === ']') { i++; return; }
            fail();
        }
    }

    try {
        value(base, 0);
        ws();
        return i >= n;
    } catch {
        // Malformed, truncated, or over budget. Whatever was emitted before
        // this point came from well-formed input, so the caller keeps it: HAR
        // bodies are truncated in the field, and the paths resolved before the
        // cut are the ones an operator would otherwise have to find by hand.
        return false;
    }
}

/**
 * Walk `text` as a JSON body if it is one, emitting `(keyPath, scalarText)`.
 *
 * Returns true when a structural walk ran at all -- which is not the same as
 * having parsed cleanly. A caller uses this only for PRECISION; the raw-text
 * pass is what decides whether anything is reported.
 */
function walkJsonBody(text, base, emit) {
    if (typeof text !== 'string' || text.length === 0) return false;
    if (text.length > STRUCTURAL_LIMITS.maxChars) return false;

    let start = 0;
    while (start < text.length && ' \t\n\r'.includes(text[start])) start++;
    if (start >= text.length) return false;

    const budget = { nodes: 0 };
    if (text[start] === '{' || text[start] === '[') {
        scanJsonSource(text, start, base, emit, budget, 0);
        return true;
    }

    // A body behind an anti-hijacking prefix -- `for (;;);`, `)]}'`, `while(1);`
    // -- is ordinary armour on a JSON API and is not JSON at offset zero, so a
    // walk anchored there resolves nothing for every response the provider
    // sends. Starting further in is a GUESS, though, so unlike the anchored
    // case it must parse end to end before its paths are believed: applied to
    // prose or markup that merely contains a brace, a partial parse would
    // attach confident-looking key paths to nothing.
    const guess = text.indexOf('{', start) >= 0 && text.indexOf('{', start) < STRUCTURAL_LIMITS.prefixScanChars
        ? text.indexOf('{', start)
        : (text.indexOf('[', start) >= 0 && text.indexOf('[', start) < STRUCTURAL_LIMITS.prefixScanChars
            ? text.indexOf('[', start) : -1);
    if (guess < 0) return false;

    const buffered = [];
    if (!scanJsonSource(text, guess, base, (p, v) => buffered.push([p, v]), budget, 0)) return false;
    for (const [p, v] of buffered) emit(p, v);
    return true;
}

/**
 * Scan one string, structurally where it can be and as text where it cannot.
 *
 * A body that parses as JSON is walked so every finding carries a real key
 * path. A body that does not -- HTML, a minified JS asset, a multipart blob --
 * is still scanned as text, because those carry reverse-engineerable protocol
 * constants and skipping them by content type is the "scrub by size, not
 * sensitivity" mistake the issue calls out.
 */
function scanString(text, keyPath, policy, push) {
    if (typeof text !== 'string' || text === '') return;

    // Three passes over one string, each seeing something the others cannot.
    // The hard part is counting: the passes overlap, so a naive "report each
    // fingerprint once" collapses two GENUINE occurrences of a value as
    // readily as it collapses one occurrence seen twice. The count is what an
    // operator reads to judge blast radius -- one stray echo versus the same
    // value in fifty places -- so it has to come from one authoritative pass
    // rather than from whatever the passes happen to agree on.
    //
    // The raw text is that authority: it is the actual bytes, and every
    // occurrence in it is a real occurrence. The structural pass contributes
    // PRECISION, not counts.

    // 1. Structural, for location. Records the key path of the first leaf
    //    carrying each value; pushes nothing yet.
    //
    //    Every path is recorded, not merely the first. The same value at two
    //    different keys is two occurrences and the two keys may not agree:
    //    `{"media_id": X, "billing": {"card_number": X}}` is downgraded by the
    //    first and must not be by the second, and keeping only the first key
    //    would decide the whole finding on whichever the serialiser happened
    //    to write earlier. The list is capped, because a value echoed a
    //    thousand times must not cost a thousand strings.
    const pathFor = new Map();
    walkJsonBody(text, keyPath, (p, s) => {
        if (s.length < STRUCTURAL_LIMITS.minScalarChars) return;
        for (const l of findLeaks(s, policy)) {
            const key = `${l.kind}:${l.fingerprint}`;
            const found = pathFor.get(key);
            if (!found) { pathFor.set(key, { paths: [p], leak: l }); continue; }
            if (found.paths.length < STRUCTURAL_LIMITS.maxPathsPerValue) found.paths.push(p);
        }
    });

    // 2. The RAW TEXT, always -- never gated on whether the structural pass
    //    ran. Reading a body only through `JSON.parse` trusts the parser to be
    //    a faithful copy of the wire, and it is not: a numeric literal past
    //    2^53 comes back with its tail rounded off, which is every card length
    //    above 16 digits, and the rounded value fails Luhn. Quoting, escaping
    //    and numeric precision are all invisible to a regex over the original
    //    bytes, which is why the sweep this replaced saw these and why it
    //    still runs. Every match here is one occurrence.
    //
    //    The structural pass walks the same bytes left to right, so its k-th
    //    sighting of a value is the k-th occurrence here; the paths are handed
    //    out in that order. Past the end of the list -- or with no structural
    //    pass at all -- the occurrence falls back to the body node, which is
    //    what this reported for every finding before key paths existed.
    const rawSeen = new Set();
    const taken = new Map();
    for (const l of findLeaks(text, policy)) {
        const key = `${l.kind}:${l.fingerprint}`;
        rawSeen.add(key);
        const located = pathFor.get(key);
        const nth = taken.get(key) || 0;
        taken.set(key, nth + 1);
        push(l, located && nth < located.paths.length ? located.paths[nth] : keyPath, null);
    }

    // 3. Anything the structural pass found that the raw bytes did not -- a
    //    value spelled with JSON escapes, say, which is one occurrence the
    //    regex over the source text cannot match.
    for (const [key, { paths, leak }] of pathFor) {
        if (!rawSeen.has(key)) for (const at of paths) push(leak, at, null);
    }

    // 4. The percent-decoded view. A secret inside `variables=<encoded JSON>`
    //    is spelled `%22` and `%40` on the wire, so no pattern reaches it
    //    otherwise -- this is the layer the real `fb_dtsg` leak hid in. The
    //    decoded offset sits inside a string rather than at a JSON key, so it
    //    has no structural path of its own; the enclosing node is named
    //    instead. Only values the plain passes missed: the decoded view is a
    //    second reading of the SAME bytes, not a second occurrence.
    const shadow = decodedShadow(text);
    if (shadow !== text) {
        for (const l of findLeaks(shadow, policy)) {
            const key = `${l.kind}:${l.fingerprint}`;
            if (rawSeen.has(key) || pathFor.has(key)) continue;
            rawSeen.add(key);
            push(l, null, keyPath);
        }
    }
}

/**
 * The field name that DIRECTLY holds a value, from its key path.
 *
 * Array subscripts are stripped, so `media_ids[4]` is held by `media_ids` --
 * an element has no key of its own and the field holding it is the array.
 * Returns null when the path names no field.
 */
function enclosingFieldName(keyPath) {
    if (typeof keyPath !== 'string' || keyPath === '') return null;
    const withoutIndices = keyPath.replace(/(\[\d+\])+$/, '');
    const dot = withoutIndices.lastIndexOf('.');
    const name = dot === -1 ? withoutIndices : withoutIndices.slice(dot + 1);
    return name === '' ? null : name;
}

/**
 * Is this finding an identity value sitting in a field declared to hold ids?
 *
 * THE SCOPE OF THIS IS THE WHOLE POINT, so it is stated once, here, rather
 * than left to each caller:
 *
 *   * IDENTITY class only. A card-shaped digit run at `media_id` is a card in
 *     the same sense that ~10% of all digit runs are.
 *   * SECRET class never. A high-entropy token under a field called
 *     `session_id` is a session token, and suppressing it because the key ends
 *     in `_id` would be a false negative of exactly the kind this gate exists
 *     to prevent. Entropy is evidence of secret-ness; a field name does not
 *     argue it away.
 *   * A RESOLVED key path only. A percent-decoded finding has no structural
 *     path; reading the enclosing HAR node's name instead would downgrade on
 *     no evidence at all.
 */
function isIdentifierShaped(leak, keyPath, policy) {
    if (!policy || leak.class !== 'identity') return false;
    const field = enclosingFieldName(keyPath);
    return field !== null && harPolicy.isIdentifierField(policy, field);
}

/**
 * Does a finding FAIL the run?
 *
 * One definition, because both verifiers ask the question and two copies of it
 * is how the gate on the committed reference ends up weaker than the gate on
 * the intermediate it came from.
 *
 *   gate       yes -- the whole point.
 *   advise     yes, FOR NOW; the design's end state pairs a non-zero exit with
 *              a surviving artifact, and the quarantine that makes that safe
 *              has not landed.
 *   off        no -- the project disabled the class.
 *   waived     no -- a waiver that did not stop the failure would be decoration.
 *   identifier no -- the field is declared to hold ids. Identity class only.
 *
 * None of these REMOVE the finding. A loosening that made findings disappear
 * would be an invisible one, and invisible loosenings are how this gate lost
 * its authority in the first place.
 */
function blocksLeak(leak) {
    if (leak.waived) return false;
    if (leak.setting === 'off') return false;
    if (leak.identifierField) return false;
    return true;
}

/**
 * Find leaks in a PARSED HAR, with a location on every finding.
 *
 * Returns one finding per (kind, fingerprint) -- 1413 identical findings is
 * not 1413 problems, and a wall of them is what taught readers to ignore the
 * gate. Each carries the FIRST place it was seen plus an occurrence `count`.
 *
 * A location is not a secret. Only the value is, and none is ever included.
 */
function findLeaksInHar(har, policy) {
    const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : [];
    const grouped = new Map();

    entries.forEach((entry, entryIndex) => {
        if (!entry || typeof entry !== 'object') return;
        const push = (leak, keyPath, enclosing) => {
            const key = `${leak.kind}:${leak.fingerprint}`;
            const identifierField = isIdentifierShaped(leak, keyPath, policy);
            const existing = grouped.get(key);
            if (existing) {
                existing.count++;
                // One occurrence at an id field does not make the VALUE an id.
                // The same digits echoed at `card_number` are evidence the
                // field-name downgrade was wrong, so the finding is promoted
                // back and re-located to the occurrence that earned it.
                if (existing.identifierField && !identifierField) {
                    existing.identifierField = false;
                    existing.gating = !existing.waived && existing.setting === 'gate';
                    existing.entryIndex = entryIndex;
                    existing.keyPath = keyPath;
                    existing.enclosing = enclosing;
                }
                return;
            }
            grouped.set(key, Object.assign({}, leak, {
                entryIndex,
                keyPath,
                enclosing,
                identifierField,
                gating: leak.gating && !identifierField,
                count: 1,
            }));
        };
        collectEntryStrings(entry, (keyPath, text) => scanString(text, keyPath, policy, push));
    });

    return [...grouped.values()];
}

module.exports = {
    LEAK_PATTERNS,
    STRUCTURAL_LIMITS,
    findLeaksInHar,
    blocksLeak,
    walkJsonBody,
    enclosingFieldName,
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
