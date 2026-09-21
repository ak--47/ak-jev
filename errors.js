/**
 * @fileoverview Error classes for ak-jev.
 *
 * The TypeSafe API returns `detail` in three different shapes depending on which
 * layer rejected the request. Normalizing them into one readable `message` is the
 * first thing this package does for you.
 *
 * ```jsonc
 * {"detail": {"error_type": "authentication_error", "message": "..."}}  // 401, some 400s
 * {"detail": "Too many choices. Must have at most 255 choices."}        // most 400s
 * {"detail": [{"type":"missing","loc":["body","model"],"msg":"..."}]}   // 422 (FastAPI)
 * ```
 *
 * One shape carries no message at all — `{"detail":{"error_type":"max_tokens_exceeded"}}`
 * — so `JevRequestTooLargeError` supplies its own, along with the fix.
 */

/** Base class for every error this package throws. */
export class JevError extends Error {
	/**
	 * @param {string} message
	 * @param {Object} [meta={}]
	 */
	constructor(message, meta = {}) {
		super(message);
		this.name = new.target.name;
		/** @type {string|undefined} */
		this.requestId = meta.requestId;
		Error.captureStackTrace?.(this, new.target);
	}
}

/** Bad or missing client configuration — an API key, a base URL, an option value. */
export class JevConfigError extends JevError {}

/**
 * A question or request failed ak-jev's own checks before anything was sent.
 * Catching these locally is free; the same mistake costs a round trip and an
 * unhelpful 400 if it reaches the API.
 */
export class JevValidationError extends JevError {
	/**
	 * @param {string} message
	 * @param {Object} [meta={}]
	 * @param {string} [meta.questionId] which question is at fault
	 */
	constructor(message, meta = {}) {
		super(message, meta);
		/** @type {string|undefined} */
		this.questionId = meta.questionId;
	}
}

/** The request never reached the API (DNS, TLS, socket closed). */
export class JevConnectionError extends JevError {
	constructor(message, meta = {}) {
		super(message, meta);
		/** @type {Error|undefined} */
		this.cause = meta.cause;
	}
}

/** A single attempt exceeded its timeout. */
export class JevTimeoutError extends JevError {
	constructor(message, meta = {}) {
		super(message, meta);
		/** @type {number|undefined} */
		this.timeout = meta.timeout;
	}
}

/** The caller's AbortSignal fired. */
export class JevAbortError extends JevError {}

/** The API returned a non-2xx status. */
export class JevAPIError extends JevError {
	/**
	 * @param {string} message
	 * @param {Object} [meta={}]
	 * @param {number} [meta.status]
	 * @param {any} [meta.detail] the raw `detail` field, untouched
	 * @param {string} [meta.errorType] the API's own `error_type`, when it sends one
	 * @param {string} [meta.requestId]
	 * @param {Object.<string,string>} [meta.headers]
	 */
	constructor(message, meta = {}) {
		super(message, meta);
		/** @type {number} */
		this.status = meta.status ?? 0;
		/** @type {any} */
		this.detail = meta.detail;
		/** @type {string|undefined} */
		this.errorType = meta.errorType;
		/** @type {Object.<string,string>} */
		this.headers = meta.headers ?? {};
	}
}

/** 401 — the key is missing, malformed, or revoked. */
export class JevAuthError extends JevAPIError {}

/** 400 — the API rejected the request body. */
export class JevBadRequestError extends JevAPIError {}

/**
 * 400 with `error_type: "max_tokens_exceeded"`.
 *
 * Split out because the API sends no message, and because the fix is specific:
 * `jev-1.13` allows roughly 64k tokens per request and 32k for the state plus the
 * single longest question. Filter the state before sending it, or split the
 * questions across calls.
 */
export class JevRequestTooLargeError extends JevBadRequestError {}

/** 404 — no such route. */
export class JevNotFoundError extends JevAPIError {}

/** 403 — the key is valid but not allowed here. */
export class JevPermissionError extends JevAPIError {}

/** 422 — the body failed schema validation. `fields` lists the offending paths. */
export class JevUnprocessableError extends JevAPIError {
	constructor(message, meta = {}) {
		super(message, meta);
		/** @type {Array<{path: string, message: string}>} */
		this.fields = meta.fields ?? [];
	}
}

/** 429 — over the rate limit. Retried automatically by default. */
export class JevRateLimitError extends JevAPIError {
	constructor(message, meta = {}) {
		super(message, meta);
		/** @type {number|undefined} milliseconds, from `retry-after` when present */
		this.retryAfterMs = meta.retryAfterMs;
	}
}

/** 529 — the service is temporarily overloaded. Retried automatically by default. */
export class JevOverloadedError extends JevAPIError {}

/** 5xx other than 529. */
export class JevServerError extends JevAPIError {}

/**
 * Flatten any of the three `detail` shapes into one readable sentence.
 *
 * @param {any} body the parsed response body, or `undefined` if it did not parse
 * @param {number} status
 * @returns {{message: string, errorType: string|undefined, fields: Array<{path: string, message: string}>}}
 */
export function describeDetail(body, status) {
	const detail = body?.detail;

	// Shape 3: FastAPI validation array.
	if (Array.isArray(detail)) {
		const fields = detail.map((d) => ({
			// `loc` starts with "body"; drop it, it is the same for every entry.
			path: Array.isArray(d?.loc) ? d.loc.slice(1).join('.') || 'body' : 'body',
			message: String(d?.msg ?? 'invalid')
		}));
		const summary = fields.map((f) => `${f.path}: ${f.message}`).join('; ');
		return { message: summary || `HTTP ${status}`, errorType: undefined, fields };
	}

	// Shape 1: object with error_type, and usually a message.
	if (detail && typeof detail === 'object') {
		const errorType = typeof detail.error_type === 'string' ? detail.error_type : undefined;
		const message = typeof detail.message === 'string' && detail.message
			? detail.message
			: errorType
				? `The API rejected the request: ${errorType}`
				: `HTTP ${status}`;
		return { message, errorType, fields: [] };
	}

	// Shape 2: a bare string.
	if (typeof detail === 'string' && detail) {
		return { message: detail, errorType: undefined, fields: [] };
	}

	// No usable detail at all.
	const fallback = typeof body === 'string' && body ? body.slice(0, 300) : `HTTP ${status}`;
	return { message: fallback, errorType: undefined, fields: [] };
}

/**
 * Build the right error subclass for an HTTP response.
 *
 * @param {Object} args
 * @param {number} args.status
 * @param {any} args.body parsed response body
 * @param {Object.<string,string>} args.headers
 * @param {string|undefined} args.requestId
 * @returns {JevAPIError}
 */
export function errorFromResponse({ status, body, headers, requestId }) {
	const { message, errorType, fields } = describeDetail(body, status);
	const meta = { status, detail: body?.detail, errorType, requestId, headers };

	if (status === 401) {
		return new JevAuthError(
			`${message} Set TYPESAFE_API_KEY, or pass { apiKey } to the constructor.`,
			meta
		);
	}
	if (status === 403) return new JevPermissionError(message, meta);
	if (status === 404) return new JevNotFoundError(message, meta);
	if (status === 422) return new JevUnprocessableError(message, { ...meta, fields });
	if (status === 429) {
		return new JevRateLimitError(message, { ...meta, retryAfterMs: parseRetryAfter(headers) });
	}
	if (status === 529) return new JevOverloadedError(message, meta);
	if (status >= 500) return new JevServerError(message, meta);

	if (status === 400) {
		if (errorType === 'max_tokens_exceeded') {
			return new JevRequestTooLargeError(
				'The request exceeded the model context budget. jev-1.13 allows about 64k tokens ' +
					'per request, and 32k for the state plus the single longest question. ' +
					'Filter the state down to what the questions actually need, or split the ' +
					'questions across several calls. Call estimate() to check before sending.',
				meta
			);
		}
		return new JevBadRequestError(message, meta);
	}

	return new JevAPIError(message, meta);
}

/**
 * Read a retry delay from `retry-after-ms` or `retry-after`.
 * @param {Object.<string,string>} headers
 * @returns {number|undefined} milliseconds
 */
export function parseRetryAfter(headers = {}) {
	const ms = headers['retry-after-ms'];
	if (ms !== undefined) {
		const n = Number(ms);
		if (Number.isFinite(n) && n >= 0) return n;
	}
	const after = headers['retry-after'];
	if (after === undefined) return undefined;

	const seconds = Number(after);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

	// HTTP-date form.
	const at = Date.parse(after);
	if (!Number.isNaN(at)) return Math.max(0, at - Date.now());

	return undefined;
}
