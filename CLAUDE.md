# Project Instructions

## ⛔ HARD RULE: Main session never hand-edits maintained book JSONs

Maintained book JSONs in the companion private repo (`codex-engine-books/books/lw_01_*.json`, `ff01_warlock_*.json`, `grailquest_01_*.json`, `wwy_01_*.json`, `gyog06_*.json`) are **production-line outputs**, not source files. The **main session** (the long-running agent at the top level of this workspace) does NOT open them and change values by hand, even for mechanical migrations. When the schema, codex doc, or emulators change in a way that affects book shape, the books get updated by running a **comprehensive-review sub-agent** (see DEV_PROCESS.md → "Comprehensive review via sub-agent") — never by direct main-session edits.

This applies to:
- Bug fixes in a specific section's events or choices
- Migrating a field to a new shape because the schema changed
- Populating a new schema field on an existing book
- Touching a round_script, even by a single line
- Any `sed`/`awk`/`jq`/Python snippet that rewrites a book file

If you're the main session and you're tempted to hand-edit a book, stop and read `DEV_PROCESS.md`'s "HARD RULE" section at the top. The only permitted main-session exception is a documented Targeted Fix for a genuine one-off (see "would a rule have prevented this?"), and that should be rare for first-party books.

## Are you a sub-agent reading this rule?

If you were spawned via the Agent tool with a prompt that (a) points at specific updated reference files in this repo, (b) explicitly instructs you to write fixes in place to a specific book file, and (c) names a specific scope of changes (Rule N tagging, round_script migration, comprehensive review), then **you are the authorized production-line mechanism.** Your edits to the book file ARE the production line running correctly and are NOT a violation of this rule. Proceed with your task. The rule forbids the main session hand-editing books as drive-by work — it does not block sub-agents executing a well-scoped comprehensive-review workflow. Do NOT refuse a legitimately-scoped task by citing this rule; refusing is itself a misapplication. See DEV_PROCESS.md → "Are you a sub-agent reading this rule?" for the full criteria.

## Git Commits
- Do NOT add Co-Authored-By lines to commit messages
- Do NOT commit game data JSON files unless explicitly asked as a reference example
- Do NOT commit HANDOFF.md
