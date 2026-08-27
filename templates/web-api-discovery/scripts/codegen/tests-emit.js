// scripts/codegen/tests-emit.js -- emits the xUnit + Pester test scaffold for a
// generated wrapper. Invoked by generate-wrapper.js after the wrapper csproj
// and fixtures are on disk. Zero npm deps, deterministic output.
//
// Layout produced under <outDir>:
//   tests/
//     <TestProjectName>/
//       <TestProjectName>.csproj
//       FixtureLoader.cs
//       MockHandler.cs
//       ClientTests.<Group>.cs    (one per resource group; [Fact] per endpoint)
//       pester/
//         Mcp.Tests.ps1
//         run-pester.ps1

'use strict';

const fs = require('fs');
const path = require('path');

const { pascalCase } = require('./generate-wrapper-helpers.js');

const IGNORED_PATH_PREFIXES = new Set(['api', 'v1', 'v2', 'v3', 'rest', 'graphql']);

function meaningfulSegments(segments) {
    let i = 0;
    while (i < segments.length && segments[i].literal &&
           IGNORED_PATH_PREFIXES.has(segments[i].literal.toLowerCase())) {
        i++;
    }
    if (i >= segments.length) return segments.slice(-1);
    return segments.slice(i);
}

function groupNameFor(pattern) {
    const segs = meaningfulSegments(pattern.segments);
    for (const s of segs) {
        if (s.literal) return pascalCase(s.literal);
    }
    return 'Root';
}

function fixtureFileNameFor(pattern, patternPath) {
    return (pattern.method + '_' + patternPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')) + '.json';
}

function placeholderArg(type) {
    if (type === 'int' || type === 'long') return '1';
    if (type === 'double') return '1.0';
    if (type === 'bool') return 'true';
    return '"abc"';
}

function buildFactBody(pattern, methodName, patternPath) {
    const fixture = fixtureFileNameFor(pattern, patternPath);
    const args = pattern.segments.filter((s) => s.param).map((s) => placeholderArg(s.type)).join(', ');
    const lines = [];
    lines.push('    [Fact]');
    lines.push('    public async Task ' + methodName + '_ReturnsFixture()');
    lines.push('    {');
    lines.push('        using var http = MockHandler.FromFixture("' + fixture + '");');
    lines.push('        var creds = new SessionCredentials("test=1", string.Empty);');
    lines.push('        using var client = new __CLIENT__(creds, http);');
    lines.push('        var result = await client.' + methodName + '(' + args + ');');
    lines.push('        Assert.NotNull((object?)result);');
    lines.push('    }');
    return lines.join('\n');
}

function buildGraphQlFact() {
    const lines = [];
    lines.push('    [Fact]');
    lines.push('    public async Task GraphQLAsync_ReturnsFixture()');
    lines.push('    {');
    lines.push('        using var http = MockHandler.FromFixture("graphql.json");');
    lines.push('        var creds = new SessionCredentials("test=1", string.Empty);');
    lines.push('        using var client = new __CLIENT__(creds, http);');
    lines.push('        var result = await client.GraphQLAsync<JsonElement>("query { me { id } }");');
    lines.push('        Assert.NotNull((object?)result);');
    lines.push('    }');
    return lines.join('\n');
}

function substitute(body, tokens) {
    return body.replace(/\{\{(\w+)\}\}/g, (m, k) => tokens[k] !== undefined ? tokens[k] : m);
}

function emitTestScaffold(args) {
    const { outDir, opts, patterns, hasGraphQL, methodNameFor, patternPath } = args;
    const projectName = opts.projectName;
    const testProjectName = opts.testProjectName || (projectName + '.Tests');
    const namespace = opts.namespace;

    const tmplDir = path.resolve(__dirname, '..', '..', 'csharp', 'tests');
    if (!fs.existsSync(tmplDir)) return;

    const testProjDir = path.join(outDir, 'tests', testProjectName);
    const pesterDir = path.join(testProjDir, 'pester');
    fs.mkdirSync(pesterDir, { recursive: true });

    // Group patterns by resource group; emit ClientTests.<Group>.cs per group.
    // Stable sort so output is deterministic.
    const groups = new Map();
    for (const p of patterns) {
        const g = groupNameFor(p);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(p);
    }
    if (hasGraphQL) {
        if (!groups.has('Graphql')) groups.set('Graphql', []);
        groups.get('Graphql').push({ __graphql: true });
    }

    const groupNames = Array.from(groups.keys()).sort();

    const baseTokens = {
        ProjectName: projectName,
        TestProjectName: testProjectName,
        Namespace: namespace,
    };

    // Tests.csproj
    const csprojTmpl = fs.readFileSync(path.join(tmplDir, 'Tests.csproj.tmpl'), 'utf8');
    fs.writeFileSync(path.join(testProjDir, testProjectName + '.csproj'),
        substitute(csprojTmpl, baseTokens));

    // FixtureLoader.cs + MockHandler.cs
    const flTmpl = fs.readFileSync(path.join(tmplDir, 'FixtureLoader.cs.tmpl'), 'utf8');
    fs.writeFileSync(path.join(testProjDir, 'FixtureLoader.cs'), substitute(flTmpl, baseTokens));
    const mhTmpl = fs.readFileSync(path.join(tmplDir, 'MockHandler.cs.tmpl'), 'utf8');
    fs.writeFileSync(path.join(testProjDir, 'MockHandler.cs'), substitute(mhTmpl, baseTokens));

    // ClientTests.<Group>.cs (per group)
    const clientName = projectName + 'Client';
    const ctTmpl = fs.readFileSync(path.join(tmplDir, 'ClientTests.cs.tmpl'), 'utf8');
    for (const g of groupNames) {
        const facts = [];
        const groupPatterns = groups.get(g).slice().sort((a, b) => {
            const ka = a.__graphql ? 'zzz' : (methodNameFor(a) || '');
            const kb = b.__graphql ? 'zzz' : (methodNameFor(b) || '');
            return ka.localeCompare(kb);
        });
        for (const p of groupPatterns) {
            if (p.__graphql) {
                facts.push(buildGraphQlFact());
            } else {
                facts.push(buildFactBody(p, methodNameFor(p), patternPath(p)));
            }
        }
        // Replace __CLIENT__ placeholder used inside fact bodies. The placeholder
        // avoids interfering with the {{...}} substitution pass.
        const factBlock = facts.join('\n\n').replace(/__CLIENT__/g, clientName);

        // Each group's file is a `partial class` body; using the same class
        // name across groups keeps every generated [Fact] in one logical type.
        const tokens = Object.assign({}, baseTokens, { Facts: factBlock });
        const body = substitute(ctTmpl, tokens);
        fs.writeFileSync(path.join(testProjDir, 'ClientTests.' + g + '.cs'), body);
    }

    // Pester -- bake the expected method list into Mcp.Tests.ps1 so the smoke
    // suite can assert every generated tool retains its [Description].
    const methodNames = [];
    for (const p of patterns) methodNames.push(methodNameFor(p));
    if (hasGraphQL) methodNames.push('GraphQLAsync');
    const uniqueSorted = Array.from(new Set(methodNames)).sort();
    const expectedMethods = uniqueSorted.map((n) => '        "' + n + '"').join(',\n');

    const mcpTokens = Object.assign({}, baseTokens, { ExpectedMethods: expectedMethods });
    const mcpTmpl = fs.readFileSync(path.join(tmplDir, 'pester', 'Mcp.Tests.ps1.tmpl'), 'utf8');
    fs.writeFileSync(path.join(pesterDir, 'Mcp.Tests.ps1'), substitute(mcpTmpl, mcpTokens));
    const runTmpl = fs.readFileSync(path.join(tmplDir, 'pester', 'run-pester.ps1.tmpl'), 'utf8');
    fs.writeFileSync(path.join(pesterDir, 'run-pester.ps1'), substitute(runTmpl, baseTokens));
}

module.exports = { emitTestScaffold, groupNameFor, fixtureFileNameFor };