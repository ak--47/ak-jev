/**
 * @fileoverview Client-side rate governor: concurrency, requests/minute, tokens/second.
 *
 * TypeSafe publishes 1,200 requests/minute and 250,000 tokens/second, and returns
 * no rate-limit headers, so pacing has to happen on this side. It matters because
 * the patterns this API is built for are fan-outs: the re-ranking cookbook fires
 * 1,200 calls for 40 queries.
 *
 * Defaults sit under both published limits. A 429 is still retried by the
 * transport — the governor reduces how often you meet one, it does not replace
 * the retry.
 */

/** Sliding-window counter for "N events per window". */
class SlidingWindow {
	/**
	 * @param {number} limit
	 * @param {number} windowMs
	 */
	constructor(limit, windowMs) {
		this.limit = limit;
		this.windowMs = windowMs;
		/** @type {Array<{at: number, weight: number}>} */
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

		// Wait until enough of the oldest events age out.
		let freed = 0;
		const need = used + weight - this.limit;
		for (const e of this.events) {
			freed += e.weight;
			if (freed >= need) return Math.max(1, e.at + this.windowMs - now);
		}
		// A single request heavier than the whole window. Let it through rather
		// than deadlock; the API will decide.
		return 0;
	}

	/** @param {number} weight @param {number} now */
	record(weight, now) {
		this.events.push({ at: now, weight });
	}
}

/**
 * Paces outbound requests. One instance per client.
 */
export class Governor {
	/**
	 * @param {Object} [opts={}]
	 * @param {number} [opts.concurrency=8] simultaneous in-flight requests
	 * @param {number} [opts.requestsPerMinute=1000] under the published 1,200
	 * @param {number} [opts.tokensPerSecond=200000] under the published 250,000
	 */
	constructor(opts = {}) {
		this.concurrency = positive(opts.concurrency, 8);
		this.requestsPerMinute = positive(opts.requestsPerMinute, 1000);
		this.tokensPerSecond = positive(opts.tokensPerSecond, 200000);

		this._rpm = new SlidingWindow(this.requestsPerMinute, 60_000);
		this._tps = new SlidingWindow(this.tokensPerSecond, 1_000);

		this._active = 0;
		/** @type {Array<() => void>} */
		this._waiting = [];
		/** Counters for `stats()`. */
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
			/** @type {() => void} */
			const admit = () => {
				signal?.removeEventListener('abort', onAbort);
				this._active++;
				resolve(undefined);
			};
			const onAbort = () => {
				const i = this._waiting.indexOf(admit);
				if (i >= 0) this._waiting.splice(i, 1);
				reject(signal?.reason ?? new Error('Aborted while queued'));
			};
			if (signal?.aborted) return onAbort();
			signal?.addEventListener('abort', onAbort, { once: true });
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
		for (;;) {
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
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal?.reason ?? new Error('Aborted'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * @param {any} v
 * @param {number} fallback
 * @returns {number}
 */
function positive(v, fallback) {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
