# Qwen 3.6 27B — vLLM Serving Recipe (Fork Feature 9, L0)

> Source: `docs/artifacts/01-07-2026_premature-stop-recovery/spec.md` §L0.3.
> Status: L0 deliverable. Applies to the personal opencode fork only.
> Scope: vLLM only (UC1). SGLang/llama.cpp/LM Studio/Ollama are out of scope.

This document is the **required** server-side configuration for running the
Qwen 3.6 27B reasoning model via vLLM behind this fork, plus the staged
rollout gates that bind L0 (prevention) to L1 (recovery).

## 1. Sampling preset (thinking-coding)

| Parameter | Value | Notes |
|---|---|---|
| `temperature` | 0.6 | Never greedy. Qwen official thinking-coding preset. |
| `top_p` | 0.95 | |
| `top_k` | 20 | Delivered via the fork's extra-body mechanism (L0.1). |
| `min_p` | 0.0 | Delivered via extra-body. |
| `presence_penalty` | 0.5 → 1.5 | Anti-loop dial. Start 0.5; raise toward 1.5 if loops persist. **1.5 strongly recommended for FP8/quantized** (research-2 §Recommendations, research-3 §Recovery ladder rung 2). |
| `frequency_penalty` | 0.0 – 0.3 | Optional. |
| `repetition_penalty` | 1.0 | **Never raise.** Harms code; can itself cause loops (research-2 lever #10). |

Never use greedy decoding (`temperature: 0`).

## 2. Server flags

| Flag / field | Value | Evidence |
|---|---|---|
| `--reasoning-parser` | `qwen3` | Separates `reasoning_content` from `content` (research-3 §vLLM streaming reasoning channel). |
| `--reasoning-config` | set if the build needs explicit start/end strings | Required by some vLLM builds to surface `</think>`. |
| `thinking_token_budget` | ≈ 4096–8192 for agentic/tool tasks | Forces `</think>` (PR #20859). **Caveat: NOT enforced under MTP speculative decoding** (#39573). Request-level field. |
| `repetition_detection` | `{ min_pattern_size: 1, max_pattern_size: 40, min_count: 4 }` | vLLM scheduler stop → `FINISHED_REPETITION` (research-3 §Native vLLM primitives). Request-level field. |
| KV cache | `q8_0` or unquantized | Never `q4` (research-2 §5). |
| Weight quant | ≥ 4-bit | |
| YaRN | off unless > 32K context | |
| vLLM version | ≥ 0.21.0 | Spec-decode budget enforcement. |
| Harness pins | `ai 6.0.168`, `@ai-sdk/openai-compatible 2.0.41` | |

## 3. opencode.json example

The local model entry **MUST** include `limit.output` — it gates when
`finish: "length"` fires (`packages/opencode/src/provider/transform.ts:1325-1327`
uses `min(model.limit.output, 32_000)`).

```jsonc
{
  "provider": {
    "local-vllm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:8000/v1"
      }
    }
  },
  "model": "local-vllm/qwen3.6-27b",
  "agent": {
    "default": {
      "model": "local-vllm/qwen3.6-27b",
      "steps": 40
    }
  },
  "models": {
    "local-vllm/qwen3.6-27b": {
      "options": {
        "temperature": 0.6,
        "topP": 0.95,
        "presencePenalty": 0.5,
        "frequencyPenalty": 0.1,
        "min_p": 0.0,
        "top_k": 20,
        "thinking_token_budget": 8192,
        "repetition_detection": {
          "min_pattern_size": 1,
          "max_pattern_size": 40,
          "min_count": 4
        }
      },
      "limit": {
        "context": 32768,
        "output": 32000
      }
    }
  },
  "stopRecovery": {
    "enabled": true,
    "lengthContinue": { "enabled": true, "max": 3 },
    "noToolNudge": { "enabled": true, "limit": 3, "graceRetry": true },
    "emptyAfterThinking": { "enabled": true }
  }
}
```

## 4. Parser / tool-call canary (pre-deploy gate)

Before enabling L1, run **one scripted request** with a tool schema + thinking
enabled. Verify tool calls arrive in the `tool_calls` / content channel, **NOT**
in `reasoning_content`. If misrouted, `hasToolCalls` breaks and L1 false-nudges
on every tool turn — **do not enable L1 until fixed**.

## 5. Phase 0 — Baseline capture

- Enable vLLM request logging.
- Record the finish-reason histogram over a work session.
- **Capture the RAW `finish_reason` string vLLM sends when `repetition_detection`
  fires** (feeds spec §5.6 mapping decision — currently unmapped, surfaces as
  `finish: "unknown"` and emits the telemetry-only `observed` event).
- Record loop/truncation incidence and wasted-token profile. This is the
  comparison base for everything after.

## 6. Phases 1–3 — staged enablement (spec §10.1)

| Phase | Gate to enter | Content |
|---|---|---|
| 1 — L0 only | Phase 0 data recorded | Sampling preset + penalties + server recipe live; L1 off (`stopRecovery.enabled: false`). Measure loop-incidence delta vs Phase 0. |
| 2 — L1 per component | Phase 1 stable | Enable `lengthContinue` alone → observe; then the nudge family (`noToolNudge`, `emptyAfterThinking`). Watch R7 (conversational nudge replies) and R12 (stale-todo storms) in `session.next.stop_recovery` telemetry. |
| 3 — L2 go/no-go | Phase 2 telemetry over an agreed window | UC2 implication: revisit L2 only if `stop_recovery`/`observed` telemetry shows loops surviving L0+L1. |

## 7. OPEN-7 check — reasoning replay

Probe whether the served chat template replays prior-turn `reasoning_content`
into the rendered prompt. The client sends it
(`packages/opencode/src/session/message-v2.ts:362-376` serializes reasoning
parts into outgoing messages); the template may drop it. Record the answer
here (and in the spec §11 OPEN-7 row):

> Result: __________ (TODO: fill after Phase 0 probe)

This affects §5.1 reasoning-only routing efficacy.

## Harness output cap note

`OUTPUT_TOKEN_MAX = 32_000` (`packages/opencode/src/provider/transform.ts:18`,
env override `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`) — this is why
`finish: "length"` occurs. The recipe's `limit.output` must be ≤ this cap for
the length-finish gate to fire as expected.