# LW1 Fresh-Parse Probe — Sub-agent Report Excerpts

**Date:** 2026-04-17 (Chat #8)
**Full triage and verdict:** see `TRIAGE.md` in this directory.

This file preserves the sub-agent's key structural inline JSON snippets
and a representative sample of section encodings, excerpted from the
sub-agent's final report. The full verbatim report is not persisted
here (the Chat #7 large-Write timeout lesson generalizes to
transcribing 30 KB of report content via Edit/Write). The full
transcript lives in the Chat #8 session log.

## Section A — structural choices as the sub-agent derived them

### A.1 metadata (key fields)

```json
{
  "title": "Flight from the Dark",
  "series": "Lone Wolf",
  "series_number": 1,
  "author": "Joe Dever",
  "illustrator": "Gary Chalk",
  "publisher": "Project Aon (Internet Edition)",
  "year": 2010,
  "series_profile": "lone_wolf",
  "total_sections": 350,
  "dice_type": "R10",
  "codex_version": "2.10.0"
}
```

### A.2 rules (provisions / attack+health / abilities skeleton)

```json
{
  "attack_stat": "COMBAT SKILL",
  "health_stat": "ENDURANCE",
  "provisions": {
    "enabled": true,
    "starting_amount": 1,
    "heal_amount": 0,
    "heal_stat": "ENDURANCE",
    "when_usable": "when_instructed",
    "display_name": "Meals"
  },
  "abilities": {
    "enabled": true,
    "choose_count": 5,
    "available": [
      "Camouflage", "Hunting", "Sixth Sense", "Tracking",
      "Healing", "Weaponskill", "Mindshield", "Mindblast",
      "Animal Kinship", "Mind Over Matter"
    ]
  }
}
```

Note: sub-agent emitted the full Combat Ratio Table (13 ratio buckets
× 10 R10 values) inline. Not reproduced here; the table is
reference-book material and the current production encoding is already
sound against it.

### A.3 character_creation — key step shapes

- `roll_stat stat:"COMBAT SKILL" formula:"R10+10"`
- `roll_stat stat:"ENDURANCE" formula:"R10+20"`
- `choose_abilities count: 5, from: "abilities_list"`
- `roll_stat stat:"weaponskill_weapon_index" formula:"R10"`
  **with `condition: { has_ability: "Weaponskill" }`** (Rule 15)
- `add_item item:"axe"`
- `add_item item:"map_of_sommerlund"`
- `roll_resource resource:"gold" formula:"R10"` (Rule 11)
- `set_resource resource:"provisions" amount:1` (or omitted — auto-init
  via `rules.provisions.starting_amount` per Rule 21)
- `roll_stat stat:"starting_equipment_roll_index" formula:"R10"`
  — **flagged: this is the `roll_table` gap (Rule 11 acknowledges)**

## Representative section samples (selected)

### §147 — eat_meal with Hunting exemption (Rule 15)

```json
{
  "events": [{
    "type": "eat_meal",
    "required": true,
    "penalty_stat": "ENDURANCE",
    "penalty_amount": -3,
    "condition": { "type": "not", "condition": { "type": "has_ability", "ability": "Hunting" } }
  }]
}
```

### §267 — compound pickup (Rule 20 canonical example)

```json
{
  "events": [
    { "type": "add_item", "item": "message_animal_skin", "optional": true },
    { "type": "add_item", "item": "dagger", "optional": true }
  ]
}
```

### §29 — combat with Mindshield-gated modifier (Rule 17)

```json
{
  "events": [{
    "type": "combat",
    "combat_modifiers": [{
      "target": "player.attack", "delta": -2,
      "reason": "Vordak Mindforce attack (negated by Mindshield)",
      "condition": { "type": "not", "condition": { "type": "has_ability", "ability": "Mindshield" } }
    }]
  }]
}
```

### §55 — combat with `duration: "fight"` modifier

```json
{
  "events": [{
    "type": "combat",
    "combat_modifiers": [
      { "target": "player.attack", "delta": 4, "reason": "Surprise attack", "duration": "fight" }
    ]
  }]
}
```

### §236 — permanent modify_initial + remove_item

```json
{
  "events": [
    { "type": "remove_item", "item": "vordak_gem" },
    { "type": "modify_stat", "stat": "ENDURANCE", "amount": -6 },
    { "type": "modify_stat", "stat": "COMBAT SKILL", "amount": -1, "modify_initial": true }
  ]
}
```

Remaining 15 sections (§1, §5, §17, §36, §21, §19, §12, §9, §113,
§188, §20, §15, §133, §292, §350, §121) followed the same shape
patterns — choice-heavy navigation, stat_test-equivalent `roll_dice`,
`script` for sequential-dependent rolls, `is_ending: true` with
`ending_type: "death"` / `"continuation"` as appropriate.

## Sections covered by the sub-agent's 10 upstream concerns

See `TRIAGE.md` for main-session decisions per concern. The sub-agent
cited specific LW1 sections for most concerns:

- §36 → per-range `effects` on `roll_dice` (new schema gap).
- §188 → `remove_inventory_category` primitive (new schema/emulator gap).
- §17 → synthetic post-combat sub-section convention (doc gap; defer).
- §147 → errata footnote narrative variants (new codex-rule gap).
- §113 → Laumspur / named-consumable Rule 21 exception (new codex-rule
  wording candidate).
- §55 / §133 / §17 / §29 → combat modifier duration + Mindblast
  immunity + no-weapon penalty (part new, part existing rule-body
  acknowledgements).

## Contamination check

Sub-agent confirmed zero reads from the books repo's forbidden files.
CLAUDE.md exposure was via system-reminder only, not via tool-use read.
Zero file writes. `pdftotext` was used to extract `/tmp/lw1.txt` from
the raw PDF — a local side effect, not a write to any tracked
location.
