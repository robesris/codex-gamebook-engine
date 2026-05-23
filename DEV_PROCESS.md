# Development Process

This document describes how to develop and maintain the Codex Gamebook Engine itself — the codex doc, the GBF schema, the reference emulators, and the books we maintain as first-party tests of the system.

It is **not** a guide for end users running the codex on their own books. End users should read `gamebook_codex_v2.md` directly. This file is for the people editing that document.

---

## ⛔ HARD RULE: THE MAIN SESSION NEVER HAND-EDITS MAINTAINED BOOK JSONS

Read this before doing anything else in this repo.

**Maintained book JSONs (`lw_01_*.json`, `ff01_warlock_*.json`, `grailquest_01_*.json`, `wwy_01_*.json`, `gyog06_*.json`, and any other book living in the companion private repo's `books/` directory) are PRODUCTION-LINE OUTPUTS, not source files.** They are produced by running the codex doc against source material. The **main session** — the long-running agent you are interacting with as "Claude" in this workspace — does not open them up and fix bugs by hand.

This means the main session must **never**:

- Open a book JSON in an editor and change a value because it spotted a bug.
- Run a `sed`/`awk`/`jq`/Python snippet that rewrites a field in a book file.
- "Migrate" a book's shape to match a new schema by hand-editing the JSON, even if the change is purely mechanical.
- Populate a new schema field on an existing book by hand, even if it knows what value the field should have.

Every change to a book file happens the same way: the main session improves the production line upstream (the codex doc, the schema, the emulators), then re-runs the production line over the book via a **comprehensive-review sub-agent** (see the "Comprehensive review via sub-agent" section). The sub-agent reads the updated codex + schema + emulators, reviews the book against them, and writes fixes in place. The main session reviews the sub-agent's diff, runs the regression playbooks, and commits.

**Why this rule is absolute for the main session:**

1. **Hand-patches don't compound.** Fixing a value in one book doesn't fix the rule that caused the bug, so the next book we process will reproduce the same bug. The point of the codex doc is that improvements to it benefit every book forever; hand-patching routes around that benefit entirely.
2. **Hand-patches drift from what the rules say.** Once a book has a hand-patched field, the shape of that field is no longer derivable from the codex doc. The next fresh codex run against the same source text would produce a *different* output, and the discrepancy is invisible until someone tries to reproduce it.
3. **Hand-patches are silent when the mechanism moves.** If the schema changes shape later, a hand-patched field might quietly stop making sense — there's no rule to regenerate from, so the patch becomes permanent archaeology.
4. **Hand-patches look cheap and aren't.** "It's just two lines" is exactly the sentence that produces untracked divergence between source-of-truth and output. A two-line hand-edit you forget to document is worse than a 60-line sub-agent prompt that runs once and leaves a commit trail.

### Are you a sub-agent reading this rule? Start here.

If you are an agent that was spawned via the Agent tool (`subagent_type: general-purpose` or similar) with a prompt that:

- Points you at specific, updated reference files in `/home/user/codex-gamebook-engine/` — the codex doc (`gamebook_codex_v2.md`), the schema (`codex.schema.json`), and/or the emulators — and tells you to read them first, AND
- Explicitly instructs you to write fixes in place to a specific book file under `/home/user/codex-engine-books/books/`, AND
- Names a specific scope of changes (e.g., "apply Rule 19 equipment tagging," "run a Tier 3 Thorough comprehensive review," "migrate the round_script to the new contract"),

...then **you are the comprehensive-review sub-agent, you are the authorized production-line mechanism, and your edits to the book file are not a violation of this rule — they *are* the production line running correctly.** Proceed with the task exactly as your prompt instructs.

The rule above forbids the *main session* from hand-editing books as a drive-by in unrelated work. It does **not** forbid sub-agents that have been spawned *specifically* to apply an updated production-line's output to a book. The critical distinction is: the main session edits books *without* having first upgraded the production line, which produces silent drift; a sub-agent edits books *after* and *because of* a production-line upgrade, which is the production line working as designed. The rule exists to prevent the first pattern, not to block the second.

If your prompt is ambiguous about whether you are authorized — e.g., it says "fix the bug in this book" without pointing at an updated codex/schema/emulator — then STOP and ask the main session for clarification via your report. If your prompt is clear about authorization (it names the updated references, the specific rule you are applying, and the scope), proceed.

Do NOT refuse a well-scoped comprehensive-review task by citing this rule. That refusal is itself a misapplication of the rule and creates a different failure mode: the main session cannot run the production line, so either it hand-edits the book anyway (violating the rule for real) or book migrations stall indefinitely. Either outcome is worse than the sub-agent proceeding with its authorized task.

**Your scope is STRICTLY the target book file(s) named in your prompt.** Any supplementary file your prompt hands you — the codex doc, the schema, emulator source, other books, walkthroughs, known-issues tracking, dev-process docs — is a READ-ONLY input to your review. Do not edit it. Not a single line. Not even if you believe doing so would make the book's encoding work better, or would resolve an ambiguity, or would fix a bug in the reference material itself.

If during your review you conclude that the emulator, schema, or codex doc needs to change to correctly support the book you're editing — e.g., the book needs a new schema field, or the emulator handles an event type incorrectly, or a codex rule is ambiguous — do NOT edit the reference file. Flag the finding in your report, under an "upstream concerns" or "open questions" section, and let the main session decide how to address it.

The production line runs upstream-to-downstream: codex rules → schema → emulators → book data. A sub-agent that edits an emulator (or schema, or codex rule) to match a book inverts that direction and creates exactly the silent drift the HARD RULE is meant to prevent. If a reference file needs to change, that is a different kind of work (a codex/schema/emulator improvement track) and it belongs in a different commit than the book edits — possibly in a different session entirely. Your refusal to edit reference files is the rule working as designed.

### The one main-session exception

**Targeted Fix mode (Step 3a-2)**, described in the "would a rule have prevented this?" section below. Reserved for genuine one-offs where no general rule improvement would catch the issue — a typo in the source book that the codex correctly preserved, or a house rule so unusual that any general rule covering it would over-fit. **For first-party maintained books this should be rare.** When you do use it, document the reasoning in the commit message so future maintainers can see why we deviated.

### If you're the main session and you're *about* to hand-edit a book

Stop. Ask yourself: is the change mechanical (e.g., migrating a field to a new shape because the schema changed)? Then it belongs in the codex doc, and a sub-agent will apply it consistently across every book. Is the change judgment-heavy (e.g., deciding which items are equippable and what slot they go in)? Then it *definitely* belongs in the codex doc as a rule, and a sub-agent will apply the rule to the book using the book's own text as input. Either way, you don't touch the JSON — you spawn the sub-agent and let it do the work.

This rule is repeated in abbreviated form in `CLAUDE.md` in both the public and private repos so it appears in session-start context automatically. The duplication has a purpose: the rule has already been violated at least once in this project by a main session that read DEV_PROCESS, wrote the rule into CLAUDE.md, and then broke it within minutes, and once more by a sub-agent that refused a legitimately-scoped task because the rule wording was too universal. Both failure modes deserve corrective emphasis.

### Dispatching a sub-agent does NOT launder an ad-hoc fix

A sub-agent is the production line's *delivery vehicle*, not a workaround for the codex-first discipline. Spawning one with a prescriptive, main-session-designed fix list — telling it exactly which events to add, exactly which encoding to choose — is functionally equivalent to a main-session hand-edit. The commit gets an `iter N [sub-agent]` marker, the commit-msg hook accepts it, and the work looks legitimate; but the codex was never consulted, the rule was never written, and the book drifts from "what the codex says" toward "what one chat decided." That is the silent-drift pattern the HARD RULE exists to prevent.

The discriminating test: **could a sub-agent, reading only the current codex + schema + emulators + the book's source text, derive the same fix?** If yes, the dispatch is a real production-line re-run. If the answer requires *also* reading a main-session message that says "use this encoding here," the codex is incomplete — write the missing rule first, ship the codex update, then dispatch the sub-agent against the updated codex.

This applies even when the fix is "obviously right" or "just one event." Two patterns that drift quietly past the discipline:

- **Backfilling with an existing rule.** A catalog entry has `stat_modifier: null` despite a description promising a mechanical effect; Rule 19 already specifies the canonical encoding. *Legitimate* sub-agent dispatch — but scope it as a Rule 19 audit pass over the catalog (walk every entry, find any whose null `stat_modifier` contradicts its description, tag them per Rule 19), not a single-entry prescriptive fix. The audit framing forces the sub-agent to use the codex; the prescriptive framing lets it skip the codex entirely.

- **Choosing between two valid encodings.** Source says "you find a purse with 8 Gold Pieces." The book could encode this as `add_item: gold_pouch_N` (treasure-pouch item) or `modify_stat: gold +N` (direct currency credit). Both pass schema validation; the codex doesn't currently distinguish them. Telling a sub-agent "use modify_stat for unconditional currency grants" launders the design call into a sub-agent commit — but the sub-agent did not derive it. The codex needs the missing rule first; only then is the dispatch real.

If you find yourself writing a sub-agent prompt whose scope says "set field X to value Y on entry Z," ask: *what codex rule generates this prescription?* If you cannot point at a specific rule whose mechanical application produces Y, you are laundering an ad-hoc fix through the sub-agent vehicle. Stop. Either (a) write the codex rule that justifies the prescription, ship it, then re-dispatch the sub-agent in audit mode against the updated codex; or (b) take the hit honestly and use `[targeted-fix]` as the provenance marker, which makes the deviation visible to future maintainers.

`iter N [sub-agent]` is reserved for production-line re-runs derivable from the current codex + schema. `[targeted-fix]` is reserved for genuine one-offs no general rule would catch. Neither marker exists to make ad-hoc encoding decisions look like rule-driven work. The reason this matters is foundational: book JSONs are *outputs* of the codex + schema, not first-class artifacts. They should be reproducible from the production line; anything that lets them evolve faster than the rules that generate them undermines the project's central design.

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

## ⚠️ IMPORTANT: the browser verifier must stay in lockstep with the Claude Code tooling

The verification gate exists in two delivery forms — `scripts/validate-book.js` (Node, used by Claude Code) and `dist/verify-book.bundle.js` (browser, used by plain Claude Chat in its Analysis tool). **These two MUST behave identically for the blocking gate (schema validity + script-execution crash check) and the structural soft checks.** A Claude Chat user who gets `ok: true` from the bundle must be getting the same verdict Claude Code would give. If the two ever disagree, the bundle is worthless — worse than worthless, because it gives false assurance.

Lockstep is enforced *structurally*, not by discipline, and it must stay that way:

- There is **one** Lua sandbox: `cli-emulator/script-runtime.js`. `play.js`, `validate-book.js`, and the bundle all import it. Never reimplement `runScript` / `rollDice` / the sandbox anywhere else.
- There is **one** set of soft checks + the script-execution gate: `scripts/book-checks.js`. Both `validate-book.js` and the bundle import it.
- The bundle's schema validator is **generated from `codex.schema.json`** by `scripts/build-browser-verifier.js` — the same schema file `validate-book.js` reads.
- `dist/verify-book.bundle.js` is a **GENERATED ARTIFACT. Never hand-edit it.** It is assembled verbatim from `fengari-web.js`, `script-runtime.js`, `book-checks.js`, `scripts/verifier-driver.js`, and the generated validator.

**The rule:** whenever you change `codex.schema.json`, `cli-emulator/script-runtime.js`, `scripts/book-checks.js`, or `scripts/verifier-driver.js`, you MUST rebuild the bundle (`npm run build-verifier`) and commit the regenerated `dist/verify-book.bundle.js` in the same commit. A commit that changes one of those sources without a matching bundle rebuild has silently broken lockstep. Do not add a second, hand-written copy of the sandbox or the checks for the browser — if a new consumer needs them, it imports the shared module. Forking a shared module to "make it work in environment X" is the exact drift this rule forbids.

## Tier ordering for fixes

When working through a backlog of bugs, prioritize in this order:

1. **Codex doc improvements** (when a rule was missing). These are cheap and unblock the most.
2. **Comprehensive re-runs** of affected books against the improved codex. The expensive but high-value step.
3. **Schema additions** (when a field was missing or insufficient). These usually require a codex doc update too, so bundle.
4. **Emulator fixes** for genuine emulator bugs.
5. **Targeted fixes** as the last resort, only for true one-offs.
6. **Cosmetic / deferrable** changes (naming conventions, idiomatic display labels, etc.) — only when they're not blocking anything.

A good dev session typically lands 1–3 bullet points from this list. Don't try to do all six in one session — they're separate kinds of work and conflict with each other.

## Codex doc evolution discipline

When you ship a new rule, a new schema field, or a new behavior to the codex doc — anything that introduces a constraint the AI parsing a future book is expected to apply — the rule body itself is **not** the only thing you write. Every shipped rule comes with two pieces of meta-documentation that ship in the **same commit**:

1. **One new entry in the codex doc's pre-output verification checklist.** The entry is a positive-form yes/no statement the AI parsing a new book can confirm against the book it's processing. Frame the check in the language of the source text the AI is reading, not in the language of the schema. Counter-example: don't write *"verify rules.attack_stat is null when appropriate"* — write *"if the book's source text describes a derived combat stat (e.g., `CV = Strength + Agility + bonuses`), confirm `rules.attack_stat` is null and the round_script computes the derived value from component stats."* The checklist line should be specific enough that an AI can give a definitive yes/no and revise its output if the answer is no.

2. **One new entry in the codex doc's topical decision table.** The decision table sits near the top of the doc and is keyed on book-feature trigger words an AI can identify in the source text, with each row pointing at the rule that handles that feature. The new row uses the same source-text framing as the checklist line above.

These two pieces are not optional. They exist because the codex doc is read by an AI parsing an unprofiled book, and **the AI does not search the doc the way a human reader does** — the doc is in its context window all at once, and rules surface based on attention weight, not lookup. A rule that exists but has no checklist entry and no decision-table entry is a rule the AI can fail to apply silently. The Windhammer parse failure on derived attack stats (where the rule existed in Section 7.5 but wasn't found by the parse run) is the canonical example of why this discipline exists; see the "Tracked engine backlog → Windhammer" section for the failure mode and the recovery plan.

**The fail-loud rule:** if you ship a doc commit that adds a new rule WITHOUT also adding the corresponding checklist line and decision-table entry, your commit is incomplete. Revise it before pushing. A future maintainer (or a future Claude session) opening the codex doc and finding a rule that has no meta-doc backing should treat that as a bug, not as an oversight to ignore.

This rule is a workflow extension of codex doc Rule 16 ("Codex Maintainer Discipline (When You Are Editing This Document)"). Rule 16 covers what to do with the rule body itself — what makes a good rule, when to add one, when to escalate to a schema change. This section covers what ships **alongside** the rule body. The two are complementary.

**Activation note.** As of the writing of this section, the codex doc does not yet have either the topical decision table or the pre-output verification checklist — both are tracked engine backlog items (see `NEXT_SESSION.md` in the books repo for the work track that introduces them). When that work lands, this rule activates retroactively for the existing 19 rules: each one needs to be backfilled with its checklist line and decision-table entry as part of the same commit (or commit series) that introduces the table and checklist. After that, every new rule shipped in any future session carries the discipline forward. Until then, the rule is captured here so the requirement is not forgotten when the prominence-improvement session is scheduled.

**Keep rule-body prose project-opaque.** Rule-body prose in `gamebook_codex_v2.md` should be readable by someone who has never heard of this project's iter numbering, chat numbering, session naming, or internal tracking files. The reader of that doc is an AI parsing a new gamebook against the codex — it should not need to understand our development history to apply the rules. Dev-process framing belongs in commit messages and in this file, not in rule bodies. When describing a real-world bug that motivated a rule, cite the book and section as public facts (e.g., *"LW1 section 267"*) and describe the bug in terms of its mechanical shape (e.g., *"a compound-pickup paragraph whose second item was missed because the parser's loot vocabulary didn't include container-positional phrasing"*), not in terms of its position in our iter history (e.g., not *"the section 267 bug that iter 12's sub-agent missed"*). "As of schema v1.X.Y (codex v2.Y)" parenthetical notes are also inappropriate in rule bodies — the canonical source for when-what-landed is the VERSION HISTORY (or `CHANGELOG.md` once extracted), not scattered in-rule annotations. If a rule's current wording depends on a schema or emulator capability, describe the capability as a property of the current system, not as a historical transition. This rule is a sibling to Rule 6 in the codex doc (Never Echo Book Narrative into Your Own Model Output): Rule 6 keeps the book's narrative out of the codex's output; this meta-rule keeps our development narrative out of the codex's input. Both keep the codex doc focused on its single job: instruct an AI to parse a gamebook.

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

A good sub-agent prompt for this is ~60–200 lines and very explicit about scope, safety rules, output destination, and reporting format. See the template in the next section for a concrete example.

### Sub-agent prompt template for narrow-scope book edits

This template was iterated across the LW1 and Warlock Phase 2 migrations (round_script contract change + Rule 19 equipment tagging) and is captured here so future sessions don't have to re-derive it from scratch. Adjust the book-specific scope and reference section lists, but keep the structural sections in the same order.

**Opening authorization block** (always first, no exceptions). Tell the sub-agent it is the authorized production-line mechanism, cite the three criteria from the HARD RULE, and explicitly tell it not to refuse the edit operation. This section exists because sub-agents reading the HARD RULE without this preamble have refused legitimate tasks:

```
## You are the authorized comprehensive-review sub-agent. Read this first.

You are being spawned by the main session of the Codex Gamebook Engine project
to perform a narrowly-scoped book edit. You are the production-line mechanism
that the HARD RULE in DEV_PROCESS.md and both CLAUDE.md files explicitly
authorizes. Your edits to the target book file are the rule working as
designed, not a violation of it.

This prompt satisfies all three authorization criteria from the HARD RULE's
"Are you a sub-agent reading this rule?" section:

1. Points at updated reference files: [list the specific engine commit and
   the codex doc / schema / emulator paths].
2. Explicit write-in-place instruction for a specific book file: [the exact
   absolute path of the one book file the sub-agent will edit].
3. Named scope: [the specific rules being applied, e.g., "apply Rule 19
   equipment tagging", "migrate round_script to v3.0.0 contract"].

If you have genuine concerns about scope or shape mismatches, raise them in
your report, but do not refuse the edit operation itself.
```

**Repository context** — list the two repos and their paths, note which files the sub-agent reads vs. edits, and name the one book file in scope.

**Reference files** — enumerate every file the sub-agent MUST read before editing, with line-number hints for the relevant rules. Minimum: the codex doc (with specific Rule numbers), the schema (with the relevant `$defs` names), and for round_script contract changes also `cli-emulator/play.js:runCombatRound` vs `runPostRound` so the sub-agent understands the lifecycle split.

**Scope** — an exhaustive enumerated list of the items or fields being changed. For equipment tagging, group by category (weapons, armor, edge cases) and give the exact target fields for each item. For round_script migrations, quote the specific lines being replaced. Ambiguity here is the most common source of over-scoped sub-agent edits.

**Items NOT to touch** — an explicit deny-list, especially for items the sub-agent might plausibly consider in scope (non-combat consumables, key items, treasures that could be "worn," etc.). Also: any file outside the one target book, any `post_round_script`, any `known_issues.md` entries.

**Hard rules the sub-agent must follow** — a bulleted list:
1. Don't touch specific non-scope fields (list them)
2. Don't address known_issues.md entries (separate track per user instruction)
3. Don't add features from rules that aren't in scope (e.g., don't add `damage_interactions` when the scope is equipment tagging)
4. Don't edit files outside the target book
5. Don't commit or push
6. Don't run destructive git operations (only `git status` and `git diff` are allowed)
7. Parser-driven workflow per Rule 7 — read targeted sections, don't load the whole file and re-emit
8. Don't echo section narrative into output per Rule 6

**Procedure** — numbered steps the sub-agent follows: read rules → read schema → locate targets → apply edits → verify JSON validity → verify diff scope → produce report.

**Report format** — under a word limit (300–500 depending on scope). Require these sections:
1. What you changed (bulleted per item, explicit about which fields changed and which didn't)
2. What you did NOT change (explicit confirmation of the deny-list)
3. JSON validity check result
4. `git diff --stat` output
5. Flags / concerns (out-of-scope observations worth tracking)
6. Open questions for the main session (cap at 2)

**Closing directive** — explicitly tell the sub-agent NOT to summarize the rules it's applying, NOT to describe the overall framework, NOT to repeat the scope back. The main session already knows all of that; the sub-agent's job is to report what it did to the file.

**Known sub-agent failure modes to watch for when reviewing reports:**

1. **Self-introspection failure.** A sub-agent can make Edit calls and then in its verification step read the file back and convince itself "the changes were already there; I made no edits." Seen on Warlock iter 8 (commit `a8f68b3`). Always verify the diff directly rather than trusting the sub-agent's self-report of its own edit activity. If the diff matches the spec and the file mtime is inside the sub-agent's runtime window, assume the sub-agent made the edits even if it reports otherwise.

2. **Rule-text over-literalism.** A sub-agent reading the HARD RULE without the authorization preamble will refuse the task. The opening authorization block above is the corrective. Seen once on LW1 before the CLAUDE.md clarification (engine commit `9d0815b`).

3. **Creeping scope.** A sub-agent asked to tag equipment may also volunteer to fix unrelated data bugs it notices (missing `stat_modifier.when` values, obvious typos, known_issues entries). The "Hard rules" section's explicit ban on touching known_issues is the corrective; also useful is "stay in your lane" phrasing in the scope description. When the sub-agent flags adjacent issues in its report, those go to the next session's backlog, not to the current commit.

4. **Workaround-as-success reporting.** This is the Windhammer foot-gun (see the "Tracked engine backlog" section): a sub-agent using `manual_set` or similar escape hatches to paper over a missing mechanism, then reporting "it works" — technically true but misleading. Don't let Phase 2 book migrations use `manual_set` or similar, and have the sub-agent's scope explicitly exclude workarounds.

### Spawning the sub-agent in the foreground vs the background

For narrowly-scoped edits (< 15 items touched, < 200 lines changed), foreground is fine — the main session can just wait for the result without eating much budget. For Tier 3 comprehensive reviews on 350+ section books, use `run_in_background: true` so the main session can continue other work; the completion notification comes back automatically when the sub-agent finishes.

When running in the background, remember you CANNOT poll or read the output file — the system prompt's tool description explicitly warns that reading the sub-agent's output JSONL can overflow the main session's context. Wait for the notification.

### Schema-validity comparison against baseline (mandatory for sub-agent migration commits)

Every sub-agent migration commit that edits a book file must verify that the per-section schema-validity error count did not regress outside the migration's declared scope. The verification is a fast quality gate — running `ajv` validation on `git show origin/main:<file>` (the pre-Wave baseline) and on the post-Wave file takes ~2 seconds and immediately surfaces any introduced shape errors anywhere in the file, not just in the Wave's intended scope.

The discipline is mandatory because "PASS json validity" — which only confirms the file is parseable JSON, not that it conforms to the schema — is a much weaker signal than schema-shape conformance. A Wave that fixes 6 sections cleanly while breaking 3 unrelated sections looks identical to a clean Wave under bare JSON-parse validation; ajv-shape comparison surfaces the 3 regressions immediately.

**The verification step (per Wave):**

1. Pre-Wave: extract the baseline error count and per-section breakdown from `git show origin/main:<book-path>` against the current schema using ajv. Note the total error count and any sections in the migration's scope that contributed errors.
2. Post-Wave: run the same ajv validation on the working-tree file. Compute the per-section delta (count + which sections moved up/down).
3. Confirm: every section the Wave touched should have the same or lower error count post-Wave. Every section the Wave did NOT touch should have the same error count post-Wave (any change is a regression).
4. Report: include the per-section error-count delta in the commit message. Format: `Schema validity: <pre> → <post> errors. In-scope sections: <list with deltas>. Out-of-scope regressions: none.`

**ajv is a first-class devDependency.** The engine repo's `package.json` declares `ajv` and `ajv-formats` as devDependencies so the validator is available without per-session bootstrap. Sub-agent prompts directing a baseline comparison should reference the existing `node_modules/ajv` path rather than instructing a `--no-save` install — the install pattern was the pre-discipline workaround and is now superseded.

**A minimal validation snippet** (sub-agent or main session can paste this into a one-shot script):

```js
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schema = require('/home/user/codex-gamebook-engine/codex.schema.json');
const validate = ajv.compile(schema);
const book = require('<absolute-path-to-book>');
validate(book);
// Group errors by section id derived from the dataPath
```

The cost of running the comparison is bounded — even a 600-section accumulator validates in well under 10 seconds — so there is no scenario in which it is too expensive to run on every Wave. Skipping it is a net loss every time.

### Avoid full-file `JSON.stringify` / `json.dump` round-trips for additive edits (Chat #28 lesson)

Sub-agents performing additive edits (e.g., appending one event to a section's `events` array, adding one new catalog entry, replacing a single condition) should NOT round-trip the entire book file through `JSON.parse → JSON.stringify` (or the Python equivalent `json.load → json.dump`) and write the re-serialized output back. Round-tripping introduces collateral cosmetic changes — unicode escape unwinding, single-line dicts reformatted to multi-line, key reordering, whitespace shifts — that pollute the commit diff with noise unrelated to the intended edits. The Chat #28 LW1 §147 sub-agent's first attempt produced exactly this pattern and had to be reverted; the recovery was to apply the three intended edits as **targeted byte-level string replacements on the pristine baseline** (i.e., search-and-replace with enough surrounding context to make each match unique), which produces a clean diff with zero collateral.

Two practical patterns for additive edits:
- **For small, well-localised edits** (1-3 changes touching adjacent lines): use the Edit tool with `old_string` / `new_string` carrying enough surrounding context. Each Edit call modifies bytes in place; no re-serialization happens.
- **For larger but still mechanical edits** (e.g., appending an event to N sections): build a Node script that reads the file as text, applies regex-based substitutions, and writes the modified text back. The text is never parsed/re-serialized as JSON. Verify the result is still valid JSON via a quick `JSON.parse` after the substitutions, and ALSO run `scripts/validate-book.js` to confirm schema validity.

Only use full-file `JSON.stringify` round-trips when the edits are sweeping enough that bytes-in-place wouldn't be tractable (e.g., a Wave 5-style normalization touching dozens of sections with mechanical pattern transforms). In that case, document the cosmetic-noise tradeoff in the commit message and consider whether the change should land as a separate "cosmetic reformat" commit ahead of the substantive edit commit so the substance stays reviewable.

## Two-pass remediation workflow

After a fresh parse produces a `book.json` from raw source text — whether by a sub-agent following the codex's parse rules, by a deterministic script, or by some combination — the production line uses a **second pass** (the remediation pass) to surface and triage the extraction failures the first pass missed. This is a class of comprehensive-review sub-agent workflow, distinct from the schema-migration / Rule-N-shipping waves that the comprehensive-review template above describes.

**When to invoke:** any time a fresh parse has been produced and validates schema-clean, but the soft checks in `scripts/validate-book.js` report findings (dangling catalog entries, orphan sections, loss-in-choice-text mismatches, disarmament narratives without remove events, enemy-immunity gaps). This is typically the case after a new book has been parsed and before it is committed for the first time, OR after a major codex/schema bump exposes drift in a maintained book that the migration sub-agent didn't catch.

**Why this is its own workflow:** the comprehensive-review template above is shaped for *migrations* — apply Rule N to all relevant sites, ship the changes, validate. The remediation pass is shaped for *triage* — every finding requires a user judgment call (real bug or intentional flavor?), and the user's input is plain-English answers rather than technical decisions. Folding remediation into the migration template would mix two different interaction patterns and surface technical detail to the user that they shouldn't have to engage with.

**Workflow shape:**

1. Run `node scripts/validate-book.js <book.json>`. Confirm 0 schema errors. Note the soft-check output.
2. Dispatch a remediation sub-agent via the Agent tool with the prompt template below. The agent reads the validator output, performs the LLM pass for condition-text-mismatch detection (per codex §12.6), presents each finding as a plain-English question, accepts y/n/flavor/show/other answers, and applies confirmed fixes.
3. The user (or another agent in the loop) answers the agent's questions. No technical knowledge required; the agent translates to/from the book's narrative vocabulary per codex §12.2.
4. When the loop ends, the agent reports applied fixes, flavor-markings, and remaining skipped findings. The book is now suitable for commit per the comprehensive-review-sub-agent path.

**Authorization shape:** the remediation agent is a class of comprehensive-review sub-agent — it edits maintained book JSONs in scope. The HARD RULE's "Are you a sub-agent reading this rule?" carve-out applies. The remediation agent's prompt MUST explicitly invoke that carve-out (point at the updated reference files, name the target book, and name the scope as "apply remediation fixes per soft-check output, per codex §12").

**Pre-conditions before invocation:**

- The book has been schema-validated (0 errors).
- The validator's soft-check output is available (run `validate-book.js` and capture stdout, or have the remediation agent run it as its first step).
- The book is at the most current codex / schema / emulator versions (or the discrepancies have been triaged separately — remediation doesn't substitute for migration).

**The user's job during the pass:** answer the agent's questions in plain English. The user does NOT need to:

- Know the schema
- Know the codex's rule numbers
- Understand event types or condition shapes
- Read JSON or write JSON

The user DOES need to:

- Know the book (well enough to answer "is X mechanically referenced?" or "should the player lose Y here?")
- Have the source text available if the agent shows excerpts, or trust the agent's paraphrase

**Wrapping up:** the remediation agent produces a final report (fixes applied, flavor-markings, skipped findings, final validator output). The user reviews the diff via `git diff books/<book>.json` and commits the result with a marker per the production-line commit-msg hook (`[sub-agent]` or iter convention — see the books repo's `hooks/commit-msg`).

**Codex appendix reference:** the full vocabulary translation table, question framings per finding category, freeform-answer interpretation rules, and anti-pattern list live in `gamebook_codex_v2.md` §12 ("Two-pass remediation workflow"). The remediation agent's prompt template (below) references that appendix as required reading.

### Remediation sub-agent prompt template

Adapted from the comprehensive-review template above. The structure is the same (HARD RULE preamble, scope statement, hard rules, procedure, report format) but the scope is "triage soft-check findings via plain-English Q&A" rather than "migrate to Rule N."

```
## You are the authorized remediation sub-agent. Read this first.

[Standard HARD RULE preamble — point at the updated reference files
(codex doc §12, schema, emulators), name the target book, state the
scope: "triage soft-check findings produced by scripts/validate-book.js
and apply user-confirmed fixes per codex §12 protocol."]

## Materials

- Target book: /home/user/codex-engine-books/books/<book>.json
- Codex appendix on remediation: /home/user/codex-gamebook-engine/gamebook_codex_v2.md §12
- Schema: /home/user/codex-gamebook-engine/codex.schema.json
- Validator: /home/user/codex-gamebook-engine/scripts/validate-book.js
- Source text reference (if available): <path to OCR'd source or other authoritative reference>

## Procedure

1. Run the validator. Capture the schema-error count (must be 0 to proceed)
   and the soft-check output.
2. For each soft-check finding, present a plain-English question to the
   user per the framings in codex §12.4. Use the book's own narrative
   vocabulary, not schema field names (codex §12.1 and §12.2).
3. Accept the user's answer (y / n / flavor / show / other). For `show`,
   display the relevant source-text excerpt translated per codex §12.7.
   For `other`, interpret the freeform reply per codex §12.5; re-ask in
   plain English if ambiguous.
4. After all validator findings are triaged, perform the LLM pass for
   condition-text-mismatch (codex §12.6) over sections with conditional
   choices or intrinsic_modifiers. Surface any mismatches with the
   §12.4 framing.
5. Apply user-confirmed fixes via Edit calls. Mark flavor decisions per
   codex §12.8.
6. Produce the final report per codex §12.11.

## Hard rules

- Never expose schema vocabulary to the user (codex §12.1).
- Never demand technical answers (codex §12.5).
- Stay in the book's own narrative terms (codex §12.2).
- Don't fix anything outside the validator-surfaced findings or the
  LLM-pass mismatches without asking the user first.
- Don't commit or push — the main session reviews the diff and commits.
- Don't round-trip the whole book file through JSON.stringify (see the
  "Avoid full-file JSON.stringify" section above). Use Edit calls with
  enough surrounding context for unique matches.
```

The template's authorization preamble follows the same shape as the comprehensive-review-sub-agent template above — point at the updated reference files (codex §12 specifically), name the target book, state the scope, list the deny list and hard rules. The differentiator is the procedure section and the explicit references to codex §12.

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

---

## Tracked engine backlog

Concrete engine-side improvements with known designs that haven't been scheduled into a session yet. Unlike "Open architectural questions" (design-uncertain), entries here have their shape figured out and are waiting on implementation time. Each entry should be self-contained enough that a future session can pick it up without re-deriving the findings.

### Windhammer unprofiled-series stress test (discovered codex v2.8, captured here for a future v2.9 / schema v1.6.0 / emulators v3.1.0 session)

**Source artifacts** (all on books repo `claude/continue-gamebook-conversion-89y4y` branch at `cea3e25`):
- `raw/windhammer.pdf` — source PDF (Chronicles of Arborell: Windhammer, Wayne Densley, 600 sections, unprofiled series)
- `claude_session/windhammer.json` — v2.8 parse output (contains the bugs below)
- `claude_session/windhammer_session_summary.md` — original parse-session report from the incognito Claude chat
- `claude_session/windhammer_smoke.script`, `windhammer_probe.script` — replay artifacts

**Context.** A fresh Claude chat session was asked to run the codex v2.8 on a previously-unseen gamebook in a previously-unprofiled series. This is the accountability test DEV_PROCESS mandates under "Series-agnostic design → the unprofiled-series stress test." The parse completed (600/600 sections, schema v1.5.0 validation passed), but when the output was exercised by the emulators, two genuine codex/schema gaps surfaced and one emulator validation gap was exposed. The findings justify a v2.9 / 1.6.0 / 3.1.0 session dedicated to closing them and re-running the stress test as a regression guard.

**Bug A: Point-distribution stat generation has no schema primitive.**

Windhammer uses a point-buy stat system — the player distributes 50 points across 5 attributes (Strength, Agility, Endurance, Luck, Intuition) within per-stat min/max ranges. The schema's `character_creation_step.action` enum does not include a step type for this. The parse run invented a `generation: "distribute:5-11"` string on `rules.stats[]` (a field neither emulator reads at character creation time) and emitted no corresponding character_creation step for the five core stats. Result: stats are `undefined` after character creation completes, and combat fails because `player.attack` resolves to 0.

- **Codex v2.9:** Add a rule in Section 7 (Unknown/Other Series profile) explicitly covering point-buy / point-distribution stat systems. Tell the AI what shape to emit, cross-ref to the new `distribute_points` action type, and include a Windhammer-shaped example.
- **Schema v1.6.0:** Add `distribute_points` to `character_creation_step.action` enum, with fields `total_points` (number) and `stats` (array of `{name, min, max}`). Additive — no breaking change.
- **CLI emulator v3.1.0:** New pause type `character_creation_distribute`. New action `distribute <stat>=<val> <stat>=<val> ...` that validates the sum against `total_points` and each value against per-stat min/max.
- **HTML emulator v3.1.0:** Point-buy UI with + / − buttons per stat, remaining-points counter, Confirm button that disables until allocation is valid.

**Bug B: Derived attack_stat references a stat not in `rules.stats[]`.**

Windhammer's Combat Value is a derived quantity: CV = Strength + Agility + skill/talent/armour bonuses. The parse run set `rules.attack_stat: "combat_value"` and did NOT declare `combat_value` in `rules.stats[]`. The emulator's combat init looks up `state.stats[attackStat]` = `state.stats.combat_value` = undefined, and `player.attack` becomes 0 for the whole fight.

The **codex doc already has the right guidance** at Section 7.5 line ~1485 — "Games without `attack_stat`: … `attack_stat` may be null and … the Lua script should use game-specific fields instead." The parse run didn't apply it because (a) the rule is buried in Section 7.5 instead of Section 7, (b) it's framed around "threshold-based systems" which doesn't obviously connect to "derived attack stat," and (c) there's no explicit example showing how to handle `CV = Str + Agi + bonuses`-style derivations.

- **Codex v2.9:** Move the "Games without attack_stat" guidance up from Section 7.5 into Section 7 (Unknown/Other Series profile). Add an explicit clause: *"If the book's combat stat is computed from other stats (e.g., CV = Strength + Agility + weapon bonuses), set `attack_stat: null` and compute the derived value in the round_script from its component stats: `local cv = (player.strength or 0) + (player.agility or 0); local pcs = pr.total + cv`. Do NOT declare the derived name in `rules.stats[]`. Do NOT set `rules.attack_stat` to the derived name."* Include a Windhammer-shaped example.
- No schema or emulator change needed for Bug B; the fix is entirely in the codex doc's prominence and cross-referencing.

**Bug C: Emulators silently tolerate undefined stats.**

Neither emulator validates that `rules.attack_stat` / `rules.health_stat` reference declared stats at book-load time, and neither checks that every declared stat is actually set after `character_creation.steps[]` completes. The CLI status bar renders undefined stats as the literal string `undefined` (no `|| 0` fallback on its display template literal); the HTML stat bar falls back to `0` (has `|| 0`). Same underlying state, different cosmetic symptoms, neither one surfaces the real diagnosis.

- **Both emulators v3.1.0:** Add a book-load validation pass that checks and warns about:
  - `rules.attack_stat` naming a stat not declared in `rules.stats[]`
  - `rules.health_stat` naming a stat not declared in `rules.stats[]`
  - Any declared stat that is still `undefined` after `character_creation.steps[]` has run (checked just before the first section renders)
- Surface the warnings as a prominent banner above the play area (HTML) or a `WARNING:` block at the top of the status output (CLI). Not a hard error — the game still runs so the player can see downstream effects — but the diagnostic is loud and points at the root cause, not the symptom.
- Harmonize undefined-stat rendering: both emulators should display `—` (em dash) or `?` for undefined stats with a log warning, instead of the current `undefined` / `0` divergence. This forces codex runs that produce incomplete output to fail visibly rather than silently.

**Bug D: `manual_set` is a foot-gun for Tier 3 regression claims.**

The Windhammer parse-run sub-agent used the CLI's `manual_set stats.<name> <value>` debug escape hatch to sidestep the missing character creation step in its replay scripts. Once `state.stats.combat_value = 12` was poked into state, combat ran correctly in the CLI — the sub-agent then reported "combat works" in good faith. The same book fails in the HTML emulator because the HTML has no `manual_set` equivalent (tracked as a pre-existing cosmetic issue in `known_issues.md`). The net effect: a Tier 3 playthrough script can pass the CLI and claim the book is playable, while the same book is actually unplayable through normal interactive flow.

- **Codex v2.9:** New rule or amendment to the Tier 3 playthrough procedure: *"When writing a Tier 3 playthrough script, do NOT use `manual_set` to paper over missing character creation steps. `manual_set` is for debug probes and section-coverage tests (Tier 1 / Tier 2), not for playthrough validation. If a character creation mechanism is missing from the schema, the right response is to stop, file a codex/schema gap, and report Tier 3 as BLOCKED — not to work around it and claim PASS."*
- **CLI emulator v3.1.0:** When `manual_set` is used during a playthrough script run, log a prominent `[manual_set used: stats.<name>]` line to the playthrough output. At end-of-script, if any `manual_set` set a value under `stats.*` or `initialStats.*`, mark the run as *"Tier 3 PARTIAL — manual stat workaround"* in the summary header, not *"Tier 3 PASS."* This makes the workaround visible in regression reports instead of being buried.

**Regression plan.** After the v2.9 / 1.6.0 / 3.1.0 fixes ship:

1. Re-run the codex on `raw/windhammer.pdf` via a sub-agent, using the updated codex doc as the instruction set.
2. Expected output: a `character_creation.steps[]` that includes a `distribute_points` step, `attack_stat: null`, enemies_catalog entries that use `combat_value` and `endurance` as ordinary enemy fields (not as player stats), and a `round_script` that computes `cv = player.strength + player.agility + bonuses` inside Lua.
3. Validate against the new schema, run smoke + probe + a fresh run1 playthrough WITHOUT `manual_set`.
4. If the re-run produces a cleanly playable book on both CLI and HTML, Windhammer is promoted to the maintained-books list as the permanent unprofiled-series regression slot (alongside LW1 / Warlock / GrailQuest as the profiled-series slots). The PDF, walkthrough, and playbook scripts stay in the private books repo.

**Not in scope for the Windhammer track:**

- A full comprehensive review of Windhammer against the updated codex for data-quality issues beyond the above gaps. That's a follow-up track if Windhammer gets promoted to maintained.
- The equipment point-buy in Section 1 of Windhammer (a 50-point shop that's currently narrative-only). That's a *different* point-buy problem — item purchase rather than stat distribution — and would warrant its own action type (`purchase_items` or similar). Document it as a secondary backlog entry when the main Windhammer track ships, don't fold it into v2.9.
- The `choose_items` step type, which Windhammer also references indirectly. It's already in the schema per what I saw in `play.js`; confirm scope before the session.

### Weapon-type mastery has no engine mechanism (discovered codex v2.37.0, LW1 fresh-parse remediation)

**Context.** Lone Wolf's Weaponskill Kai Discipline grants +2 COMBAT SKILL whenever the player wields a weapon of the single weapon type they are skilled in — the type is rolled at character creation on the Random Number Table (Mace, Sword, Axe, Spear, Quarterstaff, Warhammer, Dagger, Broadsword, etc.). The v2.37.0 fresh parse of LW1 surfaced that the engine has no mechanism for this: there is no `weapon_type` concept on weapon items, no concept of a player's "skilled weapon type," and no logic to apply a bonus when the equipped weapon's type matches. The parse worked around it by encoding the +2 as a `rules.combat_system.standing_modifiers[]` entry gated on `has_ability "Weaponskill"` AND `has_flag "weaponskill_weapon_equipped"` — but nothing sets or maintains that flag against the currently-equipped weapon, so the bonus does not track weapon swaps. The user reviewed this in remediation, accepted the documented partial encoding (recorded in the book's `metadata.parser_notes`), and asked for the gap to be tracked here rather than hacked into the book data.

This is a general RPG mechanic, not LW-specific: AD&D weapon proficiencies, Fighting Fantasy weapon-specific bonuses, and other series' weapon-mastery rules are the same shape — "the player has mastery of weapon type T; while wielding a weapon of type T, apply effect E."

- **Schema:** add an optional `weapon_type` string to `items_catalog` weapon entries (free-form, the book's own vocabulary — `"sword"`, `"mace"`, …). Record the player's mastered weapon type(s) as a chargen output — a dedicated chargen step, or a field the existing roll_table / discipline-pick step writes to a known player slot (e.g. `state.weapon_mastery: ["sword"]`). Add a combat-modifier `condition` predicate — `equipped_weapon_type_is_mastered` (true when the weapon currently in the weapon slot carries a `weapon_type` present in the player's mastery list) — so the bonus is an ordinary `combat_modifier` with no manually-maintained flag.
- **Codex:** in the LW series profile (Section 5) and the Section 7 unprofiled guidance, document how to encode a weapon-type-mastery discipline — tag weapon items with `weapon_type`, capture the mastered type at chargen, gate the bonus with the new condition. Include the LW Weaponskill worked example.
- **CLI + HTML emulators:** when freezing the combat modifier set at combat start, evaluate `equipped_weapon_type_is_mastered` against the equipped weapon's `weapon_type` and the player's mastery list — derived from equipped state, no flag plumbing. The Weaponskill +2 then tracks weapon swaps correctly.

**Source artifact:** `claude_session/lw1_fresh_parse_chat39_v237.json` (books repo) — the v2.37.0 fresh LW1 parse carrying the documented partial encoding. The `weaponskill_weapon_equipped` standing_modifier is the thing to replace once the mechanism ships.

### Post-roll condition predicate `test_succeeded` (discovered codex v2.37.0, Warlock fresh-parse remediation)

**Context.** Many Fighting Fantasy sections present a follow-up choice or event whose availability depends on the outcome of the dice roll the player just made — typical phrasing is "If you successfully tested your Luck, turn to A; if not, turn to B" *after* a separate Test Your Luck happened earlier in the same section, or "If you passed the roll, you may also …". The schema has `roll_dice.results[]` per-range targets and `stat_test.success_to / failure_to` direct branches, but no `condition` primitive that says "this choice / event is available iff the last dice resolution succeeded." The Warlock v2.37.0 remediation pass had to **drop 12 conditional choices and events** across the book because there was no valid encoding — the choices are flagged in `metadata.parser_notes` of `claude_session/warlock_fresh_parse_chat39_v237.json`. This is the single highest-impact gap from the Warlock work: 12 narrative branches inaccessible to the player.

The pattern recurs across FF, LW (Kai Discipline pass/fail follow-ups), GrailQuest, and most stat-test-heavy series, so the primitive is broadly reusable.

- **Schema:** add `last_roll_succeeded` (boolean) and `last_roll_failed` (boolean) to the existing `condition` union (same union used by `choices[].condition` and event-level `condition`). Semantics: true iff the most recent `stat_test` or `roll_dice` event resolved within the current section dispatched a success/failure outcome. State carries a per-section `lastRollOutcome: 'success' | 'failure' | null`, cleared at section entry, set by stat_test / roll_dice resolution.
- **Codex:** new Rule under the existing condition-primitive rules. Trigger phrasing: "If you successfully tested your Luck", "If your Skill roll failed", "If you passed the test", "If you rolled equal to or under". Worked example showing the choice-level encoding and the event-level encoding. Add a row to the Topical Decision Table.
- **CLI + HTML emulators:** track `state.lastRollOutcome` across stat_test and roll_dice resolution paths. Evaluate the new condition keys in the existing condition evaluator. Clear at section transition.
- **Regression:** the 12 dropped Warlock choices are listed in `claude_session/warlock_fresh_parse_chat39_v237.json` parser_notes. After the primitive ships, a remediation sub-agent re-encodes those choices and the count drops to zero.

### Clamped restore action `restore_to_initial` (discovered codex v2.37.0, Warlock fresh-parse remediation)

**Context.** Warlock's Holy Water (and several minor potions / spells across the FF series) restore the player's STAMINA *up to their Initial total* — i.e. add N, clamping at initial. The schema has `modify_stat` (unbounded additive delta) and `set_initial_to` (sets the initial cap itself), but no action that adds-with-clamp-to-initial. The Warlock parse encoded these as `modify_stat: +999` with a comment, relying on a manual clamp the engine doesn't actually apply. Result: drinking Holy Water briefly pushes STAMINA above its Initial cap in the stats panel until the player takes ordinary damage.

The pattern is universal across stat-restoration mechanics: every healing potion / herb / spell that "restores up to your Initial" is the same shape.

- **Schema:** add `restore_to_initial` event with fields `stat` (string, must match a `rules.stats[].name`) and `amount` (number, defaults to "full"). Semantics: `state.stats[stat] = min(state.stats[stat] + amount, state.initialStats[stat])`. Additive.
- **Codex:** new Rule documenting the trigger phrasing ("restore your STAMINA to its Initial total", "regain N STAMINA, up to your Initial", "heal fully"). Worked example with Holy Water. Decision-table row.
- **CLI + HTML emulators:** new event handler, ~10 lines each. Logs the restored amount and the cap.
- **Regression:** Holy Water uses across Warlock + the LW1 healing potions parse currently using +N modify_stat with parser_notes about clamping.

### Wager primitive `gamble` (discovered codex v2.37.0, Warlock fresh-parse remediation)

**Context.** Warlock §346 presents a wagering encounter — the player chooses an amount of gold to wager, a die is rolled, and on win they receive 2× their wager / on loss they forfeit it. The schema's `roll_dice` and `modify_stat` would compose to express this, but only after the player has been prompted to input an amount AND that amount has been multiplied through both branches — there is no primitive for "player chooses a number bounded by a resource, then a die roll decides gain/loss against that number." The Warlock parse wrapped it as a generic `custom` event the emulator no-ops past, so the wager never actually happens.

The pattern is a Fighting Fantasy / D&D-Solo staple — Warlock has 1 instance, the wider FF catalog has many.

- **Schema:** add `gamble` event with fields `stake_resource` (string, e.g. "gold"), `stake_min` and `stake_max` (number or "all"), `outcome` (object with `success_roll` predicate over the rolled die and `win_multiplier` / `loss_multiplier`). Reuses the existing `input_number` pause primitive for the stake choice and `roll_dice` for the outcome roll, but at the schema level it's a single event so the player-facing flow is one composite interaction.
- **Codex:** new Rule covering wagering encounters. Triggers: "wager", "bet", "stake", "gamble". Worked example with §346 shape. Decision-table row.
- **CLI + HTML emulators:** new pause type `gamble_stake` (prompts for stake amount, validated against `state.resources[stake_resource]`), then runs the embedded roll, then applies the outcome.

### Combat gate by equipped-weapon property (discovered codex v2.37.0, Warlock fresh-parse remediation)

**Context.** Warlock's Vampire and Wight combats both require a *silver* weapon to inflict damage — fighting them with a normal sword does nothing and the player must flee or die. The schema can tag the silver weapons in `items_catalog` (a `properties: ["silver"]` field would be additive), but there is no combat-level gate that says "this combat requires the equipped weapon to have property P; if not, damage taken/dealt is zero / forced flee / specific death section." The Warlock parse dropped the gate entirely — the player can win the Vampire fight with any weapon, which trivialises the encounter.

The pattern is broadly reusable: silver-weapons-vs-undead, magic-weapons-vs-spirits, blessed-weapons-vs-demons, holy-water-as-weapon, and similar item-type-gated combats across FF, LW (the Tomb of the Majhan permanent-death corridor), GrailQuest, and Way of the Tiger.

- **Schema:** add optional `properties: string[]` to `items_catalog` weapon entries (free-form: "silver", "magic", "blessed", "fire"). Add a combat-level field `combat.required_weapon_properties: string[]` and a behavior selector `combat.required_weapon_failure: "no_damage" | "flee_to:<sid>" | "death_to:<sid>"` for what happens when the equipped weapon lacks a required property. Add a `condition` predicate `equipped_weapon_has_property` for use in choices that gate on weapon properties (e.g. "if you have a silver weapon equipped, you may attack: turn to N").
- **Codex:** new Rule covering weapon-property-gated combats. Triggers: "only X weapon can harm", "silver weapon required", "only enchanted/magic/blessed weapons". Worked example with Vampire / Wight. Decision-table row.
- **CLI + HTML emulators:** at combat start, evaluate `required_weapon_properties` against the equipped weapon's `properties`; if mismatched, apply the configured failure behavior.

### Combat interrupt on Nth player wound (discovered codex v2.37.0, Warlock orphan-edge recovery)

**Context.** Warlock §173's Wight fight has a mechanic: every successful enemy hit on the player is a "wound," and after the **third** wound the fight ends and the player is dragged off to §24 regardless of remaining stamina. The schema's `combat` event has `end_after_rounds` (Rule 38) and `damage_caps` (Rule 32) but no field for "interrupt and navigate to <sid> after the Nth player-side wound." The Warlock orphan-recovery pass encoded this as a conditional choice on §173 reading "If during the fight you were wounded a third time, turn to §24" — relying on the player to honestly self-count wounds. The Wight fight runs as an ordinary combat in the engine.

The pattern recurs across paralysing / draining / curse-on-hit enemies in FF and LW.

- **Schema:** add `combat.lose_to_after_wounds: { count: number, target: section_id }` (a "soft loss" outcome — the player is alive but the combat ends and play resumes at the named section). State maintains a per-combat wound counter (number of resolved attack-strength rounds where the enemy outscored the player).
- **Codex:** new Rule under the existing combat-resolution rules. Triggers: "after the Nth wound", "if the Wight wounds you three times", "every time the Y hits you it counts as a wound". Worked example with §173 Wight. Decision-table row.
- **CLI + HTML emulators:** wound counter in combat state, checked after each resolved round; on threshold, transition to the configured `lose_to_after_wounds.target`.

### Reachability tool: cover stat_test / set_flag / input_number paths (discovered codex v2.38.0, Warlock orphan-edge recovery)

**Context.** `scripts/check-reachability.js` (added in codex v2.38.0) traces a fixed set of canonical nav fields — `target`, `win_to`, `flee_to`, `lose_to`, `end_to`, `goto`, `navigate_to`, `to_section`, `return_to`, plus `script_code`'s `navigate_to = N`. The Warlock orphan recovery surfaced three patterns the tool misses, forcing book-side workarounds (mirror choices) just so the static reachability report would look honest:

1. **`stat_test.success_to` / `failure_to`** are real navigation fields used by the engine, but they are NOT in the script's canonical nav-field set. Sections reachable only via a stat_test branch read as stranded.
2. **`set_flag` + `has_flag` post-action navigation** — e.g. Warlock §234 sets `next_after_wandering=43` and §161's wandering-monster subroutine reads the flag to decide where to route. The static tool sees neither edge.
3. **`input_number` with `from_inventory_category` + `count`** is partially handled (key-sum puzzles model plausible sums against the `items_catalog`), but the heuristic is hard-coded to the `keys` category and to numeric-suffix-of-id extraction. Other inventory-driven inputs (alphabet puzzles, color-coded items) won't be modelled.

The book-side mirror-choice workarounds (§173's wound-count choice, the key-puzzle static fallback choices on §139/§182/§198) exist primarily so check-reachability reports the truth. Filling this gap removes the need for those workarounds.

- **Tool change only** (no codex / schema / emulator change). Extend the NAV_KEYS set in `scripts/check-reachability.js` to include `success_to`, `failure_to`. Add a flag-propagation pass: scan all sections for `set_flag` actions, build a flag-name → setter-sections map; for each `has_flag` condition encountered during BFS, transitively credit the flag-setting sections as predecessors. Generalise the `input_number` heuristic to: (a) read `event.results[]` if present (explicit valid-input → target table); (b) for `from_inventory_category` events, enumerate from the catalog without hard-coding the category name; (c) optionally consult `items_catalog[id].value` / `.number` / numeric-suffix in the same priority order. Add unit tests under `tests/` using LW1 (clean baseline) and the v237 Warlock parse (the stat_test / set_flag / key-puzzle cases).
- **Regression:** rerun the Warlock parse's mirror-choice removals (a comprehensive-review sub-agent) and confirm reachability stays at 399/400 without them.

### Warlock OCR catalog: key numbers misread as 112 / 211 (discovered codex v2.38.0, Warlock orphan-edge recovery)

**Context.** `claude_session/warlock_fresh_parse_chat39_v237.json` carries two keys in `items_catalog` with OCR-damaged numbers — `bronze_key_112` (source page reads "112") and `red_key_211` (source page reads "211"). The maintained reference book has both as **111**, which is the catalog state that makes the canonical key-sum puzzle solvable (111 + 99 + 174 → §384 → §400 in the original game; the exact intended sums vary by which 3-of-N keys the player collects). With OCR-true numbers, no combination of collected keys produces a sum that reaches any intended destination — the puzzle is structurally inert. The Warlock orphan-recovery pass added **static fallback choices** to §139/§182/§198 routing directly to the puzzle destinations so reachability is correct in static analysis and end-to-end emulator probing, but the genuine input_number puzzle does not function for a player who tries to solve it.

This is a **book-data fix that depends on a Rule 2 (No Hallucination) judgment call**: do we deliberately overwrite OCR-true content with the maintained-reference values, or do we accept the OCR-true encoding and document that the key-sum puzzle is non-functional for this parse?

- **Recommended option (post-engine-gap-fill):** after the engine gaps above ship and a fresh Warlock re-parse runs against the updated stack, a remediation sub-agent re-examines the source pages for §75 / §258 with a higher-quality OCR (`ocrmypdf --redo-ocr --oversample 600`) and adjudicates 111 vs 112 / 211 against the actual scan. If the higher-quality OCR confirms 111, treat the v237 numbers as documented OCR damage and overwrite (with a `metadata.parser_notes` entry citing the higher-quality re-read as the source of truth). If the higher-quality OCR still reads 112 / 211, the puzzle is what the OCR'd source actually says — leave it; the static fallback choices stay as documented workarounds.
- **Alternative (if re-OCR is inconclusive):** ship the engine gaps, leave the key catalog OCR-true, and document the puzzle as non-functional in `metadata.parser_notes` and the `known_issues` block. The fallback choices remain the canonical path to the puzzle destinations.
- **Not in scope of this entry:** the static fallback choices themselves; those are a check-reachability tooling issue (see the "Reachability tool" entry above) and are removed in that entry's regression step.

---
