#!/usr/bin/env node
'use strict';

/**
 * run-with-heartbeat.js -- run one command, and keep saying that it is still
 * running (#492).
 *
 * WHY THIS EXISTS. After a recording stops, capture-har spawns the AI
 * catalogue pass (`claude -p`), and that one child is ~95% of the wall time --
 * fifteen minutes on one measured capture -- during which it prints nothing at
 * all. The operator's report was "it now appears to have frozen", and the only
 * way to tell otherwise was to list OS processes and correlate parent pids.
 *
 * capture-har cannot keep a timer of its own for this: postProcess is
 * synchronous by design, and `spawnSync` blocks its event loop for the whole
 * child. So the child runs under THIS process instead, which is free to tick.
 *
 * WHAT IT DOES NOT DO. It does not stream, buffer or interpret the child's
 * output -- stdio is inherited, so whatever the child says still reaches the
 * terminal directly, and a child that needs the terminal still has it. It adds
 * lines on stderr and nothing else. The exit status is the child's.
 *
 * Usage (capture-har's own, not an operator-facing command):
 *   node run-with-heartbeat.js <command> [args...]
 */

const { spawn } = require('child_process');

const HEARTBEAT_MS = 30 * 1000;
const LABEL = 'capture-har: cataloguing';

/** "45s", "4m30s" -- read the way an operator reads a clock, not in ms. */
function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * Run `command args`, writing an elapsed-time line every `intervalMs` until it
 * exits, and one closing line when it does.
 *
 * The heartbeat names the CHILD's pid, because that is the process an operator
 * would otherwise go hunting for. A child that cannot be started is reported
 * and never waited on: no heartbeat may claim work that is not happening.
 *
 * @returns {Promise<{status: number, signal: string|null, pid: number|null}>}
 */
function runWithHeartbeat(command, args, opts = {}) {
    const intervalMs = opts.intervalMs || HEARTBEAT_MS;
    const write = opts.write || ((line) => process.stderr.write(`${line}\n`));
    const started = Date.now();
    const elapsed = () => formatElapsed(Date.now() - started);

    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
        const timer = setInterval(
            () => write(`${LABEL} ... ${elapsed()} elapsed (pid ${child.pid})`), intervalMs);
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            resolve(Object.assign({ pid: child.pid === undefined ? null : child.pid }, result));
        };
        // ENOENT and friends arrive here, asynchronously, and `exit` may never
        // follow -- so this settles on its own rather than waiting for it.
        child.on('error', (e) => {
            write(`${LABEL}: could not start ${command}: ${e.message}`);
            finish({ status: 127, signal: null });
        });
        child.on('exit', (code, signal) => {
            write(signal
                ? `${LABEL} ended by ${signal} after ${elapsed()}`
                : `${LABEL} finished after ${elapsed()}`);
            // A signalled child has no exit code; reporting 0 for it would
            // read as a successful catalogue pass.
            finish({ status: code === null ? 1 : code, signal });
        });
    });
}

module.exports = { HEARTBEAT_MS, formatElapsed, runWithHeartbeat };

if (require.main === module) {
    const [command, ...args] = process.argv.slice(2);
    if (!command) {
        process.stderr.write('usage: run-with-heartbeat.js <command> [args...]\n');
        process.exit(2);
    }
    runWithHeartbeat(command, args).then((result) => process.exit(result.status));
}
