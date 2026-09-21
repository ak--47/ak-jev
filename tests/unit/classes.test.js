/**
 * The nine classes. Offline: every client gets a fake `fetch`, so these assert
 * the shape of what goes out and the shape of what comes back, not the model's
 * judgment.
 */

import { describe, test, expect } from '@jest/globals';

import Evaluator from '../../evaluator.js';
import Classifier from '../../classifier.js';
import Detector from '../../detector.js';
import Scorer from '../../scorer.js';
import Router from '../../router.js';
import Ranker from '../../ranker.js';
import Extractor from '../../extractor.js';
import Taxonomy from '../../taxonomy.js';
import Guard, { JevGuardError } from '../../guard.js';
import { NOT_STATED } from '../../extractor.js';
import { noul, choice, score } from '../../questions.js';
import { JevValidationError } from '../../errors.js';
import { fakeFetch, systemOneBody, noulAnswer, choiceAnswer, scoreAnswer, OFFLINE } from './_harness.js';

// ── Evaluator ────────────────────────────────────────────────────────────────

describe('Evaluator', () => {
	const body = systemOneBody({ a: noulAnswer(0.9), b: choiceAnswer('x', { x: 1, y: 0 }) });

	test('binds a question set and sends it on every run', async () => {
		const { fetch, calls } = fakeFetch([{ body }]);
		const ev = new Evaluator({ ...OFFLINE, fetch, questions: { a: 'A?', b: choice('B?', ['x', 'y']) } });
		await ev.run('state one');
		expect(Object.keys(calls[0].body.questions).sort()).toEqual(['a', 'b']);
	});

	test('addQuestions and removeQuestions chain', async () => {
		const { fetch, calls } = fakeFetch([{ body }]);
		const ev = new Evaluator({ ...OFFLINE, fetch, questions: { a: 'A?' } });
		ev.addQuestions({ b: choice('B?', ['x', 'y']) }).addQuestions({ c: 'C?' }).removeQuestions('c');
		await ev.run('s');
		expect(Object.keys(calls[0].body.questions).sort()).toEqual(['a', 'b']);
	});

	test('per-call questions merge over the bound set', async () => {
		const { fetch, calls } = fakeFetch([{ body }]);
		const ev = new Evaluator({ ...OFFLINE, fetch, questions: { a: 'A?' } });
		await ev.run('s', { questions: { z: 'Z?' } });
		expect(Object.keys(calls[0].body.questions).sort()).toEqual(['a', 'z']);
	});

	test('throws when there are no questions at all', async () => {
		const ev = new Evaluator({ ...OFFLINE, fetch: fakeFetch([]).fetch });
		await expect(ev.run('s')).rejects.toThrow(/no questions/i);
	});

	test('stream() yields every state exactly once, with its index', async () => {
		const { fetch } = fakeFetch(async (_u, init) => {
			const s = JSON.parse(init.body).state;
			await new Promise((r) => setTimeout(r, s === 'slow' ? 25 : 1));
			return { body: systemOneBody({ a: noulAnswer(s === 'slow' ? 0.1 : 0.9) }) };
		});
		const ev = new Evaluator({ ...OFFLINE, fetch, questions: { a: 'A?' } });

		const seen = [];
		for await (const item of ev.stream(['slow', 'fast1', 'fast2'])) seen.push(item);

		expect(seen).toHaveLength(3);
		expect(seen.map((s) => s.index).sort()).toEqual([0, 1, 2]);
		// Completion order, so the slow one is not first.
		expect(seen[0].state).not.toBe('slow');
		expect(seen.every((s) => s.result)).toBe(true);
	});

	test('stream() reports a per-item error rather than aborting the run', async () => {
		const { fetch } = fakeFetch(async (_u, init) =>
			JSON.parse(init.body).state === 'bad'
				? { status: 400, body: { detail: 'nope' } }
				: { body: systemOneBody({ a: noulAnswer(0.5) }) }
		);
		const ev = new Evaluator({ ...OFFLINE, fetch, questions: { a: 'A?' }, retry: { maxRetries: 0 } });
		const seen = [];
		for await (const item of ev.stream(['ok', 'bad'])) seen.push(item);
		expect(seen).toHaveLength(2);
		expect(seen.filter((s) => s.error)).toHaveLength(1);
	});
});

// ── Classifier ───────────────────────────────────────────────────────────────

describe('Classifier', () => {
	const mk = (winner, probs, confidence) =>
		systemOneBody({ label: choiceAnswer(winner, probs, confidence) });

	test('requires labels', () => {
		expect(() => new Classifier(/** @type {any} */ ({ ...OFFLINE }))).toThrow(/labels/);
	});

	test('rejects a fallback that collides with a real label', () => {
		expect(() => new Classifier({ ...OFFLINE, labels: ['a', 'b'], fallback: 'a' }))
			.toThrow(/also one of the labels/);
	});

	test('returns the label above the bar', async () => {
		const { fetch } = fakeFetch([{ body: mk('billing', { billing: 0.9, tech: 0.1 }, 0.85) }]);
		const c = new Classifier({ ...OFFLINE, fetch, labels: ['billing', 'tech'], minConfidence: 0.5, fallback: 'human' });
		const r = await c.classify('t');
		expect(r.label).toBe('billing');
		expect(r.decided).toBe(true);
	});

	test('falls back below the bar but still reports what the model picked', async () => {
		const { fetch } = fakeFetch([{ body: mk('billing', { billing: 0.4, tech: 0.35, sales: 0.25 }, 0.2) }]);
		const c = new Classifier({ ...OFFLINE, fetch, labels: ['billing', 'tech', 'sales'], minConfidence: 0.5, fallback: 'human' });
		const r = await c.classify('t');
		expect(r.label).toBe('human');
		expect(r.decided).toBe(false);
		expect(r.choice).toBe('billing');
	});

	test('a null label when undecided with no fallback', async () => {
		const { fetch } = fakeFetch([{ body: mk('a', { a: 0.5, b: 0.5 }, 0.1) }]);
		const c = new Classifier({ ...OFFLINE, fetch, labels: ['a', 'b'], minConfidence: 0.9 });
		expect((await c.classify('t')).label).toBeNull();
	});

	test('alternatives lists other labels over the threshold, excluding zeroes', async () => {
		const { fetch } = fakeFetch([{ body: mk('returns', { returns: 0.61, billing: 0.35, shipping: 0 }, 0.42) }]);
		const c = new Classifier({ ...OFFLINE, fetch, labels: ['returns', 'billing', 'shipping'], alternativeThreshold: 0.25 });
		const r = await c.classify('t');
		expect(r.alternatives).toEqual([{ label: 'billing', probability: 0.35 }]);
	});

	test('extra questions ride along in the same request', async () => {
		const { fetch, calls } = fakeFetch([{ body: { ...mk('a', { a: 1, b: 0 }, 1), answers: { label: choiceAnswer('a', { a: 1, b: 0 }), extra: noulAnswer(0.3) } } }]);
		const c = new Classifier({ ...OFFLINE, fetch, labels: ['a', 'b'] });
		const r = await c.classify('t', { questions: { extra: 'Is it raining?' } });
		expect(Object.keys(calls[0].body.questions).sort()).toEqual(['extra', 'label']);
		expect(r.answers.extra.noul).toBe(0.3);
	});

	test('group() buckets states by label', async () => {
		const { fetch } = fakeFetch(async (_u, init) => {
			const s = JSON.parse(init.body).state;
			return { body: mk(s === 'm' ? 'billing' : 'tech', { billing: 1, tech: 0 }, 1) };
		});
		const c = new Classifier({ ...OFFLINE, fetch, labels: ['billing', 'tech'] });
		const groups = await c.group(['m', 'b', 'm']);
		expect(groups.billing).toEqual(['m', 'm']);
		expect(groups.tech).toEqual(['b']);
	});
});

// ── Detector ─────────────────────────────────────────────────────────────────

describe('Detector', () => {
	test('requires conditions', () => {
		expect(() => new Detector(/** @type {any} */ ({ ...OFFLINE }))).toThrow(/conditions/);
	});

	test('flags, verdicts and triggered order', async () => {
		const { fetch } = fakeFetch([{
			body: systemOneBody({ email: noulAnswer(1), phone: noulAnswer(0.01), addr: noulAnswer(0.55) })
		}]);
		const d = new Detector({ ...OFFLINE, fetch, conditions: { email: 'e?', phone: 'p?', addr: 'a?' } });
		const r = await d.check('t');

		expect(r.flags).toEqual({ email: true, phone: false, addr: true });
		expect(r.verdicts).toEqual({ email: 'yes', phone: 'no', addr: 'unsure' });
		expect(r.triggered).toEqual(['email', 'addr']); // strongest first
		expect(r.unsure).toEqual(['addr']);
		expect(r.any).toBe(true);
		expect(r.all).toBe(false);
		expect(r.count).toBe(2);
		expect(r.max).toBe(1);
	});

	test('a per-condition threshold overrides the client default', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ a: noulAnswer(0.6), b: noulAnswer(0.6) }) }]);
		const d = new Detector({
			...OFFLINE, fetch,
			conditions: { a: 'a?', b: { instructions: 'b?', yes: 0.7 } }
		});
		const r = await d.check('t');
		expect(r.flags).toEqual({ a: true, b: false });
	});

	test('criteria reach the wire', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({ a: noulAnswer(0.5) }) }]);
		const d = new Detector({
			...OFFLINE, fetch,
			conditions: { a: { instructions: 'a?', criteria: { true: 'yes means', false: 'no means' } } }
		});
		await d.check('t');
		expect(calls[0].body.questions.a.criteria).toEqual({ true: 'yes means', false: 'no means' });
	});
});

// ── Scorer ───────────────────────────────────────────────────────────────────

describe('Scorer', () => {
	const body = systemOneBody({
		severity: scoreAnswer(1.24, ['a', 'b', 'c'], { 0: 0, 1: 0.76, 2: 0.24 }, 0.64),
		quality: scoreAnswer(3, ['a', 'b', 'c', 'd'], { 0: 0, 1: 0, 2: 0, 3: 1 }, 1)
	});
	const dims = {
		severity: { weight: 0.6, instructions: 's?', levels: ['a', 'b', 'c'] },
		quality: { weight: 0.4, instructions: 'q?', levels: ['a', 'b', 'c', 'd'] }
	};

	test('requires dimensions', () => {
		expect(() => new Scorer(/** @type {any} */ ({ ...OFFLINE }))).toThrow(/dimensions/);
	});

	test('rejects a dimension without levels', () => {
		expect(() => new Scorer({ ...OFFLINE, dimensions: { a: /** @type {any} */ ({ instructions: 'x' }) } }))
			.toThrow(/levels/);
	});

	test('rejects a negative weight', () => {
		expect(() => new Scorer({ ...OFFLINE, dimensions: { a: { instructions: 'x', levels: ['a', 'b'], weight: -1 } } }))
			.toThrow(/finite and >= 0/);
	});

	test('normalizes each score by its own level count before weighting', async () => {
		const { fetch } = fakeFetch([{ body }]);
		const s = new Scorer({ ...OFFLINE, fetch, dimensions: dims });
		const r = await s.score('t');
		// severity: 1.24 / 2 = 0.62   quality: 3 / 3 = 1.0
		expect(r.dimensions.severity.normalized).toBeCloseTo(0.62, 10);
		expect(r.dimensions.quality.normalized).toBe(1);
		expect(r.composite).toBeCloseTo(0.6 * 0.62 + 0.4 * 1.0, 10);
	});

	test('weights are rescaled so the composite is always 0 to 1', async () => {
		const { fetch } = fakeFetch([{ body }]);
		// Weights of 6 and 4 must behave exactly like 0.6 and 0.4.
		const s = new Scorer({
			...OFFLINE, fetch,
			dimensions: { severity: { ...dims.severity, weight: 6 }, quality: { ...dims.quality, weight: 4 } }
		});
		const r = await s.score('t');
		expect(r.composite).toBeCloseTo(0.6 * 0.62 + 0.4 * 1.0, 10);
		expect(s.normalizedWeights).toEqual({ severity: 0.6, quality: 0.4 });
	});

	test('invert flips a dimension after normalization', async () => {
		const { fetch } = fakeFetch([{ body }]);
		const s = new Scorer({
			...OFFLINE, fetch,
			dimensions: { severity: { ...dims.severity, weight: 1 }, quality: { ...dims.quality, weight: 0, invert: true } }
		});
		const r = await s.score('t');
		expect(r.dimensions.quality.normalized).toBe(0); // 1 - 1
		expect(r.dimensions.quality.inverted).toBe(true);
	});

	test('weakest names the least confident dimension', async () => {
		const { fetch } = fakeFetch([{ body }]);
		const s = new Scorer({ ...OFFLINE, fetch, dimensions: dims });
		const r = await s.score('t');
		expect(r.weakest).toBe('severity');
		expect(r.weakestConfidence).toBe(0.64);
	});

	test('reweight recomputes with no API call', async () => {
		const { fetch, calls } = fakeFetch([{ body }]);
		const s = new Scorer({ ...OFFLINE, fetch, dimensions: dims });
		const r = await s.score('t');
		expect(Scorer.reweight(r, { severity: 1, quality: 0 })).toBeCloseTo(0.62, 10);
		expect(Scorer.reweight(r, { severity: 0, quality: 1 })).toBe(1);
		expect(calls).toHaveLength(1);
	});

	test('rank sorts descending and pushes failures to the end', async () => {
		const { fetch } = fakeFetch(async (_u, init) => {
			const s = JSON.parse(init.body).state;
			if (s === 'bad') return { status: 400, body: { detail: 'nope' } };
			const v = s === 'high' ? 2 : 0;
			return {
				body: systemOneBody({
					severity: scoreAnswer(v, ['a', 'b', 'c'], { 0: 0, 1: 0, 2: 1 }, 1),
					quality: scoreAnswer(0, ['a', 'b', 'c', 'd'], { 0: 1, 1: 0, 2: 0, 3: 0 }, 1)
				})
			};
		});
		const s = new Scorer({ ...OFFLINE, fetch, dimensions: dims, retry: { maxRetries: 0 } });
		const rows = await s.rank(['low', 'bad', 'high']);
		expect(rows.map((r) => r.state)).toEqual(['high', 'low', 'bad']);
		expect(rows[2].error).toBeDefined();
		expect(rows[2].composite).toBeNull();
	});

	test('rank honours top', async () => {
		const { fetch } = fakeFetch([{ body }]);
		const s = new Scorer({ ...OFFLINE, fetch, dimensions: dims });
		expect(await s.rank(['a', 'b', 'c'], { top: 2 })).toHaveLength(2);
	});
});

// ── Router ───────────────────────────────────────────────────────────────────

describe('Router', () => {
	const mk = (winner, probs, confidence) => systemOneBody({ route: choiceAnswer(winner, probs, confidence) });

	test('requires routes', () => {
		expect(() => new Router(/** @type {any} */ ({ ...OFFLINE }))).toThrow(/routes/);
	});

	test('runs the handler when the route clears its own bar', async () => {
		const { fetch } = fakeFetch([{ body: mk('refund', { refund: 0.95, info: 0.05 }, 0.9) }]);
		const r = new Router({
			...OFFLINE, fetch,
			routes: {
				refund: { description: 'money back', minConfidence: 0.85, handler: async (ctx) => `R:${ctx.extra}` },
				info: { description: 'a question', minConfidence: 0.5, handler: async () => 'I' }
			},
			fallback: async () => 'HUMAN'
		});
		const out = await r.route('t', 'T-1');
		expect(out.route).toBe('refund');
		expect(out.value).toBe('R:T-1');
		expect(out.handled).toBe(true);
	});

	test('per-route bars differ: the same confidence clears one and not the other', async () => {
		const routes = {
			cheap: { description: 'low stakes', minConfidence: 0.6, handler: async () => 'CHEAP' },
			risky: { description: 'high stakes', minConfidence: 0.95, handler: async () => 'RISKY' }
		};
		const at = async (winner) => {
			const { fetch } = fakeFetch([{ body: mk(winner, { cheap: 0.8, risky: 0.8 }, 0.8) }]);
			const r = new Router({ ...OFFLINE, fetch, routes, fallback: async () => 'HUMAN' });
			return r.route('t');
		};
		expect((await at('cheap')).value).toBe('CHEAP');
		expect((await at('risky')).value).toBe('HUMAN');
		expect((await at('risky')).fellBack).toBe(true);
	});

	test('a bare function is a route with no description', async () => {
		const { fetch, calls } = fakeFetch([{ body: mk('a', { a: 1, b: 0 }, 1) }]);
		const r = new Router({ ...OFFLINE, fetch, routes: { a: async () => 'A', b: async () => 'B' } });
		const out = await r.route('t');
		expect(calls[0].body.questions.route.criteria).toEqual({ a: null, b: null });
		expect(out.value).toBe('A');
	});

	test('dispatch: false returns the decision without running anything', async () => {
		let ran = false;
		const { fetch } = fakeFetch([{ body: mk('a', { a: 1, b: 0 }, 1) }]);
		const r = new Router({ ...OFFLINE, fetch, dispatch: false, routes: { a: async () => { ran = true; }, b: 'B' } });
		const out = await r.route('t');
		expect(ran).toBe(false);
		expect(out.route).toBe('a');
		expect(out.handled).toBe(false);
	});

	test('extra questions ride along and reach the handler context', async () => {
		const { fetch } = fakeFetch([{
			body: systemOneBody({ route: choiceAnswer('a', { a: 1, b: 0 }, 1), complexity: scoreAnswer(2, ['x', 'y', 'z'], { 0: 0, 1: 0, 2: 1 }, 1) })
		}]);
		const r = new Router({
			...OFFLINE, fetch,
			routes: { a: async (ctx) => ctx.answers.complexity.normalized, b: 'B' },
			questions: { complexity: score('How complex?', ['x', 'y', 'z']) }
		});
		expect((await r.route('t')).value).toBe(1);
	});

	test('rejects a non-function handler and a non-function fallback', () => {
		expect(() => new Router({ ...OFFLINE, routes: { a: /** @type {any} */ ({ handler: 'nope' }) } }))
			.toThrow(/not a function/);
		expect(() => new Router({ ...OFFLINE, routes: { a: 'A' }, fallback: /** @type {any} */ ('nope') }))
			.toThrow(/must be a function/);
	});
});

// ── Ranker ───────────────────────────────────────────────────────────────────

describe('Ranker', () => {
	test('one question per candidate, all in one request when they fit', async () => {
		const { fetch, calls } = fakeFetch([{
			body: systemOneBody({ c0: noulAnswer(0.2), c1: noulAnswer(0.9), c2: noulAnswer(0.5) })
		}]);
		const r = new Ranker({ ...OFFLINE, fetch, instructions: 'relevant?' });
		const out = await r.rank('q', ['a', 'b', 'c']);

		expect(calls).toHaveLength(1);
		expect(Object.keys(calls[0].body.questions).sort()).toEqual(['c0', 'c1', 'c2']);
		// The candidate travels inside its own question, keeping the state small.
		expect(calls[0].body.state).toEqual({ query: 'q' });
		expect(calls[0].body.questions.c0.instructions).toEqual({ candidate: 'a', question: 'relevant?' });

		expect(out.map((x) => x.candidate)).toEqual(['b', 'c', 'a']);
		expect(out.map((x) => x.rank)).toEqual([1, 2, 3]);
		expect(out[0].relevance).toBe(0.9);
		expect(out[0].index).toBe(1);
	});

	test('batches across requests when the count cap is hit', async () => {
		const { fetch, calls } = fakeFetch(async (_u, init) => {
			const ids = Object.keys(JSON.parse(init.body).questions);
			return { body: systemOneBody(Object.fromEntries(ids.map((id) => [id, noulAnswer(0.5)]))) };
		});
		const r = new Ranker({ ...OFFLINE, fetch, batchSize: 3 });
		const out = await r.rank('q', Array.from({ length: 7 }, (_, i) => `cand ${i}`));
		expect(calls).toHaveLength(3); // 3 + 3 + 1
		expect(out).toHaveLength(7);
	});

	test('top and minRelevance cut the result', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ c0: noulAnswer(0.2), c1: noulAnswer(0.9), c2: noulAnswer(0.5) }) }]);
		const r = new Ranker({ ...OFFLINE, fetch });
		expect(await r.rank('q', ['a', 'b', 'c'], { top: 2 })).toHaveLength(2);

		const { fetch: f2 } = fakeFetch([{ body: systemOneBody({ c0: noulAnswer(0.2), c1: noulAnswer(0.9), c2: noulAnswer(0.5) }) }]);
		const r2 = new Ranker({ ...OFFLINE, fetch: f2 });
		expect(await r2.rank('q', ['a', 'b', 'c'], { minRelevance: 0.4 })).toHaveLength(2);
	});

	test('toText pulls the text out of candidate objects', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({ c0: noulAnswer(0.5) }) }]);
		const r = new Ranker({ ...OFFLINE, fetch, toText: (c) => c.body });
		const out = await r.rank('q', [{ id: 7, body: 'the text' }]);
		expect(calls[0].body.questions.c0.instructions.candidate).toBe('the text');
		// The full object comes back, not just the text.
		expect(out[0].candidate).toEqual({ id: 7, body: 'the text' });
	});

	test("mode 'score' uses normalized score as relevance", async () => {
		const { fetch, calls } = fakeFetch([{
			body: systemOneBody({ c0: scoreAnswer(2, ['no', 'maybe', 'yes'], { 0: 0, 1: 0, 2: 1 }, 1) })
		}]);
		const r = new Ranker({ ...OFFLINE, fetch, mode: 'score', levels: ['no', 'maybe', 'yes'] });
		const out = await r.rank('q', ['a']);
		expect(calls[0].body.questions.c0.type).toBe('score');
		expect(out[0].relevance).toBe(1);
	});

	test("mode 'score' without levels throws at construction", () => {
		expect(() => new Ranker({ ...OFFLINE, mode: 'score' })).toThrow(/levels/);
	});

	test('pick puts the candidates in the state and the ids in the criteria', async () => {
		const { fetch, calls } = fakeFetch([{
			body: systemOneBody({ best: choiceAnswer('c1', { c0: 0.1, c1: 0.9 }, 0.8) })
		}]);
		const r = new Ranker({ ...OFFLINE, fetch });
		const out = await r.pick('q', ['alpha', 'beta']);

		expect(calls[0].body.state.candidates).toEqual({ c0: 'alpha', c1: 'beta' });
		expect(calls[0].body.questions.best.criteria).toEqual({ c0: null, c1: null });
		expect(out.index).toBe(1);
		expect(out.candidate).toBe('beta');
		expect(out.found).toBe(true);
	});

	test('pick with includeNone adds an absolute found check', async () => {
		const { fetch, calls } = fakeFetch([{
			body: systemOneBody({ best: choiceAnswer('__none__', { c0: 0, c1: 0, __none__: 1 }, 1), found: noulAnswer(0.02) })
		}]);
		const r = new Ranker({ ...OFFLINE, fetch });
		const out = await r.pick('q', ['alpha', 'beta'], { includeNone: true });

		expect(Object.keys(calls[0].body.questions).sort()).toEqual(['best', 'found']);
		expect(out.index).toBe(-1);
		expect(out.candidate).toBeNull();
		expect(out.found).toBe(false);
		// The "none" pseudo-option must not appear in the ranked list.
		expect(out.ranked.map((x) => x.index)).toEqual([0, 1]);
	});

	test('pick refuses more candidates than a Choice allows', async () => {
		const r = new Ranker({ ...OFFLINE, fetch: fakeFetch([]).fetch });
		await expect(r.pick('q', Array.from({ length: 300 }, (_, i) => `c${i}`)))
			.rejects.toThrow(/at most 255/);
	});

	test('pick refuses an empty shortlist', async () => {
		const r = new Ranker({ ...OFFLINE, fetch: fakeFetch([]).fetch });
		await expect(r.pick('q', [])).rejects.toThrow(JevValidationError);
	});

	test('rank of an empty list is an empty list, with no request', async () => {
		const { fetch, calls } = fakeFetch([]);
		const r = new Ranker({ ...OFFLINE, fetch });
		expect(await r.rank('q', [])).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

// ── Extractor ────────────────────────────────────────────────────────────────

describe('Extractor', () => {
	test('requires fields, and each field requires options', () => {
		expect(() => new Extractor(/** @type {any} */ ({ ...OFFLINE }))).toThrow(/fields/);
		expect(() => new Extractor({ ...OFFLINE, fields: { a: /** @type {any} */ ({ instructions: 'x' }) } }))
			.toThrow(/cannot generate a value/);
	});

	test('builds one Choice per field and copies the winning label verbatim', async () => {
		const { fetch, calls } = fakeFetch([{
			body: systemOneBody({
				currency: choiceAnswer('EUR', { USD: 0, EUR: 1 }, 1),
				status: choiceAnswer('due', { paid: 0, due: 1 }, 1)
			})
		}]);
		const e = new Extractor({
			...OFFLINE, fetch,
			fields: {
				currency: { instructions: 'which currency?', options: ['USD', 'EUR'] },
				status: { instructions: 'status?', options: { paid: 'settled', due: 'not yet' } }
			}
		});
		const r = await e.extract('doc');
		expect(calls[0].body.questions.currency.type).toBe('choice');
		expect(r.record).toEqual({ currency: 'EUR', status: 'due' });
		expect(r.complete).toBe(true);
	});

	test('allowMissing adds a not-stated option and maps it to null', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({ po: choiceAnswer(NOT_STATED, { 'PO-1': 0, [NOT_STATED]: 1 }, 1) }) }]);
		const e = new Extractor({ ...OFFLINE, fetch, allowMissing: true, fields: { po: { instructions: 'po?', options: ['PO-1'] } } });
		const r = await e.extract('doc');
		expect(Object.keys(calls[0].body.questions.po.criteria)).toContain(NOT_STATED);
		expect(r.record.po).toBeNull();
		expect(r.missing).toEqual(['po']);
		expect(r.complete).toBe(false);
	});

	test('a field below its bar comes back null and lands in uncertain', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ terms: choiceAnswer('net_30', { net_15: 0.45, net_30: 0.55 }, 0.1) }) }]);
		const e = new Extractor({ ...OFFLINE, fetch, fields: { terms: { instructions: 't?', options: ['net_15', 'net_30'], minConfidence: 0.7 } } });
		const r = await e.extract('doc');
		expect(r.record.terms).toBeNull();
		expect(r.uncertain).toEqual(['terms']);
		// The model's pick is still visible for a human to review.
		expect(r.fields.terms.choice).toBe('net_30');
	});

	test('transform runs in code, after the verbatim copy', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ month: choiceAnswer('March', { March: 1, April: 0 }, 1) }) }]);
		const e = new Extractor({
			...OFFLINE, fetch,
			fields: { month: { instructions: 'm?', options: ['March', 'April'], transform: (v) => ({ March: 3, April: 4 })[v] } }
		});
		expect((await e.extract('doc')).record.month).toBe(3);
	});

	test('a field that already uses the reserved name throws', () => {
		expect(() => new Extractor({
			...OFFLINE, allowMissing: true,
			fields: { a: { instructions: 'x', options: { [NOT_STATED]: 'mine' } } }
		})).toThrow(/reserves/);
	});
});

// ── Taxonomy ─────────────────────────────────────────────────────────────────

describe('Taxonomy', () => {
	const tree = {
		Sport: { Cycling: { Bottles: null, Helmets: null }, Running: { Shoes: null } },
		Home: { Drinkware: { Bottles: null, Mugs: null } }
	};

	/** Answer whichever level is being asked, favouring the given path. */
	const walker = (prefer) => async (_u, init) => {
		const criteria = JSON.parse(init.body).questions.level.criteria;
		const labels = Object.keys(criteria);
		const winner = labels.find((l) => prefer.includes(l)) ?? labels[0];
		const probabilities = Object.fromEntries(labels.map((l) => [l, l === winner ? 1 : 0]));
		return { body: systemOneBody({ level: choiceAnswer(winner, probabilities, 1) }) };
	};

	test('requires a tree', () => {
		expect(() => new Taxonomy(/** @type {any} */ ({ ...OFFLINE }))).toThrow(/tree/);
	});

	test('walks root to leaf, one request per level', async () => {
		const { fetch, calls } = fakeFetch(walker(['Sport', 'Cycling', 'Bottles']));
		const t = new Taxonomy({ ...OFFLINE, fetch, tree });
		const r = await t.classify('a bike bottle');
		expect(r.path).toEqual(['Sport', 'Cycling', 'Bottles']);
		expect(r.label).toBe('Bottles');
		expect(r.requests).toBe(3);
		expect(calls).toHaveLength(3);
	});

	test('the first level offers the roots, with subtrees as descriptions', async () => {
		const { fetch, calls } = fakeFetch(walker(['Sport', 'Cycling', 'Bottles']));
		const t = new Taxonomy({ ...OFFLINE, fetch, tree });
		await t.classify('x');
		expect(Object.keys(calls[0].body.questions.level.criteria).sort()).toEqual(['Home', 'Sport']);
		// describeDepth 2: one level of children as an object, then names only.
		expect(calls[0].body.questions.level.criteria.Sport).toEqual({
			Cycling: ['Bottles', 'Helmets'],
			Running: ['Shoes']
		});
	});

	test('the path score is the product along the path', async () => {
		const { fetch } = fakeFetch(async (_u, init) => {
			const labels = Object.keys(JSON.parse(init.body).questions.level.criteria);
			const probabilities = Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.5 : 0.5 / (labels.length - 1)]));
			return { body: systemOneBody({ level: choiceAnswer(labels[0], probabilities, 0.5) }) };
		});
		const t = new Taxonomy({ ...OFFLINE, fetch, tree });
		const r = await t.classify('x');
		expect(r.score).toBeCloseTo(0.125, 10); // 0.5 * 0.5 * 0.5
	});

	test('candidates are deduplicated — two beams can converge on one path', async () => {
		const { fetch } = fakeFetch(walker(['Sport', 'Cycling', 'Bottles']));
		const t = new Taxonomy({ ...OFFLINE, fetch, tree });
		const r = await t.classify('x', { beam: 2 });
		const paths = r.candidates.map((c) => c.path.join('>'));
		expect(new Set(paths).size).toBe(paths.length);
	});

	test('beam 2 makes more requests than beam 1 and keeps both branches alive', async () => {
		const spread = async (_u, init) => {
			const labels = Object.keys(JSON.parse(init.body).questions.level.criteria);
			const probabilities = Object.fromEntries(labels.map((l) => [l, 1 / labels.length]));
			return { body: systemOneBody({ level: choiceAnswer(labels[0], probabilities, 0.2) }) };
		};
		const a = fakeFetch(spread);
		const b = fakeFetch(spread);
		await new Taxonomy({ ...OFFLINE, fetch: a.fetch, tree }).classify('x', { beam: 1 });
		const r2 = await new Taxonomy({ ...OFFLINE, fetch: b.fetch, tree }).classify('x', { beam: 2 });
		expect(b.calls.length).toBeGreaterThan(a.calls.length);
		expect(r2.candidates.length).toBeGreaterThan(1);
	});

	test('minScore prunes low-probability branches', async () => {
		const { fetch } = fakeFetch(walker(['Sport', 'Cycling', 'Bottles']));
		const t = new Taxonomy({ ...OFFLINE, fetch, tree });
		const r = await t.classify('x', { beam: 3, minScore: 0.5 });
		expect(r.candidates).toHaveLength(1);
	});

	test('steps record the full distribution at every level', async () => {
		const { fetch } = fakeFetch(walker(['Sport', 'Cycling', 'Bottles']));
		const t = new Taxonomy({ ...OFFLINE, fetch, tree });
		const r = await t.classify('x');
		expect(r.steps).toHaveLength(3);
		expect(r.steps[0].label).toBe('Sport');
		expect(r.steps[1].parent).toBe('Sport');
		expect(r.steps[0].ranked.length).toBe(2);
	});
});

// ── Guard ────────────────────────────────────────────────────────────────────

describe('Guard', () => {
	const hazards = {
		injection: { instructions: 'injection?', action: 'block', threshold: 0.7 },
		pii: { instructions: 'pii?', action: 'review', threshold: 0.5 },
		noise: { instructions: 'noise?', action: 'allow', threshold: 0.5 }
	};

	test('requires hazards, and rejects an unknown action', () => {
		expect(() => new Guard(/** @type {any} */ ({ ...OFFLINE }))).toThrow(/hazards/);
		expect(() => new Guard({ ...OFFLINE, hazards: { a: { instructions: 'x', action: /** @type {any} */ ('nuke') } } }))
			.toThrow(/Valid actions/);
	});

	test('allow when nothing fires', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ injection: noulAnswer(0.01), pii: noulAnswer(0.02), noise: noulAnswer(0.9) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards });
		const v = await g.inspect('hello');
		expect(v.action).toBe('allow');
		expect(v.allowed).toBe(true);
		expect(v.triggered).toEqual([]);
	});

	test('the strictest triggered action wins', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ injection: noulAnswer(0.99), pii: noulAnswer(0.99), noise: noulAnswer(0) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards });
		const v = await g.inspect('x');
		expect(v.action).toBe('block');
		expect(v.blocked).toBe(true);
		expect(v.triggered.map((t) => t.id)).toEqual(['injection', 'pii']);
	});

	test('review alone stays review', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ injection: noulAnswer(0.1), pii: noulAnswer(0.99), noise: noulAnswer(0) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards });
		const v = await g.inspect('x');
		expect(v.action).toBe('review');
		expect(v.review).toBe(true);
	});

	test("an 'allow' hazard never escalates, however high it scores", async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ injection: noulAnswer(0), pii: noulAnswer(0), noise: noulAnswer(1) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards });
		const v = await g.inspect('x');
		expect(v.action).toBe('allow');
		// It is still reported, so the number is not lost.
		expect(v.probabilities.noise).toBe(1);
		expect(v.max).toBe(1);
	});

	test('reviewThreshold downgrades a would-be block', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ injection: noulAnswer(0.5) }) }]);
		const g = new Guard({
			...OFFLINE, fetch,
			hazards: { injection: { instructions: 'x', action: 'block', threshold: 0.9, reviewThreshold: 0.4 } }
		});
		expect((await g.inspect('x')).action).toBe('review');
	});

	test('assert throws on block and returns on review', async () => {
		const blockBody = systemOneBody({ injection: noulAnswer(0.99), pii: noulAnswer(0), noise: noulAnswer(0) });
		const reviewBody = systemOneBody({ injection: noulAnswer(0), pii: noulAnswer(0.99), noise: noulAnswer(0) });

		const g1 = new Guard({ ...OFFLINE, fetch: fakeFetch([{ body: blockBody }]).fetch, hazards });
		await expect(g1.assert('x')).rejects.toThrow(JevGuardError);

		const g2 = new Guard({ ...OFFLINE, fetch: fakeFetch([{ body: reviewBody }]).fetch, hazards });
		await expect(g2.assert('x')).resolves.toMatchObject({ action: 'review' });
	});

	test('the thrown error carries the verdict and the reasons', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ injection: noulAnswer(0.99), pii: noulAnswer(0), noise: noulAnswer(0) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards });
		try {
			await g.assert('x');
			throw new Error('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(JevGuardError);
			expect(err.reasons[0]).toMatch(/^injection \(0\.99\)$/);
			expect(err.verdict.action).toBe('block');
		}
	});

	test('a string hazard defaults to block at 0.5', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ a: noulAnswer(0.6) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards: { a: 'is it bad?' } });
		expect((await g.inspect('x')).action).toBe('block');
	});

	test('wrap checks input and output around the wrapped function', async () => {
		const { fetch, calls } = fakeFetch([{ body: systemOneBody({ a: noulAnswer(0.01) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards: { a: 'bad?' } });
		const safe = g.wrap(async (input) => `echo:${input}`);
		expect(await safe('hello')).toBe('echo:hello');
		expect(calls).toHaveLength(2); // input, then output
	});

	test('wrap blocks the input before the function runs', async () => {
		let ran = false;
		const { fetch } = fakeFetch([{ body: systemOneBody({ a: noulAnswer(0.99) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards: { a: 'bad?' } });
		const safe = g.wrap(async () => { ran = true; return 'x'; });
		await expect(safe('evil')).rejects.toThrow(/Input blocked/);
		expect(ran).toBe(false);
	});

	test('onBlock replaces the throw', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ a: noulAnswer(0.99) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards: { a: 'bad?' } });
		const safe = g.wrap(async () => 'x', { onBlock: (v, phase) => `refused at ${phase}` });
		expect(await safe('evil')).toBe('refused at input');
	});
});

// ── regressions from the 0.1.0 code review ───────────────────────────────────

describe('review regressions', () => {
	/** A response that omits one of the answers the class asked for. */
	const partial = (answers) => systemOneBody(answers);

	test('Scorer refuses a composite when a dimension came back unanswered', async () => {
		// Before the fix this returned composite 0.5 as if both dimensions had
		// answered. A quietly halved score is worse than a loud stop.
		const { fetch } = fakeFetch([{ body: partial({ a: scoreAnswer(2, ['x', 'y', 'z'], { 0: 0, 1: 0, 2: 1 }, 1) }) }]);
		const s = new Scorer({
			...OFFLINE, fetch,
			dimensions: {
				a: { weight: 0.5, instructions: 'a', levels: ['x', 'y', 'z'] },
				b: { weight: 0.5, instructions: 'b', levels: ['x', 'y', 'z'] }
			}
		});
		await expect(s.score('t')).rejects.toThrow(/no answer for "b"/);
	});

	test('Detector refuses when a condition came back unanswered', async () => {
		// A dropped condition would read as "not triggered" — the unsafe direction.
		const { fetch } = fakeFetch([{ body: partial({ a: noulAnswer(0.9) }) }]);
		const d = new Detector({ ...OFFLINE, fetch, conditions: { a: 'a?', b: 'b?' } });
		await expect(d.check('t')).rejects.toThrow(/no answer for "b"/);
	});

	test('Guard refuses when a hazard came back unanswered', async () => {
		// Same, and worse: a missing hazard silently reads as "did not fire".
		const { fetch } = fakeFetch([{ body: partial({ injection: noulAnswer(0.1) }) }]);
		const g = new Guard({ ...OFFLINE, fetch, hazards: { injection: 'a?', secrets: 'b?' } });
		await expect(g.inspect('t')).rejects.toThrow(/no answer for "secrets"/);
	});

	test('Extractor refuses when a field came back unanswered', async () => {
		// A dropped field is indistinguishable from one the document did not state.
		const { fetch } = fakeFetch([{ body: partial({ a: choiceAnswer('X', { X: 1 }, 1) }) }]);
		const e = new Extractor({
			...OFFLINE, fetch,
			fields: { a: { instructions: 'a', options: ['X'] }, b: { instructions: 'b', options: ['Y'] } }
		});
		await expect(e.extract('t')).rejects.toThrow(/no answer for "b"/);
	});

	test('Ranker refuses when a candidate came back unanswered', async () => {
		const { fetch } = fakeFetch([{ body: partial({ c0: noulAnswer(0.5) }) }]);
		const r = new Ranker({ ...OFFLINE, fetch });
		await expect(r.rank('q', ['a', 'b'])).rejects.toThrow(/no answer for "c1"/);
	});

	test('Classifier and Router give a named error, not a TypeError', async () => {
		const { fetch: f1 } = fakeFetch([{ body: partial({ wrong_id: choiceAnswer('a', { a: 1 }, 1) }) }]);
		const c = new Classifier({ ...OFFLINE, fetch: f1, labels: ['a', 'b'] });
		await expect(c.classify('t')).rejects.toThrow(/no answer for "label"/);

		const { fetch: f2 } = fakeFetch([{ body: partial({ wrong_id: choiceAnswer('a', { a: 1 }, 1) }) }]);
		const r = new Router({ ...OFFLINE, fetch: f2, routes: { a: 'A', b: 'B' } });
		await expect(r.route('t')).rejects.toThrow(/no answer for "route"/);
	});

	test('the error names the collision as a likely cause', async () => {
		// The realistic way to hit this: opts.questions reusing a class's own id.
		const { fetch } = fakeFetch([{ body: partial({ a: noulAnswer(0.9) }) }]);
		const d = new Detector({ ...OFFLINE, fetch, conditions: { a: 'a?', b: 'b?' } });
		await expect(d.check('t')).rejects.toThrow(/collided/);
	});

	test('Extractor names the field when a transform throws', async () => {
		// Before the fix this surfaced as a bare "boom" with no context.
		const { fetch } = fakeFetch([{ body: systemOneBody({ month: choiceAnswer('Smarch', { Smarch: 1 }, 1) }) }]);
		const e = new Extractor({
			...OFFLINE, fetch,
			fields: { month: { instructions: 'm', options: ['Smarch'], transform: () => { throw new Error('boom'); } } }
		});
		await expect(e.extract('t')).rejects.toThrow(/transform for field "month" threw on the value "Smarch"/);
	});

	test('Ranker builds each candidate question once, not twice', async () => {
		// _batch built a question to size it, then rank() rebuilt it to send it.
		// Doubled JSON work on every candidate in a 1,200-candidate re-rank.
		const { fetch } = fakeFetch(async (_u, init) => {
			const ids = Object.keys(JSON.parse(init.body).questions);
			return { body: systemOneBody(Object.fromEntries(ids.map((id) => [id, noulAnswer(0.5)]))) };
		});
		const r = new Ranker({ ...OFFLINE, fetch });
		let built = 0;
		const orig = r._questionFor.bind(r);
		r._questionFor = (t) => { built++; return orig(t); };
		await r.rank('q', ['a', 'b', 'c', 'd']);
		expect(built).toBe(4);
	});

	test('Taxonomy reports a walk truncated by maxDepth', async () => {
		let deep = null;
		for (let i = 0; i < 5; i++) deep = deep ? { ['L' + i]: deep } : { leaf: null };
		const walk = () => fakeFetch(async (_u, init) => {
			const labels = Object.keys(JSON.parse(init.body).questions.level.criteria);
			return {
				body: systemOneBody({
					level: choiceAnswer(labels[0], Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 1 : 0])), 1)
				})
			};
		});

		const shallow = await new Taxonomy({ ...OFFLINE, fetch: walk().fetch, tree: deep }).classify('x', { maxDepth: 2 });
		expect(shallow.truncated).toBe(true);
		expect(shallow.path).toHaveLength(2);

		const full = await new Taxonomy({ ...OFFLINE, fetch: walk().fetch, tree: deep }).classify('x', { maxDepth: 10 });
		expect(full.truncated).toBe(false);
	});
});
