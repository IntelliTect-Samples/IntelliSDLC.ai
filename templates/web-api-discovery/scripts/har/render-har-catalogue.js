#!/usr/bin/env node
/**
 * render-har-catalogue.js -- write the human-facing table from catalogue.json.
 *
 * The catalogue used to BE the table: prose rows in a README, which is why a
 * row could claim "one Only-Me post with two people tagged" about a reference
 * that carries no request body at all, and nothing could tell. `catalogue.json`
 * is now the source of truth and this renders it.
 *
 * This script only WRITES. It is not the gate -- `verify-har-catalogue.js`
 * checks the rows against the references and fails on a stale README. Keeping
 * the writer and the judge apart is what lets CI run one command that never
 * modifies the tree it is checking.
 *
 * ONLY the region between the markers is written:
 *
 *   <!-- BEGIN GENERATED CATALOGUE -- edit catalogue.json, not this table -->
 *   <!-- END GENERATED CATALOGUE -->
 *
 * Everything outside them is hand-written and survives verbatim -- the
 * provenance notes, the naming convention, the re-capture recipe. Those are
 * the part of the file nobody can regenerate, and a generator that ate one
 * would be worse than the prose table it replaced. A README with no markers is
 * therefore an ERROR, not an invitation to guess where the table goes.
 *
 * Usage:
 *   node render-har-catalogue.js [--dir <reference directory>]
 *
 * Exit codes:
 *   0 -- README written (or already correct)
 *   1 -- the directory or catalogue.json is missing, or unreadable
 *   2 -- README.md exists but carries no generated region
 */

'use strict';

const fs = require('fs');
const path = require('path');

const cat = require(path.join(__dirname, 'har-catalogue.js'));

// Matches verify-har-reference.js: a reference directory is where you already
// are when you run this from a capture's own output folder.
const DEFAULT_DIR = '.';

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dir') out.dir = argv[++i];
        else if (a.startsWith('--')) {
            console.error(`render-har-catalogue: unknown option ${a}`);
            process.exit(1);
        }
    }
    return out;
}

/**
 * Render one reference directory. Returns the text written, or null when the
 * file was already correct.
 *
 * Writing only on a change keeps the mtime stable, so a watch or an
 * incremental build is not woken by a run that decided nothing.
 */
function renderDirectory(dir) {
    const entries = cat.readCatalogue(dir);
    const readmePath = path.join(dir, cat.README_FILE);

    let existing = null;
    if (fs.existsSync(readmePath)) existing = fs.readFileSync(readmePath, 'utf8');

    const next = cat.renderReadme(existing, entries, path.basename(path.resolve(dir)));
    if (existing !== null && next === existing) return null;

    // `renderReadme` has already matched the file's own line endings, so this
    // writes the string as given. Do NOT add normalisation here: rewriting a
    // consumer's CRLF README as LF would dirty their tree on the first run and
    // make the staleness gate the thing that did it.
    fs.writeFileSync(readmePath, next, { encoding: 'utf8' });
    return next;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const dir = args.dir || DEFAULT_DIR;

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.error(`render-har-catalogue: not a directory: ${dir}`);
        process.exit(1);
    }

    let written;
    try {
        written = renderDirectory(dir);
    } catch (e) {
        if (e instanceof cat.MissingMarkersError) {
            console.error(`render-har-catalogue: ${path.join(dir, cat.README_FILE)}`);
            console.error(e.message);
            process.exit(2);
        }
        console.error(`render-har-catalogue: ${e.message}`);
        process.exit(1);
    }

    const readmePath = path.join(dir, cat.README_FILE);
    console.log(written === null
        ? `render-har-catalogue: ${readmePath} already matches ${cat.CATALOGUE_FILE}`
        : `render-har-catalogue: wrote ${readmePath} from ${cat.CATALOGUE_FILE}`);
    process.exit(0);
}

if (require.main === module) main();

module.exports = { renderDirectory };
