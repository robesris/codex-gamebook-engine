/**
 * Shared Lua script runtime — the canonical sandbox for GBF `script` events
 * and combat round/post scripts.
 *
 * ⚠️ IMPORTANT — SINGLE SOURCE OF TRUTH. This module is the ONLY place the
 * Lua sandbox (roll()/log()/lookup()/get_clock(), the player/enemy/combat/
 * game_state bridge, and the dice math) is defined. It is consumed by:
 *   - cli-emulator/play.js          (Node — the canonical CLI emulator)
 *   - scripts/validate-book.js      (Node — the script-execution gate)
 *   - scripts/verify-book.browser.js (browser — the Claude.ai Analysis-tool
 *                                     verifier)
 * Do NOT fork or reimplement runScript / rollDice / the sandbox elsewhere.
 * Any reimplementation silently drifts from the real runtime API and defeats
 * the script-execution gate. New consumers import this module; they do not
 * copy it.
 *
 * Environment-agnostic. The UMD wrapper resolves the Fengari Lua runtime:
 *   - Node:    require('fengari')              (npm, pinned fengari@0.1.5)
 *   - Browser: the `fengari` global exposed by fengari-web.js, which MUST be
 *              loaded before this file. fengari-web.js is committed as a
 *              static bundle and reports Fengari 0.1.5 — the same version as
 *              the npm pin, so the Node and browser sandboxes are identical.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fengari'));
  } else {
    root.ScriptRuntime = factory(root.fengari);
  }
}(typeof self !== 'undefined' ? self : this, function (fengari) {
  'use strict';

  if (!fengari) {
    throw new Error(
      'script-runtime: Fengari Lua runtime not available. In the browser, ' +
      'load fengari-web.js before script-runtime.js; in Node, install fengari.'
    );
  }
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

  // Pinned Lua runtime. Fengari is an unmaintained pure-JS Lua 5.3
  // implementation; the project is frozen but functional for our usage
  // (small combat round scripts and section-level scripts). If this pin is
  // ever bumped, re-run the full regression harness (lw_probe, warlock_probe,
  // all runN playbooks) to verify no behaviour differences in shipped scripts.
  const FENGARI_RUNTIME_PIN = 'fengari@0.1.5';

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

  return { FENGARI_RUNTIME_PIN, rollDice, createSandbox, pushValue, pushTable, readTable, runScript };
}));
