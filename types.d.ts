/**
 * ak-jev — Node.js bindings for TypeSafe's Jev, the System One model.
 *
 * Answer types are inferred from the questions you pass. A Choice over
 * `{billing, technical}` returns a `choice` typed `'billing' | 'technical'`, and a
 * Score over a three-entry tuple returns a `level` typed `0 | 1 | 2`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Any JSON-compatible value. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * What `state`, `instructions` and every criteria description accept. Structure
 * is allowed everywhere: Jev is trained to read it.
 */
export type EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null;

/** A criterion description; `null` leaves the label undescribed. */
export type Description = EntryType;

// ─────────────────────────────────────────────────────────────────────────────
// Questions
// ─────────────────────────────────────────────────────────────────────────────

export interface NoulCriteria {
	/** What a yes (a value near 1) means. */
	true?: EntryType;
	/** What a no (a value near 0) means. */
	false?: EntryType;
}

export interface NoulQuestion {
	type: 'noul';
	instructions?: EntryType;
	criteria?: NoulCriteria;
}

/** Labels mapped to descriptions. `null` where the label speaks for itself. */
export type ChoiceCriteria = { [label: string]: Description };

export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
	type: 'choice';
	instructions?: EntryType;
	criteria: T;
}

/** Ordered level descriptions, lowest first. */
export type ScoreCriteria = readonly EntryType[];

export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
	type: 'score';
	instructions?: EntryType;
	criteria: T;
}

export type Question = NoulQuestion | ChoiceQuestion<any> | ScoreQuestion<any>;

/** Questions keyed by the ids their answers come back under. */
export interface Questions {
	[id: string]: Question | string;
}

export declare const QUESTION_TYPES: readonly ['noul', 'choice', 'score'];
export declare const QUESTION_META: unique symbol;

/**
 * A yes/no question. Phrase it so a high value means yes.
 * @throws {JevValidationError} when both arguments are omitted
 */
export declare function noul(instructions?: EntryType, criteria?: NoulCriteria): NoulQuestion;

/**
 * Pick one option from a fixed set.
 *
 * `criteria` accepts a `{ label: description }` map, or a plain array of labels
 * which is expanded to `{ label: null }`.
 */
export declare function choice<const T extends ChoiceCriteria>(
	instructions: EntryType,
	criteria: T
): ChoiceQuestion<T>;
export declare function choice<const L extends readonly string[]>(
	instructions: EntryType,
	criteria: L
): ChoiceQuestion<{ [K in L[number]]: null }>;

/**
 * Rate the state along ordered levels.
 *
 * `criteria` accepts an ordered array of level descriptions, or an ordered
 * `{ name: description }` object whose keys become `answer.label`.
 */
export declare function score<const T extends ScoreCriteria>(
	instructions: EntryType,
	criteria: T
): ScoreQuestion<T>;
export declare function score<const T extends Record<string, EntryType>>(
	instructions: EntryType,
	criteria: T
): ScoreQuestion<readonly EntryType[]>;

export declare function expandQuestions(questions: Questions): Record<string, Question>;
export declare function toWireQuestions(questions: Record<string, Question>): Record<string, object>;
export declare function validateQuestions(
	questions: Record<string, Question>,
	opts?: { model?: string }
): { warnings: string[] };
export declare function questionMeta(question: unknown): { levelNames?: string[] };

// ─────────────────────────────────────────────────────────────────────────────
// Answers
// ─────────────────────────────────────────────────────────────────────────────

export interface RankedEntry {
	label: string;
	probability: number;
}

/** A yes/no answer, plus the fields ak-jev derives from it. */
export interface NoulAnswer {
	id: string;
	type: 'noul';
	/** Probability the answer is yes, 0 to 1. Straight from the API. */
	noul: number;
	/** DERIVED: `noul >= thresholds.yes`. */
	yes: boolean;
	/** DERIVED: `'yes'` / `'no'` / `'unsure'` from the two-sided threshold. */
	verdict: 'yes' | 'no' | 'unsure';
	/**
	 * DERIVED BY ak-jev, not returned by the API: `|noul - 0.5| * 2`. Present so
	 * one gating expression works across all three question types.
	 */
	confidence: number;
	thresholds: { yes: number; high: number; low: number };
}

/** The label a Choice can return, inferred from its criteria. */
export type ChoiceOf<T extends ChoiceCriteria> = keyof T & string;

export interface ChoiceAnswer<T extends ChoiceCriteria = ChoiceCriteria> {
	id: string;
	type: 'choice';
	/** The highest-probability option. From the API. */
	choice: ChoiceOf<T>;
	/** From the API, derived there from `probabilities`. */
	confidence: number;
	/** Every option mapped to its probability. Sums to 1. From the API. */
	probabilities: { [K in keyof T]: number };
	/** DERIVED: every option, highest probability first. */
	ranked: RankedEntry[];
	/** DERIVED: second place, or `null` when there is only one option. */
	runnerUp: RankedEntry | null;
	/** DERIVED: top probability minus second. */
	margin: number;
	/** DERIVED: normalized Shannon entropy, 0 (peaked) to 1 (flat). */
	entropy: number;
}

/** Valid level indices for a fixed-length rubric; `number` for a loose one. */
export type LevelOf<T extends ScoreCriteria> = number extends T['length']
	? number
	: Extract<keyof T, `${number}`> extends `${infer N extends number}`
		? N
		: number;

export interface ScoreAnswer<T extends ScoreCriteria = ScoreCriteria> {
	id: string;
	type: 'score';
	/** Probability-weighted position on the levels. Can fall between two. From the API. */
	score: number;
	/** From the API. */
	confidence: number;
	/** Each level number mapped back to its description. From the API. */
	legend: Record<string, EntryType>;
	/** Each level mapped to its probability. Sums to 1. From the API. */
	probabilities: Record<string, number>;
	/** DERIVED: how many levels the rubric has. */
	levels: number;
	/** DERIVED: `score / (levels - 1)`, 0 to 1. Normalize before weighting. */
	normalized: number;
	/** DERIVED: the nearest whole level. */
	level: number;
	/** DERIVED: the level name from `score()`'s object form, else the legend text. */
	label: EntryType;
	/** DERIVED: every level, highest probability first. */
	ranked: RankedEntry[];
	/** DERIVED: normalized Shannon entropy. */
	entropy: number;
}

export type Answer = NoulAnswer | ChoiceAnswer<any> | ScoreAnswer<any>;

/** The answer a given question produces, with its criteria keys preserved. */
export type AnswerFor<Q> = Q extends string
	? NoulAnswer
	: Q extends NoulQuestion
		? NoulAnswer
		: Q extends ChoiceQuestion<infer C>
			? ChoiceAnswer<C>
			: Q extends ScoreQuestion<infer S>
				? ScoreAnswer<S>
				: Answer;

/** Every answer for a question set, keyed the same way. */
export type AnswersFor<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface Thresholds {
	/** `answer.yes` is true at or above this. Default 0.5. */
	yes?: number;
	/** `answer.verdict` is `'yes'` at or above this. Default 0.8. */
	high?: number;
	/** `answer.verdict` is `'no'` at or below this. Default 0.2. */
	low?: number;
}

export declare const DEFAULT_THRESHOLDS: Readonly<Required<Thresholds>>;

export declare function enrichAnswer(
	id: string,
	raw: unknown,
	opts?: { thresholds?: Thresholds; levelNames?: string[] }
): Answer;
export declare function enrichAnswers(
	answers: Record<string, unknown>,
	opts?: { thresholds?: Thresholds; meta?: Record<string, { levelNames?: string[] }> }
): Record<string, Answer>;
export declare function rank(probabilities: Record<string, number>): RankedEntry[];
/** Throw if any question id came back without an answer. Used by every class. */
export declare function requireAnswers(
	answers: Record<string, unknown>,
	ids: string[],
	className: string
): void;
export declare function normalizedEntropy(values: number[]): number;

// ─────────────────────────────────────────────────────────────────────────────
// Results and usage
// ─────────────────────────────────────────────────────────────────────────────

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** USD. `null` means unknown — it never means free. */
	estimatedCost: number | null;
	/** This API returns no cost header, so a live call is always `'estimated'`. */
	costSource: 'estimated' | 'cached';
	/** API round trips. 0 for a cache hit. */
	requests: number;
	cached: boolean;
	questions: number;
}

export interface JevResult<Q extends Questions = Questions> {
	answers: AnswersFor<Q>;
	/** The versioned model that answered, e.g. `jev-1.13.0`. */
	model: string;
	/** What was sent, which may be an alias. */
	requestedModel: string;
	usage: Usage;
	/** `x-typesafe-request-id`, for a support ticket. */
	requestId: string | undefined;
	latencyMs: number;
	cached: boolean;
}

export interface JevFailure {
	index: number;
	error: Error;
	failed: true;
}

export interface Spread {
	mean: number;
	min: number;
	max: number;
	/** `max - min`. */
	spread: number;
	stdev: number;
}

export interface NoulSpread extends Spread {
	type: 'noul';
	values: number[];
	/** The modal three-way verdict across the draws. */
	verdict: 'yes' | 'no' | 'unsure';
	/** Fraction of draws that agreed with it, 0 to 1. */
	agreement: number;
	counts: Record<string, number>;
}

export interface ChoiceSpread {
	type: 'choice';
	/** The modal label across the draws. */
	choice: string;
	agreement: number;
	counts: Record<string, number>;
	confidence: Spread;
	values: string[];
}

export interface ScoreSpread extends Spread {
	type: 'score';
	values: number[];
	/** The modal nearest level, as a string key. */
	level: string;
	agreement: number;
	counts: Record<string, number>;
}

export type AnswerSpread = NoulSpread | ChoiceSpread | ScoreSpread;

export interface SampleResult<Q extends Questions = Questions> {
	n: number;
	samples: Array<JevResult<Q>>;
	summary: { [K in keyof Q]: AnswerSpread };
}

export interface JevStats {
	requests: number;
	retries: number;
	failures: number;
	cacheHits: number;
	cacheMisses: number;
	cacheSize: number;
	usage: Usage;
	governor: GovernorSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// Models, pricing, limits
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelCard {
	name: string;
	description: string;
	release_date: string;
}

export interface ModelPricing {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. Zero on this API — output is free. */
	output: number;
}

export interface ModelLimits {
	contextTokens: number;
	stateTokens: number;
	maxChoiceOptions: number;
	minChoiceOptions: number;
	maxScoreLevels: number;
	minScoreLevels: number;
	requestsPerMinute: number;
	tokensPerSecond: number;
	requestOverheadTokens: number;
}

export declare const MODEL_PRICING: Readonly<Record<string, ModelPricing>>;
export declare const MODEL_PRICING_AS_OF: string;
export declare const MODEL_ALIASES: Readonly<Record<string, string>>;
export declare const MODEL_LIMITS: Readonly<Record<string, ModelLimits>>;
export declare const DEFAULT_MODEL: string;
export declare const DEFAULT_BASE_URL: string;
export declare const SYSTEM_ONE_PATH: string;
export declare const MODELS_PATH: string;

export declare function resolveModelId(model: string): string;
export declare function resolvePricing(
	model: string
): (ModelPricing & { asOf: string; modelId: string }) | null;
export declare function resolveLimits(model: string): ModelLimits;
export declare function computeCost(
	usage: { inputTokens?: number; outputTokens?: number },
	model: string
): number | null;
export declare function listModels(opts?: {
	apiKey?: string;
	baseURL?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}): Promise<ModelCard[]>;

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────────────────────────────────────

export interface Estimate {
	stateTokens: number;
	questionTokens: number;
	overheadTokens: number;
	/** Nominal estimate of `input_tokens`. What `estimatedCost` is based on. */
	totalTokens: number;
	/** `totalTokens` with the safety margin. What the budget check compares. */
	budgetTokens: number;
	longestQuestionId: string | null;
	longestQuestionTokens: number;
	/** State plus the longest question, against the tighter 32k budget. */
	widestPathTokens: number;
	/** The same, with the safety margin. */
	budgetWidestPathTokens: number;
	perQuestion: Record<string, number>;
	questionCount: number;
	limits: ModelLimits;
	withinBudget: boolean;
	warnings: string[];
}

export declare function estimateTokens(value: unknown): number;
export declare function estimateQuestionTokens(question: unknown): number;
export declare const BUDGET_SAFETY_MARGIN: number;
export declare function estimateRequest(args: {
	state: unknown;
	questions: Record<string, unknown>;
	model?: string;
}): Estimate;

// ─────────────────────────────────────────────────────────────────────────────
// Client options
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent' | 'none';

export interface RetryPolicy {
	/** Retries after the first attempt. `0` disables them. Default 3. */
	maxRetries: number;
	/** First backoff, doubled up to `backoffMaxMs`. Default 500. */
	backoffInitialMs: number;
	backoffMaxMs: number;
	/** Fraction of each delay randomly subtracted, 0 to 1. Default 0.25. */
	backoffJitter: number;
	httpStatuses: readonly number[];
	respectRetryAfter: boolean;
	maxRetryAfterMs: number;
	apiConnectionError: boolean;
	apiTimeoutError: boolean;
}

export interface CacheOptions {
	/** Entries held in memory. Default 1000. */
	max?: number;
	/** Expiry. Omit for never. */
	ttlMs?: number;
	/** Write entries here too, so a re-run of a script is free. */
	dir?: string;
}

export interface JevOptions {
	/** Default `jev-latest`. Also accepted as `model`. */
	modelName?: string;
	model?: string;
	/** Falls back to `TYPESAFE_API_KEY`, then `JEV_API_KEY`. */
	apiKey?: string;
	/** Falls back to `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai`. */
	baseURL?: string;
	/** Per attempt, ms. Default 30000. */
	timeout?: number;
	retry?: Partial<RetryPolicy>;
	defaultHeaders?: Record<string, string>;
	/** Custom transport, for tests or a proxy. */
	fetch?: typeof fetch;
	logLevel?: LogLevel;
	/** Verify the key on `init()`. Default false. */
	healthCheck?: boolean;
	/** Where a Noul turns into a decision. */
	thresholds?: Thresholds;
	/** Check questions against the API's hard limits first. Default true. */
	validate?: boolean;
	/** Warn when a request looks too large for the context budget. Default true. */
	checkBudget?: boolean;
	/**
	 * Response cache. **Off by default**: the API is consistent but not
	 * deterministic, so an entry is a memo of one sample rather than the value of
	 * a pure function. Turn it on when iterating over a fixed corpus. Use
	 * `sample()` when you want the distribution.
	 */
	cache?: boolean | CacheOptions | ResponseCache;
	/** Simultaneous in-flight requests. Default 8. */
	concurrency?: number;
	/** Under the published 1,200. Default 1000. */
	requestsPerMinute?: number;
	/** Under the published 250,000. Default 200000. */
	tokensPerSecond?: number;
	onResult?: (result: JevResult) => void;
}

export interface EvaluateOptions {
	model?: string;
	signal?: AbortSignal;
	timeout?: number;
	retry?: Partial<RetryPolicy>;
	headers?: Record<string, string>;
}

export interface EvaluateManyOptions extends EvaluateOptions {
	onProgress?: (p: { done: number; total: number; index: number }) => void;
	/** Rethrow the first failure instead of capturing it per item. */
	throwOnError?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseJev
// ─────────────────────────────────────────────────────────────────────────────

export declare class BaseJev {
	constructor(options?: JevOptions);

	modelName: string;
	baseURL: string;
	thresholds: Required<Thresholds>;
	validate: boolean;
	checkBudget: boolean;
	healthCheck: boolean;
	governor: Governor;
	cache: ResponseCache | null;
	client: JevClient;

	/** Resolve configuration and, with `healthCheck`, verify the key. */
	init(): Promise<this>;

	/** Evaluate one state against a question set. */
	evaluate<Q extends Questions>(
		state: EntryType,
		questions: Q,
		opts?: EvaluateOptions
	): Promise<JevResult<Q>>;

	/** Evaluate many states in parallel. Results keep input order. */
	evaluateMany<Q extends Questions>(
		states: EntryType[],
		questions: Q,
		opts?: EvaluateManyOptions
	): Promise<Array<JevResult<Q> | JevFailure>>;

	/**
	 * Run the same evaluation `n` times and report the spread.
	 *
	 * Jev is consistent but not deterministic: 12 identical requests, measured
	 * 2026-09-21, returned 6 distinct scores across a range of 0.08. Always
	 * bypasses the cache.
	 */
	sample<Q extends Questions>(
		state: EntryType,
		questions: Q,
		opts?: EvaluateOptions & { n?: number }
	): Promise<SampleResult<Q>>;

	/** Send a body through unchanged; get the raw response back. */
	raw(body: { state: EntryType; model?: string; questions: object }, opts?: RequestOptions): Promise<any>;

	listModels(opts?: RequestOptions): Promise<ModelCard[]>;

	/** Token and cost estimate, with both context budgets checked. No API call. */
	estimate(
		state: EntryType,
		questions: Questions,
		opts?: { model?: string }
	): Estimate & { estimatedCost: number | null };

	estimateCost(state: EntryType, questions: Questions, opts?: { model?: string }): number | null;

	getLastUsage(): Usage | null;
	getTotalUsage(): Usage;
	resetUsage(): void;
	stats(): JevStats;
	limits(): ModelLimits;
	pricing(): (ModelPricing & { asOf: string; modelId: string }) | null;
}

export declare function normalizeOptions(raw?: JevOptions): Record<string, any>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluatorOptions<Q extends Questions = Questions> extends JevOptions {
	questions?: Q;
}

export declare class Evaluator<Q extends Questions = Questions> extends BaseJev {
	constructor(options?: EvaluatorOptions<Q>);
	questions: Record<string, Question>;

	addQuestions(questions: Questions): this;
	removeQuestions(...ids: string[]): this;

	run(state: EntryType, opts?: EvaluateOptions & { questions?: Questions }): Promise<JevResult<Q>>;
	runMany(
		states: EntryType[],
		opts?: EvaluateManyOptions & { questions?: Questions }
	): Promise<Array<JevResult<Q> | JevFailure>>;
	/** Yields each result as it lands, in completion order. */
	stream(
		states: EntryType[],
		opts?: EvaluateManyOptions & { questions?: Questions }
	): AsyncGenerator<{ index: number; state: EntryType; result?: JevResult<Q>; error?: Error }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifierOptions extends JevOptions {
	labels: ChoiceCriteria | string[];
	instructions?: string;
	/** Below this, `label` becomes `fallback` and `decided` is false. */
	minConfidence?: number;
	/** Where an undecided result goes. Must not collide with a real label. */
	fallback?: string | null;
	/** Other labels above this probability come back in `alternatives`. */
	alternativeThreshold?: number;
	questionId?: string;
}

export interface Classification {
	/** The decision, or the fallback when confidence was too low. */
	label: string | null;
	decided: boolean;
	/** What the model picked, before the gate. */
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
	ranked: RankedEntry[];
	runnerUp: RankedEntry | null;
	margin: number;
	entropy: number;
	alternatives: RankedEntry[];
	answers: Record<string, Answer>;
	usage: Usage;
	cached: boolean;
	requestId: string | undefined;
}

export declare class Classifier extends BaseJev {
	constructor(options: ClassifierOptions);
	labels: string[];
	instructions: string;
	minConfidence: number;
	fallback: string | null;

	classify(state: EntryType, opts?: EvaluateOptions & { questions?: Questions }): Promise<Classification>;
	classifyMany(
		states: EntryType[],
		opts?: EvaluateManyOptions & { questions?: Questions }
	): Promise<Array<Classification | JevFailure>>;
	/** Bucket states by their label. Undecided land under the fallback. */
	group(states: EntryType[], opts?: EvaluateManyOptions): Promise<Record<string, EntryType[]>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detector
// ─────────────────────────────────────────────────────────────────────────────

export interface DetectorCondition {
	instructions?: EntryType;
	criteria?: NoulCriteria;
	/** Overrides the client threshold for this condition alone. */
	yes?: number;
	high?: number;
	low?: number;
}

export interface DetectorOptions extends JevOptions {
	conditions: Record<string, string | DetectorCondition>;
}

export interface Detection {
	flags: Record<string, boolean>;
	probabilities: Record<string, number>;
	verdicts: Record<string, 'yes' | 'no' | 'unsure'>;
	/** Ids where `flags` is true, strongest first. */
	triggered: string[];
	/** Ids in the band between `low` and `high` — the ones to send to a person. */
	unsure: string[];
	any: boolean;
	all: boolean;
	count: number;
	max: number;
	answers: Record<string, Answer>;
	usage: Usage;
	cached: boolean;
	requestId: string | undefined;
}

export declare class Detector extends BaseJev {
	constructor(options: DetectorOptions);
	conditionIds: string[];
	check(state: EntryType, opts?: EvaluateOptions & { questions?: Questions }): Promise<Detection>;
	checkMany(
		states: EntryType[],
		opts?: EvaluateManyOptions & { questions?: Questions }
	): Promise<Array<Detection | JevFailure>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scorer
// ─────────────────────────────────────────────────────────────────────────────

export interface ScorerDimension {
	instructions: EntryType;
	/** Ordered array, or an ordered `{ name: description }` object. */
	levels: readonly EntryType[] | Record<string, EntryType>;
	criteria?: readonly EntryType[] | Record<string, EntryType>;
	/** Relative importance. All weights are rescaled to sum to 1. Default 1. */
	weight?: number;
	/** A high level lowers the composite. */
	invert?: boolean;
}

export interface ScorerOptions extends JevOptions {
	dimensions: Record<string, ScorerDimension>;
}

export interface ScoredDimension {
	score: number;
	normalized: number;
	weight: number;
	weighted: number;
	confidence: number;
	level: number;
	label: EntryType;
	levels: number;
	probabilities: Record<string, number>;
	entropy: number;
	inverted: boolean;
}

export interface CompositeScore {
	/** 0 to 1. The weighted mean of the normalized dimensions. */
	composite: number;
	dimensions: Record<string, ScoredDimension>;
	confidence: number;
	/** The dimension the model was least sure about. */
	weakest: string | null;
	weakestConfidence: number;
	answers: Record<string, Answer>;
	usage: Usage;
	cached: boolean;
	requestId: string | undefined;
}

export interface RankedState {
	index: number;
	state: EntryType;
	composite: number | null;
	result: CompositeScore | null;
	error?: Error;
}

export declare class Scorer extends BaseJev {
	constructor(options: ScorerOptions);
	dimensionIds: string[];
	weights: Record<string, number>;
	normalizedWeights: Record<string, number>;

	score(state: EntryType, opts?: EvaluateOptions & { questions?: Questions }): Promise<CompositeScore>;
	scoreMany(
		states: EntryType[],
		opts?: EvaluateManyOptions & { questions?: Questions }
	): Promise<Array<CompositeScore | JevFailure>>;
	/** Score many and sort, highest composite first. Failures sort last. */
	rank(states: EntryType[], opts?: EvaluateManyOptions & { top?: number }): Promise<RankedState[]>;

	/** Recompute a composite from an existing result. No API call. */
	static reweight(result: CompositeScore, weights: Record<string, number>): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteContext {
	state: EntryType;
	extra: unknown;
	route: string | null;
	confidence: number;
	answers: Record<string, Answer>;
	classification: Routing;
}

export interface RouteSpec {
	description?: EntryType;
	handler?: (ctx: RouteContext) => unknown | Promise<unknown>;
	/** This route's own bar. Defaults to the Router's `minConfidence`. */
	minConfidence?: number;
}

export interface RouterOptions extends JevOptions {
	routes: Record<string, RouteSpec | ((ctx: RouteContext) => unknown) | string>;
	instructions?: string;
	fallback?: (ctx: RouteContext) => unknown | Promise<unknown>;
	minConfidence?: number;
	/** Run the handler, or just return the decision. Default true. */
	dispatch?: boolean;
	/** Extra questions carried in the same request; handlers can read them. */
	questions?: Questions;
	questionId?: string;
}

export interface Routing {
	/** The route that ran, or null when nothing cleared its bar. */
	route: string | null;
	choice: string;
	decided: boolean;
	confidence: number;
	required: number | null;
	probabilities: Record<string, number>;
	ranked: RankedEntry[];
	runnerUp: RankedEntry | null;
	margin: number;
	answers: Record<string, Answer>;
	usage: Usage;
	cached: boolean;
	requestId: string | undefined;
	handled: boolean;
	fellBack?: boolean;
	value: unknown;
}

export declare class Router extends BaseJev {
	constructor(options: RouterOptions);
	routes: Record<string, { handler?: Function; minConfidence: number }>;
	route(state: EntryType, extra?: unknown, opts?: EvaluateOptions & { dispatch?: boolean }): Promise<Routing>;
	routeMany(
		states: EntryType[],
		opts?: EvaluateManyOptions & { extraFor?: (state: EntryType, index: number) => unknown }
	): Promise<Array<Routing | JevFailure>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranker
// ─────────────────────────────────────────────────────────────────────────────

export interface RankerOptions extends JevOptions {
	instructions?: string;
	/** `'noul'` scores each candidate 0–1; `'score'` places it on `levels`. */
	mode?: 'noul' | 'score';
	levels?: readonly EntryType[];
	criteria?: NoulCriteria;
	/** Pull the text out of a candidate object. */
	toText?: (candidate: any, index: number) => EntryType;
	/** Token budget per request. Default 40000. */
	batchTokens?: number;
	/** Hard cap on candidates per request. Default 400. */
	batchSize?: number;
}

export interface RankOptions extends EvaluateOptions {
	top?: number;
	minRelevance?: number;
	onProgress?: (p: { done: number; total: number }) => void;
}

export interface PickOptions extends EvaluateOptions {
	instructions?: string;
	/** Add a "none of these" option and an absolute `found` check. */
	includeNone?: boolean;
}

export interface RankedCandidate<T = any> {
	rank: number;
	index: number;
	candidate: T;
	/** 0 to 1: the noul value, or the normalized score. */
	relevance: number;
	answer: Answer;
}

export interface PickResult<T = any> {
	/** -1 when nothing was picked. */
	index: number;
	candidate: T | null;
	confidence: number;
	/** Whether any candidate answers the query at all. Absolute, not relative. */
	found: boolean;
	ranked: Array<{ index: number; candidate: T; probability: number }>;
	answers: Record<string, Answer>;
	usage: Usage;
	cached: boolean;
	requestId: string | undefined;
}

export declare class Ranker extends BaseJev {
	constructor(options?: RankerOptions);
	mode: 'noul' | 'score';
	/** Score every candidate and sort, best first. Batched across requests. */
	rank<T>(query: EntryType, candidates: T[], opts?: RankOptions): Promise<Array<RankedCandidate<T>>>;
	/** One winner, one request. Bounded by the 255-option Choice limit. */
	pick<T>(query: EntryType, candidates: T[], opts?: PickOptions): Promise<PickResult<T>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractorField {
	instructions?: EntryType;
	/** The bounded set of values. Jev picks from a list; it cannot generate one. */
	options: string[] | ChoiceCriteria;
	criteria?: string[] | ChoiceCriteria;
	/** Add a "not stated" option, mapped to `null` in the record. */
	allowMissing?: boolean;
	missingDescription?: EntryType;
	/** Below this the field comes back `null` and lands in `uncertain`. */
	minConfidence?: number;
	/** Normalize the winning label. Runs in code, after the verbatim copy. */
	transform?: (value: string, answer: ChoiceAnswer) => unknown;
}

export interface ExtractorOptions extends JevOptions {
	fields: Record<string, ExtractorField>;
	allowMissing?: boolean;
	minConfidence?: number;
}

export interface ExtractedField {
	value: unknown;
	choice: string;
	decided: boolean;
	notStated: boolean;
	confidence: number;
	probabilities: Record<string, number>;
	runnerUp: RankedEntry | null;
	margin: number;
	required: number;
}

export interface Extraction {
	/** The extracted values. `null` where missing or below the bar. */
	record: Record<string, unknown>;
	fields: Record<string, ExtractedField>;
	missing: string[];
	uncertain: string[];
	complete: boolean;
	minConfidence: number;
	answers: Record<string, Answer>;
	usage: Usage;
	cached: boolean;
	requestId: string | undefined;
}

export declare const NOT_STATED: '__not_stated__';

export declare class Extractor extends BaseJev {
	constructor(options: ExtractorOptions);
	fieldNames: string[];
	extract(state: EntryType, opts?: EvaluateOptions & { questions?: Questions }): Promise<Extraction>;
	extractMany(
		states: EntryType[],
		opts?: EvaluateManyOptions & { questions?: Questions }
	): Promise<Array<Extraction | JevFailure>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Taxonomy
// ─────────────────────────────────────────────────────────────────────────────

/** A nested category tree. `null` (or any non-object) marks a leaf. */
export interface TaxonomyTree {
	[category: string]: TaxonomyTree | null | string;
}

export interface TaxonomyOptions extends JevOptions {
	tree?: TaxonomyTree;
	instructions?: string;
	/** Paths kept alive per level. 1 is greedy. Default 1. */
	beam?: number;
	/** Stop descending below this path probability. Default 0. */
	minScore?: number;
	maxDepth?: number;
	/** How many levels of a subtree to show as an option description. Default 2. */
	describeDepth?: number;
}

export interface TaxonomyStep {
	depth: number;
	parent: string | null;
	label: string;
	probability: number;
	confidence: number;
	ranked: RankedEntry[];
}

export interface TaxonomyResult {
	path: string[];
	label: string | null;
	/** Product of the probabilities along the path. */
	score: number;
	steps: TaxonomyStep[];
	candidates: Array<{ path: string[]; score: number }>;
	/** True when `maxDepth` stopped the walk above a leaf, so `path` is partial. */
	truncated: boolean;
	/** API round trips this walk took. */
	requests: number;
	usage: Usage | null;
}

export declare class Taxonomy extends BaseJev {
	constructor(options: TaxonomyOptions);
	tree: TaxonomyTree;
	classify(state: EntryType, opts?: TaxonomyOptions & EvaluateOptions): Promise<TaxonomyResult>;
	classifyMany(
		states: EntryType[],
		opts?: TaxonomyOptions & EvaluateManyOptions
	): Promise<Array<TaxonomyResult | JevFailure>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard
// ─────────────────────────────────────────────────────────────────────────────

export type GuardAction = 'allow' | 'review' | 'block';
export declare const GUARD_ACTIONS: readonly GuardAction[];

export interface GuardHazard {
	/** Phrase it so that yes means the hazard is present. */
	instructions: EntryType;
	criteria?: NoulCriteria;
	action?: GuardAction;
	/** The probability at which it fires. Default 0.5. */
	threshold?: number;
	/** A lower bar at which it only warrants review. */
	reviewThreshold?: number;
	description?: string;
}

export interface GuardOptions extends JevOptions {
	hazards: Record<string, GuardHazard | string>;
	threshold?: number;
}

export interface TriggeredHazard {
	id: string;
	probability: number;
	action: GuardAction;
	threshold: number;
	description: string | null;
}

export interface Verdict {
	/** The strictest triggered action. */
	action: GuardAction;
	allowed: boolean;
	review: boolean;
	blocked: boolean;
	triggered: TriggeredHazard[];
	reasons: string[];
	probabilities: Record<string, number>;
	max: number;
	answers: Record<string, Answer>;
	usage: Usage;
	cached: boolean;
	requestId: string | undefined;
}

export declare class Guard extends BaseJev {
	constructor(options: GuardOptions);
	hazardIds: string[];
	inspect(state: EntryType, opts?: EvaluateOptions & { questions?: Questions }): Promise<Verdict>;
	/** Throws `JevGuardError` on a `block` verdict. A `review` returns normally. */
	assert(state: EntryType, opts?: EvaluateOptions): Promise<Verdict>;
	inspectMany(states: EntryType[], opts?: EvaluateManyOptions): Promise<Array<Verdict | JevFailure>>;
	/** Wrap an async function so its input and output are both checked. */
	wrap<T>(
		fn: (input: any) => Promise<T>,
		opts?: {
			input?: boolean;
			output?: boolean;
			onBlock?: (v: Verdict, phase: 'input' | 'output') => any;
		}
	): (input: any) => Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport, cache, governor
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestOptions {
	signal?: AbortSignal;
	timeout?: number;
	retry?: Partial<RetryPolicy>;
	headers?: Record<string, string>;
	estimatedTokens?: number;
}

export declare const DEFAULT_RETRY: Readonly<RetryPolicy>;
export declare const DEFAULT_TIMEOUT_MS: number;

export declare class JevClient {
	constructor(config?: {
		apiKey?: string;
		baseURL?: string;
		timeout?: number;
		retry?: Partial<RetryPolicy>;
		defaultHeaders?: Record<string, string>;
		fetch?: typeof fetch;
		governor?: Governor;
		userAgent?: string;
	});
	apiKey: string;
	baseURL: string;
	timeout: number;
	retry: RetryPolicy;
	governor: Governor;
	counters: { requests: number; retries: number; failures: number };

	systemOne(
		body: { state: EntryType; model: string; questions: object },
		options?: RequestOptions
	): Promise<{ data: any; requestId: string | undefined; status: number; headers: Record<string, string>; latencyMs: number }>;
	models(options?: RequestOptions): Promise<ModelCard[]>;
	request(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
		options?: RequestOptions
	): Promise<{ data: any; requestId: string | undefined; status: number; headers: Record<string, string>; latencyMs: number }>;
}

export declare function backoffDelay(err: unknown, attempt: number, retry: RetryPolicy): number;

export declare class ResponseCache {
	constructor(opts?: CacheOptions);
	readonly size: number;
	hits: number;
	misses: number;
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	clear(): void;
}

export declare function resolveCache(option?: boolean | CacheOptions | ResponseCache): ResponseCache | null;
export declare function cacheKey(args: {
	baseURL: string;
	model: string;
	state: unknown;
	questions: unknown;
}): string;
export declare function canonicalize(value: unknown): string;

export interface GovernorSnapshot {
	active: number;
	queued: number;
	requestsInWindow: number;
	tokensInWindow: number;
	admitted: number;
	throttledMs: number;
	peakQueued: number;
}

export declare class Governor {
	constructor(opts?: { concurrency?: number; requestsPerMinute?: number; tokensPerSecond?: number });
	concurrency: number;
	requestsPerMinute: number;
	tokensPerSecond: number;
	run<T>(fn: () => Promise<T>, opts?: { tokens?: number; signal?: AbortSignal }): Promise<T>;
	snapshot(): GovernorSnapshot;
}

export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export declare class JevError extends Error {
	requestId?: string;
}
export declare class JevConfigError extends JevError {}
export declare class JevValidationError extends JevError {
	questionId?: string;
}
export declare class JevConnectionError extends JevError {
	cause?: Error;
}
export declare class JevTimeoutError extends JevError {
	timeout?: number;
}
export declare class JevAbortError extends JevError {}

export declare class JevAPIError extends JevError {
	status: number;
	detail: unknown;
	errorType?: string;
	headers: Record<string, string>;
}
export declare class JevAuthError extends JevAPIError {}
export declare class JevBadRequestError extends JevAPIError {}
/** 400 `max_tokens_exceeded`. The API sends no message; this one explains the fix. */
export declare class JevRequestTooLargeError extends JevBadRequestError {}
export declare class JevNotFoundError extends JevAPIError {}
export declare class JevPermissionError extends JevAPIError {}
export declare class JevUnprocessableError extends JevAPIError {
	fields: Array<{ path: string; message: string }>;
}
export declare class JevRateLimitError extends JevAPIError {
	retryAfterMs?: number;
}
export declare class JevOverloadedError extends JevAPIError {}
export declare class JevServerError extends JevAPIError {}

export declare class JevGuardError extends JevError {
	verdict: Verdict;
	reasons: string[];
}

export declare function describeDetail(
	body: unknown,
	status: number
): { message: string; errorType: string | undefined; fields: Array<{ path: string; message: string }> };
export declare function errorFromResponse(args: {
	status: number;
	body: unknown;
	headers: Record<string, string>;
	requestId: string | undefined;
}): JevAPIError;
export declare function parseRetryAfter(headers?: Record<string, string>): number | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Top-level helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The shared client behind `ask()` and `models()`. */
export declare function client(options?: JevOptions): BaseJev;
/** Drop the shared client; the next `ask()` builds a fresh one. */
export declare function resetClient(): void;

/** Ask questions about a state, with no setup. */
export declare function ask<Q extends Questions>(
	state: EntryType,
	questions: Q,
	opts?: EvaluateOptions & JevOptions
): Promise<JevResult<Q>>;

export declare function models(opts?: JevOptions): Promise<ModelCard[]>;

/**
 * Token and cost estimate for a request. Synchronous, free, and needs no API key.
 * `BaseJev.estimate()` is the same calculation on a configured client.
 */
export declare function estimate(
	state: EntryType,
	questions: Questions,
	opts?: { model?: string }
): Estimate & { estimatedCost: number | null };

/**
 * Ask the same questions `n` times and report the spread. Bypasses the cache.
 *
 * Jev is consistent but not deterministic: 12 identical requests, measured
 * 2026-09-21, returned 6 distinct scores spanning 0.08.
 */
export declare function sample<Q extends Questions>(
	state: EntryType,
	questions: Q,
	opts?: EvaluateOptions & JevOptions & { n?: number }
): Promise<SampleResult<Q>>;

export declare const log: {
	level: string;
	trace(...args: any[]): void;
	debug(...args: any[]): void;
	info(...args: any[]): void;
	warn(...args: any[]): void;
	error(...args: any[]): void;
	fatal(...args: any[]): void;
};

declare const _default: {
	Evaluator: typeof Evaluator;
	Classifier: typeof Classifier;
	Detector: typeof Detector;
	Scorer: typeof Scorer;
	Router: typeof Router;
	Ranker: typeof Ranker;
	Extractor: typeof Extractor;
	Taxonomy: typeof Taxonomy;
	Guard: typeof Guard;
	ask: typeof ask;
	sample: typeof sample;
	estimate: typeof estimate;
	models: typeof models;
	client: typeof client;
	resetClient: typeof resetClient;
};

export default _default;
