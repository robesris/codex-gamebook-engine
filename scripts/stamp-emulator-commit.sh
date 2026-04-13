#!/usr/bin/env bash
#
# codex-gamebook-engine / scripts/stamp-emulator-commit.sh
#
# Stamp the current git HEAD's short SHA into the CODEX_EMULATOR_COMMIT
# constant in both index.html and cli-emulator/play.js. Intended to be
# run BEFORE making a commit that touches the emulator, so the
# resulting commit contains the hash of its own PARENT in the
# CODEX_EMULATOR_COMMIT constant. Semantically: "this emulator binary
# was built on top of commit X".
#
# Why the parent's hash and not the commit's own hash? Because the
# commit's own hash doesn't exist until after `git commit` runs, and
# updating the constant after-the-fact would require an amend — which
# in turn would change the hash, creating a recursive chicken-and-egg.
# Using the parent's hash is the cleanest stable semantic: the
# emulator binary you are running is based on the known-good state
# that was sealed at commit X, and any later changes up to the
# commit that sets this value are visible in `git log X..HEAD`.
#
# Usage (from the engine repo root):
#
#   ./scripts/stamp-emulator-commit.sh
#   git add index.html cli-emulator/play.js
#   git commit -m "..."
#
# Or combined with a one-shot commit:
#
#   ./scripts/stamp-emulator-commit.sh && git commit -am "..."
#
# If HEAD doesn't exist (fresh repo, or detached HEAD pointing at
# nothing), the script uses the literal string "dev" as the stamp.
#
# This script is intentionally NOT wired as a git pre-commit hook
# because not every engine-repo commit touches the emulator. Wiring
# it as a hook would churn the constants on unrelated doc-only
# commits. Run it manually when you're about to ship an emulator
# change.

set -e

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "stamp-emulator-commit: not a git repo; aborting." >&2
  exit 1
fi

if hash=$(git rev-parse --short HEAD 2>/dev/null); then
  :
else
  hash="dev"
fi

if [[ -z "$hash" ]]; then
  hash="dev"
fi

echo "stamp-emulator-commit: setting CODEX_EMULATOR_COMMIT = '$hash'"

# Platform-portable sed in-place: use a backup suffix and delete it.
for f in index.html cli-emulator/play.js; do
  if [[ ! -f "$f" ]]; then
    echo "stamp-emulator-commit: $f not found; skipping." >&2
    continue
  fi
  sed -i.bak "s/const CODEX_EMULATOR_COMMIT = '[^']*';/const CODEX_EMULATOR_COMMIT = '$hash';/" "$f"
  rm -f "$f.bak"
  # Verify the replacement actually happened — sed would silently
  # succeed even if the pattern didn't match.
  if ! grep -q "const CODEX_EMULATOR_COMMIT = '$hash';" "$f"; then
    echo "stamp-emulator-commit: WARNING — $f does not contain the expected stamp after sed." >&2
    echo "stamp-emulator-commit: current line(s) matching CODEX_EMULATOR_COMMIT in $f:" >&2
    grep -n CODEX_EMULATOR_COMMIT "$f" >&2 || true
    exit 2
  fi
done

echo "stamp-emulator-commit: done. Diff:"
git diff --stat index.html cli-emulator/play.js || true
