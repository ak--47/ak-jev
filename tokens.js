/**
 * @fileoverview Token estimation and context-budget pre-flight.
 *
 * TypeSafe publishes no tokenizer, so these are estimates. They exist to catch a
 * request that is obviously too large before it costs a round trip and comes back
 * as `{"detail":{"error_type":"max_tokens_exceeded"}}` — an error with no message
 * attached at all.
 *
 * ## Calibration, measured against the live API on 2026-09-21
 *
 * An empty state with a one-character question bills exactly **267 tokens**, so
 * that is the fixed overhead. Characters per token then vary by a factor of three
 * depending on what the content is:
 *
 * | content              | chars/token |
 * |----------------------|-------------|
 * | code                 | 3.47        |
 * | JSON object          | 3.76        |
 * | English prose        | 4.47        |
 * | legal text           | 4.94        |
 * | one phrase, repeated | 9.36        |
 *
 * The estimator uses **3.6**, between code and JSON, because a Jev `state` is
 * usually structured data rather than flowing prose. On realistic content it
 * lands within about 25% either way. It over-counts heavily on repetitive text,
 * which is the harmless direction.
 *
 * Because the ratio genuinely varies, the budget check applies a further
 * `BUDGET_SAFETY_MARGIN` on top. That keeps the warning conservative without
 * inflating `estimatedCost`, which reports the nominal figure.
 */

import { resolveLimits } from './models.js';

/** Characters per token. See the calibration table above. */
const CHARS_PER_TOKEN = 3.6;

/**
 * Applied to the budget comparison only, never to the cost estimate.
 *
 * Dense content (code, minified JSON) tokenizes about 25% heavier than the
 * nominal ratio, and being told "this might not fit" is much cheaper than a
 * round trip that returns a 400 with no message.
 */
export const BUDGET_SAFETY_MARGIN = 1.25;

/** Tokens of structural overhead per question, on top of its text. */
const PER_QUESTION_OVERHEAD = 8;

/**
 * Rough token count for any JSON-serializable value.
 *
 * @param {any} value
 * @returns {number}
 */
export function estimateTokens(value) {
	if (value === null || value === undefined) return 0;
	const text = typeof value === 'string' ? value : safeStringify(value);
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Token count for a single question, including its criteria.
 *
 * @param {any} question a wire-shaped question (`{type, instructions, criteria}`)
 * @returns {number}
 */
export function estimateQuestionTokens(question) {
	if (!question) return 0;
	return estimateTokens(question.instructions) +
		estimateTokens(question.criteria) +
		PER_QUESTION_OVERHEAD;
}

/**
 * Estimate a whole request and check it against the model's two budgets.
 *
 * jev-1.13 has two limits, and the tighter one is easy to miss: the total request
 * must fit 64k tokens, AND the state plus the *single longest question* must fit
 * 32k. A modest state with one enormous question can pass the first and fail the
 * second.
 *
 * @param {Object} args
 * @param {any} args.state
 * @param {Object.<string, any>} args.questions wire-shaped questions
 * @param {string} [args.model]
 * @returns {JevEstimate}
 */
export function estimateRequest({ state, questions, model }) {
	const limits = resolveLimits(model);
	const stateTokens = estimateTokens(state);

	/** @type {Object.<string, number>} */
	const perQuestion = {};
	let questionTokens = 0;
	let longestQuestion = 0;
	let longestQuestionId = null;

	for (const [id, question] of Object.entries(questions ?? {})) {
		const n = estimateQuestionTokens(question);
		perQuestion[id] = n;
		questionTokens += n;
		if (n > longestQuestion) {
			longestQuestion = n;
			longestQuestionId = id;
		}
	}

	const totalTokens = limits.requestOverheadTokens + stateTokens + questionTokens;
	// The fixed overhead counts against the 32k budget too, so include it here.
	const widestPath = limits.requestOverheadTokens + stateTokens + longestQuestion;

	// The budget is checked against the padded figures; cost is not.
	const budgetTokens = Math.ceil(totalTokens * BUDGET_SAFETY_MARGIN);
	const budgetWidestPath = Math.ceil(widestPath * BUDGET_SAFETY_MARGIN);

	/** @type {string[]} */
	const warnings = [];
	if (budgetTokens > limits.contextTokens) {
		warnings.push(
			`Estimated ${totalTokens} tokens (${budgetTokens} with the safety margin) may exceed ` +
				`the ${limits.contextTokens}-token request budget. ` +
				`Split the ${Object.keys(questions ?? {}).length} questions across several calls.`
		);
	}
	if (budgetWidestPath > limits.stateTokens) {
		warnings.push(
			`Estimated ${widestPath} tokens (${budgetWidestPath} with the safety margin) for the state ` +
				`plus the longest question (${longestQuestionId}) may exceed the ` +
				`${limits.stateTokens}-token budget. Filter the state down to what the question needs.`
		);
	}

	return {
		stateTokens,
		questionTokens,
		overheadTokens: limits.requestOverheadTokens,
		totalTokens,
		budgetTokens,
		longestQuestionId,
		longestQuestionTokens: longestQuestion,
		widestPathTokens: widestPath,
		budgetWidestPathTokens: budgetWidestPath,
		perQuestion,
		questionCount: Object.keys(questions ?? {}).length,
		limits,
		withinBudget: warnings.length === 0,
		warnings
	};
}

/**
 * @typedef {Object} JevEstimate
 * @property {number} stateTokens
 * @property {number} questionTokens
 * @property {number} overheadTokens
 * @property {number} totalTokens nominal estimate of `input_tokens`; what cost is based on
 * @property {number} budgetTokens `totalTokens` with the safety margin; what the check uses
 * @property {string|null} longestQuestionId
 * @property {number} longestQuestionTokens
 * @property {number} widestPathTokens state + longest question, against the 32k budget
 * @property {number} budgetWidestPathTokens the same, with the safety margin
 * @property {Object.<string, number>} perQuestion
 * @property {number} questionCount
 * @property {import('./models.js').JevModelLimits} limits
 * @property {boolean} withinBudget
 * @property {string[]} warnings
 */

/**
 * `JSON.stringify` that survives cycles and BigInt rather than throwing. An
 * estimator must never be the thing that breaks a call.
 *
 * @param {any} value
 * @returns {string}
 */
function safeStringify(value) {
	const seen = new WeakSet();
	try {
		return JSON.stringify(value, (_key, v) => {
			if (typeof v === 'bigint') return String(v);
			if (v && typeof v === 'object') {
				if (seen.has(v)) return '[Circular]';
				seen.add(v);
			}
			return v;
		}) ?? '';
	} catch {
		return String(value);
	}
}
