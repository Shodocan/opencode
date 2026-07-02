# Deep Research Report 3 — Streaming Thinking-Loop Detection & Recovery (vLLM/Qwen3)

> Source: external deep-research run, pasted 2026-07-01. Preserved verbatim as evidence for spec/plan review.
> NOTE: this report informs the DEFERRED L2 layer (streaming detector). Kept as design input for the follow-up feature; also contains vLLM server-side primitives that ARE in scope for L0.

## TL;DR
- **Watch only the `reasoning_content` delta channel** (vLLM's Qwen3 reasoning parser exposes it separately in streaming), run a cheap **line-level exact-repeat detector at newline boundaries plus a rolling n-gram/compression check**, and **abort at 2–4k reasoning tokens** rather than the 32k cap — the single highest-ROI optimization. Then apply a **ranked recovery ladder** whose best first rung for Qwen3 is **prefill `</think>` to force the answer phase**, escalating to param bumps and finally a fallback model.
- **False positives are the main risk.** Require **≥3–4 consecutive/near-consecutive repeats** and a **minimum cycle length**, monitor only the thinking channel, and whitelist structured content — matching what OpenHands (3–4 repeats), llama.cpp's proposed line detector, and vLLM's own `RepetitionDetectionParams` (`min_count ≥ 2`) do. SWE-agent deliberately runs only 100%-precision guardrails.
- **vLLM already ships two native primitives**: `SamplingParams.repetition_detection` (N-gram scheduler stop → `FINISHED_REPETITION`) and `thinking_token_budget` (forces `</think>` when the reasoning budget is hit). Combine server-side budgets with a client-side streaming detector for defense in depth.

## Key Findings

### 1. Detection algorithms and what production actually uses
- **N-gram overlap / exact repeat** is the workhorse. HuggingFace `no_repeat_ngram_size` (typically 3) is the canonical prevention primitive. vLLM's native `RepetitionDetectionParams` detects a repeating token N-gram of size `min_pattern_size..max_pattern_size` recurring `min_count` (≥2) times.
- **Line-level exact-repeat** is the cheapest effective online detector for reasoning loops. llama.cpp issue #21264 proposes a sliding window of the last N≈20 generated lines, comparing each completed line (on `\n`) against the window; overhead "near zero." Targets the R1/Qwen3/GPT-OSS/GLM thinking-loop pattern where each line is token-level varied but line-level identical.
- **Compression-ratio (zlib/gzip)** heuristics: canonical reference is **OpenAI Whisper's `transcribe.py`, `--compression_ratio_threshold` default 2.4** ("if the gzip compression ratio is higher than this value, treat the decoding as failed"). Normal English zlib ratios ~2:1–5:1; degenerate repetition pushes far higher. Best as a secondary corroborating signal over a window.
- **Self-BLEU / repetition metrics** from the literature: Holtzman et al. (arXiv 1904.09751) define a loop as a phrase (min length 2) repeating **≥3 times at the end** of generation. Welleck et al. (arXiv 1908.04319), citing Holtzman: **"the average percentage of repeated n-grams in model continuations with greedy decoding (43%) far exceeds that of humans (0.5%)."**
- **Reasoning-model-specific looping** is documented and active. Qwen3/Qwen3-VL/Qwen3.5 repeatedly enter infinite reasoning loops in vLLM, often never emitting `</think>` until the budget is exhausted. Underthinking paper (Wang et al., arXiv 2501.18585): **"o1-like LLMs consume 225% more tokens in incorrect responses than in correct ones due to 418% more frequent thought-switching behaviors."**

**Comparison of detection methods**

| Method | Sensitivity | FP rate on code | Compute/delta | Detection latency |
|---|---|---|---|---|
| Line-level exact repeat (window ~20 lines) | High for verbatim loops | Low if min-repeat ≥3 | Trivial (runs on `\n`) | ~2–3 repeated lines |
| Rolling n-gram overlap (n=3–8, window 256–512 tok) | High | Medium (boilerplate) | Low (hash set) | ~1–2 cycles |
| zlib compression ratio (window 1–4k chars, cutoff ~2.4) | Medium | Low–medium | Low (per chunk) | Lagging, needs window |
| Self-BLEU / semantic similarity | High incl. paraphrase loops | Low | High | Slow |
| Token-histogram saturation / entropy drop | Medium | Medium | Low if logprobs available | Medium |

### 2. False-positive handling
- **Legitimate repetition is real.** QwenLM/Qwen3-VL #1611: *"Increasing the repetition penalty is not an acceptable solution because it breaks the transcription of naturally repetitive text, for example in tables."* Code boilerplate, repeated imports, similar signatures, re-reading file content inside reasoning all trip naive detectors.
- **Consecutive-repeat requirements** are the primary defense. OpenHands requires **4 identical action-observation pairs**, **3 identical action-error pairs**, **3 repeated agent messages (monologue)**, or a **6-step A-B-A-B alternation** (`openhands/controller/stuck.py`). vLLM `RepetitionDetectionParams.min_count` ≥2 (auto-enabled for structured output at `min_count=4`). Holtzman uses ≥3. Whisper's compression cutoff is 2.4.
- **Minimum cycle length**: DRY's `allowed_length` (default 2) — sequences ≤2 tokens never penalized.
- **Channel isolation**: monitor the reasoning channel only. vLLM's Qwen3 reasoning parser emits `reasoning_content` deltas separately from `content`.
- **Sequence breakers / whitelisting**: DRY defaults `\n`, `:`, `"`, `*` (p-e-w PR #5677); add `;`, `{`, `}` for code. OpenHands compares edit actions by first 3 lines, ignores PIDs (`_eq_no_pid`).
- **SWE-agent's stance**: tried semantic stuck detection, abandoned it — false positives too high; keeps only 100%-precision guardrails (cost, syntax check, lint+revert). OpenHands' counterpoint: stuck detection is safe when false-positive cost is low (abort/notify, not crash).
- **OpenHands FP incident** (#5355): loop detection killed agents legitimately waiting on long-running processes (2-min timeout × sleep-polling). Lesson: time/stall triggers need process-awareness.

### 3. Secondary "stuck" signals
- **OpenHands StuckDetector** (~488 lines) — reference implementation, five heuristics, all requiring N repeats, comparing semantic content (ignoring IDs/PIDs), only after the last user message in interactive mode: (1) 4× identical action+observation; (2) 3× identical action + `ErrorObservation`; (3) monologue = 3 consecutive identical agent messages; (4) 6-step A-B-A-B-A-B ping-pong; (5) ≥10 repeated `AgentCondensationObservation`.
- **Tool-call repetition**: same tool + identical args 3rd consecutive iteration.
- **Reasoning budget mechanisms**: vLLM native `thinking_token_budget` (forces `</think>`) and `RepetitionDetectionParams`. SGLang `thinking_budget` buggy (#25536). Transformers pattern: `ThinkingTokenBudgetProcessor(max_thinking_tokens=N)`.
- **Reasoning-length vs correctness**: arXiv 2505.00127 — models overthink easy problems, underthink hard ones → task-complexity-scaled budget is legitimate.
- **Time-based stall**: no tokens for X seconds — hard-timeout backstop, gated on "no tool activity" (OpenHands #5355 lesson).

### 4. Recovery policy ladder (ranked, Qwen3-on-vLLM)
1. **Prefill `</think>` to force the answer phase (best first move).** vLLM's `thinking_token_budget` does exactly this: at budget, "vLLM forces the model to produce `reasoning_end_str`." Edge case: forcing the answer on an unsolved problem yields lower-quality but *bounded* response. Caveat: not enforced under MTP speculative decoding (#39573).
2. **Abort + retry same model with anti-repetition params.** Qwen official: presence_penalty 0–2, **1.5 recommended for significant repetition; quantized-model cards "strongly recommend setting this value to 1.5"** (relevant to FP8). Temp bump + presence_penalty 1.5 + new seed is the standard retry. Caution: Unsloth found naive repetition penalties *caused* looping on QwQ-32B until sampler order changed.
3. **DRY sampler (prevention, if exposed).** `penalty = multiplier * base^(match_length − allowed_length)`. Defaults: multiplier 0.8, base 1.75, allowed_length 2, breakers `\n : " *`. **Not merged into vLLM** (unmerged PR #11368 / issue #8581) — on vLLM use penalties/`bad_words`/custom `logits_processors`.
4. **Retry with thinking disabled** (`enable_thinking:false` via `chat_template_kwargs`).
5. **Reduce context (drop oldest turns / compact) then retry** — addresses long-context degeneration (QwenLM/Qwen3.5 #115).
6. **Fallback to a different model** — last resort; also mitigates Qwen3-Coder/vLLM looping that did *not* reproduce under llama.cpp.

### 5. Cost/latency accounting
- **Early detection is the dominant lever.** Qwen3.5 LiveCodeBench case burned up to 81,920 tokens never emitting `</think>` (QwenLM/Qwen3.6 #88); full-reasoning MMLU run produced >20% empty responses from hitting `max_tokens` mid-reasoning. Detecting at 2–4k reasoning tokens instead of 32k saves ~85–95% of wasted tokens on a looping request.
- **Detection overhead**: line-level and n-gram-hash ~O(1) amortized per delta. Run per-line/per-chunk. zlib/self-BLEU per 256–512 new tokens, never per token.
- **vLLM abort**: `AsyncLLMEngine.abort(request_id)`; on the OpenAI server, client disconnect triggers abort (middleware caveat #10087; v1 abort semantics differ from v0 per #20362/#24584). In a TS harness, closing the fetch stream / `AbortController` is the practical trigger.
- **Telemetry per incident**: loop signature (hash of repeating unit + cycle length), detector/threshold fired, reasoning-token count at detection, model + sampling params + backend/quant, task features, recovery rung, retry outcome.

## Details

### vLLM streaming reasoning channel (critical for the detector)
The Qwen3 reasoning parser (`vllm/reasoning/qwen3_reasoning_parser.py`, `--reasoning-parser qwen3`) implements `extract_reasoning_content_streaming(...)` splitting each delta into `reasoning_content` vs `content`, using token IDs for speed. Streaming chunks carry `delta.reasoning_content` (newer docs: `reasoning`). **Key the detector off `delta.reasoning_content` only.** Known bugs: with `enable_thinking:false`, some builds (~0.20.0) mis-route all deltas to `reasoning`; downstream clients have dropped post-thinking `content` chunks (Open WebUI #24697). Qwen3 `</think>` token id **151668** (`<think>` = 151667).

### Native vLLM primitives (confirmed in `vllm/sampling_params.py`, main branch)
- **`repetition_detection: RepetitionDetectionParams | None`** — docstring: *"Parameters for detecting repetitive N-gram patterns in output tokens. If such repetition is detected, generation will be ended early…"* Fields: `max_pattern_size` (0 disables), `min_pattern_size` (≤ max), `min_count` (≥2 when enabled). Runs as a **scheduler stop condition** (`check_sequence_repetition` in `vllm/v1/core/sched/utils.py`) — finishes with `FINISHED_REPETITION` / stop reason `repetition_detected`. Auto-enabled for grammar-constrained output (reported `max_pattern_size=20, min_count=4`). Exposed as a request field on the OpenAI-compatible server. (Introduced ~vLLM v0.17.0 per integrators — verify against pinned version.)
- **`thinking_token_budget: int | None`** — *"Maximum number of tokens allowed for thinking operations."* `-1` → unlimited. Enforced in `vllm/v1/sample/thinking_budget_state.py` via `apply_to_logits(...)` which *"masks and bumps logits for forced end-of-thinking tokens"* — i.e. **forces `</think>`**. Works in streaming; introduced in **PR #20859**; **not enforced under MTP speculative decoding (#39573)**. Related open PR #37112 (`reasoning_budget`).

### DRY sampler design (state of the art for prevention)
From p-e-w's PR #5677: DRY penalizes tokens that would extend the current suffix into a sequence already seen. `penalty = multiplier * base^(n − allowed_length)`. Defaults: 0.8 / 1.75 / 2 / breakers `\n : " *`. For code add `; { }`. Sampler order matters: Unsloth's QwQ-32B fix `top_k;top_p;min_p;temperature;dry;typ_p;xtc`. **Not in mainline vLLM.**

### OpenHands StuckDetector heuristics (verbatim thresholds)
Needs ≥3 filtered events. S1: last **4** actions and **4** observations equal. S2: last **3** actions equal + last **3** observations all errors (or all IPython `SyntaxError` consistent). S3 (monologue): **3** consecutive identical agent `MessageAction`s, no observation between. S4: 6-step **A-B-A-B-A-B**. S5: **≥10** consecutive `AgentCondensationObservation`. `_eq_no_pid` ignores PIDs/command_ids; compares IPython edit actions by first 3 lines (requiring >2 lines). Practitioners: this ~100-LOC detector saved "more money than any other optimization."

### Reasoning-model looping evidence (primary reproductions)
Qwen3-8B repetition in vLLM (#25977, temp 0.6/top_p 0.9); Qwen3-VL-30B-A3B "keeps outputting the same phrases," worse with lists/JSON (#27157); Qwen3.5-35B-A3B on LiveCodeBench loops inside `<think>`, never emitting `</think>`, exhausting 81,920 tokens (#88); Qwen3-Coder-Next "randomly looping gibberish" under vLLM but 50/50 clean under llama.cpp with Q5_K_XL GGUF (spark-vllm-docker #115); **OpenCode compaction-summary loop with local vLLM Qwen3-Coder (#22792); generic OpenCode "infinite thinking loop" — a reasoning block repeated 6× verbatim (#27921)**. Reinforces: Qwen3 looping is partly a serving-stack interaction (FP8/KV-quant/long-context/async scheduling), not purely a sampler issue.

## Recommendations

### Recommended default configuration (TS harness, vLLM + Qwen3)

**Server side (vLLM) — defense in depth:**
- Serve with `--reasoning-parser qwen3` so `reasoning_content` is separated in streaming deltas.
- `thinking_token_budget ≈ 4096` for agentic/tool tasks. Disable if depending on MTP spec-decode.
- Enable `repetition_detection` with **`min_pattern_size=1, max_pattern_size≈40, min_count=4`** as a server-side backstop.
- Qwen thinking-mode sampling: temp 0.6, top_p 0.95, top_k 20, min_p 0, **presence_penalty 1.0–1.5 (1.5 for FP8/quantized)**, repetition_penalty 1.0. Never greedy.

**Client side — streaming detector on `delta.reasoning_content` only (L2, deferred):**
- **Primary — line-level exact repeat**: ring buffer of last **~24** non-trivial lines (ignore <15 chars); flag when same line appears **≥3 times** or a 2–4-line block repeats ≥3 times.
- **Secondary — rolling n-gram**: last **512 reasoning tokens**, token **8-grams**; flag if fraction of new tokens inside already-seen 8-grams exceeds **~0.5** sustained.
- **Corroborating — zlib ratio**: every 512 new reasoning tokens over last ~2k chars; raise confidence above **~2.4**.
- **Budget trigger**: reasoning tokens exceed task-scaled budget (≈2k simple / 4k default / 8k hard) with no tool call or `</think>`.
- **Stall trigger**: no delta for **>20 s** → abort (gate on absence of tool activity).
- **Fire only on ≥2 signals, or one high-confidence signal (≥3 exact line/block repeats).** Whitelist fenced code blocks/tables; add `; { }` to structural-ignore set.

**Recovery ladder (execute in order; cap retries at 2–3):**
1. Abort stream (`AbortController`; server frees KV via disconnect). Re-issue with **`</think>` prefilled** to force the answer phase.
2. Re-loops: retry with **temp +0.1–0.2, new seed, presence_penalty 1.5**.
3. Still looping: retry with **`enable_thinking:false`**.
4. Large context: **compact / drop oldest turns**, retry.
5. **Fallback model**.

**Thresholds that would change the policy:**
- FP aborts on legitimate code/table generation → raise consecutive-repeat to 4, lengthen min cycle, restrict strictly to `reasoning_content`.
- Loops rarely caught before ~8k tokens → lower budget trigger and n-gram window.
- If `thinking_token_budget` proves reliable in the pinned vLLM build → lean server-side, relax client aggressiveness.
- If server-side `repetition_detection` alone catches most incidents with acceptable precision → downgrade client detector to telemetry-only.

## Caveats
- `repetition_detection` and `thinking_token_budget` are recent vLLM additions; exact defaults and the introducing PR came partly from secondary sources — verify against the pinned vLLM version. `thinking_token_budget` (PR #20859) unenforced under MTP spec-decode (#39573).
- DRY not native to vLLM.
- Streaming reasoning-channel bugs exist across vLLM versions and downstream clients — validate delta parsing end-to-end before trusting channel isolation.
- SWE-agent evidence cautions semantic loop detection FP rates; mitigation: abort-and-retry is low-cost, tune for recall with cheap reversible recovery.
- Qwen3 looping is partly a serving-stack interaction — treat model/params/backend/quant as part of the loop fingerprint.
- Several client-side numbers (line-window ≈24, n-gram fraction 0.5, budgets 2k/4k/8k) are practitioner heuristics extrapolated from sourced anchors (Whisper 2.4; Holtzman ≥3; OpenHands 3–4; llama.cpp N≈20), not benchmarked optima — calibrate on real traffic.
