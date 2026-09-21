/**
 * 07 — Classify into a deep tree, with beam search.
 *
 * A Choice allows 255 options. A real catalogue has thousands. So walk the tree:
 * one Choice per level, whose options are the children of the current node and
 * whose descriptions are the subtrees beneath them. Showing the subtree lets the
 * model see what lives under a branch before committing to it — which matters when
 * the right leaf sits under a branch whose name gives no hint.
 *
 * Beam search keeps several paths alive at once. A bike bottle plausibly belongs
 * under both Sporting Goods and Home & Kitchen; a beam of 2 explores both and lets
 * the leaf probabilities settle it.
 *
 *   node examples/07-walk-a-taxonomy.mjs
 */

import { Taxonomy } from '../index.js';

const CATALOGUE = {
	'Sporting Goods': {
		Cycling: { 'Bike Bottles & Cages': null, Helmets: null, 'Tyres & Tubes': null, 'Lights & Reflectors': null },
		Running: { 'Running Shoes': null, 'GPS Watches': null, 'Hydration Vests': null },
		'Water Sports': { Wetsuits: null, 'Dry Bags': null, Goggles: null }
	},
	'Home & Kitchen': {
		Drinkware: { 'Water Bottles': null, Mugs: null, Tumblers: null, 'Wine Glasses': null },
		Cookware: { 'Frying Pans': null, Saucepans: null, 'Baking Trays': null },
		Storage: { 'Food Containers': null, 'Vacuum Flasks': null }
	},
	Electronics: {
		Audio: { Headphones: null, 'Portable Speakers': null },
		Wearables: { Smartwatches: null, 'Fitness Trackers': null },
		Accessories: { 'Charging Cables': null, 'Power Banks': null }
	},
	'Health & Personal Care': {
		Nutrition: { 'Protein Powder': null, 'Electrolyte Tablets': null },
		'First Aid': { 'Blister Plasters': null, 'Cold Packs': null }
	}
};

const taxonomy = new Taxonomy({
	logLevel: 'warn',
	tree: CATALOGUE,
	instructions: 'Which category does this product listing belong to?'
});

const LISTINGS = [
	'Insulated 750ml cycling bottle. Fits standard bike cages. Keeps water cold for 12 hours on long rides.',
	'Stainless steel 500ml bottle with a screw cap. Great for the gym, the office, or a bike cage.',
	'Vacuum flask, 1L, keeps soup hot for 8 hours. Wide mouth, dishwasher safe.',
	'Wireless earbuds with active noise cancellation and a 30-hour charging case.',
	'Effervescent electrolyte tabs, 20 per tube. Drop one in water after a long run.'
];

for (const listing of LISTINGS) {
	const r = await taxonomy.classify(listing, { beam: 2 });

	console.log(`\n"${listing.slice(0, 66)}…"`);
	console.log(`  → ${r.path.join('  >  ')}`);
	console.log(`    score ${r.score.toFixed(3)} after ${r.requests} requests`);

	// Where the walk was close, show the road not taken.
	for (const step of r.steps) {
		const [top, second] = step.ranked;
		if (second && second.probability > 0.15) {
			console.log(`    level ${step.depth}: ${top.label} ${top.probability.toFixed(2)} vs ${second.label} ${second.probability.toFixed(2)} — close`);
		}
	}
	if (r.candidates.length > 1) {
		const alt = r.candidates[1];
		console.log(`    runner-up path: ${alt.path.join(' > ')} (${alt.score.toFixed(3)})`);
	}
}

console.log(`\n${taxonomy.getTotalUsage().requests} requests total, $${taxonomy.getTotalUsage().estimatedCost.toFixed(6)}`);
