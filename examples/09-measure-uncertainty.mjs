/**
 * 09 — Measure the model's own variance before you trust a threshold.
 *
 * Jev is consistent but NOT deterministic. Twelve byte-identical requests,
 * measured 2026-09-21, returned six distinct score values spanning 0.08.
 *
 * That spread is small, and for a clear-cut input it does not matter. It matters a
 * great deal when a decision sits near one of your thresholds — because then a
 * threshold you tuned on a single draw will flip depending on the weather.
 *
 * sample() runs the same request n times, bypasses the cache unconditionally, and
 * reports the spread. All the statistics are computed in JavaScript; Jev is never
 * asked to do arithmetic.
 *
 *   node examples/09-measure-uncertainty.mjs
 */

import { BaseJev, noul, choice, score } from '../index.js';

// cache: true on purpose — sample() must bypass it, and this proves it does.
const jev = new BaseJev({ logLevel: 'warn', cache: true, concurrency: 8 });

const QUESTIONS = {
	refund: noul('Is the customer asking for money back?'),
	team: choice('Which team should handle this?', {
		billing: 'Payments, invoicing, refunds',
		technical: 'Bugs, outages, integrations',
		returns: 'Exchanges, wrong or damaged items'
	}),
	frustration: score('How frustrated is the customer?', {
		calm: 'Calm, just stating facts',
		frustrated: 'Frustrated but civil',
		furious: 'Very angry or threatening to leave'
	})
};

const CASES = [
	{ label: 'clear-cut', text: 'Please refund order A-104 — I was charged twice. Thanks!' },
	{ label: 'genuinely ambiguous', text: "I'm not happy with the fit. What are my options here?" },
	{ label: 'mixed signals', text: "Charged twice AND the shoes are the wrong size. Third time writing in. I'm done." }
];

const N = 8;

for (const { label, text } of CASES) {
	const s = await jev.sample(text, QUESTIONS, { n: N });

	console.log(`\n${label}`);
	console.log(`  "${text}"`);

	const r = s.summary.refund;
	console.log(`  refund       mean ${r.mean.toFixed(3)}  spread ${r.spread.toFixed(3)}  sd ${r.stdev.toFixed(3)}`);
	console.log(`               verdict "${r.verdict}" in ${(r.agreement * 100).toFixed(0)}% of draws  ${JSON.stringify(r.counts)}`);

	const t = s.summary.team;
	console.log(`  team         "${t.choice}" in ${(t.agreement * 100).toFixed(0)}% of draws  ${JSON.stringify(t.counts)}`);
	console.log(`               confidence mean ${t.confidence.mean.toFixed(3)}  spread ${t.confidence.spread.toFixed(3)}`);

	const f = s.summary.frustration;
	console.log(`  frustration  mean ${f.mean.toFixed(3)}  spread ${f.spread.toFixed(3)}  nearest level "${f.level}" in ${(f.agreement * 100).toFixed(0)}%`);

	// The decision the variance is actually for: would MY threshold flip?
	//
	// The verdict usually stays stable even when the number moves, because the
	// default bands are wide. The danger is a threshold you chose yourself that
	// happens to land inside the spread.
	const MY_THRESHOLD = 0.65; // auto-issue a refund above this
	const above = r.values.filter((v) => v >= MY_THRESHOLD).length;
	const flips = above > 0 && above < r.values.length;

	console.log(`  → threshold ${MY_THRESHOLD}: ${above}/${N} draws above it` +
		(flips
			? '  ⚠ FLIPS. Same input, different outcome depending on the draw.'
			: '  stable.'));
	if (flips) console.log('     Move the threshold outside the spread, or sample and use the mean.');
}

// Proof the cache did not interfere.
const st = jev.stats();
console.log(`\n${st.requests} real requests for ${CASES.length} cases x ${N} draws = ${CASES.length * N}. ` +
	`Cache hits: ${st.cacheHits} (sample() bypasses it).`);
console.log(`$${st.usage.estimatedCost.toFixed(6)} total.`);

console.log('\nTakeaway: a threshold tuned on ONE draw of an ambiguous input is a coin flip.');
console.log('Sample the cases that sit near your boundaries; trust the single call elsewhere.');
