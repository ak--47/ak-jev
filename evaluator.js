/**
 * @fileoverview Evaluator — a reusable question set, run against one state or many.
 *
 * The workhorse. Declare the questions once at module scope, then call `run()`
 * per item. This is the shape the Speculative Fan-Out pattern wants: put every
 * question your code might need in the set, including the speculative ones, and
 * let the code decide afterwards which answers matter.
 */

import BaseJev from './base.js';
import { expandQuestions } from './questions.js';
import { JevValidationError } from './errors.js';
import log from './logger.js';

/**
 * A fixed question set bound to a client.
 *
 * @example
 * import { Evaluator, noul, choice, score } from 'ak-jev';
 *
 * const triage = new Evaluator({
 *   questions: {
 *     category: choice('What kind of ticket is this?', {
 *       bug_report: 'Something is broken',
 *       billing: 'Charges, invoices, refunds',
 *       feature_request: 'Asking for something new'
 *     }),
 *     // Speculative: only read when category is bug_report.
 *     severity: score('How severe is the issue?', [
 *       'Cosmetic', 'Broken but has a workaround', 'Blocking, no workaround'
 *     ]),
 *     refund_requested: noul('Does the customer ask for money back?'),
 *     frustration: score('How frustrated is the customer?', ['Calm', 'Annoyed', 'Furious'])
 *   }
 * });
 *
 * const { answers } = await triage.run(ticket);
 * if (answers.category.choice === 'bug_report' && answers.severity.normalized > 0.6) escalate();
 */
class Evaluator extends BaseJev {
	/**
	 * @param {import('./base.js').JevOptions & {questions?: Object.<string, any>}} [options={}]
	 */
	constructor(options = {}) {
		super(options);
		/** @type {Object.<string, any>} */
		this.questions = options.questions ? expandQuestions(options.questions) : {};
		log.debug({ questions: Object.keys(this.questions).length }, 'ak-jev: Evaluator created');
	}

	/**
	 * Add or replace questions after construction. Returns `this` so it chains.
	 *
	 * @param {Object.<string, any>} questions
	 * @returns {this}
	 */
	addQuestions(questions) {
		Object.assign(this.questions, expandQuestions(questions));
		return this;
	}

	/**
	 * Remove questions by id. Returns `this` so it chains.
	 * @param {...string} ids
	 * @returns {this}
	 */
	removeQuestions(...ids) {
		for (const id of ids) delete this.questions[id];
		return this;
	}

	/**
	 * Evaluate one state against the bound question set.
	 *
	 * @param {any} state
	 * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
	 *   `questions` here are merged over the bound set for this call only.
	 * @returns {Promise<import('./base.js').JevResult>}
	 */
	async run(state, opts = {}) {
		return this.evaluate(state, this._questionsFor(opts), opts);
	}

	/**
	 * Evaluate many states against the bound question set, in parallel.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @returns {Promise<Array<import('./base.js').JevResult|import('./base.js').JevFailure>>}
	 */
	async runMany(states, opts = {}) {
		return this.evaluateMany(states, this._questionsFor(opts), opts);
	}

	/**
	 * Evaluate many states and yield each result as it lands, in completion order
	 * rather than input order.
	 *
	 * Use this over `runMany()` when you want to start acting on early results
	 * instead of waiting for the whole corpus. Each yielded item carries its
	 * `index` and the original `state` so you can tell them apart.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
	 * @yields {{index: number, state: any, result?: import('./base.js').JevResult, error?: Error}}
	 */
	async *stream(states, opts = {}) {
		if (!Array.isArray(states)) {
			throw new JevValidationError('stream() needs an array of states.');
		}
		const questions = this._questionsFor(opts);

		/** @type {Array<Promise<any>>} */
		const pending = states.map((state, index) =>
			this.evaluate(state, questions, opts).then(
				(result) => ({ index, state, result }),
				(error) => {
					if (opts.throwOnError) throw error;
					return { index, state, error };
				}
			)
		);

		// Settle-as-you-go: race the outstanding set, then drop the one that won.
		const outstanding = new Map(pending.map((p, i) => [i, p.then((v) => ({ slot: i, v }))]));
		while (outstanding.size > 0) {
			const { slot, v } = await Promise.race(outstanding.values());
			outstanding.delete(slot);
			yield v;
		}
	}

	/**
	 * The questions for one call: the bound set, with per-call overrides merged in.
	 * @param {{questions?: Object.<string, any>}} opts
	 */
	_questionsFor(opts) {
		const extra = opts.questions ? expandQuestions(opts.questions) : null;
		const questions = extra ? { ...this.questions, ...extra } : this.questions;
		if (Object.keys(questions).length === 0) {
			throw new JevValidationError(
				'Evaluator has no questions. Pass { questions } to the constructor, ' +
					'call addQuestions(), or pass { questions } to this call.'
			);
		}
		return questions;
	}
}

export default Evaluator;
