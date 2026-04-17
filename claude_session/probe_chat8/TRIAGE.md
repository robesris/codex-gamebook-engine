# LW1 Fresh-Parse Verification — Chat #8 Triage

**Date:** 2026-04-17
**Probe:** blind fresh parse of LW1 against codex v2.10.0 / schema v1.7.0 /
emulators v3.2.0, produced by a scope-limited sub-agent with read
access to `raw/01fftd.pdf` + engine repo only (NOT the books repo).
**Sub-agent deliverable:** structural-probe report + 20 representative
section JSONs, all inline (no file writes). Full sub-agent transcript
preserved in REPORT.md alongside this file.

## Verdict

**Mostly validates the production line, with 6 new codex/schema/emulator
gaps worth filing.**

The sub-agent, working only from the codex + schema + raw PDF,
independently derived structural choices that align with the current
production output:

- `rules.provisions`: `starting_amount: 1`, `heal_amount: 0`,
  `heal_stat: "ENDURANCE"`, `display_name: "Meals"`. Matches the
  current LW1 production file exactly.
- `attack_stat: "COMBAT SKILL"`, `health_stat: "ENDURANCE"`.
- Kai Discipline list, `choose_count: 5`, Weaponskill's `requires_roll`
  table (0-9 → weapon name).
- `character_creation.steps[]` applying Rules 11 (`roll_resource` for
  Gold Crowns) and 15 (conditional Weaponskill weapon-type roll).
- Combat Ratio Table shape + round_script skeleton.
- Rule 20 compound pickup on §267 emitted as two `add_item` events
  (canonical worked example in the rule body).
- Rule 15 Hunting exemption on eat_meal §147 via
  `condition: { not: { has_ability: "Hunting" } }`.
- Rule 17 Mindshield negation on §29 via combat_modifier with
  `condition: { not: { has_ability: "Mindshield" } }`.

No divergence on headline structural choices. The production line is
producing what a fresh independent parse against the same codex would
produce.

## Sub-agent's 10 upstream concerns — triage per concern

### Already tracked in known_issues.md (no action needed)

1. **`roll_table` char-creation action for starting-equipment R10
   table** — known_issues.md last Chat #3 bullet
   (`starting_equipment_roll step 8 data bug`). Codex v2.10 Rule 11
   acknowledges the gap. Deferred to a future codex-rule session.
2. **Discipline-driven per-combat bonuses (Mindblast +2, Weaponskill
   +2)** — codex Rule 17 closing note acknowledges the round_script
   is the enforcement path. Not a new gap; captured in rule body.

### New and worth filing in known_issues.md (this triage)

3. **Per-range `effects` on `roll_dice`.** §36 ("if 0-4, lose 2
   ENDURANCE and turn to 140; if 5-9, turn to 323") bundles a stat
   change with the failure branch. Schema v1.7's `roll_dice.results[range]`
   has only `target` and `text`. Workarounds push the damage into
   the target section's `events[]` or promote the whole resolution
   to a `script`. Neither round-trips cleanly. Schema extension
   candidate: add `effects` array to `results[range]`.
4. **`remove_inventory_category` primitive.** §188 ("the Kraan has
   ripped away your Backpack. You have lost the Pack and all the
   Equipment that was inside it") needs a single event that removes
   every item in `inventory_category: "backpack"`. `remove_item`
   is per-id. Currently expressed as a `script` with a sentinel
   flag, which the emulator doesn't natively honor. Schema + emulator
   extension candidate.
5. **Standing / global `combat_modifiers` (no-weapon -4).** LW1's
   rules state "If you enter combat with no weapons, deduct 4 points
   from your COMBAT SKILL." This is a book-wide standing rule, not
   a per-section modifier. Repeating it on every combat event is
   lossy. Schema extension candidate: `rules.combat_system.standing_modifiers[]`
   merged with per-section modifiers at combat start.
6. **Errata-footnote narrative variants.** §147's errata footnote
   says the wording assumes arrival from §28; alternate last-sentence
   and swapped choice targets apply for arrival from §42. Effectively
   a `has_flag came_from_28` gate. Codex-rule candidate: encode
   book-errata-footnote-driven narrative variants via `set_flag` at
   upstream sections + conditional text/choices downstream. Not
   blocking — the mechanics don't change — but the narrative
   fidelity is lost as currently encoded.
7. **`|| 4` fallback in `eat_meal` heal path coalesces explicit 0.**
   (Caught by main-session cross-check, not flagged by the sub-agent.)
   `cli-emulator/play.js:1729` reads
   `const heal = event.heal_amount || book.rules?.provisions?.heal_amount || 4;`
   with the same pattern at `index.html:3362`. LW1's
   `rules.provisions.heal_amount` is 0 (correct — plain Meals don't
   heal; only Laumspur does, and Laumspur grants are encoded
   per-instance). All 6 of LW1's `eat_meal` events leave
   `heal_amount` unset, so the emulator falls through to 0 →
   (falsy) → 4. Players who eat a Meal currently gain +4 ENDURANCE
   that shouldn't exist. Fix: switch to `??` (nullish coalescing)
   so explicit 0 is honored. Defensive coverage: add a unit test
   to `tests/run.js` asserting that `heal_amount: 0` on the book's
   rules yields 0 heal, not 4. Both emulators need the fix in
   lockstep.
8. **Rule 21 wording on named-consumable exceptions (Laumspur).**
   Rule 21 reads as banning `meal` / `ration` / `food` in
   `items_catalog`. Laumspur is a named herbal backpack item that
   ALSO fulfils a Meal requirement and heals 3 ENDURANCE per use.
   Keeping it in `items_catalog` is the correct encoding, but the
   rule wording doesn't explicitly carve out named magical
   consumables. Codex-rule clarification candidate: add a sentence
   distinguishing generic provisions (resource counter) from named
   magical consumables (catalog-listed, distinct name, may coexist
   with the provisions counter).

### Low priority / not worth filing now

9. **Synthetic post-combat sub-sections (e.g. §17_post).** Emulator
   convention for `win_to: "17_post"` string targets. Codex 7.6.8
   describes the return-based subroutine pattern; LW1's pattern is
   the simpler non-return one. Documentation clarification more
   than a schema change. Defer.
10. **CRT 'K' sentinel.** `combat_results_table` uses `"K"` for
    automatic kills. Sub-agent treated as `damage = 999`. A
    `damage_to_X: "kill"` string sentinel would be cleaner but the
    999-damage workaround is functional. Defer.

## Structural cross-check against current LW1 production

Spot-checked a handful of the sub-agent's structural derivations against
`books/lw_01_flight_from_the_dark.json` (main-session inspection, not
sub-agent):

| Field | Sub-agent derived | Production | Match? |
|---|---|---|---|
| `rules.attack_stat` | `"COMBAT SKILL"` | `"COMBAT SKILL"` | ✓ |
| `rules.health_stat` | `"ENDURANCE"` | `"ENDURANCE"` | ✓ |
| `rules.provisions.starting_amount` | 1 | 1 | ✓ |
| `rules.provisions.heal_amount` | 0 | 0 | ✓ |
| `rules.provisions.heal_stat` | `"ENDURANCE"` | `"ENDURANCE"` | ✓ |
| `rules.provisions.display_name` | `"Meals"` | `"Meals"` | ✓ |
| `rules.abilities.choose_count` | 5 | 5 | ✓ |
| Kai Discipline list | 10 names, Weaponskill has `requires_roll` | same | ✓ |
| character_creation uses `roll_resource` for Gold | yes | yes (iter 13) | ✓ |
| 6 `eat_meal` events, all `required: true`, `penalty_amount: -3` | yes | yes (§37, 130, 147, 184, 235, 300) | ✓ |

## Process notes

- **First probe attempt hit a stream idle timeout** during an
  attempted full-parse Write. Retried with a tighter scope
  (structural probe + 20-section sample, all inline, no writes) —
  succeeded in ~11 min wall clock. Same pattern as Chat #7 large-
  Write failures. NEXT_SESSION.md's Chat #7 process lesson on
  stream idle timeouts generalizes to Agent-tool sub-agent runs
  that end in a large final output operation — future probe prompts
  should explicitly cap output sections or avoid large terminal
  Writes.
- **Sub-agent used `pdftotext`** (available at `/usr/bin/pdftotext`)
  to extract the PDF to `/tmp/lw1.txt` before parsing. This made
  the PDF tractable without 12+ 20-page Read chunks. Worth noting
  in future probe prompts as a fast-path option when `pdftotext`
  is available.
- **Contamination check passed.** Sub-agent confirms no reads from
  the books repo's forbidden files. Its CLAUDE.md exposure came
  via system-reminder only, not via tool-use read — which matches
  the blind-probe spirit (it saw the HARD RULE but not anything
  LW1-specific from the books repo).

## Artifacts

- `REPORT.md` (this directory) — full sub-agent report preserved
  verbatim.
- `TRIAGE.md` (this file) — main-session triage summary.
- `books-repo` `known_issues.md` — updated with the 6 new upstream
  concerns above (3, 4, 5, 6, 7, 8).
