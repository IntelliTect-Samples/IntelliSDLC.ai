#!/usr/bin/env node
/**
 * har-policy.js -- the merged scrub policy shared by the scrubber and both
 * verifiers (issue #297, Stage 1).
 *
 * Three inputs, one merge, one definition:
 *
 *   har-policy.default.json     synced from IntelliSDLC.ai, committed, stringent
 *   .har-policy.project.json    the consuming project's overrides, committed
 *   .har-profile.json           the operator's literals, GITIGNORED (har-profile.js)
 *
 * The split that matters is VALUES vs RULES, not project vs operator. Names,
 * patterns and decisions live in the two policy files and are reviewable in a
 * diff; a raw identity value may only ever live in the profile.
 *
 * Why a merged policy at all: the scrubber and the two gates currently carry
 * three different ideas of what is sensitive -- `pii.js` scrubs 13 types while
 * `har-shapes.js` gates 8 -- so a type can be scrubbed and never gated, or
 * gated and never scrubbed. One document consumed by all three cannot drift.
 *
 * The two axes:
 *
 *   secret   grants access.  Name, literal AND shape evidence all gate.
 *   identity names a person. Literal evidence gates; shape evidence advises,
 *                            because shape carries no provenance -- a
 *                            Luhn-valid 16-digit run is a card, a trip id, or
 *                            ~10% of digit runs by chance.
 *
 * The floor lives HERE, not in the callers: a project file may lower an
 * identity class, but any attempt to lower a secret CLASS is a load-time
 * error. A caller cannot forget a check it never makes.
 *
 * What the floor does NOT forbid, deliberately, is removing an individual
 * name: `notSecretFields` may subtract a name the synced default shipped,
 * because a name list has false positives and a gate with no escape hatch is
 * the undisableable gate this issue exists to replace. Since `named-credential`
 * is caught by NAME or not at all, that subtraction is the one input that can
 * hollow out a secret class while its setting still reads `gate` -- so every
 * upstream name a project removes is recorded in `loosenedSecretNames` for the
 * gates to report. Allowed, never silent.
 *
 * The sanctioned escape for a specific false-positive VALUE is a `waiver`,
 * which is keyed on the non-reversible fingerprint, must carry a reason, and
 * expires -- so a reviewer sees THAT something was waived and why, without the
 * value ever entering the repo.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { findUpward } = require('./har-profile.js');

const POLICY_FILENAME = '.har-policy.project.json';
const DEFAULT_POLICY_FILENAME = 'har-policy.default.json';

// The only schema this loader understands. A file declaring a newer one is a
// hard failure: silently ignoring a schema we cannot interpret would apply a
// policy nobody wrote.
const SUPPORTED_SCHEMA_VERSION = 1;

// `gate` blocks, `advise` reports without blocking, `off` neither detects nor
// reports as a finding. A disabled class still surfaces as a warning at the
// call sites (Stage 2 onward), so the cost of a loosening stays visible.
const SETTINGS = ['gate', 'advise', 'off'];

// Lists of names that a project file APPENDS to rather than replaces.
// Replacement would mean a project adding one field name silently discarded
// every default -- the loosening nobody intended and nobody sees.
const APPEND_LISTS = ['identifierFields', 'secretFields', 'secretHeaders', 'notSecretFields'];

// har-shapes.js emits a 12-hex non-reversible fingerprint; a waiver keys on it.
const FINGERPRINT_RE = /^[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WAIVER_KEYS = ['kind', 'fingerprint', 'reason', 'expires'];

class PolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PolicyError';
    }
}

const HOWTO =
    `Declare project overrides in ${POLICY_FILENAME}, which merges over the ` +
    `synced ${DEFAULT_POLICY_FILENAME}. It holds rules only -- names, patterns ` +
    `and decisions. A raw identity value belongs in the gitignored ` +
    `.har-profile.json and nowhere else.`;

// `_comment` is documentation for the humans reading the JSON. It is stripped
// before validation and before the version hash, so re-wording a comment does
// not read as a policy change.
function stripComments(doc) {
    const out = {};
    for (const key of Object.keys(doc)) {
        if (key === '_comment') continue;
        out[key] = doc[key];
    }
    return out;
}

function readJson(file, label) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new PolicyError(`${file}: cannot read the ${label} policy -- ${e.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new PolicyError(`${file}: cannot parse JSON -- ${e.message}`);
    }
}

function requireObject(value, file, what) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new PolicyError(`${file}: "${what}" must be an object.`);
    }
}

function requireStringArray(value, file, what) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new PolicyError(`${file}: "${what}" must be an array of strings.`);
    }
}

/**
 * Validate one document against the vocabulary the DEFAULT policy declares.
 *
 * The default file is the schema authority: it lists every top-level key,
 * every class, every class kind and every PII field dictionary. A project file
 * naming anything outside that vocabulary is a typo, and a typo that is
 * silently ignored is how a repo ends up believing it changed a gate it never
 * touched. So an unknown key is a hard error, never a shrug.
 */
function validateDocument(doc, file, vocabulary) {
    requireObject(doc, file, 'policy');

    for (const key of Object.keys(doc)) {
        if (!vocabulary.topLevel.includes(key)) {
            throw new PolicyError(
                `${file}: unknown policy key "${key}". Known keys: ` +
                `${vocabulary.topLevel.join(', ')}. ${HOWTO}`);
        }
    }

    if (doc.schemaVersion !== undefined && doc.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        throw new PolicyError(
            `${file}: "schemaVersion" ${JSON.stringify(doc.schemaVersion)} is not supported ` +
            `(this loader understands ${SUPPORTED_SCHEMA_VERSION}).`);
    }

    if (doc.classes !== undefined) validateClasses(doc.classes, file, vocabulary);
    for (const list of APPEND_LISTS) {
        if (doc[list] !== undefined) requireStringArray(doc[list], file, list);
    }
    if (doc.piiFields !== undefined) validatePiiFields(doc.piiFields, file, vocabulary);
    if (doc.waivers !== undefined) validateWaivers(doc.waivers, file, vocabulary);
}

function validateClasses(classes, file, vocabulary) {
    requireObject(classes, file, 'classes');
    for (const className of Object.keys(classes)) {
        const kinds = vocabulary.classes[className];
        if (!kinds) {
            throw new PolicyError(
                `${file}: unknown class "${className}". The policy model has exactly two ` +
                `axes: ${Object.keys(vocabulary.classes).join(' and ')}.`);
        }
        requireObject(classes[className], file, `classes.${className}`);
        for (const kind of Object.keys(classes[className])) {
            if (!kinds.includes(kind)) {
                throw new PolicyError(
                    `${file}: unknown ${className} class "${kind}". Known: ${kinds.join(', ')}.`);
            }
            const setting = classes[className][kind];
            if (!SETTINGS.includes(setting)) {
                throw new PolicyError(
                    `${file}: classes.${className}.${kind} is ${JSON.stringify(setting)}; ` +
                    `it must be one of ${SETTINGS.join(', ')}.`);
            }
        }
    }
}

function validatePiiFields(piiFields, file, vocabulary) {
    requireObject(piiFields, file, 'piiFields');
    for (const type of Object.keys(piiFields)) {
        if (!vocabulary.piiTypes.includes(type)) {
            throw new PolicyError(
                `${file}: unknown piiFields type "${type}". Known: ${vocabulary.piiTypes.join(', ')}.`);
        }
        requireStringArray(piiFields[type], file, `piiFields.${type}`);
    }
}

/**
 * A waiver is a committed, reviewable exception to a gating finding.
 *
 * Every field it demands exists so the waiver is auditable without the value:
 * `fingerprint` identifies the finding non-reversibly, `kind` stops one
 * fingerprint waiving an unrelated detector, `reason` is what a reviewer reads,
 * and `expires` is what stops a one-off exception becoming permanent. A waiver
 * that matches nothing is worse than no waiver at all -- it reads as cover --
 * so a malformed fingerprint is rejected rather than tolerated.
 */
function validateWaivers(waivers, file, vocabulary) {
    if (!Array.isArray(waivers)) {
        throw new PolicyError(`${file}: "waivers" must be an array.`);
    }
    const allKinds = [];
    for (const kinds of Object.values(vocabulary.classes)) allKinds.push(...kinds);
    waivers.forEach((waiver, i) => validateWaiver(waiver, `${file}: waivers[${i}]`, file, i, allKinds));
}

function validateWaiver(waiver, at, file, index, allKinds) {
    requireObject(waiver, file, `waivers[${index}]`);
    for (const key of Object.keys(waiver)) {
        if (!WAIVER_KEYS.includes(key)) {
            throw new PolicyError(`${at}: unknown waiver key "${key}".`);
        }
    }
    if (!allKinds.includes(waiver.kind)) {
        throw new PolicyError(
            `${at}: unknown kind "${waiver.kind}". A waiver may only cover a ` +
            `classified finding. Known: ${allKinds.join(', ')}.`);
    }
    if (typeof waiver.fingerprint !== 'string' || !FINGERPRINT_RE.test(waiver.fingerprint)) {
        throw new PolicyError(
            `${at}: "fingerprint" must be the 12-character hex fingerprint reported ` +
            `by the verifier. A waiver that matches nothing reads as cover for a ` +
            `finding nobody triaged.`);
    }
    if (typeof waiver.reason !== 'string' || waiver.reason.trim() === '') {
        throw new PolicyError(
            `${at}: "reason" is required. A committed waiver exists so a reviewer ` +
            `can see WHY a finding was accepted.`);
    }
    if (waiver.expires !== undefined
        && (typeof waiver.expires !== 'string' || !ISO_DATE_RE.test(waiver.expires)
            || Number.isNaN(Date.parse(`${waiver.expires}T00:00:00Z`)))) {
        throw new PolicyError(`${at}: "expires" must be a YYYY-MM-DD date.`);
    }
}

/** Append `additions` to `base`, preserving order and dropping repeats. */
function appendNames(base, additions) {
    const merged = [];
    const seen = new Set();
    for (const name of [...(base || []), ...(additions || [])]) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(name);
    }
    return merged;
}

function without(names, excluded) {
    const drop = new Set(excluded.map((n) => n.toLowerCase()));
    return names.filter((n) => !drop.has(n.toLowerCase()));
}

function mergeDocuments(base, override) {
    const merged = {
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        classes: {},
        piiFields: {},
        waivers: [...(base.waivers || []), ...(override.waivers || [])],
    };

    // classes: a project setting replaces exactly the kind it names, leaving
    // its siblings at the default. Replacing the whole class object would mean
    // naming one kind silently reset every other.
    for (const className of Object.keys(base.classes)) {
        merged.classes[className] = Object.assign(
            {}, base.classes[className], (override.classes || {})[className]);
    }

    for (const list of APPEND_LISTS) {
        merged[list] = appendNames(base[list], override[list]);
    }

    for (const type of Object.keys(base.piiFields)) {
        merged.piiFields[type] = appendNames(base.piiFields[type], (override.piiFields || {})[type]);
    }

    // The subtraction runs AFTER the append, so `notSecretFields` can remove a
    // default name and can veto a name the same file just added -- which is
    // what a consumer reaches for when a default flags a header that is
    // configuration in their API, not a credential.
    merged.secretFields = without(merged.secretFields, merged.notSecretFields);
    merged.secretHeaders = without(merged.secretHeaders, merged.notSecretFields);

    // ...but `named-credential` is the one secret class with no shape backup:
    // `sessionid`, `fb_dtsg`, `c_user` are caught by NAME or not at all. So a
    // subtraction can hollow that class out while `classes.secret` still reads
    // `gate` -- the floor checks the setting, and the setting is not where the
    // class lives. Forbidding it is wrong (the issue's own sketch removes
    // `x-asbd-id`, and a name list with no escape hatch is the undisableable
    // gate this issue exists to replace); leaving it INVISIBLE is what must
    // not happen. Record which upstream names a project removed, so the gates
    // can report the loosening on every run and its cost stays visible.
    // Reported in merged `notSecretFields` order -- which is the order the
    // project wrote them while the shipped default carries none of its own,
    // and default-then-project if it ever does. Only names the synced default
    // actually carried are reported: vetoing a name the same file just added
    // loosens nothing, and a report that cries wolf is the failure mode this
    // issue measured at 1134 findings.
    const upstream = new Set(
        [...(base.secretFields || []), ...(base.secretHeaders || [])].map((n) => n.toLowerCase()));
    merged.loosenedSecretNames = merged.notSecretFields
        .filter((name) => upstream.has(name.toLowerCase()));

    return merged;
}

/**
 * The floor. A consumer may disable any identity class; a secret class may
 * not be lowered at all -- not to `off`, and not to `advise`, which is `off`
 * wearing a hat: a secret finding that does not gate is a secret finding that
 * ships. Per-value relief is a waiver.
 */
function enforceFloor(merged, source) {
    for (const kind of Object.keys(merged.classes.secret)) {
        const setting = merged.classes.secret[kind];
        if (setting !== 'gate') {
            throw new PolicyError(
                `${source}: the secret class "${kind}" is set to "${setting}". Secret classes ` +
                `always gate and cannot be lowered -- a secret grants access, so it is removed ` +
                `unconditionally. To accept one specific finding, add a waiver for its ` +
                `fingerprint with a reason and an expiry.`);
        }
    }
}

/** Stable JSON with sorted keys, so the version hash tracks content only. */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return value;
}

/**
 * The default file is the schema authority: the classes it declares and the
 * PII dictionaries it carries ARE the vocabulary every document is checked
 * against. Deriving it rather than hardcoding it means adding a class upstream
 * needs no second edit here -- and no way for the two to disagree.
 */
function buildVocabulary(baseDoc, defaultPath) {
    requireObject(baseDoc.classes, defaultPath, 'classes');
    requireObject(baseDoc.piiFields, defaultPath, 'piiFields');
    return {
        topLevel: ['schemaVersion', 'classes', 'identifierFields', 'secretFields',
            'secretHeaders', 'notSecretFields', 'piiFields', 'waivers'],
        classes: Object.fromEntries(
            Object.keys(baseDoc.classes).map((c) => [c, Object.keys(baseDoc.classes[c])])),
        piiTypes: Object.keys(baseDoc.piiFields),
    };
}

/**
 * An EXPLICIT path that does not exist is a hard failure -- the operator named
 * a file and meant it. A discovered path that does not exist is not: standing
 * on the synced default is the correct posture for a project that has declared
 * no overrides.
 */
function resolveProjectPath(opts) {
    if (!opts.policyPath) return findUpward(POLICY_FILENAME, opts.startDir, opts.stopAt);
    const resolved = path.resolve(opts.policyPath);
    if (!fs.existsSync(resolved)) {
        throw new PolicyError(`${resolved}: project policy not found. ${HOWTO}`);
    }
    return resolved;
}

/**
 * Load and merge the scrub policy.
 *
 * @param {object} [opts]
 * @param {string} [opts.policyPath]  explicit project policy (the `--policy` override)
 * @param {string} [opts.startDir]    where upward discovery begins
 * @param {string} [opts.stopAt]      highest directory discovery may reach
 * @param {string} [opts.defaultPath] explicit default policy (tests only)
 * @returns {object} frozen merged policy: { path, defaultPath, version, schemaVersion,
 *                   classes, identifierFields, secretFields, secretHeaders,
 *                   notSecretFields, loosenedSecretNames, piiFields, waivers }
 * @throws {PolicyError} on an unreadable, unknown-keyed, or floor-violating policy
 */
function loadPolicy(opts = {}) {
    const defaultPath = opts.defaultPath
        ? path.resolve(opts.defaultPath)
        : path.join(__dirname, DEFAULT_POLICY_FILENAME);
    const baseDoc = stripComments(readJson(defaultPath, 'default'));
    const vocabulary = buildVocabulary(baseDoc, defaultPath);
    validateDocument(baseDoc, defaultPath, vocabulary);

    const projectPath = resolveProjectPath(opts);

    // An absent project policy is not an error: the synced default is the
    // stringent baseline and standing on it is the correct default posture.
    const overrideDoc = projectPath
        ? stripComments(readJson(projectPath, 'project'))
        : {};
    if (projectPath) validateDocument(overrideDoc, projectPath, vocabulary);

    const merged = mergeDocuments(baseDoc, overrideDoc);
    enforceFloor(merged, projectPath || defaultPath);

    return deepFreeze(Object.assign({}, merged, {
        path: projectPath,
        defaultPath,
        // Identifies the MERGED document, so a reference stamped with it
        // records the rules that actually produced it -- not merely which
        // upstream default was in the tree at the time.
        version: crypto.createHash('sha256').update(canonicalJson(merged)).digest('hex').slice(0, 16),
    }));
}

function todayIso(now) {
    return (now || new Date()).toISOString().slice(0, 10);
}

/**
 * True when `policy` waives a finding of `kind` with `fingerprint`.
 *
 * An expired waiver does not match. The expiry is the whole reason a waiver is
 * safe to commit: without it, one accepted false positive is a permanent hole
 * that nobody revisits because nothing ever asks them to.
 */
function isWaived(policy, kind, fingerprint, now) {
    if (!policy || !Array.isArray(policy.waivers) || typeof fingerprint !== 'string') return false;
    const wanted = fingerprint.toLowerCase();
    const today = todayIso(now);
    return policy.waivers.some((w) =>
        w.kind === kind
        && w.fingerprint.toLowerCase() === wanted
        && (w.expires === undefined || w.expires >= today));
}

module.exports = {
    POLICY_FILENAME,
    DEFAULT_POLICY_FILENAME,
    SUPPORTED_SCHEMA_VERSION,
    SETTINGS,
    PolicyError,
    loadPolicy,
    isWaived,
};
