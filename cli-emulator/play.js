#!/usr/bin/env node
/**
 * Grimoire: The Universal Gamebook Engine — CLI Emulator
 *
 * The authoritative emulator version is the `CODEX_EMULATOR_VERSION`
 * constant below. The codex doc's "Version identifiers" section names
 * the version of this file the rest of the toolchain currently ships
 * with; the "CODEX VERSION AND COMPATIBILITY" table near the top of
 * the codex doc names the minimums the parser AI requires.
 *
 * Stateless command-line emulator for GBF game data files.
 * Each invocation takes a state JSON + an action and outputs a new state.
 *
 * Usage:
 *   node play.js init <book.json>                    # Output initial state (no character)
 *   node play.js act <state.json> <action> [args...] # Apply an action, print new state
 *   node play.js dry <state.json> <action> [args...] # Dry run — show what would happen, don't commit
 *   node play.js state <state.json>                  # Just print the current state's summary
 *
 * The state JSON includes a reference to the book file path so it can be
 * reloaded between calls. State is compact — only deltas from the book.
 *
 * Output:
 *   stdout: JSON envelope with { state, summary, available_actions, logs, error }
 *   stderr: human-readable summary (when run with --verbose)
 */

'use strict';

const CODEX_EMULATOR_VERSION = '3.28.0';
// Short SHA of the git commit this emulator binary was built on top of.
// Updated via `scripts/stamp-emulator-commit.sh` before making a
// commit that touches the emulator. Displayed in the HTML emulator's
// header (index.html) and available as a constant here for CLI-side
// introspection. Semantically: "this emulator binary was built on top
// of commit X" — the stamp is the parent of the commit that sets it,
// so a downstream user can see exactly which known-good release their
// binary was built on top of.
const CODEX_EMULATOR_COMMIT = '9e39253';
const fs = require('fs');
const path = require('path');
// The Lua sandbox — runScript, rollDice, and the roll()/log()/lookup()/
// get_clock() bridge — lives in the shared script-runtime module so the CLI
// emulator, the validate-book.js script-execution gate, and the browser
// verifier all execute scripts against an identical runtime. Do not
// reimplement these here; see cli-emulator/script-runtime.js.
const { runScript, rollDice } = require('./script-runtime.js');

// ==================== UTILITIES ====================

function loadJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

// ==================== GAME STATE ====================

/**
 * Compact state shape:
 * {
 *   bookPath: "books/foo.json",
 *   stats: { ... },
 *   initialStats: { ... },
 *   inventory: [ ... ],
 *   flags: [ ... ],
 *   provisions: 0,
 *   gold: 0,
 *   meals: 0,
 *   abilities: [ ... ],
 *   potion: { name, doses } | null,
 *   currentSection: "1",
 *   visitedSections: [ ... ],
 *   pause: { type, ... },         // What is the emulator waiting for?
 *   eventQueue: [ ... ],          // Pending events not yet processed
 *   combat: { ... } | null,       // Active combat state
 *   pendingChoices: [ ... ],      // Choices to show after events resolved
 *   lastRoll: null,               // Last dice roll result (for re-roll items)
 *   lastTestResult: null,         // For test_failed / test_succeeded conditions
 *   creationStep: 0,              // Index into character_creation.steps
 *   creationDone: false,
 *   frontmatterPage: 0,
 *   frontmatterDone: false,
 *   log: [ ... ],                 // Recent events for the player to see
 * }
 */

function initialState(bookPath) {
  return {
    bookPath,
    stats: {},
    initialStats: {},
    inventory: [],
    // Equipment map: {slot_name -> item_id}. Populated by auto_equip on
    // add_item when the item is equippable, and by explicit equip/unequip
    // actions from the player. A slot holds exactly one item; equipping
    // to an occupied slot displaces the previous occupant (the displaced
    // item stays in inventory, it's just no longer equipped). Schema v1.5+.
    equipment: {},
    flags: [],
    // Schema v1.26+ (Rule 42). Buffered one-shot combat modifiers waiting
    // to be consumed on the next combat-enter. Pushed by the
    // `queue_combat_modifier` effect (typically fired from a triggered_effect
    // on a consumable). Drained into the effective combat_modifier set at
    // startCombat time, frozen for the fight's duration per Rule 17, and
    // implicitly cleared when combat ends (the per-combat modifier set is
    // discarded; the pending buffer is also reset). Empty buffer means
    // "no queued buffs."
    pendingCombatModifiers: [],
    provisions: 0,
    gold: 0,
    meals: 0,
    abilities: [],
    // Schema v1.18+. List of talent names confirmed via the
    // choose_talents chargen step. Parallel to `abilities`. Empty when
    // the book carries no `rules.talents` block or hasn't reached the
    // step yet. Populated in canonical book-text capitalization (e.g.
    // ['Strong Back', 'Heroic Confidence']); the has_talent condition
    // canonicalises whitespace + case at lookup time.
    talents: [],
    // Per-ability remaining-uses counters, populated by set_ability_uses
    // character creation steps and by book scripts. Keyed by ability name.
    // Empty by default; absent when no ability needs use tracking.
    abilityUses: {},
    potion: null,
    currentSection: null,
    previousSection: null,
    visitedSections: [],
    // Stack of caller section ids pushed when the player navigates INTO a
    // section with `is_subroutine_entry: true`. Popped by the runtime when
    // a `return_to_caller` event fires in the reference (auto-return)
    // implementation. Empty by default. See codex section 7.6.8.
    returnStack: [],
    // Tier 3 partial-run tracking (Rule 16 / codex v2.9.0). Every
    // `manual_set` debug-escape-hatch invocation appends a record here
    // so the run summary can report `tier3_status: "PARTIAL"` to the
    // playbook harness. If the array stays empty the run is
    // `tier3_status: "CLEAN"`. Sub-agents running Tier 3 comprehensive
    // reviews MUST NOT rely on `manual_set` to paper over missing
    // character-creation steps or missing schema mechanisms; the
    // reporting here is designed to make such workarounds loud, not to
    // whitewash them. See DEV_PROCESS.md failure mode 4
    // ("workaround-as-success reporting").
    manualSets: [],
    // Book-shape + post-creation validation warnings (schema v1.10+ /
    // emulators v3.5+, Windhammer Bug C). Populated once per session by
    // validateBookShape at character-creation start and by
    // validatePostCreation after creation steps complete. Rendered as a
    // visible banner at the top of the status output so silent-broken
    // books fail loud rather than quiet. See codex Rule 26.
    validationWarnings: [],
    validationDone: false,
    pause: { type: 'frontmatter' },
    eventQueue: [],
    combat: null,
    pendingChoices: [],
    lastRoll: null,
    lastTestResult: null,
    creationStep: 0,
    creationDone: false,
    frontmatterPage: 0,
    frontmatterDone: false,
    log: [],
    // Queue of forced rolls for upcoming `script` events. Each element is an
    // array of numbers (one set per expected roll() call in the script). The
    // queue is FIFO: the next script event consumes and clears it.
    forcedScriptRolls: [],
    // Forced wall-clock value for scripts that call get_clock() (time-of-day
    // mechanics). When set, get_clock() returns this instead of real Date.
    // Shape: {wday: 1..7 (1=Sun), hour: 0..23, minute: 0..59}. Null means
    // use the real clock.
    forcedClock: null,
    // Rule 36 v2.28.0 / schema v1.21+. Per-section bookkeeping recorded
    // at every navigateTo (after currentSection updates) and consulted
    // by on_section_exit triggered_effects via the
    // section_had_no_endurance_loss / section_had_no_combat conditions.
    // Shape: {<healthStat>: <int>, hadCombat: <bool>} once populated,
    // null before the first navigation. The healthStat key is dynamic
    // (resolved via book.rules.health_stat at snapshot time) so the
    // structure is series-neutral.
    sectionEntrySnapshot: null,
    // Schema v1.23+ / codex v2.30 (Rule 38). Round number the most recent
    // combat ended on (1-based). Set at every on_combat_end dispatch path
    // (win, lose-by-survive-N-rounds, all-enemies-defeated, player-flee,
    // R36-triggered flee_combat, and the new end_after_rounds auto-end
    // path) BEFORE the lifecycle trigger fires, so combat_round_count_lte
    // and combat_round_count_gte conditions on post-combat choices /
    // events evaluate against the round the fight actually ended on.
    // Null = no combat has resolved yet; the two condition primitives
    // return false on null (safe default — stale conditions reached
    // without a prior combat do not fire spuriously).
    lastCombatRoundCount: null,
    // Schema v1.30+ / codex v2.42 (Rule 46). Pausable / resumable combat
    // as active state. Null when no combat is paused. When an
    // interrupt_after_player_wounds or interrupt_after_enemy_wounds fires,
    // the engine snapshots the in-progress combat here (enemy_ref +
    // enemy_snapshot + currentHealth + frozen modifiers + wound + round
    // counters) and navigates to the interrupt's target. The active
    // snapshot persists across section visits until a downstream combat
    // event with `mode: "resume"` continues the fight at the preserved
    // STAMINA, or `mode: "start"` (default) clears + replaces it, or
    // `mode: "modify"` adjusts the snapshot in place (wandering-monster
    // pattern). Round-tripped through compactState so save/load survives
    // a paused combat. See Rule 46.
    activeCombat: null,
  };
}

function loadBook(state) {
  return loadJSON(state.bookPath);
}

// ==================== CONDITION EVALUATION ====================

function evalCondition(cond, state, book) {
  if (!cond) return true;
  switch (cond.type) {
    case 'has_item': return state.inventory.includes(cond.item);
    case 'has_flag': return state.flags.includes(cond.flag);
    case 'stat_gte': {
      const v = cond.stat === 'provisions' ? state.provisions : cond.stat === 'gold' ? state.gold : (state.stats[cond.stat] || 0);
      return v >= cond.value;
    }
    case 'stat_lte': {
      const v = cond.stat === 'provisions' ? state.provisions : cond.stat === 'gold' ? state.gold : (state.stats[cond.stat] || 0);
      return v <= cond.value;
    }
    case 'has_ability':
      return (state.abilities || []).some(a => a.toLowerCase().replace(/ /g, '_') === cond.ability.toLowerCase().replace(/ /g, '_'));
    case 'has_talent':
      // Schema v1.18+. Parallel to has_ability; reads state.talents (the
      // names confirmed by a `choose_talents` chargen step). Same
      // case-insensitive whitespace-to-underscore canonicalisation as
      // has_ability so books that capitalize talent names differently in
      // condition references don't drift.
      return (state.talents || []).some(t => t.toLowerCase().replace(/ /g, '_') === cond.talent.toLowerCase().replace(/ /g, '_'));
    case 'not': return !evalCondition(cond.condition, state, book);
    case 'and': return (cond.conditions || []).every(c => evalCondition(c, state, book));
    case 'or': return (cond.conditions || []).some(c => evalCondition(c, state, book));
    case 'test_failed': return state.lastTestResult === false;
    case 'test_succeeded': return state.lastTestResult === true;
    // Schema v1.5+ equipment-aware conditions. Each evaluates the player's
    // current equipment map (state.equipment: {slot → item_id}) against
    // the condition parameters. If state.equipment is undefined (pre-v1.5
    // state carried over from older save formats), treat it as empty.
    case 'has_equipped_item': {
      const eq = state.equipment || {};
      return Object.values(eq).some(id => id === cond.item);
    }
    case 'has_equipped_in_slot': {
      const eq = state.equipment || {};
      const occupant = eq[cond.slot];
      if (!occupant) return false;
      if (cond.item) return occupant === cond.item;
      return true;  // slot is occupied by anything
    }
    case 'has_equipped_with_property': {
      const eq = state.equipment || {};
      const catalog = (book && book.items_catalog) || {};
      for (const itemId of Object.values(eq)) {
        if (!itemId) continue;
        const item = catalog[itemId];
        if (!item) continue;
        const props = Array.isArray(item.properties) ? item.properties : [];
        if (props.includes(cond.property)) return true;
      }
      return false;
    }
    case 'is_equipped': {
      // Schema v1.20+ (Rule 36). Canonical condition for gating Rule 36
      // triggered_effects on equipment-slot occupancy. Same state check as
      // has_equipped_item; the distinct condition type is preserved for
      // parser intent (and so schema validators can reject is_equipped on
      // abilities / talents where it has no meaning).
      const eq = state.equipment || {};
      return Object.values(eq).some(id => id === cond.item);
    }
    case 'section_had_no_endurance_loss': {
      // Schema v1.21+ (Rule 36 v2.28.0 extension). Compares the current
      // primary-health stat (resolved via book.rules.health_stat) against
      // the snapshot taken at the most recent section-enter (stored on
      // state.sectionEntrySnapshot). True iff current value is at or
      // above the snapshot. If snapshot is missing (defensive default,
      // pre-any-navigation evaluation), return true. Used by
      // on_section_exit triggers to gate per-section regen mechanics on
      // "did the player avoid losing health this section."
      const healthStat = book?.rules?.health_stat || null;
      if (!healthStat) return true;
      const snap = state.sectionEntrySnapshot;
      if (!snap || snap[healthStat] === undefined) return true;
      const current = state.stats[healthStat];
      if (current === undefined) return true;
      return current >= snap[healthStat];
    }
    case 'section_had_no_combat': {
      // Schema v1.21+ (Rule 36 v2.28.0 extension). True iff no combat
      // event has resolved in the current section. The hadCombat flag
      // on the per-section snapshot is set inside the on_combat_end
      // lifecycle dispatch (covering win, lose, and flee paths) before
      // the on_section_exit trigger fires, so by the time an
      // on_section_exit condition evaluates this predicate, the flag
      // reflects the section's full combat history. If snapshot is
      // missing (defensive default), return true.
      const snap = state.sectionEntrySnapshot;
      if (!snap) return true;
      return !snap.hadCombat;
    }
    case 'combat_round_count_lte': {
      // Schema v1.23+ / codex v2.30 (Rule 38). True iff
      // state.lastCombatRoundCount <= cond.value. Defaults to false
      // when no combat has resolved yet (lastCombatRoundCount === null)
      // — the safe default for a stale condition reached without a
      // prior combat is non-firing, not phantom-firing.
      if (state.lastCombatRoundCount === null || state.lastCombatRoundCount === undefined) return false;
      return state.lastCombatRoundCount <= cond.value;
    }
    case 'combat_round_count_gte': {
      // Schema v1.23+ / codex v2.30 (Rule 38). True iff
      // state.lastCombatRoundCount >= cond.value. Same null-safe
      // default as combat_round_count_lte.
      if (state.lastCombatRoundCount === null || state.lastCombatRoundCount === undefined) return false;
      return state.lastCombatRoundCount >= cond.value;
    }
    default: return true;
  }
}

function describeCondition(cond) {
  if (!cond) return '';
  switch (cond.type) {
    case 'has_item': return `has item: ${cond.item}`;
    case 'has_flag': return `has flag: ${cond.flag}`;
    case 'stat_gte': return `${cond.stat} >= ${cond.value}`;
    case 'stat_lte': return `${cond.stat} <= ${cond.value}`;
    case 'has_ability': return `has ability: ${cond.ability}`;
    case 'has_talent': return `has talent: ${cond.talent}`;
    case 'not': return `NOT (${describeCondition(cond.condition)})`;
    case 'and': return (cond.conditions || []).map(describeCondition).join(' AND ');
    case 'or': return (cond.conditions || []).map(describeCondition).join(' OR ');
    case 'test_failed': return 'test failed';
    case 'test_succeeded': return 'test succeeded';
    case 'has_equipped_item': return `has equipped: ${cond.item}`;
    case 'has_equipped_in_slot': return cond.item ? `${cond.slot} slot has ${cond.item}` : `${cond.slot} slot occupied`;
    case 'has_equipped_with_property': return `equipped item has property: ${cond.property}`;
    case 'is_equipped': return `is equipped: ${cond.item}`;
    case 'section_had_no_endurance_loss': return 'section had no endurance loss';
    case 'section_had_no_combat': return 'section had no combat';
    case 'combat_round_count_lte': return `last combat lasted <= ${cond.value} rounds`;
    case 'combat_round_count_gte': return `last combat lasted >= ${cond.value} rounds`;
    default: return cond.type;
  }
}

// ==================== TRIGGERED EFFECTS (Rule 36, schema v1.20+) ====================
//
// Run-time triggered effects fire on lifecycle events (per combat round, on
// section enter, on user use, etc.) and live on four placements:
//   - items_catalog[id].triggered_effects[]
//   - enemies_catalog[id].triggered_effects[]
//   - rules.abilities.available[].triggered_effects[]
//   - rules.talents.available[].triggered_effects[]
//
// Each entry: { trigger, context?, condition?, gate_roll?, effect, consume_on_fire?, reason? }
//
// Pipeline ordering (per Q4 design closure, Chat #33):
//   Rule 17 combat_modifiers (frozen, applied to round_script INPUTS)
//     → Rule 18 damage_interactions (per-component multiplicative)
//       → Rule 32 frozen damage_caps (post-interaction total bound)
//         → Rule 36 damage_delta (additive shift on per-direction total)
//           → Rule 36 damage_multiplier (× on per-direction total)
//             → Rule 36 damage_set (replaces per-direction total)
//               → Rule 36 damage_cap (tightest-cap-wins, extends Rule 32 v1.15 semantic)
//                 → apply to state.

// Parse a gate_roll.applies_on expression ("6", "1-2", "1-5") against a
// rolled total. Returns true on match, false otherwise. Same syntax as
// roll_dice.results keys.
function matchAppliesOn(rolled, applies_on) {
  if (typeof applies_on !== 'string') return false;
  const trimmed = applies_on.trim();
  if (/^-?\d+$/.test(trimmed)) return rolled === parseInt(trimmed, 10);
  const m = trimmed.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (m) return rolled >= parseInt(m[1], 10) && rolled <= parseInt(m[2], 10);
  return false;
}

// Evaluate a triggered_effect.gate_roll. Rolls the dice expression and tests
// the rolled total against applies_on. Forced-rolls queue (state.forcedRolls)
// is consumed when present for deterministic replay / test fixtures, mirroring
// the existing roll_dice UX.
function evalGateRoll(gateRoll, state) {
  if (!gateRoll) return { fired: true, rolled: null };
  const { dice, applies_on } = gateRoll;
  if (!dice || !applies_on) return { fired: false, rolled: null };
  const forced = Array.isArray(state.forcedRolls) ? state.forcedRolls : undefined;
  const result = rollDice(dice, forced);
  if (forced && forced.length > 0) {
    // rollDice consumed from the front when forced was supplied — but rollDice
    // currently reads forcedRolls without shifting. The existing pattern in
    // run_dice handlers shifts off the queue manually. Mirror that:
    forced.splice(0, result.rolls.length);
  }
  return { fired: matchAppliesOn(result.total, applies_on), rolled: result.total };
}

// Resolve a modify_stat-style amount field that may be either a numeric
// value (legacy form) or a dice-amount object {kind: 'dice', expression, sign}
// (Schema v1.20+). Returns the integer amount; logs the roll when dice.
function resolveAmount(amount, state, label) {
  if (typeof amount === 'number') return amount;
  if (amount && typeof amount === 'object' && amount.kind === 'dice') {
    const forced = Array.isArray(state.forcedRolls) ? state.forcedRolls : undefined;
    const r = rollDice(amount.expression, forced);
    if (forced && forced.length > 0) forced.splice(0, r.rolls.length);
    const signed = amount.sign === 'negative' ? -r.total : r.total;
    if (state && Array.isArray(state.log)) {
      state.log.push(`Dice amount${label ? ' (' + label + ')' : ''}: ${amount.expression} → ${r.total}${amount.sign === 'negative' ? ' (negated)' : ''}`);
    }
    return signed;
  }
  return 0;
}

// Collect every Rule 36 triggered_effect entry currently in scope for the
// given trigger, walking all four placements. Each returned entry is tagged
// with its source for consume_on_fire bookkeeping and the playthrough log.
// `combat` is optional; when present, enemies_catalog entries for the active
// combat's enemies contribute.
function collectTriggeredEffects(state, book, trigger, combat) {
  const out = [];
  const itemsCat = (book && book.items_catalog) || {};
  for (const itemId of (state.inventory || [])) {
    const def = itemsCat[itemId];
    if (!def || !Array.isArray(def.triggered_effects)) continue;
    for (const te of def.triggered_effects) {
      if (!te || !te.trigger) continue;
      if (te.trigger === trigger) {
        out.push({ source: 'item', itemId, entry: te });
      } else if (te.trigger === 'while_equipped' && trigger === 'on_combat_round') {
        // while_equipped fires at the on_combat_round lifecycle moment IF
        // the carrying item currently occupies its slot. Equivalent to
        // (on_combat_round + implicit is_equipped condition). Implemented
        // as sugar so the candidate doc's two-trigger split stays clean.
        if (isItemEquipped(state, itemId)) {
          out.push({ source: 'item', itemId, entry: te, _whileEquipped: true });
        }
      }
    }
  }
  const abilities = (book?.rules?.abilities?.available) || [];
  for (const ab of abilities) {
    if (!Array.isArray(ab.triggered_effects)) continue;
    const owned = (state.abilities || []).some(a => a.toLowerCase().replace(/ /g, '_') === ab.name.toLowerCase().replace(/ /g, '_'));
    if (!owned) continue;
    for (const te of ab.triggered_effects) {
      if (te && te.trigger === trigger) out.push({ source: 'ability', name: ab.name, entry: te });
    }
  }
  const talents = (book?.rules?.talents?.available) || [];
  for (const tal of talents) {
    if (!Array.isArray(tal.triggered_effects)) continue;
    const owned = (state.talents || []).some(t => t.toLowerCase().replace(/ /g, '_') === tal.name.toLowerCase().replace(/ /g, '_'));
    if (!owned) continue;
    for (const te of tal.triggered_effects) {
      if (te && te.trigger === trigger) out.push({ source: 'talent', name: tal.name, entry: te });
    }
  }
  if (combat) {
    const enemiesCat = (book && book.enemies_catalog) || {};
    for (const ref of (combat.enemyRefs || [])) {
      const def = enemiesCat[ref];
      if (!def || !Array.isArray(def.triggered_effects)) continue;
      for (const te of def.triggered_effects) {
        if (te && te.trigger === trigger) out.push({ source: 'enemy', ref, entry: te });
      }
    }
  }
  return out;
}

// Resolve a damage_set.value field: integer literal OR symbolic expression
// (currently 'enemy.max_health'). Future expressions may be added.
function resolveDamageSetValue(value, ctx) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value === 'enemy.max_health') return ctx.enemyMaxHealth || 0;
    return 0;
  }
  return 0;
}

// Apply a single passing Rule 36 effect to a per-round damage flow context.
// Returns true if the effect was a damage-flow op; false if a non-damage
// effect (caller dispatches non-damage ops via the standard event handler).
function applyDamageFlowEffect(effect, ctx, source) {
  const dir = effect.direction;
  if (!dir) return false;
  const key = dir === 'incoming' ? 'enemyTotal' : 'playerTotal';
  switch (effect.type) {
    case 'damage_delta': {
      const delta = typeof effect.delta === 'number' ? effect.delta : 0;
      ctx[key] = ctx[key] + delta;
      ctx.log.push(`R36 damage_delta (${source}): ${dir} ${delta >= 0 ? '+' : ''}${delta} → ${ctx[key]}`);
      return true;
    }
    case 'damage_multiplier': {
      const m = typeof effect.multiplier === 'number' ? effect.multiplier : 1;
      const before = ctx[key];
      ctx[key] = before * m;
      ctx.log.push(`R36 damage_multiplier (${source}): ${dir} ${before} × ${m} → ${ctx[key]}`);
      return true;
    }
    case 'damage_set': {
      const before = ctx[key];
      ctx[key] = resolveDamageSetValue(effect.value, ctx);
      ctx.log.push(`R36 damage_set (${source}): ${dir} ${before} → ${ctx[key]}`);
      return true;
    }
    case 'damage_cap': {
      const cap = typeof effect.max === 'number' ? effect.max : Infinity;
      if (ctx[key] > cap) {
        ctx.log.push(`R36 damage_cap (${source}): ${dir} ${ctx[key]} → ${cap}`);
        ctx[key] = cap;
      }
      return true;
    }
    default: return false;
  }
}

// Top-level: dispatch all on_combat_round Rule 36 effects against a per-round
// damage flow. Mutates ctx.{playerTotal, enemyTotal, log} and ctx.consume[]
// (item ids to remove_item one copy of after the round resolves).
function dispatchCombatRoundTriggers(state, book, ctx) {
  const entries = collectTriggeredEffects(state, book, 'on_combat_round', state.combat);
  // Two-pass: first apply delta/multiplier/set (shift/scale/replace), THEN apply
  // damage_cap (tightest-cap-wins). Within each pass, iterate in collection
  // order so item-then-ability-then-talent-then-enemy is the canonical order.
  const SHIFT_OPS = new Set(['damage_delta', 'damage_multiplier', 'damage_set']);
  const passes = [
    e => SHIFT_OPS.has(e.entry.effect?.type),
    e => e.entry.effect?.type === 'damage_cap',
  ];
  const fired = [];
  for (const pass of passes) {
    for (const e of entries.filter(pass)) {
      const te = e.entry;
      if (te.condition && !evalCondition(te.condition, state, book)) continue;
      const gr = evalGateRoll(te.gate_roll, state);
      if (!gr.fired) {
        if (te.gate_roll) ctx.log.push(`R36 gate_roll skip (${describeSource(e)}): rolled ${gr.rolled} not in ${te.gate_roll.applies_on}`);
        continue;
      }
      if (te.gate_roll) ctx.log.push(`R36 gate_roll fire (${describeSource(e)}): rolled ${gr.rolled} in ${te.gate_roll.applies_on}`);
      applyDamageFlowEffect(te.effect, ctx, describeSource(e));
      fired.push(e);
    }
  }
  // Non-damage-flow effects (modify_stat, set_flag, etc.) — these dispatch as
  // standard events. We collect them so the caller can run them after the
  // damage-flow numerics settle.
  ctx.nonDamageQueue = [];
  for (const e of entries) {
    const te = e.entry;
    if (!te.effect) continue;
    if (SHIFT_OPS.has(te.effect.type) || te.effect.type === 'damage_cap' || te.effect.type === 'flee_combat') continue;
    if (te.condition && !evalCondition(te.condition, state, book)) continue;
    const gr = evalGateRoll(te.gate_roll, state);
    if (!gr.fired) continue;
    ctx.nonDamageQueue.push({ source: e, effect: te.effect });
    fired.push(e);
  }
  // consume_on_fire bookkeeping.
  for (const e of fired) {
    if (e.source === 'item' && e.entry.consume_on_fire) ctx.consume.push(e.itemId);
  }
  return ctx;
}

function describeSource(e) {
  if (e.source === 'item') return `item:${e.itemId}${e._whileEquipped ? ' (while_equipped)' : ''}`;
  if (e.source === 'enemy') return `enemy:${e.ref}`;
  if (e.source === 'ability') return `ability:${e.name}`;
  if (e.source === 'talent') return `talent:${e.name}`;
  return e.source || '?';
}

// Dispatch a single non-damage-flow effect (modify_stat / set_flag / etc.)
// through the standard event handler, after rolling any dice-amount.
function dispatchTriggeredEvent(effect, state, book, sourceDesc) {
  if (!effect || !effect.type) return;
  const evt = JSON.parse(JSON.stringify(effect));
  if (evt.type === 'modify_stat' && evt.amount !== undefined && typeof evt.amount !== 'number') {
    evt.amount = resolveAmount(evt.amount, state, sourceDesc);
  }
  if (state.log) state.log.push(`R36 event (${sourceDesc}): ${evt.type}${evt.stat ? ' ' + evt.stat : ''}${typeof evt.amount === 'number' ? ' ' + (evt.amount >= 0 ? '+' : '') + evt.amount : ''}`);
  handleEvent(evt, state, book);
}

// Dispatch lifecycle triggers that DON'T touch the per-round damage flow
// (on_section_enter, on_section_exit, on_combat_start, on_combat_end,
// on_eat_meal, on_user_use). Returns { fledTo: <sectionId | null> } so
// callers can act on a flee_combat effect (only meaningful when combat
// is active).
function dispatchLifecycleTriggers(state, book, trigger, options) {
  options = options || {};
  const combat = state.combat;
  const entries = collectTriggeredEffects(state, book, trigger, options.combatScope ? combat : null);
  const consume = [];
  let fledTo = null;
  for (const e of entries) {
    const te = e.entry;
    if (te.condition && !evalCondition(te.condition, state, book)) continue;
    // context filter for on_user_use; ignored for other triggers
    if (trigger === 'on_user_use' && te.context && te.context !== 'anywhere') {
      const inCombat = !!combat;
      if (te.context === 'in_combat' && !inCombat) continue;
      if (te.context === 'in_section' && inCombat) continue;
    }
    const gr = evalGateRoll(te.gate_roll, state);
    if (!gr.fired) {
      if (te.gate_roll && state.log) state.log.push(`R36 gate_roll skip (${describeSource(e)}): rolled ${gr.rolled} not in ${te.gate_roll.applies_on}`);
      continue;
    }
    if (te.gate_roll && state.log) state.log.push(`R36 gate_roll fire (${describeSource(e)}): rolled ${gr.rolled} in ${te.gate_roll.applies_on}`);
    const eff = te.effect;
    if (!eff) continue;
    if (eff.type === 'flee_combat') {
      if (!combat) {
        state.log.push(`R36 flee_combat (${describeSource(e)}): no active combat; skipping`);
      } else {
        fledTo = eff.target_section;
        state.log.push(`R36 flee_combat (${describeSource(e)}): fleeing to §${eff.target_section}`);
      }
    } else if (['damage_delta', 'damage_multiplier', 'damage_set', 'damage_cap'].includes(eff.type)) {
      // damage-flow effects only meaningful on on_combat_round; warn elsewhere
      state.log.push(`R36 ${eff.type} (${describeSource(e)}): damage-flow effects only fire on on_combat_round trigger; skipping`);
    } else {
      dispatchTriggeredEvent(eff, state, book, describeSource(e));
    }
    if (e.source === 'item' && te.consume_on_fire) consume.push(e.itemId);
  }
  // Apply consume_on_fire removals (Rule 39 v1.24+: splice one copy, not
  // filter all — stackable items keep their remaining copies).
  for (const itemId of consume) {
    const idx = state.inventory.indexOf(itemId);
    if (idx >= 0) state.inventory.splice(idx, 1);
    if (state.equipment && !state.inventory.includes(itemId)) {
      for (const slot of Object.keys(state.equipment)) {
        if (state.equipment[slot] === itemId) delete state.equipment[slot];
      }
    }
    state.log.push(`R36 consume_on_fire: removed ${itemId}`);
  }
  return { fledTo };
}

// ==================== ACTION HANDLERS ====================

function getCombatStats(book) {
  return {
    attackStat: book.rules?.attack_stat || null,
    healthStat: book.rules?.health_stat || null,
  };
}

function getPlayerHealth(state, book) {
  const { healthStat } = getCombatStats(book);
  return healthStat ? (state.stats[healthStat] || 0) : 0;
}

function setPlayerHealth(state, book, val) {
  const { healthStat } = getCombatStats(book);
  if (healthStat) state.stats[healthStat] = val;
}

// ==================== EQUIPMENT HELPERS (schema v1.5+) ====================

// Return the items_catalog entry for the given item_id, or null.
function getItemDef(book, itemId) {
  const catalog = (book && book.items_catalog) || {};
  return catalog[itemId] || null;
}

// Is the given item currently equipped in any slot?
function isItemEquipped(state, itemId) {
  const eq = state.equipment || {};
  return Object.values(eq).some(id => id === itemId);
}

// Can this item be equipped right now given current state (combat active,
// equip_timing constraints)? Returns {ok: boolean, reason: string}.
//
// `isAutoEquip` is true when the check is being made on behalf of an
// add_item auto-equip (not a player action). Auto-equip bypasses the
// combat-active check because the narrative moment of acquisition is
// considered "not yet in combat" for timing purposes, even if a combat
// event happens to be running.
function canEquipItem(state, book, itemId, isAutoEquip) {
  const item = getItemDef(book, itemId);
  if (!item) return { ok: false, reason: `no item definition for ${itemId}` };
  if (!item.equippable) return { ok: false, reason: `${itemId} is not equippable` };
  if (!item.slot) return { ok: false, reason: `${itemId} has no slot declared` };
  const timing = item.equip_timing || 'out_of_combat';
  if (timing === 'once' && isItemEquipped(state, itemId)) {
    return { ok: false, reason: `${itemId} has equip_timing: once and is already equipped` };
  }
  if (isAutoEquip) return { ok: true, reason: '' };
  if (timing === 'out_of_combat' && state.combat) {
    return { ok: false, reason: `${itemId} cannot be equipped during combat (equip_timing: out_of_combat)` };
  }
  return { ok: true, reason: '' };
}

// Can this item be unequipped right now?
function canUnequipItem(state, book, itemId) {
  const item = getItemDef(book, itemId);
  if (!item) return { ok: false, reason: `no item definition for ${itemId}` };
  const timing = item.equip_timing || 'out_of_combat';
  if (timing === 'once') {
    return { ok: false, reason: `${itemId} has equip_timing: once and cannot be unequipped` };
  }
  if (timing === 'out_of_combat' && state.combat) {
    return { ok: false, reason: `${itemId} cannot be unequipped during combat (equip_timing: out_of_combat)` };
  }
  return { ok: true, reason: '' };
}

// Equip itemId into its declared slot. Displaces any previous occupant
// (which stays in inventory but is no longer equipped). Assumes caller
// has already validated the operation via canEquipItem.
function equipItem(state, book, itemId) {
  const item = getItemDef(book, itemId);
  if (!item || !item.slot) return;
  if (!state.equipment) state.equipment = {};
  const prev = state.equipment[item.slot];
  state.equipment[item.slot] = itemId;
  if (prev && prev !== itemId) {
    state.log.push(`Equipped ${itemId} in slot ${item.slot} (displaced ${prev})`);
  } else if (!prev) {
    state.log.push(`Equipped ${itemId} in slot ${item.slot}`);
  }
}

// Unequip the item currently in the given slot, if any. The item stays
// in inventory; only the equipped pointer is cleared.
function unequipSlot(state, book, slot) {
  if (!state.equipment) return;
  const occupant = state.equipment[slot];
  if (!occupant) return;
  delete state.equipment[slot];
  state.log.push(`Unequipped ${occupant} from slot ${slot}`);
}

// Auto-unequip any slot containing the named item. Called when remove_item
// fires so a removed item is no longer shown as equipped.
function autoUnequipOnRemove(state, itemId) {
  if (!state.equipment) return;
  for (const slot of Object.keys(state.equipment)) {
    if (state.equipment[slot] === itemId) {
      delete state.equipment[slot];
    }
  }
}

// Rule 25 (schema v1.9+). Return the list of inventory item ids whose
// items_catalog entry declares consume.satisfies_eat_meal: true — these
// appear as alternative actions during eat_meal pauses alongside the
// generic 'eat' and 'skip' options. A named consumable is a substitute
// for a generic provision, not a supplement, so selecting one removes
// one copy of the item, runs its consume.effects, and satisfies the
// eat_meal prompt WITHOUT decrementing state.provisions.
function getNamedConsumables(state, book) {
  const catalog = (book && book.items_catalog) || {};
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const out = [];
  for (const id of inv) {
    const entry = catalog[id];
    if (entry && entry.consume && entry.consume.satisfies_eat_meal === true) {
      out.push(id);
    }
  }
  return out;
}

// Handle the auto-equip side of an add_item. If the item is equippable
// with auto_equip: true (default), AND the item's slot is currently
// empty, move it into its slot. If the slot is already occupied by a
// different item, leave the existing occupant equipped and leave the
// new item unequipped in plain inventory. The player can later issue
// an explicit equip command to swap.
//
// Non-displacing semantic (codex v2.8.3+, emulator v3.0.2+). Prior
// versions (pre-3.0.2) displaced the previous occupant on every
// auto_equip fire, which meant a section granting a new weapon
// silently swapped the player's active weapon underneath them. The
// codex v2.8.3 Rule 19 update moves to "auto_equip fills empty slots
// only" so the player's active equipment is never changed without an
// explicit opt-in. The player-driven equip command still displaces,
// because that's the player's explicit choice.
function autoEquipOnAdd(state, book, itemId) {
  const item = getItemDef(book, itemId);
  if (!item || !item.equippable) return;
  const autoEquip = item.auto_equip !== false; // default true
  if (!autoEquip) return;
  if (!state.equipment) state.equipment = {};
  const existingOccupant = state.equipment[item.slot];
  if (existingOccupant && existingOccupant !== itemId) {
    state.log.push(`Auto-equip skipped for ${itemId}: slot ${item.slot} already holds ${existingOccupant} (player may equip manually to swap)`);
    return;
  }
  const check = canEquipItem(state, book, itemId, true);
  if (!check.ok) {
    state.log.push(`Auto-equip skipped for ${itemId}: ${check.reason}`);
    return;
  }
  equipItem(state, book, itemId);
}

// Rule 39 (schema v1.24+). Stackable-aware inventory add. Adds `quantity`
// copies of `itemId` to `state.inventory`. If the item's items_catalog
// entry carries `stackable: true`, copies accumulate (true multiset). If
// not, the second-and-beyond copies are no-ops via the existing set
// semantics — the same behaviour as pre-v1.24 emulators. Always runs
// `autoEquipOnAdd` once at the end (idempotent for already-equipped or
// non-equippable items). Returns the number of copies actually added.
function addItemToInventory(state, book, itemId, quantity) {
  const n = (typeof quantity === 'number' && quantity >= 1) ? Math.floor(quantity) : 1;
  const def = getItemDef(book, itemId) || {};
  const isStackable = def.stackable === true;
  let added = 0;
  for (let i = 0; i < n; i++) {
    if (isStackable || !state.inventory.includes(itemId)) {
      state.inventory.push(itemId);
      added++;
    }
  }
  autoEquipOnAdd(state, book, itemId);
  return added;
}

// ==================== DAMAGE INTERACTIONS (schema v1.5+) ====================

// Normalize a damage value into a list of component objects
// { amount: number, sources: string[] }. Accepts three forms:
//   - undefined / null → empty list (no damage)
//   - a number → a single untagged component with that amount
//   - a list of {amount, sources} tables → the full form, passed through
//   - an array of numbers (unusual) → one untagged component per entry
function normalizeDamage(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'number') {
    return [{ amount: raw, sources: [] }];
  }
  if (Array.isArray(raw)) {
    const out = [];
    for (const entry of raw) {
      if (typeof entry === 'number') {
        out.push({ amount: entry, sources: [] });
      } else if (entry && typeof entry === 'object') {
        const amount = typeof entry.amount === 'number' ? entry.amount : 0;
        const sources = Array.isArray(entry.sources) ? entry.sources.filter(s => typeof s === 'string')
          : (entry.sources && typeof entry.sources === 'object' ? Object.values(entry.sources).filter(s => typeof s === 'string') : []);
        out.push({ amount, sources });
      }
    }
    return out;
  }
  // readTable in the Lua bridge converts Lua tables to objects keyed by
  // 1-based numeric indices. Walk the numeric keys in order.
  if (typeof raw === 'object') {
    const keys = Object.keys(raw).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    if (keys.length > 0) {
      const out = [];
      for (const k of keys) {
        const entry = raw[k];
        if (typeof entry === 'number') {
          out.push({ amount: entry, sources: [] });
        } else if (entry && typeof entry === 'object') {
          const amount = typeof entry.amount === 'number' ? entry.amount : 0;
          let sources = [];
          if (Array.isArray(entry.sources)) {
            sources = entry.sources.filter(s => typeof s === 'string');
          } else if (entry.sources && typeof entry.sources === 'object') {
            // Lua-table form
            const srcKeys = Object.keys(entry.sources).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
            sources = srcKeys.map(k => entry.sources[k]).filter(s => typeof s === 'string');
          }
          out.push({ amount, sources });
        }
      }
      return out;
    }
    // A lone {amount, sources} object (not wrapped in a list).
    if (typeof raw.amount === 'number') {
      let sources = [];
      if (Array.isArray(raw.sources)) sources = raw.sources.filter(s => typeof s === 'string');
      else if (raw.sources && typeof raw.sources === 'object') {
        const srcKeys = Object.keys(raw.sources).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
        sources = srcKeys.map(k => raw.sources[k]).filter(s => typeof s === 'string');
      }
      return [{ amount: raw.amount, sources }];
    }
  }
  return [];
}

// Test whether a damage_interaction's source filters match a given component.
// Returns true if the interaction should apply to this component. An
// interaction with no filters always matches.
function interactionMatchesComponent(inter, component) {
  const sources = component.sources || [];
  if (Array.isArray(inter.source_has_any) && inter.source_has_any.length > 0) {
    const any = inter.source_has_any.some(tag => sources.includes(tag));
    if (!any) return false;
  }
  if (Array.isArray(inter.source_lacks_all) && inter.source_lacks_all.length > 0) {
    const lacks = inter.source_lacks_all.every(tag => !sources.includes(tag));
    if (!lacks) return false;
  }
  return true;
}

// Apply frozen damage_interactions to a list of damage components and
// Schema v1.7+ duration-aware modifier filtering. Given a frozen modifier
// entry and a 1-based combat round number, return true if the modifier
// participates in that round. Round 0 is pre-first-round (nothing applies
// yet); round 1 is the first fighting round; round 2+ are subsequent
// rounds. Undefined duration means 'fight' (backward-compatible default).
// 'round' is reserved for a future per-round dynamic semantic and is
// currently treated as 'fight'.
function modifierAppliesAtRound(mod, round) {
  if (round < 1) return false;
  const dur = (mod && mod.duration) || 'fight';
  if (dur === 'first_round') return round === 1;
  if (dur === 'after_first_round') return round >= 2;
  return true;
}

// Schema v1.14+ (Rule 17 modifier-expiry-on-loss-streak): a modifier with
// removedAfterConsecutiveLosses set is excluded from the active list once
// the per-fight player-loss streak counter has reached its threshold.
// One-way: the modifier does not come back if the streak later resets.
function modifierExpiredByLossStreak(mod, consecutiveLosses) {
  const t = mod && mod.removedAfterConsecutiveLosses;
  if (typeof t !== 'number' || t < 1) return false;
  return (consecutiveLosses || 0) >= t;
}

// return the summed scaled damage. Interactions are filtered by direction
// (incoming / outgoing), then by source tags per-component. Matching
// interactions' multipliers compose multiplicatively on a component.
// Negative damage (healing) bypasses interactions entirely — it is
// returned unchanged and summed directly.
function applyDamageInteractions(components, interactions, direction, state, book, round) {
  let total = 0;
  const logEntries = [];
  for (const comp of components) {
    let amount = comp.amount;
    if (amount <= 0) {
      // Healing or no-op: pass through unchanged.
      total += amount;
      continue;
    }
    for (const inter of interactions) {
      if ((inter.direction || 'incoming') !== direction) continue;
      if (!interactionMatchesComponent(inter, comp)) continue;
      const before = amount;
      amount = amount * inter.multiplier;
      if (round === 1) {
        logEntries.push({ comp, inter, before, after: amount });
      }
    }
    total += amount;
  }
  // Log a summary of damage_interactions that fired on round 1, so the
  // playthrough log shows what's in effect. We only log round 1 to avoid
  // cluttering the log with per-round spam.
  if (round === 1 && logEntries.length > 0) {
    for (const entry of logEntries) {
      const srcs = entry.comp.sources.length > 0 ? `[${entry.comp.sources.join(',')}]` : '[untagged]';
      state.log.push(
        `Damage interaction (${direction}): ${entry.inter.kind} x${entry.inter.multiplier} on ${srcs} — ${entry.before} → ${entry.after}` +
        (entry.inter.reason ? ` (${entry.inter.reason})` : '')
      );
    }
  }
  return total;
}

function getEnemyHealth(enemy, book) {
  const { healthStat } = getCombatStats(book);
  if (!healthStat) return 0;
  const key = healthStat.toLowerCase().replace(/ /g, '_');
  return enemy[healthStat] ?? enemy[key] ?? 0;
}

function getEnemyAttack(enemy, book) {
  const { attackStat } = getCombatStats(book);
  if (!attackStat) return 0;
  const key = attackStat.toLowerCase().replace(/ /g, '_');
  return enemy[attackStat] ?? enemy[key] ?? 0;
}

// Codex v2.13+ / emulators v3.5+ (Windhammer Bug C). One-shot book-shape
// validation that surfaces the silent-broken cases where a book declares an
// attack_stat or health_stat that isn't in rules.stats[]. Warnings are
// accumulated into state.validationWarnings and rendered at the top of the
// status output so the root cause is visible before downstream symptoms
// (player.attack=0 every round, stat bar showing 0 health) become confusing.
// Non-fatal — the game still runs so players can see the consequences. Runs
// once per session at the start of character creation; the post-creation
// "declared but never initialised" check fires later (see processCreationSteps
// end-of-loop).
function validateBookShape(state, book) {
  const warnings = [];
  const statsArr = book?.rules?.stats || [];
  const declaredNames = new Set(statsArr.map(s => s.name));
  const attackStat = book?.rules?.attack_stat;
  if (attackStat && !declaredNames.has(attackStat)) {
    warnings.push(`rules.attack_stat "${attackStat}" is not declared in rules.stats[] — state.stats[${JSON.stringify(attackStat)}] will be undefined and player.attack will resolve to 0. Either add ${attackStat} to rules.stats[] with an initialiser, or set rules.attack_stat: null and compute the attack value inside the round_script (see Rule 26 / Section 7.5 "Games without attack_stat").`);
  }
  const healthStat = book?.rules?.health_stat;
  if (healthStat && !declaredNames.has(healthStat)) {
    warnings.push(`rules.health_stat "${healthStat}" is not declared in rules.stats[] — state.stats[${JSON.stringify(healthStat)}] will be undefined and health display will fail.`);
  }
  if (warnings.length) {
    state.validationWarnings = (state.validationWarnings || []).concat(warnings);
    for (const w of warnings) state.log.push(`WARNING: ${w}`);
  }
  return warnings;
}

// Codex v2.13+ / emulators v3.5+ (Windhammer Bug C). Runs after
// character_creation.steps[] completes and before the first section
// renders. Flags any stat declared in rules.stats[] that is still
// undefined in state.stats — the "stat declared but never initialised"
// case (no roll_stat, no distribute_points, no set_resource matching the
// stat name, and no script populating it).
function validatePostCreation(state, book) {
  const warnings = [];
  const statsArr = book?.rules?.stats || [];
  for (const s of statsArr) {
    if (typeof s?.name !== 'string') continue;
    const v = state.stats[s.name];
    if (v === undefined || v === null || Number.isNaN(v)) {
      warnings.push(`Stat "${s.name}" declared in rules.stats[] is still undefined after character_creation.steps[] completed — no roll_stat, distribute_points, set_resource, or other initialiser wrote to it. Character-sheet rendering and combat will read 0 / em-dash for this stat.`);
    }
  }
  if (warnings.length) {
    state.validationWarnings = (state.validationWarnings || []).concat(warnings);
    for (const w of warnings) state.log.push(`WARNING: ${w}`);
  }
  return warnings;
}

function startCharacterCreation(state, book) {
  if (!state.validationDone) {
    validateBookShape(state, book);
    state.validationDone = true;
  }
  state.pause = { type: 'character_creation' };
  state.creationStep = 0;
  // Codex v2.9 / schema v1.6: provisions are a resource counter, not
  // an inventory item. The canonical encoding for any book that uses
  // meals/rations/provisions/food as a character-sheet counter is
  // `state.provisions`, optionally labeled via
  // `rules.provisions.display_name`. The authoritative starting value
  // is `rules.provisions.starting_amount` — when present, auto-init
  // state.provisions here so the emulator has the right count even
  // when the book's character_creation.steps[] forgets to explicitly
  // set_resource provisions, or (worse) sets the wrong slot name like
  // `set_resource resource:"meals"` that doesn't route to the
  // canonical slot. See Rule 21 in THE_CODEX_OF_ULTIMATE_WISDOM.md for the full
  // encoding story and the known_issues.md "starting Meal not
  // surfaced" entry for the LW1 instance that motivated this.
  const startingProvisions = book?.rules?.provisions?.starting_amount;
  if (typeof startingProvisions === 'number' && startingProvisions >= 0) {
    state.provisions = startingProvisions;
  }
  return processCreationSteps(state, book);
}

function processCreationSteps(state, book) {
  const steps = book.character_creation?.steps || [];
  while (state.creationStep < steps.length) {
    const step = steps[state.creationStep];
    // Schema v1.6+: character_creation_step.condition. If a condition
    // is present and evaluates false against the current state, skip
    // the step entirely (no pause, no state mutation, no UI). The
    // condition evaluates against state as it exists at the moment
    // this step is reached, so later steps can gate on earlier
    // steps' outputs (ability picks from a preceding
    // choose_abilities, rolled values from a preceding roll_stat,
    // etc.). Introduced to support Rule 15-style discipline-gated
    // creation rolls — e.g. LW1's Weaponskill weapon-type roll that
    // should only fire when the player picked Weaponskill in the
    // preceding choose_abilities step.
    if (step.condition && !evalCondition(step.condition, state, book)) {
      state.log.push(`Character creation step ${state.creationStep} (${step.action}) skipped — condition not met`);
      state.creationStep++;
      continue;
    }
    if (step.action === 'roll_stat') {
      state.pause = { type: 'character_creation_roll', step_index: state.creationStep, stat: step.stat, formula: step.formula };
      return state;
    } else if (step.action === 'roll_resource') {
      // Schema v1.6+ / codex v2.9+. A roll for a canonical resource
      // slot (state.gold / state.provisions / state.meals) or a
      // declared-stat-currency. Pause on a dedicated pause type so
      // the player or harness can provide the roll, then the 'act'
      // handler routes the rolled total into the appropriate slot.
      // See Rule 11 in THE_CODEX_OF_ULTIMATE_WISDOM.md for the full story and
      // the LW1 Gold Crowns worked example; this closes the pre-v1.6
      // anti-pattern of using roll_stat with a scratch stat name.
      state.pause = {
        type: 'character_creation_roll_resource',
        step_index: state.creationStep,
        resource: step.resource,
        formula: step.formula,
      };
      return state;
    } else if (step.action === 'roll_table') {
      // Schema v1.22+ / codex v2.29+ (Rule 11 extension). A chargen roll
      // whose result selects a per-range entry whose `effects[]` are
      // applied via the standard handleEvent path. The rolled value is
      // ephemeral — NOT written to any stat slot. Pause on a dedicated
      // pause type carrying the step's results map; the 'act' handler
      // rolls the formula, picks the matching entry, and dispatches the
      // effects. See Rule 11's v2.29.0 extension subsection for the full
      // story and the LW1 starting-equipment worked example.
      state.pause = {
        type: 'character_creation_roll_table',
        step_index: state.creationStep,
        formula: step.formula,
        prompt: step.prompt || null,
        results: step.results || {},
      };
      return state;
    } else if (step.action === 'choose_one') {
      state.pause = {
        type: 'character_creation_choose_one',
        step_index: state.creationStep,
        category: step.category,
        options: step.options || [],
      };
      return state;
    } else if (step.action === 'choose_abilities') {
      state.pause = {
        type: 'character_creation_choose_abilities',
        step_index: state.creationStep,
        count: step.count || book.rules?.abilities?.choose_count || 5,
        available: (book.rules?.abilities?.available || []).map(a => a.name),
      };
      return state;
    } else if (step.action === 'choose_talents') {
      // Schema v1.18+ / codex Rule 35. Parallel to choose_abilities; reads
      // candidates from rules.talents.available and writes the player's
      // picks to state.talents (list of names). Per-talent `effects[]`
      // auto-apply at confirm time and `exclusive_with` is enforced before
      // any state mutation, exactly as for choose_abilities.
      state.pause = {
        type: 'character_creation_choose_talents',
        step_index: state.creationStep,
        count: step.count || book.rules?.talents?.choose_count || 2,
        available: (book.rules?.talents?.available || []).map(t => t.name),
      };
      return state;
    } else if (step.action === 'add_item') {
      const q = (typeof step.quantity === 'number' && step.quantity >= 1) ? Math.floor(step.quantity) : 1;
      addItemToInventory(state, book, step.item, q);
      state.creationStep++;
    } else if (step.action === 'set_resource') {
      // Canonical resource slots first.
      if (step.resource === 'provisions') {
        state.provisions = step.amount;
      } else if (step.resource === 'gold') {
        state.gold = step.amount;
      } else if (step.resource === 'meals') {
        state.meals = step.amount;
      } else {
        // Fall through: if the resource name matches a declared stat in
        // rules.stats[].name, route the value into state.stats[name]
        // rather than silently dropping it. This handles books whose
        // currency or experience is carried as a first-class stat (e.g.,
        // GrailQuest declares GOLD and EXPERIENCE as stats and uses
        // set_resource: "GOLD" / "EXPERIENCE" to initialize them at 0).
        // Schema v1.3 documents this behavior on character_creation_step.resource.
        const statDefs = book.rules?.stats || [];
        const matchingStat = statDefs.find(s => s.name === step.resource);
        if (matchingStat) {
          state.stats[step.resource] = step.amount;
          if (matchingStat.initial_is_max) {
            state.initialStats[step.resource] = step.amount;
          }
        } else {
          state.log.push(`Unknown resource in set_resource: ${step.resource} (not a canonical slot and not a declared stat name; value discarded)`);
        }
      }
      state.creationStep++;
    } else if (step.action === 'set_ability_uses') {
      // Initializes the per-use counter for a named ability. Used by books
      // that track limited-use spells or powers separately from a simple
      // inventory of scrolls or potions. Stored in state.abilityUses so
      // conditions like `stat_gte` (via a future `ability_uses` condition)
      // or bespoke script events can read the remaining count. The ability
      // itself should be in rules.abilities.available OR a character creation
      // choose_abilities result, but we don't enforce that here — the book
      // may ship hard-coded starting abilities outside the discipline system.
      if (!state.abilityUses) state.abilityUses = {};
      state.abilityUses[step.ability] = step.uses;
      state.log.push(`Set ${step.ability} uses = ${step.uses}`);
      state.creationStep++;
    } else if (step.action === 'distribute_points') {
      // Schema v1.10+ / codex v2.13+ (Rule 26). Point-buy character
      // creation. Pause on a dedicated pause type with the full step
      // descriptor; the `distribute` action collects per-stat values
      // and validates sum + ranges before committing.
      state.pause = {
        type: 'character_creation_distribute',
        step_index: state.creationStep,
        total_points: step.total_points,
        stats: step.stats || [],
      };
      return state;
    } else {
      // Unknown action — skip
      state.log.push(`Unknown character_creation action: ${step.action} (skipped)`);
      state.creationStep++;
    }
  }
  // Done with creation
  validatePostCreation(state, book);
  state.creationDone = true;
  state.pause = null;
  return navigateTo(state, book, '1');
}

function navigateTo(state, book, sectionId) {
  const sid = String(sectionId);
  const section = book.sections[sid];
  if (!section) {
    state.log.push(`ERROR: Section ${sid} not found`);
    state.pause = { type: 'error', message: `Section ${sid} not found` };
    return state;
  }
  // Rule 36 on_section_exit triggers (schema v1.21+ / codex v2.28.0):
  // fire BEFORE state.currentSection updates to the destination so the
  // sectionEntrySnapshot from the section being LEFT is still in scope
  // for condition evaluation (section_had_no_endurance_loss,
  // section_had_no_combat). Guarded by state.currentSection != null so
  // the first navigation in a run (chargen-confirm → §1) does not fire
  // the trigger from a phantom-empty snapshot. The trigger fires on
  // every form of section-exit: choice navigation, combat-win
  // navigation, combat-lose navigation, combat-flee navigation, because
  // every path lands here.
  if (state.currentSection != null) {
    dispatchLifecycleTriggers(state, book, 'on_section_exit');
  }
  // Capture the caller before updating currentSection. previousSection is
  // the section we're LEAVING as this call runs; it will become the
  // "caller" if the destination is a subroutine entry.
  const callerId = state.currentSection;
  state.previousSection = callerId;
  state.currentSection = sid;
  // Rule 36 section-bookkeeping snapshot (schema v1.21+): record the
  // primary-health stat value and a freshly-cleared hadCombat flag for
  // the section the player is entering. Consulted by the next
  // on_section_exit dispatch (via section_had_no_endurance_loss /
  // section_had_no_combat conditions). The primary-health stat is
  // resolved via book.rules.health_stat (the canonical engine spelling
  // — the same field consulted by getCombatStats / getPlayerHealth /
  // setPlayerHealth everywhere else). Resource slots (provisions /
  // gold / meals) are never the primary-health stat by convention so
  // they don't need special handling here.
  const _healthStat = book?.rules?.health_stat || null;
  state.sectionEntrySnapshot = { hadCombat: false };
  if (_healthStat) state.sectionEntrySnapshot[_healthStat] = state.stats[_healthStat];
  if (!state.visitedSections.includes(sid)) state.visitedSections.push(sid);
  state.lastTestResult = null;

  // Codex 7.6.8 subroutine-entry handling: if the destination section has
  // is_subroutine_entry: true, push the caller onto returnStack so that a
  // later return_to_caller event can pop it. Guards against pushing null
  // (e.g. the player arrived via a debug jump with no prior currentSection
  // — in that case we leave the stack alone and the return_to_caller
  // handler falls back to its input_number prompt mode).
  if (section.is_subroutine_entry && callerId != null) {
    if (!Array.isArray(state.returnStack)) state.returnStack = [];
    state.returnStack.push(callerId);
    state.log.push(`Entered subroutine section ${sid}; return target ${callerId} pushed onto stack (depth ${state.returnStack.length})`);
  }

  if (section.is_ending) {
    state.pause = { type: 'ending', ending_type: section.ending_type, text: section.text };
    return state;
  }

  // Check for death
  const { healthStat } = getCombatStats(book);
  if (healthStat && state.stats[healthStat] !== undefined && state.stats[healthStat] <= 0) {
    state.pause = { type: 'ending', ending_type: 'death', text: `Your ${healthStat} has reached zero.` };
    return state;
  }

  // Rule 36 on_section_enter triggers (schema v1.20+): fire after death
  // check, before section event queue. Items / abilities / talents whose
  // triggered_effects[].trigger === 'on_section_enter' dispatch their
  // effect against the player's state as they enter the section.
  dispatchLifecycleTriggers(state, book, 'on_section_enter');

  // Queue events
  state.eventQueue = [...(section.events || [])];
  state.pendingChoices = section.choices || [];
  return processNextEvent(state, book);
}

function processNextEvent(state, book) {
  while (state.eventQueue.length > 0) {
    const event = state.eventQueue.shift();
    const result = handleEvent(event, state, book);
    if (result === 'pause') return state;
    if (result === 'navigate') return state;
  }
  // No more events — present choices
  return presentSection(state, book);
}

function handleEvent(event, state, book) {
  // Event-level condition gate (schema v1.2+). If the event carries a
  // `condition` field and it evaluates to false at dispatch time, skip
  // the event entirely: no state mutation, no pause, no log side effect.
  // This is the primary mechanism for discipline- and item-driven
  // exemptions from rule-mandated mechanics (e.g. Lone Wolf's Hunting
  // discipline exempting the player from eat_meal requirements).
  // Absent or null `condition` means the event always fires, so
  // pre-v1.2 books remain valid.
  if (event.condition && !evalCondition(event.condition, state, book)) {
    state.log.push(`Event skipped (${event.type}: ${describeCondition(event.condition)} is false)`);
    return 'continue';
  }
  switch (event.type) {
    case 'modify_stat': {
      const stat = event.stat;
      const amount = event.amount || 0;
      // modify_initial_only (schema v1.16+): apply amount to initialStats
      // ONLY, leaving current stats[stat] untouched. The current value
      // may legitimately exceed the new initial after this event fires;
      // initial_is_max clamping on subsequent heal events does the
      // catch-up. Resource slots (provisions / gold / meals) have no
      // initial-stats entry, so the field is a true no-op for those —
      // we still return early so the regular `amount` application path
      // below does NOT run. Mutually exclusive with modify_initial (the
      // schema description says don't combine; this implementation lets
      // modify_initial_only take precedence if both are set, since
      // modify_initial would otherwise also touch current).
      if (event.modify_initial_only) {
        if (stat !== 'provisions' && stat !== 'gold' && stat !== 'meals') {
          state.initialStats[stat] = (state.initialStats[stat] || 0) + amount;
          if (event.set_initial_to !== undefined) {
            state.initialStats[stat] = event.set_initial_to;
            if ((state.stats[stat] || 0) > event.set_initial_to) {
              state.stats[stat] = event.set_initial_to;
            }
          }
          const setNoteOnly = event.set_initial_to !== undefined ? ` (initial set to ${event.set_initial_to})` : '';
          state.log.push(`${stat} initial ${amount >= 0 ? '+' : ''}${amount} (initial only — current unchanged)${setNoteOnly}${event.reason ? ' (' + event.reason + ')' : ''}`);
        } else {
          state.log.push(`${stat} modify_initial_only no-op (resource slot)${event.reason ? ' (' + event.reason + ')' : ''}`);
        }
        return 'continue';
      }
      // If modify_initial is set, also apply the delta to initialStats
      // so the change is permanent — healing cannot restore past the
      // new (lower) ceiling. See codex / schema modify_initial field.
      // Applied first, before the current-value update, so that a
      // statDef.initial_is_max clamp uses the new ceiling.
      if (event.modify_initial && stat !== 'provisions' && stat !== 'gold' && stat !== 'meals') {
        state.initialStats[stat] = (state.initialStats[stat] || 0) + amount;
      }
      if (stat === 'provisions') state.provisions = Math.max(0, state.provisions + amount);
      else if (stat === 'gold') state.gold = Math.max(0, state.gold + amount);
      else if (stat === 'meals') state.meals = Math.max(0, state.meals + amount);
      else {
        const old = state.stats[stat] || 0;
        let newVal = old + amount;
        const statDef = (book.rules?.stats || []).find(s => s.name === stat);
        if (statDef?.initial_is_max && state.initialStats[stat] !== undefined) {
          newVal = Math.min(newVal, state.initialStats[stat]);
        }
        if (statDef?.min !== undefined && statDef?.min !== null) {
          newVal = Math.max(newVal, statDef.min);
        }
        state.stats[stat] = newVal;
      }
      // set_initial_to (schema v1.12+): absolute-ceiling cap. Assign
      // initialStats[stat] to the supplied value and clamp current
      // stats[stat] down if currently above the new ceiling. Applied
      // AFTER the amount delta so a single event combining a heal +
      // permanent cap (rare) lands on the new ceiling. Excluded for
      // resource slots (provisions/gold/meals) which don't have an
      // initial-stats ceiling. See codex Rule 30.
      if (event.set_initial_to !== undefined && stat !== 'provisions' && stat !== 'gold' && stat !== 'meals') {
        state.initialStats[stat] = event.set_initial_to;
        if ((state.stats[stat] || 0) > event.set_initial_to) {
          state.stats[stat] = event.set_initial_to;
        }
      }
      const setNote = event.set_initial_to !== undefined ? ` (initial set to ${event.set_initial_to})` : '';
      state.log.push(`${stat} ${amount >= 0 ? '+' : ''}${amount}${event.modify_initial ? ' (permanent, initial updated)' : ''}${setNote}${event.reason ? ' (' + event.reason + ')' : ''}`);
      return 'continue';
    }
    case 'restore_to_initial': {
      // Rule 45 (schema v1.28+). SET semantic for the source phrasing
      // "STAMINA is restored to its Initial total" — raise current to
      // initial, never lower. Distinguished from modify_stat with
      // initial_is_max on the stat declaration (which is the clamped-
      // ADD encoding for "regain N, up to your Initial").
      const stat = event.stat;
      if (!stat) {
        state.log.push(`restore_to_initial: missing stat field, skipping`);
        return 'continue';
      }
      const initial = state.initialStats[stat];
      if (initial === undefined) {
        state.log.push(`restore_to_initial: ${stat} has no initial value, skipping`);
        return 'continue';
      }
      const old = state.stats[stat] || 0;
      const newVal = Math.max(old, initial);
      state.stats[stat] = newVal;
      const delta = newVal - old;
      state.log.push(`${stat} restored to Initial (${old} → ${newVal}${delta > 0 ? ', +' + delta : ', no change'})${event.reason ? ' (' + event.reason + ')' : ''}`);
      return 'continue';
    }
    case 'add_item': {
      const q = (typeof event.quantity === 'number' && event.quantity >= 1) ? Math.floor(event.quantity) : 1;
      addItemToInventory(state, book, event.item, q);
      state.log.push(`Acquired: ${event.item}${q > 1 ? ' ×' + q : ''}`);
      return 'continue';
    }
    case 'remove_item': {
      const q = (typeof event.quantity === 'number' && event.quantity >= 1) ? Math.floor(event.quantity) : 1;
      let removed = 0;
      for (let i = 0; i < q; i++) {
        const idx = state.inventory.indexOf(event.item);
        if (idx < 0) break;
        state.inventory.splice(idx, 1);
        removed++;
      }
      autoUnequipOnRemove(state, event.item);
      state.log.push(`Lost: ${event.item}${removed > 1 ? ' ×' + removed : ''}`);
      return 'continue';
    }
    case 'remove_inventory_category': {
      // Rule 24 (schema v1.8+): remove every inventory item whose
      // items_catalog[id].inventory_category matches event.category, and
      // auto-unequip any currently-equipped items in that set. Canonical
      // use: LW1 §188 Kraan Backpack loss. Items without an
      // inventory_category (or with a non-matching one) are unaffected.
      // No-op if the category matches nothing currently carried.
      const category = event.category;
      const catalog = book.items_catalog || {};
      if (!category) {
        state.log.push('[Warning: remove_inventory_category event has no category field]');
        return 'continue';
      }
      const doomed = state.inventory.filter(id => (catalog[id] || {}).inventory_category === category);
      for (const id of doomed) {
        const idx = state.inventory.indexOf(id);
        if (idx >= 0) state.inventory.splice(idx, 1);
        autoUnequipOnRemove(state, id);
      }
      if (doomed.length > 0) {
        state.log.push(`Lost ${doomed.length} ${category} item${doomed.length === 1 ? '' : 's'}: ${doomed.join(', ')}${event.reason ? ' (' + event.reason + ')' : ''}`);
      } else {
        state.log.push(`No ${category} items to remove${event.reason ? ' (' + event.reason + ')' : ''}`);
      }
      return 'continue';
    }
    case 'set_flag':
      if (!state.flags.includes(event.flag)) state.flags.push(event.flag);
      state.log.push(`Flag set: ${event.flag}`);
      return 'continue';
    case 'clear_flag': {
      const idx = state.flags.indexOf(event.flag);
      if (idx >= 0) {
        state.flags.splice(idx, 1);
        state.log.push(`Flag cleared: ${event.flag}${event.reason ? ' (' + event.reason + ')' : ''}`);
      } else {
        state.log.push(`Flag clear no-op: ${event.flag} was not set${event.reason ? ' (' + event.reason + ')' : ''}`);
      }
      return 'continue';
    }
    case 'queue_combat_modifier': {
      // Schema v1.26+ (Rule 42). Buffer a one-shot combat_modifier consumed
      // on the next combat-enter. The modifier's shape matches Rule 17
      // combat_modifier entries (target, delta, optional reason). Multiple
      // queued modifiers stack — the buffer drains in FIFO order at
      // startCombat time.
      if (!event.modifier || typeof event.modifier !== 'object') {
        state.log.push(`queue_combat_modifier: missing or invalid modifier payload; no-op`);
        return 'continue';
      }
      if (!Array.isArray(state.pendingCombatModifiers)) state.pendingCombatModifiers = [];
      const mod = {
        target: event.modifier.target,
        delta: event.modifier.delta,
      };
      if (event.modifier.reason) mod.reason = event.modifier.reason;
      state.pendingCombatModifiers.push(mod);
      state.log.push(`Queued combat modifier for next fight: ${mod.target} ${mod.delta >= 0 ? '+' : ''}${mod.delta}${mod.reason ? ' (' + mod.reason + ')' : ''}`);
      return 'continue';
    }
    case 'combat':
      return startCombat(event, state, book);
    case 'stat_test':
      state.pause = { type: 'stat_test', event };
      return 'pause';
    case 'roll_dice':
      state.pause = { type: 'roll_dice', event };
      return 'pause';
    case 'eat_meal': {
      // Zero-food auto-penalty path (codex v2.9.0 / schema v1.6.0).
      // Rule 15's event-level `condition` field handles the exemption
      // case (e.g. LW Hunting discipline): if the condition evaluates
      // false at event dispatch, the event is never reached here. If
      // we ARE here and the event is `required: true`, the player has
      // no exempting ability AND the event must resolve — but
      // getAvailableActions exposes neither "eat" (no food) nor "skip"
      // (required:true) if the player has zero provisions and zero
      // meals. That's a deadlock. The book's intent in that situation
      // is "the player could not eat, so they take the penalty," so
      // we auto-apply the penalty at dispatch time and advance without
      // pausing. Pre-v2.9 emulators silently swallowed this case (no
      // pause, no penalty, no log) — see LW1 section 235 entry in
      // known_issues.md.
      //
      // Rule 25 (schema v1.9+) broadens the "has food" check to also
      // include named consumables (items with consume.satisfies_eat_meal:
      // true, e.g. Laumspur). The player who holds a Laumspur but zero
      // generic Meals should pause and choose to eat the Laumspur — not
      // auto-penalty.
      const hasFood = state.provisions > 0 || state.meals > 0 || getNamedConsumables(state, book).length > 0;
      if (event.required && !hasFood) {
        const penStat = event.penalty_stat || book.rules?.provisions?.heal_stat || 'endurance';
        const penalty = (typeof event.penalty_amount === 'number') ? event.penalty_amount : 0;
        if (penalty !== 0) {
          const old = state.stats[penStat] || 0;
          state.stats[penStat] = Math.max(0, old + penalty);
          state.log.push(`No ${book.rules?.provisions?.display_name || 'provisions'} to eat: ${penStat} ${penalty >= 0 ? '+' : ''}${penalty}`);
        } else {
          state.log.push(`No ${book.rules?.provisions?.display_name || 'provisions'} to eat (required meal, no penalty defined)`);
        }
        return processNextEvent(state, book);
      }
      state.pause = { type: 'eat_meal', event };
      return 'pause';
    }
    case 'input_number':
      state.pause = { type: 'input_number', event };
      return 'pause';
    case 'input_text':
      state.pause = { type: 'input_text', event };
      return 'pause';
    case 'choose_items': {
      // Schema v1.25+ (Rule 40): when event.mode === 'remove', the event
      // is a loss-variant — eligible pool is filtered from state.inventory
      // by event.from_category; pause only if multi-choice required.
      if (event.mode === 'remove') {
        const catalog = book.items_catalog || {};
        const cat = event.from_category;
        const eligible = state.inventory.filter(id => {
          if (cat == null) return true;
          const item = catalog[id];
          return item && item.inventory_category === cat;
        });
        const want = event.count || 1;
        if (eligible.length === 0) {
          state.log.push(`choose_items mode:remove — no eligible items${cat ? ` in category ${cat}` : ''}; no-op`);
          return 'continue';
        }
        if (eligible.length <= want) {
          // Auto-resolve: remove all eligible items, no pause needed.
          for (const id of eligible) {
            const idx = state.inventory.indexOf(id);
            if (idx >= 0) state.inventory.splice(idx, 1);
            autoUnequipOnRemove(state, id);
          }
          if (event.on_success_set_flag) {
            if (!state.flags.includes(event.on_success_set_flag)) state.flags.push(event.on_success_set_flag);
          }
          state.log.push(`Removed (forced, only eligible): ${eligible.join(', ')}`);
          return 'continue';
        }
        // Multi-choice case — pause for player selection.
        state.pause = { type: 'choose_items', event, eligible };
        return 'pause';
      }
      state.pause = { type: 'choose_items', event };
      return 'pause';
    }
    case 'script':
      return runScriptEvent(event, state, book);
    case 'route_by_flag': {
      // Schema v1.31+ (Rule 47) — flag-driven static-routing event.
      // Walk routes in order, take the first whose flag predicate
      // matches state.flags, navigate to that route's target. If no
      // route matches and event.fallback is set, navigate there
      // instead. If neither matches, fall through to the next event
      // in the queue (mirrors roll_dice no-match-no-target).
      const flags = state.flags || [];
      const routes = Array.isArray(event.routes) ? event.routes : [];
      for (const route of routes) {
        const flagMatch = route.flag && flags.includes(route.flag);
        const notFlagMatch = route.not_flag && !flags.includes(route.not_flag);
        if (flagMatch || notFlagMatch) {
          state.log.push(`route_by_flag: ${route.flag ? 'flag=' + route.flag : 'not_flag=' + route.not_flag} matched → ${route.target}`);
          if (route.clear_flag_on_match && route.flag) {
            const idx = state.flags.indexOf(route.flag);
            if (idx >= 0) state.flags.splice(idx, 1);
          }
          navigateTo(state, book, route.target);
          return 'navigate';
        }
      }
      if (event.fallback !== undefined && event.fallback !== null) {
        state.log.push(`route_by_flag: no route matched → fallback ${event.fallback}`);
        navigateTo(state, book, event.fallback);
        return 'navigate';
      }
      state.log.push(`route_by_flag: no route matched and no fallback — falling through`);
      return 'continue';
    }
    case 'return_to_caller': {
      // Codex 7.6.8 return_to_caller handling (reference / auto-return
      // implementation). If the returnStack has a caller on top, pop it
      // and navigate there. If the stack is empty — because the player
      // arrived here via a debug jump or other unusual path with no
      // subroutine-entry push recorded — fall back to the purist
      // implementation: pause on an input_number so the player can type
      // the reference they noted. The event's prompt string is carried
      // through to both paths so a single book JSON works identically
      // in auto-return and manual-return emulators.
      if (!Array.isArray(state.returnStack)) state.returnStack = [];
      if (state.returnStack.length > 0) {
        const target = state.returnStack.pop();
        state.log.push(`return_to_caller: popped ${target} from stack (depth now ${state.returnStack.length})`);
        navigateTo(state, book, target);
        return 'navigate';
      }
      // Graceful degradation: no caller recorded. Prompt the player.
      state.pause = {
        type: 'input_number',
        event: {
          type: 'input_number',
          prompt: event.prompt || 'Enter the section reference you noted before the encounter',
          target: 'computed',
          note: '(return_to_caller fell back to manual entry — the return stack was empty)',
        },
      };
      return 'pause';
    }
    case 'custom':
      state.log.push(`Custom event: ${event.description || event.mechanic_name || 'unknown'}`);
      return 'continue';
    default:
      state.log.push(`Unknown event type: ${event.type}`);
      return 'continue';
  }
}

function runScriptEvent(event, state, book) {
  const playerData = {
    health: getPlayerHealth(state, book),
    name: 'You',
  };
  const context = {
    player: playerData,
    enemy: { attack: 0, health: 0, name: '' },
    combat: { round: 0 },
    game_state: { ...state.stats, provisions: state.provisions, gold: state.gold, meals: state.meals },
    initial_stats: { ...(state.initialStats || {}) },
    inventory: [...state.inventory],
    flags: [...state.flags],
    items_catalog: book.items_catalog || {},
  };
  // Pass the playbook-queued forced rolls by reference so that chained
  // scripts (where one script sets player.navigate_to and the destination
  // section also has a script event) all draw from the same queue. The
  // alternative — consuming and clearing the queue before each script —
  // would mean only the first script in a chain got forced rolls, which
  // is surprising and forces the playbook author to stop the chain.
  // Individual roll() calls inside runScript still shift from the queue,
  // so over-queueing leaves leftover values that the next script event
  // (in this chain or the next navigation) will pick up.
  const result = runScript(event.script_code || '', context, state.forcedScriptRolls, state.forcedClock);
  if (result.error) {
    state.log.push(`Script error: ${result.error}`);
    state.pause = { type: 'error', message: 'Script error: ' + result.error };
    return 'pause';
  }
  for (const msg of result.logs || []) state.log.push(msg);
  // Apply stat changes
  if (result.player?.stats_changed) {
    for (const [k, v] of Object.entries(result.player.stats_changed)) {
      state.stats[k] = v;
    }
  }
  // Apply health change
  if (result.player?.health !== undefined) {
    setPlayerHealth(state, book, result.player.health);
  }
  // Navigation
  if (result.player?.navigate_to) {
    navigateTo(state, book, result.player.navigate_to);
    return 'navigate';
  }
  return 'continue';
}

function startCombat(event, state, book) {
  // Schema v1.30+ / Rule 46. Resolve the lifecycle mode. The `mode` field
  // is overloaded with both lifecycle values (start/resume/modify) and
  // multi-enemy ordering values (sequential/simultaneous/player_choice);
  // we read each axis independently. The lifecycle axis defaults to
  // 'start' when absent or when the value is a multi-enemy ordering value.
  const lifecycleMode =
    (event.mode === 'resume' || event.mode === 'modify') ? event.mode : 'start';

  // Rule 46 'modify' — adjust state.activeCombat in place without engaging
  // combat. Supports enemy_ref swap (with a fresh enemy_snapshot rebuild)
  // and current_health override. Useful for wandering-monster patterns
  // where a roll-table effect pre-populates the active combat with the
  // rolled enemy before a downstream `mode: "resume"` engages it. No-op
  // if there is no active combat AND no enemy_ref to seed one — that's
  // a book-shape error worth surfacing in the log.
  if (lifecycleMode === 'modify') {
    if (!state.activeCombat && !event.enemy_ref) {
      state.log.push('R46 modify: no state.activeCombat and no enemy_ref to seed; skipping');
      return 'continue';
    }
    if (!state.activeCombat) {
      const data = book.enemies_catalog[event.enemy_ref] || {};
      state.activeCombat = {
        enemy_ref: event.enemy_ref,
        enemy_snapshot: JSON.parse(JSON.stringify(data)),
        currentHealth: getEnemyHealth(data, book),
        modifiers: [],
        damageInteractions: [],
        damageCaps: [],
        woundsDealt: 0,
        woundsTaken: 0,
        round: 0,
        consecutiveLosses: 0,
        originSection: state.currentSection,
        originEventIdx: 0,
      };
      state.log.push(`R46 modify: seeded activeCombat with ${event.enemy_ref}`);
    }
    if (event.enemy_ref && event.enemy_ref !== state.activeCombat.enemy_ref) {
      const data = book.enemies_catalog[event.enemy_ref] || {};
      state.activeCombat.enemy_ref = event.enemy_ref;
      state.activeCombat.enemy_snapshot = JSON.parse(JSON.stringify(data));
      // When the enemy swaps without an explicit current_health, refresh
      // the health to the new enemy's catalog default — the prior enemy's
      // remaining HP would be meaningless on a different creature.
      if (typeof event.current_health !== 'number') {
        state.activeCombat.currentHealth = getEnemyHealth(data, book);
      }
      state.log.push(`R46 modify: activeCombat.enemy_ref → ${event.enemy_ref}`);
    }
    if (typeof event.current_health === 'number') {
      state.activeCombat.currentHealth = Math.max(0, event.current_health);
      state.log.push(`R46 modify: activeCombat.currentHealth → ${state.activeCombat.currentHealth}`);
    }
    return 'continue';
  }

  let enemies = [];
  let resumed = false;

  // Rule 46 'resume' — continue an existing paused combat. The activeCombat
  // snapshot supplies enemy_ref / enemy_snapshot / currentHealth; the
  // resuming event's OWN combat_modifiers / damage_interactions / damage_caps
  // apply fresh (NOT inherited from the snapshot — this lets the interlude
  // introduce new modifiers cleanly, per the §24 "every third wound costs
  // 1 SKILL" pattern). woundsDealt / woundsTaken reset to 0 for the resumed
  // combat — each resume opens a fresh interrupt window. If there is no
  // active combat to resume, log and fall through to 'start' behavior
  // (the source-text pattern is broken but the engine should not deadlock).
  if (lifecycleMode === 'resume') {
    if (!state.activeCombat) {
      state.log.push('R46 resume: no state.activeCombat to resume; falling back to start');
    } else {
      const ac = state.activeCombat;
      const snap = ac.enemy_snapshot || book.enemies_catalog[ac.enemy_ref] || {};
      enemies = [{
        ref: ac.enemy_ref,
        name: snap.name,
        currentHealth: ac.currentHealth,
        data: snap,
      }];
      resumed = true;
      state.log.push(`R46 resume: continuing vs ${snap.name || ac.enemy_ref} at ${ac.currentHealth} health`);
    }
  }

  // 'start' (default) and the resume-fallback path both read enemies from
  // the event. 'start' also clears any stale activeCombat — the displaced
  // paused fight is treated as abandoned (no on_combat_end dispatch, per
  // the Rule 46 spec: interrupts pause; only normal completion ends).
  if (!resumed) {
    if (lifecycleMode === 'start' && state.activeCombat) {
      state.log.push(`R46 start: clearing stale activeCombat (vs ${state.activeCombat.enemy_ref})`);
      state.activeCombat = null;
    }
    if (event.enemies) {
      enemies = event.enemies.map(e => {
        const data = book.enemies_catalog[e.ref] || {};
        return { ref: e.ref, name: data.name, currentHealth: getEnemyHealth(data, book), data };
      });
    } else if (event.enemy_ref) {
      const data = book.enemies_catalog[event.enemy_ref] || {};
      enemies = [{ ref: event.enemy_ref, name: data.name, currentHealth: getEnemyHealth(data, book), data }];
    }
  }
  // Evaluate combat_modifiers (schema v1.4) once at combat start. We
  // merge the combat event's `combat_modifiers` with the intrinsic
  // modifiers from each enemy's catalog entry, evaluate each modifier's
  // condition against current state, and freeze the result on
  // state.combat.appliedModifiers. The list is then used verbatim for
  // every round's math and for the summary display. Modifiers are NOT
  // re-evaluated each round, so mid-combat state changes (losing an
  // item that gated a modifier, etc.) don't update the list. That
  // matches player expectations (modifiers announced at combat start
  // stay in effect) and simplifies the code. A book that needs truly
  // dynamic per-round modifiers should encode them in the round_script
  // directly instead of via combat_modifiers.
  const eventModifiers = event.combat_modifiers || [];
  const intrinsicModifiers = [];
  for (const en of enemies) {
    const cat = en.data || {};
    if (Array.isArray(cat.intrinsic_modifiers)) {
      intrinsicModifiers.push(...cat.intrinsic_modifiers);
    }
  }
  // Schema v1.26+ (Rule 42). Drain any pending one-shot combat modifiers
  // queued by `queue_combat_modifier` effects (typically fired from a
  // consumable's on_user_use triggered_effect). They merge into the
  // effective modifier set alongside event + intrinsic modifiers and
  // freeze with the rest at combat-start. After this drain, the buffer
  // is empty — the buffs are spent on this combat alone.
  const queuedModifiers = Array.isArray(state.pendingCombatModifiers) ? state.pendingCombatModifiers.slice() : [];
  if (queuedModifiers.length > 0) {
    state.log.push(`Consuming ${queuedModifiers.length} queued combat modifier${queuedModifiers.length === 1 ? '' : 's'}`);
    state.pendingCombatModifiers = [];
  }
  // Rule 23 (schema v1.8+): book-wide standing modifiers from
  // rules.combat_system.standing_modifiers[] apply to every combat in
  // the book unless their condition evaluates false. Merged into the
  // same frozen list as per-section and per-enemy modifiers. Canonical
  // use: LW's "if you enter combat with no weapons, deduct 4 from
  // COMBAT SKILL" — one entry in the book's rules block covers every
  // fight, rather than repeating the modifier on every combat event.
  const standingModifiers = Array.isArray(book.rules?.combat_system?.standing_modifiers)
    ? book.rules.combat_system.standing_modifiers
    : [];
  const appliedModifiers = [];
  for (const mod of [...standingModifiers, ...eventModifiers, ...intrinsicModifiers, ...queuedModifiers]) {
    if (mod.condition && !evalCondition(mod.condition, state, book)) continue;
    const target = typeof mod.target === 'string' ? mod.target : null;
    const delta = typeof mod.delta === 'number' ? mod.delta : 0;
    if (!target || delta === 0) continue;
    // Schema v1.7+ honors the duration field. Preserve it on the frozen
    // list so runCombatRound and the status-bar display can filter per
    // round. Absent duration is treated as 'fight' (backward compatible).
    // Schema v1.14+ optional per-fight expiry: drop the modifier after N
    // consecutive player-loss rounds. Preserve the threshold on the frozen
    // entry; the activeThisRound filter checks it against
    // state.combat.consecutiveLosses.
    const removedAfter = (typeof mod.removed_after_consecutive_losses === 'number'
      && Number.isInteger(mod.removed_after_consecutive_losses)
      && mod.removed_after_consecutive_losses >= 1)
      ? mod.removed_after_consecutive_losses : null;
    appliedModifiers.push({
      target, delta,
      reason: mod.reason || null,
      duration: mod.duration || 'fight',
      removedAfterConsecutiveLosses: removedAfter,
    });
  }

  // Evaluate damage_interactions (schema v1.5) once at combat start, the
  // same way combat_modifiers are frozen. We merge the combat event's
  // `damage_interactions` with the `intrinsic_damage_interactions` from
  // each enemy's catalog entry, evaluate each entry's optional condition,
  // and freeze the passing entries on state.combat.appliedDamageInteractions.
  // Condition filtering happens once here; source-tag filtering happens
  // per damage component per round in runCombatRound, because the source
  // tags are decided by the round_script each round.
  const eventInteractions = event.damage_interactions || [];
  const intrinsicInteractions = [];
  for (const en of enemies) {
    const cat = en.data || {};
    if (Array.isArray(cat.intrinsic_damage_interactions)) {
      intrinsicInteractions.push(...cat.intrinsic_damage_interactions);
    }
  }
  const appliedDamageInteractions = [];
  for (const inter of [...eventInteractions, ...intrinsicInteractions]) {
    if (inter.condition && !evalCondition(inter.condition, state, book)) continue;
    const kind = inter.kind;
    if (kind !== 'immunity' && kind !== 'resistance' && kind !== 'weakness') continue;
    const defaultMult = kind === 'immunity' ? 0 : kind === 'resistance' ? 0.5 : 2;
    const multiplier = typeof inter.multiplier === 'number' ? inter.multiplier : defaultMult;
    appliedDamageInteractions.push({
      kind,
      multiplier,
      direction: inter.direction || 'incoming',
      source_has_any: Array.isArray(inter.source_has_any) ? inter.source_has_any.slice() : null,
      source_lacks_all: Array.isArray(inter.source_lacks_all) ? inter.source_lacks_all.slice() : null,
      reason: inter.reason || null,
    });
  }

  // Evaluate damage_caps (schema v1.15+, Rule 32) once at combat start, the
  // same way damage_interactions are frozen. Merge the combat event's
  // `damage_caps` with each enemy's `intrinsic_damage_caps`, evaluate each
  // entry's optional condition, and freeze passing entries on
  // state.combat.appliedDamageCaps. Each round, after interactions scale
  // per-component damage and components sum into per-direction totals,
  // matching caps bound the totals at min(total, cap.max). Distinguished
  // from damage_interactions (multiplicative on components) — caps are
  // absolute bounds on the post-interaction TOTAL.
  const eventCaps = Array.isArray(event.damage_caps) ? event.damage_caps : [];
  const intrinsicCaps = [];
  for (const en of enemies) {
    const cat = en.data || {};
    if (Array.isArray(cat.intrinsic_damage_caps)) {
      intrinsicCaps.push(...cat.intrinsic_damage_caps);
    }
  }
  const appliedDamageCaps = [];
  for (const cap of [...eventCaps, ...intrinsicCaps]) {
    if (cap.condition && !evalCondition(cap.condition, state, book)) continue;
    if (typeof cap.max !== 'number' || cap.max < 0) continue;
    appliedDamageCaps.push({
      max: cap.max,
      direction: cap.direction || 'outgoing',
      reason: cap.reason || null,
      // Schema v1.19+ (Rule 32 min_attacker_margin extension): preserve the
      // optional per-round margin gate so the per-round cap evaluator can
      // apply the gate-and-cap semantic. The gate itself is evaluated each
      // round against combat.attacker_margin (set by the round_script), not
      // frozen at combat start like the cap.condition.
      min_attacker_margin: typeof cap.min_attacker_margin === 'number' ? cap.min_attacker_margin : null,
    });
  }

  state.combat = {
    enemies,
    // Schema v1.20+ (Rule 36): list of enemy catalog ids in scope for this
    // combat, so collectTriggeredEffects can walk enemies_catalog[].triggered_effects[].
    enemyRefs: enemies.map(en => en.ref).filter(r => typeof r === 'string'),
    currentEnemyIdx: 0,
    mode: event.mode || 'sequential',
    winTo: event.win_to,
    fleeTo: event.flee_to,
    specialRules: event.special_rules,
    // Schema v1.13+ (Rule 31): non-defeat win condition. When set,
    // checkCombatEnd ends the fight in victory once combat.round
    // reaches this threshold, regardless of remaining enemy health.
    winAfterRounds: event.win_after_rounds,
    // Schema v1.23+ (Rule 38): round-cap auto-end. When set,
    // checkCombatEnd ends the fight WITHOUT a verdict once combat.round
    // reaches this threshold. Distinct from winAfterRounds (treated as
    // victory): this is the broken-off semantic. Routes to endTo if
    // set, otherwise falls through to the section's choices.
    endAfterRounds: event.end_after_rounds,
    endTo: event.end_to,
    // Schema v1.23+ (Rule 38): round-gate on flee. When set, the flee
    // action is rejected until combat.round >= fleeAvailableAfterRound.
    // Only meaningful when fleeTo is also set.
    fleeAvailableAfterRound: event.flee_available_after_round,
    // Frozen, condition-evaluated modifier list for this combat.
    appliedModifiers,
    // Frozen, condition-evaluated damage_interactions list for this combat.
    // Source filtering happens per-round per-component in runCombatRound.
    appliedDamageInteractions,
    // Schema v1.15+ (Rule 32): frozen, condition-evaluated damage_caps
    // bounding the post-interaction per-round damage total per direction.
    appliedDamageCaps,
    round: 0,
    lastRoundResult: null,
    awaitingPostRound: false,
    // Schema v1.14+ (Rule 17 modifier-expiry-on-loss-streak): per-fight
    // counter, incremented post-round when the player took more damage
    // than the enemy, reset on any other outcome (tie, player win, or
    // no-damage round). Used to gate combat_modifiers carrying a
    // `removed_after_consecutive_losses` threshold.
    consecutiveLosses: 0,
    // Schema v1.30+ / Rule 46. Per-fight wound counters distinct from
    // consecutiveLosses (which is a streak that resets on non-loss rounds).
    // wounds counters are monotonic across the fight and drive the
    // interrupt-after-N-wounds checks below. Reset to 0 on every combat
    // start AND on every Rule 46 resume — each resumed combat gets its
    // own interrupt window. Increment per the round_script's last_result
    // tag ('player_wounds_enemy' → woundsDealt++; 'enemy_wounds_player'
    // → woundsTaken++; tie / simultaneous / no-damage rounds do not
    // increment).
    woundsDealt: 0,
    woundsTaken: 0,
    interruptAfterPlayerWounds: event.interrupt_after_player_wounds || null,
    interruptAfterEnemyWounds: event.interrupt_after_enemy_wounds || null,
    interruptAfterRounds: event.interrupt_after_rounds || null,
    // Rule 46 lifecycle context — preserved on combat so checkCombatEnd
    // can know whether a 'mode: resume' continuation that subsequently
    // completes normally should still produce on_combat_end dispatches
    // (yes: a resumed combat ending normally clears activeCombat AND
    // fires on_combat_end as usual). Currently informational; the
    // checkCombatEnd / interrupt paths read activeCombat directly.
    lifecycleMode,
  };

  // Rule 36 on_combat_start triggers (schema v1.20+): fire after frozen
  // modifiers / damage_interactions / damage_caps resolve and state.combat
  // is initialized. Enemies in this combat contribute their on_combat_start
  // triggered_effects too.
  dispatchLifecycleTriggers(state, book, 'on_combat_start', { combatScope: true });

  state.pause = { type: 'combat' };
  return 'pause';
}

function presentSection(state, book) {
  state.pause = { type: 'section', section: state.currentSection };
  return state;
}

// ==================== ACTION DISPATCH ====================

function getAvailableActions(state, book) {
  const actions = [];
  if (!state.pause) return actions;

  switch (state.pause.type) {
    case 'frontmatter':
      actions.push({ name: 'next_page', description: 'Continue to next frontmatter page' });
      actions.push({ name: 'skip_frontmatter', description: 'Skip directly to character creation' });
      break;

    case 'character_creation_roll':
      actions.push({ name: 'roll', description: `Roll ${state.pause.formula} for ${state.pause.stat} (or provide_roll <values>)` });
      actions.push({ name: 'provide_roll', description: 'Manually provide roll values: provide_roll <n1> <n2> ...' });
      break;

    case 'character_creation_roll_resource':
      actions.push({ name: 'roll', description: `Roll ${state.pause.formula} for ${state.pause.resource} (or provide_roll <values>)` });
      actions.push({ name: 'provide_roll', description: 'Manually provide roll values: provide_roll <n1> <n2> ...' });
      break;

    case 'character_creation_roll_table':
      actions.push({ name: 'roll', description: `Roll ${state.pause.formula} on the character-creation table (or provide_roll <values>)` });
      actions.push({ name: 'provide_roll', description: 'Manually provide roll values: provide_roll <n1> <n2> ...' });
      break;

    case 'character_creation_choose_one':
      for (const opt of state.pause.options) {
        actions.push({ name: 'choose', description: `choose ${JSON.stringify(opt)}` });
      }
      break;

    case 'character_creation_choose_abilities':
      actions.push({ name: 'choose_abilities', description: `Pick ${state.pause.count} from: ${state.pause.available.join(', ')}` });
      break;

    case 'character_creation_choose_talents':
      actions.push({ name: 'choose_talents', description: `Pick ${state.pause.count} from: ${state.pause.available.join(', ')}` });
      break;

    case 'character_creation_distribute': {
      const parts = state.pause.stats.map(s => `${s.name}=<${s.min}..${s.max}>`).join(' ');
      actions.push({
        name: 'distribute',
        description: `Distribute exactly ${state.pause.total_points} points: distribute ${parts}`,
      });
      break;
    }

    case 'section':
      // Choices
      const choices = state.pendingChoices || [];
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i];
        const ok = evalCondition(c.condition, state, book);
        const target = c.target;
        actions.push({
          name: 'choose_section',
          arg: i,
          target: target,
          text: c.text,
          available: ok,
          reason: ok ? null : describeCondition(c.condition),
        });
      }
      // Rule 36 on_user_use (schema v1.20+): list items in inventory whose
      // triggered_effects[] has an on_user_use trigger reachable from the
      // current context (in_section or anywhere). Player initiates via
      // `use <item_id>`.
      {
        const cat = book.items_catalog || {};
        for (const itemId of state.inventory) {
          const def = cat[itemId];
          if (!def || !Array.isArray(def.triggered_effects)) continue;
          const hasUseHere = def.triggered_effects.some(te => {
            if (!te || te.trigger !== 'on_user_use') return false;
            const ctx = te.context || 'anywhere';
            return ctx === 'anywhere' || ctx === 'in_section';
          });
          if (hasUseHere) {
            actions.push({ name: 'use', arg: itemId, description: `Use ${def.name || itemId}` });
          }
        }
      }
      // Equipment actions (schema v1.5+): list equip/unequip options for
      // any equippable item in inventory. Gated by equip_timing via
      // canEquipItem/canUnequipItem so out_of_combat items only show up
      // outside of combat (which is the case here — we're in a section
      // pause, not a combat pause).
      {
        const catalog = book.items_catalog || {};
        for (const itemId of state.inventory) {
          const item = catalog[itemId];
          if (!item || !item.equippable) continue;
          if (isItemEquipped(state, itemId)) {
            const check = canUnequipItem(state, book, itemId);
            if (check.ok) {
              actions.push({
                name: 'unequip',
                arg: itemId,
                description: `Unequip ${itemId} from ${item.slot}`,
              });
            }
          } else {
            const check = canEquipItem(state, book, itemId, false);
            if (check.ok) {
              actions.push({
                name: 'equip',
                arg: itemId,
                description: `Equip ${itemId} in ${item.slot}`,
              });
            }
          }
        }
      }
      break;

    case 'stat_test':
      actions.push({ name: 'roll', description: `Test ${state.pause.event.stat} (provide_roll for manual)` });
      actions.push({ name: 'provide_roll', description: 'provide_roll <n1> <n2> ...' });
      break;

    case 'roll_dice':
      actions.push({ name: 'roll', description: `Roll ${state.pause.event.dice}` });
      actions.push({ name: 'provide_roll', description: 'provide_roll <n1> <n2> ...' });
      break;

    case 'eat_meal':
      if (state.provisions > 0 || state.meals > 0) {
        actions.push({ name: 'eat', description: 'Eat a meal' });
      }
      // Rule 25 (schema v1.9+): named consumables with
      // consume.satisfies_eat_meal: true appear as alternative eat
      // actions. The action name is `eat_<itemId>` so the applyAction
      // dispatcher can identify which item to consume.
      for (const id of getNamedConsumables(state, book)) {
        const entry = (book.items_catalog || {})[id];
        const displayName = (entry && entry.name) || id;
        actions.push({ name: `eat_${id}`, description: `Eat ${displayName} (named consumable)` });
      }
      if (!state.pause.event.required) {
        actions.push({ name: 'skip', description: 'Skip the meal' });
      }
      break;

    case 'input_number':
      actions.push({ name: 'submit_number', description: 'submit_number <N>' });
      break;

    case 'input_text':
      actions.push({ name: 'submit_text', description: 'submit_text <text>' });
      break;

    case 'choose_items':
      actions.push({ name: 'select_items', description: `Choose ${state.pause.event.count} items: select_items <id1> <id2> ...` });
      break;

    case 'combat':
      const combat = state.combat;
      if (combat.awaitingPostRound) {
        const cs = (typeof book.rules?.combat_system === 'object' ? book.rules.combat_system : null) || book.rules?.combat_rules_detail;
        actions.push({ name: 'post_round', description: cs?.post_round_label || 'Post-round action' });
        actions.push({ name: 'skip_post_round', description: 'Skip post-round action' });
      } else {
        actions.push({ name: 'attack', description: 'Attack' });
        if (combat.fleeTo) {
          // Schema v1.23+ (Rule 38): hide flee action until the round-gate
          // window opens. Player can still attempt to flee earlier — the
          // act handler will reject with a log line — but the canonical
          // surface is to omit it from the action list so an automated
          // harness sees the action as unavailable until round N.
          const fleeRoundGate = combat.fleeAvailableAfterRound;
          const fleeReady = fleeRoundGate === undefined || fleeRoundGate === null || combat.round >= fleeRoundGate;
          if (fleeReady) actions.push({ name: 'flee', description: 'Flee' });
        }
      }
      // Rule 36 on_user_use (schema v1.20+, in-combat context): list items
      // whose triggered_effects[] has on_user_use reachable from combat.
      {
        const cat = book.items_catalog || {};
        for (const itemId of state.inventory) {
          const def = cat[itemId];
          if (!def || !Array.isArray(def.triggered_effects)) continue;
          const hasUseHere = def.triggered_effects.some(te => {
            if (!te || te.trigger !== 'on_user_use') return false;
            const ctx = te.context || 'anywhere';
            return ctx === 'anywhere' || ctx === 'in_combat';
          });
          if (hasUseHere) {
            actions.push({ name: 'use', arg: itemId, description: `Use ${def.name || itemId}` });
          }
        }
      }
      actions.push({ name: 'provide_roll', description: 'For next attack: provide_roll <values>' });
      // Equip/unequip actions for items with equip_timing: "always". Items
      // with equip_timing: "out_of_combat" are not listed here because
      // canEquipItem/canUnequipItem reject them while combat is active.
      {
        const catalog = book.items_catalog || {};
        for (const itemId of state.inventory) {
          const item = catalog[itemId];
          if (!item || !item.equippable) continue;
          if (isItemEquipped(state, itemId)) {
            const check = canUnequipItem(state, book, itemId);
            if (check.ok) {
              actions.push({ name: 'unequip', arg: itemId, description: `Unequip ${itemId} from ${item.slot}` });
            }
          } else {
            const check = canEquipItem(state, book, itemId, false);
            if (check.ok) {
              actions.push({ name: 'equip', arg: itemId, description: `Equip ${itemId} in ${item.slot}` });
            }
          }
        }
      }
      break;

    case 'ending':
      actions.push({ name: 'restart', description: 'Start over' });
      break;
  }

  // Universal actions (always available)
  actions.push({ name: 'state', description: 'Print full state' });
  actions.push({ name: 'manual_set', description: 'manual_set <key> <value> — debug escape hatch' });

  return actions;
}

function applyAction(state, book, action, args) {
  args = args || [];

  // Universal actions
  if (action === 'state') return state;
  if (action === 'queue_script_rolls') {
    // Queue forced rolls to be consumed by the next `script` event.
    // Each arg is a comma-separated set of numbers for one roll() call,
    // e.g. `queue_script_rolls 1,1 6,6` forces the first roll() in the
    // next script event to return 1,1 and the second to return 6,6.
    if (!Array.isArray(state.forcedScriptRolls)) state.forcedScriptRolls = [];
    for (const a of args) {
      state.forcedScriptRolls.push(a.split(',').map(Number));
    }
    state.log.push(`Queued ${args.length} forced roll set(s) for next script event`);
    return state;
  }
  if (action === 'set_clock') {
    // Force the wall-clock value that get_clock() will return in subsequent
    // script events. Args: <wday> <hour> [minute]. wday is 1..7 (1=Sun,
    // 7=Sat) to match the os.date('*t') convention. Use clear_clock (or
    // set_clock with no args) to revert to the real clock.
    if (args.length === 0) {
      state.forcedClock = null;
      state.log.push('Cleared forced clock (get_clock will use real time)');
    } else {
      const wday = parseInt(args[0], 10);
      const hour = parseInt(args[1], 10);
      const minute = args.length > 2 ? parseInt(args[2], 10) : 0;
      state.forcedClock = { wday, hour, minute };
      state.log.push(`Forced clock: wday=${wday} hour=${hour} minute=${minute}`);
    }
    return state;
  }
  if (action === 'manual_set') {
    const [key, ...vals] = args;
    const val = vals.join(' ');
    // Try to parse as number/JSON
    let parsed;
    try { parsed = JSON.parse(val); } catch { parsed = val; }
    // Record the invocation BEFORE applying it so the Tier 3 partial
    // marker survives even if the apply path throws. The record is
    // deliberately prominent in both the log and the structured
    // `state.manualSets` array — these are the two channels the
    // playbook harness consumes (log tail for humans, manualSets for
    // the JSON envelope's `tier3_status` field).
    if (!Array.isArray(state.manualSets)) state.manualSets = [];
    state.manualSets.push({
      key,
      value: parsed,
      section: state.currentSection,
      creationStep: state.creationDone ? null : state.creationStep,
    });
    state.log.push(`!!! manual_set ${key}=${val} — run will be reported as TIER 3 PARTIAL !!!`);
    if (key.startsWith('stats.')) {
      state.stats[key.slice(6)] = parsed;
    } else if (key === 'currentSection') {
      navigateTo(state, book, parsed);
    } else {
      state[key] = parsed;
    }
    return state;
  }

  if (!state.pause) {
    state.log.push(`ERROR: No pause to act on`);
    return state;
  }

  switch (state.pause.type) {
    case 'frontmatter':
      if (action === 'next_page') {
        state.frontmatterPage++;
        const total = (book.frontmatter?.pages || []).length;
        if (state.frontmatterPage >= total) {
          state.frontmatterDone = true;
          return startCharacterCreation(state, book);
        }
      } else if (action === 'skip_frontmatter') {
        state.frontmatterDone = true;
        return startCharacterCreation(state, book);
      }
      break;

    case 'character_creation_roll': {
      const step = book.character_creation.steps[state.pause.step_index];
      let result;
      if (action === 'provide_roll') {
        const vals = args.map(Number);
        result = rollDice(step.formula, vals);
      } else {
        result = rollDice(step.formula);
      }
      state.stats[step.stat] = result.total;
      state.initialStats[step.stat] = result.total;
      state.log.push(`Rolled ${step.formula} = ${result.rolls.join(',')} => ${step.stat} ${result.total}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'character_creation_roll_resource': {
      // Schema v1.6+ / codex v2.9+ roll_resource action. Roll the
      // formula, then route the total into the canonical slot named
      // by step.resource. Canonical lowercase names (`gold`,
      // `provisions`, `meals`) write directly to the corresponding
      // state field; any other name falls through to a declared
      // stat lookup in rules.stats[] (this supports books that
      // carry currency as a first-class stat, e.g. GrailQuest's
      // `GOLD`). Unknown resource names log a warning and the
      // value is discarded — the codex rule forbids this shape,
      // so reaching the warning means the book has a data bug.
      const step = book.character_creation.steps[state.pause.step_index];
      let result;
      if (action === 'provide_roll') {
        const vals = args.map(Number);
        result = rollDice(step.formula, vals);
      } else {
        result = rollDice(step.formula);
      }
      const total = result.total;
      const rname = step.resource;
      if (rname === 'gold') {
        state.gold = total;
      } else if (rname === 'provisions') {
        state.provisions = total;
      } else if (rname === 'meals') {
        state.meals = total;
      } else {
        const statDefs = book.rules?.stats || [];
        const matchingStat = statDefs.find(s => s.name === rname);
        if (matchingStat) {
          state.stats[rname] = total;
          if (matchingStat.initial_is_max) state.initialStats[rname] = total;
        } else {
          state.log.push(`roll_resource: unknown resource "${rname}" (not canonical, not a declared stat); value ${total} discarded`);
        }
      }
      state.log.push(`Rolled ${step.formula} = ${result.rolls.join(',')} => ${rname} ${total}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'character_creation_roll_table': {
      // Schema v1.22+ / codex v2.29+ (Rule 11 extension). Roll the
      // formula, find the matching entry in the step's results map
      // (single key or inclusive range, same syntax as roll_dice.results
      // keys), and apply each effect in the matched entry's effects[]
      // array via handleEvent. The rolled value itself is ephemeral —
      // NOT written to any stat slot. Only chargen-safe non-pausing
      // event types are legal in effects[]; if an inner event returns
      // 'pause' or 'navigate' the chargen flow is broken (the schema
      // forbids interactive event types here — see Rule 11 v2.29.0
      // subsection). The common case is all modify_stat / add_item /
      // set_flag / clear_flag / set_resource events.
      const step = book.character_creation.steps[state.pause.step_index];
      let result;
      if (action === 'provide_roll') {
        const vals = args.map(Number);
        result = rollDice(step.formula, vals);
      } else {
        result = rollDice(step.formula);
      }
      const results = step.results || {};
      let matchedEntry = null, matchedKey = null;
      if (results[String(result.total)]) {
        matchedEntry = results[String(result.total)];
        matchedKey = String(result.total);
      } else {
        for (const [key, val] of Object.entries(results)) {
          if (key.includes('-')) {
            const [lo, hi] = key.split('-').map(Number);
            if (result.total >= lo && result.total <= hi) {
              matchedEntry = val;
              matchedKey = key;
              break;
            }
          }
        }
      }
      state.log.push(`Rolled ${step.formula} = ${result.rolls.join(',')} => ${result.total}${matchedKey ? ` (matches ${matchedKey})` : ' (no result-table match)'}`);
      if (matchedEntry) {
        if (matchedEntry.text) state.log.push(matchedEntry.text);
        if (Array.isArray(matchedEntry.effects)) {
          for (const subEvent of matchedEntry.effects) {
            const sub = handleEvent(subEvent, state, book);
            if (sub === 'pause' || sub === 'navigate') {
              state.log.push('[Warning: roll_table effects[] must hold only chargen-safe non-pausing events. Remaining effects skipped.]');
              break;
            }
          }
        }
      }
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'character_creation_choose_one': {
      const step = book.character_creation.steps[state.pause.step_index];
      const choice = args.join(' ');
      if (step.category === 'potion') {
        state.potion = { name: choice, doses: book.rules?.potion?.doses || 2 };
        const id = choice.toLowerCase().replace(/ /g, '_');
        addItemToInventory(state, book, id, 1);
      } else {
        const flagName = `${step.category}_${choice.toLowerCase().replace(/ /g, '_')}`;
        if (!state.flags.includes(flagName)) state.flags.push(flagName);
      }
      state.log.push(`Chose ${step.category}: ${choice}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'character_creation_choose_abilities': {
      // Schema v1.18+ / codex Rule 35. The player's submitted set is
      // first validated against per-entry `exclusive_with` lists from
      // rules.abilities.available[]; any violation rejects the whole
      // submission with a per-violation log line and leaves the pause
      // intact. After validation passes, each chosen entry's `effects[]`
      // (if present) is applied via applyEvent in array order against
      // the in-flight state — so Bushcraft's +5 initial Endurance, etc.,
      // lands at confirm time. Pre-v1.18 books with no effects/no
      // exclusive_with on their ability entries continue to work
      // unchanged (effects default to no-op, exclusive_with defaults to
      // empty).
      const chosen = args;
      const available = book.rules?.abilities?.available || [];
      const byName = {};
      for (const a of available) byName[a.name] = a;
      const violations = [];
      for (const pick of chosen) {
        const entry = byName[pick];
        if (!entry || !Array.isArray(entry.exclusive_with)) continue;
        for (const other of chosen) {
          if (other === pick) continue;
          if (entry.exclusive_with.includes(other)) {
            violations.push(`${pick} is mutually exclusive with ${other}`);
          }
        }
      }
      if (violations.length) {
        for (const v of violations) state.log.push(`choose_abilities rejected: ${v}`);
        return state;
      }
      state.abilities = [...chosen];
      for (const name of chosen) {
        const flag = 'ability_' + name.toLowerCase().replace(/ /g, '_');
        if (!state.flags.includes(flag)) state.flags.push(flag);
      }
      // Auto-apply effects from each chosen ability entry.
      for (const pick of chosen) {
        const entry = byName[pick];
        if (!entry || !Array.isArray(entry.effects)) continue;
        for (const ev of entry.effects) {
          handleEvent(ev, state, book);
        }
      }
      state.log.push(`Chose abilities: ${chosen.join(', ')}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'character_creation_choose_talents': {
      // Schema v1.18+ / codex Rule 35. Mirror of choose_abilities — same
      // exclusive_with validation, same effects-application loop, same
      // post-confirm flow into processCreationSteps. Picks are written
      // to state.talents (parallel to state.abilities); each chosen
      // talent's name also lands as a `talent_<canonical>` flag for
      // condition-shape symmetry with `ability_<canonical>` flags. See
      // codex Rule 35 for the full pattern.
      const chosen = args;
      const available = book.rules?.talents?.available || [];
      const byName = {};
      for (const t of available) byName[t.name] = t;
      const violations = [];
      for (const pick of chosen) {
        const entry = byName[pick];
        if (!entry || !Array.isArray(entry.exclusive_with)) continue;
        for (const other of chosen) {
          if (other === pick) continue;
          if (entry.exclusive_with.includes(other)) {
            violations.push(`${pick} is mutually exclusive with ${other}`);
          }
        }
      }
      if (violations.length) {
        for (const v of violations) state.log.push(`choose_talents rejected: ${v}`);
        return state;
      }
      state.talents = [...chosen];
      for (const name of chosen) {
        const flag = 'talent_' + name.toLowerCase().replace(/ /g, '_');
        if (!state.flags.includes(flag)) state.flags.push(flag);
      }
      for (const pick of chosen) {
        const entry = byName[pick];
        if (!entry || !Array.isArray(entry.effects)) continue;
        for (const ev of entry.effects) {
          handleEvent(ev, state, book);
        }
      }
      state.log.push(`Chose talents: ${chosen.join(', ')}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'character_creation_distribute': {
      // Schema v1.10+ / codex v2.13+ (Rule 26). args is a list of
      // `<stat_name>=<value>` pairs. Parse, then validate: every stat
      // named in the pause descriptor is present exactly once; each
      // value is an integer within the declared [min, max] range; the
      // sum of values equals total_points exactly. Invalid allocations
      // leave the pause intact so the harness can correct and retry.
      if (action !== 'distribute') {
        state.log.push(`Expected 'distribute' action during character_creation_distribute pause, got '${action}'`);
        return state;
      }
      const declared = state.pause.stats;
      const total = state.pause.total_points;
      const allocation = {};
      for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq < 0) {
          state.log.push(`distribute: malformed pair "${arg}" (expected stat=value)`);
          return state;
        }
        const name = arg.slice(0, eq);
        const valStr = arg.slice(eq + 1);
        const val = parseInt(valStr, 10);
        if (!Number.isFinite(val) || String(val) !== valStr.trim()) {
          state.log.push(`distribute: non-integer value "${valStr}" for ${name}`);
          return state;
        }
        if (allocation[name] !== undefined) {
          state.log.push(`distribute: duplicate allocation for "${name}"`);
          return state;
        }
        allocation[name] = val;
      }
      for (const s of declared) {
        if (allocation[s.name] === undefined) {
          state.log.push(`distribute: missing allocation for "${s.name}"`);
          return state;
        }
        const v = allocation[s.name];
        if (v < s.min || v > s.max) {
          state.log.push(`distribute: ${s.name}=${v} outside range [${s.min}, ${s.max}]`);
          return state;
        }
      }
      const declaredNames = new Set(declared.map(s => s.name));
      for (const name of Object.keys(allocation)) {
        if (!declaredNames.has(name)) {
          state.log.push(`distribute: unknown stat "${name}" (not in this step's stats list)`);
          return state;
        }
      }
      const sum = declared.reduce((a, s) => a + allocation[s.name], 0);
      if (sum !== total) {
        state.log.push(`distribute: allocated sum ${sum} does not equal total_points ${total}`);
        return state;
      }
      for (const s of declared) {
        const v = allocation[s.name];
        state.stats[s.name] = v;
        state.initialStats[s.name] = v;
      }
      state.log.push(`Distributed ${total} points: ${declared.map(s => `${s.name}=${allocation[s.name]}`).join(', ')}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'section':
      if (action === 'use') {
        const itemId = args[0];
        if (!itemId) { state.log.push('use requires an item_id argument'); return state; }
        if (!state.inventory.includes(itemId)) {
          state.log.push(`Cannot use ${itemId}: not in inventory`);
          return state;
        }
        return runUserUse(state, book, itemId);
      }
      if (action === 'equip') {
        const itemId = args[0];
        if (!itemId) {
          state.log.push('equip requires an item_id argument');
          return state;
        }
        if (!state.inventory.includes(itemId)) {
          state.log.push(`Cannot equip ${itemId}: not in inventory`);
          return state;
        }
        const check = canEquipItem(state, book, itemId, false);
        if (!check.ok) {
          state.log.push(`Cannot equip ${itemId}: ${check.reason}`);
          return state;
        }
        equipItem(state, book, itemId);
        return state;
      }
      if (action === 'unequip') {
        const itemId = args[0];
        if (!itemId) {
          state.log.push('unequip requires an item_id argument');
          return state;
        }
        if (!isItemEquipped(state, itemId)) {
          state.log.push(`Cannot unequip ${itemId}: not currently equipped`);
          return state;
        }
        const check = canUnequipItem(state, book, itemId);
        if (!check.ok) {
          state.log.push(`Cannot unequip ${itemId}: ${check.reason}`);
          return state;
        }
        // Find which slot it's in.
        const item = getItemDef(book, itemId);
        if (item && item.slot) {
          unequipSlot(state, book, item.slot);
        }
        return state;
      }
      if (action === 'choose_section') {
        const idx = parseInt(args[0]);
        const choices = state.pendingChoices || [];
        const choice = choices[idx];
        if (!choice) {
          state.log.push(`Invalid choice index: ${idx}`);
          return state;
        }
        if (!evalCondition(choice.condition, state, book)) {
          state.log.push(`Choice not available: ${describeCondition(choice.condition)}`);
          return state;
        }
        if (choice.target == null) {
          // Section-level test handler
          const section = book.sections[state.currentSection];
          if (section.luck_test || section.skill_test) {
            const test = section.luck_test || section.skill_test;
            const stat = section.luck_test ? 'luck' : 'skill';
            state.eventQueue.unshift({
              type: 'stat_test',
              stat,
              success_to: test.success_to,
              failure_to: test.failure_to,
              deduct_after: stat === 'luck',
              deduct_stat: 'luck',
              deduct_amount: 1,
            });
            return processNextEvent(state, book);
          }
          state.log.push(`Choice has null target and no section-level test`);
          return state;
        }
        return navigateTo(state, book, choice.target);
      }
      break;

    case 'stat_test': {
      const event = state.pause.event;
      const stat = event.stat;
      const statVal = state.stats[stat] || 0;
      let result;
      if (action === 'provide_roll') {
        result = rollDice('2d6', args.map(Number));
      } else {
        result = rollDice('2d6');
      }
      const success = result.total <= statVal;
      state.lastTestResult = success;
      state.lastRoll = result;
      if (event.deduct_after) {
        const ds = event.deduct_stat || stat;
        const da = event.deduct_amount || 1;
        state.stats[ds] = Math.max(0, (state.stats[ds] || 0) - da);
      }
      if (!success && event.failure_penalty) {
        // Schema v1.33+ (Rule 49): failure_penalty accepts either a single
        // {stat, amount} object (pre-v1.33 shape) or an array of them
        // (multi-penalty shape, e.g. Warlock §361's -2 SKILL AND -3 STAMINA
        // poison-gas failure). Normalize to array then apply each in order.
        const penalties = Array.isArray(event.failure_penalty) ? event.failure_penalty : [event.failure_penalty];
        for (const p of penalties) {
          if (p && p.stat) {
            state.stats[p.stat] = (state.stats[p.stat] || 0) + (p.amount || 0);
          }
        }
      }
      state.log.push(`Test ${stat}: rolled ${result.rolls.join(',')}=${result.total} vs ${statVal} → ${success ? 'SUCCESS' : 'FAILURE'}`);
      state.pause = null;
      if (success && event.success_to) return navigateTo(state, book, event.success_to);
      if (!success && event.failure_to) return navigateTo(state, book, event.failure_to);
      return processNextEvent(state, book);
    }

    case 'roll_dice': {
      const event = state.pause.event;
      const dice = event.dice || '2d6';
      let result;
      if (action === 'provide_roll') {
        result = rollDice(dice, args.map(Number));
      } else {
        result = rollDice(dice);
      }
      state.lastRoll = result;
      state.log.push(`Rolled ${dice}: ${result.rolls.join(',')} = ${result.total}`);

      // apply_to_stat
      if (event.apply_to_stat) {
        const stat = event.apply_to_stat;
        const isAdd = event.amount_sign === 'positive';
        const amount = isAdd ? result.total : -result.total;
        state.stats[stat] = Math.max(0, (state.stats[stat] || 0) + amount);
        state.log.push(`Applied to ${stat}: ${amount >= 0 ? '+' : ''}${amount}`);
        state.pause = null;
        return processNextEvent(state, book);
      }

      // Result table lookup
      const results = event.results || {};
      let target = null, matched = false, resultText = '', matchedEntry = null;
      if (results[String(result.total)]) {
        matched = true;
        matchedEntry = results[String(result.total)];
        target = matchedEntry.target;
        resultText = matchedEntry.text || matchedEntry.note || '';
      } else {
        for (const [key, val] of Object.entries(results)) {
          if (key.includes('-')) {
            const [lo, hi] = key.split('-').map(Number);
            if (result.total >= lo && result.total <= hi) {
              matched = true;
              matchedEntry = val;
              target = val.target;
              resultText = val.text || val.note || '';
              break;
            }
          }
        }
      }
      if (resultText) state.log.push(resultText);
      state.pause = null;
      // Rule 44 (schema v1.27+): if the matched range carries an `outcome`
      // tag, record it on state.lastTestResult so subsequent test_succeeded
      // / test_failed conditions in this section (or the navigated-to
      // section) see the binary outcome of the roll. Applied BEFORE the
      // per-range effects and target navigation so an effect or downstream
      // condition can read the freshly-set value. Opt-in: results entries
      // without an `outcome` tag leave lastTestResult unchanged.
      if (matched && matchedEntry && matchedEntry.outcome) {
        if (matchedEntry.outcome === 'success') state.lastTestResult = true;
        else if (matchedEntry.outcome === 'failure') state.lastTestResult = false;
      }
      // Per-range effects (Rule 22, schema v1.8+). Effects fire AFTER the
      // range match and BEFORE the target navigation, so a branch can both
      // mutate state and move the player in a single roll_dice event. Each
      // effect is a full event object — modify_stat, add_item, remove_item,
      // remove_inventory_category, set_flag, etc. Applied synchronously
      // via handleEvent; the common case is all non-pausing events. If an
      // inner event pauses (unsupported per Rule 22 — use a `script` event
      // instead for that shape), we log a warning and skip the rest; if it
      // navigates (e.g. a nested script sets navigate_to), that navigation
      // shadows the range's target.
      if (matched && matchedEntry && Array.isArray(matchedEntry.effects)) {
        for (const subEvent of matchedEntry.effects) {
          const subResult = handleEvent(subEvent, state, book);
          if (subResult === 'navigate') return state;
          if (subResult === 'pause') {
            state.log.push('[Warning: roll_dice per-range effects do not support pausing events; remaining effects and target navigation skipped. Use a script event for this shape per Rule 22.]');
            return state;
          }
        }
      }
      if (target) return navigateTo(state, book, target);
      if (matched) return processNextEvent(state, book);
      state.log.push(`No result for ${result.total}`);
      return processNextEvent(state, book);
    }

    case 'eat_meal': {
      const event = state.pause.event;
      const hasFood = state.provisions > 0 || state.meals > 0;
      // Rule 25 (schema v1.9+): action `eat_<itemId>` consumes a named
      // consumable whose items_catalog entry declares
      // consume.satisfies_eat_meal: true. Remove one of the item (plus
      // auto-unequip), dispatch consume.effects synchronously, and
      // satisfy the eat_meal prompt WITHOUT decrementing provisions.
      if (action.startsWith('eat_') && action !== 'eat') {
        const itemId = action.slice(4);
        const catalog = book.items_catalog || {};
        const entry = catalog[itemId];
        if (!entry || !entry.consume || entry.consume.satisfies_eat_meal !== true || !state.inventory.includes(itemId)) {
          state.log.push(`Cannot consume ${itemId}: not a valid named consumable in inventory`);
          return state;
        }
        const idx = state.inventory.indexOf(itemId);
        if (idx >= 0) state.inventory.splice(idx, 1);
        autoUnequipOnRemove(state, itemId);
        state.log.push(`Consumed ${entry.name || itemId} as a meal`);
        if (Array.isArray(entry.consume.effects)) {
          for (const subEvent of entry.consume.effects) {
            const subResult = handleEvent(subEvent, state, book);
            if (subResult === 'pause') {
              state.log.push('[Warning: consume.effects do not support pausing events; remaining effects skipped. Use section-level events for pause-requiring shapes per Rule 25.]');
              break;
            }
            if (subResult === 'navigate') {
              // Consume effects that navigate are unusual but legal; we
              // let the navigate fire and stop processing further
              // effects. The eat_meal pause is cleared either way.
              state.pause = null;
              return state;
            }
          }
        }
        state.pause = null;
        return processNextEvent(state, book);
      }
      if (action === 'eat' && hasFood) {
        // Normal eat path: decrement food, apply heal.
        const heal = event.heal_amount ?? book.rules?.provisions?.heal_amount ?? 4;
        const stat = event.heal_stat || book.rules?.provisions?.heal_stat || 'stamina';
        if (state.provisions > 0) state.provisions--;
        else if (state.meals > 0) state.meals--;
        const old = state.stats[stat] || 0;
        let newVal = old + heal;
        const statDef = (book.rules?.stats || []).find(s => s.name === stat);
        if (statDef?.initial_is_max && state.initialStats[stat] !== undefined) {
          newVal = Math.min(newVal, state.initialStats[stat]);
        }
        state.stats[stat] = newVal;
        state.log.push(`Ate a meal: +${heal} ${stat}`);
      } else if (action === 'eat' && !hasFood) {
        // Defense in depth: the dispatch path auto-applies the
        // required-meal penalty when hasFood is false, so we should
        // not normally land here. If we do (e.g. the eat action was
        // somehow exposed without food), treat it as the no-food
        // required-meal case.
        if (event.required && typeof event.penalty_amount === 'number' && event.penalty_amount !== 0) {
          const penStat = event.penalty_stat || book.rules?.provisions?.heal_stat || 'endurance';
          const old = state.stats[penStat] || 0;
          state.stats[penStat] = Math.max(0, old + event.penalty_amount);
          state.log.push(`No ${book.rules?.provisions?.display_name || 'provisions'} to eat: ${penStat} ${event.penalty_amount >= 0 ? '+' : ''}${event.penalty_amount}`);
        } else {
          state.log.push('No food available to eat');
        }
      } else {
        // Skip path. If the event is required with a penalty, apply
        // the penalty. getAvailableActions only exposes the skip
        // action when !event.required, so this branch is primarily
        // defensive — it catches the case where a harness or debug
        // override drives `skip` on a required meal.
        if (event.required && typeof event.penalty_amount === 'number' && event.penalty_amount !== 0) {
          const penStat = event.penalty_stat || book.rules?.provisions?.heal_stat || 'endurance';
          const old = state.stats[penStat] || 0;
          state.stats[penStat] = Math.max(0, old + event.penalty_amount);
          state.log.push(`Skipped required meal: ${penStat} ${event.penalty_amount >= 0 ? '+' : ''}${event.penalty_amount}`);
        } else {
          state.log.push('Skipped meal');
        }
      }
      state.pause = null;
      return processNextEvent(state, book);
    }

    case 'input_number': {
      const event = state.pause.event;
      const num = parseInt(args[0]);
      if (isNaN(num)) {
        state.log.push('Invalid number');
        return state;
      }
      state.pause = null;
      if (event.target === 'computed' || !event.target) {
        return navigateTo(state, book, num);
      }
      return navigateTo(state, book, event.target);
    }

    case 'input_text': {
      const event = state.pause.event;
      const text = args.join(' ').trim();
      const results = event.results || event.answers || {};
      const match = results[text.toLowerCase()] || results[text];
      state.pause = null;
      if (match) return navigateTo(state, book, match.target || match);
      if (event.default_to || event.default?.target) return navigateTo(state, book, event.default_to || event.default.target);
      return processNextEvent(state, book);
    }

    case 'choose_items': {
      const event = state.pause.event;
      const selected = args;
      const catalog = book.items_catalog || {};
      // Schema v1.25+ (Rule 40): mode:"remove" — selected items are removed
      // from inventory rather than added. Auto-resolved cases (empty pool /
      // single-eligible) are handled at dispatch time and don't reach here.
      if (event.mode === 'remove') {
        const eligible = state.pause.eligible || [];
        for (const id of selected) {
          if (!eligible.includes(id)) continue; // ignore picks outside the pool
          const idx = state.inventory.indexOf(id);
          if (idx >= 0) state.inventory.splice(idx, 1);
          autoUnequipOnRemove(state, id);
        }
        if (selected.length > 0 && event.on_success_set_flag) {
          if (!state.flags.includes(event.on_success_set_flag)) state.flags.push(event.on_success_set_flag);
        }
        state.log.push(`Removed (player-chosen): ${selected.join(', ')}`);
        state.pause = null;
        return processNextEvent(state, book);
      }
      // Auto items
      for (const id of (event.add_automatic || [])) {
        if (!state.inventory.includes(id)) state.inventory.push(id);
        autoEquipOnAdd(state, book, id);
      }
      // Replace category if needed — also auto-unequip any items being removed.
      if (event.replace_category) {
        const filterKey = Object.keys(event.catalog_filter || {})[0];
        const filterVal = event.catalog_filter[filterKey];
        if (filterKey && filterVal) {
          const kept = [];
          for (const id of state.inventory) {
            const item = catalog[id];
            if (!item || item[filterKey] !== filterVal || (event.add_automatic || []).includes(id)) {
              kept.push(id);
            } else {
              autoUnequipOnRemove(state, id);
            }
          }
          state.inventory = kept;
        }
      }
      for (const id of selected) {
        if (!state.inventory.includes(id)) state.inventory.push(id);
        autoEquipOnAdd(state, book, id);
      }
      state.log.push(`Selected items: ${[...(event.add_automatic || []), ...selected].join(', ')}`);
      state.pause = null;
      return processNextEvent(state, book);
    }

    case 'combat':
      return handleCombatAction(action, args, state, book);
  }

  state.log.push(`Unknown or invalid action: ${action}`);
  return state;
}

function handleCombatAction(action, args, state, book) {
  const combat = state.combat;
  const enemy = combat.enemies[combat.currentEnemyIdx];
  const cs = (typeof book.rules?.combat_system === 'object' ? book.rules.combat_system : null) || book.rules?.combat_rules_detail || {};

  // Equip / unequip during combat: only items with equip_timing: "always"
  // will pass canEquipItem / canUnequipItem here, since combat is active.
  // Out-of-combat items will return a rejection message from the helpers.
  if (action === 'equip') {
    const itemId = args[0];
    if (!itemId) { state.log.push('equip requires an item_id argument'); return state; }
    if (!state.inventory.includes(itemId)) {
      state.log.push(`Cannot equip ${itemId}: not in inventory`);
      return state;
    }
    const check = canEquipItem(state, book, itemId, false);
    if (!check.ok) { state.log.push(`Cannot equip ${itemId}: ${check.reason}`); return state; }
    equipItem(state, book, itemId);
    return state;
  }
  if (action === 'unequip') {
    const itemId = args[0];
    if (!itemId) { state.log.push('unequip requires an item_id argument'); return state; }
    if (!isItemEquipped(state, itemId)) {
      state.log.push(`Cannot unequip ${itemId}: not currently equipped`);
      return state;
    }
    const check = canUnequipItem(state, book, itemId);
    if (!check.ok) { state.log.push(`Cannot unequip ${itemId}: ${check.reason}`); return state; }
    const item = getItemDef(book, itemId);
    if (item && item.slot) unequipSlot(state, book, item.slot);
    return state;
  }

  if (action === 'flee') {
    // Schema v1.23+ / codex v2.30 (Rule 38): round-gate. If
    // fleeAvailableAfterRound is set, reject the flee until the
    // player has fought enough rounds. The combat continues; the
    // player can try again next round.
    if (combat.fleeAvailableAfterRound !== undefined && combat.fleeAvailableAfterRound !== null
        && combat.round < combat.fleeAvailableAfterRound) {
      const missing = combat.fleeAvailableAfterRound - combat.round;
      state.log.push(`Cannot flee yet — must fight ${missing} more round${missing === 1 ? '' : 's'}.`);
      return state;
    }
    const fleeRules = book.rules?.escaping || {};
    const fleeDmg = fleeRules.flee_damage || 2;
    setPlayerHealth(state, book, Math.max(0, getPlayerHealth(state, book) - fleeDmg));
    state.log.push(`Fled! -${fleeDmg} damage`);
    if (getPlayerHealth(state, book) <= 0) {
      state.pause = { type: 'ending', ending_type: 'death', text: 'You died fleeing.' };
      state.combat = null;
      // Rule 46: death clears any active combat snapshot.
      state.activeCombat = null;
      return state;
    }
    if (combat.fleeTo) {
      // Rule 36 on_combat_end: fire before clearing combat (player-initiated flee).
      // Mark the section-entry snapshot's hadCombat flag BEFORE the dispatch
      // so any on_combat_end-triggered or downstream on_section_exit conditions
      // see the section as combat-resolved (schema v1.21+ / Rule 36 v2.28.0).
      if (state.sectionEntrySnapshot) state.sectionEntrySnapshot.hadCombat = true;
      state.lastCombatRoundCount = combat.round;
      dispatchLifecycleTriggers(state, book, 'on_combat_end', { combatScope: true });
      state.combat = null;
      // Rule 46: player-initiated flee is normal combat completion —
      // clear any active combat snapshot.
      state.activeCombat = null;
      return navigateTo(state, book, combat.fleeTo);
    }
    return state;
  }

  // Rule 36 on_user_use (schema v1.20+): player initiates use of an item
  // whose triggered_effects[] has trigger 'on_user_use'. In-combat context.
  if (action === 'use') {
    const itemId = args[0];
    if (!itemId) { state.log.push('use requires an item_id argument'); return state; }
    if (!state.inventory.includes(itemId)) {
      state.log.push(`Cannot use ${itemId}: not in inventory`);
      return state;
    }
    return runUserUse(state, book, itemId);
  }

  if (action === 'attack') {
    return runCombatRound(args, state, book);
  }

  if (action === 'post_round') {
    return runPostRound(args, state, book);
  }

  if (action === 'skip_post_round') {
    combat.awaitingPostRound = false;
    combat.lastRoundResult = null;
    return checkCombatEnd(state, book);
  }

  state.log.push(`Unknown combat action: ${action}`);
  return state;
}

function runCombatRound(forcedRollsArg, state, book) {
  const combat = state.combat;
  const enemy = combat.enemies[combat.currentEnemyIdx];
  const cs = (typeof book.rules?.combat_system === 'object' ? book.rules.combat_system : null) || book.rules?.combat_rules_detail || {};
  const roundScript = cs.round_script;

  combat.round++;

  if (!roundScript) {
    state.log.push('ERROR: no round_script defined');
    return state;
  }

  // Build context — include all stats and all enemy fields
  const playerData = {
    attack: 0,
    health: getPlayerHealth(state, book),
    name: 'You',
    ...state.stats,
  };
  const { attackStat } = getCombatStats(book);
  if (attackStat) playerData.attack = state.stats[attackStat] || 0;

  // Apply passive equipment. The canonical shape of stat_modifier per the
  // codex section 2.5 is
  //   { "stat": "<stat name>", "amount": <number>, "when": "always|combat|equipped" }
  // As of schema v1.5+, all three `when` values are honored by the emulator:
  //   - "always"   — applies whenever the item is in inventory, any time.
  //   - "combat"   — applies only during combat rounds, regardless of equipped state.
  //   - "equipped" — applies only when the item occupies an equipment slot in state.equipment.
  // An earlier version of this code walked Object.entries(item.stat_modifier)
  // and treated every key as a stat name, which set playerData.stat =
  // "endurance" and playerData.amount = 2 instead of applying an ENDURANCE
  // bonus. Now we read the structured fields directly.
  const catalog = book.items_catalog || {};
  const equipmentMap = state.equipment || {};
  const equippedIds = new Set(Object.values(equipmentMap));
  for (const itemId of state.inventory) {
    const item = catalog[itemId];
    const sm = item?.stat_modifier;
    if (!sm || typeof sm.stat !== 'string' || typeof sm.amount !== 'number') continue;
    const when = sm.when || 'always';
    let applies = false;
    if (when === 'always') applies = true;
    else if (when === 'combat') applies = true;  // we are inside a combat round
    else if (when === 'equipped') applies = equippedIds.has(itemId);
    if (applies) {
      playerData[sm.stat] = (typeof playerData[sm.stat] === 'number' ? playerData[sm.stat] : 0) + sm.amount;
    }
  }

  const enemyData = {
    attack: getEnemyAttack(enemy.data, book),
    health: enemy.currentHealth,
    name: enemy.name,
    ...enemy.data,
  };
  enemyData.health = enemy.currentHealth;

  // Apply the frozen combat_modifiers list (schema v1.4; duration-aware
  // since v1.7). The list was evaluated once at combat start in
  // startCombat() and stored on combat.appliedModifiers. Each modifier has
  // a target dot-path like "player.attack", "player.hit_threshold",
  // "enemy.armor", etc. The delta is added to the existing value of the
  // target field on playerData or enemyData. Fields that are currently
  // undefined are treated as 0 so books can introduce new fields purely
  // via modifiers (e.g., `hit_threshold_penalty`).
  //
  // The `duration` field filters WHICH ROUNDS the modifier participates
  // in: 'fight' (default) applies every round, 'first_round' only in
  // round 1, 'after_first_round' only in round 2+, 'round' is reserved
  // and currently treated as 'fight'. Conditions are still snapshotted
  // at combat start; duration just selects among the frozen list per
  // round.
  const applied = combat.appliedModifiers || [];
  const consecutiveLosses = combat.consecutiveLosses || 0;
  const activeThisRound = applied.filter(m =>
    modifierAppliesAtRound(m, combat.round) && !modifierExpiredByLossStreak(m, consecutiveLosses)
  );
  for (const mod of activeThisRound) {
    const target = mod.target;
    const delta = mod.delta;
    const dotIdx = target.indexOf('.');
    if (dotIdx < 0) continue;
    const scope = target.slice(0, dotIdx);
    const field = target.slice(dotIdx + 1);
    let dataObj = null;
    if (scope === 'player') dataObj = playerData;
    else if (scope === 'enemy') dataObj = enemyData;
    if (!dataObj) continue;
    const current = typeof dataObj[field] === 'number' ? dataObj[field] : 0;
    dataObj[field] = current + delta;
  }
  // Log the modifiers that just became active this round. Modifiers with
  // `duration: "fight"` (or absent duration) log once in round 1.
  // Modifiers with `duration: "first_round"` also log in round 1 (and
  // stop applying after). Modifiers with `duration: "after_first_round"`
  // log in round 2 when they first take effect. This gives the player a
  // visible note at the moment the modifier starts participating.
  const newlyActive = activeThisRound.filter(m => !modifierAppliesAtRound(m, combat.round - 1));
  if (newlyActive.length > 0) {
    for (const m of newlyActive) {
      const sign = m.delta >= 0 ? '+' : '';
      const durTag = m.duration === 'first_round' ? ' [first round only]'
        : m.duration === 'after_first_round' ? ' [rounds 2+]'
        : '';
      state.log.push(`Combat modifier: ${m.target} ${sign}${m.delta}${durTag}${m.reason ? ' (' + m.reason + ')' : ''}`);
    }
  }

  const combatData = {
    round: combat.round,
    standard_damage: cs.details?.standard_damage || cs.standard_damage || 2,
    last_result: '',
    last_damage: 0,
    // Schema v1.5+ damage contract: the round_script sets these fields
    // to report the damage it decided for this round. The emulator then
    // applies damage_interactions (if any) to scale the values and
    // subtracts the scaled totals from health. Scripts MUST NOT mutate
    // player.health or enemy.health directly; that contract is gone.
    damage_to_enemy: 0,
    damage_to_player: 0,
    // Expose applied modifiers to the round_script via combat.modifiers
    // so book-specific scripts can do per-modifier math if they need
    // to. Most scripts don't need this — they just read the already-
    // modified player.attack / enemy.armor / hit_threshold / etc.
    modifiers: applied,
    // Expose applied damage_interactions so round_scripts that care
    // can read them. Most won't — interaction application is the
    // emulator's job, not the script's.
    damage_interactions: combat.appliedDamageInteractions || [],
  };

  const context = {
    player: playerData,
    enemy: enemyData,
    combat: combatData,
    inventory: [...state.inventory],
    items_catalog: catalog,
    // Expose the current equipment map (slot -> item_id) so round_scripts
    // can do weapon-aware logic if needed. Most scripts read player.attack
    // directly and don't need this, but it's available for e.g. computing
    // per-weapon damage formulas. Schema v1.5+.
    equipment: { ...(state.equipment || {}) },
  };
  // Also expose equipment via player.equipment for the more natural
  // player.equipment.weapon access pattern inside round_scripts.
  playerData.equipment = { ...(state.equipment || {}) };
  // Pass details object keys as globals
  for (const [k, v] of Object.entries(cs.details || {})) {
    if (k !== 'standard_damage') context[k] = v;
  }

  // Forced rolls from CLI
  let forcedRolls = null;
  if (forcedRollsArg && forcedRollsArg.length > 0) {
    // Each provide_roll arg is a comma-separated set for one roll() call
    forcedRolls = forcedRollsArg.map(s => s.split(',').map(Number));
  }

  const result = runScript(roundScript, context, forcedRolls);
  if (result.error) {
    state.log.push(`Lua error: ${result.error}`);
    state.pause = { type: 'error', message: result.error };
    return state;
  }

  // Schema v1.5+ contract: round_scripts MUST NOT mutate player.health or
  // enemy.health directly. They report damage via combat.damage_to_enemy
  // and combat.damage_to_player, and the emulator applies any active
  // damage_interactions before subtracting from health. Reject the old
  // contract with a clear error so mismigrated books are easy to spot.
  if ((result.enemy && result.enemy.health !== undefined && result.enemy.health !== enemy.currentHealth) ||
      (result.player && result.player.health !== undefined && result.player.health !== playerData.health)) {
    const msg = 'round_script uses the pre-v1.5 contract (mutated player.health or enemy.health directly). Migrate the script to set combat.damage_to_enemy and combat.damage_to_player instead. See codex Rule 18 / round_script contract.';
    state.log.push(`ERROR: ${msg}`);
    state.pause = { type: 'error', message: msg };
    return state;
  }

  // Read the damage values the round_script reported and normalize them
  // to the component list form { amount, sources } [] so interaction
  // filters can operate uniformly.
  const rawEnemy = result.combat?.damage_to_enemy;
  const rawPlayer = result.combat?.damage_to_player;
  const enemyComponents = normalizeDamage(rawEnemy);
  const playerComponents = normalizeDamage(rawPlayer);

  // Apply damage_interactions (scale each component per interaction
  // filters) then sum into a final scalar damage-to-apply for each side.
  const interactions = combat.appliedDamageInteractions || [];
  let enemyTotal = applyDamageInteractions(enemyComponents, interactions, 'incoming', state, book, combat.round);
  let playerTotal = applyDamageInteractions(playerComponents, interactions, 'outgoing', state, book, combat.round);

  // Apply damage_caps (schema v1.15+, Rule 32) post-interaction. For each
  // direction, the tightest matching cap bounds the per-round total.
  // Healing (negative totals) bypasses caps — caps only bound positive
  // damage; a damage cap should not flip a heal into nothing.
  // Schema v1.19+ (Rule 32 min_attacker_margin extension): a cap carrying
  // min_attacker_margin is evaluated per round against the round_script's
  // combat.attacker_margin; below the threshold the cap blocks all damage
  // (effective max = 0), at-or-above threshold the cap applies as `max`.
  const caps = combat.appliedDamageCaps || [];
  const attackerMargin = (typeof result.combat?.attacker_margin === 'number')
    ? result.combat.attacker_margin
    : null;
  if (caps.length > 0) {
    if (enemyTotal > 0) {
      for (const c of caps) {
        if (c.direction !== 'incoming') continue;
        let effectiveMax = c.max;
        if (typeof c.min_attacker_margin === 'number') {
          if (attackerMargin === null) {
            state.log.push(`WARN: damage_cap with min_attacker_margin requires combat.attacker_margin from round_script; cap skipped this round${c.reason ? ' (' + c.reason + ')' : ''}`);
            continue;
          }
          effectiveMax = (attackerMargin >= c.min_attacker_margin) ? c.max : 0;
        }
        if (enemyTotal > effectiveMax) {
          state.log.push(`Damage cap: damage_to_enemy ${enemyTotal} → ${effectiveMax}${c.reason ? ' (' + c.reason + ')' : ''}`);
          enemyTotal = effectiveMax;
        }
      }
    }
    if (playerTotal > 0) {
      for (const c of caps) {
        if ((c.direction || 'outgoing') !== 'outgoing') continue;
        let effectiveMax = c.max;
        if (typeof c.min_attacker_margin === 'number') {
          if (attackerMargin === null) {
            state.log.push(`WARN: damage_cap with min_attacker_margin requires combat.attacker_margin from round_script; cap skipped this round${c.reason ? ' (' + c.reason + ')' : ''}`);
            continue;
          }
          effectiveMax = (attackerMargin >= c.min_attacker_margin) ? c.max : 0;
        }
        if (playerTotal > effectiveMax) {
          state.log.push(`Damage cap: damage_to_player ${playerTotal} → ${effectiveMax}${c.reason ? ' (' + c.reason + ')' : ''}`);
          playerTotal = effectiveMax;
        }
      }
    }
  }

  // Rule 36 on_combat_round triggers (schema v1.20+). Dispatch AFTER Rule 32
  // frozen caps and BEFORE applying damage to health, per the Q4-decided
  // pipeline ordering: damage_delta / damage_multiplier / damage_set first
  // (shift/scale/replace pass), then damage_cap (tightest-cap-wins pass).
  // Non-damage-flow effects (modify_stat / set_flag / etc.) queue and fire
  // after the numerics settle; consume_on_fire items are removed last.
  const enemyMaxHealth = (book.enemies_catalog?.[combat.enemyRefs?.[0]]?.[book.rules?.health_stat] || enemy.maxHealth || 0);
  const r36ctx = {
    playerTotal,
    enemyTotal,
    enemyMaxHealth,
    log: state.log,
    consume: [],
    nonDamageQueue: [],
  };
  dispatchCombatRoundTriggers(state, book, r36ctx);
  playerTotal = Math.max(0, r36ctx.playerTotal);
  enemyTotal = Math.max(0, r36ctx.enemyTotal);

  // Subtract damage from health. Negative damage = healing; clamp to 0
  // on the damage side. Healing is applied directly and can exceed
  // initial_is_max (the modify_stat path handles those clamps elsewhere).
  if (enemyTotal !== 0) {
    enemy.currentHealth = Math.max(0, enemy.currentHealth - enemyTotal);
  }
  if (playerTotal !== 0) {
    const currentPlayerHp = getPlayerHealth(state, book);
    setPlayerHealth(state, book, Math.max(0, currentPlayerHp - playerTotal));
  }

  // Apply Rule 36 non-damage-flow effects (modify_stat, set_flag, etc.)
  // queued by dispatchCombatRoundTriggers.
  for (const q of r36ctx.nonDamageQueue) {
    dispatchTriggeredEvent(q.effect, state, book, describeSource(q.source));
  }
  // Apply Rule 36 consume_on_fire removals.
  for (const itemId of r36ctx.consume) {
    state.inventory = state.inventory.filter(id => id !== itemId);
    if (state.equipment) {
      for (const slot of Object.keys(state.equipment)) {
        if (state.equipment[slot] === itemId) delete state.equipment[slot];
      }
    }
    state.log.push(`R36 consume_on_fire: removed ${itemId}`);
  }

  for (const msg of result.logs || []) state.log.push(msg);

  combat.lastRoundResult = result.combat?.last_result;
  combat.lastDamage = result.combat?.last_damage || 0;

  // Schema v1.30+ / Rule 46. Update monotonic per-fight wound counters
  // from the round_script's last_result tag. These drive the
  // interrupt-after-N-wounds checks in checkCombatEnd. Tie /
  // simultaneous / no-damage rounds (any last_result that isn't one of
  // the two tagged outcomes) do NOT increment — only rounds the script
  // explicitly tagged as a wound count.
  if (combat.lastRoundResult === 'player_wounds_enemy') {
    combat.woundsDealt = (combat.woundsDealt || 0) + 1;
  } else if (combat.lastRoundResult === 'enemy_wounds_player') {
    combat.woundsTaken = (combat.woundsTaken || 0) + 1;
  }

  // Schema v1.14+ (Rule 17 modifier-expiry-on-loss-streak): update the
  // per-fight player-loss streak counter using post-interaction damage
  // totals. A round counts as a player loss when the player took strictly
  // more damage than the enemy this round; ties (including 0-vs-0
  // no-damage rounds) and player-victory rounds reset the streak.
  const prevStreak = combat.consecutiveLosses || 0;
  if (playerTotal > enemyTotal) {
    combat.consecutiveLosses = prevStreak + 1;
  } else {
    combat.consecutiveLosses = 0;
  }
  // Log any modifier that just expired due to the streak update so the
  // player sees a discrete event ("Modifier removed: ...") at the moment
  // it falls off, mirroring the "Combat modifier: ..." line that fires
  // when one becomes active.
  const newStreak = combat.consecutiveLosses;
  for (const m of (combat.appliedModifiers || [])) {
    const t = m.removedAfterConsecutiveLosses;
    if (typeof t !== 'number' || t < 1) continue;
    if (prevStreak < t && newStreak >= t) {
      const sign = m.delta >= 0 ? '+' : '';
      state.log.push(`Combat modifier removed: ${m.target} ${sign}${m.delta}${m.reason ? ' (' + m.reason + ')' : ''} — ${t} consecutive losses`);
    }
  }

  // Check post-round availability
  const postScript = cs.post_round_script;
  const lr = combat.lastRoundResult;
  if (postScript && lr && lr !== 'tie' && lr !== 'simultaneous' && getPlayerHealth(state, book) > 0 && enemy.currentHealth > 0) {
    combat.awaitingPostRound = true;
    return state;
  }

  return checkCombatEnd(state, book);
}

function runPostRound(forcedRollsArg, state, book) {
  const combat = state.combat;
  const enemy = combat.enemies[combat.currentEnemyIdx];
  const cs = (typeof book.rules?.combat_system === 'object' ? book.rules.combat_system : null) || book.rules?.combat_rules_detail || {};
  const postScript = cs.post_round_script;

  if (!postScript) {
    combat.awaitingPostRound = false;
    return checkCombatEnd(state, book);
  }

  const playerData = {
    attack: 0,
    health: getPlayerHealth(state, book),
    name: 'You',
    ...state.stats,
  };
  const enemyData = {
    attack: getEnemyAttack(enemy.data, book),
    health: enemy.currentHealth,
    name: enemy.name,
    ...enemy.data,
  };
  enemyData.health = enemy.currentHealth;

  const combatData = {
    round: combat.round,
    last_result: combat.lastRoundResult,
    last_damage: combat.lastDamage || 0,
  };

  const context = {
    player: playerData,
    enemy: enemyData,
    combat: combatData,
    player_stats: { ...state.stats },
    initial_stats: { ...state.initialStats },
  };
  for (const [k, v] of Object.entries(cs.details || {})) {
    if (k !== 'standard_damage') context[k] = v;
  }

  let forcedRolls = null;
  if (forcedRollsArg && forcedRollsArg.length > 0) {
    forcedRolls = forcedRollsArg.map(s => s.split(',').map(Number));
  }

  const result = runScript(postScript, context, forcedRolls);
  if (result.error) {
    state.log.push(`Lua post-round error: ${result.error}`);
  } else {
    if (result.enemy?.health !== undefined) enemy.currentHealth = Math.max(0, result.enemy.health);
    if (result.player?.health !== undefined) setPlayerHealth(state, book, Math.max(0, result.player.health));
    if (result.player?.stats_changed) {
      for (const [k, v] of Object.entries(result.player.stats_changed)) {
        state.stats[k] = v;
      }
    }
    for (const msg of result.logs || []) state.log.push(msg);
  }

  combat.awaitingPostRound = false;
  combat.lastRoundResult = null;
  return checkCombatEnd(state, book);
}

// Rule 36 on_user_use dispatch (schema v1.20+). The player initiated `use
// <itemId>` from either a section pause (in_section context) or a combat
// pause (in_combat context). Dispatches the item's on_user_use
// triggered_effects[]; honors consume_on_fire; handles flee_combat by
// clearing combat and navigating.
function runUserUse(state, book, itemId) {
  const def = (book.items_catalog || {})[itemId];
  if (!def || !Array.isArray(def.triggered_effects)) {
    state.log.push(`No on_user_use triggered_effects on ${itemId}`);
    return state;
  }
  const combat = state.combat;
  const ctxName = combat ? 'in_combat' : 'in_section';
  const fireable = def.triggered_effects.filter(te => {
    if (!te || te.trigger !== 'on_user_use') return false;
    const ctx = te.context || 'anywhere';
    if (ctx !== 'anywhere' && ctx !== ctxName) return false;
    if (te.condition && !evalCondition(te.condition, state, book)) return false;
    return true;
  });
  if (fireable.length === 0) {
    state.log.push(`No fireable on_user_use entry on ${itemId} in ${ctxName} context`);
    return state;
  }
  let fledTo = null;
  let consume = false;
  for (const te of fireable) {
    const gr = evalGateRoll(te.gate_roll, state);
    if (!gr.fired) {
      if (te.gate_roll) state.log.push(`R36 gate_roll skip (item:${itemId}): rolled ${gr.rolled} not in ${te.gate_roll.applies_on}`);
      continue;
    }
    if (te.gate_roll) state.log.push(`R36 gate_roll fire (item:${itemId}): rolled ${gr.rolled} in ${te.gate_roll.applies_on}`);
    const eff = te.effect;
    if (!eff) continue;
    if (eff.type === 'flee_combat') {
      if (!combat) {
        state.log.push(`R36 flee_combat (item:${itemId}): no active combat; skipping`);
      } else {
        fledTo = eff.target_section;
        state.log.push(`R36 flee_combat (item:${itemId}): fleeing to §${eff.target_section}`);
      }
    } else if (['damage_delta', 'damage_multiplier', 'damage_set', 'damage_cap'].includes(eff.type)) {
      state.log.push(`R36 ${eff.type} (item:${itemId}): damage-flow effects only fire on on_combat_round; skipping`);
    } else {
      dispatchTriggeredEvent(eff, state, book, `item:${itemId}`);
    }
    if (te.consume_on_fire) consume = true;
  }
  if (consume) {
    state.inventory = state.inventory.filter(id => id !== itemId);
    if (state.equipment) {
      for (const slot of Object.keys(state.equipment)) {
        if (state.equipment[slot] === itemId) delete state.equipment[slot];
      }
    }
    state.log.push(`R36 consume_on_fire: removed ${itemId}`);
  }
  if (fledTo !== null && combat) {
    // Fire on_combat_end (R36) before tearing down combat, then navigate.
    // Mark hadCombat on the section snapshot (schema v1.21+ / R36 v2.28.0).
    if (state.sectionEntrySnapshot) state.sectionEntrySnapshot.hadCombat = true;
    state.lastCombatRoundCount = combat.round;
    dispatchLifecycleTriggers(state, book, 'on_combat_end', { combatScope: true });
    state.combat = null;
    // Rule 46: R36 flee_combat is normal combat completion — clear any
    // active combat snapshot.
    state.activeCombat = null;
    return navigateTo(state, book, fledTo);
  }
  return state;
}

function checkCombatEnd(state, book) {
  const combat = state.combat;
  const enemy = combat.enemies[combat.currentEnemyIdx];

  if (getPlayerHealth(state, book) <= 0) {
    state.combat = null;
    // Rule 46: player death clears any active combat snapshot — a dead
    // player cannot resume a paused fight.
    state.activeCombat = null;
    state.pause = { type: 'ending', ending_type: 'death', text: 'You have been slain in combat.' };
    return state;
  }

  // Schema v1.30+ / Rule 46. Interrupt-after-N-wounds check. Runs BEFORE
  // win_after_rounds / end_after_rounds / enemy-defeated so a wounding
  // interrupt threshold met on the same round as an end-condition fires
  // the interrupt (the interrupt is the more specific source-text
  // instruction). Within the two interrupt kinds, player-wounds takes
  // priority over enemy-wounds when both fire on the same round (the
  // player-wounds case is the more dramatic narrative beat — the player
  // is being dragged off, not the enemy retreating). Pauses snapshot
  // the current combat state into state.activeCombat (preserving enemy
  // STAMINA, frozen modifiers, wound + round counters) and navigate to
  // the interrupt's target. The on_combat_end lifecycle trigger does
  // NOT fire on an interrupt pause — the combat is not ended, only
  // paused. A downstream `mode: "resume"` combat event continues the
  // same fight at preserved STAMINA.
  function pauseCombat(reason, target) {
    const snapEnemy = enemy.data || book.enemies_catalog[enemy.ref] || {};
    state.activeCombat = {
      enemy_ref: enemy.ref,
      enemy_snapshot: JSON.parse(JSON.stringify(snapEnemy)),
      currentHealth: enemy.currentHealth,
      modifiers: (combat.appliedModifiers || []).slice(),
      damageInteractions: (combat.appliedDamageInteractions || []).slice(),
      damageCaps: (combat.appliedDamageCaps || []).slice(),
      woundsDealt: combat.woundsDealt || 0,
      woundsTaken: combat.woundsTaken || 0,
      round: combat.round,
      consecutiveLosses: combat.consecutiveLosses || 0,
      originSection: state.currentSection,
      originEventIdx: 0,
    };
    state.log.push(`R46 ${reason}: pausing vs ${enemy.name || enemy.ref} at ${enemy.currentHealth} health → §${target}`);
    state.combat = null;
    return navigateTo(state, book, target);
  }

  const iap = combat.interruptAfterPlayerWounds;
  if (iap && typeof iap.count === 'number' && (combat.woundsTaken || 0) >= iap.count && iap.target !== undefined && iap.target !== null) {
    return pauseCombat(`interrupt_after_player_wounds (${combat.woundsTaken}/${iap.count})`, iap.target);
  }
  const iae = combat.interruptAfterEnemyWounds;
  if (iae && typeof iae.count === 'number' && (combat.woundsDealt || 0) >= iae.count && iae.target !== undefined && iae.target !== null) {
    return pauseCombat(`interrupt_after_enemy_wounds (${combat.woundsDealt}/${iae.count})`, iae.target);
  }

  // Schema v1.32+ / Rule 48: interrupt_after_rounds. Like end_after_rounds
  // but PRESERVES state.activeCombat (via pauseCombat) so a downstream
  // section with `mode: "resume"` can pick the fight back up at the same
  // enemy STAMINA. Use this for the "pause for a decision, maybe resume"
  // pattern (FF Warlock §333 Vampire flee mechanic, where after 6 rounds
  // the player can Test their Luck to flee or continue).
  //
  // Distinct from end_after_rounds (Rule 38, "the fight is broken off"
  // semantic — clears activeCombat). On a Rule 46 mode:resume the round
  // counter resets to 0 in the new combat (existing engine behaviour),
  // so this interrupt naturally re-arms for another `count` rounds in
  // the resumed fight without any extra bookkeeping.
  const iar = combat.interruptAfterRounds;
  if (iar && typeof iar.count === 'number' && combat.round >= iar.count && iar.target !== undefined && iar.target !== null) {
    return pauseCombat(`interrupt_after_rounds (${combat.round}/${iar.count})`, iar.target);
  }
  // Schema v1.13+ / Rule 31: survive-N-rounds win condition. If the
  // combat carries win_after_rounds, the player wins once combat.round
  // reaches the threshold (i.e. that many rounds have completed with
  // the player still alive). Player-death takes priority above; this
  // check runs before the enemy-defeat-by-health check so a fight
  // configured as both "endurance OR damage" wins on whichever fires
  // first.
  if (combat.winAfterRounds !== undefined && combat.winAfterRounds !== null && combat.round >= combat.winAfterRounds) {
    state.log.push(`Survived ${combat.round} rounds — combat ends in victory.`);
    // Rule 36 on_combat_end (schema v1.20+): fire before clearing combat.
    // Mark hadCombat (schema v1.21+ / R36 v2.28.0) so the upcoming
    // on_section_exit dispatch sees this section as combat-resolved.
    if (state.sectionEntrySnapshot) state.sectionEntrySnapshot.hadCombat = true;
    state.lastCombatRoundCount = combat.round;
    dispatchLifecycleTriggers(state, book, 'on_combat_end', { combatScope: true });
    const winTo = combat.winTo;
    state.combat = null;
    // Rule 46: normal completion clears any active combat snapshot.
    state.activeCombat = null;
    if (winTo) return navigateTo(state, book, winTo);
    return processNextEvent(state, book);
  }

  // Schema v1.23+ / codex v2.30 (Rule 38). Round-cap auto-end — combat
  // is broken off without a victory/loss verdict after end_after_rounds
  // rounds. Distinct from win_after_rounds (Rule 31, treated as victory):
  // this is the "the fight is broken off" semantic. Player-defeat and
  // player-flee paths take priority (handled earlier in the round loop).
  // Routes to end_to if set, otherwise falls through to the section's
  // choice list (combine with combat_round_count_gte conditions for
  // that pattern). Sets state.lastCombatRoundCount to combat.round
  // BEFORE the lifecycle trigger fires, mirroring the other dispatch
  // paths so post-combat conditions evaluate against the right round.
  if (combat.endAfterRounds !== undefined && combat.endAfterRounds !== null && combat.round >= combat.endAfterRounds) {
    state.log.push(`Combat broken off after ${combat.round} rounds.`);
    if (state.sectionEntrySnapshot) state.sectionEntrySnapshot.hadCombat = true;
    state.lastCombatRoundCount = combat.round;
    dispatchLifecycleTriggers(state, book, 'on_combat_end', { combatScope: true });
    const endTo = combat.endTo;
    state.combat = null;
    // Rule 46: normal completion clears any active combat snapshot.
    state.activeCombat = null;
    if (endTo !== undefined && endTo !== null) return navigateTo(state, book, endTo);
    return processNextEvent(state, book);
  }

  if (enemy.currentHealth <= 0) {
    state.log.push(`${enemy.name} defeated!`);
    const nextIdx = combat.currentEnemyIdx + 1;
    if (nextIdx < combat.enemies.length && (combat.mode === 'sequential' || combat.mode === 'custom')) {
      combat.currentEnemyIdx = nextIdx;
      return state;
    }
    // All enemies defeated
    // Rule 36 on_combat_end (schema v1.20+): fire before clearing combat.
    // Mark hadCombat (schema v1.21+ / R36 v2.28.0) so the upcoming
    // on_section_exit dispatch sees this section as combat-resolved.
    if (state.sectionEntrySnapshot) state.sectionEntrySnapshot.hadCombat = true;
    state.lastCombatRoundCount = combat.round;
    dispatchLifecycleTriggers(state, book, 'on_combat_end', { combatScope: true });
    const winTo = combat.winTo;
    state.combat = null;
    // Rule 46: normal completion clears any active combat snapshot.
    state.activeCombat = null;
    if (winTo) return navigateTo(state, book, winTo);
    return processNextEvent(state, book);
  }

  return state;
}

// ==================== STATE COMPACTION ====================

/**
 * Strip the state to its minimal form for output.
 * The output JSON includes everything needed to resume.
 */
function compactState(state) {
  const out = {
    bookPath: state.bookPath,
    stats: state.stats,
    initialStats: state.initialStats,
    inventory: state.inventory,
    // Schema v1.5+. Equipment map {slot -> item_id}. Survives save/restore.
    equipment: state.equipment || {},
    flags: state.flags,
    provisions: state.provisions,
    gold: state.gold,
    meals: state.meals,
    abilities: state.abilities,
    talents: state.talents || [],
    abilityUses: state.abilityUses || {},
    potion: state.potion,
    currentSection: state.currentSection,
    previousSection: state.previousSection,
    returnStack: state.returnStack,
    visitedSections: state.visitedSections,
    pause: state.pause,
    eventQueue: state.eventQueue,
    combat: state.combat,
    pendingChoices: state.pendingChoices,
    lastRoll: state.lastRoll,
    lastTestResult: state.lastTestResult,
    creationStep: state.creationStep,
    creationDone: state.creationDone,
    frontmatterPage: state.frontmatterPage,
    frontmatterDone: state.frontmatterDone,
    // Tier 3 partial-run tracking survives across act calls and
    // save/load. Empty array means the run is still a candidate for
    // TIER 3 CLEAN; any entry downgrades it to TIER 3 PARTIAL.
    manualSets: Array.isArray(state.manualSets) ? state.manualSets : [],
    // Rule 36 v2.28.0 / schema v1.21+. Per-section bookkeeping snapshot
    // (current health-stat value at section-enter + hadCombat flag).
    // Round-tripped through state JSON so on_section_exit triggers
    // continue to evaluate correctly across act() calls.
    sectionEntrySnapshot: state.sectionEntrySnapshot ?? null,
    // Rule 38 / schema v1.23+. Round number the most recent combat ended
    // on; null until the first combat resolves. Round-tripped through
    // state JSON so combat_round_count_lte/gte conditions on choices
    // and events continue to evaluate correctly across act() calls.
    lastCombatRoundCount: state.lastCombatRoundCount ?? null,
    // Rule 46 / schema v1.30+. Paused-combat snapshot. Null when no
    // combat is paused. Round-tripped through state JSON so a saved-mid-
    // pause session can resume against the same enemy at preserved
    // STAMINA after reload.
    activeCombat: state.activeCombat ?? null,
    log: state.log.slice(-20), // Keep recent log entries only
  };
  return out;
}

// ==================== HUMAN-READABLE SUMMARY ====================

function summarize(state, book) {
  const lines = [];
  const { healthStat, attackStat } = getCombatStats(book);

  // Tier 3 partial-run warning banner (Rule 16 / codex v2.9.0). When
  // the playbook has invoked `manual_set` even once, the run is NOT a
  // valid Tier 3 playthrough — it was papered over with a debug
  // escape hatch and must be reported accordingly. The banner goes
  // at the TOP of the summary so it cannot be skimmed past in a log
  // dump. See DEV_PROCESS.md failure mode 4 ("workaround-as-success
  // reporting") for the full rationale.
  const manualSets = Array.isArray(state.manualSets) ? state.manualSets : [];
  if (manualSets.length > 0) {
    lines.push(`[!!! TIER 3 PARTIAL — ${manualSets.length} manual_set invocation(s) used this run !!!]`);
    for (const ms of manualSets) {
      const where = ms.section != null ? `section ${ms.section}` : (ms.creationStep != null ? `creation step ${ms.creationStep}` : 'pre-creation');
      lines.push(`  manual_set ${ms.key}=${JSON.stringify(ms.value)} at ${where}`);
    }
  }

  // Book-shape + post-creation validation banner (schema v1.10+ /
  // emulators v3.5+, Windhammer Bug C). Surface undeclared attack/health
  // stats and uninitialised declared stats at the top of the status so
  // silent-broken books fail loud rather than silently producing a 0
  // combat stat and cosmetic "undefined" renders. See codex Rule 26.
  const vw = Array.isArray(state.validationWarnings) ? state.validationWarnings : [];
  if (vw.length > 0) {
    lines.push(`[!!! BOOK VALIDATION — ${vw.length} warning(s), see codex Rule 26 !!!]`);
    for (const w of vw) lines.push(`  ${w}`);
  }

  if (state.pause?.type === 'frontmatter') {
    const page = (book.frontmatter?.pages || [])[state.frontmatterPage];
    if (page) {
      lines.push(`[Frontmatter page ${state.frontmatterPage + 1}: ${page.title}]`);
    }
  } else if (state.pause?.type === 'character_creation_roll') {
    lines.push(`[Character Creation] Roll ${state.pause.formula} for ${state.pause.stat}`);
  } else if (state.pause?.type === 'character_creation_roll_resource') {
    lines.push(`[Character Creation] Roll ${state.pause.formula} for ${state.pause.resource}`);
  } else if (state.pause?.type === 'character_creation_choose_one') {
    lines.push(`[Character Creation] Choose ${state.pause.category}: ${state.pause.options.join(' / ')}`);
  } else if (state.pause?.type === 'character_creation_choose_abilities') {
    lines.push(`[Character Creation] Choose ${state.pause.count} abilities from: ${state.pause.available.join(', ')}`);
  } else if (state.pause?.type === 'character_creation_distribute') {
    const parts = state.pause.stats.map(s => `${s.name} [${s.min}..${s.max}]`).join(', ');
    lines.push(`[Character Creation] Distribute ${state.pause.total_points} points across: ${parts}`);
  } else if (state.pause?.type === 'section') {
    lines.push(`Section ${state.currentSection}`);
    const stats = [];
    // Emulators v3.5+ (Windhammer Bug C): render undefined stats as an
    // em-dash rather than the literal string "undefined". Paired with the
    // validation banner above so the root cause is named at the top while
    // the stat bar shows a neutral placeholder rather than leaking a JS
    // runtime artifact into the player view.
    const fmtStat = (v) => (v === undefined || v === null || Number.isNaN(v)) ? '—' : v;
    if (attackStat) stats.push(`${attackStat} ${fmtStat(state.stats[attackStat])}/${fmtStat(state.initialStats[attackStat])}`);
    if (healthStat) stats.push(`${healthStat} ${fmtStat(state.stats[healthStat])}/${fmtStat(state.initialStats[healthStat])}`);
    const provLabel = book.rules?.provisions?.display_name || 'Provisions';
    const goldLabel = book.rules?.inventory?.currency_display_name || 'Gold';
    if (state.provisions > 0) stats.push(`${provLabel} ${state.provisions}`);
    // Show currency: prefer `state.gold` (the canonical lowercase slot used
    // by LW/FF), and fall back to a stat-declared currency if the book
    // carries its currency as a first-class stat (GrailQuest uses `GOLD`
    // as a stat name, with no use of the canonical `state.gold` slot).
    // Detection is structural: if any stat in rules.stats has a name that
    // looks currency-ish AND its state value is non-zero, show it.
    if (state.gold > 0) {
      stats.push(`${goldLabel} ${state.gold}`);
    } else {
      const statDefs = book.rules?.stats || [];
      for (const sd of statDefs) {
        const name = sd.name;
        if (typeof name !== 'string') continue;
        if (!/gold|coin|crown|piece|credit|cap|doubloon|money|silver/i.test(name)) continue;
        const v = state.stats[name];
        if (typeof v === 'number' && v > 0) {
          // Use the declared display name if present, else the stat name itself.
          stats.push(`${goldLabel !== 'Gold' ? goldLabel : name} ${v}`);
          break;
        }
      }
    }
    // Also surface any non-attack non-health non-currency stats the book
    // declares, so unprofiled books with stats like EXPERIENCE or HONOUR
    // show up in the summary instead of silently tracking in the
    // background. Skip the health and attack stats (already shown), skip
    // currency-ish stats (handled above), and skip zero-valued stats.
    const statDefs = book.rules?.stats || [];
    for (const sd of statDefs) {
      const name = sd.name;
      if (typeof name !== 'string') continue;
      if (name === healthStat || name === attackStat) continue;
      if (/gold|coin|crown|piece|credit|cap|doubloon|money|silver/i.test(name)) continue;
      const v = state.stats[name];
      if (typeof v === 'number' && v !== 0) {
        stats.push(`${name} ${v}`);
      }
    }
    lines.push(`  ${stats.join(' | ')}`);
  } else if (state.pause?.type === 'combat') {
    const enemy = state.combat.enemies[state.combat.currentEnemyIdx];
    lines.push(`[Combat: ${enemy.name}]`);
    const eAtt = getEnemyAttack(enemy.data, book);
    const eMax = getEnemyHealth(enemy.data, book);
    // Display effective attack stats accounting for the frozen
    // combat_modifiers list (schema v1.4). The round_script sees the
    // modifier-adjusted values at attack time; we reproduce the scalar
    // sum here so the status bar shows what's actually in effect.
    // Format: "COMBAT SKILL 14 (base 15)" when a modifier is active,
    // plain "COMBAT SKILL 15" when no modifier is active. Plain text
    // only — no ANSI colour — so the output stays friendly to log files
    // and the playbook regression harness.
    // Sum only modifiers that are active in the upcoming round. When
    // combat is about to start (combat.round === 0), treat the display
    // as if round 1 — that's what the next attack will use. Schema v1.7+
    // duration-aware filtering.
    const applied = state.combat.appliedModifiers || [];
    const displayRound = state.combat.round === 0 ? 1 : state.combat.round;
    const displayStreak = state.combat.consecutiveLosses || 0;
    const activeForDisplay = applied.filter(m =>
      modifierAppliesAtRound(m, displayRound) && !modifierExpiredByLossStreak(m, displayStreak)
    );
    const playerAtkDelta = activeForDisplay
      .filter(m => m && m.target === 'player.attack' && typeof m.delta === 'number')
      .reduce((s, m) => s + m.delta, 0);
    const enemyAtkDelta = activeForDisplay
      .filter(m => m && m.target === 'enemy.attack' && typeof m.delta === 'number')
      .reduce((s, m) => s + m.delta, 0);
    const fmt = (base, delta) => {
      if (!delta) return String(base);
      return `${base + delta} (base ${base})`;
    };
    if (attackStat) {
      const playerBase = state.stats[attackStat];
      lines.push(`  You: ${attackStat} ${fmt(playerBase, playerAtkDelta)}, ${healthStat} ${state.stats[healthStat]}/${state.initialStats[healthStat]}`);
      lines.push(`  ${enemy.name}: ${attackStat} ${fmt(eAtt, enemyAtkDelta)}, ${healthStat} ${enemy.currentHealth}/${eMax}`);
    } else {
      lines.push(`  You: ${healthStat} ${state.stats[healthStat]}/${state.initialStats[healthStat]}`);
      lines.push(`  ${enemy.name}: ${healthStat} ${enemy.currentHealth}/${eMax}`);
    }
    if (state.combat.awaitingPostRound) lines.push(`  Post-round action available`);
    if (state.combat.specialRules) lines.push(`  Special: ${state.combat.specialRules}`);
  } else if (state.pause?.type === 'stat_test') {
    lines.push(`[Test ${state.pause.event.stat}]`);
  } else if (state.pause?.type === 'roll_dice') {
    lines.push(`[Roll ${state.pause.event.dice || '2d6'}] ${state.pause.event.prompt || ''}`);
  } else if (state.pause?.type === 'choose_items') {
    lines.push(`[Choose Items] ${state.pause.event.description || ''}`);
  } else if (state.pause?.type === 'eat_meal') {
    lines.push(`[Eat a meal? Provisions: ${state.provisions}, Meals: ${state.meals}]`);
  } else if (state.pause?.type === 'ending') {
    lines.push(`[Ending: ${state.pause.ending_type}]`);
  }

  // Recent log entries
  if (state.log.length > 0) {
    const recent = state.log.slice(-5);
    for (const entry of recent) {
      lines.push(`  · ${entry}`);
    }
  }

  return lines.join('\n');
}

// ==================== MAIN ====================

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: play.js <command> [args...]');
    console.error('Commands: init <book.json> | act <state.json> <action> [args...] | dry <state.json> <action> [args...] | state <state.json>');
    process.exit(1);
  }

  const cmd = args[0];

  // Parse --state-file flag
  let stateFile = null;
  const fileFlagIdx = args.indexOf('--state-file');
  if (fileFlagIdx !== -1) {
    stateFile = args[fileFlagIdx + 1];
    args.splice(fileFlagIdx, 2);
  }

  if (cmd === 'init') {
    const bookPath = args[1];
    if (!bookPath) { console.error('Need book path'); process.exit(1); }
    const state = initialState(bookPath);
    const book = loadBook(state);
    if (!book.frontmatter?.pages?.length) {
      state.frontmatterDone = true;
      startCharacterCreation(state, book);
    }
    output(state, book);
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(compactState(state), null, 2));
    return;
  }

  if (cmd === 'act' || cmd === 'dry') {
    const statePath = args[1];
    const action = args[2];
    const actionArgs = args.slice(3);
    let raw = loadJSON(statePath);
    // Accept either the envelope format or a raw state
    const state = raw.state ? raw.state : raw;
    const book = loadBook(state);
    if (cmd === 'dry') {
      const copy = JSON.parse(JSON.stringify(state));
      applyAction(copy, book, action, actionArgs);
      output(copy, book, true);
    } else {
      applyAction(state, book, action, actionArgs);
      output(state, book);
      // Write back as raw state (not envelope) so it can be reloaded
      fs.writeFileSync(statePath, JSON.stringify(compactState(state), null, 2));
    }
    return;
  }

  if (cmd === 'state') {
    const statePath = args[1];
    let raw = loadJSON(statePath);
    const state = raw.state ? raw.state : raw;
    const book = loadBook(state);
    output(state, book);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

function output(state, book, isDry) {
  const compact = compactState(state);
  const summary = summarize(state, book);
  const actions = getAvailableActions(state, book);
  // Tier 3 partial-run flag (Rule 16 / codex v2.9.0). A Tier 3
  // comprehensive playthrough is CLEAN only if no `manual_set` debug
  // escape hatch was invoked during the run. Any invocation flips
  // the run to PARTIAL and the reason for each invocation is
  // surfaced in `manualSets` on the compact state. The playbook
  // harness (replay.js and the sub-agent prompts) must treat PARTIAL
  // runs as non-regression — a papered-over gap, not a passing run.
  const manualSets = Array.isArray(state.manualSets) ? state.manualSets : [];
  const tier3Status = manualSets.length === 0 ? 'CLEAN' : 'PARTIAL';
  const envelope = {
    state: compact,
    summary,
    available_actions: actions,
    is_dry_run: !!isDry,
    tier3_status: tier3Status,
    tier3_manual_sets: manualSets,
  };
  console.log(JSON.stringify(envelope, null, 2));
}

// Export for use as a module (replay.js, tests, etc.)
module.exports = {
  initialState,
  loadBook,
  startCharacterCreation,
  applyAction,
  getAvailableActions,
  compactState,
  summarize,
  getCombatStats,
  getPlayerHealth,
  navigateTo,
  rollDice,
  evalCondition,
  handleEvent,
  runScript,
};

if (require.main === module) {
  main();
}
