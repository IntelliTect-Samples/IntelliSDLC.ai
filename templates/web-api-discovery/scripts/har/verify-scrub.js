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
const harPolicy = require(path.join(__dirname, 'har-policy.js'));

// Does a finding fail the run? One definition, in har-shapes.js, so the gate
// on the committed reference cannot drift away from the gate on the
// intermediate it came from. See `blocksLeak` there for what each setting
// means and why an identifier-shaped finding is reported rather than dropped.
const blocks = harShapes.blocksLeak;

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
    // The merged policy is discovered from the file being verified, so a
    // consuming project's `.har-policy.project.json` governs its own captures.
    let policy;
    try {
        policy = harPolicy.loadPolicy({ startDir: path.dirname(path.resolve(args.in)) });
    } catch (e) {
        console.error(`verify-scrub: ${e.message}`);
        process.exit(1);
    }

    if (parsed) {
        leaks = harShapes.findLeaksInHar(parsed, policy);
        harSecrets.walkForUnredactedSecrets(parsed, (name) => {
            leaks.push({ kind: 'known-secret', sample: name, gating: true });
        }, { policy });
    } else {
        leaks = harShapes.findLeaksDeep(raw, policy);
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

    // A finding the policy does not gate is reported and does not fail the
    // run: an identity matched only by SHAPE, a waived fingerprint, a class the
    // project disabled. It has left the gate, not the report.
    //
    // The design also asks an advisory finding to exit non-zero while keeping
    // the artifact. That half waits for Stage 7: today capture-har.js DELETES
    // the scrubbed file on any non-zero exit, so exiting non-zero on an
    // advisory finding would destroy the artifact -- the exact behaviour this
    // issue exists to end. The quarantine lands first, then the exit code.
    const describe = (l) =>
        l.sample !== undefined ? `${l.kind}: ${l.sample}` : harShapes.describeLeak(l);
    const gating = leaks.filter(blocks);
    const advisory = leaks.filter((l) => !blocks(l));

    // A loosening the project chose is printed on EVERY run, clean or not.
    // `named-credential` is caught by name or not at all, so removing a name
    // silently hollows the class out; saying so is what keeps the cost visible.
    if (policy && policy.loosenedSecretNames && policy.loosenedSecretNames.length) {
        console.error(
            `verify-scrub: NOTE -- ${policy.path} removes ${policy.loosenedSecretNames.length} ` +
            `upstream secret name(s) from detection: ${policy.loosenedSecretNames.join(', ')}`);
    }
    for (const l of advisory) console.error(`  ~ reported, not blocking: ${describe(l)}`);

    if (gating.length === 0) {
        console.log(
            `verify-scrub: ${args.in} -- 0 blocking leaks` +
            `${advisory.length ? `, ${advisory.length} reported but not blocking` : ''} ` +
            `(literal check: ${literalStatus})`);
        process.exit(0);
    }
    console.error(`verify-scrub: ${gating.length} leak(s) detected in ${args.in}:`);
    // Named findings print the field or the sentinel; shape findings print a
    // fingerprint and a location. Nothing here prints the value itself.
    for (const l of gating) console.error(`  - ${describe(l)}`);
    process.exit(3);
}

main();
