#!/usr/bin/env nu
# Enumerate a GitButler workspace's branches in sweep order -- every
# applied stack walked from its base commit up to its tip, so a caller
# visits each branch parent-before-child. Built for stack-wide tooling
# (review sweeps, fmt/clippy gates) that scopes and acts on one branch
# at a time.
#
# `but status -j` lists stacks tip-first; this flips each stack to
# base-first and flattens the workspace into one ordered table:
#
#   stack   branch                      pr     commits
#   0       feat/factor-sma-zscore             1
#   0       chore/factors-submodules           1
#   ...
#   1       feat/risk-frontend          352    1
#
# Usage:
#   gitbutler-stack                          # whole workspace, base -> tip
#   gitbutler-stack --start feat/risk-var    # subrange from a branch upward
#   gitbutler-stack --end feat/risk-frontend # subrange up to a branch
#   gitbutler-stack --json-file status.json  # parse a saved `but status -j`

# Order the branches of a parsed `but status -j` record into a sweep
# table, base-first within each stack. Columns: stack (0-based stack
# index), branch, pr (PR number or null), commits (count ahead of base).
export def parse-stacks [status: record]: nothing -> table {
  $status.stacks
  | enumerate
  | each {|stack|
      $stack.item.branches
      | reverse
      | each {|branch| {
          stack: $stack.index
          branch: $branch.name
          pr: ($branch.reviewId? | parse-pr-number)
          commits: ($branch.commits | length)
        }}
    }
  | flatten
}

# Trim an ordered sweep table to the inclusive [start, end] subrange,
# matched by branch name against the flat sweep order. An empty bound
# is unbounded on that side. Errors if a named branch is absent or the
# end precedes the start.
export def trim-range [
  --start: string = ""
  --end: string = ""
]: table -> table {
  let branches = $in

  # An empty workspace with no bounds is a valid no-op sweep. With a bound,
  # fall through so the named branch is reported as not-in-stack rather than
  # silently swallowed.
  if (($branches | is-empty) and ($start | is-empty) and ($end | is-empty)) {
    return $branches
  }

  let names = ($branches | get branch)

  let start_idx = if ($start | is-empty) {
    0
  } else {
    $names | index-of $start "--start"
  }

  let end_idx = if ($end | is-empty) {
    ($branches | length) - 1
  } else {
    $names | index-of $end "--end"
  }

  if $start_idx > $end_idx {
    error make {msg: "--end precedes --start in sweep order"}
  }

  $branches | enumerate | where index >= $start_idx and index <= $end_idx | get item
}

# Position of a branch name in the sweep order, or a labelled error.
def index-of [name: string, flag: string]: list -> int {
  let found = ($in | enumerate | where item == $name)

  if ($found | is-empty) {
    error make {msg: $"($flag) branch not in stack: ($name)"}
  }

  $found.0.index
}

# Extract the integer PR number from a GitButler reviewId like "(#352)".
# Null or unmatched input yields null.
def parse-pr-number []: any -> any {
  let review_id = $in

  if ($review_id | is-empty) {
    return null
  }

  let matched = ($review_id | parse --regex '#(?<num>\d+)')

  if ($matched | is-empty) { null } else { $matched.0.num | into int }
}

def main [
  --start: string = ""      # first branch of the sweep subrange (inclusive)
  --end: string = ""        # last branch of the sweep subrange (inclusive)
  --json-file: string = ""  # read `but status -j` output from a file instead of running it
]: nothing -> table {
  let status = if ($json_file | is-empty) {
    ^but status -j | from json
  } else {
    open --raw $json_file | from json
  }

  parse-stacks $status | trim-range --start $start --end $end
}
