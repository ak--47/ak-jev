/**
 * Answer enrichment. Raw API fields must survive untouched; derived fields must
 * be right, because the whole point of computing them once is that nobody
 * re-checks the arithmetic.
 */

import { describe, test, expect } from '@jest/globals';
import { enrichAnswer, enrichAnswers, rank, normalizedEntropy, DEFAULT_THRESHOLDS } from '../../answers.js';

describe('noul enrichment', () => {
	const raw = { type: 'noul', noul: 0.96 };

	test('keeps the raw value and adds an id', () => {
		const a = enrichAnswer('urgent', raw);
		expect(a.noul).toBe(0.96);
		expect(a.id).toBe('urgent');
		expect(a.type).toBe('noul');
	});

	test('yes thresholds at 0.5 by default', () => {
		expect(enrichAnswer('a', { type: 'noul', noul: 0.51 }).yes).toBe(true);
		expect(enrichAnswer('a', { type: 'noul', noul: 0.49 }).yes).toBe(false);
		expect(enrichAnswer('a', { type: 'noul', noul: 0.5 }).yes).toBe(true);
	});

	test('verdict is three-way across the 0.2 / 0.8 band', () => {
		expect(enrichAnswer('a', { type: 'noul', noul: 0.95 }).verdict).toBe('yes');
		expect(enrichAnswer('a', { type: 'noul', noul: 0.05 }).verdict).toBe('no');
		expect(enrichAnswer('a', { type: 'noul', noul: 0.4 }).verdict).toBe('unsure');
		expect(enrichAnswer('a', { type: 'noul', noul: 0.8 }).verdict).toBe('yes');
		expect(enrichAnswer('a', { type: 'noul', noul: 0.2 }).verdict).toBe('no');
	});

	test('custom thresholds are honoured and echoed back', () => {
		const a = enrichAnswer('a', { type: 'noul', noul: 0.6 }, { thresholds: { yes: 0.7, high: 0.9, low: 0.1 } });
		expect(a.yes).toBe(false);
		expect(a.verdict).toBe('unsure');
		expect(a.thresholds).toEqual({ yes: 0.7, high: 0.9, low: 0.1 });
	});

	test('derived confidence is |p - 0.5| * 2', () => {
		expect(enrichAnswer('a', { type: 'noul', noul: 0.5 }).confidence).toBe(0);
		expect(enrichAnswer('a', { type: 'noul', noul: 1 }).confidence).toBe(1);
		expect(enrichAnswer('a', { type: 'noul', noul: 0 }).confidence).toBe(1);
		expect(enrichAnswer('a', { type: 'noul', noul: 0.75 }).confidence).toBeCloseTo(0.5, 10);
	});
});

describe('choice enrichment', () => {
	const raw = {
		type: 'choice',
		choice: 'billing',
		confidence: 0.42,
		probabilities: { shipping: 0.04, billing: 0.61, returns: 0.35 }
	};

	test('keeps every raw field', () => {
		const a = enrichAnswer('dept', raw);
		expect(a.choice).toBe('billing');
		expect(a.confidence).toBe(0.42);
		expect(a.probabilities).toEqual(raw.probabilities);
	});

	test('ranked is descending', () => {
		expect(enrichAnswer('d', raw).ranked).toEqual([
			{ label: 'billing', probability: 0.61 },
			{ label: 'returns', probability: 0.35 },
			{ label: 'shipping', probability: 0.04 }
		]);
	});

	test('runnerUp and margin', () => {
		const a = enrichAnswer('d', raw);
		expect(a.runnerUp).toEqual({ label: 'returns', probability: 0.35 });
		expect(a.margin).toBeCloseTo(0.26, 10);
	});

	test('a single option has no runner-up and a full margin', () => {
		const a = enrichAnswer('d', { type: 'choice', choice: 'only', confidence: 1, probabilities: { only: 1 } });
		expect(a.runnerUp).toBeNull();
		expect(a.margin).toBe(1);
		expect(a.entropy).toBe(0);
	});

	test('ties break on label, so ranked is stable across calls', () => {
		const tied = { type: 'choice', choice: 'b', confidence: 0, probabilities: { b: 0.5, a: 0.5 } };
		expect(enrichAnswer('d', tied).ranked.map((r) => r.label)).toEqual(['a', 'b']);
	});
});

describe('score enrichment', () => {
	const raw = {
		type: 'score',
		score: 1.43,
		confidence: 0.35,
		legend: { 0: 'Cosmetic', 1: 'Workaround exists', 2: 'Blocking' },
		probabilities: { 0: 0, 1: 0.57, 2: 0.43 }
	};

	test('normalized divides by levels - 1', () => {
		expect(enrichAnswer('s', raw).normalized).toBeCloseTo(1.43 / 2, 10);
	});

	test('a 4-level rubric normalizes by 3, not 2', () => {
		const four = {
			type: 'score',
			score: 3,
			confidence: 1,
			legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' },
			probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 }
		};
		expect(enrichAnswer('s', four).normalized).toBe(1);
		expect(enrichAnswer('s', four).levels).toBe(4);
	});

	test('level rounds to the nearest and label reads the legend', () => {
		const a = enrichAnswer('s', raw);
		expect(a.level).toBe(1);
		expect(a.label).toBe('Workaround exists');
	});

	test('level names from score()\'s object form win over the legend', () => {
		const a = enrichAnswer('s', raw, { levelNames: ['cosmetic', 'workaround', 'blocking'] });
		expect(a.label).toBe('workaround');
	});

	test('a one-level rubric normalizes to 0 rather than dividing by zero', () => {
		const one = { type: 'score', score: 0, confidence: 1, legend: { 0: 'only' }, probabilities: { 0: 1 } };
		expect(enrichAnswer('s', one).normalized).toBe(0);
		expect(Number.isFinite(enrichAnswer('s', one).normalized)).toBe(true);
	});

	test('a structured legend entry comes back whole', () => {
		const structured = {
			type: 'score',
			score: 1,
			confidence: 1,
			legend: { 0: { what: 'a' }, 1: { what: 'b', examples: ['x'] } },
			probabilities: { 0: 0, 1: 1 }
		};
		expect(enrichAnswer('s', structured).label).toEqual({ what: 'b', examples: ['x'] });
	});
});

describe('normalizedEntropy', () => {
	test('0 when all probability sits on one outcome', () => {
		expect(normalizedEntropy([1, 0, 0])).toBe(0);
	});

	test('1 when the distribution is flat', () => {
		expect(normalizedEntropy([0.5, 0.5])).toBeCloseTo(1, 10);
		expect(normalizedEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(1, 10);
	});

	test('a zero-probability option still counts as an outcome', () => {
		// Adding an option the model gave no weight to should lower entropy,
		// because the distribution is now peaked across a wider space.
		expect(normalizedEntropy([0.5, 0.5, 0])).toBeLessThan(normalizedEntropy([0.5, 0.5]));
	});

	test('0 for degenerate input rather than NaN', () => {
		expect(normalizedEntropy([])).toBe(0);
		expect(normalizedEntropy([1])).toBe(0);
		expect(normalizedEntropy([0, 0])).toBe(0);
	});
});

describe('rank', () => {
	test('sorts descending and coerces bad values to 0', () => {
		expect(rank({ a: 0.1, b: /** @type {any} */ ('x'), c: 0.9 })).toEqual([
			{ label: 'c', probability: 0.9 },
			{ label: 'a', probability: 0.1 },
			{ label: 'b', probability: 0 }
		]);
	});
});

describe('enrichAnswers', () => {
	test('enriches every entry and passes meta through per id', () => {
		const out = enrichAnswers(
			{
				a: { type: 'noul', noul: 0.9 },
				b: { type: 'score', score: 1, confidence: 1, legend: { 0: 'x', 1: 'y' }, probabilities: { 0: 0, 1: 1 } }
			},
			{ meta: { b: { levelNames: ['low', 'high'] } } }
		);
		expect(out.a.yes).toBe(true);
		expect(out.b.label).toBe('high');
	});

	test('an unknown answer type passes through with an id rather than being dropped', () => {
		const out = enrichAnswer('x', { type: 'future_primitive', value: 7 });
		expect(out).toEqual({ id: 'x', type: 'future_primitive', value: 7 });
	});
});

test('DEFAULT_THRESHOLDS is frozen', () => {
	expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
	expect(DEFAULT_THRESHOLDS).toEqual({ yes: 0.5, high: 0.8, low: 0.2 });
});
