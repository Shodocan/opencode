# Deep Research Report 2 — Inference-Side Mitigations for Qwen Reasoning-Model Thinking Loops and Premature Exit

> Source: external deep-research run, pasted 2026-07-01. Preserved verbatim as evidence for spec/plan review.
> NOTE: user's deployment is vLLM (frozen choice UC1) — the vLLM rows/sections are the operative ones; other servers kept for reference.

## TL;DR
- **Fix sampling first, and never use greedy/temperature=0.** For a Qwen3.6-27B-class thinking model in a coding agent, the official card values are the anchor: thinking-general `temp=1.0, top_p=0.95, top_k=20, min_p=0.0, presence_penalty=0.0`; thinking-coding `temp=0.6, top_p=0.95, top_k=20, min_p=0.0, presence_penalty=0.0`. When loops appear, the officially sanctioned anti-loop lever is `presence_penalty` in the 0–2 range (Qwen explicitly recommends 1.5); do **not** reach for `repetition_penalty`, which damages code and structured output.
- **The strongest per-request anti-loop tool on local stacks is llama.cpp's DRY sampler** (`dry_multiplier ≈ 0.8`, up to 1.1 for stubborn loops), settable via the OpenAI endpoint's JSON body. vLLM does **not** support DRY (open feature request #8581); SGLang's `repetition_penalty` is currently non-functional (bug #10142). Match the anti-loop lever to your server.
- **For premature exit and runaway thinking, use a real reasoning-budget mechanism, not just max_tokens.** llama.cpp exposes `thinking_budget_tokens` per request plus `--reasoning-budget-message`; vLLM has `thinking_token_budget` (needs `--reasoning-parser` + `--reasoning-config`). Also verify your chat template opens/closes `<think>` correctly — a wrong template is a top cause of both loops and skipped thinking.

## Key Findings

1. **Greedy decoding is the single most-cited cause of Qwen thinking loops.** Every Qwen3-era card states: "DO NOT use greedy decoding, as it can lead to performance degradation and endless repetitions." Coding agents that default to `temperature=0` for determinism are actively triggering the failure mode.
2. **`presence_penalty` is the official anti-loop lever; `repetition_penalty` is a trap for code.** Qwen recommends `presence_penalty` 0–2 (set to 1.5 for significant repetition), warning higher values cause language mixing. `repetition_penalty` penalizes the legitimately repeated tokens in code and JSON.
3. **Server support for anti-repetition samplers is highly uneven.** llama.cpp has the richest set (DRY, XTC, min_p, top-n-sigma, all per-request). vLLM supports `repetition_penalty`, `top_k`, `min_p` via `extra_body` but **not DRY**. SGLang's `repetition_penalty` is defined but non-functional. Ollama passes options through; LM Studio (llama.cpp core) exposes DRY.
4. **Thinking-budget / early-exit support is now real but version-sensitive.** llama.cpp's `--reasoning-budget` became a true token-counting sampler (per-request `thinking_budget_tokens`). vLLM merged/added `thinking_token_budget` and `reasoning_budget`. SGLang's `thinking_budget` is reported broken for Qwen3.6 (issue #25536). Truncating thinking too aggressively measurably hurts accuracy.
5. **Quantization and serving misconfig amplify loops.** Q4 KV-cache quant can break output on some stacks; aggressive low-bit weight quant amplifies repetition in thinking mode; static YaRN degrades short-context quality (Qwen3-32B: ~15–20% agentic drop reported in vLLM issue #18728) and can induce looping; llama.cpp context-shift corrupts modern reasoning models and is now disabled by default.

## Details

### 1. Documented causes of thinking loops and premature exit

**Greedy decoding.** The Qwen3 family cards (0.6B/4B/32B and the readthedocs Quickstart) uniformly warn: *"For thinking mode, use Temperature=0.6, TopP=0.95, TopK=20, and MinP=0 … DO NOT use greedy decoding, as it can lead to performance degradation and endless repetitions."* Nuance: the **Qwen3.6-27B card itself does not repeat the greedy-decoding warning** — it only carries the `presence_penalty` guidance — but the warning is consistent across the Qwen3 lineage and QwQ.

**Repetition amplification in thinking mode + quantization.** QwQ-32B was notorious for endless repetition. Unsloth's Daniel Han (X, Mar 7 2025) documented that naively adding repetition penalties backfires: *"When using repetition penalties to counteract looping, it rather causes looping! Try adding this to llama.cpp: --samplers 'top_k;top_p;min_p;temperature;dry;typ_p;xtc'."* A light `dry_multiplier 0.5` and `repetition_penalty 1.1` with reordered samplers worked better; QwQ is *"sensitive to quantization — the first and last few layers should be left unquantized."* Unsloth: *"Feb 4 update: llama.cpp fixed a bug that caused Qwen to loop and have poor outputs. We updated GGUFs — please re-download."*

**Wrong/missing chat template — a top cause of both loops and premature exit.** Qwen3-Thinking-2507 and Qwen3.6 templates hardcode a leading `<think>`, so *"it is normal for the model's output to contain only `</think>` without an explicit opening `<think>` tag."* If the server's reasoning parser expects both tokens (vLLM issue #27118), reasoning is misrouted. QwenLM/Qwen3.6 issue #131 documents the template emitting **empty historical `<think>` blocks**, causing prompt drift and cache invalidation. Community-fixed templates (froggeric, allanchan339) explicitly fix *"Tool calling mid-thought: Model generates `</think>` tags without properly closing `<think>` blocks"* and *"Premature stops: XML tool calls trigger stop tokens incorrectly."* Ollama issue #14798: bare `{{ .Prompt }}` template silently ignores `think:false` (a 4096-token budget produced 17,054 chars of thinking and 0 chars of answer).

**Premature thinking exit.** Beyond template bugs, models close `</think>` early or skip thinking when: (a) the parser or template disables thinking unexpectedly (vLLM enable_thinking bugs #35574, #40816 route tokens to the wrong field); (b) an over-aggressive reasoning budget forces `</think>` too soon; (c) tool-call XML mid-thought triggers a stop token.

### 2. Official sampling parameters and what practitioners actually use

**Qwen3.6-27B official card (verbatim, the user's model class):**
| Mode | temp | top_p | top_k | min_p | presence_penalty | repetition_penalty |
|---|---|---|---|---|---|---|
| Thinking – general | 1.0 | 0.95 | 20 | 0.0 | 0.0 | 1.0 |
| Thinking – precise/coding (WebDev) | 0.6 | 0.95 | 20 | 0.0 | 0.0 | 1.0 |
| Instruct / non-thinking | 0.7 | 0.80 | 20 | 0.0 | 1.5 | 1.0 |

Card guidance verbatim: *"For supported frameworks, you can adjust the presence_penalty parameter between 0 and 2 to reduce endless repetitions. However, using a higher value may occasionally result in language mixing and a slight decrease in model performance."* Output length verbatim: *"We recommend using an output length of 32,768 tokens for most queries. For benchmarking on highly complex problems, such as those found in math and programming competitions, we suggest setting the max output length to 81,920 tokens."*

**27B vs 35B-A3B difference:** the MoE Qwen3.6-35B-A3B uses `presence_penalty=1.5` for thinking-general while the dense 27B uses `0.0` (attributed to MoE-vs-dense training differences). Practitioners doing agentic/coding work converge on the coding preset (`temp=0.6, top_p=0.95, top_k=20`), sometimes dropping to temp 0.2–0.3 with min_p when quants misbehave.

**Does repetition_penalty harm reasoning/code?** Yes — well-documented. Community guidance: for code, keep repeat penalties at 1.0–1.05, "never exceed 1.2." Qwen3-VL issue #1611: *"Increasing the repetition penalty is not an acceptable solution because it breaks the transcription of naturally repetitive text, for example in tables."* **Verdict: presence_penalty (0.5–1.5) is the preferred anti-loop lever per official guidance; repetition_penalty should stay at 1.0 for coding agents.**

### 3. DRY and anti-repetition samplers: per-server availability via OpenAI-compatible endpoint

- **llama.cpp server:** Richest support, all per-request in the JSON body: `dry_multiplier`, `dry_base` (1.75), `dry_allowed_length` (2), `dry_penalty_last_n` (-1), `dry_sequence_breakers`, plus `xtc_probability/threshold`, `min_p`, `top_k`, `top_n_sigma`, `repeat_penalty`, `presence_penalty`, `frequency_penalty`, and a `samplers` ordering array. Default chain: `penalties → dry → top_n_sigma → top_k → typ_p → top_p → min_p → xtc → temperature`.
- **vLLM:** Via `extra_body`: `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty`, `length_penalty`. **No DRY** — open feature request (issue #8581). `guided_decoding`/structured outputs supported.
- **SGLang:** `temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`, `presence_penalty` via sampling_params/`extra_body`. **`repetition_penalty` is defined but non-functional** (bug #10142). No native DRY.
- **LM Studio:** llama.cpp core → DRY and the llama.cpp sampler set available.
- **Ollama:** Options passthrough (`PARAMETER`/`options`); `think` boolean in API; thinking-toggle template-dependent.

**Interaction with structured outputs / tool calls.** Grammar-constrained decoding masks any token violating the schema to −∞. DRY and repetition penalties are dangerous here because they penalize the repeated structural tokens (`{`, `}`, `"`, repeated key names) that valid JSON requires. Guidance: **disable or minimize DRY/repetition penalties during constrained/JSON generation**, or add structural characters to `dry_sequence_breakers` and raise `dry_allowed_length`.

### 4. Thinking-budget controls and early exit

- **Qwen official:** Hard switch `enable_thinking=False` (chat-template kwarg); soft switch `/think` `/no_think` on Qwen3 — but **Qwen3.5/3.6 dropped the soft switch** (must use `chat_template_kwargs: {enable_thinking: false}`). No official per-request numeric thinking-budget parameter in the base inference path.
- **llama.cpp:** `--reasoning-budget` became a real token-counting sampler (commit acb7c79) forcing `</think>` at budget with `--reasoning-budget-message`. Per-request: `thinking_budget_tokens`. Maintainer test on Qwen3-9B/HumanEval: thinking 94%, non-thinking 88%, **tight unprompted budget cratered to 78%**; 1000-token budget + budget-message recovered to 89%. Caveat: issue #22717 reports numeric budgets flaky on Qwen3.5/3.6 in llama-server (only 0/-1 reliable on some builds).
- **vLLM:** `thinking_token_budget` (with `--reasoning-parser qwen3` + `--reasoning-config` giving `reasoning_start_str`/`reasoning_end_str`); `reasoning_budget` PR #37112 adds a `ReasoningBudgetLogitsProcessor` forcing `</think>` at budget with configurable message. Community patch `vllm-thinking-budget` uses `vllm_xargs: {max_thinking_tokens: N}` with 80% soft nudge / 100% hard cut.
- **SGLang:** `thinking_budget` / `--enable-strict-thinking` exist but issue #25536 reports **not enforced for Qwen3.6-27B-FP8** (reasoning consumed all max_tokens, `content: null`). Two-stage `sgl.gen` workaround documented.
- **LM Studio / Ollama:** No first-class numeric reasoning budget.

**Quality tradeoff of early truncation.** Cui et al. (arXiv:2604.10739): *"early tokens provide substantial gains (+3.2% per 500 tokens for R1-32B), while beyond 12K tokens, marginal utility turns negative."* Nemotron's report notes budget control can *improve* accuracy by early-terminating malformed repetition loops. But tight budgets without a transition message degrade coherence (78% HumanEval result above).

### 5. Quantization and serving pitfalls that increase looping

- **KV-cache quantization:** Q4/Q5 KV cache can break output (ik_llama.cpp #1142); KVTuner data shows Qwen2.5-7B perplexity exploding at K4V8/KV2. **Use q8_0 KV cache, not q4**; leave unquantized if VRAM allows.
- **Aggressive weight quantization:** Liu et al. (arXiv:2504.04823): *"4-bit weight-only quantization reaches lossless results while 3-bit induces non-negligible accuracy loss, e.g., over 7% degradation on LiveCodeBench for both AWQ and GPTQ"* — worst on long-response reasoning. Unsloth recommends Dynamic 2.0 quants.
- **Static YaRN:** Qwen cards warn static YaRN *"remains constant regardless of input length… if the average context length does not exceed 32,768 tokens, we do not recommend enabling YaRN."* vLLM #18728 (Qwen3-32B): *"~15-20% performance drop"* with YaRN enabled. SGLang #6030 ties static YaRN to loops on short prompts. **Only enable YaRN when >32K context is actually needed.**
- **Context shift (llama.cpp):** corrupts modern reasoning models; disabled by default as of PR #15416.
- **Prompt-cache reuse:** Qwen3.6 #131 — empty historical `<think>` blocks invalidate prefix cache; fixed templates restore ~100% KV cache hit rate in multi-turn agent loops.
- **Speculative decoding:** historically bypassed thinking-budget constraints; vLLM v0.21.0 fixed spec-decode to enforce thinking budgets. Verify if running spec decode.

### Deliverable (a): Recommended request-parameter block + per-server compatibility

Baseline for a Qwen3.6-27B-class **thinking** coding agent (coding preset):

```json
{
  "temperature": 0.6,
  "top_p": 0.95,
  "top_k": 20,
  "min_p": 0.0,
  "presence_penalty": 0.5,
  "repetition_penalty": 1.0,
  "max_tokens": 32768,
  "extra_body": {
    "dry_multiplier": 0.8,
    "dry_base": 1.75,
    "dry_allowed_length": 3,
    "dry_sequence_breakers": ["\n", ":", "\"", "*", "{", "}", ";"],
    "thinking_budget_tokens": 8192
  }
}
```
(`presence_penalty` → 1.5 if loops persist; drop DRY and penalties during JSON/tool-constrained generation. DRY fields are llama.cpp-only — omit on vLLM.)

| Field | llama.cpp server | vLLM | SGLang | LM Studio | Ollama |
|---|---|---|---|---|---|
| temperature / top_p / top_k / min_p | ✅ native | ✅ (top_k, min_p via `extra_body`) | ✅ | ✅ | ✅ (`options`) |
| presence_penalty / frequency_penalty | ✅ | ✅ | ✅ | ✅ | ✅ |
| repetition_penalty | ✅ (`repeat_penalty`) | ✅ (`extra_body`) | ⚠️ accepted but **non-functional** (#10142) | ✅ | ✅ |
| DRY (`dry_multiplier` etc.) | ✅ per-request JSON | ❌ unsupported (#8581) | ❌ (fork only) | ✅ | ✅ (`PARAMETER`) |
| XTC / top-n-sigma | ✅ | ❌ | ❌ | ✅ | partial |
| thinking budget / early exit | ✅ `--reasoning-budget` + per-req `thinking_budget_tokens` (build-dependent) | ✅ `thinking_token_budget` + `--reasoning-config`; `reasoning_budget` (PR #37112) | ⚠️ broken for Qwen3.6 (#25536) | ❌ | ⚠️ `think` bool only |
| enable_thinking toggle | ✅ | ✅ `chat_template_kwargs`/`--reasoning-parser qwen3` (version-sensitive) | ✅ | ✅ toggle | ⚠️ template-dependent |
| grammar/JSON constrained | ✅ GBNF | ✅ (xgrammar/Outlines) | ✅ | ✅ | limited |

### Deliverable (b): Anti-loop levers ranked by evidence strength

1. **Correct sampling / no greedy decoding** — *Evidence: strongest (official Qwen3 cards + generation_config.json).* Tradeoff: none.
2. **`presence_penalty` 0.5–1.5** — *Evidence: official card guidance.* Tradeoff: >1.5 risks language mixing.
3. **Correct chat template + matching reasoning parser** — *Evidence: strong (QwenLM #131, vLLM #27118, community-fixed templates, Ollama #14798).* Tradeoff: re-validate on upgrades.
4. **DRY sampler (llama.cpp/LM Studio/Ollama)** — *Evidence: strong for llama-family; N/A on vLLM/SGLang.* Tradeoff: can break JSON/tool structure.
5. **Thinking budget / forced early exit** — *Evidence: medium; works well on vLLM, flaky on llama.cpp (#22717), broken on SGLang for Qwen3.6 (#25536).* Tradeoff: tight budgets without transition message cut accuracy (94%→78%).
6. **Avoid KV-cache quantization (q8_0/unquantized)** — *Evidence: strong.* Tradeoff: VRAM.
7. **Use ≥4-bit weight quants (Unsloth Dynamic 2.0)** — *Evidence: strong (arXiv:2504.04823).* Tradeoff: footprint.
8. **Disable static YaRN unless >32K context** — *Evidence: strong (Qwen cards; vLLM #18728; SGLang #6030).*
9. **Keep context shift disabled (llama.cpp)** — *Evidence: medium-strong.*
10. **Do NOT raise `repetition_penalty` for code** — *Evidence: strong ("rather causes looping"; Qwen3-VL #1611).* Keep at 1.0.

## Recommendations

**Stage 1 — Fix the fundamentals (in order):**
1. **Stop sending `temperature=0`.** Set the thinking-coding preset: `temperature=0.6, top_p=0.95, top_k=20, min_p=0.0`.
2. **Verify the chat template.** Confirm `<think>` handling and that the server's reasoning parser matches (vLLM: `--reasoning-parser qwen3`). If empty historical think blocks or premature stops appear, adopt a community-fixed Qwen3.5/3.6 template.
3. **Set `presence_penalty` as the first anti-loop dial:** start `0.5`, raise toward `1.5` if loops persist. Keep `repetition_penalty=1.0`.

**Stage 2 — Add a per-request anti-loop sampler matched to the server:**
- **vLLM (operative):** no DRY — rely on `presence_penalty` (0.5–1.5) via `extra_body`; optionally `frequency_penalty` 0.1–0.3.

**Stage 3 — Bound the thinking block:**
- **vLLM (operative):** use `thinking_token_budget` with `--reasoning-parser qwen3` + `--reasoning-config`, or the `reasoning_budget` request field on builds with PR #37112.

**Stage 4 — Fix serving/quant pitfalls:**
- q8_0 (or unquantized) KV cache; ≥4-bit weight quants; context shift off; YaRN off unless >32K; vLLM ≥0.21.0 if spec decode.

**Thresholds that change the plan:**
- Loops persist after Stage 1–2 at correct sampling → suspect quant or KV-cache quant.
- Accuracy drops after adding a thinking budget → budget too tight or lacks transition message; raise (start ~4K–8K for coding).
- Short prompts loop but long ones don't → static YaRN is the culprit.

## Caveats
- **Model identity:** "Qwen3.6-27B" is a dense, multimodal causal LM with thinking-on-by-default and the `qwen3_5` architecture tag; it dropped the `/think`–`/no_think` soft switch. If the local model is actually a text-only Qwen3-32B / Qwen3-Thinking-2507, the thinking `temperature=0.6` preset applies rather than the 27B's thinking-general `temperature=1.0`.
- **Version sensitivity is severe.** Thinking-budget behavior, enable_thinking routing, and reasoning parsers changed repeatedly across vLLM 0.8.5→0.9→0.11→0.21 and llama.cpp commits in early–mid 2026. Pin versions and re-test after upgrades.
- Conflicting field reports on llama.cpp reasoning-budget (build-dependent).
- Third-party Qwen3.6 GGUF benchmark numbers are contested; don't over-weight.
- Sampling values, server flags, arXiv findings, and GitHub issues/PRs are corroborated against primary sources; secondary blog guidance treated as such.
