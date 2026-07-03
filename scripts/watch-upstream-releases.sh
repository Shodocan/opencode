#!/usr/bin/env bash
# watch-upstream-releases.sh — emits the upstream latest stable version forever.
# The opencode-monitor plugin watches this output; when a new stable tag appears
# (anything != the state marker), the --regex match wakes the agent to run the
# republish pipeline per RELEASE_MONITOR.md.
#
# Output: one line per poll — the latest stable semver tag (e.g. "v1.17.11").
# Exit: never (forever loop). The monitor plugin owns lifecycle.
#
# Safety: read-only polling; no writes, no network mutation. Stateless on its own.
set -euo pipefail

REPO="anomalyco/opencode"
INTERVAL_SECONDS="${RELEASE_MONITOR_INTERVAL_SECONDS:-21600}"  # 6h default
STATE_FILE="${RELEASE_MONITOR_STATE_FILE:-/home/wdcas/projects/pessoal/opencode-mcp-pr/.release-monitor-state}"

while true; do
  # gh may fail transiently (rate limit, network). Emit nothing on failure so the
  # monitor regex never matches a partial/garbage value; retry next interval.
  latest="$(gh release list --repo "$REPO" --limit 20 2>/dev/null \
    | awk '{print $3}' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -1 || true)"

  if [[ -n "$latest" ]]; then
    marker="$(cat "$STATE_FILE" 2>/dev/null || echo "0.0.0")"
    # Normalize both sides to the bare base version (no "v" prefix, no "-RCn"
    # suffix) so a clean release and its bug-fix republishes compare equal.
    # The Makefile record step writes "1.17.13-RC2" (fork version); gh emits
    # "v1.17.13" (upstream tag). Strip "v" and "-RCn" from both before comparing.
    norm_latest="${latest#v}"; norm_latest="${norm_latest%%-RC*}"
    norm_marker="${marker#v}"; norm_marker="${norm_marker%%-RC*}"
    # Only emit when upstream has moved past the state marker. Any output line =
    # "new stable release detected — wake the agent". The monitor --regex matches
    # any semver tag; silence means idle.
    if [[ "$norm_latest" != "$norm_marker" ]]; then
      echo "$latest"
    fi
  fi

  sleep "$INTERVAL_SECONDS"
done