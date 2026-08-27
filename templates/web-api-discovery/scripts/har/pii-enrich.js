#!/usr/bin/env node
/**
 * pii-enrich.js -- opt-in LLM enrichment pass for the web-api-discovery
 * scrub pipeline (issue #46).
 *
 * STATUS: stub. A full LLM-driven rewrite is intentionally deferred per the
 * "stretch" clause of the original plan. See follow-up issue for the
 * end-to-end implementation that streams the detected-PII list + a rewrite
 * prompt over stdin/stdout to a pluggable provider.
 *
 * Current behavior:
 *   - With no LLM_PROVIDER env var set: prints an informational message and
 *     exits 0. No HAR mutation occurs.
 *   - With LLM_PROVIDER=stub: prints a "stub provider applied (0 rewrites)"
 *     message and exits 0. The HAR file is copied to --out unchanged.
 *
 * Usage:
 *   node pii-enrich.js --in <scrubbed.har> [--out <enriched.har>]
 */

'use strict';

const fs = require('fs');

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
        console.error('usage: node pii-enrich.js --in <har> [--out <har>]');
        process.exit(2);
    }
    const provider = process.env.LLM_PROVIDER;
    if (!provider) {
        console.log('pii-enrich: LLM enrichment requested but no provider plugged in (set LLM_PROVIDER); skipping.');
        process.exit(0);
    }
    if (provider === 'stub') {
        if (args.out) {
            try {
                fs.copyFileSync(args.in, args.out);
            } catch (e) {
                console.error(`pii-enrich: failed to copy ${args.in} -> ${args.out}: ${e.message}`);
                process.exit(1);
            }
        }
        console.log('pii-enrich: stub provider applied (0 rewrites).');
        process.exit(0);
    }
    console.error(`pii-enrich: unsupported LLM_PROVIDER='${provider}'. Stub-only build; see issue #46 follow-up.`);
    process.exit(0);
}

main();
