/**
 * @fileoverview Scorer — the Composite Scoring pattern, with the arithmetic done for you.
 *
 * A judgment that depends on several things is best split into one Score question
 * per thing, then combined with weights you control. Two details trip people up
 * and both are handled here:
 *
 * 1. **Normalize before weighting.** A 4-level rubric returns 0–3 and a 3-level
 *    rubric returns 0–2, so a top score on one is a bigger number than a top score
 *    on the other. Every dimension is divided by `levels - 1` first.
 * 2. **Keep the arithmetic in code.** Jev is explicitly not a calculator. Every
 *    number below is computed in JavaScript; none of it is asked of the model.
 *
 * Weights are normalized to sum to 1, so a composite is always 0–1 and adding a
 * dimension does not silently rescale the others.
 */

import BaseJev from './base.js';
import { score as scoreQuestion } from './questions.js';
import { requireAnswers } from './answers.js';
import { JevValidationError } from './errors.js';
import log from './logger.js';

/**
 * Weighted composite scoring over several Score dimensions.
 *
 * @example
 * import { Scorer } from 'ak-jev';
 *
 * const priority = new Scorer({
 *   dimensions: {
 *     severity: {
 *       weight: 0.6,
 *       instructions: 'How severe is the reported issue?',
 *       levels: ['Cosmetic', 'Broken but has a workaround', 'Blocking, no workaround']
 *     },
 *     frustration: {
 *       weight: 0.3,
 *       instructions: 'How frustrated is the customer?',
 *       levels: ['Calm', 'Frustrated but civil', 'Very angry']
 *     },
 *     report_quality: {
 *       weight: 0.1,
 *       instructions: 'How much does the report give an engineer to work with?',
 *       levels: ['No detail', 'Names the feature', 'Steps or environment', 'Steps and environment']
 *     }
 *   }
 * });
 *
 * const r = await priority.score(ticket);
 * r.composite            // 0.66
 * r.dimensions.severity  // { score: 1.24, normalized: 0.62, weighted: 0.372, confidence: 0.64, ... }
 *
 * const ranked = await priority.rank(tickets);   // sorted, highest composite first
 */
class Scorer extends BaseJev {
	/**
	 * @param {ScorerOptions} options
	 */
	constructor(options = /** @type {any} */ ({})) {
		super(options);

		const dims = options.dimensions;
		if (!dims || typeof dims !== 'object' || Object.keys(dims).length === 0) {
			throw new JevValidationError(
				'Scorer needs { dimensions }: an object of id -> { instructions, levels, weight }.'
			);
		}

		/** @type {Object.<string, any>} */
		this.questions = {};
		/** @type {Object.<string, number>} */
		this.weights = {};
		/** @type {Object.<string, boolean>} */
		this.inverted = {};

		let weightTotal = 0;
		for (const [id, spec] of Object.entries(dims)) {
			if (!spec || typeof spec !== 'object') {
				throw new JevValidationError(
					`Dimension "${id}" must be an object with { instructions, levels }.`,
					{ questionId: id }
				);
			}
			const levels = spec.levels ?? spec.criteria;
			if (!levels) {
				throw new JevValidationError(
					`Dimension "${id}" needs { levels }: an ordered array of level descriptions, ` +
						'or an ordered { name: description } object.',
					{ questionId: id }
				);
			}
			this.questions[id] = scoreQuestion(spec.instructions, levels);
			const weight = spec.weight ?? 1;
			if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
				throw new JevValidationError(
					`Dimension "${id}" has weight ${spec.weight}. Weights must be finite and >= 0.`,
					{ questionId: id }
				);
			}
			this.weights[id] = weight;
			// An inverted dimension counts backwards: a high level lowers the composite.
			this.inverted[id] = spec.invert === true;
			weightTotal += weight;
		}

		if (weightTotal <= 0) {
			throw new JevValidationError('Scorer weights sum to zero. At least one must be positive.');
		}

		/** Weights rescaled to sum to 1, so `composite` is always 0–1. */
		this.normalizedWeights = Object.fromEntries(
			Object.entries(this.weights).map(([id, w]) => [id, w / weightTotal])
		);
		/** @type {string[]} */
		this.dimensionIds = Object.keys(this.questions);
		log.debug({ dimensions: this.dimensionIds.length }, 'ak-jev: Scorer created');
	}

	/**
	 * Score one state across every dimension.
	 *
	 * @param {any} state
	 * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<CompositeScore>}
	 */
	async score(state, opts = {}) {
		const questions = { ...this.questions, ...(opts.questions ?? {}) };
		const result = await this.evaluate(state, questions, opts);
		return this._shape(result);
	}

	/**
	 * Score many states in parallel. Input order is kept.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<Array<CompositeScore|import('./base.js').JevFailure>>}
	 */
	async scoreMany(states, opts = {}) {
		const questions = { ...this.questions, ...(opts.questions ?? {}) };
		const results = await this.evaluateMany(states, questions, opts);
		return results.map((r) => (/** @type {any} */ (r).failed ? /** @type {any} */ (r) : this._shape(/** @type {any} */ (r))));
	}

	/**
	 * Score many states and return them sorted, highest composite first.
	 *
	 * Failures sort to the end rather than being dropped, so the caller always
	 * gets back as many entries as they passed in.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {top?: number}} [opts={}]
	 * @returns {Promise<Array<{index: number, state: any, composite: number|null, result: CompositeScore|null, error?: Error}>>}
	 */
	async rank(states, opts = {}) {
		const scored = await this.scoreMany(states, opts);
		const rows = scored.map((r, index) => {
			if (/** @type {any} */ (r).failed) {
				return { index, state: states[index], composite: null, result: null, error: /** @type {any} */ (r).error };
			}
			const cs = /** @type {CompositeScore} */ (r);
			return { index, state: states[index], composite: cs.composite, result: cs };
		});

		rows.sort((a, b) => {
			if (a.composite === null) return 1;
			if (b.composite === null) return -1;
			return b.composite - a.composite;
		});

		return opts.top ? rows.slice(0, opts.top) : rows;
	}

	/**
	 * Re-weight without re-calling the API.
	 *
	 * Recomputing a composite from an existing result is the whole reason weights
	 * live in code. Try a new set against yesterday's answers for nothing.
	 *
	 * @param {CompositeScore} result
	 * @param {Object.<string, number>} weights
	 * @returns {number}
	 */
	static reweight(result, weights) {
		let total = 0;
		let sum = 0;
		for (const [id, w] of Object.entries(weights)) {
			const dim = result.dimensions[id];
			if (!dim) continue;
			total += w;
			sum += w * dim.normalized;
		}
		return total > 0 ? sum / total : 0;
	}

	/**
	 * @param {import('./base.js').JevResult} result
	 * @returns {CompositeScore}
	 */
	_shape(result) {
		// A dropped dimension would silently shrink the composite. Stop instead.
		requireAnswers(result.answers, this.dimensionIds, 'Scorer');

		/** @type {Object.<string, any>} */
		const dimensions = {};
		let composite = 0;
		let confidenceSum = 0;
		let lowest = { id: /** @type {string|null} */ (null), confidence: Infinity };

		for (const id of this.dimensionIds) {
			const answer = result.answers[id];

			// An inverted dimension counts backwards, so a high level pulls the
			// composite down. Done here, after normalization, so it is a clean flip.
			const normalized = this.inverted[id] ? 1 - answer.normalized : answer.normalized;
			const weight = this.normalizedWeights[id];
			const weighted = weight * normalized;

			dimensions[id] = {
				score: answer.score,
				normalized,
				weight,
				weighted,
				confidence: answer.confidence,
				level: answer.level,
				label: answer.label,
				levels: answer.levels,
				probabilities: answer.probabilities,
				entropy: answer.entropy,
				inverted: this.inverted[id]
			};

			composite += weighted;
			confidenceSum += weight * answer.confidence;
			if (answer.confidence < lowest.confidence) lowest = { id, confidence: answer.confidence };
		}

		return {
			composite,
			dimensions,
			/** Weighted mean of the per-dimension confidences. */
			confidence: confidenceSum,
			/** The dimension the model was least sure about — the one to look at first. */
			weakest: lowest.id,
			weakestConfidence: lowest.id ? lowest.confidence : 0,
			answers: result.answers,
			usage: result.usage,
			cached: result.cached,
			requestId: result.requestId
		};
	}
}

/**
 * @typedef {Object} ScorerDimension
 * @property {any} instructions
 * @property {any[]|Object.<string, any>} levels ordered array, or ordered { name: description }
 * @property {any[]|Object.<string, any>} [criteria] alias for `levels`
 * @property {number} [weight=1] relative importance; all weights are rescaled to sum to 1
 * @property {boolean} [invert=false] a high level lowers the composite
 */

/**
 * @typedef {import('./base.js').JevOptions & {
 *   dimensions: Object.<string, ScorerDimension>
 * }} ScorerOptions
 */

/**
 * @typedef {Object} CompositeScore
 * @property {number} composite 0–1, the weighted mean of the normalized dimensions
 * @property {Object.<string, any>} dimensions per-dimension detail
 * @property {number} confidence weighted mean of the dimension confidences
 * @property {string|null} weakest the least confident dimension
 * @property {number} weakestConfidence
 * @property {Object.<string, any>} answers
 * @property {import('./base.js').JevUsage} usage
 * @property {boolean} cached
 * @property {string|undefined} requestId
 */

export default Scorer;
