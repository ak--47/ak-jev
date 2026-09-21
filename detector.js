/**
 * @fileoverview Detector — a checklist of yes/no conditions, all in one request.
 *
 * For a list of independent conditions, ask one Noul per condition and let the
 * code decide what the combination means. They are answered in parallel, so
 * twenty conditions cost about what one costs in wall time.
 *
 * Each condition can carry its own thresholds, because "does this contain
 * personal data" and "is this a duplicate" should not share a bar.
 */

import BaseJev from './base.js';
import { noul } from './questions.js';
import { requireAnswers } from './answers.js';
import { JevValidationError } from './errors.js';
import log from './logger.js';

/**
 * Run a set of yes/no conditions against a state.
 *
 * @example
 * import { Detector } from 'ak-jev';
 *
 * const pii = new Detector({
 *   conditions: {
 *     email: 'Does the text contain an email address?',
 *     phone: 'Does the text contain a phone number?',
 *     // per-condition thresholds: be trigger-happy about card numbers
 *     card: { instructions: 'Does the text contain a payment card number?', high: 0.5 },
 *     address: {
 *       instructions: 'Does the text contain a home address?',
 *       criteria: { true: 'A street address precise enough to find', false: 'A city or country alone' }
 *     }
 *   }
 * });
 *
 * const r = await pii.check(message);
 * r.triggered   // ['email', 'card']
 * r.any         // true
 * r.unsure      // ['address']  -> send these to a person
 * r.flags.email // true
 */
class Detector extends BaseJev {
	/**
	 * @param {DetectorOptions} options
	 */
	constructor(options = /** @type {any} */ ({})) {
		super(options);

		const conditions = options.conditions;
		if (!conditions || typeof conditions !== 'object' || Object.keys(conditions).length === 0) {
			throw new JevValidationError(
				'Detector needs { conditions }: an object of id -> question string or ' +
					'{ instructions, criteria, yes, high, low }.'
			);
		}

		/** @type {Object.<string, any>} */
		this.questions = {};
		/** @type {Object.<string, {yes: number, high: number, low: number}>} */
		this.conditionThresholds = {};

		for (const [id, spec] of Object.entries(conditions)) {
			if (typeof spec === 'string') {
				this.questions[id] = noul(spec);
				this.conditionThresholds[id] = { ...this.thresholds };
				continue;
			}
			if (!spec || typeof spec !== 'object') {
				throw new JevValidationError(
					`Condition "${id}" must be a question string or an object.`,
					{ questionId: id }
				);
			}
			this.questions[id] = noul(spec.instructions, spec.criteria);
			this.conditionThresholds[id] = {
				yes: spec.yes ?? this.thresholds.yes,
				high: spec.high ?? this.thresholds.high,
				low: spec.low ?? this.thresholds.low
			};
		}

		/** @type {string[]} */
		this.conditionIds = Object.keys(this.questions);
		log.debug({ conditions: this.conditionIds.length }, 'ak-jev: Detector created');
	}

	/**
	 * Run every condition against one state.
	 *
	 * @param {any} state
	 * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<Detection>}
	 */
	async check(state, opts = {}) {
		const questions = { ...this.questions, ...(opts.questions ?? {}) };
		const result = await this.evaluate(state, questions, opts);
		return this._shape(result);
	}

	/**
	 * Run every condition against many states, in parallel. Input order is kept.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<Array<Detection|import('./base.js').JevFailure>>}
	 */
	async checkMany(states, opts = {}) {
		const questions = { ...this.questions, ...(opts.questions ?? {}) };
		const results = await this.evaluateMany(states, questions, opts);
		return results.map((r) => (/** @type {any} */ (r).failed ? /** @type {any} */ (r) : this._shape(/** @type {any} */ (r))));
	}

	/**
	 * @param {import('./base.js').JevResult} result
	 * @returns {Detection}
	 */
	_shape(result) {
		// A dropped condition would read as "not triggered". Stop instead.
		requireAnswers(result.answers, this.conditionIds, 'Detector');

		/** @type {Object.<string, boolean>} */
		const flags = {};
		/** @type {Object.<string, number>} */
		const probabilities = {};
		/** @type {Object.<string, 'yes'|'no'|'unsure'>} */
		const verdicts = {};
		/** @type {string[]} */
		const triggered = [];
		/** @type {string[]} */
		const unsure = [];

		for (const id of this.conditionIds) {
			const answer = result.answers[id];
			const t = this.conditionThresholds[id];
			const p = answer.noul;

			probabilities[id] = p;
			flags[id] = p >= t.yes;
			const verdict = p >= t.high ? 'yes' : p <= t.low ? 'no' : 'unsure';
			verdicts[id] = verdict;

			if (flags[id]) triggered.push(id);
			if (verdict === 'unsure') unsure.push(id);
		}

		// Strongest signal first — the thing you would look at, looked at first.
		triggered.sort((a, b) => probabilities[b] - probabilities[a]);

		return {
			flags,
			probabilities,
			verdicts,
			triggered,
			unsure,
			any: triggered.length > 0,
			all: triggered.length === this.conditionIds.length,
			count: triggered.length,
			/** The highest probability across every condition. */
			max: this.conditionIds.length
				? Math.max(...this.conditionIds.map((id) => probabilities[id] ?? 0))
				: 0,
			answers: result.answers,
			usage: result.usage,
			cached: result.cached,
			requestId: result.requestId
		};
	}
}

/**
 * @typedef {Object} DetectorCondition
 * @property {any} [instructions]
 * @property {{true?: any, false?: any}} [criteria]
 * @property {number} [yes] overrides the client threshold for this condition
 * @property {number} [high]
 * @property {number} [low]
 */

/**
 * @typedef {import('./base.js').JevOptions & {
 *   conditions: Object.<string, string|DetectorCondition>
 * }} DetectorOptions
 */

/**
 * @typedef {Object} Detection
 * @property {Object.<string, boolean>} flags thresholded at each condition's `yes`
 * @property {Object.<string, number>} probabilities raw noul values
 * @property {Object.<string, 'yes'|'no'|'unsure'>} verdicts three-way per condition
 * @property {string[]} triggered ids where `flags` is true, strongest first
 * @property {string[]} unsure ids in the band between `low` and `high`
 * @property {boolean} any
 * @property {boolean} all
 * @property {number} count
 * @property {number} max highest probability across all conditions
 * @property {Object.<string, any>} answers
 * @property {import('./base.js').JevUsage} usage
 * @property {boolean} cached
 * @property {string|undefined} requestId
 */

export default Detector;
