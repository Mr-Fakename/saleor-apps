#!/usr/bin/env python3
"""
Runs per-app GraphQL codegen when .graphql files are modified in saleor-apps.
Detects which app from file path, runs pnpm --filter <app> generate.
"""

import json
import sys
import os
import re
from pathlib import Path

try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    # Handle different tool types
    files_to_check = []

    if tool_name in ["Edit", "Write"]:
        file_path = tool_input.get("file_path", "")
        if file_path:
            files_to_check.append(file_path)

    elif tool_name == "MultiEdit":
        edits = tool_input.get("edits", [])
        for edit in edits:
            file_path = edit.get("file_path", "")
            if file_path:
                files_to_check.append(file_path)

    # Find .graphql files and detect which app they belong to
    apps_needing_codegen = set()
    for file_path in files_to_check:
        if not file_path.endswith(".graphql"):
            continue
        # Extract app name from path like apps/<app-name>/...
        match = re.search(r'apps/([^/]+)/', file_path)
        if match:
            apps_needing_codegen.add(match.group(1))

    if not apps_needing_codegen:
        sys.exit(0)

    # Show a message that generation is starting
    app_list = ", ".join(sorted(apps_needing_codegen))
    output = {
        "systemMessage": f"🔄 GraphQL files changed in [{app_list}], regenerating types..."
    }
    print(json.dumps(output))
    sys.stdout.flush()

    # Run codegen for each affected app
    import subprocess
    all_success = True
    errors = []

    for app_name in sorted(apps_needing_codegen):
        process = subprocess.Popen(
            f"pnpm --filter {app_name} generate 2>&1",
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
        stdout, _ = process.communicate()
        result = process.returncode

        if "Syntax Error:" in stdout or "Failed to load" in stdout:
            error_lines = [line for line in stdout.split('\n') if 'Syntax Error' in line or 'Failed to load' in line]
            errors.append(f"{app_name}: {'; '.join(error_lines[:2])}")
            all_success = False
        elif result != 0:
            errors.append(f"{app_name}: codegen failed (exit {result})")
            all_success = False

    if not all_success:
        error_msg = '\n'.join(errors)
        error_output = {
            "decision": "block",
            "reason": f"❌ GraphQL codegen failed!\n{error_msg}\n\nPlease fix the errors before continuing.",
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": "GraphQL code generation failed for one or more apps."
            }
        }
        print(json.dumps(error_output))
        sys.exit(0)
    else:
        success_output = {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": f"✅ GraphQL types regenerated successfully for [{app_list}]"
            },
            "systemMessage": f"✅ GraphQL types regenerated successfully for [{app_list}]"
        }
        print(json.dumps(success_output))
        sys.exit(0)

except Exception as e:
    print(f"Hook error: {e}", file=sys.stderr)
    pass
