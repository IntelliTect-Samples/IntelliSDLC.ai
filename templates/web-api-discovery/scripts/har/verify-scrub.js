#!/usr/bin/env node
/**
 * verify-scrub.js -- CI-grade leak detector for scrubbed HAR files.
 *
 * Scans a HAR file for unredacted JWTs, long hex tokens, bearer tokens,
 * and plausible email addresses. Exits non-zero on any hit so it can be
 * wired into pre-commit and CI workflows.
 *
 * Three checks, matching the three ways a value escapes a scrub:
 *
 *   1. Shape patterns -- JWTs, long hex, bearer tokens, emails, PII.
 *   2. Known secret names, INCLUDING inside percent-encoded parameters. A
 *      form body carrying `variables=<percent-encoded JSON>` hides tokens
 *      where no flat pattern reaches them.
 *   3. Forbidden literals from the operator profile -- the operator's own
 *      identifiers, which escape (1) and (2) whenever they travel under a
 *      name nobody anticipated.
 *
 * Check 3 needs `.har-profile.json`, which is gitignored and therefore
 * absent in CI. When no profile is found the literal check is reported as
 * skipped rather than silently passing; checks 1 and 2 still gate.
 *
 * No failure message ever echoes the offending value -- that would merely
 * relocate the leak into the log that reports it.
 *
 * Usage:
 *   node verify-scrub.js --in <scrubbed.har> [--profile <path>]
 *
 * Exit codes:
 *   0 -- clean
 *   1 -- I/O or parse error
 *   3 -- one or more leaks detected (reported on stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const harProfile = require(path.join(__dirname, 'har-profile.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));
// Shape patterns live in har-shapes.js so verify-har-reference.js gates the
// committed reference on exactly the same list. The reference is the file
// that actually ships.
const harShapes = require(path.join(__dirname, 'har-shapes.js'));
const { findLeaks } = harShapes;

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
    }
    return out;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.in) {
        console.error('usage: node verify-scrub.js --in <har> [--profile <path>]');
        process.exit(1);
    }
    let raw;
    try {
        raw = fs.readFileSync(args.in, 'utf8');
    } catch (e) {
        console.error(`verify-scrub: cannot read ${args.in}: ${e.message}`);
        process.exit(1);
    }

    // Walk the parsed HAR so every finding carries a location, and so the
    // fields WE wrote -- log.comment, log.creator, our own annotations -- are
    // not scanned as if they were wire data. A HAR that will not parse still
    // gets the flat text sweep: a gate that skips a malformed file entirely
    // would be a gate anyone could bypass by malforming the file.
    let leaks;
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = null;
    }
    if (parsed) {
        leaks = harShapes.findLeaksInHar(parsed);
        harSecrets.walkForUnredactedSecrets(parsed, (name) => {
            leaks.push({ kind: 'known-secret', sample: name });
        });
    } else {
        leaks = harShapes.findLeaksDeep(raw);
    }

    // Forbidden literals. The profile is gitignored, so it is absent in CI;
    // say so rather than reporting a check that never ran as a pass.
    let literalStatus = 'skipped (no profile)';
    try {
        const profile = harProfile.loadProfile({ profilePath: args.profile });
        for (const hit of harLiterals.findLiteralHits(raw, profile.literals)) {
            leaks.push({ kind: 'forbidden-literal', sample: `${hit.sentinel} (x${hit.count})` });
        }
        literalStatus = `${profile.literals.length} literal(s)`;
    } catch (e) {
        if (args.profile) {
            console.error(`verify-scrub: ${e.message}`);
            process.exit(1);
        }
    }

    if (leaks.length === 0) {
        console.log(`verify-scrub: ${args.in} -- 0 leaks (literal check: ${literalStatus})`);
        process.exit(0);
    }
    console.error(`verify-scrub: ${leaks.length} leak(s) detected in ${args.in}:`);
    // Named findings print the field or the sentinel; shape findings print a
    // fingerprint. Nothing here prints the value itself.
    for (const l of leaks) {
        console.error(`  - ${l.sample !== undefined ? `${l.kind}: ${l.sample}` : harShapes.describeLeak(l)}`);
    }
    process.exit(3);
}

main();
