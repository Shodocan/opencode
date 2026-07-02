# Deep Research Report 1 — Premature-Stop Detection & Recovery in Coding-Agent Harnesses

> Source: external deep-research run, pasted 2026-07-01. Preserved verbatim as evidence for spec/plan review.

## TL;DR
- **The dominant harness-side pattern is deterministic finish-reason gating plus a synthetic "you didn't use a tool" nudge, bounded by a hard cap (typically 3 consecutive mistakes) — not LLM-as-judge.** Cline/Roo/Kilo inject the literal string `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.` and abort after `consecutiveMistakeLimit` (default 3); Aider caps at `max_reflections = 3`; OpenHands uses a structural `StuckDetector`; Gemini CLI uses a `LoopDetectionService`.
- **For an opencode fork + local Qwen, the two most proven, low-risk mechanisms are: (1) treat `finish_reason: "length"` as a distinct, auto-continuable state with a bounded synthetic "Continue from where you left off" message, and (2) a deterministic "no tool call + pending todos" check that injects one nudge and then hard-stops after N attempts.** Both are cheap, deterministic, already validated in the surveyed harnesses, and avoid the doom-loop and trust failures that plague naive auto-continue.
- **Upstream opencode itself does NOT currently auto-continue on `finish_reason: "length"`** (it breaks the loop and waits for the user — feature request #17471 is open) and has a documented history of the *opposite* bug: infinite loops when a provider returns `finish_reason: "stop"` incorrectly. Its only loop guard is a `DOOM_LOOP_THRESHOLD` of 3 for identical tool calls.

## Key Findings

1. **Two failure modes need opposite fixes.** A premature *stop* (`finish_reason: "stop"` with work incomplete, or empty text after a long think) needs a *nudge to continue*. A *truncation* (`finish_reason: "length"`, output cap hit) needs *re-request/continuation*. Conflating them causes bugs — opencode's loop currently mishandles both directions.
2. **Cheap deterministic checks dominate real implementations.** Every open-source harness surveyed keys off `finish_reason` inspection and "did the last assistant message contain a tool call?" — a boolean state check. LLM-as-judge completion verification is rare in the core loop; where it exists (Claude Code's optional `Stop` "prompt" hook, Goose recipe validation) it is opt-in.
3. **The near-universal guardrail is a hard cap of ~3 (for mistake/reflection loops).** Cline/Roo/Kilo `consecutiveMistakeLimit = 3`; Aider `max_reflections = 3`; opencode `DOOM_LOOP_THRESHOLD = 3`; OpenHands stuck detector fires on 3–4 identical steps. (Turn/iteration budgets are much higher — see Finding 6.) This convergence on 3 for *repetition* detection is the single strongest signal for what to implement.
4. **The synthetic nudge is almost always shown in the UI, not hidden**, and is explicitly marked as automated (Cline/Roo append `(This is an automated message, so do not respond to it conversationally.)`).
5. **Claude Code enforces completion through the TodoWrite tool description + a Stop hook**, not a single "never stop" prompt line. The Stop hook can return `{"decision":"block","reason":"..."}` to force continuation, guarded against infinite loops by the `stop_hook_active` flag.
6. **AI SDK (opencode's foundation) gives the primitives already**: `stopWhen`, `stepCountIs(n)`, `prepareStep`, and `finishReason`/`rawFinishReason` on the result. Per the AI SDK docs (ai-sdk.dev/docs/agents/loop-control), verbatim: "By default, agents stop after 20 steps using isStepCount(20). This default is a safety measure to prevent runaway loops that could result in excessive API calls and costs."

## Details

### AI SDK (Vercel) — the substrate the fork runs on
- `streamText`/`generateText` expose multi-step looping via **`stopWhen`** (replaces the older `maxSteps`). Built-in conditions: **`stepCountIs(count)`** (default `isStepCount(20)`), **`hasToolCall(...toolNames)`**, and custom predicates. The loop continues after tool calls "until there are no further tool calls or the stopping condition is met." Source: ai-sdk.dev/docs/agents/loop-control, ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling.
- `result.finishReason` resolves to one of `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown'`; `result.rawFinishReason` gives the raw provider value. Source: ai-sdk.dev streamText reference.
- **Known gap:** GitHub issue **vercel/ai #8459** ("Continue generating when faced with finish reason equals to length") documents that AI SDK does *not* auto-continue on `length` — it "stops mid way in streamText and generateText instead of continuing." So the fork must handle `length` itself. Issue #5026 requests a `maxToolSteps` variant because Claude 3.7 hit `maxSteps` and "streamText ends without an answer."
- `prepareStep` can rewrite the messages array between steps (usable to inject a nudge); `stopWhen`/`prepareStep` receive step context. Source: ai-sdk.dev/docs/agents/loop-control.

### opencode (sst / now anomalyco) — upstream behavior for comparison
- **Loop structure:** `SessionPrompt.loop` in `packages/opencode/src/session/prompt.ts` runs until the assistant message has a terminal finish reason. The exact termination guard (from multiple issue reports):
  ```ts
  if (lastAssistant?.finish && !["tool-calls", "unknown"].includes(lastAssistant.finish) && lastUser.id < lastAssistant.id) { break }
  ```
  (`packages/opencode/src/session/prompt.ts`, ~L263–271 / L324 / L720 across versions).
- **Does it auto-continue on `length`? No.** Feature request **#17471** explicitly asks opencode to "automatically inject a synthetic 'continue' user message and re-enter the loop" when `finish_reason` is `"length"`, noting "The infrastructure for synthetic user messages already exists (used for subtask command summaries)" and that `"length"` is currently *not* in the continuation conditions. Issue **#18108** confirms `finishReason: "length"` "is NOT in the exclusion list for modelFinished check, so the session loop breaks when the model is cut off mid-tool-call."
- **Doom-loop guard:** `SessionProcessor` detects repeated identical tool calls using **`DOOM_LOOP_THRESHOLD = 3`** (`packages/opencode/src/session/processor.ts:32-33`); detection requires an exact `JSON.stringify` match of tool inputs.
- **Output cap:** `OUTPUT_TOKEN_MAX = 32_000` (`transform.ts:21`); overridable via `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`. This is *why* local Qwen hits `length` — the cap can truncate mid-tool-call.
- **The mirror-image bug (very relevant to a local OpenAI-compatible Qwen setup):** Multiple issues (#14972, #20719, #19339, #11153, #13577) document that when an OpenAI-compatible provider (LiteLLM/Ollama/LM Studio) returns `finish_reason: "stop"` *even though tool calls are present*, or returns `"unknown"`, opencode either exits prematurely or loops infinitely. Issue #4255 shows opencode hangs with LM Studio + Qwen because of empty `tool_calls: []` arrays. **Takeaway for the fork: gate continuation on `hasToolCalls` boolean, not solely on `finish_reason` string, because local providers lie about finish_reason.**

### Cline (cline/cline) — synthetic nudge + consecutive-mistake cap
- **No-tool-use detection:** When the assistant produces text but no tool call, Cline injects a synthetic user message. Exact string from `src/core/prompts/responses.ts` (`noToolsUsed`):
  > `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.` … followed by tool-use reminder and `# Next Steps` (use `attempt_completion` if done, `ask_followup_question` if it needs info) and closes with `(This is an automated message, so do not respond to it conversationally.)`
- **Completion contract:** Cline expects an explicit **`attempt_completion`** tool call to end the task — this is the harness-tracked "done" signal (a tool call, not a `finish_reason`). The XML-tool variant literally instructs: "If you have completed the user's task, use the attempt_completion tool."
- **Guardrail:** `consecutiveMistakeCount`; on hitting the limit it raises **`mistake_limit_reached`**, an `ask` shown to the user: "Cline uses complex prompts and iterative task execution that may be challenging for less capable models… Please type yes(y) or no(n)." The `tooManyMistakes` string begins "You seem to be having trouble proceeding. The user has provided the following feedback to help guide you:".
- **Relevant to local models:** Cline docs literally recommend "Constraint Stuffing" ("ensure the code is complete," "always provide the full function definition") to mitigate truncation — a prompt-side complement to harness handling.

### Roo Code (RooCodeInc/Roo-Code) — configurable cap + grace retry
- **Same nudge lineage as Cline.** Native-tool variant string: `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.` plus "Refer to the tool definitions provided in your system instructions…" and the same `# Next Steps` block and `(This is an automated message, so do not respond to it conversationally.)`.
- **Config:** `consecutiveMistakeLimit` (default **3**; `0` = unlimited). Error thrown: `ConsecutiveMistakeError` with `reason ∈ {"no_tools_used", "tool_repetition", "unknown"}`. User-facing abort text: "[ERROR] The model has made too many consecutive mistakes (limit: 3). This often indicates the task is too complex or the model is stuck in a loop." Sources: `src/core/task/Task.ts:320-323`, DeepWiki Roo error-handling page, PRs #10193/#10196.
- **Grace retry (PR #10196):** Roo added `consecutiveNoToolUseCount` so it "retries once without user notification, then shows error after 2 consecutive failures" — i.e., one free retry before it counts against the mistake limit.
- **`ToolRepetitionDetector`** (`src/core/tools/ToolRepetitionDetector.ts`): compares tool name + serialized params; on repetition pushes `Tool call repetition limit reached for {toolName}. Please try a different approach.`
- **UI:** shown as "Roo says [Tool Use: …] Model response incomplete — The model did not use any tools in its response."

### Kilo Code (Kilo-Org/kilocode) — Roo fork, same mechanism
- Emits **`MODEL_NO_TOOLS_USED`** with the identical `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.` string (issues #5256, #5280, #5041, #1775). Inherits Roo's `consecutiveMistakeLimit`. Also shows the Roo-derived "Kilo Code appears to be stuck in a loop, attempting the same action (apply_diff) repeatedly" message (issue #1132). Confirms the mechanism is a Roo-lineage inheritance, not independent.

### Aider (Aider-AI/aider) — reflection loop with hard cap
- **Reflection mechanism:** After edits, Aider runs lint/test and feeds failures back as a `reflected_message`, re-prompting the model to fix. Bounded by **`max_reflections = 3`** (hardcoded in `aider/coders/base_coder.py`, alongside `num_reflections = 0`). On exceeding it: "Only 3 reflections allowed, stopping." (issues #1440, #3450; feature request #3865 asks to make it configurable — as of those threads it is *not* CLI-configurable).
- **Completion verification is real work, not a judge call:** `--auto-lint` (default **True**) and `--auto-test` (default **False**, with `--test-cmd`) run actual linters/test suites; non-zero exit → reflection. This is the "verify before idle" pattern implemented deterministically via exit codes.
- **Truncation handling:** Aider tracks `num_exhausted_context_windows` and `num_malformed_responses`; supports "infinite output" via continuation for models that truncate. History note: "Bugfix for turn taking when reflecting lint/test errors."

### OpenHands (formerly OpenDevin, All-Hands-AI/OpenHands) — structural StuckDetector
- **`openhands/controller/stuck.py`** (`class StuckDetector`) detects stalls structurally over the event history (not via `finish_reason`). Five scenarios, verbatim from source:
  1. **Repeating action+observation:** 4 identical action/observation pairs → `loop_type='repeating_action_observation'`.
  2. **Repeating action+error:** 3 identical actions all yielding `ErrorObservation` (or specific `SyntaxError` messages like `'SyntaxError: unterminated string literal (detected at line'`).
  3. **Monologue:** 3 repeated `MessageAction` with `source=AGENT` and no observation between them — directly catches "agent keeps talking, never acts."
  4. **Alternating pattern:** (A,obs)(B,obs)(A,obs)(B,obs)… over the last 6 steps.
  5. **Context-window-error loop:** ≥10 repeated `AgentCondensationObservation`.
- `is_stuck()` takes `headless_mode`; in interactive mode it only inspects history after the last user message.
- **Guardrails:** documented default iteration cap is **`max_iterations = 500`** (per official `config.template.toml` and issue #9344); `LLM_NUM_RETRIES` (default 8); plus a hard accumulated-cost cutoff. SDK stuck detection on by default (`stuck_detection=True`).
- **Failure modes documented in issues:** #5355 (loop detection kills agents legitimately waiting on long-running processes), #5480/#5500 ("Cannot recover from 'Agent stuck in loop'" — the hard `RuntimeError` blocked user recovery; fix replaced it with a graceful error state that resets on a new user message), #7183, #2238 (asking for the system prompt caused an infinite apology loop). Note: `stuck.py` is now **Legacy V0**, deprecated for the V1 Software-Agent-SDK.

### Gemini CLI (google-gemini/gemini-cli) — LoopDetectionService
- **`packages/core/src/services/loopDetectionService.ts`** monitors event patterns. `GeminiClient.processTurn` checks before each turn: loop count 1 → early warning, attempts recovery via **`_recoverFromLoop()`**; count > 1 → yields `LoopDetected` and aborts (`controller.abort()`). It also feeds every streaming event to the detector to catch mid-turn loops (repeated identical tool calls). Threshold constant: **`TOOL_CALL_LOOP_THRESHOLD`**.
- **Guardrails/opt-out:** PR #8231 added a **`disableForSession`** flag + a confirmation dialog: on detection the user is offered "Keep" vs "Disable" for the session. Changelog: "Loop detection confirmation: When loops are detected you are now presented with a dialog to disable detection for the current session."
- **Failure modes:** heavy false-positive history — issues #6950 (8-iteration audio loop wrongly halted), #8237, #5761, #15133, #11002 (user requests output-comparison so same-command/different-output = progress, not a loop), and #20106 (a `controller.abort()` in `processTurn` caused a *fatal uncaught AbortError crash*). User-facing string: "A potential loop was detected. This can happen due to repetitive tool calls or other model behavior. The request has been halted."
- **Todos:** experimental `useWriteTodos` (off by default) tracks a managed checklist.

### Codex CLI (openai/codex) — turn-based, hooks with continuation
- **Turn model:** Codex "present[s] the assistant message to the user and focus[es] the composer to indicate … it's their 'turn'." A plain assistant message (no tool call) ends the turn. Source: "Unrolling the Codex agent loop," openai.com.
- **Stop hook with continuation:** Codex hooks include a **`Stop`** event where `decision: "block"` "doesn't reject the turn. Instead, it tells Codex to continue and automatically creates a new continuation prompt that acts as a new user prompt, using your reason as that prompt text." `continue: false` from any matching Stop hook takes precedence and halts. Source: developers.openai.com/codex/hooks. This is a first-class, harness-native "inject a synthetic user message to resume" mechanism.
- **`/goal` (experimental):** stores a durable objective in thread state; runtime in `goals.rs` "can inject a continuation turn when the thread is idle and an active goal remains," bounded by token/time budget. Explicitly designed for the failure mode "The model finishes a turn but leaves the broader task unfinished." (Under development as of mid-2026.)
- **Compaction:** auto-compacts at `auto_compact_limit` to sustain long autonomy; Codex-Max prompting guide warns to "remove all prompting for the model to communicate an upfront plan, preambles… as this can cause the model to stop abruptly before the rollout is complete" — a model-behavior cause of premature stop.

### Goose (Block / now AAIF) — Max Turns + recipe validation
- **Max Turns:** `GOOSE_MAX_TURNS` (default **1000**) caps consecutive turns without user input; CLI: "--max-turns <NUMBER>: Maximum number of turns allowed without user input (default: 1000)." On hit it prompts: "I've reached the maximum number of actions I can do without user input. Would you like me to continue?" (Subagents: separate `DEFAULT_SUBAGENT_MAX_TURNS = 25`, per issue #6198.)
- **Retry & validation (recipes):** `RetryConfig` in recipe YAML defines success checks; `handle_retry_logic` (`crates/goose/src/agents/retry.rs`, called after each turn) re-runs if success criteria fail. Deterministic, shell-command-based completion verification (like Aider), not LLM-judge.
- **Continuous mode / budget:** `goose run --continuous --budget 2.00` iterates unattended until a dollar cap.
- **Failure mode:** issue #3739 — "Goose will stop performing tool calls even when… it says it will call further tools" (exactly the "promised action, no tool call" symptom); #3960 — premature cancellation of a local-LLM tool loop.

### Claude Code (Anthropic, closed source) — TodoWrite contract + Stop hook
- **Persistence is enforced via the TodoWrite tool description**, not a single "never stop" line. Community-extracted (Piebald-AI/claude-code-system-prompts) verbatim: "ONLY mark a task as completed when you have FULLY accomplished it"; "Never mark a task as completed if: Tests are failing / Implementation is partial / You encountered unresolved errors / You couldn't find necessary files or dependencies"; "Complete current tasks before starting new ones."
- **Stop hook (official, code.claude.com/docs/en/hooks):** the `Stop` event fires "When Claude finishes responding." A hook returning `{"decision": "block", "reason": "..."}` (or exit code 2) "Prevents Claude from stopping, continues the conversation," with `reason` fed back to Claude as its next instruction. This is the canonical harness-side "verify completion before idle" mechanism.
- **Infinite-loop guard:** the `stop_hook_active` boolean in the Stop hook's stdin JSON. "When true, Claude is already in a 'forced continuation' state from a previous block" — the hook must then exit 0 and let Claude stop. This is the exact only-once/backoff pattern needed.
- **Optional LLM-as-judge:** a `Stop` hook of type `"prompt"` can run "Check if all tasks are complete… Return {\"ok\": false, \"reason\": \"...\"} if work remains." — an opt-in secondary-LLM completion check.
- **Max-tokens vs pause_turn (two distinct cases):** `stop_reason == "max_tokens"` is truncation — per Anthropic docs, verbatim: "If stop_reason is max_tokens and the last content block is an incomplete tool_use, the response was truncated by your output budget, not paused… The fix there is to retry with a higher max_tokens, not to continue the conversation." The `pause_turn` stop reason has a documented default ceiling of **10 server-tool iterations per request**; documented handling: "Your application should handle pause_turn in any agent loop that uses server tools. Add the assistant's response to your messages array and make another API request to let Claude continue."

### Amp (Sourcegraph, closed source)
- Least publicly documented. Execute mode (`amp -x`) "sends the message… waits until the agent ended its turn, prints its final message, and exits" — turn-based like Codex. No public evidence of automatic `finish_reason: length` continuation or an injected "continue" nudge in the core agent.

## Technique Catalog (mechanism → harnesses → trigger → guardrails → failure modes)

**1. Finish-reason gating (deterministic, cheap).**
- Harnesses: all. opencode (`prompt.ts` terminal-reason check), AI SDK (`stopWhen`/`finishReason`).
- Trigger: inspect `finish_reason` ∈ {stop, length, tool-calls, unknown}; continue while `tool-calls`.
- Guardrails: pair with `hasToolCalls` boolean because OpenAI-compatible/local providers mislabel `stop`/`unknown` (opencode #14972/#19339).
- Failure modes: premature exit (provider returns `stop` with tool calls) OR infinite loop (`unknown` treated as non-terminal).

**2. Synthetic "you didn't use a tool" nudge (deterministic).**
- Harnesses: Cline, Roo, Kilo (identical `[ERROR] You did not use a tool…` string); Codex Stop hook (continuation prompt from `reason`).
- Trigger: assistant text with zero tool calls.
- Guardrails: consecutive-mistake counter (default 3); Roo's one-free-grace-retry; message marked automated and shown in UI.
- Failure modes: model replies conversationally to the nudge; loops of "[ERROR]…" when a parser/provider bug prevents tool calls from ever being recognized (Roo #10725, Kilo #5256).

**3. Auto-continue on truncation (`finish_reason: "length"`).**
- Harnesses: Aider (infinite-output continuation), Claude Code (higher max_tokens re-request), classic OpenAI pattern ("Continue from where you left off"). opencode does NOT (feature req #17471).
- Trigger: `finish_reason == "length"`.
- Guardrails: cap continuations; validate truncated tool-call JSON before executing (opencode #18108, Hermes #7680 show unrecovered truncated tool calls).
- Failure modes: repeated truncation at same cap (Hermes "response remained truncated after 3 continuation attempts"); context bloat from re-appending partial output.

**4. Structural stuck/loop detection (deterministic, history-based).**
- Harnesses: OpenHands `StuckDetector` (3–4 repeats, monologue, alternating), Gemini CLI `LoopDetectionService` (`TOOL_CALL_LOOP_THRESHOLD`), opencode `DOOM_LOOP_THRESHOLD=3`, Roo `ToolRepetitionDetector`.
- Trigger: N identical/alternating action-observation pairs, or repeated agent messages with no observation.
- Guardrails: user confirmation dialog + `disableForSession` (Gemini), graceful recovery on new user message (OpenHands #5500).
- Failure modes: false positives on legitimate repetition (Gemini #6950/#8237/#11002); killing agents waiting on long-running processes (OpenHands #5355); fatal crash on abort (Gemini #20106).

**5. Turn-cap / iteration budget (deterministic).**
- Harnesses: Goose `GOOSE_MAX_TURNS=1000` (subagents 25), OpenHands `max_iterations=500`, AI SDK `stepCountIs(20)`, Aider `max_reflections=3`, Claude Code `--max-turns`.
- Trigger: step/turn counter.
- Guardrails: user prompt to continue (Goose), hard cost cutoff.
- Failure modes: silent stop in headless mode with no way to continue.

**6. Completion verification before idle.**
- Deterministic variant (preferred): Aider `--auto-test`/`--auto-lint` exit codes; Goose recipe `RetryConfig` success checks; Claude Code Stop hook running `npm test`.
- LLM-as-judge variant (opt-in): Claude Code `Stop` prompt hook ("is the task done?"), quality-engineer subagent.
- Trigger: turn about to end.
- Guardrails: `stop_hook_active`/only-once flag to prevent forced-continuation loops.
- Failure modes: over-broad gate fires on unrelated turns; infinite block loop without the active-flag check.

## Recommendations

**Shortlist — the 2–3 most proven approaches for the opencode fork + local Qwen 3.6 27B:**

**(1) Deterministic finish-reason + tool-call gating with a bounded "length" continuation (highest priority).** In the `prompt.ts` loop, branch explicitly on the classified state:
- `finish_reason == "tool-calls"` OR `hasToolCalls` true → continue (do NOT rely on the string alone; local llama.cpp/LM Studio/LiteLLM return `stop`/`unknown` with tool calls present — opencode #14972/#19339/#20719).
- `finish_reason == "length"` → inject a synthetic user message ("Continue from where you left off.") and re-enter the loop, exactly as opencode feature request #17471 proposes; but FIRST validate any partial tool-call JSON (opencode #18108) and cap continuations at 2–3.
- `finish_reason == "stop"` with no tool call AND no pending todos → terminate (correct done state).

**(2) "Promised-but-not-executed / empty-after-thinking" nudge with a hard cap of 3 and one grace retry.** When the assistant returns non-empty text but zero tool calls and todos remain pending, inject Cline/Roo's proven pattern — a shown, explicitly-automated user message. Track a `consecutiveNoToolUseCount`; give one silent grace retry (Roo PR #10196), then count toward a `consecutiveMistakeLimit` (default 3, config-exposed, `0` = unlimited), then hard-stop and surface to the user. For the empty-after-long-reasoning case specifically, detect `text.trim().length == 0 && reasoning.length > 0` as a deterministic trigger.

**(3) A lightweight structural loop guard (defense-in-depth).** Keep/extend opencode's `DOOM_LOOP_THRESHOLD=3` but add OpenHands-style monologue detection (≥3 consecutive assistant messages with no intervening tool observation). Gate it on identical *or* near-identical content, and never `abort()` synchronously; instead surface a user confirmation with a session-level opt-out (`disableForSession`).

**Sequencing:** Implement (1) first. Add (2) next. Add (3) only if repetition persists after (1)+(2).

**Thresholds that would change the recommendation:**
- If nudge-loops appear (Qwen replies "I already finished" to the nudge): drop the grace retry and lower the cap to 2, and switch the nudge to a stronger, task-specific reason string.
- If false-positive stuck detection kills legitimate work: switch structural detection to output-comparison (Gemini #11002) — same tool, different observation = progress.
- If truncation persists after 3 continuations: raise `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` above 32k and/or subtract the reasoning budget from the output budget, rather than continuing.
- If a completion *guarantee* is wanted: add an opt-in Claude-Code-style Stop check guarded by an only-once flag.

## Caveats
- Claude Code persistence/Stop-hook details combine official docs with community reverse-engineering; Amp's internal loop is largely undocumented.
- Version drift: opencode moved org; OpenHands `stuck.py` is Legacy V0; Roo's public repo archived read-only May 2026. Verify line numbers/constants in-repo.
- **`finish_reason` from local/OpenAI-compatible providers is unreliable** — any recommendation keying on `finish_reason` MUST also inspect presence of tool-call parts. Single biggest implementation risk for this stack.
- Some cited numbers are from secondary write-ups/DeepWiki; confirm in-repo before relying on exact values.
- LLM-as-judge completion checks are the least-used approach in core loops; reserve for opt-in workflows.
