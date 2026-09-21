/**
 * 08 — Moderate a batch: Detector + Classifier, paced by the governor.
 *
 * At $0.042 per million input tokens you can afford to check everything, so the
 * interesting problem stops being cost and starts being throughput. The governor
 * keeps you under the published 1,200 req/min and 250,000 tokens/sec without you
 * writing a queue.
 *
 * A failure is captured per item rather than losing the batch.
 *
 *   node examples/08-moderate-a-batch.mjs
 */

import { Detector, Classifier } from '../index.js';

const POSTS = [
	'Has anyone got the new firmware working on a v2 board? Mine hangs on boot.',
	'You are all idiots and this forum is a waste of oxygen. Get a life.',
	"DM me for cheap followers!!! 100% real, best price, click here bit.ly/xyz",
	'My doctor said 40mg but I read online you can take 400mg safely, is that right?',
	"Here's my number if anyone wants to chat offline: 555-0147, ask for Dana.",
	'Solved it — you need to hold BOOT while plugging in USB. Writeup in the wiki.',
	'This product is garbage and the CEO should be ashamed. Refund me or I go to the press.',
	'Selling two spare v2 boards, £15 each, collection from Bristol.',
	'Can a mod delete my earlier post? I accidentally pasted my API key into it.',
	'Anyone else seeing 3x the expected current draw on the 3v3 rail?'
];

// One request per post answers all six conditions.
const hazards = new Detector({
	logLevel: 'warn',
	concurrency: 6,
	conditions: {
		harassment: 'Is the post abusive, insulting or demeaning toward a person or group?',
		spam: 'Is the post unsolicited promotion, or does it push an external link for gain?',
		unsafe_advice: { instructions: 'Does the post give medical or safety advice that could cause harm if followed?', yes: 0.4 },
		personal_data: 'Does the post expose a phone number, address or other contact detail?',
		credentials: 'Does the post mention an exposed API key, password or token?',
		off_topic: 'Is the post unrelated to electronics or this product?'
	}
});

// And one request per post classifies it.
const topic = new Classifier({
	logLevel: 'warn',
	concurrency: 6,
	instructions: 'What is this forum post mainly doing?',
	labels: {
		asking_for_help: 'Describing a problem and asking for a fix',
		giving_help: 'Answering, explaining, or sharing a solution',
		marketplace: 'Buying or selling something',
		complaint: 'Expressing dissatisfaction with the product or company',
		moderation_request: 'Asking a moderator to do something'
	},
	minConfidence: 0.45,
	fallback: 'unclear'
});

console.time('batch');
const [flags, topics] = await Promise.all([
	hazards.checkMany(POSTS),
	topic.classifyMany(POSTS)
]);
console.timeEnd('batch');

// Policy lives here, in one place, as plain data.
const ACTIONS = {
	credentials: 'redact + notify',
	harassment: 'hide + warn',
	spam: 'remove',
	personal_data: 'redact',
	unsafe_advice: 'add safety note',
	off_topic: 'move'
};

console.log('');
POSTS.forEach((post, i) => {
	const f = flags[i];
	const t = topics[i];
	if (f.failed || t.failed) {
		console.log(`! failed: ${(f.error ?? t.error).message}`);
		return;
	}

	const actions = f.triggered.map((id) => `${ACTIONS[id]} (${id} ${f.probabilities[id].toFixed(2)})`);
	const verdict = actions.length ? actions.join(', ') : 'allow';

	console.log(`${(t.label ?? 'unclear').padEnd(19)} ${verdict}`);
	console.log(`   "${post.slice(0, 68)}${post.length > 68 ? '…' : ''}"`);
	if (f.unsure.length) console.log(`   unsure about: ${f.unsure.join(', ')} → human review`);
});

const stats = { hazards: hazards.stats(), topic: topic.stats() };
const cost = stats.hazards.usage.estimatedCost + stats.topic.usage.estimatedCost;
console.log(`\n${POSTS.length} posts · ${stats.hazards.requests + stats.topic.requests} requests · ` +
	`${stats.hazards.usage.questions + stats.topic.usage.questions} questions · $${cost.toFixed(6)}`);
console.log(`governor: peak queue ${Math.max(stats.hazards.governor.peakQueued, stats.topic.governor.peakQueued)}, ` +
	`throttled ${stats.hazards.governor.throttledMs + stats.topic.governor.throttledMs}ms`);
