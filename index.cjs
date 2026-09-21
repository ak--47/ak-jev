var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// errors.js
var errors_exports = {};
__export(errors_exports, {
  JevAPIError: () => JevAPIError,
  JevAbortError: () => JevAbortError,
  JevAuthError: () => JevAuthError,
  JevBadRequestError: () => JevBadRequestError,
  JevConfigError: () => JevConfigError,
  JevConnectionError: () => JevConnectionError,
  JevError: () => JevError,
  JevNotFoundError: () => JevNotFoundError,
  JevOverloadedError: () => JevOverloadedError,
  JevPermissionError: () => JevPermissionError,
  JevRateLimitError: () => JevRateLimitError,
  JevRequestTooLargeError: () => JevRequestTooLargeError,
  JevServerError: () => JevServerError,
  JevTimeoutError: () => JevTimeoutError,
  JevUnprocessableError: () => JevUnprocessableError,
  JevValidationError: () => JevValidationError,
  describeDetail: () => describeDetail,
  errorFromResponse: () => errorFromResponse,
  parseRetryAfter: () => parseRetryAfter
});
function describeDetail(body, status) {
  const detail = body?.detail;
  if (Array.isArray(detail)) {
    const fields = detail.map((d) => ({
      // `loc` starts with "body"; drop it, it is the same for every entry.
      path: Array.isArray(d?.loc) ? d.loc.slice(1).join(".") || "body" : "body",
      message: String(d?.msg ?? "invalid")
    }));
    const summary = fields.map((f) => `${f.path}: ${f.message}`).join("; ");
    return { message: summary || `HTTP ${status}`, errorType: void 0, fields };
  }
  if (detail && typeof detail === "object") {
    const errorType = typeof detail.error_type === "string" ? detail.error_type : void 0;
    const message = typeof detail.message === "string" && detail.message ? detail.message : errorType ? `The API rejected the request: ${errorType}` : `HTTP ${status}`;
    return { message, errorType, fields: [] };
  }
  if (typeof detail === "string" && detail) {
    return { message: detail, errorType: void 0, fields: [] };
  }
  const fallback = typeof body === "string" && body ? body.slice(0, 300) : `HTTP ${status}`;
  return { message: fallback, errorType: void 0, fields: [] };
}
function errorFromResponse({ status, body, headers, requestId }) {
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
    if (errorType === "max_tokens_exceeded") {
      return new JevRequestTooLargeError(
        "The request exceeded the model context budget. jev-1.13 allows about 64k tokens per request, and 32k for the state plus the single longest question. Filter the state down to what the questions actually need, or split the questions across several calls. Call estimate() to check before sending.",
        meta
      );
    }
    return new JevBadRequestError(message, meta);
  }
  return new JevAPIError(message, meta);
}
function parseRetryAfter(headers = {}) {
  const ms = headers["retry-after-ms"];
  if (ms !== void 0) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const after = headers["retry-after"];
  if (after === void 0) return void 0;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1e3;
  const at = Date.parse(after);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return void 0;
}
var JevError, JevConfigError, JevValidationError, JevConnectionError, JevTimeoutError, JevAbortError, JevAPIError, JevAuthError, JevBadRequestError, JevRequestTooLargeError, JevNotFoundError, JevPermissionError, JevUnprocessableError, JevRateLimitError, JevOverloadedError, JevServerError;
var init_errors = __esm({
  "errors.js"() {
    JevError = class extends Error {
      /**
       * @param {string} message
       * @param {Object} [meta={}]
       */
      constructor(message, meta = {}) {
        super(message);
        this.name = new.target.name;
        this.requestId = meta.requestId;
        Error.captureStackTrace?.(this, new.target);
      }
    };
    JevConfigError = class extends JevError {
    };
    JevValidationError = class extends JevError {
      /**
       * @param {string} message
       * @param {Object} [meta={}]
       * @param {string} [meta.questionId] which question is at fault
       */
      constructor(message, meta = {}) {
        super(message, meta);
        this.questionId = meta.questionId;
      }
    };
    JevConnectionError = class extends JevError {
      constructor(message, meta = {}) {
        super(message, meta);
        this.cause = meta.cause;
      }
    };
    JevTimeoutError = class extends JevError {
      constructor(message, meta = {}) {
        super(message, meta);
        this.timeout = meta.timeout;
      }
    };
    JevAbortError = class extends JevError {
    };
    JevAPIError = class extends JevError {
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
        this.status = meta.status ?? 0;
        this.detail = meta.detail;
        this.errorType = meta.errorType;
        this.headers = meta.headers ?? {};
      }
    };
    JevAuthError = class extends JevAPIError {
    };
    JevBadRequestError = class extends JevAPIError {
    };
    JevRequestTooLargeError = class extends JevBadRequestError {
    };
    JevNotFoundError = class extends JevAPIError {
    };
    JevPermissionError = class extends JevAPIError {
    };
    JevUnprocessableError = class extends JevAPIError {
      constructor(message, meta = {}) {
        super(message, meta);
        this.fields = meta.fields ?? [];
      }
    };
    JevRateLimitError = class extends JevAPIError {
      constructor(message, meta = {}) {
        super(message, meta);
        this.retryAfterMs = meta.retryAfterMs;
      }
    };
    JevOverloadedError = class extends JevAPIError {
    };
    JevServerError = class extends JevAPIError {
    };
  }
});

// index.js
var index_exports = {};
__export(index_exports, {
  BUDGET_SAFETY_MARGIN: () => BUDGET_SAFETY_MARGIN,
  BaseJev: () => base_default,
  Classifier: () => classifier_default,
  DEFAULT_BASE_URL: () => DEFAULT_BASE_URL,
  DEFAULT_MODEL: () => DEFAULT_MODEL,
  DEFAULT_RETRY: () => DEFAULT_RETRY,
  DEFAULT_THRESHOLDS: () => DEFAULT_THRESHOLDS,
  DEFAULT_TIMEOUT_MS: () => DEFAULT_TIMEOUT_MS,
  Detector: () => detector_default,
  Evaluator: () => evaluator_default,
  Extractor: () => extractor_default,
  GUARD_ACTIONS: () => GUARD_ACTIONS,
  Governor: () => Governor,
  Guard: () => guard_default,
  JevAPIError: () => JevAPIError,
  JevAbortError: () => JevAbortError,
  JevAuthError: () => JevAuthError,
  JevBadRequestError: () => JevBadRequestError,
  JevClient: () => JevClient,
  JevConfigError: () => JevConfigError,
  JevConnectionError: () => JevConnectionError,
  JevError: () => JevError,
  JevGuardError: () => JevGuardError,
  JevNotFoundError: () => JevNotFoundError,
  JevOverloadedError: () => JevOverloadedError,
  JevPermissionError: () => JevPermissionError,
  JevRateLimitError: () => JevRateLimitError,
  JevRequestTooLargeError: () => JevRequestTooLargeError,
  JevServerError: () => JevServerError,
  JevTimeoutError: () => JevTimeoutError,
  JevUnprocessableError: () => JevUnprocessableError,
  JevValidationError: () => JevValidationError,
  MODELS_PATH: () => MODELS_PATH,
  MODEL_ALIASES: () => MODEL_ALIASES,
  MODEL_LIMITS: () => MODEL_LIMITS,
  MODEL_PRICING: () => MODEL_PRICING,
  MODEL_PRICING_AS_OF: () => MODEL_PRICING_AS_OF,
  NOT_STATED: () => NOT_STATED,
  QUESTION_META: () => QUESTION_META,
  QUESTION_TYPES: () => QUESTION_TYPES,
  Ranker: () => ranker_default,
  ResponseCache: () => ResponseCache,
  Router: () => router_default,
  SYSTEM_ONE_PATH: () => SYSTEM_ONE_PATH,
  Scorer: () => scorer_default,
  Taxonomy: () => taxonomy_default,
  ask: () => ask,
  backoffDelay: () => backoffDelay,
  cacheKey: () => cacheKey,
  canonicalize: () => canonicalize,
  choice: () => choice,
  client: () => client,
  computeCost: () => computeCost,
  default: () => index_default,
  describeDetail: () => describeDetail,
  enrichAnswer: () => enrichAnswer,
  enrichAnswers: () => enrichAnswers,
  errorFromResponse: () => errorFromResponse,
  estimate: () => estimate,
  estimateQuestionTokens: () => estimateQuestionTokens,
  estimateRequest: () => estimateRequest,
  estimateTokens: () => estimateTokens,
  expandQuestions: () => expandQuestions,
  listModels: () => listModels,
  log: () => logger_default,
  models: () => models,
  normalizeOptions: () => normalizeOptions,
  normalizedEntropy: () => normalizedEntropy,
  noul: () => noul,
  parseRetryAfter: () => parseRetryAfter,
  questionMeta: () => questionMeta,
  rank: () => rank,
  resetClient: () => resetClient,
  resolveCache: () => resolveCache,
  resolveLimits: () => resolveLimits,
  resolveModelId: () => resolveModelId,
  resolvePricing: () => resolvePricing,
  sample: () => sample,
  score: () => score,
  sleep: () => sleep,
  toWireQuestions: () => toWireQuestions,
  validateQuestions: () => validateQuestions
});
module.exports = __toCommonJS(index_exports);

// base.js
var import_config = require("dotenv/config");

// client.js
init_errors();

// models.js
init_errors();
var DEFAULT_MODEL = "jev-latest";
var DEFAULT_BASE_URL = "https://api.typesafe.ai";
var SYSTEM_ONE_PATH = "/v1/systemone";
var MODELS_PATH = "/v1/models";
var MODEL_PRICING_AS_OF = "2026-09-21";
var MODEL_PRICING = Object.freeze({
  "jev-1.13.0": { input: 0.042, output: 0 }
});
var MODEL_ALIASES = Object.freeze({
  "jev-latest": "jev-1.13.0",
  "jev-preview": "jev-1.13.0",
  // The docs use the bare minor version in one example; accept it.
  "jev-1.13": "jev-1.13.0"
});
var MODEL_LIMITS = Object.freeze({
  "jev-1.13.0": Object.freeze({
    /** Total tokens per request: state + every question. */
    contextTokens: 64e3,
    /**
     * State plus the single longest question. The tighter of the two budgets,
     * and the one you actually hit. Measured: a single-question request was
     * accepted at 32,698 input tokens and rejected above it.
     */
    stateTokens: 32e3,
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
    tokensPerSecond: 25e4,
    /**
     * Measured exactly: an empty state with a one-character question bills
     * 267 input tokens before any of your own content.
     */
    requestOverheadTokens: 267
  })
});
function resolveModelId(model) {
  if (!model) return MODEL_ALIASES[DEFAULT_MODEL];
  return MODEL_ALIASES[model] ?? model;
}
function resolvePricing(model) {
  const modelId = resolveModelId(model);
  const rates = MODEL_PRICING[modelId];
  if (!rates) return null;
  return { ...rates, asOf: MODEL_PRICING_AS_OF, modelId };
}
function resolveLimits(model) {
  const modelId = resolveModelId(model);
  return MODEL_LIMITS[modelId] ?? MODEL_LIMITS["jev-1.13.0"];
}
function computeCost(usage, model) {
  const pricing = resolvePricing(model);
  if (!pricing) return null;
  const input = (usage?.inputTokens ?? 0) / 1e6 * pricing.input;
  const output = (usage?.outputTokens ?? 0) / 1e6 * pricing.output;
  return input + output;
}
async function listModels(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  if (!apiKey) {
    throw new JevValidationError(
      "listModels() needs an API key. Pass { apiKey } or set TYPESAFE_API_KEY."
    );
  }
  const baseURL = (opts.baseURL ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(`${baseURL}${MODELS_PATH}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: opts.signal
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const { errorFromResponse: errorFromResponse2 } = await Promise.resolve().then(() => (init_errors(), errors_exports));
    throw errorFromResponse2({
      status: res.status,
      body,
      headers: Object.fromEntries(res.headers),
      requestId: res.headers.get("x-typesafe-request-id") ?? void 0
    });
  }
  return body?.models ?? [];
}

// governor.js
var SlidingWindow = class {
  /**
   * @param {number} limit
   * @param {number} windowMs
   */
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.events = [];
  }
  /** Drop events that have aged out. @param {number} now */
  _prune(now) {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.events.length && this.events[i].at <= cutoff) i++;
    if (i > 0) this.events.splice(0, i);
  }
  /**
   * Milliseconds to wait before `weight` more units would fit. 0 means now.
   * @param {number} weight
   * @param {number} now
   * @returns {number}
   */
  delayFor(weight, now) {
    if (this.limit <= 0) return 0;
    this._prune(now);
    let used = 0;
    for (const e of this.events) used += e.weight;
    if (used + weight <= this.limit) return 0;
    let freed = 0;
    const need = used + weight - this.limit;
    for (const e of this.events) {
      freed += e.weight;
      if (freed >= need) return Math.max(1, e.at + this.windowMs - now);
    }
    return 0;
  }
  /** @param {number} weight @param {number} now */
  record(weight, now) {
    this.events.push({ at: now, weight });
  }
};
var Governor = class {
  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.concurrency=8] simultaneous in-flight requests
   * @param {number} [opts.requestsPerMinute=1000] under the published 1,200
   * @param {number} [opts.tokensPerSecond=200000] under the published 250,000
   */
  constructor(opts = {}) {
    this.concurrency = positive(opts.concurrency, 8);
    this.requestsPerMinute = positive(opts.requestsPerMinute, 1e3);
    this.tokensPerSecond = positive(opts.tokensPerSecond, 2e5);
    this._rpm = new SlidingWindow(this.requestsPerMinute, 6e4);
    this._tps = new SlidingWindow(this.tokensPerSecond, 1e3);
    this._active = 0;
    this._waiting = [];
    this.stats = { admitted: 0, throttledMs: 0, peakQueued: 0 };
  }
  /**
   * Run `fn` once a slot is free and the rate windows allow it.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {Object} [opts={}]
   * @param {number} [opts.tokens=0] estimated input tokens, for the TPS window
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<T>}
   */
  async run(fn, opts = {}) {
    const tokens = Math.max(0, opts.tokens ?? 0);
    await this._acquire(opts.signal);
    try {
      await this._pace(tokens, opts.signal);
      const now = Date.now();
      this._rpm.record(1, now);
      this._tps.record(tokens, now);
      this.stats.admitted++;
      return await fn();
    } finally {
      this._release();
    }
  }
  /** @param {AbortSignal|undefined} signal */
  async _acquire(signal) {
    if (this._active < this.concurrency) {
      this._active++;
      return;
    }
    this.stats.peakQueued = Math.max(this.stats.peakQueued, this._waiting.length + 1);
    await new Promise((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener("abort", onAbort);
        this._active++;
        resolve(void 0);
      };
      const onAbort = () => {
        const i = this._waiting.indexOf(admit);
        if (i >= 0) this._waiting.splice(i, 1);
        reject(signal?.reason ?? new Error("Aborted while queued"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this._waiting.push(admit);
    });
  }
  _release() {
    this._active--;
    const next = this._waiting.shift();
    if (next) next();
  }
  /**
   * Sleep until both rate windows have room.
   * @param {number} tokens
   * @param {AbortSignal|undefined} signal
   */
  async _pace(tokens, signal) {
    for (; ; ) {
      const now = Date.now();
      const wait = Math.max(this._rpm.delayFor(1, now), this._tps.delayFor(tokens, now));
      if (wait <= 0) return;
      this.stats.throttledMs += wait;
      await sleep(wait, signal);
    }
  }
  /** Current utilisation, for `stats()` and for tests. */
  snapshot() {
    const now = Date.now();
    this._rpm._prune(now);
    this._tps._prune(now);
    return {
      active: this._active,
      queued: this._waiting.length,
      requestsInWindow: this._rpm.events.length,
      tokensInWindow: this._tps.events.reduce((a, e) => a + e.weight, 0),
      ...this.stats
    };
  }
};
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function positive(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

// logger.js
var import_pino = __toESM(require("pino"), 1);
var isDev = process.env.NODE_ENV !== "production";
var logger = (0, import_pino.default)({
  level: process.env.LOG_LEVEL || "info",
  // fatal | error | warn | info | debug | trace | silent
  messageKey: "message",
  // GCP expects 'message' rather than pino's default 'msg'
  transport: isDev ? { target: "pino-pretty", options: { colorize: true, translateTime: true } } : void 0
});
var logger_default = logger;

// client.js
var DEFAULT_RETRY = Object.freeze({
  maxRetries: 3,
  backoffInitialMs: 500,
  backoffMaxMs: 5e3,
  backoffJitter: 0.25,
  httpStatuses: Object.freeze([408, 409, 429, 500, 502, 503, 504, 529]),
  respectRetryAfter: true,
  maxRetryAfterMs: 6e4,
  apiConnectionError: true,
  apiTimeoutError: true
});
var DEFAULT_TIMEOUT_MS = 3e4;
var JevClient = class {
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
        "No API key. Pass { apiKey } to the constructor, or set TYPESAFE_API_KEY in the environment. Get a key at https://console.typesafe.ai/keys"
      );
    }
    this.apiKey = apiKey;
    this.baseURL = (config.baseURL ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY, ...config.retry ?? {} };
    this.defaultHeaders = { ...config.defaultHeaders ?? {} };
    this.fetch = config.fetch ?? globalThis.fetch;
    this.governor = config.governor ?? new Governor();
    this.userAgent = config.userAgent ?? "ak-jev";
    if (typeof this.fetch !== "function") {
      throw new JevConfigError(
        "No fetch implementation. ak-jev needs Node 22+ (which has a global fetch), or a { fetch } option."
      );
    }
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
    return this.request("POST", SYSTEM_ONE_PATH, body, options);
  }
  /**
   * `GET /v1/models`. Unwraps the `{ models: [...] }` envelope.
   *
   * @param {JevRequestOptions} [options={}]
   * @returns {Promise<Array<{name: string, description: string, release_date: string}>>}
   */
  async models(options = {}) {
    const { data } = await this.request("GET", MODELS_PATH, void 0, options);
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
    const retry = { ...this.retry, ...options.retry ?? {} };
    const retryable = new Set(retry.httpStatuses);
    const timeout = options.timeout ?? this.timeout;
    const url = `${this.baseURL}${path}`;
    const payload = body === void 0 ? void 0 : JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...this.defaultHeaders,
      ...options.headers ?? {},
      ...payload !== void 0 ? { "Content-Type": "application/json" } : {}
    };
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
        if (options.signal?.aborted) throw new JevAbortError("The request was aborted by the caller.");
        const canRetry = attempt < retry.maxRetries && isRetryable(err, retry, retryable);
        if (!canRetry) break;
        const delay = backoffDelay(err, attempt, retry);
        logger_default.debug(
          { attempt: attempt + 1, of: retry.maxRetries, delay, status: err?.status, err: err?.message },
          "ak-jev: retrying"
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
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const started = Date.now();
    this.counters.requests++;
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
      if (signal?.aborted) throw new JevAbortError("The request was aborted by the caller.");
      throw new JevConnectionError(
        `Could not reach ${url}: ${/** @type {Error} */
        err?.message ?? "connection failed"}`,
        { cause: (
          /** @type {Error} */
          err
        ) }
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const latencyMs = Date.now() - started;
    const responseHeaders = Object.fromEntries(res.headers);
    const requestId = res.headers.get("x-typesafe-request-id") ?? void 0;
    const text = await res.text().catch(() => "");
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
};
function isRetryable(err, retry, retryable) {
  if (err instanceof JevTimeoutError) return retry.apiTimeoutError;
  if (err instanceof JevConnectionError) return retry.apiConnectionError;
  if (typeof err?.status === "number") return retryable.has(err.status);
  return false;
}
function backoffDelay(err, attempt, retry) {
  if (retry.respectRetryAfter && err instanceof JevRateLimitError && err.retryAfterMs !== void 0) {
    if (err.retryAfterMs <= retry.maxRetryAfterMs) return err.retryAfterMs;
  }
  const base = Math.min(retry.backoffInitialMs * 2 ** attempt, retry.backoffMaxMs);
  return Math.max(0, base * (1 - Math.random() * retry.backoffJitter));
}

// cache.js
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}
function cacheKey({ baseURL, model, state, questions }) {
  const payload = canonicalize({ baseURL, model, state, questions });
  return (0, import_node_crypto.createHash)("sha256").update(payload).digest("hex");
}
var ResponseCache = class {
  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.max=1000] entries held in memory
   * @param {number} [opts.ttlMs] optional expiry; omitted means never
   * @param {string} [opts.dir] optional directory for write-through persistence
   */
  constructor(opts = {}) {
    this.max = opts.max ?? 1e3;
    this.ttlMs = opts.ttlMs;
    this.dir = opts.dir;
    this._map = /* @__PURE__ */ new Map();
    this.hits = 0;
    this.misses = 0;
    if (this.dir) (0, import_node_fs.mkdirSync)(this.dir, { recursive: true });
  }
  /**
   * @param {string} key
   * @returns {any|undefined}
   */
  get(key) {
    const entry = this._map.get(key) ?? this._readDisk(key);
    if (!entry) {
      this.misses++;
      return void 0;
    }
    if (this.ttlMs !== void 0 && Date.now() - entry.at > this.ttlMs) {
      this._map.delete(key);
      this.misses++;
      return void 0;
    }
    this._remember(key, entry);
    this.hits++;
    return entry.value;
  }
  /**
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    this._remember(key, { at: Date.now(), value });
    if (this.dir) this._writeDisk(key, value);
  }
  /**
   * Put an entry in the map and evict down to `max`.
   *
   * Every write goes through here, including the ones that come back off disk.
   * A disk read that wrote straight to the map would let a long run over a large
   * corpus grow memory without bound, which is exactly the run a disk cache is
   * for.
   *
   * @param {string} key
   * @param {{at: number, value: any}} entry
   */
  _remember(key, entry) {
    this._map.delete(key);
    this._map.set(key, entry);
    while (this._map.size > this.max) {
      const oldest = this._map.keys().next().value;
      if (oldest === void 0) break;
      this._map.delete(oldest);
    }
  }
  clear() {
    this._map.clear();
  }
  get size() {
    return this._map.size;
  }
  /** @param {string} key */
  _readDisk(key) {
    if (!this.dir) return void 0;
    const path = (0, import_node_path.join)(this.dir, `${key}.json`);
    if (!(0, import_node_fs.existsSync)(path)) return void 0;
    try {
      const parsed = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
      const entry = { at: parsed.at ?? Date.now(), value: parsed.value };
      this._remember(key, entry);
      return entry;
    } catch {
      return void 0;
    }
  }
  /** @param {string} key @param {any} value */
  _writeDisk(key, value) {
    if (!this.dir) return;
    try {
      (0, import_node_fs.writeFileSync)((0, import_node_path.join)(this.dir, `${key}.json`), JSON.stringify({ at: Date.now(), value }));
    } catch {
    }
  }
};
function resolveCache(option = false) {
  if (option === false || option === null || option === void 0) return null;
  if (option instanceof ResponseCache) return option;
  if (option === true) return new ResponseCache();
  return new ResponseCache(option);
}

// answers.js
init_errors();
var DEFAULT_THRESHOLDS = Object.freeze({
  /** `answer.yes` is true at or above this. */
  yes: 0.5,
  /** `answer.verdict` is `'yes'` at or above this. */
  high: 0.8,
  /** `answer.verdict` is `'no'` at or below this. Between the two it is `'unsure'`. */
  low: 0.2
});
function enrichAnswer(id, raw, opts = {}) {
  if (!raw || typeof raw !== "object") return raw;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds ?? {} };
  if (raw.type === "noul") return enrichNoul(id, raw, thresholds);
  if (raw.type === "choice") return enrichChoice(id, raw);
  if (raw.type === "score") return enrichScore(id, raw, opts.levelNames);
  return { id, ...raw };
}
function enrichNoul(id, raw, t) {
  const p = numberOr(raw.noul, 0);
  return {
    id,
    type: "noul",
    noul: p,
    /** Thresholded at `thresholds.yes`. */
    yes: p >= t.yes,
    /** Three-way: `'yes'`, `'no'`, or `'unsure'` in the band between. */
    verdict: p >= t.high ? "yes" : p <= t.low ? "no" : "unsure",
    /**
     * DERIVED BY ak-jev, not returned by the API. `|p - 0.5| * 2`, so 0.5 maps
     * to 0 and both extremes map to 1. It exists so one gating expression works
     * across all three question types. A Noul's own probability already
     * describes its two-outcome distribution completely.
     */
    confidence: Math.abs(p - 0.5) * 2,
    thresholds: { yes: t.yes, high: t.high, low: t.low }
  };
}
function enrichChoice(id, raw) {
  const probabilities = raw.probabilities ?? {};
  const ranked = rank(probabilities);
  const top = ranked[0];
  const second = ranked[1] ?? null;
  return {
    id,
    type: "choice",
    choice: raw.choice,
    confidence: numberOr(raw.confidence, 0),
    probabilities,
    /** Every option, highest probability first. */
    ranked,
    /** Second place, or `null` when there is only one option. */
    runnerUp: second,
    /** Top probability minus second. A small margin is a close call. */
    margin: top && second ? top.probability - second.probability : top ? top.probability : 0,
    /** Normalized Shannon entropy, 0 (one clear winner) to 1 (flat). */
    entropy: normalizedEntropy(Object.values(probabilities))
  };
}
function enrichScore(id, raw, levelNames) {
  const probabilities = raw.probabilities ?? {};
  const legend = raw.legend ?? {};
  const levelCount = Object.keys(legend).length || Object.keys(probabilities).length;
  const topLevel = Math.max(0, levelCount - 1);
  const value = numberOr(raw.score, 0);
  const nearest = Math.round(value);
  const label = levelNames?.[nearest] ?? describeLevel(legend[String(nearest)]);
  return {
    id,
    type: "score",
    score: value,
    confidence: numberOr(raw.confidence, 0),
    legend,
    probabilities,
    /** How many levels this rubric has. */
    levels: levelCount,
    /**
     * `score / (levels - 1)`, so 0–1 regardless of rubric length. Always
     * normalize before weighting two scores against each other — a 4-level
     * scale tops out at 3 and a 3-level scale at 2.
     */
    normalized: topLevel > 0 ? value / topLevel : 0,
    /** The nearest whole level. */
    level: nearest,
    /** The level name from `score()`'s object form, else the legend text. */
    label,
    /** Every level, highest probability first. Keys are level numbers as strings. */
    ranked: rank(probabilities),
    /** Normalized Shannon entropy, 0 (one clear level) to 1 (flat). */
    entropy: normalizedEntropy(Object.values(probabilities))
  };
}
function enrichAnswers(answers, opts = {}) {
  const out = {};
  for (const [id, raw] of Object.entries(answers ?? {})) {
    out[id] = enrichAnswer(id, raw, {
      thresholds: opts.thresholds,
      levelNames: opts.meta?.[id]?.levelNames
    });
  }
  return out;
}
function requireAnswers(answers, ids, className) {
  const missing = ids.filter((id) => !answers?.[id]);
  if (missing.length === 0) return;
  throw new JevValidationError(
    `${className}: the API returned no answer for ${missing.map((m) => `"${m}"`).join(", ")}. Expected ${ids.length} answers, got ${Object.keys(answers ?? {}).length}. A question id passed through opts.questions may have collided with one of the class's own ids.`,
    { questionId: missing[0] }
  );
}
function rank(probabilities) {
  return Object.entries(probabilities ?? {}).map(([label, probability]) => ({ label, probability: numberOr(probability, 0) })).sort((a, b) => b.probability - a.probability || a.label.localeCompare(b.label));
}
function normalizedEntropy(values) {
  const ps = (values ?? []).map((v) => numberOr(v, 0)).filter((p) => p > 0);
  if (ps.length <= 1) return 0;
  const total = ps.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const p of ps) {
    const q = p / total;
    h -= q * Math.log(q);
  }
  const n = (values ?? []).length;
  return n > 1 ? h / Math.log(n) : 0;
}
function numberOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function describeLevel(entry) {
  return entry === void 0 ? null : entry;
}

// questions.js
init_errors();
var QUESTION_META = /* @__PURE__ */ Symbol("ak-jev.question.meta");
var QUESTION_TYPES = Object.freeze(["noul", "choice", "score"]);
function noul(instructions, criteria) {
  if (instructions === void 0 && criteria === void 0) {
    throw new JevValidationError(
      "noul() needs instructions, criteria, or both. The API rejects a Noul with neither."
    );
  }
  const q = { type: "noul" };
  if (instructions !== void 0) q.instructions = instructions;
  if (criteria !== void 0) q.criteria = criteria;
  return q;
}
function choice(instructions, criteria) {
  const expanded = expandChoiceCriteria(criteria);
  return { type: "choice", instructions, criteria: expanded };
}
function score(instructions, criteria) {
  const { levels, names } = expandScoreCriteria(criteria);
  const q = { type: "score", instructions, criteria: levels };
  if (names) q[QUESTION_META] = { levelNames: names };
  return q;
}
function expandChoiceCriteria(criteria) {
  if (Array.isArray(criteria)) {
    const out = {};
    for (const label of criteria) {
      if (typeof label !== "string") {
        throw new JevValidationError(
          `choice() was given an array, so every entry must be a label string. Got ${typeof label}. To describe options, pass a { label: description } map instead.`
        );
      }
      out[label] = null;
    }
    return out;
  }
  if (criteria && typeof criteria === "object") return { ...criteria };
  throw new JevValidationError(
    "choice() needs criteria: either a { label: description } map or an array of label strings."
  );
}
function expandScoreCriteria(criteria) {
  if (Array.isArray(criteria)) return { levels: [...criteria], names: null };
  if (criteria && typeof criteria === "object") {
    const names = Object.keys(criteria);
    return { levels: names.map((k) => criteria[k]), names };
  }
  throw new JevValidationError(
    "score() needs criteria: either an ordered array of level descriptions, or an ordered { name: description } object."
  );
}
function expandQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw new JevValidationError(
      "questions must be an object keyed by the ids you want the answers under."
    );
  }
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    if (typeof q === "string") {
      out[id] = noul(q);
      continue;
    }
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      throw new JevValidationError(
        `Question "${id}" must be a question object or a string. Use noul(), choice() or score() to build one.`,
        { questionId: id }
      );
    }
    out[id] = q;
  }
  return out;
}
function toWireQuestions(questions) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const wire = { type: q.type };
    if (q.instructions !== void 0) wire.instructions = q.instructions;
    if (
      /** @type {any} */
      q.criteria !== void 0
    ) wire.criteria = /** @type {any} */
    q.criteria;
    out[id] = wire;
  }
  return out;
}
function questionMeta(question) {
  return question?.[QUESTION_META] ?? {};
}
function validateQuestions(questions, opts = {}) {
  const limits = resolveLimits(opts.model);
  const ids = Object.keys(questions ?? {});
  if (ids.length === 0) {
    throw new JevValidationError(
      "At least one question is required. The API returns 422 for an empty questions map."
    );
  }
  const warnings = [];
  for (const id of ids) {
    const q = (
      /** @type {any} */
      questions[id]
    );
    if (!QUESTION_TYPES.includes(q?.type)) {
      throw new JevValidationError(
        `Question "${id}" has type ${JSON.stringify(q?.type)}. Expected one of: ${QUESTION_TYPES.join(", ")}.`,
        { questionId: id }
      );
    }
    if (q.type === "noul") {
      const hasInstructions = q.instructions !== void 0 && q.instructions !== null;
      const hasCriteria = q.criteria !== void 0 && q.criteria !== null;
      if (!hasInstructions && !hasCriteria) {
        throw new JevValidationError(
          `Noul question "${id}" has neither instructions nor criteria. The API rejects it with 400.`,
          { questionId: id }
        );
      }
      if (hasCriteria && (typeof q.criteria !== "object" || Array.isArray(q.criteria))) {
        throw new JevValidationError(
          `Noul question "${id}" has criteria that are not an object. Noul criteria are { true: ..., false: ... }.`,
          { questionId: id }
        );
      }
      continue;
    }
    if (q.type === "choice") {
      if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) {
        throw new JevValidationError(
          `Choice question "${id}" needs criteria as a { label: description } map. Pass an array of labels to choice() if you want them expanded for you.`,
          { questionId: id }
        );
      }
      const n = Object.keys(q.criteria).length;
      if (n < limits.minChoiceOptions) {
        throw new JevValidationError(
          `Choice question "${id}" has no options. The API rejects it with 400.`,
          { questionId: id }
        );
      }
      if (n > limits.maxChoiceOptions) {
        throw new JevValidationError(
          `Choice question "${id}" has ${n} options; the API allows at most ${limits.maxChoiceOptions}. Split the options across a two-level Taxonomy walk, or group the tail under an "other" option.`,
          { questionId: id }
        );
      }
      continue;
    }
    if (!Array.isArray(q.criteria)) {
      throw new JevValidationError(
        `Score question "${id}" needs criteria as an ordered array of level descriptions, lowest level first. Pass an ordered object to score() to name the levels.`,
        { questionId: id }
      );
    }
    if (q.criteria.length < limits.minScoreLevels) {
      throw new JevValidationError(
        `Score question "${id}" has no levels.`,
        { questionId: id }
      );
    }
    if (q.criteria.length > limits.maxScoreLevels) {
      throw new JevValidationError(
        `Score question "${id}" has ${q.criteria.length} levels; the API allows at most ${limits.maxScoreLevels}.`,
        { questionId: id }
      );
    }
    if (q.criteria.length < 2) {
      warnings.push(
        `Score question "${id}" has one level. The API accepts this and always returns score 0.0 at confidence 1.0, which tells you nothing. Add levels, or use a Noul.`
      );
    }
  }
  return { warnings };
}

// tokens.js
var CHARS_PER_TOKEN = 3.6;
var BUDGET_SAFETY_MARGIN = 1.25;
var PER_QUESTION_OVERHEAD = 8;
function estimateTokens(value) {
  if (value === null || value === void 0) return 0;
  const text = typeof value === "string" ? value : safeStringify(value);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function estimateQuestionTokens(question) {
  if (!question) return 0;
  return estimateTokens(question.instructions) + estimateTokens(question.criteria) + PER_QUESTION_OVERHEAD;
}
function estimateRequest({ state, questions, model }) {
  const limits = resolveLimits(model);
  const stateTokens = estimateTokens(state);
  const perQuestion = {};
  let questionTokens = 0;
  let longestQuestion = 0;
  let longestQuestionId = null;
  for (const [id, question] of Object.entries(questions ?? {})) {
    const n = estimateQuestionTokens(question);
    perQuestion[id] = n;
    questionTokens += n;
    if (n > longestQuestion) {
      longestQuestion = n;
      longestQuestionId = id;
    }
  }
  const totalTokens = limits.requestOverheadTokens + stateTokens + questionTokens;
  const widestPath = limits.requestOverheadTokens + stateTokens + longestQuestion;
  const budgetTokens = Math.ceil(totalTokens * BUDGET_SAFETY_MARGIN);
  const budgetWidestPath = Math.ceil(widestPath * BUDGET_SAFETY_MARGIN);
  const warnings = [];
  if (budgetTokens > limits.contextTokens) {
    warnings.push(
      `Estimated ${totalTokens} tokens (${budgetTokens} with the safety margin) may exceed the ${limits.contextTokens}-token request budget. Split the ${Object.keys(questions ?? {}).length} questions across several calls.`
    );
  }
  if (budgetWidestPath > limits.stateTokens) {
    warnings.push(
      `Estimated ${widestPath} tokens (${budgetWidestPath} with the safety margin) for the state plus the longest question (${longestQuestionId}) may exceed the ${limits.stateTokens}-token budget. Filter the state down to what the question needs.`
    );
  }
  return {
    stateTokens,
    questionTokens,
    overheadTokens: limits.requestOverheadTokens,
    totalTokens,
    budgetTokens,
    longestQuestionId,
    longestQuestionTokens: longestQuestion,
    widestPathTokens: widestPath,
    budgetWidestPathTokens: budgetWidestPath,
    perQuestion,
    questionCount: Object.keys(questions ?? {}).length,
    limits,
    withinBudget: warnings.length === 0,
    warnings
  };
}
function safeStringify(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "bigint") return String(v);
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    }) ?? "";
  } catch {
    return String(value);
  }
}

// base.js
init_errors();
var BaseJev = class {
  /**
   * @param {JevOptions} [options={}]
   */
  constructor(options = {}) {
    const o = normalizeOptions(options);
    this.modelName = o.modelName;
    this.baseURL = o.baseURL;
    this.thresholds = o.thresholds;
    this.validate = o.validate;
    this.checkBudget = o.checkBudget;
    this.healthCheck = o.healthCheck;
    this.onResult = o.onResult;
    if (o.logLevel) logger_default.level = o.logLevel === "none" ? "silent" : o.logLevel;
    this.governor = new Governor({
      concurrency: o.concurrency,
      requestsPerMinute: o.requestsPerMinute,
      tokensPerSecond: o.tokensPerSecond
    });
    this.cache = resolveCache(o.cache);
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
      const models2 = await this.client.models();
      logger_default.debug({ models: models2.map((m) => m.name) }, "ak-jev: health check passed");
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
        const result2 = this._buildResult(hit, {
          prepared,
          requestedModel: model,
          cached: true,
          latencyMs: 0,
          requestId: void 0
        });
        this.onResult?.(result2);
        return result2;
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
      throw new JevValidationError("evaluateMany() needs an array of states.");
    }
    if (!this._initialized) await this.init();
    const total = states.length;
    let done = 0;
    const out = new Array(total);
    await Promise.all(
      states.map(async (state, index) => {
        try {
          out[index] = await this.evaluate(state, questions, opts);
        } catch (error) {
          if (opts.throwOnError) throw error;
          out[index] = { index, error: (
            /** @type {Error} */
            error
          ), failed: true };
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
    const { n: requested, ...evaluateOpts } = opts;
    const n = Math.max(1, Math.floor(requested ?? 5));
    const draws = await Promise.all(
      Array.from(
        { length: n },
        () => (
          // `cache: false` is not enough here — the instance may have one. Pass a
          // per-call marker that `evaluate()` honours.
          this.evaluate(state, questions, { ...evaluateOpts, _bypassCache: true })
        )
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
      for (const w of warnings) logger_default.warn(`ak-jev: ${w}`);
    }
    const meta = {};
    for (const [id, q] of Object.entries(expanded)) {
      const m = questionMeta(q);
      if (m.levelNames) meta[id] = m;
    }
    const wire = toWireQuestions(expanded);
    const estimate2 = estimateRequest({ state, questions: wire, model });
    if (this.checkBudget && !estimate2.withinBudget) {
      for (const w of estimate2.warnings) logger_default.warn(`ak-jev: ${w}`);
    }
    return { expanded, wire, meta, estimate: estimate2 };
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
    const usage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      // A cache hit costs nothing because no request was made. It is reported
      // as 0 with `cached: true`, never silently folded into the estimate.
      estimatedCost: cached ? 0 : computeCost({ inputTokens, outputTokens }, model),
      // This API returns no cost header, so every non-cached figure is a
      // table estimate. Named for parity with the sibling packages.
      costSource: cached ? "cached" : "estimated",
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
};
function normalizeOptions(raw = {}) {
  const modelName = raw.modelName ?? raw.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL;
  if (raw.thresholds) {
    for (const k of Object.keys(raw.thresholds)) {
      if (!["yes", "high", "low"].includes(k)) {
        throw new JevConfigError(
          `Unknown threshold "${k}". Valid keys are: yes, high, low.`
        );
      }
    }
  }
  return {
    modelName,
    apiKey: raw.apiKey,
    baseURL: (raw.baseURL ?? process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai").replace(/\/+$/, ""),
    timeout: raw.timeout,
    retry: raw.retry,
    defaultHeaders: raw.defaultHeaders,
    fetch: raw.fetch,
    logLevel: raw.logLevel,
    healthCheck: raw.healthCheck ?? false,
    thresholds: { ...DEFAULT_THRESHOLDS, ...raw.thresholds ?? {} },
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
function summarizeDraws(draws) {
  const summary = {};
  const ids = Object.keys(draws[0]?.answers ?? {});
  for (const id of ids) {
    const answers = draws.map((d) => d.answers[id]).filter(Boolean);
    if (answers.length === 0) continue;
    const type = answers[0].type;
    if (type === "noul") {
      const values = answers.map((a) => a.noul);
      summary[id] = {
        type,
        ...spread(values),
        values,
        // How often the draws landed on the same three-way verdict.
        ...modeAgreement(answers.map((a) => a.verdict), "verdict")
      };
    } else if (type === "choice") {
      const confidences = answers.map((a) => a.confidence);
      summary[id] = {
        type,
        ...modeAgreement(answers.map((a) => a.choice), "choice"),
        confidence: spread(confidences),
        values: answers.map((a) => a.choice)
      };
    } else if (type === "score") {
      const values = answers.map((a) => a.score);
      summary[id] = {
        type,
        ...spread(values),
        values,
        ...modeAgreement(answers.map((a) => String(a.level)), "level")
      };
    }
  }
  return summary;
}
function spread(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, min, max, spread: max - min, stdev: Math.sqrt(variance) };
}
function modeAgreement(values, key) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  const [winner, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { [key]: winner, agreement: count / values.length, counts };
}
function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    costSource: "estimated",
    requests: 0,
    cached: false,
    questions: 0
  };
}
function accumulate(total, one) {
  total.inputTokens += one.inputTokens;
  total.outputTokens += one.outputTokens;
  total.totalTokens += one.totalTokens;
  total.requests += one.requests;
  total.questions += one.questions;
  if (one.estimatedCost !== null && total.estimatedCost !== null) {
    total.estimatedCost += one.estimatedCost;
  } else {
    total.estimatedCost = null;
  }
}
var base_default = BaseJev;

// evaluator.js
init_errors();
var Evaluator = class extends base_default {
  /**
   * @param {import('./base.js').JevOptions & {questions?: Object.<string, any>}} [options={}]
   */
  constructor(options = {}) {
    super(options);
    this.questions = options.questions ? expandQuestions(options.questions) : {};
    logger_default.debug({ questions: Object.keys(this.questions).length }, "ak-jev: Evaluator created");
  }
  /**
   * Add or replace questions after construction. Returns `this` so it chains.
   *
   * @param {Object.<string, any>} questions
   * @returns {this}
   */
  addQuestions(questions) {
    Object.assign(this.questions, expandQuestions(questions));
    return this;
  }
  /**
   * Remove questions by id. Returns `this` so it chains.
   * @param {...string} ids
   * @returns {this}
   */
  removeQuestions(...ids) {
    for (const id of ids) delete this.questions[id];
    return this;
  }
  /**
   * Evaluate one state against the bound question set.
   *
   * @param {any} state
   * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
   *   `questions` here are merged over the bound set for this call only.
   * @returns {Promise<import('./base.js').JevResult>}
   */
  async run(state, opts = {}) {
    return this.evaluate(state, this._questionsFor(opts), opts);
  }
  /**
   * Evaluate many states against the bound question set, in parallel.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Array<import('./base.js').JevResult|import('./base.js').JevFailure>>}
   */
  async runMany(states, opts = {}) {
    return this.evaluateMany(states, this._questionsFor(opts), opts);
  }
  /**
   * Evaluate many states and yield each result as it lands, in completion order
   * rather than input order.
   *
   * Use this over `runMany()` when you want to start acting on early results
   * instead of waiting for the whole corpus. Each yielded item carries its
   * `index` and the original `state` so you can tell them apart.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
   * @yields {{index: number, state: any, result?: import('./base.js').JevResult, error?: Error}}
   */
  async *stream(states, opts = {}) {
    if (!Array.isArray(states)) {
      throw new JevValidationError("stream() needs an array of states.");
    }
    const questions = this._questionsFor(opts);
    const pending = states.map(
      (state, index) => this.evaluate(state, questions, opts).then(
        (result) => ({ index, state, result }),
        (error) => {
          if (opts.throwOnError) throw error;
          return { index, state, error };
        }
      )
    );
    const outstanding = new Map(pending.map((p, i) => [i, p.then((v) => ({ slot: i, v }))]));
    while (outstanding.size > 0) {
      const { slot, v } = await Promise.race(outstanding.values());
      outstanding.delete(slot);
      yield v;
    }
  }
  /**
   * The questions for one call: the bound set, with per-call overrides merged in.
   * @param {{questions?: Object.<string, any>}} opts
   */
  _questionsFor(opts) {
    const extra = opts.questions ? expandQuestions(opts.questions) : null;
    const questions = extra ? { ...this.questions, ...extra } : this.questions;
    if (Object.keys(questions).length === 0) {
      throw new JevValidationError(
        "Evaluator has no questions. Pass { questions } to the constructor, call addQuestions(), or pass { questions } to this call."
      );
    }
    return questions;
  }
};
var evaluator_default = Evaluator;

// classifier.js
init_errors();
var Classifier = class extends base_default {
  /**
   * @param {ClassifierOptions} options
   */
  constructor(options = (
    /** @type {any} */
    {}
  )) {
    super(options);
    if (!options.labels) {
      throw new JevValidationError(
        "Classifier needs { labels }: either a { label: description } map or an array of labels."
      );
    }
    this.instructions = options.instructions ?? "Which of these best describes the content?";
    this.question = choice(this.instructions, options.labels);
    this.labels = Object.keys(this.question.criteria);
    this.minConfidence = options.minConfidence ?? 0;
    this.fallback = options.fallback ?? null;
    this.alternativeThreshold = options.alternativeThreshold ?? 0;
    if (this.fallback && this.labels.includes(this.fallback)) {
      throw new JevValidationError(
        `fallback "${this.fallback}" is also one of the labels. Pick a name the model cannot return, so an undecided result is always distinguishable from a decided one.`
      );
    }
    this.questionId = options.questionId ?? "label";
    logger_default.debug({ labels: this.labels.length }, "ak-jev: Classifier created");
  }
  /**
   * Classify one state.
   *
   * @param {any} state
   * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
   *   Extra `questions` ride along in the same request and come back on
   *   `result.answers`. Free speculative fan-out.
   * @returns {Promise<Classification>}
   */
  async classify(state, opts = {}) {
    const questions = { [this.questionId]: this.question, ...opts.questions ?? {} };
    const result = await this.evaluate(state, questions, opts);
    return this._shape(result);
  }
  /**
   * Classify many states in parallel. Results keep input order.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Array<Classification|import('./base.js').JevFailure>>}
   */
  async classifyMany(states, opts = {}) {
    const questions = { [this.questionId]: this.question, ...opts.questions ?? {} };
    const results = await this.evaluateMany(states, questions, opts);
    return results.map((r) => (
      /** @type {any} */
      r.failed ? (
        /** @type {any} */
        r
      ) : this._shape(
        /** @type {any} */
        r
      )
    ));
  }
  /**
   * Group states by their classified label. Undecided states land under the
   * fallback name, or under `'undecided'` when no fallback is configured.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions} [opts={}]
   * @returns {Promise<Object.<string, any[]>>}
   */
  async group(states, opts = {}) {
    const results = await this.classifyMany(states, opts);
    const buckets = {};
    results.forEach((r, i) => {
      const key = (
        /** @type {any} */
        r.failed ? "failed" : (
          /** @type {Classification} */
          r.label ?? "undecided"
        )
      );
      (buckets[key] ??= []).push(states[i]);
    });
    return buckets;
  }
  /**
   * @param {import('./base.js').JevResult} result
   * @returns {Classification}
   */
  _shape(result) {
    requireAnswers(result.answers, [this.questionId], "Classifier");
    const answer = result.answers[this.questionId];
    const decided = answer.confidence >= this.minConfidence;
    const alternatives = answer.ranked.filter((r) => r.label !== answer.choice && r.probability >= this.alternativeThreshold).filter((r) => r.probability > 0);
    return {
      label: decided ? answer.choice : this.fallback,
      decided,
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      ranked: answer.ranked,
      runnerUp: answer.runnerUp,
      margin: answer.margin,
      entropy: answer.entropy,
      alternatives,
      answers: result.answers,
      usage: result.usage,
      cached: result.cached,
      requestId: result.requestId
    };
  }
};
var classifier_default = Classifier;

// detector.js
init_errors();
var Detector = class extends base_default {
  /**
   * @param {DetectorOptions} options
   */
  constructor(options = (
    /** @type {any} */
    {}
  )) {
    super(options);
    const conditions = options.conditions;
    if (!conditions || typeof conditions !== "object" || Object.keys(conditions).length === 0) {
      throw new JevValidationError(
        "Detector needs { conditions }: an object of id -> question string or { instructions, criteria, yes, high, low }."
      );
    }
    this.questions = {};
    this.conditionThresholds = {};
    for (const [id, spec] of Object.entries(conditions)) {
      if (typeof spec === "string") {
        this.questions[id] = noul(spec);
        this.conditionThresholds[id] = { ...this.thresholds };
        continue;
      }
      if (!spec || typeof spec !== "object") {
        throw new JevValidationError(
          `Condition "${id}" must be a question string or an object.`,
          { questionId: id }
        );
      }
      this.questions[id] = noul(spec.instructions, spec.criteria);
      this.conditionThresholds[id] = {
        yes: spec.yes ?? this.thresholds.yes,
        high: spec.high ?? this.thresholds.high,
        low: spec.low ?? this.thresholds.low
      };
    }
    this.conditionIds = Object.keys(this.questions);
    logger_default.debug({ conditions: this.conditionIds.length }, "ak-jev: Detector created");
  }
  /**
   * Run every condition against one state.
   *
   * @param {any} state
   * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Detection>}
   */
  async check(state, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const result = await this.evaluate(state, questions, opts);
    return this._shape(result);
  }
  /**
   * Run every condition against many states, in parallel. Input order is kept.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Array<Detection|import('./base.js').JevFailure>>}
   */
  async checkMany(states, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const results = await this.evaluateMany(states, questions, opts);
    return results.map((r) => (
      /** @type {any} */
      r.failed ? (
        /** @type {any} */
        r
      ) : this._shape(
        /** @type {any} */
        r
      )
    ));
  }
  /**
   * @param {import('./base.js').JevResult} result
   * @returns {Detection}
   */
  _shape(result) {
    requireAnswers(result.answers, this.conditionIds, "Detector");
    const flags = {};
    const probabilities = {};
    const verdicts = {};
    const triggered = [];
    const unsure = [];
    for (const id of this.conditionIds) {
      const answer = result.answers[id];
      const t = this.conditionThresholds[id];
      const p = answer.noul;
      probabilities[id] = p;
      flags[id] = p >= t.yes;
      const verdict = p >= t.high ? "yes" : p <= t.low ? "no" : "unsure";
      verdicts[id] = verdict;
      if (flags[id]) triggered.push(id);
      if (verdict === "unsure") unsure.push(id);
    }
    triggered.sort((a, b) => probabilities[b] - probabilities[a]);
    return {
      flags,
      probabilities,
      verdicts,
      triggered,
      unsure,
      any: triggered.length > 0,
      all: triggered.length === this.conditionIds.length,
      count: triggered.length,
      /** The highest probability across every condition. */
      max: this.conditionIds.length ? Math.max(...this.conditionIds.map((id) => probabilities[id] ?? 0)) : 0,
      answers: result.answers,
      usage: result.usage,
      cached: result.cached,
      requestId: result.requestId
    };
  }
};
var detector_default = Detector;

// scorer.js
init_errors();
var Scorer = class extends base_default {
  /**
   * @param {ScorerOptions} options
   */
  constructor(options = (
    /** @type {any} */
    {}
  )) {
    super(options);
    const dims = options.dimensions;
    if (!dims || typeof dims !== "object" || Object.keys(dims).length === 0) {
      throw new JevValidationError(
        "Scorer needs { dimensions }: an object of id -> { instructions, levels, weight }."
      );
    }
    this.questions = {};
    this.weights = {};
    this.inverted = {};
    let weightTotal = 0;
    for (const [id, spec] of Object.entries(dims)) {
      if (!spec || typeof spec !== "object") {
        throw new JevValidationError(
          `Dimension "${id}" must be an object with { instructions, levels }.`,
          { questionId: id }
        );
      }
      const levels = spec.levels ?? spec.criteria;
      if (!levels) {
        throw new JevValidationError(
          `Dimension "${id}" needs { levels }: an ordered array of level descriptions, or an ordered { name: description } object.`,
          { questionId: id }
        );
      }
      this.questions[id] = score(spec.instructions, levels);
      const weight = spec.weight ?? 1;
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
        throw new JevValidationError(
          `Dimension "${id}" has weight ${spec.weight}. Weights must be finite and >= 0.`,
          { questionId: id }
        );
      }
      this.weights[id] = weight;
      this.inverted[id] = spec.invert === true;
      weightTotal += weight;
    }
    if (weightTotal <= 0) {
      throw new JevValidationError("Scorer weights sum to zero. At least one must be positive.");
    }
    this.normalizedWeights = Object.fromEntries(
      Object.entries(this.weights).map(([id, w]) => [id, w / weightTotal])
    );
    this.dimensionIds = Object.keys(this.questions);
    logger_default.debug({ dimensions: this.dimensionIds.length }, "ak-jev: Scorer created");
  }
  /**
   * Score one state across every dimension.
   *
   * @param {any} state
   * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<CompositeScore>}
   */
  async score(state, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const result = await this.evaluate(state, questions, opts);
    return this._shape(result);
  }
  /**
   * Score many states in parallel. Input order is kept.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Array<CompositeScore|import('./base.js').JevFailure>>}
   */
  async scoreMany(states, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const results = await this.evaluateMany(states, questions, opts);
    return results.map((r) => (
      /** @type {any} */
      r.failed ? (
        /** @type {any} */
        r
      ) : this._shape(
        /** @type {any} */
        r
      )
    ));
  }
  /**
   * Score many states and return them sorted, highest composite first.
   *
   * Failures sort to the end rather than being dropped, so the caller always
   * gets back as many entries as they passed in.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {top?: number}} [opts={}]
   * @returns {Promise<Array<{index: number, state: any, composite: number|null, result: CompositeScore|null, error?: Error}>>}
   */
  async rank(states, opts = {}) {
    const scored = await this.scoreMany(states, opts);
    const rows = scored.map((r, index) => {
      if (
        /** @type {any} */
        r.failed
      ) {
        return { index, state: states[index], composite: null, result: null, error: (
          /** @type {any} */
          r.error
        ) };
      }
      const cs = (
        /** @type {CompositeScore} */
        r
      );
      return { index, state: states[index], composite: cs.composite, result: cs };
    });
    rows.sort((a, b) => {
      if (a.composite === null) return 1;
      if (b.composite === null) return -1;
      return b.composite - a.composite;
    });
    return opts.top ? rows.slice(0, opts.top) : rows;
  }
  /**
   * Re-weight without re-calling the API.
   *
   * Recomputing a composite from an existing result is the whole reason weights
   * live in code. Try a new set against yesterday's answers for nothing.
   *
   * @param {CompositeScore} result
   * @param {Object.<string, number>} weights
   * @returns {number}
   */
  static reweight(result, weights) {
    let total = 0;
    let sum = 0;
    for (const [id, w] of Object.entries(weights)) {
      const dim = result.dimensions[id];
      if (!dim) continue;
      total += w;
      sum += w * dim.normalized;
    }
    return total > 0 ? sum / total : 0;
  }
  /**
   * @param {import('./base.js').JevResult} result
   * @returns {CompositeScore}
   */
  _shape(result) {
    requireAnswers(result.answers, this.dimensionIds, "Scorer");
    const dimensions = {};
    let composite = 0;
    let confidenceSum = 0;
    let lowest = { id: (
      /** @type {string|null} */
      null
    ), confidence: Infinity };
    for (const id of this.dimensionIds) {
      const answer = result.answers[id];
      const normalized = this.inverted[id] ? 1 - answer.normalized : answer.normalized;
      const weight = this.normalizedWeights[id];
      const weighted = weight * normalized;
      dimensions[id] = {
        score: answer.score,
        normalized,
        weight,
        weighted,
        confidence: answer.confidence,
        level: answer.level,
        label: answer.label,
        levels: answer.levels,
        probabilities: answer.probabilities,
        entropy: answer.entropy,
        inverted: this.inverted[id]
      };
      composite += weighted;
      confidenceSum += weight * answer.confidence;
      if (answer.confidence < lowest.confidence) lowest = { id, confidence: answer.confidence };
    }
    return {
      composite,
      dimensions,
      /** Weighted mean of the per-dimension confidences. */
      confidence: confidenceSum,
      /** The dimension the model was least sure about — the one to look at first. */
      weakest: lowest.id,
      weakestConfidence: lowest.id ? lowest.confidence : 0,
      answers: result.answers,
      usage: result.usage,
      cached: result.cached,
      requestId: result.requestId
    };
  }
};
var scorer_default = Scorer;

// router.js
init_errors();
var Router = class extends base_default {
  /**
   * @param {RouterOptions} options
   */
  constructor(options = (
    /** @type {any} */
    {}
  )) {
    super(options);
    const routes = options.routes;
    if (!routes || typeof routes !== "object" || Object.keys(routes).length === 0) {
      throw new JevValidationError(
        "Router needs { routes }: an object of name -> { description, handler, minConfidence }."
      );
    }
    this.routes = {};
    const criteria = {};
    for (const [name, spec] of Object.entries(routes)) {
      const normalized = typeof spec === "function" ? { handler: spec, description: null } : typeof spec === "string" ? { handler: void 0, description: spec } : spec;
      if (!normalized || typeof normalized !== "object") {
        throw new JevValidationError(`Route "${name}" must be an object, a handler function, or a description string.`);
      }
      if (normalized.handler !== void 0 && typeof normalized.handler !== "function") {
        throw new JevValidationError(`Route "${name}" has a handler that is not a function.`);
      }
      this.routes[name] = {
        handler: normalized.handler,
        minConfidence: normalized.minConfidence ?? options.minConfidence ?? 0
      };
      criteria[name] = normalized.description ?? null;
    }
    this.instructions = options.instructions ?? "Which of these best describes what is being asked for?";
    this.questionId = options.questionId ?? "route";
    this.question = choice(this.instructions, criteria);
    this.fallback = options.fallback;
    this.dispatch = options.dispatch ?? true;
    this.extraQuestions = options.questions ? expandQuestions(options.questions) : {};
    if (this.fallback !== void 0 && typeof this.fallback !== "function") {
      throw new JevValidationError("Router { fallback } must be a function.");
    }
    logger_default.debug({ routes: Object.keys(this.routes).length }, "ak-jev: Router created");
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
  async route(state, extra = void 0, opts = {}) {
    const questions = { [this.questionId]: this.question, ...this.extraQuestions };
    const result = await this.evaluate(state, questions, opts);
    requireAnswers(result.answers, [this.questionId], "Router");
    const answer = result.answers[this.questionId];
    const name = answer.choice;
    const spec = this.routes[name];
    const confidence = answer.confidence;
    const cleared = Boolean(spec) && confidence >= spec.minConfidence;
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
      value: void 0
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
    logger_default.debug({ route: name, confidence, cleared }, "ak-jev: Router had no handler to run");
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
    if (!Array.isArray(states)) throw new JevValidationError("routeMany() needs an array of states.");
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
};
var router_default = Router;

// ranker.js
init_errors();
var Ranker = class extends base_default {
  /**
   * @param {RankerOptions} [options={}]
   */
  constructor(options = {}) {
    super(options);
    this.instructions = options.instructions ?? "Is this candidate relevant to the query?";
    this.mode = options.mode ?? "noul";
    if (!["noul", "score"].includes(this.mode)) {
      throw new JevValidationError(`Ranker mode must be 'noul' or 'score', got ${JSON.stringify(this.mode)}.`);
    }
    this.levels = options.levels ?? null;
    if (this.mode === "score" && !this.levels) {
      throw new JevValidationError(
        "Ranker mode 'score' needs { levels }: an ordered array of relevance level descriptions."
      );
    }
    this.toText = options.toText ?? ((c) => c);
    this.batchTokens = options.batchTokens ?? 4e4;
    this.batchSize = options.batchSize ?? 400;
    this.criteria = options.criteria;
    logger_default.debug({ mode: this.mode }, "ak-jev: Ranker created");
  }
  /**
   * Score every candidate against the query and return them sorted, best first.
   *
   * @param {any} query
   * @param {any[]} candidates
   * @param {RankOptions} [opts={}]
   * @returns {Promise<RankedCandidate[]>}
   */
  async rank(query, candidates, opts = {}) {
    if (!Array.isArray(candidates)) throw new JevValidationError("rank() needs an array of candidates.");
    if (candidates.length === 0) return [];
    const batches = this._batch(query, candidates);
    logger_default.debug({ candidates: candidates.length, batches: batches.length }, "ak-jev: ranking");
    const rows = [];
    let done = 0;
    await Promise.all(
      batches.map(async (batch) => {
        const questions = {};
        for (const { index, question } of batch) {
          questions[`c${index}`] = question;
        }
        const result = await this.evaluate({ query }, questions, opts);
        requireAnswers(result.answers, Object.keys(questions), "Ranker");
        for (const { index } of batch) {
          const answer = result.answers[`c${index}`];
          rows.push({
            rank: 0,
            // assigned after the global sort
            index,
            candidate: candidates[index],
            relevance: this.mode === "noul" ? answer.noul : answer.normalized,
            answer
          });
        }
        done += batch.length;
        opts.onProgress?.({ done, total: candidates.length });
      })
    );
    rows.sort((a, b) => b.relevance - a.relevance || a.index - b.index);
    rows.forEach((r, i) => {
      r.rank = i + 1;
    });
    const cut = typeof opts.minRelevance === "number" ? rows.filter((r) => r.relevance >= /** @type {number} */
    opts.minRelevance) : rows;
    return opts.top ? cut.slice(0, opts.top) : cut;
  }
  /**
   * Pick the single best candidate in one request, via a Choice over candidate ids.
   *
   * The candidates go in the STATE, keyed by id, and the Choice options are just
   * those ids. That is the Line-by-line search shape, and it is what makes the
   * `found` check possible: a second Noul against the same state can ask whether
   * any candidate answers the query at all.
   *
   * The distinction matters. A Choice is relative — it settles *which* candidate
   * is best even when every one of them is useless. The Noul is absolute. Pass
   * `includeNone` to get both, and check `found` before trusting `index`.
   *
   * Bounded by the API's 255-option limit on a Choice.
   *
   * @param {any} query
   * @param {any[]} candidates
   * @param {PickOptions} [opts={}]
   * @returns {Promise<PickResult>}
   */
  async pick(query, candidates, opts = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new JevValidationError("pick() needs a non-empty array of candidates.");
    }
    const limit = this.limits().maxChoiceOptions - (opts.includeNone ? 1 : 0);
    if (candidates.length > limit) {
      throw new JevValidationError(
        `pick() was given ${candidates.length} candidates; a Choice allows at most ${limit} options. Narrow the shortlist first, or use rank() which batches across requests.`
      );
    }
    const NONE = "__none__";
    const catalogue = {};
    const criteria = {};
    candidates.forEach((c, i) => {
      catalogue[`c${i}`] = this.toText(c, i);
      criteria[`c${i}`] = null;
    });
    if (opts.includeNone) criteria[NONE] = "None of the candidates in `candidates` answers the query.";
    const instructions = opts.instructions ?? this.instructions;
    const questions = {
      best: choice(
        { question: instructions, note: "Each option is a key in `candidates`. Pick the key whose text best answers `query`." },
        criteria
      )
    };
    if (opts.includeNone) {
      questions.found = noul("Does any entry in `candidates` answer the question in `query`?");
    }
    const result = await this.evaluate({ query, candidates: catalogue }, questions, opts);
    const answer = result.answers.best;
    const isNone = answer.choice === NONE;
    const index = isNone ? -1 : Number(String(answer.choice).slice(1));
    return {
      index,
      candidate: index >= 0 ? candidates[index] : null,
      confidence: answer.confidence,
      found: opts.includeNone ? result.answers.found?.yes ?? !isNone : !isNone,
      ranked: answer.ranked.filter((r) => r.label !== NONE).map((r) => ({
        index: Number(r.label.slice(1)),
        candidate: candidates[Number(r.label.slice(1))],
        probability: r.probability
      })),
      answers: result.answers,
      usage: result.usage,
      cached: result.cached,
      requestId: result.requestId
    };
  }
  /**
   * Build the per-candidate question. The candidate travels in the question's
   * structured `instructions`, not in the state.
   * @param {any} text
   */
  _questionFor(text) {
    const instructions = { candidate: text, question: this.instructions };
    return this.mode === "noul" ? noul(instructions, this.criteria) : score(
      instructions,
      /** @type {any[]} */
      this.levels
    );
  }
  /**
   * Split candidates into requests that each fit the token budget.
   * @param {any} query
   * @param {any[]} candidates
   * @returns {Array<Array<{index: number, text: any, question: any}>>}
   */
  _batch(query, candidates) {
    const limits = this.limits();
    const queryTokens = estimateTokens({ query }) + limits.requestOverheadTokens;
    const budget = Math.min(this.batchTokens, limits.contextTokens) - queryTokens;
    const batches = [];
    let current = [];
    let used = 0;
    candidates.forEach((candidate, index) => {
      const text = this.toText(candidate, index);
      const question = this._questionFor(text);
      const cost = estimateQuestionTokens(question);
      if (current.length > 0 && (used + cost > budget || current.length >= this.batchSize)) {
        batches.push(current);
        current = [];
        used = 0;
      }
      current.push({ index, text, question });
      used += cost;
    });
    if (current.length > 0) batches.push(current);
    return batches;
  }
};
var ranker_default = Ranker;

// extractor.js
init_errors();
var NOT_STATED = "__not_stated__";
var Extractor = class extends base_default {
  /**
   * @param {ExtractorOptions} options
   */
  constructor(options = (
    /** @type {any} */
    {}
  )) {
    super(options);
    const fields = options.fields;
    if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
      throw new JevValidationError(
        "Extractor needs { fields }: an object of name -> { instructions, options }."
      );
    }
    this.questions = {};
    this.fieldSpecs = {};
    for (const [name, spec] of Object.entries(fields)) {
      if (!spec || typeof spec !== "object") {
        throw new JevValidationError(`Field "${name}" must be an object with { instructions, options }.`);
      }
      const raw = spec.options ?? spec.criteria;
      if (!raw) {
        throw new JevValidationError(
          `Field "${name}" needs { options }: the bounded set of values it can take. Jev picks from a list; it cannot generate a value.`,
          { questionId: name }
        );
      }
      const allowMissing = spec.allowMissing ?? options.allowMissing ?? false;
      const criteria = Array.isArray(raw) ? Object.fromEntries(raw.map((v) => [String(v), null])) : { ...raw };
      if (allowMissing) {
        if (NOT_STATED in criteria) {
          throw new JevValidationError(
            `Field "${name}" already defines "${NOT_STATED}", which allowMissing reserves.`,
            { questionId: name }
          );
        }
        criteria[NOT_STATED] = spec.missingDescription ?? "The document does not state this. Choose this rather than inferring a value.";
      }
      this.questions[name] = choice(
        spec.instructions ?? `What is the ${name}?`,
        criteria
      );
      this.fieldSpecs[name] = {
        allowMissing,
        minConfidence: spec.minConfidence ?? options.minConfidence ?? 0,
        // Applied to the winning label, in code. The model's output is copied
        // verbatim first; this only normalizes it.
        transform: spec.transform
      };
    }
    this.fieldNames = Object.keys(this.questions);
    logger_default.debug({ fields: this.fieldNames.length }, "ak-jev: Extractor created");
  }
  /**
   * Extract every field from one document, in one request.
   *
   * @param {any} state
   * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Extraction>}
   */
  async extract(state, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const result = await this.evaluate(state, questions, opts);
    return this._shape(result);
  }
  /**
   * Extract from many documents, in parallel. Input order is kept.
   *
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Array<Extraction|import('./base.js').JevFailure>>}
   */
  async extractMany(states, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const results = await this.evaluateMany(states, questions, opts);
    return results.map((r) => (
      /** @type {any} */
      r.failed ? (
        /** @type {any} */
        r
      ) : this._shape(
        /** @type {any} */
        r
      )
    ));
  }
  /**
   * @param {import('./base.js').JevResult} result
   * @returns {Extraction}
   */
  _shape(result) {
    requireAnswers(result.answers, this.fieldNames, "Extractor");
    const record = {};
    const fields = {};
    const missing = [];
    const uncertain = [];
    for (const name of this.fieldNames) {
      const answer = result.answers[name];
      const spec = this.fieldSpecs[name];
      const notStated = answer.choice === NOT_STATED;
      const confident = answer.confidence >= spec.minConfidence;
      const decided = !notStated && confident;
      let value = decided ? answer.choice : null;
      if (decided && spec.transform) {
        try {
          value = spec.transform(value, answer);
        } catch (err) {
          throw new JevValidationError(
            `Extractor: the transform for field "${name}" threw on the value ${JSON.stringify(answer.choice)}: ${/** @type {Error} */
            err?.message}`,
            { questionId: name }
          );
        }
      }
      record[name] = value;
      fields[name] = {
        value,
        choice: answer.choice,
        decided,
        notStated,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        runnerUp: answer.runnerUp,
        margin: answer.margin,
        required: spec.minConfidence
      };
      if (notStated) missing.push(name);
      else if (!confident) uncertain.push(name);
    }
    return {
      record,
      fields,
      missing,
      uncertain,
      complete: missing.length === 0 && uncertain.length === 0,
      /** Lowest confidence across the fields — the one to review first. */
      minConfidence: this.fieldNames.length ? Math.min(...this.fieldNames.map((n) => fields[n]?.confidence ?? 1)) : 1,
      answers: result.answers,
      usage: result.usage,
      cached: result.cached,
      requestId: result.requestId
    };
  }
};
var extractor_default = Extractor;

// taxonomy.js
init_errors();
var Taxonomy = class extends base_default {
  /**
   * @param {TaxonomyOptions} [options={}]
   */
  constructor(options = {}) {
    super(options);
    if (!options.tree || typeof options.tree !== "object") {
      throw new JevValidationError(
        "Taxonomy needs { tree }: a nested object where each key is a category and each value is its subtree, or null at a leaf."
      );
    }
    this.tree = options.tree;
    this.instructions = options.instructions ?? "Which category does this belong to?";
    this.beam = options.beam ?? 1;
    this.minScore = options.minScore ?? 0;
    this.maxDepth = options.maxDepth ?? 10;
    this.describeDepth = options.describeDepth ?? 2;
    logger_default.debug({ roots: Object.keys(this.tree).length }, "ak-jev: Taxonomy created");
  }
  /**
   * Walk the tree for one state.
   *
   * Makes one request per level, per surviving beam width. A 3-level tree with
   * `beam: 2` costs at most 1 + 2 + 2 = 5 requests.
   *
   * @param {any} state
   * @param {TaxonomyOptions & import('./base.js').JevEvaluateOptions} [opts={}]
   * @returns {Promise<TaxonomyResult>}
   */
  async classify(state, opts = {}) {
    const beam = opts.beam ?? this.beam;
    const minScore = opts.minScore ?? this.minScore;
    const maxDepth = opts.maxDepth ?? this.maxDepth;
    let frontier = [{ path: [], node: this.tree, score: 1, steps: [] }];
    const finished = [];
    let requests = 0;
    let truncated = false;
    for (let depth = 0; depth < maxDepth; depth++) {
      const descending = [];
      for (const entry of frontier) {
        if (isLeaf(entry.node)) finished.push(entry);
        else descending.push(entry);
      }
      frontier = descending;
      if (descending.length === 0) break;
      const next = [];
      const levels = await Promise.all(
        descending.map(async (entry) => {
          const children = Object.keys(entry.node);
          const criteria = Object.fromEntries(
            children.map((name) => [name, this._describe(entry.node[name], this.describeDepth)])
          );
          const result = await this.evaluate(
            state,
            { level: choice(this._instructionsFor(entry.path, opts), criteria) },
            opts
          );
          requests++;
          return { entry, answer: result.answers.level, usage: result.usage };
        })
      );
      for (const { entry, answer } of levels) {
        for (const { label, probability } of answer.ranked) {
          const score2 = entry.score * probability;
          if (score2 < minScore) continue;
          next.push({
            path: [...entry.path, label],
            node: entry.node[label],
            score: score2,
            steps: [...entry.steps, {
              depth,
              parent: entry.path.at(-1) ?? null,
              label,
              probability,
              confidence: answer.confidence,
              ranked: answer.ranked
            }]
          });
        }
      }
      next.sort((a, b) => b.score - a.score);
      frontier = next.slice(0, Math.max(1, beam));
      if (frontier.length === 0) break;
      if (depth === maxDepth - 1 && frontier.some((e) => !isLeaf(e.node))) truncated = true;
    }
    for (const entry of frontier) finished.push(entry);
    finished.sort((a, b) => b.score - a.score);
    const seen = /* @__PURE__ */ new Set();
    const unique = finished.filter((f) => {
      const key = f.path.join("\0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const best = unique[0];
    if (!best) {
      throw new JevValidationError(
        "Taxonomy produced no path. The tree is empty, or minScore pruned everything."
      );
    }
    return {
      path: best.path,
      label: best.path.at(-1) ?? null,
      score: best.score,
      steps: best.steps,
      candidates: unique.map((f) => ({ path: f.path, score: f.score })),
      /** True when `maxDepth` stopped the walk above a leaf. */
      truncated,
      requests,
      usage: this.getLastUsage()
    };
  }
  /**
   * Walk the tree for many states, in parallel.
   * @param {any[]} states
   * @param {TaxonomyOptions & import('./base.js').JevEvaluateManyOptions} [opts={}]
   * @returns {Promise<Array<TaxonomyResult|import('./base.js').JevFailure>>}
   */
  async classifyMany(states, opts = {}) {
    if (!Array.isArray(states)) throw new JevValidationError("classifyMany() needs an array of states.");
    const out = new Array(states.length);
    let done = 0;
    await Promise.all(
      states.map(async (state, index) => {
        try {
          out[index] = await this.classify(state, opts);
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
  /**
   * Phrase the question for the level being decided, so the model knows where in
   * the tree it is.
   * @param {string[]} path
   * @param {any} opts
   */
  _instructionsFor(path, opts) {
    const base = opts.instructions ?? this.instructions;
    if (path.length === 0) return base;
    return { question: base, already_chosen: path, note: "Choose from the options, which are the subcategories of the last entry in `already_chosen`." };
  }
  /**
   * Turn a subtree into an option description, trimmed to `depth` levels.
   * Beyond the cut, list the child names only.
   * @param {any} node
   * @param {number} depth
   * @returns {any}
   */
  _describe(node, depth) {
    if (isLeaf(node)) return null;
    const keys = Object.keys(node);
    if (depth <= 1) return keys;
    return Object.fromEntries(keys.map((k) => [k, this._describe(node[k], depth - 1)]));
  }
};
function isLeaf(node) {
  return !node || typeof node !== "object" || Object.keys(node).length === 0;
}
var taxonomy_default = Taxonomy;

// guard.js
init_errors();
var GUARD_ACTIONS = Object.freeze(["allow", "review", "block"]);
var JevGuardError = class extends JevError {
  /**
   * @param {string} message
   * @param {Object} [meta={}]
   */
  constructor(message, meta = {}) {
    super(message, meta);
    this.verdict = meta.verdict;
    this.reasons = meta.reasons ?? [];
  }
};
var Guard = class extends base_default {
  /**
   * @param {GuardOptions} options
   */
  constructor(options = (
    /** @type {any} */
    {}
  )) {
    super(options);
    const hazards = options.hazards;
    if (!hazards || typeof hazards !== "object" || Object.keys(hazards).length === 0) {
      throw new JevValidationError(
        "Guard needs { hazards }: an object of id -> { instructions, action, threshold }."
      );
    }
    this.questions = {};
    this.hazards = {};
    for (const [id, spec] of Object.entries(hazards)) {
      const normalized = typeof spec === "string" ? { instructions: spec } : spec;
      if (!normalized || typeof normalized !== "object") {
        throw new JevValidationError(`Hazard "${id}" must be a question string or an object.`, { questionId: id });
      }
      const action = normalized.action ?? "block";
      if (!GUARD_ACTIONS.includes(action)) {
        throw new JevValidationError(
          `Hazard "${id}" has action ${JSON.stringify(action)}. Valid actions: ${GUARD_ACTIONS.join(", ")}.`,
          { questionId: id }
        );
      }
      this.questions[id] = noul(normalized.instructions, normalized.criteria);
      this.hazards[id] = {
        action,
        threshold: normalized.threshold ?? options.threshold ?? 0.5,
        // A hazard that blocks can also have a lower bar at which it merely
        // gets reviewed. That is the three-way split the confidence docs
        // recommend, expressed per hazard.
        reviewThreshold: normalized.reviewThreshold ?? null,
        description: normalized.description ?? null
      };
    }
    this.hazardIds = Object.keys(this.questions);
    logger_default.debug({ hazards: this.hazardIds.length }, "ak-jev: Guard created");
  }
  /**
   * Check one piece of content and return a verdict. Never throws on a hazard.
   *
   * @param {any} state
   * @param {import('./base.js').JevEvaluateOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Verdict>}
   */
  async inspect(state, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const result = await this.evaluate(state, questions, opts);
    return this._shape(result);
  }
  /**
   * Check one piece of content and throw `JevGuardError` when the verdict is
   * `block`. A `review` verdict returns normally — reviewing is your call to
   * make, not an error.
   *
   * @param {any} state
   * @param {import('./base.js').JevEvaluateOptions} [opts={}]
   * @returns {Promise<Verdict>}
   */
  async assert(state, opts = {}) {
    const verdict = await this.inspect(state, opts);
    if (verdict.blocked) {
      throw new JevGuardError(
        `Blocked by guard: ${verdict.reasons.join(", ")}.`,
        { verdict, reasons: verdict.reasons, requestId: verdict.requestId }
      );
    }
    return verdict;
  }
  /**
   * Check many pieces of content in parallel. Input order is kept.
   * @param {any[]} states
   * @param {import('./base.js').JevEvaluateManyOptions & {questions?: Object.<string, any>}} [opts={}]
   * @returns {Promise<Array<Verdict|import('./base.js').JevFailure>>}
   */
  async inspectMany(states, opts = {}) {
    const questions = { ...this.questions, ...opts.questions ?? {} };
    const results = await this.evaluateMany(states, questions, opts);
    return results.map((r) => (
      /** @type {any} */
      r.failed ? (
        /** @type {any} */
        r
      ) : this._shape(
        /** @type {any} */
        r
      )
    ));
  }
  /**
   * Wrap an async function so its input is checked before it runs and its output
   * is checked before it returns. The cheapest place to put a Guard.
   *
   * @template T
   * @param {(input: any) => Promise<T>} fn
   * @param {{input?: boolean, output?: boolean, onBlock?: (v: Verdict, phase: 'input'|'output') => any}} [opts={}]
   * @returns {(input: any) => Promise<T>}
   *
   * @example
   * const safeAsk = guard.wrap(askTheLLM, {
   *   onBlock: (v, phase) => { throw new Error(`${phase} blocked: ${v.reasons}`); }
   * });
   */
  wrap(fn, opts = {}) {
    const checkInput = opts.input ?? true;
    const checkOutput = opts.output ?? true;
    return async (input) => {
      if (checkInput) {
        const v = await this.inspect(input);
        if (v.blocked) {
          if (opts.onBlock) return opts.onBlock(v, "input");
          throw new JevGuardError(`Input blocked by guard: ${v.reasons.join(", ")}.`, { verdict: v, reasons: v.reasons });
        }
      }
      const output = await fn(input);
      if (checkOutput) {
        const v = await this.inspect(output);
        if (v.blocked) {
          if (opts.onBlock) return opts.onBlock(v, "output");
          throw new JevGuardError(`Output blocked by guard: ${v.reasons.join(", ")}.`, { verdict: v, reasons: v.reasons });
        }
      }
      return output;
    };
  }
  /**
   * @param {import('./base.js').JevResult} result
   * @returns {Verdict}
   */
  _shape(result) {
    requireAnswers(result.answers, this.hazardIds, "Guard");
    const probabilities = {};
    const triggered = [];
    let strictest = 0;
    for (const id of this.hazardIds) {
      const answer = result.answers[id];
      const spec = this.hazards[id];
      const p = answer.noul;
      probabilities[id] = p;
      let action2 = null;
      if (p >= spec.threshold) action2 = spec.action;
      else if (spec.reviewThreshold !== null && p >= spec.reviewThreshold) action2 = "review";
      if (!action2 || action2 === "allow") continue;
      triggered.push({ id, probability: p, action: action2, threshold: spec.threshold, description: spec.description });
      strictest = Math.max(strictest, GUARD_ACTIONS.indexOf(action2));
    }
    triggered.sort((a, b) => b.probability - a.probability);
    const action = (
      /** @type {'allow'|'review'|'block'} */
      GUARD_ACTIONS[strictest]
    );
    return {
      action,
      allowed: action === "allow",
      review: action === "review",
      blocked: action === "block",
      triggered,
      reasons: triggered.map((t) => `${t.id} (${t.probability.toFixed(2)})`),
      probabilities,
      /** The highest hazard probability seen, triggered or not. */
      max: this.hazardIds.length ? Math.max(...this.hazardIds.map((id) => probabilities[id] ?? 0)) : 0,
      answers: result.answers,
      usage: result.usage,
      cached: result.cached,
      requestId: result.requestId
    };
  }
};
var guard_default = Guard;

// index.js
init_errors();
var shared = null;
function client(options) {
  if (!shared) shared = new base_default(options ?? {});
  return shared;
}
function resetClient() {
  shared = null;
}
async function ask(state, questions, opts = {}) {
  return client(opts).evaluate(state, questions, opts);
}
async function models(opts = {}) {
  return client(opts).listModels();
}
function estimate(state, questions, opts = {}) {
  const model = opts.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL;
  const wire = toWireQuestions(expandQuestions(questions));
  const est = estimateRequest({ state, questions: wire, model });
  return {
    ...est,
    estimatedCost: computeCost({ inputTokens: est.totalTokens, outputTokens: 0 }, model)
  };
}
async function sample(state, questions, opts = {}) {
  return client(opts).sample(state, questions, opts);
}
var index_default = {
  Evaluator: evaluator_default,
  Classifier: classifier_default,
  Detector: detector_default,
  Scorer: scorer_default,
  Router: router_default,
  Ranker: ranker_default,
  Extractor: extractor_default,
  Taxonomy: taxonomy_default,
  Guard: guard_default,
  ask,
  sample,
  estimate,
  models,
  client,
  resetClient
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BUDGET_SAFETY_MARGIN,
  BaseJev,
  Classifier,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_RETRY,
  DEFAULT_THRESHOLDS,
  DEFAULT_TIMEOUT_MS,
  Detector,
  Evaluator,
  Extractor,
  GUARD_ACTIONS,
  Governor,
  Guard,
  JevAPIError,
  JevAbortError,
  JevAuthError,
  JevBadRequestError,
  JevClient,
  JevConfigError,
  JevConnectionError,
  JevError,
  JevGuardError,
  JevNotFoundError,
  JevOverloadedError,
  JevPermissionError,
  JevRateLimitError,
  JevRequestTooLargeError,
  JevServerError,
  JevTimeoutError,
  JevUnprocessableError,
  JevValidationError,
  MODELS_PATH,
  MODEL_ALIASES,
  MODEL_LIMITS,
  MODEL_PRICING,
  MODEL_PRICING_AS_OF,
  NOT_STATED,
  QUESTION_META,
  QUESTION_TYPES,
  Ranker,
  ResponseCache,
  Router,
  SYSTEM_ONE_PATH,
  Scorer,
  Taxonomy,
  ask,
  backoffDelay,
  cacheKey,
  canonicalize,
  choice,
  client,
  computeCost,
  describeDetail,
  enrichAnswer,
  enrichAnswers,
  errorFromResponse,
  estimate,
  estimateQuestionTokens,
  estimateRequest,
  estimateTokens,
  expandQuestions,
  listModels,
  log,
  models,
  normalizeOptions,
  normalizedEntropy,
  noul,
  parseRetryAfter,
  questionMeta,
  rank,
  resetClient,
  resolveCache,
  resolveLimits,
  resolveModelId,
  resolvePricing,
  sample,
  score,
  sleep,
  toWireQuestions,
  validateQuestions
});
