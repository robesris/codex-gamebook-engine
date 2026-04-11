# Development Process

This document describes how to develop and maintain the Codex Gamebook Engine itself — the codex doc, the GBF schema, the reference emulators, and the books we maintain as first-party tests of the system.

It is **not** a guide for end users running the codex on their own books. End users should read `gamebook_codex_v2.md` directly. This file is for the people editing that document.

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

This is the single most important rule for codex maintainers, and it's encoded in the codex doc itself as Rule 16. Restating it here for our own reference:

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

- **Codex version** (currently 2.2): bumped when `gamebook_codex_v2.md` changes meaningfully. Tracked in the doc's title, header, and version history block.
- **GBF format version** (currently 1.0.0): bumped when the schema changes in a way that affects output structure. Bump only for breaking changes; additive changes don't bump it. Tracked in the schema's `title` field.
- **Emulator versions** (currently 2.1.0 for both CLI and HTML): bumped when the emulator gains a feature or fixes a meaningful bug. Tracked in `CODEX_EMULATOR_VERSION` constants.

These are intentionally independent. A codex doc change that doesn't affect the schema or emulators bumps only the codex version. A schema addition that requires emulator support bumps the schema (if breaking), the emulators, and the codex doc together.

## Open architectural questions

These are the things waiting for a deliberate design decision rather than incremental work:

1. **Combat `special_rules` mechanical enforcement.** The schema field is currently a free-form string that the emulators render but don't apply. Multiple bugs depend on this gap. Two proposed solutions: structured `combat_modifiers` sub-object that the round_script reads, or pre/post-combat `modify_stat` events with `modify_initial: false`. Discuss before picking.
2. **Event-level conditions on the schema.** Currently `condition` is only allowed on choices. Several bug classes (e.g. LW Hunting exemption on `eat_meal`) would benefit from allowing it on events too. Small schema and emulator change, but worth doing as a deliberate decision rather than a drive-by.
3. **Lua runtime migration.** Currently using Fengari (unmaintained but stable). [wasmoon](https://github.com/ceifa/wasmoon) is the maintained alternative. Documented in the codex doc as a back-burner option.

When attacking any of these, the fix is a multi-part change spanning the doc, schema, and both emulators. Plan a dedicated session, not a drive-by.
