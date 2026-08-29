#!/usr/bin/env node
/**
 * sanitize-har.js -- deterministic HAR scrubber for the web-api-discovery agent.
 *
 * Reads a captured HAR file, redacts secrets / PII, and writes a scrubbed
 * HAR plus a hash -> fake substitution map. The substitution table is
 * HMAC-SHA256-keyed by the project salt so the same original value
 * always maps to the same fake within a project. Format-preserving:
 * an email becomes a fake email, a 64-char hex token becomes a 64-char
 * fake hex string, etc.
 *
 * The substitution tables are NOT an output artifact. Their keys are the
 * plaintext values the scrub replaced, so a table is a reverse lookup of live
 * credentials; they default beside the raw capture in the gitignored
 * `.har-captures/` tree and never into the scrubbed output path (issue #294).
 *
 * Scrubbing is TWO controls, not one:
 *
 *   1. Key-name scrubbing -- shape patterns plus the known-secret field and
 *      header lists. It reaches inside percent-encoded parameters, because
 *      per-request tokens routinely live in a nested JSON blob whose own key
 *      never appears in the form's parameter list.
 *   2. Literal-value scrubbing -- the operator's own identifiers (account id,
 *      display name, email), applied LAST over the serialized HAR so one
 *      sweep covers URLs, headers, request bodies and response bodies.
 *
 * Control 1 can only redact values whose NAME somebody anticipated. Control 2
 * covers the same value appearing under a name nobody knew about. Neither
 * substitutes for the other.
 *
 * The salt and the literal map come from the gitignored `.har-profile.json`
 * (see har-profile.js). They are never defaulted: the literals are the
 * operator's own identifiers, and an absent profile is a hard failure.
 *
 * Usage:
 *   node sanitize-har.js --in <input.har>
 *
 * Exit codes:
 *   0  -- scrubbed HAR + subs map written successfully
 *   1  -- I/O, parse, or profile error
 *   2  -- usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pii = require(path.join(__dirname, 'pii.js'));
const harProfile = require(path.join(__dirname, 'har-profile.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));

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

// The substitution tables are keyed by the plaintext values the scrub
// replaced, which makes each one a reverse lookup table of live credentials.
// They are recorder state, not a deliverable, so they never default into the
// output path -- the directory the operator has been told holds scrubbed,
// verified artifacts and which is tracked by git (issue #294).
const LEGACY_SUBS_FILENAME = '.har-substitutions.json';
const PII_SUBS_FILENAME = '.substitutions.json';
const CAPTURES_DIR = '.har-captures';

/**
 * Where a substitution table goes when the caller did not say.
 *
 * The raw capture is confined to `.har-captures/` by construction and no
 * option redirects it, so the session directory the input came from is both
 * gitignored and already holds the only other file keyed to these values.
 * When the input is not a raw capture -- the documented `samples/har-original/`
 * layout, say -- there is no session directory to use, so the tables go under
 * a `.har-captures/` beside the input instead. The synced .gitignore block
 * matches that name at any depth, so the containment holds either way.
 *
 * What is never used: the output directory. That is the whole point.
 */
function deriveSubsDir(inPath) {
    const dir = path.dirname(path.resolve(inPath));
    const segments = dir.split(path.sep);
    if (segments.includes(CAPTURES_DIR)) return dir;
    return path.join(dir, CAPTURES_DIR);
}

function usage() {
    console.error([
        'usage: node sanitize-har.js --in <in.har>',
        '  --out        default: the input path with samples/har-original/ -> samples/har/',
        `  --subs       default: <captures-dir>/${LEGACY_SUBS_FILENAME} (never the output path)`,
        `  --pii-subs   default: <captures-dir>/${PII_SUBS_FILENAME} (never the output path)`,
        `                <captures-dir> is the ${CAPTURES_DIR} session directory the input`,
        `                came from, else a ${CAPTURES_DIR}/ beside it -- gitignored either way`,
        `  --profile    default: nearest ${harProfile.PROFILE_FILENAME} at or above the working directory`,
        '  --fixed-time determinism for tests',
    ].join('\n'));
    process.exit(2);
}

// Conventional layout: the raw capture lives in samples/har-original/ and the
// scrubbed copy in samples/har/ (see the web-api-discovery skill, Phase 3).
// Deriving the output from that convention keeps three required flags off the
// command line without guessing.
function deriveOutPath(inPath) {
    const resolved = path.resolve(inPath);
    const parts = resolved.split(path.sep);
    const i = parts.lastIndexOf('har-original');
    if (i >= 0) {
        parts[i] = 'har';
        return parts.join(path.sep);
    }
    return path.join(path.dirname(resolved), path.basename(resolved, '.har') + '.scrubbed.har');
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
    // Bounded local part / domain: an unbounded `[chars]+@` backtracks
    // quadratically over a long non-matching run (see pii.js RE.email).
    { kind: 'email',  re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g },
    { kind: 'uuid',   re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
    { kind: 'hex64',  re: /\b[0-9a-fA-F]{64}\b/g },
    { kind: 'hex32',  re: /\b[0-9a-fA-F]{32}\b/g },
];

// Field/header names that are secrets by identity, not by shape (issue #253).
// These are short, non-hex, non-JWT tokens (CSRF/session-signing values,
// upload handles) that the shape-based PATTERNS above never match, so they
// need to be redacted by name instead. The lists live in har-secrets.js so
// the verifiers gate on exactly the names the scrubber redacts.
const {
    KNOWN_SECRET_FIELD_NAMES,
    KNOWN_SECRET_HEADER_NAMES,
    isKnownSecretField,
    replaceMultipartSecretFields,
} = require(path.join(__dirname, 'har-secrets.js'));

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

// A form-encoded body or query string worth DECODING: `k=v` pairs that
// actually carry percent escapes. Without an escape there is nothing hidden
// -- key-name scrubbing already sees the value on the wire -- and decoding
// anyway would rewrite the value's spelling for no gain.
//
// A `; `-separated string is a Cookie header, not a form body; it has its own
// scrubber and must keep its separators intact.
function looksFormEncoded(s) {
    return /%[0-9A-Fa-f]{2}/.test(s)
        && !/;\s/.test(s)
        && /^[^=&\s{[\]}"]+=[^&]*(?:&|$)/.test(s);
}

const MAX_DECODE_DEPTH = 3;

function scrubString(s, subs, salt, depth) {
    if (typeof s !== 'string' || s.length === 0) return s;
    const level = depth || 0;
    let out = scrubKnownFields(s, subs, salt);

    // Multipart bodies carry the field name in a header and the value on its
    // own line, so the `name=value` and `"name":"value"` forms above never
    // see them.
    out = replaceMultipartSecretFields(out, (name, value) => {
        const key = `field:${name.toLowerCase()}:${value}`;
        if (!subs[key]) subs[key] = fakeFor('field', value, salt);
        return subs[key];
    });

    // Reach INSIDE percent-encoded parameters. A form body carrying
    // `variables=<percent-encoded JSON>` hides per-request tokens where no
    // flat pattern over the wire body can match them, and where the inner key
    // never appears in the form's own parameter list.
    if (level < MAX_DECODE_DEPTH && looksFormEncoded(out)) {
        out = harLiterals.transformEncodedParams(out, (_name, decoded) =>
            scrubString(decoded, subs, salt, level + 1));
    }

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

// The HAR spec lets `cookies[]` and the `Cookie` header diverge, and the
// 16-char-or-known-name heuristic only ever ran over header text. A session
// cookie present only in the structured array was missed by the scrubber and
// by every gate downstream of it.
function scrubCookieArray(cookies, subs, salt) {
    if (!Array.isArray(cookies)) return cookies;
    for (const c of cookies) {
        if (!c || typeof c.value !== 'string' || typeof c.name !== 'string') continue;
        if (c.value.length < 16 && !isKnownSecretField(c.name)) continue;
        const key = `cookie:${c.name.toLowerCase()}:${c.value}`;
        if (!subs[key]) subs[key] = fakeFor('cookie', c.value, salt);
        c.value = subs[key];
    }
    return cookies;
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
            } else if (k === 'cookies') {
                node[k] = scrubCookieArray(node[k], subs, salt);
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
    if (!args.in) usage();

    let profile;
    try {
        profile = harProfile.loadProfile({ profilePath: args.profile });
    } catch (e) {
        console.error(`sanitize-har: ${e.message}`);
        process.exit(1);
    }
    const salt = profile.salt;

    const outPath = args.out || deriveOutPath(args.in);
    const outDir = path.dirname(outPath);
    const subsDir = deriveSubsDir(args.in);
    const subsPath = args.subs || path.join(subsDir, LEGACY_SUBS_FILENAME);
    const piiSubsPath = args['pii-subs'] || path.join(subsDir, PII_SUBS_FILENAME);

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
    walk(har, subs, salt);

    // Typed-PII pass (issue #46): runs after legacy regex scrub so that
    // anything still in the HAR (emails in custom-named fields, phones,
    // SSNs, credit-cards, IPs, plus context-driven name/address/dob/geo)
    // gets a deterministic, obviously-fake replacement. The returned
    // substitutions array contains only hash prefixes of originals so the
    // file is safe to commit.
    const piiResult = pii.scrubPii(har);

    // Literal-value pass runs LAST, over the SERIALIZED document, so a single
    // sweep covers URLs, headers, request bodies and response bodies -- the
    // same identifier under three different names is one replacement, not
    // three key-list entries somebody has to know about in advance.
    const serialized = JSON.stringify(har, null, 2);
    const literalPass = harLiterals.applyLiteralPass(serialized, profile.literals);

    // Merge rather than overwrite: the substitution table is the project's
    // running hash -> fake map, and a second capture must not erase the first.
    let existingSubs = {};
    if (fs.existsSync(subsPath)) {
        try {
            existingSubs = JSON.parse(fs.readFileSync(subsPath, 'utf8'));
        } catch {
            existingSubs = {};
        }
    }
    const merged = Object.assign({}, existingSubs, subs);
    // Stable key order in output JSON for byte-for-byte determinism.
    const sortedSubs = {};
    for (const k of Object.keys(merged).sort()) sortedSubs[k] = merged[k];

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, literalPass.text, 'utf8');
    // The tables no longer share a directory with the output, and an explicit
    // --subs / --pii-subs may point anywhere, so each parent is created on its
    // own rather than assumed to exist.
    fs.mkdirSync(path.dirname(subsPath), { recursive: true });
    fs.writeFileSync(subsPath, JSON.stringify(sortedSubs, null, 2), 'utf8');

    const createdAt = args['fixed-time'] || new Date().toISOString();
    fs.mkdirSync(path.dirname(piiSubsPath), { recursive: true });
    fs.writeFileSync(piiSubsPath, JSON.stringify({
        version: 1,
        createdAt,
        substitutions: piiResult.substitutions
    }, null, 2), 'utf8');

    // Hit counts name the sentinel only. Echoing the literal would relocate
    // the leak into the log that reports it.
    const literalSummary = literalPass.hits.length
        ? literalPass.hits.map((h) => `${h.sentinel} x${h.count}`).join(', ')
        : 'none matched';
    console.log(
        `sanitize-har: wrote ${outPath} ` +
        `(${Object.keys(subs).length} legacy + ${piiResult.substitutions.length} typed-PII ` +
        `substitutions; literals: ${literalSummary})`);
    process.exit(0);
}

main();

