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

## Codex doc evolution discipline

When you ship a new rule, a new schema field, or a new behavior to the codex doc — anything that introduces a constraint the AI parsing a future book is expected to apply — the rule body itself is **not** the only thing you write. Every shipped rule comes with two pieces of meta-documentation that ship in the **same commit**:

1. **One new entry in the codex doc's pre-output verification checklist.** The entry is a positive-form yes/no statement the AI parsing a new book can confirm against the book it's processing. Frame the check in the language of the source text the AI is reading, not in the language of the schema. Counter-example: don't write *"verify rules.attack_stat is null when appropriate"* — write *"if the book's source text describes a derived combat stat (e.g., `CV = Strength + Agility + bonuses`), confirm `rules.attack_stat` is null and the round_script computes the derived value from component stats."* The checklist line should be specific enough that an AI can give a definitive yes/no and revise its output if the answer is no.

2. **One new entry in the codex doc's topical decision table.** The decision table sits near the top of the doc and is keyed on book-feature trigger words an AI can identify in the source text, with each row pointing at the rule that handles that feature. The new row uses the same source-text framing as the checklist line above.

These two pieces are not optional. They exist because the codex doc is read by an AI parsing an unprofiled book, and **the AI does not search the doc the way a human reader does** — the doc is in its context window all at once, and rules surface based on attention weight, not lookup. A rule that exists but has no checklist entry and no decision-table entry is a rule the AI can fail to apply silently. The Windhammer parse failure on derived attack stats (where the rule existed in Section 7.5 but wasn't found by the parse run) is the canonical example of why this discipline exists; see the "Tracked engine backlog → Windhammer" section for the failure mode and the recovery plan.

**The fail-loud rule:** if you ship a doc commit that adds a new rule WITHOUT also adding the corresponding checklist line and decision-table entry, your commit is incomplete. Revise it before pushing. A future maintainer (or a future Claude session) opening the codex doc and finding a rule that has no meta-doc backing should treat that as a bug, not as an oversight to ignore.

This rule is a workflow extension of codex doc Rule 16 ("Codex Maintainer Discipline (When You Are Editing This Document)"). Rule 16 covers what to do with the rule body itself — what makes a good rule, when to add one, when to escalate to a schema change. This section covers what ships **alongside** the rule body. The two are complementary.

**Activation note.** As of the writing of this section, the codex doc does not yet have either the topical decision table or the pre-output verification checklist — both are tracked engine backlog items (see `NEXT_SESSION.md` in the books repo for the work track that introduces them). When that work lands, this rule activates retroactively for the existing 19 rules: each one needs to be backfilled with its checklist line and decision-table entry as part of the same commit (or commit series) that introduces the table and checklist. After that, every new rule shipped in any future session carries the discipline forward. Until then, the rule is captured here so the requirement is not forgotten when the prominence-improvement session is scheduled.

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

---
