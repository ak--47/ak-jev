/**
 * The `provider` option: TypeSafe's hosted Jev, or Kev behind Mixpanel's LiteLLM
 * gateway. Same wire protocol, different host, key, default model, limits and
 * error shapes. Fully offline — every client here is handed a fake `fetch`.
 */

import { describe, test, expect, afterEach } from '@jest/globals';

import BaseJev from '../../base.js';
import { JevClient, gatewayMeta } from '../../client.js';
import { resolveProvider, resolveLimits, computeCost, listModels, PROVIDERS } from '../../models.js';
import { estimate } from '../../index.js';
import { noul, score } from '../../questions.js';
import {
	JevAuthError,
	JevConfigError,
	JevRequestTooLargeError,
	JevValidationError,
	describeDetail
} from '../../errors.js';
import { fakeFetch, systemOneBody, noulAnswer } from './_harness.js';

const GATEWAY = Object.freeze({ provider: 'litellm', logLevel: 'silent', cache: false });

/** Headers the gateway sent on a live kev-latest call, 2026-09-28. */
const LIVE_GATEWAY_HEADERS = {
	'x-litellm-call-id': 'bfa9faa7-ce54-4caf-b74f-13d70572645e',
	'x-litellm-model-api-base': 'http://kev.kev.svc.cluster.local:8008/v1/systemone',
	'x-litellm-key-spend': '7.98e-07'
};

const kevBody = (answers, opts = {}) => systemOneBody(answers, { model: 'kev-latest', inputTokens: 11, outputTokens: 21, ...opts });

// Tests below mutate provider env vars; put back what jest.setup.js set.
const saved = { ...process.env };
afterEach(() => {
	for (const k of ['JEV_PROVIDER', 'LITELLM_API_KEY', 'LITELLM_BASE_URL', 'TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL']) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('resolveProvider', () => {
	test('defaults to typesafe', () => {
		delete process.env.JEV_PROVIDER;
		const p = resolveProvider();
		expect(p.name).toBe('typesafe');
		expect(p.defaultModel).toBe('jev-latest');
		expect(p.limitsModel).toBeUndefined();
	});

	test('JEV_PROVIDER selects the provider when no name is passed', () => {
		process.env.JEV_PROVIDER = 'litellm';
		expect(resolveProvider().name).toBe('litellm');
		expect(resolveProvider('typesafe').name).toBe('typesafe');
	});

	test('litellm reads LITELLM_API_KEY and defaults to kev-latest on /typesafe', () => {
		delete process.env.LITELLM_BASE_URL;
		const p = resolveProvider('litellm');
		expect(p.apiKey).toBe('sk-test-litellm');
		expect(p.baseURL).toBe('https://litellm.mixpanel.org/typesafe');
		expect(p.defaultModel).toBe('kev-latest');
		expect(p.timeout).toBe(120_000);
	});

	test('LITELLM_BASE_URL is shared with ak-litellm, with or without /v1', () => {
		process.env.LITELLM_BASE_URL = 'https://gw.example.com/v1/';
		expect(resolveProvider('litellm').baseURL).toBe('https://gw.example.com/typesafe');
		process.env.LITELLM_BASE_URL = 'https://gw.example.com';
		expect(resolveProvider('litellm').baseURL).toBe('https://gw.example.com/typesafe');
	});

	test('each provider reads only its own variables', () => {
		// A TYPESAFE_BASE_URL in .env must not send a gateway key to TypeSafe.
		process.env.TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
		process.env.TYPESAFE_DEFAULT_MODEL = 'jev-preview';
		delete process.env.LITELLM_BASE_URL;
		const p = resolveProvider('litellm');
		expect(p.baseURL).toBe('https://litellm.mixpanel.org/typesafe');
		expect(p.defaultModel).toBe('kev-latest');
		expect(p.apiKey).toBe('sk-test-litellm');
	});

	test('an unknown provider throws and names the valid ones', () => {
		expect(() => resolveProvider('openai')).toThrow(JevConfigError);
		expect(() => resolveProvider('openai')).toThrow(/typesafe, litellm/);
	});
});

describe('BaseJev on the litellm provider', () => {
	test('sends the gateway key to the gateway route with kev-latest', async () => {
		const { fetch, calls } = fakeFetch([{ body: kevBody({ a: noulAnswer(0.9) }) }]);
		const jev = new BaseJev({ ...GATEWAY, baseURL: 'https://litellm.invalid/typesafe', fetch });
		await jev.evaluate('I was charged twice.', { a: noul('Is this about billing?') });

		expect(jev.provider).toBe('litellm');
		expect(calls[0].url).toBe('https://litellm.invalid/typesafe/v1/systemone');
		expect(calls[0].init.headers.Authorization).toBe('Bearer sk-test-litellm');
		expect(calls[0].body.model).toBe('kev-latest');
	});

	test('explicit options win over the provider defaults', async () => {
		const { fetch, calls } = fakeFetch([{ body: kevBody({ a: noulAnswer(0.9) }) }]);
		const jev = new BaseJev({ ...GATEWAY, apiKey: 'sk-explicit', baseURL: 'https://other.invalid', modelName: 'jev-latest', fetch });
		await jev.evaluate('x', { a: noul('y?') });
		expect(calls[0].url).toBe('https://other.invalid/v1/systemone');
		expect(calls[0].init.headers.Authorization).toBe('Bearer sk-explicit');
		expect(calls[0].body.model).toBe('jev-latest');
	});

	test('the per-attempt timeout defaults to 120 s on litellm and 30 s on typesafe', () => {
		const fetch = fakeFetch([]).fetch;
		expect(new BaseJev({ ...GATEWAY, fetch }).client.timeout).toBe(120_000);
		expect(new BaseJev({ logLevel: 'silent', fetch }).client.timeout).toBe(30_000);
		expect(new BaseJev({ ...GATEWAY, timeout: 5000, fetch }).client.timeout).toBe(5000);
	});

	test('a missing gateway key names LITELLM_API_KEY', () => {
		delete process.env.LITELLM_API_KEY;
		expect(() => new BaseJev({ ...GATEWAY, fetch: fakeFetch([]).fetch })).toThrow(/LITELLM_API_KEY/);
	});

	test('usage shows tokens, $0 for kev-latest, and the gateway call id and key spend', async () => {
		const { fetch } = fakeFetch([{ body: kevBody({ a: noulAnswer(0.9) }), headers: LIVE_GATEWAY_HEADERS }]);
		const jev = new BaseJev({ ...GATEWAY, fetch });
		const { usage } = await jev.evaluate('x', { a: noul('y?') });

		expect(usage.inputTokens).toBe(11);
		expect(usage.outputTokens).toBe(21);
		expect(usage.estimatedCost).toBe(0);
		expect(usage.costSource).toBe('estimated');
		expect(usage.callId).toBe('bfa9faa7-ce54-4caf-b74f-13d70572645e');
		expect(usage.keySpend).toBeCloseTo(7.98e-7, 12);
		expect(jev.getTotalUsage().keySpend).toBeCloseTo(7.98e-7, 12);
	});

	test('x-litellm-response-cost, when the gateway sends it, wins over the table', async () => {
		const headers = { ...LIVE_GATEWAY_HEADERS, 'x-litellm-response-cost': '0.00000123' };
		const { fetch } = fakeFetch([{ body: kevBody({ a: noulAnswer(0.9) }, { model: 'jev-latest' }), headers }]);
		const jev = new BaseJev({ ...GATEWAY, modelName: 'jev-latest', fetch });
		const { usage } = await jev.evaluate('x', { a: noul('y?') });
		expect(usage.estimatedCost).toBeCloseTo(0.00000123, 12);
		expect(usage.costSource).toBe('gateway');
	});

	test('jev-latest on the gateway is priced at TypeSafe rates', async () => {
		const { fetch } = fakeFetch([{ body: kevBody({ a: noulAnswer(0.9) }, { model: 'jev-latest', inputTokens: 1e6 }) }]);
		const jev = new BaseJev({ ...GATEWAY, modelName: 'jev-latest', fetch });
		const { usage } = await jev.evaluate('x', { a: noul('y?') });
		expect(usage.estimatedCost).toBeCloseTo(0.042, 9);
	});

	test('the typesafe provider adds no gateway fields to usage', async () => {
		const { fetch } = fakeFetch([{ body: systemOneBody({ a: noulAnswer(0.9) }) }]);
		const jev = new BaseJev({ logLevel: 'silent', fetch });
		const { usage } = await jev.evaluate('x', { a: noul('y?') });
		expect(usage).not.toHaveProperty('callId');
		expect(usage).not.toHaveProperty('keySpend');
	});
});

describe('Kev limits', () => {
	test('every model name on litellm gets Kev limits, jev-latest included', () => {
		expect(resolveLimits('jev-latest', 'litellm').stateTokens).toBe(8192);
		expect(resolveLimits('kev-latest', 'litellm').maxScoreLevels).toBe(255);
		expect(resolveLimits('jev-latest').stateTokens).toBe(32000);
		expect(new BaseJev({ ...GATEWAY, modelName: 'jev-latest', fetch: fakeFetch([]).fetch }).limits().stateTokens).toBe(8192);
	});

	test('a 20-level score passes pre-flight on litellm and is rejected on typesafe', async () => {
		const levels = Array.from({ length: 20 }, (_, i) => `level ${i}`);
		const { fetch } = fakeFetch([{ body: kevBody({ a: { type: 'score', score: 3, confidence: 0.5, legend: {}, probabilities: {} } }) }]);
		await expect(new BaseJev({ ...GATEWAY, fetch }).evaluate('x', { a: score('r', levels) })).resolves.toBeDefined();
		await expect(new BaseJev({ logLevel: 'silent', fetch }).evaluate('x', { a: score('r', levels) })).rejects.toThrow(JevValidationError);
	});

	test('the top-level estimate() uses the provider limits and price', () => {
		const e = estimate('x'.repeat(36_000), { a: noul('y?') }, { provider: 'litellm' });
		expect(e.limits.stateTokens).toBe(8192);
		expect(e.withinBudget).toBe(false);
		expect(e.estimatedCost).toBe(0);
		expect(estimate('x'.repeat(36_000), { a: noul('y?') }).withinBudget).toBe(true);
	});

	test('kev-latest is free, and a known price is not null', () => {
		expect(computeCost({ inputTokens: 1e9, outputTokens: 1e9 }, 'kev-latest')).toBe(0);
	});
});

describe('gateway errors', () => {
	// Captured from the live gateway, 2026-09-28. Key hash shortened.
	const BAD_KEY = {
		error: {
			message: 'Authentication Error, Invalid proxy server token passed. Received API Key = sk-..., Key Hash (Token) =76e8. Unable to find token in cache or `LiteLLM_VerificationTokenTable`',
			type: 'token_not_found_in_db',
			param: 'key',
			code: '401'
		}
	};

	test('describeDetail reads the gateway {error} shape', () => {
		const d = describeDetail(BAD_KEY, 401);
		expect(d.message).toMatch(/Invalid proxy server token/);
		expect(d.errorType).toBe('token_not_found_in_db');
	});

	test('a gateway 401 is a JevAuthError that names LITELLM_API_KEY, and is not retried', async () => {
		const { fetch, calls } = fakeFetch([{ status: 401, body: BAD_KEY }]);
		const jev = new BaseJev({ ...GATEWAY, fetch });
		const err = await jev.evaluate('x', { a: noul('y?') }).catch((e) => e);
		expect(err).toBeInstanceOf(JevAuthError);
		expect(err.message).toMatch(/Invalid proxy server token.*Set LITELLM_API_KEY/);
		expect(err.errorType).toBe('token_not_found_in_db');
		expect(calls).toHaveLength(1);
	});

	test("Kev's oversize 422 is a JevRequestTooLargeError", async () => {
		const detail = 'branch too long: 13 tokens with a 8192-token state (row limit 8192)';
		const { fetch } = fakeFetch([{ status: 422, body: { detail } }]);
		const jev = new BaseJev({ ...GATEWAY, checkBudget: false, fetch });
		const err = await jev.evaluate('x', { a: noul('y?') }).catch((e) => e);
		expect(err).toBeInstanceOf(JevRequestTooLargeError);
		expect(err.message).toMatch(/row limit 8192/);
		expect(err.message).toMatch(/estimate\(\)/);
	});

	test('listModels() on litellm uses the gateway key and route', async () => {
		const { fetch, calls } = fakeFetch([{ body: { models: [{ name: 'kev-latest' }, { name: 'jev-latest' }] } }]);
		const models = await listModels({ provider: 'litellm', fetch });
		expect(models.map((m) => m.name)).toEqual(['kev-latest', 'jev-latest']);
		expect(calls[0].url).toBe('https://litellm.invalid/typesafe/v1/models');
		expect(calls[0].init.headers.Authorization).toBe('Bearer sk-test-litellm');
	});
});

describe('gatewayMeta', () => {
	test('reads the x-litellm headers and ignores the rest', () => {
		expect(gatewayMeta(LIVE_GATEWAY_HEADERS)).toEqual({
			callId: 'bfa9faa7-ce54-4caf-b74f-13d70572645e',
			keySpend: 7.98e-7
		});
		expect(gatewayMeta({ 'x-typesafe-request-id': 'r' })).toEqual({});
		expect(gatewayMeta({ 'x-litellm-key-spend': 'nope' })).toEqual({});
	});

	test('JevClient records the provider and the variable a 401 names', () => {
		const c = new JevClient({ provider: 'litellm', fetch: fakeFetch([]).fetch });
		expect(c.provider).toBe('litellm');
		expect(c.keyEnv).toBe('LITELLM_API_KEY');
		expect(Object.keys(PROVIDERS)).toEqual(['typesafe', 'litellm']);
	});
});
