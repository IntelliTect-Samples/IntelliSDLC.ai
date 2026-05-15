#!/usr/bin/env node
/**
 * capture-cdp.js -- Playwright CDP-attach HAR capture baseline.
 *
 * Launches Chromium via Playwright. When --storage-state is provided,
 * loads the storage state and skips interactive login. Captures all
 * network traffic to a HAR file. Polite-crawl defaults: descriptive
 * User-Agent and ~1 req/sec throttle on automated traversal.
 *
 * Usage:
 *   node capture-cdp.js --url <baseUrl> --out <out.har> [--storage-state <path>] [--headless] [--throttle-ms 1000]
 *
 * Notes:
 *   - This is a template consumed by the api-wrapper-scaffold agent. The
 *     agent substitutes default values (project name in UA, output path)
 *     at scaffold time; the script itself reads everything from CLI args
 *     so it is testable with `node --check` and runnable standalone.
 *   - Requires `playwright` to be installed at runtime in the consumer
 *     project (not in this repo).
 *
 * Exit codes:
 *   0 -- HAR written successfully
 *   1 -- argument or runtime error
 */

'use strict';

const path = require('path');

function parseArgs(argv) {
    const out = { headless: false, 'throttle-ms': 1000 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--headless') { out.headless = true; continue; }
        if (a.startsWith('--')) {
            out[a.slice(2)] = argv[i + 1];
            i++;
        }
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.url || !args.out) {
        console.error('usage: node capture-cdp.js --url <baseUrl> --out <out.har> [--storage-state <path>] [--headless] [--throttle-ms 1000]');
        process.exit(1);
    }

    let playwright;
    try {
        playwright = require('playwright');
    } catch (e) {
        console.error('capture-cdp: playwright module not found. Run `npm install playwright` first.');
        process.exit(1);
    }

    const projectUA = process.env.CAPTURE_USER_AGENT
        || 'api-wrapper-scaffold/0.1 (+https://github.com/IntelliTect-Samples/IntelliSDLC.ai)';
    const throttleMs = Number(args['throttle-ms']) || 1000;

    const browser = await playwright.chromium.launch({ headless: !!args.headless });
    const contextOptions = {
        userAgent: projectUA,
        recordHar: { path: path.resolve(args.out), mode: 'full', content: 'embed' }
    };
    if (args['storage-state']) {
        contextOptions.storageState = args['storage-state'];
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Polite crawl: throttle requests by inserting a small delay.
    await context.route('**/*', async (route) => {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * throttleMs)));
        return route.continue();
    });

    console.log(`capture-cdp: navigating to ${args.url}`);
    await page.goto(args.url, { waitUntil: 'networkidle' });

    if (!args.headless && !args['storage-state']) {
        console.log('capture-cdp: interact with the browser to drive the capture. Press Ctrl+C when done.');
        // Keep the process alive until the user closes the browser window.
        await new Promise((resolve) => {
            page.on('close', resolve);
            context.on('close', resolve);
            browser.on('disconnected', resolve);
        });
    }

    await context.close();
    await browser.close();
    console.log(`capture-cdp: HAR written to ${args.out}`);
    process.exit(0);
}

main().catch((err) => {
    console.error('capture-cdp: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
