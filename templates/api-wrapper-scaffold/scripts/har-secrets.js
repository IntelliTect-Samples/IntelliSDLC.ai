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
const MULTIPART_FIELD_RE =
    /(Content-Disposition:[^\r\n]*?\bname="([^"]+)"[^\r\n]*(?:\r?\n(?!\r?\n)[^\r\n]*)*\r?\n\r?\n)([\s\S]*?)(?=\r?\n--)/gi;

/**
 * Visit each multipart field whose name is a known secret.
 *
 * `replacer(name, value)` returns a replacement value, or null/undefined to
 * leave it alone (which is how a detector uses this without mutating).
 * Returns the rewritten text.
 */
function replaceMultipartSecretFields(text, replacer) {
    if (typeof text !== 'string' || !text.includes('Content-Disposition')) return text;
    return text.replace(MULTIPART_FIELD_RE, (match, head, name, value) => {
        if (!isKnownSecretField(name) || !isPlausibleSecretValue(value) || isRedacted(value)) {
            return match;
        }
        const replacement = replacer(name, value);
        return replacement === null || replacement === undefined ? match : head + replacement;
    });
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
