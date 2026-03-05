# GitButler Reference for AI Agents

Lessons learned from production use. These are empirical — verified through
actual failures, not documentation alone.

---

## Stacked Branches

### Creating stacked branches

Use `but branch new <name> --anchor <parent-branch>` to create a branch that
depends on another. GitButler manages the dependency chain automatically.

### Stacked PRs

**Always create PRs from the TOP of the stack.**

`but pr new <topmost-branch> -t --status-after` creates PRs for every branch in
the dependency chain. Running it on an intermediate branch creates only that
branch's PR and can cause 422 errors when later trying to create PRs for
branches above it (GitButler skips branches that already have `review_id` set).

**Do not use `gh pr create`.** GitButler handles stack footers and dependency
metadata automatically. Using GitHub CLI directly bypasses this and creates
orphaned PRs that don't participate in the stack.

### Squashing across stacked branches

**Never squash commits that span different branches in a stack.** Squashing a
commit from branch B into a commit in branch A collapses the branch boundary.
GitButler unapplies the destroyed branches and merges all commits into one
branch. Recovery requires manually recreating branch boundaries with
`but branch new --anchor <commit>`.

---

## Locked Hunks

When `but status` shows `🔒 <commit-sha>` next to a file, the modified lines
overlap with changes already in that commit. The hunk is "locked" to that
commit's branch.

### What works

- `but commit <branch> -m "..." --changes <id>` — creates a new commit on the
  branch. Works even for locked hunks.
- `but amend <file-id> <commit-id>` — amends into the locked commit. This is the
  intended flow but has known issues (see below).

### What fails

- `but amend` on locked hunks in stacked branches can cause catastrophic
  workspace corruption. Conflict artifacts (`.auto-resolution/`,
  `.conflict-base-0/`, `.conflict-side-0/`, `.conflict-files`) flood the working
  directory. These are copies of every file in the repo.
- `but amend` may report success ("Amended a hunk in X → new-sha") without
  actually incorporating the change. The commit SHA changes but the file content
  in the new commit is identical to the old one.

### Safe approach

1. Prefer `but commit` to create a new commit rather than amending locked hunks
2. If you must amend, take a snapshot first:
   `but oplog snapshot -m "before amend"`
3. After amending, verify the change landed: `git show <new-commit>:<file>` and
   check the content

---

## Workspace Corruption Recovery

If the workspace fills with `.auto-resolution/` and `.conflict-*` directories:

1. Try `but oplog restore <snapshot-id>` to revert to a known-good state
2. If conflict artifacts persist on disk after restore:
   - `but teardown` (returns to normal git mode)
   - `rm -rf .auto-resolution .conflict-base-0 .conflict-side-0 .conflict-files`
   - `but setup --status-after` (re-enters GitButler mode)
3. Verify with `but status` — workspace should be clean

The oplog restore fixes GitButler's internal state but may not clean up
filesystem artifacts. The teardown/setup cycle re-materializes the workspace
from the commit tree, but the conflict files are embedded in the workspace
commit's tree object and get re-created. Physical deletion is required.

---

## Push Behavior

### Branches created with `but branch new --anchor`

These branches may not have upstream tracking metadata. `but push` only pushes
branches it believes have unpushed commits based on internal tracking — not
actual remote state. If GitButler thinks a branch is already pushed (stale
metadata), `but push` silently does nothing.

### When push silently fails

If `but push <branch>` produces no output and the remote doesn't update:

1. Check with `but push <branch> --json` — the `branchShaUpdates` array shows
   what actually pushed
2. If the remote branch doesn't exist, create it via GitHub API:
   ```
   gh api repos/OWNER/REPO/git/refs -X POST \
     -f ref="refs/heads/BRANCH" -f sha="FULL_40_CHAR_SHA"
   ```
3. Use full 40-character SHAs — truncated SHAs cause 422 errors

### After deleting remote branches externally

GitButler's internal metadata still marks the branch as pushed. No amount of
`but push -f` or `but fetch` will re-push. Either create the remote ref via
GitHub API or use `but teardown` + `but setup` to reset tracking.

---

## Commands That Skip Pre-Commit Hooks

- `but amend` **does not** run pre-commit hooks
- `but commit` **does** run pre-commit hooks

Always prefer `but commit` for new changes. If amending, run
`prek run --all-files` afterward.

---

## Oplog and Snapshots

GitButler maintains an operation log of every mutation. Use it for safety:

- `but oplog list` — view recent operations
- `but oplog snapshot -m "description"` — create a named restore point
- `but oplog restore <id>` — revert to a previous state

**Always snapshot before risky operations** (amending locked hunks, squashing,
reordering commits in stacked branches).

---

## Branch References

**Always use full branch names, never short IDs.** `but status` assigns
2-character IDs (`wa`, `do`, `es`) for convenience, but these are opaque and
unreadable. Every `but` command that accepts a branch reference also accepts the
full branch name:

```bash
# Bad: opaque, nobody can review what this does
but push wa
but commit wa -m "fix typo"

# Good: self-documenting, reviewable
but push feature/wallet-turnkey
but commit feature/wallet-turnkey -m "fix typo"
```

This applies to all commands: `but push`, `but commit`, `but amend`,
`but apply`, `but unapply`, `but pr new`, `but squash`, and any other command
that takes a branch argument. The user must be able to see exactly which branch
is being operated on without cross-referencing `but status` output.

---

## Common Pitfalls

| Pitfall                                    | Consequence                     | Prevention                          |
| ------------------------------------------ | ------------------------------- | ----------------------------------- |
| `gh pr create` instead of `but pr new`     | Orphaned PRs, no stack metadata | Always use `but pr new`             |
| Squash across branch boundaries            | Branch structure collapses      | Only squash within a single branch  |
| Amend locked hunks in stacked branches     | Workspace corruption            | Snapshot first; prefer `but commit` |
| Push after external remote branch deletion | Silent no-op                    | Create remote ref via `gh api`      |
| Truncated SHA in GitHub API calls          | 422 error                       | Always use full 40-char SHA         |
| `but amend` without hooks                  | Formatting/lint violations      | Run `prek run --all-files` after    |
