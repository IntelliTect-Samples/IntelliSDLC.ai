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
    const candidates = [
        literal,
        once,
        once.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
        once.replace(/%20/g, '+'),
        encodeURIComponent(once),
    ];
    return Array.from(new Set(candidates.filter((c) => c.length > 0)))
        .sort((a, b) => b.length - a.length);
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
function applyLiteralPass(text, literals) {
    let out = text;
    const hits = [];
    for (const { literal, sentinel } of literals || []) {
        let count = 0;
        for (const form of encodedForms(literal)) {
            const r = countAndReplace(out, form, sentinel);
            out = r.text;
            count += r.count;
        }
        if (count > 0) hits.push({ sentinel, count });
    }
    return { text: out, hits };
}

/**
 * Detect forbidden literals without mutating the text. Same non-echoing
 * contract as `applyLiteralPass`.
 */
function findLiteralHits(text, literals) {
    const hits = [];
    for (const { literal, sentinel } of literals || []) {
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

/**
 * Percent-decode a parameter value and return the JSON object/array it
 * carries, or null when it carries neither.
 */
function decodeNestedJson(value) {
    const decoded = percentDecode(value);
    if (decoded === null) return null;
    const trimmed = decoded.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
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
    applyLiteralPass,
    findLiteralHits,
    decodeNestedJson,
    transformEncodedParams,
    isPlausibleSecretValue,
};
