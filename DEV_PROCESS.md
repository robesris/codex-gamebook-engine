# Development Process

This document describes how to develop and maintain the Codex Gamebook Engine itself — the codex doc, the GBF schema, the reference emulators, and the books we maintain as first-party tests of the system.

It is **not** a guide for end users running the codex on their own books. End users should read `gamebook_codex_v2.md` directly. This file is for the people editing that document.

---

## ⛔ HARD RULE: NEVER HAND-EDIT MAINTAINED BOOK JSONS

Read this before doing anything else in this repo.

**Maintained book JSONs (`lw_01_*.json`, `ff01_warlock_*.json`, `grailquest_01_*.json`, `wwy_01_*.json`, `gyog06_*.json`, and any other book living in the companion private repo's `books/` directory) are PRODUCTION-LINE OUTPUTS, not source files.** They are produced by running the codex doc against source material. They are not places you open up and fix bugs by hand.

This means:

- **Never** open a book JSON in an editor and change a value because you spotted a bug.
- **Never** run a `sed`/`awk`/`jq`/Python snippet that rewrites a field in a book file.
- **Never** "migrate" a book's shape to match a new schema by hand-editing the JSON, even if the change is purely mechanical.
- **Never** populate a new schema field on an existing book by hand, even if you know what value it should have.

Every change to a book file happens the same way: you improve the production line upstream (the codex doc, the schema, the emulators), then you re-run the production line over the book via a **comprehensive-review sub-agent** (see the "Comprehensive review via sub-agent" section). The sub-agent reads the updated codex + schema + emulators, reviews the book against them, and writes fixes in place. You review the sub-agent's diff, run the regression playbooks, and commit.

**Why this rule is absolute:**

1. **Hand-patches don't compound.** Fixing a value in one book doesn't fix the rule that caused the bug, so the next book we process will reproduce the same bug. The point of the codex doc is that improvements to it benefit every book forever; hand-patching routes around that benefit entirely.
2. **Hand-patches drift from what the rules say.** Once a book has a hand-patched field, the shape of that field is no longer derivable from the codex doc. The next fresh codex run against the same source text would produce a *different* output, and the discrepancy is invisible until someone tries to reproduce it.
3. **Hand-patches are silent when the mechanism moves.** If the schema changes shape later, a hand-patched field might quietly stop making sense — there's no rule to regenerate from, so the patch becomes permanent archaeology.
4. **Hand-patches look cheap and aren't.** "It's just two lines" is exactly the sentence that produces untracked divergence between source-of-truth and output. A two-line hand-edit you forget to document is worse than a 60-line sub-agent prompt that runs once and leaves a commit trail.

**The one permitted exception** is Targeted Fix mode (Step 3a-2), which the "would a rule have prevented this?" section below describes. Targeted Fix is reserved for genuine one-offs where no general rule improvement would catch the issue — a typo in the source book that the codex correctly preserved, or a house rule so unusual that any general rule covering it would over-fit. **For first-party maintained books this should be rare.** When you do use it, document the reasoning in the commit message so future maintainers can see why we deviated.

If you're reading this rule because you're *about* to hand-edit a book, stop. Ask yourself: is the change mechanical (e.g., migrating a field to a new shape because the schema changed)? Then it belongs in the codex doc, and the sub-agent will apply it consistently across every book. Is the change judgment-heavy (e.g., deciding which items are equippable and what slot they go in)? Then it *definitely* belongs in the codex doc as a rule, and the sub-agent will apply the rule to the book using the book's own text as input. Either way, you don't touch the JSON.

This rule is repeated in abbreviated form in `CLAUDE.md` in both the public and private repos so it appears in session-start context automatically. It is not duplicated out of paranoia — it is duplicated because it has already been violated at least once by an assistant that read this doc but didn't apply the rule to its own proposed workflow, and the duplication is the corrective.

---

## What this project is, in one paragraph

The codex (`gamebook_codex_v2.md`) is a set of instructions for an AI to convert a gamebook into a structured JSON file in the GBF format defined by `codex.schema.json`. The reference emulators (`cli-emulator/play.js` for Node, `index.html` + `fengari-web.js` for the browser) are deterministic players of that JSON. The four artifacts move together: the codex tells the AI what to produce, the schema constrains what the AI can produce, and the emulators define what the AI's output actually does at runtime. Bugs can live in any of the four. The dev process below describes how to figure out where a bug lives and how to fix it without making things worse.

## The four kinds of bugs

When a bug surfaces during a playthrough, classify it before fixing it:

1. **Data bug.** A book JSON file (e.g. `lw_01_flight_from_the_dark.json`) contains an encoding that doesn't match the source book's text. Symptoms: a section is missing an event the text describes, a choice is missing a condition the text gates on, an enemy stat is wrong, a target points to the wrong section.
2. **Codex bug.** The instructions in `gamebook_codex_v2.md` are missing a rule or have an incomplete rule, so the AI produces wrong output across many books or many sections. Symptoms: the same class of data bug shows up repeatedly, or a fresh codex run on a new book reproduces a bug we've seen before.
3. **Schema bug.** The GBF schema doesn't allow the encoding the book actually needs, OR it allows an encoding the emulators can't interpret. Symptoms: the codex can't represent a real mechanic in any structured way and falls back to `custom` events; the emulator silently ignores a field.
4. **Emulator bug.** One of the emulators (CLI or HTML) doesn't correctly execute valid GBF JSON. Symptoms: an event is shown but its mechanical effect doesn't apply; a choice is offered when its condition shouldn't allow it; UI flow swallows information the player needs to see.

The first question on every bug is: **which of the four kinds is this?** A symptom in the player's view (gold went negative, item didn't show up, combat ended too fast) can be caused by any of the four. Diagnose before fixing.

## The "would a rule have prevented this?" principle

This is the single most important rule for codex maintainers, and it's encoded in the codex doc itself as Rule 16. It is the operational consequence of the top-of-file hard rule ("NEVER HAND-EDIT MAINTAINED BOOK JSONS") — the hard rule tells you what's forbidden, this section tells you what to do instead. Restating it here for our own reference:

**When a data bug shows up in a first-party book, the first question is not "how do I patch the symptom?" It is "would a new or expanded codex rule have prevented this?"**

If the answer is yes:

1. Improve the rule first. Add it to `gamebook_codex_v2.md` with a concrete example drawn from the bug, and a clear "do this, not that" formulation.
2. Bump the codex version in the doc's version history.
3. Run a comprehensive review (Step 3a-1) on the affected book against the improved codex. Use a sub-agent for this — see the "Comprehensive review via sub-agent" section below.
4. Verify the bug is fixed in the new output and that nothing regressed. Run the full playbook regression on the affected book.
5. Ship the doc change and the regenerated book in the same dev session, in lockstep.

Only fall back to Step 3a-2 (Targeted Fix) when the answer is genuinely "no, this is a one-off that no general rule would catch." For first-party books that should be rare. Targeted Fix mode exists primarily for end users, not for us.

The reasoning: hand-patching outputs is a crutch that lets the codex stay broken. The next book we process will hit the same bug because nothing improved upstream. Rule improvements compound across every future run on every book; output patches don't compound at all.

## When the answer is "no rule would have caught this"

Genuine one-offs do exist. Examples:

- The book itself has a typo or contradiction that the codex correctly preserved.
- A book's house rule is so unusual that no general pattern fits, and writing one would over-fit.
- A schema field exists but the codex didn't know to use it for this specific book's mechanic, and the mechanic is unique enough that no general rule would change.

For these, Targeted Fix is appropriate — but document the reasoning in the commit message so future maintainers can see why we deviated from the rule-improvement default.

## The schema is also a production line

The same principle applies when a bug is a schema bug (kind 3 above). If the codex can't represent a real mechanic structurally, the fix is to extend the schema, then re-run the codex against the improved schema. Don't paper over schema gaps by encoding the mechanic as `custom` events or as narrative-only descriptions in the section text.

Schema changes should be additive whenever possible (new optional fields, new enum members) so existing books remain valid. Breaking changes to the schema bump the GBF format version in the schema's `title` field and require all maintained books to be re-run through the codex against the new schema.

## Series-agnostic design

This is a corollary of the schema-is-a-production-line principle, and it is the most important architectural rule to internalize. **Put mechanisms in the schema, the codex rules, and the emulators; put specifics in the data.**

The schema, the codex general rules, and both reference emulators must be series-neutral. What this means concretely:

- **No per-mechanic convenience fields in the schema.** Never add `rules.provisions.exempt_when`, `rules.magic.spell_book_required`, `rules.stat_tests.class_exemption`, or any similar field whose purpose is "make a specific series' rule easier to encode." Every such field narrows the codex to one series' vocabulary and creates schema sprawl as new series bring new patterns. Instead, extend the general mechanism (event-level conditions, combat modifiers, rules blocks that use generic primitives) and let the book's data name the specific ability, item, flag, or class the rule depends on.
- **No per-series enum values or per-series branches in the emulators.** If you find yourself writing `if (series === 'lone_wolf')` or adding a `lone_wolf_combat_ratio_table` enum member to a field, stop. The emulator should drive all behavior from data (the book's `rules` block, its `combat_system.round_script`, its `combat_modifiers` blocks, etc.) not from the series tag. The series name in `metadata.series` is for display and for the codex's own series-profile lookup, never for code dispatch in the emulator.
- **Specifics live in the data, not the mechanism.** A Lone Wolf book's data contains "Hunting" as a string value in a condition — the schema doesn't know the word "Hunting." A Fighting Fantasy book's data contains "SKILL" as a stat name — the schema's `attack_stat` field doesn't default to "SKILL," it reads whatever the book says. If you're tempted to hardcode a specific discipline name, stat name, or game term into the schema or emulator, you're doing it wrong.

**The unsupported-series test.** When designing any new field, rule, or emulator feature, ask: *"if someone runs the codex on a series we've never heard of — Way of the Tiger, Cretan Chronicles, Blood Sword, Fabled Lands, Star Challenge, GrailQuest, Sagard the Barbarian — does this mechanism still work?"* If the answer depends on adding a new series profile, a new schema field, or a new enum member before the new series can be parsed, the mechanism is too narrow. Fix the mechanism so it works for unknown series by default, then add the profile as an optional optimization.

**Where it's fine to mention series by name.** In codex doc rule *examples* (to illustrate), in series profiles (Sections 3–7 of the codex doc, which are convenience pre-loads of well-known series), and in field description examples in the schema (where citing "e.g. Gold Crowns (LW), Gold Pieces (FF), Credits (sci-fi)" helps the reader understand the field's range). Where it's not fine: in the mechanism itself, in the emulator code paths, or in schema field names and required-field lists.

**Series profiles are optimizations, not preconditions.** Sections 3–7 of `gamebook_codex_v2.md` pre-load knowledge about well-known series (LW's Combat Ratio Table, FF's 2d6 combat, AD&D's percentile rolls, etc.) so the codex doesn't re-derive them from scratch on every run. They are valuable and we should keep adding to them as we support new series. But **a codex run on an unprofiled series must still produce a correct, playable GBF JSON using only the general rules and the "Unknown/Other Series" handler (Section 7).** The quality gap between profiled and unprofiled series should be small — measured in percentage points of rule-catching, not in "works vs. doesn't work."

**Accountability: the unprofiled-series stress test.** Periodically — and especially after adding any new schema field, rule, or emulator mechanism — run the codex on a gamebook from a series we don't have a profile for, in a scoped sub-agent. Compare the result against what we'd expect from the general rules. If anything breaks, if the codex gets stuck on a mechanic it can't represent, if the sub-agent ends up writing "the book uses Lone Wolf's COMBAT SKILL" when it should be using the book's actual stat name, those are bugs in the general machinery. Fix them before declaring the new feature done. The stress test is how we verify that generality claims are real.

## The emulators are not a production line

Emulator bugs (kind 4 above) are the one case where it's appropriate to fix the symptom directly. The emulators are imperative code, not derived output — they have no upstream "production line" to improve. When you find an emulator bug, fix it in the emulator code, add a regression test if practical, and ship.

Both emulators (CLI and HTML) implement the same GBF spec independently. When fixing a bug in one, audit the other for the same bug. They're not allowed to drift.

## Tier ordering for fixes

When working through a backlog of bugs, prioritize in this order:

1. **Codex doc improvements** (when a rule was missing). These are cheap and unblock the most.
2. **Comprehensive re-runs** of affected books against the improved codex. The expensive but high-value step.
3. **Schema additions** (when a field was missing or insufficient). These usually require a codex doc update too, so bundle.
4. **Emulator fixes** for genuine emulator bugs.
5. **Targeted fixes** as the last resort, only for true one-offs.
6. **Cosmetic / deferrable** changes (naming conventions, idiomatic display labels, etc.) — only when they're not blocking anything.

A good dev session typically lands 1–3 bullet points from this list. Don't try to do all six in one session — they're separate kinds of work and conflict with each other.

## Comprehensive review via sub-agent

The Step 3a-1 workflow on a 350–400-section book is roughly a 20–30 minute, 1M+ token job. Doing it inline in a normal session would consume the whole budget on one task, so we delegate it to a sub-agent.

The pattern that has worked:

1. Make the codex doc improvements first, in the main session. Commit and push.
2. Spawn a sub-agent (`general-purpose` type, run in background) with a self-contained prompt that:
   - Points at the updated codex doc (with the new rules)
   - Points at the schema, the emulator files, the book being reviewed, the walkthrough (if available), the existing playbook scripts, and the `known_issues.md` file
   - Tells it to operate at Tier 3 (Thorough)
   - Tells it to write fixes in place to the book file
   - Tells it explicitly NOT to commit or push (the user reviews the diff before commit)
   - Tells it to use the parser-driven workflow (Rule 7) and not echo narrative into its own output (Rule 6) — this avoids the cumulative-context classifier trip
   - Tells it to produce a structured report under N words at the end
3. Continue with other work in the main session while the sub-agent runs. The notification system will tell you when it finishes.
4. When the sub-agent reports back, review its diff, run the regression yourself to spot-check, and commit.

A good sub-agent prompt for this is ~60 lines and very explicit about scope, safety rules, output destination, and reporting format. Examples in the repo's `claude/` branches show the shape.

## Playbook regression harness

Each first-party book has a set of `*.script` playbooks under `plans/playthroughs/` (gitignored — these live on disk only) that exercise different paths through the book. The naming convention is:

- `<book>_probe.script` — a coverage probe using `manual_set` to navigate into every section and verify no errors. The cheapest and highest-value structural test.
- `<book>_smoke.script` — a tiny ~10-line script that boots the book, runs character creation, and walks a few sections.
- `<book>_runN.script` — full playthroughs from character creation to an ending, taking different branches.
- `<book>_<section>_smoke.script` — focused smoke for a specific tricky section.

The full regression after a fix is: run every `<book>_*` playbook for the affected book and verify all of them pass with 0 errors. If any regressed, the fix is incomplete. Don't commit a fix that breaks an existing playbook — either fix the playbook (if its expectation was wrong) or fix the book (if the encoding regressed).

The playbooks are deliberately gitignored. They're project-specific dev artifacts and contain section refs that depend on the current state of each book's iter-N. When the book changes, the playbooks change with it. Putting them in version control would create constant churn for no benefit since they're not consumed by anyone outside this project.

## What lives in the public repo vs. the private repo

This is a public repo. It contains:

- The codex doc (`gamebook_codex_v2.md`)
- The schema (`codex.schema.json`)
- The reference emulators (`cli-emulator/`, `index.html`, `fengari-web.js`)
- The CLI emulator's pinned dependencies (`package.json`, `package-lock.json`)
- This dev process doc (`DEV_PROCESS.md`)
- The schema validation test fixtures, if any

It does NOT contain:

- Any book JSON files (those are copyrighted source material derivatives — see the private companion repo)
- Walkthroughs (also third-party material)
- Playbook scripts (project-specific dev artifacts)
- Session logs or development notes

The companion private repo holds the book JSONs, walkthroughs, and any source material we have rights to use in development. The public repo never references absolute paths in the private repo — everything is set up via local symlinks per the README.

## What's tracked vs. what's local-only

| Lives in public git | Lives in private git | Local-only (gitignored) |
|---|---|---|
| codex doc, schema, emulators, package.json, DEV_PROCESS.md | book JSONs, walkthroughs, known_issues.md | playbook scripts, dev session logs, scratch parsers, transient notes |

When in doubt: if it changes constantly and is project-specific, it's local-only. If it's the source of truth for the AI/codex/schema/emulators, it's public. If it's copyrighted source material or its derivative, it's private.

## Commit hygiene

- Commits go on branch `claude/continue-gamebook-conversion-6moom` (the long-running feature branch) and merge to `main` when promoted.
- Commit messages should be specific about the WHY, not just the WHAT. "Fix LW 315 loot" is bad; "Add Rule 12 to prevent duplicate penalty events that double-count eat_meal losses" is good.
- Reference the codex version in commit messages when bumping it ("Codex v2.2: …").
- Don't squash unrelated changes into one commit. The commit log is the dev history; keep it readable.
- Don't commit book JSONs to the public repo. CLAUDE.md has the rule.
- Don't commit `package.json` / `package-lock.json` for the private repo if it has its own; only the public repo's package.json is tracked there.

## Versioning

Three independent version numbers:

- **Codex version** (currently 2.7): bumped when `gamebook_codex_v2.md` changes meaningfully. Tracked in the doc's title, header, and version history block.
- **GBF format version** (currently 1.4.0): bumped when the schema changes in a way that affects output structure. Additive changes bump the minor version; breaking changes bump the major. Tracked in the schema's `title` field.
- **Emulator versions** (currently 2.5.0 for both CLI and HTML): bumped when the emulator gains a feature or fixes a meaningful bug. Tracked in `CODEX_EMULATOR_VERSION` constants.

These are intentionally independent. A codex doc change that doesn't affect the schema or emulators bumps only the codex version. A schema addition that requires emulator support bumps the schema (if breaking), the emulators, and the codex doc together.

## Resolved architectural questions

These were previously listed as open questions waiting for design decisions. All three have been resolved.

1. **~~Combat `special_rules` mechanical enforcement.~~** ✅ Resolved in codex v2.7 / schema v1.4.0 / emulators v2.5.0. The structured `combat_modifiers` sub-object on combat events + `intrinsic_modifiers` on enemies_catalog entries was the chosen approach (Option A from the original discussion). Modifiers use generic dot-path targets (`player.attack`, `player.hit_threshold`, `enemy.armor`, etc.) so they work on any combat system including threshold-based systems with `attack_stat: null`. Conditions are evaluated once at combat start and frozen for the fight's duration. See codex doc Rule 17 for the full specification. Per-book data passes to populate the structured modifiers on existing books are tracked as follow-up iterations (LW iter 9, Warlock iter 7, GrailQuest iter 2).

2. **~~Event-level conditions on the schema.~~** ✅ Resolved in codex v2.4 / schema v1.2.0 / emulators v2.3.0. Every event type now supports an optional `condition` field with the same union as choice conditions. The canonical first use was Lone Wolf's Hunting-exempts-Meals rule (condition on `eat_meal` events). See codex doc Rule 15 for the full specification. Applied to the LW book in iter 8.

3. **~~Ability immunity / damage scaling / equipment framework.~~** ✅ Resolved together in codex v2.8 / schema v1.5.0 / emulators v3.0.0. The originally scoped "ability immunity" question was reframed when we realized that immunities, resistances, and weaknesses are the same concept under different multipliers, and that a more general mechanism (damage_interactions with source-tag filters) covers the whole family while also handling weapon-property-based rules like Lone Wolf 2's Helghast ("only silvered weapons harm them"). The equipment framework (equippable / slot / equip_timing / auto_equip) ships in the same session because gating a damage_interaction on "does the player have a silver weapon" is meaningless without a proper concept of which carried weapon is currently active, and that concept is itself a general RPG mechanic that every series needs. Rule 18 (damage_interactions) and Rule 19 (equipment framework) in the codex doc specify the full mechanism. The round_script contract changes in the same version: scripts now report damage via `combat.damage_to_enemy` / `combat.damage_to_player` instead of mutating `*.health` directly, so the emulator can apply interaction multipliers to each damage component before subtracting from health. This is a breaking change for v3.0.0 emulators; the three maintained books (LW1, Warlock, GrailQuest) were migrated in lockstep via comprehensive-review sub-agents in the same session. **Canonical source for LW's one-weapon-at-a-time rule:** the Mongoose Publishing reprint of *Flight from the Dark* includes Footnote 1, which states *"The new Mongoose Publishing editions of the gamebooks clarify that 'You may only use one Weapon at a time in combat.'"* This is a published errata clarification, not an inference, and is why LW equipment uses `equip_timing: "out_of_combat"` with a single `weapon` slot. The narrower "ability-bonus suppression" sub-case (e.g., Mindblast suppression on enemies immune to psychic attacks) is still handled imperatively inside the round_script — it's a legitimately narrower scope than damage_interactions and does not have a second use case to justify a dedicated schema field yet; see Rule 17's closing notes for the current handling and the trigger for reopening it.

## Open architectural questions

1. **Lua runtime migration.** Currently using Fengari (unmaintained but stable, pinned at 0.1.5). [wasmoon](https://github.com/ceifa/wasmoon) is the maintained alternative. Documented in the codex doc as a back-burner option. Not blocking any current work.

When attacking any of these, the fix is a multi-part change spanning the doc, schema, and both emulators. Plan a dedicated session, not a drive-by.
