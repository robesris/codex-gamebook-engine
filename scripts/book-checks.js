/**
 * Shared book-validation checks — the structural / soft checks and the
 * script-execution gate, factored out of validate-book.js.
 *
 * ⚠️ IMPORTANT — SINGLE SOURCE OF TRUTH. This module is the ONLY place the
 * soft checks (loss-in-choice-text, disarmament-without-event, enemy
 * immunities, missing eat_meal, catalog category-vs-text, catalog effect
 * promises), the orphan/dangling scans, and the script-execution gate are
 * defined. It is consumed by:
 *   - scripts/validate-book.js       (Node — the Claude Code validator)
 *   - scripts/verify-book.browser.js (browser — the Claude.ai Analysis-tool
 *                                     verifier)
 * Do NOT fork or reimplement these checks elsewhere. Both callers import this
 * module so the two environments report identical findings. New checks are
 * added here once, not copied per environment.
 *
 * Environment-agnostic: pure JS, no Node built-ins. The script-execution gate
 * receives `runScript` as a parameter (from cli-emulator/script-runtime.js)
 * rather than importing it, so this module loads cleanly in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BookChecks = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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
      // "erase ... from your Action Chart / Equipment List" — explicit
      // cross-off instruction (allows intermediate text up to 100 chars).
      // Action Chart is LW vocab, Equipment List is FF vocab; some books
      // use "character sheet" / "adventure sheet" generically.
      /(?:erase|cross\s+off|remove|take(?:\s+this|\s+that|\s+it)?\s+off)[^.]{0,100}(?:action\s+chart|equipment\s+list|character\s+sheet|adventure\s+sheet)/i,
      // "adjust your Equipment List" (FF Warlock §155 phrasing — the
      // standalone canonical FF trigger for player-chosen loss; the
      // erase/cross-off pattern above doesn't cover this verb).
      /\badjust\s+your\s+(?:equipment\s+list|action\s+chart|character\s+sheet|adventure\s+sheet)/i,
      // "Weapon is broken in two" / "Backpack is destroyed" — gear damage
      /(?:your\s+)?(?:weapons?|backpack)\s+(?:is|are)\s+(?:broken|destroyed|shattered|smashed)/i,
      // "you no longer have your Backpack"
      /(?:no\s+longer\s+have|no\s+longer\s+carry)\s+(?:your\s+|any\s+)?(?:backpack|weapons?|equipment)/i,
      // "leave behind one item / one of your X" — voluntary-trade
      // phrasing (FF Warlock §155 canonical: "you will have to leave
      // behind one item of equipment").
      /\bleave\s+behind\s+(?:one|an|a|any|some)\s+(?:of\s+your\s+)?(?:item|piece|weapon|object)/i,
      // "in exchange (for) X" / "exchange ... for X" — barter trades
      // where a take must be paired with a give (LW1 §307 Warhammer,
      // any "give X to keep Y" wizard-trade phrasing).
      /\b(?:in\s+exchange(?:\s+for)?|exchange\s+(?:one\s+of\s+)?(?:your\s+)?(?:weapons?|items?|possessions?)\s+for)/i,
      // "may take it only if you (exchange|give|leave|trade)" — the
      // strict §307-style trade gate. Anchors on the imperative
      // conditional so it doesn't fire on permissive "you may take it"
      // pickups.
      /\bmay\s+take\s+(?:it|this|the\s+\w+)\s+only\s+if\s+you\s+(?:exchange|give|leave|trade|drop)/i,
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
        ev.type === 'script' || // script events can apply removal programmatically
        // Schema v1.25+ (Rule 40): choose_items with mode:"remove" is a
        // canonical loss-variant encoding; counts as a real disarmament event.
        // choose_items without explicit mode (defaults to "grant") does NOT
        // count — it's still a grant primitive.
        (ev.type === 'choose_items' && ev.mode === 'remove')
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

  // Orphan sections: no events, no choices, not flagged as an ending.
  // Dangling catalog entries: defined but never granted (possible missed pickup).
  // Rule 46 (schema v1.30+) — flag combat events that try to RESUME a
  // paused combat without any combat-pause site upstream. Partial
  // static analysis: walks every section's flattened events looking
  // for combat events with mode='resume', and walks the same events
  // looking for combat events carrying interrupt_after_player_wounds
  // or interrupt_after_enemy_wounds. If the resume set is non-empty
  // but the interrupt set is empty, every resume site is structurally
  // dead — there's no way state.activeCombat ever gets populated.
  // (We do NOT try to trace reachability from each individual interrupt
  // to each individual resume — a false positive on a complex flag-
  // chain or stat_test-driven detour is more annoying than a missed
  // diagnosis. The all-or-nothing check catches the common bug shape:
  // a parser emitted resume sites but forgot to emit any pause sites.)
  function checkRule46OrphanResumes(book) {
    const resumeSites = [];
    const interruptSites = [];
    for (const [id, section] of Object.entries(book.sections || {})) {
      for (const ev of flattenSectionEvents(section)) {
        if (!ev || ev.type !== 'combat') continue;
        if (ev.mode === 'resume') resumeSites.push(`§${id}`);
        if (ev.interrupt_after_player_wounds || ev.interrupt_after_enemy_wounds) {
          interruptSites.push(`§${id}`);
        }
      }
    }
    if (resumeSites.length === 0) return [];
    if (interruptSites.length === 0) {
      return [`Rule 46: ${resumeSites.length} combat event(s) carry mode:'resume' (${resumeSites.slice(0, 5).join(', ')}${resumeSites.length > 5 ? ', …' : ''}) but no combat event in the book carries an interrupt_after_player_wounds or interrupt_after_enemy_wounds — state.activeCombat is never populated, so every resume site falls back to start behavior`];
    }
    return [];
  }

  // Check G (Rule 49 catch-net): flag events whose freeform `note` field
  // contains imperative-mood mechanic verbs ("must drop", "also lose",
  // "in addition to", "may only take if", "must give up"). When a
  // sub-agent encodes a constraint in a `note` instead of as a structured
  // event, the note's body almost always uses one of these verbs. Catches
  // the §155 and §361 fingerprint regardless of the source-text dialect
  // or the specific rule the un-encoded constraint should have used. The
  // check is shape-agnostic — it walks every event in every section
  // (flattened across roll_dice/stat_test/choose_items sub-effects) and
  // matches the note body. Counts as a soft finding, not an error.
  function checkMechanicVerbsInNote(book) {
    const findings = [];
    // Phrases that indicate a `note` is restating a mechanic the events
    // array doesn't enforce. Tuned to be conservative — a `note` saying
    // "First word is 'Test' - confirmed from PDF" is parser commentary
    // and not a mechanic; the verbs below all describe player obligations
    // or stat/inventory deltas that should be in the events array.
    const verbs = [
      /\bmust\s+drop\b/i,
      /\bmust\s+(?:give\s+up|leave|exchange|trade|share)\b/i,
      /\balso\s+(?:lose|gain|deduct|reduce|restore)\b/i,
      /\bonly\s+(?:gain|get|receive|restore|lose|recover)\b/i,
      /\binstead\s+of\s+(?:the\s+)?(?:normal|usual|standard|\d+)\b/i,
      /\b(?:half|halve|halved|double|doubled)\s+(?:the\s+|your\s+)?(?:normal|usual)\b/i,
      /\bin\s+addition\s+to\b/i,
      /\bmay\s+(?:only|not)\s+(?:take|keep|use)\s+if\b/i,
      /\bcan\s+only\s+be\s+(?:taken|kept|used)\s+if\b/i,
      /\bif\s+you\s+take\s+(?:this|it)\s*[,;]?\s*(?:you\s+)?(?:must|will\s+have\s+to)\b/i,
      /\b(?:on|upon)\s+(?:success|failure)[,:;]?\s*(?:also|additionally)\s+(?:lose|gain|deduct)\b/i,
    ];
    for (const [secId, s] of Object.entries(book.sections || {})) {
      if (!s) continue;
      for (const ev of flattenSectionEvents(s)) {
        if (!ev || typeof ev.note !== 'string') continue;
        const note = ev.note;
        let matched = null;
        for (const re of verbs) {
          const m = note.match(re);
          if (m) { matched = m[0]; break; }
        }
        if (!matched) continue;
        findings.push(`§${secId} ${ev.type} event: note describes un-encoded mechanic ("${matched}") — full note: "${note.slice(0, 120)}${note.length > 120 ? '...' : ''}"`);
      }
    }
    return findings;
  }

  // Rule 49.1 (codex v2.47+). Notes that mention a declared stat name
  // alongside a digit AND a constraint-shaped word are highly suspicious:
  // the §131 idiom "only gain 2 STAMINA instead of 4" is the canonical
  // case. Tuned to be conservative: requires ALL THREE signals (stat name
  // + digit + constraint word) so benign parser commentary like
  // "First word 'STAMINA' confirmed from PDF" or "STAMINA cap is 24"
  // does NOT flag (former: no digit AND no constraint; latter: digit but
  // no constraint word). The user-noted insight: text containing a stat
  // name or a differently-cased rule-word ("Backpack", "Provisions",
  // "Equipment List") warrants extra parser attention because such
  // tokens almost always carry mechanical weight in the source.
  function checkStatNameInNote(book) {
    const findings = [];
    const declared = (book.rules?.stats || []).map(s => (s && s.name) ? s.name.toLowerCase() : null).filter(Boolean);
    // Common stat-name aliases across the engine's first-party books, in
    // case a book's `rules.stats[]` declares one spelling but the note
    // uses the source-text spelling (e.g. declared "endurance" vs note
    // "ENDURANCE points"). Conservative additions only.
    const aliases = ['stamina', 'skill', 'luck', 'endurance', 'combat_skill', 'combat skill', 'willpower', 'provisions', 'gold'];
    const statNames = new Set([...declared, ...aliases]);
    const digit = /\d/;
    // Constraint-shaped words: quantifiers and conditionals that almost
    // always co-occur with a mechanical effect (as distinct from pure
    // narrative or parser commentary).
    const constraint = /\b(?:only|just|must|may\s+only|can\s+only|instead\s+of|half|halve|halved|double|doubled|share|share\s+it|forfeit|forced\s+to)\b/i;
    for (const [secId, s] of Object.entries(book.sections || {})) {
      if (!s) continue;
      for (const ev of flattenSectionEvents(s)) {
        if (!ev || typeof ev.note !== 'string') continue;
        const note = ev.note;
        const nl = note.toLowerCase();
        const hitStat = [...statNames].find(name => nl.includes(name));
        if (!hitStat) continue;
        if (!digit.test(note)) continue;
        if (!constraint.test(note)) continue;
        findings.push(`§${secId} ${ev.type} event: note mentions stat "${hitStat.toUpperCase()}" with a numeric value and constraint phrasing — likely un-encoded mechanic. Full note: "${note.slice(0, 140)}${note.length > 140 ? '...' : ''}"`);
      }
    }
    return findings;
  }

  function checkStructural(book) {
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
    return { dangling, orphans };
  }

  // Run every soft (non-blocking) check and return a structured result. The
  // caller decides how to render it — validate-book.js prints to stdout, the
  // browser verifier renders into the Analysis-tool report.
  function collectSoftFindings(book) {
    const { dangling, orphans } = checkStructural(book);
    return {
      dangling,
      orphans,
      lossInChoiceText: checkLossInChoiceText(book),
      disarmamentWithoutEvent: checkDisarmamentWithoutEvent(book),
      enemyImmunities: checkEnemyImmunities(book),
      missingEatMeal: checkMissingEatMeal(book),
      categoryVsTextLanguage: checkCategoryVsTextLanguage(book),
      catalogEffectPromise: checkCatalogEffectPromise(book),
      rule46OrphanResumes: checkRule46OrphanResumes(book),
      mechanicVerbsInNote: checkMechanicVerbsInNote(book),
      statNameInNote: checkStatNameInNote(book),
    };
  }

  // ==================== SCRIPT-EXECUTION GATE (BLOCKING) ====================
  //
  // `script_code` is an opaque string to the JSON Schema: a sandbox-API misuse
  // (treating roll()'s return table as a number, a bare `navigate_to` global
  // instead of `player.navigate_to`, writing `game_state.X` instead of
  // `player.stats_changed`) is fully schema-valid and crashes only at runtime.
  // This gate executes every section-level `script` event in the canonical Lua
  // sandbox and fails on any crash.
  //
  // The forced-roll sweep (each die face 0-9, plus one random run) exercises a
  // script's branches well enough to catch crashes on the common paths. It is
  // NOT a substitute for the deliberate per-branch testing the codex mandates
  // (Section 7.6) — it is a safety net for the §21-class "crashes on any input"
  // bug that ships when the parser never ran the code it generated.

  function buildScriptContext(book) {
    const stats = {};
    for (const s of (book.rules && book.rules.stats) || []) {
      if (s && s.name) stats[s.name] = 20;
    }
    return {
      player: { health: 20, name: 'You' },
      enemy: { attack: 0, health: 0, name: '' },
      combat: { round: 0 },
      game_state: { ...stats, provisions: 5, gold: 20, meals: 5 },
      initial_stats: { ...stats },
      inventory: [],
      flags: [],
      items_catalog: book.items_catalog || {},
    };
  }

  // runScript MUST be the canonical runtime from cli-emulator/script-runtime.js.
  // It is passed in (rather than imported) so this module loads in the browser
  // without a hard dependency on the module system.
  function checkScriptExecution(book, runScript) {
    if (typeof runScript !== 'function') {
      return { failures: [], skipped: 'script runtime (runScript) was not provided' };
    }
    const failures = [];
    for (const [id, section] of Object.entries(book.sections || {})) {
      for (const ev of flattenSectionEvents(section)) {
        if (!ev || ev.type !== 'script') continue;
        const code = typeof ev.script_code === 'string' ? ev.script_code : '';
        if (!code.trim()) {
          failures.push(`§${id}: script event has empty or missing script_code`);
          continue;
        }
        const sweep = [];
        for (let v = 0; v <= 9; v++) sweep.push(v);
        sweep.push(null); // one run with un-forced (random) rolls
        let firstError = null;
        for (const v of sweep) {
          const forced = v === null ? [] : Array.from({ length: 12 }, () => [v, v, v]);
          let result;
          try {
            result = runScript(code, buildScriptContext(book), forced, null);
          } catch (e) {
            firstError = `threw ${(e && e.message) || e}`;
            break;
          }
          if (result && result.error) {
            firstError = `${result.error}${v === null ? '' : ` (rolls forced to ${v})`}`;
            break;
          }
        }
        if (firstError) failures.push(`§${id}: script_code crashed in the Lua sandbox — ${firstError}`);
      }
    }
    return { failures, skipped: null };
  }

  return {
    flattenSectionEvents,
    collectGrantedItemIds,
    checkLossInChoiceText,
    checkDisarmamentWithoutEvent,
    enemyImmunityRegistry,
    checkEnemyImmunities,
    checkMissingEatMeal,
    checkCategoryVsTextLanguage,
    checkCatalogEffectPromise,
    checkRule46OrphanResumes,
    checkStructural,
    collectSoftFindings,
    buildScriptContext,
    checkScriptExecution,
  };
}));
