/**
 * 05 — Composite scoring: break one judgment into several, weight them in code.
 *
 * "Rate this candidate" is a bad question — it asks the model to balance several
 * independent things at once and you cannot see how it got there. Ask about each
 * thing separately and combine them with weights you own. When the ranking is
 * wrong, you change a number instead of rewriting a prompt.
 *
 * Every dimension is normalized by its own level count first. A 5-level rubric
 * returns 0–4 and a 3-level one returns 0–2, so raw scores are not comparable.
 *
 *   node examples/05-score-and-rank.mjs
 */

import { Scorer } from '../index.js';

const DIMENSIONS = {
	python: {
		instructions: 'How much hands-on Python experience does this candidate have?',
		levels: {
			none: 'No Python mentioned at all',
			some: 'Occasional scripting alongside a different main language',
			daily: 'Used Python daily in a professional role',
			deep: 'Years of Python, including maintaining a large codebase'
		}
	},
	systems: {
		instructions: 'How much distributed-systems depth does this candidate show?',
		levels: {
			none: 'No distributed systems work described',
			consumer: 'Used a queue or a cache someone else operated',
			operator: 'Ran and debugged distributed services in production',
			designer: 'Designed the architecture of a distributed system'
		}
	},
	leadership: {
		instructions: 'How much evidence of leading other engineers is there?',
		levels: {
			none: 'Individual contributor only',
			mentor: 'Mentored or onboarded others',
			lead: 'Led a project or a small team',
			manager: 'Managed engineers as a direct report line'
		}
	},
	writing: {
		instructions: 'How clearly is the resume itself written?',
		levels: {
			poor: 'Vague, full of unexplained buzzwords',
			ok: 'Clear enough, mostly lists of technologies',
			good: 'Concrete, states what was built and what changed as a result'
		}
	}
};

const CANDIDATES = [
	{ name: 'Ada', resume: 'Eight years of Python, maintained a 400k-line Django monolith and led its split into services. Ran the on-call rotation for a 40-service Kubernetes estate. Mentored four juniors to mid-level. Cut p99 checkout latency from 1.8s to 240ms by moving session state out of Postgres.' },
	{ name: 'Brin', resume: 'Engineering manager, 6 direct reports. Background in Java and Go. Occasional Python for internal scripts. Owned the platform roadmap; shipped a multi-region failover design. Strong on hiring and performance management.' },
	{ name: 'Cyd', resume: 'Python developer, 3 years. Built Flask APIs and a data pipeline with Celery and Redis. Comfortable with Docker. Looking to grow into more architectural work. Wrote the team runbook.' },
	{ name: 'Dee', resume: 'Full stack engineer. React, Node, some Python. Fast learner, team player, passionate about clean code and cutting-edge technologies. Delivered many successful projects.' }
];

// Two roles, two weightings, ONE set of answers. This is the point of the pattern.
const SENIOR_IC = { python: 0.35, systems: 0.40, leadership: 0.10, writing: 0.15 };
const ENG_MANAGER = { python: 0.10, systems: 0.20, leadership: 0.50, writing: 0.20 };

const scorer = new Scorer({
	logLevel: 'warn',
	dimensions: Object.fromEntries(
		Object.entries(DIMENSIONS).map(([k, v]) => [k, { ...v, weight: SENIOR_IC[k] }])
	)
});

const scored = await Promise.all(
	CANDIDATES.map(async (c) => ({ candidate: c, result: await scorer.score(c.resume) }))
);

const dims = Object.keys(DIMENSIONS);
console.log('name   ' + dims.map((d) => d.padStart(11)).join('') + '   senior IC   eng manager');
console.log('-'.repeat(84));

const rows = scored.map(({ candidate, result }) => ({
	name: candidate.name,
	result,
	ic: Scorer.reweight(result, SENIOR_IC),
	em: Scorer.reweight(result, ENG_MANAGER)
}));

for (const row of rows.sort((a, b) => b.ic - a.ic)) {
	const cells = dims.map((d) => row.result.dimensions[d].normalized.toFixed(2).padStart(11)).join('');
	console.log(`${row.name.padEnd(7)}${cells}   ${row.ic.toFixed(3).padStart(9)}   ${row.em.toFixed(3).padStart(11)}`);
}

console.log('\nby senior-IC weighting:    ' + rows.slice().sort((a, b) => b.ic - a.ic).map((r) => r.name).join(' > '));
console.log('by eng-manager weighting:  ' + rows.slice().sort((a, b) => b.em - a.em).map((r) => r.name).join(' > '));

// The dimension the model was least sure about is the one a human should look at.
console.log('\nleast confident dimension per candidate:');
for (const row of rows) {
	console.log(`  ${row.name.padEnd(6)} ${row.result.weakest} (${row.result.weakestConfidence.toFixed(2)})`);
}

console.log(`\n${scorer.getTotalUsage().requests} requests, $${scorer.getTotalUsage().estimatedCost.toFixed(6)}`);
console.log('Both rankings came from the same answers. Re-weighting cost nothing.');
