/**
 * @fileoverview Answer enrichment.
 *
 * The API gives you the raw numbers. Every cookbook then computes the same
 * handful of derivations by hand: normalize a score by its level count, find the
 * runner-up, threshold a noul, look up which level text a score landed on.
 *
 * ak-jev computes them once, here. Raw API fields are never modified — enrichment
 * only adds. Every added field is listed in the README so you always know which
 * numbers came from the model and which came from arithmetic.
 */

import { JevValidationError } from './errors.js';

/** Defaults for turning a Noul probability into a decision. */
export const DEFAULT_THRESHOLDS = Object.freeze({
	/** `answer.yes` is true at or above this. */
	yes: 0.5,
	/** `answer.verdict` is `'yes'` at or above this. */
	high: 0.8,
	/** `answer.verdict` is `'no'` at or below this. Between the two it is `'unsure'`. */
	low: 0.2
});

/**
 * @typedef {Object} JevThresholds
 * @property {number} [yes]
 * @property {number} [high]
 * @property {number} [low]
 */

/**
 * Enrich one answer in place of the raw one.
 *
 * @param {string} id the question id the answer came back under
 * @param {any} raw the answer exactly as the API returned it
 * @param {Object} [opts={}]
 * @param {JevThresholds} [opts.thresholds]
 * @param {string[]} [opts.levelNames] level names from `score()`'s object form
 * @returns {any} the enriched answer
 */
export function enrichAnswer(id, raw, opts = {}) {
	if (!raw || typeof raw !== 'object') return raw;
	const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };

	if (raw.type === 'noul') return enrichNoul(id, raw, thresholds);
	if (raw.type === 'choice') return enrichChoice(id, raw);
	if (raw.type === 'score') return enrichScore(id, raw, opts.levelNames);

	// An answer type this version does not know about. Pass it through with an id
	// rather than dropping it — a new primitive should not break a running app.
	return { id, ...raw };
}

/**
 * @param {string} id
 * @param {any} raw
 * @param {Required<JevThresholds>} t
 */
function enrichNoul(id, raw, t) {
	const p = numberOr(raw.noul, 0);
	return {
		id,
		type: 'noul',
		noul: p,
		/** Thresholded at `thresholds.yes`. */
		yes: p >= t.yes,
		/** Three-way: `'yes'`, `'no'`, or `'unsure'` in the band between. */
		verdict: p >= t.high ? 'yes' : p <= t.low ? 'no' : 'unsure',
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

/**
 * @param {string} id
 * @param {any} raw
 */
function enrichChoice(id, raw) {
	const probabilities = raw.probabilities ?? {};
	const ranked = rank(probabilities);
	const top = ranked[0];
	const second = ranked[1] ?? null;

	return {
		id,
		type: 'choice',
		choice: raw.choice,
		confidence: numberOr(raw.confidence, 0),
		probabilities,
		/** Every option, highest probability first. */
		ranked,
		/** Second place, or `null` when there is only one option. */
		runnerUp: second,
		/** Top probability minus second. A small margin is a close call. */
		margin: top && second ? top.probability - second.probability : (top ? top.probability : 0),
		/** Normalized Shannon entropy, 0 (one clear winner) to 1 (flat). */
		entropy: normalizedEntropy(Object.values(probabilities))
	};
}

/**
 * @param {string} id
 * @param {any} raw
 * @param {string[]|undefined} levelNames
 */
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
		type: 'score',
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

/**
 * Enrich a whole `answers` map.
 *
 * @param {Object.<string, any>} answers
 * @param {Object} [opts={}]
 * @param {JevThresholds} [opts.thresholds]
 * @param {Object.<string, {levelNames?: string[]}>} [opts.meta] per-question client metadata
 * @returns {Object.<string, any>}
 */
export function enrichAnswers(answers, opts = {}) {
	/** @type {Object.<string, any>} */
	const out = {};
	for (const [id, raw] of Object.entries(answers ?? {})) {
		out[id] = enrichAnswer(id, raw, {
			thresholds: opts.thresholds,
			levelNames: opts.meta?.[id]?.levelNames
		});
	}
	return out;
}

/**
 * Assert that every question id came back with an answer.
 *
 * The API returns one answer per question, so a gap here means something is
 * genuinely wrong: a truncated response, or a question id that collided with one
 * the caller passed through `opts.questions`.
 *
 * Every class calls this before reading answers. The alternative — skipping the
 * missing id — produces a composite score, a flag set, or an extracted record
 * that looks complete and is not. A quiet wrong number is worse than a loud stop,
 * and the `*Many` methods already capture a throw as a per-item failure.
 *
 * @param {Object.<string, any>} answers
 * @param {string[]} ids
 * @param {string} className for the message
 * @throws {JevValidationError} when any id is missing
 */
export function requireAnswers(answers, ids, className) {
	const missing = ids.filter((id) => !answers?.[id]);
	if (missing.length === 0) return;
	throw new JevValidationError(
		`${className}: the API returned no answer for ${missing.map((m) => `"${m}"`).join(', ')}. ` +
			`Expected ${ids.length} answers, got ${Object.keys(answers ?? {}).length}. ` +
			'A question id passed through opts.questions may have collided with one of the ' +
			"class's own ids.",
		{ questionId: missing[0] }
	);
}

// ── helpers, also exported because they are useful on their own ──────────────

/**
 * Sort a probability map into a descending list.
 * Ties break on key, so the order is stable across calls.
 *
 * @param {Object.<string, number>} probabilities
 * @returns {Array<{label: string, probability: number}>}
 */
export function rank(probabilities) {
	return Object.entries(probabilities ?? {})
		.map(([label, probability]) => ({ label, probability: numberOr(probability, 0) }))
		.sort((a, b) => b.probability - a.probability || a.label.localeCompare(b.label));
}

/**
 * Shannon entropy of a distribution, divided by `log(n)` so it lands on 0–1.
 *
 * 0 means all probability is on one outcome. 1 means it is spread evenly. This is
 * a second view of the same thing `confidence` reports; it is here because a flat
 * distribution over 10 levels and a flat one over 2 read very differently on a
 * raw confidence number.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function normalizedEntropy(values) {
	const ps = (values ?? []).map((v) => numberOr(v, 0)).filter((p) => p > 0);
	if (ps.length <= 1) return 0;
	const total = ps.reduce((a, b) => a + b, 0);
	if (total <= 0) return 0;
	let h = 0;
	for (const p of ps) {
		const q = p / total;
		h -= q * Math.log(q);
	}
	// Normalize by the maximum possible entropy for the number of OUTCOMES, not
	// the number of non-zero ones, so adding a zero-probability option does not
	// change the reading.
	const n = (values ?? []).length;
	return n > 1 ? h / Math.log(n) : 0;
}

/**
 * @param {any} v
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(v, fallback) {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Legend entries can be structured objects, not just strings.
 * @param {any} entry
 * @returns {any}
 */
function describeLevel(entry) {
	return entry === undefined ? null : entry;
}
