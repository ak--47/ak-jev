/**
 * @fileoverview Ranker — semantic search, re-ranking, and relevance scoring.
 *
 * Two shapes, both drawn from the cookbooks:
 *
 * `rank()` asks one question per candidate, batched into as few requests as the
 * token budget allows. Each candidate rides inside its own question's structured
 * `instructions`, so the state stays small and no candidate distracts from
 * another. That is the pattern the Noul docs use for duplicate-record matching,
 * and it avoids the "large state full of irrelevant detail" failure mode.
 *
 * `pick()` asks one Choice over every candidate id in a single request, when you
 * want one winner rather than a full ordering. That is the Line-by-line search
 * shape: 218 candidates, one call.
 *
 * Batching is by estimated tokens, not by a fixed count, because candidate sizes
 * vary by orders of magnitude between a log line and a legal passage.
 */

import BaseJev from './base.js';
import { noul, score as scoreQuestion, choice } from './questions.js';
import { estimateQuestionTokens, estimateTokens } from './tokens.js';
import { requireAnswers } from './answers.js';
import { JevValidationError } from './errors.js';
import log from './logger.js';

/**
 * Rank candidates against a query.
 *
 * @example
 * import { Ranker } from 'ak-jev';
 *
 * const ranker = new Ranker({
 *   instructions: 'Does this passage contain the answer to the query?'
 * });
 *
 * const top = await ranker.rank(query, passages, { top: 10 });
 * top[0]  // { rank: 1, index: 42, candidate: '...', relevance: 0.97 }
 *
 * // One winner, one request:
 * const best = await ranker.pick(query, passages);
 */
class Ranker extends BaseJev {
	/**
	 * @param {RankerOptions} [options={}]
	 */
	constructor(options = {}) {
		super(options);

		/** @type {string} */
		this.instructions = options.instructions ?? 'Is this candidate relevant to the query?';
		/** @type {'noul'|'score'} */
		this.mode = options.mode ?? 'noul';
		if (!['noul', 'score'].includes(this.mode)) {
			throw new JevValidationError(`Ranker mode must be 'noul' or 'score', got ${JSON.stringify(this.mode)}.`);
		}
		/** @type {any[]|null} Relevance levels, required when mode is 'score'. */
		this.levels = options.levels ?? null;
		if (this.mode === 'score' && !this.levels) {
			throw new JevValidationError(
				"Ranker mode 'score' needs { levels }: an ordered array of relevance level descriptions."
			);
		}
		/** @type {(candidate: any, index: number) => any} */
		this.toText = options.toText ?? ((c) => c);
		/**
		 * Token budget per request. Below the 64k hard limit, with room for the
		 * query, the fixed overhead and the model's own slack.
		 * @type {number}
		 */
		this.batchTokens = options.batchTokens ?? 40_000;
		/** @type {number} Hard cap on candidates per request, whatever the token maths says. */
		this.batchSize = options.batchSize ?? 400;
		/** @type {{true?: any, false?: any}|undefined} */
		this.criteria = options.criteria;

		log.debug({ mode: this.mode }, 'ak-jev: Ranker created');
	}

	/**
	 * Score every candidate against the query and return them sorted, best first.
	 *
	 * @param {any} query
	 * @param {any[]} candidates
	 * @param {RankOptions} [opts={}]
	 * @returns {Promise<RankedCandidate[]>}
	 */
	async rank(query, candidates, opts = {}) {
		if (!Array.isArray(candidates)) throw new JevValidationError('rank() needs an array of candidates.');
		if (candidates.length === 0) return [];

		const batches = this._batch(query, candidates);
		log.debug({ candidates: candidates.length, batches: batches.length }, 'ak-jev: ranking');

		/** @type {RankedCandidate[]} */
		const rows = [];
		let done = 0;

		await Promise.all(
			batches.map(async (batch) => {
				/** @type {Object.<string, any>} */
				const questions = {};
				// `_batch` already built each question to size it. Reuse those rather
				// than re-serializing every candidate a second time.
				for (const { index, question } of batch) {
					questions[`c${index}`] = question;
				}

				const result = await this.evaluate({ query }, questions, opts);
				// A dropped answer would quietly remove a candidate from the ranking,
				// and the caller would never know it was considered.
				requireAnswers(result.answers, Object.keys(questions), 'Ranker');

				for (const { index } of batch) {
					const answer = result.answers[`c${index}`];
					rows.push({
						rank: 0, // assigned after the global sort
						index,
						candidate: candidates[index],
						relevance: this.mode === 'noul' ? answer.noul : answer.normalized,
						answer
					});
				}

				done += batch.length;
				opts.onProgress?.({ done, total: candidates.length });
			})
		);

		rows.sort((a, b) => b.relevance - a.relevance || a.index - b.index);
		rows.forEach((r, i) => {
			r.rank = i + 1;
		});

		const cut = typeof opts.minRelevance === 'number'
			? rows.filter((r) => r.relevance >= /** @type {number} */ (opts.minRelevance))
			: rows;
		return opts.top ? cut.slice(0, opts.top) : cut;
	}

	/**
	 * Pick the single best candidate in one request, via a Choice over candidate ids.
	 *
	 * The candidates go in the STATE, keyed by id, and the Choice options are just
	 * those ids. That is the Line-by-line search shape, and it is what makes the
	 * `found` check possible: a second Noul against the same state can ask whether
	 * any candidate answers the query at all.
	 *
	 * The distinction matters. A Choice is relative — it settles *which* candidate
	 * is best even when every one of them is useless. The Noul is absolute. Pass
	 * `includeNone` to get both, and check `found` before trusting `index`.
	 *
	 * Bounded by the API's 255-option limit on a Choice.
	 *
	 * @param {any} query
	 * @param {any[]} candidates
	 * @param {PickOptions} [opts={}]
	 * @returns {Promise<PickResult>}
	 */
	async pick(query, candidates, opts = {}) {
		if (!Array.isArray(candidates) || candidates.length === 0) {
			throw new JevValidationError('pick() needs a non-empty array of candidates.');
		}
		const limit = this.limits().maxChoiceOptions - (opts.includeNone ? 1 : 0);
		if (candidates.length > limit) {
			throw new JevValidationError(
				`pick() was given ${candidates.length} candidates; a Choice allows at most ${limit} options. ` +
					'Narrow the shortlist first, or use rank() which batches across requests.'
			);
		}

		const NONE = '__none__';
		/** @type {Object.<string, any>} */
		const catalogue = {};
		/** @type {Object.<string, any>} */
		const criteria = {};
		candidates.forEach((c, i) => {
			catalogue[`c${i}`] = this.toText(c, i);
			criteria[`c${i}`] = null;
		});
		if (opts.includeNone) criteria[NONE] = 'None of the candidates in `candidates` answers the query.';

		const instructions = opts.instructions ?? this.instructions;
		const questions = {
			best: choice(
				{ question: instructions, note: 'Each option is a key in `candidates`. Pick the key whose text best answers `query`.' },
				criteria
			)
		};
		if (opts.includeNone) {
			questions.found = noul('Does any entry in `candidates` answer the question in `query`?');
		}

		const result = await this.evaluate({ query, candidates: catalogue }, questions, opts);
		const answer = result.answers.best;
		const isNone = answer.choice === NONE;
		const index = isNone ? -1 : Number(String(answer.choice).slice(1));

		return {
			index,
			candidate: index >= 0 ? candidates[index] : null,
			confidence: answer.confidence,
			found: opts.includeNone ? (result.answers.found?.yes ?? !isNone) : !isNone,
			ranked: answer.ranked
				.filter((/** @type {any} */ r) => r.label !== NONE)
				.map((/** @type {any} */ r) => ({
					index: Number(r.label.slice(1)),
					candidate: candidates[Number(r.label.slice(1))],
					probability: r.probability
				})),
			answers: result.answers,
			usage: result.usage,
			cached: result.cached,
			requestId: result.requestId
		};
	}

	/**
	 * Build the per-candidate question. The candidate travels in the question's
	 * structured `instructions`, not in the state.
	 * @param {any} text
	 */
	_questionFor(text) {
		const instructions = { candidate: text, question: this.instructions };
		return this.mode === 'noul'
			? noul(instructions, this.criteria)
			: scoreQuestion(instructions, /** @type {any[]} */ (this.levels));
	}

	/**
	 * Split candidates into requests that each fit the token budget.
	 * @param {any} query
	 * @param {any[]} candidates
	 * @returns {Array<Array<{index: number, text: any, question: any}>>}
	 */
	_batch(query, candidates) {
		const limits = this.limits();
		const queryTokens = estimateTokens({ query }) + limits.requestOverheadTokens;
		const budget = Math.min(this.batchTokens, limits.contextTokens) - queryTokens;

		/** @type {Array<Array<{index: number, text: any, question: any}>>} */
		const batches = [];
		/** @type {Array<{index: number, text: any, question: any}>} */
		let current = [];
		let used = 0;

		candidates.forEach((candidate, index) => {
			const text = this.toText(candidate, index);
			const question = this._questionFor(text);
			const cost = estimateQuestionTokens(question);

			// One oversized candidate gets its own request rather than being dropped.
			// The API will reject it if it truly does not fit, with a clear error.
			if (current.length > 0 && (used + cost > budget || current.length >= this.batchSize)) {
				batches.push(current);
				current = [];
				used = 0;
			}
			current.push({ index, text, question });
			used += cost;
		});

		if (current.length > 0) batches.push(current);
		return batches;
	}
}

/**
 * @typedef {import('./base.js').JevOptions & {
 *   instructions?: string,
 *   mode?: 'noul'|'score',
 *   levels?: any[],
 *   criteria?: {true?: any, false?: any},
 *   toText?: (candidate: any, index: number) => any,
 *   batchTokens?: number,
 *   batchSize?: number
 * }} RankerOptions
 */

/**
 * @typedef {import('./base.js').JevEvaluateOptions & {
 *   top?: number,
 *   minRelevance?: number,
 *   onProgress?: (p: {done: number, total: number}) => void
 * }} RankOptions
 */

/**
 * @typedef {import('./base.js').JevEvaluateOptions & {
 *   instructions?: string,
 *   includeNone?: boolean
 * }} PickOptions
 */

/**
 * @typedef {Object} RankedCandidate
 * @property {number} rank 1-based, after sorting
 * @property {number} index position in the input array
 * @property {any} candidate
 * @property {number} relevance 0–1; the noul value, or the normalized score
 * @property {any} answer the full enriched answer
 */

/**
 * @typedef {Object} PickResult
 * @property {number} index -1 when nothing was picked
 * @property {any} candidate
 * @property {number} confidence
 * @property {boolean} found
 * @property {Array<{index: number, candidate: any, probability: number}>} ranked
 * @property {Object.<string, any>} answers
 * @property {import('./base.js').JevUsage} usage
 * @property {boolean} cached
 * @property {string|undefined} requestId
 */

export default Ranker;
