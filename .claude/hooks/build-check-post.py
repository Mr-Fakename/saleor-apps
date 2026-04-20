#!/usr/bin/env python3
"""
Post-hook to track code changes and recommend build verification.
After Write/Edit to app source files (not test files), emits a system message
reminding the agent to run `next build` and `vitest run` before reporting completion.

Triggers on: PostToolUse for Edit|Write|MultiEdit
"""

import json
import sys
import os
from pathlib import Path


# Track changes in a temp file per session
CHANGE_TRACKER = Path(os.environ.get("TMPDIR", "/tmp")) / "saleor-apps-change-tracker.json"

# Files that indicate significant structural changes requiring build verification
STRUCTURAL_PATTERNS = [
    "pages/api/",        # API routes
    "pages/",            # Page components
    "_app.tsx",          # App wrapper
    "next.config",       # Build config
    "package.json",      # Dependencies
    "tsconfig.json",     # TypeScript config
    "modules/trpc/",     # tRPC setup
    "saleor-app.ts",     # App initialization
]


def load_tracker():
    try:
        if CHANGE_TRACKER.exists():
            return json.loads(CHANGE_TRACKER.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"apps": {}, "build_reminded": {}}


def save_tracker(data):
    try:
        CHANGE_TRACKER.write_text(json.dumps(data))
    except OSError:
        pass


def get_app_name(file_path: str) -> str | None:
    """Extract app name from file path like apps/<name>/src/..."""
    path = Path(file_path)
    parts = path.parts

    # Look for apps/<name> pattern
    for i, part in enumerate(parts):
        if part == "apps" and i + 1 < len(parts):
            return parts[i + 1]
    return None


def is_structural_change(file_path: str) -> bool:
    """Check if the file change is structural (affects build)."""
    return any(pattern in file_path for pattern in STRUCTURAL_PATTERNS)


def is_test_file(file_path: str) -> bool:
    """Check if the file is a test file."""
    return ".test." in file_path or ".spec." in file_path or "/__tests__/" in file_path


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

    # Only track saleor-apps files
    if "saleor-apps" not in file_path:
        sys.exit(0)

    # Skip test files for structural tracking
    if is_test_file(file_path):
        sys.exit(0)

    app_name = get_app_name(file_path)
    if not app_name:
        sys.exit(0)

    tracker = load_tracker()

    # Track the change
    if app_name not in tracker["apps"]:
        tracker["apps"][app_name] = {"files": [], "structural_count": 0}

    app_data = tracker["apps"][app_name]
    if file_path not in app_data["files"]:
        app_data["files"].append(file_path)

    if is_structural_change(file_path):
        app_data["structural_count"] = app_data.get("structural_count", 0) + 1

    save_tracker(tracker)

    # Emit build reminder after 5+ file changes or any structural change
    file_count = len(app_data["files"])
    structural = app_data["structural_count"]
    already_reminded = tracker.get("build_reminded", {}).get(app_name, False)

    if (file_count >= 5 or structural >= 1) and not already_reminded:
        tracker.setdefault("build_reminded", {})[app_name] = True
        save_tracker(tracker)

        output = {
            "systemMessage": (
                f"⚠️ BUILD CHECK NEEDED for {app_name}\n"
                f"You've modified {file_count} files ({structural} structural). "
                f"Before reporting this work as complete, you MUST:\n"
                f"  1. Run `cd saleor-apps/apps/{app_name} && npx next build` to verify the build\n"
                f"  2. Run `cd saleor-apps/apps/{app_name} && npx vitest run` to verify tests pass\n"
                f"  3. Fix any errors before continuing\n"
                f"Do NOT delegate these to a sub-agent — run them directly."
            )
        }
        print(json.dumps(output))

    sys.exit(0)


if __name__ == "__main__":
    main()
