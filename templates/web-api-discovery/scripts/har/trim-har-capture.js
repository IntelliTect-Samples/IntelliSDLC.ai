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
const { createClassificationAccumulator, reportLines, KEPT_CATEGORIES } = entryClass;
const harStream = require(path.join(__dirname, '..', 'lib', 'har-stream.js'));
// The boundary that names the codes the engine raises, so every stage refuses
// an unreadable capture in the same words (issue #423).
const harDocument = require(path.join(__dirname, 'har-document.js'));

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
 * Resolved real paths where both exist, so `./raw.har`, an absolute path, a
 * symlink and a junction to one file all compare equal.
 *
 * BE HONEST ABOUT WHEN THIS ACTUALLY FIRES. In the normal invocation the output
 * does NOT exist yet -- that is the whole point -- so `realpathSync` throws
 * ENOENT on it and this degrades to a plain `path.resolve` comparison that
 * resolves no links on either side. The protection in that case comes from the
 * separate "output already exists" refusal, not from here: any alias of the
 * input necessarily exists on disk, so that check catches it.
 *
 * This is therefore the second of two guards, not the first, and it earns its
 * place only for the case where the caller names an existing output that is an
 * alias of the input. Documented rather than removed, because a comment
 * crediting the wrong mechanism is how the next person deletes the check that
 * is really doing the work.
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

    // TWO PASSES OVER THE CAPTURE, and the second one is not waste.
    //
    // The refusals above are worth nothing if they arrive after the output has
    // been opened, and the "nothing would survive" refusal cannot be made until
    // every entry has been classified. The old whole-document read got that for
    // free by holding the entire capture in memory -- which is exactly what
    // made this command unable to open the largest capture in the store at all
    // (issue #450). So the classification pass streams and retains nothing, and
    // the write pass streams again. Two sequential reads of a file are cheap;
    // holding a 1.7 GB capture as objects is not possible.
    let doc;
    try {
        doc = harStream.openHarDocument(args.in);
    } catch (e) {
        // The message, never the stack: an operator needs to know what is wrong
        // with their file, not where this script is.
        //
        // Translated through the boundary rather than relayed raw (issue #423).
        // The engine cannot import har-document.js -- the boundary requires the
        // engine, and a require back would be a cycle -- so it raises its own
        // error carrying one of the boundary's codes, and this is where the two
        // meet. Every stage then refuses an unreadable capture in the same
        // words, which is the whole point of there being one boundary.
        fail(harDocument.fromEngineError(e, args.in).message, EXIT_UNREADABLE);
    }

    const accumulator = createClassificationAccumulator();
    try {
        for (const entry of doc.entries()) accumulator.add(entry);
    } catch (e) {
        // What reaches HERE rather than the open is the per-entry pair --
        // `entry-not-json` and `entry-too-large` -- because those are the only
        // conditions the engine cannot know until it decodes and parses an
        // individual entry. Truncation is NOT one of them: the open locates the
        // entries array by scanning for its closing bracket, so a document that
        // ends mid-entries is refused before a single entry is yielded.
        // (Verified against the engine rather than assumed: a truncated capture
        // fails at the open with `truncated`, a corrupt entry fails here with
        // `entry-not-json`.)
        //
        // Same translation and same exit code either way, so the operator is
        // told which of the two happened in the same words every other stage
        // uses.
        if (e instanceof harStream.HarStreamError) {
            fail(harDocument.fromEngineError(e, args.in).message, EXIT_UNREADABLE);
        }
        throw e;
    }
    const report = accumulator.report();

    for (const line of reportLines(report, report.scanned)) console.log(line);

    if (report.kept === 0) {
        fail(`every one of the ${report.scanned} entries classified as cruft, so nothing would
  survive. That means the capture or the classifier is wrong, and a zero-entry
  HAR would pass every downstream gate while proving nothing. Nothing written.`,
        EXIT_EMPTY);
    }

    // The parent may not exist. extract-har-reference.js creates it for the
    // same reason: without this the write throws a bare ENOENT and the operator
    // gets a Node stack trace under an exit code that means something else.
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });

    // The log envelope is preserved, not rebuilt: `version`, `creator`,
    // `browser` and `pages` are what make this a HAR the rest of the pipeline
    // reads without knowing it was trimmed -- and preserving it in place keeps
    // `entries` at the key position it had, so a capture that needed no trim
    // round trips to the bytes it started with.
    //
    // 'wx' -- fail if it exists, rather than truncate. The existence check
    // earlier happens before the input is read and classified, which on the
    // multi-gigabyte captures this command targets is a real wall-clock window.
    // Without the flag, anything that appeared in that window would be silently
    // overwritten, and the promise never to clobber an output would hold only
    // when nothing raced it.
    const kept = (function* () {
        const second = createClassificationAccumulator();
        for (const entry of doc.entries()) {
            if (KEPT_CATEGORIES.includes(second.add(entry).category)) yield entry;
        }
        // The two passes must agree. They classify the same bytes with the same
        // pure function, so a disagreement means the file changed underneath
        // this command -- which would make the report printed above a
        // description of something other than what was just written.
        const again = second.report();
        if (again.kept !== report.kept || again.scanned !== report.scanned) {
            throw new Error(
                `${args.in} changed while it was being trimmed: classified `
                + `${report.kept}/${report.scanned} entries, then `
                + `${again.kept}/${again.scanned}. Nothing written can be trusted.`);
        }
    })();

    let written;
    try {
        written = harStream.writeHarDocument(args.out, doc.envelope, kept, { flag: 'wx' });
    } catch (e) {
        if (e.code === 'EEXIST') {
            // NOT ours to remove. 'wx' failed because the file was already
            // there, so it belongs to whatever put it there.
            fail(`${args.out} appeared while this capture was being read. Refusing to
  replace it. Nothing was written.`, EXIT_REFUSED);
        }
        // Everything else failed AFTER 'wx' created the file, so what is on
        // disk is a partial capture. Removed rather than left: the refusal
        // above means the next run would decline to overwrite it, and the
        // operator would be told their output already exists when what exists
        // is a fragment of a failed run. A truncated HAR that later reads as a
        // capture is the worse half of the same problem.
        let removed = true;
        try { fs.unlinkSync(args.out); } catch { removed = false; }
        fail(`cannot write ${args.out}: ${e.message}\n`
            + (removed
                ? '  The partial output was removed.'
                : `  A PARTIAL output may remain at ${args.out} -- delete it before retrying.`),
        EXIT_UNREADABLE);
    }

    const before = fs.statSync(args.in).size;
    const after = fs.statSync(args.out).size;
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    console.log(`trim-har-capture: wrote ${args.out}`);
    console.log(`  ${written.entries} of ${report.scanned} entries, `
        + `${(after / 1048576).toFixed(1)} MB from ${(before / 1048576).toFixed(1)} MB (${pct}% smaller)`);
    console.log('  The output is RAW and UNSCRUBBED. It belongs under .har-captures/.');
    console.log(`  ${args.in} is unchanged -- remove it yourself once you have checked the result.`);
    process.exit(0);
}

if (require.main === module) main();

module.exports = { samePath };
