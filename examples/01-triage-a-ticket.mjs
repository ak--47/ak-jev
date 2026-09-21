/**
 * 01 — Triage a support ticket in one request.
 *
 * The Speculative Fan-Out pattern. Ask everything your code might need, including
 * the questions that only matter for some tickets, and let the code decide
 * afterwards which answers it uses. Questions are answered in parallel, so 8
 * questions cost about what 1 costs in wall time and a few tokens more.
 *
 *   node examples/01-triage-a-ticket.mjs
 */

import { Evaluator, noul, choice, score } from '../index.js';

const triage = new Evaluator({
	logLevel: 'warn',
	questions: {
		category: choice('What kind of ticket is this?', {
			bug_report: 'Something in the product is broken or behaving wrongly',
			billing: 'Charges, invoices, refunds, subscriptions',
			feature_request: 'Asking for something the product does not do yet',
			how_to: 'Asking how to use an existing feature'
		}),

		// Speculative: only read when category is bug_report.
		severity: score('How severe is the reported issue?', {
			cosmetic: 'Cosmetic; no impact to functionality',
			degraded: 'Broken or degraded feature, but a workaround exists',
			blocking: 'Blocking issue; no workaround exists'
		}),
		has_repro: noul('Does the report include steps to reproduce the problem?'),

		// Speculative: only read when category is billing.
		refund_requested: noul('Is the customer asking for money back?'),

		// Useful whatever the category.
		frustration: score('How frustrated is the customer?', {
			calm: 'Calm, just stating facts',
			frustrated: 'Frustrated but civil',
			furious: 'Very angry, using strong language, or threatening to leave'
		}),
		wants_human: noul('Is the customer asking to speak to a person?'),
		repeat_contact: noul('Has the customer contacted support about this before?', {
			true: 'Mentions a prior ticket, a previous attempt, or that they have asked before',
			false: 'No sign of any previous contact'
		})
	}
});

const TICKETS = [
	"The PDF export button does nothing when I click it in Safari 18.2. Works fine in Chrome. Steps: open Settings, click Export, nothing happens. A few of our customers only use Safari so this is a real problem for us.",
	"I've been charged twice for the March invoice — £240 instead of £120. This is the third time I've written in about this and nobody has replied. Can I please just talk to a real person? I want the duplicate refunded today.",
	"Is there a way to change the default timezone for scheduled reports? I looked in Settings but couldn't find it.",
	"It would be great if you could add a dark mode. Not urgent, just nice to have."
];

for (const ticket of TICKETS) {
	const { answers, usage, latencyMs } = await triage.run(ticket);

	// One request, and now it is all ordinary if statements.
	const lines = [];
	lines.push(`category      ${answers.category.choice}  (confidence ${answers.category.confidence.toFixed(2)})`);

	if (answers.category.confidence < 0.4) {
		lines.push('              → too close to call, sending to manual triage');
	} else if (answers.category.choice === 'bug_report') {
		lines.push(`severity      ${answers.severity.label}  (${answers.severity.normalized.toFixed(2)} normalized)`);
		lines.push(`repro steps   ${answers.has_repro.verdict}`);
		if (answers.severity.normalized > 0.6 && answers.has_repro.yes) {
			lines.push('              → escalating to engineering');
		} else {
			lines.push('              → bug backlog');
		}
	} else if (answers.category.choice === 'billing') {
		lines.push(`refund asked  ${answers.refund_requested.verdict}`);
		if (answers.refund_requested.yes) lines.push('              → flagging for refund approval');
	}

	lines.push(`frustration   ${answers.frustration.label}  (${answers.frustration.normalized.toFixed(2)})`);
	if (answers.wants_human.yes) lines.push('              → routing to an agent, not the bot');
	if (answers.repeat_contact.yes) lines.push('              → raising priority: repeat contact');

	// A second category with a real share of the probability gets a copy.
	for (const { label, probability } of answers.category.ranked.slice(1)) {
		if (probability > 0.25) lines.push(`              → cc ${label} (${probability.toFixed(2)})`);
	}

	console.log(`\n"${ticket.slice(0, 70)}…"`);
	console.log(lines.map((l) => '  ' + l).join('\n'));
	console.log(`  ${latencyMs}ms  ${usage.inputTokens} tokens  $${usage.estimatedCost.toFixed(8)}`);
}

const total = triage.getTotalUsage();
console.log(`\n${TICKETS.length} tickets, ${total.requests} requests, ${total.questions} questions answered, $${total.estimatedCost.toFixed(6)} total`);
