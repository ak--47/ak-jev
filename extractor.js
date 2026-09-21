/**
 * @fileoverview Extractor — structured extraction, without generation.
 *
 * Jev cannot write text. The documented workaround is to turn extraction into a
 * Choice over the possible values: when the answer space is bounded, let the
 * model pick rather than produce. Every field a Choice, every field in the same
 * request, and the code copies the winning label verbatim — it never re-types the
 * value, so the output is always exactly one of the options you supplied.
 *
 * `allowMissing` matters more than it looks. Without an explicit "not stated"
 * option a Choice must pick something, and it will invent a reading rather than
 * report an absence.
 */

import BaseJev from './base.js';
import { choice } from './questions.js';
import { JevValidationError } from './errors.js';
import log from './logger.js';

/** The option added for `allowMissing`. Mapped back to `null` in the record. */
export const NOT_STATED = '__not_stated__';

/**
 * Extract a record of bounded fields from unstructured input.
 *
 * @example
 * import { Extractor } from 'ak-jev';
 *
 * const invoice = new Extractor({
 *   fields: {
 *     currency: { instructions: 'Which currency is the total in?', options: ['USD', 'EUR', 'GBP'] },
 *     status:   { instructions: 'What is the payment status?',     options: { paid: 'Settled in full', due: 'Not yet paid', partial: 'Some paid' } },
 *     month:    { instructions: 'Which month is the invoice dated?', options: MONTHS, allowMissing: true },
 *     terms:    { instructions: 'What are the payment terms?', options: ['net_15','net_30','net_60'], minConfidence: 0.7 }
 *   }
 * });
 *
 * const r = await invoice.extract(document);
 * r.record            // { currency: 'USD', status: 'paid', month: null, terms: null }
 * r.complete          // false — two fields were missing or below their bar
 * r.uncertain         // ['terms']
 * r.fields.currency   // { value: 'USD', confidence: 0.99, decided: true, ... }
 */
class Extractor extends BaseJev {
	/**
	 * @param {ExtractorOptions} options
	 */
	constructor(options = /** @type {any} */ ({})) {
		super(options);

		const fields = options.fields;
		if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
			throw new JevValidationError(
				'Extractor needs { fields }: an object of name -> { instructions, options }.'
			);
		}

		/** @type {Object.<string, any>} */
		this.questions = {};
		/** @type {Object.<string, any>} */
		this.fieldSpecs = {};

		for (const [name, spec] of Object.entries(fields)) {
			if (!spec || typeof spec !== 'object') {
				throw new JevValidationError(`Field "${name}" must be an object with { instructions, options }.`);
			}
			const raw = spec.options ?? spec.criteria;
			if (!raw) {
				throw new JevValidationError(
					`Field "${name}" needs { options }: the bounded set of values it can take. ` +
						'Jev picks from a list; it cannot generate a value.',
					{ questionId: name }
				);
			}

			const allowMissing = spec.allowMissing ?? options.allowMissing ?? false;
			const criteria = Array.isArray(raw)
				? Object.fromEntries(raw.map((v) => [String(v), null]))
				: { ...raw };

			if (allowMissing) {
				if (NOT_STATED in criteria) {
					throw new JevValidationError(
						`Field "${name}" already defines "${NOT_STATED}", which allowMissing reserves.`,
						{ questionId: name }
					);
				}
				criteria[NOT_STATED] = spec.missingDescription ??
					'The document does not state this. Choose this rather than inferring a value.';
			}

			this.questions[name] = choice(
				spec.instructions ?? `What is the ${name}?`,
				criteria
			);
			this.fieldSpecs[name] = {
				allowMissing,
				minConfidence: spec.minConfidence ?? options.minConfidence ?? 0,
				// Applied to the winning label, in code. The model's output is copied
				// verbatim first; this only normalizes it.
				transform: spec.transform
			};
		}

		/** @type {string[]} */
		this.fieldNames = Object.keys(this.questions);
		log.debug({ fields: this.fieldNames.length }, 'ak-jev: Extractor created');
	}

	/**
	 * Extract every field from one document, in one request.
	 *
	 * @param {any} state
	 * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<Extraction>}
	 */
	async extract(state, opts = {}) {
		const questions = { ...this.questions, ...(opts.questions ?? {}) };
		const result = await this.evaluate(state, questions, opts);
		return this._shape(result);
	}

	/**
	 * Extract from many documents, in parallel. Input order is kept.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<Array<Extraction|import('./base.js').JevFailure>>}
	 */
	async extractMany(states, opts = {}) {
		const questions = { ...this.questions, ...(opts.questions ?? {}) };
		const results = await this.evaluateMany(states, questions, opts);
		return results.map((r) => (/** @type {any} */ (r).failed ? /** @type {any} */ (r) : this._shape(/** @type {any} */ (r))));
	}

	/**
	 * @param {import('./base.js').JevResult} result
	 * @returns {Extraction}
	 */
	_shape(result) {
		/** @type {Object.<string, any>} */
		const record = {};
		/** @type {Object.<string, any>} */
		const fields = {};
		/** @type {string[]} */
		const missing = [];
		/** @type {string[]} */
		const uncertain = [];

		for (const name of this.fieldNames) {
			const answer = result.answers[name];
			if (!answer) continue;
			const spec = this.fieldSpecs[name];

			const notStated = answer.choice === NOT_STATED;
			const confident = answer.confidence >= spec.minConfidence;
			const decided = !notStated && confident;

			// Copy the label verbatim, then normalize. Never re-type the value.
			let value = decided ? answer.choice : null;
			if (decided && spec.transform) value = spec.transform(value, answer);

			record[name] = value;
			fields[name] = {
				value,
				choice: answer.choice,
				decided,
				notStated,
				confidence: answer.confidence,
				probabilities: answer.probabilities,
				runnerUp: answer.runnerUp,
				margin: answer.margin,
				required: spec.minConfidence
			};

			if (notStated) missing.push(name);
			else if (!confident) uncertain.push(name);
		}

		return {
			record,
			fields,
			missing,
			uncertain,
			complete: missing.length === 0 && uncertain.length === 0,
			/** Lowest confidence across the fields — the one to review first. */
			minConfidence: this.fieldNames.length
				? Math.min(...this.fieldNames.map((n) => fields[n]?.confidence ?? 1))
				: 1,
			answers: result.answers,
			usage: result.usage,
			cached: result.cached,
			requestId: result.requestId
		};
	}
}

/**
 * @typedef {Object} ExtractorField
 * @property {any} [instructions]
 * @property {string[]|Object.<string, any>} options the bounded set of values
 * @property {string[]|Object.<string, any>} [criteria] alias for `options`
 * @property {boolean} [allowMissing] add a "not stated" option, mapped to `null`
 * @property {any} [missingDescription] wording for that option
 * @property {number} [minConfidence] below this the field comes back `null`
 * @property {(value: string, answer: any) => any} [transform] normalize the winning label in code
 */

/**
 * @typedef {import('./base.js').JevOptions & {
 *   fields: Object.<string, ExtractorField>,
 *   allowMissing?: boolean,
 *   minConfidence?: number
 * }} ExtractorOptions
 */

/**
 * @typedef {Object} Extraction
 * @property {Object.<string, any>} record the extracted values; `null` where missing or unsure
 * @property {Object.<string, any>} fields per-field detail
 * @property {string[]} missing fields the document did not state
 * @property {string[]} uncertain fields below their confidence bar
 * @property {boolean} complete
 * @property {number} minConfidence
 * @property {Object.<string, any>} answers
 * @property {import('./base.js').JevUsage} usage
 * @property {boolean} cached
 * @property {string|undefined} requestId
 */

export default Extractor;
