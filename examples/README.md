# ak-jev recipes

Nine runnable scripts. Each one hits the live API and prints real output. Put your
key in `.env` first, then:

```bash
node examples/01-triage-a-ticket.mjs
```

All nine together cost about **$0.002**.

| # | Script | Class | What it shows |
|---|---|---|---|
| 01 | [triage-a-ticket](01-triage-a-ticket.mjs) | `Evaluator` | Speculative fan-out: 7 questions per ticket, one request, code picks which answers matter |
| 02 | [route-to-a-handler](02-route-to-a-handler.mjs) | `Router` | Per-route confidence bars. Closing an account needs 0.95; reading a balance needs 0.6 |
| 03 | [guard-an-llm](03-guard-an-llm.mjs) | `Guard` | allow / review / block on prompts and completions, and `wrap()` around a real call |
| 04 | [rank-and-search](04-rank-and-search.mjs) | `Ranker` | Re-ranking with no embeddings, and why `pick()` needs `includeNone` |
| 05 | [score-and-rank](05-score-and-rank.mjs) | `Scorer` | Composite scoring. Two role weightings, one set of answers, different winners |
| 06 | [extract-a-record](06-extract-a-record.mjs) | `Extractor` | Structured extraction without generation, and why `allowMissing` matters |
| 07 | [walk-a-taxonomy](07-walk-a-taxonomy.mjs) | `Taxonomy` | A 4-level catalogue tree with beam search |
| 08 | [moderate-a-batch](08-moderate-a-batch.mjs) | `Detector` + `Classifier` | 10 posts, 70 questions, 733 ms, paced by the governor |
| 09 | [measure-uncertainty](09-measure-uncertainty.mjs) | `sample()` | Jev is consistent but not deterministic — watch a threshold flip |

## Suggested order

Start with **01**. It is the shape almost every Jev integration ends up in: one
question set, one request per item, ordinary `if` statements afterwards.

Then **09**, because it is the one that changes how you write the rest. It shows a
threshold at 0.65 flipping across 8 identical draws of the same input.

Then whichever matches your problem.

## What each one actually prints

**01** routes four tickets through a 7-question set, escalating the Safari export
bug to engineering and flagging the double-charge for refund approval. 28 questions
answered for $0.0001.

**02** approves a transfer at confidence 1.00 and sends the ambiguous
"maybe close the account, not sure" to a human at 0.92 — because closing an account
is gated at 0.95 and reading a balance at 0.6.

**03** blocks a prompt injection at 0.99 and an exposed API key at 0.95, sends a PII
disclosure to review, and lets an ordinary refund question through. Every hazard
probability is printed, including the ones that never act.

**04** ranks 8 GDPR passages against a breach-notification question: three score
above 0.94, five below 0.13. Then asks about the boiling point of mercury and gets
`found: false` — even though the Choice still crowned a passage, because a Choice is
relative and one of them has to win.

**05** scores four resumes on four dimensions, then ranks them twice from the same
answers: Ada wins the senior-IC weighting, Brin wins the engineering-manager one.
Re-weighting costs nothing.

**06** pulls a clean record out of a tidy invoice, marks `terms` as missing on one
that does not state them, and returns four nulls for a scribbled desk note while
still correctly identifying it as legal.

**07** puts a cycling bottle under Sporting Goods and a gym-or-office bottle under
Home & Kitchen — the same object, disambiguated by the listing text, with beam
search keeping both branches alive.

**08** moderates ten forum posts in 733 ms: 20 requests, 70 questions, $0.0003.

**09** samples three tickets eight times each and finds a threshold at 0.65 that
lands 5/8 above and 3/8 below on the same input.
