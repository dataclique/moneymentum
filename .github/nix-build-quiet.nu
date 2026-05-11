#!/usr/bin/env nu
# Wrapper that runs `nix build <target>` while filtering noisy progress
# chatter (`building '/nix/store/...'`, `copying path '...'`, etc.) so
# real build errors stay visible in CI logs. Failure output (error
# messages, last log lines from the failing derivation) is preserved
# verbatim.
#
# Usage:
#   .github/nix-build-quiet.nu .#some-package

def main [target: string] {
  let result = (^nix build $target | complete)
  let filter_re = '^(building |copying path |Resolving deltas:|Receiving objects:|Counting objects:|Compressing objects:|remote: |From |\s+\* \[new (branch|tag|ref)\])'

  if ($result.stdout | str length) > 0 {
    print -n $result.stdout
  }

  let filtered = (
    $result.stderr
    | lines
    | where {|line| not ($line =~ $filter_re)}
    | str join "\n"
  )
  if ($filtered | str length) > 0 {
    print -e $filtered
  }

  exit $result.exit_code
}
