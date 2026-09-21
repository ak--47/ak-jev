/**
 * The core machinery: transport, retry, cache, governor, tokens, pricing, and
 * the `evaluate()` round trip. Fully offline — every client here is handed a
 * fake `fetch`.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BaseJev from '../../base.js';
import { JevClient, DEFAULT_RETRY, backoffDelay } from '../../client.js';
import { ResponseCache, cacheKey, canonicalize, resolveCache } from '../../cache.js';
import { Governor } from '../../governor.js';
import { estimateRequest, estimateTokens } from '../../tokens.js';
import { computeCost, resolvePricing, resolveLimits, resolveModelId, MODEL_PRICING } from '../../models.js';
import { noul, choice, score } from '../../questions.js';
import {
	JevConfigError,
	JevTimeoutError,
	JevRateLimitError,
	JevServerError,
	JevAuthError,
	JevAbortError
} from '../../errors.js';
import { fakeFetch, systemOneBody, noulAnswer, choiceAnswer, scoreAnswer, OFFLINE } from './_harness.js';

// ── pricing and limits ───────────────────────────────────────────────────────

describe('pricing', () => {
	test('rates are per million tokens, and output is free', () => {
		expect(MODEL_PRICING['jev-1.13.0']).toEqual({ input: 0.042, output: 0 });
	});

	test('$42/Btok is $0.042/Mtok', () => {
		// 1 billion input tokens should cost $42.
		expect(computeCost({ inputTokens: 1e9, outputTokens: 0 }, 'jev-latest')).toBeCloseTo(42, 6);
	});

	test('output tokens add nothing', () => {
		const a = computeCost({ inputTokens: 1000, outputTokens: 0 }, 'jev-latest');
		const b = computeCost({ inputTokens: 1000, outputTokens: 999999 }, 'jev-latest');
		expect(a).toBe(b);
	});

	test('aliases resolve for pricing', () => {
		expect(resolveModelId('jev-latest')).toBe('jev-1.13.0');
		expect(resolveModelId('jev-preview')).toBe('jev-1.13.0');
		expect(resolveModelId('jev-1.13')).toBe('jev-1.13.0');
		expect(resolvePricing('jev-preview').modelId).toBe('jev-1.13.0');
	});

	test('an unknown model yields null, which means unknown and not free', () => {
		expect(resolvePricing('jev-99')).toBeNull();
		expect(computeCost({ inputTokens: 1e6 }, 'jev-99')).toBeNull();
	});

	test('an unknown model still gets the flagship limits rather than none', () => {
		expect(resolveLimits('jev-99').maxChoiceOptions).toBe(255);
	});
});

// ── token estimation ─────────────────────────────────────────────────────────

describe('estimateRequest', () => {
	const q = { a: { type: 'noul', instructions: 'Is this urgent?' } };

	test('counts state, questions and the measured fixed overhead', () => {
		const est = estimateRequest({ state: 'hello world', questions: q, model: 'jev-latest' });
		expect(est.overheadTokens).toBe(267);
		expect(est.totalTokens).toBe(est.overheadTokens + est.stateTokens + est.questionTokens);
		expect(est.questionCount).toBe(1);
		expect(est.withinBudget).toBe(true);
	});

	test('flags a state over the 64k request budget', () => {
		const est = estimateRequest({ state: 'x'.repeat(400_000), questions: q });
		expect(est.withinBudget).toBe(false);
		expect(est.warnings.join(' ')).toMatch(/64000-token request budget/);
	});

	test('flags the tighter state-plus-longest-question budget on its own', () => {
		// Small state, one enormous question: passes 64k on the state alone but
		// the 32k widest-path check must still fire.
		const est = estimateRequest({
			state: 'tiny',
			questions: { big: { type: 'noul', instructions: 'y'.repeat(140_000) } }
		});
		expect(est.longestQuestionId).toBe('big');
		expect(est.warnings.join(' ')).toMatch(/longest question/);
	});

	test('names the longest question so you know what to trim', () => {
		const est = estimateRequest({
			state: 's',
			questions: { small: { type: 'noul', instructions: 'a' }, large: { type: 'noul', instructions: 'a'.repeat(500) } }
		});
		expect(est.longestQuestionId).toBe('large');
		expect(est.perQuestion.large).toBeGreaterThan(est.perQuestion.small);
	});

	test('survives a circular state rather than throwing', () => {
		const state = { a: 1 };
		/** @type {any} */ (state).self = state;
		expect(() => estimateTokens(state)).not.toThrow();
	});

	test('the safety margin pads the budget check but not the nominal total', () => {
		const est = estimateRequest({ state: 'hello world', questions: q });
		// `totalTokens` is what cost is based on; `budgetTokens` is what the
		// warning compares against. Conflating them would overstate spend.
		expect(est.budgetTokens).toBe(Math.ceil(est.totalTokens * 1.25));
		expect(est.budgetWidestPathTokens).toBe(Math.ceil(est.widestPathTokens * 1.25));
	});

	test('the margin makes the warning fire before the nominal estimate does', () => {
		// Sized so nominal is under 32k but padded is over: the whole point.
		const chars = Math.round(3.6 * 27_000);
		const est = estimateRequest({ state: 'x'.repeat(chars), questions: q });
		expect(est.totalTokens).toBeLessThan(32_000);
		expect(est.budgetWidestPathTokens).toBeGreaterThan(32_000);
		expect(est.withinBudget).toBe(false);
	});
});

// ── cache ────────────────────────────────────────────────────────────────────

describe('cache', () => {
	test('canonicalize sorts keys at every depth', () => {
		expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
	});

	test('canonicalize keeps array order, which is semantic for score levels', () => {
		expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
	});

	test('the key covers the whole payload', () => {
		const base = { baseURL: 'https://x', model: 'jev-latest', state: 's', questions: { a: 1 } };
		expect(cacheKey(base)).toBe(cacheKey({ ...base }));
		expect(cacheKey(base)).not.toBe(cacheKey({ ...base, state: 't' }));
		expect(cacheKey(base)).not.toBe(cacheKey({ ...base, questions: { a: 1, b: 2 } }));
		// An alias can move under you, so it is a distinct key from what it resolves to.
		expect(cacheKey(base)).not.toBe(cacheKey({ ...base, model: 'jev-1.13.0' }));
	});

	test('LRU evicts the oldest', () => {
		const c = new ResponseCache({ max: 2 });
		c.set('a', 1);
		c.set('b', 2);
		c.set('c', 3);
		expect(c.get('a')).toBeUndefined();
		expect(c.get('b')).toBe(2);
		expect(c.get('c')).toBe(3);
	});

	test('a read refreshes LRU position', () => {
		const c = new ResponseCache({ max: 2 });
		c.set('a', 1);
		c.set('b', 2);
		c.get('a');
		c.set('c', 3);
		expect(c.get('a')).toBe(1);
		expect(c.get('b')).toBeUndefined();
	});

	test('ttl expires an entry', () => {
		const c = new ResponseCache({ ttlMs: -1 });
		c.set('a', 1);
		expect(c.get('a')).toBeUndefined();
	});

	test('hits and misses are counted', () => {
		const c = new ResponseCache();
		c.get('nope');
		c.set('a', 1);
		c.get('a');
		expect(c.misses).toBe(1);
		expect(c.hits).toBe(1);
	});

	test('a disk cache survives a new instance', () => {
		const dir = mkdtempSync(join(tmpdir(), 'jev-cache-'));
		try {
			new ResponseCache({ dir }).set('k', { hello: 'world' });
			expect(new ResponseCache({ dir }).get('k')).toEqual({ hello: 'world' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('resolveCache honours false, true, options and an instance', () => {
		expect(resolveCache(false)).toBeNull();
		expect(resolveCache(true)).toBeInstanceOf(ResponseCache);
		expect(resolveCache({ max: 5 }).max).toBe(5);
		const existing = new ResponseCache();
		expect(resolveCache(existing)).toBe(existing);
	});
});

// ── governor ─────────────────────────────────────────────────────────────────

describe('governor', () => {
	test('never exceeds the concurrency limit', async () => {
		const g = new Governor({ concurrency: 3, requestsPerMinute: 100000, tokensPerSecond: 1e9 });
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 20 }, () =>
				g.run(async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((r) => setTimeout(r, 5));
					active--;
				})
			)
		);
		expect(peak).toBeLessThanOrEqual(3);
		expect(g.snapshot().admitted).toBe(20);
	});

	test('throttles when the requests-per-window budget is spent', async () => {
		// 2 per minute: the third must wait. Abort it rather than sleep a minute.
		const g = new Governor({ concurrency: 10, requestsPerMinute: 2, tokensPerSecond: 1e9 });
		await g.run(async () => {});
		await g.run(async () => {});

		const ctrl = new AbortController();
		const pending = g.run(async () => 'never', { signal: ctrl.signal });
		await new Promise((r) => setTimeout(r, 20));
		expect(g.snapshot().throttledMs).toBeGreaterThan(0);

		ctrl.abort();
		await expect(pending).rejects.toBeDefined();
	});

	test('throttles on the tokens-per-second window too', async () => {
		const g = new Governor({ concurrency: 10, requestsPerMinute: 1e6, tokensPerSecond: 100 });
		await g.run(async () => {}, { tokens: 100 });

		const before = g.snapshot().throttledMs;
		await g.run(async () => {}, { tokens: 100 }); // must wait out the 1s window
		expect(g.snapshot().throttledMs).toBeGreaterThan(before);
	});

	test('a queued call can be aborted', async () => {
		const g = new Governor({ concurrency: 1 });
		const ctrl = new AbortController();
		const blocker = g.run(() => new Promise((r) => setTimeout(r, 50)));
		const queued = g.run(async () => 'never', { signal: ctrl.signal });
		ctrl.abort();
		await expect(queued).rejects.toBeDefined();
		await blocker;
	});

	test('releases its slot even when the work throws', async () => {
		const g = new Governor({ concurrency: 1 });
		await expect(g.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		await expect(g.run(async () => 'ok')).resolves.toBe('ok');
	});
});

// ── transport ────────────────────────────────────────────────────────────────

describe('JevClient', () => {
	test('throws a config error with no key', () => {
		const saved = process.env.TYPESAFE_API_KEY;
		delete process.env.TYPESAFE_API_KEY;
		try {
			expect(() => new JevClient({})).toThrow(JevConfigError);
		} finally {
			process.env.TYPESAFE_API_KEY = saved;
		}
	});

	test('strips trailing slashes from baseURL', () => {
		expect(new JevClient({ apiKey: 'k', baseURL: 'https://x.test///' }).baseURL).toBe('https://x.test');
	});

	test('sends bearer auth, JSON content type and a user agent', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({}) }]);
		const c = new JevClient({ apiKey: 'secret', baseURL: 'https://x.test', fetch });
		await c.systemOne({ state: 's', model: 'jev-latest', questions: {} });
		expect(calls[0].url).toBe('https://x.test/v1/systemone');
		expect(calls[0].init.headers.Authorization).toBe('Bearer secret');
		expect(calls[0].init.headers['Content-Type']).toBe('application/json');
		expect(calls[0].init.headers['User-Agent']).toBe('ak-jev');
	});

	test('captures x-typesafe-request-id', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({}) }]);
		const c = new JevClient({ apiKey: 'k', baseURL: 'https://x.test', fetch });
		const r = await c.systemOne({ state: 's', model: 'jev-latest', questions: {} });
		expect(r.requestId).toBe('req_test_0');
	});

	test('models() unwraps the { models: [...] } envelope', async () => {
		// The docs' own JS snippet iterates the wrapper and would yield nothing.
		const { fetch } = fakeFetch([{ body: { models: [{ name: 'jev-latest', description: 'd', release_date: 'r' }] } }]);
		const c = new JevClient({ apiKey: 'k', baseURL: 'https://x.test', fetch });
		expect(await c.models()).toHaveLength(1);
	});

	test('retries a 529 and then succeeds', async () => {
		const { fetch, calls } = fakeFetch([
			{ status: 529, body: { detail: 'overloaded' } },
			{ body: systemOneBody({ a: noulAnswer(0.5) }) }
		]);
		const c = new JevClient({
			apiKey: 'k', baseURL: 'https://x.test', fetch,
			retry: { backoffInitialMs: 1, backoffMaxMs: 1 }
		});
		const r = await c.systemOne({ state: 's', model: 'jev-latest', questions: {} });
		expect(calls).toHaveLength(2);
		expect(r.data.answers.a.noul).toBe(0.5);
		expect(c.counters.retries).toBe(1);
	});

	test('gives up after maxRetries and throws the last error', async () => {
		const { fetch, calls } = fakeFetch([{ status: 500, body: { detail: 'nope' } }]);
		const c = new JevClient({
			apiKey: 'k', baseURL: 'https://x.test', fetch,
			retry: { maxRetries: 2, backoffInitialMs: 1, backoffMaxMs: 1 }
		});
		await expect(c.systemOne({ state: 's', model: 'jev-latest', questions: {} })).rejects.toThrow(JevServerError);
		expect(calls).toHaveLength(3); // 1 attempt + 2 retries
		expect(c.counters.failures).toBe(1);
	});

	test('does NOT retry a 401 — a bad key will not fix itself', async () => {
		const { fetch, calls } = fakeFetch([{ status: 401, body: { detail: { error_type: 'authentication_error', message: 'bad' } } }]);
		const c = new JevClient({ apiKey: 'k', baseURL: 'https://x.test', fetch, retry: { backoffInitialMs: 1 } });
		await expect(c.systemOne({ state: 's', model: 'jev-latest', questions: {} })).rejects.toThrow(JevAuthError);
		expect(calls).toHaveLength(1);
	});

	test('does NOT retry a 422 — the body is wrong, not the moment', async () => {
		const { fetch, calls } = fakeFetch([{ status: 422, body: { detail: [{ loc: ['body', 'model'], msg: 'Field required' }] } }]);
		const c = new JevClient({ apiKey: 'k', baseURL: 'https://x.test', fetch, retry: { backoffInitialMs: 1 } });
		await expect(c.systemOne({ state: 's', model: 'jev-latest', questions: {} })).rejects.toBeDefined();
		expect(calls).toHaveLength(1);
	});

	test('times out a slow attempt', async () => {
		const { fetch } = fakeFetch([{ delayMs: 200, body: systemOneBody({}) }]);
		const c = new JevClient({
			apiKey: 'k', baseURL: 'https://x.test', fetch,
			timeout: 20, retry: { maxRetries: 0 }
		});
		await expect(c.systemOne({ state: 's', model: 'jev-latest', questions: {} })).rejects.toThrow(JevTimeoutError);
	});

	test('a caller abort surfaces as JevAbortError and stops retrying', async () => {
		const ctrl = new AbortController();
		const { fetch, calls } = fakeFetch(async () => {
			ctrl.abort();
			return { status: 500, body: { detail: 'x' } };
		});
		const c = new JevClient({ apiKey: 'k', baseURL: 'https://x.test', fetch, retry: { backoffInitialMs: 1 } });
		await expect(
			c.systemOne({ state: 's', model: 'jev-latest', questions: {} }, { signal: ctrl.signal })
		).rejects.toThrow(JevAbortError);
		expect(calls).toHaveLength(1);
	});
});

describe('backoffDelay', () => {
	test('doubles and caps', () => {
		const r = { ...DEFAULT_RETRY, backoffJitter: 0, backoffInitialMs: 100, backoffMaxMs: 300 };
		expect(backoffDelay({}, 0, r)).toBe(100);
		expect(backoffDelay({}, 1, r)).toBe(200);
		expect(backoffDelay({}, 5, r)).toBe(300);
	});

	test('honours retry-after when it is within the ceiling', () => {
		const err = new JevRateLimitError('x', { retryAfterMs: 1234 });
		expect(backoffDelay(err, 0, { ...DEFAULT_RETRY, backoffJitter: 0 })).toBe(1234);
	});

	test('ignores an absurd retry-after and backs off instead', () => {
		const err = new JevRateLimitError('x', { retryAfterMs: 999_999_999 });
		const r = { ...DEFAULT_RETRY, backoffJitter: 0, backoffInitialMs: 100 };
		expect(backoffDelay(err, 0, r)).toBe(100);
	});

	test('jitter only ever subtracts', () => {
		const r = { ...DEFAULT_RETRY, backoffInitialMs: 1000, backoffMaxMs: 1000, backoffJitter: 0.25 };
		for (let i = 0; i < 50; i++) {
			const d = backoffDelay({}, 0, r);
			expect(d).toBeLessThanOrEqual(1000);
			expect(d).toBeGreaterThanOrEqual(750);
		}
	});
});

// ── BaseJev.evaluate ─────────────────────────────────────────────────────────

describe('BaseJev.evaluate', () => {
	const answers = {
		urgent: noulAnswer(0.96),
		team: choiceAnswer('billing', { billing: 0.9, technical: 0.1 }, 0.85),
		anger: scoreAnswer(1.05, ['Calm', 'Cross', 'Furious'], { 0: 0, 1: 0.95, 2: 0.05 }, 0.93)
	};

	const questions = () => ({
		urgent: 'Does this convey urgency?',
		team: choice('Who?', ['billing', 'technical']),
		anger: score('How angry?', { calm: 'Calm', cross: 'Cross', furious: 'Furious' })
	});

	test('sends state, model and wire-shaped questions', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody(answers) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		await jev.evaluate('a ticket', questions());

		expect(calls[0].body.state).toBe('a ticket');
		expect(calls[0].body.model).toBe('jev-latest');
		expect(calls[0].body.questions.urgent).toEqual({ type: 'noul', instructions: 'Does this convey urgency?' });
		expect(calls[0].body.questions.team.criteria).toEqual({ billing: null, technical: null });
		// Level NAMES must never reach the wire; only the descriptions do.
		expect(calls[0].body.questions.anger.criteria).toEqual(['Calm', 'Cross', 'Furious']);
	});

	test('returns enriched answers and level names from the object form', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody(answers) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const r = await jev.evaluate('t', questions());
		expect(r.answers.urgent.verdict).toBe('yes');
		expect(r.answers.team.margin).toBeCloseTo(0.8, 10);
		expect(r.answers.anger.label).toBe('cross');
		expect(r.model).toBe('jev-1.13.0');
		expect(r.requestedModel).toBe('jev-latest');
	});

	test('usage carries the cost and says where it came from', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody(answers, { inputTokens: 1_000_000, outputTokens: 500 }) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const r = await jev.evaluate('t', questions());
		expect(r.usage.inputTokens).toBe(1_000_000);
		expect(r.usage.estimatedCost).toBeCloseTo(0.042, 10);
		expect(r.usage.costSource).toBe('estimated');
		expect(r.usage.requests).toBe(1);
		expect(r.usage.questions).toBe(3);
	});

	test('total usage accumulates and resets', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody(answers, { inputTokens: 100 }) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		await jev.evaluate('a', questions());
		await jev.evaluate('b', questions());
		expect(jev.getTotalUsage().inputTokens).toBe(200);
		expect(jev.getTotalUsage().requests).toBe(2);
		jev.resetUsage();
		expect(jev.getTotalUsage().inputTokens).toBe(0);
		expect(jev.getLastUsage()).toBeNull();
	});

	test('one unknown rate makes the running total unknown, not a partial sum', async () => {
		const { fetch } = fakeFetch([
			{ body: systemOneBody(answers, { inputTokens: 100 }) },
			{ body: systemOneBody(answers, { model: 'jev-from-the-future', inputTokens: 100 }) }
		]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		await jev.evaluate('a', questions());
		await jev.evaluate('b', questions());
		expect(jev.getTotalUsage().estimatedCost).toBeNull();
	});

	test('a cache hit makes no request, costs zero and says so', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody(answers) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch, cache: true });
		const first = await jev.evaluate('t', questions());
		const second = await jev.evaluate('t', questions());

		expect(calls).toHaveLength(1);
		expect(first.cached).toBe(false);
		expect(second.cached).toBe(true);
		expect(second.usage.estimatedCost).toBe(0);
		expect(second.usage.costSource).toBe('cached');
		expect(second.usage.requests).toBe(0);
		expect(second.answers.urgent.noul).toBe(0.96);
		expect(jev.stats().cacheHits).toBe(1);
		expect(jev.stats().cacheMisses).toBe(1);
	});

	test('a different state is a different cache entry', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody(answers) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch, cache: true });
		await jev.evaluate('a', questions());
		await jev.evaluate('b', questions());
		expect(calls).toHaveLength(2);
	});

	test('validation runs before the request, so a bad question never leaves', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({}) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		await expect(
			jev.evaluate('t', { a: choice('x', Array.from({ length: 300 }, (_, i) => `o${i}`)) })
		).rejects.toThrow(/at most 255/);
		expect(calls).toHaveLength(0);
	});

	test('validate: false lets it through to the API', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({}) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch, validate: false });
		await jev.evaluate('t', { a: choice('x', Array.from({ length: 300 }, (_, i) => `o${i}`)) });
		expect(calls).toHaveLength(1);
	});

	test('a per-call model override is sent and reported', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody(answers) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const r = await jev.evaluate('t', questions(), { model: 'jev-preview' });
		expect(calls[0].body.model).toBe('jev-preview');
		expect(r.requestedModel).toBe('jev-preview');
	});

	test('onResult fires for both live and cached results', async () => {
		const seen = [];
		const { fetch } = fakeFetch([{ body: systemOneBody(answers) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch, cache: true, onResult: (r) => seen.push(r.cached) });
		await jev.evaluate('t', questions());
		await jev.evaluate('t', questions());
		expect(seen).toEqual([false, true]);
	});

	test('healthCheck calls GET /v1/models on init', async () => {
		const { fetch, calls } = fakeFetch([
			{ body: { models: [] } },
			{ body: systemOneBody(answers) }
		]);
		const jev = new BaseJev({ ...OFFLINE, fetch, healthCheck: true });
		await jev.evaluate('t', questions());
		expect(calls[0].url).toContain('/v1/models');
		expect(calls[0].init.method).toBe('GET');
	});
});

describe('BaseJev.evaluateMany', () => {
	const body = systemOneBody({ a: noulAnswer(0.7) });

	test('keeps input order regardless of completion order', async () => {
		const { fetch } = fakeFetch(async (_url, init) => {
			const state = JSON.parse(init.body).state;
			// Later states finish first.
			await new Promise((r) => setTimeout(r, state === 'first' ? 30 : 1));
			return { body: systemOneBody({ a: noulAnswer(state === 'first' ? 0.1 : 0.9) }) };
		});
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const out = await jev.evaluateMany(['first', 'second'], { a: 'x?' });
		expect(out[0].answers.a.noul).toBe(0.1);
		expect(out[1].answers.a.noul).toBe(0.9);
	});

	test('captures a failure per item rather than losing the batch', async () => {
		const { fetch } = fakeFetch(async (_url, init) =>
			JSON.parse(init.body).state === 'bad'
				? { status: 400, body: { detail: 'nope' } }
				: { body }
		);
		const jev = new BaseJev({ ...OFFLINE, fetch, retry: { maxRetries: 0 } });
		const out = await jev.evaluateMany(['ok', 'bad', 'ok2'], { a: 'x?' });
		expect(out[0].failed).toBeUndefined();
		expect(out[1].failed).toBe(true);
		expect(out[1].error.message).toBe('nope');
		expect(out[2].failed).toBeUndefined();
	});

	test('throwOnError propagates instead', async () => {
		const { fetch } = fakeFetch([{ status: 400, body: { detail: 'nope' } }]);
		const jev = new BaseJev({ ...OFFLINE, fetch, retry: { maxRetries: 0 } });
		await expect(jev.evaluateMany(['a'], { a: 'x?' }, { throwOnError: true })).rejects.toThrow('nope');
	});

	test('reports progress once per item', async () => {
		const { fetch } = fakeFetch([{ body }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const seen = [];
		await jev.evaluateMany(['a', 'b', 'c'], { a: 'x?' }, { onProgress: (p) => seen.push(p.done) });
		expect(seen.sort()).toEqual([1, 2, 3]);
	});
});

describe('BaseJev.sample', () => {
	/** Draws that vary the way the real API does. */
	const varying = (values) => {
		let i = 0;
		return fakeFetch(async () => ({ body: systemOneBody({ f: noulAnswer(values[i++ % values.length]) }) }));
	};

	test('makes n requests and reports the spread', async () => {
		const { fetch, calls } = varying([0.47, 0.5, 0.53, 0.49, 0.51]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const s = await jev.sample('t', { f: noul('Refund?') }, { n: 5 });

		expect(calls).toHaveLength(5);
		expect(s.n).toBe(5);
		expect(s.samples).toHaveLength(5);
		expect(s.summary.f.min).toBe(0.47);
		expect(s.summary.f.max).toBe(0.53);
		expect(s.summary.f.spread).toBeCloseTo(0.06, 10);
		expect(s.summary.f.mean).toBeCloseTo(0.5, 10);
		expect(s.summary.f.values).toHaveLength(5);
	});

	test('bypasses the cache even when the client has one', async () => {
		// Without the bypass, four of five draws would be the same memo and the
		// measured spread would be zero — the exact wrong answer.
		const { fetch, calls } = varying([0.4, 0.6, 0.4, 0.6]);
		const jev = new BaseJev({ ...OFFLINE, fetch, cache: true });
		const s = await jev.sample('t', { f: noul('Refund?') }, { n: 4 });
		expect(calls).toHaveLength(4);
		expect(s.summary.f.spread).toBeGreaterThan(0);
		expect(s.samples.every((x) => x.cached === false)).toBe(true);
	});

	test('agreement is the fraction of draws sharing the modal verdict', async () => {
		// 3 clear yes, 1 unsure -> 3/4.
		const { fetch } = varying([0.95, 0.9, 0.85, 0.5]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const s = await jev.sample('t', { f: noul('Refund?') }, { n: 4 });
		expect(s.summary.f.verdict).toBe('yes');
		expect(s.summary.f.agreement).toBe(0.75);
		expect(s.summary.f.counts).toEqual({ yes: 3, unsure: 1 });
	});

	test('summarizes a choice by modal label and confidence spread', async () => {
		let i = 0;
		const picks = [
			choiceAnswer('a', { a: 0.6, b: 0.4 }, 0.5),
			choiceAnswer('a', { a: 0.7, b: 0.3 }, 0.6),
			choiceAnswer('b', { a: 0.45, b: 0.55 }, 0.1)
		];
		const { fetch } = fakeFetch(async () => ({ body: systemOneBody({ c: picks[i++ % picks.length] }) }));
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const s = await jev.sample('t', { c: choice('Which?', ['a', 'b']) }, { n: 3 });
		expect(s.summary.c.choice).toBe('a');
		expect(s.summary.c.agreement).toBeCloseTo(2 / 3, 10);
		expect(s.summary.c.confidence.spread).toBeCloseTo(0.5, 10);
	});

	test('summarizes a score by value spread and modal level', async () => {
		let i = 0;
		const draws = [1.75, 1.83, 1.79];
		const { fetch } = fakeFetch(async () => ({
			body: systemOneBody({ s: scoreAnswer(draws[i++ % draws.length], ['a', 'b', 'c'], { 0: 0, 1: 0.2, 2: 0.8 }, 0.5) })
		}));
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const out = await jev.sample('t', { s: score('How?', ['a', 'b', 'c']) }, { n: 3 });
		expect(out.summary.s.spread).toBeCloseTo(0.08, 10);
		expect(out.summary.s.level).toBe('2');
		expect(out.summary.s.agreement).toBe(1);
	});

	test('n defaults to 5 and is floored at 1', async () => {
		const a = varying([0.5]);
		await new BaseJev({ ...OFFLINE, fetch: a.fetch }).sample('t', { f: noul('x') });
		expect(a.calls).toHaveLength(5);

		const b = varying([0.5]);
		await new BaseJev({ ...OFFLINE, fetch: b.fetch }).sample('t', { f: noul('x') }, { n: 0 });
		expect(b.calls).toHaveLength(1);
	});
});

describe('BaseJev.estimate', () => {
	test('estimates without touching the network', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({}) }]);
		const jev = new BaseJev({ ...OFFLINE, fetch });
		const est = jev.estimate('hello', { a: noul('Is this a greeting?') });
		expect(calls).toHaveLength(0);
		expect(est.totalTokens).toBeGreaterThan(267);
		expect(est.estimatedCost).toBeGreaterThan(0);
	});

	test('estimateCost returns just the number', async () => {
		const jev = new BaseJev({ ...OFFLINE, fetch: fakeFetch([]).fetch });
		expect(typeof jev.estimateCost('x', { a: noul('y') })).toBe('number');
	});
});

describe('option normalization', () => {
	test('accepts both modelName and model', () => {
		const f = fakeFetch([]).fetch;
		expect(new BaseJev({ ...OFFLINE, fetch: f, modelName: 'jev-preview' }).modelName).toBe('jev-preview');
		expect(new BaseJev({ ...OFFLINE, fetch: f, model: 'jev-preview' }).modelName).toBe('jev-preview');
	});

	test('rejects an unknown threshold key rather than ignoring it', () => {
		expect(() => new BaseJev({ ...OFFLINE, thresholds: /** @type {any} */ ({ maybe: 0.5 }) }))
			.toThrow(JevConfigError);
	});

	test('thresholds merge over the defaults', () => {
		const jev = new BaseJev({ ...OFFLINE, fetch: fakeFetch([]).fetch, thresholds: { yes: 0.9 } });
		expect(jev.thresholds).toEqual({ yes: 0.9, high: 0.8, low: 0.2 });
	});
});
