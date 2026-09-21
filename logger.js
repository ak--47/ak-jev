import pino from 'pino';

// Prettified locally, JSON in production so cloud logging can parse it.
const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
	level: process.env.LOG_LEVEL || 'info', // fatal | error | warn | info | debug | trace | silent
	messageKey: 'message', // GCP expects 'message' rather than pino's default 'msg'
	transport: isDev
		? { target: 'pino-pretty', options: { colorize: true, translateTime: true } }
		: undefined
});

export default logger;
