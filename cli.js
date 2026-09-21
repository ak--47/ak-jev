#!/usr/bin/env node
/**
 * @fileoverview ak-jev CLI — ask Jev questions from a terminal.
 *
 * ```
 * ak-jev ask "My card was charged twice" --noul "Is this about billing?"
 * ak-jev ask --file ticket.txt --questions questions.json
 * ak-jev models
 * ak-jev estimate --file big.txt --questions questions.json
 * ```
 */

import { readFileSync } from 'node:fs';
import BaseJev from './base.js';
import { noul, choice, score } from './questions.js';
import { listModels, MODEL_PRICING, MODEL_PRICING_AS_OF, MODEL_LIMITS } from './models.js';
import { estimate as estimateRequestCost } from './index.js';
import { JevError } from './errors.js';

const HELP = `
ak-jev — typed decisions from TypeSafe's Jev model

USAGE
  ak-jev ask [state] [options]        evaluate a state against questions
  ak-jev estimate [state] [options]   token and cost estimate, no API call
  ak-jev models                       list the models this key can use
  ak-jev limits                       print the model's hard limits and rates

STATE
  [state]                     the text to evaluate, as a positional argument
  --file <path>               read the state from a file instead
  --json-state                parse the state as JSON before sending
  (with neither, stdin is read)

QUESTIONS
  --noul   "<question>"              a yes/no question       (repeatable)
  --choice "id:a,b,c"                pick one of a,b,c       (repeatable)
  --score  "id:low|mid|high"         rate on ordered levels  (repeatable)
  --questions <path>                 a JSON file of questions, merged in

  A --noul with no "id:" prefix is named n1, n2, ... in order.

OPTIONS
  --model <name>              default jev-latest
  --api-key <key>             overrides TYPESAFE_API_KEY. That variable is read
                              from the environment, or from a .env file in the
                              CURRENT directory. Prefer the variable: an argument
                              is visible in "ps" and in your shell history.
  --json                      print the raw JSON result
  --no-cache                  skip the response cache
  --quiet                     suppress the usage footer
  -h, --help

EXAMPLES
  ak-jev ask "Help, my payouts have been failing for 3 days" \\
    --noul "urgent:Does this convey urgency?" \\
    --choice "team:billing,technical,sales" \\
    --score "anger:Calm|Annoyed|Furious"

  cat ticket.txt | ak-jev ask --questions triage.json --json

  ak-jev estimate --file contract.txt --questions checks.json
`;

/** Every flag this CLI knows, so a missing value cannot swallow the next one. */
const FLAGS = new Set([
	'-h', '--help', '--json', '--json-state', '--no-cache', '--quiet',
	'--file', '--questions', '--model', '--api-key', '--noul', '--choice', '--score'
]);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	/** @type {any} */
	const out = { _: [], noul: [], choice: [], score: [] };

	// Read the value that follows a flag. A missing one must fail loudly: a
	// dropped `--api-key` value would otherwise fall back to the environment key,
	// which is the one the user was trying to override.
	/** @param {number} i index of the value, i.e. the flag's index plus one */
	const value = (i) => {
		const v = argv[i];
		if (v === undefined || FLAGS.has(v)) throw new Error(`${argv[i - 1]} needs a value.`);
		return v;
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') out.help = true;
		else if (a === '--json') out.json = true;
		else if (a === '--json-state') out.jsonState = true;
		else if (a === '--no-cache') out.noCache = true;
		else if (a === '--quiet') out.quiet = true;
		else if (a === '--file') out.file = value(++i);
		else if (a === '--questions') out.questionsFile = value(++i);
		else if (a === '--model') out.model = value(++i);
		else if (a === '--api-key') out.apiKey = value(++i);
		else if (a === '--noul') out.noul.push(value(++i));
		else if (a === '--choice') out.choice.push(value(++i));
		else if (a === '--score') out.score.push(value(++i));
		else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
		else out._.push(a);
	}
	return out;
}

/**
 * Split `"id:rest"` into its two parts. No colon means no id.
 * @param {string} spec
 * @returns {{id: string|null, rest: string}}
 */
function splitId(spec) {
	const at = spec.indexOf(':');
	if (at < 0) return { id: null, rest: spec };
	return { id: spec.slice(0, at).trim(), rest: spec.slice(at + 1).trim() };
}

/** @param {any} args */
function buildQuestions(args) {
	/** @type {Object.<string, any>} */
	const questions = {};

	args.noul.forEach((/** @type {string} */ spec, /** @type {number} */ i) => {
		const { id, rest } = splitId(spec);
		questions[id || `n${i + 1}`] = noul(rest);
	});

	args.choice.forEach((/** @type {string} */ spec, /** @type {number} */ i) => {
		const { id, rest } = splitId(spec);
		const labels = rest.split(',').map((s) => s.trim()).filter(Boolean);
		questions[id || `c${i + 1}`] = choice(`Which of these best applies?`, labels);
	});

	args.score.forEach((/** @type {string} */ spec, /** @type {number} */ i) => {
		const { id, rest } = splitId(spec);
		const levels = rest.split('|').map((s) => s.trim()).filter(Boolean);
		questions[id || `s${i + 1}`] = score('Rate the state on these levels.', levels);
	});

	if (args.questionsFile) {
		const parsed = JSON.parse(readFileSync(args.questionsFile, 'utf8'));
		Object.assign(questions, parsed);
	}

	return questions;
}

/** @param {any} args */
async function readState(args) {
	let text;
	if (args.file) text = readFileSync(args.file, 'utf8');
	else if (args._.length > 1) text = args._.slice(1).join(' ');
	else text = await readStdin();

	if (!text || !text.trim()) {
		throw new Error('No state. Pass it as an argument, with --file, or on stdin.');
	}
	return args.jsonState ? JSON.parse(text) : text;
}

function readStdin() {
	return new Promise((resolve) => {
		if (process.stdin.isTTY) return resolve('');
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (c) => { data += c; });
		process.stdin.on('end', () => resolve(data));
	});
}

/** @param {any} answers */
function printAnswers(answers) {
	for (const [id, a] of Object.entries(/** @type {any} */ (answers))) {
		const ans = /** @type {any} */ (a);
		if (ans.type === 'noul') {
			console.log(`${id}\n  noul       ${ans.noul.toFixed(2)}   ${bar(ans.noul)}  ${ans.verdict}`);
		} else if (ans.type === 'choice') {
			console.log(`${id}\n  choice     ${ans.choice}   (confidence ${ans.confidence.toFixed(2)}, margin ${ans.margin.toFixed(2)})`);
			for (const r of ans.ranked) {
				if (r.probability > 0) console.log(`             ${r.probability.toFixed(2)} ${bar(r.probability)} ${r.label}`);
			}
		} else if (ans.type === 'score') {
			const name = typeof ans.label === 'string' ? ans.label : `level ${ans.level}`;
			console.log(`${id}\n  score      ${ans.score.toFixed(2)} / ${ans.levels - 1}   (${ans.normalized.toFixed(2)} normalized, confidence ${ans.confidence.toFixed(2)})`);
			console.log(`  nearest    ${name}`);
			for (const r of ans.ranked) {
				if (r.probability > 0) console.log(`             ${r.probability.toFixed(2)} ${bar(r.probability)} ${ans.legend[r.label] ?? r.label}`);
			}
		}
		console.log('');
	}
}

/** @param {number} p */
function bar(p) {
	const n = Math.round(p * 20);
	return '█'.repeat(n) + '·'.repeat(20 - n);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const command = args._[0];

	if (args.help || !command) {
		console.log(HELP.trim());
		return;
	}

	if (command === 'models') {
		const models = await listModels({ apiKey: args.apiKey });
		for (const m of models) {
			console.log(`${m.name.padEnd(14)} ${String(m.release_date).slice(0, 10)}  ${m.description}`);
		}
		return;
	}

	if (command === 'limits') {
		for (const [id, rates] of Object.entries(MODEL_PRICING)) {
			const lim = MODEL_LIMITS[id];
			console.log(`${id}   (rates as of ${MODEL_PRICING_AS_OF})`);
			console.log(`  input             $${rates.input}/Mtok`);
			console.log(`  output            $${rates.output}/Mtok  (free)`);
			console.log(`  context           ${lim.contextTokens} tokens total, ${lim.stateTokens} for state + longest question`);
			console.log(`  choice options    ${lim.maxChoiceOptions} max`);
			console.log(`  score levels      ${lim.maxScoreLevels} max`);
			console.log(`  rate limits       ${lim.requestsPerMinute} req/min, ${lim.tokensPerSecond} tok/sec`);
		}
		return;
	}

	if (command !== 'ask' && command !== 'estimate') {
		throw new Error(`Unknown command: ${command}. Try --help.`);
	}

	const state = await readState(args);
	const questions = buildQuestions(args);
	if (Object.keys(questions).length === 0) {
		throw new Error('No questions. Use --noul, --choice, --score, or --questions.');
	}

	if (command === 'estimate') {
		// Deliberately before the client is built: estimating makes no API call, so
		// it must not require a key.
		const est = estimateRequestCost(state, questions, { model: args.model });
		if (args.json) return console.log(JSON.stringify(est, null, 2));
		console.log(`questions        ${est.questionCount}`);
		console.log(`state tokens     ~${est.stateTokens}`);
		console.log(`question tokens  ~${est.questionTokens}`);
		console.log(`total            ~${est.totalTokens} / ${est.limits.contextTokens}`);
		console.log(`widest path      ~${est.widestPathTokens} / ${est.limits.stateTokens}   (state + "${est.longestQuestionId}")`);
		console.log(`estimated cost   $${(est.estimatedCost ?? 0).toFixed(8)}`);
		console.log(`within budget    ${est.withinBudget ? 'yes' : 'NO'}`);
		for (const w of est.warnings) console.log(`  ! ${w}`);
		return;
	}

	const jev = new BaseJev({
		modelName: args.model,
		apiKey: args.apiKey,
		cache: !args.noCache,
		logLevel: 'warn'
	});

	const result = await jev.evaluate(state, questions);

	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log('');
	printAnswers(result.answers);
	if (!args.quiet) {
		const u = result.usage;
		const cost = u.estimatedCost === null ? 'unknown' : `$${u.estimatedCost.toFixed(8)}`;
		console.log(
			`${result.model}  ${result.latencyMs}ms  ${u.inputTokens} in / ${u.outputTokens} out  ${cost}` +
				`${result.cached ? '  (cached)' : ''}`
		);
	}
}

main().catch((err) => {
	if (err instanceof JevError) {
		console.error(`\n${err.name}: ${err.message}`);
		if (/** @type {any} */ (err).requestId) console.error(`request id: ${/** @type {any} */ (err).requestId}`);
	} else {
		console.error(`\nError: ${err.message}`);
	}
	process.exit(1);
});
