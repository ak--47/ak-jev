# Changelog

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
