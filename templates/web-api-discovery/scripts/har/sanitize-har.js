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
 * That default is verified rather than assumed: git is asked whether the
 * destination is actually ignored, and the run is refused when it is not
 * (issue #318).
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
 * The names control 1 acts on come from the MERGED policy (har-policy.js) --
 * the same document the two verifiers gate on. That is not a tidiness point:
 * while the scrubber kept its own view of the names and of where they live, it
 * covered one spelling of each datum and the gate covered the other, so a
 * capture the pipeline called "scrubbed" carried live session credentials in
 * the structural nodes (`postData.params[]`, `queryString[]`, the `Cookie`
 * header) while their raw twins held sentinels (issue #297).
 *
 * HAR stores the same datum twice, so every redaction decision here is a pure
 * function of (name, value) and the policy: both copies are replaced, with the
 * same fake, or neither is. What a value LOOKS like never exempts it from the
 * scrub -- a live credential that arrives already looking masked is still a
 * live credential (see `alreadySubstituted`).
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
const harPolicy = require(path.join(__dirname, 'har-policy.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));
const subsDestination = require(path.join(__dirname, 'subs-destination.js'));

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
//
// The filenames themselves live in subs-destination.js, not here -- that
// module is the one place both this script (which writes the tables) and
// capture-store.js (which, for #387, only needs to ask whether one exists)
// can safely `require()`. This file cannot be required as a library itself:
// its `main()` runs unconditionally at the bottom with no `require.main`
// guard, so requiring it would run a scrub. Keeping the names in the
// dependency-free module both sides already share is what keeps this a single
// definition instead of two that can drift.
const { LEGACY_SUBS_FILENAME, PII_SUBS_FILENAME } = subsDestination;
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
 *
 * This function picks a destination by NAME, which is a proposal and not a
 * guarantee -- `.har-captures` is only gitignored where a `.gitignore` says
 * so. Whether the proposal is safe is a separate question, answered by
 * subs-destination.js before anything is written (issue #318).
 */
function deriveSubsDir(inPath) {
    const dir = path.dirname(path.resolve(inPath));
    const segments = dir.split(path.sep);
    if (segments.includes(CAPTURES_DIR)) return dir;
    return path.join(dir, CAPTURES_DIR);
}

/**
 * Refuse any derived table destination git will not confirm is ignored.
 *
 * Only *derived* destinations are gated. An explicit --subs / --pii-subs is a
 * deliberate act by an operator who has said where the table goes, and both
 * extract-har-reference.js and run-agent.js rely on it to write into a temp
 * working directory outside any repository which they then delete.
 *
 * This runs before the input is read and before --out is written, so a refused
 * run leaves the filesystem exactly as it found it.
 */
function assertDerivedDestinationsProtected(candidates) {
    for (const { path: dest, flag, derived } of candidates) {
        if (!derived) continue;
        const status = subsDestination.classifyDestination(dest);
        const message = subsDestination.refusalMessage(dest, status, flag);
        if (!message) continue;
        console.error(`sanitize-har: ${message}`);
        process.exit(1);
    }
}

function usage() {
    console.error([
        'usage: node sanitize-har.js --in <in.har>',
        '  --out        default: the input path with samples/har-original/ -> samples/har/',
        `  --subs       default: <captures-dir>/${LEGACY_SUBS_FILENAME} (never the output path)`,
        `  --pii-subs   default: <captures-dir>/${PII_SUBS_FILENAME} (never the output path)`,
        `                <captures-dir> is the ${CAPTURES_DIR} session directory the input`,
        `                came from, else a ${CAPTURES_DIR}/ beside it. A derived destination is`,
        '                verified gitignored before use and the run is refused otherwise;',
        '                an explicit --subs / --pii-subs is taken as deliberate and is not.',
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
// The password-envelope fake keeps the envelope's four-token shape and marks
// itself with a label, version and timestamp the real format never emits.
const PWD_ENVELOPE_FAKE_PREFIX = '#PWD_REDACTED:0:0:'; // -> 24 hex chars follow

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
        // A client-side password envelope (issue #407). FORMAT-PRESERVING,
        // like `upload-handle`: a consumer that parses the field still sees
        // the four tokens it expects, so the scrubbed capture keeps the shape
        // of the original instead of turning into a bare marker.
        //
        // The three literal tokens are the fake SENTINEL, and the LABEL is what
        // carries it: `REDACTED` is not a product, and the label is the product
        // (`BROWSER`, `INSTAGRAM_BROWSER`, `MSGR`). Version `0` and epoch `0`
        // are supporting, not load-bearing alone -- #378 measured a real
        // envelope at version `0`, and the tests carry one.
        // `isFake` in har-shapes.js keys on exactly this spelling --
        // without it the gate would re-report the scrubber's own redaction on
        // every run, forever, which is the failure the `hex64` / `hex32`
        // sentinels exist to prevent.
        //
        // The tail is 24 hex chars, NOT 32 or 64, on purpose: a 32-hex tail
        // would be matched by the `hex32` rule later in this same PATTERNS
        // sweep and rewritten, so the sentinel this file emits and the one
        // har-shapes.js exempts would disagree about the scrubber's own output.
        case 'pwd-envelope': return `${PWD_ENVELOPE_FAKE_PREFIX}${h.slice(0, 24)}`;
        default:        return `<REDACTED-${h.slice(0, 8)}>`;
    }
}

// Patterns ordered most-specific first so JWTs match before hex64.
const PATTERNS = [
    // A client-side password envelope, `#PWD_<LABEL>:<v>:<unix>:<base64>`
    // (issue #407). FIRST because it is the most specific rule here: it is
    // self-identifying, so a match is evidence rather than an estimate, and
    // letting a later rule bite a hex-looking run out of its ciphertext would
    // leave the envelope's own prefix standing in the output.
    //
    // Shape-scrubbed rather than name-scrubbed for the same reason the gate
    // is: the name control loses this value the moment a provider renames the
    // field or the envelope travels as a bare form parameter, and those are
    // exactly the captures a name list cannot be written for in advance.
    // Without this entry the gate (issue #395) BLOCKS such a capture with no
    // automatic remedy at all -- a correct refusal with no route out.
    { kind: 'pwd-envelope', re: /#PWD_[A-Z0-9_]{1,40}:\d{1,4}:\d{1,14}:[A-Za-z0-9+/_=-]{4,}/g },
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
// need to be redacted by name instead.
//
// The names are DATA, and they come from the MERGED policy -- the same
// `loadPolicy` the two verifiers call -- not from a second list this file
// keeps. Sourcing them anywhere else is how the scrubber and the gate drifted:
// stage 4.3 moved the gate onto the policy and left the scrubber reading the
// shipped defaults, so a name a consuming project ADDED was gated by the
// verifiers and never redacted by the scrubber (issue #297).
const {
    isKnownSecretField,
    isKnownSecretHeader,
    replaceMultipartSecretFields,
} = require(path.join(__dirname, 'har-secrets.js'));

/**
 * The scrub context: the merged policy, the salt, the running substitution
 * table, and the field patterns compiled from the policy's names.
 *
 * It is one object rather than four parameters because every scrub function
 * needs the policy now, and a `policy` that some call sites forget to pass is
 * exactly the drift this change exists to remove.
 */
function createContext(policy, subs, salt) {
    // Escaped alternation of known secret field names, used to catch them by
    // identity inside form-encoded bodies (`fb_dtsg=...&lsd=...`) and inline
    // JSON text (`"lsd":"..."`) -- shapes that PATTERNS never matches because
    // these values are short and neither hex- nor JWT-shaped.
    const alternation = policy.secretFields
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    return {
        policy,
        subs,
        salt,
        // Every fake this run has emitted. Membership here is the ONLY reason
        // the scrub skips a value -- see `alreadySubstituted`.
        produced: new Set(),
        formFieldRe: new RegExp(`\\b(${alternation})=([^&\\s"';,]+)`, 'gi'),
        jsonFieldRe: new RegExp(`("(?:${alternation})"\\s*:\\s*")([^"]*)(")`, 'gi'),
    };
}

// One substitution per (kind, name, value), so the SAME datum spelled two ways
// -- `postData.text` and `postData.params[]`, the `Cookie` header and
// `request.cookies[]` -- resolves to the same fake. Both copies scrubbed, to
// the same sentinel, or neither.
function substitute(kind, name, value, ctx) {
    const key = `${kind}:${name.toLowerCase()}:${value}`;
    if (!ctx.subs[key]) ctx.subs[key] = fakeFor(kind, value, ctx.salt);
    ctx.produced.add(ctx.subs[key]);
    return ctx.subs[key];
}

/**
 * True only for a value THIS run already emitted as a replacement.
 *
 * An IDENTITY test, never a shape test. The scrub must run over some nodes
 * twice -- a `Cookie` header is scrubbed pair by pair and then swept again as
 * text -- and without suppression the header's fake would be replaced by a
 * second, different fake, so the two spellings of one cookie would stop
 * agreeing. That is the whole and only job here.
 *
 * It is emphatically NOT `isRedacted(value)`. Asking whether an INPUT value
 * looks like a redaction marker hands the decision to the data: a live
 * credential that arrives as `REDACTED_SESSION_TOKEN_...`, wrapped in angle
 * brackets, or spelled `***` would be skipped and shipped in the clear, under
 * a name the policy says is a secret. That is a scrub bypass an upstream can
 * trigger, in the false-negative direction, which is the direction that ships.
 * `isRedacted` is the right question for the GATE, which must not cry wolf
 * over our own sentinels; it is the wrong question for the SCRUBBER, which is
 * looking at data it has not replaced yet.
 */
function alreadySubstituted(value, ctx) {
    return ctx.produced.has(value);
}

/**
 * The replacement for a `name=value` pair whose NAME is a known secret, or
 * null to leave it alone.
 *
 * Deliberately the same predicate the gate uses (`isKnownSecretField` /
 * `isKnownSecretHeader` over the merged policy), so the scrubber redacts
 * exactly what the verifiers would report. Nothing about the value's SHAPE
 * exempts it -- only a fake this run itself produced is passed over.
 */
function fieldReplacement(name, value, ctx) {
    if (typeof name !== 'string' || typeof value !== 'string' || value === '') return null;
    if (alreadySubstituted(value, ctx)) return null;
    if (!isKnownSecretField(name, ctx.policy) && !isKnownSecretHeader(name, ctx.policy)) return null;
    return substitute('field', name, value, ctx);
}

function scrubKnownFields(s, ctx) {
    let out = s.replace(ctx.formFieldRe, (m, name, val) => {
        if (alreadySubstituted(val, ctx)) return m;
        return `${name}=${substitute('field', name, val, ctx)}`;
    });
    out = out.replace(ctx.jsonFieldRe, (m, pre, val, post) => {
        if (val === '' || alreadySubstituted(val, ctx)) return m;
        return `${pre}${substitute('field', pre, val, ctx)}${post}`;
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

function scrubString(s, ctx, depth) {
    if (typeof s !== 'string' || s.length === 0) return s;
    const level = depth || 0;
    let out = scrubKnownFields(s, ctx);

    // Multipart bodies carry the field name in a header and the value on its
    // own line, so the `name=value` and `"name":"value"` forms above never
    // see them.
    // `includeRedacted: true`: a multipart value that merely looks masked is
    // still scrubbed. Our own output is passed over by identity instead.
    out = replaceMultipartSecretFields(out, (name, value) =>
        (alreadySubstituted(value, ctx) ? null : substitute('field', name, value, ctx)),
        ctx.policy, { includeRedacted: true });

    // Reach INSIDE percent-encoded parameters. A form body carrying
    // `variables=<percent-encoded JSON>` hides per-request tokens where no
    // flat pattern over the wire body can match them, and where the inner key
    // never appears in the form's own parameter list.
    if (level < MAX_DECODE_DEPTH && looksFormEncoded(out)) {
        out = harLiterals.transformEncodedParams(out, (_name, decoded) =>
            scrubString(decoded, ctx, level + 1));
    }

    for (const { kind, re } of PATTERNS) {
        out = out.replace(re, (match) => {
            const key = `${kind}:${match}`;
            if (!ctx.subs[key]) ctx.subs[key] = fakeFor(kind, match, ctx.salt);
            return ctx.subs[key];
        });
    }
    return out;
}

// A cookie is worth redacting when its value looks token-ish (16+ chars) OR
// its name is a known secret -- session cookies like `mid` / `sb` can be short.
const COOKIE_TOKEN_MIN_LENGTH = 16;

/**
 * The replacement for one cookie, or null to leave it alone.
 *
 * The ONE decision, shared by `request.cookies[]`, `response.cookies[]`, the
 * `Cookie` header and the `Set-Cookie` header. It is a pure function of the
 * cookie's name and value, which is what makes "both copies scrubbed or
 * neither" true by construction rather than by two heuristics happening to
 * agree -- they did not: the header scrub stopped its value match at a comma,
 * so a comma-bearing session cookie was scrubbed in the array and left live
 * in the header carrying the same datum.
 */
function cookieReplacement(name, value, ctx) {
    if (typeof name !== 'string' || typeof value !== 'string' || value === '') return null;
    if (alreadySubstituted(value, ctx)) return null;
    if (value.length < COOKIE_TOKEN_MIN_LENGTH
        && !isKnownSecretField(name, ctx.policy)
        && !isKnownSecretHeader(name, ctx.policy)) return null;
    return substitute('cookie', name, value, ctx);
}

/**
 * Scrub the cookie pairs of a `Cookie` or `Set-Cookie` header.
 *
 * Split on `;`, which is what actually separates the pairs, rather than
 * matching `name=value` with a character class that excludes commas: a cookie
 * value legitimately contains commas (and `=`), and the old pattern truncated
 * such a value to the fragment before the comma, measured the fragment against
 * the 16-character threshold, and left the whole cookie in the clear.
 *
 * `Set-Cookie` carries exactly one pair, in the first segment; everything after
 * it is an attribute (`Path`, `Domain`, `Expires`, ...). Attributes are
 * protocol documentation, not credentials, so they are left alone -- the old
 * scrub replaced any attribute whose value ran to 16 characters, which
 * corrupted `Domain` and told the reader nothing.
 */
function scrubCookieHeader(value, ctx, singlePair) {
    if (typeof value !== 'string') return value;
    const segments = value.split(';');
    const last = singlePair ? Math.min(1, segments.length) : segments.length;
    for (let i = 0; i < last; i++) {
        const segment = segments[i];
        const eq = segment.indexOf('=');
        if (eq < 0) continue;
        const rawName = segment.slice(0, eq);
        const rawValue = segment.slice(eq + 1);
        const name = rawName.trim();
        const leading = /^\s*/.exec(rawValue)[0];
        const trailing = /\s*$/.exec(rawValue)[0];
        const cookieValue = rawValue.slice(leading.length, rawValue.length - trailing.length);
        const replacement = cookieReplacement(name, cookieValue, ctx);
        if (replacement === null) continue;
        segments[i] = `${rawName}=${leading}${replacement}${trailing}`;
    }
    return segments.join(';');
}

// The HAR spec lets `cookies[]` and the `Cookie` header diverge, and the
// 16-char-or-known-name heuristic only ever ran over header text. A session
// cookie present only in the structured array was missed by the scrubber and
// by every gate downstream of it.
function scrubCookieArray(cookies, ctx) {
    if (!Array.isArray(cookies)) return cookies;
    for (const c of cookies) {
        if (!c || typeof c.value !== 'string' || typeof c.name !== 'string') continue;
        const replacement = cookieReplacement(c.name, c.value, ctx);
        if (replacement !== null) c.value = replacement;
    }
    return cookies;
}

/**
 * Scrub the structural `{ name, value }` arrays: `request.queryString[]` and
 * `request.postData.params[]`.
 *
 * These are the OTHER half of data the scrubber already handled in its raw
 * spelling. `postData.text` was scrubbed by name and `postData.params[]` was
 * not, so on a real capture the same secret appeared twice in one entry: a
 * sentinel in the text and the live value in the parameter list. The query
 * string had no raw twin at all and was simply never scrubbed by name.
 *
 * The generic walk still runs over each pair afterwards, so shapes and
 * percent-encoded payloads inside a parameter keep exactly today's treatment.
 */
function scrubNameValuePairs(pairs, ctx) {
    if (!Array.isArray(pairs)) return walk(pairs, ctx);
    for (const pair of pairs) {
        if (pair && typeof pair === 'object' && !Array.isArray(pair)) {
            const replacement = fieldReplacement(pair.name, pair.value, ctx);
            if (replacement !== null) pair.value = replacement;
        }
        walk(pair, ctx);
    }
    return pairs;
}

function scrubHeaders(headers, ctx) {
    if (!Array.isArray(headers)) return headers;
    for (const h of headers) {
        if (!h || typeof h.value !== 'string') continue;
        const lname = (h.name || '').toLowerCase();
        if (lname === 'cookie' || lname === 'set-cookie') {
            h.value = scrubCookieHeader(h.value, ctx, lname === 'set-cookie');
        }
        if (lname === 'authorization') {
            // Replace bearer-style: "Bearer <token>"
            h.value = h.value.replace(/Bearer\s+(\S+)/i, (_m, tok) => {
                const key = `bearer:${tok}`;
                if (!ctx.subs[key]) ctx.subs[key] = `Bearer ${fakeFor('hex64', tok, ctx.salt).slice(0, 40)}`;
                return ctx.subs[key];
            });
        }
        // A header whose NAME is a secret, by either list. The verifiers test a
        // name/value pair against both, so the scrubber does too: a name on one
        // list and not the other would be gated and never redacted.
        const replacement = fieldReplacement(lname, h.value, ctx);
        if (replacement !== null) h.value = replacement;
        h.value = scrubString(h.value, ctx);
    }
    return headers;
}

function walk(node, ctx) {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') return scrubString(node, ctx);
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = walk(node[i], ctx);
        return node;
    }
    if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
            if (k === 'headers') {
                node[k] = scrubHeaders(node[k], ctx);
            } else if (k === 'cookies') {
                node[k] = scrubCookieArray(node[k], ctx);
            } else if (k === 'queryString' || k === 'params') {
                node[k] = scrubNameValuePairs(node[k], ctx);
            } else {
                node[k] = walk(node[k], ctx);
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

    // The merged policy is discovered from the file being scrubbed, exactly as
    // verify-scrub.js discovers it from the file being verified, so a consuming
    // project's `.har-policy.project.json` governs the scrub and the gate with
    // one document. A policy that fails to load is a hard failure: scrubbing
    // against a silently-defaulted list is how a project's added secret names
    // go unredacted (issue #297).
    let policy;
    try {
        policy = harPolicy.loadPolicy({ startDir: path.dirname(path.resolve(args.in)) });
    } catch (e) {
        console.error(`sanitize-har: ${e.message}`);
        process.exit(1);
    }

    const outPath = args.out || deriveOutPath(args.in);
    const outDir = path.dirname(outPath);
    const subsDir = deriveSubsDir(args.in);
    const subsPath = args.subs || path.join(subsDir, LEGACY_SUBS_FILENAME);
    const piiSubsPath = args['pii-subs'] || path.join(subsDir, PII_SUBS_FILENAME);

    // Before any read or write: a derived destination is only safe if git says
    // it is ignored. `.har-captures` is a name, not a protection (issue #318).
    const tableDestinations = [
        { path: subsPath, flag: '--subs', derived: !args.subs },
        { path: piiSubsPath, flag: '--pii-subs', derived: !args['pii-subs'] },
    ];
    assertDerivedDestinationsProtected(tableDestinations);

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
    walk(har, createContext(policy, subs, salt));

    // Typed-PII pass (issue #46): runs after legacy regex scrub so that
    // anything still in the HAR (emails in custom-named fields, phones,
    // SSNs, credit-cards, IPs, plus context-driven name/address/dob/geo)
    // gets a deterministic, obviously-fake replacement. The returned
    // substitutions array contains only hash prefixes of originals so the
    // file is safe to commit.
    // The MERGED policy goes in, so the scrub honours exactly the document the
    // gate honours (issue #334). Without it `fieldTypeFor` was always called
    // with null and the card predicate would have been too, which left a
    // project's `piiFields` and `cardIssuers` validated, merged, loaded -- and
    // never consulted on the side that actually rewrites the capture.
    const piiResult = pii.scrubPii(har, policy);

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

    // Asked once more, immediately before the writes. The check above runs
    // early so a refusal costs nothing and leaves nothing behind; this one is
    // what makes "never written to an unverified destination" true rather than
    // nearly true, since the scrub in between is not instantaneous and the
    // repository's ignore rules are not frozen while it runs.
    assertDerivedDestinationsProtected(tableDestinations);

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

    // Name the tables THIS run wrote, one per line under a stable prefix.
    //
    // Not a new option -- output, and output a caller can act on. Both tables
    // are keyed by the plaintext originals, so each is a reverse lookup table
    // of the live credentials the raw carried, and anything that disposes of
    // the raw has to dispose of them too. Where they went depends on
    // deriveSubsDir, on --subs and on --pii-subs; the only way for a caller to
    // be sure is to be TOLD, because a caller that re-derives the paths for
    // itself is a second copy of that rule waiting to disagree with this one
    // and delete the wrong file -- or, worse, none.
    //
    // Paths only. Never a key, never a value: the whole point of the tables is
    // that their contents do not belong in a log.
    for (const { path: table } of tableDestinations) {
        console.log(`sanitize-har: subs-table: ${table}`);
    }

    // A class the project set to `off` means REAL personal data is still in the
    // file that was just written, on purpose (issue #346). That is what #297
    // requirement 1 asks for and it is the right answer to 125,000
    // correct-but-unwanted replacements -- but it is a standing decision to
    // PUBLISH personal data, and it must not be discoverable only by reading a
    // policy diff months later. So it is said on EVERY run, clean or not, in
    // the terms of the decision rather than as one more advisory line: the same
    // reason `verify-scrub.js` prints `loosenedSecretNames` unconditionally.
    //
    // Printed from the POLICY, so it fires whether or not this capture happened
    // to contain any -- the decision stands either way -- with the counts
    // appended when it did. Counts and class names only; echoing a value would
    // relocate the data into the log that reports it.
    const identifierRetained = piiResult.retained.filter((r) => r.identifierField);
    const disabledRetained = piiResult.retained.filter((r) => !r.identifierField);
    // The identifier-field rule declines a REPLACEMENT, so it has to be as
    // visible as the class rule that declines one. An invisible loosening is
    // how this gate lost its authority (#297 root-cause, failure mode 4), and a
    // suppression nobody can see in the run output is invisible whatever the
    // returned object carries. Counts and kinds only.
    if (identifierRetained.length) {
        console.error(
            `sanitize-har: NOTE -- ${identifierRetained.length} identity kind(s) were ` +
            `detected at fields the policy declares to hold object ids, and were ` +
            `therefore NOT replaced: ` +
            identifierRetained
                .map((r) => `${r.kind} x${r.occurrences} (${r.distinct} distinct)`
                    + (r.mixedEvidence ? ' [MIXED EVIDENCE]' : '')).join(', ') +
            `. identifierFields in ${policy && policy.path || 'the merged policy'}.`);
        // A MIXED row is not the same news as a pure one and must not read like
        // it. The value also appeared at a field with no id declaration, so the
        // scrub took the safe direction -- fail toward a miss on a replace path
        // -- and handed the decision to the engine whose false positives are
        // cheap. The gate WILL fail on these. Saying so here is the difference
        // between an operator reading a finished run and one reading a run that
        // is about to stop.
        const mixed = identifierRetained.filter((r) => r.mixedEvidence);
        if (mixed.length) {
            console.error(
                `sanitize-har: NOTE -- ${mixed.length} of those also appeared at a field ` +
                `with no id declaration (${mixed.map((r) => r.kind).join(', ')}). Mixed ` +
                `evidence is not decided here: the value is left in place rather than ` +
                `rewritten into a fake that no gate could ever report again, and the GATE ` +
                `blocks on it. Expect the verify step to fail until the field names or the ` +
                `policy say which it is.`);
        }
    }

    const disabledClasses = pii.disabledIdentityClasses(policy);
    if (disabledClasses.length) {
        const found = disabledRetained.length
            ? disabledRetained
                .map((r) => `${r.kind} x${r.occurrences} (${r.distinct} distinct)`).join(', ')
            : 'none present in this capture';
        console.error(
            `sanitize-har: NOTE -- IDENTITY DATA IS BEING PUBLISHED. ` +
            `${policy.path || 'the merged policy'} disables ${disabledClasses.length} ` +
            `identity class(es): ${disabledClasses.join(', ')}. Values of those classes are ` +
            `detected and reported but NOT replaced, so real personal data remains in ` +
            `${outPath} -- retained: ${found}.`);
    }

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

