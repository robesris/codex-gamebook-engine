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
// Test 6a: a roll_table character-creation step advertises a
// roll action via getAvailableActions.
// ============================================================
// MOTIVATED_BY: CLI emulator v3.21.3. getAvailableActions had
// cases for every chargen pause type EXCEPT
// character_creation_roll_table, so a roll_table chargen step
// advertised no actionable command — an interactive player (or
// any getAvailableActions-driven client) was stuck mid-creation
// even though applyAction handled the step fine. Surfaced by the
// LW1 fresh-parse DFS playthrough: LW1 character creation has two
// roll_table steps (Weaponskill weapon-type table; starting-
// equipment table) and the unconditioned one stalled creation.
// END_TO_END_VERIFY: drive the CLI emulator through LW1 character
// creation; at the starting-equipment roll_table step, confirm
// `roll` / `provide_roll` appear in available_actions and that
// providing a roll advances to creationDone.
test('roll_table chargen step advertises a roll action', () => {
  const results = {};
  for (let i = 0; i <= 9; i++) results[String(i)] = { text: 'opt' + i, effects: [] };
  const book = buildBook({
    character_creation: {
      steps: [{ action: 'roll_table', formula: 'R10', results }],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;

  play.startCharacterCreation(state, book);
  assertEqual(state.pause && state.pause.type, 'character_creation_roll_table', 'paused on roll_table');

  const actionNames = play.getAvailableActions(state, book).map(a => a.name);
  assertTrue(actionNames.includes('roll'), 'roll action advertised for roll_table step');
  assertTrue(actionNames.includes('provide_roll'), 'provide_roll action advertised for roll_table step');

  play.applyAction(state, book, 'provide_roll', ['7']);
  assertTrue(state.creationDone, 'creation completed via the advertised action');
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
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title at v1.34.0');

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
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title at v1.34.0');
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
  // Schema title bumped to v1.15.0.
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title bumped to v1.34.0');
});

// ============================================================
// Test 24: damage_caps bound the post-interaction per-round
//          damage total in the cap's direction (Rule 32, schema
//          v1.15+).
// ============================================================
// MOTIVATED_BY: Codex v2.19.0 Rule 32 (per-round damage caps).
// Pre-v1.15 there was no clean encoding for the Windhammer §564
// Words of Protection mechanic ("any damage caused by Windhammer
// in each battle round will be limited to two endurance points").
// `damage_interactions` (Rule 18) handle multiplicative scaling
// per component but cannot express an absolute per-round total
// cap; `combat_modifiers` (Rule 17) are additive deltas on
// round_script INPUTS, not output bounds. v1.15 adds a parallel
// `damage_caps` structure on combat events (and
// `intrinsic_damage_caps` on enemies_catalog entries) bounding
// the post-interaction per-round damage total in a given
// direction at `min(total, cap.max)`.
// END_TO_END_VERIFY: drive Windhammer §564 once it is migrated
// from the non-canonical chunk1 shape to a canonical Rule 17 +
// Rule 32 encoding with `combat_modifiers` for the stacked +5/+8/+2
// bonuses and `damage_caps` for the Words-of-Protection per-round
// cap; confirm the player takes at most 2 damage per round when
// the book + flag are both present.
test('damage_caps bound post-interaction per-round damage total', () => {
  // Case A: outgoing cap of 2 with round_script reporting damage_to_player=5
  //         → player takes 2, not 5.
  {
    const book = buildBook({
      rules: {
        stats: [{ name: 'HEALTH' }],
        health_stat: 'HEALTH',
        combat_system: {
          // Player takes 5 damage / deals 0 every round. With a cap of 2,
          // the post-cap player total is 2.
          round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 5',
        },
      },
      sections: {
        '1': {
          text: 'protected fight',
          events: [{
            type: 'combat',
            enemy_ref: 'test_enemy_cap',
            win_to: '2',
            flee_to: null,
            damage_caps: [{
              max: 2,
              direction: 'outgoing',
              reason: 'Words of Protection',
            }],
          }],
          choices: [],
        },
        '2': { text: 'survived', events: [], choices: [] },
      },
      enemies_catalog: {
        test_enemy_cap: { name: 'Test Enemy Cap', HEALTH: 100 },
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
    assertTrue(state.combat, 'combat started');
    assertEqual(state.combat.appliedDamageCaps.length, 1, 'one frozen cap');
    assertEqual(state.combat.appliedDamageCaps[0].max, 2, 'cap max preserved');
    assertEqual(state.combat.appliedDamageCaps[0].direction, 'outgoing', 'direction preserved');

    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    const hpAfter = state.stats.HEALTH;
    assertEqual(hpBefore - hpAfter, 2, 'player took 2 damage (capped from 5)');

    const capLog = state.log.find(l => /Damage cap: damage_to_player 5 .* 2/.test(l));
    assertTrue(!!capLog, 'cap log line emitted with pre→post values');
  }

  // Case B: cap is condition-gated; condition false → cap not applied,
  //         player takes the full 5.
  {
    const book = buildBook({
      rules: {
        stats: [{ name: 'HEALTH' }],
        health_stat: 'HEALTH',
        combat_system: {
          round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 5',
        },
      },
      sections: {
        '1': {
          text: 'no-protection fight',
          events: [{
            type: 'combat',
            enemy_ref: 'test_enemy_cap_b',
            win_to: '2',
            flee_to: null,
            damage_caps: [{
              max: 2,
              direction: 'outgoing',
              condition: { type: 'has_item', item: 'words_of_protection' },
              reason: 'Words of Protection (gated)',
            }],
          }],
          choices: [],
        },
        '2': { text: 'survived', events: [], choices: [] },
      },
      enemies_catalog: {
        test_enemy_cap_b: { name: 'Test Enemy Cap B', HEALTH: 100 },
      },
    });
    const state = play.initialState('synthetic');
    state.frontmatterDone = true;
    state.creationDone = true;
    state.pause = null;
    state.stats = { HEALTH: 100 };
    state.inventory = []; // no words_of_protection — condition fails
    state.equipment = {};

    play.navigateTo(state, book, '1');
    assertEqual(state.combat.appliedDamageCaps.length, 0, 'cap filtered out by failing condition');

    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 5, 'player took full 5 damage (cap not applied)');
  }

  // Case C: cap of 0 negates damage entirely; the round counts as a
  //         non-loss because post-cap playerTotal = 0 = enemyTotal.
  {
    const book = buildBook({
      rules: {
        stats: [{ name: 'HEALTH' }],
        health_stat: 'HEALTH',
        combat_system: {
          round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 5',
        },
      },
      sections: {
        '1': {
          text: 'fully protected fight',
          events: [{
            type: 'combat',
            enemy_ref: 'test_enemy_cap_c',
            win_to: '2',
            flee_to: null,
            damage_caps: [{ max: 0, direction: 'outgoing', reason: 'Full protection' }],
          }],
          choices: [],
        },
        '2': { text: 'survived', events: [], choices: [] },
      },
      enemies_catalog: {
        test_enemy_cap_c: { name: 'Test Enemy Cap C', HEALTH: 100 },
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
    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 0, 'player took 0 damage (cap of 0)');
    assertEqual(state.combat.consecutiveLosses, 0, 'streak does not increment on a fully-capped round');
  }

  // Schema-shape assertions.
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title at v1.34.0');
  const eventProps = schema.definitions.event.properties;
  assertTrue(!!eventProps.damage_caps, 'event.damage_caps declared');
  assertEqual(eventProps.damage_caps.type, 'array', 'damage_caps is array');
  assertTrue(!!schema.definitions.damage_cap, 'damage_cap definition declared');
  const dcProps = schema.definitions.damage_cap.properties;
  assertEqual(dcProps.max.type, 'number', 'damage_cap.max is number');
  assertEqual(dcProps.max.minimum, 0, 'damage_cap.max minimum is 0');
  assertTrue(Array.isArray(schema.definitions.damage_cap.required) && schema.definitions.damage_cap.required.includes('max'), 'max is required');
  assertEqual(dcProps.direction.enum.join(','), 'incoming,outgoing', 'direction enum is incoming|outgoing');
  // Schema v1.19+ (Rule 32 margin-gate extension) — min_attacker_margin
  // is a per-round gate on the cap. Optional integer >= 1.
  assertTrue(!!dcProps.min_attacker_margin, 'damage_cap.min_attacker_margin declared');
  assertEqual(dcProps.min_attacker_margin.type, 'integer', 'min_attacker_margin is integer');
  assertEqual(dcProps.min_attacker_margin.minimum, 1, 'min_attacker_margin minimum is 1');
});

// ============================================================
// Test 25: modify_stat.modify_initial_only adjusts initialStats
//          without touching state.stats[stat] (schema v1.16+ /
//          Rule 30 modify_initial-only sub-pattern).
// ============================================================
// MOTIVATED_BY: Codex v2.21.0 / schema v1.16.0 Rule 30 update.
// Source-text discovery: Windhammer §453 says "Your endurance
// points remain at the same level as they were prior to the
// attack by the Dweo'gorga, but the Trial has weakened your
// overall endurance level. For the remainder of this quest your
// maximum endurance level must be reduced by 3 points." The
// existing modify_initial: true field reduces BOTH current and
// initial; the §453 case requires reducing ONLY initial,
// preserving current at its pre-event level. New field
// modify_initial_only: true on modify_stat events covers this
// case. Locks in the four behaviors a future regression must
// preserve: (a) initial drops by amount; (b) current value is
// untouched; (c) the over-initial state is permitted (current
// may legitimately exceed new initial); (d) subsequent heal
// events still clamp to the new initial via initial_is_max.
// END_TO_END_VERIFY: drive both emulators through Windhammer
// §453 once the section is migrated to modify_initial_only;
// confirm the player's current endurance is unchanged but
// initial drops by 3, and a subsequent eat_meal event clamps
// healing at the new lower initial.
test('modify_initial_only reduces initial without touching current and respects later clamping', () => {
  const book = buildBook({
    rules: { stats: [{ name: 'TESTSTAT_END', initial_is_max: true }] },
    sections: {
      '1': {
        text: 'permanent max reduction; current preserved',
        events: [{ type: 'modify_stat', stat: 'TESTSTAT_END', amount: -3, modify_initial_only: true, reason: 'Trial of Hallen-draal' }],
        choices: [],
      },
      '2': {
        text: 'try to heal',
        events: [{ type: 'modify_stat', stat: 'TESTSTAT_END', amount: 100, reason: 'big heal' }],
        choices: [],
      },
    },
  });

  // Case (a): pre-event current=12, initial=12. Post-event current=12 (unchanged),
  // initial=9.
  const stateA = play.initialState('synthetic');
  stateA.frontmatterDone = true;
  stateA.creationDone = true;
  stateA.pause = null;
  stateA.stats = { TESTSTAT_END: 12 };
  stateA.initialStats = { TESTSTAT_END: 12 };
  play.navigateTo(stateA, book, '1');
  assertEqual(stateA.initialStats.TESTSTAT_END, 9, '(a) initial dropped by 3 to 9');
  assertEqual(stateA.stats.TESTSTAT_END, 12, '(a) current unchanged at 12 (allowed to exceed new initial)');

  // Case (b): pre-event current=8, initial=12. Post-event current=8 (unchanged),
  // initial=9. The current is now correctly below initial; nothing weird here.
  const stateB = play.initialState('synthetic');
  stateB.frontmatterDone = true;
  stateB.creationDone = true;
  stateB.pause = null;
  stateB.stats = { TESTSTAT_END: 8 };
  stateB.initialStats = { TESTSTAT_END: 12 };
  play.navigateTo(stateB, book, '1');
  assertEqual(stateB.initialStats.TESTSTAT_END, 9, '(b) initial dropped by 3 to 9');
  assertEqual(stateB.stats.TESTSTAT_END, 8, '(b) current unchanged at 8');

  // Case (c): a subsequent heal event clamps at the NEW initial (9), not the
  // OLD initial (12). Verifies the field interacts correctly with
  // initial_is_max on later events.
  const stateC = play.initialState('synthetic');
  stateC.frontmatterDone = true;
  stateC.creationDone = true;
  stateC.pause = null;
  stateC.stats = { TESTSTAT_END: 5 };
  stateC.initialStats = { TESTSTAT_END: 12 };
  play.navigateTo(stateC, book, '1');  // initial -> 9, current stays 5
  play.navigateTo(stateC, book, '2');  // big heal — should clamp at 9
  assertEqual(stateC.initialStats.TESTSTAT_END, 9, '(c) initial still 9 after heal');
  assertEqual(stateC.stats.TESTSTAT_END, 9, '(c) heal clamped at NEW initial of 9, not OLD initial of 12');

  // Case (d): resource slots (provisions/gold/meals) are excluded — applying
  // modify_initial_only to provisions should be a no-op on initial (since
  // initial-stats tracking doesn't apply to resource slots).
  const stateD = play.initialState('synthetic');
  stateD.frontmatterDone = true;
  stateD.creationDone = true;
  stateD.pause = null;
  stateD.stats = {};
  stateD.initialStats = {};
  stateD.provisions = 5;
  const provBook = buildBook({
    sections: {
      '1': {
        text: 'no-op on resource',
        events: [{ type: 'modify_stat', stat: 'provisions', amount: -2, modify_initial_only: true }],
        choices: [],
      },
    },
  });
  play.navigateTo(stateD, provBook, '1');
  assertEqual(stateD.provisions, 5, '(d) provisions unchanged (modify_initial_only no-ops on resource slots)');
  assertEqual(stateD.initialStats.provisions, undefined, '(d) initialStats.provisions unchanged');

  // Schema-shape assertion.
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  const eventProps = schema.definitions.event.properties;
  assertTrue(!!eventProps.modify_initial_only, 'event.modify_initial_only declared');
  assertEqual(eventProps.modify_initial_only.type, 'boolean', 'event.modify_initial_only is boolean');
});

// ============================================================
// Test 26: clear_flag removes a flag from state.flags; no-op
//          on absent flags; emits a discrete log entry either
//          way (schema v1.17+ / Rule 33 reversible-state
//          sub-pattern).
// ============================================================
// MOTIVATED_BY: Codex v2.22.0 / schema v1.17.0 Rule 33
// extension. Source-text discovery: Windhammer §89 sets
// jotun_shoulder_wound with the explicit clearing trigger
// "until you next can rest and take food." Pre-v1.17 the
// schema lacked a clear_flag event — the workaround was a
// script event mutating state.flags. v1.17 adds clear_flag
// as a parallel to set_flag. Locks in the three behaviors
// a future regression must preserve: (a) clear_flag on a
// present flag removes it from state.flags; (b) clear_flag
// on an absent flag is a no-op (state unchanged); (c) both
// outcomes emit a log entry distinguishable from the
// other case so playthrough debugging can tell which case
// fired.
// END_TO_END_VERIFY: drive both emulators through Windhammer
// §89 → eat_meal section once the book-side migration lands;
// confirm jotun_shoulder_wound is set after §89, the standing
// modifier's -2 CV penalty applies in any combat between §89
// and the next eat_meal, and the flag clears at the eat_meal
// such that combats afterward run at full CV.
test('clear_flag removes a present flag and no-ops on an absent flag', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'set the wound flag',
        events: [{ type: 'set_flag', flag: 'TEST_WOUND_FLAG' }],
        choices: [],
      },
      '2': {
        text: 'rest and clear',
        events: [{ type: 'clear_flag', flag: 'TEST_WOUND_FLAG', reason: 'rest' }],
        choices: [],
      },
      '3': {
        text: 'rest again (no-op on already-clear flag)',
        events: [{ type: 'clear_flag', flag: 'TEST_WOUND_FLAG', reason: 'rest again' }],
        choices: [],
      },
    },
  });

  // Case (a): flag is set, then cleared. After case (a) the flag
  // should be absent.
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  play.navigateTo(state, book, '1');
  assertTrue(state.flags.includes('TEST_WOUND_FLAG'), '(a-pre) flag set after §1');
  play.navigateTo(state, book, '2');
  assertTrue(!state.flags.includes('TEST_WOUND_FLAG'), '(a-post) flag cleared after §2');
  const cleared = state.log.some(line => line.includes('Flag cleared: TEST_WOUND_FLAG'));
  assertTrue(cleared, '(a-log) clear emitted distinct log line');

  // Case (b): flag already absent; clear is a no-op. State unchanged;
  // log carries the no-op variant.
  play.navigateTo(state, book, '3');
  assertTrue(!state.flags.includes('TEST_WOUND_FLAG'), '(b-state) flag still absent after §3');
  const noop = state.log.some(line => line.includes('Flag clear no-op: TEST_WOUND_FLAG'));
  assertTrue(noop, '(b-log) no-op clear emitted distinct log line');

  // Schema-shape assertion: clear_flag in event.type enum.
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  const eventTypes = schema.definitions.event.properties.type.enum;
  assertTrue(eventTypes.includes('clear_flag'), 'clear_flag in event.type enum');
});

// ============================================================
// Test 27: Auto-applied chargen ability/talent effects + exclusive_with
// ============================================================
// MOTIVATED_BY: Codex v2.23.0 / schema v1.18.0 Rule 34. Closes the
// chargen residual surfaced during Chat #29 verification of the
// Windhammer Bug A/B status — chargen was wired but per-ability
// `mechanical_effect` strings (Bushcraft +5 EP, Lorecraft +1 INT,
// Stealth +1 Shimmera) were descriptive only, with no auto-application
// at confirm time. v1.18 adds optional `effects[]` and `exclusive_with`
// to ability/talent entries plus a parallel `rules.talents` block and
// `choose_talents` chargen action. Locks in the four behaviors a
// future regression must preserve: (a) per-ability `effects[]` apply
// at confirm time via the standard event handler (modify_stat etc.);
// (b) `exclusive_with` rejects mutually-exclusive co-selections BEFORE
// any state mutation, with a per-violation log entry; (c) parallel
// `choose_talents` step writes picks to state.talents and applies
// per-talent effects[] the same way; (d) has_talent condition reads
// state.talents with the same canonicalisation as has_ability.
// END_TO_END_VERIFY: drive both emulators through a Windhammer chargen
// once the book-side migration lands; confirm Bushcraft picks bump
// state.stats.endurance by 5 and state.initialStats.endurance by 5;
// confirm picking Weaponmastery + Huntmastery is rejected with a
// violation log; confirm choose_talents sets state.talents and the
// has_talent('Shadar in the Making') condition fires.
test('chargen ability effects auto-apply, exclusive_with rejects, choose_talents + has_talent', () => {
  const play = require('../cli-emulator/play.js');
  const book = {
    metadata: { title: 'Test Book', codex_version: '2.23' },
    rules: {
      stats: [
        { name: 'strength', min: 5, max: 11, initial_is_max: false },
        { name: 'endurance', min: 0, max: 35, initial_is_max: true },
        { name: 'intuition', min: 1, max: 5, initial_is_max: false },
        { name: 'shimmera_uses', min: 0, max: null, initial_is_max: false },
      ],
      attack_stat: null,
      health_stat: 'endurance',
      provisions: { starting_amount: 0, display_name: 'Provisions' },
      abilities: {
        enabled: true,
        choose_count: 2,
        available: [
          {
            name: 'Bushcraft',
            description: 'wilderness skills',
            mechanical_effect: '+5 initial EP',
            effects: [
              { type: 'modify_stat', stat: 'endurance', amount: 5, modify_initial: true,
                reason: 'Bushcraft +5 initial EP' }
            ]
          },
          {
            name: 'Huntmastery',
            description: 'hunting skills',
            mechanical_effect: '+1 CV',
            exclusive_with: ['Weaponmastery']
          },
          {
            name: 'Weaponmastery',
            description: 'weapon proficiency',
            mechanical_effect: '+1 CV',
            exclusive_with: ['Huntmastery']
          },
          {
            name: 'Lorecraft',
            description: 'magic sense',
            mechanical_effect: '+1 Intuition',
            effects: [
              { type: 'modify_stat', stat: 'intuition', amount: 1, modify_initial: true,
                reason: 'Lorecraft +1 Intuition' }
            ]
          },
        ]
      },
      talents: {
        enabled: true,
        choose_count: 2,
        available: [
          {
            name: 'Shadar in the Making',
            description: 'magical affinity',
            mechanical_effect: '+1 Intuition',
            effects: [
              { type: 'modify_stat', stat: 'intuition', amount: 1, modify_initial: true,
                reason: 'Shadar talent +1 Intuition' }
            ]
          },
          {
            name: 'Strong Back',
            description: 'ignore carry limits',
            mechanical_effect: 'parser_notes only',
            parser_notes: 'all sub-rules conditional; not encoded'
          },
          {
            name: 'Beast Slayer',
            description: '+1 CV vs beasts',
            mechanical_effect: 'combat-internal',
            exclusive_with: ['Sword Focus']
          },
          {
            name: 'Sword Focus',
            description: '+1 CV with sword',
            mechanical_effect: 'combat-internal',
            exclusive_with: ['Beast Slayer']
          },
        ]
      }
    },
    character_creation: {
      steps: [
        { action: 'distribute_points', total_points: 22,
          stats: [
            { name: 'strength', min: 5, max: 11 },
            { name: 'endurance', min: 15, max: 16 },
            { name: 'intuition', min: 1, max: 5 }
          ]
        },
        { action: 'choose_abilities', count: 2, from: 'abilities_list' },
        { action: 'choose_talents', count: 2, from: 'talents_list' },
      ]
    },
    items_catalog: {},
    enemies_catalog: {},
    sections: {
      '1': { id: '1', text: 'after talents', events: [
        { type: 'modify_stat', stat: 'endurance', amount: -1,
          condition: { type: 'has_talent', talent: 'Shadar in the Making' } }
      ], choices: [] }
    }
  };

  // ----------------------------------------------------------------
  // Case (a): Bushcraft + Lorecraft → +5 endurance, +1 intuition.
  // ----------------------------------------------------------------
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  play.startCharacterCreation(state, book);
  assertEqual(state.pause && state.pause.type, 'character_creation_distribute',
              '(a-pause0) paused on distribute_points');
  // Distribute: strength=5, endurance=16, intuition=1 (sum 22)
  play.applyAction(state, book, 'distribute', ['strength=5', 'endurance=16', 'intuition=1']);
  assertEqual(state.stats.endurance, 16, '(a-pre) endurance after distribute');
  assertEqual(state.initialStats.endurance, 16, '(a-pre) initial endurance after distribute');
  assertEqual(state.stats.intuition, 1, '(a-pre) intuition after distribute');
  play.applyAction(state, book, 'choose_abilities', ['Bushcraft', 'Lorecraft']);
  assertEqual(state.stats.endurance, 21, '(a-post-ab) endurance bumped by Bushcraft +5');
  assertEqual(state.initialStats.endurance, 21, '(a-post-ab) initial endurance bumped by Bushcraft +5');
  assertEqual(state.stats.intuition, 2, '(a-post-ab) intuition bumped by Lorecraft +1');
  assertEqual(state.initialStats.intuition, 2, '(a-post-ab) initial intuition bumped by Lorecraft +1');
  assertTrue(state.flags.includes('ability_bushcraft'), '(a-flag) ability_bushcraft flag set');
  assertTrue(state.flags.includes('ability_lorecraft'), '(a-flag) ability_lorecraft flag set');

  play.applyAction(state, book, 'choose_talents', ['Shadar in the Making', 'Strong Back']);
  // Note: end-of-chargen auto-navigates to §1, which fires §1's
  // has_talent-gated -1 endurance — so the assertions below check
  // the post-§1 state directly (no separate navigateTo call needed).
  assertEqual(state.stats.intuition, 3, '(a-post-tl) intuition bumped by Shadar +1 (Strong Back parser_notes only)');
  assertEqual(state.initialStats.intuition, 3, '(a-post-tl) initial intuition bumped by Shadar +1');
  assertTrue(Array.isArray(state.talents) && state.talents.includes('Shadar in the Making'),
             '(a-tl-array) state.talents contains Shadar in the Making');
  assertTrue(state.flags.includes('talent_shadar_in_the_making'),
             '(a-flag-tl) talent_shadar_in_the_making flag set');
  assertTrue(state.flags.includes('talent_strong_back'),
             '(a-flag-tl) talent_strong_back flag set');
  // has_talent-gated section event fires on auto-navigate to §1.
  assertEqual(state.stats.endurance, 20, '(a-cond) has_talent-gated endurance -1 fired on auto-navigate');

  // ----------------------------------------------------------------
  // Case (b): Huntmastery + Weaponmastery → rejected, no state mutation.
  // ----------------------------------------------------------------
  const state2 = play.initialState('synthetic');
  state2.frontmatterDone = true;
  play.startCharacterCreation(state2, book);
  play.applyAction(state2, book, 'distribute', ['strength=5', 'endurance=16', 'intuition=1']);
  const enduranceBefore = state2.stats.endurance;
  play.applyAction(state2, book, 'choose_abilities', ['Huntmastery', 'Weaponmastery']);
  // Pause should still be choose_abilities (not advanced).
  assertEqual(state2.pause && state2.pause.type, 'character_creation_choose_abilities',
              '(b-pause) still on choose_abilities after rejection');
  assertEqual(state2.stats.endurance, enduranceBefore,
              '(b-state) endurance unchanged on rejection');
  assertTrue(!state2.abilities || state2.abilities.length === 0,
             '(b-abilities) state.abilities not populated on rejection');
  const violationLogged = state2.log.some(l => l.includes('mutually exclusive'));
  assertTrue(violationLogged, '(b-log) violation logged');

  // Re-submit with a valid pair → succeeds.
  play.applyAction(state2, book, 'choose_abilities', ['Huntmastery', 'Bushcraft']);
  assertEqual(state2.stats.endurance, enduranceBefore + 5,
              '(b-retry) Bushcraft +5 lands on retry');

  // ----------------------------------------------------------------
  // Case (c): talent exclusive_with rejection (Beast Slayer + Sword Focus).
  // ----------------------------------------------------------------
  const state3 = play.initialState('synthetic');
  state3.frontmatterDone = true;
  play.startCharacterCreation(state3, book);
  play.applyAction(state3, book, 'distribute', ['strength=5', 'endurance=16', 'intuition=1']);
  play.applyAction(state3, book, 'choose_abilities', ['Bushcraft', 'Lorecraft']);
  play.applyAction(state3, book, 'choose_talents', ['Beast Slayer', 'Sword Focus']);
  assertEqual(state3.pause && state3.pause.type, 'character_creation_choose_talents',
              '(c-pause) still on choose_talents after rejection');
  assertTrue(!state3.talents || state3.talents.length === 0,
             '(c-talents) state.talents not populated on rejection');

  // ----------------------------------------------------------------
  // Schema-shape assertions.
  // ----------------------------------------------------------------
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title at v1.34.0');
  const stepActions = schema.definitions.character_creation_step.properties.action.enum;
  assertTrue(stepActions.includes('choose_talents'),
             'choose_talents in character_creation_step.action enum');
  const condTypes = schema.definitions.condition.properties.type.enum;
  assertTrue(condTypes.includes('has_talent'),
             'has_talent in condition.type enum');
  assertTrue(schema.properties.rules.properties.talents !== undefined,
             'rules.talents block present in schema');
  const abilityProps = schema.properties.rules.properties.abilities.properties.available.items.properties;
  assertTrue(abilityProps.effects !== undefined, 'rules.abilities.available[].effects defined');
  assertTrue(abilityProps.exclusive_with !== undefined, 'rules.abilities.available[].exclusive_with defined');
  assertTrue(abilityProps.parser_notes !== undefined, 'rules.abilities.available[].parser_notes defined');
});

// ============================================================
// Test 28: damage_cap.min_attacker_margin gates the cap on
//          per-round attacker margin (Rule 32, schema v1.19+).
// ============================================================
// MOTIVATED_BY: Codex v2.25.0 / schema v1.19.0 Rule 32 margin-gate
// extension. Closes the Chat #30 known_issues entry on Windhammer
// §242 Shieldstone two-rule combination — "Dragon will only harm
// you if it wins by more than four points... max two EP per round."
// Previous schema layers (Rule 17 modifiers, Rule 18 interactions,
// Rule 32 v1.15 caps) could not express the per-round margin gate.
// v1.19 adds an optional `min_attacker_margin` field on `damage_cap`
// that, when present, makes the cap evaluate per round against the
// round_script-reported `combat.attacker_margin`: when margin >= N,
// the cap applies as `max`; when margin < N, the cap blocks all
// damage in that direction (effective max = 0). Both halves of the
// §242 source rule fold into one cap entry.
// END_TO_END_VERIFY: drive Windhammer §242 once the round_script
// is updated to expose `combat.attacker_margin` and the §242 combat
// is migrated from `parser_notes`-string-only to the canonical
// `damage_caps: [{max: 2, min_attacker_margin: 5, ...}]` encoding;
// confirm the player takes 0 damage on margin 1-4 rounds and 2 damage
// on margin >= 5 rounds when Shieldstone is active.
test('damage_cap min_attacker_margin gates per-round application on attacker margin', () => {
  const fs = require('fs');
  const buildBookForMargin = (scriptCode) => buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: scriptCode },
    },
    sections: {
      '1': {
        text: 'shieldstone fight',
        events: [{
          type: 'combat',
          enemy_ref: 'test_dragon',
          win_to: '2',
          flee_to: null,
          damage_caps: [{
            max: 2,
            min_attacker_margin: 5,
            direction: 'outgoing',
            reason: 'Shieldstone gate-and-cap',
          }],
        }],
        choices: [],
      },
      '2': { text: 'survived', events: [], choices: [] },
    },
    enemies_catalog: {
      test_dragon: { name: 'Test Dragon', HEALTH: 100 },
    },
  });

  // Case A: round_script reports margin = 7 (>= 5) and damage_to_player = 4.
  //         Cap applies normally: 4 → 2.
  {
    const book = buildBookForMargin(
      'combat.damage_to_enemy = 0\n' +
      'combat.damage_to_player = 4\n' +
      'combat.attacker_margin = 7'
    );
    const state = play.initialState('synthetic');
    state.frontmatterDone = true;
    state.creationDone = true;
    state.pause = null;
    state.stats = { HEALTH: 100 };
    state.inventory = [];
    state.equipment = {};

    play.navigateTo(state, book, '1');
    assertEqual(state.combat.appliedDamageCaps.length, 1, 'cap frozen at start');
    assertEqual(state.combat.appliedDamageCaps[0].min_attacker_margin, 5, 'min_attacker_margin preserved on freeze');

    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 2, 'margin 7 >= 5 → cap applies, 4 → 2 damage');

    const capLog = state.log.find(l => /Damage cap: damage_to_player 4 .* 2/.test(l));
    assertTrue(!!capLog, 'cap fire logged with 4 → 2');
  }

  // Case B: round_script reports margin = 3 (< 5) and damage_to_player = 4.
  //         Cap blocks all damage in direction (effective max = 0).
  {
    const book = buildBookForMargin(
      'combat.damage_to_enemy = 0\n' +
      'combat.damage_to_player = 4\n' +
      'combat.attacker_margin = 3'
    );
    const state = play.initialState('synthetic');
    state.frontmatterDone = true;
    state.creationDone = true;
    state.pause = null;
    state.stats = { HEALTH: 100 };
    state.inventory = [];
    state.equipment = {};

    play.navigateTo(state, book, '1');

    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 0, 'margin 3 < 5 → cap blocks all damage');

    const capLog = state.log.find(l => /Damage cap: damage_to_player 4 .* 0/.test(l));
    assertTrue(!!capLog, 'cap fire logged with 4 → 0 (blocked below threshold)');
    assertEqual(state.combat.consecutiveLosses, 0, 'fully-blocked round does not increment loss-streak');
  }

  // Case C: round_script does NOT set combat.attacker_margin.
  //         Cap with min_attacker_margin is skipped with a warning;
  //         player takes the full 4 damage.
  {
    const book = buildBookForMargin(
      'combat.damage_to_enemy = 0\n' +
      'combat.damage_to_player = 4'
      // no combat.attacker_margin
    );
    const state = play.initialState('synthetic');
    state.frontmatterDone = true;
    state.creationDone = true;
    state.pause = null;
    state.stats = { HEALTH: 100 };
    state.inventory = [];
    state.equipment = {};

    play.navigateTo(state, book, '1');

    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 4, 'no attacker_margin → cap skipped, full damage flows');

    const warnLog = state.log.find(l => /WARN: damage_cap with min_attacker_margin/.test(l));
    assertTrue(!!warnLog, 'misconfiguration warning logged');
  }
});

// ============================================================
// Test 29: Rule 36 (schema v1.20+) — on_combat_round damage_delta with
// gate_roll fires when the rolled total falls in applies_on, and is
// skipped when it doesn't. Covers the basic trigger + gate_roll +
// damage_delta primitives.
// ============================================================
// MOTIVATED_BY: Warlock §155 iron_shield_crescent ('When wounded in
// combat, roll 1d6: on 6, damage reduced by 1 point.') is the canonical
// audit-wave-1 site. Schema v1.20+ encodes this as a triggered_effect
// on the shield item: trigger on_combat_round, gate_roll 1d6 on 6,
// effect damage_delta direction outgoing delta -1.
// END_TO_END_VERIFY: Once Warlock wave 1 lands the encoding on the
// shield's items_catalog entry, drive a CLI session through §155, equip
// the shield, enter combat with a Warlock enemy, and verify that on
// rounds where the gate-roll lands on 6 the player takes 1 less damage
// than the round_script reports.
test('Rule 36 on_combat_round damage_delta fires on gate_roll match, skips otherwise', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 4' },
    },
    sections: {
      '1': {
        text: 'fight', events: [{ type: 'combat', enemy_ref: 'test_orc', win_to: '2', flee_to: null }], choices: [],
      },
      '2': { text: 'won', events: [], choices: [] },
    },
    items_catalog: {
      test_shield: {
        name: 'Test Shield', type: 'armor', equippable: true, slot: 'shield', equip_timing: 'out_of_combat', auto_equip: true,
        triggered_effects: [{
          trigger: 'on_combat_round',
          condition: { type: 'is_equipped', item: 'test_shield' },
          gate_roll: { dice: '1d6', applies_on: '6' },
          effect: { type: 'damage_delta', direction: 'outgoing', delta: -1 },
          reason: 'Test shield: 1d6 on 6 → -1 damage',
        }],
      },
    },
    enemies_catalog: { test_orc: { name: 'Test Orc', HEALTH: 50 } },
  });

  // Case A: gate_roll rolls 6 → effect fires → player takes 4 - 1 = 3.
  {
    const state = play.initialState('synthetic');
    state.frontmatterDone = true; state.creationDone = true; state.pause = null;
    state.stats = { HEALTH: 100 }; state.inventory = ['test_shield']; state.equipment = { shield: 'test_shield' };
    state.forcedRolls = [6];
    play.navigateTo(state, book, '1');
    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 3, 'gate_roll fire → damage_delta -1 → 4-1=3 damage');
    assertTrue(!!state.log.find(l => /gate_roll fire/.test(l) && /test_shield/.test(l)), 'gate_roll fire logged');
    assertTrue(!!state.log.find(l => /damage_delta.*item:test_shield/.test(l)), 'damage_delta application logged');
  }
  // Case B: gate_roll rolls 3 → effect skipped → player takes full 4.
  {
    const state = play.initialState('synthetic');
    state.frontmatterDone = true; state.creationDone = true; state.pause = null;
    state.stats = { HEALTH: 100 }; state.inventory = ['test_shield']; state.equipment = { shield: 'test_shield' };
    state.forcedRolls = [3];
    play.navigateTo(state, book, '1');
    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 4, 'gate_roll miss → full damage 4');
    assertTrue(!!state.log.find(l => /gate_roll skip/.test(l)), 'gate_roll skip logged');
  }
  // Case C: is_equipped condition false (shield in inventory, not equipped) → effect skipped.
  {
    const state = play.initialState('synthetic');
    state.frontmatterDone = true; state.creationDone = true; state.pause = null;
    state.stats = { HEALTH: 100 }; state.inventory = ['test_shield']; state.equipment = {};
    state.forcedRolls = [6];
    play.navigateTo(state, book, '1');
    const hpBefore = state.stats.HEALTH;
    play.applyAction(state, book, 'attack', []);
    assertEqual(hpBefore - state.stats.HEALTH, 4, 'is_equipped false → effect skipped, full damage');
  }
});

// ============================================================
// Test 30: Rule 36 pipeline composition — damage_multiplier ×2 followed
// by damage_cap 0 on the same round → cap wins (final damage = 0).
// Covers the Q4-decided ordering: shift/multiply/set pass BEFORE cap
// pass, with tightest-cap-wins on the cap pass.
// ============================================================
// MOTIVATED_BY: Q4 composition test case (i) — "magic sword (1d6-on-6
// damage_multiplier 2 incoming) + shield (1d6-on-6 damage_cap 0
// outgoing) on the same round → cap wins". Direct test of the codex's
// pipeline-ordering claim.
// END_TO_END_VERIFY: Encode the magic-sword + shield pair on a synthetic
// test book; drive a round where both gate_rolls land; verify the
// damage_to_player is 0.
test('Rule 36 pipeline: damage_multiplier + damage_cap → cap wins (Q4 composition (i))', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 3' },
    },
    sections: {
      '1': { text: 'fight', events: [{ type: 'combat', enemy_ref: 'test_orc', win_to: '2', flee_to: null }], choices: [] },
      '2': { text: 'won', events: [], choices: [] },
    },
    items_catalog: {
      magic_sword: {
        name: 'Magic Sword', type: 'weapon', equippable: true, slot: 'weapon', auto_equip: true,
        triggered_effects: [{
          trigger: 'on_combat_round',
          gate_roll: { dice: '1d6', applies_on: '6' },
          effect: { type: 'damage_multiplier', direction: 'outgoing', multiplier: 2 },
          reason: 'Magic sword: 1d6 on 6 → 2x damage',
        }],
      },
      blocker_shield: {
        name: 'Blocker Shield', type: 'armor', equippable: true, slot: 'shield', auto_equip: true,
        triggered_effects: [{
          trigger: 'on_combat_round',
          gate_roll: { dice: '1d6', applies_on: '6' },
          effect: { type: 'damage_cap', direction: 'outgoing', max: 0 },
          reason: 'Blocker shield: 1d6 on 6 → 0 damage cap',
        }],
      },
    },
    enemies_catalog: { test_orc: { name: 'Test Orc', HEALTH: 50 } },
  });

  const state = play.initialState('synthetic');
  state.frontmatterDone = true; state.creationDone = true; state.pause = null;
  state.stats = { HEALTH: 100 }; state.inventory = ['magic_sword', 'blocker_shield']; state.equipment = { weapon: 'magic_sword', shield: 'blocker_shield' };
  // First gate_roll = sword (6 → multiplier fires), second = shield (6 → cap fires).
  state.forcedRolls = [6, 6];
  play.navigateTo(state, book, '1');
  const hpBefore = state.stats.HEALTH;
  play.applyAction(state, book, 'attack', []);
  assertEqual(hpBefore - state.stats.HEALTH, 0, 'multiplier ×2 then cap 0 → final 0 damage (cap wins)');
  assertTrue(!!state.log.find(l => /damage_multiplier.*magic_sword/.test(l)), 'multiplier application logged');
  assertTrue(!!state.log.find(l => /damage_cap.*blocker_shield/.test(l)), 'cap application logged');
});

// ============================================================
// Test 31: Rule 36 damage_set + Rule 32 frozen damage_cap → frozen cap
// holds (final damage = cap.max, not the set value). Covers the
// cross-rule pipeline: Rule 32 frozen cap is applied at the per-round
// total stage AFTER Rule 36's damage_set replaces the total — and then
// the Rule 32 cap could constrain it, but per Q4 the ordering is:
// Rule 32 frozen cap → Rule 36 set → Rule 36 triggered cap. So the
// Rule 32 cap actually runs BEFORE damage_set, which means damage_set
// can EXCEED Rule 32's cap. To get the "vorpal × intrinsic cap → cap
// wins" semantic, the intrinsic cap must ALSO be a Rule 36 triggered
// cap. This test verifies the Q4-decided ordering empirically and
// documents the design implication: Rule 32 frozen caps cannot
// constrain Rule 36 damage_set, by design.
// ============================================================
// MOTIVATED_BY: Q4 composition test case (ii) — "vorpal sword (1d6-on-6
// damage_set enemy.max_health incoming) + enemy intrinsic Rule 32
// damage_cap.max: 10 → cap wins (10, not max_health)". The Q4 design
// chose pipeline ordering where R32 frozen caps run BEFORE R36
// shift/set, so a Rule 32 cap CANNOT bind a Rule 36 damage_set. To
// achieve the intended "intrinsic cap holds against vorpal" semantic,
// the intrinsic cap should be a Rule 36 triggered cap (on the enemy),
// which then runs AFTER damage_set per the ordering. This test
// exercises that path.
test('Rule 36 damage_set + enemy intrinsic Rule 36 cap → cap holds (Q4 composition (ii))', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 2\ncombat.damage_to_player = 0' },
    },
    sections: {
      '1': { text: 'fight', events: [{ type: 'combat', enemy_ref: 'big_guy', win_to: '2', flee_to: null }], choices: [] },
      '2': { text: 'won', events: [], choices: [] },
    },
    items_catalog: {
      vorpal_sword: {
        name: 'Vorpal Sword', type: 'weapon', equippable: true, slot: 'weapon', auto_equip: true,
        triggered_effects: [{
          trigger: 'on_combat_round',
          gate_roll: { dice: '1d6', applies_on: '6' },
          effect: { type: 'damage_set', direction: 'incoming', value: 'enemy.max_health' },
          reason: 'Vorpal sword: 1d6 on 6 → insta-kill',
        }],
      },
    },
    enemies_catalog: {
      big_guy: {
        name: 'Big Guy', HEALTH: 50,
        triggered_effects: [{
          trigger: 'on_combat_round',
          effect: { type: 'damage_cap', direction: 'incoming', max: 10 },
          reason: 'Big Guy: intrinsic cap 10 incoming',
        }],
      },
    },
  });

  const state = play.initialState('synthetic');
  state.frontmatterDone = true; state.creationDone = true; state.pause = null;
  state.stats = { HEALTH: 100 }; state.inventory = ['vorpal_sword']; state.equipment = { weapon: 'vorpal_sword' };
  state.forcedRolls = [6];
  play.navigateTo(state, book, '1');
  // Snapshot the enemy's max health before the round so we can compare.
  assertEqual(state.combat.enemies[0].currentHealth, 50, 'enemy starts at 50');
  play.applyAction(state, book, 'attack', []);
  // damage_set replaces incoming damage with enemy.max_health (50); then
  // the enemy's Rule 36 intrinsic cap caps it at 10. Enemy takes 10
  // damage, drops to 40.
  const enemyAfter = state.combat?.enemies?.[0]?.currentHealth ?? null;
  assertEqual(enemyAfter, 40, 'damage_set 50 → R36 cap 10 → enemy 50-10=40');
  assertTrue(!!state.log.find(l => /damage_set.*vorpal_sword/.test(l)), 'damage_set application logged');
  assertTrue(!!state.log.find(l => /damage_cap.*big_guy/.test(l)), 'enemy R36 cap application logged');
});

// ============================================================
// Test 32: Rule 36 tightest-cap-wins across two items. Extends Rule 32
// v1.15 semantic to Rule 36 caps.
// ============================================================
// MOTIVATED_BY: Q4 composition test case (iv) — "multiple Rule 36 caps
// from different items → tightest cap wins (extends Rule 32 v1.15
// semantic)".
// END_TO_END_VERIFY: Hypothetical site — two passive cap items, one
// caps at 3, one caps at 1. Verify per-round damage is bound at 1.
test('Rule 36 multiple caps compose tightest-wins (Q4 composition (iv))', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 5' },
    },
    sections: {
      '1': { text: 'fight', events: [{ type: 'combat', enemy_ref: 'test_orc', win_to: '2', flee_to: null }], choices: [] },
      '2': { text: 'won', events: [], choices: [] },
    },
    items_catalog: {
      loose_cap: {
        name: 'Loose Cap', type: 'general',
        triggered_effects: [{
          trigger: 'on_combat_round',
          effect: { type: 'damage_cap', direction: 'outgoing', max: 3 },
          reason: 'Loose Cap: outgoing 3',
        }],
      },
      tight_cap: {
        name: 'Tight Cap', type: 'general',
        triggered_effects: [{
          trigger: 'on_combat_round',
          effect: { type: 'damage_cap', direction: 'outgoing', max: 1 },
          reason: 'Tight Cap: outgoing 1',
        }],
      },
    },
    enemies_catalog: { test_orc: { name: 'Test Orc', HEALTH: 50 } },
  });

  const state = play.initialState('synthetic');
  state.frontmatterDone = true; state.creationDone = true; state.pause = null;
  state.stats = { HEALTH: 100 }; state.inventory = ['loose_cap', 'tight_cap']; state.equipment = {};
  play.navigateTo(state, book, '1');
  const hpBefore = state.stats.HEALTH;
  play.applyAction(state, book, 'attack', []);
  assertEqual(hpBefore - state.stats.HEALTH, 1, 'tightest cap (1) wins over loose cap (3) and raw 5');
});

// ============================================================
// Test 33: Rule 36 damage_delta cancellation (-1 + +1 = 0 net) and
// dice-amount (modify_stat amount as {kind: dice, expression, sign})
// resolution at firing time.
// ============================================================
// MOTIVATED_BY: Q4 composition test case (iii) — per-round damage_delta
// -1 (shield) + per-round damage_delta +1 (poison aura) → net 0 delta.
// AND Q6 — variable-amount effects via dice-amount union on
// modify_stat.amount.
// END_TO_END_VERIFY: Synthetic test book mixing both effects.
test('Rule 36 damage_delta cancellation + dice-amount modify_stat resolution (Q4 (iii), Q6)', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 2' },
    },
    sections: {
      '1': { text: 'fight', events: [{ type: 'combat', enemy_ref: 'test_orc', win_to: '2', flee_to: null }], choices: [] },
      '2': { text: 'won', events: [], choices: [] },
    },
    items_catalog: {
      neg_shield: {
        name: 'Neg Shield', type: 'armor', equippable: true, slot: 'shield', auto_equip: true,
        triggered_effects: [{
          trigger: 'on_combat_round',
          effect: { type: 'damage_delta', direction: 'outgoing', delta: -1 },
          reason: 'Neg Shield: -1 outgoing',
        }],
      },
      poison_aura: {
        name: 'Poison Aura', type: 'general',
        triggered_effects: [{
          trigger: 'on_combat_round',
          effect: { type: 'damage_delta', direction: 'outgoing', delta: 1 },
          reason: 'Poison Aura: +1 outgoing',
        }],
      },
      heal_charm: {
        name: 'Heal Charm', type: 'general',
        triggered_effects: [{
          trigger: 'on_combat_round',
          effect: { type: 'modify_stat', stat: 'HEALTH', amount: { kind: 'dice', expression: '1d6', sign: 'positive' } },
          reason: 'Heal Charm: +1d6 HEALTH per round',
        }],
      },
    },
    enemies_catalog: { test_orc: { name: 'Test Orc', HEALTH: 50 } },
  });

  const state = play.initialState('synthetic');
  state.frontmatterDone = true; state.creationDone = true; state.pause = null;
  state.stats = { HEALTH: 100 }; state.inventory = ['neg_shield', 'poison_aura', 'heal_charm']; state.equipment = { shield: 'neg_shield' };
  state.forcedRolls = [4];  // heal_charm rolls 4
  play.navigateTo(state, book, '1');
  const hpBefore = state.stats.HEALTH;
  play.applyAction(state, book, 'attack', []);
  // Damage flow: 2 (script) + (-1) (neg_shield) + (+1) (poison_aura) = 2 net → take 2.
  // Then heal_charm modify_stat +4 fires post-damage → +4 HEALTH.
  // Net HEALTH change: -2 + 4 = +2.
  assertEqual(state.stats.HEALTH - hpBefore, 2, 'delta cancel net 0 (took 2), then +1d6=4 heal → +2 HEALTH');
  assertTrue(!!state.log.find(l => /Dice amount.*1d6.*4/.test(l)), 'dice-amount roll logged');
});

// ============================================================
// Test 34: Rule 36 on_user_use + flee_combat + consume_on_fire — full
// "use a potion to escape" mechanic. Covers Q3 (UX schema vs emulator
// split), Q8 (flee_combat effect type), and the consume_on_fire
// item-removal bookkeeping.
// ============================================================
// MOTIVATED_BY: Warlock potion_of_invisibility (audit-wave-1 site).
// Player uses the potion mid-combat, fleeing to a target section; the
// potion is removed from inventory.
// END_TO_END_VERIFY: Once Warlock wave 1 lands the encoding, drive a
// CLI session through §39 or §51, equip a potion_of_invisibility, enter
// combat, `use potion_of_invisibility`, verify navigation to §105 and
// item removed.
test('Rule 36 on_user_use + flee_combat + consume_on_fire navigates and removes item', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 0' },
    },
    sections: {
      '1': { text: 'fight', events: [{ type: 'combat', enemy_ref: 'test_orc', win_to: '2', flee_to: null }], choices: [] },
      '2': { text: 'won', events: [], choices: [] },
      '105': { text: 'escaped via potion', events: [], choices: [] },
    },
    items_catalog: {
      test_potion: {
        name: 'Test Potion of Invisibility', type: 'consumable',
        triggered_effects: [{
          trigger: 'on_user_use',
          context: 'in_combat',
          effect: { type: 'flee_combat', target_section: 105 },
          consume_on_fire: true,
          reason: 'Potion: use in combat to flee',
        }],
      },
    },
    enemies_catalog: { test_orc: { name: 'Test Orc', HEALTH: 50 } },
  });

  const state = play.initialState('synthetic');
  state.frontmatterDone = true; state.creationDone = true; state.pause = null;
  state.stats = { HEALTH: 100 }; state.inventory = ['test_potion']; state.equipment = {};
  play.navigateTo(state, book, '1');
  assertTrue(state.combat !== null, 'in combat before use');
  play.applyAction(state, book, 'use', ['test_potion']);
  assertEqual(state.combat, null, 'combat cleared after flee_combat');
  assertEqual(state.currentSection, '105', 'navigated to flee target §105');
  assertTrue(!state.inventory.includes('test_potion'), 'consume_on_fire removed potion from inventory');
  assertTrue(!!state.log.find(l => /flee_combat.*test_potion/.test(l)), 'flee_combat logged');
  assertTrue(!!state.log.find(l => /consume_on_fire.*test_potion/.test(l)), 'consume_on_fire logged');
});

// ============================================================
// Rule 36 v2.28.0 / Schema v1.21+ on_section_exit trigger +
// section_had_no_endurance_loss / section_had_no_combat conditions.
// ============================================================
// MOTIVATED_BY: LW1's Healing Kai Discipline — "+1 ENDURANCE per
// numbered section the player passes through in which they were not
// involved in combat or another situation involving loss of ENDURANCE."
// The v2.27.0 codex captured this as a known follow-up (the
// Healing-discipline known_issues.md entry referenced the gap). v2.28.0
// closes it with the on_section_exit lifecycle trigger and two
// independent primitive conditions, AND-gated by LW1's wire-up.
// END_TO_END_VERIFY: Once the books-side sub-agent wires LW1's Healing
// to use these primitives, drive the CLI through any LW1 clean section
// run with the Healing discipline selected; confirm ENDURANCE climbs by
// 1 per clean section, stops climbing on the first combat or
// non-combat ENDURANCE-loss section, and clamps at the chargen ceiling.

// Build a toy book with the canonical LW1-Healing-shape triggered_effect
// on a test ability. healthStat 'HP', initial 10, initial_is_max true so
// the regen clamps.
function buildHealingTestBook(overrides = {}) {
  return Object.assign({
    metadata: { title: 'Synthetic Healing Test', series: 'test' },
    rules: {
      stats: [{ name: 'HP', initial_is_max: true }],
      health_stat: 'HP',
      combat_system: { round_script: 'combat.damage_to_enemy = 1\ncombat.damage_to_player = 0' },
      abilities: {
        available: [{
          name: 'test_regen',
          triggered_effects: [{
            trigger: 'on_section_exit',
            condition: { type: 'and', conditions: [
              { type: 'section_had_no_endurance_loss' },
              { type: 'section_had_no_combat' },
            ]},
            effect: { type: 'modify_stat', stat: 'HP', amount: 1, reason: 'test_regen discipline' },
          }],
        }],
      },
    },
    character_creation: { steps: [] },
    sections: {
      '1': { text: 'start', events: [], choices: [] },
    },
    items_catalog: {},
    enemies_catalog: {},
  }, overrides);
}

function _setupHealingState(book, startHP, initialHP) {
  const state = play.initialState('synthetic');
  state.frontmatterDone = true; state.creationDone = true; state.pause = null;
  state.stats = { HP: startHP };
  state.initialStats = { HP: initialHP };
  state.abilities = ['test_regen'];
  return state;
}

// ============================================================
// Test 35: on_section_exit fires the regen on a clean section.
// ============================================================
test('Rule 36 on_section_exit: healing fires on pure-narrative section', () => {
  const book = buildHealingTestBook({
    sections: {
      'A': { text: 'clean', events: [], choices: [{ text: 'go', target: 'B' }] },
      'B': { text: 'next', events: [], choices: [] },
    },
  });
  const state = _setupHealingState(book, 5, 10);
  play.navigateTo(state, book, 'A');
  // First navigation: no exit-trigger fire (currentSection was null).
  assertEqual(state.stats.HP, 5, 'no regen on first nav into A');
  play.navigateTo(state, book, 'B');
  // Exit from A → snapshot showed HP=5 at A-enter, current HP=5 at A-exit,
  // hadCombat=false. AND-gate passes; regen applies; HP 5 → 6.
  assertEqual(state.stats.HP, 6, 'regen +1 fired on A→B exit');
});

// ============================================================
// Test 36: on_section_exit skips after combat (player wins, even
// taking zero damage — combat-presence alone blocks regen).
// ============================================================
test('Rule 36 on_section_exit: healing skips after combat win (no_combat gate)', () => {
  const book = buildHealingTestBook({
    rules: Object.assign({}, buildHealingTestBook().rules, {
      // Player deals 5 / turn, enemy deals 0 → win in 1 round at full HP.
      combat_system: { round_script: 'combat.damage_to_enemy = 5\ncombat.damage_to_player = 0' },
    }),
    sections: {
      'A': { text: 'combat', events: [{ type: 'combat', enemy_ref: 'goblin', win_to: 'B', flee_to: null }], choices: [] },
      'B': { text: 'next', events: [], choices: [] },
    },
    enemies_catalog: { goblin: { name: 'Goblin', HP: 5 } },
  });
  const state = _setupHealingState(book, 10, 10);
  play.navigateTo(state, book, 'A');
  // Combat: enemy at 5 HP, 5 dmg/round → dies on round 1, navigates to B.
  play.applyAction(state, book, 'attack', []);
  // Exit from A fired during win-to navigateTo(B). hadCombat was set true
  // before on_combat_end (which in turn fires before navigate). Regen
  // gate fails on section_had_no_combat; HP stays at 10 (not 11).
  assertEqual(state.stats.HP, 10, 'no regen after combat win (no_combat gate blocks)');
  assertEqual(state.currentSection, 'B', 'navigated to B after combat win');
});

// ============================================================
// Test 37: on_section_exit skips after non-combat ENDURANCE loss.
// Validates section_had_no_endurance_loss as an independent gate.
// ============================================================
test('Rule 36 on_section_exit: healing skips after non-combat HP loss (endurance_loss gate)', () => {
  const book = buildHealingTestBook({
    sections: {
      'A': { text: 'trap', events: [{ type: 'modify_stat', stat: 'HP', amount: -2, reason: 'trap' }], choices: [{ text: 'go', target: 'B' }] },
      'B': { text: 'next', events: [], choices: [] },
    },
  });
  const state = _setupHealingState(book, 5, 10);
  play.navigateTo(state, book, 'A');
  // After A's events: HP = 5 - 2 = 3. No combat in section.
  assertEqual(state.stats.HP, 3, 'A trap applied -2 HP');
  play.navigateTo(state, book, 'B');
  // Exit from A: snapshot.HP=5; current HP=3; current < snapshot, so
  // section_had_no_endurance_loss is false. AND-gate fails; HP stays at 3.
  assertEqual(state.stats.HP, 3, 'no regen after non-combat HP loss');
});

// ============================================================
// Test 38: on_section_exit skips after combat with zero damage.
// Validates that section_had_no_combat is checked INDEPENDENTLY of
// section_had_no_endurance_loss — even a zero-damage combat blocks
// the regen via the combat-presence half of the AND-gate.
// ============================================================
test('Rule 36 on_section_exit: healing skips after zero-damage combat (no_combat independent of HP)', () => {
  const book = buildHealingTestBook({
    rules: Object.assign({}, buildHealingTestBook().rules, {
      // Player deals 99, enemy deals 0 → win in 1 round with no HP loss.
      combat_system: { round_script: 'combat.damage_to_enemy = 99\ncombat.damage_to_player = 0' },
    }),
    sections: {
      'A': { text: 'easy fight', events: [{ type: 'combat', enemy_ref: 'weakling', win_to: 'B', flee_to: null }], choices: [] },
      'B': { text: 'next', events: [], choices: [] },
    },
    enemies_catalog: { weakling: { name: 'Weakling', HP: 1 } },
  });
  const state = _setupHealingState(book, 5, 10);
  play.navigateTo(state, book, 'A');
  play.applyAction(state, book, 'attack', []);
  // HP loss: 0. section_had_no_endurance_loss is TRUE (HP at exit = HP at
  // enter = 5). But section_had_no_combat is FALSE (combat resolved).
  // AND-gate fails on the no_combat half alone; HP stays at 5 (not 6).
  assertEqual(state.stats.HP, 5, 'no regen even on zero-damage combat (no_combat independent)');
  assertEqual(state.currentSection, 'B', 'navigated to B');
});

// ============================================================
// Test 39: on_section_exit regen clamps at initial_is_max ceiling.
// ============================================================
test('Rule 36 on_section_exit: healing regen clamps at initial_is_max ceiling', () => {
  const book = buildHealingTestBook({
    sections: {
      'A': { text: 'clean', events: [], choices: [{ text: 'go', target: 'B' }] },
      'B': { text: 'next', events: [], choices: [] },
    },
  });
  // Start at the ceiling (10) with initial=10. Regen should be a no-op.
  const state = _setupHealingState(book, 10, 10);
  play.navigateTo(state, book, 'A');
  play.navigateTo(state, book, 'B');
  // initial_is_max clamps +1 attempt back down to the ceiling.
  assertEqual(state.stats.HP, 10, 'regen clamps at initial_is_max ceiling');
});

// ============================================================
// Test 40: Multi-section clean run — regen accumulates across many
// clean exits; clamps at ceiling at the end.
// ============================================================
test('Rule 36 on_section_exit: healing accumulates across multi-section clean run', () => {
  const sections = {};
  for (let i = 1; i <= 6; i++) {
    sections[String(i)] = {
      text: 'clean ' + i,
      events: [],
      choices: i < 6 ? [{ text: 'next', target: String(i + 1) }] : [],
    };
  }
  const book = buildHealingTestBook({ sections });
  const state = _setupHealingState(book, 5, 10);
  play.navigateTo(state, book, '1');
  // Five exits (1→2, 2→3, 3→4, 4→5, 5→6). Each clean exit fires +1.
  // Starting HP=5; expected HP after 5 exits = min(10, 5+5) = 10.
  for (let i = 2; i <= 6; i++) play.navigateTo(state, book, String(i));
  assertEqual(state.stats.HP, 10, 'HP climbed from 5 to ceiling 10 across 5 clean exits');
});

// ============================================================
// Test 41: Schema back-compat — a v1.20-era book with no
// on_section_exit references validates clean against the v1.21 schema.
// ============================================================
test('Rule 36 v2.28.0: schema-additive — pre-v1.21 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  // A minimal book using only pre-v1.21 vocabulary. No on_section_exit;
  // no section_had_no_endurance_loss / section_had_no_combat conditions.
  const book = {
    metadata: { title: 'Back-compat smoke test', author: 'test', total_sections: 1 },
    rules: {
      stats: [{ name: 'HP' }],
    },
    character_creation: { steps: [] },
    sections: {
      '1': {
        text: 'test',
        is_ending: false,
        events: [{ type: 'modify_stat', stat: 'HP', amount: -1, condition: { type: 'has_flag', flag: 'foo' } }],
        choices: [{ text: 'end', target: '1' }],
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.21 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Test 42: roll_table fires effects[] on a single-key match
// (Rule 11 v2.29.0 extension / schema v1.22+).
// ============================================================
// MOTIVATED_BY: LW1 starting-equipment table (step 8) — pre-v1.22 the
// roll wrote to a scratch `state.stats.starting_equipment_roll` slot
// and no event fired, so the player ended chargen without the rolled
// item. The roll_table action selects the matching results-map entry
// and applies its effects via the chargen-safe event handler.
// END_TO_END_VERIFY: drive LW1 chargen through step 8; provide_roll a
// fixed value (e.g. 3 = "Two Meals"); confirm state.provisions
// increased by 2 and no scratch stat was created.
test('roll_table fires effects on single-key match', () => {
  const book = buildBook({
    character_creation: {
      steps: [{
        action: 'roll_table',
        formula: 'R10',
        results: {
          '0': { text: 'Broadsword', effects: [{ type: 'add_item', item: 'broadsword' }] },
          '3': { text: 'Two Meals', effects: [{ type: 'modify_stat', stat: 'provisions', amount: 2 }] },
          '9': { text: '12 Gold Crowns', effects: [{ type: 'modify_stat', stat: 'gold', amount: 12 }] },
        },
      }],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  play.startCharacterCreation(state, book);
  assertEqual(state.pause && state.pause.type, 'character_creation_roll_table', 'paused on roll_table');

  play.applyAction(state, book, 'provide_roll', ['3']);
  assertEqual(state.provisions, 2, 'provisions +2 from single-key match');
  assertEqual(state.gold, 0, 'gold untouched (other branches did not fire)');
  assertTrue(!state.inventory.includes('broadsword'), 'unmatched branch did not fire');
  assertEqual(state.stats.starting_equipment_roll, undefined, 'no scratch stat written — roll value is ephemeral');
  assertTrue(state.creationDone, 'creation completed');
});

// ============================================================
// Test 43: roll_table fires effects[] on an inclusive-range match
// (range keys like "0-4" match the same way as roll_dice.results).
// ============================================================
// MOTIVATED_BY: range-key support — books may bucket multiple rolls
// to the same outcome (e.g. "0-4 = sword, 5-9 = mace"). Without range
// support, authors would have to enumerate every face value.
// END_TO_END_VERIFY: drive a synthetic chargen with a range-key
// table; confirm the rolled value picks the right bucket.
test('roll_table fires effects on inclusive-range match', () => {
  const book = buildBook({
    character_creation: {
      steps: [{
        action: 'roll_table',
        formula: 'R10',
        results: {
          '0-4': { text: 'Sword', effects: [{ type: 'add_item', item: 'sword' }] },
          '5-9': { text: 'Mace',  effects: [{ type: 'add_item', item: 'mace' }] },
        },
      }],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  play.startCharacterCreation(state, book);

  play.applyAction(state, book, 'provide_roll', ['7']);
  assertTrue(state.inventory.includes('mace'), 'rolled 7 → mace via 5-9 range');
  assertTrue(!state.inventory.includes('sword'), 'sword bucket did not fire');
});

// ============================================================
// Test 44: roll_table respects character_creation_step.condition.
// (schema v1.6+ gating still works on the new action.)
// ============================================================
// MOTIVATED_BY: LW1 Weaponskill weapon-type roll — should fire only
// when the player picked the Weaponskill discipline. The v1.6+
// chargen condition gate must apply uniformly to all chargen
// actions, including the new roll_table.
// END_TO_END_VERIFY: drive LW1 chargen through step 4 WITHOUT picking
// Weaponskill; confirm the roll_table step is skipped (no pause,
// no effect mutation, no scratch stat) and creation proceeds.
test('roll_table respects step condition (skipped when false)', () => {
  const book = buildBook({
    character_creation: {
      steps: [{
        action: 'roll_table',
        formula: 'R10',
        condition: { type: 'has_flag', flag: 'never_set' },
        results: {
          '0': { text: 'A', effects: [{ type: 'add_item', item: 'item_a' }] },
        },
      }],
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  play.startCharacterCreation(state, book);

  assertTrue(state.pause && state.pause.type !== 'character_creation_roll_table', 'roll_table step did NOT pause — condition gated it');
  assertTrue(!state.inventory.includes('item_a'), 'no effect from skipped step');
  assertTrue(state.creationDone, 'creation completed without prompting');
});

// ============================================================
// Test 45: Schema back-compat — a v1.21-era book with no roll_table
// references validates clean against the v1.22 schema.
// ============================================================
// MOTIVATED_BY: roll_table is schema-additive — the action enum
// gains one new value and two new optional properties. Pre-v1.22
// books with no roll_table references must validate unchanged.
test('Rule 11 v2.29.0: schema-additive — pre-v1.22 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  // A minimal book using only pre-v1.22 chargen actions.
  const book = {
    metadata: { title: 'Back-compat smoke test', author: 'test', total_sections: 1 },
    rules: {
      stats: [{ name: 'HP' }, { name: 'GOLD' }],
    },
    character_creation: {
      steps: [
        { action: 'roll_stat', stat: 'HP', formula: '2d6' },
        { action: 'roll_resource', resource: 'GOLD', formula: 'R10' },
      ],
    },
    sections: {
      '1': {
        text: 'test',
        is_ending: false,
        events: [],
        choices: [{ text: 'end', target: '1' }],
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.22 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title bumped to v1.34.0');
});

// ============================================================
// Test 46: end_after_rounds auto-ends combat without a verdict
// and navigates to end_to (Rule 38 / schema v1.23+).
// ============================================================
// MOTIVATED_BY: LW1 §231 / §339 "still fighting after 4 rounds
// of combat, turn to 203" — the broken-off-without-verdict
// combat semantic. Pre-v1.23 the only encodings were `script` or
// honor-system choices. The Rule 38 primitive makes the round-
// cap first-class and routes deterministically.
// END_TO_END_VERIFY: drive a synthetic combat with
// end_after_rounds: 4 + end_to: '2'; fight 4 rounds without
// defeat; confirm combat ends, currentSection === '2', and
// state.lastCombatRoundCount === 4.
test('end_after_rounds auto-ends combat at round threshold and navigates to end_to', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 0' },
    },
    sections: {
      '1': {
        text: 'broken-off combat',
        events: [{
          type: 'combat',
          enemy_ref: 'test_enemy_01',
          win_to: null,
          end_after_rounds: 4,
          end_to: '2',
          flee_to: null,
        }],
        choices: [],
      },
      '2': { text: 'broken off', events: [], choices: [] },
    },
    enemies_catalog: { test_enemy_01: { name: 'Test Enemy', HEALTH: 100 } },
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
  assertEqual(state.combat.endAfterRounds, 4, 'endAfterRounds passed through');
  assertEqual(state.combat.endTo, '2', 'endTo passed through');

  play.applyAction(state, book, 'attack', []);
  play.applyAction(state, book, 'attack', []);
  play.applyAction(state, book, 'attack', []);
  assertTrue(state.combat, 'combat still active after 3 rounds');
  play.applyAction(state, book, 'attack', []);

  assertTrue(!state.combat, 'combat ended at round 4 cap');
  assertEqual(state.currentSection, '2', 'navigated to end_to');
  assertEqual(state.lastCombatRoundCount, 4, 'lastCombatRoundCount set to end-round');
});

// ============================================================
// Test 47: combat_round_count_lte gates a post-combat choice
// (the "kill within N rounds" branch).
// ============================================================
// MOTIVATED_BY: LW1 §231 "If you kill him within 4 rounds of
// combat, turn to 94" — the post-combat condition primitive.
// END_TO_END_VERIFY: drive a combat that wins at round 2 (low
// enemy health); confirm a choice gated on
// combat_round_count_lte: 4 is selectable AND a choice gated on
// combat_round_count_gte: 5 is NOT selectable.
test('combat_round_count_lte gates post-combat choice (kill-within-N branch)', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      combat_system: { round_script: 'combat.damage_to_enemy = 100\ncombat.damage_to_player = 0' },
    },
    sections: {
      '1': {
        text: 'kill quick',
        events: [{ type: 'combat', enemy_ref: 'glass_jaw', win_to: null, flee_to: null }],
        choices: [
          { text: 'kill within 4 rounds', target: '2', condition: { type: 'combat_round_count_lte', value: 4 } },
          { text: 'still fighting', target: '3', condition: { type: 'combat_round_count_gte', value: 5 } },
        ],
      },
      '2': { text: 'killed fast', events: [], choices: [] },
      '3': { text: 'slow', events: [], choices: [] },
    },
    enemies_catalog: { glass_jaw: { name: 'Glass Jaw', HEALTH: 1 } },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { HEALTH: 20 };
  state.inventory = [];
  state.equipment = {};

  play.navigateTo(state, book, '1');
  play.applyAction(state, book, 'attack', []);
  assertTrue(!state.combat, 'combat ended at round 1 (enemy defeated)');
  assertEqual(state.lastCombatRoundCount, 1, 'lastCombatRoundCount set to 1');

  const choices = book.sections['1'].choices;
  assertTrue(play.evalCondition(choices[0].condition, state, book), 'kill-within-4 choice available');
  assertTrue(!play.evalCondition(choices[1].condition, state, book), 'still-fighting choice gated off');
});

// ============================================================
// Test 48: flee_available_after_round blocks flee until the
// round-gate window opens (Rule 38).
// ============================================================
// MOTIVATED_BY: LW1 §43 "After three rounds of combat, you
// position yourself so that you can run down the hill. If you
// wish to evade at this time then turn to 106." Pre-v1.23 the
// flee was always available — honor-system tracking of "after
// three rounds." The Rule 38 round-gate makes the constraint
// first-class.
// END_TO_END_VERIFY: drive a combat with
// flee_available_after_round: 3 + flee_to: '2'; attempt flee at
// round 1 → reject, combat still active; attempt flee at round
// 3 → flees successfully, navigates to '2'.
test('flee_available_after_round blocks flee before threshold', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'HEALTH' }],
      health_stat: 'HEALTH',
      escaping: { flee_damage: 0 },
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 0' },
    },
    sections: {
      '1': {
        text: 'positioning',
        events: [{
          type: 'combat',
          enemy_ref: 'test_enemy_01',
          win_to: null,
          flee_to: '2',
          flee_available_after_round: 3,
        }],
        choices: [],
      },
      '2': { text: 'fled', events: [], choices: [] },
    },
    enemies_catalog: { test_enemy_01: { name: 'Test Enemy', HEALTH: 100 } },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { HEALTH: 20 };
  state.inventory = [];
  state.equipment = {};

  play.navigateTo(state, book, '1');
  assertEqual(state.combat.fleeAvailableAfterRound, 3, 'gate passed through');

  // Attempt flee at round 0 — should be rejected.
  play.applyAction(state, book, 'flee', []);
  assertTrue(state.combat, 'flee rejected before threshold — combat still active');
  assertEqual(state.currentSection, '1', 'no navigation occurred');

  // Fight to round 3.
  play.applyAction(state, book, 'attack', []);
  play.applyAction(state, book, 'attack', []);
  play.applyAction(state, book, 'attack', []);
  assertEqual(state.combat.round, 3, 'reached round 3');

  // Flee at round 3 — should succeed.
  play.applyAction(state, book, 'flee', []);
  assertTrue(!state.combat, 'flee accepted at round 3');
  assertEqual(state.currentSection, '2', 'navigated to flee_to');
  assertEqual(state.lastCombatRoundCount, 3, 'lastCombatRoundCount set on flee');
});

// ============================================================
// Test 50: add_item.quantity accumulates copies on stackable items.
// ============================================================
// MOTIVATED_BY: Rule 39 (schema v1.24+) — LW1 §113 "take two
// Laumspur potions" was previously encoded either as a parallel-id
// pair (`laumspur_1`, `laumspur_2`) or as a single add_item that
// silently dropped the second copy via set-semantics. With
// stackable: true on the catalog entry and quantity: 2 on the
// add_item event, both copies land in inventory.
// END_TO_END_VERIFY: drive the CLI emulator through LW1 to §113
// once that section is migrated; confirm state.inventory holds
// two 'laumspur' entries and the inventory render shows "× 2".
test('Rule 39 v2.31.0: add_item.quantity accumulates on stackable item', () => {
  const book = buildBook({
    items_catalog: {
      healing_herb: { name: 'Healing Herb', type: 'consumable', stackable: true },
    },
    sections: {
      '1': {
        text: 'forage',
        events: [{ type: 'add_item', item: 'healing_herb', quantity: 3 }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;

  play.navigateTo(state, book, '1');

  const heaps = state.inventory.filter(id => id === 'healing_herb');
  assertEqual(heaps.length, 3, 'three copies of stackable item accumulated');
});

// ============================================================
// Test 51: add_item.quantity is set-semantic on non-stackable items.
// ============================================================
// MOTIVATED_BY: Rule 39 composition — quantity > 1 on a
// non-stackable item collapses to a single inventory entry via
// the existing set-semantics dedup. This is the equippable-item
// shape (two copies of the same sword make no sense) and the
// alternate-path-grant shape (LW1's `sword` granted at §15/§62/§184
// — each section is a first-pickup from a different branch).
// END_TO_END_VERIFY: drive the CLI emulator through a custom test
// book where a section fires `add_item glow_orb quantity: 5` with
// glow_orb declared without `stackable`; confirm state.inventory
// holds exactly one 'glow_orb' entry.
test('Rule 39 v2.31.0: add_item.quantity set-semantic on non-stackable item', () => {
  const book = buildBook({
    items_catalog: {
      glow_orb: { name: 'Glow Orb', type: 'key_item' },
    },
    sections: {
      '1': {
        text: 'try',
        events: [{ type: 'add_item', item: 'glow_orb', quantity: 5 }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;

  play.navigateTo(state, book, '1');

  const heaps = state.inventory.filter(id => id === 'glow_orb');
  assertEqual(heaps.length, 1, 'non-stackable item deduped to one copy');
});

// ============================================================
// Test 52: remove_item.quantity removes N copies one at a time.
// ============================================================
// MOTIVATED_BY: Rule 39 — `remove_item.quantity` is the mirror of
// `add_item.quantity`. Splices one copy at a time up to quantity;
// over-remove tail is a no-op. Use case: a section that consumes
// multiple rations or potions in one beat.
// END_TO_END_VERIFY: drive the CLI emulator through a custom test
// section that fires `remove_item healing_herb quantity: 2` after
// the player has accumulated three copies; confirm one copy
// remains. Fire it again with quantity: 5 (over-remove); confirm
// no copies remain and no error fires.
test('Rule 39 v2.31.0: remove_item.quantity splices N copies; over-remove is no-op', () => {
  const book = buildBook({
    items_catalog: {
      healing_herb: { name: 'Healing Herb', type: 'consumable', stackable: true },
    },
    sections: {
      '1': {
        text: 'consume some',
        events: [{ type: 'remove_item', item: 'healing_herb', quantity: 2 }],
        choices: [],
        is_ending: false,
      },
      '2': {
        text: 'consume the rest plus extras',
        events: [{ type: 'remove_item', item: 'healing_herb', quantity: 5 }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.inventory = ['healing_herb', 'healing_herb', 'healing_herb'];

  play.navigateTo(state, book, '1');
  assertEqual(state.inventory.filter(id => id === 'healing_herb').length, 1, 'one copy left after remove quantity: 2');

  play.navigateTo(state, book, '2');
  assertEqual(state.inventory.filter(id => id === 'healing_herb').length, 0, 'over-remove is no-op; no error');
});

// ============================================================
// Test 53: Schema back-compat — a v1.23-era book with no
// Rule 39 references validates clean against the v1.24 schema.
// ============================================================
// MOTIVATED_BY: Rule 39 is schema-additive — `add_item.quantity`,
// `remove_item.quantity`, and `items_catalog[id].stackable` are
// all new optional fields. Pre-v1.24 books must validate unchanged.
test('Rule 39 v2.31.0: schema-additive — pre-v1.24 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const book = {
    metadata: { title: 'Back-compat smoke test', author: 'test', total_sections: 1 },
    rules: { stats: [{ name: 'HP' }] },
    character_creation: { steps: [{ action: 'add_item', item: 'potion' }] },
    items_catalog: {
      potion: { name: 'Potion', type: 'consumable' },
    },
    sections: {
      '1': {
        text: 'test',
        is_ending: false,
        events: [
          { type: 'add_item', item: 'potion' },
          { type: 'remove_item', item: 'potion' },
        ],
        choices: [],
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.24 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Test 49: Schema back-compat — a v1.22-era book with no
// Rule 38 references validates clean against the v1.23 schema.
// ============================================================
// MOTIVATED_BY: Rule 38 is schema-additive — the condition.type
// enum gains two new values; the combat event gains three new
// optional properties. Pre-v1.23 books must validate unchanged.
test('Rule 38 v2.30.0: schema-additive — pre-v1.23 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const book = {
    metadata: { title: 'Back-compat smoke test', author: 'test', total_sections: 1 },
    rules: { stats: [{ name: 'HP' }] },
    character_creation: { steps: [{ action: 'roll_stat', stat: 'HP', formula: '2d6' }] },
    sections: {
      '1': {
        text: 'test',
        is_ending: false,
        events: [{ type: 'combat', enemy_ref: 'foo', win_to: '1', flee_to: null }],
        choices: [{ text: 'end', target: '1', condition: { type: 'has_flag', flag: 'x' } }],
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.23 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Rule 40 v2.33.0 — choose_items mode:"remove" (player-chosen item loss)
// ============================================================
test('Rule 40 v2.33.0: choose_items mode:remove with empty eligible pool no-ops', () => {
  const book = buildBook({
    items_catalog: {
      sword: { name: 'Sword', type: 'weapon', inventory_category: 'weapons' },
    },
    sections: {
      '1': {
        text: 'try to take a weapon you have none of',
        events: [{ type: 'choose_items', mode: 'remove', from_category: 'weapons', count: 1, description: 'lose a weapon' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.inventory = []; // no weapons
  play.navigateTo(state, book, '1');
  assertTrue(state.pause?.type !== 'choose_items', 'no choose_items pause when eligible pool empty');
  assertEqual(state.inventory.length, 0, 'inventory unchanged');
});

test('Rule 40 v2.33.0: choose_items mode:remove auto-removes when single eligible', () => {
  const book = buildBook({
    items_catalog: {
      sword: { name: 'Sword', type: 'weapon', inventory_category: 'weapons' },
      dagger: { name: 'Dagger', type: 'weapon', inventory_category: 'weapons' },
    },
    sections: {
      '1': {
        text: 'weapon breaks',
        events: [{ type: 'choose_items', mode: 'remove', from_category: 'weapons', count: 1, description: 'one weapon breaks' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.inventory = ['sword']; // exactly one weapon
  play.navigateTo(state, book, '1');
  assertTrue(state.pause?.type !== 'choose_items', 'no choose_items pause when eligible pool is single item');
  assertEqual(state.inventory.length, 0, 'sword auto-removed');
});

test('Rule 40 v2.33.0: choose_items mode:remove pauses when multi-eligible and resolves on selection', () => {
  const book = buildBook({
    items_catalog: {
      sword: { name: 'Sword', type: 'weapon', inventory_category: 'weapons' },
      dagger: { name: 'Dagger', type: 'weapon', inventory_category: 'weapons' },
      mace: { name: 'Mace', type: 'weapon', inventory_category: 'weapons' },
    },
    sections: {
      '1': {
        text: 'pick which weapon to lose',
        events: [{ type: 'choose_items', mode: 'remove', from_category: 'weapons', count: 1, description: 'lose one weapon' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.inventory = ['sword', 'dagger', 'mace']; // multi-eligible
  play.navigateTo(state, book, '1');
  assertEqual(state.pause?.type, 'choose_items', 'pauses on multi-eligible');
  assertEqual((state.pause.eligible || []).length, 3, 'eligible pool exposed');

  // Simulate player picking the dagger
  play.applyAction(state, book, 'choose_items', ['dagger']);
  assertEqual(state.inventory.includes('dagger'), false, 'dagger removed by selection');
  assertEqual(state.inventory.length, 2, 'sword and mace remain');
});

test('Rule 40 v2.33.0: on_success_set_flag fires only when removal happened', () => {
  const book = buildBook({
    items_catalog: {
      sword: { name: 'Sword', type: 'weapon', inventory_category: 'weapons' },
    },
    sections: {
      '1': {
        text: 'exchange',
        events: [{ type: 'choose_items', mode: 'remove', from_category: 'weapons', count: 1, on_success_set_flag: 'weapon_traded' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;

  state.inventory = []; // no weapons, no removal expected
  play.navigateTo(state, book, '1');
  assertEqual(state.flags.includes('weapon_traded'), false, 'flag NOT set when pool was empty');

  state.inventory = ['sword'];
  state.flags = [];
  play.navigateTo(state, book, '1');
  assertEqual(state.flags.includes('weapon_traded'), true, 'flag set on auto-resolve removal');
});

test('Rule 40 v2.33.0: schema-additive — pre-v1.25 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  // A v1.24-era book that uses the existing grant-shape choose_items.
  const book = {
    metadata: { title: 'Book', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'X', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: { gem: { name: 'Gem', type: 'general' } },
    enemies_catalog: {},
    sections: {
      '1': {
        text: 'pick',
        events: [{ type: 'choose_items', count: 1, options: ['gem'] }], // pre-v1.25 grant shape, no mode
        choices: [{ text: 'end', target: '1', condition: null }],
        is_ending: false,
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.25 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Rule 42 v2.34.0 — queue_combat_modifier (per-fight one-shot buff)
// ============================================================
test('Rule 42 v2.34.0: queue_combat_modifier pushes modifier onto pending buffer', () => {
  const state = play.initialState('synthetic');
  state.pendingCombatModifiers = [];
  const book = buildBook({ sections: { '1': { text: 't', events: [], choices: [], is_ending: false } } });
  play.handleEvent({
    type: 'queue_combat_modifier',
    modifier: { target: 'player.attack', delta: 2, reason: 'test buff' }
  }, state, book);
  assertEqual(state.pendingCombatModifiers.length, 1, 'one modifier queued');
  assertEqual(state.pendingCombatModifiers[0].target, 'player.attack', 'target preserved');
  assertEqual(state.pendingCombatModifiers[0].delta, 2, 'delta preserved');
});

test('Rule 42 v2.34.0: queued modifier drains into next combat and applies for the fight', () => {
  const book = buildBook({
    rules: { stats: [{ name: 'COMBAT SKILL', initial: 15 }, { name: 'ENDURANCE', initial: 20, initial_is_max: true }], health_stat: 'ENDURANCE' },
    enemies_catalog: { goblin: { name: 'Goblin', 'COMBAT SKILL': 10, ENDURANCE: 5 } },
    sections: {
      '1': {
        text: 'fight',
        events: [{ type: 'combat', enemy_ref: 'goblin', win_to: '2', flee_to: null }],
        choices: [],
        is_ending: false,
      },
      '2': { text: 'win', events: [], choices: [], is_ending: false },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { 'COMBAT SKILL': 15, ENDURANCE: 20 };
  state.initialStats = { 'COMBAT SKILL': 15, ENDURANCE: 20 };
  state.pendingCombatModifiers = [
    { target: 'player.attack', delta: 2, reason: 'Alether' }
  ];
  play.navigateTo(state, book, '1');
  // Combat should have started with the queued modifier merged in
  assertTrue(!!state.combat, 'combat is active');
  const applied = state.combat.appliedModifiers || [];
  const alether = applied.find(m => m.reason === 'Alether');
  assertTrue(!!alether, 'Alether modifier present in appliedModifiers');
  assertEqual(alether.delta, 2, 'delta preserved');
  assertEqual(state.pendingCombatModifiers.length, 0, 'pending buffer drained');
});

test('Rule 42 v2.34.0: multiple queued modifiers stack', () => {
  const state = play.initialState('synthetic');
  state.pendingCombatModifiers = [];
  const book = buildBook({ sections: { '1': { text: 't', events: [], choices: [], is_ending: false } } });
  play.handleEvent({ type: 'queue_combat_modifier', modifier: { target: 'player.attack', delta: 2 } }, state, book);
  play.handleEvent({ type: 'queue_combat_modifier', modifier: { target: 'player.attack', delta: 1 } }, state, book);
  assertEqual(state.pendingCombatModifiers.length, 2, 'two modifiers queued');
});

test('Rule 42 v2.34.0: schema-additive — pre-v1.26 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const book = {
    metadata: { title: 'Book', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'X', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: {
      potion: {
        name: 'Potion',
        type: 'consumable',
        // pre-v1.26 — no triggered_effects, no queue_combat_modifier
      }
    },
    enemies_catalog: {},
    sections: { '1': { text: 'x', events: [], choices: [{ text: 'end', target: '1', condition: null }], is_ending: false } },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.26 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Test: Rule 44 v2.39.0 — roll_dice with outcome tag sets
// state.lastTestResult so a follow-up test_succeeded /
// test_failed condition fires.
//
// MOTIVATED_BY: FF books encode Test-your-Luck as roll_dice with
// 'lucky' / 'unlucky' range keys (not stat_test). Before Rule 44 a
// post-roll choice like "if you successfully tested your Luck, take
// the dagger" had no schema-allowed encoding and got dropped.
// ============================================================

test('Rule 44 v2.39.0: roll_dice success outcome sets lastTestResult true', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'test your luck',
        events: [{
          type: 'roll_dice',
          dice: 'R10',
          prompt: 'Test your Luck',
          results: {
            '0-4': { text: 'Lucky.',   outcome: 'success', target: null },
            '5-9': { text: 'Unlucky.', outcome: 'failure', target: null },
          },
        }],
        choices: [
          { text: 'Take the dagger', target: '2', condition: { type: 'test_succeeded' } },
          { text: 'Carry on',        target: '3', condition: { type: 'test_failed' } },
        ],
      },
      '2': { text: 'dagger', events: [], choices: [], is_ending: false },
      '3': { text: 'no dagger', events: [], choices: [], is_ending: false },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  play.navigateTo(state, book, '1');
  // Force a lucky roll (2 → within 0-4).
  play.applyAction(state, book, 'provide_roll', [2]);
  assertEqual(state.lastTestResult, true, 'outcome:success set lastTestResult to true');
  // The roll has target:null so we stay on §1 and present choices.
  assertEqual(state.currentSection, '1', 'stayed on §1 with no target');
  const avail = play.getAvailableActions(state, book);
  assertTrue(avail && avail.some(a => /dagger/i.test(a.label || a.text || JSON.stringify(a))),
    'test_succeeded choice is available after lucky roll');
});

test('Rule 44 v2.39.0: roll_dice failure outcome sets lastTestResult false', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'test',
        events: [{
          type: 'roll_dice',
          dice: 'R10',
          prompt: 'Test your Luck',
          results: {
            '0-4': { outcome: 'success', target: null },
            '5-9': { outcome: 'failure', target: null },
          },
        }],
        choices: [
          { text: 'lucky path',   target: '2', condition: { type: 'test_succeeded' } },
          { text: 'unlucky path', target: '3', condition: { type: 'test_failed' } },
        ],
      },
      '2': { text: 'win', events: [], choices: [], is_ending: false },
      '3': { text: 'lose', events: [], choices: [], is_ending: false },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  play.navigateTo(state, book, '1');
  play.applyAction(state, book, 'provide_roll', [8]);
  assertEqual(state.lastTestResult, false, 'outcome:failure set lastTestResult to false');
});

test('Rule 44 v2.39.0: untagged roll_dice range leaves lastTestResult unchanged', () => {
  // target:null means the roll stays on §1, so we can read lastTestResult
  // after resolution without navigation clearing it.
  const book = buildBook({
    sections: {
      '1': {
        text: 'roll for damage',
        events: [{
          type: 'roll_dice',
          dice: 'R10',
          prompt: 'roll',
          results: { '0-9': { target: null } },
        }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  play.navigateTo(state, book, '1');
  // Seed lastTestResult AFTER navigateTo (which clears it). The untagged
  // roll must not clobber the seeded value.
  state.lastTestResult = true;
  play.applyAction(state, book, 'provide_roll', [4]);
  assertEqual(state.lastTestResult, true, 'untagged result entry left lastTestResult untouched');
});

test('Rule 44 v2.39.0: test_succeeded is in the schema condition enum', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const condEnum = schema.definitions.condition.properties.type.enum;
  assertTrue(condEnum.includes('test_succeeded'), 'test_succeeded present in condition enum');
  assertTrue(condEnum.includes('test_failed'), 'test_failed still present in condition enum');
});

test('Rule 44 v2.39.0: schema-additive — pre-v1.27 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const book = {
    metadata: { title: 'Book', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'X', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: {},
    enemies_catalog: {},
    sections: {
      '1': {
        text: 'x',
        events: [{
          type: 'roll_dice',
          dice: '1d6',
          // pre-v1.27 — no outcome tag on any results entry
          results: { '1-3': { target: '1' }, '4-6': { target: '1' } },
        }],
        choices: [{ text: 'end', target: '1', condition: null }],
        is_ending: false,
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.27 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Test: Rule 45 v2.40.0 — restore_to_initial event sets the
// named stat to Initial via max(current, initial), never lowering
// when a transient buff is active.
//
// MOTIVATED_BY: FF Warlock's Holy Water and Strength/Skill/Fortune
// potions read "STAMINA is restored to its Initial total" — a SET,
// not an ADD. Earlier parses encoded this as modify_stat: +999 with
// a manual-clamp parser_note that failed when initial_is_max was
// missing from the stat declaration (stats panel could read
// STAMINA 1007/20).
// ============================================================

test('Rule 45 v2.40.0: restore_to_initial raises current to initial', () => {
  const book = buildBook({
    rules: { stats: [{ name: 'STAMINA', initial: 20, initial_is_max: true }], abilities: { available: [] } },
    sections: {
      '1': {
        text: 'drink',
        events: [{ type: 'restore_to_initial', stat: 'STAMINA', reason: 'Holy Water' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { STAMINA: 8 };
  state.initialStats = { STAMINA: 20 };
  play.navigateTo(state, book, '1');
  assertEqual(state.stats.STAMINA, 20, 'STAMINA raised from 8 to Initial (20)');
});

test('Rule 45 v2.40.0: restore_to_initial is a no-op when current already at initial', () => {
  const book = buildBook({
    rules: { stats: [{ name: 'STAMINA', initial: 20, initial_is_max: true }], abilities: { available: [] } },
    sections: {
      '1': {
        text: 'drink',
        events: [{ type: 'restore_to_initial', stat: 'STAMINA' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { STAMINA: 20 };
  state.initialStats = { STAMINA: 20 };
  play.navigateTo(state, book, '1');
  assertEqual(state.stats.STAMINA, 20, 'STAMINA stays at 20');
});

test('Rule 45 v2.40.0: restore_to_initial does NOT lower current when buff above initial', () => {
  // Defensive: a transient buff has pushed STAMINA above Initial.
  // "Restore" means regain, not lose — heal must never reduce.
  const book = buildBook({
    rules: { stats: [{ name: 'STAMINA', initial: 20, initial_is_max: false }], abilities: { available: [] } },
    sections: {
      '1': {
        text: 'drink',
        events: [{ type: 'restore_to_initial', stat: 'STAMINA' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { STAMINA: 25 };
  state.initialStats = { STAMINA: 20 };
  play.navigateTo(state, book, '1');
  assertEqual(state.stats.STAMINA, 25, 'transient buff above Initial preserved (heal does not lower)');
});

test('Rule 45 v2.40.0: restore_to_initial composes with modify_initial for Fortune-style raise+restore', () => {
  // FF Warlock Potion of Fortune: raise Initial LUCK by 1, then
  // restore LUCK to the new (raised) Initial. Two events in order.
  const book = buildBook({
    rules: { stats: [{ name: 'LUCK', initial: 9, initial_is_max: true }], abilities: { available: [] } },
    sections: {
      '1': {
        text: 'drink',
        events: [
          { type: 'modify_stat', stat: 'LUCK', amount: 1, modify_initial: true, reason: 'Fortune raises Initial LUCK' },
          { type: 'restore_to_initial', stat: 'LUCK', reason: 'Fortune restores LUCK' },
        ],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { LUCK: 5 };
  state.initialStats = { LUCK: 9 };
  play.navigateTo(state, book, '1');
  assertEqual(state.initialStats.LUCK, 10, 'Initial LUCK raised from 9 to 10');
  assertEqual(state.stats.LUCK, 10, 'LUCK restored to new Initial (10)');
});

test('Rule 45 v2.40.0: modify_stat + initial_is_max clamps at Initial (Laumspur shape)', () => {
  // The clamped-ADD half of Rule 45's decision. LW1 Laumspur reads
  // "restores 4 ENDURANCE per dose, up to Initial" — a numeric heal,
  // NOT restore_to_initial. This test asserts the existing engine
  // mechanism (initial_is_max clamp on modify_stat) still does its
  // job, since Rule 45's doc directs parsers to use it for this shape.
  const book = buildBook({
    rules: { stats: [{ name: 'ENDURANCE', initial: 25, initial_is_max: true }], abilities: { available: [] } },
    sections: {
      '1': {
        text: 'heal',
        events: [{ type: 'modify_stat', stat: 'ENDURANCE', amount: 4, reason: 'Laumspur dose' }],
        choices: [],
        is_ending: false,
      },
    },
  });
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { ENDURANCE: 23 };
  state.initialStats = { ENDURANCE: 25 };
  play.navigateTo(state, book, '1');
  assertEqual(state.stats.ENDURANCE, 25, '+4 clamped at Initial (25), not 27');
});

test('Rule 45 v2.40.0: restore_to_initial is in the schema event-type enum', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const eventEnum = schema.definitions.event.properties.type.enum;
  assertTrue(eventEnum.includes('restore_to_initial'), 'restore_to_initial present in event-type enum');
});

test('Rule 45 v2.40.0: schema-additive — pre-v1.28 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const book = {
    metadata: { title: 'Book', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'X', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: {},
    enemies_catalog: {},
    sections: {
      '1': {
        text: 'x',
        // pre-v1.28 — no restore_to_initial; healing encoded as modify_stat
        events: [{ type: 'modify_stat', stat: 'X', amount: 99 }],
        choices: [{ text: 'end', target: '1', condition: null }],
        is_ending: false,
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.28 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Rule 46 v2.42.0 — Pausable / resumable combat as active state
// ============================================================
// MOTIVATED_BY: FF Warlock §173 + §24 third-wound interrupt with
// resume — the player engages the Wight, after their third wound the
// fight pauses and they navigate to §24, which offers continue (-1
// SKILL) or flee, and on continue the SAME fight resumes against the
// SAME Wight at its preserved STAMINA. Pre-Rule-46 there was no way
// to pause a combat for a section visit and resume with enemy STAMINA
// preserved; the source mechanic could only be approximated with a
// narrative-only workaround (a conditional choice on §173 that
// invited the player to honest-self-count their wounds).
//
// FF Warlock §41 first-wound exit is the companion case (after the
// first wound dealt, the fight ends and the player navigates to the
// reveal section §310) and is addressed by the same machinery in the
// enemy-wounds direction.
//
// Design B (active-combat state) chosen over Design A (targeted
// save-and-restore-HP fields) in the chat-40 design discussion — see
// codex Rule 46 "Why a stateful activeCombat" for the rationale.
//
// END_TO_END_VERIFY: drive the CLI emulator through FF Warlock §173
// and confirm the third player-wound triggers the §24 navigation; on
// §24's continue choice, confirm the resumed combat starts against
// the same Wight at its preserved STAMINA (not the catalog default)
// with the new -1 SKILL modifier applied; confirm the cycle repeats
// every 3 further wounds. Also drive §41 and confirm the first
// player-DEALT wound triggers the §310 navigation with the Wight
// state captured in state.activeCombat.
// ============================================================

// Build a minimal combat-capable book for Rule 46 tests. The
// round_script is deterministic — pass `forceResult` per round via
// state.forcedScriptRolls before calling 'attack'. We use forced
// rolls rather than synthetic dice because the engine's
// runCombatRound reads result.combat.last_result directly from the
// round_script, and a script that consults a forced roll lets each
// test stage a sequence of player-loss / player-win / tie rounds.
function buildRule46Book(extraSection1Events, section24Events) {
  return buildBook({
    rules: {
      stats: [{ name: 'SKILL', initial: 10 }, { name: 'STAMINA', initial: 20, initial_is_max: true }],
      health_stat: 'STAMINA',
      combat_system: {
        // Forced-result round_script. roll() returns the first forced
        // value (1 = player loses round / takes wound; 2 = player wins
        // round / deals wound; 3 = tie). Damage is symmetric so neither
        // side dies in a single test round.
        round_script: [
          'local r = roll("1d6").total',
          'if r == 1 then',
          '  combat.damage_to_enemy = 0',
          '  combat.damage_to_player = 1',
          '  combat.last_result = "enemy_wounds_player"',
          'elseif r == 2 then',
          '  combat.damage_to_enemy = 1',
          '  combat.damage_to_player = 0',
          '  combat.last_result = "player_wounds_enemy"',
          'else',
          '  combat.damage_to_enemy = 0',
          '  combat.damage_to_player = 0',
          '  combat.last_result = "tie"',
          'end',
        ].join('\n'),
      },
    },
    enemies_catalog: {
      wight_s173: { name: 'Wight (§173)', SKILL: 8, STAMINA: 9 },
      wight_alt: { name: 'Alt Wight', SKILL: 7, STAMINA: 6 },
    },
    sections: {
      '1': { text: 'fight', events: extraSection1Events, choices: [], is_ending: false },
      '24': { text: 'interlude', events: section24Events || [], choices: [{ text: 'continue', target: '1', condition: null }], is_ending: false },
      '174': { text: 'win', events: [], choices: [], is_ending: false },
      '310': { text: 'reveal', events: [], choices: [], is_ending: false },
    },
  });
}

function setupRule46Player() {
  const state = play.initialState('synthetic');
  state.frontmatterDone = true;
  state.creationDone = true;
  state.pause = null;
  state.stats = { SKILL: 10, STAMINA: 20 };
  state.initialStats = { SKILL: 10, STAMINA: 20 };
  state.inventory = [];
  state.equipment = {};
  return state;
}

// One d6 per forced round; encoded as a comma-string per the
// applyAction('attack', [forcedRollsString]) contract.
function forceRound(state, book, value) {
  play.applyAction(state, book, 'attack', [String(value)]);
}

test('Rule 46 v2.42.0: interrupt_after_player_wounds pauses combat after Nth wound TAKEN and writes activeCombat', () => {
  const book = buildRule46Book([{
    type: 'combat',
    enemy_ref: 'wight_s173',
    win_to: '174',
    flee_to: null,
    interrupt_after_player_wounds: { count: 3, target: '24' },
  }]);
  const state = setupRule46Player();
  play.navigateTo(state, book, '1');
  assertTrue(!!state.combat, 'combat started');
  assertEqual(state.combat.interruptAfterPlayerWounds.count, 3, 'interrupt threshold passed through');

  // Three losing rounds — player takes 3 wounds.
  forceRound(state, book, 1);
  assertEqual(state.combat.woundsTaken, 1, 'woundsTaken=1 after round 1');
  assertTrue(!!state.combat, 'combat still active after 1 wound');

  forceRound(state, book, 1);
  assertEqual(state.combat.woundsTaken, 2, 'woundsTaken=2 after round 2');
  assertTrue(!!state.combat, 'combat still active after 2 wounds');

  forceRound(state, book, 1);
  assertTrue(!state.combat, 'combat paused after 3rd wound');
  assertEqual(state.currentSection, '24', 'navigated to interrupt target §24');
  assertTrue(!!state.activeCombat, 'activeCombat snapshot written');
  assertEqual(state.activeCombat.enemy_ref, 'wight_s173', 'activeCombat carries enemy_ref');
  assertEqual(state.activeCombat.currentHealth, 9, 'enemy STAMINA preserved (no damage dealt)');
  assertEqual(state.activeCombat.woundsTaken, 3, 'woundsTaken counter preserved');
  assertEqual(state.activeCombat.round, 3, 'round counter preserved');
});

test('Rule 46 v2.42.0: interrupt_after_enemy_wounds pauses combat after Nth wound DEALT', () => {
  const book = buildRule46Book([{
    type: 'combat',
    enemy_ref: 'wight_s173',
    win_to: '174',
    flee_to: null,
    interrupt_after_enemy_wounds: { count: 1, target: '310' },
  }]);
  const state = setupRule46Player();
  play.navigateTo(state, book, '1');
  assertTrue(!!state.combat, 'combat started');

  // One winning round — player deals 1 wound.
  forceRound(state, book, 2);
  assertTrue(!state.combat, 'combat paused after 1st wound dealt');
  assertEqual(state.currentSection, '310', 'navigated to enemy-wounds interrupt target §310');
  assertTrue(!!state.activeCombat, 'activeCombat snapshot written');
  assertEqual(state.activeCombat.enemy_ref, 'wight_s173', 'activeCombat carries enemy_ref');
  assertEqual(state.activeCombat.currentHealth, 8, 'enemy STAMINA reduced by the dealt wound (9 → 8)');
  assertEqual(state.activeCombat.woundsDealt, 1, 'woundsDealt counter preserved');
});

test('Rule 46 v2.42.0: ties and simultaneous rounds do not increment wound counters', () => {
  const book = buildRule46Book([{
    type: 'combat',
    enemy_ref: 'wight_s173',
    win_to: '174',
    flee_to: null,
    interrupt_after_player_wounds: { count: 2, target: '24' },
  }]);
  const state = setupRule46Player();
  play.navigateTo(state, book, '1');

  forceRound(state, book, 3); // tie
  assertEqual(state.combat.woundsTaken, 0, 'tie does not increment woundsTaken');
  assertEqual(state.combat.woundsDealt, 0, 'tie does not increment woundsDealt');
  assertTrue(!!state.combat, 'combat still active after tie');

  forceRound(state, book, 3); // another tie
  assertEqual(state.combat.woundsTaken, 0, 'two ties still 0 woundsTaken');
  assertTrue(!!state.combat, 'no interrupt on ties');
});

test('Rule 46 v2.42.0: mode=resume reads enemy state from activeCombat (preserves STAMINA)', () => {
  // Pre-populate activeCombat as if a prior combat had paused.
  const book = buildBook({
    rules: {
      stats: [{ name: 'SKILL', initial: 10 }, { name: 'STAMINA', initial: 20, initial_is_max: true }],
      health_stat: 'STAMINA',
      combat_system: {
        // No-op round_script — both sides report 0 damage so health
        // and counters stay clean for this test; we only need to
        // assert the initial enemy state at combat-start.
        round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 0\ncombat.last_result = "tie"',
      },
    },
    enemies_catalog: { wight_s173: { name: 'Wight (§173)', SKILL: 8, STAMINA: 9 } },
    sections: {
      '24': {
        text: 'resume',
        events: [{ type: 'combat', mode: 'resume', win_to: '174', flee_to: null }],
        choices: [],
        is_ending: false,
      },
      '174': { text: 'win', events: [], choices: [], is_ending: false },
    },
  });
  const state = setupRule46Player();
  state.activeCombat = {
    enemy_ref: 'wight_s173',
    enemy_snapshot: { name: 'Wight (§173)', SKILL: 8, STAMINA: 9 },
    currentHealth: 4, // resumed at 4, not 9
    modifiers: [],
    damageInteractions: [],
    damageCaps: [],
    woundsDealt: 0,
    woundsTaken: 3,
    round: 5,
    consecutiveLosses: 0,
    originSection: '173',
    originEventIdx: 0,
  };

  play.navigateTo(state, book, '24');
  assertTrue(!!state.combat, 'resumed combat is active');
  assertEqual(state.combat.enemies.length, 1, 'one enemy in resumed combat');
  assertEqual(state.combat.enemies[0].ref, 'wight_s173', 'resumed against same enemy_ref');
  assertEqual(state.combat.enemies[0].currentHealth, 4, 'resumed at preserved STAMINA, not catalog default 9');
  assertEqual(state.combat.woundsDealt, 0, 'resumed combat resets woundsDealt counter');
  assertEqual(state.combat.woundsTaken, 0, 'resumed combat resets woundsTaken counter');
});

test('Rule 46 v2.42.0: mode=start clears stale activeCombat', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'SKILL', initial: 10 }, { name: 'STAMINA', initial: 20, initial_is_max: true }],
      health_stat: 'STAMINA',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 0\ncombat.last_result = "tie"' },
    },
    enemies_catalog: {
      wight_s173: { name: 'Wight', SKILL: 8, STAMINA: 9 },
      goblin: { name: 'Goblin', SKILL: 5, STAMINA: 5 },
    },
    sections: {
      '50': {
        text: 'fresh fight',
        events: [{ type: 'combat', enemy_ref: 'goblin', win_to: '51', flee_to: null }],
        choices: [],
        is_ending: false,
      },
      '51': { text: 'win', events: [], choices: [], is_ending: false },
    },
  });
  const state = setupRule46Player();
  state.activeCombat = {
    enemy_ref: 'wight_s173',
    enemy_snapshot: { name: 'Wight', SKILL: 8, STAMINA: 9 },
    currentHealth: 4,
    modifiers: [], damageInteractions: [], damageCaps: [],
    woundsDealt: 0, woundsTaken: 3, round: 5, consecutiveLosses: 0,
    originSection: '173', originEventIdx: 0,
  };

  play.navigateTo(state, book, '50');
  // 'start' (default mode) should have cleared activeCombat before
  // creating the new combat against the Goblin.
  assertTrue(!!state.combat, 'new combat is active');
  assertEqual(state.combat.enemies[0].ref, 'goblin', 'fighting the new enemy (goblin), not the stale Wight');
  assertEqual(state.activeCombat, null, 'stale activeCombat cleared by mode=start');
});

test('Rule 46 v2.42.0: mode=modify updates activeCombat without engaging combat', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'SKILL', initial: 10 }, { name: 'STAMINA', initial: 20, initial_is_max: true }],
      health_stat: 'STAMINA',
      combat_system: { round_script: 'combat.damage_to_enemy = 0\ncombat.damage_to_player = 0\ncombat.last_result = "tie"' },
    },
    enemies_catalog: {
      wight_s173: { name: 'Wight', SKILL: 8, STAMINA: 9 },
      wight_alt: { name: 'Alt Wight', SKILL: 7, STAMINA: 6 },
    },
    sections: {
      '99': {
        text: 'wandering monster swap',
        events: [{ type: 'combat', mode: 'modify', enemy_ref: 'wight_alt', current_health: 5 }],
        choices: [{ text: 'next', target: '99', condition: null }],
        is_ending: false,
      },
    },
  });
  const state = setupRule46Player();
  state.activeCombat = {
    enemy_ref: 'wight_s173',
    enemy_snapshot: { name: 'Wight', SKILL: 8, STAMINA: 9 },
    currentHealth: 4,
    modifiers: [], damageInteractions: [], damageCaps: [],
    woundsDealt: 0, woundsTaken: 0, round: 0, consecutiveLosses: 0,
    originSection: '50', originEventIdx: 0,
  };

  play.navigateTo(state, book, '99');
  assertEqual(state.combat, null, 'mode=modify does NOT engage combat');
  assertTrue(!!state.activeCombat, 'activeCombat still present after modify');
  assertEqual(state.activeCombat.enemy_ref, 'wight_alt', 'enemy_ref swapped to wandering monster');
  assertEqual(state.activeCombat.currentHealth, 5, 'currentHealth overridden by event.current_health');
  assertEqual(state.activeCombat.enemy_snapshot.name, 'Alt Wight', 'enemy_snapshot refreshed to new enemy');
});

test('Rule 46 v2.42.0: normal combat completion (enemy defeated) clears activeCombat', () => {
  const book = buildBook({
    rules: {
      stats: [{ name: 'SKILL', initial: 10 }, { name: 'STAMINA', initial: 20, initial_is_max: true }],
      health_stat: 'STAMINA',
      combat_system: {
        // One-shot kill round_script.
        round_script: 'combat.damage_to_enemy = 99\ncombat.damage_to_player = 0\ncombat.last_result = "player_wounds_enemy"',
      },
    },
    enemies_catalog: { goblin: { name: 'Goblin', SKILL: 5, STAMINA: 1 } },
    sections: {
      '1': {
        text: 'fight',
        events: [{ type: 'combat', enemy_ref: 'goblin', win_to: '2', flee_to: null }],
        choices: [],
        is_ending: false,
      },
      '2': { text: 'win', events: [], choices: [], is_ending: false },
    },
  });
  const state = setupRule46Player();
  // Pre-populate activeCombat from an unrelated prior pause — the
  // mode=start (default) combat should have cleared it on entry.
  state.activeCombat = {
    enemy_ref: 'stale_wight', enemy_snapshot: { name: 'Stale Wight' }, currentHealth: 3,
    modifiers: [], damageInteractions: [], damageCaps: [],
    woundsDealt: 0, woundsTaken: 0, round: 0, consecutiveLosses: 0,
    originSection: '0', originEventIdx: 0,
  };

  play.navigateTo(state, book, '1');
  assertEqual(state.activeCombat, null, 'mode=start cleared the stale snapshot on entry');
  forceRound(state, book, 1); // 1 → not used by this round_script (it ignores rolls); kills goblin
  assertEqual(state.currentSection, '2', 'navigated to win_to');
  assertEqual(state.activeCombat, null, 'normal completion leaves activeCombat null');
});

test('Rule 46 v2.42.0: activeCombat round-trips through compactState', () => {
  const state = setupRule46Player();
  state.activeCombat = {
    enemy_ref: 'wight_s173',
    enemy_snapshot: { name: 'Wight (§173)', SKILL: 8, STAMINA: 9 },
    currentHealth: 4,
    modifiers: [{ target: 'player.SKILL', delta: -1, reason: 'every third wound', duration: 'fight', removedAfterConsecutiveLosses: null }],
    damageInteractions: [],
    damageCaps: [],
    woundsDealt: 0,
    woundsTaken: 3,
    round: 5,
    consecutiveLosses: 0,
    originSection: '173',
    originEventIdx: 0,
  };
  const compact = play.compactState(state);
  assertTrue(!!compact.activeCombat, 'compactState includes activeCombat');
  assertEqual(compact.activeCombat.enemy_ref, 'wight_s173', 'enemy_ref preserved');
  assertEqual(compact.activeCombat.currentHealth, 4, 'currentHealth preserved');
  assertEqual(compact.activeCombat.woundsTaken, 3, 'woundsTaken preserved');
  assertEqual(compact.activeCombat.modifiers.length, 1, 'frozen modifiers preserved');
});

test('Rule 46 v2.42.0: interrupt_after_player_wounds is declared on the event schema', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ep = schema.definitions.event.properties;
  assertTrue(!!ep.interrupt_after_player_wounds, 'event.interrupt_after_player_wounds declared');
  assertTrue(!!ep.interrupt_after_enemy_wounds, 'event.interrupt_after_enemy_wounds declared');
  assertEqual(ep.interrupt_after_player_wounds.required.join(','), 'count,target', 'required: count + target');
  assertTrue(ep.mode.enum.includes('start'), 'mode enum includes start');
  assertTrue(ep.mode.enum.includes('resume'), 'mode enum includes resume');
  assertTrue(ep.mode.enum.includes('modify'), 'mode enum includes modify');
  // Backwards-compat: legacy multi-enemy ordering values still valid.
  assertTrue(ep.mode.enum.includes('sequential'), 'mode enum still includes sequential');
});

test('Rule 46 v2.42.0: schema-additive — pre-v1.30 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const book = {
    metadata: { title: 'Book', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'X', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: {},
    enemies_catalog: { goblin: { name: 'Goblin', X: 5 } },
    sections: {
      '1': {
        text: 'x',
        // pre-v1.30 — no mode lifecycle, no interrupt_after_*_wounds,
        // ordinary combat event with default-start behavior.
        events: [{ type: 'combat', enemy_ref: 'goblin', win_to: '1', flee_to: null }],
        choices: [{ text: 'end', target: '1', condition: null }],
        is_ending: false,
      },
    },
  };
  const ok = validate(book);
  assertTrue(ok, `pre-v1.30 book should validate clean: ${JSON.stringify(validate.errors)}`);
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

// ============================================================
// Rule 47 v2.43.0 — Flag-routed subroutine return (route_by_flag)
// ============================================================

test('Rule 47 v2.43.0: route_by_flag with matched flag navigates to that route target', () => {
  const book = buildBook({
    sections: {
      '1': { text: '', events: [{ type: 'route_by_flag', routes: [
        { flag: 'go_to_a', target: 10 },
        { flag: 'go_to_b', target: 20 },
      ], fallback: 99 }], choices: [] },
      '10': { text: '', events: [], choices: [] },
      '20': { text: '', events: [], choices: [] },
      '99': { text: '', events: [], choices: [] },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state.flags = ['go_to_b'];
  state = play.navigateTo(state, book, 1);
  assertEqual(String(state.currentSection), '20', 'route_by_flag with go_to_b flag → 20');
});

test('Rule 47 v2.43.0: route_by_flag uses fallback when no route matches', () => {
  const book = buildBook({
    sections: {
      '1': { text: '', events: [{ type: 'route_by_flag', routes: [
        { flag: 'never_set', target: 10 },
      ], fallback: 99 }], choices: [] },
      '10': { text: '', events: [], choices: [] },
      '99': { text: '', events: [], choices: [] },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state = play.navigateTo(state, book, 1);
  assertEqual(String(state.currentSection), '99', 'route_by_flag falls back to 99');
});

test('Rule 47 v2.43.0: route_by_flag with clear_flag_on_match removes the matched flag', () => {
  const book = buildBook({
    sections: {
      '1': { text: '', events: [{ type: 'route_by_flag', routes: [
        { flag: 'transient', target: 10, clear_flag_on_match: true },
      ] }], choices: [] },
      '10': { text: '', events: [], choices: [] },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state.flags = ['transient'];
  state = play.navigateTo(state, book, 1);
  assertEqual(String(state.currentSection), '10', 'matched & navigated');
  assertEqual(state.flags.includes('transient'), false, 'transient flag was cleared');
});

test('Rule 47 v2.43.0: route_by_flag event type is declared on the event schema', () => {
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  const eventEnum = schema.definitions.event.properties.type.enum;
  assertTrue(eventEnum.includes('route_by_flag'), 'route_by_flag in event type enum');
});

test('Rule 47 v2.43.0: schema declares schema_version as an accepted top-level field', () => {
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  assertTrue('schema_version' in schema.properties, 'schema.properties.schema_version is declared');
  assertEqual(schema.properties.schema_version.type, 'string', 'schema_version is a string field');
});

// ============================================================
// Rule 49 v2.45.0 — Multi-stat failure_penalty + note-heuristic catch-net
// ============================================================

test('Rule 49 v2.45.0: failure_penalty array applies each penalty in order on failure', () => {
  const book = buildBook({
    rules: {
      stats: [
        { name: 'skill', initial: 12 },
        { name: 'stamina', initial: 20 },
      ],
    },
    sections: {
      '1': {
        text: 'Roll vs SKILL; on failure lose 2 SKILL AND 3 STAMINA',
        events: [{
          type: 'stat_test',
          stat: 'skill',
          failure_to: '2',
          // Deterministically force a failure by setting current skill
          // unreachably low against a 2d6 roll — handled below by stat
          // mutation before navigate. The penalty SHAPE under test is
          // the array form (Schema v1.33+ / Rule 49).
          failure_penalty: [
            { stat: 'skill', amount: -2 },
            { stat: 'stamina', amount: -3 },
          ],
        }],
        choices: [],
        is_ending: false,
      },
      '2': { text: 'failed', events: [], choices: [], is_ending: false },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state.stats.skill = 2;     // 2d6 always >= 2, force failure
  state.stats.stamina = 20;
  state = play.navigateTo(state, book, 1);
  // The stat_test pauses; apply the player's roll.
  assertEqual(state.pause?.type, 'stat_test', 'stat_test paused as expected');
  state = play.applyAction(state, book, 'roll');
  assertEqual(state.stats.skill, 0, 'skill deducted by 2 (2 - 2)');
  assertEqual(state.stats.stamina, 17, 'stamina deducted by 3 (20 - 3)');
  assertEqual(String(state.currentSection), '2', 'navigated to failure_to');
});

test('Rule 49 v2.45.0: failure_penalty single-object shape still works (back-compat)', () => {
  const book = buildBook({
    rules: { stats: [{ name: 'skill', initial: 12 }, { name: 'stamina', initial: 20 }] },
    sections: {
      '1': {
        text: 'old shape',
        events: [{
          type: 'stat_test',
          stat: 'skill',
          failure_to: '2',
          failure_penalty: { stat: 'stamina', amount: -3 }, // pre-v1.33 single-object
        }],
        choices: [],
      },
      '2': { text: '', events: [], choices: [] },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state.stats.skill = 2;     // force failure
  state.stats.stamina = 20;
  state = play.navigateTo(state, book, 1);
  state = play.applyAction(state, book, 'roll');
  assertEqual(state.stats.skill, 2, 'skill unchanged (not in the single-object penalty)');
  assertEqual(state.stats.stamina, 17, 'stamina -3 from the single-object penalty');
});

test('Rule 49 v2.45.0: schema accepts both failure_penalty shapes', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const baseBook = (penalty) => ({
    metadata: { title: 'B', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'SKILL', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: {},
    enemies_catalog: {},
    sections: {
      '1': {
        text: 't',
        events: [{ type: 'stat_test', stat: 'SKILL', failure_to: '1', failure_penalty: penalty }],
        choices: [{ text: 'end', target: '1', condition: null }],
        is_ending: false,
      },
    },
  });

  assertTrue(validate(baseBook({ stat: 'SKILL', amount: -1 })), 'single-object shape validates');
  assertTrue(validate(baseBook([{ stat: 'SKILL', amount: -1 }, { stat: 'SKILL', amount: -2 }])), 'array shape validates');
  assertTrue(!validate(baseBook('bogus')), 'string penalty rejected');
  assertEqual(schema.title, 'Gamebook Format (GBF) v1.34.0', 'schema title is v1.34.0');
});

test('Rule 49 v2.45.0: schema-additive — pre-v1.33 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  // A v1.32-era book using the single-object failure_penalty shape.
  const book = {
    metadata: { title: 'B', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'SKILL', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: {},
    enemies_catalog: {},
    sections: {
      '1': {
        text: 't',
        events: [{ type: 'stat_test', stat: 'SKILL', failure_to: '1', failure_penalty: { stat: 'SKILL', amount: -2 } }],
        choices: [{ text: 'end', target: '1', condition: null }],
        is_ending: false,
      },
    },
  };
  assertTrue(validate(book), `pre-v1.33 book should validate clean: ${JSON.stringify(validate.errors)}`);
});

test('Rule 49 v2.45.0: mechanic-verbs-in-note soft check flags un-encoded constraints', () => {
  const BookChecks = require('../scripts/book-checks.js');
  const book = {
    metadata: { title: 'B', author: 'a', total_sections: 3 },
    rules: { stats: [{ name: 'SKILL', initial: 10 }] },
    character_creation: { steps: [] },
    items_catalog: { shield: { name: 'Shield' } },
    enemies_catalog: {},
    sections: {
      // §155-shape: add_item with mechanic in note
      '155': {
        text: '...',
        events: [{ type: 'add_item', item: 'shield', optional: true, note: 'Must drop one item to take.' }],
        choices: [],
        is_ending: false,
      },
      // §361-shape: stat_test with second-penalty in note
      '361': {
        text: '...',
        events: [{
          type: 'stat_test', stat: 'SKILL', failure_to: '1',
          failure_penalty: { stat: 'STAMINA', amount: -3 },
          note: 'On failure, also lose 2 SKILL points (in addition to 3 STAMINA)',
        }],
        choices: [],
        is_ending: false,
      },
      // Negative: a benign parser-commentary note should NOT trip the check
      '1': {
        text: '...',
        events: [{ type: 'add_item', item: 'shield', note: 'Item appears in illustration, first word confirmed from PDF' }],
        choices: [],
        is_ending: false,
      },
    },
  };
  const findings = BookChecks.collectSoftFindings(book).mechanicVerbsInNote;
  assertTrue(findings.length >= 2, `expected ≥2 findings, got ${findings.length}: ${JSON.stringify(findings)}`);
  assertTrue(findings.some(f => f.includes('§155')), '§155 add_item note flagged');
  assertTrue(findings.some(f => f.includes('§361')), '§361 stat_test note flagged');
  assertTrue(!findings.some(f => f.includes('§1 ')), '§1 benign parser note not flagged');
});

test('Rule 49 v2.45.0: disarmament regex now catches FF-dialect "leave behind" / "adjust your Equipment List"', () => {
  const BookChecks = require('../scripts/book-checks.js');
  const book = {
    metadata: { title: 'B', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'SKILL', initial: 10 }] },
    character_creation: { steps: [] },
    items_catalog: { shield: { name: 'Shield' } },
    enemies_catalog: {},
    sections: {
      // §155-flavoured: voluntary trade with no remove event
      '155': {
        text: 'However, the shield is heavy and you will have to leave behind one item of equipment (adjust your Equipment List) to be able to carry it.',
        events: [{ type: 'add_item', item: 'shield', optional: true }],
        choices: [],
        is_ending: false,
      },
    },
  };
  const findings = BookChecks.collectSoftFindings(book).disarmamentWithoutEvent;
  assertTrue(findings.some(f => f.includes('§155')), `§155 should be flagged: ${JSON.stringify(findings)}`);
});

// ============================================================
// Rule 50 v2.46.0 — prompt_choice (voluntary binary player decision)
// ============================================================

test('Rule 50 v2.46.0: prompt_choice pauses with accept/decline actions', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'offer',
        events: [{
          type: 'prompt_choice',
          prompt: 'Take it?',
          accept_label: 'Yes',
          decline_label: 'No',
          accept_set_flag: 'took_it',
        }],
        choices: [],
        is_ending: false,
      },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state = play.navigateTo(state, book, 1);
  assertEqual(state.pause?.type, 'prompt_choice', 'paused at prompt_choice');
  const actions = play.getAvailableActions(state, book).map(a => a.name);
  assertTrue(actions.includes('accept') && actions.includes('decline'), 'accept and decline exposed');
});

test('Rule 50 v2.46.0: accept sets accept_set_flag and continues', () => {
  const book = buildBook({
    sections: {
      '1': {
        text: 'offer',
        events: [
          { type: 'prompt_choice', prompt: 'Take it?', accept_set_flag: 'took_it' },
          { type: 'set_flag', flag: 'after_prompt' },
        ],
        choices: [{ text: 'end', target: '1', condition: null }],
      },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state = play.navigateTo(state, book, 1);
  state = play.applyAction(state, book, 'accept');
  assertTrue(state.flags.includes('took_it'), 'accept_set_flag set on accept');
  assertTrue(state.flags.includes('after_prompt'), 'subsequent events ran after resume');
  assertTrue(!state.pause || state.pause.type !== 'prompt_choice', 'no longer paused on prompt_choice');
});

test('Rule 50 v2.46.0: decline sets decline_set_flag and skips accept-gated events', () => {
  const book = buildBook({
    items_catalog: { gem: { name: 'Gem' } },
    sections: {
      '1': {
        text: 'offer',
        events: [
          { type: 'prompt_choice', prompt: 'Take it?', accept_set_flag: 'took_it', decline_set_flag: 'refused_it' },
          { type: 'add_item', item: 'gem', condition: { type: 'has_flag', flag: 'took_it' } },
        ],
        choices: [{ text: 'end', target: '1', condition: null }],
      },
    },
  });
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state = play.navigateTo(state, book, 1);
  state = play.applyAction(state, book, 'decline');
  assertTrue(state.flags.includes('refused_it'), 'decline_set_flag set on decline');
  assertEqual(state.flags.includes('took_it'), false, 'accept flag NOT set on decline');
  assertEqual(state.inventory.includes('gem'), false, 'accept-gated add_item did not fire');
});

test('Rule 50 v2.46.0: prompt_choice + choose_items mode:remove composes for voluntary accept-with-trade', () => {
  // The canonical §155-shape encoding: optional accept, mandatory trade
  // on acceptance, no trade and no grant on decline.
  const book = buildBook({
    items_catalog: {
      shield: { name: 'Shield' },
      sword: { name: 'Sword' },
      torch: { name: 'Torch' },
    },
    sections: {
      '1': {
        text: 'You may take the shield, but only if you drop one item.',
        events: [
          { type: 'prompt_choice', prompt: 'Take the shield?', accept_set_flag: 'accept_shield' },
          // The trade ONLY runs if the player accepted.
          {
            type: 'choose_items', mode: 'remove', count: 1,
            on_success_set_flag: 'shield_traded',
            condition: { type: 'has_flag', flag: 'accept_shield' },
            description: 'Drop one item',
          },
          // The grant ONLY runs if the trade actually happened (which
          // in turn only runs if the player accepted).
          { type: 'add_item', item: 'shield', condition: { type: 'has_flag', flag: 'shield_traded' } },
          // Clean up scratch flags so they don't leak forward.
          { type: 'clear_flag', flag: 'accept_shield' },
          { type: 'clear_flag', flag: 'shield_traded' },
        ],
        choices: [{ text: 'end', target: '1', condition: null }],
      },
    },
  });

  // Path A: decline
  let state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state.inventory = ['sword', 'torch'];
  state = play.navigateTo(state, book, 1);
  state = play.applyAction(state, book, 'decline');
  assertEqual(state.inventory.includes('shield'), false, 'decline: no shield gained');
  assertEqual(state.inventory.length, 2, 'decline: nothing dropped');

  // Path B: accept, then pick which item to drop
  state = play.initialState(book);
  state = play.startCharacterCreation(state, book);
  state.inventory = ['sword', 'torch'];
  state = play.navigateTo(state, book, 1);
  state = play.applyAction(state, book, 'accept');
  // choose_items mode:remove now pauses with the multi-eligible inventory
  assertEqual(state.pause?.type, 'choose_items', 'accept: choose_items pauses for drop pick');
  state = play.applyAction(state, book, 'choose_items', ['torch']);
  assertTrue(state.inventory.includes('shield'), 'accept: shield granted');
  assertEqual(state.inventory.includes('torch'), false, 'accept: torch dropped');
  assertEqual(state.flags.includes('accept_shield'), false, 'scratch flag cleared');
  assertEqual(state.flags.includes('shield_traded'), false, 'scratch flag cleared');
});

test('Rule 50 v2.46.0: prompt_choice is in the schema event-type enum', () => {
  const fs = require('fs');
  const schema = JSON.parse(fs.readFileSync(__dirname + '/../codex.schema.json', 'utf8'));
  const eventEnum = schema.definitions.event.properties.type.enum;
  assertTrue(eventEnum.includes('prompt_choice'), 'prompt_choice in event type enum');
});

test('Rule 50 v2.46.0: schema-additive — pre-v1.34 books validate unchanged', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'codex.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  // A v1.33-era book with no prompt_choice events.
  const book = {
    metadata: { title: 'B', author: 'a', total_sections: 1 },
    rules: { stats: [{ name: 'SKILL', initial: 10 }], abilities: { available: [] } },
    character_creation: { steps: [] },
    items_catalog: {},
    enemies_catalog: {},
    sections: {
      '1': {
        text: 't',
        events: [{ type: 'modify_stat', stat: 'SKILL', amount: 1 }],
        choices: [{ text: 'end', target: '1', condition: null }],
        is_ending: false,
      },
    },
  };
  assertTrue(validate(book), `pre-v1.34 book should validate clean: ${JSON.stringify(validate.errors)}`);
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
