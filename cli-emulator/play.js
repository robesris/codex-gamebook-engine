#!/usr/bin/env node
/**
 * Codex Gamebook Engine — CLI Emulator
 *
 * Version: 2.3.0
 * Compatible with codex doc >= 2.4 and GBF schema >= 1.2.0
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

const CODEX_EMULATOR_VERSION = '2.3.0';
// Pinned Lua runtime. See package.json for the exact npm version and
// package-lock.json for the integrity hash. Fengari is an unmaintained
// pure-JS Lua 5.3 implementation; the project is frozen but functional
// for our usage (small combat round scripts and section-level scripts).
// If we ever bump this pin, re-run the full regression harness
// (lw_probe, warlock_probe, all runN playbooks) to verify no behaviour
// differences in the scripts we ship in book JSONs.
const FENGARI_RUNTIME_PIN = 'fengari@0.1.5';

const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

// ==================== UTILITIES ====================

function loadJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function rollDice(formula, forcedRolls) {
  // Handle R10 (Lone Wolf random number table: 0-9)
  const r10 = formula.match(/^R10(?:\+(\d+))?$/);
  if (r10) {
    const bonus = r10[1] ? parseInt(r10[1]) : 0;
    const roll = forcedRolls && forcedRolls.length > 0
      ? forcedRolls[0]
      : Math.floor(Math.random() * 10);
    return { total: roll + bonus, rolls: [roll], bonus, op: '+' };
  }
  // Parse "NdX+Y", "NdX*Y", "NdX-Y", or "NdX"
  const m = formula.match(/(\d+)d(\d+)(?:([+\-*])(\d+))?/);
  if (!m) return { total: 0, rolls: [], bonus: 0 };
  const count = parseInt(m[1]);
  const sides = parseInt(m[2]);
  const op = m[3] || '+';
  const modifier = m[4] ? parseInt(m[4]) : 0;
  const rolls = [];
  for (let i = 0; i < count; i++) {
    if (forcedRolls && forcedRolls.length > i) {
      rolls.push(forcedRolls[i]);
    } else {
      rolls.push(Math.floor(Math.random() * sides) + 1);
    }
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = op === '*' ? sum * modifier : op === '-' ? sum - modifier : sum + modifier;
  return { total, rolls, bonus: modifier, op };
}

// ==================== LUA SANDBOX ====================

function createSandbox() {
  const L = lauxlib.luaL_newstate();
  lauxlib.luaL_requiref(L, to_luastring('_G'), lualib.luaopen_base, 1); lua.lua_pop(L, 1);
  lauxlib.luaL_requiref(L, to_luastring('math'), lualib.luaopen_math, 1); lua.lua_pop(L, 1);
  lauxlib.luaL_requiref(L, to_luastring('string'), lualib.luaopen_string, 1); lua.lua_pop(L, 1);
  lauxlib.luaL_requiref(L, to_luastring('table'), lualib.luaopen_table, 1); lua.lua_pop(L, 1);
  for (const name of ['dofile', 'loadfile', 'require', 'collectgarbage', 'rawset', 'rawget', 'io', 'os', 'debug']) {
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, to_luastring(name));
  }
  return L;
}

function pushValue(L, val) {
  if (val === null || val === undefined) lua.lua_pushnil(L);
  else if (typeof val === 'number') lua.lua_pushnumber(L, val);
  else if (typeof val === 'string') lua.lua_pushstring(L, to_luastring(val));
  else if (typeof val === 'boolean') lua.lua_pushboolean(L, val);
  else if (Array.isArray(val)) {
    lua.lua_createtable(L, val.length, 0);
    for (let i = 0; i < val.length; i++) {
      pushValue(L, val[i]);
      lua.lua_rawseti(L, -2, i + 1);
    }
  } else if (typeof val === 'object') {
    pushTable(L, val);
  } else {
    lua.lua_pushnil(L);
  }
}

function pushTable(L, obj) {
  lua.lua_createtable(L, 0, Object.keys(obj).length);
  for (const [key, val] of Object.entries(obj)) {
    lua.lua_pushstring(L, to_luastring(String(key)));
    pushValue(L, val);
    lua.lua_settable(L, -3);
  }
}

function readTable(L, idx) {
  const obj = {};
  lua.lua_pushnil(L);
  while (lua.lua_next(L, idx < 0 ? idx - 1 : idx) !== 0) {
    let key;
    if (lua.lua_type(L, -2) === lua.LUA_TSTRING) {
      key = to_jsstring(lua.lua_tostring(L, -2));
    } else if (lua.lua_type(L, -2) === lua.LUA_TNUMBER) {
      key = lua.lua_tonumber(L, -2);
    } else {
      key = null;
    }
    let val;
    const valType = lua.lua_type(L, -1);
    if (valType === lua.LUA_TNUMBER) val = lua.lua_tonumber(L, -1);
    else if (valType === lua.LUA_TSTRING) val = to_jsstring(lua.lua_tostring(L, -1));
    else if (valType === lua.LUA_TBOOLEAN) val = lua.lua_toboolean(L, -1);
    else if (valType === lua.LUA_TTABLE) val = readTable(L, lua.lua_gettop(L));
    else val = null;
    if (key !== null) obj[key] = val;
    lua.lua_pop(L, 1);
  }
  return obj;
}

function runScript(scriptCode, context, forcedRolls, forcedClock) {
  const L = createSandbox();
  const logs = [];
  // Use forcedRolls by reference when it's a genuine queue (array) so that
  // chained script events (see runScriptEvent) share the same draw pile.
  // Fall back to a private copy for callers that pass an array literal
  // for a one-shot use (runCombatRound / runPostRound).
  const rollsUsed = Array.isArray(forcedRolls) ? forcedRolls : [];

  // roll(formula) function — uses forced rolls if available.
  //
  // Dice results (both the sum `total` and the per-die `rolls` values)
  // are pushed as Lua INTEGERS, not floats. This matters because the
  // Lone Wolf round_script (and any future combat system that indexes
  // a lookup table by roll value as a string key) does
  //     combat_results_table[cr_key][tostring(rval)]
  // and Lua 5.3's tostring() distinguishes integers from floats:
  // tostring(9) returns "9" while tostring(9.0) returns "9.0". If we
  // pushed die rolls as lua_pushnumber (which promotes to float), the
  // lookup would silently miss on every row of the Combat Results
  // Table, dealing zero damage to both sides and hanging the fight
  // indefinitely. Pushing as lua_pushinteger keeps the values as Lua
  // integers so tostring(rval) returns the expected plain-digit key.
  lua.lua_pushjsfunction(L, function(L) {
    const formula = to_jsstring(lua.lua_tostring(L, 1));
    const result = rollDice(formula, rollsUsed.length > 0 ? rollsUsed.shift() : null);
    lua.lua_createtable(L, 0, 3);
    lua.lua_pushstring(L, to_luastring('total'));
    lua.lua_pushinteger(L, result.total);
    lua.lua_settable(L, -3);
    lua.lua_pushstring(L, to_luastring('rolls'));
    lua.lua_createtable(L, result.rolls.length, 0);
    for (let i = 0; i < result.rolls.length; i++) {
      lua.lua_pushinteger(L, result.rolls[i]);
      lua.lua_rawseti(L, -2, i + 1);
    }
    lua.lua_settable(L, -3);
    lua.lua_pushstring(L, to_luastring('text'));
    lua.lua_pushstring(L, to_luastring(result.rolls.join(', ')));
    lua.lua_settable(L, -3);
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('roll'));

  // log(msg) function
  lua.lua_pushjsfunction(L, function(L) {
    const msg = to_jsstring(lua.lua_tostring(L, 1));
    logs.push(msg);
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('log'));

  // lookup(table, col, row) function
  lua.lua_pushjsfunction(L, function(L) {
    if (lua.lua_type(L, 1) !== lua.LUA_TTABLE) { lua.lua_pushnil(L); return 1; }
    const tbl = readTable(L, 1);
    const col = lua.lua_type(L, 2) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, 2)) : String(lua.lua_tonumber(L, 2));
    const row = lua.lua_type(L, 3) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, 3)) : String(lua.lua_tonumber(L, 3));
    const result = tbl?.[col]?.[row];
    if (result && typeof result === 'object') pushTable(L, result);
    else if (typeof result === 'number') lua.lua_pushnumber(L, result);
    else lua.lua_pushnil(L);
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('lookup'));

  // get_clock() returns {wday=1..7 (1=Sun), hour=0..23, minute=0..59}.
  // If forcedClock is supplied by the playbook via set_clock, use it;
  // otherwise fall back to the real wall clock. This lets scripts encode
  // "if reading on Sunday night" type mechanics deterministically in tests.
  lua.lua_pushjsfunction(L, function(L) {
    let wday, hour, minute;
    if (forcedClock && typeof forcedClock === 'object') {
      wday = forcedClock.wday;
      hour = forcedClock.hour;
      minute = forcedClock.minute !== undefined ? forcedClock.minute : 0;
    } else {
      const d = new Date();
      wday = d.getDay() + 1; // JS 0..6 (Sun..Sat) -> 1..7
      hour = d.getHours();
      minute = d.getMinutes();
    }
    lua.lua_createtable(L, 0, 3);
    lua.lua_pushstring(L, to_luastring('wday'));
    lua.lua_pushinteger(L, wday);
    lua.lua_settable(L, -3);
    lua.lua_pushstring(L, to_luastring('hour'));
    lua.lua_pushinteger(L, hour);
    lua.lua_settable(L, -3);
    lua.lua_pushstring(L, to_luastring('minute'));
    lua.lua_pushinteger(L, minute);
    lua.lua_settable(L, -3);
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('get_clock'));

  // Push all context variables as globals
  for (const [key, val] of Object.entries(context || {})) {
    pushValue(L, val);
    lua.lua_setglobal(L, to_luastring(key));
  }

  // Execute
  const status = lauxlib.luaL_dostring(L, to_luastring(scriptCode));
  if (status !== lua.LUA_OK) {
    const err = to_jsstring(lua.lua_tostring(L, -1));
    lua.lua_close(L);
    return { error: err, logs };
  }

  // Read back any tables we expect to have changed
  const result = { logs, error: null };
  for (const key of ['player', 'enemy', 'combat', 'game_state']) {
    lua.lua_getglobal(L, to_luastring(key));
    if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
      result[key] = readTable(L, lua.lua_gettop(L));
    }
    lua.lua_pop(L, 1);
  }

  lua.lua_close(L);
  return result;
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
    flags: [],
    provisions: 0,
    gold: 0,
    meals: 0,
    abilities: [],
    potion: null,
    currentSection: null,
    previousSection: null,
    visitedSections: [],
    // Stack of caller section ids pushed when the player navigates INTO a
    // section with `is_subroutine_entry: true`. Popped by the runtime when
    // a `return_to_caller` event fires in the reference (auto-return)
    // implementation. Empty by default. See codex section 7.6.8.
    returnStack: [],
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
  };
}

function loadBook(state) {
  return loadJSON(state.bookPath);
}

// ==================== CONDITION EVALUATION ====================

function evalCondition(cond, state) {
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
    case 'not': return !evalCondition(cond.condition, state);
    case 'and': return (cond.conditions || []).every(c => evalCondition(c, state));
    case 'or': return (cond.conditions || []).some(c => evalCondition(c, state));
    case 'test_failed': return state.lastTestResult === false;
    case 'test_succeeded': return state.lastTestResult === true;
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
    case 'not': return `NOT (${describeCondition(cond.condition)})`;
    case 'and': return (cond.conditions || []).map(describeCondition).join(' AND ');
    case 'or': return (cond.conditions || []).map(describeCondition).join(' OR ');
    case 'test_failed': return 'test failed';
    case 'test_succeeded': return 'test succeeded';
    default: return cond.type;
  }
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

function startCharacterCreation(state, book) {
  state.pause = { type: 'character_creation' };
  state.creationStep = 0;
  return processCreationSteps(state, book);
}

function processCreationSteps(state, book) {
  const steps = book.character_creation?.steps || [];
  while (state.creationStep < steps.length) {
    const step = steps[state.creationStep];
    if (step.action === 'roll_stat') {
      state.pause = { type: 'character_creation_roll', step_index: state.creationStep, stat: step.stat, formula: step.formula };
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
    } else if (step.action === 'add_item') {
      if (!state.inventory.includes(step.item)) state.inventory.push(step.item);
      state.creationStep++;
    } else if (step.action === 'set_resource') {
      if (step.resource === 'provisions') state.provisions = step.amount;
      else if (step.resource === 'gold') state.gold = step.amount;
      else if (step.resource === 'meals') state.meals = step.amount;
      state.creationStep++;
    } else {
      // Unknown action — skip
      state.creationStep++;
    }
  }
  // Done with creation
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
  // Capture the caller before updating currentSection. previousSection is
  // the section we're LEAVING as this call runs; it will become the
  // "caller" if the destination is a subroutine entry.
  const callerId = state.currentSection;
  state.previousSection = callerId;
  state.currentSection = sid;
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
  if (event.condition && !evalCondition(event.condition, state)) {
    state.log.push(`Event skipped (${event.type}: ${describeCondition(event.condition)} is false)`);
    return 'continue';
  }
  switch (event.type) {
    case 'modify_stat': {
      const stat = event.stat;
      const amount = event.amount || 0;
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
      state.log.push(`${stat} ${amount >= 0 ? '+' : ''}${amount}${event.modify_initial ? ' (permanent, initial updated)' : ''}${event.reason ? ' (' + event.reason + ')' : ''}`);
      return 'continue';
    }
    case 'add_item':
      if (!state.inventory.includes(event.item)) state.inventory.push(event.item);
      state.log.push(`Acquired: ${event.item}`);
      return 'continue';
    case 'remove_item': {
      const idx = state.inventory.indexOf(event.item);
      if (idx >= 0) state.inventory.splice(idx, 1);
      state.log.push(`Lost: ${event.item}`);
      return 'continue';
    }
    case 'set_flag':
      if (!state.flags.includes(event.flag)) state.flags.push(event.flag);
      state.log.push(`Flag set: ${event.flag}`);
      return 'continue';
    case 'combat':
      return startCombat(event, state, book);
    case 'stat_test':
      state.pause = { type: 'stat_test', event };
      return 'pause';
    case 'roll_dice':
      state.pause = { type: 'roll_dice', event };
      return 'pause';
    case 'eat_meal':
      state.pause = { type: 'eat_meal', event };
      return 'pause';
    case 'input_number':
      state.pause = { type: 'input_number', event };
      return 'pause';
    case 'input_text':
      state.pause = { type: 'input_text', event };
      return 'pause';
    case 'choose_items':
      state.pause = { type: 'choose_items', event };
      return 'pause';
    case 'script':
      return runScriptEvent(event, state, book);
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
  let enemies = [];
  if (event.enemies) {
    enemies = event.enemies.map(e => {
      const data = book.enemies_catalog[e.ref] || {};
      return { ref: e.ref, name: data.name, currentHealth: getEnemyHealth(data, book), data };
    });
  } else if (event.enemy_ref) {
    const data = book.enemies_catalog[event.enemy_ref] || {};
    enemies = [{ ref: event.enemy_ref, name: data.name, currentHealth: getEnemyHealth(data, book), data }];
  }
  state.combat = {
    enemies,
    currentEnemyIdx: 0,
    mode: event.mode || 'sequential',
    winTo: event.win_to,
    fleeTo: event.flee_to,
    specialRules: event.special_rules,
    round: 0,
    lastRoundResult: null,
    awaitingPostRound: false,
  };
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

    case 'character_creation_choose_one':
      for (const opt of state.pause.options) {
        actions.push({ name: 'choose', description: `choose ${JSON.stringify(opt)}` });
      }
      break;

    case 'character_creation_choose_abilities':
      actions.push({ name: 'choose_abilities', description: `Pick ${state.pause.count} from: ${state.pause.available.join(', ')}` });
      break;

    case 'section':
      // Choices
      const choices = state.pendingChoices || [];
      for (let i = 0; i < choices.length; i++) {
        const c = choices[i];
        const ok = evalCondition(c.condition, state);
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
        if (combat.fleeTo) actions.push({ name: 'flee', description: 'Flee' });
      }
      actions.push({ name: 'provide_roll', description: 'For next attack: provide_roll <values>' });
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

    case 'character_creation_choose_one': {
      const step = book.character_creation.steps[state.pause.step_index];
      const choice = args.join(' ');
      if (step.category === 'potion') {
        state.potion = { name: choice, doses: book.rules?.potion?.doses || 2 };
        const id = choice.toLowerCase().replace(/ /g, '_');
        if (!state.inventory.includes(id)) state.inventory.push(id);
      } else {
        const flagName = `${step.category}_${choice.toLowerCase().replace(/ /g, '_')}`;
        if (!state.flags.includes(flagName)) state.flags.push(flagName);
      }
      state.log.push(`Chose ${step.category}: ${choice}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'character_creation_choose_abilities': {
      // args is the list of ability names
      const chosen = args;
      state.abilities = [...chosen];
      for (const name of chosen) {
        const flag = 'ability_' + name.toLowerCase().replace(/ /g, '_');
        if (!state.flags.includes(flag)) state.flags.push(flag);
      }
      state.log.push(`Chose abilities: ${chosen.join(', ')}`);
      state.creationStep++;
      return processCreationSteps(state, book);
    }

    case 'section':
      if (action === 'choose_section') {
        const idx = parseInt(args[0]);
        const choices = state.pendingChoices || [];
        const choice = choices[idx];
        if (!choice) {
          state.log.push(`Invalid choice index: ${idx}`);
          return state;
        }
        if (!evalCondition(choice.condition, state)) {
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
        const p = event.failure_penalty;
        if (p.stat) {
          state.stats[p.stat] = (state.stats[p.stat] || 0) + (p.amount || 0);
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
      let target = null, matched = false, resultText = '';
      if (results[String(result.total)]) {
        matched = true;
        target = results[String(result.total)].target;
        resultText = results[String(result.total)].text || results[String(result.total)].note || '';
      } else {
        for (const [key, val] of Object.entries(results)) {
          if (key.includes('-')) {
            const [lo, hi] = key.split('-').map(Number);
            if (result.total >= lo && result.total <= hi) {
              matched = true;
              target = val.target;
              resultText = val.text || val.note || '';
              break;
            }
          }
        }
      }
      if (resultText) state.log.push(resultText);
      state.pause = null;
      if (target) return navigateTo(state, book, target);
      if (matched) return processNextEvent(state, book);
      state.log.push(`No result for ${result.total}`);
      return processNextEvent(state, book);
    }

    case 'eat_meal': {
      const event = state.pause.event;
      if (action === 'eat') {
        const heal = event.heal_amount || book.rules?.provisions?.heal_amount || 4;
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
      } else {
        state.log.push('Skipped meal');
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
      // Auto items
      for (const id of (event.add_automatic || [])) {
        if (!state.inventory.includes(id)) state.inventory.push(id);
      }
      // Replace category if needed
      if (event.replace_category) {
        const filterKey = Object.keys(event.catalog_filter || {})[0];
        const filterVal = event.catalog_filter[filterKey];
        if (filterKey && filterVal) {
          state.inventory = state.inventory.filter(id => {
            const item = catalog[id];
            if (!item || item[filterKey] !== filterVal) return true;
            // Don't filter out auto items
            return (event.add_automatic || []).includes(id);
          });
        }
      }
      for (const id of selected) {
        if (!state.inventory.includes(id)) state.inventory.push(id);
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

  if (action === 'flee') {
    const fleeRules = book.rules?.escaping || {};
    const fleeDmg = fleeRules.flee_damage || 2;
    setPlayerHealth(state, book, Math.max(0, getPlayerHealth(state, book) - fleeDmg));
    state.log.push(`Fled! -${fleeDmg} damage`);
    if (getPlayerHealth(state, book) <= 0) {
      state.pause = { type: 'ending', ending_type: 'death', text: 'You died fleeing.' };
      state.combat = null;
      return state;
    }
    if (combat.fleeTo) {
      state.combat = null;
      return navigateTo(state, book, combat.fleeTo);
    }
    return state;
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

  // Apply passive equipment (when:"always"). The canonical shape of
  // stat_modifier per the codex section 2.5 is
  //   { "stat": "<stat name>", "amount": <number>, "when": "always|combat|equipped" }
  // where `stat` is a STRING NAMING the target stat and `amount` is
  // the bonus/penalty to add. An earlier version of this code walked
  // Object.entries(item.stat_modifier) and treated every key as a
  // stat name, which set playerData.stat = "endurance" and
  // playerData.amount = 2 instead of applying an ENDURANCE bonus.
  // Now we read the structured fields directly.
  const catalog = book.items_catalog || {};
  for (const itemId of state.inventory) {
    const item = catalog[itemId];
    const sm = item?.stat_modifier;
    if (sm && sm.when === 'always' && typeof sm.stat === 'string' && typeof sm.amount === 'number') {
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

  const combatData = {
    round: combat.round,
    standard_damage: cs.details?.standard_damage || cs.standard_damage || 2,
    last_result: '',
    last_damage: 0,
  };

  const context = {
    player: playerData,
    enemy: enemyData,
    combat: combatData,
    inventory: [...state.inventory],
    items_catalog: catalog,
  };
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

  // Apply results
  if (result.enemy?.health !== undefined) {
    enemy.currentHealth = Math.max(0, result.enemy.health);
  }
  if (result.player?.health !== undefined) {
    setPlayerHealth(state, book, Math.max(0, result.player.health));
  }
  for (const msg of result.logs || []) state.log.push(msg);

  combat.lastRoundResult = result.combat?.last_result;
  combat.lastDamage = result.combat?.last_damage || 0;

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

function checkCombatEnd(state, book) {
  const combat = state.combat;
  const enemy = combat.enemies[combat.currentEnemyIdx];

  if (getPlayerHealth(state, book) <= 0) {
    state.combat = null;
    state.pause = { type: 'ending', ending_type: 'death', text: 'You have been slain in combat.' };
    return state;
  }

  if (enemy.currentHealth <= 0) {
    state.log.push(`${enemy.name} defeated!`);
    const nextIdx = combat.currentEnemyIdx + 1;
    if (nextIdx < combat.enemies.length && (combat.mode === 'sequential' || combat.mode === 'custom')) {
      combat.currentEnemyIdx = nextIdx;
      return state;
    }
    // All enemies defeated
    const winTo = combat.winTo;
    state.combat = null;
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
    flags: state.flags,
    provisions: state.provisions,
    gold: state.gold,
    meals: state.meals,
    abilities: state.abilities,
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
    log: state.log.slice(-20), // Keep recent log entries only
  };
  return out;
}

// ==================== HUMAN-READABLE SUMMARY ====================

function summarize(state, book) {
  const lines = [];
  const { healthStat, attackStat } = getCombatStats(book);

  if (state.pause?.type === 'frontmatter') {
    const page = (book.frontmatter?.pages || [])[state.frontmatterPage];
    if (page) {
      lines.push(`[Frontmatter page ${state.frontmatterPage + 1}: ${page.title}]`);
    }
  } else if (state.pause?.type === 'character_creation_roll') {
    lines.push(`[Character Creation] Roll ${state.pause.formula} for ${state.pause.stat}`);
  } else if (state.pause?.type === 'character_creation_choose_one') {
    lines.push(`[Character Creation] Choose ${state.pause.category}: ${state.pause.options.join(' / ')}`);
  } else if (state.pause?.type === 'character_creation_choose_abilities') {
    lines.push(`[Character Creation] Choose ${state.pause.count} abilities from: ${state.pause.available.join(', ')}`);
  } else if (state.pause?.type === 'section') {
    lines.push(`Section ${state.currentSection}`);
    const stats = [];
    if (attackStat) stats.push(`${attackStat} ${state.stats[attackStat]}/${state.initialStats[attackStat]}`);
    if (healthStat) stats.push(`${healthStat} ${state.stats[healthStat]}/${state.initialStats[healthStat]}`);
    const provLabel = book.rules?.provisions?.display_name || 'Provisions';
    const goldLabel = book.rules?.inventory?.currency_display_name || 'Gold';
    if (state.provisions > 0) stats.push(`${provLabel} ${state.provisions}`);
    if (state.gold > 0) stats.push(`${goldLabel} ${state.gold}`);
    lines.push(`  ${stats.join(' | ')}`);
  } else if (state.pause?.type === 'combat') {
    const enemy = state.combat.enemies[state.combat.currentEnemyIdx];
    lines.push(`[Combat: ${enemy.name}]`);
    const eAtt = getEnemyAttack(enemy.data, book);
    const eMax = getEnemyHealth(enemy.data, book);
    if (attackStat) {
      lines.push(`  You: ${attackStat} ${state.stats[attackStat]}, ${healthStat} ${state.stats[healthStat]}/${state.initialStats[healthStat]}`);
      lines.push(`  ${enemy.name}: ${attackStat} ${eAtt}, ${healthStat} ${enemy.currentHealth}/${eMax}`);
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
  const envelope = {
    state: compact,
    summary,
    available_actions: actions,
    is_dry_run: !!isDry,
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
};

if (require.main === module) {
  main();
}
