#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

if echo "$COMMAND" | grep -qE '^git (commit|push|checkout|branch|merge|rebase|stash|reset|restore|add|tag) '; then
  cat << 'HOOK'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "use gitbutler. run 'but' instead of 'git' for all write operations."
  }
}
HOOK
  exit 0
fi

if echo "$COMMAND" | grep -qE '^gh pr (create|merge|ready|edit) '; then
  cat << 'HOOK'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "use gitbutler. run 'but pr new' instead of 'gh pr create'. use 'but' for all PR operations."
  }
}
HOOK
  exit 0
fi

exit 0
