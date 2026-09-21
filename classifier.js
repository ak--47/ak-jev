/**
 * @fileoverview Classifier — one Choice question, with a confidence gate.
 *
 * The single most common thing anyone does with this API. A Classifier adds the
 * two things every caller then writes by hand: a minimum confidence, and
 * somewhere for the answers that do not clear it to go.
 */

import BaseJev from './base.js';
import { choice } from './questions.js';
import { requireAnswers } from './answers.js';
import { JevValidationError } from './errors.js';
import log from './logger.js';

/**
 * Classify a state into one of a fixed set of labels.
 *
 * @example
 * import { Classifier } from 'ak-jev';
 *
 * const dept = new Classifier({
 *   instructions: 'Which team should handle this ticket?',
 *   labels: {
 *     billing: 'Payments, invoicing, refunds',
 *     technical: 'Bugs, outages, integrations',
 *     sales: 'Pricing, upgrades, new accounts'
 *   },
 *   minConfidence: 0.5,
 *   fallback: 'needs_human'
 * });
 *
 * const r = await dept.classify(ticket);
 * r.label        // 'billing', or 'needs_human' when confidence < 0.5
 * r.decided      // false when the fallback was used
 * r.confidence   // 0.92
 * r.runnerUp     // { label: 'technical', probability: 0.06 }
 */
class Classifier extends BaseJev {
	/**
	 * @param {ClassifierOptions} options
	 */
	constructor(options = /** @type {any} */ ({})) {
		super(options);

		if (!options.labels) {
			throw new JevValidationError(
				'Classifier needs { labels }: either a { label: description } map or an array of labels.'
			);
		}

		/** @type {string} */
		this.instructions = options.instructions ?? 'Which of these best describes the content?';
		/** @type {any} */
		this.question = choice(this.instructions, options.labels);
		/** @type {string[]} */
		this.labels = Object.keys(this.question.criteria);
		/** @type {number} */
		this.minConfidence = options.minConfidence ?? 0;
		/** @type {string|null} */
		this.fallback = options.fallback ?? null;
		/**
		 * Any other label whose probability clears this also comes back, in
		 * `alternatives`. The docs' triage example copies a second team in at 0.25.
		 * @type {number}
		 */
		this.alternativeThreshold = options.alternativeThreshold ?? 0;

		if (this.fallback && this.labels.includes(this.fallback)) {
			throw new JevValidationError(
				`fallback "${this.fallback}" is also one of the labels. Pick a name the model ` +
					'cannot return, so an undecided result is always distinguishable from a decided one.'
			);
		}

		/** @type {string} The question id used on the wire. */
		this.questionId = options.questionId ?? 'label';
		log.debug({ labels: this.labels.length }, 'ak-jev: Classifier created');
	}

	/**
	 * Classify one state.
	 *
	 * @param {any} state
	 * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
	 *   Extra `questions` ride along in the same request and come back on
	 *   `result.answers`. Free speculative fan-out.
	 * @returns {Promise<Classification>}
	 */
	async classify(state, opts = {}) {
		const questions = { [this.questionId]: this.question, ...(opts.questions ?? {}) };
		const result = await this.evaluate(state, questions, opts);
		return this._shape(result);
	}

	/**
	 * Classify many states in parallel. Results keep input order.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<Array<Classification|import('./base.js').JevFailure>>}
	 */
	async classifyMany(states, opts = {}) {
		const questions = { [this.questionId]: this.question, ...(opts.questions ?? {}) };
		const results = await this.evaluateMany(states, questions, opts);
		return results.map((r) => (/** @type {any} */ (r).failed ? /** @type {any} */ (r) : this._shape(/** @type {any} */ (r))));
	}

	/**
	 * Group states by their classified label. Undecided states land under the
	 * fallback name, or under `'undecided'` when no fallback is configured.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions} [opts={}]
	 * @returns {Promise<Object.<string, any[]>>}
	 */
	async group(states, opts = {}) {
		const results = await this.classifyMany(states, opts);
		/** @type {Object.<string, any[]>} */
		const buckets = {};
		results.forEach((r, i) => {
			const key = /** @type {any} */ (r).failed
				? 'failed'
				: /** @type {Classification} */ (r).label ?? 'undecided';
			(buckets[key] ??= []).push(states[i]);
		});
		return buckets;
	}

	/**
	 * @param {import('./base.js').JevResult} result
	 * @returns {Classification}
	 */
	_shape(result) {
		requireAnswers(result.answers, [this.questionId], 'Classifier');
		const answer = result.answers[this.questionId];
		const decided = answer.confidence >= this.minConfidence;
		const alternatives = answer.ranked
			.filter((/** @type {any} */ r) => r.label !== answer.choice && r.probability >= this.alternativeThreshold)
			.filter((/** @type {any} */ r) => r.probability > 0);

		return {
			label: decided ? answer.choice : this.fallback,
			decided,
			choice: answer.choice,
			confidence: answer.confidence,
			probabilities: answer.probabilities,
			ranked: answer.ranked,
			runnerUp: answer.runnerUp,
			margin: answer.margin,
			entropy: answer.entropy,
			alternatives,
			answers: result.answers,
			usage: result.usage,
			cached: result.cached,
			requestId: result.requestId
		};
	}
}

/**
 * @typedef {import('./base.js').JevOptions & {
 *   labels: Object.<string, any>|string[],
 *   instructions?: string,
 *   minConfidence?: number,
 *   fallback?: string|null,
 *   alternativeThreshold?: number,
 *   questionId?: string
 * }} ClassifierOptions
 */

/**
 * @typedef {Object} Classification
 * @property {string|null} label the decision, or the fallback when confidence was too low
 * @property {boolean} decided false when `minConfidence` was not met
 * @property {string} choice what the model picked, regardless of the gate
 * @property {number} confidence
 * @property {Object.<string, number>} probabilities
 * @property {Array<{label: string, probability: number}>} ranked
 * @property {{label: string, probability: number}|null} runnerUp
 * @property {number} margin
 * @property {number} entropy
 * @property {Array<{label: string, probability: number}>} alternatives other labels over `alternativeThreshold`
 * @property {Object.<string, any>} answers every answer, including any extra questions sent along
 * @property {import('./base.js').JevUsage} usage
 * @property {boolean} cached
 * @property {string|undefined} requestId
 */

export default Classifier;
