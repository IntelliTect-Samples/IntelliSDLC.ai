// scripts/sln-emit.js -- emits a deterministic top-level .slnx solution file
// listing every csproj produced by the wrapper scaffold. Invoked by
// generate-wrapper.js after all csprojs are on disk.
//
// We use the .slnx (XML) solution format introduced in .NET 9 because:
//   * It avoids classic-.sln Project GUIDs entirely (no hash-derived state).
//   * It is byte-deterministic by construction -- just paths + a stable order.
//   * `dotnet build` / `dotnet test` accept it natively on .NET 9.0.200+.
//
// Zero npm deps. Pure Node stdlib.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Discover every *.csproj under outDir and emit `<ProjectName>.slnx` at the root.
 * Project paths are recorded relative to outDir using POSIX forward slashes so
 * the file is identical on Windows and Linux.
 *
 * @param {object} args
 * @param {string} args.outDir       Wrapper output root.
 * @param {string} args.projectName  Used as the solution file basename.
 */
function emitSolution(args) {
    const { outDir, projectName } = args;
    if (!outDir) throw new Error('emitSolution: missing outDir');
    if (!projectName) throw new Error('emitSolution: missing projectName');

    const csprojRelPaths = findCsprojs(outDir)
        .map((abs) => toPosixRelative(outDir, abs))
        .sort();

    const lines = [];
    lines.push('<Solution>');
    for (const rel of csprojRelPaths) {
        lines.push('  <Project Path="' + rel + '" />');
    }
    lines.push('</Solution>');
    lines.push('');
    const body = lines.join('\n');

    const slnxPath = path.join(outDir, projectName + '.slnx');
    fs.writeFileSync(slnxPath, body);
    return { slnxPath, projects: csprojRelPaths };
}

function findCsprojs(root) {
    const results = [];
    walk(root, results);
    return results;
}

function walk(dir, acc) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    // Sort for deterministic traversal (though we sort results at the end too).
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            // Skip common build/output dirs in case the caller re-runs over a built tree.
            if (e.name === 'bin' || e.name === 'obj' || e.name === 'node_modules' || e.name === '.git') continue;
            walk(full, acc);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.csproj')) {
            acc.push(full);
        }
    }
}

function toPosixRelative(root, abs) {
    const rel = path.relative(root, abs);
    return rel.split(path.sep).join('/');
}

module.exports = { emitSolution };