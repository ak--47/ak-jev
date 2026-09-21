/**
 * @fileoverview Response cache. **Off by default.** See the warning below.
 *
 * ## The API is consistent, not deterministic
 *
 * Measured 2026-09-21: twelve byte-identical requests returned **six distinct**
 * score values.
 *
 * | field        | values across 12 identical calls | spread |
 * |--------------|----------------------------------|--------|
 * | `score`      | 1.75 – 1.83                      | 0.08   |
 * | `noul`       | 0.47 – 0.53                      | 0.06   |
 * | `confidence` | 0.94 – 0.97                      | 0.03   |
 *
 * So a cache entry is a **memo of one sample**, not the value of a pure
 * function. Re-running would have given you something within about ±0.04 — which
 * is far inside any sensible threshold band — but it would not have given you the
 * same number.
 *
 * **That is why caching is off by default.** Two of TypeSafe's own cookbooks
 * measure self-consistency by sampling the same request repeatedly. A cache on by
 * default would hand those an identical answer every time and they would conclude
 * the model is perfectly stable. Silently turning a distribution into a constant
 * is exactly the kind of wrong that is hard to notice.
 *
 * Turn it on with `cache: true` when you are iterating on a script over a fixed
 * corpus — it is a large saving and the variance it hides is small. Use
 * `jev.sample()` when you actually want the distribution; it bypasses the cache.
 *
 * ## Why the key covers the whole payload
 *
 * Answers also shift by about ±0.03 depending on which *other* questions share
 * the request, so a per-question cache would hand back answers that were never
 * returned for that request. Measured, same date:
 *
 * | request                       | score |
 * |-------------------------------|-------|
 * | the question alone            | 1.31  |
 * | alongside two other questions | 1.35  |
 * | the same three, reordered     | 1.32  |
 *
 * A hit is never invisible: the result carries `cached: true`, its
 * `estimatedCost` is 0, and `stats()` reports hits and misses separately.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stable JSON: object keys sorted at every depth, so two payloads that differ
 * only in property order produce the same key.
 *
 * @param {any} value
 * @returns {string}
 */
export function canonicalize(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/**
 * Cache key for one request.
 *
 * @param {Object} args
 * @param {string} args.baseURL
 * @param {string} args.model as sent, so `jev-latest` and `jev-1.13.0` are
 *   separate entries — the alias can move under you.
 * @param {any} args.state
 * @param {any} args.questions wire-shaped
 * @returns {string}
 */
export function cacheKey({ baseURL, model, state, questions }) {
	const payload = canonicalize({ baseURL, model, state, questions });
	return createHash('sha256').update(payload).digest('hex');
}

/**
 * In-memory LRU, with an optional write-through to disk.
 *
 * Disk entries survive process restarts, which is what makes re-running a script
 * against the same corpus free. They are plain JSON files named by key.
 */
export class ResponseCache {
	/**
	 * @param {Object} [opts={}]
	 * @param {number} [opts.max=1000] entries held in memory
	 * @param {number} [opts.ttlMs] optional expiry; omitted means never
	 * @param {string} [opts.dir] optional directory for write-through persistence
	 */
	constructor(opts = {}) {
		this.max = opts.max ?? 1000;
		this.ttlMs = opts.ttlMs;
		this.dir = opts.dir;
		/** @type {Map<string, {at: number, value: any}>} */
		this._map = new Map();
		this.hits = 0;
		this.misses = 0;

		if (this.dir) mkdirSync(this.dir, { recursive: true });
	}

	/**
	 * @param {string} key
	 * @returns {any|undefined}
	 */
	get(key) {
		const entry = this._map.get(key) ?? this._readDisk(key);
		if (!entry) {
			this.misses++;
			return undefined;
		}
		if (this.ttlMs !== undefined && Date.now() - entry.at > this.ttlMs) {
			this._map.delete(key);
			this.misses++;
			return undefined;
		}
		// Refresh LRU position.
		this._map.delete(key);
		this._map.set(key, entry);
		this.hits++;
		return entry.value;
	}

	/**
	 * @param {string} key
	 * @param {any} value
	 */
	set(key, value) {
		this._map.set(key, { at: Date.now(), value });
		while (this._map.size > this.max) {
			const oldest = this._map.keys().next().value;
			if (oldest === undefined) break;
			this._map.delete(oldest);
		}
		if (this.dir) this._writeDisk(key, value);
	}

	clear() {
		this._map.clear();
	}

	get size() {
		return this._map.size;
	}

	/** @param {string} key */
	_readDisk(key) {
		if (!this.dir) return undefined;
		const path = join(this.dir, `${key}.json`);
		if (!existsSync(path)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8'));
			const entry = { at: parsed.at ?? Date.now(), value: parsed.value };
			this._map.set(key, entry);
			return entry;
		} catch {
			// A corrupt cache file is a cache miss, not a crash. The next write
			// overwrites it.
			return undefined;
		}
	}

	/** @param {string} key @param {any} value */
	_writeDisk(key, value) {
		if (!this.dir) return;
		try {
			writeFileSync(join(this.dir, `${key}.json`), JSON.stringify({ at: Date.now(), value }));
		} catch {
			// Persistence is an optimisation. Losing it must not fail the call.
			// The in-memory entry is already set, so this request still benefits.
		}
	}
}

/**
 * Build a cache from the `cache` constructor option.
 *
 * Defaults to off. See the file header for why.
 *
 * @param {boolean|{max?: number, ttlMs?: number, dir?: string}|ResponseCache} [option=false]
 * @returns {ResponseCache|null} `null` when caching is off
 */
export function resolveCache(option = false) {
	if (option === false || option === null || option === undefined) return null;
	if (option instanceof ResponseCache) return option;
	if (option === true) return new ResponseCache();
	return new ResponseCache(option);
}
