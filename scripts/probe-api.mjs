#!/usr/bin/env node
/**
 * Re-derive every measured fact this package is built on, against the live API,
 * and diff it against what the code currently claims.
 *
 *   npm run probe-api
 *   npm run probe-api -- --json
 *   npm run probe-api -- --provider litellm     Kev on Mixpanel's gateway
 *
 * Costs well under a cent on typesafe, and nothing on litellm (kev-latest is
 * free). Run it before trusting anything in AGENTS.md — the determinism claim in
 * the first draft of this package was wrong because it was checked with a sample
 * size of two.
 */

import 'dotenv/config';
import { MODEL_PRICING, MODEL_PRICING_AS_OF, computeCost, resolveLimits, resolveProvider } from '../models.js';

const argProvider = process.argv.indexOf('--provider');
const PROVIDER = resolveProvider(argProvider > -1 ? process.argv[argProvider + 1] : undefined);
const KEY = PROVIDER.apiKey;
const BASE = PROVIDER.baseURL;
const MODEL = PROVIDER.defaultModel;
const GATEWAY = PROVIDER.name === 'litellm';
const JSON_OUT = process.argv.includes('--json');
const LIMITS = resolveLimits(MODEL, PROVIDER);

/**
 * The two providers reject the same bad request in different ways. Each entry is
 * what that provider measurably does, so a diff means drift, not a known gap.
 */
const EXPECT = GATEWAY
	? {
		overLimitStatus: 422,       // 256 choices / 256 score levels: FastAPI validation array
		emptyChoiceStatus: 422,
		bareNoulStatus: 200,        // Kev accepts a Noul with neither field; ak-jev still refuses it
		oversizeStatus: 422,
		authShape: 'error',         // the gateway answers before the model does
		missingModelStatus: 200,    // the pass-through serves every request from Kev
		unknownModelStatus: 200
	}
	: {
		overLimitStatus: 400,
		emptyChoiceStatus: 400,
		bareNoulStatus: 400,
		oversizeStatus: 400,
		authShape: 'detail',
		missingModelStatus: 422,
		unknownModelStatus: 400
	};

if (!KEY) {
	console.error(`${PROVIDER.keyEnv[0]} is not set. Copy .env.example to .env and fill it in.`);
	process.exit(1);
}

/** Last `x-litellm-key-spend` seen. The gateway settles it late, so it lags. */
let keySpend;

let inputTokens = 0;
let requests = 0;

async function post(body) {
	requests++;
	const res = await fetch(`${BASE}/v1/systemone`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: MODEL, ...body })
	});
	const spend = res.headers.get('x-litellm-key-spend');
	if (spend !== null) keySpend = Number(spend);
	const parsed = await res.json().catch(() => null);
	inputTokens += parsed?.usage?.input_tokens ?? 0;
	return { status: res.status, body: parsed, ms: 0 };
}

async function timedPost(body) {
	const t = Date.now();
	const r = await post(body);
	return { ...r, ms: Date.now() - t };
}

/** @type {Array<{name: string, expected: any, actual: any, ok: boolean, note?: string}>} */
const findings = [];

function check(name, expected, actual, note) {
	const ok = JSON.stringify(expected) === JSON.stringify(actual);
	findings.push({ name, expected, actual, ok, note });
}

function record(name, actual, note) {
	findings.push({ name, expected: '(observed)', actual, ok: true, note });
}

const NOUL = (q) => ({ type: 'noul', instructions: q });

// ── roster ───────────────────────────────────────────────────────────────────

async function probeRoster() {
	const res = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
	const body = await res.json();
	check('GET /v1/models returns an envelope, not an array', false, Array.isArray(body));
	record('models', (body.models ?? []).map((m) => m.name).join(', '));

	const r = await post({ state: 'hello', questions: { a: NOUL('Is this a greeting?') } });
	record(`model that answers ${MODEL}`, r.body?.model);
	if (!MODEL_PRICING[r.body?.model]) {
		findings.push({
			name: 'pricing table covers the answering model',
			expected: Object.keys(MODEL_PRICING).join(', '),
			actual: r.body?.model,
			ok: false,
			note: 'estimatedCost will be null until this model is added to MODEL_PRICING'
		});
	} else {
		check('pricing table covers the answering model', true, true);
	}
}

// ── limits ───────────────────────────────────────────────────────────────────

async function probeLimits() {
	const opts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
	const levels = (n) => Array.from({ length: n }, (_, i) => `level ${i}`);

	const c255 = await post({ state: 'x', questions: { a: { type: 'choice', instructions: 'p', criteria: opts(255) } } });
	const c256 = await post({ state: 'x', questions: { a: { type: 'choice', instructions: 'p', criteria: opts(256) } } });
	check('max choice options', LIMITS.maxChoiceOptions, c255.status === 200 && c256.status === EXPECT.overLimitStatus ? 255 : `255=${c255.status} 256=${c256.status}`);

	const maxLevels = LIMITS.maxScoreLevels;
	const sMax = await post({ state: 'x', questions: { a: { type: 'score', instructions: 'r', criteria: levels(maxLevels) } } });
	const sOver = await post({ state: 'x', questions: { a: { type: 'score', instructions: 'r', criteria: levels(maxLevels + 1) } } });
	check('max score levels', maxLevels, sMax.status === 200 && sOver.status === EXPECT.overLimitStatus ? maxLevels : `${maxLevels}=${sMax.status} ${maxLevels + 1}=${sOver.status}`);

	const empty = await post({ state: 'x', questions: { a: { type: 'choice', instructions: 'p', criteria: {} } } });
	check('empty choice is rejected', EXPECT.emptyChoiceStatus, empty.status);

	const bare = await post({ state: 'x', questions: { a: { type: 'noul' } } });
	check('noul with neither instructions nor criteria', EXPECT.bareNoulStatus, bare.status,
		GATEWAY ? 'Kev accepts it; validateQuestions() still refuses it, so code stays portable' : undefined);

	const one = await post({ state: 'x', questions: { a: { type: 'score', instructions: 'r', criteria: ['only'] } } });
	check('one-level score is accepted (warn, do not throw)', 200, one.status);

	// Request overhead: empty state, one-character question.
	const base = await post({ state: '', questions: { a: { type: 'noul', instructions: 'x' } } });
	check('fixed request overhead, tokens', LIMITS.requestOverheadTokens, base.body?.usage?.input_tokens);
}

// ── context window ───────────────────────────────────────────────────────────

async function probeContext() {
	const filler = (n) =>
		Array.from({ length: n }, (_, i) => `record ${i} alpha beta gamma delta epsilon ${i * 7} zeta eta theta iota kappa `).join('');

	// One filler record is about 18 tokens. Search up to twice the configured
	// budget, in steps of about 1/25 of the range.
	let lo = 0;
	let hi = Math.ceil(LIMITS.stateTokens / 5);   // records, not characters
	const step = Math.max(10, Math.floor(hi / 25));
	let maxTokens = 0;

	while (hi - lo > step) {
		const mid = Math.floor((lo + hi) / 2);
		const r = await post({ state: filler(mid), questions: { a: NOUL('Does this mention GDPR?') } });
		if (r.status === 200) {
			lo = mid;
			maxTokens = Math.max(maxTokens, r.body.usage.input_tokens);
		} else {
			hi = mid;
		}
	}
	record('largest single-question request accepted, input tokens', maxTokens,
		`configured stateTokens budget is ${LIMITS.stateTokens}`);

	const over = await post({ state: filler(hi + Math.ceil(hi / 6)), questions: { a: NOUL('x?') } });
	check('oversize error status', EXPECT.oversizeStatus, over.status);
	if (GATEWAY) {
		check('oversize detail names the row limit', true, /branch too long/.test(String(over.body?.detail)),
			'errorFromResponse() maps this 422 to JevRequestTooLargeError');
	} else {
		check('oversize error_type', 'max_tokens_exceeded', over.body?.detail?.error_type);
		check('oversize error carries no message', undefined, over.body?.detail?.message,
			'this is why JevRequestTooLargeError writes its own');
	}
}

// ── error shapes ─────────────────────────────────────────────────────────────

async function probeErrors() {
	const res = await fetch(`${BASE}/v1/models`, { headers: { Authorization: 'Bearer definitely-not-a-key' } });
	const body = await res.json();
	check('401 status', 401, res.status);
	if (EXPECT.authShape === 'error') {
		check('401 gateway error shape', 'object', typeof body.error);
		record('401 gateway error type', body.error?.type);
	} else {
		check('401 detail shape', 'object', typeof body.detail);
		check('401 error_type', 'authentication_error', body.detail?.error_type);
	}

	if (!GATEWAY) {
		const bad = await post({ state: 'x', questions: { a: { type: 'choice', instructions: 'p', criteria: {} } } });
		check('common 400 detail shape', 'string', typeof bad.body?.detail);
	}

	const res422 = await fetch(`${BASE}/v1/systemone`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ state: 'x', questions: { a: NOUL('y') } }) // no model
	});
	const body422 = await res422.json();
	check('missing model status', EXPECT.missingModelStatus, res422.status);
	if (!GATEWAY) {
		check('422 detail shape', true, Array.isArray(body422.detail));
		check('model is a required field', 'model', body422.detail?.[0]?.loc?.[1]);
	}

	const unknown = await post({ state: 'x', model: 'gpt-9', questions: { a: NOUL('y') } });
	check('unknown model status', EXPECT.unknownModelStatus, unknown.status,
		GATEWAY ? 'the gateway serves every model name from the same Kev server' : undefined);
	if (!GATEWAY) check('unknown model error_type', 'api_usage_error', unknown.body?.detail?.error_type);
}

// ── fan-out ──────────────────────────────────────────────────────────────────

async function probeFanOut() {
	const state = 'Help! My payouts have been failing for 3 days and nobody has replied.';
	const mk = (n) =>
		Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, NOUL(`Is topic ${i} (payments, api, billing, churn, latency) discussed?`)]));

	const results = [];
	for (const n of [1, 50, 200]) {
		const r = await timedPost({ state, questions: mk(n) });
		results.push({ questions: n, status: r.status, ms: r.ms, inputTokens: r.body?.usage?.input_tokens });
	}
	record('fan-out latency', results.map((r) => `${r.questions}q=${r.ms}ms`).join('  '),
		GATEWAY
			? 'Kev latency grows with question count (1,000 questions took 30 s); the litellm timeout default is 120 s'
			: 'latency should be roughly flat in question count');

	const flat = results[2].ms < results[0].ms * 4 + 2000;
	check('latency stays roughly flat to 200 questions', true, flat);
}

// ── consistency ──────────────────────────────────────────────────────────────

async function probeConsistency() {
	const state = "Help! My payouts have been failing for 3 days. I was also charged twice for order A-104. This is the third time I've written in.";
	const q = {
		f: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
		n: NOUL('Is the customer asking for a refund?')
	};

	const scores = [];
	const nouls = [];
	for (let i = 0; i < 10; i++) {
		const r = await post({ state, questions: q });
		scores.push(r.body.answers.f.score);
		nouls.push(r.body.answers.n.noul);
	}

	const spread = (xs) => +(Math.max(...xs) - Math.min(...xs)).toFixed(4);
	const distinct = (xs) => new Set(xs).size;

	record('score across 10 identical calls', `${distinct(scores)} distinct, spread ${spread(scores)}`, scores.join(' '));
	record('noul across 10 identical calls', `${distinct(nouls)} distinct, spread ${spread(nouls)}`, nouls.join(' '));

	// Kev is near-deterministic: 10 sequential calls agreed exactly on 2026-09-28,
	// and 12 parallel ones spread 0.0027 (the server batches concurrent requests).
	// Flag only a Kev that got noisy.
	if (GATEWAY) {
		check('consistency claim (Kev)', 'spread under 0.01', spread(scores) < 0.01 && spread(nouls) < 0.01 ? 'spread under 0.01' : `score ${spread(scores)}, noul ${spread(nouls)}`,
			'Kev is near-deterministic; cache still defaults to false so sample() and the typesafe provider behave the same');
	} else if (distinct(scores) === 1 && distinct(nouls) === 1) {
		// The package documents "consistent, not deterministic". Flag either extreme.
		findings.push({
			name: 'consistency claim',
			expected: 'consistent but not deterministic',
			actual: 'perfectly deterministic in this run',
			ok: false,
			note: 'if this holds across runs, cache: true could become the default again'
		});
	} else if (spread(scores) > 0.3) {
		findings.push({
			name: 'consistency claim',
			expected: 'spread under 0.3',
			actual: `spread ${spread(scores)}`,
			ok: false,
			note: 'much noisier than measured on 2026-09-21; thresholds tuned on one draw are unsafe'
		});
	} else {
		check('consistency claim', 'consistent but not deterministic', 'consistent but not deterministic');
	}

	// Co-question drift.
	const alone = await post({ state, questions: { f: q.f } });
	const together = await post({ state, questions: q });
	const drift = Math.abs(alone.body.answers.f.score - together.body.answers.f.score);
	record('co-question drift on the same question', +drift.toFixed(4),
		'why cacheKey covers the whole payload, never one question');
}

// ── report ───────────────────────────────────────────────────────────────────

async function main() {
	const steps = [
		['roster', probeRoster],
		['limits', probeLimits],
		['context window', probeContext],
		['error shapes', probeErrors],
		['fan-out', probeFanOut],
		['consistency', probeConsistency]
	];

	for (const [name, fn] of steps) {
		if (!JSON_OUT) process.stderr.write(`probing ${name}...\n`);
		try {
			await fn();
		} catch (err) {
			findings.push({ name: `${name} probe`, expected: 'completed', actual: err.message, ok: false });
		}
	}

	// Two probe requests send `gpt-9` and no model at all; everything else sends MODEL.
	const cost = computeCost({ inputTokens, outputTokens: 0 }, MODEL) ?? 0;

	if (JSON_OUT) {
		console.log(JSON.stringify({ provider: PROVIDER.name, model: MODEL, findings, requests, inputTokens, cost, keySpend, pricingAsOf: MODEL_PRICING_AS_OF }, null, 2));
	} else {
		console.log('');
		for (const f of findings) {
			const mark = f.ok ? '  ok ' : ' DIFF';
			console.log(`${mark}  ${f.name}`);
			if (!f.ok) {
				console.log(`        expected: ${JSON.stringify(f.expected)}`);
				console.log(`        actual:   ${JSON.stringify(f.actual)}`);
			} else if (f.expected === '(observed)') {
				console.log(`        ${JSON.stringify(f.actual)}`);
			}
			if (f.note) console.log(`        note: ${f.note}`);
		}
		const failed = findings.filter((f) => !f.ok).length;
		console.log(`\n${findings.length - failed} matched, ${failed} differed`);
		console.log(`${PROVIDER.name} / ${MODEL}: ${requests} requests, ${inputTokens} input tokens, $${cost.toFixed(6)}`);
		if (keySpend !== undefined) console.log(`gateway key spend $${keySpend} (settles late; lags this run)`);
		if (failed > 0) console.log('\nUpdate models.js, tokens.js and AGENTS.md before shipping.');
	}

	process.exit(findings.some((f) => !f.ok) ? 1 : 0);
}

main();
