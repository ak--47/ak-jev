# Changelog

## 0.2.0 — 2026-09-28

### Mixpanel's LiteLLM gateway

ak-jev can now run on Mixpanel's LiteLLM gateway, which has a pass-through route
to **Kev** (`jaredpalmer/kev-4b`), a self-hosted System One model. Your code does
not change. Set two variables:

```bash
JEV_PROVIDER=litellm
LITELLM_API_KEY=sk-...     # litellm.mixpanel.org → Virtual Keys → Create Key
```

Or pass `provider: 'litellm'` to any class. See "Mixpanel's LiteLLM gateway (Kev)"
in the README.

- New `provider` option on every class and on `JevClient`, `listModels()` and
  `estimate()`: `'typesafe'` (the default) or `'litellm'`. The `JEV_PROVIDER`
  variable sets it too.
- Each provider has its own key variable, base URL and default model, and reads
  only its own variables. litellm reads `LITELLM_API_KEY` and `LITELLM_BASE_URL`
  (the same variables as ak-litellm) and defaults to `kev-latest` at
  `https://litellm.mixpanel.org/typesafe`. An explicit `apiKey`, `baseURL` or
  `modelName` still wins.
- The per-attempt timeout defaults to 120 s on litellm. Kev latency grows with
  question count (1,000 questions took about 30 s), so Jev's 30 s default would
  time out large requests.
- `MODEL_PRICING['kev-latest']` is `$0 / $0`. Kev is free, so `estimatedCost` is
  `0` and not `null`.
- `MODEL_LIMITS['kev-latest']` holds Kev's measured limits: 8,192 tokens for the
  state plus the longest question, 255 score levels, and 10 tokens of overhead.
  The gateway serves every model name from Kev, so these limits apply to every
  request on litellm, `jev-latest` included. `resolveLimits(model, provider)`
  takes the provider as a new second argument.
- Usage on litellm adds `callId` (`x-litellm-call-id`) and `keySpend`
  (`x-litellm-key-spend`, the key's cumulative USD, which lags). If the gateway
  sends `x-litellm-response-cost`, `estimatedCost` uses it and `costSource`
  becomes `'gateway'`. New `gatewayMeta()` export.
- Errors: ak-jev reads LiteLLM's `{"error": {...}}` body. A 401 names the key
  variable of the active provider. Kev's `422 branch too long` becomes
  `JevRequestTooLargeError`.
- CLI: new `--provider` flag. `ak-jev limits` lists Kev. The usage footer shows
  key spend when the gateway sends it.
- New exports: `PROVIDERS`, `DEFAULT_PROVIDER`, `resolveProvider`,
  `LITELLM_DEFAULT_ROOT`, `gatewayMeta`.
- `npm run probe-api:litellm` measures Kev's facts again on the gateway, for free.
  The live suite runs four Kev tests when `LITELLM_API_KEY` is set.

### Kev is not Jev: what we measured

We measured Kev against the gateway on 2026-09-28. Kev is a different and much
smaller model (a LoRA on Qwen3.5-4B-Base). Check thresholds you tuned on Jev
before you use them on Kev.

| | Jev (typesafe) | Kev (litellm) |
|---|---|---|
| State + the single longest question | 32,000 tokens | **8,192 tokens** |
| Total tokens per request | 64,000 | no limit found up to 226,822 |
| Score levels | 10 | 255 |
| Choice options | 255 | 255 |
| Fixed request overhead | 267 tokens | 10 tokens |
| Latency, 1 / 200 / 1,000 questions | ~0.2 s / ~0.2 s / ~0.5 s at 500 | ~0.2 s / ~1.5 s / ~30 s |
| 10 identical requests in sequence | 7 distinct scores, spread 0.07 | identical |
| 12 identical requests in parallel | not measured | spread 0.0027 (server batching) |
| Price | $0.042/Mtok input | free |
| Over the state limit | 400 `max_tokens_exceeded` | 422 `branch too long … (row limit 8192)` |
| 256 options or levels | 400 string | 422 validation array |
| Empty choice | 400 | 422 |
| Noul with no instructions or criteria | 400 | 200 (ak-jev still refuses it) |
| Missing or unknown `model` | 422 / 400 | 200: Kev answers every name |
| Bad key | 401 `{"detail": {...}}` | 401 `{"error": {...}}` from LiteLLM |

Other findings:

- The gateway answers every model name from the same Kev server. The name only
  changes billing: `kev-latest` did not move the key's spend, and two `jev-*`
  calls moved it at exactly $0.042/Mtok. That is two samples.
- `x-litellm-response-cost` was absent. `x-litellm-key-spend` updates late, often
  by a minute or more, so it is a running total and never a per-call cost.
- `x-typesafe-request-id` passes through the gateway, so `requestId` still works.
- 60 concurrent requests to Kev all returned 200.
- The cache still defaults to `false` on both providers. Kev is near-deterministic,
  but the provider must not change what `sample()` means.

### Tests

- Every test in `classes.test.js` now runs on both providers. On each pass, the
  fake `fetch` refuses a request to the other provider's URL or with the other
  provider's key. The offline suite grew from 226 to 332 tests.
- `providers.test.js` covers provider resolution, environment variable scope,
  gateway usage and headers, Kev limits, and the gateway error shapes.

The typesafe provider does not change. The TypeSafe probe gave 29 of 29 matches
after this change.

## 0.1.0 — 2026-09-21

First release. Node.js bindings for TypeSafe's Jev, the first System One model.

### Core

- `BaseJev` with `evaluate()`, `evaluateMany()`, `sample()`, `raw()`, `estimate()`,
  `estimateCost()`, `getLastUsage()`, `getTotalUsage()`, `stats()`, `listModels()`.
- Transport written on global `fetch`. No runtime dependency beyond `dotenv` and
  `pino`. Retry-policy field names match `@typesafe-ai/sdk` exactly.
- Retry with jittered exponential backoff on 408/409/429/5xx/529, timeouts and
  connection failures. 401 and 422 are not retried.
- Rate governor: concurrency semaphore plus sliding windows for requests/minute
  and tokens/second, defaulted under the published 1,200 rpm and 250,000 tps.
- Response cache, **off by default**. Canonical whole-payload key, in-memory LRU,
  optional write-through to disk.

### Questions and answers

- `noul()`, `choice()`, `score()` builders.
- `choice()` accepts a plain array of labels; the official builder throws on one.
- `score()` accepts an ordered `{ name: description }` object, and the names come
  back as `answer.label`. Names are symbol-keyed so they cannot reach the wire.
- A bare string in a question map is shorthand for a Noul.
- Answer enrichment. Raw API fields are never modified; derived fields are added
  and labelled: `yes`, `verdict`, `confidence` (Noul); `ranked`, `runnerUp`,
  `margin`, `entropy` (Choice); `normalized`, `level`, `label`, `ranked`,
  `entropy` (Score).
- Pre-flight validation against every limit the API enforces with a 400.

### Classes

`Evaluator`, `Classifier`, `Detector`, `Scorer`, `Router`, `Ranker`, `Extractor`,
`Taxonomy`, `Guard`. Each maps to a pattern or cookbook in TypeSafe's docs.

### Errors

One readable message from the API's three different `detail` shapes.
`JevRequestTooLargeError` supplies its own message and the fix, because
`{"detail":{"error_type":"max_tokens_exceeded"}}` carries none.

### Hardening applied during pre-release review

- **Every class now refuses a response with a missing answer** instead of skipping
  it. A dropped dimension used to shrink a `Scorer` composite silently; a dropped
  `Guard` hazard used to read as "did not fire". `requireAnswers()` names the
  missing ids and points at the likeliest cause, an `opts.questions` id colliding
  with one of the class's own.
- **`Extractor` names the field when a `transform` throws**, rather than surfacing
  the bare error from inside your callback.
- **A disk-backed cache no longer grows memory without bound.** Entries read back
  off disk now go through the same LRU eviction as writes.
- **`sample()` no longer leaks its `n` option** into the per-call evaluate options.
- **`Ranker` builds each candidate's question once**, not twice. It was serialized
  to size the batch and again to send it — doubled work on every candidate.
- **`Taxonomy` reports `truncated: true`** when `maxDepth` stopped the walk above a
  leaf, so a partial path is distinguishable from a complete one.
- **Standalone `estimate(state, questions)`** export. Synchronous, free, and needs
  no API key, so `ak-jev estimate` works without one and you can size a job before
  configuring a client.
- **CLI `--api-key`**, and every value-taking flag now rejects a missing value
  rather than silently reading the next flag as its argument.

### Tooling

- Hand-written `types.d.ts`. Answer types are inferred from question criteria: a
  Choice over `{billing, tech}` narrows `choice` to `'billing' | 'tech'`.
- CLI: `ask`, `estimate`, `models`, `limits`.
- `npm run probe-api` re-derives every measured fact against the live API and
  exits non-zero on a diff.
- 216 offline unit tests (~1.3s, no network) and ~30 live tests (about $0.0003).

### Measured facts this release is built on

Probed against the live API on 2026-09-21. Full detail in `AGENTS.md`.

- **Jev is consistent but not deterministic.** Twelve byte-identical requests gave
  six distinct score values spanning 0.08. This is why the cache is off by default
  and why `sample()` exists.
- Fixed request overhead is exactly **267** input tokens.
- Chars per token ranges from 3.47 (code) to 9.36 (one repeated phrase). The
  estimator uses 3.6 and pads the budget check by a further 25%.
- The binding context limit is **32k for state plus the longest question**, not the
  64k total.
- `GET /v1/models` returns `{models: [...]}`, not an array. The docs' JavaScript
  example iterates the wrapper and would yield nothing.
- `model` is a required field. The docs do not say so; omitting it is a 422.
- A one-level Score is accepted and always returns `0.0` at confidence `1.0`. The
  docs say two are required. ak-jev warns rather than throws.
- Fan-out is real: 1 question 208 ms, 200 questions 243 ms, 500 questions 461 ms.
- Pricing: $0.042 per million input tokens. Output tokens are free.
