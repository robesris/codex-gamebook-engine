// Zero-framework unit tests for cli-emulator/play.js mechanisms.
//
// Run with: `node tests/run.js` (from the engine repo root).
// Exit code 0 on all-green, 1 on any failure.
//
// Philosophy: each test exercises ONE emulator mechanism against a
// tiny synthetic fixture. Fixture names are deliberately unrecognisable
// (TESTSTAT_A, test_ability_alpha, test_item_01) so a reader can't
// mistake a mechanism test for a game-rule regression. Real-world bug
// coverage lives in the playbook harness under plans/playthroughs/,
// running real book files end-to-end.
//
// Every test carries a MOTIVATED_BY comment citing the source bug or
// feature commit, and an END_TO_END_VERIFY comment describing how to
// reproduce the real-world effect against the live book data. The
// mechanism test being green is NECESSARY BUT NOT SUFFICIENT for the
// real-world case — a reader who sees a green test should ALSO run
// the END_TO_END_VERIFY steps before declaring a bug closed. See
// NEXT_SESSION.md (books repo) Chat #4 test-suite philosophy for the
// full rationale.

const play = require('../cli-emulator/play.js');

let passed = 0;
const failures = [];

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: got ${a}, want ${e}`);
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'expected true');
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
  }
}

// Build a minimal book with sensible defaults. Callers override any field.
function buildBook(overrides = {}) {
  return Object.assign({
    metadata: { title: 'Synthetic Test Book', series: 'test' },
    rules: {
      stats: [{ name: 'TESTSTAT_A' }, { name: 'TESTSTAT_B' }],
    },
    character_creation: { steps: [] },
    sections: {
      '1': { text: 'start', events: [], choices: [] },
    },
    items_catalog: {},
  }, overrides);
}

// ============================================================
// Test 1: evalCondition covers every declared condition type.
// ============================================================
// MOTIVATED_BY: evalCondition is the gate for Rule 15 event-level
// conditions (discipline exemptions), character_creation_step.condition
// (schema v1.6), and equipment-aware conditions (schema v1.5+). A
// silent bug in any condition type would mis-fire events across every
// maintained book. No single pre-existing bug — defensive coverage
// for a mechanism the codex relies on in many rules.
// END_TO_END_VERIFY: drive the CLI emulator to any section whose
// event or choice carries a non-trivial `condition` (e.g. LW1 §229
// Kraan dust Mindshield check once encoded, or Warlock provision
// equipment-property gates); confirm the event fires or is skipped
// per the condition's logical value.
test('evalCondition — all condition types', () => {
  const book = {
    items_catalog: {
      test_item_01: { equippable: true, slot: 'weapon', properties: ['sharp'] },
    },
  };
  const state = play.initialState('synthetic');
  state.inventory = ['test_item_01'];
  state.flags = ['test_flag_alpha'];
  state.stats = { TESTSTAT_A: 5, TESTSTAT_B: 10 };
  state.abilities = ['test_ability_alpha'];
  state.equipment = { weapon: 'test_item_01' };
  state.lastTestResult = true;

  const E = (c) => play.evalCondition(c, state, book);
  assertEqual(E(null), true, 'null condition is always true');
  assertEqual(E({ type: 'has_item', item: 'test_item_01' }), true, 'has_item hit');
  assertEqual(E({ type: 'has_item', item: 'test_item_99' }), false, 'has_item miss');
  assertEqual(E({ type: 'has_flag', flag: 'test_flag_alpha' }), true, 'has_flag hit');
  assertEqual(E({ type: 'has_flag', flag: 'test_flag_zzz' }), false, 'has_flag miss');
  assertEqual(E({ type: 'stat_gte', stat: 'TESTSTAT_A', value: 5 }), true, 'stat_gte eq');
  assertEqual(E({ type: 'stat_gte', stat: 'TESTSTAT_A', value: 6 }), false, 'stat_gte under');
  assertEqual(E({ type: 'stat_lte', stat: 'TESTSTAT_B', value: 10 }), true, 'stat_lte eq');
  assertEqual(E({ type: 'stat_lte', stat: 'TESTSTAT_B', value: 9 }), false, 'stat_lte over');
  assertEqual(E({ type: 'has_ability', ability: 'test_ability_alpha' }), true, 'has_ability hit');
  assertEqual(E({ type: 'has_ability', ability: 'test_ability_beta' }), false, 'has_ability miss');
  assertEqual(E({ type: 'not', condition: { type: 'has_item', item: 'test_item_99' } }), true, 'not');
  assertEqual(E({
    type: 'and',
    conditions: [
      { type: 'has_item', item: 'test_item_01' },
      { type: 'has_flag', flag: 'test_flag_alpha' },
    ],
  }), true, 'and true');
  assertEqual(E({
    type: 'and',
    conditions: [
      { type: 'has_item', item: 'test_item_01' },
      { type: 'has_flag', flag: 'test_flag_zzz' },
    ],
  }), false, 'and false');
  assertEqual(E({
    type: 'or',
    conditions: [
      { type: 'has_item', item: 'test_item_99' },
      { type: 'has_flag', flag: 'test_flag_alpha' },
    ],
  }), true, 'or true');
  assertEqual(E({ type: 'test_succeeded' }), true, 'test_succeeded when lastTestResult true');
  state.lastTestResult = false;
  assertEqual(E({ type: 'test_failed' }), true, 'test_failed when lastTestResult false');
  assertEqual(E({ type: 'has_equipped_item', item: 'test_item_01' }), true, 'has_equipped_item');
  assertEqual(E({ type: 'has_equipped_item', item: 'test_item_99' }), false, 'has_equipped_item miss');
  assertEqual(E({ type: 'has_equipped_in_slot', slot: 'weapon' }), true, 'has_equipped_in_slot occupied');
  assertEqual(E({ type: 'has_equipped_in_slot', slot: 'shield' }), false, 'has_equipped_in_slot empty');
  assertEqual(E({ type: 'has_equipped_in_slot', slot: 'weapon', item: 'test_item_01' }), true, 'has_equipped_in_slot match');
  assertEqual(E({ type: 'has_equipped_in_slot', slot: 'weapon', item: 'test_item_99' }), false, 'has_equipped_in_slot mismatch');
  assertEqual(E({ type: 'has_equipped_with_property', property: 'sharp' }), true, 'has_equipped_with_property hit');
  assertEqual(E({ type: 'has_equipped_with_property', property: 'cursed' }), false, 'has_equipped_with_property miss');
});

// ============================================================
// Test 2: eat_meal auto-applies penalty when required:true and
// the player has zero food.
// ============================================================
// MOTIVATED_BY: eat_meal required:true + zero-provisions silent-
// success bug (engine commit 478f410 / codex v2.9.0). Pre-v2.9
// emulators offered neither "eat" (no food) nor "skip" (required:
// true) when the player hit a required meal with no provisions,
// deadlocking the UI while the book's intent was "take the
// penalty."
// END_TO_END_VERIFY: drive the CLI emulator through LW1 to a
// required eat_meal (sections 130/147/184/235/300 per
// known_issues.md) with zero meals/provisions and no Hunting
// discipline; watch state.stats.ENDURANCE drop by the book's
// penalty_amount without any "eat"/"skip" prompt.
test('eat_meal auto-penalty fires when required and no food', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'require meal',
        events: [{
          type: 'eat_meal',
          required: true,
          penalty_stat: 'TESTSTAT_A',
          penalty_amount: -3,
        }],
        choices: [],
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { TESTSTAT_A: 10 };
  state.provisions = 0;
  state.meals = 0;

  play.navigateTo(state, book, '1');

  assertEqual(state.pause && state.pause.type, 'section', 'no eat_meal pause — penalty auto-applied');
  assertEqual(state.stats.TESTSTAT_A, 7, 'penalty applied: 10 + (-3) = 7');
});

// ============================================================
// Test 3: eat_meal heals when the player eats and has food.
// ============================================================
// MOTIVATED_BY: eat_meal heal path — the normal food-available
// branch (pre-existing behavior, defensive coverage so the heal
// path stays distinct from the auto-penalty path).
// END_TO_END_VERIFY: drive the CLI emulator through LW1 to any
// rest-heal section (e.g. §63 after receiving a meal from a
// villager) holding provisions > 0; confirm ENDURANCE climbs by
// the book's heal_amount and provisions decrements by 1.
test('eat_meal heals and decrements provisions on eat action', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'offer meal',
        events: [{
          type: 'eat_meal',
          required: false,
          heal_stat: 'TESTSTAT_A',
          heal_amount: 3,
        }],
        choices: [],
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { TESTSTAT_A: 5 };
  state.provisions = 2;

  play.navigateTo(state, book, '1');
  assertEqual(state.pause && state.pause.type, 'eat_meal', 'paused on eat_meal');

  play.applyAction(state, book, 'eat', []);
  assertEqual(state.stats.TESTSTAT_A, 8, 'heal applied: 5 + 3 = 8');
  assertEqual(state.provisions, 1, 'provisions decremented');
});

// ============================================================
// Test 4: event-level condition (Rule 15) skips eat_meal when
// the player has an exempting ability (e.g. Lone Wolf's Hunting).
// ============================================================
// MOTIVATED_BY: Rule 15 event-level condition gate (schema v1.2+).
// The exemption mechanism is how Hunting-style disciplines avoid
// mandatory meal penalties without per-section bespoke logic.
// A regression here would silently re-apply required-meal
// penalties to exempt characters.
// END_TO_END_VERIFY: drive the CLI emulator through LW1 to a
// required eat_meal section (e.g. §235) holding zero provisions
// AND the Hunting discipline (choose Hunting at character
// creation); confirm no penalty is applied and no eat_meal
// pause surfaces.
test('eat_meal event-level condition skips event when condition false', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'would-require meal',
        events: [{
          type: 'eat_meal',
          required: true,
          penalty_stat: 'TESTSTAT_A',
          penalty_amount: -3,
          condition: {
            type: 'not',
            condition: { type: 'has_ability', ability: 'test_ability_alpha' },
          },
        }],
        choices: [],
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { TESTSTAT_A: 10 };
  state.provisions = 0;
  state.abilities = ['test_ability_alpha'];

  play.navigateTo(state, book, '1');

  assertEqual(state.pause && state.pause.type, 'section', 'no eat_meal pause — event skipped');
  assertEqual(state.stats.TESTSTAT_A, 10, 'no penalty applied — exemption honoured');
});

// ============================================================
// Test 5: roll_resource routes to canonical gold / provisions /
// meals slots (not to state.stats).
// ============================================================
// MOTIVATED_BY: roll_resource action added in codex v2.9.0 /
// schema v1.6.0 (engine commit 4e25fb6). Replaces the pre-v1.6
// anti-pattern of roll_stat with a scratch stat name for canonical
// currency rolls. A silent routing bug here would write the
// rolled total to the wrong slot and display zero gold to the
// player.
// END_TO_END_VERIFY: drive the CLI emulator through LW1 character
// creation to step 6 (Gold Crowns); provide_roll a fixed value
// like 7; confirm state.gold === 7 and state.stats.gold_crowns
// is undefined after the step advances.
test('roll_resource routes to canonical gold slot', () => {
  const book = buildBook({
    character_creation: {
      steps: [{ action: 'roll_resource', resource: 'gold', formula: 'R10' }],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);
  assertEqual(state.pause && state.pause.type, 'character_creation_roll_resource', 'paused on roll_resource');

  play.applyAction(state, book, 'provide_roll', ['7']);
  assertEqual(state.gold, 7, 'gold slot populated');
  assertEqual(state.stats.gold, undefined, 'no gold stat created');
  assertTrue(state.creationDone, 'creation completed');
});

// ============================================================
// Test 6: roll_resource routes to a declared-stat-currency when
// the resource name matches a stat in rules.stats[].
// ============================================================
// MOTIVATED_BY: roll_resource declared-stat-currency path. Books
// like GrailQuest carry GOLD / EXPERIENCE as first-class stats
// (not as canonical slots), and roll_resource must route into
// state.stats[name] when the name matches a declared stat.
// END_TO_END_VERIFY: when GrailQuest migrates to roll_resource
// for its starting GOLD roll, drive the CLI emulator through
// character creation; confirm state.stats.GOLD holds the rolled
// value and state.gold remains 0.
test('roll_resource routes to declared-stat-currency slot', () => {
  const book = buildBook({
    rules: { stats: [{ name: 'TESTSTAT_CURRENCY' }] },
    character_creation: {
      steps: [{ action: 'roll_resource', resource: 'TESTSTAT_CURRENCY', formula: 'R10' }],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);
  play.applyAction(state, book, 'provide_roll', ['4']);

  assertEqual(state.stats.TESTSTAT_CURRENCY, 4, 'declared-stat slot populated');
  assertEqual(state.gold, 0, 'canonical gold untouched');
});

// ============================================================
// Test 7: character_creation_step.condition skips the step when
// the condition evaluates false.
// ============================================================
// MOTIVATED_BY: character_creation_step.condition added in schema
// v1.6 (engine commit 3a6e34f). Motivating case: LW1's Weaponskill
// weapon-type roll should only fire when the player picked the
// Weaponskill discipline in a preceding choose_abilities step.
// A regression would run conditional steps unconditionally and
// produce spurious state mutations.
// END_TO_END_VERIFY: drive the CLI emulator through LW1 character
// creation WITHOUT picking Weaponskill; confirm the weapon-type
// roll step is skipped (no pause, no prompt) and creation
// proceeds to the next step.
test('character_creation_step.condition skips step when false', () => {
  const book = buildBook({
    character_creation: {
      steps: [
        {
          action: 'add_item',
          item: 'test_item_01',
          condition: { type: 'has_item', item: 'test_item_99' },
        },
        { action: 'add_item', item: 'test_item_02' },
      ],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);

  assertTrue(!state.inventory.includes('test_item_01'), 'conditional step skipped');
  assertTrue(state.inventory.includes('test_item_02'), 'unconditional step fired');
});

// ============================================================
// Test 8: character_creation_step.condition executes the step
// when the condition evaluates true.
// ============================================================
// MOTIVATED_BY: character_creation_step.condition true-branch —
// complements Test 7. The condition gate must be inert when the
// predicate holds.
// END_TO_END_VERIFY: drive the CLI emulator through LW1 character
// creation AFTER picking Weaponskill; confirm the weapon-type
// roll step DOES pause for the roll and routes the result into
// the appropriate Weaponskill weapon pick.
test('character_creation_step.condition executes step when true', () => {
  const book = buildBook({
    character_creation: {
      steps: [
        { action: 'add_item', item: 'test_item_01' },
        {
          action: 'add_item',
          item: 'test_item_02',
          condition: { type: 'has_item', item: 'test_item_01' },
        },
      ],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);

  assertTrue(state.inventory.includes('test_item_01'), 'first step fired');
  assertTrue(state.inventory.includes('test_item_02'), 'conditional step fired (condition true)');
});

// ============================================================
// Test 9: manual_set records its invocation and flips the run to
// TIER 3 PARTIAL in both compactState and summarize output.
// ============================================================
// MOTIVATED_BY: Tier 3 PARTIAL reporting on manual_set (engine
// commit 24532e6 / codex v2.9.0 Rule 16). Closes DEV_PROCESS.md
// failure mode 4 ("workaround-as-success reporting"). A silent
// regression would let a sub-agent paper over a parser gap and
// report the run as CLEAN, which the prior behavior did.
// END_TO_END_VERIFY: run a replay.js playback that invokes
// `manual_set stats.ENDURANCE 20` at any point; confirm the
// final envelope's tier3_status is "PARTIAL", tier3_manual_sets
// contains one entry, and the summary header includes the
// "[!!! TIER 3 PARTIAL ...]" banner.
test('manual_set records invocation and flips tier3 status to PARTIAL', () => {
  const book = buildBook();
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.currentSection = '1';

  play.applyAction(state, book, 'manual_set', ['stats.TESTSTAT_A', '5']);

  assertEqual(state.stats.TESTSTAT_A, 5, 'manual_set applied the value');
  assertEqual(state.manualSets.length, 1, 'manual_set invocation recorded');
  assertEqual(state.manualSets[0].key, 'stats.TESTSTAT_A', 'key recorded');
  assertEqual(state.manualSets[0].value, 5, 'value recorded (JSON-parsed)');

  const compact = play.compactState(state);
  assertEqual(compact.manualSets.length, 1, 'compactState exposes manualSets');

  const summary = play.summarize(state, book);
  assertTrue(summary.startsWith('[!!! TIER 3 PARTIAL'), 'summary starts with TIER 3 PARTIAL banner');
});

// ============================================================
// Test 10: rules.provisions.starting_amount auto-initialises
// state.provisions at startCharacterCreation.
// ============================================================
// MOTIVATED_BY: provisions auto-init (engine commit a0bc9ea /
// codex v2.9.0 Rule 21). Ensures state.provisions is set even
// when character_creation.steps[] forgets an explicit
// set_resource, or (worse) uses the wrong slot name (the LW1
// `set_resource resource:"meals"` bug that motivated Rule 21).
// END_TO_END_VERIFY: drive the CLI emulator through LW1 character
// creation; confirm "Provisions: 1" surfaces in the post-
// creation equipment display regardless of whether step 5
// explicitly sets provisions.
test('rules.provisions.starting_amount auto-initialises state.provisions', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'TESTSTAT_A' }],
      provisions: { starting_amount: 1 },
    },
    character_creation: { steps: [] },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);

  assertEqual(state.provisions, 1, 'provisions auto-initialised from rules.provisions.starting_amount');
});

// ============================================================
// Test 11: eat_meal honours explicit heal_amount: 0 on rules.provisions
// (no per-event override), does NOT fall through to the 4-default.
// ============================================================
// MOTIVATED_BY: `|| 4` fallback bug surfaced by the Chat #8 LW1
// fresh-parse probe (emulators v3.2.1). cli-emulator/play.js:1729
// and index.html:3362 both read
// `event.heal_amount || book.rules?.provisions?.heal_amount || 4;`,
// which coalesces an explicit 0 to the default 4 — a book whose
// plain Meals restore nothing (LW1: Meals are sustenance only;
// healing comes from named Laumspur only) ended up granting +4
// ENDURANCE per Meal eaten. Fix: switch both sites to `??`.
// END_TO_END_VERIFY: drive the CLI emulator through LW1 to any
// offered eat_meal (e.g. §63 or any section where the player may
// voluntarily eat); confirm ENDURANCE does NOT increase and the
// provisions counter decrements by 1.
test('eat_meal honours explicit heal_amount: 0 (no || 4 fallthrough)', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'TESTSTAT_A' }],
      provisions: { heal_amount: 0, heal_stat: 'TESTSTAT_A' },
    },
    sections: {
      '1': {
        text: 'offer meal',
        events: [{ type: 'eat_meal', required: false }],
        choices: [],
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { TESTSTAT_A: 5 };
  state.provisions = 2;

  play.navigateTo(state, book, '1');
  assertEqual(state.pause && state.pause.type, 'eat_meal', 'paused on eat_meal');

  play.applyAction(state, book, 'eat', []);
  assertEqual(state.stats.TESTSTAT_A, 5, 'heal_amount: 0 honoured — no heal applied');
  assertEqual(state.provisions, 1, 'provisions decremented regardless of heal');
});

// ============================================================
// Test 12: roll_dice per-range effects (Rule 22, schema v1.8+).
// ============================================================
// MOTIVATED_BY: Chat #8 LW1 fresh-parse probe surfaced that
// roll_dice.results[range] couldn't express "lose 2 ENDURANCE AND
// turn to 140" without demoting the whole event to a script event.
// Rule 22 adds a per-range `effects` array that fires after range
// match and before navigation. Canonical example: LW1 §36 ladder.
// END_TO_END_VERIFY: encode LW1 §36 as a `roll_dice` with per-range
// effects during LW iter 14 sub-agent pass; drive the emulator
// through §36, confirm ENDURANCE drops by 2 on a 0-4 roll, stays
// put on a 5-9 roll, and that navigation lands on 140 or 323
// respectively.
test('roll_dice per-range effects apply on match, before navigation', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'roll branch',
        events: [{
          type: 'roll_dice',
          dice: 'R10',
          prompt: 'pick',
          results: {
            '0-4': {
              text: 'fall',
              effects: [{ type: 'modify_stat', stat: 'TESTSTAT_A', amount: -2 }],
              target: '2',
            },
            '5-9': { text: 'safe', target: '3' },
          },
        }],
        choices: [],
      },
      '2': { text: 'fell', events: [], choices: [] },
      '3': { text: 'safe', events: [], choices: [] },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { TESTSTAT_A: 10 };

  play.navigateTo(state, book, '1');
  assertEqual(state.pause && state.pause.type, 'roll_dice', 'paused on roll_dice');

  // Force a low roll (2 → within 0-4): effects should fire, then navigate to 2.
  play.applyAction(state, book, 'provide_roll', [2]);
  assertEqual(state.stats.TESTSTAT_A, 8, 'per-range modify_stat effect applied (-2)');
  assertEqual(state.currentSection, '2', 'navigated to target after effects');

  // Reset and try a high roll: no effects, navigate to 3.
  const state2 = play.initialState('synthetic');
  state2.frontmatterDone = true;
  state2.creationDone = true;
  state2.pause = null;
  state2.stats = { TESTSTAT_A: 10 };
  play.navigateTo(state2, book, '1');
  play.applyAction(state2, book, 'provide_roll', [7]);
  assertEqual(state2.stats.TESTSTAT_A, 10, 'non-matching range has no effects');
  assertEqual(state2.currentSection, '3', 'navigated to high-roll target');
});

// ============================================================
// Test 13: rules.combat_system.standing_modifiers merge into
// combat at start (Rule 23, schema v1.8+).
// ============================================================
// MOTIVATED_BY: Chat #8 LW1 fresh-parse probe surfaced that LW's
// book-wide "no weapon in hand = -4 COMBAT SKILL" rule had no
// canonical home — it was either re-encoded on every combat event
// (lossy) or left as narrative-only text (silent). Rule 23 adds
// a `standing_modifiers` list under rules.combat_system that the
// emulator merges with per-section and per-enemy modifiers at
// every combat start.
// END_TO_END_VERIFY: populate rules.combat_system.standing_modifiers
// on LW1 with the no-weapon -4 rule during LW iter 14 sub-agent
// pass; drive a CLI combat with and without an equipped weapon;
// confirm the modifier panel shows the -4 when no weapon equipped
// and omits it when a weapon is equipped.
test('standing_modifiers merge into combat, condition-gated', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'COMBAT_SKILL' }, { name: 'HEALTH' }],
      attack_stat: 'COMBAT_SKILL',
      health_stat: 'HEALTH',
      combat_system: {
        round_script: '-- noop round script',
        standing_modifiers: [{
          target: 'player.attack',
          delta: -4,
          condition: { type: 'not', condition: { type: 'has_equipped_in_slot', slot: 'weapon' } },
          reason: 'No weapon in hand',
        }],
      },
    },
    sections: {
      '1': {
        text: 'fight',
        events: [{
          type: 'combat',
          enemy_ref: 'test_enemy_01',
          win_to: '2',
        }],
        choices: [],
      },
      '2': { text: 'won', events: [], choices: [] },
    },
    enemies_catalog: {
      test_enemy_01: { name: 'Test Enemy', COMBAT_SKILL: 10, HEALTH: 5 },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { COMBAT_SKILL: 15, HEALTH: 20 };
  state.inventory = [];
  state.equipment = {};

  play.navigateTo(state, book, '1');
  assertTrue(state.combat, 'combat started');
  const mods = state.combat.appliedModifiers;
  assertTrue(Array.isArray(mods), 'appliedModifiers is an array');
  const standing = mods.find(m => m.reason === 'No weapon in hand');
  assertTrue(standing, 'standing modifier present when no weapon equipped');
  assertEqual(standing.delta, -4, 'standing modifier delta is -4');

  // Re-run with a weapon equipped: condition fails, modifier skipped.
  const state2 = play.initialState('synthetic');
  state2.frontmatterDone = true;
  state2.creationDone = true;
  state2.pause = null;
  state2.stats = { COMBAT_SKILL: 15, HEALTH: 20 };
  state2.inventory = ['test_weapon_01'];
  state2.equipment = { weapon: 'test_weapon_01' };

  play.navigateTo(state2, book, '1');
  const mods2 = state2.combat.appliedModifiers;
  const standing2 = mods2.find(m => m.reason === 'No weapon in hand');
  assertTrue(!standing2, 'standing modifier skipped when weapon equipped');
});

// ============================================================
// Test 14: remove_inventory_category purges category + unequips
// (Rule 24, schema v1.8+).
// ============================================================
// MOTIVATED_BY: Chat #8 LW1 fresh-parse probe surfaced that §188
// ("the Kraan has ripped away your Backpack") had no single-event
// encoding — the alternative was a per-id remove_item sequence
// that is lossy (misses newly-added items) and fragile. Rule 24
// adds a category-based primitive.
// END_TO_END_VERIFY: encode LW1 §188 as a single
// remove_inventory_category event during LW iter 14; drive the
// emulator through §188 with a populated Backpack; confirm every
// backpack-category item drops from state.inventory AND any
// equipped item in that category is auto-unequipped.
test('remove_inventory_category drops category items and unequips', () => {
  const book = buildBook({
    items_catalog: {
      test_item_bp_01: { name: 'Rope',    type: 'general', inventory_category: 'backpack' },
      test_item_bp_02: { name: 'Helmet',  type: 'armor',   inventory_category: 'backpack', equippable: true, slot: 'head' },
      test_item_sp_01: { name: 'Amulet',  type: 'general', inventory_category: 'special' },
      test_item_free:  { name: 'Loose',   type: 'general' },
    },
    sections: {
      '1': {
        text: 'Kraan rips',
        events: [{ type: 'remove_inventory_category', category: 'backpack', reason: 'Kraan attack' }],
        choices: [],
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.inventory = ['test_item_bp_01', 'test_item_bp_02', 'test_item_sp_01', 'test_item_free'];
  state.equipment = { head: 'test_item_bp_02' };

  play.navigateTo(state, book, '1');

  assertTrue(!state.inventory.includes('test_item_bp_01'), 'backpack item 1 removed');
  assertTrue(!state.inventory.includes('test_item_bp_02'), 'backpack item 2 removed');
  assertTrue(state.inventory.includes('test_item_sp_01'), 'special item preserved');
  assertTrue(state.inventory.includes('test_item_free'),  'uncategorised item preserved');
  assertTrue(!state.equipment.head, 'equipped backpack item auto-unequipped');
});

// ============================================================
// Test 15: Named-consumable `consume.satisfies_eat_meal` path
//          (Rule 25 / schema v1.9).
// ============================================================
// MOTIVATED_BY: Rule 25 introduces `items_catalog[id].consume` so that
// named magical consumables (Laumspur-family) can be offered as
// alternatives during an eat_meal pause. Chat #11 sub-agent flagged
// that LW1 laumspur had no machine-readable heal mechanic — Rule 21's
// carve-out described when items_catalog entries are legal but did not
// specify how their eating resolves. Rule 25 closes the gap.
// END_TO_END_VERIFY: drive the CLI emulator to an eat_meal event with
// both generic provisions and a named consumable in inventory; confirm
// the named-consumable action appears, applies its consume.effects,
// decrements the named item (not provisions), and satisfies the pause.
test('named consumable satisfies eat_meal, runs effects, leaves provisions alone', () => {
  const book = buildBook({
    rules: {
      stats: [
        { name: 'TESTSTAT_HP', initial: 20, initial_is_max: true, min: 0 },
      ],
      provisions: { enabled: true, starting_amount: 2, heal_amount: 1, heal_stat: 'TESTSTAT_HP' },
    },
    items_catalog: {
      test_consumable_alpha: {
        name: 'Alpha Herb',
        type: 'consumable',
        inventory_category: 'backpack',
        consume: {
          satisfies_eat_meal: true,
          effects: [
            { type: 'modify_stat', stat: 'TESTSTAT_HP', amount: 5 },
            { type: 'set_flag', flag: 'ate_alpha_herb' },
          ],
        },
      },
      test_item_plain: {
        name: 'Plain Rock',
        type: 'general',
      },
    },
    sections: {
      '1': {
        text: 'Eat prompt',
        events: [{ type: 'eat_meal', required: true }],
        choices: [],
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.stats.TESTSTAT_HP = 10;
  state.initialStats.TESTSTAT_HP = 20;
  state.provisions = 2;
  state.inventory = ['test_consumable_alpha', 'test_item_plain'];
  state.pause = null;

  play.navigateTo(state, book, '1');

  // We should be paused on eat_meal with the named consumable available.
  assertEqual(state.pause.type, 'eat_meal', 'paused on eat_meal');
  const actions = play.getAvailableActions(state, book).map(a => a.name);
  assertTrue(actions.includes('eat'), 'generic eat available');
  assertTrue(actions.includes('eat_test_consumable_alpha'), 'named-consumable eat available');

  play.applyAction(state, book, 'eat_test_consumable_alpha');

  assertEqual(state.stats.TESTSTAT_HP, 15, 'named-consumable effects applied (10 + 5)');
  assertEqual(state.provisions, 2, 'provisions untouched — named consumable is a substitute');
  assertTrue(!state.inventory.includes('test_consumable_alpha'), 'consumed item removed from inventory');
  assertTrue(state.inventory.includes('test_item_plain'), 'other inventory items untouched');
  assertTrue(state.flags.includes('ate_alpha_herb'), 'consume.effects set_flag fired');
  assertTrue(!state.pause || state.pause.type !== 'eat_meal', 'eat_meal pause cleared');
});

// ============================================================
// Test 16: Named-consumable keeps a required eat_meal alive when
//          generic provisions are zero but a consumable is available.
// ============================================================
// MOTIVATED_BY: Rule 25 broadens the eat_meal zero-food auto-penalty
// check to consider named consumables — otherwise a player with 0
// generic provisions but 1 Laumspur would eat the forced penalty even
// though they have a legal meal option.
// END_TO_END_VERIFY: set provisions to 0, hold a named consumable,
// drive to a required eat_meal; confirm the pause opens (no
// auto-penalty) and the named-consumable action is available.
test('eat_meal does not auto-penalty when only a named consumable is available', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'TESTSTAT_HP', initial: 20, initial_is_max: true, min: 0 }],
      provisions: { enabled: true, starting_amount: 0, heal_amount: 1, heal_stat: 'TESTSTAT_HP' },
    },
    items_catalog: {
      test_consumable_beta: {
        name: 'Beta Root',
        type: 'consumable',
        consume: {
          satisfies_eat_meal: true,
          effects: [{ type: 'modify_stat', stat: 'TESTSTAT_HP', amount: 3 }],
        },
      },
    },
    sections: {
      '1': {
        text: 'Forced meal',
        events: [{ type: 'eat_meal', required: true, penalty_amount: -3, penalty_stat: 'TESTSTAT_HP' }],
        choices: [],
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.stats.TESTSTAT_HP = 10;
  state.initialStats.TESTSTAT_HP = 20;
  state.provisions = 0;
  state.meals = 0;
  state.inventory = ['test_consumable_beta'];
  state.pause = null;

  play.navigateTo(state, book, '1');

  assertEqual(state.pause.type, 'eat_meal', 'paused on eat_meal rather than auto-penalty');
  assertEqual(state.stats.TESTSTAT_HP, 10, 'penalty not applied yet');
});

// ============================================================
// Runner footer
// ============================================================
const total = passed + failures.length;
console.log('');
console.log(`${passed}/${total} tests passed`);
if (failures.length > 0) {
  process.exit(1);
}
