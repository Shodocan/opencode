# User Choices — Qwen Premature-Stop Recovery & Thinking-Loop Prevention

Status: **FROZEN** 2026-07-01 (structured questions answered by human in-session)
Invariant: these choices are frozen. Spec `Human Decision Log` must copy them 1:1. Any review finding that conflicts with a frozen choice is `human_required`; never autonomously revise.

## UC1 — Inference server

**Question:** Which inference server(s) run the Qwen 3.6 27B model?
**Choice:** **vLLM** (only).
**Implications:** L0 levers are `presence_penalty`/`frequency_penalty` via request body (no DRY sampler on vLLM), `--reasoning-parser qwen3`, `thinking_token_budget`, `repetition_detection`. SGLang/llama.cpp/LM Studio/Ollama recipes are out of scope (reference-only in research-2).

## UC2 — Scope of first implementation

**Question:** What scope for the first implementation?
**Choice:** **L0 + L1** — prevention config (sampling defaults/config plumbing + vLLM server recipe docs) plus premature-stop recovery (length auto-continue, no-tool-use nudge with grace retry + cap 3, empty-after-thinking trigger).
**Explicitly deferred (non-goals v1):** L2 streaming thinking-loop detector; L3 fallback escalation; stream-stall watchdog; LLM-as-judge completion checks.
**Implications:** revisit L2 only if telemetry from L0+L1 shows loops surviving correct sampling + vLLM server-side budgets.

## UC3 — Placement

**Question:** Where should the recovery behavior live?
**Choice:** **Core fork feature**, config-gated (opt-in, off by default), in the session loop/processor — same pattern as the fallback-model and compaction-continuation fork features.
**Implications:** full access to `finishReason`, tool-call state, and runner transitions; adds fork maintenance surface → must be additive/isolated with a FORK_CHANGES.md entry; plugin-only implementation rejected (no finishReason input, no clean prompt-injection path, no abort/retry capability).

## UC4 — Nudge/continue message visibility

**Question:** Should the synthetic continue/nudge messages be visible in the TUI?
**Choice:** **Visible, muted, explicitly marked as automated** (Cline/Roo convention), rendered via existing `visibleUserTextParts` machinery.
**Implications:** no hidden auto-continues; preserves user trust and debuggability; a later config option to hide is possible but not in v1 scope.
