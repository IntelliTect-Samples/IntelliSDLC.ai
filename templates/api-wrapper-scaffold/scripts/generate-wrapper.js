#!/usr/bin/env node
/**
 * generate-wrapper.js -- HAR -> C# wrapper project codegen pipeline.
 *
 * Pipeline:
 *   1. Load HAR(s) + auth-detection JSON + project metadata.
 *   2. Extract endpoints, detect GraphQL, dedup path patterns.
 *   3. Infer + merge JSON shapes -> typed models.
 *   4. Emit Client.Generated.cs + Models.Generated.cs (partial classes).
 *   5. Substitute existing csharp/*.tmpl files (Client.cs, ISessionStore.cs, etc.).
 *   6. Emit .csproj with NuGet metadata.
 *   7. Emit README.md (recipes + polite-crawl note).
 *   8. Emit tests/fixtures/*.json (one per endpoint).
 *
 * Deterministic: same HAR + flags = byte-identical output. Stable sort, no timestamps in output.
 *
 * Usage:
 *   node generate-wrapper.js --har <p1[,p2,...]> --out <dir> \
 *     --project-name <Name> --namespace <Ns> --base-url <https://x> \
 *     [--auth-model cookie|cookie+csrf|bearer|...] [--auth-detection <path>] \
 *     [--authors <s>] [--description <s>] [--repository-url <s>] [--package-tags <s>]
 *
 * Zero npm deps. Pure Node stdlib.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { emitTestScaffold } = require('./tests-emit.js');
const { emitSecretGate, secretGateReadmeSection } = require('./secret-gate-emit.js');

// -------------------- CLI --------------------

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) { out[key] = true; }
            else { out[key] = next; i++; }
        }
    }
    return out;
}

function fail(msg) { console.error('generate-wrapper: ' + msg); process.exit(1); }

// -------------------- HAR loading --------------------

function loadHar(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    return { har: JSON.parse(text), sha, path: filePath };
}

function* iterEntries(harBundles) {
    for (const b of harBundles) {
        const entries = (b.har && b.har.log && b.har.log.entries) || [];
        for (const e of entries) { yield { entry: e, sourceSha: b.sha }; }
    }
}

// -------------------- Endpoint extraction + GraphQL detection --------------------

function isGraphQL(entry) {
    const req = entry.request || {};
    if (req.method !== 'POST') return false;
    const ct = headerValue(req.headers, 'content-type') || '';
    if (ct.toLowerCase().includes('application/graphql')) return true;
    const body = req.postData && req.postData.text;
    if (!body) return false;
    try {
        const parsed = JSON.parse(body);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.query === 'string';
    } catch { return false; }
}

function headerValue(headers, name) {
    if (!Array.isArray(headers)) return null;
    const lname = name.toLowerCase();
    for (const h of headers) {
        if (h && typeof h.name === 'string' && h.name.toLowerCase() === lname) return h.value;
    }
    return null;
}

function parseUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        // Split path into segments, drop empty leading segment.
        const segs = u.pathname.split('/').filter(Boolean);
        return { host: u.host, segments: segs, pathname: u.pathname };
    } catch { return null; }
}

// -------------------- Path-pattern dedup --------------------

// A segment is a likely path param if it matches one of these intrinsic patterns
// OR if it varies while neighboring segments are stable across captures.
const INTRINSIC_PARAM = [
    { re: /^\d+$/, type: 'int', name: 'id' },
    { re: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, type: 'string', name: 'id' },
    { re: /^[0-9a-fA-F]{24,}$/, type: 'string', name: 'id' }, // long hex (mongo ObjectId, etc.)
];

function classifySegment(seg) {
    for (const p of INTRINSIC_PARAM) { if (p.re.test(seg)) return p; }
    return null;
}

/**
 * Group entries by (method, host, segCount) then within each group find segments
 * that should collapse to {param}. Returns array of pattern descriptors:
 *   { method, host, segments: [{ literal: 'users' } | { param: 'id', type: 'int' }], samples: [entry,...] }
 */
function dedupePatterns(restEntries) {
    const groups = new Map();
    for (const item of restEntries) {
        const u = parseUrl(item.entry.request.url);
        if (!u) continue;
        const key = item.entry.request.method + ' ' + u.host + ' /' + u.segments.length;
        let g = groups.get(key);
        if (!g) { g = { method: item.entry.request.method, host: u.host, len: u.segments.length, items: [] }; groups.set(key, g); }
        g.items.push({ ...item, url: u });
    }

    const patterns = [];
    // Sort groups for deterministic output: by method then host then path.
    const sortedKeys = Array.from(groups.keys()).sort();
    for (const key of sortedKeys) {
        const g = groups.get(key);
        // For each segment index, look across samples.
        const segDescs = [];
        for (let i = 0; i < g.len; i++) {
            const values = g.items.map((it) => it.url.segments[i]);
            const unique = Array.from(new Set(values));
            // intrinsic param if every sample matches the same intrinsic pattern
            const intrinsics = values.map(classifySegment);
            if (intrinsics.every((x) => x) && allSameType(intrinsics)) {
                segDescs.push({ param: intrinsics[0].name, type: intrinsics[0].type });
            } else if (unique.length === 1) {
                segDescs.push({ literal: unique[0] });
            } else if (unique.length > 1 && g.items.length >= 2) {
                // Varies across captures with same len -> path param. Guess type.
                const allInts = values.every((v) => /^\d+$/.test(v));
                segDescs.push({ param: 'id', type: allInts ? 'int' : 'string' });
            } else {
                segDescs.push({ literal: unique[0] });
            }
        }
        // Disambiguate duplicate param names (rare): id, id2, id3...
        let idCount = 0;
        for (const s of segDescs) {
            if (s.param) {
                if (idCount > 0) s.param = s.param + (idCount + 1);
                idCount++;
            }
        }
        patterns.push({
            method: g.method,
            host: g.host,
            segments: segDescs,
            samples: g.items,
        });
    }

    // Now merge patterns that have identical (method, host, segments-shape).
    const merged = new Map();
    for (const p of patterns) {
        const sig = patternSignature(p);
        const ex = merged.get(sig);
        if (ex) { ex.samples.push(...p.samples); }
        else { merged.set(sig, p); }
    }
    return Array.from(merged.values()).sort((a, b) =>
        patternSignature(a).localeCompare(patternSignature(b)));
}

function allSameType(intrinsics) {
    const t = intrinsics[0].type;
    return intrinsics.every((x) => x.type === t);
}

function patternSignature(p) {
    const path = '/' + p.segments.map((s) => s.literal ? s.literal : '{' + s.param + '}').join('/');
    return p.method + ' ' + p.host + ' ' + path;
}

function patternPath(p) {
    return '/' + p.segments.map((s) => s.literal ? s.literal : '{' + s.param + '}').join('/');
}

// -------------------- JSON shape inference + merge --------------------

/**
 * Infer a shape descriptor from a JSON value:
 *   { kind: 'object', fields: { name: { type, nullable, optional } } }
 *   { kind: 'array', element: shape }
 *   { kind: 'primitive', type: 'string'|'int'|'long'|'double'|'bool', nullable }
 *   { kind: 'unknown' }
 */
function inferShape(val) {
    if (val === null) return { kind: 'primitive', type: 'object', nullable: true };
    if (Array.isArray(val)) {
        if (val.length === 0) return { kind: 'array', element: { kind: 'unknown' } };
        let acc = inferShape(val[0]);
        for (let i = 1; i < val.length; i++) acc = mergeShapes(acc, inferShape(val[i]));
        return { kind: 'array', element: acc };
    }
    const t = typeof val;
    if (t === 'string')  return { kind: 'primitive', type: 'string', nullable: false };
    if (t === 'boolean') return { kind: 'primitive', type: 'bool', nullable: false };
    if (t === 'number') {
        if (Number.isInteger(val)) {
            return { kind: 'primitive', type: (Math.abs(val) > 2147483647 ? 'long' : 'int'), nullable: false };
        }
        return { kind: 'primitive', type: 'double', nullable: false };
    }
    if (t === 'object') {
        const fields = {};
        const keys = Object.keys(val).sort();
        for (const k of keys) {
            const sub = inferShape(val[k]);
            fields[k] = { shape: sub, optional: false, presentCount: 1 };
        }
        return { kind: 'object', fields, sampleCount: 1 };
    }
    return { kind: 'unknown' };
}

function mergeShapes(a, b) {
    if (!a || a.kind === 'unknown') return b;
    if (!b || b.kind === 'unknown') return a;
    if (a.kind !== b.kind) {
        // mixed -> fall back to unknown (will emit as JsonElement)
        return { kind: 'unknown' };
    }
    if (a.kind === 'primitive') {
        const type = widenPrimitive(a.type, b.type);
        return { kind: 'primitive', type, nullable: a.nullable || b.nullable };
    }
    if (a.kind === 'array') {
        return { kind: 'array', element: mergeShapes(a.element, b.element) };
    }
    if (a.kind === 'object') {
        const allKeys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
        const fields = {};
        const newCount = (a.sampleCount || 1) + (b.sampleCount || 1);
        for (const k of Array.from(allKeys).sort()) {
            const fa = a.fields[k];
            const fb = b.fields[k];
            if (fa && fb) {
                fields[k] = {
                    shape: mergeShapes(fa.shape, fb.shape),
                    optional: fa.optional || fb.optional,
                    presentCount: (fa.presentCount || 0) + (fb.presentCount || 0),
                };
            } else if (fa) {
                fields[k] = { shape: fa.shape, optional: true, presentCount: fa.presentCount || 0 };
            } else {
                fields[k] = { shape: fb.shape, optional: true, presentCount: fb.presentCount || 0 };
            }
        }
        return { kind: 'object', fields, sampleCount: newCount };
    }
    return a;
}

function widenPrimitive(a, b) {
    if (a === b) return a;
    const order = ['int', 'long', 'double', 'string', 'bool', 'object'];
    // Numeric widening
    if ((a === 'int' || a === 'long' || a === 'double') &&
        (b === 'int' || b === 'long' || b === 'double')) {
        if (a === 'double' || b === 'double') return 'double';
        if (a === 'long' || b === 'long') return 'long';
        return 'int';
    }
    if (a === 'object' || b === 'object') return a === 'object' ? b : a;
    return 'string';
}

// -------------------- Name helpers --------------------

function pascalCase(s) {
    if (!s) return '';
    return s.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
            .replace(/^(.)/, (_, c) => c.toUpperCase())
            .replace(/[^A-Za-z0-9]/g, '');
}

function singularize(s) {
    if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
    if (/ses$/i.test(s) || /xes$/i.test(s) || /zes$/i.test(s)) return s.slice(0, -2);
    if (/s$/i.test(s) && !/ss$/i.test(s)) return s.slice(0, -1);
    return s;
}

// URL path prefixes that carry no semantic meaning for a method name.
const IGNORED_PATH_PREFIXES = new Set(['api', 'v1', 'v2', 'v3', 'rest', 'graphql']);

function meaningfulSegments(segments) {
    let i = 0;
    while (i < segments.length && segments[i].literal && IGNORED_PATH_PREFIXES.has(segments[i].literal.toLowerCase())) {
        i++;
    }
    // Always keep at least one segment so the method name is non-empty.
    if (i >= segments.length) return segments.slice(-1);
    return segments.slice(i);
}

function methodNameFor(pattern) {
    const verbMap = { GET: 'Get', POST: 'Create', PUT: 'Update', PATCH: 'Update', DELETE: 'Delete' };
    const verb = verbMap[pattern.method] || pascalCase(pattern.method.toLowerCase());
    const segs = meaningfulSegments(pattern.segments);
    const parts = [];
    for (const s of segs) {
        if (s.literal) parts.push(pascalCase(s.literal));
        else parts.push('By' + pascalCase(s.param));
    }
    return verb + parts.join('') + 'Async';
}

function modelNameFor(pattern) {
    const segs = meaningfulSegments(pattern.segments).filter((s) => s.literal).map((s) => s.literal);
    const hasParam = pattern.segments.some((s) => s.param);
    let base = segs.map(pascalCase).join('') || 'Root';
    if (hasParam && segs.length > 0) {
        // Singularize the last literal segment for "by id" endpoints
        const last = segs[segs.length - 1];
        base = segs.slice(0, -1).map(pascalCase).join('') + pascalCase(singularize(last));
    }
    return base + 'Response';
}

function describeFor(pattern) {
    const verbWord = { GET: 'Gets', POST: 'Creates', PUT: 'Updates', PATCH: 'Updates', DELETE: 'Deletes' }[pattern.method] || pattern.method;
    const segs = meaningfulSegments(pattern.segments);
    const literals = segs.filter((s) => s.literal).map((s) => s.literal.replace(/[-_]/g, ' '));
    const hasParam = segs.some((s) => s.param);
    const noun = literals.length > 0 ? literals[literals.length - 1] : 'resource';
    // Keep the plural form for the noun; only suffix " by id" when a path param is present.
    const subject = hasParam ? noun + ' by id' : noun;
    return verbWord + ' ' + subject + '.';
}

// -------------------- Response shape extraction --------------------

function parseResponseJson(entry) {
    const resp = entry.response || {};
    const text = resp.content && resp.content.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

// -------------------- C# emission --------------------

function csTypeFor(shape, modelMap, nameHint) {
    if (!shape || shape.kind === 'unknown') return 'JsonElement';
    if (shape.kind === 'primitive') {
        const base = { string: 'string', int: 'int', long: 'long', double: 'double', bool: 'bool', object: 'JsonElement' }[shape.type] || 'string';
        if (shape.nullable && shape.type !== 'object') return base + '?';
        return base;
    }
    if (shape.kind === 'array') {
        const inner = csTypeFor(shape.element, modelMap, singularize(nameHint || 'Item'));
        return 'IReadOnlyList<' + inner + '>';
    }
    if (shape.kind === 'object') {
        // Lazily register an inline record.
        const name = registerModel(modelMap, nameHint || 'Anon', shape);
        return name;
    }
    return 'JsonElement';
}

function registerModel(modelMap, hint, shape) {
    const baseName = pascalCase(hint) || 'Anon';
    // If an identical shape was already registered with this base, reuse it.
    const sig = shapeSignature(shape);
    for (const [n, info] of modelMap) {
        if (info.baseName === baseName && info.sig === sig) return n;
    }
    let name = baseName;
    let n = 2;
    while (modelMap.has(name)) { name = baseName + n; n++; }
    modelMap.set(name, { baseName, sig, shape });
    return name;
}

function shapeSignature(shape) {
    if (!shape) return 'null';
    if (shape.kind === 'primitive') return 'P:' + shape.type + (shape.nullable ? '?' : '');
    if (shape.kind === 'array') return 'A:' + shapeSignature(shape.element);
    if (shape.kind === 'object') {
        const parts = Object.keys(shape.fields).sort().map((k) => {
            const f = shape.fields[k];
            return k + (f.optional ? '?' : '') + ':' + shapeSignature(f.shape);
        });
        return 'O:{' + parts.join(',') + '}';
    }
    return '?';
}

function emitModels(modelMap) {
    // csTypeFor may register additional models (array elements) while we emit.
    // Iterate to fixed point so every reachable model gets a body.
    const emitted = new Map(); // name -> body
    let progressed = true;
    while (progressed) {
        progressed = false;
        const names = Array.from(modelMap.keys()).sort();
        for (const name of names) {
            if (emitted.has(name)) continue;
            const info = modelMap.get(name);
            if (!info || info.shape.kind !== 'object') { emitted.set(name, ''); continue; }
            const buf = [];
            buf.push('/// <summary>Auto-generated model for ' + name + '.</summary>');
            buf.push('public sealed partial class ' + name);
            buf.push('{');
            const keys = Object.keys(info.shape.fields).sort();
            for (const k of keys) {
                const f = info.shape.fields[k];
                const propName = pascalCase(k);
                let type = csTypeFor(f.shape, modelMap, propName);
                if (f.optional && !type.endsWith('?')) type = type + '?';
                buf.push('    [JsonPropertyName("' + escapeCs(k) + '")]');
                const init = initializerFor(type);
                buf.push('    public ' + type + ' ' + propName + ' { get; init; }' + (init ? init + ';' : ''));
            }
            buf.push('}');
            buf.push('');
            emitted.set(name, buf.join('\n'));
            progressed = true;
        }
    }
    const ordered = Array.from(emitted.keys()).sort();
    return ordered.map((n) => emitted.get(n)).filter(Boolean).join('\n');
}

/**
 * Returns a C# property initializer suffix (e.g., " = default!"). Used to
 * silence CS8618 ("non-nullable property must contain a non-null value") on
 * generated DTOs that are populated by JsonSerializer reflection.
 *
 * Value types (int, bool, double, long) and nullable types are zero-initialized
 * already; only non-nullable reference types need the explicit default.
 */
function initializerFor(type) {
    if (!type) return '';
    if (type.endsWith('?')) return '';
    const valueTypes = new Set(['int', 'long', 'double', 'bool']);
    if (valueTypes.has(type)) return '';
    return ' = default!';
}

function escapeCs(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function emitClient(opts, patterns, sourceShas, hasGraphQL, modelMap) {
    const header = autoGenHeader(sourceShas);
    const ns = opts.namespace;
    const projectName = opts.projectName;
    const lines = [];
    lines.push(header);
    lines.push('using System.ComponentModel;');
    lines.push('using System.Net.Http;');
    lines.push('using System.Text.Json;');
    lines.push('using System.Text.Json.Serialization;');
    lines.push('');
    lines.push('namespace ' + ns + ';');
    lines.push('');
    lines.push('public sealed partial class ' + projectName + 'Client');
    lines.push('{');

    if (hasGraphQL) {
        lines.push('    /// <summary>Issues a GraphQL operation against the target endpoint and deserializes the response.</summary>');
        lines.push('    [Description("Executes a GraphQL query or mutation and returns the typed response.")]');
        lines.push('    public async Task<T> GraphQLAsync<T>(string query, object? variables = null, CancellationToken ct = default)');
        lines.push('    {');
        lines.push('        var payload = JsonSerializer.Serialize(new { query, variables });');
        lines.push('        var raw = await SendRawJsonAsync("/graphql", payload, ct).ConfigureAwait(false);');
        lines.push('        return Deserialize<T>(raw);');
        lines.push('    }');
        lines.push('');
    }

    for (const p of patterns) {
        const methodName = methodNameFor(p);
        const modelName = p.responseModel || 'JsonElement';
        const pathArgs = p.segments
            .filter((s) => s.param)
            .map((s) => ({ name: s.param, type: s.type }));
        const sig = pathArgs.map((a) => a.type + ' ' + a.name).concat(['CancellationToken ct = default']).join(', ');
        const pathExpr = pathExpression(p);
        lines.push('    /// <summary>' + describeFor(p) + '</summary>');
        lines.push('    [Description("' + escapeCs(describeFor(p)) + '")]');
        lines.push('    public async Task<' + modelName + '> ' + methodName + '(' + sig + ')');
        lines.push('    {');
        lines.push('        var raw = await SendRawAsync(' + pathExpr + ', query: null, ct: ct).ConfigureAwait(false);');
        lines.push('        return Deserialize<' + modelName + '>(raw);');
        lines.push('    }');
        lines.push('');
    }

    lines.push('    private async Task<string> SendRawJsonAsync(string path, string json, CancellationToken ct)');
    lines.push('    {');
    lines.push('        // POST helper used by GraphQLAsync; delegates to the hand-written Client.cs partial.');
    lines.push('        return await SendRawAsync(path, query: null, ct: ct).ConfigureAwait(false);');
    lines.push('    }');
    lines.push('}');
    lines.push('');
    return lines.join('\n');
}

function pathExpression(p) {
    // Build a C# interpolated string for the URL path.
    const segs = p.segments.map((s) => s.literal ? s.literal : '{' + s.param + '}').join('/');
    if (p.segments.every((s) => s.literal)) {
        return '"/' + segs + '"';
    }
    return '$"/' + segs + '"';
}

function autoGenHeader(sourceShas) {
    const lines = [];
    lines.push('// <auto-generated>');
    lines.push('//   This file was generated by api-wrapper-scaffold (generate-wrapper.js).');
    lines.push('//   Do not edit -- changes will be lost on regeneration.');
    for (const s of sourceShas) {
        lines.push('//   source HAR sha-256: ' + s);
    }
    lines.push('// </auto-generated>');
    lines.push('#nullable enable');
    return lines.join('\n');
}

function emitModelsFile(modelMap, sourceShas, opts) {
    const lines = [];
    lines.push(autoGenHeader(sourceShas));
    lines.push('using System.Text.Json;');
    lines.push('using System.Text.Json.Serialization;');
    lines.push('');
    lines.push('namespace ' + opts.namespace + ';');
    lines.push('');
    lines.push(emitModels(modelMap));
    return lines.join('\n');
}

// -------------------- Project metadata files --------------------

function emitCsproj(opts) {
    const tags = opts.packageTags || '';
    const repo = opts.repositoryUrl || '';
    return [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <TargetFramework>net8.0</TargetFramework>',
        '    <OutputType>Exe</OutputType>',
        '    <Nullable>enable</Nullable>',
        '    <ImplicitUsings>enable</ImplicitUsings>',
        '    <PackageId>' + xmlEscape(opts.projectName) + '</PackageId>',
        '    <Description>' + xmlEscape(opts.description || '') + '</Description>',
        '    <Authors>' + xmlEscape(opts.authors || '') + '</Authors>',
        '    <RepositoryUrl>' + xmlEscape(repo) + '</RepositoryUrl>',
        '    <PackageTags>' + xmlEscape(tags) + '</PackageTags>',
        '  </PropertyGroup>',
        '  <ItemGroup>',
        '    <PackageReference Include="Microsoft.Extensions.Hosting" Version="10.0.0" />',
        '    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.0" />',
        '    <PackageReference Include="ModelContextProtocol" Version="0.4.1-preview.1" />',
        '    <PackageReference Include="System.Security.Cryptography.ProtectedData" Version="8.0.0" />',
        '  </ItemGroup>',
        '</Project>',
        ''
    ].join('\n');
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emitReadme(opts, patterns, hasGraphQL) {
    const lines = [];
    lines.push('# ' + opts.projectName);
    lines.push('');
    lines.push(opts.description || ('Wrapper for ' + opts.baseUrl));
    lines.push('');
    lines.push('> Auto-generated by api-wrapper-scaffold. Re-run the generator to refresh; hand-written code goes in `Client.cs` (a `partial class` paired with `' + opts.projectName + 'Client.Generated.cs`).');
    lines.push('');
    lines.push('## Polite-crawl policy');
    lines.push('');
    lines.push('When re-capturing HAR fixtures, the recommended throttle is **1 request/second** with a descriptive `User-Agent`. Respect `robots.txt`. The bundled `capture-cdp.js` defaults to a ~1000 ms inter-request delay.');
    lines.push('');
    lines.push('## Recipes');
    lines.push('');
    const recipes = buildRecipes(opts, patterns, hasGraphQL);
    for (const r of recipes) {
        lines.push('### ' + r.title);
        lines.push('');
        lines.push('```csharp');
        lines.push(r.code);
        lines.push('```');
        lines.push('');
    }
    lines.push(secretGateReadmeSection());
    return lines.join('\n');
}

function buildRecipes(opts, patterns, hasGraphQL) {
    const out = [];
    const client = opts.projectName + 'Client';
    // Recipe 0: construction
    out.push({
        title: 'Construct the client',
        code: [
            'var session = await new ' + opts.projectName + 'Authenticator(store).AuthenticateAsync();',
            'using var client = new ' + client + '(session);',
        ].join('\n'),
    });
    if (hasGraphQL) {
        out.push({
            title: 'Run a GraphQL query',
            code: [
                'var result = await client.GraphQLAsync<MyResponse>(',
                '    "query { me { id name } }");',
            ].join('\n'),
        });
    }
    for (const p of patterns.slice(0, 4)) {
        const m = methodNameFor(p);
        const paramArgs = p.segments.filter((s) => s.param).map((s) => s.type === 'int' ? '1' : '"abc"').join(', ');
        out.push({
            title: p.method + ' ' + patternPath(p),
            code: 'var result = await client.' + m + '(' + paramArgs + ');',
        });
    }
    return out;
}

function emitTestFixtures(outDir, patterns, hasGraphQL, graphqlEntries) {
    const fixDir = path.join(outDir, 'tests', 'fixtures');
    fs.mkdirSync(fixDir, { recursive: true });
    for (const p of patterns) {
        const sample = p.samples[0];
        const json = parseResponseJson(sample.entry);
        if (json === null) continue;
        const fname = (p.method + '_' + patternPath(p).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')) + '.json';
        const content = JSON.stringify(json, null, 2) + '\n';
        fs.writeFileSync(path.join(fixDir, fname), content);
    }
    if (hasGraphQL && graphqlEntries.length > 0) {
        const json = parseResponseJson(graphqlEntries[0].entry);
        if (json !== null) {
            fs.writeFileSync(path.join(fixDir, 'graphql.json'), JSON.stringify(json, null, 2) + '\n');
        }
    }
}

// -------------------- Template substitution --------------------

function substituteTemplates(opts, outDir) {
    const templatesDir = path.resolve(__dirname, '..', 'csharp');
    if (!fs.existsSync(templatesDir)) return;
    const manifestPath = path.join(templatesDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const tokens = buildTokenMap(opts);
    const projDir = path.join(outDir, 'src', opts.projectName);
    fs.mkdirSync(projDir, { recursive: true });

    // Only substitute templates whose required tokens are all available.
    for (const t of manifest.templates) {
        const required = t.requiredTokens || [];
        if (required.some((tok) => tokens[tok] === undefined)) continue;
        const src = path.join(templatesDir, t.file);
        if (!fs.existsSync(src)) continue;
        const body = fs.readFileSync(src, 'utf8');
        const subbed = body.replace(/\{\{(\w+)\}\}/g, (m, k) => tokens[k] !== undefined ? tokens[k] : m);
        // Strip ".tmpl" suffix; ".gitignore.tmpl" -> ".gitignore"
        const outName = t.file.replace(/\.tmpl$/, '');
        // Friendly remappings:
        //   Client.cs -> src/<Project>/Client.cs (hand-written partial)
        //   manifest.json -> not emitted
        if (outName === 'manifest.json') continue;
        fs.writeFileSync(path.join(projDir, outName), subbed);
    }
}

function buildTokenMap(opts) {
    return {
        ProjectName: opts.projectName,
        Namespace: opts.namespace,
        BaseUrl: opts.baseUrl,
        AuthModel: opts.authModel || 'cookie',
        IdpName: opts.idpName || 'Google',
        IdpAuthorizeUrl: opts.idpAuthorizeUrl || 'https://accounts.google.com/o/oauth2/v2/auth',
        IdpTokenUrl: opts.idpTokenUrl || 'https://oauth2.googleapis.com/token',
        IdpClientId: opts.idpClientId || 'REPLACE_WITH_CLIENT_ID',
        IdpScopes: opts.idpScopes || 'openid email profile',
        HasMobileCoverage: opts.hasMobileCoverage || 'false',
        MobileHarPaths: opts.mobileHarPaths || '',
    };
}

// -------------------- Pipeline orchestration --------------------

function run(args) {
    if (!args.har) fail('missing --har <path[,path,...]>');
    if (!args.out) fail('missing --out <dir>');
    if (!args['project-name']) fail('missing --project-name <Name>');
    if (!args.namespace) fail('missing --namespace <Ns>');
    if (!args['base-url']) fail('missing --base-url <url>');

    const opts = {
        projectName: args['project-name'],
        namespace: args.namespace,
        baseUrl: args['base-url'],
        authModel: args['auth-model'] || 'cookie',
        authors: args.authors || '',
        description: args.description || '',
        repositoryUrl: args['repository-url'] || '',
        packageTags: args['package-tags'] || '',
    };

    const harPaths = String(args.har).split(',').map((s) => s.trim()).filter(Boolean);
    const bundles = harPaths.map(loadHar);
    const sourceShas = bundles.map((b) => b.sha).sort();

    // Partition entries into GraphQL vs REST.
    const gql = [], rest = [];
    for (const item of iterEntries(bundles)) {
        if (isGraphQL(item.entry)) gql.push(item);
        else rest.push(item);
    }

    // Dedup REST patterns.
    const patterns = dedupePatterns(rest);

    // Infer response shapes per pattern.
    const modelMap = new Map();
    for (const p of patterns) {
        let merged = null;
        for (const s of p.samples) {
            const json = parseResponseJson(s.entry);
            if (json === null || json === undefined) continue;
            const inferred = inferShape(json);
            merged = merged ? mergeShapes(merged, inferred) : inferred;
        }
        if (merged && merged.kind === 'object') {
            p.responseModel = registerModel(modelMap, modelNameFor(p), merged);
        } else if (merged && merged.kind === 'array') {
            // Array response: emit a list type directly; introduce a wrapper model.
            const itemModel = registerModel(modelMap, singularize(modelNameFor(p).replace(/Response$/, '')) + 'Item', merged.element.kind === 'object' ? merged.element : { kind: 'object', fields: {} });
            p.responseModel = 'IReadOnlyList<' + itemModel + '>';
        } else {
            p.responseModel = 'JsonElement';
        }
    }

    // Out dirs.
    const outDir = path.resolve(args.out);
    const projDir = path.join(outDir, 'src', opts.projectName);
    fs.mkdirSync(projDir, { recursive: true });

    // Substitute templates first (writes Client.cs, ISessionStore.cs, etc).
    substituteTemplates(opts, outDir);

    // Emit generated C# files.
    const clientCs = emitClient(opts, patterns, sourceShas, gql.length > 0, modelMap);
    const modelsCs = emitModelsFile(modelMap, sourceShas, opts);
    fs.writeFileSync(path.join(projDir, opts.projectName + 'Client.Generated.cs'), clientCs);
    fs.writeFileSync(path.join(projDir, 'Models.Generated.cs'), modelsCs);

    // .csproj
    fs.writeFileSync(path.join(projDir, opts.projectName + '.csproj'), emitCsproj(opts));

    // README + recipes + polite-crawl note
    fs.writeFileSync(path.join(outDir, 'README.md'), emitReadme(opts, patterns, gql.length > 0));

    // Test fixtures
    emitTestFixtures(outDir, patterns, gql.length > 0, gql);

    // xUnit + Pester test-project scaffold (one [Fact] per detected endpoint).
    emitTestScaffold({
        outDir,
        opts,
        patterns,
        hasGraphQL: gql.length > 0,
        methodNameFor,
        patternPath,
    });

    // Secret-gate (pre-commit hook + .gitleaks.toml + secret-scan/ci workflows).
    emitSecretGate({ outDir, opts });

    console.log('generate-wrapper: wrote ' + patterns.length + ' REST pattern(s)' +
        (gql.length ? ' + GraphQL' : '') + ' to ' + outDir);
    console.log('generate-wrapper: next step -- activate the pre-commit hook with:');
    console.log('                  git -C ' + outDir + ' config core.hooksPath .githooks');
}

if (require.main === module) {
    try { run(parseArgs(process.argv.slice(2))); }
    catch (e) { fail(e && e.stack ? e.stack : String(e)); }
}

module.exports = {
    parseArgs,
    isGraphQL,
    inferShape,
    mergeShapes,
    dedupePatterns,
    methodNameFor,
    pascalCase,
    singularize,
};
