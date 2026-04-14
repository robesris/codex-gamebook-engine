# Codex Gamebook Engine

A universal web-based engine that plays gamebooks (Fighting Fantasy, Choose Your Own Adventure, Lone Wolf, etc.) from structured JSON data files. No copyrighted content is included — you bring your own books.

**Play now:** [robesris.github.io/codex-gamebook-engine](https://robesris.github.io/codex-gamebook-engine/)

## How It Works

1. **Create a game data file** from a gamebook you own (see below)
2. **Load it** into the engine using the file picker
3. **Play** — the engine handles combat, stat tracking, inventory, dice rolls, and all game mechanics

## Creating a Game Data File

You'll need an AI chat that supports file uploads. The included `gamebook_codex_v2.md` is a prompt document that instructs the AI how to parse a gamebook into the JSON format the engine expects.

### Steps

1. Start a new AI chat conversation
2. Upload `gamebook_codex_v2.md` along with your gamebook (PDF or text)
3. The AI will walk you through the parsing process interactively
4. When it's done, download the resulting JSON file
5. Load it into the engine and play

### Model Recommendations

- **Tested with:** Claude Opus 4.6 on a paid Claude Pro/Max account
- A paid account is recommended — parsing a full gamebook is a large task that will hit free-tier limits
- Other models (GPT, Gemini, etc.) may work but haven't been tested — YMMV

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

Codex Gamebook Engine is released under the [MIT License](LICENSE). No copyrighted gamebook content is included in this repository — you bring your own books.

This repository bundles `fengari-web.js`, a webpack build of [Fengari](https://fengari.io/) (a Lua 5.3 VM written in JavaScript), which is also distributed under the MIT License. Upstream copyrights for the bundled file are Benoit Giannangeli, Daurnimator, and Lua.org / PUC-Rio. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for the full notices.
