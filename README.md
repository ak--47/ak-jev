# ak-jev

Node.js bindings for **[TypeSafe's Jev](https://docs.typesafe.ai)** — the first
System One model.

Jev is not a chat model. You send a **state** and a map of typed **questions**, and
you get back one typed **answer** per question: a probability, a label with a full
distribution, or a position on a rubric you wrote. No prose. No JSON coaxing. No
parsing. Your code branches on the numbers.

It answers in about 200 ms and costs **$0.042 per million input tokens** — output
tokens are free — which is roughly a thousandth of a frontier model call. That
price and that latency are what make it worth putting a semantic check on *every*
request, not just the interesting ones.

```javascript
import { ask, noul, choice, score } from 'ak-jev';

const { answers } = await ask(ticket, {
  urgent: noul('Does this convey urgency?'),
  team:   choice('Who handles this?', ['billing', 'technical', 'sales']),
  anger:  score('How angry is the customer?', ['Calm', 'Annoyed', 'Furious'])
});

answers.urgent.noul        // 0.96
answers.urgent.verdict     // 'yes'
answers.team.choice        // 'billing'
answers.team.confidence    // 0.92
answers.team.runnerUp      // { label: 'technical', probability: 0.05 }
answers.anger.normalized   // 0.73   ← 0–1 regardless of how many levels you wrote
```

All three questions were answered in **one request**, in parallel, for about two
thousandths of a cent.

---

## Install

```bash
npm install ak-jev
```

Node 22 or newer. Put your key in `.env`:

```bash
TYPESAFE_API_KEY=apikey_...
```

Get one at [console.typesafe.ai/keys](https://console.typesafe.ai/keys).

At Mixpanel, you can skip the TypeSafe key and use the LiteLLM gateway instead.
See [the next section](#mixpanels-litellm-gateway-kev).

---

## Mixpanel's LiteLLM gateway (Kev)

Mixpanel's LiteLLM gateway has a pass-through route to **Kev**, a self-hosted,
open-weight System One model ([`jaredpalmer/kev-4b`](https://huggingface.co/jaredpalmer/kev-4b),
a LoRA on Qwen3.5-4B-Base). Kev speaks the same `/v1/systemone` protocol as Jev.
Every class, builder and helper in this package works on it unchanged.

**1. Get a key.** Open [litellm.mixpanel.org](https://litellm.mixpanel.org), go to
**Virtual Keys**, then **Create Key**. Pick team `general` or `sales` and the default
models. Kev is not in the gateway's model list or playground, because it is a
pass-through route, not a model. Your calls show on the **Logs** page as
`typesafe/kev-latest`.

**2. Point ak-jev at the gateway.** Two lines in `.env`, and no code changes:

```bash
JEV_PROVIDER=litellm
LITELLM_API_KEY=sk-...
```

Or choose per instance, which wins over `JEV_PROVIDER`:

```javascript
const triage = new Evaluator({ provider: 'litellm', questions });
```

`LITELLM_API_KEY` and `LITELLM_BASE_URL` are the same variables ak-litellm reads.
Each provider reads only its own variables, so a `TYPESAFE_BASE_URL` in the same
`.env` cannot send your gateway key to TypeSafe.

| | `provider: 'typesafe'` (default) | `provider: 'litellm'` |
|---|---|---|
| Key | `TYPESAFE_API_KEY` or `JEV_API_KEY` | `LITELLM_API_KEY` |
| Base URL | `TYPESAFE_BASE_URL`, else `https://api.typesafe.ai` | `LITELLM_BASE_URL` + `/typesafe`, else `https://litellm.mixpanel.org/typesafe` |
| Default model | `TYPESAFE_DEFAULT_MODEL`, else `jev-latest` | `kev-latest` |
| Per-attempt timeout | 30 s | 120 s |

An explicit `apiKey`, `baseURL`, `modelName` or `timeout` option always wins.

**Use `kev-latest`.** It is free. The gateway also accepts `jev-latest`, but it
bills that name at TypeSafe's rate ($0.042/Mtok), and the gateway serves it from
the same Kev server. The gateway answers **every** model name from Kev.

### Kev is not Jev

Kev is a different and much smaller model. Do not reuse thresholds you tuned on Jev
without checking them. ak-jev knows these differences and applies Kev's limits to
every request on the litellm provider, whatever model name you send:

| | Jev (typesafe) | Kev (litellm) |
|---|---|---|
| State + the single longest question | 32,000 tokens | **8,192 tokens** |
| Total tokens per request | 64,000 | no limit found up to 226,822 |
| Score levels | 10 | 255 |
| Choice options | 255 | 255 |
| Fixed request overhead | 267 tokens | 10 tokens |
| Latency | near flat: 500 questions in ~0.5 s | grows with question count: 1,000 questions in ~30 s |
| Repeat the same request | spreads ~0.08 | near-deterministic: identical when sequential, ~0.003 when parallel |
| Price | $0.042/Mtok input | free |
| Over the state limit | 400 `max_tokens_exceeded` | 422 `branch too long` |

Both oversize errors become `JevRequestTooLargeError`. A bad gateway key comes back
in LiteLLM's own `{"error": {...}}` shape. ak-jev reads that shape too, and the
`JevAuthError` names `LITELLM_API_KEY`. Measured 2026-09-28. Run
`npm run probe-api:litellm` to measure again.

### Usage and spend on the gateway

```javascript
const { usage } = await triage.run(ticket);
usage.inputTokens     // 81
usage.outputTokens    // 177
usage.estimatedCost   // 0          kev-latest is free
usage.costSource      // 'estimated'
usage.callId          // 'bfa9faa7-…'   x-litellm-call-id, matches the gateway's Logs page
usage.keySpend        // 0.000018984    x-litellm-key-spend
```

- `keySpend` is the key's **cumulative** USD, as of the gateway's last update. The
  gateway updates it late, often by a minute or more. It is never the cost of this
  call.
- If the gateway ever sends `x-litellm-response-cost`, ak-jev uses that exact figure
  and sets `costSource: 'gateway'`. The gateway did not send it on 2026-09-28.
- `getTotalUsage().keySpend` holds the latest figure seen. `callId` and `keySpend`
  are not present on the typesafe provider.

The CLI takes the same switch: `ak-jev ask --provider litellm ...`. The CLI also
reads `JEV_PROVIDER`.

---

## Which one do I use?

Nine classes is a lot. You only ever need one at a time. Find your sentence:

| If you are saying… | Use | Because |
|---|---|---|
| "I have a thing, and I want to know six different facts about it" | **`Evaluator`** | One question set, one request, six answers. The default choice. |
| "Put this into exactly one of these buckets" | **`Classifier`** | One Choice, with a confidence bar and somewhere for the unsure ones to go |
| "Check this against a list of yes/no conditions" | **`Detector`** | One Noul per condition, per-condition thresholds, all in one request |
| "Rank these by something with several parts to it" | **`Scorer`** | Weighted composite, normalized so the parts are comparable |
| "Decide what this is, then actually go do that thing" | **`Router`** | Classify plus dispatch, with a different bar per action |
| "Which of these 200 documents answers my question?" | **`Ranker`** | Scores every candidate, batched; no embeddings involved |
| "Pull fields out of this messy text" | **`Extractor`** | Choice over allowed values, so the output cannot be a hallucination |
| "Classify into my 4,000-category tree" | **`Taxonomy`** | Walks the tree level by level, past the 255-option ceiling |
| "Is it safe to send this to my LLM / to a user?" | **`Guard`** | Hazards in, `allow` / `review` / `block` out |

And three functions that are not classes:

| Function | For |
|---|---|
| `ask(state, questions)` | A one-off. No setup, no class. Reach for `Evaluator` once you call it twice. |
| `sample(state, questions, {n})` | "Can I trust this number?" Runs it n times and reports the spread. |
| `estimate(state, questions)` | "How much will this cost?" Synchronous, free, needs no API key. |

### A worked example of the difference

Say you have a support ticket. Here is the same ticket through four classes, and
why you would pick each.

```javascript
const ticket = "Charged twice for order A-104. Third time I've written in. I'm done.";
```

**`ask`** — you just want to know one thing, once:

```javascript
const { answers } = await ask(ticket, { refund: 'Do they want money back?' });
answers.refund.noul;        // 0.66
```

**`Classifier`** — you need exactly one bucket, and you care about not guessing:

```javascript
const r = await dept.classify(ticket);
r.label;        // 'billing'   ← or 'needs_human' if confidence was below your bar
r.decided;      // true
r.runnerUp;     // { label: 'returns', probability: 0.31 }  ← worth cc-ing
```

**`Scorer`** — you need a number you can sort a queue by:

```javascript
const r = await priority.score(ticket);
r.composite;    // 0.81   ← 0.6 × severity + 0.3 × frustration + 0.1 × detail
r.weakest;      // 'frustration'  ← the part the model was least sure about
```

**`Router`** — you want the work to actually happen:

```javascript
const out = await router.route(ticket, { ticketId: 'T-1' });
out.route;      // 'refund'
out.value;      // whatever issueRefund() returned
```

The pattern to notice: `Classifier` gives you a **label**, `Scorer` gives you a
**number**, `Router` gives you an **effect**. Pick by what your next line of code
needs.

### Starting from scratch? Do this

1. Write down the decisions your code makes about one item. Not the prose you want
   — the `if` statements.
2. Turn each into one question. `noul` for yes/no, `choice` for a fixed set,
   `score` for a spectrum.
3. Put them all in one `Evaluator`. Ask everything, including the questions that
   only matter sometimes — 200 questions cost the same wall time as one.
4. Run `node examples/01-triage-a-ticket.mjs` to see that shape working end to end.
5. Once it works, look at whether a narrower class fits better.

---

## Why this and not `@typesafe-ai/sdk`

TypeSafe's own JS SDK is a clean, thin HTTP client with good types. ak-jev is built
on `fetch` directly, adds no runtime dependency beyond `dotenv` and `pino`, and
gives you the layer above:

| | `@typesafe-ai/sdk` | ak-jev |
|---|---|---|
| Send state + questions, get answers | yes | yes |
| Retry with backoff | yes | yes |
| Typed answers inferred from criteria | yes | yes |
| Derived fields (`normalized`, `runnerUp`, `margin`, `verdict`, `entropy`) | — | yes |
| Named score levels → `answer.label` | — | yes |
| `choice('…', ['a','b','c'])` array shorthand | throws | expands it |
| Limits checked before the request | — | yes, all of them |
| Token + cost estimation with both budgets | — | yes |
| Rate governor (concurrency / rpm / tokens-per-sec) | — | yes |
| Batching many states or candidates | — | yes |
| Response cache | — | opt-in, with the caveat spelled out |
| `sample()` for measuring the model's own variance | — | yes |
| Nine pattern classes | — | yes |
| One readable error message from three `detail` shapes | partial | yes |
| CLI | — | yes |

Everything measured, including the things the docs get wrong, is in
[AGENTS.md](AGENTS.md). Re-derive it any time with `npm run probe-api`.

---

## The three primitives

| Builder | Asks | Returns |
|---|---|---|
| `noul(instructions, criteria?)` | Is this true? | a probability, 0 to 1 |
| `choice(instructions, criteria)` | Which of these? | a label, a distribution, a confidence |
| `score(instructions, criteria)` | Which level? | a position on your levels, a distribution, a confidence |

```javascript
noul('Does the customer request a refund?')

noul('Has the customer contacted support before?', {
  true:  'Mentions a prior attempt, ticket, or that they have asked before',
  false: 'No sign of any previous contact'
})

choice('Which team should handle this?', {
  billing:   'Payments, invoicing, refunds',
  technical: 'Bugs, outages, integrations'
})

choice('What is the tone?', ['calm', 'frustrated', 'angry'])   // array shorthand

score('How severe is this bug?', [
  'Cosmetic; no impact to functionality',
  'Broken or degraded feature, but workaround exists',
  'Blocking issue; no workaround exists'
])

score('How frustrated is the customer?', {          // named levels
  calm:       'Calm, just stating facts',
  frustrated: 'Frustrated but civil',
  furious:    'Very angry or threatening to leave'
})
// → answer.label === 'frustrated'
```

A bare string is shorthand for a Noul:

```javascript
await ask(ticket, { urgent: 'Does this convey urgency?' });
```

### Always ask more than one question

Questions in one request are answered **in parallel** against the same state.
Measured on the live API: 1 question takes 208 ms, 200 questions take 243 ms. You
pay only for the extra question tokens.

So ask every question your code *might* need, including the speculative ones, and
let the code decide afterwards which answers matter. A question you end up
ignoring is close to free.

---

## What you get back

Raw API fields are never modified. ak-jev only adds, and every added field is
listed here so you always know which numbers came from the model and which came
from arithmetic.

**Noul**

| field | from | meaning |
|---|---|---|
| `noul` | API | probability the answer is yes |
| `yes` | derived | `noul >= thresholds.yes` (default 0.5) |
| `verdict` | derived | `'yes'` / `'no'` / `'unsure'` across a two-sided band |
| `confidence` | **derived by ak-jev** | `\|noul − 0.5\| × 2`. The API does not return one. It is here so a single gating expression works across all three types. |

**Choice**

| field | from | meaning |
|---|---|---|
| `choice` | API | the winning label |
| `probabilities` | API | every option, summing to 1 |
| `confidence` | API | how peaked the distribution is |
| `ranked` | derived | every option, highest first |
| `runnerUp` | derived | second place, or `null` |
| `margin` | derived | top minus second. A small margin is a close call. |
| `entropy` | derived | normalized Shannon entropy, 0 (peaked) to 1 (flat) |

**Score**

| field | from | meaning |
|---|---|---|
| `score` | API | position on your levels; can land between two |
| `legend` | API | each level number mapped to its description |
| `probabilities` | API | each level, summing to 1 |
| `confidence` | API | how peaked the distribution is |
| `normalized` | derived | `score / (levels − 1)`, so 0 to 1 **whatever the rubric length** |
| `level` | derived | the nearest whole level |
| `label` | derived | the level name from `score()`'s object form, else the legend text |
| `ranked`, `entropy` | derived | as above |

`normalized` is the one to reach for. A four-level rubric returns 0–3 and a
three-level one returns 0–2, so comparing two raw scores compares nothing.

---

## The nine classes

Each maps to a pattern or cookbook in TypeSafe's docs. All extend `BaseJev`, so all
of them have `evaluate()`, `sample()`, `estimate()`, `getLastUsage()` and `stats()`.

| Class | For |
|---|---|
| [`Evaluator`](#evaluator) | a reusable question set, over one state or ten thousand |
| [`Classifier`](#classifier) | one Choice, with a confidence gate and a fallback |
| [`Detector`](#detector) | a checklist of yes/no conditions, all in one request |
| [`Scorer`](#scorer) | weighted composite scoring, normalized for you |
| [`Router`](#router) | classify, then call the right handler |
| [`Ranker`](#ranker) | semantic search and re-ranking, batched |
| [`Extractor`](#extractor) | structured extraction, without generation |
| [`Taxonomy`](#taxonomy) | deep category trees, with beam search |
| [`Guard`](#guard) | allow / review / block, for LLM inputs and outputs |

### Evaluator

**Reach for it when** one item needs several unrelated judgments at once, and your
code will decide afterwards which of them mattered.

*Real use:* support triage. Every ticket needs a category, and a bug ticket also
needs a severity, and a billing ticket also needs to know whether a refund was
asked for. Ask all of it, every time. The severity answer on a feature request
costs about 30 tokens and you throw it away.

*Not this when:* you only need one label (use `Classifier`) or you want the work
dispatched for you (use `Router`).

```javascript
import { Evaluator, noul, choice, score } from 'ak-jev';

const triage = new Evaluator({
  questions: {
    category: choice('What kind of ticket is this?', {
      bug_report:      'Something is broken',
      billing:         'Charges, invoices, refunds',
      feature_request: 'Asking for something new'
    }),
    // Speculative: only read when category is bug_report. Costs ~30 tokens.
    severity:    score('How severe is the issue?', ['Cosmetic', 'Workaround exists', 'Blocking']),
    refund:      noul('Does the customer ask for money back?'),
    frustration: score('How frustrated is the customer?', ['Calm', 'Annoyed', 'Furious'])
  }
});

const { answers } = await triage.run(ticket);

if (answers.category.choice === 'bug_report' && answers.severity.normalized > 0.6) {
  escalate(ticket);
}
if (answers.frustration.normalized > 0.7) flagForPriorityResponse(ticket);
```

Over a corpus, in parallel, paced by the governor:

```javascript
const results = await triage.runMany(tickets, {
  onProgress: ({ done, total }) => process.stdout.write(`\r${done}/${total}`)
});
```

Or act on each as it lands, in completion order:

```javascript
for await (const { index, result, error } of triage.stream(tickets)) {
  if (error) continue;
  await save(index, result.answers);
}
```

### Classifier

**Reach for it when** an item belongs in exactly one bucket and you need somewhere
for the ones the model is not sure about.

*Real use:* routing inbound email to a team. The important part is not the happy
path — it is that a 40/35/25 three-way split does **not** silently become
"billing". It becomes `needs_human`.

```javascript
const dept = new Classifier({
  instructions: 'Which team should handle this ticket?',
  labels: {
    billing:   'Payments, invoicing, refunds',
    technical: 'Bugs, outages, integrations',
    sales:     'Pricing, upgrades, new accounts'
  },
  minConfidence: 0.5,
  fallback: 'needs_human',
  alternativeThreshold: 0.25   // other teams worth cc-ing
});

const r = await dept.classify(ticket);
r.label          // 'billing', or 'needs_human' when confidence < 0.5
r.decided        // false when the fallback was used
r.choice         // what the model actually picked, gate or no gate
r.alternatives   // [{ label: 'technical', probability: 0.35 }]

const groups = await dept.group(tickets);   // { billing: [...], needs_human: [...] }
```

### Detector

**Reach for it when** you have a checklist of independent yes/no conditions and
the interesting output is *which ones fired*.

*Real use:* PII and policy scanning before text is stored, logged, or sent
onward. Each condition gets its own bar, because "mentions a card number" and
"mentions a city" do not deserve the same trigger point.

*Not this when:* the conditions are really one spectrum (use `Scorer`) or you want
an allow/block decision out the other end (use `Guard`).

One Noul per condition, one request, per-condition thresholds.

```javascript
const pii = new Detector({
  conditions: {
    email: 'Does the text contain an email address?',
    phone: 'Does the text contain a phone number?',
    card:  { instructions: 'Does the text contain a payment card number?', yes: 0.3 },
    addr:  {
      instructions: 'Does the text contain a home address?',
      criteria: { true: 'A street address precise enough to find', false: 'A city or country alone' }
    }
  }
});

const r = await pii.check(message);
r.triggered   // ['email', 'card']  — strongest first
r.unsure      // ['addr']           — send these to a person
r.any         // true
r.flags.email // true
```

### Scorer

**Reach for it when** you need to rank or prioritise, and the ranking depends on
several things you can weigh against each other.

*Real use:* a support queue ordered by priority, or a stack of resumes ordered for
a specific role. The payoff is `Scorer.reweight()`: score a candidate once, then
rank them as a senior IC **and** as an engineering manager from the same answers,
with no second API call.

*Not this when:* the judgment is really one dimension — then it is a single
`score()` question inside an `Evaluator`.

Composite scoring with the two things people get wrong handled for you:
every dimension is normalized by its own level count before weighting, and all the
arithmetic happens in JavaScript. Jev is not a calculator and is never asked to be.

```javascript
const priority = new Scorer({
  dimensions: {
    severity:    { weight: 0.6, instructions: 'How severe is the issue?',
                   levels: ['Cosmetic', 'Workaround exists', 'Blocking'] },
    frustration: { weight: 0.3, instructions: 'How frustrated is the customer?',
                   levels: ['Calm', 'Frustrated but civil', 'Very angry'] },
    quality:     { weight: 0.1, instructions: 'How much can an engineer act on?',
                   levels: ['Nothing', 'Names the feature', 'Steps or environment', 'Steps and environment'] }
  }
});

const r = await priority.score(ticket);
r.composite   // 0.66 — always 0 to 1; weights are rescaled to sum to 1
r.weakest     // 'frustration' — the dimension the model was least sure about

// Try different weights against answers you already paid for. No API call.
Scorer.reweight(r, { severity: 1, quality: 0 });

const ranked = await priority.rank(tickets, { top: 20 });
```

### Router

**Reach for it when** the classification's whole purpose is to decide which code
runs next, and different branches carry different risk.

*Real use:* a voice or chat assistant over a real account. Reading a balance at
0.6 confidence is fine; the worst case is the user hearing a number they did not
ask for. Approving a transfer at 0.6 is not fine. Same model, same call, different
bars.

Classify, then dispatch. Each route carries **its own** confidence bar, because
showing the wrong screen is recoverable and approving the wrong transfer is not.

```javascript
const router = new Router({
  instructions: 'What is the user trying to do?',
  routes: {
    check_balance:    { description: 'View account balance',        minConfidence: 0.6,  handler: showBalance },
    approve_transfer: { description: 'Approve a pending withdrawal', minConfidence: 0.9, handler: approveTransfer },
    support:          { description: 'Get help with an issue',      minConfidence: 0.6,  handler: openTicket }
  },
  fallback: routeToHuman,
  // Rides along in the same request; every handler can read it.
  questions: { complexity: score('How complex is this?', ['Simple', 'Involved', 'Needs a specialist']) }
});

const out = await router.route(command, { accountId });
out.route   // 'approve_transfer', or null when nothing cleared its bar
out.value   // whatever the handler returned
```

Handlers receive `{ state, extra, route, confidence, answers, classification }`.
Set `dispatch: false` to get the decision without running anything.

### Ranker

**Reach for it when** you have a query and a pile of candidates, and you need them
ordered by how well they actually answer it.

*Real use:* the retrieval step of a RAG pipeline. Pull 200 candidates cheaply with
BM25 or a SQL `LIKE`, then let Jev re-rank them and feed only the top 8 to an
expensive model. No vector store, no index to rebuild, no chunking strategy, and
`relevance` is a real probability you can threshold rather than a cosine distance
you have to calibrate.

Semantic search and re-ranking. One question per candidate, batched into as few
requests as the token budget allows. Each candidate travels inside its **own**
question rather than in the shared state, so no candidate distracts from another.

```javascript
const ranker = new Ranker({
  instructions: 'Does this passage answer the query?'
});

const top = await ranker.rank(query, passages, { top: 10 });
top[0]   // { rank: 1, index: 42, candidate: '...', relevance: 0.97 }
```

One winner in one request, plus an honest "is any of this relevant at all":

```javascript
const best = await ranker.pick(query, passages, { includeNone: true });
best.found   // false when nothing actually answers the query
```

A Choice is **relative** — it will crown the least-bad candidate even when every
one is useless. `includeNone` adds a separate absolute check. Use it.

For objects rather than strings:

```javascript
new Ranker({ instructions: '…', toText: (doc) => doc.body });
```

### Extractor

**Reach for it when** you need fields out of messy text **and** you can enumerate
what each field is allowed to be.

*Real use:* normalising invoices, forms, or listings from many sources into one
schema. The guarantee is stronger than JSON-mode on an LLM: the output is not
validated against your allowed values, it is *selected from* them, so a value
outside the set is not representable.

*Not this when:* the field is open-ended, like a summary or a customer's name. Jev
cannot generate. Use an LLM for those and Jev to check the result.

Jev cannot write text. The documented workaround is to turn extraction into a
Choice over the possible values, so the model **picks** rather than generates. The
code copies the winning label verbatim; it never re-types a value.

```javascript
const MONTHS = ['January', 'February', 'March', /* … */];

const invoice = new Extractor({
  allowMissing: true,
  fields: {
    currency: { instructions: 'Which currency is the total in?', options: ['USD', 'EUR', 'GBP'] },
    status:   { instructions: 'What is the payment status?',
                options: { paid: 'Settled in full', due: 'Not yet paid', partial: 'Partly paid' } },
    month:    { instructions: 'Which month is it dated?', options: MONTHS,
                transform: (v) => MONTHS.indexOf(v) + 1 },
    terms:    { instructions: 'What are the payment terms?', options: ['net_15', 'net_30', 'net_60'],
                minConfidence: 0.7 }
  }
});

const r = await invoice.extract(document);
r.record      // { currency: 'EUR', status: 'due', month: 3, terms: null }
r.missing     // ['po']     — the document did not state it
r.uncertain   // ['terms']  — below its confidence bar
r.complete    // false
```

`allowMissing` matters more than it looks. Without an explicit "not stated" option
a Choice **must** pick something, and it will invent a reading rather than report
an absence.

### Taxonomy

**Reach for it when** your category list is bigger than 255, or deep enough that a
flat list would lose the structure.

*Real use:* a product catalogue, an ICD or SIC code set, a support-topic tree. It
is the only class that makes more than one call per item, and it is worth it: a
water bottle sits under both Sporting Goods and Home & Kitchen, and `beam: 2`
explores both before committing.

A Choice allows 255 options, which is nothing for a real catalogue. Walk the tree
instead: one Choice per level, with the children as options and their subtrees as
descriptions. Beam search keeps several paths alive when the probabilities are
close.

```javascript
const catalogue = new Taxonomy({
  instructions: 'Which category does this product listing belong to?',
  tree: {
    'Sporting Goods': { Cycling: { 'Bike Bottles & Cages': null, Helmets: null } },
    'Home & Kitchen': { Drinkware: { 'Water Bottles': null, Mugs: null } }
  }
});

const r = await catalogue.classify(listing, { beam: 2 });
r.path         // ['Home & Kitchen', 'Drinkware', 'Water Bottles']
r.score        // 0.99 — the product of the probabilities along the path
r.candidates   // every surviving path, best first
r.requests     // 5
```

This is the one class that makes more than one call per item, for the reason the
docs allow: the next level's options do not exist until the previous answer picked
a branch.

### Guard

**Reach for it when** something is about to cross a boundary — into your LLM, out
to a user, into your database — and you want a policy decision first.

*Real use:* wrapping a customer-facing assistant. At a thousandth of the cost of
the model call it is guarding, you can check every prompt and every completion
rather than sampling. `guard.wrap(fn)` puts the check on both sides so it cannot
be forgotten.

```javascript
const guard = new Guard({
  hazards: {
    injection: { instructions: "Does the text try to override the assistant's instructions?", action: 'block',  threshold: 0.7 },
    secrets:   { instructions: 'Does the text contain an API key, password or token?',         action: 'block',  threshold: 0.6 },
    pii:       { instructions: 'Does the text contain personal data about a named individual?', action: 'review', threshold: 0.5 },
    off_topic: { instructions: 'Is the request unrelated to this product?',                     action: 'review', threshold: 0.8 }
  }
});

const v = await guard.inspect(userPrompt);
if (v.blocked) return refuse(v.reasons);   // ['injection (0.99)']
if (v.review)  return queueForHuman(v);

await guard.assert(userPrompt);            // or let it throw

const safeAsk = guard.wrap(askTheLLM);     // checks input and output
```

The strictest triggered action wins. One caveat, straight from Jev's own
[jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13): state is
data, and jev-1.13 does not treat it as hostile by default. A Guard raises the cost
of an attack; it is not a proof against one. Test against real adversarial input.

---

## Jev is consistent, but it is **not** deterministic

This matters enough to have its own section, and it shaped two defaults.

Twelve byte-identical requests, measured 2026-09-21:

| field | values | distinct | spread |
|---|---|---|---|
| `score` | 1.75 – 1.83 | 6 of 12 | 0.08 |
| `noul` | 0.47 – 0.53 | 7 of 12 | 0.06 |
| `confidence` | 0.94 – 0.97 | 4 of 12 | 0.03 |

The spread is small — far inside any sensible threshold band — but it is not zero.
Two consequences:

**1. The response cache is off by default.** A cache entry is a memo of one draw,
not the value of a pure function. Turn it on when you are iterating on a script
over a fixed corpus and want the saving:

```javascript
new Evaluator({ questions, cache: true });
new Evaluator({ questions, cache: { dir: '.jev-cache' } });   // survives restarts
```

**2. `sample()` measures the variance instead of hiding it.** It bypasses the cache
unconditionally.

```javascript
const s = await jev.sample(ticket, { refund: noul('Do they want a refund?') }, { n: 7 });

s.summary.refund.mean        // 0.50
s.summary.refund.spread      // 0.06
s.summary.refund.stdev       // 0.019
s.summary.refund.verdict     // 'unsure' — the modal verdict
s.summary.refund.agreement   // 0.71 — 5 of 7 draws agreed with it

if (s.summary.refund.agreement < 0.9) sendToHuman(ticket);
```

**Do not tune a threshold against a single draw.** If a decision sits near a
boundary, sample it.

---

## Confidence

Every Choice and Score answer carries a `confidence` from 0 to 1, computed from how
peaked the probability distribution is. A Noul does not get one from the API, so
ak-jev derives `|p − 0.5| × 2` and labels it as derived.

The useful pattern is three bands, with the boundaries set by what it costs to be
wrong:

```javascript
if (answer.confidence < 0.5)      routeToHuman();       // genuinely unsure
else if (action === 'read_only')  justDoIt();           // recoverable
else if (answer.confidence > 0.9) doTheRiskyThing();    // confident enough
else                              askUserToConfirm();   // not confident enough
```

`margin` and `entropy` are two more views of the same thing. A `margin` of 0.02
means two options were nearly tied, whatever the confidence says.

---

## Cost and limits

$0.042 per million **input** tokens. Output tokens are free. A typical
three-question triage call costs about **$0.000016**.

```javascript
import { estimate } from 'ak-jev';

// Synchronous, free, and needs no API key — so you can size a job before you
// have configured anything.
const est = estimate(ticket, questions);
est.totalTokens         // 388   nominal; what cost is based on
est.budgetTokens        // 485   padded; what the budget check uses
est.estimatedCost       // 0.0000163
est.withinBudget        // true
est.warnings            // []

console.log(`~$${(est.estimatedCost * corpus.length).toFixed(2)} for the whole corpus`);
```

`jev.estimate(...)` on any client is the same calculation.

Every hard limit is checked **before** the request, because each one is a 400 that
costs a round trip and does not say which question caused it:

| limit | value |
|---|---|
| Choice options | 255 |
| Score levels | 10 |
| Total tokens per request | 64,000 |
| State + the single longest question | **32,000** ← the one you actually hit |
| Rate limits | 1,200 req/min, 250,000 tokens/sec |

Those are Jev's limits. Kev, on Mixpanel's gateway, has different ones. See
[Kev is not Jev](#kev-is-not-jev).

`estimateCost()` errs within about ±25% on realistic content; the budget check pads
a further 25% on top, because chars-per-token varies from 3.5 (code) to 4.9 (legal
prose). See [AGENTS.md](AGENTS.md#token-estimation) for the calibration table.

---

## Rate governing and batching

Defaults sit under both published limits. Every request goes through the governor,
including retries.

```javascript
new Evaluator({
  questions,
  concurrency: 8,            // simultaneous requests
  requestsPerMinute: 1000,   // under the published 1,200
  tokensPerSecond: 200000    // under the published 250,000
});
```

`evaluateMany()`, `runMany()`, `classifyMany()`, `Ranker.rank()` and friends all
go through it. A failure is captured per item rather than losing the batch:

```javascript
const results = await ev.runMany(tickets);
const ok = results.filter((r) => !r.failed);
```

Pass `throwOnError: true` if you would rather the first failure propagate.

---

## Errors

The API returns `detail` in **three** different shapes depending on which layer
rejected the request, and one of them carries no message at all. ak-jev flattens
all three into one readable sentence and picks the right class.

```javascript
import { JevRequestTooLargeError, JevRateLimitError, JevUnprocessableError } from 'ak-jev';

try {
  await jev.evaluate(hugeDocument, questions);
} catch (err) {
  if (err instanceof JevRequestTooLargeError) {
    // The API sends {"detail":{"error_type":"max_tokens_exceeded"}} and nothing else.
    // ak-jev supplies the budget numbers and the fix.
  }
  err.requestId;   // x-typesafe-request-id, for a support ticket
  err.status;
  err.detail;      // the raw detail, untouched
}
```

`JevAuthError` · `JevBadRequestError` · `JevRequestTooLargeError` ·
`JevUnprocessableError` (with `fields`) · `JevRateLimitError` (with `retryAfterMs`) ·
`JevOverloadedError` · `JevServerError` · `JevTimeoutError` · `JevConnectionError` ·
`JevValidationError` (with `questionId`) · `JevConfigError` · `JevGuardError`.

429, 529, 5xx, timeouts and connection failures retry with jittered exponential
backoff. 401 and 422 do not — a bad key and a malformed body do not fix themselves.

---

## Writing questions that work

From Jev's own [jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
which is unusually honest and worth reading in full:

- **It answers the question you wrote, not the one you meant.** When you look at a
  wrong answer and catch yourself explaining what you really meant, that
  explanation is the missing half of the instruction.
- **It is not a calculator.** Do not ask it to count, compare dates, or do
  arithmetic. Extract the parts as a Choice over enumerated options and do the maths
  in code. `Scorer` and `sample()` follow this rule strictly.
- **One judgment per question.** "Is the customer angry *and* asking for a refund?"
  makes the number mean less. Ask two Nouls and combine them.
- **Phrase it so high means yes.** "Is the message free of personal data?" reads
  backwards later and someone will get it wrong.
- **Describe situations, not degrees.** "Broken but a workaround exists" gives the
  model something to match. "Moderately severe" gives it nothing. Levels are judged
  independently — the model never sees a level's number or its neighbours.
- **Filter the state first.** Accuracy falls as the state fills with material the
  question does not need.
- **Do not expect arithmetic identities between questions.** `P(noul)` and
  `1 − P(not noul)` measured 0.72 and 0.47 on the same ticket. A Choice over options
  and one Noul per option answer genuinely different questions.

---

## CLI

```bash
ak-jev ask "Help, my payouts have been failing for 3 days" \
  --noul   "urgent:Does this convey urgency?" \
  --choice "team:billing,technical,sales" \
  --score  "anger:Calm|Annoyed|Furious"
```

```
urgent
  noul       0.96   ███████████████████·  yes

team
  choice     billing   (confidence 0.92, margin 0.85)
             0.90 ██████████████████·· billing
             0.05 █··················· technical

anger
  score      1.46 / 2   (0.73 normalized, confidence 0.31)
  nearest    Annoyed

jev-1.13.0  358ms  365 in / 68 out  $0.00001533
```

```bash
cat ticket.txt | ak-jev ask --questions triage.json --json
ak-jev estimate --file contract.txt --questions checks.json
ak-jev models
ak-jev limits
ak-jev ask --provider litellm "My card was charged twice" --noul "Is this about billing?"
```

---

## TypeScript

Answer types are inferred from the questions you pass.

```typescript
const r = await ask(ticket, {
  team:  choice('Who?', { billing: 'money', tech: 'bugs' }),
  anger: score('How angry?', ['Calm', 'Mad', 'Furious'] as const)
});

r.team.choice   // 'billing' | 'tech'   — not string
r.team.noul     // ✗ a choice answer has no .noul
r.nope          // ✗ no such question
```

---

## Recipes

Nine runnable scripts in [`examples/`](examples/), each one hitting the live API
and printing real output. All nine together cost about $0.002.

```bash
node examples/01-triage-a-ticket.mjs     # fan out 7 questions per ticket
node examples/09-measure-uncertainty.mjs # watch a threshold flip on identical input
```

Twelve more patterns in [RECIPES.md](RECIPES.md), including replacing an LLM
prompt with a question set, semantic search with no embeddings, and verifying
another model's output.

---

## Development

```bash
npm test                   # 332 offline tests, ~1.5s, no network, free
npm run test:live          # real API, 37 tests, about $0.0003; the Kev tests run when LITELLM_API_KEY is set
npm run typecheck
npm run probe-api          # re-derive every measured fact and diff it
npm run probe-api:litellm  # the same, against Kev on the gateway; free
npm run build:cjs
```

The unit suite stubs `fetch` and points at an unresolvable host, so a test that
forgets to inject one fails loudly instead of quietly spending money.

---

## See also

- [AGENTS.md](AGENTS.md) — everything measured about the live API, including where the docs are wrong
- [RECIPES.md](RECIPES.md) — longer worked examples
- [CHANGELOG.md](CHANGELOG.md)
- [TypeSafe docs](https://docs.typesafe.ai) · [their JS SDK](https://github.com/typesafe-ai/typesafe-sdk-js)

Sibling packages, same house style, different models:
[ak-claude](https://github.com/ak--47/ak-claude) ·
[ak-gemini](https://github.com/ak--47/ak-gemini) ·
[ak-litellm](https://github.com/ak--47/ak-litellm)

ISC © AK
