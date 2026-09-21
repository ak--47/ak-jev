/**
 * 06 — Structured extraction from messy text, without generation.
 *
 * Jev cannot write text. So extraction becomes a Choice over the possible values:
 * the model PICKS, and the code copies the winning label verbatim. The output is
 * therefore always exactly one of the options you supplied — there is no parsing
 * step and no schema to validate, because a wrong value is not representable.
 *
 * `allowMissing` is the part people skip. Without an explicit "not stated" option
 * a Choice MUST pick something, and it will invent a reading rather than report an
 * absence.
 *
 *   node examples/06-extract-a-record.mjs
 */

import { Extractor } from '../index.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'];

const extractor = new Extractor({
	logLevel: 'warn',
	allowMissing: true,
	fields: {
		currency: {
			instructions: 'Which currency is the invoice total denominated in?',
			options: ['USD', 'EUR', 'GBP', 'JPY', 'CHF']
		},
		status: {
			instructions: 'What is the payment status of this invoice?',
			options: {
				paid: 'Settled in full',
				partial: 'Some of the amount has been paid',
				due: 'Not yet paid, and not yet past its due date',
				overdue: 'Not yet paid, and past its due date'
			}
		},
		month: {
			instructions: 'Which calendar month is the invoice dated?',
			options: MONTHS,
			// Arithmetic and normalization happen HERE, in code, never in a question.
			// Jev reads dates as text; it does not order them.
			transform: (v) => MONTHS.indexOf(v) + 1
		},
		terms: {
			instructions: 'What are the stated payment terms?',
			options: { net_15: 'Due within 15 days', net_30: 'Due within 30 days', net_60: 'Due within 60 days', on_receipt: 'Due immediately' },
			// Terms drive when we chase; a wrong guess is expensive.
			minConfidence: 0.7
		},
		department: {
			instructions: 'Which internal department should own this invoice?',
			options: { engineering: 'Tooling, infrastructure, cloud', marketing: 'Advertising, events, agencies', facilities: 'Office, utilities, cleaning', legal: 'Counsel, filings, compliance' }
		}
	}
});

const INVOICES = [
	`ACME CLOUD SERVICES — INVOICE 88120
Issued 14 March 2026. Total due: 4,820.00 EUR.
Terms: payment within 30 days of issue date.
Line items: Kubernetes cluster hosting, object storage, egress.
Status: awaiting payment. Due 13 April 2026.`,

	`Northwind Facilities Ltd
Invoice #4471 · 2 June 2026 · £1,240.00
For: quarterly office cleaning and window washing, Q2.
PAID IN FULL — thank you.`,

	`Scribbled note from the desk drawer:
"legal thing, the filing people, about 9 grand, need to sort this out"`
];

for (const doc of INVOICES) {
	const r = await extractor.extract(doc);
	console.log(`\n${doc.split('\n')[0].slice(0, 60)}`);
	console.log('  record    ', JSON.stringify(r.record));
	console.log(`  complete   ${r.complete}`);
	if (r.missing.length) console.log(`  missing    ${r.missing.join(', ')}  (the document does not say)`);
	if (r.uncertain.length) {
		for (const f of r.uncertain) {
			const fld = r.fields[f];
			console.log(`  uncertain  ${f}: model leaned "${fld.choice}" at ${fld.confidence.toFixed(2)}, needed ${fld.required} → null`);
		}
	}
}

console.log(`\n${extractor.getTotalUsage().requests} requests, $${extractor.getTotalUsage().estimatedCost.toFixed(6)}`);
