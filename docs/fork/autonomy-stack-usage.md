# Autonomy stack — what shipped in `1.18.22-RC2`, and how to drive it

FORK FEATURE (13). Everything below was verified against source at `fork/main@0657ad202d`.
Design docs: `docs/artifacts/25-08-2026_autonomy-stack/`. Wake recipe: `docs/fork/autonomy-wake-recipe.md`.

---

## 1. The one-paragraph model

A **goal** is a durable objective attached to a session. While one is `active` and *armed*, the harness
re-enters the loop after each turn instead of going idle — until the model marks it complete or blocked, or
it hits a round/token cap. All of this hangs off the **same** evaluator that stop-recovery already used, so
there is exactly one thing deciding whether another turn happens.

**Ralph** is unrelated machinery for a different problem: a repeat-until-done loop where each round runs in
a **fresh child session**, so long grinds don't rot from accumulated context.

---

## 2. Turn it on

Nothing autonomous runs until you opt in. In `opencode.json`:

```json
{
  "goal": {
    "enabled": true,
    "maxRounds": 20,
    "maxTokens": 500000
  }
}
```

| Key | Default | Effect |
|---|---|---|
| `goal.enabled` | `false` | **Master switch for goal ROUNDS.** When false, no auto-continuation happens. |
| `goal.maxRounds` | `20` | Default round cap for a new goal. |
| `goal.maxTokens` | `1000000` | Default cumulative token cap for a new goal. |
| per-agent `goal: false` | — | Disables goal rounds for that agent only. |

**Independent of `stopRecovery`.** You can run goals with stop-recovery off, and vice versa. Per-agent
flags are reciprocal too: `stopRecovery: false` on an agent does not disable its goal rounds.

> ⚠️ **`ralph.enabled` / `ralph.maxRounds` are accepted by the config schema but are NOT read by anything.**
> The ralph tool is registered unconditionally and uses its own default of 8 rounds. Setting them does
> nothing today. Same for per-agent `ralph: false`. Treat the ralph config block as reserved.

> ⚠️ **`goal.enabled` gates ROUNDS, not the tool.** The `goal` tool is always registered, so a model can
> create a goal even when `enabled` is false — it just won't auto-continue. If you want the tool hidden
> from an agent, deny it in that agent's permission ruleset.

---

## 3. Driving it — three surfaces

### `/goal <instruction>` — the human surface

An ordinary template command. Costs one cheap model turn (a built-in slash command **cannot** be
zero-turn in opencode), and works in TUI, desktop, web and CLI because they all route `/x` through the
same endpoint. It reads your instruction and calls the right tool verb.

```
/goal finish the autonomy stack and publish RC2
/goal that's done
/goal I'm blocked on missing credentials
```

### `goal` tool — the model surface

| verb | args | what it does |
|---|---|---|
| `create` | `objective` (required), `maxRounds?`, `maxTokens?` | Opens a durable goal, **armed**. Rounds start firing. |
| `complete` | — | Terminal success. Clears any blocked reason. |
| `report-blocked` | `message?` | Terminal. Writes `blocked.code = model_reported`. |
| `resume` | — | Re-arms a goal that an abort disarmed. |

**Write objectives as a checkable end state, not an activity.** "the stack is implemented and RC2 is
published" — not "work on the stack". The model is later asked to judge whether it's met, and a vague
objective never terminates.

`resume` has a hard precondition: it re-arms **only** a goal whose durable phase is `active`. On a
blocked or complete goal it returns an error and re-arms nothing. That is deliberate — it's what stops a
model from resurrecting a goal the safety brake stopped. Raising an exhausted cap is *not* what `resume`
does; there is no verb for that yet.

### `ralph` tool — long grinds

| arg | default | notes |
|---|---|---|
| `objective` | required | Checkable end state, same rule as above. |
| `maxRounds` | `8` | Hard-coded default; the config key is inert (see §2). |

Each round gets a **fresh child session**. Exactly two things cross a round boundary: the **working tree**
(the declared source of truth — each round is told to re-verify it rather than trust the previous summary)
and one bounded structured report. Reports over 16384 chars **hard-fail the loop rather than truncate**,
because a silently shortened hand-off makes the next round act on a partial picture.

Returns one of four outcomes: `complete`, `blocked`, `budget-limited` (hit the round cap, carries the last
good hand-off), or `round-failed` (a round settled without a structured report, also carries the hand-off).
There is no retry anywhere.

---

## 4. How a round actually fires

At the end of every turn the evaluator runs, in this order:

```
  hard gates ──────────► none      (tool calls pending, error, content-filter,
      │                             doom-loop, compaction pending, at maxSteps,
      │                             structured-output turn)
      ▼
  stop-recovery ───────► continue / nudge / halt   ← if it acts, the goal branch
      │                                              is never consulted
      ▼  (policy exit only)
  evaluateGoal ────────► goal_round / goal_blocked
```

The goal branch can only ever upgrade a "nothing to do" into an action. It **cannot** override
stop-recovery, and it cannot reach the `halt` path. If stop-recovery halts, the goal transitions to
`blocked` with code `halted` — you get a blocked goal, not a silently idle session.

A round fires when **all** of: goal phase is `active`, the goal is armed, the model didn't just signal
completion, and neither budget is exhausted.

### Armed vs. active — the bit that trips people

`phase` (`active`/`paused`/`blocked`/`complete`) is **durable**. "Armed" is **never persisted**.

- **Restart** → every goal comes back *disarmed*. Any ordinary turn re-arms it automatically. So a
  restarted goal resumes on your next message — a crash can't silently resume spending on its own.
- **Abort** (escape) → disarms with a *different* reason, and **only the `resume` verb clears it**. An
  ordinary message will not re-arm it.

### Why it stopped

`blocked.code` is a closed set of four, each with exactly one producer:

| code | means |
|---|---|
| `round_budget_exceeded` | hit `maxRounds` |
| `token_budget_exceeded` | hit `maxTokens` (cumulative per goal, including ralph child spend) |
| `halted` | stop-recovery's no-progress brake fired |
| `model_reported` | the model called `report-blocked` |

Budgets are checked **before** starting a round, so the cap bounds rounds *started*.

---

## 5. Known gaps — read this before relying on it

These are real and shipped:

1. **`session.abort` does NOT disarm a goal.** Pressing escape cancels the current turn, but the goal
   stays armed, so your **next message fires another round**. The disarm-on-abort wiring is Step 17/18 and
   is not implemented. Today the reliable way to stop a goal is `/goal` → `report-blocked`, or `complete`.
2. **There is no UI.** No status surface, no round counter, no badge. You cannot see a goal's phase,
   rounds used, or budget from the TUI. Inspect it in SQLite: `select * from session_goal;`
3. **No `GET /session/:id/goal` endpoint.** The wake recipe's phase guard depends on it; until it lands,
   drop the guard and rely on the goal's own budget.
4. **Ralph has no end-to-end test.** Its budget rollup is tested; the round loop itself has not been
   exercised against a live provider.
5. **`isOverflow` is not wired.** The evaluator can take a context-pressure signal but the shell currently
   passes `false`, so a goal will not yet prefer a fresh ralph round over another same-session nudge.
6. **L1 timed wake is out-of-process only** and requires a long-lived `opencode serve`. Headless
   `opencode run` cannot host it in either direction.

---

## 6. Operational notes for a harness session

- **Start goals in `opencode serve`**, not headless `run`, if you want wakes to work at all.
- **Wakes coalesce.** Firing N wakes into a busy session produces **one** turn, not N — a message arriving
  mid-turn joins the in-flight run. Round counting is on assistant-turn start, so a coalesced wake is the
  same round. Never let a scheduler back-fill missed wakes.
- **Budget is the only real stop.** With no UI and no abort-disarm, the round/token caps are what
  bound a runaway goal. Set `maxTokens` deliberately.
- **Rollback:** goal state is one table. `DROP TABLE session_goal;` clears it (the migration framework is
  forward-only, so there's no down-migration). It is FK-cascaded from `session`.
- Durable event: `session.next.goal.changed`, carrying a full post-mutation snapshot every time.
