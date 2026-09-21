# AGENTS.md

Guidance for Claude Code and other agents working in `ak-jev`.

## Module overview

`ak-jev` wraps **TypeSafe's Jev**, the first System One model, at
`POST https://api.typesafe.ai/v1/systemone`.

Jev is not a chat model. One request carries a `state` and a map of typed
`questions`; the response carries one typed `answer` per question. There is no
generation, no conversation, no tool loop. The whole model surface is three
question types: `noul`, `choice`, `score`.

This package is developed inside the private `ak-ai-wrappers` workspace next to
`ak-claude`, `ak-gemini`, `ak-gpt` and `ak-litellm`. Those four wrap chat models
and share a class list (`Chat`, `Message`, `Transformer`, `ToolAgent`, …). **That
class list does not port here and should not be added.** ak-jev keeps the sibling
*ergonomics* — declarative constructors, `init()`, usage accounting, pricing
helpers, `types.d.ts`, esbuild CJS — and replaces the nouns.

Design spec, with the raw probe output this package is built on:
`docs/superpowers/specs/2026-09-21-ak-jev-design.md` in the workspace. It does not
ship in this repo; everything you need to work standalone is here.

---

## Things that will bite you

Every item is measured against the live API, not read from the docs. `npm run
probe-api` re-derives all of it and exits non-zero on a diff. **Run it before
trusting anything below.**

### 1. Jev is consistent, NOT deterministic — and the first draft of this package got that wrong

The first probe sent the same payload twice, got identical answers, and concluded
the API was a pure function. n=2 was luck. Twelve byte-identical requests:

| field | values | distinct | spread |
|---|---|---|---|
| `score` | 1.75 – 1.83 | 6 of 12 | 0.08 |
| `noul` | 0.47 – 0.53 | 7 of 12 | 0.06 |
| `confidence` | 0.94 – 0.97 | 4 of 12 | 0.03 |

Independently reproduced by the probe: 5 distinct scores in 10 calls, spread 0.09.

**Three consequences. Do not undo any of them without re-measuring:**

- **`cache` defaults to `false`.** An entry is a memo of one draw. TypeSafe's own
  self-consistency cookbooks sample the same request repeatedly; a default-on cache
  would give them an identical answer every time and they would conclude the model
  is perfectly stable. Do not flip this default back without re-measuring.
- **`sample()` exists** on `BaseJev` and as a top-level export. It bypasses the
  cache *unconditionally* via the internal `_bypassCache` option. If you touch
  `evaluate()`'s cache branch, keep that bypass working — `tests/unit/core.test.js`
  asserts it, and without it `sample()` reports a spread of zero, which is the
  exact wrong answer.
- **Never assert exact equality between two live calls.** `tests/live` asserts a
  spread band instead.

### 2. Answers drift when co-questions change, so the cache key covers the whole payload

| request | `score` |
|---|---|
| the question alone | 1.31 |
| alongside 2 other questions | 1.35 |
| the same 3, reordered | 1.32 |

Repeat probe measured 0.09 drift — the same order as the run-to-run noise. The docs
say questions are "evaluated independently"; that holds to about one decimal place.

`cacheKey()` hashes `{baseURL, model, state, questions}` canonically. **Never key on
a single question** — it would return answers that were never produced for that
request.

### 3. Three different `detail` shapes, and one with no message at all

```jsonc
{"detail": {"error_type": "authentication_error", "message": "..."}}   // 401, some 400s
{"detail": "Too many choices. Must have at most 255 choices."}          // most 400s
{"detail": [{"type":"missing","loc":["body","model"],"msg":"..."}]}     // 422, FastAPI
```

`{"detail":{"error_type":"max_tokens_exceeded"}}` carries **no message**. That is
why `JevRequestTooLargeError` is a separate class that writes its own, naming both
budgets and pointing at `estimate()`.

`describeDetail()` in `errors.js` owns all three. `tests/unit/errors.test.js` has
one case per shape, captured from the live API.

### 4. `model` is required, and the docs never say so

Omitting it is a `422`, not a default. `BaseJev` always sends one.

### 5. Hard limits are 400s, so ak-jev checks them first

| limit | value | over-limit body |
|---|---|---|
| Choice options | 255 max | `"Too many choices. Must have at most 255 choices."` |
| Choice options | 1 min | `"Choice question must have at least one choice: <id>"` |
| Score levels | 10 max | `"Too many score levels. Must have at most 10 levels."` |
| Score levels | 1 min | accepted — see below |
| Noul | needs `instructions` **or** `criteria` | `"Noul question must have criteria or instructions: <id>"` |
| Questions map | at least 1 | `422` |

A **one-level Score is accepted** and always returns `score: 0.0, confidence: 1.0`.
The docs say "at least two"; the API does not enforce it. `validateQuestions()`
**warns** rather than throws, because it is useless but not illegal.

`validate: false` turns the pre-flight off and lets the API decide.

### 6. The 32k budget is the one you hit, not the 64k one

64,000 tokens per request total; 32,000 for the state plus the **single longest
question**. A small state with one enormous question passes the first and fails the
second. `estimateRequest()` checks both and names the offending question.

Largest single-question request observed: **30,490–32,698** input tokens across runs.

### 7. Chars per token varies by a factor of three

Measured against an exact **267-token** baseline (empty state, one-character
question):

| content | chars/token |
|---|---|
| code | 3.47 |
| JSON object | 3.76 |
| English prose | 4.47 |
| legal text | 4.94 |
| one phrase repeated | 9.36 |

`tokens.js` uses **3.6** for the nominal estimate, between code and JSON, because a
Jev `state` is usually structured data. The budget check multiplies by
`BUDGET_SAFETY_MARGIN` (1.25) on top.

**Keep those two separate.** `totalTokens` feeds `estimatedCost`; `budgetTokens`
feeds the warning. Padding the cost figure would overstate spend by up to 45% on
prose.

This is also why a naive oversize test can fail: 277k characters of one repeated
phrase fits, while 200k characters of varied text does not. The live suite uses
varied filler deliberately.

### 8. `GET /v1/models` returns an envelope, and the docs' JS snippet is wrong

It returns `{"models": [...]}`, not a bare array. The Models page's JavaScript
example does `for (const model of await client.models.list())`, which would iterate
nothing. `JevClient.models()` and `listModels()` both unwrap it. The live suite
asserts the envelope so a future change is caught.

Only the two aliases are listed. Versioned ids like `jev-1.13.0` are accepted in
`model` but never appear in the list.

### 9. Fan-out is real, and it is the whole point

| questions in one call | wall time |
|---|---|
| 1 | 208 ms |
| 50 | 205 ms |
| 200 | 243 ms |
| 500 | 461 ms |

60 concurrent single-question requests: all 200, 530 ms wall, no 429.

No rate-limit headers are returned at all, so the governor is client-side only and
cannot adapt. Defaults sit under the published 1,200 rpm / 250,000 tps.

### 10. Pricing: output tokens are genuinely free

`$42/Btok` input = **`$0.042/Mtok`**. `MODEL_PRICING` stores per-Mtok to match the
sibling packages. `output: 0` is real, not a rounding.

`estimatedCost: null` means **unknown**, never free. `_accumulateUsage` propagates
`null` through the running total rather than summing a partial — reporting a
partial sum as complete would understate spend.

---

## Architecture

| file | role |
|---|---|
| `base.js` | `BaseJev`. `evaluate`, `evaluateMany`, `sample`, usage, cost, cache, pre-flight. |
| `client.js` | Transport on `fetch`: retry, timeout, governor hook, request-id capture. |
| `errors.js` | Error classes; `describeDetail()` normalizes the three `detail` shapes. |
| `questions.js` | `noul` / `choice` / `score`, shorthand expansion, limit validation. |
| `answers.js` | Enrichment. Raw fields untouched; derived fields added. |
| `models.js` | `MODEL_PRICING`, `MODEL_LIMITS`, aliases, `computeCost`, `listModels`. |
| `tokens.js` | Estimation and the two budget checks. |
| `cache.js` | Canonical key, LRU, optional disk. Off by default. |
| `governor.js` | Concurrency semaphore plus RPM and TPS sliding windows. |
| `evaluator.js` … `guard.js` | The nine classes, each a thin subclass. |
| `cli.js` | `ask`, `estimate`, `models`, `limits`. |
| `types.d.ts` | Hand-written. Generics infer answer types from question criteria. |
| `scripts/probe-api.mjs` | Re-derives every fact above and diffs it. |

```
BaseJev
├── Evaluator     reusable question set, one state or many
├── Classifier    one Choice + confidence gate + fallback
├── Detector      many Nouls → flags and tri-state verdicts
├── Scorer        weighted composite over normalized Scores
├── Router        intent → handler, per-route confidence bars
├── Ranker        query × candidates, batched by token budget
├── Extractor     bounded fields via Choice (Jev cannot generate)
├── Taxonomy      hierarchical walk with beam search
└── Guard         hazards → allow / review / block
```

### Design decisions

1. **Raw `fetch`, not `@typesafe-ai/sdk`.** That SDK is 1,266 lines of thin
   transport. Wrapping it would put the governor outside the retry loop and hide
   the raw `Response` on the error path — the only place the request id lives when
   a call fails. Retry field names match theirs exactly.
2. **Enrichment only adds.** Raw API fields are never modified. Every derived field
   is labelled in the README table and in `types.d.ts`. `NoulAnswer.confidence` is
   the one field that looks like an API field and is not — it is always flagged.
3. **All arithmetic in JavaScript.** Jev is explicitly not a calculator. `Scorer`
   weights, `sample()` statistics, `Taxonomy` path products and `answers.js`
   entropy are all computed here and never asked of the model.
4. **Client-side metadata is symbol-keyed.** `score()`'s level names ride on
   `QUESTION_META`, so `JSON.stringify` cannot leak them onto the wire.
   `toWireQuestions()` also rebuilds each question explicitly.
5. **Warn on shapes the API tolerates; throw on shapes it rejects.** A one-level
   Score warns. 256 choice options throw.
6. **Batch by token budget, not by count.** Candidate sizes vary by orders of
   magnitude between a log line and a legal passage.

---

## Commands

```bash
npm test              # 216 offline tests, ~1.3s, no network, free
npm run test:live     # JEV_LIVE=1, real API, ~30 tests, about $0.0003
npm run typecheck     # tsc --noEmit
npm run build:cjs     # esbuild → index.cjs
npm run probe-api     # re-derive every measured fact, diff, exit 1 on drift
node cli.js limits
```

**Run them with an explicit prefix from the workspace root** — `npm --prefix
ak-jev test`. A bare `npm test` after a `cd` that got reset will run a sibling
package's suite, and three of the four siblings make real, paid API calls.

Jest needs the ESM flags; `npm test` has them. Plain `npx jest` fails.

### Testing strategy

**Unit (`tests/unit/`, 216 tests).** Fully offline. `tests/jest.setup.js` sets a
fake key and points `TYPESAFE_BASE_URL` at `api.typesafe.invalid`, so a test that
forgets to inject a `fetch` fails with DNS rather than quietly spending money.
`_harness.js` builds fake responses and honours `AbortSignal` so the timeout and
abort paths are genuinely exercised.

**Live (`tests/live/`, ~30 tests).** Gated on `JEV_LIVE=1`. Every assertion is an
upstream fact, not a claim about ak-jev, so drift breaks a test here before it
breaks a consumer. Prints its own spend and asserts it stayed under a cent.

`tests/jest.setup.js` branches on `JEV_LIVE`. If you add a config, keep that branch.

---

## Environment

| variable | purpose |
|---|---|
| `TYPESAFE_API_KEY` | Required. Also accepted as `JEV_API_KEY`. |
| `TYPESAFE_BASE_URL` | Optional. Defaults to `https://api.typesafe.ai`. |
| `TYPESAFE_DEFAULT_MODEL` | Optional. Defaults to `jev-latest`. |
| `JEV_LIVE` | `1` un-skips the live suite. |
| `LOG_LEVEL` | pino level. |

`.env` is gitignored and holds a real key. Never commit it, never log it, never put
it in a fixture.

---

## When adding a feature

1. **Check whether the docs already name the pattern.** Nine classes map to
   documented patterns and cookbooks. A tenth should too.
2. **Measure, do not trust the docs.** The docs were wrong about `GET /v1/models`
   returning an array and about a Score needing two levels. This package's own spec
   was wrong about determinism. Probe it.
3. **Sample size matters.** Two identical answers do not prove determinism. Ten
   draws is the floor for any consistency claim.
4. **Add the fact to `scripts/probe-api.mjs`** so drift is caught automatically.
5. Add a unit test. Add a live test if it depends on API behaviour.
6. Run `npm run typecheck`, `npm test`, and `npm run probe-api`.

### Do not add

- **Generation of any kind.** Jev cannot write text. `Extractor` turns extraction
  into a Choice over candidates, which is the documented workaround.
- **Images, audio, video.** Text state only, upstream.
- **Embeddings, chat, tools.** Nothing in the API backs them.
- **Arithmetic questions.** Counting, date comparison and numeric interpolation are
  named failure modes on the jaggedness page. Keep the maths in code.
