#!/usr/bin/env node
'use strict';

/**
 * Reading and writing a HAR that is larger than a JavaScript string (issue #450).
 *
 * THE DEFECT THIS EXISTS TO CLOSE. Every stage in this pipeline read a capture
 * with `JSON.parse(fs.readFileSync(path, 'utf8'))`. That cannot produce a
 * string above Node's maximum string length (~512 MB in UTF-16 code units), so
 * a 1.7 GB capture is not slow to process -- it is impossible to open, and the
 * error is Node's internal "Cannot create a string longer than 0x1fffffe8
 * characters" rather than anything about captures. The largest, most
 * evidence-dense capture in the store was already past the limit and sat
 * unprocessable for eight days.
 *
 * THE WRITE SIDE IS THE SAME CLIFF, and it is the one that is easy to miss.
 * `JSON.stringify(doc, null, 2)` builds one string too, so a stage that read a
 * 1.7 GB capture entry by entry and then serialized the result in one call has
 * moved the failure, not removed it. That is why this module exports a writer
 * and not only a reader, and why the trim -- whose whole job is to write a
 * smaller copy of the biggest file in the store -- needs both halves.
 *
 * WHAT IS AND IS NOT STREAMED. The entries array is streamed; everything else
 * in the document is not. That is deliberate rather than a shortcut: in a HAR
 * the entries are the unbounded part and the envelope -- `version`, `creator`,
 * `browser`, `pages` -- is small by construction. Holding the envelope whole is
 * what lets callers keep using ordinary object access for it, and it is what
 * makes the byte-identical write below possible at all.
 *
 * BYTES, NOT CHARACTERS. The scan runs over the file's bytes and never decodes
 * them. Every byte this scanner tests for -- quote, backslash, brace, bracket,
 * comma, colon, whitespace -- is below 0x80, and every byte of a multi-byte
 * UTF-8 sequence is at or above 0x80, so a byte scanner cannot mistake part of
 * a multi-byte character for structure. Only the slice covering one entry is
 * decoded, and only then parsed.
 *
 * FAILING LOUDLY IS PART OF THE CONTRACT, not a nicety. A reader that cannot
 * find `log.entries` throws; it never yields zero entries. A capture that
 * reports as empty is worse than one that reports as broken, because every gate
 * downstream is then honest about a corpus that is silently short -- which is
 * the defect issue #423 is about. This module owes that issue a guarantee, not
 * a format: `HarStreamError` codes are translated at the boundary that issue
 * owns into the one error type callers catch.
 */

const fs = require('fs');

// Structural bytes. Named because a bare 0x7B in a comparison is unreadable,
// and because the byte-safety argument above only holds while every one of
// these is below 0x80.
const QUOTE = 0x22;
const BACKSLASH = 0x5C;
const LBRACE = 0x7B;
const RBRACE = 0x7D;
const LBRACKET = 0x5B;
const RBRACKET = 0x5D;
const COLON = 0x3A;
const COMMA = 0x2C;

// Whitespace as JSON defines it -- space, tab, line feed, carriage return.
// JSON permits nothing else between tokens, so any other byte is content.
function isSpace(b) {
    return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D;
}

/**
 * 1 MiB. Large enough that per-read overhead disappears against the scan, small
 * enough that the reader's memory does not scale with the file.
 *
 * TESTS OVERRIDE THIS DOWN TO SINGLE BYTES, and that is the point of exposing
 * it at all. Every piece of scanner state below -- `inString`, `escaped`, the
 * container stack, the key candidate, the element start -- is a boundary bug
 * waiting to happen. At 1 MiB a naive scanner passes, because a boundary almost
 * never lands inside a string or between a backslash and the byte it escapes.
 * At one byte every boundary lands somewhere awkward, which is the only way to
 * prove the state actually survives.
 */
const DEFAULT_CHUNK_SIZE = 1024 * 1024;

// The longest byte run considered as a possible object key. `log` and
// `entries` are the only keys this scanner cares about, so a cap keeps a
// multi-megabyte string VALUE from being buffered on the chance it is a key.
const MAX_KEY_BYTES = 256;

// THE CODE STRINGS ARE THE BOUNDARY'S VOCABULARY, not this module's.
//
// har-document.js owns the one error type callers catch, and exports these
// spellings frozen as HAR_FORMAT_CODES. Raising the same literals here makes its
// translation a pass-through rather than a lookup table that can be written
// wrong, and it means a code added on one side and forgotten on the other fails
// an assertion instead of quietly degrading to "unreadable". This module still
// does not IMPORT that one -- the boundary requires this engine, so a require
// back would be a cycle. Matching strings, not a shared constant, is what keeps
// that true.
const ENTRIES_NOT_FOUND = 'not-a-har';
const TRUNCATED = 'truncated';
const ENVELOPE_UNPARSEABLE = 'envelope-not-json';
const ENTRY_UNPARSEABLE = 'entry-not-json';
const ENTRY_TOO_LARGE = 'entry-too-large';

/**
 * Carries a `code` so a caller maps a cause to an exit status without matching
 * on message text. The messages are written for an operator looking at their
 * own capture, so they name the file; the codes are written for the pipeline,
 * so they are stable.
 */
class HarStreamError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'HarStreamError';
        this.code = code;
    }
}

/**
 * Decodes a captured key literal, quotes included.
 *
 * `JSON.parse` rather than a byte comparison because JSON permits a key to be
 * spelled with unicode escapes -- the six characters backslash-u-0-0-6-c in
 * place of the letter l. Nothing in this pipeline writes that, but a scanner
 * that silently fails to recognise an escaped key would skip the entries array
 * and report the file as not-a-HAR, which is exactly the loud-but-wrong answer
 * this module exists to avoid. The cap above keeps this cheap.
 */
function decodeKey(bytes) {
    try {
        const v = JSON.parse(Buffer.from(bytes).toString('utf8'));
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

/**
 * The single forward scan: finds the byte range of the `log.entries` array.
 *
 * Decodes nothing except candidate keys and parses nothing at all, so its cost
 * is one sequential pass over the file and its memory is one chunk.
 *
 * WHY A KEY PATH AND NOT A DEPTH COUNT. `entries` is a common key -- a captured
 * response body can contain one, at the same nesting depth. Matching on depth
 * alone would find the wrong array in a capture whose first entry happens to
 * carry a JSON document with an `entries` field. The chain of keys each
 * container was opened under is checked instead, so the array must be the
 * `entries` of the `log` of the root object and nothing else.
 */
function locateEntries(filePath, chunkSize) {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(chunkSize);

    // Scanner state that must survive a chunk boundary.
    let inString = false;
    let escaped = false;

    // `stack[i]` describes container i. `key` is the key it was opened under
    // (null for the root and for array elements); `pendingKey` is the most
    // recent confirmed key inside it, waiting to be claimed by the next value.
    const stack = [];

    // A string literal is only a key if the next non-space byte is a colon,
    // which is not known until after the string closes. The candidate is held
    // here in the meantime. `overflow` means it ran past MAX_KEY_BYTES and so
    // cannot be one of the two keys we care about.
    let keyBytes = null;
    let keyOverflow = false;
    let awaitingColon = false;

    let entriesDepth = -1;
    let entriesStart = -1;
    let entriesEnd = -1;

    let abs = 0;

    try {
        for (;;) {
            const read = fs.readSync(fd, buf, 0, chunkSize, null);
            if (read === 0) break;

            for (let i = 0; i < read; i += 1) {
                const b = buf[i];
                const at = abs + i;

                if (inString) {
                    if (keyBytes !== null) {
                        if (keyBytes.length < MAX_KEY_BYTES) keyBytes.push(b);
                        else keyOverflow = true;
                    }
                    if (escaped) {
                        escaped = false;
                    } else if (b === BACKSLASH) {
                        escaped = true;
                    } else if (b === QUOTE) {
                        inString = false;
                        awaitingColon = true;
                    }
                    continue;
                }

                if (awaitingColon) {
                    // The byte after a closed string decides whether that string
                    // was a key. Resolved before the structural handling below so
                    // that in `"entries": [` the key is recorded before the `[`.
                    if (b === COLON) {
                        const top = stack.length > 0 ? stack[stack.length - 1] : null;
                        if (top && top.type === 'obj') {
                            top.pendingKey = (keyBytes && !keyOverflow) ? decodeKey(keyBytes) : null;
                        }
                        awaitingColon = false;
                        keyBytes = null;
                        keyOverflow = false;
                        continue;
                    }
                    if (!isSpace(b)) {
                        awaitingColon = false;
                        keyBytes = null;
                        keyOverflow = false;
                        // Falls through: this byte is a real token and still
                        // needs the handling below.
                    } else {
                        continue;
                    }
                }

                if (isSpace(b)) continue;

                if (b === QUOTE) {
                    inString = true;
                    escaped = false;
                    keyBytes = [QUOTE];
                    keyOverflow = false;
                    continue;
                }

                if (b === LBRACE || b === LBRACKET) {
                    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
                    let openKey = null;
                    if (parent && parent.type === 'obj') {
                        openKey = parent.pendingKey;
                        parent.pendingKey = null;
                    }
                    stack.push({ type: b === LBRACE ? 'obj' : 'arr', key: openKey, pendingKey: null });

                    // stack is now [root, log, entries]. The root is opened under
                    // no key, so the chain is read from index 1.
                    if (entriesStart === -1 && b === LBRACKET
                        && stack.length === 3
                        && stack[0].type === 'obj'
                        && stack[1].type === 'obj' && stack[1].key === 'log'
                        && stack[2].key === 'entries') {
                        entriesDepth = stack.length;
                        entriesStart = at;
                    }
                    continue;
                }

                if (b === RBRACE || b === RBRACKET) {
                    stack.pop();
                    if (entriesStart !== -1 && entriesEnd === -1 && stack.length === entriesDepth - 1) {
                        entriesEnd = at + 1;
                    }
                    continue;
                }

                // Scalars need no handling here: they carry no structural byte
                // and no quote, and this pass records positions rather than
                // values.
            }

            abs += read;
        }
    } finally {
        fs.closeSync(fd);
    }

    if (entriesStart === -1) {
        throw new HarStreamError(
            `${filePath} has no log.entries array -- it is not a HAR document`,
            ENTRIES_NOT_FOUND);
    }
    if (entriesEnd === -1) {
        throw new HarStreamError(
            `${filePath} ends inside log.entries -- the capture is truncated`,
            TRUNCATED);
    }
    return { entriesStart, entriesEnd, size: abs };
}

// Reads an arbitrary byte range into a Buffer. Used only for the envelope's
// head and tail, which are small by construction; nothing here is applied to
// the entries region.
function readRange(filePath, start, end) {
    const length = end - start;
    const out = Buffer.allocUnsafe(length);
    const fd = fs.openSync(filePath, 'r');
    try {
        let got = 0;
        while (got < length) {
            const n = fs.readSync(fd, out, got, length - got, start + got);
            if (n === 0) break;
            got += n;
        }
        return out.subarray(0, got);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * The envelope: the document with `log.entries` replaced by an empty array, IN
 * ITS ORIGINAL KEY POSITION.
 *
 * The position is not cosmetic. JavaScript objects preserve insertion order and
 * `JSON.stringify` emits keys in that order, so reconstructing the envelope by
 * reading the head and tail around the entries array -- rather than by deleting
 * a key and adding it back -- is what lets the writer below reproduce a
 * byte-identical document. Rebuild the envelope any other way and `entries`
 * migrates to the end of `log`, which is a diff on every capture that round
 * trips.
 */
function readEnvelope(filePath, range) {
    const head = readRange(filePath, 0, range.entriesStart);
    const tail = readRange(filePath, range.entriesEnd, range.size);
    const text = head.toString('utf8') + '[]' + tail.toString('utf8');
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new HarStreamError(
            `${filePath} is not valid JSON outside log.entries: ${e.message}`,
            ENVELOPE_UNPARSEABLE);
    }
}

/**
 * Yields one parsed entry at a time from a located entries array.
 *
 * Scans only the entries region, so the cost of consuming entries is not paid
 * again for the envelope. Depth here is relative to the array itself: the
 * opening `[` is consumed by starting at `entriesStart + 1`, so an element
 * begins at any non-space byte seen while depth is zero.
 */
function* iterateEntries(filePath, range, chunkSize) {
    const start = range.entriesStart + 1;
    const end = range.entriesEnd - 1;
    if (end <= start) return;

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(chunkSize);

    let inString = false;
    let escaped = false;
    let depth = 0;

    // Bytes of the element currently being collected, as a list of slices so a
    // chunk boundary inside an entry costs a push rather than a copy of
    // everything seen so far.
    let pieces = null;
    let pieceStart = -1;
    let index = 0;

    const finishPiece = (upto) => {
        if (pieceStart !== -1 && upto > pieceStart) {
            pieces.push(Buffer.from(buf.subarray(pieceStart, upto)));
        }
        pieceStart = -1;
    };

    try {
        let pos = start;
        while (pos < end) {
            const want = Math.min(chunkSize, end - pos);
            const read = fs.readSync(fd, buf, 0, want, pos);
            if (read === 0) break;

            for (let i = 0; i < read; i += 1) {
                const b = buf[i];

                if (inString) {
                    if (escaped) escaped = false;
                    else if (b === BACKSLASH) escaped = true;
                    else if (b === QUOTE) inString = false;
                    continue;
                }

                // Element start: the first byte of a value while no element is
                // open. Checked before the structural handling so the `{` that
                // opens an entry is included in the element's own bytes.
                if (pieces === null && !isSpace(b) && b !== COMMA) {
                    pieces = [];
                    pieceStart = i;
                }

                if (b === QUOTE) {
                    inString = true;
                    escaped = false;
                    continue;
                }
                if (b === LBRACE || b === LBRACKET) { depth += 1; continue; }
                if (b === RBRACE || b === RBRACKET) { depth -= 1; continue; }

                if (b === COMMA && depth === 0 && pieces !== null) {
                    finishPiece(i);
                    yield parseEntry(pieces, index, filePath);
                    index += 1;
                    pieces = null;
                }
            }

            finishPiece(read);
            if (pieces !== null) pieceStart = 0;
            pos += read;
        }

        // The final element has no trailing comma; it is terminated by the `]`
        // that the range deliberately excludes.
        if (pieces !== null) {
            yield parseEntry(pieces, index, filePath);
        }
    } finally {
        fs.closeSync(fd);
    }
}

function parseEntry(pieces, index, filePath) {
    const bytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    let text;
    try {
        text = bytes.toString('utf8');
    } catch (e) {
        // A single entry larger than a JavaScript string. Streaming removes the
        // limit on the DOCUMENT; it cannot remove it from one entry, so this is
        // named rather than dressed up as a parse failure.
        throw new HarStreamError(
            `${filePath}: entry ${index} is ${bytes.length} bytes, larger than a single`
            + ' JavaScript string can hold, so it cannot be parsed on its own.'
            + ` (${e.message})`,
            ENTRY_TOO_LARGE);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new HarStreamError(
            `${filePath}: entry ${index} is not valid JSON: ${e.message}`,
            ENTRY_UNPARSEABLE);
    }
}

/**
 * Opens a capture for streaming.
 *
 * Returns the envelope up front -- callers need `log.version` and `log.pages`
 * before they have seen an entry, and a writer needs the envelope before it can
 * emit its first byte -- and an `entries()` generator that may be walked once
 * per call. The located range is computed once and shared, so calling
 * `entries()` twice re-reads the entries region but never re-scans the file.
 */
function openHarDocument(filePath, options) {
    const opts = options || {};
    const chunkSize = Math.max(1, opts.chunkSize || DEFAULT_CHUNK_SIZE);
    const range = locateEntries(filePath, chunkSize);
    const envelope = readEnvelope(filePath, range);
    return {
        envelope,
        range,
        entries: () => iterateEntries(filePath, range, chunkSize),
    };
}

// Marker for the writer. A NUL-delimited name because it must not collide with
// any value a real envelope could carry, and NUL cannot appear unescaped in
// JSON text -- so the needle below matches the marker and nothing else.
const ENTRIES_MARKER = '\u0000__HAR_STREAM_ENTRIES__\u0000';

/**
 * Writes a HAR whose entries come from an iterable, without ever building the
 * whole document as one string.
 *
 * BYTE-IDENTICAL TO `JSON.stringify(doc, null, 2)`, which is the property that
 * makes this safe to drop into a stage that used to serialize in one call: a
 * capture that fits in memory must round trip to exactly the bytes it did
 * before, or "streaming must not alter what is read" is an untested claim.
 *
 * How the indentation is derived rather than assumed: the envelope is
 * serialized once with a marker in place of the entries array, and the marker's
 * own column in that output gives the indentation `JSON.stringify` would have
 * used. Hard-coding six spaces would be right for today's `log.entries` and
 * wrong the moment an envelope nests differently.
 */
function writeHarDocument(outPath, envelope, entriesIterable, options) {
    const opts = options || {};
    const flag = opts.flag || 'w';

    // Refused rather than repaired. Inserting a missing `log.entries` would
    // silently succeed and put it at the END of `log`, which is both a diff on
    // every round trip and a sign the caller is holding something that is not
    // an envelope this module produced.
    if (!envelope || typeof envelope.log !== 'object' || envelope.log === null
        || !Object.prototype.hasOwnProperty.call(envelope.log, 'entries')) {
        throw new HarStreamError(
            `cannot write ${outPath}: the envelope has no log.entries to write entries into`,
            ENTRIES_NOT_FOUND);
    }

    const marked = Object.assign({}, envelope, {
        log: Object.assign({}, envelope.log, { entries: ENTRIES_MARKER }),
    });
    const text = JSON.stringify(marked, null, 2);
    const needle = JSON.stringify(ENTRIES_MARKER);
    const at = text.indexOf(needle);
    if (at === -1) {
        throw new HarStreamError(
            `cannot write ${outPath}: the envelope has no log.entries to write entries into`,
            ENTRIES_NOT_FOUND);
    }
    // The marker must be unique, and this is checked rather than argued for.
    //
    // It is NUL-delimited precisely so that no real envelope can contain it, and
    // that reasoning is sound: a capture would have to carry the two-character
    // escape for NUL in a string value on purpose. But the failure mode if the
    // reasoning is ever wrong is the worst kind available here -- the write
    // would splice at the wrong occurrence and produce a WRONG document
    // silently, with no error and a plausible-looking file. A second
    // `indexOf` is the entire cost of turning that into a refusal, and this
    // module's whole argument is that a loud failure beats a quiet wrong answer.
    if (text.indexOf(needle, at + needle.length) !== -1) {
        throw new HarStreamError(
            `cannot write ${outPath}: the envelope's own content collides with the marker`
            + ' this writer uses to find log.entries, so the entries cannot be placed'
            + ' unambiguously. Nothing was written.',
            ENVELOPE_UNPARSEABLE);
    }

    const lineStart = text.lastIndexOf('\n', at) + 1;
    const keyIndent = /^[ ]*/.exec(text.slice(lineStart, at))[0];
    const elementIndent = keyIndent + '  ';

    const head = text.slice(0, at);
    const tail = text.slice(at + needle.length);

    const fd = fs.openSync(outPath, flag);
    // Buffered rather than one write per entry: an entry is typically a few KB
    // and a syscall each would dominate. Flushed on a size threshold so the
    // buffer itself never becomes the memory the streaming was meant to avoid.
    let pending = '';
    const FLUSH_AT = 4 * 1024 * 1024;
    const push = (s) => {
        pending += s;
        if (pending.length >= FLUSH_AT) {
            fs.writeSync(fd, pending, null, 'utf8');
            pending = '';
        }
    };

    let count = 0;
    try {
        push(head);
        push('[');
        for (const entry of entriesIterable) {
            push(count === 0 ? '\n' : ',\n');
            // `JSON.stringify` indents by depth from its own root, so each
            // entry is re-indented to the depth it sits at in the document.
            // Only newlines inside the entry are touched; string contents carry
            // their newlines escaped, so no value can be corrupted by this.
            push(elementIndent + JSON.stringify(entry, null, 2).replace(/\n/g, '\n' + elementIndent));
            count += 1;
        }
        // An empty array is `[]` on one line, which is what JSON.stringify
        // emits and therefore what byte-identity requires.
        if (count > 0) push('\n' + keyIndent);
        push(']');
        push(tail);
        if (pending.length > 0) fs.writeSync(fd, pending, null, 'utf8');
    } finally {
        fs.closeSync(fd);
    }
    return { entries: count };
}

module.exports = {
    HarStreamError,
    openHarDocument,
    writeHarDocument,
    DEFAULT_CHUNK_SIZE,
    codes: {
        ENTRIES_NOT_FOUND,
        TRUNCATED,
        ENVELOPE_UNPARSEABLE,
        ENTRY_UNPARSEABLE,
        ENTRY_TOO_LARGE,
    },
};
