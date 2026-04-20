#!/bin/bash

# Check if there are any changes in apps/ or src/ directory
changed_apps=$(git diff --name-only HEAD | grep -oP '^apps/[^/]+' | sort -u)

if [ -z "$changed_apps" ]; then
    echo 'ℹ️ No changes in apps/ directory, skipping validation' >&2
    exit 0
fi

echo '🔍 Running final validation for changed apps...' >&2

failed=0

for app_dir in $changed_apps; do
    app_name=$(basename "$app_dir")
    echo "  Checking $app_name..." >&2

    # Run type checking for the specific app
    if ! pnpm --filter "$app_name" exec tsc --noEmit 2>&1; then
        echo "❌ TypeScript validation failed for $app_name" >&2
        failed=1
    fi

    # Run linting for the specific app
    if ! pnpm --filter "$app_name" lint 2>&1; then
        echo "❌ ESLint validation failed for $app_name" >&2
        failed=1
    fi
done

if [ $failed -ne 0 ]; then
    echo '❌ Validation failed - please fix errors before completing the task' >&2
    exit 2
fi

echo '✅ All validations passed!' >&2
exit 0
