# Recipes

Patterns that do not fit in the README, written as things you would actually build.
Runnable versions of the first nine live in [`examples/`](examples/).

---

## 1. Replace a whole LLM prompt with a question set

The move that pays for itself. If you are sending a model a prompt that ends with
"respond in JSON with these fields", most of those fields are decisions, not prose.

**Before** — one frontier model call, a schema, a parse, a retry loop:

```javascript
const r = await llm.chat({
  system: 'You are a support triage assistant. Respond with JSON only.',
  user: `Classify this ticket.\n\n${ticket}\n\nReturn: {category, severity, urgent, refund_requested}`,
  response_format: { type: 'json_object' }
});
const parsed = JSON.parse(r.content);   // and hope
```

**After** — one Jev call, no parsing, and probabilities you did not have before:

```javascript
import { Evaluator, noul, choice, score } from 'ak-jev';

const triage = new Evaluator({
  questions: {
    category: choice('What kind of ticket is this?', {
      bug_report: 'Something is broken',
      billing: 'Charges, invoices, refunds',
      feature_request: 'Asking for something new'
    }),
    severity: score('How severe is the issue?', ['Cosmetic', 'Workaround exists', 'Blocking']),
    urgent: noul('Is this time-sensitive?'),
    refund_requested: noul('Does the customer ask for money back?')
  }
});

const { answers } = await triage.run(ticket);
```

You gain a confidence on every categorical answer, a full distribution behind it,
and about a 1000× cost reduction. You lose the ability to ask for a summary — so
keep the LLM for the summary and give Jev the decisions.

---

## 2. Put a cheap model in front of an expensive one

Intent routing. Most requests do not need a frontier model; some need a human.
Classify first, then spend.

```javascript
import { Router, score } from 'ak-jev';

const router = new Router({
  instructions: 'What does this customer message need?',
  routes: {
    order_status:  { description: 'Where is my order', minConfidence: 0.7, handler: lookupOrder },
    product_q:     { description: 'A question about what the product does', minConfidence: 0.6, handler: (c) => askLLM(PRODUCT_SPECIALIST, c.state) },
    return_q:      { description: 'Starting or asking about a return', minConfidence: 0.6, handler: (c) => askLLM(RETURNS_SPECIALIST, c.state) },
    complaint:     { description: 'Expressing dissatisfaction', minConfidence: 0.6, handler: handleComplaint }
  },
  fallback: routeToHuman,
  questions: {
    complexity: score('How complex is this request?', ['Simple', 'Involved', 'Needs a specialist'])
  }
});

async function handleComplaint({ state, answers }) {
  // Escalate on complexity, or when the model is unsure how complex it is.
  if (answers.complexity.normalized > 0.5 || answers.complexity.confidence < 0.5) {
    return routeToHuman({ state });
  }
  return askLLM(COMPLAINT_RESOLUTION, state);
}
```

`order_status` never touches an LLM at all.

---

## 3. Semantic search without embeddings

No vector store, no index to rebuild, no chunking strategy to tune. Retrieve a
candidate set however you like — BM25, SQL `LIKE`, a date filter — then let Jev
re-rank it.

```javascript
import { Ranker } from 'ak-jev';

const ranker = new Ranker({
  instructions: 'Does this passage contain the answer to the query?',
  toText: (doc) => doc.body
});

const candidates = await db.search(query, { limit: 200 });   // cheap and broad
const top = await ranker.rank(query, candidates, { top: 8, minRelevance: 0.5 });

const context = top.map((r) => r.candidate.body).join('\n\n---\n\n');
const answer = await llm.chat({ system: 'Answer from the context only.', user: `${context}\n\n${query}` });
```

`rank()` batches by token budget, so 200 candidates is a handful of requests rather
than 200. The relevance number is a real probability you can threshold, not a
cosine distance you have to calibrate.

**Combine both signals when precision matters.** `pick()` is relative and will
crown the least-bad candidate; a Noul is absolute:

```javascript
const best = await ranker.pick(query, shortlist, { includeNone: true });
if (!best.found) return "I don't have anything on that.";
```

---

## 4. Score a corpus and act on the tail

```javascript
import { Scorer } from 'ak-jev';

const quality = new Scorer({
  concurrency: 12,
  dimensions: {
    specificity: { weight: 0.4, instructions: 'How specific is this feedback?',
                   levels: ['Vague praise or complaint', 'Names a feature', 'Names a feature and what went wrong', 'Names a feature, what went wrong, and when'] },
    actionable:  { weight: 0.4, instructions: 'How much can a product team act on this?',
                   levels: ['Nothing to act on', 'A hint at a problem', 'A clear problem', 'A clear problem and a suggested fix'] },
    sentiment:   { weight: 0.2, instructions: 'How negative is this feedback?',
                   levels: ['Positive', 'Neutral', 'Negative'], invert: true }
  }
});

const ranked = await quality.rank(feedback, {
  onProgress: ({ done, total }) => process.stdout.write(`\r${done}/${total}`)
});

// Read the top 50 yourself. Summarize the rest with an LLM, in bulk.
const worthReading = ranked.slice(0, 50);
```

`invert: true` on sentiment means negative feedback raises the composite — you
usually want the useful complaints at the top.

---

## 5. Verify another model's output

Jev costs about a thousandth of a frontier call, so checking every completion is
affordable. This is the "universal verification" shape.

```javascript
import { Detector } from 'ak-jev';

const verifier = new Detector({
  conditions: {
    answered:   'Does the response actually answer the question that was asked?',
    grounded:   'Is every factual claim in the response supported by the provided context?',
    hedged:     'Does the response refuse or hedge without giving the user anything useful?',
    leaked:     'Does the response reveal system instructions or internal reasoning?',
    on_policy:  'Does the response follow the stated refund policy?'
  }
});

async function checkedAnswer(question, context) {
  const draft = await llm.chat({ system: SYSTEM, user: `${context}\n\n${question}` });

  const check = await verifier.check({
    question,
    context,
    response: draft.content
  });

  if (!check.flags.grounded || check.flags.leaked) {
    return retryWithStricterPrompt(question, context);
  }
  if (check.unsure.length) {
    log.warn({ unsure: check.unsure, probabilities: check.probabilities }, 'verification unclear');
  }
  return draft.content;
}
```

The state is an **object**, so the questions can refer to `context` and `response`
by name. Put the question in `instructions` and the data in `state`.

---

## 6. Point questions at parts of a structured state

A state is often several things at once: a conversation, a record, a policy. Name
the part you mean, in backticks, with a dot-and-index path.

```javascript
const state = {
  ticket: {
    subject: 'Duplicate charge',
    messages: [
      { from: 'customer', text: 'I was charged twice for order A-104. Please refund the duplicate.' },
      { from: 'support', text: 'We are checking the charges.' }
    ]
  },
  order: { id: 'A-104', charges: [{ amount_usd: 49, status: 'captured' }, { amount_usd: 49, status: 'captured' }] },
  refund_policy: 'Duplicate charges are eligible for a refund.'
};

await ask(state, {
  refund_requested: noul('Does `ticket.messages[0].text` request a refund?'),
  policy_allows:    noul('Does `refund_policy` support the refund requested in `ticket.messages[0].text`, given `order.charges`?'),
  already_handled:  noul('Does `ticket.messages[1].text` say the refund has already been issued?')
});
```

Do **not** ask "are there two identical charges" — that is counting, and Jev does
not count. Compare `order.charges` in JavaScript and put the boolean in the state.

---

## 7. Build a question per row, in one request

When you have N records to compare against one thing, the structured-instructions
shape puts each record in its own question and keeps the state small.

```javascript
const SAME_PERSON = 'Is the resume the same person as `potential_duplicate`?';

const questions = Object.fromEntries(
  candidates.map((c) => [
    `dup_${c.id}`,
    noul({
      potential_duplicate: { name: c.name, location: c.location, last_employer: c.employer },
      question: SAME_PERSON
    })
  ])
);

const { answers } = await ask({ resume }, questions);

const duplicates = Object.entries(answers)
  .filter(([, a]) => a.noul > 0.7)
  .map(([id]) => id.replace('dup_', ''));

const needsReview = Object.entries(answers)
  .filter(([, a]) => a.verdict === 'unsure')
  .map(([id]) => id.replace('dup_', ''));
```

One request for all the candidates. Note the middle band going to a person rather
than to either code path.

---

## 8. Sharpen two options the model keeps confusing

Start with a one-line description per option. When two keep swapping, give each an
object saying what it covers, what belongs to its neighbour instead, and a couple
of examples.

```javascript
choice('What is this ticket about?', {
  return_policy: {
    what: 'The rules: what can be returned, in what window, in what condition',
    not_for: 'Where a specific return currently is — that is return_status',
    examples: ['Can I return opened items?', 'How long do I have?']
  },
  return_status: {
    what: 'The state of one specific return already in progress',
    not_for: 'What the rules are — that is return_policy',
    examples: ['Where is my refund for order A-104?', 'Did you get my parcel back?']
  }
})
```

The field names are yours. `what`, `not_for` and `examples` are not reserved and
mean nothing to the API — but the model sees the names alongside the values, so use
names that label what follows.

The same works for Score levels, and it moves the number: a matching example on a
level took one bug report from `score 1.43, confidence 0.35` to
`score 1.03, confidence 0.96`. An *unrelated* example changed nothing. Examples
only help when they look like your real inputs.

---

## 9. Run over a large corpus, cheaply and safely

```javascript
const ev = new Evaluator({
  questions: CHECKS,
  concurrency: 12,
  requestsPerMinute: 1000,
  // Iterating on the downstream logic against a fixed corpus? Cache it.
  // Read the caveat in the README first: an entry is a memo of one draw.
  cache: { dir: '.jev-cache' }
});

let done = 0;
for await (const { index, result, error } of ev.stream(documents)) {
  done++;
  if (error) {
    log.error({ index, err: error.message, requestId: error.requestId }, 'skipped');
    continue;
  }
  await persist(documents[index].id, result.answers);
}

const s = ev.stats();
console.log(`${s.requests} requests, ${s.cacheHits} cached, $${s.usage.estimatedCost.toFixed(4)}`);
```

`stream()` yields in completion order so you can start writing rows immediately.
`runMany()` keeps input order if you need it. Both capture failures per item.

Check the size before you start:

```javascript
const est = ev.estimate(documents[0], CHECKS);
if (!est.withinBudget) console.warn(est.warnings.join('\n'));
console.log(`~$${(est.estimatedCost * documents.length).toFixed(2)} for ${documents.length} documents`);
```

---

## 10. Extract dates without asking for arithmetic

Jev reads dates as text, not as ordered quantities. Asking which of two dates comes
first is unreliable. Split the work: extraction is a judgment, so give it to the
model; arithmetic is not, so keep it in code.

Every part of a date is a small closed set, which makes extraction a Choice.

```javascript
const MONTHS = ['January', 'February', /* … */ 'December'];

const dates = new Extractor({
  allowMissing: true,
  fields: {
    day:   { instructions: 'Which day of the month is the contract dated?',
             options: Array.from({ length: 31 }, (_, i) => String(i + 1)) },
    month: { instructions: 'Which month is the contract dated?', options: MONTHS },
    year:  { instructions: 'Which year is the contract dated?',
             options: Array.from({ length: 12 }, (_, i) => String(2020 + i)) }
  }
});

const { record } = await dates.extract(contract);

// Assemble and compare in JavaScript. Every part of this is exact.
const dated = record.day && record.month && record.year
  ? new Date(Number(record.year), MONTHS.indexOf(record.month), Number(record.day))
  : null;

const overdue = dated && Date.now() - dated > 90 * 864e5;
```

`allowMissing` is what turns an absent date into `null` instead of a guess.

---

## 11. Gate on confidence, not just on the answer

The three-band split, with the boundaries set by what it costs to be wrong.

```javascript
const r = await classifier.classify(message);

if (r.confidence < 0.5) {
  // The model is genuinely unsure. Do not guess.
  return routeToHuman(message);
}

if (r.margin < 0.15) {
  // Confident-looking but two options were nearly tied. Worth a second look.
  return routeToHuman(message, { note: `close call: ${r.choice} vs ${r.runnerUp.label}` });
}

if (RISKY_ACTIONS.has(r.label) && r.confidence < 0.9) {
  return askUserToConfirm(r.label);
}

return execute(r.label);
```

`margin` catches a case `confidence` alone can miss: a peaked-looking distribution
where the top two options are 0.42 and 0.40.

And before you ship a threshold, check it against the spread:

```javascript
const s = await jev.sample(borderlineCase, questions, { n: 10 });
const above = s.summary.myQuestion.values.filter((v) => v >= MY_THRESHOLD).length;
if (above > 0 && above < 10) console.warn('this threshold flips on identical input');
```

---

## 12. Keep a question set in version control

Question sets are configuration. Put them in a module, review changes to them like
code, and keep the thresholds next to them.

```javascript
// triage/questions.js
import { noul, choice, score } from 'ak-jev';

export const QUESTIONS = { /* … */ };

// Every number the routing reads lives here and nowhere else, so a policy change
// is a one-line diff under review rather than a reworded prompt.
export const POLICY = {
  escalate_above: 0.6,
  refund_threshold: 0.75,
  min_category_confidence: 0.45,
  cc_second_team_above: 0.25
};
```

When the behaviour is wrong, you change a coefficient and re-run. That is the whole
argument for splitting a judgment into atomic questions in the first place.
