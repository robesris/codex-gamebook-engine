#!/usr/bin/env node
// Post-parse coverage check for a GBF book file.
//
// Usage:
//   node scripts/check-reachability.js <path-to-book.json>
//
// Walks the book starting at section 1, follows every "turn to N"
// instruction it can find, and reports any section a player would
// never visit during real play. Sections fall into three categories:
//
//   "stranded"          — nothing in the book points to this section
//                         (a parser miss; the smoking gun)
//   "stranded-behind"   — something points to it, but only from another
//                         stranded section (fix the upstream ones first)
//   "player-typed-only" — only reached when the player types a number
//                         (key-sum puzzle, lock combination) — not a
//                         defect on its own; flagged for confirmation
//
// Reads:
//   sections[*].choices[*].target
//   sections[*].events[*] — any field in {target, win_to, flee_to,
//                            lose_to, end_to, goto, navigate_to,
//                            to_section, return_to}
//   Lua `script_code` containing `navigate_to = N`
//   input_number events with `from_inventory_category` — modelled
//   against `items_catalog` entries in that category to compute the
//   set of player-typed-only destinations.
//
// Prints a layman-friendly report; exits 1 if there are any stranded
// or stranded-behind sections, 0 otherwise. The script-execution gate
// and schema check live in validate-book.js; this script ONLY answers
// "can the player actually reach every section?"
'use strict';
const fs = require('fs');
const path = require('path');

const NAV_KEYS = new Set(['target', 'win_to', 'flee_to', 'lose_to', 'end_to', 'goto', 'navigate_to', 'to_section', 'return_to']);

function loadBook(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`${path.basename(p)}: ${e.message}`); process.exit(2); }
}

function harvest(srcId, node, edges, inputSections) {
  if (node == null) return;
  if (Array.isArray(node)) { for (const x of node) harvest(srcId, x, edges, inputSections); return; }
  if (typeof node !== 'object') return;
  if (node.type === 'input_number' || node.type === 'input_text') inputSections.add(srcId);
  for (const [k, v] of Object.entries(node)) {
    if (NAV_KEYS.has(k) && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) {
      edges.get(srcId).add(String(v));
    }
    if (k === 'script_code' && typeof v === 'string') {
      for (const m of v.matchAll(/navigate_to\s*=\s*(\d+)/g)) edges.get(srcId).add(m[1]);
    }
    harvest(srcId, v, edges, inputSections);
  }
}

function extractKeyNumber(itemId, item) {
  for (const k of ['value', 'number']) {
    const v = item[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  const m = String(itemId).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function plausibleInputTargets(book, count) {
  // For input_number events with from_inventory_category="keys" (or similar
  // numbered-items category), the player chooses `count` items, sums them,
  // and turns to the resulting section. Enumerate plausible sums in [1, N].
  const cat = 'keys';
  const numbers = [];
  for (const [iid, it] of Object.entries(book.items_catalog || {})) {
    if (it.category !== cat && !iid.toLowerCase().includes('key')) continue;
    const n = extractKeyNumber(iid, it);
    if (n != null) numbers.push(n);
  }
  const sums = new Set();
  function pick(start, soFar, remaining) {
    if (remaining === 0) {
      const s = soFar.reduce((a, b) => a + b, 0);
      if (s >= 1 && s <= 400 && book.sections[String(s)]) sums.add(String(s));
      return;
    }
    for (let i = start; i < numbers.length; i++) pick(i + 1, [...soFar, numbers[i]], remaining - 1);
  }
  pick(0, [], count);
  return sums;
}

function main() {
  const bookPath = process.argv[2];
  if (!bookPath) {
    console.error('Usage: node scripts/check-reachability.js <path-to-book.json>');
    process.exit(2);
  }
  const book = loadBook(bookPath);
  const sections = book.sections || {};
  const ids = Object.keys(sections);
  if (!ids.length) { console.error('No sections in book.'); process.exit(2); }

  // 1. Harvest all literal navigation edges.
  const edges = new Map(ids.map(id => [id, new Set()]));
  const inputSections = new Set();
  for (const id of ids) {
    harvest(id, sections[id].choices || [], edges, inputSections);
    harvest(id, sections[id].events || [], edges, inputSections);
  }

  // 2. For sections that pause on a player-typed number sourced from
  //    items_catalog (key-sum puzzles), add edges to every plausible
  //    sum. Track which edges are "input-only" so we can report on
  //    them separately.
  const inputOnlyEdges = new Map(); // src -> Set of dst ids
  for (const id of inputSections) {
    const sec = sections[id];
    const inputEvents = (sec.events || []).filter(e => e && (e.type === 'input_number' || e.type === 'input_text'));
    for (const ev of inputEvents) {
      if (ev.from_inventory_category && typeof ev.count === 'number') {
        const sums = plausibleInputTargets(book, ev.count);
        if (!inputOnlyEdges.has(id)) inputOnlyEdges.set(id, new Set());
        for (const s of sums) {
          if (!edges.get(id).has(s)) inputOnlyEdges.get(id).add(s);
          edges.get(id).add(s);
        }
      }
    }
  }

  // 3. BFS from §1.
  const start = sections['1'] ? '1' : ids.sort((a, b) => +a - +b)[0];
  const reachable = new Set([start]);
  const reachedViaInputOnly = new Set();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    const inputOnly = inputOnlyEdges.get(cur) || new Set();
    for (const nxt of edges.get(cur)) {
      if (!reachable.has(nxt)) {
        reachable.add(nxt);
        if (inputOnly.has(nxt) && !(edges.get(cur).has(nxt) && hasLiteralEdge(sections[cur], nxt))) {
          // we reached nxt only via the modelled key-sum edge.
          reachedViaInputOnly.add(nxt);
        }
        queue.push(nxt);
      }
    }
  }

  const unreachable = ids.filter(id => !reachable.has(id)).sort((a, b) => +a - +b);

  // 4. Classify each unreachable.
  const predecessors = new Map(ids.map(id => [id, []]));
  for (const [src, outs] of edges) for (const t of outs) predecessors.get(t)?.push(src);
  const stranded = [];
  const strandedBehind = [];
  for (const u of unreachable) {
    const ps = predecessors.get(u) || [];
    if (ps.length === 0) stranded.push(u);
    else strandedBehind.push({ id: u, preds: ps });
  }

  // 5. Layman report.
  const W = book.metadata && book.metadata.title ? `"${book.metadata.title}"` : path.basename(bookPath);
  console.log(`Coverage check: ${W}`);
  console.log(`  sections in book:                    ${ids.length}`);
  console.log(`  reachable from §${start} (player can visit): ${reachable.size}`);
  console.log(`  not reachable:                       ${unreachable.length}`);
  console.log();
  const isWinSec = id => sections[id] && (sections[id].is_ending || (sections[id].ending_type === 'victory'));
  const victoryIds = ids.filter(isWinSec).filter(id => (sections[id].ending_type || '').includes('victor') || /victor|the end|you have won/i.test(sections[id].text || ''));
  if (victoryIds.length) {
    const blocked = victoryIds.filter(id => !reachable.has(id));
    if (blocked.length) console.log(`  ! victory ending(s) NOT reachable: ${blocked.map(x => '§' + x).join(', ')}`);
    else console.log(`  victory ending(s) reachable: ${victoryIds.map(x => '§' + x).join(', ')}`);
    console.log();
  }

  if (stranded.length) {
    console.log(`STRANDED — ${stranded.length} section${stranded.length === 1 ? '' : 's'} nothing else in the book points to.`);
    console.log(`These are the smoking guns. For each, go to the source text and search for any place that says "turn to <section number>" — whichever section's body text contains that line is one the parse missed a choice from. Add the missing choice and re-run.`);
    console.log(`  ${stranded.map(x => '§' + x).join(', ')}`);
    console.log();
  } else {
    console.log(`STRANDED — none. Every section in the book has at least one other section pointing to it.`);
    console.log();
  }

  if (strandedBehind.length) {
    console.log(`STRANDED-BEHIND — ${strandedBehind.length} section${strandedBehind.length === 1 ? '' : 's'} something points to, but only from another stranded section.`);
    console.log(`These will usually fix themselves once you recover the STRANDED list above — just re-run this script after each fix.`);
    const cap = 12;
    for (const x of strandedBehind.slice(0, cap)) {
      const lostPreds = x.preds.filter(p => !reachable.has(p));
      console.log(`  §${x.id}  (only reached from: ${lostPreds.map(p => '§' + p).join(', ')})`);
    }
    if (strandedBehind.length > cap) console.log(`  (+${strandedBehind.length - cap} more)`);
    console.log();
  }

  // 6. Player-typed-only summary.
  if (reachedViaInputOnly.size) {
    const list = [...reachedViaInputOnly].sort((a, b) => +a - +b);
    console.log(`PLAYER-TYPED-ONLY — ${list.length} section${list.length === 1 ? '' : 's'} reachable only when the player types a specific number (key-sum puzzle / lock combination).`);
    console.log(`These are NOT defects on their own — the script just can't tell from looking at the book whether the player's typed number will land here. Confirm against the source: if the section is a plausible "right answer" or "specific wrong answer" destination, leave it; if the source says it should ALSO be reached some other way, the parse missed that other way.`);
    console.log(`  ${list.map(x => '§' + x).join(', ')}`);
    console.log();
  }

  // 7. Exit code: 0 only if no STRANDED or STRANDED-BEHIND sections.
  const blockingCount = stranded.length + strandedBehind.length;
  if (blockingCount === 0) {
    console.log(`OK — every section is reachable during play (modulo the player-typed-only set, which is documented above).`);
    process.exit(0);
  } else {
    console.log(`Not yet clean — ${blockingCount} section${blockingCount === 1 ? '' : 's'} still unreachable. Recover the STRANDED list first.`);
    process.exit(1);
  }
}

function hasLiteralEdge(section, dstId) {
  // Does the section have ANY non-input-modelled edge to dstId?
  // (We only need this to decide whether a section was reached
  // through a literal "turn to" or only through the modelled input.)
  const seen = new Set();
  function walk(node) {
    if (node == null || seen.has(node) || typeof node !== 'object') return false;
    seen.add(node);
    if (node.type === 'input_number' || node.type === 'input_text') return false;
    if (Array.isArray(node)) return node.some(walk);
    for (const [k, v] of Object.entries(node)) {
      if (NAV_KEYS.has(k) && String(v) === String(dstId)) return true;
      if (k === 'script_code' && typeof v === 'string' && new RegExp(`navigate_to\\s*=\\s*${dstId}\\b`).test(v)) return true;
      if (walk(v)) return true;
    }
    return false;
  }
  return walk(section.choices || []) || walk(section.events || []);
}

main();
