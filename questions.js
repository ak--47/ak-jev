/**
 * @fileoverview Question builders, shorthand expansion, and pre-flight validation.
 *
 * Jev has exactly three question types. These builders produce them, accept a few
 * shapes the official SDK rejects, and check every limit that the API enforces
 * with a 400 so you find out locally instead of a round trip later.
 *
 * Everything the builders add beyond `{type, instructions, criteria}` is carried
 * on a symbol key, so it can never leak onto the wire.
 */

import { JevValidationError } from './errors.js';
import { resolveLimits } from './models.js';

/** Client-side metadata. Symbol-keyed, so `JSON.stringify` ignores it. */
export const QUESTION_META = Symbol('ak-jev.question.meta');

/** The three question types. */
export const QUESTION_TYPES = Object.freeze(['noul', 'choice', 'score']);

/**
 * A yes/no question. The answer is the probability that the answer is yes.
 *
 * Phrase it so that a high value means yes. "Does the message contain personal
 * data?" reads correctly later; "Is the message free of personal data?" inverts
 * the meaning and the code that reads it will get it backwards.
 *
 * @param {any} instructions the question, as a string, object or array
 * @param {{true?: any, false?: any}} [criteria] optional descriptions of each outcome
 * @returns {JevNoulQuestion}
 *
 * @example
 * noul('Is the customer asking for a human agent?')
 * noul('Has the customer contacted support before?', {
 *   true: 'Mentions a prior attempt, ticket, or that they have asked before',
 *   false: 'No sign of any previous contact'
 * })
 */
export function noul(instructions, criteria) {
	if (instructions === undefined && criteria === undefined) {
		throw new JevValidationError(
			'noul() needs instructions, criteria, or both. The API rejects a Noul with neither.'
		);
	}
	/** @type {any} */
	const q = { type: 'noul' };
	if (instructions !== undefined) q.instructions = instructions;
	if (criteria !== undefined) q.criteria = criteria;
	return q;
}

/**
 * Pick one option from a fixed set. The answer carries the winning label, a
 * probability for every option, and a confidence.
 *
 * Two shapes are accepted for `criteria`:
 * - a map of `label -> description`, with `null` where the label speaks for itself
 * - a plain array of labels, expanded to `{label: null, ...}`
 *
 * The array form is the one the official builder throws on. It is the right
 * shorthand when your options are already a list.
 *
 * @param {any} instructions
 * @param {Object.<string, any>|string[]} criteria
 * @returns {JevChoiceQuestion}
 *
 * @example
 * choice('Which team should handle this?', {
 *   billing: 'Payments, invoicing, refunds',
 *   technical: 'Bugs, outages, integrations'
 * })
 * choice('What is the tone?', ['calm', 'frustrated', 'angry'])
 */
export function choice(instructions, criteria) {
	const expanded = expandChoiceCriteria(criteria);
	return { type: 'choice', instructions, criteria: expanded };
}

/**
 * Rate the state along ordered levels. The answer is a position on those levels
 * and can fall between two of them.
 *
 * Two shapes are accepted for `criteria`:
 * - an ordered array of level descriptions, level 0 first
 * - an ordered object of `name -> description`; the names stay client-side and
 *   come back as `answer.label`
 *
 * The object form exists because almost every caller wants a name for the level
 * a score landed on, and computing it from `legend` by hand is tedious.
 *
 * Levels are judged independently. Describe situations, not degrees: the model
 * never sees a level's number or its neighbours, so "worse than the last one"
 * means nothing to it.
 *
 * @param {any} instructions
 * @param {any[]|Object.<string, any>} criteria
 * @returns {JevScoreQuestion}
 *
 * @example
 * score('How severe is this bug?', [
 *   'Cosmetic; no impact to functionality',
 *   'Broken or degraded feature, but workaround exists',
 *   'Blocking issue; no workaround exists'
 * ])
 * score('How frustrated is the customer?', {
 *   calm: 'Calm, just stating facts',
 *   frustrated: 'Frustrated but civil',
 *   furious: 'Very angry, strong language or threatening to leave'
 * })
 */
export function score(instructions, criteria) {
	const { levels, names } = expandScoreCriteria(criteria);
	/** @type {any} */
	const q = { type: 'score', instructions, criteria: levels };
	if (names) q[QUESTION_META] = { levelNames: names };
	return q;
}

/**
 * @typedef {{type: 'noul', instructions?: any, criteria?: {true?: any, false?: any}}} JevNoulQuestion
 * @typedef {{type: 'choice', instructions?: any, criteria: Object.<string, any>}} JevChoiceQuestion
 * @typedef {{type: 'score', instructions?: any, criteria: any[]}} JevScoreQuestion
 * @typedef {JevNoulQuestion|JevChoiceQuestion|JevScoreQuestion} JevQuestion
 */

/**
 * Turn a Choice `criteria` of either accepted shape into the wire shape.
 * @param {any} criteria
 * @returns {Object.<string, any>}
 */
function expandChoiceCriteria(criteria) {
	if (Array.isArray(criteria)) {
		/** @type {Object.<string, any>} */
		const out = {};
		for (const label of criteria) {
			if (typeof label !== 'string') {
				throw new JevValidationError(
					'choice() was given an array, so every entry must be a label string. ' +
						`Got ${typeof label}. To describe options, pass a { label: description } map instead.`
				);
			}
			out[label] = null;
		}
		return out;
	}
	if (criteria && typeof criteria === 'object') return { ...criteria };
	throw new JevValidationError(
		'choice() needs criteria: either a { label: description } map or an array of label strings.'
	);
}

/**
 * Turn a Score `criteria` of either accepted shape into levels plus optional names.
 * @param {any} criteria
 * @returns {{levels: any[], names: string[]|null}}
 */
function expandScoreCriteria(criteria) {
	if (Array.isArray(criteria)) return { levels: [...criteria], names: null };
	if (criteria && typeof criteria === 'object') {
		// Insertion order is the level order. That is the whole contract of the
		// object form, and it is stated in the JSDoc above and in the README.
		const names = Object.keys(criteria);
		return { levels: names.map((k) => criteria[k]), names };
	}
	throw new JevValidationError(
		'score() needs criteria: either an ordered array of level descriptions, ' +
			'or an ordered { name: description } object.'
	);
}

/**
 * Expand shorthand into full questions.
 *
 * A bare string is the most common question anyone writes, so it expands to a
 * Noul: `{ urgent: 'Is this urgent?' }` is `{ urgent: noul('Is this urgent?') }`.
 * Anything else must already be a question object.
 *
 * @param {Object.<string, any>} questions
 * @returns {Object.<string, JevQuestion>}
 */
export function expandQuestions(questions) {
	if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
		throw new JevValidationError(
			'questions must be an object keyed by the ids you want the answers under.'
		);
	}
	/** @type {Object.<string, any>} */
	const out = {};
	for (const [id, q] of Object.entries(questions)) {
		if (typeof q === 'string') {
			out[id] = noul(q);
			continue;
		}
		if (!q || typeof q !== 'object' || Array.isArray(q)) {
			throw new JevValidationError(
				`Question "${id}" must be a question object or a string. ` +
					'Use noul(), choice() or score() to build one.',
				{ questionId: id }
			);
		}
		out[id] = q;
	}
	return out;
}

/**
 * Strip a question set down to exactly what the API accepts.
 * Client-side metadata lives on a symbol key and is dropped here by construction.
 *
 * @param {Object.<string, JevQuestion>} questions
 * @returns {Object.<string, {type: string, instructions?: any, criteria?: any}>}
 */
export function toWireQuestions(questions) {
	/** @type {Object.<string, any>} */
	const out = {};
	for (const [id, q] of Object.entries(questions)) {
		/** @type {any} */
		const wire = { type: q.type };
		if (q.instructions !== undefined) wire.instructions = q.instructions;
		if (/** @type {any} */ (q).criteria !== undefined) wire.criteria = /** @type {any} */ (q).criteria;
		out[id] = wire;
	}
	return out;
}

/**
 * Read the client-side metadata a builder attached, if any.
 * @param {any} question
 * @returns {{levelNames?: string[]}}
 */
export function questionMeta(question) {
	return question?.[QUESTION_META] ?? {};
}

/**
 * Check a question set against every limit the API enforces with a 400.
 *
 * Throws on anything the API would reject. Returns warnings for shapes the API
 * accepts but that will not do what you want — a one-level Score being the only
 * current example.
 *
 * @param {Object.<string, JevQuestion>} questions
 * @param {Object} [opts={}]
 * @param {string} [opts.model]
 * @returns {{warnings: string[]}}
 */
export function validateQuestions(questions, opts = {}) {
	const limits = resolveLimits(opts.model);
	const ids = Object.keys(questions ?? {});

	if (ids.length === 0) {
		throw new JevValidationError(
			'At least one question is required. The API returns 422 for an empty questions map.'
		);
	}

	/** @type {string[]} */
	const warnings = [];

	for (const id of ids) {
		const q = /** @type {any} */ (questions[id]);

		if (!QUESTION_TYPES.includes(q?.type)) {
			throw new JevValidationError(
				`Question "${id}" has type ${JSON.stringify(q?.type)}. ` +
					`Expected one of: ${QUESTION_TYPES.join(', ')}.`,
				{ questionId: id }
			);
		}

		if (q.type === 'noul') {
			const hasInstructions = q.instructions !== undefined && q.instructions !== null;
			const hasCriteria = q.criteria !== undefined && q.criteria !== null;
			if (!hasInstructions && !hasCriteria) {
				throw new JevValidationError(
					`Noul question "${id}" has neither instructions nor criteria. ` +
						'The API rejects it with 400.',
					{ questionId: id }
				);
			}
			if (hasCriteria && (typeof q.criteria !== 'object' || Array.isArray(q.criteria))) {
				throw new JevValidationError(
					`Noul question "${id}" has criteria that are not an object. ` +
						'Noul criteria are { true: ..., false: ... }.',
					{ questionId: id }
				);
			}
			continue;
		}

		if (q.type === 'choice') {
			if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
				throw new JevValidationError(
					`Choice question "${id}" needs criteria as a { label: description } map. ` +
						'Pass an array of labels to choice() if you want them expanded for you.',
					{ questionId: id }
				);
			}
			const n = Object.keys(q.criteria).length;
			if (n < limits.minChoiceOptions) {
				throw new JevValidationError(
					`Choice question "${id}" has no options. The API rejects it with 400.`,
					{ questionId: id }
				);
			}
			if (n > limits.maxChoiceOptions) {
				throw new JevValidationError(
					`Choice question "${id}" has ${n} options; the API allows at most ` +
						`${limits.maxChoiceOptions}. Split the options across a two-level ` +
						'Taxonomy walk, or group the tail under an "other" option.',
					{ questionId: id }
				);
			}
			continue;
		}

		// score
		if (!Array.isArray(q.criteria)) {
			throw new JevValidationError(
				`Score question "${id}" needs criteria as an ordered array of level descriptions, ` +
					'lowest level first. Pass an ordered object to score() to name the levels.',
				{ questionId: id }
			);
		}
		if (q.criteria.length < limits.minScoreLevels) {
			throw new JevValidationError(
				`Score question "${id}" has no levels.`,
				{ questionId: id }
			);
		}
		if (q.criteria.length > limits.maxScoreLevels) {
			throw new JevValidationError(
				`Score question "${id}" has ${q.criteria.length} levels; the API allows at most ` +
					`${limits.maxScoreLevels}.`,
				{ questionId: id }
			);
		}
		if (q.criteria.length < 2) {
			warnings.push(
				`Score question "${id}" has one level. The API accepts this and always returns ` +
					'score 0.0 at confidence 1.0, which tells you nothing. Add levels, or use a Noul.'
			);
		}
	}

	return { warnings };
}
