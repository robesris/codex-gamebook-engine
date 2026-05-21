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

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

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

// Soft structural checks. These do NOT affect exit code — schema validity is the
// only blocking signal. The soft checks surface drift that the schema can't catch:
// catalog entries that are defined but never granted (missed pickups), orphan
// sections (parser dead-ends), stat losses mentioned in choice text without a
// matching modify_stat event, disarmament narratives without a corresponding
// remove event, and combats against known-immune enemies whose catalog entry
// is missing the expected intrinsic_modifiers.
function collectGrantedItemIds(book) {
  const granted = new Set();
  const scan = (events) => {
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'add_item' && ev.item) granted.add(ev.item);
      if (ev.type === 'choose_items' && Array.isArray(ev.options)) {
        for (const o of ev.options) if (typeof o === 'string') granted.add(o);
      }
      if (ev.type === 'roll_dice' && ev.results) {
        for (const r of Object.values(ev.results)) scan(r && r.effects);
      }
    }
  };
  for (const s of Object.values(book.sections || {})) scan(s && s.events);
  for (const step of (book.character_creation && book.character_creation.steps) || []) {
    scan(step && step.events);
    if (step && step.action === 'add_item' && step.item) granted.add(step.item);
    // Chargen roll_table results: schema uses an OBJECT keyed by range strings
    // ("0", "1", ..., "9") with `effects` arrays under each. Some books may
    // alternatively use an array. Handle both shapes.
    const rollResults = (step && step.roll_table && step.roll_table.results) || (step && step.action === 'roll_table' && step.results);
    if (rollResults) {
      const iter = Array.isArray(rollResults) ? rollResults : Object.values(rollResults);
      for (const r of iter) scan(r && r.effects);
    }
    // Chargen choose_one action with options carrying effects
    if (step && step.action === 'choose_one' && Array.isArray(step.options)) {
      for (const o of step.options) scan(o && o.effects);
    }
  }
  return granted;
}

// Flatten all events in a section, recursing into roll_dice.results.effects.
function flattenSectionEvents(section) {
  const out = [];
  const walk = (events) => {
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      out.push(ev);
      if (ev.type === 'roll_dice' && ev.results) {
        for (const r of Object.values(ev.results)) walk(r && r.effects);
      }
    }
  };
  walk(section && section.events);
  return out;
}

// Check A: choice.text mentions "lose/deduct N <stat>" but the section has no
// matching modify_stat event applying the loss. Catches the §276/§343 pattern
// where the loss is narrated in the choice text but never wired as an event.
function checkLossInChoiceText(book) {
  const findings = [];
  const lossRe = /(?:lose|deduct|subtract)\s+(\d+)\s+(ENDURANCE|COMBAT SKILL|STAMINA|SKILL|LUCK)/gi;
  for (const [secId, s] of Object.entries(book.sections || {})) {
    if (!s) continue;
    for (const choice of (s.choices || [])) {
      const text = (choice && choice.text) || '';
      let m;
      while ((m = lossRe.exec(text)) !== null) {
        const amount = parseInt(m[1], 10);
        const stat = m[2].toUpperCase();
        const flat = flattenSectionEvents(s);
        const hasScript = flat.some(ev => ev.type === 'script');
        const hasMatchingModify = flat.some(ev =>
          ev.type === 'modify_stat' &&
          typeof ev.stat === 'string' &&
          ev.stat.toUpperCase() === stat &&
          typeof ev.amount === 'number' &&
          ev.amount === -amount
        );
        if (!hasMatchingModify && !hasScript) {
          findings.push(`§${secId}: choice text mentions "lose ${amount} ${stat}" but no matching modify_stat (or script) event in section`);
        }
      }
    }
  }
  return findings;
}

// Check B: section text describes inventory disarmament ("they take your Backpack",
// "you lose your Weapon", "erase all Backpack Items", "Weapon is broken in two",
// "cross off your Action Chart") but no remove_item / remove_inventory_category /
// script event applies the loss. Catches the §83→§205 / §144 / §162 / §174 /
// §258 / §274 / §277 / §294 pattern.
function checkDisarmamentWithoutEvent(book) {
  const findings = [];
  // Trigger phrases that indicate the player loses inventory in this section.
  const triggers = [
    // "they take your X" / "the guards seize your X" — second-person theft
    /(?:they|the\s+\w+|guards?|soldiers?|men|enemy)\s+(?:take|seize|confiscate|strip(?:\s+you\s+of)?)\s+(?:all\s+)?(?:your\s+)?(?:backpack|weapons?|equipment|gear)/i,
    // "you lose your X" / "you (have) (unfortunately) lost your X" — allow 0-3 adverbs between subject and verb
    /\byou\s+(?:\w+\s+){0,3}(?:lost|lose)\s+(?:your\s+|all\s+(?:your\s+)?)?(?:backpack|weapons?|equipment)/i,
    // "X is stolen from your Backpack/pouch" — theft pattern (§144 fallback)
    /(?:is|are)\s+stolen\s+from\s+(?:your\s+)?(?:backpack|pouch)/i,
    // "erase ... from your Action Chart" / "take this off your Action Chart" / "cross off" — explicit cross-off instruction (allows intermediate text up to 100 chars)
    /(?:erase|cross\s+off|remove|take(?:\s+this|\s+that|\s+it)?\s+off)[^.]{0,100}action\s+chart/i,
    // "Weapon is broken in two" / "Backpack is destroyed" — gear damage
    /(?:your\s+)?(?:weapons?|backpack)\s+(?:is|are)\s+(?:broken|destroyed|shattered|smashed)/i,
    // "you no longer have your Backpack"
    /(?:no\s+longer\s+have|no\s+longer\s+carry)\s+(?:your\s+|any\s+)?(?:backpack|weapons?|equipment)/i,
  ];
  // Negation guard: skip if any matched phrase is within 30 chars after
  // "do not"/"don't"/"will not"/"won't"/"cannot"/"never" — those are negated.
  const negationRe = /(?:do\s+not|don['']t|will\s+not|won['']t|cannot|never)\s+(?:[^.!?]{0,60})/gi;
  for (const [secId, s] of Object.entries(book.sections || {})) {
    if (!s) continue;
    const text = (s.text || '');
    let matched = null;
    for (const re of triggers) {
      const m = text.match(re);
      if (m) {
        // Negation check: was this match inside a negated clause?
        let negated = false;
        let n;
        const idx = text.toLowerCase().indexOf(m[0].toLowerCase());
        const negRe = new RegExp(negationRe.source, 'gi');
        while ((n = negRe.exec(text)) !== null) {
          if (idx >= n.index && idx <= n.index + n[0].length) { negated = true; break; }
        }
        if (!negated) { matched = m[0].trim(); break; }
      }
    }
    if (!matched) continue;
    const flat = flattenSectionEvents(s);
    const hasRemoveEvent = flat.some(ev =>
      ev.type === 'remove_item' ||
      ev.type === 'remove_inventory_category' ||
      ev.type === 'clear_inventory' ||
      ev.type === 'script' // script events can apply removal programmatically
      // Note: `choose_items` is intentionally NOT in this list. The current
      // schema's choose_items is a GRANT primitive (player picks which items
      // to take). There's no loss-variant in the schema yet, so a choose_items
      // event in a disarmament-narrative section is a misleading workaround,
      // not a real fix. Excluded so disarmament-without-event stays surfaced
      // until either (a) the schema ships a remove-variant of choose_items,
      // or (b) the book switches to a remove_inventory_category / script
      // encoding.
    );
    if (!hasRemoveEvent) {
      findings.push(`§${secId}: text describes inventory loss (\"${matched}\") but no remove_item / remove_inventory_category / script event in section`);
    }
  }
  return findings;
}

// Check C: combats against enemies known to be immune to specific disciplines
// must have intrinsic_modifiers cancelling those bonuses. LW-family registry —
// other book series add their own entries here as needed. Each registry entry
// maps a substring (case-insensitive, matched against enemies_catalog[id].name)
// to the list of ability names whose +CS bonus the enemy is immune to.
const enemyImmunityRegistry = {
  vordak: ['Mindblast'],
  helghast: ['Mindblast'],
  gourgaz: ['Mindblast'],
  darklord: ['Mindblast'],
  burrowcrawler: ['Mindblast', 'Animal Kinship'],
};

function checkEnemyImmunities(book) {
  const findings = [];
  const enemies = book.enemies_catalog || {};
  for (const [enemyId, e] of Object.entries(enemies)) {
    if (!e) continue;
    const name = (e.name || '').toLowerCase();
    const expectedImmunities = [];
    for (const [key, abilities] of Object.entries(enemyImmunityRegistry)) {
      if (name.includes(key)) {
        for (const a of abilities) if (!expectedImmunities.includes(a)) expectedImmunities.push(a);
      }
    }
    if (expectedImmunities.length === 0) continue;
    const mods = Array.isArray(e.intrinsic_modifiers) ? e.intrinsic_modifiers : [];
    const present = new Set();
    for (const m of mods) {
      // Walk the condition tree (handles {has_ability:"X"} and nested and/or/not)
      const walk = (cond) => {
        if (!cond || typeof cond !== 'object') return;
        if (cond.has_ability) present.add(cond.has_ability);
        if (cond.type === 'has_ability' && cond.ability) present.add(cond.ability);
        if (Array.isArray(cond.conditions)) for (const c of cond.conditions) walk(c);
        if (cond.condition) walk(cond.condition);
      };
      walk(m && m.condition);
    }
    const missing = expectedImmunities.filter(a => !present.has(a));
    if (missing.length > 0) {
      findings.push(`${enemyId} ("${e.name}"): name matches known-immune type but intrinsic_modifiers missing immunity for ${missing.join(', ')}`);
    }
  }
  return findings;
}

// Check D: section text describes a Meal instruction ("must now take a Meal",
// "you must eat", "stop to eat", "very hungry") but the section has no
// eat_meal event. Catches the LW1 §168-style pattern.
function checkMissingEatMeal(book) {
  const findings = [];
  // Explicit-instruction language. Excludes narrative meal mentions like
  // "you find food enough for two Meals" or "the merchant offers you food."
  const mealInstructionRe = /\b(?:must now (?:take|eat)|now (?:take|eat)|stop to eat|now eat) a Meal\b|\bvery hungry\b/i;
  for (const [secId, s] of Object.entries(book.sections || {})) {
    if (!s) continue;
    const text = s.text || '';
    if (!mealInstructionRe.test(text)) continue;
    const flat = flattenSectionEvents(s);
    if (flat.some(ev => ev.type === 'eat_meal')) continue;
    if (flat.some(ev => ev.type === 'script')) continue; // script could handle it
    const sent = text.match(/[^.!?]*(?:must now (?:take|eat)|now (?:take|eat)|stop to eat|now eat) a Meal[^.!?]*/i) || text.match(/[^.!?]*very hungry[^.!?]*/i);
    findings.push(`§${secId}: text describes a Meal instruction (\"${(sent || ['']).toString().trim().slice(0, 80)}\") but no eat_meal event in section`);
  }
  return findings;
}

// Check E: catalog category vs encoded section-text language. When a section's
// text uses "Special Item" near an item-grant, the granted item's catalog
// `inventory_category` should be `special_items`; when text uses "Backpack
// Item", the category should be `backpack`. Catches mis-categorized catalog
// entries where the encoded text confirms the source's intended category.
// (Does NOT catch text-drift cases where the encoded text already mis-paraphrases
// the source — that requires a source-text comparator, out of scope here.)
function checkCategoryVsTextLanguage(book) {
  const findings = [];
  const catalog = book.items_catalog || {};
  for (const [secId, s] of Object.entries(book.sections || {})) {
    if (!s) continue;
    const text = s.text || '';
    const flat = flattenSectionEvents(s);
    const adds = flat.filter(ev => ev.type === 'add_item' && ev.item).map(ev => ev.item);
    if (adds.length === 0) continue;
    for (const itemId of adds) {
      const entry = catalog[itemId];
      if (!entry) continue;
      const cat = entry.inventory_category;
      // Look for category-language proximity to the item's name (or to the grant verb)
      const name = (entry.name || itemId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameRe = new RegExp(name, 'i');
      // Sentences within the section text
      const sentences = text.split(/(?<=[.!?])\s+/);
      for (const sent of sentences) {
        const sentL = sent.toLowerCase();
        const hasSpecialLang = /\bspecial item\b/i.test(sent);
        const hasBackpackLang = /\bbackpack item\b/i.test(sent);
        if (!hasSpecialLang && !hasBackpackLang) continue;
        if (!nameRe.test(sent) && sent.length < 500) continue; // proximity check
        // Find the conflict
        if (hasSpecialLang && cat !== 'special_items') {
          findings.push(`§${secId} grants ${itemId}: text mentions \"Special Item\" but catalog inventory_category is \"${cat}\"`);
          break;
        }
        if (hasBackpackLang && cat !== 'backpack') {
          findings.push(`§${secId} grants ${itemId}: text mentions \"Backpack Item\" but catalog inventory_category is \"${cat}\"`);
          break;
        }
      }
    }
  }
  return findings;
}

// Check F: catalog entry's description promises a mechanical effect (Restores
// N ENDURANCE, adds N to COMBAT SKILL, "single dose", "when swallowed") but
// the entry has no consume.effects, no triggered_effects, and no stat_modifier.
// Catches Rule 25 lag + Rule 36 lag on consumables. The healing_potion case.
function checkCatalogEffectPromise(book) {
  const findings = [];
  const promiseRe = /(?:restores?|heals?|adds?|increases?|reduces?|grants?)\s+\d+|(?:when |if )(?:swallow|drink|consume|eat|used|equipped|in combat|before|after)|single dose/i;
  for (const [id, item] of Object.entries(book.items_catalog || {})) {
    if (!item) continue;
    const desc = item.description || '';
    if (!promiseRe.test(desc)) continue;
    const hasConsume = item.consume && Array.isArray(item.consume.effects) && item.consume.effects.length > 0;
    const hasTrig = Array.isArray(item.triggered_effects) && item.triggered_effects.length > 0;
    const hasStatMod = item.stat_modifier;
    if (hasConsume || hasTrig || hasStatMod) continue;
    findings.push(`${id} (\"${item.name || id}\"): description promises an effect (\"${desc.slice(0, 80)}...\") but no consume.effects / triggered_effects / stat_modifier on the catalog entry`);
  }
  return findings;
}

function softChecks(book) {
  const catalogIds = Object.keys(book.items_catalog || {});
  const granted = collectGrantedItemIds(book);
  const dangling = catalogIds.filter(id => !granted.has(id)).sort();

  const orphans = [];
  for (const [id, s] of Object.entries(book.sections || {})) {
    if (!s || s.is_ending) continue;
    const noEvents = !Array.isArray(s.events) || s.events.length === 0;
    const noChoices = !Array.isArray(s.choices) || s.choices.length === 0;
    if (noEvents && noChoices) orphans.push(id);
  }

  const lossFindings = checkLossInChoiceText(book);
  const disarmFindings = checkDisarmamentWithoutEvent(book);
  const immunityFindings = checkEnemyImmunities(book);
  const mealFindings = checkMissingEatMeal(book);
  const categoryFindings = checkCategoryVsTextLanguage(book);
  const promiseFindings = checkCatalogEffectPromise(book);

  if (dangling.length > 0) {
    console.log(`  Soft: ${dangling.length} catalog entr${dangling.length === 1 ? 'y' : 'ies'} defined but never granted (possible missed pickup): ${dangling.join(', ')}`);
  }
  if (orphans.length > 0) {
    console.log(`  Soft: ${orphans.length} orphan section${orphans.length === 1 ? '' : 's'} (no events, no choices, not flagged as ending): ${orphans.map(s => '§' + s).join(', ')}`);
  }
  const enumerate = (label, findings, cap = 20) => {
    if (findings.length === 0) return;
    console.log(`  Soft: ${findings.length} ${label}:`);
    for (const f of findings.slice(0, cap)) console.log(`    - ${f}`);
    if (findings.length > cap) console.log(`    - (+${findings.length - cap} more)`);
  };
  enumerate('loss-in-choice-text findings', lossFindings);
  enumerate('disarmament-without-event findings', disarmFindings);
  enumerate('enemy-immunity findings', immunityFindings);
  enumerate('missing eat_meal findings', mealFindings);
  enumerate('catalog-category-vs-text-language findings', categoryFindings);
  enumerate('catalog-effect-promise-without-machinery findings', promiseFindings);
}

const bookText = fs.readFileSync(bookPath, 'utf8');
const book = loadBook(bookText, 'book');
validate(book);
const post = summarise(validate.errors, `POST (${path.basename(bookPath)})`);

if (!baselineSpec) {
  for (const [sec, n] of Object.entries(post.buckets).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${sec}\t${n}`);
  }
  softChecks(book);
  process.exit(post.total === 0 ? 0 : 1);
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
