#!/usr/bin/env node
/**
 * har-literals.js -- literal-value scrubbing, the second scrub control.
 *
 * Key-name scrubbing (`sanitize-har.js`'s secret field/header lists) can only
 * ever redact a value whose NAME somebody anticipated. Two classes escape it:
 *
 *   (a) a secret nested inside a percent-encoded JSON parameter -- the wire
 *       body is encoded, so no flat pattern matches, and the inner key never
 *       appears in the form's own parameter list;
 *   (b) the same value under several names, one of them undocumented -- an
 *       account id observed as a nested `default_actor.id`, as a permalink
 *       `&id=`, and as an undiscovered `target_id=`. Extending a key list
 *       cannot fix this, because the failure is that you do not know all the
 *       names.
 *
 * So: key-name scrubbing handles secrets you can name; a literal-value pass
 * over the identifiers you know you are exposing handles the ones you cannot.
 * You need both. The literals come from the operator's gitignored
 * `.har-profile.json` (see `har-profile.js`) and are never defaulted.
 *
 * The pass is applied LAST, over the SERIALIZED entry, so a single sweep
 * covers URLs, headers, request bodies and response bodies alike.
 */

'use strict';

// Values shorter than this are placeholders and counters, not credentials.
// A verifier that flags `client_mutation_id: "1"` or `actor_id: "0"` trains
// its readers to ignore it, which is worse than not running it.
const MIN_SECRET_LENGTH = 4;

/**
 * Every serialization of `literal` that can appear in a HAR: raw, the
 * percent-encoded form, its lowercase-hex spelling, the form-encoded `+`
 * spelling, and the double-encoded form (a value nested inside an already
 * encoded parameter). Deduplicated and ordered longest-first so a more
 * specific spelling is consumed before a shorter one that is its prefix.
 */
function encodedForms(literal) {
    const once = encodeURIComponent(literal);
    // The pass runs over the SERIALIZED document, where a quote is `\"`, a
    // backslash is `\\` and a non-ASCII character may be `\uXXXX`. A literal
    // containing any of those never appears raw in the text being scanned --
    // and names, the most common literal after an id, routinely contain them.
    const jsonEscaped = JSON.stringify(literal).slice(1, -1);
    const jsonAscii = JSON.stringify(literal)
        .slice(1, -1)
        .replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    // Escaped twice: a JSON response body is stored in the HAR as a STRING, so
    // serializing the HAR escapes its quotes a second time. A literal inside a
    // JSON body therefore reaches the pass as `\\\"Countess\\\"`.
    const jsonEscapedTwice = JSON.stringify(jsonEscaped).slice(1, -1);
    const candidates = [
        literal,
        jsonEscaped,
        jsonEscapedTwice,
        jsonAscii,
        once,
        once.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
        once.replace(/%20/g, '+'),
        encodeURIComponent(once),
    ];
    return Array.from(new Set(candidates.filter((c) => c.length > 0)))
        .sort((a, b) => b.length - a.length);
}

/**
 * Longest literal first, regardless of declaration order.
 *
 * If a short literal runs first it consumes its own substring out of a longer
 * one -- replacing `Lovelace` inside `Ada Lovelace` strands `Ada ` next to a
 * sentinel, and the longer literal records no hit, so nothing reports the
 * partial name that just leaked. The operator should not have to know that
 * declaration order is load-bearing.
 */
function byDescendingLength(literals) {
    return (literals || []).slice().sort((a, b) => b.literal.length - a.literal.length);
}

function countAndReplace(text, needle, replacement) {
    if (!needle) return { text, count: 0 };
    const parts = text.split(needle);
    return { text: parts.join(replacement), count: parts.length - 1 };
}

/**
 * Replace every literal (in every encoding) with its sentinel.
 *
 * @returns {{text: string, hits: Array<{sentinel: string, count: number}>}}
 *   The hit records name the SENTINEL and a count only -- never the literal.
 *   A failure report that quotes the offending value merely relocates the
 *   leak into the log that reports it.
 */
// Text already replaced by an earlier literal is off-limits to later ones.
// Sentinels are readable words -- `<DisplayName>`, `<AccountId>` -- so an
// operator who also declares a short literal like `Name` would otherwise see
// the second pass match INSIDE the first pass's sentinel, producing
// `<Display<ShortHandle>>`: a corrupted marker that no longer reads as a
// redaction, plus a silently inflated hit count. So each replacement parks a
// placeholder that cannot occur in captured text, and the sentinels are
// restored once every literal has run.
// U+0001 / U+0002: control characters that cannot appear unescaped in a JSON
// document, so a placeholder cannot collide with captured text or a sentinel.
const PLACEHOLDER_OPEN = String.fromCharCode(1) + 'har-literal:';
const PLACEHOLDER_CLOSE = String.fromCharCode(2);

/**
 * Substitute a placeholder with its sentinel, QUOTING it when it stands where a
 * bare JSON value used to (issue #482).
 *
 * The literal pass runs over the serialized HAR as text, so it has no idea what
 * context a literal sat in. That is harmless when the literal was a quoted
 * string -- the quotes are still there and the sentinel lands between them. It
 * is not harmless when the literal was a bare NUMBER:
 *
 *     "productIdentifier":61593494464534   ->   "productIdentifier":<Sentinel>
 *
 * An angle-bracket sentinel is not a JSON token, so the document stops parsing
 * and the leak gate passes it anyway -- the gate asks whether a secret survived,
 * never whether the document is still a document.
 *
 * WHAT COUNTS AS A BARE VALUE, and why both sides are required: the placeholder
 * must be preceded by `:`, `,` or `[` and followed by `,`, `}` or `]`, ignoring
 * whitespace. "The character before it is a quote" is NOT a sufficient test,
 * because a literal in the MIDDLE of a string has ordinary characters on both
 * sides and must not acquire quotes. Requiring structural characters on both
 * sides admits exactly the whole-value positions and nothing else.
 *
 * THE QUOTES ARE ESCAPED TO THE DEPTH THEY ARE INSERTED AT. A HAR carries
 * bodies as strings, so an embedded JSON document appears in the serialization
 * with its quotes escaped (`\"id\":1`). Emitting a bare `"` there would fix the
 * outer document by breaking the inner one. The depth is read off the nearest
 * preceding quote -- whatever backslashes escape it, escape ours.
 *
 * Non-JSON text is left alone: with no structural characters around the
 * placeholder, nothing matches and the sentinel goes in bare, which is what a
 * form body or a plain-text payload needs.
 */
// The character a three-character percent escape stands for, or '' when the
// text is not one. Used to recognise a JSON delimiter that has been encoded.
function percentChar(seq) {
    if (!/^%[0-9A-Fa-f]{2}$/.test(seq)) return '';
    return String.fromCharCode(parseInt(seq.slice(1), 16));
}

function substituteSentinel(text, placeholder, sentinel) {
    if (!placeholder) return text;
    const STRUCT_BEFORE = ':,[';
    const STRUCT_AFTER = ',}]';

    let out = '';
    let from = 0;
    for (;;) {
        const at = text.indexOf(placeholder, from);
        if (at < 0) { out += text.slice(from); return out; }

        let i = at - 1;
        while (i >= 0 && /\s/.test(text[i])) i--;
        const encodedBefore = i >= 2 && text[i - 2] === '%' &&
            STRUCT_BEFORE.includes(percentChar(text.slice(i - 2, i + 1)));
        const opensValue = encodedBefore || (i >= 0 && STRUCT_BEFORE.includes(text[i]));

        let j = at + placeholder.length;
        while (j < text.length && /\s/.test(text[j])) j++;
        const encodedAfter = text[j] === '%' &&
            STRUCT_AFTER.includes(percentChar(text.slice(j, j + 3)));
        const closesValue = encodedAfter || (j < text.length && STRUCT_AFTER.includes(text[j]));

        let quote = '';
        if (opensValue && closesValue) {
            if (encodedBefore || encodedAfter) {
                // THE PAYLOAD IS PERCENT-ENCODED HERE, so the delimiters around
                // it are `%3A` and `%7D` rather than `:` and `}` -- and the
                // quote we add has to be encoded to match, or it survives the
                // decode as a literal `"` inside an encoded value.
                //
                // This is the shape the defect was actually FOUND in: a form
                // parameter that the scrub rewrote is re-encoded before the HAR
                // is serialized, so by the time this pass runs the structural
                // characters are escapes. A version of this check that only
                // understood literal `:` and `}` passed every unit test and left
                // the real capture broken.
                quote = '%22';
            } else {
                // The nearest quote before this point is escaped exactly as
                // deeply as we are, whether it closed a key or a neighbouring
                // value.
                let k = at - 1;
                while (k >= 0 && text[k] !== '"') k--;
                let slashes = 0;
                for (let b = k - 1; b >= 0 && text[b] === '\\'; b--) slashes++;
                quote = '\\'.repeat(slashes) + '"';
            }
        }

        out += text.slice(from, at) + quote + sentinel + quote;
        from = at + placeholder.length;
    }
}

function applyLiteralPass(text, literals) {
    const ordered = byDescendingLength(literals);
    let out = text;
    const hits = [];

    for (const [index, { literal, sentinel }] of ordered.entries()) {
        const placeholder = `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
        let count = 0;
        for (const form of encodedForms(literal)) {
            const r = countAndReplace(out, form, placeholder);
            out = r.text;
            count += r.count;
        }
        if (count > 0) hits.push({ sentinel, count });
    }

    for (const [index, { sentinel }] of ordered.entries()) {
        out = substituteSentinel(out, `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`, sentinel);
    }

    return { text: out, hits };
}

/**
 * Detect forbidden literals without mutating the text. Same non-echoing
 * contract as `applyLiteralPass`.
 */
function findLiteralHits(text, literals) {
    const hits = [];
    for (const { literal, sentinel } of byDescendingLength(literals)) {
        let count = 0;
        for (const form of encodedForms(literal)) {
            count += countAndReplace(text, form, '').count;
        }
        if (count > 0) hits.push({ sentinel, count });
    }
    return hits;
}

function percentDecode(value) {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, ' '));
    } catch {
        // A malformed escape is not an error here -- it just means this value
        // is not an encoded payload.
        return null;
    }
}

/** The JSON object/array `text` parses to, or null when it is not one. */
function parseJsonObject(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Return the JSON object/array a value carries, percent-encoded or not, or
 * null when it carries neither.
 *
 * PARSE FIRST, DECODE SECOND (issue #454, defect D3). This used to
 * percent-decode unconditionally before parsing, which made a JSON document
 * that was ALREADY decoded and contained a bare `%` -- "discount 50%off" --
 * unreadable: `decodeURIComponent` throws on the invalid escape,
 * `percentDecode` returns null, and the document was skipped entirely.
 *
 * It was skipped by BOTH engines, because the gate (`har-secrets.js`) and the
 * scrubber (`sanitize-har.js`) both reach nested payloads through here. So a
 * secret inside such a document survived the scrub AND the gate reported the
 * artifact clean -- the one outcome the gate exists to prevent. Decoding is
 * the fallback now, not the precondition.
 */
function decodeNestedJson(value) {
    const direct = parseJsonObject(value);
    if (direct !== null) return direct;
    const decoded = percentDecode(value);
    if (decoded === null) return null;
    return parseJsonObject(decoded);
}

/**
 * Visit every parameter of a form-encoded body or query string with its value
 * DECODED, so key-name scrubbing reaches secrets nested inside an encoded
 * JSON parameter.
 *
 * `transform(name, decodedValue)` returns the replacement decoded value. A
 * parameter whose value is returned unchanged keeps its original bytes --
 * re-encoding an untouched value would churn the committed reference for no
 * reason and defeat diffing against a fresh capture.
 */
function transformEncodedParams(text, transform) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text
        .split('&')
        .map((pair) => {
            const eq = pair.indexOf('=');
            if (eq < 0) return pair;
            const rawName = pair.slice(0, eq);
            const rawValue = pair.slice(eq + 1);
            const decoded = percentDecode(rawValue);
            if (decoded === null) return pair;
            const name = percentDecode(rawName) ?? rawName;
            const replaced = transform(name, decoded);
            if (replaced === decoded) return pair;
            return `${rawName}=${encodeURIComponent(replaced)}`;
        })
        .join('&');
}

/** B.3: counters and placeholders are not credentials. */
function isPlausibleSecretValue(value) {
    return typeof value === 'string' && value.length >= MIN_SECRET_LENGTH;
}

module.exports = {
    MIN_SECRET_LENGTH,
    encodedForms,
    byDescendingLength,
    applyLiteralPass,
    findLiteralHits,
    decodeNestedJson,
    transformEncodedParams,
    isPlausibleSecretValue,
};
