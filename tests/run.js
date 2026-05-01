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
// Test 17: distribute_points validates sum against total_points and
//          rejects allocations that fall outside per-stat ranges;
//          accepts valid allocations and writes each stat to both
//          state.stats and state.initialStats.
// ============================================================
// MOTIVATED_BY: Rule 26 / schema v1.10+ (Windhammer Bug A). Point-buy
// character creation had no schema primitive before v1.10, so
// unprofiled parses either invented a non-standard generation string
// (which neither emulator reads) or papered over the gap with
// manual_set. v1.10's distribute_points action closes the mechanism
// gap; this test locks in the validation + write semantics so a
// future regression doesn't silently accept invalid allocations.
// END_TO_END_VERIFY: drive the CLI through Windhammer character
// creation and confirm the point-buy step paused, rejects
// over/under allocations, and commits the valid allocation into
// both state.stats and state.initialStats for each named attribute.
test('distribute_points validates sum + ranges and writes stats + initialStats', () => {
  const book = buildBook({
    rules: {
      stats: [
        { name: 'TESTSTAT_STR', initial_is_max: true },
        { name: 'TESTSTAT_AGI', initial_is_max: true },
        { name: 'TESTSTAT_END', initial_is_max: true },
      ],
    },
    character_creation: {
      steps: [
        {
          action: 'distribute_points',
          total_points: 20,
          stats: [
            { name: 'TESTSTAT_STR', min: 5, max: 11 },
            { name: 'TESTSTAT_AGI', min: 5, max: 11 },
            { name: 'TESTSTAT_END', min: 5, max: 11 },
          ],
        },
      ],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);
  assertEqual(state.pause && state.pause.type, 'character_creation_distribute', 'paused on distribute');

  // Wrong sum — should be rejected, pause still active, no stats written.
  play.applyAction(state, book, 'distribute', ['TESTSTAT_STR=7', 'TESTSTAT_AGI=7', 'TESTSTAT_END=7']);
  assertEqual(state.pause && state.pause.type, 'character_creation_distribute', 'sum=21 rejected, pause retained');
  assertEqual(state.stats.TESTSTAT_STR, undefined, 'stats not mutated on rejection');

  // Out-of-range — should be rejected.
  play.applyAction(state, book, 'distribute', ['TESTSTAT_STR=12', 'TESTSTAT_AGI=4', 'TESTSTAT_END=4']);
  assertEqual(state.pause && state.pause.type, 'character_creation_distribute', 'out-of-range rejected, pause retained');

  // Valid allocation.
  play.applyAction(state, book, 'distribute', ['TESTSTAT_STR=7', 'TESTSTAT_AGI=6', 'TESTSTAT_END=7']);
  assertEqual(state.stats.TESTSTAT_STR, 7, 'STR written');
  assertEqual(state.stats.TESTSTAT_AGI, 6, 'AGI written');
  assertEqual(state.stats.TESTSTAT_END, 7, 'END written');
  assertEqual(state.initialStats.TESTSTAT_STR, 7, 'initial STR written');
  assertEqual(state.initialStats.TESTSTAT_AGI, 6, 'initial AGI written');
  assertEqual(state.initialStats.TESTSTAT_END, 7, 'initial END written');
  assertTrue(state.creationDone, 'creation completed after valid allocation');
});

// ============================================================
// Test 18: Book-load validation warns when rules.attack_stat names
//          a stat not declared in rules.stats[] (Windhammer Bug C).
// ============================================================
// MOTIVATED_BY: Rule 26 / Windhammer Bug C. v2.8's Windhammer parse
// set rules.attack_stat: "combat_value" without declaring
// combat_value in rules.stats[], causing player.attack to resolve to
// 0 for the whole fight with no diagnostic. v3.5's validation pass
// writes a visible warning so the root cause is named at load time.
// END_TO_END_VERIFY: load a book whose rules.attack_stat mismatches
// rules.stats[] in either emulator; confirm a warning banner
// appears above the play area / at the top of the status output
// before the first section renders.
test('validateBookShape warns on rules.attack_stat not declared in rules.stats[]', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'TESTSTAT_STR' }, { name: 'TESTSTAT_AGI' }],
      attack_stat: 'TESTSTAT_CV',
    },
    character_creation: {
      steps: [
        { action: 'set_resource', resource: 'TESTSTAT_STR', amount: 8 },
        { action: 'set_resource', resource: 'TESTSTAT_AGI', amount: 8 },
      ],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);

  assertTrue(Array.isArray(state.validationWarnings), 'validationWarnings array exists');
  const joined = (state.validationWarnings || []).join(' | ');
  assertTrue(/TESTSTAT_CV/.test(joined), 'warning names the undeclared attack_stat');
  assertTrue(/attack_stat/.test(joined), 'warning mentions attack_stat');
});

// ============================================================
// Test 19: Post-creation validation warns when a declared stat is
//          still undefined after character_creation.steps[] completed.
// ============================================================
// MOTIVATED_BY: Rule 26 / Windhammer Bug C. The "stat declared but
// never initialised" case — a book that lists a stat in rules.stats[]
// but ships no character-creation step that writes it. Without the
// post-creation check, the stat renders as em-dash with no root-cause
// diagnostic; with the check, a warning names the stat so the codex
// run's incomplete output is visible.
// END_TO_END_VERIFY: load a book whose rules.stats[] declares a stat
// with no matching character_creation step; confirm a warning
// appears on the validation banner after character creation
// completes.
test('validatePostCreation warns on declared-but-uninitialised stat', () => {
  const book = buildBook({
    rules: {
      stats: [
        { name: 'TESTSTAT_INIT' },
        { name: 'TESTSTAT_GHOST' },  // declared but never set
      ],
    },
    character_creation: {
      steps: [
        { action: 'set_resource', resource: 'TESTSTAT_INIT', amount: 10 },
      ],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);

  const joined = (state.validationWarnings || []).join(' | ');
  assertTrue(/TESTSTAT_GHOST/.test(joined), 'warning names the uninitialised stat');
  assertTrue(!/TESTSTAT_INIT/.test(joined) || /TESTSTAT_INIT.*undefined/.test(joined) === false, 'initialised stat not flagged');
});

// ============================================================
// Test 20: Endings placement — both shapes accepted (schema v1.11).
// ============================================================
// MOTIVATED_BY: Section 2.1a / v2.15.0. The schema accepts two
// interchangeable placements for death_endings / victory_endings:
// (a) section-id arrays inside metadata.confidence.{death,victory}_endings
//     — single-chat parses, matches LW1 / Warlock / GrailQuest / WWY;
// (b) section-id arrays at the top level of the book with INTEGER
//     COUNTS in metadata.confidence.{death,victory}_endings —
//     multi-chunk accumulators per Section 9.9 (the Windhammer
//     accumulator drift Chat #21's merge helper introduced).
// Pre-v1.11 the schema only accepted (a); v1.11 broadens
// metadata.confidence.{death,victory}_endings to oneOf [array,
// integer] and adds top-level death_endings / victory_endings as
// optional arrays so both shapes round-trip.
// END_TO_END_VERIFY: load any maintained book (shape a) and the
// Windhammer accumulator (shape b); both should pass schema
// validation and the emulator's book-load path should not raise.
test('schema v1.11 accepts both endings placements (confidence-array and top-level-array+confidence-int)', () => {
  // Schema-shape assertions: both shapes appear in the schema text.
  const fs = require('fs');
  const schemaText = fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8');
  const schema = JSON.parse(schemaText);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.14.0', 'schema title at v1.14.0');

  // Top-level death_endings / victory_endings declared.
  assertTrue(!!schema.properties.death_endings, 'top-level death_endings declared');
  assertTrue(!!schema.properties.victory_endings, 'top-level victory_endings declared');
  assertEqual(schema.properties.death_endings.type, 'array', 'top-level death_endings is array');
  assertEqual(schema.properties.victory_endings.type, 'array', 'top-level victory_endings is array');

  // metadata.confidence.{death,victory}_endings broadened to oneOf [array, integer].
  const conf = schema.properties.metadata.properties.confidence.properties;
  assertTrue(Array.isArray(conf.death_endings.oneOf), 'confidence.death_endings is oneOf');
  assertTrue(Array.isArray(conf.victory_endings.oneOf), 'confidence.victory_endings is oneOf');
  const deTypes = conf.death_endings.oneOf.map((s) => s.type).sort();
  const veTypes = conf.victory_endings.oneOf.map((s) => s.type).sort();
  assertEqual(JSON.stringify(deTypes), JSON.stringify(['array', 'integer']), 'confidence.death_endings oneOf [array, integer]');
  assertEqual(JSON.stringify(veTypes), JSON.stringify(['array', 'integer']), 'confidence.victory_endings oneOf [array, integer]');

  // Behavioral: emulator's book-load path accepts both shapes without raising.
  // Shape (a): arrays inside metadata.confidence (the single-chat parse shape).
  const bookA = buildBook({
    metadata: {
      title: 'Synthetic A',
      confidence: {
        sections_parsed: 1,
        death_endings: [10, 36, 40],
        victory_endings: [250, 500, 600],
      },
    },
  });
  const stateA = play.initialState('synthetic');
  stateA.frontmatterDone = true;
  play.startCharacterCreation(stateA, bookA);
  // No throw is the success signal; the emulator does not read these fields
  // for runtime, but the load path walks metadata and must not choke.

  // Shape (b): top-level arrays + integer counts in metadata.confidence
  // (the multi-chunk-accumulator shape, e.g. Windhammer claude_session output).
  const bookB = buildBook({
    metadata: {
      title: 'Synthetic B',
      confidence: {
        sections_parsed: 1,
        death_endings: 38,
        victory_endings: 3,
      },
    },
    death_endings: [10, 36, 40, 73, 84],
    victory_endings: [250, 500, 600],
  });
  const stateB = play.initialState('synthetic');
  stateB.frontmatterDone = true;
  play.startCharacterCreation(stateB, bookB);
  // No throw is the success signal.

  assertTrue(true, 'both endings placements accepted by schema and emulator');
});

// ============================================================
// Test 21: modify_stat.set_initial_to caps initialStats at an
//          absolute value and clamps current down when above it
//          (schema v1.12+ / Rule 30 cap-pattern first-class encoding).
// ============================================================
// MOTIVATED_BY: Codex v2.16.0 Rule 30 update. Pre-v1.12 the
// canonical encoding for an absolute ceiling cap ("from now on
// your STRENGTH cannot exceed 11" — Windhammer §440) was a
// `script` event clamping both state.initialStats and state.stats
// via the Lua sandbox. v1.12 adds `modify_stat.set_initial_to`
// as a single-event encoding. This test locks in the three
// behaviors a future regression must preserve: (a) initialStats
// is assigned the absolute value, (b) current is clamped down
// when above the new ceiling, (c) current is left alone when
// already at or below the new ceiling (raising a ceiling does
// not auto-heal).
// END_TO_END_VERIFY: drive the CLI emulator through Windhammer
// §440 / §533 once those sections are migrated from the Rule 30
// script-event workaround to set_initial_to; confirm the player's
// initial STRENGTH/ENDURANCE drops to the cap value and current
// is clamped down if it was previously above it.
test('modify_stat.set_initial_to caps initialStats and clamps current when above', () => {
  const book = buildBook({
    rules: { stats: [{ name: 'TESTSTAT_STR', initial_is_max: true }] },
    sections: {
      '1': {
        text: 'cap STR at 11',
        events: [{ type: 'modify_stat', stat: 'TESTSTAT_STR', set_initial_to: 11, reason: 'cap' }],
        choices: [],
      },
    },
  });

  // Case (a): current ABOVE the cap — both ceiling and current drop.
  const stateA = play.initialState('synthetic');
  stateA.frontmatterDone = true;
  stateA.creationDone = true;
  stateA.pause = null;
  stateA.stats = { TESTSTAT_STR: 13 };
  stateA.initialStats = { TESTSTAT_STR: 13 };
  play.navigateTo(stateA, book, '1');
  assertEqual(stateA.initialStats.TESTSTAT_STR, 11, '(a) initial assigned to 11');
  assertEqual(stateA.stats.TESTSTAT_STR, 11, '(a) current clamped from 13 to 11');

  // Case (b): current AT the cap — ceiling assigned, current unchanged.
  const stateB = play.initialState('synthetic');
  stateB.frontmatterDone = true;
  stateB.creationDone = true;
  stateB.pause = null;
  stateB.stats = { TESTSTAT_STR: 11 };
  stateB.initialStats = { TESTSTAT_STR: 13 };
  play.navigateTo(stateB, book, '1');
  assertEqual(stateB.initialStats.TESTSTAT_STR, 11, '(b) initial assigned to 11');
  assertEqual(stateB.stats.TESTSTAT_STR, 11, '(b) current unchanged at 11');

  // Case (c): current BELOW the cap — ceiling assigned, current unchanged.
  const stateC = play.initialState('synthetic');
  stateC.frontmatterDone = true;
  stateC.creationDone = true;
  stateC.pause = null;
  stateC.stats = { TESTSTAT_STR: 8 };
  stateC.initialStats = { TESTSTAT_STR: 13 };
  play.navigateTo(stateC, book, '1');
  assertEqual(stateC.initialStats.TESTSTAT_STR, 11, '(c) initial assigned to 11');
  assertEqual(stateC.stats.TESTSTAT_STR, 8, '(c) current unchanged at 8 (no auto-heal)');

  // Schema-shape assertion: set_initial_to declared on event properties,
  // schema title at v1.12.0.
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.14.0', 'schema title at v1.14.0');
  const eventProps = schema.definitions.event.properties;
  assertTrue(!!eventProps.set_initial_to, 'event.set_initial_to declared');
  assertEqual(eventProps.set_initial_to.type, 'number', 'event.set_initial_to is number');
});

// ============================================================
// Test 22: combat.win_after_rounds ends combat in victory once
//          the round counter reaches the threshold (Rule 31,
//          schema v1.13+).
// ============================================================
// MOTIVATED_BY: Codex v2.17.0 Rule 31. Pre-v1.13 endurance-framed
// combats ("hold the gate for three rounds" — Windhammer §516)
// had no clean encoding; workarounds inflated enemy health (which
// silently re-encodes the win condition as "deal enough damage")
// or used a script event with a manual round counter. v1.13 adds
// `combat.win_after_rounds` as a non-defeat win condition the
// emulator's checkCombatEnd consults after each round. This test
// drives a synthetic combat through three no-damage rounds and
// asserts the emulator ends combat in victory exactly at the
// threshold and navigates to win_to.
// END_TO_END_VERIFY: drive the CLI emulator through Windhammer
// §516 once that section is migrated from the manual-counter
// workaround to win_after_rounds; confirm combat ends in victory
// after surviving the stated number of rounds and navigates to
// the post-survive section.
test('combat.win_after_rounds ends combat in victory at the round threshold', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: {
        // No-damage round_script — both sides report 0 damage so
        // health stays unchanged and only the round counter advances.
        round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 0',
      },
    },
    sections: {
      '1': {
        text: 'survive three rounds',
        events: [{
          type: 'combat',
          enemy_ref: 'test_enemy_01',
          win_to: '2',
          win_after_rounds: 3,
          flee_to: null,
        }],
        choices: [],
      },
      '2': { text: 'survived', events: [], choices: [] },
    },
    enemies_catalog: {
      test_enemy_01: { name: 'Test Enemy', HEALTH: 100 },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { HEALTH: 20 };
  state.inventory = [];
  state.equipment = {};

  play.navigateTo(state, book, '1');
  assertTrue(state.combat, 'combat started');
  assertEqual(state.combat.winAfterRounds, 3, 'winAfterRounds passed through to combat state');

  // Round 1
  play.applyAction(state, book, 'attack', []);
  assertTrue(state.combat, 'combat still active after round 1');
  assertEqual(state.combat.round, 1, 'round counter at 1');

  // Round 2
  play.applyAction(state, book, 'attack', []);
  assertTrue(state.combat, 'combat still active after round 2');
  assertEqual(state.combat.round, 2, 'round counter at 2');

  // Round 3 — should trigger the survive-N-rounds win and navigate to '2'.
  play.applyAction(state, book, 'attack', []);
  assertTrue(!state.combat, 'combat ended after round 3 reaches threshold');
  assertEqual(state.currentSection, '2', 'navigated to win_to after surviving 3 rounds');

  // Schema-shape assertion: win_after_rounds declared on event properties.
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  const eventProps = schema.definitions.event.properties;
  assertTrue(!!eventProps.win_after_rounds, 'event.win_after_rounds declared');
  assertEqual(eventProps.win_after_rounds.type, 'integer', 'event.win_after_rounds is integer');
  assertEqual(eventProps.win_after_rounds.minimum, 1, 'event.win_after_rounds minimum is 1');
});

// ============================================================
// Test 23: combat_modifier.removed_after_consecutive_losses
//          drops a modifier from the active list after the
//          player-loss streak reaches its threshold (Rule 17,
//          schema v1.14+).
// ============================================================
// MOTIVATED_BY: Codex v2.18.0 Rule 17 modifier-expiry-on-loss-
// streak subsection. Pre-v1.14 there was no clean encoding for
// the Windhammer §446 mechanic ("torch grants +4 CV while held;
// lose three rounds in a row and the torch is knocked from grasp,
// CV returns to its normal level"). v1.14 adds an optional
// per-modifier `removed_after_consecutive_losses: <int>` field.
// Semantics: `state.combat.consecutiveLosses` increments after
// any round where post-interaction `damage_to_player > damage_to_enemy`,
// resets to 0 on any other outcome (tie, player win, no-damage),
// and a modifier whose threshold has been reached is filtered out
// of the active list for the remainder of the fight.
// END_TO_END_VERIFY: drive Windhammer §446 once it is migrated
// from the non-canonical `player_cv_modifier` shape to a
// canonical Rule 17 entry with `has_item: torch` and
// `removed_after_consecutive_losses: 3`; confirm the +4 bonus
// disappears from the active list after the third consecutive
// player-loss round and is logged as "Combat modifier removed".
test('removed_after_consecutive_losses drops modifier after threshold streak', () => {
  // Round_script: damage_to_player = 1, damage_to_enemy = 0 unless
  // combat.no_loss_this_round is set (in which case both sides 0).
  // The test mutates a flag on the combat event's special_rules-style
  // hook by re-running navigateTo with a different book. Simpler:
  // every round is a player loss; we check the streak threshold.
  function buildBookWithModifier(threshold) {
    return buildBook({
      rules: {
        stats: [{ name: 'HEALTH' }],
        health_stat: 'HEALTH',
        combat_system: {
          // Player loses every round: takes 1 damage, deals 0.
          round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 1',
        },
      },
      sections: {
        '1': {
          text: 'torch fight',
          events: [{
            type: 'combat',
            enemy_ref: 'test_enemy_torch',
            win_to: '2',
            flee_to: null,
            combat_modifiers: [{
              target: 'player.attack',
              delta: 4,
              reason: 'Torch dazzles night-sensitive enemy',
              removed_after_consecutive_losses: threshold,
            }],
          }],
          choices: [],
        },
        '2': { text: 'survived', events: [], choices: [] },
      },
      enemies_catalog: {
        test_enemy_torch: { name: 'Test Enemy', HEALTH: 100 },
      },
    });
  }

  // Case A: 3 consecutive losses with threshold 3 → modifier expires.
  {
    const book = buildBookWithModifier(3);
    const state = play.initialState('synthetic');
    state.frontmatterDone = true;
    state.creationDone = true;
    state.pause = null;
    state.stats = { HEALTH: 100 };
    state.inventory = [];
    state.equipment = {};

    play.navigateTo(state, book, '1');
    assertTrue(state.combat, 'combat started');
    assertEqual(state.combat.consecutiveLosses, 0, 'streak starts at 0');
    assertEqual(state.combat.appliedModifiers.length, 1, 'one frozen modifier');
    assertEqual(
      state.combat.appliedModifiers[0].removedAfterConsecutiveLosses,
      3,
      'threshold preserved on frozen modifier'
    );

    // Round 1 — player takes 1, enemy 0. Streak → 1 (below threshold).
    play.applyAction(state, book, 'attack', []);
    assertEqual(state.combat.consecutiveLosses, 1, 'streak=1 after round 1');

    // Round 2 — Streak → 2 (still below threshold).
    play.applyAction(state, book, 'attack', []);
    assertEqual(state.combat.consecutiveLosses, 2, 'streak=2 after round 2');

    // Round 3 — Streak → 3 (reaches threshold → modifier expires this round-end).
    play.applyAction(state, book, 'attack', []);
    assertEqual(state.combat.consecutiveLosses, 3, 'streak=3 after round 3');

    // Expiry log line emitted.
    const expiredLog = state.log.find(l => /Combat modifier removed.*3 consecutive losses/.test(l));
    assertTrue(!!expiredLog, 'expiry log line emitted at threshold');
  }

  // Case B: streak resets on a non-loss round, modifier survives.
  {
    const book = buildBook({
      rules: {
        stats: [{ name: 'HEALTH' }],
        health_stat: 'HEALTH',
        combat_system: {
          // Round 1, 2: player loses (1 vs 0). Round 3: tie (0 vs 0
          // resets streak). Round 4, 5: player loses again. Streak
          // hits 2 after round 5, never reaches threshold of 3.
          round_script:
            'if combat.round == 3 then\n' +
            '  combat.damage_to_enemy = 0\n' +
            '  combat.damage_to_player = 0\n' +
            'else\n' +
            '  combat.damage_to_enemy = 0\n' +
            '  combat.damage_to_player = 1\n' +
            'end',
        },
      },
      sections: {
        '1': {
          text: 'torch fight reset',
          events: [{
            type: 'combat',
            enemy_ref: 'test_enemy_torch_b',
            win_to: '2',
            flee_to: null,
            combat_modifiers: [{
              target: 'player.attack',
              delta: 4,
              reason: 'Torch',
              removed_after_consecutive_losses: 3,
            }],
          }],
          choices: [],
        },
        '2': { text: 'survived', events: [], choices: [] },
      },
      enemies_catalog: {
        test_enemy_torch_b: { name: 'Test Enemy B', HEALTH: 100 },
      },
    });
    const state = play.initialState('synthetic');
    state.frontmatterDone = true;
    state.creationDone = true;
    state.pause = null;
    state.stats = { HEALTH: 100 };
    state.inventory = [];
    state.equipment = {};

    play.navigateTo(state, book, '1');

    // Rounds 1-2 (loss): streak 1, 2.
    play.applyAction(state, book, 'attack', []);
    play.applyAction(state, book, 'attack', []);
    assertEqual(state.combat.consecutiveLosses, 2, 'streak=2 after two losses');

    // Round 3 (tie / no-damage): streak resets to 0.
    play.applyAction(state, book, 'attack', []);
    assertEqual(state.combat.consecutiveLosses, 0, 'streak resets after non-loss round');

    // Rounds 4-5 (loss): streak 1, 2 — still below threshold.
    play.applyAction(state, book, 'attack', []);
    play.applyAction(state, book, 'attack', []);
    assertEqual(state.combat.consecutiveLosses, 2, 'streak=2 after two more losses post-reset');

    const expiredLog = state.log.find(l => /Combat modifier removed/.test(l));
    assertTrue(!expiredLog, 'no expiry log emitted because streak never reached threshold');
  }

  // Schema-shape assertion: removed_after_consecutive_losses declared
  // on combat_modifier.properties with the right type and minimum.
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  const cmProps = schema.definitions.combat_modifier.properties;
  assertTrue(!!cmProps.removed_after_consecutive_losses, 'combat_modifier.removed_after_consecutive_losses declared');
  assertEqual(cmProps.removed_after_consecutive_losses.type, 'integer', 'is integer');
  assertEqual(cmProps.removed_after_consecutive_losses.minimum, 1, 'minimum is 1');
  // Schema title bumped to v1.14.0.
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.14.0', 'schema title bumped to v1.14.0');
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
