// The unit suite must never reach the network. A fake key and an unresolvable
// host are set here, before dotenv loads, so a test that forgets to inject its
// own `fetch` fails loudly instead of quietly calling the real API and spending
// money.
//
// The live suite needs the opposite, so it opts out via JEV_LIVE=1 and reads the
// real credentials from .env.
if (process.env.JEV_LIVE === '1') {
	const { config } = await import('dotenv');
	config();
	process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
} else {
	process.env.TYPESAFE_API_KEY = 'apikey_test_0000000000000000000000000000000000000000';
	process.env.TYPESAFE_BASE_URL = 'https://api.typesafe.invalid';
	process.env.LOG_LEVEL = 'silent';
}

process.env.NODE_ENV = 'test';
