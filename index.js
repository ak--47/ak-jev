/**
 * @fileoverview ak-jev — Node.js bindings for TypeSafe's Jev, the System One model.
 *
 * Jev is not a chat model. You send a `state` and a map of typed `questions`, and
 * you get back one typed answer per question: a probability, a label with a
 * distribution, or a position on a rubric. No prose, no parsing, no schema
 * coaxing. Your code branches on the numbers directly.
 *
 * ```javascript
 * import { ask, noul, choice, score } from 'ak-jev';
 *
 * const { answers } = await ask(ticket, {
 *   urgent: noul('Does this convey urgency?'),
 *   team:   choice('Who handles this?', ['billing', 'technical', 'sales']),
 *   anger:  score('How angry is the customer?', ['Calm', 'Annoyed', 'Furious'])
 * });
 *
 * if (answers.urgent.yes && answers.team.confidence > 0.7) page(answers.team.choice);
 * ```
 *
 * Nine classes sit on top of that one call, one per usage shape. See the README.
 */

// ── Classes ──────────────────────────────────────────────────────────────────
export { default as Evaluator } from './evaluator.js';
export { default as Classifier } from './classifier.js';
export { default as Detector } from './detector.js';
export { default as Scorer } from './scorer.js';
export { default as Router } from './router.js';
export { default as Ranker } from './ranker.js';
export { default as Extractor } from './extractor.js';
export { default as Taxonomy } from './taxonomy.js';
export { default as Guard } from './guard.js';

// ── Base class ───────────────────────────────────────────────────────────────
export { default as BaseJev } from './base.js';
export { normalizeOptions } from './base.js';

// ── Question builders ────────────────────────────────────────────────────────
export {
	noul,
	choice,
	score,
	expandQuestions,
	toWireQuestions,
	validateQuestions,
	questionMeta,
	QUESTION_TYPES,
	QUESTION_META
} from './questions.js';

// ── Answer helpers ───────────────────────────────────────────────────────────
export {
	enrichAnswer,
	enrichAnswers,
	rank,
	normalizedEntropy,
	DEFAULT_THRESHOLDS
} from './answers.js';

// ── Models, pricing, limits ──────────────────────────────────────────────────
export {
	MODEL_PRICING,
	MODEL_PRICING_AS_OF,
	MODEL_ALIASES,
	MODEL_LIMITS,
	DEFAULT_MODEL,
	DEFAULT_BASE_URL,
	LITELLM_DEFAULT_ROOT,
	PROVIDERS,
	DEFAULT_PROVIDER,
	resolveProvider,
	SYSTEM_ONE_PATH,
	MODELS_PATH,
	resolveModelId,
	resolvePricing,
	resolveLimits,
	computeCost,
	listModels
} from './models.js';

// ── Token estimation ─────────────────────────────────────────────────────────
export {
	estimateTokens,
	estimateQuestionTokens,
	estimateRequest,
	BUDGET_SAFETY_MARGIN
} from './tokens.js';

// ── Transport, cache, governor — exported for tests and for advanced callers ──
export { JevClient, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, backoffDelay, gatewayMeta } from './client.js';
export { ResponseCache, resolveCache, cacheKey, canonicalize } from './cache.js';
export { Governor, sleep } from './governor.js';

// ── Errors ───────────────────────────────────────────────────────────────────
export {
	JevError,
	JevConfigError,
	JevValidationError,
	JevConnectionError,
	JevTimeoutError,
	JevAbortError,
	JevAPIError,
	JevAuthError,
	JevBadRequestError,
	JevRequestTooLargeError,
	JevNotFoundError,
	JevPermissionError,
	JevUnprocessableError,
	JevRateLimitError,
	JevOverloadedError,
	JevServerError,
	describeDetail,
	errorFromResponse,
	parseRetryAfter
} from './errors.js';

export { JevGuardError, GUARD_ACTIONS } from './guard.js';
export { NOT_STATED } from './extractor.js';

// ── Utilities ────────────────────────────────────────────────────────────────
export { default as log } from './logger.js';

import BaseJev from './base.js';
import { computeCost, resolveProvider } from './models.js';
import { expandQuestions, toWireQuestions } from './questions.js';
import { estimateRequest } from './tokens.js';
import Evaluator from './evaluator.js';
import Classifier from './classifier.js';
import Detector from './detector.js';
import Scorer from './scorer.js';
import Router from './router.js';
import Ranker from './ranker.js';
import Extractor from './extractor.js';
import Taxonomy from './taxonomy.js';
import Guard from './guard.js';

/**
 * A shared client for the one-liner helpers below, built on first use. Reusing it
 * means `ask()` gets the response cache and the rate governor rather than
 * standing up a fresh client per call.
 * @type {BaseJev|null}
 */
let shared = null;

/**
 * The default client used by `ask()` and `models()`.
 *
 * @param {import('./base.js').JevOptions} [options] applied only when the client
 *   does not exist yet; pass them to build it with non-default settings
 * @returns {BaseJev}
 */
export function client(options) {
	if (!shared) shared = new BaseJev(options ?? {});
	return shared;
}

/**
 * Drop the shared client. The next `ask()` builds a fresh one, which is what you
 * want after changing `TYPESAFE_API_KEY` or between test cases.
 */
export function resetClient() {
	shared = null;
}

/**
 * Ask questions about a state, with no setup.
 *
 * The one-liner entry point. For anything you call more than once, build an
 * `Evaluator` instead — it binds the question set so you are not rebuilding it
 * per item.
 *
 * @param {any} state a string, or a JSON object/array of related context
 * @param {Object.<string, any>} questions keyed by the ids you want answers under;
 *   a bare string is shorthand for a Noul
 * @param {import('./base.js').JevEvaluateOptions & import('./base.js').JevOptions} [opts={}]
 * @returns {Promise<import('./base.js').JevResult>}
 *
 * @example
 * const { answers } = await ask('My card was charged twice.', {
 *   billing: 'Is this about billing?',
 *   urgency: score('How urgent is this?', ['Whenever', 'Soon', 'Right now'])
 * });
 */
export async function ask(state, questions, opts = {}) {
	return client(opts).evaluate(state, questions, opts);
}

/**
 * List the models this key can use.
 * @param {import('./base.js').JevOptions} [opts={}]
 * @returns {Promise<Array<{name: string, description: string, release_date: string}>>}
 */
export async function models(opts = {}) {
	return client(opts).listModels();
}

/**
 * Token and cost estimate for a request, without a client and without an API key.
 *
 * Synchronous and free. `BaseJev.estimate()` does the same thing, but building a
 * `BaseJev` requires a key, and "how big is this?" is a question worth answering
 * before you have configured anything.
 *
 * @param {any} state
 * @param {Object.<string, any>} questions
 * @param {{model?: string, provider?: string}} [opts={}]
 * @returns {import('./tokens.js').JevEstimate & {estimatedCost: number|null}}
 *
 * @example
 * import { estimate, noul } from 'ak-jev';
 *
 * const e = estimate(bigDocument, { relevant: noul('Is this about GDPR?') });
 * if (!e.withinBudget) console.warn(e.warnings.join('\n'));
 * console.log(`~$${(e.estimatedCost * corpus.length).toFixed(2)} for the whole corpus`);
 */
export function estimate(state, questions, opts = {}) {
	const provider = resolveProvider(opts.provider);
	const model = opts.model ?? provider.defaultModel;
	const wire = toWireQuestions(expandQuestions(questions));
	const est = estimateRequest({ state, questions: wire, model: provider.limitsModel ?? model });
	return {
		...est,
		estimatedCost: computeCost({ inputTokens: est.totalTokens, outputTokens: 0 }, model)
	};
}

/**
 * Ask the same questions `n` times and report the spread.
 *
 * Jev is consistent but not deterministic: twelve identical requests, measured
 * 2026-09-21, returned six distinct scores spanning 0.08. When a decision sits
 * near one of your thresholds, sample it rather than trusting one draw.
 *
 * @param {any} state
 * @param {Object.<string, any>} questions
 * @param {import('./base.js').JevEvaluateOptions & import('./base.js').JevOptions & {n?: number}} [opts={}]
 * @returns {Promise<import('./base.js').JevSampleResult>}
 *
 * @example
 * const s = await sample(ticket, { refund: noul('Do they want a refund?') }, { n: 7 });
 * if (s.summary.refund.agreement < 0.9) sendToHuman(ticket);
 */
export async function sample(state, questions, opts = {}) {
	return client(opts).sample(state, questions, opts);
}

export default {
	Evaluator,
	Classifier,
	Detector,
	Scorer,
	Router,
	Ranker,
	Extractor,
	Taxonomy,
	Guard,
	ask,
	sample,
	estimate,
	models,
	client,
	resetClient
};
