# Grimoire: The Universal Gamebook Engine

A universal web-based engine that plays gamebooks (Fighting Fantasy, Choose Your Own Adventure, Lone Wolf, etc.) from structured JSON data files. No copyrighted content is included — you bring your own books.

**Play now:** [robesris.github.io/grimoire-gamebook-engine](https://robesris.github.io/grimoire-gamebook-engine/)

## Quick Start

Want to parse a gamebook into a playable JSON? Open a new AI chat with **your gamebook source** (PDF or text — bring your own; no copyrighted content ships here), then paste this opener:

> I want to parse the attached gamebook into the JSON format the Grimoire engine consumes. Before you start, fetch the latest version of the engine's reference files from GitHub. First call this URL to get the current commit SHA on main:
>
> `https://api.github.com/repos/robesris/grimoire-gamebook-engine/branches/main`
>
> Look at `.commit.sha` in the response — that's the SHA. Then fetch each of these four files pinned to that SHA (replace `<SHA>` with the value you just got):
>
> - `https://raw.githubusercontent.com/robesris/grimoire-gamebook-engine/<SHA>/THE_CODEX_OF_ULTIMATE_WISDOM.md` — the parser's playbook
> - `https://raw.githubusercontent.com/robesris/grimoire-gamebook-engine/<SHA>/codex.schema.json` — the JSON shape the engine expects
> - `https://raw.githubusercontent.com/robesris/grimoire-gamebook-engine/<SHA>/cli-emulator/play.js` — the engine (you'll use this to play-test the parse)
> - `https://raw.githubusercontent.com/robesris/grimoire-gamebook-engine/<SHA>/cli-emulator/script-runtime.js` — the Lua sandbox the engine uses to execute script events
>
> Once you have all four, follow the codex doc end-to-end: do the fresh parse, run the §12 two-pass remediation workflow with me as the human-in-the-loop, then run the §12.14 play-execution gate until coverage is at or near 100%. Ask me questions in plain English. Tell me when the book is ready to download.

That's it. The SHA-pinned URLs sidestep CDN caching — every fetch returns the latest committed content for that file, never a stale copy. **Answer questions in plain English** as the AI walks you through the workflow. The codex handles the heavy lifting — vocabulary translation, question framing, progress tracking, the DFS play-test, the remediation→DFS loop. You don't need to learn the schema or the engine internals. **Download the resulting JSON** when the AI says it's ready, then load it at the play link above.

**If your AI doesn't support URL fetching**, you can upload the same four files manually from your local clone of this repo instead — the workflow is identical from there.

**If the AI hits a genuine engine limitation** (something the current engine can't model — rare, but possible), it will tell you which limitation, point you to the engine's [issue tracker](https://github.com/robesris/grimoire-gamebook-engine/issues), and stop. Submit a feature request. When the engine ships an update, come back to the AI chat and tell it to re-fetch the four reference files (the same URLs work — they'll resolve to the new SHA on main) and resume. It can either re-parse fresh from source or continue with the partially-completed JSON via another remediation→DFS loop. See the codex doc's **§12.15 Resuming after an engine update** section for the exact resume protocol the AI will walk you through.

## How It Works

1. **Create a game data file** from a gamebook you own (see below)
2. **Load it** into the engine using the file picker
3. **Play** — the engine handles combat, stat tracking, inventory, dice rolls, and all game mechanics

## Creating a Game Data File

You'll need an AI chat (paid Claude account recommended; see below). `THE_CODEX_OF_ULTIMATE_WISDOM.md` is a prompt document that instructs the AI how to parse a gamebook into the JSON format the engine expects.

### Steps

1. Start a new AI chat conversation with your gamebook (PDF or text) attached
2. Paste the opener from the Quick Start above — it tells the AI to fetch `THE_CODEX_OF_ULTIMATE_WISDOM.md` and the other reference files from this repo
3. The AI will walk you through the parsing process interactively
4. When it's done, download the resulting JSON file
5. Load it into the engine and play

### Model Recommendations

- **Tested with:** Claude Opus 4.6 on a paid Claude Pro/Max account
- A paid account is recommended — parsing a full gamebook is a large task that will hit free-tier limits
- Other models (GPT, Gemini, etc.) may work but haven't been tested — YMMV

### Which Claude should I use?

Either regular **Claude Chat** (claude.ai) or **Claude Code** (the CLI/IDE tool)
can parse a gamebook — but they verify the result differently:

- **Claude Code** gives the most thorough results. It runs the real engine,
  validates the book against the schema, and self-tests every scripted event
  by actually executing it. If a book has lots of scripted mechanics, Claude
  Code is strongly recommended.
- **Claude Chat** also works well, especially for simpler gamebooks (mostly
  choices and prose, few or no scripted events). Chat has no Node.js or
  filesystem, so it can't run the engine directly — but it *can* run the
  bundled verifier (see below) in its Analysis tool to schema-check the book
  and crash-test every script.

For script-heavy books, prefer Claude Code. For simpler books, Claude Chat is
fine.

### Verifying your parsed book

Before playing, verify the parsed JSON:

- **In Claude Code (or any Node.js environment):**
  `node scripts/validate-book.js path/to/your-book.json`
  Reports schema errors, structural soft-warnings, and runs every `script`
  event through the real Lua sandbox, failing on any crash.
- **In Claude Chat:** upload `dist/verify-book.bundle.js` alongside your book.
  It is a single self-contained file that runs in Chat's Analysis tool:
  `verifyBook(yourBookJson)` returns `{ ok, report, ... }` — `ok` is `true`
  only when the book is schema-valid and no script crashed. The bundle uses
  the *same* schema and the *same* Lua sandbox as the Claude Code validator,
  so the two agree.

### Tips

- A full book parse typically takes multiple conversation turns. The AI may pause at its output limit — just type "continue" to keep going
- Digital PDFs with a text layer work best. Scanned PDFs work too — the Codex supports vision-based parsing
- After parsing, play through a few sections to verify the output before committing to a full playthrough

## Running Locally

No build step required. Just open `index.html` directly in your browser — no server needed.

## Features

- Character creation with dice rolling and equipment selection
- Combat system (sequential and multi-enemy encounters)
- Stat tests and luck tests with dice display
- Inventory and flag tracking
- Conditional choices (greyed out when requirements aren't met)
- Free input for computed navigation puzzles
- Save/load via localStorage
- Export/import game state as JSON files
- Debug panel for inspecting game state

## License

Grimoire: The Universal Gamebook Engine is released under the [MIT License](LICENSE). No copyrighted gamebook content is included in this repository — you bring your own books.

This repository bundles `fengari-web.js`, a webpack build of [Fengari](https://fengari.io/) (a Lua 5.3 VM written in JavaScript), which is also distributed under the MIT License. Upstream copyrights for the bundled file are Benoit Giannangeli, Daurnimator, and Lua.org / PUC-Rio. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for the full notices.
