# Emulator Implementation Guide

This document specifies how a compliant emulator should interpret and execute Gamebook Format (GBF) game data files. It is intended for developers building their own emulator in any language or platform.

The reference implementation is `index.html` in this repository. This guide documents the behavior that any compliant emulator may replicate, fully or partially, depending on the tier of compliance it aims for.

---

## 1. Overview

A GBF emulator is a state machine that:
1. Loads a game data JSON file
2. Presents frontmatter pages to the player
3. Runs character creation
4. Navigates the player through numbered sections, processing events and presenting choices
5. Ends when the player reaches a terminal section (death, victory, etc.)

The emulator contains **zero game-specific logic**. All mechanics — combat, stat tests, dice rolls, item selection — are defined by the game data file and the GBF schema. The emulator simply executes what the data describes.

---

## 2. Compliance Tiers

Not every emulator needs to implement the full GBF specification. GBF supports multiple tiers of compliance, letting developers build emulators that range from "e-reader with clickable choices" to "fully automated game engine." An emulator should declare which tier(s) it supports.

### Tier 1: Reader

A minimal emulator that displays sections and handles navigation choices. Supports:
- Frontmatter display
- Section text and image references
- `choices` navigation (no condition enforcement)

**Does NOT need to implement:** events, combat, stat tests, dice rolls, inventory, conditions, character creation, Lua scripting.

Tier 1 emulators treat a GBF file as an e-book. The player is responsible for tracking their own stats, inventory, and combat. This is useful for quick reading, accessibility, or low-resource platforms.

### Tier 2: Assisted

A Tier 1 emulator that also tracks state and displays it to the player, but does not automate mechanics. Adds:
- Character creation (stat rolling, ability selection)
- Stat bar and inventory display
- Manual controls: let the player edit stats, add/remove items, set flags, roll dice, etc.
- Condition evaluation on choices (grey out unavailable options)

**Manual mode:** Instead of executing combat scripts or stat tests automatically, Tier 2 emulators may offer manual input — e.g., "Combat happens here. Edit your stats when done." This gives the player the tools to track state without forcing automation.

### Tier 3: Full Auto

A Tier 2 emulator that also executes all mechanics automatically. Adds:
- Event processing (all event types)
- Combat with Lua script execution
- Stat tests, dice rolls, input events
- Script events

Tier 3 emulators play the game with no manual intervention required beyond making choices and clicking "Attack."

### Tier 4: Strict

A Tier 3 emulator that enforces strict schema compliance and surfaces all inconsistencies as visible errors rather than working around them. Useful for game data authors (including the Codex) who need rigorous feedback on their output.

### Flexibility Between Tiers

Any Tier 2+ emulator **should** offer a "low-tech" or "manual" escape hatch — the ability to manually edit state, manually resolve an encounter, or skip an event that's broken. This ensures that a bug in one section of a game doesn't render the entire book unplayable. Even a Tier 4 strict emulator should offer a debug mode that allows state edits.

The reference implementation (`index.html`) is primarily Tier 3 with some Tier 4 enforcement. It offers manual save/load and state editing via a debug panel.

---

## 3. Dependencies by Tier

| Tier | Needs |
|------|-------|
| 1 | JSON parser |
| 2 | JSON parser, RNG |
| 3 | JSON parser, RNG, Lua 5.3+ runtime |
| 4 | JSON parser, RNG, Lua 5.3+ runtime, strict schema validator |

**Lua runtime options:**
- Browser: Fengari (pure JS) or Wasmoon (WASM)
- Python: `lupa`
- Java/Kotlin: `LuaJ`
- C#/.NET: `MoonSharp` or `NLua`
- Go: `gopher-lua`
- Rust: `mlua`
- Swift/Obj-C: direct C interop with Lua C API

---

## 4. Game State (Tier 2+)

The emulator maintains the following state throughout a game session:

| Field | Type | Description |
|-------|------|-------------|
| `stats` | map[string → number] | All player stats, keyed by the exact stat name from `rules.stats` |
| `initialStats` | map[string → number] | Starting values for each stat (used for caps and restoration) |
| `inventory` | array[string] | Item IDs the player is currently carrying |
| `flags` | set[string] | Boolean flags that have been set during play |
| `provisions` | integer | Current provisions/food count |
| `gold` | integer | Current gold/currency count |
| `meals` | integer | Current meal count (if distinct from provisions) |
| `potion` | string or null | Name of the player's chosen potion (if applicable) |
| `potionDoses` | integer | Remaining potion doses |
| `abilities` | array[string] | Names of abilities/disciplines the player has chosen |
| `currentSection` | string | The section number the player is currently viewing |
| `visitedSections` | set[string] | All section numbers the player has visited |

All stat names must match **exactly** what appears in `rules.stats[].name`. The emulator must not normalize, lowercase, or transform stat names.

---

## 5. Game Lifecycle

### 4.1 Load Game Data

Parse the JSON file. Validate that the required top-level keys exist: `metadata`, `rules`, `sections`. The `character_creation`, `items_catalog`, `enemies_catalog`, and `frontmatter` keys are optional.

### 4.2 Check for Saved Game

If the emulator supports persistence (e.g., localStorage in a browser), check for an existing save matching the game's title. If found, offer the player a choice: **continue saved game** or **start new game**.

### 4.3 Display Frontmatter

If `frontmatter.pages` exists and is non-empty, display each page in order. Each page has:
- `title` — displayed as a heading
- `text` — the full page content, rendered as formatted text
- `type` — informational (`story`, `rules`, `reference`, `flavor`)

The player advances through pages sequentially (e.g., a "Continue" button). After the last page, proceed to character creation.

### 4.4 Character Creation

Process `character_creation.steps` in order. Each step has an `action` field:

| Action | Behavior |
|--------|----------|
| `roll_stat` | Roll dice using `formula`, store result in `stats[stat]` and `initialStats[stat]`. Display the roll to the player. |
| `choose_one` | Present `options` as buttons. The player selects one. For `category: "potion"`, store the choice and set doses from `rules.potion.doses`. For other categories, set a flag: `{category}_{option_snake_case}`. |
| `choose_abilities` | Present `rules.abilities.available` as a multi-select. Player picks `count` abilities. Store in `abilities` array and set flags as `ability_{name_snake_case}`. If any selected ability has `requires_roll`, prompt the player to roll and display the result. |
| `add_item` | Add the item ID to `inventory`. |
| `set_resource` | Set the named resource (`provisions`, `gold`, `meals`) to `amount`. |

If `steps` is empty, skip directly to section 1.

### 4.5 Begin Adventure

Navigate to section `"1"`.

---

## 6. Section Navigation

When navigating to a section:

1. Set `currentSection` to the section number. Add it to `visitedSections`.
2. Check `is_ending`. If true, display the ending (see Section 10).
3. Check if the player's health stat has reached 0. If so, display a death ending.
4. Display the section's `text` as formatted narrative.
5. Process `events` in order (see Section 6).
6. After all events are processed, display `choices` (see Section 8).

---

## 7. Event Processing (Tier 3+)

Events are processed sequentially. Some events are **blocking** — they pause processing until the player interacts (e.g., combat, stat tests, dice rolls). Others are **immediate** — they execute and continue to the next event.

### 6.1 `modify_stat`

**Immediate.** Modify `stats[event.stat]` by `event.amount`. Respect `initial_is_max` from the stat definition (don't exceed initial value if true). Respect `min` from the stat definition. Display the change to the player.

After applying, check if the health stat has reached 0 → death ending.

### 6.2 `add_item`

**Immediate.** Add `event.item` to `inventory` if not already present. Display to the player.

### 6.3 `remove_item`

**Immediate.** Remove `event.item` from `inventory`. Display to the player.

### 6.4 `set_flag`

**Immediate.** Add `event.flag` to the flags set. Display to the player (optional).

### 6.5 `combat`

**Blocking.** See Section 7.

### 6.6 `stat_test`

**Blocking.** Display the test (e.g., "Test your Luck"). Present a "Roll" button. When clicked:

1. Roll dice per the test method (typically `2d6` for Fighting Fantasy, `R10` for Lone Wolf).
2. Compare result to `stats[event.stat]`. Success if result ≤ stat value (for `lte` methods).
3. If `deduct_after` is true, subtract `deduct_amount` from `stats[deduct_stat]`.
4. Store the test result for use by `test_failed` / `test_succeeded` conditions on subsequent choices.
5. If `success_to` is non-null, navigate there on success. If `failure_to` is non-null, navigate there on failure. If the relevant target is null, continue to the next event.

If `failure_penalty` is present and the test failed, apply it as a `modify_stat`.

### 6.7 `roll_dice`

**Blocking.** Display the roll prompt. Present a "Roll" button. When clicked:

1. Roll using `event.dice` formula.
2. **If `event.apply_to_stat` is set:** Apply the result as a stat modification (negative by default, or positive if `amount_sign` is `"positive"`). Continue to next event.
3. **If `event.results` is an object:** Look up the result in the table. Keys may be exact numbers (`"3"`) or ranges (`"1-2"`). If a match is found and `target` is non-null, navigate to that section. If `target` is null, continue to the next event (the roll determined an outcome but didn't navigate). If no match is found, display an error.

### 6.8 `eat_meal`

**Blocking.** If the player has provisions/meals, present "Eat" and (if not `required`) "Skip" buttons. Eating: decrement provisions, restore `heal_amount` to `heal_stat` (capped at initial value). If the player has no provisions and the event is required, they cannot eat (penalty may apply per game rules).

### 6.9 `input_number`

**Blocking.** Display `event.prompt` and a numeric input field. When submitted, if `target` is `"computed"`, navigate to the entered number as a section.

### 6.10 `input_text`

**Blocking.** Display `event.prompt` and a text input field. When submitted, look up the answer in `event.answers` (case-insensitive unless `case_sensitive` is true). Navigate to the matching target, or to `event.default.target` if no match.

### 6.11 `choose_items`

**Blocking.** Display items from `items_catalog` that match `event.catalog_filter`. Items in `event.exclude` are hidden from selection but items in `event.add_automatic` are shown as non-selectable "always carried" entries. The player selects exactly `event.count` items. On confirm:

1. If `replace_category` is true, remove all existing inventory items that match the filter.
2. Add all `add_automatic` items.
3. Add all selected items.
4. Continue to the next event.

### 6.12 `script`

**Blocking.** Execute `event.script_code` as Lua in the sandbox (see Section 9). The sandbox provides: `game_state` (all player stats), `inventory` (item IDs), `flags` (flag names), `roll()`, `log()`, `lookup()`, `player`, `enemy` (empty in non-combat context), `combat` (empty). After execution:

- Apply `player.stats_changed` to player stats.
- If `player.navigate_to` is set, navigate to that section.
- Otherwise, continue to the next event.
- Display all `log()` messages to the player.
- Check for death.

### 6.13 `custom`

**Immediate.** Display `event.description` as informational text. The emulator cannot execute custom events — they exist only as documentation for mechanics that could not be expressed as structured events or scripts.

---

## 8. Combat (Tier 3+)

Combat is initiated by a `combat` event. The emulator resolves enemies from `enemies_catalog` using the `ref` field in each entry of `event.enemies` (or the single `event.enemy_ref`).

### 7.1 Initialization

For each enemy:
1. Look up the enemy in `enemies_catalog` by ref.
2. Read the enemy's health using the field matching `rules.health_stat` (exact name or snake_case variant).
3. Store as `currentHealth`.

Set the current enemy index to 0.

### 7.2 Display

Show the player's stats and the current enemy's stats. If `rules.attack_stat` is defined, display both combatants' attack and health stats. If `attack_stat` is null, display only health.

Show the combat log (accumulated round results). Show an "Attack" button (and "Flee" if `flee_to` is defined). If `event.special_rules` is set, display it as a visible note.

### 7.3 Attack (Round Execution)

When the player clicks "Attack":

1. Read `round_script` from `rules.combat_system` or `rules.combat_rules_detail`.
2. If no `round_script` exists, combat cannot proceed — display an error.
3. Build the Lua context (see Section 9.2).
4. Execute the script.
5. Read back `player.health`, `enemy.health`, `combat.last_result`, `combat.last_damage`.
6. Update the player's health stat and the enemy's `currentHealth`.
7. Add `log()` messages to the combat log.
8. If a `post_round_script` exists and `combat.last_result` indicates a wound (not `"tie"` or `"simultaneous"`), offer the post-round action button. Otherwise, check for combat end.

### 7.4 Post-Round Action (e.g., Luck Test)

When the player clicks the post-round button (labeled per `post_round_label`):

1. Build the Lua context with the additional `player_stats` and `initial_stats` globals.
2. Execute `post_round_script`.
3. Read back changes. Apply `player.stats_changed` to game state.
4. Update health values.
5. Check for combat end.

The player may also "Skip" the post-round action, which proceeds directly to combat end check.

### 7.5 Combat End Check

After each round (and after any post-round action):

1. If the player's health ≤ 0 → death ending.
2. If the current enemy's health ≤ 0:
   a. If there are more enemies (sequential/custom mode), advance to the next enemy.
   b. If all enemies are defeated: if `win_to` is defined, navigate there. If `win_to` is null, continue to the next event in the section.
3. Otherwise, render the combat display for the next round.

### 7.6 Flee

When the player clicks "Flee" (only shown when `flee_to` is defined):

1. Apply flee damage per `rules.escaping.flee_damage` to the player's health stat.
2. If a `post_round_script` exists and flee-wound luck testing is allowed (`rules.escaping.luck_on_flee_wound_allowed`), offer the post-round action.
3. Navigate to `flee_to`.

### 7.7 Multi-Enemy Combat

Enemies are fought based on `event.mode`:
- `sequential` — one at a time, in order
- `simultaneous` — all at once (the Lua script handles targeting)
- `player_choice` — player selects which enemy to target each round

For mechanics that must happen between enemies (e.g., gaining a stat bonus after defeating the first), use separate combat events with `win_to: null` on the first (see schema section 8.5).

---

## 9. Choices

After all events are processed, display the section's `choices` as clickable options. Each choice has:

- `text` — display text
- `target` — section number to navigate to
- `condition` — optional; if present, evaluate it (see Section 8.1)

If a condition is not met, the choice should be **visible but disabled** (greyed out), with a tooltip explaining why (e.g., "Requires: Golden Key").

If `target` is null, check for a section-level `luck_test` or `skill_test` object and trigger an inline stat test.

### 8.1 Condition Evaluation

Conditions are recursive. Evaluate as follows:

| Type | Rule |
|------|------|
| `has_item` | True if `item` is in `inventory` |
| `has_flag` | True if `flag` is in `flags` |
| `stat_gte` | True if `stats[stat]` ≥ `value` |
| `stat_lte` | True if `stats[stat]` ≤ `value` |
| `has_ability` | True if `ability` is in `abilities` (match by name, case-insensitive) or if a corresponding flag exists |
| `not` | True if the inner `condition` is false |
| `and` | True if ALL inner `conditions` are true |
| `or` | True if ANY inner `conditions` are true |
| `test_failed` | True if the most recent stat test in this section failed |
| `test_succeeded` | True if the most recent stat test in this section succeeded |

---

## 10. Lua Sandbox (Tier 3+)

The emulator must provide a sandboxed Lua 5.3+ environment for executing scripts. The sandbox must be **safe** — no file I/O, no network access, no debug library.

### 9.1 Safe Libraries

Only load: `base` (with dangerous functions removed), `math`, `string`, `table`. Remove: `dofile`, `loadfile`, `require`, `collectgarbage`, `io`, `os`, `debug`.

### 9.2 Combat Script Context

Before executing a `round_script`, push these globals:

| Global | Contents |
|--------|----------|
| `player` | `{attack=N, health=N, name="You", ...all_stats, ...passive_equipment_modifiers}` |
| `enemy` | `{attack=N, health=N, name="...", ...all_catalog_fields}` |
| `combat` | `{round=N, standard_damage=N, last_result="", last_damage=0}` |
| `roll` | Function: `roll(formula)` → `{total=N, rolls={...}, text="..."}` |
| `log` | Function: `log(msg)` → adds to combat log |
| `lookup` | Function: `lookup(table, col, row)` → `table[col][row]` |
| `inventory` | Array of item IDs the player carries |
| `items_catalog` | Full items catalog from game data |
| All keys from `combat_system.details` | As individual globals |

For `post_round_script`, also push:
| `player_stats` | All player stats |
| `initial_stats` | Initial stat values |

**Passive equipment:** Before building the `player` table, iterate through inventory items. For items with `stat_modifier.when == "always"`, apply their modifier fields to the player table. Items with `when == "combat"` are **not** applied automatically — the Lua script must handle weapon selection using `inventory` and `items_catalog`.

### 9.3 Script Event Context

For `script` events (non-combat), push:

| Global | Contents |
|--------|----------|
| `player` | `{health=N, name="You"}` |
| `enemy` | `{attack=0, health=0, name=""}` (empty placeholder) |
| `combat` | `{round=0}` (empty placeholder) |
| `game_state` | All player stats |
| `inventory` | Array of item IDs |
| `flags` | Array of flag names |
| `roll`, `log`, `lookup` | Same as combat |

After execution, read back:
- `player.stats_changed` → apply to game state
- `player.navigate_to` → navigate to that section (skipping remaining events)
- `log()` messages → display to player

### 9.4 Roll Function

The `roll(formula)` function must support:

| Formula | Behavior |
|---------|----------|
| `NdX` | Roll N dice with X sides (e.g., `2d6`) |
| `NdX+Y` | Roll and add Y |
| `NdX-Y` | Roll and subtract Y |
| `NdX*Y` | Roll and multiply by Y |
| `R10` | Random integer 0-9 (Lone Wolf random number table) |
| `R10+Y` | Random 0-9 plus Y |

Returns a table: `{total=N, rolls={...}, text="comma-separated rolls"}`.

---

## 11. Endings

When a section has `is_ending: true`:

- Display the section text.
- Style based on `ending_type`: `death` (somber), `victory` (celebratory), `neutral`, `continuation`.
- Show a "Play Again" button that resets all state and returns to the load screen.

Also trigger a death ending whenever the health stat reaches 0, regardless of whether the current section is marked as an ending.

---

## 12. Stat Bar (Tier 2+)

Display a persistent stat bar showing:
- All stats from `rules.stats` with current/initial values
- Provisions, gold, meals (if applicable)
- Potion with remaining doses (clickable to use)

The stat bar should update after every state change.

---

## 13. Inventory Display (Tier 2+)

Show the player's inventory as a collapsible panel. Display item names from `items_catalog`. If the player has a potion shown in the stat bar, optionally hide it from the inventory list to avoid visual duplication.

---

## 14. Save/Load (Optional)

If the platform supports persistence:

- **Save:** Serialize the complete game state (stats, initialStats, inventory, flags, provisions, gold, meals, potion, potionDoses, abilities, currentSection, visitedSections) to storage, keyed by game title.
- **Load:** Deserialize and navigate to `currentSection`.
- **Export:** Save state as a downloadable JSON file.
- **Import:** Load state from a JSON file.

Serialization note: `flags` and `visitedSections` are sets — serialize as arrays.

---

## 15. Strict Schema Compliance (Tier 4 only)

A Tier 4 emulator must **only** support structures and types defined in the GBF JSON Schema (`codex.schema.json`). If game data uses non-schema fields or invalid types, the emulator should fail visibly rather than silently handling it. This ensures that:

1. Schema shortcomings are surfaced as bugs, not hidden by workarounds.
2. Any Tier 4 emulator will behave identically for the same game data.
3. Game data producers (the Codex) get clear feedback on what works and what doesn't.

Tier 4 emulators do not add fallback behavior, guessing, or heuristics for malformed data. If the data is wrong, the emulator shows an error.

**Tier 1-3 emulators may be more forgiving.** They can choose to silently handle missing fields, normalize values, or display partial data instead of crashing. The tradeoff: more permissive emulators are friendlier to players but less useful for catching data quality issues.

---

## 16. Manual Escape Hatch (Strongly Recommended)

Any Tier 2+ emulator should provide a way for players to manually intervene when something goes wrong. Possible mechanisms:

- **Debug panel** — Shows current state (stats, inventory, flags, current section) and lets the player edit values directly.
- **Manual section navigation** — A "Go to section..." input that lets the player jump to any section, bypassing broken events or stuck combats.
- **Manual dice roll override** — When a stat test or dice roll happens, allow the player to enter the result manually instead of (or in addition to) clicking "Roll."
- **Skip event** — A button that abandons the current blocking event and moves on.
- **State import/export** — Let players save and restore state to JSON files for sharing or recovery.

**Why this matters:** GBF files are produced by AI parsing or manual transcription, both of which can have bugs. A single broken event in a 400-section game shouldn't render the entire book unplayable. The escape hatch lets players work around bugs while still enjoying the game. It also enables accessibility use cases — a player who prefers to roll real dice can do so and enter the results manually.

The reference implementation provides a debug panel showing live state. Future versions will add more manual controls.

---

## 17. Declaring Compliance

An emulator should publicly declare its compliance tier(s) and which optional features it supports. Example declaration:

```
Codex Gamebook Engine — Reference Implementation
- Tier: 3 (Full Auto), with optional Tier 4 strict mode
- Lua runtime: Fengari
- Save/Load: Yes (browser localStorage + import/export)
- Manual escape hatch: Debug panel
- Platforms: Browser (any)
```

This helps players know what to expect and helps game data authors target compatible emulators.
