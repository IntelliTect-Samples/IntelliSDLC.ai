#!/usr/bin/env node
/**
 * verify-har-reference.js -- the gate on committed HAR references.
 *
 * Verify the ARTIFACT, not the report of it. A capture-extraction commit once
 * stated "structure and all keys preserved verbatim" while the file it
 * described had every request body truncated away. The defect was found by
 * parsing the artifact, not by reading the description of it -- so this script
 * parses every committed reference and asserts on its content.
 *
 * Four gates:
 *
 *   1. A truncated request body. Only responses may be capped; a reference
 *      whose request bodies were shortened cannot be replayed or diffed, and
 *      it looks authoritative anyway.
 *   2. An unredacted credential header or parameter (the key-name control).
 *   3. A secret nested inside a JSON-valued parameter -- the class that
 *      escapes any flat scan, because the wire body is percent-encoded.
 *   4. A forbidden literal from the operator profile (the literal-value
 *      control), reported by SENTINEL only.
 *
 * No failure message ever echoes an offending value: that would relocate the
 * leak into the CI log that reports it.
 *
 * The profile is gitignored and therefore absent in CI, where gate 4 reports
 * as skipped rather than silently passing. Gates 1-3 always run.
 *
 * Usage:
 *   node verify-har-reference.js [--dir docs/har-reference] [--profile <path>]
 *
 * Exit codes:
 *   0 -- every reference is clean
 *   1 -- the reference directory is missing or a file cannot be parsed
 *   3 -- one or more gate violations (reported on stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const harProfile = require(path.join(__dirname, 'har-profile.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));

const DEFAULT_DIR = path.join('docs', 'har-reference');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const next = argv[i + 1];
        out[a.slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
    }
    return out;
}

function listHarFiles(dir) {
    const found = [];
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) found.push(...listHarFiles(full));
        else if (name.endsWith('.har')) found.push(full);
    }
    return found.sort();
}

function checkRequestBodies(entries, report) {
    for (const [i, entry] of entries.entries()) {
        const postData = entry.request && entry.request.postData;
        if (!postData) continue;
        if (postData.truncated) {
            report(`entry ${i}: request body is marked truncated -- request bodies are never capped`);
        }
    }
}

function checkSecrets(node, report, where, seen) {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
        for (const item of node) checkSecrets(item, report, where, seen);
        return;
    }

    // HAR name/value pairs: headers, cookies, queryString, postData.params.
    if (typeof node.name === 'string' && typeof node.value === 'string'
        && harSecrets.isUnredactedSecret(node.name, node.value)) {
        report(`${where}: credential '${node.name}' is readable in the clear`);
    }

    for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value === 'string') {
            if (harSecrets.isUnredactedSecret(key, value)) {
                report(`${where}: credential '${key}' is readable in the clear`);
            }
            const nested = harLiterals.decodeNestedJson(value);
            if (nested) {
                checkSecrets(nested, report, `${where} (inside encoded '${key}')`, seen);
            }
        } else {
            checkSecrets(value, report, where, seen);
        }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const dir = path.resolve(typeof args.dir === 'string' ? args.dir : DEFAULT_DIR);

    if (!fs.existsSync(dir)) {
        console.error(
            `verify-har-reference: ${dir} does not exist. A capture worth keeping belongs in ` +
            `${DEFAULT_DIR}/<provider>/, indexed by ${path.join(DEFAULT_DIR, 'README.md')}; ` +
            'pass --dir if this project keeps its references elsewhere.');
        process.exit(1);
    }

    let literalStatus = 'skipped (no profile)';
    let literals = [];
    try {
        const profile = harProfile.loadProfile({ profilePath: args.profile, startDir: dir });
        literals = profile.literals;
        literalStatus = `${literals.length} literal(s)`;
    } catch (e) {
        if (args.profile) {
            console.error(`verify-har-reference: ${e.message}`);
            process.exit(1);
        }
    }

    const files = listHarFiles(dir);
    if (files.length === 0) {
        console.error(`verify-har-reference: no .har reference found under ${dir}.`);
        process.exit(1);
    }

    const violations = [];
    for (const file of files) {
        const rel = path.relative(dir, file);
        const report = (message) => violations.push(`${rel}: ${message}`);

        let raw;
        let har;
        try {
            raw = fs.readFileSync(file, 'utf8');
            har = JSON.parse(raw);
        } catch (e) {
            console.error(`verify-har-reference: cannot parse ${rel}: ${e.message}`);
            process.exit(1);
        }

        const entries = (har.log && har.log.entries) || [];
        checkRequestBodies(entries, report);
        checkSecrets(har, report, 'entry', new Set());

        for (const hit of harLiterals.findLiteralHits(raw, literals)) {
            report(`forbidden literal ${hit.sentinel} appears ${hit.count} time(s) unscrubbed`);
        }
    }

    if (violations.length === 0) {
        console.log(
            `verify-har-reference: ${files.length} reference(s) under ${dir} -- clean ` +
            `(literal check: ${literalStatus})`);
        process.exit(0);
    }

    console.error(`verify-har-reference: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(3);
}

main();
