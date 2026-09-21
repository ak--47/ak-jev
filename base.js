/**
 * @fileoverview BaseJev — the shared machinery under every ak-jev class.
 *
 * One evaluation call is: take a `state` and a map of typed `questions`, send
 * them together, get one typed answer per question back. Everything else here
 * (cache, governor, usage, cost, pre-flight limits) exists so that the call is
 * cheap to make a thousand times.
 */

import 'dotenv/config';

import { JevClient } from './client.js';
import { Governor } from './governor.js';
import { ResponseCache, cacheKey, resolveCache } from './cache.js';
import { enrichAnswers, DEFAULT_THRESHOLDS } from './answers.js';
import {
	expandQuestions,
	questionMeta,
	toWireQuestions,
	validateQuestions
} from './questions.js';
import { estimateRequest } from './tokens.js';
import {
	DEFAULT_MODEL,
	computeCost,
	resolveLimits,
	resolvePricing
} from './models.js';
import { JevConfigError, JevValidationError } from './errors.js';
import log from './logger.js';

/**
 * Shared base. Subclasses add a shape on top of `evaluate()`; none of them
 * replace it.
 */
class BaseJev {
	/**
	 * @param {JevOptions} [options={}]
	 */
	constructor(options = {}) {
		const o = normalizeOptions(options);

		/** @type {string} The model name sent on the wire. */
		this.modelName = o.modelName;
		/** @type {string} */
		this.baseURL = o.baseURL;
		/** @type {Required<import('./answers.js').JevThresholds>} */
		this.thresholds = o.thresholds;
		/** @type {boolean} */
		this.validate = o.validate;
		/** @type {boolean} */
		this.checkBudget = o.checkBudget;
		/** @type {boolean} */
		this.healthCheck = o.healthCheck;
		/** @type {((result: any) => void)|undefined} */
		this.onResult = o.onResult;

		if (o.logLevel) log.level = o.logLevel === 'none' ? 'silent' : o.logLevel;

		/** @type {Governor} */
		this.governor = new Governor({
			concurrency: o.concurrency,
			requestsPerMinute: o.requestsPerMinute,
			tokensPerSecond: o.tokensPerSecond
		});

		/** @type {ResponseCache|null} */
		this.cache = resolveCache(o.cache);

		/** @type {JevClient} */
		this.client = new JevClient({
			apiKey: o.apiKey,
			baseURL: o.baseURL,
			timeout: o.timeout,
			retry: o.retry,
			defaultHeaders: o.defaultHeaders,
			fetch: o.fetch,
			governor: this.governor
		});

		this._initialized = false;
		/** @type {JevUsage|null} */
		this._lastUsage = null;
		this._totalUsage = emptyUsage();
		this._cacheHits = 0;
		this._cacheMisses = 0;
	}

	/**
	 * Resolve configuration and, when `healthCheck` is on, confirm the key works
	 * before the first evaluation. Called lazily by `evaluate()`; call it yourself
	 * at startup to fail fast.
	 *
	 * @returns {Promise<this>}
	 */
	async init() {
		if (this._initialized) return this;
		if (this.healthCheck) {
			const models = await this.client.models();
			log.debug({ models: models.map((m) => m.name) }, 'ak-jev: health check passed');
		}
		this._initialized = true;
		return this;
	}

	/**
	 * Evaluate one state against a set of questions.
	 *
	 * Send every question you might need in one call. They are answered in
	 * parallel against the same state, latency is roughly flat in question count
	 * (measured: 1 question 327 ms, 500 questions 461 ms), and you pay only for the
	 * extra question tokens. Asking a question you might not use is close to free.
	 *
	 * @param {any} state a string, or a JSON object/array of related context
	 * @param {Object.<string, any>} questions keyed by the ids you want answers under
	 * @param {JevEvaluateOptions} [opts={}]
	 * @returns {Promise<JevResult>}
	 *
	 * @example
	 * const { answers } = await jev.evaluate(ticket, {
	 *   urgent: noul('Does this convey urgency?'),
	 *   team: choice('Who handles this?', ['billing', 'technical', 'sales']),
	 *   anger: score('How angry?', ['Calm', 'Annoyed', 'Furious'])
	 * });
	 * if (answers.urgent.yes && answers.team.confidence > 0.7) page(answers.team.choice);
	 */
	async evaluate(state, questions, opts = {}) {
		if (!this._initialized) await this.init();

		const prepared = this._prepare(state, questions, opts);
		const model = opts.model ?? this.modelName;
		const body = { state, model, questions: prepared.wire };

		const useCache = this.cache && !opts._bypassCache;
		const key = useCache ? cacheKey({ baseURL: this.baseURL, model, state, questions: prepared.wire }) : null;
		if (key) {
			const hit = this.cache?.get(key);
			if (hit) {
				this._cacheHits++;
				const result = this._buildResult(hit, {
					prepared,
					requestedModel: model,
					cached: true,
					latencyMs: 0,
					requestId: undefined
				});
				this.onResult?.(result);
				return result;
			}
			this._cacheMisses++;
		}

		const { data, requestId, latencyMs } = await this.client.systemOne(body, {
			signal: opts.signal,
			timeout: opts.timeout,
			retry: opts.retry,
			headers: opts.headers,
			estimatedTokens: prepared.estimate.totalTokens
		});

		if (key) this.cache?.set(key, data);

		const result = this._buildResult(data, {
			prepared,
			requestedModel: model,
			cached: false,
			latencyMs,
			requestId
		});
		this.onResult?.(result);
		return result;
	}

	/**
	 * Evaluate many states against the same questions, in parallel, paced by the
	 * governor.
	 *
	 * Results come back in the order the states were given, regardless of which
	 * finished first. A failure is captured rather than thrown unless
	 * `throwOnError` is set, so one bad row does not lose a whole corpus.
	 *
	 * @param {any[]} states
	 * @param {Object.<string, any>} questions
	 * @param {JevEvaluateManyOptions} [opts={}]
	 * @returns {Promise<Array<JevResult|JevFailure>>}
	 */
	async evaluateMany(states, questions, opts = {}) {
		if (!Array.isArray(states)) {
			throw new JevValidationError('evaluateMany() needs an array of states.');
		}
		if (!this._initialized) await this.init();

		const total = states.length;
		let done = 0;
		/** @type {Array<JevResult|JevFailure>} */
		const out = new Array(total);

		await Promise.all(
			states.map(async (state, index) => {
				try {
					out[index] = await this.evaluate(state, questions, opts);
				} catch (error) {
					if (opts.throwOnError) throw error;
					out[index] = { index, error: /** @type {Error} */ (error), failed: true };
				} finally {
					done++;
					opts.onProgress?.({ done, total, index });
				}
			})
		);

		return out;
	}

	/**
	 * Run the same evaluation several times and report the spread.
	 *
	 * Jev is consistent but not deterministic. Twelve byte-identical requests,
	 * measured 2026-09-21, returned six distinct score values across a range of
	 * 0.08. When a decision sits near one of your thresholds, that matters, and the
	 * honest way to find out is to sample.
	 *
	 * Always bypasses the cache — a cached sample would make every draw identical
	 * and the answer would look far more stable than it is.
	 *
	 * @param {any} state
	 * @param {Object.<string, any>} questions
	 * @param {JevEvaluateOptions & {n?: number}} [opts={}]
	 * @returns {Promise<JevSampleResult>}
	 *
	 * @example
	 * const s = await jev.sample(ticket, { refund: noul('Do they want a refund?') }, { n: 7 });
	 * s.summary.refund.spread     // 0.06 — the model is not sure, and says so consistently
	 * s.summary.refund.agreement  // 0.71 — 5 of 7 draws agreed on the verdict
	 * if (s.summary.refund.agreement < 0.9) sendToHuman(ticket);
	 */
	async sample(state, questions, opts = {}) {
		const n = Math.max(1, Math.floor(opts.n ?? 5));
		const draws = await Promise.all(
			Array.from({ length: n }, () =>
				// `cache: false` is not enough here — the instance may have one. Pass a
				// per-call marker that `evaluate()` honours.
				this.evaluate(state, questions, { ...opts, _bypassCache: true })
			)
		);
		return { n, samples: draws, summary: summarizeDraws(draws) };
	}

	/**
	 * Send a request body through unchanged, and get the raw response back with no
	 * enrichment. The escape hatch for anything this package has not modelled yet.
	 *
	 * @param {{state: any, model?: string, questions: Object}} body
	 * @param {import('./client.js').JevRequestOptions} [opts={}]
	 * @returns {Promise<any>}
	 */
	async raw(body, opts = {}) {
		if (!this._initialized) await this.init();
		const { data } = await this.client.systemOne(
			{ model: this.modelName, ...body },
			opts
		);
		return data;
	}

	/**
	 * The models this key can use.
	 * @param {import('./client.js').JevRequestOptions} [opts={}]
	 * @returns {Promise<Array<{name: string, description: string, release_date: string}>>}
	 */
	async listModels(opts = {}) {
		return this.client.models(opts);
	}

	/**
	 * Estimate the token cost of a call without making it.
	 *
	 * Checks both budgets — the 64k total and the tighter 32k for state plus the
	 * single longest question. A modest state with one enormous question passes the
	 * first and fails the second.
	 *
	 * @param {any} state
	 * @param {Object.<string, any>} questions
	 * @param {{model?: string}} [opts={}]
	 * @returns {import('./tokens.js').JevEstimate & {estimatedCost: number|null}}
	 */
	estimate(state, questions, opts = {}) {
		const expanded = expandQuestions(questions);
		const wire = toWireQuestions(expanded);
		const model = opts.model ?? this.modelName;
		const est = estimateRequest({ state, questions: wire, model });
		return {
			...est,
			estimatedCost: computeCost({ inputTokens: est.totalTokens, outputTokens: 0 }, model)
		};
	}

	/**
	 * Estimated USD for a call, without making it. Output tokens are free on this
	 * API, so only the input estimate matters.
	 *
	 * @param {any} state
	 * @param {Object.<string, any>} questions
	 * @param {{model?: string}} [opts={}]
	 * @returns {number|null} `null` means unknown, never free.
	 */
	estimateCost(state, questions, opts = {}) {
		return this.estimate(state, questions, opts).estimatedCost;
	}

	/**
	 * Usage from the most recent evaluation on this instance.
	 * @returns {JevUsage|null}
	 */
	getLastUsage() {
		return this._lastUsage;
	}

	/**
	 * Usage accumulated over every evaluation this instance has made.
	 * @returns {JevUsage}
	 */
	getTotalUsage() {
		return { ...this._totalUsage };
	}

	/** Reset the cumulative usage counters. Does not clear the cache. */
	resetUsage() {
		this._totalUsage = emptyUsage();
		this._lastUsage = null;
	}

	/**
	 * Everything this instance has done: requests, retries, cache, throttling, spend.
	 * @returns {JevStats}
	 */
	stats() {
		return {
			requests: this.client.counters.requests,
			retries: this.client.counters.retries,
			failures: this.client.counters.failures,
			cacheHits: this._cacheHits,
			cacheMisses: this._cacheMisses,
			cacheSize: this.cache?.size ?? 0,
			usage: this.getTotalUsage(),
			governor: this.governor.snapshot()
		};
	}

	/** The hard limits for the configured model. */
	limits() {
		return resolveLimits(this.modelName);
	}

	/** Per-million-token rates for the configured model, or `null` if unknown. */
	pricing() {
		return resolvePricing(this.modelName);
	}

	// ── internals ─────────────────────────────────────────────────────────────

	/**
	 * Expand shorthand, validate against the API's hard limits, collect client-side
	 * metadata, and estimate the request.
	 *
	 * @param {any} state
	 * @param {Object.<string, any>} questions
	 * @param {JevEvaluateOptions} opts
	 * @returns {{expanded: Object, wire: Object, meta: Object, estimate: import('./tokens.js').JevEstimate}}
	 */
	_prepare(state, questions, opts) {
		const expanded = expandQuestions(questions);
		const model = opts.model ?? this.modelName;

		if (this.validate) {
			const { warnings } = validateQuestions(expanded, { model });
			for (const w of warnings) log.warn(`ak-jev: ${w}`);
		}

		/** @type {Object.<string, {levelNames?: string[]}>} */
		const meta = {};
		for (const [id, q] of Object.entries(expanded)) {
			const m = questionMeta(q);
			if (m.levelNames) meta[id] = m;
		}

		const wire = toWireQuestions(expanded);
		const estimate = estimateRequest({ state, questions: wire, model });

		if (this.checkBudget && !estimate.withinBudget) {
			for (const w of estimate.warnings) log.warn(`ak-jev: ${w}`);
		}

		return { expanded, wire, meta, estimate };
	}

	/**
	 * Turn a raw API body into the enriched result, and fold its usage into the
	 * running totals.
	 *
	 * @param {any} data
	 * @param {Object} ctx
	 * @returns {JevResult}
	 */
	_buildResult(data, { prepared, requestedModel, cached, latencyMs, requestId }) {
		const answers = enrichAnswers(data?.answers ?? {}, {
			thresholds: this.thresholds,
			meta: prepared.meta
		});

		const inputTokens = data?.usage?.input_tokens ?? 0;
		const outputTokens = data?.usage?.output_tokens ?? 0;
		const model = data?.model ?? requestedModel;

		/** @type {JevUsage} */
		const usage = {
			inputTokens,
			outputTokens,
			totalTokens: inputTokens + outputTokens,
			// A cache hit costs nothing because no request was made. It is reported
			// as 0 with `cached: true`, never silently folded into the estimate.
			estimatedCost: cached ? 0 : computeCost({ inputTokens, outputTokens }, model),
			// This API returns no cost header, so every non-cached figure is a
			// table estimate. Named for parity with the sibling packages.
			costSource: cached ? 'cached' : 'estimated',
			requests: cached ? 0 : 1,
			cached,
			questions: prepared.estimate.questionCount
		};

		this._lastUsage = usage;
		accumulate(this._totalUsage, usage);

		return {
			answers,
			model,
			requestedModel,
			usage,
			requestId,
			latencyMs,
			cached
		};
	}
}

/**
 * Normalize and default the constructor options.
 * @param {JevOptions} raw
 */
export function normalizeOptions(raw = {}) {
	// `model` is what the API calls it; `modelName` is what the sibling packages
	// call it. Accept both rather than make anyone remember which.
	const modelName = raw.modelName ?? raw.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL;

	if (raw.thresholds) {
		for (const k of Object.keys(raw.thresholds)) {
			if (!['yes', 'high', 'low'].includes(k)) {
				throw new JevConfigError(
					`Unknown threshold "${k}". Valid keys are: yes, high, low.`
				);
			}
		}
	}

	return {
		modelName,
		apiKey: raw.apiKey,
		baseURL: (raw.baseURL ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, ''),
		timeout: raw.timeout,
		retry: raw.retry,
		defaultHeaders: raw.defaultHeaders,
		fetch: raw.fetch,
		logLevel: raw.logLevel,
		healthCheck: raw.healthCheck ?? false,
		thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
		validate: raw.validate ?? true,
		checkBudget: raw.checkBudget ?? true,
		// Off by default: the API is consistent but not deterministic, so a cache
		// entry is a memo of one sample. See the header of cache.js.
		cache: raw.cache ?? false,
		concurrency: raw.concurrency,
		requestsPerMinute: raw.requestsPerMinute,
		tokensPerSecond: raw.tokensPerSecond,
		onResult: raw.onResult
	};
}

/**
 * Collapse repeated draws of the same request into per-question statistics.
 *
 * All arithmetic is in JavaScript. Jev is explicitly not a calculator, and asking
 * it to summarize its own variance would be both circular and wrong.
 *
 * @param {JevResult[]} draws
 * @returns {Object.<string, any>}
 */
function summarizeDraws(draws) {
	/** @type {Object.<string, any>} */
	const summary = {};
	const ids = Object.keys(draws[0]?.answers ?? {});

	for (const id of ids) {
		const answers = draws.map((d) => d.answers[id]).filter(Boolean);
		if (answers.length === 0) continue;
		const type = answers[0].type;

		if (type === 'noul') {
			const values = answers.map((a) => a.noul);
			summary[id] = {
				type,
				...spread(values),
				values,
				// How often the draws landed on the same three-way verdict.
				...modeAgreement(answers.map((a) => a.verdict), 'verdict')
			};
		} else if (type === 'choice') {
			const confidences = answers.map((a) => a.confidence);
			summary[id] = {
				type,
				...modeAgreement(answers.map((a) => a.choice), 'choice'),
				confidence: spread(confidences),
				values: answers.map((a) => a.choice)
			};
		} else if (type === 'score') {
			const values = answers.map((a) => a.score);
			summary[id] = {
				type,
				...spread(values),
				values,
				...modeAgreement(answers.map((a) => String(a.level)), 'level')
			};
		}
	}
	return summary;
}

/**
 * @param {number[]} values
 * @returns {{mean: number, min: number, max: number, spread: number, stdev: number}}
 */
function spread(values) {
	const min = Math.min(...values);
	const max = Math.max(...values);
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
	return { mean, min, max, spread: max - min, stdev: Math.sqrt(variance) };
}

/**
 * The most common value, and the fraction of draws that agreed with it.
 * @param {string[]} values
 * @param {string} key what to call the winning value in the result
 */
function modeAgreement(values, key) {
	/** @type {Object.<string, number>} */
	const counts = {};
	for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
	const [winner, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	return { [key]: winner, agreement: count / values.length, counts };
}

/** @returns {JevUsage} */
function emptyUsage() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		estimatedCost: 0,
		costSource: 'estimated',
		requests: 0,
		cached: false,
		questions: 0
	};
}

/**
 * @param {JevUsage} total
 * @param {JevUsage} one
 */
function accumulate(total, one) {
	total.inputTokens += one.inputTokens;
	total.outputTokens += one.outputTokens;
	total.totalTokens += one.totalTokens;
	total.requests += one.requests;
	total.questions += one.questions;
	if (one.estimatedCost !== null && total.estimatedCost !== null) {
		total.estimatedCost += one.estimatedCost;
	} else {
		// One unknown rate makes the running total unknown. Reporting a partial sum
		// as if it were complete would understate spend.
		total.estimatedCost = null;
	}
}

/**
 * @typedef {Object} JevOptions
 * @property {string} [modelName='jev-latest'] also accepted as `model`
 * @property {string} [model]
 * @property {string} [apiKey] falls back to `TYPESAFE_API_KEY`
 * @property {string} [baseURL] falls back to `TYPESAFE_BASE_URL`
 * @property {number} [timeout=30000] per attempt, ms
 * @property {Object} [retry] overrides for the retry policy
 * @property {Object.<string,string>} [defaultHeaders]
 * @property {typeof fetch} [fetch] custom transport, for tests or proxies
 * @property {'trace'|'debug'|'info'|'warn'|'error'|'fatal'|'silent'|'none'} [logLevel]
 * @property {boolean} [healthCheck=false] verify the key on `init()`
 * @property {import('./answers.js').JevThresholds} [thresholds] Noul decision points
 * @property {boolean} [validate=true] check questions against the API's hard limits first
 * @property {boolean} [checkBudget=true] warn when a request looks too large
 * @property {boolean|Object|ResponseCache} [cache=false] response cache, OFF by default
 *   because the API is consistent but not deterministic; `{dir}` persists it to disk
 * @property {number} [concurrency=8]
 * @property {number} [requestsPerMinute=1000]
 * @property {number} [tokensPerSecond=200000]
 * @property {(result: JevResult) => void} [onResult] called after every evaluation
 */

/**
 * @typedef {Object} JevEvaluateOptions
 * @property {string} [model] override the model for this call
 * @property {AbortSignal} [signal]
 * @property {number} [timeout]
 * @property {Object} [retry]
 * @property {Object.<string,string>} [headers]
 * @property {boolean} [_bypassCache] internal; used by `sample()`
 */

/**
 * @typedef {Object} JevSampleResult
 * @property {number} n how many draws were taken
 * @property {JevResult[]} samples every draw, in full
 * @property {Object.<string, any>} summary per-question spread and agreement
 */

/**
 * @typedef {JevEvaluateOptions & {
 *   onProgress?: (p: {done: number, total: number, index: number}) => void,
 *   throwOnError?: boolean
 * }} JevEvaluateManyOptions
 */

/**
 * @typedef {Object} JevUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 * @property {number|null} estimatedCost USD; `null` means unknown, never free
 * @property {'estimated'|'cached'} costSource
 * @property {number} requests API round trips; 0 for a cache hit
 * @property {boolean} cached
 * @property {number} questions
 */

/**
 * @typedef {Object} JevResult
 * @property {Object.<string, any>} answers enriched, keyed by question id
 * @property {string} model the versioned model that answered
 * @property {string} requestedModel what was sent, which may be an alias
 * @property {JevUsage} usage
 * @property {string|undefined} requestId `x-typesafe-request-id`
 * @property {number} latencyMs
 * @property {boolean} cached
 */

/**
 * @typedef {Object} JevFailure
 * @property {number} index
 * @property {Error} error
 * @property {true} failed
 */

/**
 * @typedef {Object} JevStats
 * @property {number} requests
 * @property {number} retries
 * @property {number} failures
 * @property {number} cacheHits
 * @property {number} cacheMisses
 * @property {number} cacheSize
 * @property {JevUsage} usage
 * @property {Object} governor
 */

export default BaseJev;
