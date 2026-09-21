/**
 * The API returns `detail` in three different shapes. Normalizing them is the
 * first thing ak-jev does, so it gets the first test file.
 *
 * Every shape below was captured from the live API on 2026-09-21.
 */

import { describe, test, expect } from '@jest/globals';
import {
	describeDetail,
	errorFromResponse,
	parseRetryAfter,
	JevAuthError,
	JevBadRequestError,
	JevRequestTooLargeError,
	JevUnprocessableError,
	JevRateLimitError,
	JevOverloadedError,
	JevServerError,
	JevNotFoundError,
	JevPermissionError,
	JevAPIError
} from '../../errors.js';

describe('describeDetail — the three real shapes', () => {
	test('shape 1: object with error_type and message (401)', () => {
		const body = {
			detail: {
				error_type: 'authentication_error',
				message: 'Cannot authenticate with the server. Please check your API key and try again.'
			}
		};
		const d = describeDetail(body, 401);
		expect(d.message).toContain('Cannot authenticate');
		expect(d.errorType).toBe('authentication_error');
		expect(d.fields).toEqual([]);
	});

	test('shape 1b: error_type with NO message (max_tokens_exceeded)', () => {
		const d = describeDetail({ detail: { error_type: 'max_tokens_exceeded' } }, 400);
		expect(d.errorType).toBe('max_tokens_exceeded');
		// The API sends nothing readable, so we must synthesize something.
		expect(d.message).toContain('max_tokens_exceeded');
	});

	test('shape 2: a bare string (most 400s)', () => {
		const d = describeDetail({ detail: 'Too many choices. Must have at most 255 choices.' }, 400);
		expect(d.message).toBe('Too many choices. Must have at most 255 choices.');
		expect(d.errorType).toBeUndefined();
	});

	test('shape 3: the FastAPI validation array (422)', () => {
		const body = {
			detail: [
				{ type: 'missing', loc: ['body', 'model'], msg: 'Field required', input: {} },
				{ type: 'too_short', loc: ['body', 'questions'], msg: 'Dictionary should have at least 1 item after validation, not 0' }
			]
		};
		const d = describeDetail(body, 422);
		expect(d.fields).toEqual([
			{ path: 'model', message: 'Field required' },
			{ path: 'questions', message: 'Dictionary should have at least 1 item after validation, not 0' }
		]);
		expect(d.message).toBe(
			'model: Field required; questions: Dictionary should have at least 1 item after validation, not 0'
		);
	});

	test('no usable detail falls back to the status', () => {
		expect(describeDetail({}, 503).message).toBe('HTTP 503');
		expect(describeDetail(null, 503).message).toBe('HTTP 503');
		expect(describeDetail('plain text body', 503).message).toBe('plain text body');
	});
});

describe('errorFromResponse maps status to class', () => {
	const mk = (status, body = {}) =>
		errorFromResponse({ status, body, headers: {}, requestId: 'req_x' });

	test.each([
		[401, JevAuthError],
		[403, JevPermissionError],
		[404, JevNotFoundError],
		[422, JevUnprocessableError],
		[429, JevRateLimitError],
		[529, JevOverloadedError],
		[500, JevServerError],
		[503, JevServerError],
		[400, JevBadRequestError],
		[418, JevAPIError]
	])('%i -> %s', (status, cls) => {
		expect(mk(status)).toBeInstanceOf(cls);
	});

	test('max_tokens_exceeded gets its own class and an actionable message', () => {
		const err = mk(400, { detail: { error_type: 'max_tokens_exceeded' } });
		expect(err).toBeInstanceOf(JevRequestTooLargeError);
		expect(err.message).toMatch(/64k/);
		expect(err.message).toMatch(/32k/);
		expect(err.message).toMatch(/estimate\(\)/);
	});

	test('a plain 400 stays a plain bad request', () => {
		const err = mk(400, { detail: 'Choice question must have at least one choice: a' });
		expect(err).toBeInstanceOf(JevBadRequestError);
		expect(err).not.toBeInstanceOf(JevRequestTooLargeError);
		expect(err.message).toContain('at least one choice');
	});

	test('the auth error says how to fix it', () => {
		const err = mk(401, { detail: { error_type: 'authentication_error', message: 'Bad key.' } });
		expect(err.message).toContain('TYPESAFE_API_KEY');
	});

	test('422 carries the offending field paths', () => {
		const err = /** @type {JevUnprocessableError} */ (
			mk(422, { detail: [{ type: 'missing', loc: ['body', 'model'], msg: 'Field required' }] })
		);
		expect(err.fields).toEqual([{ path: 'model', message: 'Field required' }]);
	});

	test('every error keeps status and requestId', () => {
		const err = mk(500);
		expect(err.status).toBe(500);
		expect(err.requestId).toBe('req_x');
	});
});

describe('parseRetryAfter', () => {
	test('reads retry-after-ms first', () => {
		expect(parseRetryAfter({ 'retry-after-ms': '250', 'retry-after': '99' })).toBe(250);
	});

	test('reads retry-after as seconds', () => {
		expect(parseRetryAfter({ 'retry-after': '2' })).toBe(2000);
	});

	test('reads retry-after as an HTTP date', () => {
		const at = new Date(Date.now() + 5000).toUTCString();
		const ms = parseRetryAfter({ 'retry-after': at });
		expect(ms).toBeGreaterThan(3000);
		expect(ms).toBeLessThanOrEqual(6000);
	});

	test('undefined when absent or unparseable', () => {
		expect(parseRetryAfter({})).toBeUndefined();
		expect(parseRetryAfter({ 'retry-after': 'soonish' })).toBeUndefined();
	});
});
