/**
 * @fileoverview Router — the Intent Routing and Confidence-Gated Routing patterns.
 *
 * Classify the request, then hand it to the handler for that route. The part
 * worth automating is the gate: different actions in the same system deserve
 * different confidence bars, because the cost of being wrong is different.
 * Showing the wrong screen is recoverable; approving the wrong transfer is not.
 *
 * So every route carries its own `minConfidence`, and anything that does not
 * clear its own bar goes to the fallback.
 */

import BaseJev from './base.js';
import { choice } from './questions.js';
import { expandQuestions } from './questions.js';
import { JevValidationError } from './errors.js';
import log from './logger.js';

/**
 * Route a state to one of several handlers, gated on confidence.
 *
 * @example
 * import { Router, score } from 'ak-jev';
 *
 * const router = new Router({
 *   instructions: 'What is the user trying to do?',
 *   routes: {
 *     check_balance:    { description: 'View account balance',   minConfidence: 0.6,  handler: showBalance },
 *     approve_transfer: { description: 'Approve the withdrawal', minConfidence: 0.85, handler: approveTransfer },
 *     support:          { description: 'Get help with an issue', minConfidence: 0.6,  handler: openTicket }
 *   },
 *   fallback: routeToHuman,
 *   // Rides along in the same request; every handler can read it.
 *   questions: { complexity: score('How complex is this request?', ['Simple', 'Involved', 'Needs a specialist']) }
 * });
 *
 * const out = await router.route(command, { accountId });
 * out.route    // 'approve_transfer', or null when nothing cleared its bar
 * out.value    // whatever the handler returned
 */
class Router extends BaseJev {
	/**
	 * @param {RouterOptions} options
	 */
	constructor(options = /** @type {any} */ ({})) {
		super(options);

		const routes = options.routes;
		if (!routes || typeof routes !== 'object' || Object.keys(routes).length === 0) {
			throw new JevValidationError(
				'Router needs { routes }: an object of name -> { description, handler, minConfidence }.'
			);
		}

		/** @type {Object.<string, any>} */
		this.routes = {};
		/** @type {Object.<string, any>} */
		const criteria = {};

		for (const [name, spec] of Object.entries(routes)) {
			const normalized = typeof spec === 'function'
				? { handler: spec, description: null }
				: typeof spec === 'string'
					? { handler: undefined, description: spec }
					: spec;

			if (!normalized || typeof normalized !== 'object') {
				throw new JevValidationError(`Route "${name}" must be an object, a handler function, or a description string.`);
			}
			if (normalized.handler !== undefined && typeof normalized.handler !== 'function') {
				throw new JevValidationError(`Route "${name}" has a handler that is not a function.`);
			}

			this.routes[name] = {
				handler: normalized.handler,
				minConfidence: normalized.minConfidence ?? options.minConfidence ?? 0
			};
			criteria[name] = normalized.description ?? null;
		}

		/** @type {string} */
		this.instructions = options.instructions ?? 'Which of these best describes what is being asked for?';
		/** @type {string} */
		this.questionId = options.questionId ?? 'route';
		/** @type {any} */
		this.question = choice(this.instructions, criteria);
		/** @type {Function|undefined} */
		this.fallback = options.fallback;
		/** @type {boolean} Call the handler, or just return the decision. */
		this.dispatch = options.dispatch ?? true;
		/** @type {Object.<string, any>} Extra questions carried in the same request. */
		this.extraQuestions = options.questions ? expandQuestions(options.questions) : {};

		if (this.fallback !== undefined && typeof this.fallback !== 'function') {
			throw new JevValidationError('Router { fallback } must be a function.');
		}

		log.debug({ routes: Object.keys(this.routes).length }, 'ak-jev: Router created');
	}

	/**
	 * Classify and, unless `dispatch` is off, run the matching handler.
	 *
	 * The handler is called with one context object:
	 * `{ state, route, confidence, answers, classification, extra }`.
	 *
	 * @param {any} state
	 * @param {any} [extra] anything your handlers need — an id, a db handle, a request
	 * @param {import('./base.js').JevEvaluateOptions & {dispatch?: boolean}} [opts={}]
	 * @returns {Promise<Routing>}
	 */
	async route(state, extra = undefined, opts = {}) {
		const questions = { [this.questionId]: this.question, ...this.extraQuestions };
		const result = await this.evaluate(state, questions, opts);

		const answer = result.answers[this.questionId];
		const name = answer.choice;
		const spec = this.routes[name];
		const confidence = answer.confidence;
		const cleared = Boolean(spec) && confidence >= spec.minConfidence;

		/** @type {Routing} */
		const routing = {
			route: cleared ? name : null,
			choice: name,
			decided: cleared,
			confidence,
			required: spec ? spec.minConfidence : null,
			probabilities: answer.probabilities,
			ranked: answer.ranked,
			runnerUp: answer.runnerUp,
			margin: answer.margin,
			answers: result.answers,
			usage: result.usage,
			cached: result.cached,
			requestId: result.requestId,
			handled: false,
			value: undefined
		};

		const shouldDispatch = opts.dispatch ?? this.dispatch;
		if (!shouldDispatch) return routing;

		const ctx = {
			state,
			extra,
			route: routing.route,
			confidence,
			answers: result.answers,
			classification: routing
		};

		if (cleared && spec.handler) {
			routing.value = await spec.handler(ctx);
			routing.handled = true;
			return routing;
		}

		if (this.fallback) {
			routing.value = await this.fallback(ctx);
			routing.handled = true;
			routing.fellBack = true;
			return routing;
		}

		// No handler and no fallback. Return the decision rather than throw — a
		// Router used purely as a classifier is a legitimate way to use it.
		log.debug({ route: name, confidence, cleared }, 'ak-jev: Router had no handler to run');
		return routing;
	}

	/**
	 * Route many states in parallel. Handlers run as each classification lands.
	 *
	 * @param {any[]} states
	 * @param {import('./base.js').JevEvaluateManyOptions & {extraFor?: (state: any, index: number) => any}} [opts={}]
	 * @returns {Promise<Array<Routing|import('./base.js').JevFailure>>}
	 */
	async routeMany(states, opts = {}) {
		if (!Array.isArray(states)) throw new JevValidationError('routeMany() needs an array of states.');
		/** @type {Array<any>} */
		const out = new Array(states.length);
		let done = 0;

		await Promise.all(
			states.map(async (state, index) => {
				try {
					out[index] = await this.route(state, opts.extraFor?.(state, index), opts);
				} catch (error) {
					if (opts.throwOnError) throw error;
					out[index] = { index, error, failed: true };
				} finally {
					done++;
					opts.onProgress?.({ done, total: states.length, index });
				}
			})
		);

		return out;
	}
}

/**
 * @typedef {Object} RouteSpec
 * @property {any} [description] what this route covers; sharpens the boundary with its neighbours
 * @property {Function} [handler] called with the routing context when this route wins and clears its bar
 * @property {number} [minConfidence] this route's own bar; defaults to the Router's
 */

/**
 * @typedef {import('./base.js').JevOptions & {
 *   routes: Object.<string, RouteSpec|Function|string>,
 *   instructions?: string,
 *   fallback?: Function,
 *   minConfidence?: number,
 *   dispatch?: boolean,
 *   questions?: Object.<string, any>,
 *   questionId?: string
 * }} RouterOptions
 */

/**
 * @typedef {Object} Routing
 * @property {string|null} route the route that will run, or null when nothing cleared its bar
 * @property {string} choice what the model picked, before the gate
 * @property {boolean} decided
 * @property {number} confidence
 * @property {number|null} required the bar this route had to clear
 * @property {Object.<string, number>} probabilities
 * @property {Array<{label: string, probability: number}>} ranked
 * @property {{label: string, probability: number}|null} runnerUp
 * @property {number} margin
 * @property {Object.<string, any>} answers
 * @property {import('./base.js').JevUsage} usage
 * @property {boolean} cached
 * @property {string|undefined} requestId
 * @property {boolean} handled whether a handler actually ran
 * @property {boolean} [fellBack] whether the fallback ran instead of a route handler
 * @property {any} value the handler's return value
 */

export default Router;
