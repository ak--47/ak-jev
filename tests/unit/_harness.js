/**
 * @fileoverview Offline test harness.
 *
 * Every unit test injects a `fetch` built here, so no code path can reach the
 * network. `TYPESAFE_BASE_URL` also points at an invalid host in
 * `tests/jest.setup.js`, so a missed injection fails loudly rather than
 * quietly calling the real API.
 */

/** @type {{urlPrefix: string, authorization: string}|null} */
let expected = null;

/**
 * Make every fake `fetch` refuse a request that does not go to `urlPrefix` with
 * `authorization`. Pass `null` to turn the check off.
 *
 * @param {{urlPrefix: string, authorization: string}|null} transport
 */
export function expectTransport(transport) {
	expected = transport;
}

/**
 * Build a fake `fetch` that returns canned responses.
 *
 * @param {Array<{status?: number, body?: any, headers?: Object, delayMs?: number, throws?: Error}>|Function} script
 *   Either a list of responses served in order (the last one repeats), or a
 *   function called with `(url, init, callIndex)` that returns one.
 * @returns {{fetch: Function, calls: Array<{url: string, init: any, body: any}>}}
 */
export function fakeFetch(script) {
	/** @type {Array<{url: string, init: any, body: any}>} */
	const calls = [];
	let n = 0;

	const impl = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
		if (expected) {
			// Fail the request, not just an assertion, so no class can pass while
			// talking to the wrong provider.
			if (!url.startsWith(expected.urlPrefix)) throw new Error(`expected a request to ${expected.urlPrefix}, got ${url}`);
			if (init.headers?.Authorization !== expected.authorization) {
				throw new Error(`expected Authorization "${expected.authorization}", got "${init.headers?.Authorization}"`);
			}
		}
		const body = init.body ? JSON.parse(init.body) : undefined;
		const index = n++;
		calls.push({ url, init, body });

		const spec = typeof script === 'function'
			? await script(url, init, index)
			: script[Math.min(index, script.length - 1)];

		if (spec?.throws) throw spec.throws;
		if (spec?.delayMs) {
			// Honour the abort signal the same way a real `fetch` does. Without this
			// the timeout and abort paths would never be exercised.
			await new Promise((resolve, reject) => {
				const t = setTimeout(resolve, spec.delayMs);
				init.signal?.addEventListener(
					'abort',
					() => {
						clearTimeout(t);
						const err = new Error('This operation was aborted');
						err.name = 'AbortError';
						reject(err);
					},
					{ once: true }
				);
			});
		}

		const status = spec?.status ?? 200;
		const headers = new Headers({
			'content-type': 'application/json',
			'x-typesafe-request-id': `req_test_${index}`,
			...(spec?.headers ?? {})
		});
		const text = typeof spec?.body === 'string' ? spec.body : JSON.stringify(spec?.body ?? {});

		return {
			ok: status >= 200 && status < 300,
			status,
			headers,
			text: async () => text,
			json: async () => JSON.parse(text)
		};
	};

	return { fetch: impl, calls };
}

/**
 * A well-formed `POST /v1/systemone` response body.
 *
 * @param {Object.<string, any>} answers
 * @param {{model?: string, inputTokens?: number, outputTokens?: number}} [opts={}]
 */
export function systemOneBody(answers, opts = {}) {
	return {
		model: opts.model ?? 'jev-1.13.0',
		answers,
		usage: {
			input_tokens: opts.inputTokens ?? 300,
			output_tokens: opts.outputTokens ?? 20
		}
	};
}

/** @param {number} p */
export const noulAnswer = (p) => ({ type: 'noul', noul: p });

/**
 * @param {string} winner
 * @param {Object.<string, number>} probabilities
 * @param {number} [confidence]
 */
export const choiceAnswer = (winner, probabilities, confidence = 0.9) => ({
	type: 'choice',
	choice: winner,
	confidence,
	probabilities
});

/**
 * @param {number} value
 * @param {string[]} levels
 * @param {Object.<string, number>} probabilities
 * @param {number} [confidence]
 */
export const scoreAnswer = (value, levels, probabilities, confidence = 0.9) => ({
	type: 'score',
	score: value,
	confidence,
	legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
	probabilities
});

/** Options every unit-test client shares. */
export const OFFLINE = Object.freeze({
	apiKey: 'apikey_test',
	baseURL: 'https://api.typesafe.invalid',
	logLevel: 'silent',
	cache: false
});

/**
 * The same, on the litellm provider. No `apiKey` or `baseURL`: the provider
 * resolves them from `LITELLM_API_KEY` and `LITELLM_BASE_URL`, which
 * `tests/jest.setup.js` points at fakes. That exercises the provider wiring too.
 */
export const OFFLINE_LITELLM = Object.freeze({
	provider: 'litellm',
	logLevel: 'silent',
	cache: false
});

/**
 * Both inference paths, for `describe.each`. `transport` is what every request
 * on that path must look like.
 */
export const INFERENCE_PATHS = Object.freeze([
	{
		name: 'typesafe',
		options: OFFLINE,
		transport: { urlPrefix: 'https://api.typesafe.invalid/', authorization: 'Bearer apikey_test' }
	},
	{
		name: 'litellm',
		options: OFFLINE_LITELLM,
		transport: { urlPrefix: 'https://litellm.invalid/typesafe/', authorization: 'Bearer sk-test-litellm' }
	}
]);
