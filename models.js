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

import { JevConfigError, JevValidationError } from './errors.js';

/** The alias every example uses, and this package's default. */
export const DEFAULT_MODEL = 'jev-latest';

/** Base URL for the API. */
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

/** Mixpanel's LiteLLM gateway root, shared with ak-litellm. */
export const LITELLM_DEFAULT_ROOT = 'https://litellm.mixpanel.org';

/**
 * Where the TypeSafe wire protocol can be reached, and how each place is
 * configured. Every provider speaks the same `/v1/systemone` protocol; only the
 * host, the key and the model behind it differ.
 *
 * `litellm` is a pass-through route on Mixpanel's gateway to a self-hosted Kev
 * server (`jaredpalmer/kev-4b`). It is not in the gateway's model list and does
 * not appear in its UI; calls show in its Logs page as `typesafe/kev-latest`.
 * The gateway serves EVERY model name from that one Kev server, `jev-latest`
 * included — so limits there are Kev's whatever the name (`limitsModel`), while
 * billing still follows the name: `kev-latest` is free, `jev-*` is billed at
 * TypeSafe's rate. Measured 2026-09-28.
 *
 * @type {Readonly<Object.<string, JevProviderSpec>>}
 */
export const PROVIDERS = Object.freeze({
	typesafe: Object.freeze({
		name: 'typesafe',
		keyEnv: Object.freeze(['TYPESAFE_API_KEY', 'JEV_API_KEY']),
		keyHelp: 'Get a key at https://console.typesafe.ai/keys',
		baseURL: () => process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL,
		defaultModel: () => process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL,
		limitsModel: undefined,
		timeout: undefined
	}),
	litellm: Object.freeze({
		name: 'litellm',
		keyEnv: Object.freeze(['LITELLM_API_KEY']),
		keyHelp: 'Create one at https://litellm.mixpanel.org: Virtual Keys, Create Key, team general or sales',
		// Same LITELLM_BASE_URL as ak-litellm, which may or may not end in /v1.
		baseURL: () =>
			`${(process.env.LITELLM_BASE_URL ?? LITELLM_DEFAULT_ROOT).replace(/\/+$/, '').replace(/\/v1$/, '')}/typesafe`,
		defaultModel: () => 'kev-latest',
		limitsModel: 'kev-latest',
		// Kev's latency grows with question count (1,000 questions: 30 s), where
		// Jev's stays near flat. Jev's 30 s default would time out large requests.
		timeout: 120_000
	})
});

/** Used when neither the `provider` option nor `JEV_PROVIDER` is set. */
export const DEFAULT_PROVIDER = 'typesafe';

/**
 * @typedef {Object} JevProviderSpec
 * @property {string} name
 * @property {readonly string[]} keyEnv environment variables read for the key, in order
 * @property {string} keyHelp where to get a key, for error messages
 * @property {() => string} baseURL
 * @property {() => string} defaultModel
 * @property {string|undefined} limitsModel the model whose limits apply to every name
 * @property {number|undefined} timeout per-attempt default, ms; `undefined` keeps the client's
 */

/**
 * @typedef {Object} JevProvider
 * @property {string} name
 * @property {string} baseURL no trailing slash
 * @property {string} defaultModel
 * @property {string|undefined} apiKey from the provider's environment variables, if set
 * @property {readonly string[]} keyEnv
 * @property {string} keyHelp
 * @property {string|undefined} limitsModel
 * @property {number|undefined} timeout
 */

/**
 * Resolve a provider name to its settings. Environment variables are read here,
 * at call time, and each provider reads only its own — a `TYPESAFE_BASE_URL` in
 * `.env` must not send a gateway key to TypeSafe.
 *
 * @param {string} [name] falls back to `JEV_PROVIDER`, then `typesafe`
 * @returns {JevProvider}
 */
export function resolveProvider(name) {
	const id = name ?? process.env.JEV_PROVIDER ?? DEFAULT_PROVIDER;
	const spec = PROVIDERS[id];
	if (!spec) {
		throw new JevConfigError(
			`Unknown provider "${id}". Valid providers are: ${Object.keys(PROVIDERS).join(', ')}.`
		);
	}
	return {
		name: spec.name,
		baseURL: spec.baseURL().replace(/\/+$/, ''),
		defaultModel: spec.defaultModel(),
		apiKey: spec.keyEnv.map((k) => process.env[k]).find(Boolean),
		keyEnv: spec.keyEnv,
		keyHelp: spec.keyHelp,
		limitsModel: spec.limitsModel,
		timeout: spec.timeout
	};
}

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
	'jev-1.13.0': { input: 0.042, output: 0 },
	// Mixpanel's self-hosted Kev, on the litellm provider only. Free: the gateway's
	// key spend does not move for it, while a `jev-*` name on the same route is
	// billed at the rate above. Measured 2026-09-28.
	'kev-latest': { input: 0, output: 0 }
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
	}),
	/**
	 * Kev (`jaredpalmer/kev-4b`) behind the litellm provider. Measured against the
	 * gateway on 2026-09-28. It is a different model from Jev and its limits are
	 * different in both directions.
	 */
	'kev-latest': Object.freeze({
		/**
		 * No total limit found: 8,000 questions over one state (226,822 input
		 * tokens) was accepted. This is the largest size measured, not a known
		 * ceiling. Latency grows with question count on Kev (1,000 questions took
		 * 30 s), so a request this large is slow long before it is rejected.
		 */
		contextTokens: 220000,
		/**
		 * `422 branch too long: <n> tokens with a <m>-token state (row limit 8192)`.
		 * Accepted at 8,187 input tokens with one short question.
		 */
		stateTokens: 8192,
		/** 256 options is a 422 validation array, not Jev's 400 string. */
		maxChoiceOptions: 255,
		/** An empty choice is a 422. */
		minChoiceOptions: 1,
		/** Up to 255 levels accepted; 256 is a 422. Jev stops at 10. */
		maxScoreLevels: 255,
		/** Accepted, with the same `score: 0, confidence: 1` as Jev. */
		minScoreLevels: 1,
		/**
		 * Not published. 60 concurrent requests all returned 200. These mirror
		 * Jev's published figures so the client-side governor defaults still fit.
		 */
		requestsPerMinute: 1200,
		tokensPerSecond: 250000,
		/** Empty state, one-character question: 10 input tokens. */
		requestOverheadTokens: 10
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
 * On a provider with a `limitsModel`, that model's limits apply whatever name is
 * sent — the litellm gateway serves every name from one Kev server.
 *
 * @param {string} model
 * @param {string|{limitsModel?: string}} [provider] a provider name or a resolved provider
 * @returns {JevModelLimits}
 */
export function resolveLimits(model, provider) {
	const limitsModel = typeof provider === 'string' ? PROVIDERS[provider]?.limitsModel : provider?.limitsModel;
	const modelId = resolveModelId(limitsModel ?? model);
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
 * @param {string} [opts.provider] `typesafe` or `litellm`; falls back to `JEV_PROVIDER`
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseURL]
 * @param {typeof fetch} [opts.fetch]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<{name: string, description: string, release_date: string}>>}
 */
export async function listModels(opts = {}) {
	const provider = resolveProvider(opts.provider);
	const apiKey = opts.apiKey ?? provider.apiKey;
	if (!apiKey) {
		throw new JevValidationError(
			`listModels() needs an API key. Pass { apiKey } or set ${provider.keyEnv[0]}.`
		);
	}
	const baseURL = (opts.baseURL ?? provider.baseURL).replace(/\/+$/, '');
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
			requestId: res.headers.get('x-typesafe-request-id') ?? undefined,
			keyEnv: provider.keyEnv[0]
		});
	}
	return body?.models ?? [];
}
