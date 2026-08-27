// scripts/codegen/generate-wrapper-helpers.js -- shared name-mangling helpers used by
// both generate-wrapper.js and tests-emit.js. Kept in a separate module so the
// test-scaffold emitter does not have to re-import the main pipeline.
'use strict';

function pascalCase(s) {
    if (!s) return '';
    return s.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
            .replace(/^(.)/, (_, c) => c.toUpperCase())
            .replace(/[^A-Za-z0-9]/g, '');
}

module.exports = { pascalCase };