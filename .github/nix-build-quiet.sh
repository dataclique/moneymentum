#!/usr/bin/env bash
# Run `nix build` (or any nix command) while filtering progress chatter that
# buries real errors in GitHub Actions logs. Failure output (error: builder for
# '...drv' failed, last log lines, etc.) is preserved verbatim.
#
# Usage: .github/nix-build-quiet.sh build .#some-package
set -eo pipefail

exec nix "$@" 2> >(grep --line-buffered -vE \
  "^(building '|copying path '|Resolving deltas:|Receiving objects:|Counting objects:|Compressing objects:|remote: |From [^[:space:]]+$|\\s+\\* \\[new (branch|tag|ref)\\])" >&2)
