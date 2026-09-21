/**
 * 02 — Confidence-gated routing.
 *
 * The answer tells you what. Confidence tells you whether to act on it. Different
 * actions in the same system deserve different bars, because the cost of being
 * wrong is different: showing the wrong screen is recoverable, approving the wrong
 * transfer is not.
 *
 *   node examples/02-route-to-a-handler.mjs
 */

import { Router, score } from '../index.js';

// Every threshold the routing reads lives here and nowhere else, so changing
// policy is a one-line diff under code review rather than a reworded prompt.
const POLICY = {
	check_balance: 0.6,
	list_transactions: 0.6,
	approve_transfer: 0.9,
	close_account: 0.95
};

const router = new Router({
	logLevel: 'warn',
	instructions: 'What is the user asking the banking assistant to do?',
	routes: {
		check_balance: {
			description: 'Read out the current account balance',
			minConfidence: POLICY.check_balance,
			handler: async ({ extra }) => `showed balance for ${extra.accountId}`
		},
		list_transactions: {
			description: 'List recent transactions on the account',
			minConfidence: POLICY.list_transactions,
			handler: async ({ extra }) => `listed transactions for ${extra.accountId}`
		},
		approve_transfer: {
			description: 'Approve a pending outbound transfer of money',
			minConfidence: POLICY.approve_transfer,
			handler: async ({ extra }) => `APPROVED TRANSFER on ${extra.accountId}`
		},
		close_account: {
			description: 'Permanently close the account',
			minConfidence: POLICY.close_account,
			handler: async ({ extra }) => `CLOSED ${extra.accountId}`
		}
	},

	// Anything that does not clear its own bar lands here.
	fallback: async ({ classification }) =>
		`sent to a human (model said "${classification.choice}" at ${classification.confidence.toFixed(2)}, ` +
		`needed ${classification.required ?? '—'})`,

	// Rides along in the same request. Every handler can read it.
	questions: {
		complexity: score('How complex is this request?', {
			simple: 'One step, no judgment needed',
			involved: 'Several steps, or some judgment',
			specialist: 'Needs a specialist or a manager'
		})
	}
});

const COMMANDS = [
	"What's my balance?",
	'Show me what I spent last week',
	'Go ahead and approve that transfer to my landlord',
	"I think I want to close this, but maybe transfer the money out first? Not sure.",
	'Shut it all down. Close the account.'
];

for (const command of COMMANDS) {
	const out = await router.route(command, { accountId: 'ACCT-8812' });
	console.log(`\n"${command}"`);
	console.log(`  picked      ${out.choice} @ ${out.confidence.toFixed(2)}  (bar ${out.required ?? '—'})`);
	console.log(`  complexity  ${out.answers.complexity.label}`);
	console.log(`  → ${out.value}`);
}
