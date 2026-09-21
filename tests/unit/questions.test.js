/**
 * Builders, shorthand, and the limit checks.
 *
 * Every limit asserted here was measured against the live API on 2026-09-21 and
 * is a 400 if it reaches the wire. The point of checking locally is that a 400
 * on `Too many choices` costs a round trip and tells you nothing about which
 * question caused it.
 */

import { describe, test, expect } from '@jest/globals';
import {
	noul,
	choice,
	score,
	expandQuestions,
	toWireQuestions,
	validateQuestions,
	questionMeta,
	QUESTION_META
} from '../../questions.js';
import { JevValidationError } from '../../errors.js';

describe('noul()', () => {
	test('builds the wire shape', () => {
		expect(noul('Is this urgent?')).toEqual({ type: 'noul', instructions: 'Is this urgent?' });
	});

	test('carries criteria when given', () => {
		const q = noul('Repeat contact?', { true: 'Mentions a prior ticket', false: 'No sign of one' });
		expect(q.criteria).toEqual({ true: 'Mentions a prior ticket', false: 'No sign of one' });
	});

	test('accepts structured instructions', () => {
		const q = noul({ potential_duplicate: { name: 'J. Smith' }, question: 'Same person?' });
		expect(q.instructions).toEqual({ potential_duplicate: { name: 'J. Smith' }, question: 'Same person?' });
	});

	test('throws when given neither instructions nor criteria', () => {
		// The API rejects this with 400; there is no reason to let it travel.
		expect(() => noul()).toThrow(JevValidationError);
	});
});

describe('choice()', () => {
	test('keeps a description map as-is', () => {
		const q = choice('Who?', { billing: 'money', tech: 'bugs' });
		expect(q.criteria).toEqual({ billing: 'money', tech: 'bugs' });
	});

	test('expands an array of labels — the official builder throws on this', () => {
		const q = choice('Tone?', ['calm', 'frustrated', 'angry']);
		expect(q.criteria).toEqual({ calm: null, frustrated: null, angry: null });
	});

	test('rejects an array of non-strings with a message that names the fix', () => {
		expect(() => choice('x', [/** @type {any} */ ({ a: 1 })])).toThrow(/label string/);
	});

	test('rejects missing criteria', () => {
		expect(() => choice('x', /** @type {any} */ (undefined))).toThrow(JevValidationError);
	});
});

describe('score()', () => {
	test('keeps an array of levels as-is', () => {
		const q = score('How bad?', ['Fine', 'Bad', 'Awful']);
		expect(q.criteria).toEqual(['Fine', 'Bad', 'Awful']);
		expect(questionMeta(q).levelNames).toBeUndefined();
	});

	test('an ordered object becomes levels plus client-side names', () => {
		const q = score('How bad?', { fine: 'All good', bad: 'Degraded', awful: 'On fire' });
		expect(q.criteria).toEqual(['All good', 'Degraded', 'On fire']);
		expect(questionMeta(q).levelNames).toEqual(['fine', 'bad', 'awful']);
	});

	test('level names are symbol-keyed, so they cannot reach the wire', () => {
		const q = score('x', { a: 'A', b: 'B' });
		expect(JSON.parse(JSON.stringify(q))).toEqual({ type: 'score', instructions: 'x', criteria: ['A', 'B'] });
		expect(Object.keys(q)).not.toContain('levelNames');
		expect(q[QUESTION_META]).toBeDefined();
	});

	test('rejects a non-array, non-object criteria', () => {
		expect(() => score('x', /** @type {any} */ ('a,b,c'))).toThrow(JevValidationError);
	});
});

describe('expandQuestions()', () => {
	test('a bare string becomes a Noul', () => {
		expect(expandQuestions({ urgent: 'Is this urgent?' })).toEqual({
			urgent: { type: 'noul', instructions: 'Is this urgent?' }
		});
	});

	test('question objects pass through untouched', () => {
		const q = { type: 'noul', instructions: 'x' };
		expect(expandQuestions({ a: q }).a).toBe(q);
	});

	test('rejects a non-object question with the id in the message', () => {
		expect(() => expandQuestions({ bad: /** @type {any} */ (42) })).toThrow(/"bad"/);
	});

	test('rejects a non-object questions map', () => {
		expect(() => expandQuestions(/** @type {any} */ ([]))).toThrow(JevValidationError);
	});
});

describe('toWireQuestions()', () => {
	test('emits only type, instructions and criteria', () => {
		const wire = toWireQuestions({
			a: score('x', { lo: 'Low', hi: 'High' }),
			b: noul('y')
		});
		expect(wire).toEqual({
			a: { type: 'score', instructions: 'x', criteria: ['Low', 'High'] },
			b: { type: 'noul', instructions: 'y' }
		});
	});
});

describe('validateQuestions() — limits measured live 2026-09-21', () => {
	test('an empty map throws (the API returns 422)', () => {
		expect(() => validateQuestions({})).toThrow(/At least one question/);
	});

	test('an unknown type throws', () => {
		expect(() => validateQuestions({ a: /** @type {any} */ ({ type: 'vibe' }) })).toThrow(/Expected one of/);
	});

	test('255 choice options pass, 256 throw', () => {
		const mk = (n) => choice('x', Array.from({ length: n }, (_, i) => `o${i}`));
		expect(() => validateQuestions({ a: mk(255) })).not.toThrow();
		expect(() => validateQuestions({ a: mk(256) })).toThrow(/at most 255/);
	});

	test('an empty choice throws', () => {
		expect(() => validateQuestions({ a: { type: 'choice', criteria: {} } })).toThrow(/no options/);
	});

	test('10 score levels pass, 11 throw', () => {
		const mk = (n) => score('x', Array.from({ length: n }, (_, i) => `l${i}`));
		expect(() => validateQuestions({ a: mk(10) })).not.toThrow();
		expect(() => validateQuestions({ a: mk(11) })).toThrow(/at most 10/);
	});

	test('a one-level score warns rather than throws — the API accepts it', () => {
		const { warnings } = validateQuestions({ a: score('x', ['only']) });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/one level/);
	});

	test('a noul with neither instructions nor criteria throws', () => {
		expect(() => validateQuestions({ a: { type: 'noul' } })).toThrow(/neither instructions nor criteria/);
	});

	test('a noul with only criteria is fine', () => {
		expect(() => validateQuestions({ a: { type: 'noul', criteria: { true: 'y', false: 'n' } } })).not.toThrow();
	});

	test('score criteria given as a map throws and names the fix', () => {
		expect(() => validateQuestions({ a: /** @type {any} */ ({ type: 'score', criteria: { a: 1 } }) }))
			.toThrow(/ordered array/);
	});

	test('the error names the offending question id', () => {
		try {
			validateQuestions({ my_question: /** @type {any} */ ({ type: 'choice', criteria: {} }) });
			throw new Error('should have thrown');
		} catch (err) {
			expect(err.questionId).toBe('my_question');
			expect(err.message).toContain('my_question');
		}
	});
});
