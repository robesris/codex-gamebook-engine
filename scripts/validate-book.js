#!/usr/bin/env node
// Schema-validity check + per-section breakdown for a GBF book file.
//
// Usage:
//   node scripts/validate-book.js <path-to-book.json>
//   node scripts/validate-book.js --baseline <git-rev>:<path> <path-to-book.json>
//
// Without --baseline: prints total-error count and a per-section breakdown
// for the supplied book file.
//
// With --baseline: also runs the same validation against the baseline file
// (extracted via `git show <rev>:<path>` from the engine OR books repo
// depending on which contains the path), prints the per-section delta
// (added / removed errors per section id), and exits with code 1 if any
// out-of-baseline section's error count grew (i.e. an out-of-scope
// regression was introduced).
//
// The schema is read from this engine repo's codex.schema.json. Books
// from any repo can be validated against it by absolute path.
//
// The soft structural checks and the blocking script-execution gate are
// defined in scripts/book-checks.js (shared with the browser verifier); the
// Lua sandbox is cli-emulator/script-runtime.js. This script only wires
// those modules to the Node filesystem / git and prints the report.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const BookChecks = require('./book-checks.js');

// The canonical emulator's Lua sandbox. Used by the script-execution gate so
// every section's `script_code` runs against the REAL runtime API — a
// reimplementation would silently drift from the emulator's actual
// roll()/player.* contract, defeating the purpose of the check.
let runScript = null;
try {
  runScript = require('../cli-emulator/script-runtime.js').runScript;
} catch (e) {
  runScript = null;
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node scripts/validate-book.js [--baseline <rev>:<path>] <path-to-book.json>');
  process.exit(2);
}

let baselineSpec = null;
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--baseline') { baselineSpec = argv[++i]; continue; }
  positional.push(argv[i]);
}
if (positional.length !== 1) usage();
const bookPath = path.resolve(positional[0]);
if (!fs.existsSync(bookPath)) usage(`Book file not found: ${bookPath}`);

const schemaPath = path.resolve(__dirname, '..', 'codex.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function loadBook(text, label) {
  try { return JSON.parse(text); }
  catch (e) { console.error(`${label}: JSON parse failed: ${e.message}`); process.exit(1); }
}

function bucketErrorsBySection(errors) {
  const buckets = {};
  let unscopedCount = 0;
  for (const e of errors || []) {
    const m = (e.instancePath || '').match(/^\/sections\/([^/]+)/);
    const key = m ? `§${m[1]}` : '<top-level-or-rules>';
    if (!buckets[key]) buckets[key] = 0;
    buckets[key] += 1;
    if (!m) unscopedCount += 1;
  }
  return { buckets, unscopedCount };
}

function summarise(errors, label) {
  const total = (errors || []).length;
  const { buckets } = bucketErrorsBySection(errors);
  console.log(`${label}: ${total} schema errors across ${Object.keys(buckets).length} site(s).`);
  return { total, buckets };
}

// Print the soft structural checks. These do NOT affect exit code — schema
// validity and the script-execution gate are the only blocking signals. The
// findings come from the shared book-checks.js module.
function printSoftChecks(book) {
  const f = BookChecks.collectSoftFindings(book);
  if (f.dangling.length > 0) {
    console.log(`  Soft: ${f.dangling.length} catalog entr${f.dangling.length === 1 ? 'y' : 'ies'} defined but never granted (possible missed pickup): ${f.dangling.join(', ')}`);
  }
  if (f.orphans.length > 0) {
    console.log(`  Soft: ${f.orphans.length} orphan section${f.orphans.length === 1 ? '' : 's'} (no events, no choices, not flagged as ending): ${f.orphans.map(s => '§' + s).join(', ')}`);
  }
  const enumerate = (label, findings, cap = 20) => {
    if (findings.length === 0) return;
    console.log(`  Soft: ${findings.length} ${label}:`);
    for (const x of findings.slice(0, cap)) console.log(`    - ${x}`);
    if (findings.length > cap) console.log(`    - (+${findings.length - cap} more)`);
  };
  enumerate('loss-in-choice-text findings', f.lossInChoiceText);
  enumerate('disarmament-without-event findings', f.disarmamentWithoutEvent);
  enumerate('enemy-immunity findings', f.enemyImmunities);
  enumerate('missing eat_meal findings', f.missingEatMeal);
  enumerate('catalog-category-vs-text-language findings', f.categoryVsTextLanguage);
  enumerate('catalog-effect-promise-without-machinery findings', f.catalogEffectPromise);
  enumerate('Rule 46 orphan-resume findings', f.rule46OrphanResumes || []);
  enumerate('Rule 49 mechanic-verbs-in-note findings', f.mechanicVerbsInNote || []);
}

const bookText = fs.readFileSync(bookPath, 'utf8');
const book = loadBook(bookText, 'book');
validate(book);
const post = summarise(validate.errors, `POST (${path.basename(bookPath)})`);

if (!baselineSpec) {
  for (const [sec, n] of Object.entries(post.buckets).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${sec}\t${n}`);
  }
  printSoftChecks(book);
  const scriptCheck = BookChecks.checkScriptExecution(book, runScript);
  if (scriptCheck.skipped) {
    console.log(`  Script execution: SKIPPED — ${scriptCheck.skipped}`);
  } else if (scriptCheck.failures.length > 0) {
    console.log(`  Script execution: ${scriptCheck.failures.length} BLOCKING failure(s) — script_code crashed when executed in the Lua sandbox:`);
    for (const f of scriptCheck.failures) console.log(`    - ${f}`);
  } else {
    console.log('  Script execution: all script events executed without error.');
  }
  const scriptBlocked = !scriptCheck.skipped && scriptCheck.failures.length > 0;
  process.exit((post.total === 0 && !scriptBlocked) ? 0 : 1);
}

const colon = baselineSpec.indexOf(':');
if (colon < 0) usage(`--baseline must be <rev>:<path>, got "${baselineSpec}"`);
const rev = baselineSpec.slice(0, colon);
const relPath = baselineSpec.slice(colon + 1);
const repoRoot = (() => {
  try {
    return execSync(`git -C "${path.dirname(bookPath)}" rev-parse --show-toplevel`, { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString().trim();
  } catch { return path.dirname(bookPath); }
})();
const baselineText = (() => {
  try {
    return execSync(`git -C "${repoRoot}" show "${rev}:${relPath}"`, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString();
  } catch (e) {
    console.error(`git show ${rev}:${relPath} failed: ${e.message}`);
    process.exit(1);
  }
})();
const baseBook = loadBook(baselineText, 'baseline');
const baseValidate = ajv.compile(schema);
baseValidate(baseBook);
const pre = summarise(baseValidate.errors, `PRE  (${rev}:${relPath})`);

const allKeys = new Set([...Object.keys(pre.buckets), ...Object.keys(post.buckets)]);
const deltas = [];
let regressedSections = 0;
for (const key of allKeys) {
  const before = pre.buckets[key] || 0;
  const after = post.buckets[key] || 0;
  if (before !== after) {
    deltas.push({ key, before, after, delta: after - before });
    if (after > before) regressedSections += 1;
  }
}
deltas.sort((a, b) => a.delta - b.delta);

console.log(`Total delta: ${pre.total} -> ${post.total} (${post.total - pre.total >= 0 ? '+' : ''}${post.total - pre.total})`);
console.log('Per-section deltas (sections with no change omitted):');
for (const d of deltas) {
  const sign = d.delta > 0 ? '+' : '';
  console.log(`  ${d.key}\t${d.before} -> ${d.after} (${sign}${d.delta})`);
}
if (regressedSections === 0) {
  console.log('No section saw an error-count increase. (Out-of-scope regressions: none.)');
  process.exit(0);
} else {
  console.log(`${regressedSections} section(s) saw an error-count increase. Review for out-of-scope regressions.`);
  process.exit(1);
}
