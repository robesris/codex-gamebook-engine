#!/bin/bash
# Convenience wrapper: runs an action against the current state file and prints
# only the summary + available actions, suppressing the full state JSON.
# Usage: ./step.sh <state-file> <action> [args...]
STATE="$1"
shift
node "$(dirname "$0")/play.js" act "$STATE" "$@" | python3 -c "
import json, sys
e = json.load(sys.stdin)
print('---')
print(e.get('summary', ''))
print()
print('Available actions:')
for a in e.get('available_actions', []):
    if a.get('name') in ('state', 'manual_set'): continue
    line = f\"  - {a['name']}\"
    if a.get('description'): line += f\": {a['description']}\"
    if a.get('text'): line += f\" → {a['text']} (target {a.get('target')})\"
    if a.get('available') is False: line += f\"  [disabled: {a.get('reason')}]\"
    print(line)
"
