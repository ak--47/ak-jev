/**
 * @fileoverview Offline test harness.
 *
 * Every unit test injects a `fetch` built here, so no code path can reach the
 * network. `TYPESAFE_BASE_URL` also points at an invalid host in
 * `tests/jest.setup.js`, so a missed injection fails loudly rather than
 * quietly calling the real API.
 */

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
