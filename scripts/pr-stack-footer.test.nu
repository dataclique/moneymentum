#!/usr/bin/env nu
# Tests for pr-stack-footer.nu. Run directly: `nu pr-stack-footer.test.nu`
# (also runs in the package's checkPhase). Exits nonzero on the first
# failed assertion. Only the pure footer functions are exercised; the
# `but`/`gh` I/O in `main` is not invoked.

use std assert
use ./pr-stack-footer.nu *

# build-footer numbers the stack base-first (position 1 = bottom), lists
# it top-first, and points at the current PR -- byte-for-byte the shape
# GitButler emits.
const EXPECTED = "<!-- GitButler Footer Boundary Top -->
---
This is **part 2 of 3 in a stack** made with GitButler:
- <kbd>&nbsp;3&nbsp;</kbd> #268
- <kbd>&nbsp;2&nbsp;</kbd> #266 👈
- <kbd>&nbsp;1&nbsp;</kbd> #264
<!-- GitButler Footer Boundary Bottom -->"

assert equal (build-footer [264 266 268] 266) $EXPECTED

# The bottom PR is part 1; the top PR is part N.
assert ((build-footer [264 266 268] 264) | str contains "part 1 of 3")
assert ((build-footer [264 266 268] 268) | str contains "part 3 of 3")

# Exactly one pointer, on the current PR.
assert equal ((build-footer [264 266 268] 266) | split row "👈" | length) 2
assert ((build-footer [264 266 268] 268) | str contains "#268 👈")

# A single-PR lane renders as a 1-of-1 footer so every forest PR carries one.
assert ((build-footer [286] 286) | str contains "part 1 of 1")
assert ((build-footer [286] 286) | str contains "#286 👈")
assert equal ((build-footer [286] 286) | lines | where ($it | str starts-with "- ") | length) 1

# splice-footer replaces an existing footer region and keeps the prose.
let body_with_footer = "## Motivation

Some prose.

<!-- GitButler Footer Boundary Top -->
---
This is **part 5 of 17 in a stack** made with GitButler:
- <kbd>&nbsp;1&nbsp;</kbd> #256
<!-- GitButler Footer Boundary Bottom -->"
let fresh = (build-footer [264 266 268] 264)
let spliced = (splice-footer $body_with_footer $fresh)

assert ($spliced | str contains "## Motivation")
assert ($spliced | str contains "Some prose.")
assert ($spliced | str contains "part 1 of 3")
assert (not ($spliced | str contains "part 5 of 17"))
assert (not ($spliced | str contains "#256"))
# The boundary markers appear exactly once after a splice.
assert equal ($spliced | split row "<!-- GitButler Footer Boundary Top -->" | length) 2

# splice-footer appends when the body has no footer yet, keeping the body.
let bare_body = "## Motivation

No footer here."
let appended = (splice-footer $bare_body $fresh)

assert ($appended | str starts-with "## Motivation")
assert ($appended | str contains "part 1 of 3")
assert ($appended | str contains "<!-- GitButler Footer Boundary Bottom -->")

# build-footer errors loudly when the current PR is absent from the stack
# list, instead of crashing on an empty stream.
assert error {|| build-footer [264 266 268] 999 }

# splice-footer repairs a body left with a single dangling boundary marker
# instead of appending a second footer beside the orphan. A truncated footer
# (top marker, no bottom) is dropped whole -- markers and stray lines alike --
# while the real prose above it survives.
let orphan_top = "## Motivation

Prose.

<!-- GitButler Footer Boundary Top -->
---
a truncated footer with no bottom marker"
let repaired = (splice-footer $orphan_top (build-footer [286] 286))
assert equal ($repaired | split row "<!-- GitButler Footer Boundary Top -->" | length) 2
assert equal ($repaired | split row "<!-- GitButler Footer Boundary Bottom -->" | length) 2
assert (not ($repaired | str contains "a truncated footer"))
assert ($repaired | str contains "## Motivation")
assert ($repaired | str contains "Prose.")

# An orphan bottom marker (no top) is repaired conservatively: the dangling
# marker line is dropped, the prose is kept, and a clean footer is appended.
let orphan_bottom = "## Motivation

Prose.
<!-- GitButler Footer Boundary Bottom -->"
let repaired_bottom = (splice-footer $orphan_bottom (build-footer [286] 286))
assert equal ($repaired_bottom | split row "<!-- GitButler Footer Boundary Top -->" | length) 2
assert equal ($repaired_bottom | split row "<!-- GitButler Footer Boundary Bottom -->" | length) 2
assert ($repaired_bottom | str contains "Prose.")

# stacks-with-prs flips each stack base-first, extracts PR numbers, drops
# null-reviewId branches, and omits stacks carrying no PR at all.
let status = {stacks: [
  {branches: [
    {name: "tip", reviewId: "(#103)", commits: [{}]}
    {name: "mid", reviewId: null, commits: [{}]}
    {name: "base", reviewId: "(#101)", commits: [{}]}
  ]}
  {branches: [
    {name: "solo", reviewId: null, commits: [{}]}
  ]}
]}
assert equal ($status | stacks-with-prs) [[101 103]]

# footer-jobs flattens each stack's PR list into one job per PR, preserving
# stack order and pairing every PR with its full stack list so the footer
# can be built with the right position and total.
assert equal (footer-jobs [[101 103] [205]]) [
  {prs: [101 103], pr: 101}
  {prs: [101 103], pr: 103}
  {prs: [205], pr: 205}
]

# An empty workspace yields no jobs.
assert equal (footer-jobs []) []

print "pr-stack-footer: all tests passed"
