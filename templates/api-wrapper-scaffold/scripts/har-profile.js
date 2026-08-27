#!/usr/bin/env node
/**
 * har-profile.js -- the operator profile shared by every HAR script.
 *
 * One gitignored file holds the two inputs that are specific to the person
 * running a capture: the HMAC salt for the deterministic faker table, and the
 * literal -> sentinel map used by the literal-value scrub pass.
 *
 *   .har-profile.json
 *   {
 *     "salt": "<project salt>",
 *     "literals": {
 *       "<account-id>":   "<AccountId>",
 *       "<display-name>": "<DisplayName>"
 *     }
 *   }
 *
 * Why a file and not a flag: the map is needed by sanitize-har, verify-scrub,
 * extract-har-reference and verify-har-reference alike. One auto-discovered
 * profile keeps the literal control from costing four new command-line
 * options.
 *
 * Why it is never defaulted: the literals ARE the operator's own account
 * identifiers. Baking one into a committed script is precisely what account
 * hygiene forbids, so an absent profile is a hard failure that names the file
 * rather than a quietly-empty map. A future maintainer meeting an awkward
 * required input must not be tempted to helpfully supply a default.
 *
 * The profile must be gitignored. It is an operator secret, not project
 * configuration.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_FILENAME = '.har-profile.json';

// A literal shorter than this cannot be replaced safely: a 2-3 character
// value occurs incidentally all over a HAR, and blanket-replacing it would
// corrupt the file rather than scrub it. It is also the placeholder-exemption
// floor -- counters like `client_mutation_id: "1"` are not credentials.
const MIN_LITERAL_LENGTH = 4;

// Sentinels follow the angle-bracket placeholder convention already used by
// the scrubber (`<UserEmail>`, `<BookingReference>`), so a reader of a
// committed reference can tell a redaction from a real value at a glance.
const SENTINEL_RE = /^<[A-Za-z][A-Za-z0-9]*>$/;

class ProfileError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProfileError';
    }
}

const HOWTO =
    `Create ${PROFILE_FILENAME} with a "salt" and a "literals" map of your own ` +
    `identifiers (account ids, display names, emails) to angle-bracket ` +
    `sentinels, and make sure ${PROFILE_FILENAME} is listed in .gitignore -- ` +
    `it holds your identifiers and must never be committed. There is no ` +
    `default: the values are yours, not the project's.`;

/**
 * Walk upward from `startDir` looking for the nearest profile.
 * Returns the resolved path, or null when none is found at or above
 * `startDir` (bounded by `stopAt`, when supplied).
 */
function findProfilePath(startDir, stopAt) {
    let dir = path.resolve(startDir || process.cwd());
    const stop = stopAt ? path.resolve(stopAt) : null;
    for (;;) {
        const candidate = path.join(dir, PROFILE_FILENAME);
        if (fs.existsSync(candidate)) return candidate;
        if (stop && dir === stop) return null;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function parseLiterals(raw, profilePath) {
    if (raw === undefined || raw === null) {
        throw new ProfileError(
            `${profilePath}: no "literals" map. ${HOWTO} Write "literals": {} only if ` +
            `you have deliberately decided this capture exposes none of your identifiers.`);
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ProfileError(`${profilePath}: "literals" must be an object of literal -> sentinel.`);
    }

    const literals = [];
    // Declaration order is preserved: the operator controls which replacement
    // runs first when one literal is a substring of another.
    for (const literal of Object.keys(raw)) {
        const sentinel = raw[literal];
        // Failures name the sentinel, never the literal -- echoing the value
        // would relocate the leak into the CI log that reports it.
        if (typeof sentinel !== 'string' || !SENTINEL_RE.test(sentinel)) {
            throw new ProfileError(
                `${profilePath}: a "literals" entry has an invalid sentinel ` +
                `(${JSON.stringify(sentinel)}). Sentinels use the angle-bracket ` +
                `placeholder form, e.g. <AccountId>.`);
        }
        if (literal.length < MIN_LITERAL_LENGTH) {
            throw new ProfileError(
                `${profilePath}: the literal mapped to ${sentinel} is too short ` +
                `(< ${MIN_LITERAL_LENGTH} characters). Short values occur incidentally ` +
                `throughout a capture; replacing one would corrupt the file.`);
        }
        literals.push({ literal, sentinel });
    }
    return literals;
}

/**
 * Load the operator profile.
 *
 * @param {object} [opts]
 * @param {string} [opts.profilePath] explicit path (the `--profile` override)
 * @param {string} [opts.startDir]    where upward discovery begins
 * @param {string} [opts.stopAt]      highest directory discovery may reach
 * @returns {{path: string, salt: string, literals: Array<{literal: string, sentinel: string}>}}
 * @throws {ProfileError} when the profile is absent, unparseable, or incomplete
 */
function loadProfile(opts = {}) {
    let resolved = opts.profilePath ? path.resolve(opts.profilePath) : null;
    if (resolved) {
        if (!fs.existsSync(resolved)) {
            throw new ProfileError(`${resolved}: profile not found. ${HOWTO}`);
        }
    } else {
        resolved = findProfilePath(opts.startDir, opts.stopAt);
        if (!resolved) {
            throw new ProfileError(
                `No ${PROFILE_FILENAME} found at or above ` +
                `${path.resolve(opts.startDir || process.cwd())}. ${HOWTO}`);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (e) {
        throw new ProfileError(`${resolved}: cannot parse JSON -- ${e.message}`);
    }

    if (typeof parsed.salt !== 'string' || parsed.salt.length === 0) {
        throw new ProfileError(`${resolved}: no "salt". ${HOWTO}`);
    }

    return {
        path: resolved,
        salt: parsed.salt,
        literals: parseLiterals(parsed.literals, resolved),
    };
}

module.exports = {
    PROFILE_FILENAME,
    MIN_LITERAL_LENGTH,
    ProfileError,
    findProfilePath,
    loadProfile,
};
