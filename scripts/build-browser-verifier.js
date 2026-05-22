#!/usr/bin/env node
/**
 * Build the browser verifier bundle — dist/verify-book.bundle.js.
 *
 * ⚠️ IMPORTANT — LOCKSTEP. The bundle is a GENERATED artifact. Never hand-edit
 * dist/verify-book.bundle.js. It is assembled, verbatim, from these canonical
 * sources:
 *   - fengari-web.js                 (committed Fengari 0.1.5 browser build)
 *   - cli-emulator/script-runtime.js (the shared Lua sandbox)
 *   - scripts/book-checks.js         (the shared soft checks + script gate)
 *   - scripts/verifier-driver.js     (the verifyBook composition layer)
 *   - a standalone JSON-Schema validator compiled here from codex.schema.json
 *
 * Because the bundle is rebuilt from those exact files, the Analysis-tool
 * verifier can never drift from the Claude Code tooling: validate-book.js and
 * the bundle import the SAME book-checks.js and the SAME schema. Whenever the
 * schema, script-runtime, book-checks, or driver changes, re-run this script
 * and commit the regenerated bundle.
 *
 * Usage:  node scripts/build-browser-verifier.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const standaloneCode = require('ajv/dist/standalone').default;

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- 1. Compile a standalone, self-contained schema validator -------------
// codex.schema.json uses no `format` keywords, so the generated validator has
// zero external requires — it is a single self-contained function.
const schema = JSON.parse(read('codex.schema.json'));
const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true, esm: false } });
const validateFn = ajv.compile(schema);
const validatorCode = standaloneCode(ajv, validateFn);
if (/\brequire\s*\(/.test(validatorCode)) {
  console.error('ERROR: generated validator has external require() calls — bundle would not be self-contained.');
  process.exit(1);
}

// --- 2. Read the canonical source files -----------------------------------
const fengariWeb = read('fengari-web.js');
const scriptRuntime = read('cli-emulator/script-runtime.js');
const bookChecks = read('scripts/book-checks.js');
const verifierDriver = read('scripts/verifier-driver.js');

// --- 3. Assemble the bundle -----------------------------------------------
// Each component is wrapped so its module-detection lands deterministically,
// and so the bundle runs in ANY JS host — browser main thread, Web Worker
// (no window/document — the likely Analysis-tool environment), or Node:
//   - fengari-web.js: module/exports/define shadowed undefined so its UMD
//     falls through to `<global>.fengari = ...`. `window`/`self` are pointed
//     at the real global, and `document` at the real document OR a harmless
//     stub (Fengari's <script type=application/lua> loader then finds no
//     tags and no-ops). Captured into __host.
//   - script-runtime / book-checks / verifier-driver: module/exports/define
//     shadowed AND window/self pointed at __host, so their UMD sets
//     __host.ScriptRuntime / __host.BookChecks / __host.VerifierDriver.
//   - standalone validator: given a private `module` object; captured into
//     __host.validateSchema.
const schemaTitle = (schema.title || 'GBF schema').trim();
const header =
`/* GENERATED FILE — DO NOT EDIT.
 * dist/verify-book.bundle.js — the Claude.ai Analysis-tool book verifier.
 * Built by scripts/build-browser-verifier.js from canonical sources
 * (fengari-web.js, cli-emulator/script-runtime.js, scripts/book-checks.js,
 * scripts/verifier-driver.js) + a standalone validator compiled from
 * codex.schema.json. Rebuild: node scripts/build-browser-verifier.js
 * Built: ${new Date().toISOString()}
 * Schema: ${schemaTitle}
 *
 * Usage in the Analysis tool:
 *   // (this bundle has already been loaded/eval'd in the tool)
 *   const result = verifyBook(bookJsonStringOrObject);
 *   console.log(result.report);          // human-readable summary
 *   // result.ok === true  -> schema-valid AND no script crashed
 */
`;

const mineWrap = (label, code) =>
`/* ==================== ${label} ==================== */
(function () {
  var module, exports, define;
  var window = __host, self = __host;
  ${code}
})();
`;

const bundle =
`${header}(function () {
  var __realGlobal = (typeof globalThis === 'object' && globalThis) ||
                     (typeof self === 'object' && self) ||
                     (typeof window === 'object' && window) || {};
  var __host = {};

  /* ==================== fengari-web.js (Fengari 0.1.5) ==================== */
  /* \`document\` is deliberately left undefined inside this wrapper. Fengari's
   * <script type="application/lua"> web loader is gated on
   * \`typeof document !== 'undefined' && document instanceof HTMLDocument\`;
   * with document undefined that guard short-circuits, so the DOM loader is
   * skipped and only the environment-neutral Lua CORE initialises. This is
   * what makes the bundle run identically in a browser, a Web Worker, or
   * Node — we never want the script-tag loader anyway. */
  (function () {
    var module, exports, define;
    var window = __realGlobal, self = __realGlobal;
    var document;
    ${fengariWeb}
  })();
  __host.fengari = __realGlobal.fengari;

  ${mineWrap('cli-emulator/script-runtime.js', scriptRuntime)}
  ${mineWrap('scripts/book-checks.js', bookChecks)}
  ${mineWrap('scripts/verifier-driver.js', verifierDriver)}

  /* ==================== standalone schema validator ==================== */
  (function () {
    var module = { exports: {} };
    ${validatorCode}
    __host.validateSchema = module.exports;
  })();

  /* ==================== wire up verifyBook ==================== */
  var verifyBook = __host.VerifierDriver.createVerifier({
    validateSchema: __host.validateSchema,
    BookChecks: __host.BookChecks,
    runScript: __host.ScriptRuntime.runScript,
  });

  if (__realGlobal) __realGlobal.verifyBook = verifyBook;
  if (typeof module === 'object' && module.exports) module.exports = { verifyBook: verifyBook };
})();
`;

// --- 4. Write the bundle --------------------------------------------------
const distDir = path.join(ROOT, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);
const outPath = path.join(distDir, 'verify-book.bundle.js');
fs.writeFileSync(outPath, bundle);
console.log(`Wrote ${path.relative(ROOT, outPath)} (${(bundle.length / 1024).toFixed(0)} KB)`);
console.log(`  fengari-web.js      ${(fengariWeb.length / 1024).toFixed(0)} KB`);
console.log(`  standalone validator ${(validatorCode.length / 1024).toFixed(0)} KB`);
console.log(`  script-runtime + book-checks + driver  ${((scriptRuntime.length + bookChecks.length + verifierDriver.length) / 1024).toFixed(0)} KB`);
