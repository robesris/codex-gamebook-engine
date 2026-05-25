/**
 * Browser verifier driver — composes the shared schema validator, soft
 * checks, and script-execution gate into a single `verifyBook` entry point
 * for the Claude.ai Analysis-tool verifier.
 *
 * ⚠️ IMPORTANT — this file is canonical source. It is assembled (together
 * with fengari-web.js, script-runtime.js, book-checks.js, and a generated
 * standalone schema validator) into dist/verify-book.bundle.js by
 * scripts/build-browser-verifier.js. The bundle is a GENERATED artifact —
 * never hand-edit dist/verify-book.bundle.js. Change this driver (or the
 * shared modules) and rebuild. See the build script's IMPORTANT note.
 *
 * Environment-agnostic: pure JS. All collaborators are injected via
 * createVerifier(deps) so this file has no module-system or runtime
 * dependency of its own.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VerifierDriver = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // deps: { validateSchema, BookChecks, runScript }
  //   validateSchema — the standalone ajv-compiled validator (validateSchema
  //                    .errors is populated after a call returns false)
  //   BookChecks     — the scripts/book-checks.js module exports
  //   runScript      — cli-emulator/script-runtime.js runScript
  function createVerifier(deps) {
    const { validateSchema, BookChecks, runScript } = deps || {};
    if (typeof validateSchema !== 'function') throw new Error('verifier: validateSchema not provided');
    if (!BookChecks) throw new Error('verifier: BookChecks not provided');

    function bucketErrorsBySection(errors) {
      const buckets = {};
      for (const e of errors || []) {
        const m = (e.instancePath || '').match(/^\/sections\/([^/]+)/);
        const key = m ? `§${m[1]}` : '<top-level-or-rules>';
        buckets[key] = (buckets[key] || 0) + 1;
      }
      return buckets;
    }

    // Returns a structured result + a human-readable `report` string suitable
    // for printing in the Analysis tool. `ok` is the blocking verdict: true
    // only when the book is schema-valid AND no script crashed. Soft findings
    // never affect `ok` — they are advisory, exactly as in validate-book.js.
    function verifyBook(input) {
      let book;
      if (typeof input === 'string') {
        try { book = JSON.parse(input); }
        catch (e) { return { ok: false, fatal: `JSON parse failed: ${e.message}`, report: `FATAL: JSON parse failed: ${e.message}` }; }
      } else if (input && typeof input === 'object') {
        book = input;
      } else {
        return { ok: false, fatal: 'verifyBook expects a JSON string or a parsed object', report: 'FATAL: bad input to verifyBook' };
      }

      const schemaValid = validateSchema(book) === true;
      const schemaErrors = schemaValid ? [] : (validateSchema.errors || []).slice();
      const buckets = bucketErrorsBySection(schemaErrors);

      const soft = BookChecks.collectSoftFindings(book);
      const scriptCheck = BookChecks.checkScriptExecution(book, runScript);

      const scriptBlocked = !scriptCheck.skipped && scriptCheck.failures.length > 0;
      const ok = schemaValid && !scriptBlocked;

      // ---- human-readable report ----
      const lines = [];
      lines.push(`Schema: ${schemaErrors.length} error(s)` +
        (schemaErrors.length ? ` across ${Object.keys(buckets).length} site(s).` : ' — valid.'));
      const topBuckets = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 30);
      for (const [sec, n] of topBuckets) lines.push(`  ${sec}\t${n}`);

      if (soft.dangling.length) {
        lines.push(`  Soft: ${soft.dangling.length} catalog entr${soft.dangling.length === 1 ? 'y' : 'ies'} defined but never granted (possible missed pickup): ${soft.dangling.join(', ')}`);
      }
      if (soft.orphans.length) {
        lines.push(`  Soft: ${soft.orphans.length} orphan section${soft.orphans.length === 1 ? '' : 's'} (no events, no choices, not flagged as ending): ${soft.orphans.map(s => '§' + s).join(', ')}`);
      }
      const enumerate = (label, findings, cap) => {
        cap = cap || 20;
        if (!findings.length) return;
        lines.push(`  Soft: ${findings.length} ${label}:`);
        for (const x of findings.slice(0, cap)) lines.push(`    - ${x}`);
        if (findings.length > cap) lines.push(`    - (+${findings.length - cap} more)`);
      };
      enumerate('loss-in-choice-text findings', soft.lossInChoiceText);
      enumerate('disarmament-without-event findings', soft.disarmamentWithoutEvent);
      enumerate('enemy-immunity findings', soft.enemyImmunities);
      enumerate('missing eat_meal findings', soft.missingEatMeal);
      enumerate('catalog-category-vs-text-language findings', soft.categoryVsTextLanguage);
      enumerate('catalog-effect-promise-without-machinery findings', soft.catalogEffectPromise);
      enumerate('Rule 46 orphan-resume findings', soft.rule46OrphanResumes || []);
      enumerate('Rule 49 mechanic-verbs-in-note findings', soft.mechanicVerbsInNote || []);

      if (scriptCheck.skipped) {
        lines.push(`  Script execution: SKIPPED — ${scriptCheck.skipped}`);
      } else if (scriptCheck.failures.length) {
        lines.push(`  Script execution: ${scriptCheck.failures.length} BLOCKING failure(s) — script_code crashed when executed in the Lua sandbox:`);
        for (const f of scriptCheck.failures) lines.push(`    - ${f}`);
      } else {
        lines.push('  Script execution: all script events executed without error.');
      }

      lines.push('');
      lines.push(ok
        ? 'RESULT: PASS — book is schema-valid and every script ran without crashing.'
        : 'RESULT: FAIL — ' + [
            !schemaValid ? `${schemaErrors.length} schema error(s)` : null,
            scriptBlocked ? `${scriptCheck.failures.length} script crash(es)` : null,
          ].filter(Boolean).join(' + ') + '. (Soft findings above are advisory only.)');

      return {
        ok,
        schemaValid,
        schemaErrors,
        schemaErrorBuckets: buckets,
        softFindings: soft,
        scriptFailures: scriptCheck.failures,
        scriptSkipped: scriptCheck.skipped,
        report: lines.join('\n'),
      };
    }

    return verifyBook;
  }

  return { createVerifier };
}));
