#!/usr/bin/env node
/**
 * verify-har-catalogue.js -- the gate on the committed catalogue.
 *
 * CHECK THE ROW AGAINST THE FILE, NOT AGAINST ITS OWN EXISTENCE.
 *
 * A consuming project's guard asserted that every reference has a catalogue row
 * and that no request body is truncated. Four hollow entries across three
 * reference files passed both. Each carried a 29-character
 * `REDACTED_FORM_URLENCODED_BODY` where the request payload belonged, while the
 * row described request-side behaviour the file contains none of:
 *
 *   "one Only-Me post with two people tagged"    -> no request body
 *   "email + password, then a two-factor code"   -> no request body
 *   "Backdated one existing post"                -> no request body
 *
 * A design document then cited one of them as the evidence for four specific
 * request-side facts. The claims may well be true; the cited reference is not
 * the evidence.
 *
 * The old guard could not have done better. A row was a sentence in a markdown
 * table -- "published a post with two people tagged" is prose, not a field, so
 * there was nothing to compare against the artifact. Structuring the catalogue
 * is what makes the comparison possible, and this is the script that makes it.
 *
 * Two halves:
 *
 *   TRUTH. Every fact a row declares -- Methods, Endpoints, EntryCount,
 *   RequestBodies, RequestBytes, ResponseBytes -- is RECOMPUTED from the .har
 *   the row names and must agree. Coverage is checked both ways: a reference no
 *   row names, a row naming no reference, and two rows over one reference are
 *   each a violation. And the falsifier: a row whose methods include a
 *   body-bearing verb, on a reference with zero request bodies, fails unless
 *   the row carries a written reason.
 *
 *   STALENESS. README.md is re-rendered from the committed catalogue and
 *   compared. A re-scrubbed reference cannot leave a generated table describing
 *   the one before it.
 *
 * This script NEVER WRITES. A gate that repaired what it found would report
 * success on a tree it had just changed, and CI would go green on a diff nobody
 * reviewed. `render-har-catalogue.js` is the writer.
 *
 * No finding ever echoes a request or response body: that would relocate the
 * leak into the CI log that reports it. Findings name a file, a row and a
 * field.
 *
 * Usage:
 *   node verify-har-catalogue.js [--dir <reference directory>]
 *
 * PASS --dir IN CI, for the reason verify-har-reference.js documents: the
 * default is the current directory, which is right when run from a capture's
 * own output folder and wrong anywhere else.
 *
 * Exit codes:
 *   0 -- the catalogue describes the references, and the README matches it
 *   1 -- the directory, catalogue.json or README.md is missing or unreadable
 *   3 -- one or more violations (reported on stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const cat = require(path.join(__dirname, 'har-catalogue.js'));

const DEFAULT_DIR = '.';

const EXIT_UNREADABLE = 1;
const EXIT_VIOLATIONS = 3;

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dir') out.dir = argv[++i];
        else if (a.startsWith('--')) {
            console.error(`verify-har-catalogue: unknown option ${a}`);
            process.exit(EXIT_UNREADABLE);
        }
    }
    return out;
}

/** How a row is named in a finding. Never the description, which may be long. */
function rowLabel(row, index) {
    return row.Action ? `row '${row.Action}'` : `row ${index}`;
}

/**
 * Compare one declared fact against the recomputed one.
 *
 * Arrays are compared as sorted JSON because `measureReference` already sorts
 * what it produces: a row that listed the same methods in a different order is
 * not wrong about the traffic, and reporting it would train people to distrust
 * the gate.
 */
function factDisagrees(declared, actual) {
    if (Array.isArray(actual)) {
        const left = Array.isArray(declared) ? [...declared].map(String).sort() : null;
        if (left === null) return true;
        return JSON.stringify(left) !== JSON.stringify([...actual].map(String).sort());
    }
    return declared !== actual;
}

/** Render a fact for a finding. Counts and endpoint names only -- never a body. */
function showFact(value) {
    return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/**
 * The falsifier.
 *
 * A row whose recomputed methods include POST, PUT or PATCH, on a reference
 * with zero request bodies, is claiming request-side behaviour the file cannot
 * support. Derived from the FILE rather than self-declared: the methods are
 * recomputed, so a row cannot dodge this by understating what it covers.
 *
 * The escape is a written reason, not a boolean. A bodyless POST is legal --
 * `POST /logout` is the everyday case -- and a gate that fired on real traffic
 * would be disabled within a week, costing every other check here. Requiring
 * prose puts the justification in the file, in the diff, under review.
 */
function checkRequestSideClaim(row, facts, report) {
    // PER-METHOD, never the file-wide `RequestBodies`. An earlier cut of this
    // read the file-wide count, and an independent review found the hole: one
    // GET carrying a body vouched for five bodyless POSTs beside it, so a row
    // reading "published five posts, each with a payload" passed untouched.
    // The question is whether the entries the row is ABOUT carry payloads, not
    // whether the file contains a payload somewhere.
    if (facts.BodyBearingEntries === 0 || facts.BodyBearingWithBody > 0) return;
    const bodyBearing = facts.Methods.filter((m) => cat.BODY_BEARING_METHODS.has(m));

    const reason = row.RequestBodiesAbsent;
    if (typeof reason === 'string' && reason.trim() !== '') return;

    report(
        `carries ${bodyBearing.join('/')} entries but NO request body, while the ` +
        'catalogue presents it as a worked example. As committed it documents the ' +
        'response and nothing about what a client sends, so a row describing ' +
        'request-side behaviour cannot be supported by it. Re-extract the entries ' +
        'from the preserved raw capture, correct the description to response-shape ' +
        'only, or record why there is no body in `RequestBodiesAbsent`');
}

function verifyDirectory(dir) {
    const violations = [];
    const entries = cat.readCatalogue(dir);

    // Every reference on disk, so coverage can be checked in both directions.
    const onDisk = new Set(cat.listReferences(dir));
    const claimedBy = new Map();

    // Lower-cased index, used ONLY to recognise a case-only mismatch and say so.
    //
    // It deliberately does not make such a row pass. Windows opens the file
    // whatever its case, so `Example/foo.har` reads fine here and does not
    // exist at all on a Linux runner -- accepting it would build a
    // passes-locally / fails-in-CI trap, which is a worse failure than the one
    // it replaces because it appears only after review.
    //
    // Without this the same mistake surfaced as two findings that contradict
    // each other: "names a file not in this directory" beside "a file no row
    // names", sending the reader hunting for a missing reference that is
    // sitting right there under a different capitalisation.
    const onDiskByLower = new Map();
    for (const file of onDisk) onDiskByLower.set(file.toLowerCase(), file);

    entries.forEach((row, index) => {
        const label = rowLabel(row, index);
        const report = (message) => violations.push(`${label}: ${message}`);

        const harFile = row.HarFile;
        if (!harFile) {
            // An `Observed` row is an endpoint nobody drove. It names no
            // reference by design, and requiring one would delete exactly the
            // knowledge those rows carry.
            if (row.Status !== 'Observed') {
                report('is Exercised -- a claim that a worked example exists -- but names '
                    + 'no HarFile. A row claiming a worked example that does not exist is '
                    + 'worse than no row; set Status to "Observed" or name the reference');
            }
            return;
        }

        if (claimedBy.has(harFile)) {
            report(`names ${harFile}, which ${claimedBy.get(harFile)} already claims. `
                + 'Two rows over one reference means at least one describes traffic the '
                + 'file does not hold, and a reader cannot tell which');
            return;
        }
        claimedBy.set(harFile, label);

        if (!onDisk.has(harFile)) {
            const actual = onDiskByLower.get(harFile.toLowerCase());
            if (actual) {
                // Claim the file anyway, so it is not ALSO reported as one no
                // row names. There is exactly one mistake here and the operator
                // should be told it once.
                claimedBy.set(actual, label);
                report(`names ${harFile}, but the file on disk is ${actual} -- `
                    + 'the paths differ only in case. This opens fine on a '
                    + 'case-insensitive filesystem and does not exist at all on a '
                    + 'case-sensitive one, so it passes here and fails in CI. '
                    + 'Correct HarFile to match the file exactly');
            } else {
                report(`names ${harFile}, which is not in this directory`);
            }
            return;
        }

        let facts;
        try {
            facts = cat.measureReference(path.join(dir, harFile));
        } catch (e) {
            report(`names ${harFile}, which cannot be read as a HAR: ${e.message}`);
            return;
        }

        for (const field of cat.MEASURED_FIELDS) {
            if (factDisagrees(row[field], facts[field])) {
                report(`declares ${field} ${showFact(row[field])} for ${harFile}, `
                    + `which actually has ${showFact(facts[field])}`);
            }
        }

        checkRequestSideClaim(row, facts, (message) => report(`${harFile} ${message}`));
    });

    for (const file of [...onDisk].sort()) {
        if (!claimedBy.has(file)) {
            violations.push(
                `${file}: is committed but no catalogue entry names it. A capture nobody `
                + 'catalogued is a capture nobody will find -- add a row saying what a '
                + 'human did to provoke it');
        }
    }

    return violations;
}

/**
 * Is the committed README what the committed catalogue renders to?
 *
 * Read and compare only. The repair is `render-har-catalogue.js`, run by a
 * person who then reviews the diff.
 */
function checkStaleness(dir) {
    const readmePath = path.join(dir, cat.README_FILE);
    if (!fs.existsSync(readmePath)) {
        return [`${cat.README_FILE}: is missing. The table is generated from `
            + `${cat.CATALOGUE_FILE}; run render-har-catalogue.js to create it`];
    }

    const existing = fs.readFileSync(readmePath, 'utf8');
    let expected;
    try {
        expected = cat.renderReadme(existing, cat.readCatalogue(dir),
            path.basename(path.resolve(dir)));
    } catch (e) {
        if (e instanceof cat.MissingMarkersError) {
            return [`${cat.README_FILE}: carries no generated region. ${e.message}`];
        }
        throw e;
    }

    if (expected === existing) return [];
    return [`${cat.README_FILE}: does not match what ${cat.CATALOGUE_FILE} renders to, `
        + 'so the committed table describes something other than the committed catalogue. '
        + 'Run render-har-catalogue.js and review the diff'];
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const dir = args.dir || DEFAULT_DIR;

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.error(`verify-har-catalogue: not a directory: ${dir}`);
        process.exit(EXIT_UNREADABLE);
    }

    let violations;
    try {
        // Both halves run before anything is reported. An operator who has to
        // re-run the gate once per defect fixes one and ships the rest.
        violations = [...verifyDirectory(dir), ...checkStaleness(dir)];
    } catch (e) {
        // The message, never the stack: a stack trace tells an operator where
        // the gate is, when what they need is what is wrong with their tree.
        console.error(`verify-har-catalogue: ${e.message}`);
        process.exit(EXIT_UNREADABLE);
    }

    if (violations.length === 0) {
        const count = cat.listReferences(dir).length;
        console.log(`verify-har-catalogue: ${count} reference(s) under ${dir} -- `
            + 'every row agrees with the file it names, and README.md matches the catalogue');
        process.exit(0);
    }

    console.error(`verify-har-catalogue: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(EXIT_VIOLATIONS);
}

if (require.main === module) main();

module.exports = { verifyDirectory, checkStaleness };
