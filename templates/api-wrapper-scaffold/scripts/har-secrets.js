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

// Request-signing / CSRF-adjacent body & query parameters, plus session
// cookies too short to trip the 16-character cookie-value heuristic.
const KNOWN_SECRET_FIELD_NAMES = new Set([
    'fb_dtsg', 'lsd', 'jazoest',
    '__spin_r', '__spin_b', '__spin_t', '__hs', '__hsi', '__csr', '__hsdp', '__req', '__rev',
    'c_user', 'xs', 'datr', 'fr', 'sb', 'mid', 'ig_did', 'ds_user_id',
    'sessionid', 'csrftoken',
]);

const KNOWN_SECRET_HEADER_NAMES = new Set([
    'x-fb-lsd', 'x-asbd-id', 'x-ig-app-id', 'x-instagram-rupload-params',
]);

// Prefixes the scrubber stamps on a replaced value, so a verifier can tell a
// redaction from a live credential.
const REDACTION_PREFIXES = ['redacted-', '<'];

function isKnownSecretField(key) {
    return typeof key === 'string' && KNOWN_SECRET_FIELD_NAMES.has(key.toLowerCase());
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

function detectBoundary(text) {
    const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined).trim();
    if (firstLine.startsWith('--') && firstLine.length > 2) {
        return firstLine.replace(/--$/, '');
    }
    return null;
}

/**
 * Visit each multipart field whose name is a known secret.
 *
 * `replacer(name, value)` returns a replacement value, or null/undefined to
 * leave it alone (which is how a detector uses this without mutating).
 * Returns the rewritten text.
 */
function replaceMultipartSecretFields(text, replacer) {
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
        if (!nameMatch || !isKnownSecretField(nameMatch[1])) continue;

        const separator = /\r?\n\r?\n/.exec(segment.slice(headerEnd))[0];
        const valueStart = headerEnd + separator.length;
        // The value runs to the end of the segment; a trailing CRLF belongs to
        // the delimiter, not to the value. A final part with no closing
        // boundary still parses -- the segment simply ends at end of input.
        const rest = segment.slice(valueStart);
        const trailing = /\r?\n$/.exec(rest);
        const value = trailing ? rest.slice(0, rest.length - trailing[0].length) : rest;

        if (!isPlausibleSecretValue(value) || isRedacted(value)) continue;
        const replacement = replacer(nameMatch[1], value);
        if (replacement === null || replacement === undefined) continue;

        segments[i] = segment.slice(0, valueStart) + replacement + (trailing ? trailing[0] : '');
    }
    return segments.join(boundary);
}

function isKnownSecretHeader(name) {
    return typeof name === 'string' && KNOWN_SECRET_HEADER_NAMES.has(name.toLowerCase());
}

function isRedacted(value) {
    return typeof value === 'string' && REDACTION_PREFIXES.some((p) => value.startsWith(p));
}

/**
 * True when `value` under `name` is a credential still readable in the clear.
 *
 * Deliberately exempts values below the plausible-secret length: a verifier
 * that flags `client_mutation_id: "1"` or `actor_id: "0"` trains its readers
 * to ignore it, and an ignored gate is worse than no gate. Counters and
 * placeholders are not credentials.
 */
function isUnredactedSecret(name, value) {
    if (!isKnownSecretField(name) && !isKnownSecretHeader(name)) return false;
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
function walkForUnredactedSecrets(node, report, where, seen) {
    const visited = seen || new Set();
    const location = where || 'entry';
    if (node === null || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
        for (const item of node) walkForUnredactedSecrets(item, report, location, visited);
        return;
    }

    // HAR name/value pairs: headers, cookies, queryString, postData.params.
    if (typeof node.name === 'string' && typeof node.value === 'string'
        && isUnredactedSecret(node.name, node.value)) {
        report(node.name, location);
    }

    for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value !== 'string') {
            walkForUnredactedSecrets(value, report, location, visited);
            continue;
        }
        if (isUnredactedSecret(key, value)) report(key, location);
        // A multipart body is one opaque string, so there is no structured
        // pair to walk -- detect the field in the text itself. The replacer
        // returns null, so this reports without mutating.
        replaceMultipartSecretFields(value, (name) => {
            report(name, `${location} (multipart field)`);
            return null;
        });
        const nested = decodeNestedJson(value);
        if (nested) {
            walkForUnredactedSecrets(nested, report, `${location} (inside encoded '${key}')`, visited);
        }
    }
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
