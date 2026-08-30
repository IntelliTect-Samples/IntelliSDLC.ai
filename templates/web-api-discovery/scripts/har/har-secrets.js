#!/usr/bin/env node
/**
 * har-secrets.js -- the key-name half of the scrub.
 *
 * These are secrets by IDENTITY, not by shape: short, non-hex, non-JWT values
 * that no pattern matches, so they have to be redacted by the name they
 * travel under. Shared by the scrubber (which redacts them) and the verifiers
 * (which fail when one is still readable).
 *
 * This list is necessary and not sufficient. It can only ever cover names
 * somebody anticipated -- see har-literals.js for the second control that
 * covers the same value appearing under a name nobody knew about.
 */

'use strict';

const { isPlausibleSecretValue, decodeNestedJson } = require('./har-literals.js');
const harPolicy = require('./har-policy.js');

// Request-signing / CSRF-adjacent body & query parameters, session cookies
// too short to trip the 16-character cookie-value heuristic, and the headers
// that carry app credentials.
//
// The names are DATA and live in `har-policy.default.json`, so the scrubber,
// both verifiers and a consuming project all read one list. These two Sets are
// the default view of it, for callers that have no merged policy in hand; a
// caller that does passes it and gets the project's additions and vetoes.
const DEFAULT_POLICY = harPolicy.loadDefaultPolicy();
const KNOWN_SECRET_FIELD_NAMES = new Set(DEFAULT_POLICY.secretFields.map((n) => n.toLowerCase()));
const KNOWN_SECRET_HEADER_NAMES = new Set(DEFAULT_POLICY.secretHeaders.map((n) => n.toLowerCase()));

/**
 * True when `value` is one of the scrubber's own redaction markers.
 *
 * The bug this replaces: `['redacted-', '<'].some((p) => value.startsWith(p))`
 * -- case-sensitive, so a value of literally `REDACTED`, the most obvious
 * spelling of "already handled" there is, was reported as a live credential.
 * Noise of that kind is not cosmetic: it is what destroyed the gate's
 * authority, and an ignored gate is how the three real leaks survived a run
 * that produced 1134 findings.
 *
 * Deliberately anchored, never a substring test. `myredacted-token` is not a
 * redaction, and treating it as one would be a hole rather than a cleanup.
 */
const SENTINEL_RE = /^(?:<[^<>]*>|redacted(?:[-_:]\S*)?|\[redacted\]|\*{3,})$/i;

function isRedacted(value) {
    return typeof value === 'string' && SENTINEL_RE.test(value.trim());
}

function secretFieldNames(policy) {
    if (!policy || !Array.isArray(policy.secretFields)) return KNOWN_SECRET_FIELD_NAMES;
    return new Set(policy.secretFields.map((n) => n.toLowerCase()));
}

function secretHeaderNames(policy) {
    if (!policy || !Array.isArray(policy.secretHeaders)) return KNOWN_SECRET_HEADER_NAMES;
    return new Set(policy.secretHeaders.map((n) => n.toLowerCase()));
}

function isKnownSecretField(key, policy) {
    return typeof key === 'string' && secretFieldNames(policy).has(key.toLowerCase());
}

// A multipart field puts its name in a Content-Disposition header and its
// value on its own line after a blank line:
//
//   ------Boundary
//   Content-Disposition: form-data; name="lsd"
//
//   AVliveCsrfToken123
//   ------Boundary--
//
// So neither `name=value` nor `"name":"value"` matches, and the tokens on the
// name list are short and non-hex by nature -- that is why they are on a name
// list at all -- so no shape pattern catches them either. Without this the
// value survives the scrub AND every verifier: a silent bypass, which is
// worse than no scrub, because the file looks checked.
// Parsed by splitting on the body's OWN declared boundary, not by scanning for
// the next line that happens to start with `--`. A lazy "stop at the first
// `\n--`" match truncates on a value that contains such a line -- wrapped
// base64 routinely does -- leaving the tail of the real secret in the clear;
// and because the scrubber and the detector share one definition, neither
// notices. Anchoring on the declared boundary removes both blind spots.
const NAME_ATTR_RE = /\bname="((?:[^"\\]|\\.)*)"/i;

// The opening delimiter is the first line that starts with `--`, ANYWHERE in
// the body -- not necessarily the first line. A leading CRLF or a MIME
// preamble (legal per RFC 2046) is enough to push it down, and keying off
// line one meant one odd leading byte blinded the control for the entire
// body, in the scrubber and the detector alike. Failing closed on a whole
// request body is a worse shape of bug than mis-parsing one field.
// KNOWN LIMITATIONS -- accepted, not oversights. This is a split heuristic,
// not a MIME parser, and closing these properly means writing one:
//
//  1. The delimiter is the first `--` line found. A preamble or an earlier
//     field whose value contains a line consisting only of `--...` would be
//     picked instead, mis-scoping the split for that body.
//  2. A boundary token that also occurs inside a field value over-segments
//     the split.
//
// Both need an uncommon body shape and fail toward a missed redaction in one
// body, which the literal-value and shape controls still cover. If either
// starts showing up in real captures, replace this with a real parser rather
// than adding another heuristic on top.
const DELIMITER_LINE_RE = /^(--[^\r\n]+?)[ \t]*$/m;

function detectBoundary(text) {
    const match = DELIMITER_LINE_RE.exec(text);
    if (!match) return null;
    const delimiter = match[1];

    // A boundary token may itself end in `-` (RFC 2046 allows it), so a
    // trailing `--` cannot be assumed to be the closing marker. Only strip it
    // when the shorter string is what the rest of the body actually uses --
    // which is the case when we happened to find the CLOSING delimiter first.
    if (delimiter.endsWith('--')) {
        const withoutClosing = delimiter.slice(0, -2);
        // CRLF first: RFC 2046 mandates it around delimiters, so a check for
        // the bare-LF spelling alone would never fire on a real capture and
        // this branch would silently never run.
        if (withoutClosing.length > 2
            && (text.includes(withoutClosing + '\r\n') || text.includes(withoutClosing + '\n'))) {
            return withoutClosing;
        }
    }
    return delimiter;
}

/**
 * Visit each multipart field whose name is a known secret.
 *
 * `replacer(name, value)` returns a replacement value, or null/undefined to
 * leave it alone (which is how a detector uses this without mutating).
 * Returns the rewritten text.
 *
 * `options.includeRedacted` decides what happens to a value that LOOKS like a
 * redaction marker, and the right answer differs by caller:
 *
 *   * a DETECTOR (the default, false) skips it. Reporting our own sentinel is
 *     the noise that destroyed the gate's authority.
 *   * a SCRUBBER passes true. It is looking at data it has not replaced yet,
 *     and a live credential that arrives already looking masked --
 *     `REDACTED_FOR_PRIVACY...`, `<token>`, `***` -- is still a live
 *     credential. Skipping it on its shape is a bypass the upstream controls.
 *
 * A scrubber that must not re-replace its OWN output distinguishes it by
 * identity (did I emit this value?), never by shape.
 */
function replaceMultipartSecretFields(text, replacer, policy, options) {
    const includeRedacted = !!(options && options.includeRedacted);
    if (typeof text !== 'string' || !text.includes('Content-Disposition')) return text;

    const boundary = detectBoundary(text);
    if (!boundary) return text;

    // Split on the declared boundary. The delimiters are preserved by
    // rebuilding with the same separator, so an untouched body is returned
    // byte-identical.
    const segments = text.split(boundary);
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const headerEnd = segment.search(/\r?\n\r?\n/);
        if (headerEnd < 0) continue;

        const headers = segment.slice(0, headerEnd);
        if (!/Content-Disposition/i.test(headers)) continue;
        const nameMatch = NAME_ATTR_RE.exec(headers);
        if (!nameMatch || !isKnownSecretField(nameMatch[1], policy)) continue;

        const separator = /\r?\n\r?\n/.exec(segment.slice(headerEnd))[0];
        const valueStart = headerEnd + separator.length;
        // The value runs to the end of the segment; a trailing CRLF belongs to
        // the delimiter, not to the value. A final part with no closing
        // boundary still parses -- the segment simply ends at end of input.
        const rest = segment.slice(valueStart);
        const trailing = /\r?\n$/.exec(rest);
        const value = trailing ? rest.slice(0, rest.length - trailing[0].length) : rest;

        if (!isPlausibleSecretValue(value)) continue;
        if (!includeRedacted && isRedacted(value)) continue;
        const replacement = replacer(nameMatch[1], value);
        if (replacement === null || replacement === undefined) continue;

        segments[i] = segment.slice(0, valueStart) + replacement + (trailing ? trailing[0] : '');
    }
    return segments.join(boundary);
}

function isKnownSecretHeader(name, policy) {
    return typeof name === 'string' && secretHeaderNames(policy).has(name.toLowerCase());
}

/**
 * True when `value` under `name` is a credential still readable in the clear.
 *
 * Deliberately exempts values below the plausible-secret length: a verifier
 * that flags `client_mutation_id: "1"` or `actor_id: "0"` trains its readers
 * to ignore it, and an ignored gate is worse than no gate. Counters and
 * placeholders are not credentials.
 */
function isUnredactedSecret(name, value, policy) {
    if (!isKnownSecretField(name, policy) && !isKnownSecretHeader(name, policy)) return false;
    if (!isPlausibleSecretValue(value)) return false;
    return !isRedacted(value);
}

/**
 * Walk a parsed HAR for known secret names whose values are still readable,
 * descending into percent-encoded JSON parameters on the way -- a form body
 * carrying `variables=<encoded JSON>` hides tokens whose keys never appear in
 * the outer parameter list.
 *
 * `report(name, where)` receives the offending NAME and a location label.
 * It never receives the value: the value is what we are trying not to spread,
 * and a failure message that quotes it relocates the leak into the log.
 *
 * Shared by verify-scrub.js and verify-har-reference.js so both gate on
 * exactly the same definition of "readable credential".
 */
function walkForUnredactedSecrets(root, report, options) {
    // `policy` is optional and absent means the shipped defaults, so the
    // existing two-argument callers keep exactly today's behaviour. The
    // recursion state moved into a closure rather than trailing parameters:
    // an options bag that a caller could accidentally fill with a `where`
    // string is a bag that silently changes what the walk reports.
    const policy = options && options.policy;
    const visited = new Set();

    function walk(node, location) {
        if (node === null || typeof node !== 'object') return;
        if (visited.has(node)) return;
        visited.add(node);

        if (Array.isArray(node)) {
            for (const item of node) walk(item, location);
            return;
        }

        // HAR name/value pairs: headers, cookies, queryString, postData.params.
        if (typeof node.name === 'string' && typeof node.value === 'string'
            && isUnredactedSecret(node.name, node.value, policy)) {
            report(node.name, location);
        }

        for (const key of Object.keys(node)) {
            const value = node[key];
            if (typeof value !== 'string') {
                walk(value, location);
                continue;
            }
            if (isUnredactedSecret(key, value, policy)) report(key, location);
            // A multipart body is one opaque string, so there is no structured
            // pair to walk -- detect the field in the text itself. The replacer
            // returns null, so this reports without mutating.
            replaceMultipartSecretFields(value, (name) => {
                report(name, `${location} (multipart field)`);
                return null;
            }, policy);
            const nested = decodeNestedJson(value);
            if (nested) walk(nested, `${location} (inside encoded '${key}')`);
        }
    }

    walk(root, 'entry');
}

module.exports = {
    KNOWN_SECRET_FIELD_NAMES,
    KNOWN_SECRET_HEADER_NAMES,
    isKnownSecretField,
    isKnownSecretHeader,
    isRedacted,
    isUnredactedSecret,
    walkForUnredactedSecrets,
    replaceMultipartSecretFields,
};
