---
name: apps-commit
description: Commit changes in saleor-apps with per-app GraphQL codegen and Turborepo-aware workflow. Use when asked to "commit", "commit changes", or any git commit task in saleor-apps/.
---

# Apps Commit

## Workflow

1. Run `git status` and `git diff` (staged + unstaged) to understand all changes
2. Detect which app(s) have changes (from `apps/<app-name>/` paths)
3. Stage relevant files with `git add` (specific files, never `git add -A`)
4. For each app with `.graphql` file changes:
   - Run `pnpm --filter <app-name> generate`
   - Stage the generated file: `git add apps/<app-name>/generated/graphql.ts`
5. Write a comprehensive commit message using HEREDOC format
6. Run `git commit`
7. If lint-staged fails, follow error resolution below and retry

## Detecting Changed Apps

From `git status` output, extract app names:
```
apps/saleor-app-taxes/src/... → app is "saleor-app-taxes"
apps/smtp/src/...              → app is "smtp"
```

## Commit Message Format

```bash
git commit -m "$(cat <<'EOF'
Short summary of changes

Detailed description of what was changed and why.
List specific modifications when multiple files are affected.

EOF
)"
```

## Changesets

If the change is functional (user-facing feature, bug fix, enhancement):
- Prompt the user about whether a changeset is needed
- If yes: `pnpm changeset` and follow the prompts

Skip changesets for: internal refactors, code style, tests, CI, docs.

## Lint-Staged Failure Recovery

1. Read the error output to identify issues
2. Fix the reported issues
3. Stage the fixed files: `git add <files>`
4. Retry the commit (new commit, not `--amend`)

## Rules

- **Never** use `git add -A` or `git add .`
- Per-app codegen: use `pnpm --filter <app-name> generate`, not a global generate
- Generated files in `apps/<app>/generated/` must be committed alongside `.graphql` changes
- Include `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` in the commit message
