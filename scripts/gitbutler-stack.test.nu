#!/usr/bin/env nu
# Tests for gitbutler-stack.nu. Run directly: `nu gitbutler-stack.test.nu`
# (also runs in the package's checkPhase). Exits nonzero on the first
# failed assertion.

use std assert
use ./gitbutler-stack.nu *

# Mirrors `but status -j`: stacks tip-first, branches tip-first, reviewId
# rendered as "(#NNN)" or null, commits a list whose length is the count
# ahead of base.
const STATUS_JSON = '{
  "stacks": [
    { "branches": [
        { "name": "feat/tip",  "reviewId": "(#103)", "commits": [ {"message": "c"} ] },
        { "name": "feat/mid",  "reviewId": null,     "commits": [ {"message": "c"}, {"message": "d"} ] },
        { "name": "feat/base", "reviewId": "(#101)", "commits": [ {"message": "c"} ] }
    ] },
    { "branches": [
        { "name": "other/tip",  "reviewId": "(#205)", "commits": [ {"message": "c"} ] },
        { "name": "other/base", "reviewId": null,     "commits": [ {"message": "c"} ] }
    ] }
  ]
}'

def fixture []: nothing -> record {
  $STATUS_JSON | from json
}

# parse-stacks flips each stack base-first, numbers stacks, and pulls PR
# numbers and commit counts.
let parsed = (parse-stacks (fixture))

assert equal ($parsed | get branch) [feat/base feat/mid feat/tip other/base other/tip]
assert equal ($parsed | get stack) [0 0 0 1 1]
assert equal ($parsed | get pr) [101 null 103 null 205]
assert equal ($parsed | get commits) [1 2 1 1 1]

# trim-range with no bounds is the identity.
assert equal (parse-stacks (fixture) | trim-range | get branch) [feat/base feat/mid feat/tip other/base other/tip]

# --start keeps the sweep from the named branch upward, crossing stacks.
assert equal (parse-stacks (fixture) | trim-range --start feat/mid | get branch) [feat/mid feat/tip other/base other/tip]

# --end stops at the named branch.
assert equal (parse-stacks (fixture) | trim-range --end feat/tip | get branch) [feat/base feat/mid feat/tip]

# both bounds select the inclusive subrange.
assert equal (parse-stacks (fixture) | trim-range --start feat/mid --end feat/tip | get branch) [feat/mid feat/tip]

# an unknown bound is a hard error, not a silent empty sweep.
assert error {|| parse-stacks (fixture) | trim-range --start nope }

# end before start in sweep order is rejected.
assert error {|| parse-stacks (fixture) | trim-range --start feat/tip --end feat/base }

# An empty workspace (no applied stacks) is a valid no-op sweep, not a range error.
assert equal (parse-stacks {stacks: []}) []
assert equal (parse-stacks {stacks: []} | trim-range) []

# But a bound named against an empty workspace is still a hard error -- a typo'd
# --start is reported, not silently swallowed by the no-op shortcut.
assert error {|| parse-stacks {stacks: []} | trim-range --start nope }

print "gitbutler-stack: all tests passed"
