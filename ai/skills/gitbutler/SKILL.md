---
name: gitbutler
description: "Commit, branch, push, stack PRs, and manage version control with the GitButler CLI (`but`). Use for: commit my changes, check what changed, stage a file, create a branch, stack a PR, push my branch, open a pull request, view the diff, amend/squash/reorder/reword commits, absorb changes, undo an operation, resolve conflicts, update from main. Replaces git for write operations - use `but` instead of git add, git commit, git push, git checkout, git branch, git rebase, git stash, git cherry-pick, git merge."
---

# GitButler CLI (`but`) Skill

Use the GitButler CLI (`but`) as the default version-control interface in this
repository. The dev shell provides `but` through the shared
`but.packages.${system}.gitbutler-cli` package (see `flake.nix`). Run
`direnv allow` / enter the shell, then verify with `but --version`. The commands
below target the pinned GitButler 0.22.0 CLI.

GitButler works on **virtual branches** inside a `gitbutler/workspace`
integration branch: many branches can be applied at once, either side by side
(parallel) or stacked. A stack is a chain of dependent branches -- exactly what
you want for stacked PRs.

## Non-Negotiable Rules

1. Use `but` for ALL write operations. Never run `git add`, `git commit`,
   `git push`, `git checkout`, `git switch`, `git merge`, `git rebase`,
   `git stash`, or `git cherry-pick`. If the user says a `git` write command
   (e.g. "git push"), translate it to the `but` equivalent and run that.
2. Start every write/history-edit task with `but status`. It prints the
   workspace state and the CLI IDs you need.
3. Reference entities by their **CLI IDs** from `but status` / `but diff` /
   `but show`, or by **semantic branch name**. Never hardcode or guess IDs --
   they are ephemeral. Prefer the branch name (`feat/gitbutler-skill`) over
   short stack IDs (`at`) in commands you write down. The one reserved ID is
   `zz`: the built-in unassigned/unstaged area (the workspace root), not a user
   branch -- rubbing or moving anything onto `zz` unstages/unstacks it.
4. Use `--status-after` on supported mutations when the next step needs fresh
   IDs. Otherwise, inspect `but status` when needed; IDs can change after a
   mutation.
5. Prefer `but commit` over amend. `but commit` runs the repo's pre-commit hooks
   (prek: nixfmt, eslint, rustfmt, ...); amend (`but amend` / `but rub`) skips
   them. Default to new commits; clean up history later with squash/reword.
6. Read-only git inspection is fine (`git status`, `git log`, `git blame`,
   `git show --stat`, `git diff`). Only **write** operations must go through
   `but`.
7. **Never push or open a PR without an explicit instruction to do that exact
   thing.** Local commits/branches/stacks are fine to build autonomously;
   `but push` and `but pr new` are outward-facing and require the user's
   go-ahead.

## Core Flow

```bash
but status                       # inspect state, gather CLI IDs
but branch new <name>            # only if new work needs its own branch
# ... edit files with Edit/Write ...
but status                       # refresh IDs if files changed
but commit -b <branch> -m "<msg>" <id>...  # commit selected files or hunks
```

## Common Tasks

- View history: `git log` / `git log --oneline` (read-only git is fine) or
  `but show <branch>`.
- Work on a different workspace branch: if the branch is applied, edit and
  commit to it; if not, use `but apply <branch>` first (and
  `but unapply <branch>` to remove a stack from the workspace).
- Fetch upstream changes: covered by `but pull --check` / `but pull`; no
  separate fetch step is needed.

## Inspecting State

- `but status` -- overview: unstaged files, staged files per branch, applied
  branches (stacked or parallel), commits, push status, base branch. CLI IDs
  live here.
- `but status -f` -- also list committed files. `-v` adds author/timestamp.
- `but diff` -- diff of changes, with hunk-level CLI IDs.
- `but show <commit-or-branch>` -- details for a commit or branch.

## Committing

- Commit only selected files/hunks:
  `but commit -b <branch> -m "<message>" <id1> <id2>`. Change IDs are
  positional; the branch is selected with `-b` / `--branch`.
- Commit all uncommitted changes: `but commit -b <branch> -m "<message>"`. Omit
  change IDs only when every uncommitted change belongs in that commit.
- Create a new unstacked branch while committing:
  `but commit -b <new-branch> -m "<message>" <id>...`.
- Interactive change selection: `but commit -b <branch> -i`. In 0.22, `-i` opens
  the selection TUI; it does not generate a commit message.
- Insert an empty commit above an applied commit:
  `but commit --above <commit> --empty -m "<message>"`.

## Stacking Branches (stacked PRs)

This is the headline workflow. To stack a new branch on top of an existing one:

```bash
but branch new <child> --anchor <parent-branch-or-commit>
but commit -b <child> -m "<message>" <id>...
```

`--anchor` is what makes it stacked rather than parallel. To re-stack existing
branches:

- Stack one branch on top of another: `but move <branch> <target-branch>`
- Tear a branch off the stack (unstack): `but move <branch> zz`

Keep each branch in a stack atomic and independently buildable -- one PR per
branch, smallest reviewable diff. Prefer more, smaller branches over fewer large
ones.

## Editing History

GitButler edits history without `git rebase -i`:

- `but rub <source> <target>` -- the universal verb:
  - file onto a commit -> amend the file into that commit
  - commit onto another commit -> squash them together
  - commit onto a branch -> move the commit to that branch
  - file onto a branch -> stage the file to that branch
  - anything onto `zz` -> unstage/undo it (back to the unassigned area)
- `but amend <file-id> <commit-id>` -- amend a file into a commit (skips hooks).
- `but squash <a> <b>` -- squash commits together.
- `but move <source-commit> <target-commit>` -- reorder (before; `--after` for
  after).
- `but reword <commit> -m "<message>"` -- edit a commit message.
- `but absorb` -- auto-amend uncommitted changes into the commits they belong to
  (`--dry-run` to preview).
- `but uncommit <commit-or-file-in-commit>` -- move changes back to uncommitted.

**Swapping two commits** invalidates IDs after the first move -- do it in two
steps, refreshing IDs from `but status` between them.

## Branches

- `but branch new <name> [--anchor <x>]` -- create (parallel, or stacked with
  `--anchor`).
- `but branch list` -- list branches. `but branch show <name>` -- commits ahead
  of base.
- `but branch delete <name>` -- delete.
- `but apply <branch>` / `but unapply <branch>` -- add/remove a branch from the
  workspace (unapply is the closest thing to `git stash` for a whole branch).
- `but clean` -- remove empty branches.

## Pushing and Pull Requests

> Outward-facing -- requires an explicit per-task instruction (see rule 7).

- `but push` -- push all branches with unpushed commits. `but push <branch>` for
  one. `-f`/`--with-force` to force-push after history edits.
- `but pr new` -- open a PR (or `but pr` defaults to `pr new`). Needs forge
  auth: `but config forge auth` (one-time). `but pr set-draft` / `set-ready` /
  `auto-merge` manage existing PRs.
- After creating a PR, **assign it to the user**:
  `gh pr edit <number> --add-assignee @me` (do this for every PR in a stack).
- Set good titles/descriptions with `gh pr edit <number> --body-file <file>` --
  write the body with the Write tool, never a shell heredoc.
- **Every PR closes a tracked issue.** The PR body must include
  `Closes #<issue>` pointing at a problem-only GitHub issue, and that issue must
  be a checklist item in the relevant ROADMAP.md section linking the issue and
  the PR. Create the issue and roadmap entry before (or immediately after)
  `but pr new` -- a PR without them is untracked work.

## Updating From Main

```bash
but pull --check    # is the stack cleanly mergeable onto the target?
but pull            # fetch + rebase all applied branches onto the target
```

Never use raw `git pull` / `git rebase`.

## Resolving Conflicts

Stay in `but` -- never `git add`/`git checkout --ours/--theirs` during
resolution:

```bash
but resolve <commit-id>   # enter resolution mode (writes conflict markers)
# edit files, removing <<<<<<< ======= >>>>>>> markers
but resolve status        # remaining conflicted files
but resolve finish        # finalize (only after editing) -- or: but resolve cancel
```

Do not `but amend` a conflicted commit.

## Operation History (undo)

GitButler snapshots everything, including uncommitted changes:

- `but undo` / `but redo` -- step back/forward through operations.
- `but oplog` -- list past operations. `but oplog restore <sha>` -- jump to a
  state.
- `but oplog snapshot -m "<reason>"` -- create a recovery point before a large
  edit. Prefer undo/restore over patching bad state with more history edits.

## Git-to-But Map

| git                      | but                                       |
| ------------------------ | ----------------------------------------- |
| `git status`             | `but status`                              |
| `git add` + `git commit` | `but commit -b <branch> -m "..." <id>...` |
| `git checkout -b <name>` | `but branch new <name>`                   |
| `git push`               | `but push`                                |
| `git rebase -i`          | `but move` / `but squash` / `but reword`  |
| `git rebase --onto`      | `but move <branch> <new-base>`            |
| `git stash`              | `but unapply <branch>`                    |
| `git cherry-pick`        | `but pick <commit>`                       |
| open a PR                | `but pr new`                              |

## This Repository

- **Pre-commit hooks (prek):** `prek` is the repo's pre-commit hook runner;
  `but commit` runs the enabled hooks (nixfmt, nil, eslint, prettier, taplo,
  denofmt, rustfmt; the local clippy hook is disabled). If you must
  `but amend`/`but rub` (which skip hooks), run `prek run --all-files` afterward
  and fold in any formatting fixes before pushing. Markdown is formatted by
  `deno fmt`.
- **Commit messages:** conventional, lowercase -- `feat:`, `fix:`, `docs:`,
  `chore:`, `refactor:`, `test:`. Explain _why_ in the body. Never add
  "Generated with ..." or co-author trailers.
- **Branch names:** `<type>/<kebab-description>` (e.g. `feat/gitbutler-skill`,
  `fix/optimize-beta`). Always pass an explicit name to `but branch new`.

## Maintaining This Skill

- `but skill check` compares installed skills against the CLI version and
  reports drift. Run it when command behavior diverges from this doc, then
  update the doc.
- **Do not run `but skill install` into this repo.** `.claude/skills` and
  `.cursor/skills` are symlinks to `ai/skills`, so installing would overwrite
  this curated, repo-specific SKILL.md. Use `but skill install --global` if you
  want GitButler's stock skill in your home directory instead.
- For full command syntax, use `but <command> --help` or
  https://docs.gitbutler.com/cli-overview.
