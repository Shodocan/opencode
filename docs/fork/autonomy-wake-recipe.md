# L1 timed wake — the out-of-process recipe

FORK FEATURE (13) autonomy-stack, layer 1. **Zero fork code.** Every field below was verified against a
live `opencode serve` (see `docs/artifacts/25-08-2026_autonomy-stack/research.md`, Step 6).

## Why out-of-process

An in-process timer has no viable host. A TUI timer dies on quit **and on `/reload`** (which disposes
every instance scope); headless `opencode run` breaks on the first idle `session.status` and then calls
`process.exit()`, and opens no listening socket at all. Only `opencode serve` survives — and there an
external scheduler already reaches the session over HTTP for free.

**A wake delivered this way is NOT a second continuation driver.** It enters the same process, the same
`SessionRunState`, and the same runLoop exit guard — architecturally identical to you typing. A fresh
`opencode run --session <id>` **is** a second driver (separate process ⇒ separate in-memory runners map)
and is prohibited.

## The contract (verified, not assumed)

| Field | Value |
|---|---|
| endpoint | `POST /session/:id/prompt_async` |
| success | **204 No Content** |
| auth | HTTP Basic, username **exactly `opencode`** — any other username 401s |
| auth enforced | only when `OPENCODE_SERVER_PASSWORD` is set on the serve process |
| body | `{"parts":[{"type":"text","text":"..."}]}` — **`parts` is the only required key** (`{}` → 400 `Missing key at ["parts"]`) |
| optional body keys | `agent`, `model`, `format`; a stray `sessionID` is accepted and ignored |
| `?directory=` | **NOT required.** Omitted, it routes to serve's own cwd instance. Required only when the target worktree differs from serve's cwd |
| unknown session | 404 `NotFoundError` |

## The recipe

```sh
#!/usr/bin/env sh
# wake-goal.sh — nudge one long-running session. Exits non-zero on a dead serve.
set -eu

BASE="http://127.0.0.1:4096"
SESSION="$1"
WORKTREE="$2"
: "${OPENCODE_SERVER_PASSWORD:?set OPENCODE_SERVER_PASSWORD}"

# Guard on phase: only wake an ACTIVE goal. Without this, a forgotten timer burns
# one model turn every interval forever after the goal completes -- with nobody
# watching, which is the whole premise of the feature.
PHASE=$(curl -fsS -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  "$BASE/session/$SESSION/goal?directory=$WORKTREE" | sed -n 's/.*"phase":"\([a-z]*\)".*/\1/p')

[ "$PHASE" = "active" ] || { echo "goal phase=$PHASE — not waking"; exit 0; }

curl -fsS -X POST -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Continue toward the goal. If it is met, call the goal tool with verb complete."}]}' \
  "$BASE/session/$SESSION/prompt_async?directory=$WORKTREE"
```

```ini
# ~/.config/systemd/user/opencode-wake@.service
[Service]
Type=oneshot
ExecStart=%h/bin/wake-goal.sh %i /home/you/projects/thing
```

```ini
# ~/.config/systemd/user/opencode-wake@.timer
[Timer]
OnUnitActiveSec=20min
# NO catch-up. See below -- this line is load-bearing.
Persistent=false

[Install]
WantedBy=timers.target
```

## Two things that will bite you

**Wakes coalesce — N wakes are not N rounds.** `ensureRunning` makes a message arriving mid-turn join the
in-flight run rather than start a second one. A live probe fired six `prompt_async` calls and got six
`204`s, six user messages, and **one** assistant turn. That is correct and is what makes the wake safe —
but it means `roundsStarted` increments on **assistant-turn start**, never on wake acceptance. A coalesced
wake is the same round.

**Never let the scheduler catch up.** `Persistent=false`, and no `cron`/`at` backfill. After a serve
outage a catch-up burst is either a budget storm or silently free, depending which end of the count you
read. dsh solves the same problem by collapsing missed occurrences into a single dispatch; the
scheduler-side equivalent is simply not to queue them.

## Known limits

- **Headless `opencode run` cannot host this** in either direction: no socket to receive a wake, and the
  process exits at turn end. Long-running autonomous sessions must live in `opencode serve`.
- Serve loads instances lazily per directory, so **do not** build a persisted wake registry: it would not
  re-arm until someone independently touched that directory.
- The `goal` GET used by the phase guard lands with Step 17; until then, drop the guard and rely on the
  goal's own round/token budget to stop it.
