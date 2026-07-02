# Adversarial Spec Review — Judgment

Spec: `spec.md` (this dir) | Judged: 2026-07-01 | Judge: fable | Pipeline: 3 sonnet finder waves → fable final-finder → sonnet verifier → sonnet refuter → fable judge

## Verdict summary

CONFIRMED 4 (F2, F3, F9, F11) | CONFIRMED-REDUCED 12 (F1, F4, F5, F7, F8, F10, F15, F16, F17, F18, F19, F20) | REJECTED 4 (F6, F12, F13, F14)
Dispositions: SPEC-FIX 16 | PLAN-NOTE 2 (F6, F14) | ACCEPTED-RISK 2 (F12, F13) | HUMAN_REQUIRED: F1 (blocking, portfolio) + F16 (non-blocking confirmation)
Refuter kills overturned: F17 (narrow), F18, F20. OPEN items: OPEN-4/5/6 resolved, OPEN-1 rewritten, OPEN-3 narrowed, OPEN-2 kept, OPEN-7 added.

## Key verifier ground truth (authoritative, source-cited)

- The fork's LIVE session path is the V1 `SessionPrompt.loop` (`handlers/session.ts:11,289,298-302` → `promptSvc.prompt()`+`loop()`; server deps include `SessionPrompt.node`). The core `SessionRunner` is NOT the live path. This spec targets the correct layer; the sibling `30-06-2026_fallback-takeover` spec targets the core runner.
- `prompt.ts` never publishes `session.next.synthetic`; compaction continuation is direct message insertion (`compaction.ts:489-515`); outer exit guard compares `lastUser.id < lastAssistant.id` (`prompt.ts:1111-1116`) — injection must happen at the inner `outcome === "break"` path.
- `MessageV2.latest()` has no synthetic exclusion; `prompt.ts` derives model/agent/parentID from `lastUser` (`:1141`, `:1170`, `:1188`).
- `mapFinishReason` (openai-chat.ts:378-384): stop/length/content_filter/function_call|tool_calls; everything else → `"unknown"`. Unknown-finish turns end silently (processor.ts:677-679 returns "continue"; prompt.ts:1294 excludes unknown from finished; next-iteration outer guard breaks).
- `toModelMessagesEffect` DOES serialize reasoning parts into outgoing messages (`message-v2.ts:362-376`); native path too. F4's client-side no-replay claim refuted; template-side replay is OPEN-7.
- Penalties ARE emitted on the AI SDK openai-chat path (`openai-chat.ts:364-365`). Confirmed gaps: `min_p` absent from `GenerationOptions`; `top_k` not emitted AND on `PROTOCOL_BODY_OVERLAY_DENYLIST`; native `RequestInput`/`generation()` lack penalties.
- Pending tool calls are already transitioned to `error` + `interrupted: true` by cleanup on ALL exits (`processor.ts:575-591` via `Effect.ensuring`) — truncated tool calls cannot execute today.
- Event-manifest ground truth: schema tests assert 55/85/85/32; opencode test asserts `Latest === 90` and identity-asserts the rest against schema. New event → schema 56/86/86/33; opencode 91.
- V1 never sets `toolChoice: "none"` on last step; `step++` at `:1132`; `isLastStep` at `:1178-1179`; `MAX_STEPS_PROMPT` at `:1280`.
- `Todo.Service` queryable but not imported/provided in `prompt.ts`.

## FIX LIST applied to spec.md (13 items)

1. §5.0/§5.1/§3 injection+interception rewrite (F2+F1+F4 hook): inner-break interception; direct insertion; copy agent/model/format + parentID linkage; re-resolve current session model if takeover coexists; never `ignored: true`; OPEN-4/OPEN-5 resolved.
2. §5 loop end-state matrix + finish mapping requirement (F3): repetition-kill=unknown (silent today) / budget-close=§5.3 / cap-hit=length; fork-side `mapFinishReason` extension or outer-guard telemetry-only `observed` event; §5.3 finish gate; trade-off statement.
3. §5.1 reasoning-only routing (F4+F19): length+empty+reasoning → §5.3 family; `reasoning_only` tag; OPEN-7 (template replay).
4. §L0.1/OPEN-1 rewrite (F5): per-field/per-path delivery matrix; native path scoping; A1 per-field.
5. §5.5 step accounting (F9): recovery consumes steps; no injection when `step+1 >= maxSteps`; bound = min(caps, remaining steps); OPEN-6 resolved.
6. §5.1 Action (1) discard rewrite (F10): existing cleanup is the guarantee; recovery adds `truncated: true` metadata; OPEN-3 narrowed.
7. §5.2 trigger exactness (F7): normal stop := `finish==="stop"` AND no error; provider-executed tools count as progress; joined text := text parts only.
8. §5.0 state model (F8): generic real-user predicate walk-back; pruned-anchor fallback; reset placement; compaction-no-reset; queued prompt; mid-sequence disable; gaming risk row.
9. §5.2/§11 Todo wiring (F11): normative wiring requirement + R12 stale-todo storm risk.
10. §8/§3/§9-D events & artifacts (F15+F17n+F19+F3): corrected manifest facts (schema 56/86/86/33; opencode Latest 91 identity); modification targets `Definitions`/`DurableDefinitions`/`Durable` union; SDK regen step `bun ./packages/sdk/js/script/build.ts` + `SessionDurableEvent` union; event fields `observed` action, tokens, cost, `reasoning_only`; usage roll-up statement.
11. §6 non-TUI surfaces (F16): documented v1 exclusion (web filters synthetic parts, `message-part.tsx:1128`); headless fallback = events/log; shares include recovery messages.
12. New staged-validation subsection (F18): Phase 0 baseline → Phase 1 L0-only → Phase 2 L1 per-component → Phase 3 UC2 L2 go/no-go.
13. §9 AC additions (F20+): master-off negative, structured-output exclusion, compaction priority/single injection, abort no-reinjection, graceRetry:false, max:0, shared counter, step eligibility, observed-on-unknown.

## PLAN-NOTES (carry into plan.md, not spec defects)

- F6: recipe example must include `model.limit.output`; add reasoning-parser/tool-call routing canary.
- F14: pick doom_loop pending-ask enforcement mechanism (Permission.list() vs shared flag).
- F10/OPEN-3: fixture for the no-part truncation shape.
- OPEN-2: model-level temperature precedence capture test (A2).
- OPEN-7: verify vLLM Qwen-template replay of prior-turn reasoning.
- Phase-0 capture of the raw vLLM repetition-stop finish_reason string.

## HUMAN_REQUIRED

1. **F1 (blocking, portfolio — does not block THIS spec):** The live session path is V1 `SessionPrompt.loop`, which this spec correctly targets. The approved sibling spec `30-06-2026_fallback-takeover` targets the core runner, which is NOT the live path. Decide: (a) rework fallback-takeover to target V1, (b) keep it as a future V2-migration artifact, or (c) park it.
2. **F16 (non-blocking confirmation):** Recovery messages are invisible in web/app clients in v1 (they filter synthetic user parts) — auto-continues are effectively hidden on those surfaces. Confirm the documented v1 exclusion is acceptable under UC4's "no hidden auto-continues" intent, or pull web rendering into v1 scope.

## Accepted risks (documented, no action)

- F12: nudge-text hazards (config tunables cover); F13: `limit: 0` unlimited mode (explicit opt-in, R8).

## Process note

Finder-wave loop stopped after wave 3 on declining/saturating yield (47→28→18 findings, no new criticals in W3) instead of a strict zero-new wave; fable final-finder served as catch-all and contributed the highest-value architectural findings (F3 core, F4, F18). Recorded as a deliberate deviation.
