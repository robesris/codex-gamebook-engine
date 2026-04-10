#!/usr/bin/env node
/**
 * Codex Gamebook Engine — CLI Replay Tool
 *
 * Runs a scripted playthrough from a "playbook" file. Each line is either:
 *   - A blank line (skipped)
 *   - A comment starting with `#` (logged but not executed)
 *   - A checkpoint starting with `# expect <field>=<value>` (verified)
 *   - An action: <action_name> [args...]
 *
 * Special directives:
 *   `# book <path>`             — Load this book file. Must come before any action.
 *   `# section <text>`          — Mark a section header (just for log organization)
 *   `# expect section=N`        — After previous action, current section must be N
 *   `# expect stat:NAME=N`      — Stat NAME must equal N
 *   `# expect inventory has X`  — Inventory must contain item X
 *   `# expect pause=TYPE`       — Current pause type must be TYPE
 *   `# stop_on_error`           — (default) Stop on first error or checkpoint failure
 *   `# continue_on_error`       — Log errors but keep going
 *
 * Output: writes a structured log file with everything that happened.
 *
 * Usage:
 *   node replay.js <playbook.script> <log.txt> [--quiet]
 *
 * Exit codes:
 *   0 — playthrough completed successfully (or hit ending)
 *   1 — error or checkpoint mismatch
 *   2 — usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const emu = require('./play.js');

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: replay.js <playbook> <log-file> [--quiet]');
    process.exit(2);
  }
  const playbookPath = args[0];
  const logPath = args[1];
  const quiet = args.includes('--quiet');

  const playbook = fs.readFileSync(playbookPath, 'utf8').split(/\r?\n/);
  const log = [];
  let bookPath = null;
  let state = null;
  let book = null;
  let stopOnError = true;
  let lineNum = 0;
  let errors = 0;

  function append(entry) {
    log.push(entry);
    if (!quiet) {
      const tag = entry.type ? `[${entry.type}]` : '';
      const msg = entry.message || JSON.stringify(entry).slice(0, 200);
      console.log(`${String(lineNum).padStart(4)} ${tag} ${msg}`);
    }
  }

  function fail(msg) {
    errors++;
    append({ type: 'ERROR', line: lineNum, message: msg });
    if (stopOnError) return false;
    return true;
  }

  for (const rawLine of playbook) {
    lineNum++;
    const line = rawLine.trim();

    if (line === '') continue;

    // Comments and directives
    if (line.startsWith('#')) {
      const directive = line.slice(1).trim();

      // Book load
      const bookMatch = directive.match(/^book\s+(.+)$/);
      if (bookMatch) {
        bookPath = bookMatch[1].trim();
        state = emu.initialState(bookPath);
        book = emu.loadBook(state);
        // Skip frontmatter automatically if no pages
        if (!book.frontmatter?.pages?.length) {
          state.frontmatterDone = true;
          emu.startCharacterCreation(state, book);
        }
        append({ type: 'BOOK', message: `Loaded ${bookPath}` });
        continue;
      }

      // Section header
      const sectionMatch = directive.match(/^section\s+(.+)$/);
      if (sectionMatch) {
        append({ type: 'SECTION', message: sectionMatch[1] });
        continue;
      }

      // Error mode
      if (directive === 'stop_on_error') { stopOnError = true; continue; }
      if (directive === 'continue_on_error') { stopOnError = false; continue; }

      // Checkpoint
      const expectMatch = directive.match(/^expect\s+(.+)$/);
      if (expectMatch) {
        const expr = expectMatch[1].trim();
        if (!state) {
          if (!fail(`Checkpoint before book loaded: ${expr}`)) break;
          continue;
        }
        const ok = checkExpect(expr, state, book);
        if (ok) {
          append({ type: 'CHECK', message: `OK: ${expr}` });
        } else {
          const actual = describeState(state, book);
          if (!fail(`FAILED: ${expr} (state: ${actual})`)) break;
        }
        continue;
      }

      // Plain comment — just log it
      append({ type: 'NOTE', message: directive });
      continue;
    }

    // Action line
    if (!state) {
      if (!fail(`Action before book loaded: ${line}`)) break;
      continue;
    }

    const parts = parseLine(line);
    const action = parts[0];
    const actionArgs = parts.slice(1);

    const beforePause = state.pause ? JSON.stringify(state.pause).slice(0, 80) : 'none';
    let actionError = null;
    try {
      emu.applyAction(state, book, action, actionArgs);
    } catch (e) {
      actionError = e.message || String(e);
    }
    const afterPause = state.pause ? JSON.stringify(state.pause).slice(0, 80) : 'none';
    const recentLog = (state.log || []).slice(-3).join(' | ');

    append({
      type: 'ACT',
      line: lineNum,
      action,
      args: actionArgs,
      before_pause: beforePause,
      after_pause: afterPause,
      section: state.currentSection,
      recent_log: recentLog,
      error: actionError,
    });

    if (actionError) {
      if (!fail(`Action threw: ${actionError}`)) break;
    }

    // If we hit an ending, stop
    if (state.pause?.type === 'ending') {
      append({ type: 'ENDING', message: `${state.pause.ending_type}: ${state.pause.text?.slice(0, 100)}` });
      break;
    }

    // If the emulator returned an error pause, that's a failure
    if (state.pause?.type === 'error') {
      if (!fail(`Emulator error pause: ${state.pause.message}`)) break;
    }
  }

  // Write structured log
  const finalState = state ? emu.compactState(state) : null;
  const summary = state && book ? emu.summarize(state, book) : null;
  const fullLog = {
    playbook: playbookPath,
    book: bookPath,
    lines_processed: lineNum,
    errors,
    log,
    final_state: finalState,
    final_summary: summary,
  };
  fs.writeFileSync(logPath, JSON.stringify(fullLog, null, 2));

  if (!quiet) {
    console.log('---');
    console.log(`Done. ${log.length} entries, ${errors} errors. Log: ${logPath}`);
    if (state?.pause) console.log(`Final pause: ${state.pause.type}`);
    if (state?.currentSection) console.log(`Final section: ${state.currentSection}`);
  }

  process.exit(errors > 0 ? 1 : 0);
}

// Parse a line: "action arg1 arg2 \"with spaces\" arg4"
function parseLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && (i === 0 || line[i - 1] !== '\\')) {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ' ' && !inQuotes) {
      if (current.length > 0) { result.push(current); current = ''; }
      continue;
    }
    current += c;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function checkExpect(expr, state, book) {
  // section=N
  let m = expr.match(/^section=(\S+)$/);
  if (m) return String(state.currentSection) === String(m[1]);

  // pause=TYPE
  m = expr.match(/^pause=(\S+)$/);
  if (m) return state.pause?.type === m[1];

  // stat:NAME=N or stat:NAME>=N etc
  m = expr.match(/^stat:(\S+?)(=|>=|<=|>|<)(.+)$/);
  if (m) {
    const stat = m[1];
    const op = m[2];
    const val = parseInt(m[3]);
    const cur = state.stats[stat];
    if (cur === undefined) return false;
    if (op === '=') return cur === val;
    if (op === '>=') return cur >= val;
    if (op === '<=') return cur <= val;
    if (op === '>') return cur > val;
    if (op === '<') return cur < val;
  }

  // inventory has X
  m = expr.match(/^inventory has (\S+)$/);
  if (m) return state.inventory.includes(m[1]);

  // inventory missing X
  m = expr.match(/^inventory missing (\S+)$/);
  if (m) return !state.inventory.includes(m[1]);

  // flag has X
  m = expr.match(/^flag has (\S+)$/);
  if (m) return state.flags.includes(m[1]);

  // provisions=N or provisions>=N
  m = expr.match(/^provisions(=|>=|<=|>|<)(.+)$/);
  if (m) {
    const op = m[1], val = parseInt(m[2]), cur = state.provisions;
    if (op === '=') return cur === val;
    if (op === '>=') return cur >= val;
    if (op === '<=') return cur <= val;
    if (op === '>') return cur > val;
    if (op === '<') return cur < val;
  }

  return false;
}

function describeState(state, book) {
  const parts = [];
  if (state.currentSection) parts.push(`section=${state.currentSection}`);
  if (state.pause) parts.push(`pause=${state.pause.type}`);
  for (const [k, v] of Object.entries(state.stats || {})) parts.push(`${k}=${v}`);
  if (state.provisions !== undefined) parts.push(`prov=${state.provisions}`);
  return parts.join(' ');
}

main();
