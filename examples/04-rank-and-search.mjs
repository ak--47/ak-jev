/**
 * 04 — Semantic search and re-ranking, with no embeddings.
 *
 * Two shapes:
 *   rank() scores every candidate 0–1 and sorts. Batched across requests.
 *   pick()  picks one winner in a single request, and can say "none of these".
 *
 * A Choice is RELATIVE — it will crown the least-bad candidate even when every one
 * is useless. That is what `includeNone` is for.
 *
 *   node examples/04-rank-and-search.mjs
 */

import { Ranker } from '../index.js';

const PASSAGES = [
	{ id: 'a1', text: 'The controller must notify the supervisory authority of a personal data breach within 72 hours of becoming aware of it.' },
	{ id: 'a2', text: 'Cookies are small text files stored on a user device by a web browser.' },
	{ id: 'a3', text: 'Data subjects have the right to obtain erasure of personal data concerning them without undue delay.' },
	{ id: 'a4', text: 'Our support desk is open Monday to Friday, 9am to 5pm Pacific time.' },
	{ id: 'a5', text: 'Where a breach is likely to result in a high risk, the controller shall communicate it to the data subject without undue delay.' },
	{ id: 'a6', text: 'The quarterly revenue report is attached as a PDF.' },
	{ id: 'a7', text: 'Processing is lawful only if the data subject has given consent for one or more specific purposes.' },
	{ id: 'a8', text: 'A processor shall notify the controller without undue delay after becoming aware of a personal data breach.' }
];

const ranker = new Ranker({
	logLevel: 'warn',
	instructions: 'Does this passage state an obligation that arises after a personal data breach?',
	// Candidates are objects, so pull the text out. The whole object comes back.
	toText: (p) => p.text
});

const QUERY = 'Who has to be told about a data breach, and how quickly?';

console.log(`query: ${QUERY}\n`);

const ranked = await ranker.rank(QUERY, PASSAGES);
for (const r of ranked) {
	const bar = '█'.repeat(Math.round(r.relevance * 20)).padEnd(20, '·');
	console.log(`  #${String(r.rank).padStart(2)}  ${r.relevance.toFixed(2)} ${bar} [${r.candidate.id}] ${r.candidate.text.slice(0, 58)}…`);
}

// Only the ones worth feeding to an expensive model.
const shortlist = await ranker.rank(QUERY, PASSAGES, { minRelevance: 0.5, top: 3 });
console.log(`\nshortlist for the LLM: ${shortlist.map((r) => r.candidate.id).join(', ')}`);

// One winner, one request, with an honest "is any of this relevant at all".
console.log('\n--- pick() ---');
for (const q of [QUERY, 'What is the boiling point of mercury in kelvin?']) {
	const best = await ranker.pick(q, PASSAGES, { includeNone: true });
	console.log(`\n  "${q}"`);
	console.log(`  choice   ${best.candidate ? `[${best.candidate.id}] ${best.candidate.text.slice(0, 54)}…` : '(none)'}`);
	console.log(`  found    ${best.found}   confidence ${best.confidence.toFixed(2)}`);

	// Read `found` FIRST. The Choice is relative: asked which passage best answers
	// a question about mercury, it will still crown one, because one of them has
	// to win. The Noul is absolute and is the one that says "nothing here".
	if (best.found) {
		console.log(`  → use [${best.candidate.id}]`);
	} else {
		console.log('  → no passage answers this; do not use the choice above');
	}
}

console.log(`\ntotal: $${ranker.getTotalUsage().estimatedCost.toFixed(6)}`);
