#!/usr/bin/env node
/**
 * trim-har-capture.js -- drop the cruft from a raw capture, keep it raw.
 *
 * A capture store is gigabytes of fonts, images and beacons wrapped around a
 * few hundred kilobytes of the calls anyone cares about. Until now the only way
 * to make a capture smaller was `extract-har-reference.js`, which also SCRUBS
 * it -- and that is a one-way door, because a scrubbed artifact cannot be
 * re-scrubbed with a corrected profile. So the real choice was "keep gigabytes"
 * or "lose the ability to reprocess", and everyone kept the gigabytes.
 *
 * This drops the cruft and leaves the capture RAW: still unscrubbed, still
 * carrying live credentials, still belonging under `.har-captures/`, and still
 * something every later stage of the pipeline can consume as though it were the
 * original recording. Which is the point -- scrub, catalogue and the API
 * document all run on the output exactly as they would have on the input.
 *
 * WHAT IT WILL NOT DO, and why that is the important half:
 *
 *   - It never writes to the input. Not with a flag, not with a force. This is
 *     a lossy, irreversible operation against the only ground truth that exists
 *     about someone else's API, applied to recordings that cannot be repeated.
 *     Removing the original is a separate act, taken by a person who has looked
 *     at what came out.
 *   - It never overwrites an existing output.
 *   - It never writes an EMPTY capture. Every entry being cruft means the
 *     capture or the classifier is wrong, and a zero-entry HAR passes every
 *     downstream gate while proving nothing.
 *
 * The classification -- what counts as an asset or a beacon -- is NOT decided
 * here. It comes from har-entry-class.js, shared with extract-har-reference.js,
 * because two implementations that agree today are how a filter and the thing
 * it feeds drift into disagreeing about what a beacon is.
 *
 * TRIM RAWS, NEVER REFERENCES. A committed reference's `EntryCount` and
 * `Endpoints` are facts the catalogue declares and verify-har-catalogue.js
 * recomputes from the file. Trimming a reference would make its row false and
 * fail that guard -- correct behaviour, and a confusing way to discover it.
 *
 * Usage:
 *   node trim-har-capture.js --in <raw.har> --out <trimmed.har>
 *
 * Exit codes:
 *   0 -- written
 *   1 -- input missing, unreadable, or not a HAR
 *   2 -- refused: would overwrite the input or an existing output
 *   3 -- refused: nothing would survive the trim
 */

'use strict';

const fs = require('fs');
const path = require('path');

const entryClass = require(path.join(__dirname, 'har-entry-class.js'));
const { classifyEntries, reportLines, KEPT_CATEGORIES } = entryClass;

const EXIT_UNREADABLE = 1;
const EXIT_REFUSED = 2;
const EXIT_EMPTY = 3;

function usage(msg) {
    if (msg) console.error(`trim-har-capture: ${msg}`);
    console.error([
        'usage: node trim-har-capture.js --in <raw.har> --out <trimmed.har>',
        '',
        '  Keeps API calls, documents, and anything not provably a static asset or a',
        '  beacon. Drops the rest. The output is still a RAW, UNSCRUBBED capture and',
        '  belongs under .har-captures/ exactly as the input does.',
        '',
        '  The input is never modified and an existing output is never overwritten.',
        '  Delete the original yourself, once you have looked at what came out.',
    ].join('\n'));
    process.exit(EXIT_UNREADABLE);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) usage(`unexpected argument '${a}'`);
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) usage(`--${key} needs a value`);
        out[key] = next; i++;
    }
    return out;
}

function fail(message, code) {
    console.error(`trim-har-capture: ${message}`);
    process.exit(code);
}

/**
 * Same file, whatever the caller spelled?
 *
 * Compared by resolved real path, not by string. `./raw.har` and an absolute
 * path to the same file are the same file, and on a case-insensitive filesystem
 * so are two different spellings of its name. A string comparison would let the
 * one thing this command must never do through on a technicality.
 */
function samePath(a, b) {
    try {
        return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
        return path.resolve(a) === path.resolve(b);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.in) usage('--in is required');
    if (!args.out) usage('--out is required');

    if (!fs.existsSync(args.in)) fail(`no such capture: ${args.in}`, EXIT_UNREADABLE);

    // Checked BEFORE anything is read or written. A refusal that arrived after
    // the output was opened would already have truncated it.
    if (samePath(args.in, args.out)) {
        fail(`--out is the same file as --in: ${args.in}\n`
            + '  This command never writes over a capture. The raw is the only copy of the\n'
            + '  recording, and a trim cannot be undone. Write somewhere else, look at the\n'
            + '  result, then remove the original yourself.', EXIT_REFUSED);
    }
    if (fs.existsSync(args.out)) {
        fail(`--out already exists: ${args.out}\n`
            + '  Refusing to replace it. Choose another path or move it aside.', EXIT_REFUSED);
    }

    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(args.in, 'utf8'));
    } catch (e) {
        // The message, never the stack: an operator needs to know what is wrong
        // with their file, not where this script is.
        fail(`cannot read ${args.in} as a HAR: ${e.message}`, EXIT_UNREADABLE);
    }
    const entries = doc && doc.log && Array.isArray(doc.log.entries) ? doc.log.entries : null;
    if (entries === null) {
        fail(`${args.in} has no log.entries -- it is not a HAR document`, EXIT_UNREADABLE);
    }

    const report = classifyEntries(entries);
    const kept = report.classified
        .filter((c) => KEPT_CATEGORIES.includes(c.category))
        .map((c) => c.entry);

    for (const line of reportLines(report, entries.length)) console.log(line);

    if (kept.length === 0) {
        fail(`every one of the ${entries.length} entries classified as cruft, so nothing would\n`
            + '  survive. That means the capture or the classifier is wrong, and a zero-entry\n'
            + '  HAR would pass every downstream gate while proving nothing. Nothing written.',
        EXIT_EMPTY);
    }

    // The log envelope is preserved, not rebuilt: `version`, `creator`,
    // `browser` and `pages` are what make this a HAR the rest of the pipeline
    // reads without knowing it was trimmed.
    const trimmed = Object.assign({}, doc, {
        log: Object.assign({}, doc.log, { entries: kept }),
    });

    fs.writeFileSync(args.out, JSON.stringify(trimmed, null, 2), 'utf8');

    const before = fs.statSync(args.in).size;
    const after = fs.statSync(args.out).size;
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    console.log(`trim-har-capture: wrote ${args.out}`);
    console.log(`  ${kept.length} of ${entries.length} entries, `
        + `${(after / 1048576).toFixed(1)} MB from ${(before / 1048576).toFixed(1)} MB (${pct}% smaller)`);
    console.log('  The output is RAW and UNSCRUBBED. It belongs under .har-captures/.');
    console.log(`  ${args.in} is unchanged -- remove it yourself once you have checked the result.`);
    process.exit(0);
}

if (require.main === module) main();

module.exports = { samePath };
