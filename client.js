/**
 * @fileoverview HTTP transport for the TypeSafe API.
 *
 * Written on global `fetch` rather than on `@typesafe-ai/sdk`, deliberately. That
 * SDK is a thin fetch wrapper, and wrapping it would put the rate governor
 * outside the retry loop and hide the raw `Response` on the error path — the only
 * place the request id lives when a call fails. See the design spec, §3.
 *
 * Retry field names match their `RetryPolicy` exactly, so the two are
 * conceptually interchangeable.
 */

import {
	JevAbortError,
	JevConfigError,
	JevConnectionError,
	JevTimeoutError,
	JevRateLimitError,
	errorFromResponse
} from './errors.js';
import { DEFAULT_BASE_URL, MODELS_PATH, SYSTEM_ONE_PATH } from './models.js';
import { Governor, sleep } from './governor.js';
import log from './logger.js';

/**
 * Retry defaults. Same names and same values as the official SDK, except
 * `maxRetries`, which is 3 here rather than 2 — a 529 on this API is transient
 * and one more attempt costs nothing when the retried request is cheap.
 */
export const DEFAULT_RETRY = Object.freeze({
	maxRetries: 3,
	backoffInitialMs: 500,
	backoffMaxMs: 5000,
	backoffJitter: 0.25,
	httpStatuses: Object.freeze([408, 409, 429, 500, 502, 503, 504, 529]),
	respectRetryAfter: true,
	maxRetryAfterMs: 60_000,
	apiConnectionError: true,
	apiTimeoutError: true
});

/** Per-attempt timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Low-level client. One per `BaseJev` instance.
 */
export class JevClient {
	/**
	 * @param {Object} [config={}]
	 * @param {string} [config.apiKey] falls back to `TYPESAFE_API_KEY`, then `JEV_API_KEY`
	 * @param {string} [config.baseURL] falls back to `TYPESAFE_BASE_URL`, then the public API
	 * @param {number} [config.timeout] per attempt, ms
	 * @param {Partial<typeof DEFAULT_RETRY>} [config.retry]
	 * @param {Object.<string,string>} [config.defaultHeaders]
	 * @param {typeof fetch} [config.fetch]
	 * @param {Governor} [config.governor]
	 * @param {string} [config.userAgent]
	 */
	constructor(config = {}) {
		const apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
		if (!apiKey) {
			throw new JevConfigError(
				'No API key. Pass { apiKey } to the constructor, or set TYPESAFE_API_KEY ' +
					'in the environment. Get a key at https://console.typesafe.ai/keys'
			);
		}
		this.apiKey = apiKey;
		this.baseURL = (config.baseURL ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL)
			.replace(/\/+$/, '');
		this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
		this.retry = { ...DEFAULT_RETRY, ...(config.retry ?? {}) };
		this.defaultHeaders = { ...(config.defaultHeaders ?? {}) };
		this.fetch = config.fetch ?? globalThis.fetch;
		this.governor = config.governor ?? new Governor();
		this.userAgent = config.userAgent ?? 'ak-jev';

		if (typeof this.fetch !== 'function') {
			throw new JevConfigError(
				'No fetch implementation. ak-jev needs Node 22+ (which has a global fetch), ' +
					'or a { fetch } option.'
			);
		}

		/** Counters surfaced through `stats()`. */
		this.counters = { requests: 0, retries: 0, failures: 0 };
	}

	/**
	 * `POST /v1/systemone`.
	 *
	 * @param {{state: any, model: string, questions: Object}} body
	 * @param {JevRequestOptions} [options={}]
	 * @returns {Promise<{data: any, requestId: string|undefined, status: number, headers: Object.<string,string>, latencyMs: number}>}
	 */
	async systemOne(body, options = {}) {
		return this.request('POST', SYSTEM_ONE_PATH, body, options);
	}

	/**
	 * `GET /v1/models`. Unwraps the `{ models: [...] }` envelope.
	 *
	 * @param {JevRequestOptions} [options={}]
	 * @returns {Promise<Array<{name: string, description: string, release_date: string}>>}
	 */
	async models(options = {}) {
		const { data } = await this.request('GET', MODELS_PATH, undefined, options);
		return data?.models ?? [];
	}

	/**
	 * One request, with retry, timeout and rate governing.
	 *
	 * @param {'GET'|'POST'} method
	 * @param {string} path
	 * @param {any} body
	 * @param {JevRequestOptions} [options={}]
	 * @returns {Promise<{data: any, requestId: string|undefined, status: number, headers: Object.<string,string>, latencyMs: number}>}
	 */
	async request(method, path, body, options = {}) {
		const retry = { ...this.retry, ...(options.retry ?? {}) };
		const retryable = new Set(retry.httpStatuses);
		const timeout = options.timeout ?? this.timeout;
		const url = `${this.baseURL}${path}`;
		const payload = body === undefined ? undefined : JSON.stringify(body);

		const headers = {
			Authorization: `Bearer ${this.apiKey}`,
			Accept: 'application/json',
			'User-Agent': this.userAgent,
			...this.defaultHeaders,
			...(options.headers ?? {}),
			...(payload !== undefined ? { 'Content-Type': 'application/json' } : {})
		};

		/** @type {any} */
		let lastError;

		for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
			if (attempt > 0) this.counters.retries++;

			try {
				return await this.governor.run(
					() => this._attempt({ method, url, headers, payload, timeout, signal: options.signal }),
					{ tokens: options.estimatedTokens ?? 0, signal: options.signal }
				);
			} catch (err) {
				lastError = err;

				if (err instanceof JevAbortError) throw err;
				if (options.signal?.aborted) throw new JevAbortError('The request was aborted by the caller.');

				const canRetry = attempt < retry.maxRetries && isRetryable(err, retry, retryable);
				if (!canRetry) break;

				const delay = backoffDelay(err, attempt, retry);
				log.debug(
					{ attempt: attempt + 1, of: retry.maxRetries, delay, status: err?.status, err: err?.message },
					'ak-jev: retrying'
				);
				await sleep(delay, options.signal);
			}
		}

		this.counters.failures++;
		throw lastError;
	}

	/**
	 * A single HTTP attempt. No retry logic here on purpose.
	 * @param {Object} args
	 */
	async _attempt({ method, url, headers, payload, timeout, signal }) {
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener('abort', onAbort, { once: true });

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeout);

		const started = Date.now();
		this.counters.requests++;

		/** @type {Response} */
		let res;
		try {
			res = await this.fetch(url, {
				method,
				headers,
				body: payload,
				signal: controller.signal
			});
		} catch (err) {
			if (timedOut) {
				throw new JevTimeoutError(
					`Request to ${url} exceeded the ${timeout}ms per-attempt timeout.`,
					{ timeout }
				);
			}
			if (signal?.aborted) throw new JevAbortError('The request was aborted by the caller.');
			throw new JevConnectionError(
				`Could not reach ${url}: ${/** @type {Error} */ (err)?.message ?? 'connection failed'}`,
				{ cause: /** @type {Error} */ (err) }
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		}

		const latencyMs = Date.now() - started;
		const responseHeaders = Object.fromEntries(res.headers);
		const requestId = res.headers.get('x-typesafe-request-id') ?? undefined;

		const text = await res.text().catch(() => '');
		/** @type {any} */
		let data = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = text;
			}
		}

		if (!res.ok) {
			throw errorFromResponse({ status: res.status, body: data, headers: responseHeaders, requestId });
		}

		return { data, requestId, status: res.status, headers: responseHeaders, latencyMs };
	}
}

/**
 * @typedef {Object} JevRequestOptions
 * @property {AbortSignal} [signal]
 * @property {number} [timeout] per attempt, ms
 * @property {Partial<typeof DEFAULT_RETRY>} [retry]
 * @property {Object.<string,string>} [headers]
 * @property {number} [estimatedTokens] fed to the governor's tokens/second window
 */

/**
 * @param {any} err
 * @param {typeof DEFAULT_RETRY} retry
 * @param {Set<number>} retryable
 * @returns {boolean}
 */
function isRetryable(err, retry, retryable) {
	if (err instanceof JevTimeoutError) return retry.apiTimeoutError;
	if (err instanceof JevConnectionError) return retry.apiConnectionError;
	if (typeof err?.status === 'number') return retryable.has(err.status);
	return false;
}

/**
 * Exponential backoff with jitter, honouring `retry-after` when the server sends
 * one and it is not absurd.
 *
 * @param {any} err
 * @param {number} attempt zero-based
 * @param {typeof DEFAULT_RETRY} retry
 * @returns {number} milliseconds
 */
export function backoffDelay(err, attempt, retry) {
	if (retry.respectRetryAfter && err instanceof JevRateLimitError && err.retryAfterMs !== undefined) {
		if (err.retryAfterMs <= retry.maxRetryAfterMs) return err.retryAfterMs;
	}
	const base = Math.min(retry.backoffInitialMs * 2 ** attempt, retry.backoffMaxMs);
	// Subtract up to `backoffJitter` of the delay, so a burst of clients that all
	// got a 429 at the same moment do not all come back at the same moment.
	return Math.max(0, base * (1 - Math.random() * retry.backoffJitter));
}
