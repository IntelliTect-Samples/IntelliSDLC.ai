#!/usr/bin/env node
'use strict';

/**
 * How large a capture may be before whole-document tooling cannot read it, and
 * what to say about it (issue #528).
 *
 * THE DEFECT THIS EXISTS TO CLOSE. A capture session recorded an 816 MB
 * `raw.har`. The scrub read it with a single `readFileSync(..., 'utf8')`, so it
 * failed -- after the browsing was over, the account writes were spent, and the
 * only artifact left was the credential-bearing raw that must not be shared.
 * What it printed was:
 *
 *     Cannot create a string longer than 0x1fffffe8 characters
 *
 * That text names neither the file, nor its size, nor the limit, and requires
 * the reader to already know it is Node's maximum string length to interpret it
 * at all. Three separate things were wrong and each is fixed somewhere
 * different: the failure arrives too late (the recorder now warns while the
 * session is live), the message is unreadable (this module writes the readable
 * one), and the document is read whole (streaming, issue #450).
 *
 * THE LIMIT IS DISCOVERED, NOT COPIED. `0x1fffffe8` has already changed once
 * across Node major versions and a hand-written copy is a number that silently
 * stops being true. It is read from the runtime.
 *
 * BYTES ARE AN UPPER BOUND, NOT THE STRING LENGTH. The limit counts UTF-16 code
 * units; a file size counts bytes. Every UTF-8 sequence yields at most as many
 * code units as it has bytes, so a file at or under the limit ALWAYS fits --
 * the preflight never refuses something that would have worked. The converse
 * does not hold: a multi-byte-heavy file above the limit might have fitted.
 * Refusing it anyway is the deliberate trade. A capture that large fails at the
 * next stage regardless, and a refusal naming the file and the limit is worth
 * more than a rare false refusal is worth avoiding -- it costs a message, not a
 * capture, because the raw is never touched.
 *
 * WHICH IS WHY RECOGNITION EXISTS AS WELL. Serialization inflates a document
 * past the size it was read at -- pretty-printing alone adds indentation to
 * every line -- so a file that passes the preflight can still hit the ceiling
 * later. `isStringTooLongError` plus `describeStringLimitFailure` put the same
 * readable message on that path rather than pretending the exact ceiling can be
 * computed in advance.
 *
 * NO NEW OPTION AND NO NEW ENVIRONMENT VARIABLE. The limit belongs to the
 * runtime and the threshold is derived from it. A `--max-bytes` switch would be
 * a knob whose only correct setting is the one computed here.
 */

const buffer = require('buffer');

// Node's own ceiling, in UTF-16 code units. Whatever this runtime says it is.
const MAX_STRING_LENGTH = buffer.constants.MAX_STRING_LENGTH;

// Where "still fine" becomes "say something while there is still time to act".
//
// Three fifths, not nine tenths. The warning's entire value is that the
// operator can still stop, split the session, or narrow the filter, and a
// capture grows while they decide -- a threshold close to the ceiling announces
// a problem the operator can no longer avoid. Three fifths of 512 MB is around
// 320 MB, comfortably above every ordinary capture in the store and far enough
// below the cliff to leave room for a decision.
const WARN_FRACTION = 0.6;
const WARN_BYTES = Math.floor(MAX_STRING_LENGTH * WARN_FRACTION);

const ONE_KB = 1024;
const ONE_MB = ONE_KB * 1024;
const ONE_GB = ONE_MB * 1024;

/**
 * A size a human reads, with the exact byte count kept alongside it.
 *
 * Both halves, always. "816 MB" is the half an operator reasons about; the
 * exact bytes are the half that can be compared against the limit, quoted in an
 * issue, or matched against what `ls` reported. Rounding away the second is how
 * two numbers that differ come to look identical in a report.
 */
function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown size';
    let human;
    if (bytes >= ONE_GB) human = (bytes / ONE_GB).toFixed(1) + ' GB';
    else if (bytes >= ONE_MB) human = (bytes / ONE_MB).toFixed(1) + ' MB';
    else if (bytes >= ONE_KB) human = (bytes / ONE_KB).toFixed(1) + ' KB';
    else human = bytes + ' bytes';
    return `${human} (${bytes} bytes)`;
}

/**
 * Which band a capture of this size falls in, and the sentence that says so.
 *
 * Pure: bytes in, verdict out. The caller does its own single `statSync`. That
 * keeps the decision testable without producing a 512 MB file, and keeps one
 * definition of the bands rather than one per caller.
 *
 * Boundaries belong to the band BELOW them -- a file exactly at the limit still
 * reads, and a file exactly at the threshold has not yet crossed it.
 */
function assessCaptureSize(bytes, filePath) {
    const where = filePath || 'the capture';
    if (!Number.isFinite(bytes) || bytes < 0) {
        return { status: 'ok', bytes, limit: MAX_STRING_LENGTH, warnAt: WARN_BYTES, message: null };
    }
    if (bytes > MAX_STRING_LENGTH) {
        return {
            status: 'exceeds',
            bytes,
            limit: MAX_STRING_LENGTH,
            warnAt: WARN_BYTES,
            message:
                `${where} is ${formatSize(bytes)}, larger than the ` +
                `${formatSize(MAX_STRING_LENGTH)} that can be held as a single string. ` +
                'Tooling that reads a capture whole cannot open a file this large.'
        };
    }
    if (bytes > WARN_BYTES) {
        return {
            status: 'warn',
            bytes,
            limit: MAX_STRING_LENGTH,
            warnAt: WARN_BYTES,
            message:
                `${where} is ${formatSize(bytes)} and approaching the ` +
                `${formatSize(MAX_STRING_LENGTH)} ceiling on a single string, ` +
                'above which tooling that reads a capture whole stops working.'
        };
    }
    return { status: 'ok', bytes, limit: MAX_STRING_LENGTH, warnAt: WARN_BYTES, message: null };
}

/**
 * Is this the string-length ceiling, however it arrived?
 *
 * THREE SPELLINGS, BECAUSE THE RUNTIME HAS THREE, and they are not
 * interchangeable. Which one arrives depends on which layer noticed:
 *
 *   ERR_STRING_TOO_LONG          Node's own, from `readFileSync(..., 'utf8')`
 *                                decoding a buffer that is already in hand.
 *   "Cannot create a string      the message that coded error carries. Matched
 *    longer than ..."            separately so a path that loses the `code`
 *                                while wrapping the error is still recognised.
 *   "Invalid string length"      V8's, raised by `JSON.stringify` and by string
 *                                concatenation. NOT the Node message, and the
 *                                one this module originally missed -- which
 *                                made the serialization branch of the scrub
 *                                dead code that re-threw a raw RangeError after
 *                                the whole scrub had run.
 *
 * The third is a generic V8 message rather than a dedicated code, so matching
 * it is deliberately narrowed to a RangeError. That is the only error class V8
 * raises it as, and the alternative -- not recognising it -- is the defect.
 */
function isStringTooLongError(err) {
    if (!err) return false;
    if (err.code === 'ERR_STRING_TOO_LONG') return true;
    if (typeof err.message !== 'string') return false;
    if (/Cannot create a string longer than/i.test(err.message)) return true;
    return err instanceof RangeError && /^Invalid string length$/i.test(err.message);
}

/**
 * The readable form of a string-length failure that Node raised anyway.
 *
 * Names the stage as well as the file, because "reading the capture" and
 * "serializing the scrubbed document" fail at different input sizes, and an
 * operator told only "too large" about a file they can see is 300 MB has been
 * given a message that reads as wrong.
 */
function describeStringLimitFailure({ filePath, bytes, stage } = {}) {
    const where = filePath || 'the capture';
    const doing = stage || 'processing the capture';
    const sized = Number.isFinite(bytes) && bytes >= 0 ? `, ${formatSize(bytes)},` : '';
    return (
        `${where}${sized} exceeded the ${formatSize(MAX_STRING_LENGTH)} ceiling on a ` +
        `single string while ${doing}. Nothing this size can be processed in one piece.`
    );
}

module.exports = {
    MAX_STRING_LENGTH,
    WARN_BYTES,
    WARN_FRACTION,
    formatSize,
    assessCaptureSize,
    isStringTooLongError,
    describeStringLimitFailure,
};
