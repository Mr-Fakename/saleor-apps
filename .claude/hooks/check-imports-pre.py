#!/usr/bin/env python3
"""
Pre-hook to block known-incorrect import patterns in saleor-apps.
Catches common mistakes that agents make when creating new apps:
  - Using legacy import paths (e.g., @saleor/app-sdk/const)
  - Using non-existent Macaw UI prop patterns
  - Placing test files inside pages/ directory

Triggers on: PreToolUse for Edit|Write|MultiEdit
"""

import json
import sys
import re
from pathlib import Path


# Known WRONG import → correct import
BLOCKED_IMPORTS = {
    r'from\s+["\']@saleor/app-sdk/const["\']': {
        "message": "BLOCKED: '@saleor/app-sdk/const' does not exist in this version",
        "fix": "Use '@saleor/app-sdk/headers' instead (exports SALEOR_API_URL_HEADER, SALEOR_AUTHORIZATION_BEARER_HEADER)",
    },
    r'from\s+["\']@saleor/app-sdk/APL/dynamodb["\']': {
        "message": "BLOCKED: '@saleor/app-sdk/APL/dynamodb' — check actual export path",
        "fix": "Verify the correct import path by checking node_modules/@saleor/app-sdk/APL/",
    },
}

# Macaw UI patterns that don't exist in v1.3.1 (the installed version)
BLOCKED_MACAW_PATTERNS = [
    {
        "pattern": r'<Text\s+[^>]*variant\s*=',
        "message": "BLOCKED: Macaw UI v1.3.1 Text component does not accept 'variant' prop",
        "fix": "Use `size` (number) and `fontWeight` ('bold'|'regular') instead. Example: <Text size={7} fontWeight=\"bold\">",
    },
    {
        "pattern": r'<Button\s+[^>]*size\s*=\s*["\']small["\']',
        "message": "BLOCKED: Macaw UI v1.3.1 Button does not accept size='small'",
        "fix": "Remove the size prop or check Macaw UI docs for valid props",
    },
]

# Test files must NOT be placed in pages/ directory (Next.js treats them as routes)
TEST_IN_PAGES_PATTERN = r'pages/.*__tests__|pages/.*\.test\.|pages/.*\.spec\.'


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name not in ["Edit", "Write", "MultiEdit"]:
        sys.exit(0)

    file_path = tool_input.get("file_path", "")
    if not file_path:
        sys.exit(0)

    # Only check saleor-apps TypeScript files
    if "saleor-apps" not in file_path:
        sys.exit(0)

    path = Path(file_path)
    if path.suffix not in [".ts", ".tsx"]:
        sys.exit(0)

    # Get content being written
    content = ""
    if tool_name == "Edit":
        content = tool_input.get("new_string", "")
    elif tool_name == "Write":
        content = tool_input.get("content", "")
    elif tool_name == "MultiEdit":
        edits = tool_input.get("edits", [])
        content = "\n".join(edit.get("new_string", "") for edit in edits)

    if not content:
        sys.exit(0)

    # Check 1: Block test files in pages/ directory
    if re.search(TEST_IN_PAGES_PATTERN, file_path.replace("\\", "/")):
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"BLOCKED: Cannot place test files inside pages/ directory.\n"
                    f"File: {file_path}\n"
                    f"Next.js treats every file in pages/ as a route — test files become API endpoints.\n"
                    f"Move test to: src/__tests__/ or alongside the module being tested (e.g., src/modules/<module>/__tests__/)"
                ),
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    # Check 2: Block wrong imports
    for pattern, info in BLOCKED_IMPORTS.items():
        if re.search(pattern, content):
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"{info['message']}\n"
                        f"Fix: {info['fix']}\n"
                        f"Always verify import paths against existing apps (smtp, cms, avatax) — NOT example-* apps."
                    ),
                }
            }
            print(json.dumps(output))
            sys.exit(0)

    # Check 3: Block wrong Macaw UI patterns
    for macaw_rule in BLOCKED_MACAW_PATTERNS:
        if re.search(macaw_rule["pattern"], content):
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        f"{macaw_rule['message']}\n"
                        f"Fix: {macaw_rule['fix']}\n"
                        f"Verify component APIs by reading existing app pages (e.g., apps/smtp/src/pages/)"
                    ),
                }
            }
            print(json.dumps(output))
            sys.exit(0)

    # All checks passed
    sys.exit(0)


if __name__ == "__main__":
    main()
