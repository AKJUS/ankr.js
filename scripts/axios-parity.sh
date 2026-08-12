#!/usr/bin/env bash
# Differential proof for the axios 0.x -> 1.x bump.
#
# The contract suite in test/provider.test.ts describes behaviour the SDK is
# supposed to have REGARDLESS of which axios major is underneath. So run it against
# both and require both green. A test that passes on one major and fails on the
# other is the silent behaviour change this bump could otherwise ship: it does not
# crash, it surfaces downstream as a consumer reading a field that moved.
#
# THIS SCRIPT'S ONLY JOB IS TO BE A PROOF, so its own failure mode must not be a
# false pass. Two things are therefore checked explicitly rather than assumed:
#
#   1. `yarn add` really succeeded. `set -e` does NOT help here: a function invoked
#      as `run_against ... || fail=1` runs with errexit suppressed for its whole
#      body, so a failed install would fall through to the tests.
#   2. The version now on disk is the one this leg asked for. Without that, a failed
#      or no-op install leaves the previous axios in place and the leg reports a
#      pass for a version it never ran.
#
# Both legs install an EXACT version (the declared range is resolved to a concrete
# version first) so the check is an equality, not a range guess.
set -euo pipefail

cd "$(dirname "$0")/.."

OLD="${AXIOS_OLD:-0.30.3}"   # last published 0.x, what every released SDK resolves
LOG="$(mktemp)"

declared() { node -e "console.log(require('./package.json').dependencies.axios)"; }
installed() { node -e "console.log(require('./node_modules/axios/package.json').version)"; }

# Highest concrete version satisfying a range, so both legs can pin exactly.
resolve() {
  npm view "axios@$1" version --json 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const v=JSON.parse(s||'null');
  const list=Array.isArray(v)?v:[v];
  if(!list.length||!list[0]){process.exit(1)}
  console.log(list[list.length-1]);
});"
}

DECLARED="$(declared)"
NEW="${AXIOS_NEW:-$DECLARED}"

# Snapshot the two files an install rewrites, and restore them byte-for-byte on
# exit. Restoring package.json alone is not enough: yarn v1 `add` also rewrites
# yarn.lock, which pins the very dependency under test, so a parity run would
# otherwise leave the tree dirty in that file and fail a `git diff --exit-code`
# gate. Copies rather than `git checkout`, so an uncommitted local edit survives.
SNAP="$(mktemp -d)"
cp package.json "$SNAP/package.json"
[ -f yarn.lock ] && cp yarn.lock "$SNAP/yarn.lock"
restore() {
  echo
  echo "--- restoring package.json + yarn.lock and reinstalling ${DECLARED}"
  cp "$SNAP/package.json" package.json
  [ -f "$SNAP/yarn.lock" ] && cp "$SNAP/yarn.lock" yarn.lock
  yarn install --silent >/dev/null 2>&1 || true
  rm -rf "$SNAP" "$LOG"
}
trap restore EXIT

run_against() {
  local want="$1" label="$2"
  echo
  echo "=============================================================="
  echo " ${label}: axios@${want}"
  echo "=============================================================="

  if ! yarn add --silent "axios@${want}" >"$LOG" 2>&1; then
    echo "INSTALL FAILED for axios@${want}:"
    cat "$LOG"
    return 1
  fi

  local got
  got="$(installed)"
  if [ "$got" != "$want" ]; then
    echo "VERSION MISMATCH: asked for ${want}, node_modules has ${got}."
    echo "Refusing to report a result for a version this leg did not run."
    return 1
  fi
  echo "resolved axios ${got} (verified on disk)"

  if yarn --silent test; then
    echo "RESULT ${label} (axios ${got}): PASS"
    return 0
  fi
  echo "RESULT ${label} (axios ${got}): FAIL"
  return 1
}

OLD_EXACT="$(resolve "$OLD")"
NEW_EXACT="$(resolve "$NEW")"
echo "baseline range ${OLD} -> ${OLD_EXACT}"
echo "target   range ${NEW} -> ${NEW_EXACT}"
if [ "$OLD_EXACT" = "$NEW_EXACT" ]; then
  echo "Both legs resolve to ${OLD_EXACT}; there is nothing to compare." >&2
  exit 1
fi

fail=0
run_against "$OLD_EXACT" "BASELINE (pre-bump)" || fail=1
run_against "$NEW_EXACT" "TARGET (post-bump)" || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "PARITY OK: the contract suite is green on axios ${OLD_EXACT} and on ${NEW_EXACT},"
  echo "each verified as the version actually on disk for its leg."
  echo "The observable HTTP behaviour of AnkrProvider is unchanged by the major bump."
else
  echo "PARITY NOT ESTABLISHED. Read the output above: either a leg's suite failed"
  echo "(a real behaviour difference) or a leg could not be set up (no proof at all)."
  exit 1
fi
