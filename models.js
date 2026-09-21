/**
 * @fileoverview Models, pricing and hard limits for the TypeSafe API.
 *
 * Rates are USD per MILLION tokens, matching the convention in ak-claude /
 * ak-gemini / ak-litellm. TypeSafe publishes per-BILLION ($42/Btok), which is the
 * same number as $0.042/Mtok.
 *
 * Output tokens are free. That is not a rounding-to-zero; TypeSafe bills input
 * only. See https://docs.typesafe.ai/models
 */

import { JevValidationError } from './errors.js';

/** The alias every example uses, and this package's default. */
export const DEFAULT_MODEL = 'jev-latest';

/** Base URL for the API. */
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

/** The evaluation route. */
export const SYSTEM_ONE_PATH = '/v1/systemone';

/** The model-listing route. */
export const MODELS_PATH = '/v1/models';

/**
 * When the rates below were last read off the live pricing page.
 * @see https://docs.typesafe.ai/models
 */
export const MODEL_PRICING_AS_OF = '2026-09-21';

/**
 * USD per million tokens.
 *
 * `output: 0` is real. TypeSafe charges for input tokens only.
 *
 * @type {Object.<string, {input: number, output: number}>}
 */
export const MODEL_PRICING = Object.freeze({
	'jev-1.13.0': { input: 0.042, output: 0 }
});

/**
 * Aliases resolve to a versioned id for pricing and limits. The API accepts
 * either in the `model` field; the response always reports the versioned id.
 * @type {Object.<string, string>}
 */
export const MODEL_ALIASES = Object.freeze({
	'jev-latest': 'jev-1.13.0',
	'jev-preview': 'jev-1.13.0',
	// The docs use the bare minor version in one example; accept it.
	'jev-1.13': 'jev-1.13.0'
});

/**
 * Hard limits, every one of them measured against the live API on 2026-09-21
 * rather than read from the docs. Exceeding any of them is a 400, so ak-jev
 * checks them before sending.
 *
 * `scoreLevelsMin` is 1 because the API accepts a one-level Score and returns
 * `score: 0.0, confidence: 1.0`. The docs say "at least two"; the API does not
 * enforce it. ak-jev warns rather than throws, because a one-level Score is
 * useless but not illegal.
 *
 * @type {Object.<string, JevModelLimits>}
 */
export const MODEL_LIMITS = Object.freeze({
	'jev-1.13.0': Object.freeze({
		/** Total tokens per request: state + every question. */
		contextTokens: 64000,
		/**
		 * State plus the single longest question. The tighter of the two budgets,
		 * and the one you actually hit. Measured: a single-question request was
		 * accepted at 32,698 input tokens and rejected above it.
		 */
		stateTokens: 32000,
		/** `400 Too many choices. Must have at most 255 choices.` */
		maxChoiceOptions: 255,
		/** `400 Choice question must have at least one choice: <id>` */
		minChoiceOptions: 1,
		/** `400 Too many score levels. Must have at most 10 levels.` */
		maxScoreLevels: 10,
		/** Accepted, but a single level cannot discriminate anything. */
		minScoreLevels: 1,
		/** Published rate limit. */
		requestsPerMinute: 1200,
		/** Published rate limit. */
		tokensPerSecond: 250000,
		/**
		 * Measured exactly: an empty state with a one-character question bills
		 * 267 input tokens before any of your own content.
		 */
		requestOverheadTokens: 267
	})
});

/**
 * @typedef {Object} JevModelLimits
 * @property {number} contextTokens
 * @property {number} stateTokens
 * @property {number} maxChoiceOptions
 * @property {number} minChoiceOptions
 * @property {number} maxScoreLevels
 * @property {number} minScoreLevels
 * @property {number} requestsPerMinute
 * @property {number} tokensPerSecond
 * @property {number} requestOverheadTokens
 */

/**
 * Resolve an alias to its versioned model id. Unknown names pass through
 * unchanged — the API accepts versioned ids that are not in the alias table.
 *
 * @param {string} model
 * @returns {string}
 */
export function resolveModelId(model) {
	if (!model) return MODEL_ALIASES[DEFAULT_MODEL];
	return MODEL_ALIASES[model] ?? model;
}

/**
 * Pricing for a model or alias.
 *
 * @param {string} model
 * @returns {{input: number, output: number, asOf: string, modelId: string}|null}
 *   `null` when the model is unknown, which means the cost is unknown — not free.
 */
export function resolvePricing(model) {
	const modelId = resolveModelId(model);
	const rates = MODEL_PRICING[modelId];
	if (!rates) return null;
	return { ...rates, asOf: MODEL_PRICING_AS_OF, modelId };
}

/**
 * Limits for a model or alias. Falls back to the flagship's limits for an
 * unrecognized id, because a future `jev-1.14` is far more likely to match them
 * than to have none.
 *
 * @param {string} model
 * @returns {JevModelLimits}
 */
export function resolveLimits(model) {
	const modelId = resolveModelId(model);
	return MODEL_LIMITS[modelId] ?? MODEL_LIMITS['jev-1.13.0'];
}

/**
 * Cost in USD for a usage record.
 *
 * @param {{inputTokens?: number, outputTokens?: number}} usage
 * @param {string} model
 * @returns {number|null} `null` means unknown, never free.
 */
export function computeCost(usage, model) {
	const pricing = resolvePricing(model);
	if (!pricing) return null;
	const input = (usage?.inputTokens ?? 0) / 1e6 * pricing.input;
	const output = (usage?.outputTokens ?? 0) / 1e6 * pricing.output;
	return input + output;
}

/**
 * Fetch the models this key can use.
 *
 * The API returns `{ models: [...] }`, not a bare array — the JavaScript snippet
 * on the docs' Models page iterates the wrapper object and would yield nothing.
 * This helper unwraps it.
 *
 * @param {Object} [opts={}]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseURL]
 * @param {typeof fetch} [opts.fetch]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<{name: string, description: string, release_date: string}>>}
 */
export async function listModels(opts = {}) {
	const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
	if (!apiKey) {
		throw new JevValidationError(
			'listModels() needs an API key. Pass { apiKey } or set TYPESAFE_API_KEY.'
		);
	}
	const baseURL = (opts.baseURL ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
	const doFetch = opts.fetch ?? globalThis.fetch;

	const res = await doFetch(`${baseURL}${MODELS_PATH}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: opts.signal
	});
	const body = await res.json().catch(() => null);
	if (!res.ok) {
		const { errorFromResponse } = await import('./errors.js');
		throw errorFromResponse({
			status: res.status,
			body,
			headers: Object.fromEntries(res.headers),
			requestId: res.headers.get('x-typesafe-request-id') ?? undefined
		});
	}
	return body?.models ?? [];
}
