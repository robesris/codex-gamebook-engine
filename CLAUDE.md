# Project Instructions

## ⛔ HARD RULE: Never hand-edit maintained book JSONs

Maintained book JSONs in the companion private repo (`codex-engine-books/books/lw_01_*.json`, `ff01_warlock_*.json`, `grailquest_01_*.json`, `wwy_01_*.json`, `gyog06_*.json`) are **production-line outputs**, not source files. Do NOT open them and change values by hand, even for mechanical migrations. When the schema, codex doc, or emulators change in a way that affects book shape, the books get updated by running a **comprehensive-review sub-agent** (see DEV_PROCESS.md → "Comprehensive review via sub-agent") — never by direct edits.

This applies to:
- Bug fixes in a specific section's events or choices
- Migrating a field to a new shape because the schema changed
- Populating a new schema field on an existing book
- Touching a round_script, even by a single line
- Any `sed`/`awk`/`jq`/Python snippet that rewrites a book file

If you're tempted to hand-edit a book, stop and read `DEV_PROCESS.md`'s "HARD RULE" section at the top. The only permitted exception is a documented Targeted Fix for a genuine one-off (see "would a rule have prevented this?"), and that should be rare for first-party books.

## Git Commits
- Do NOT add Co-Authored-By lines to commit messages
- Do NOT commit game data JSON files unless explicitly asked as a reference example
- Do NOT commit HANDOFF.md
