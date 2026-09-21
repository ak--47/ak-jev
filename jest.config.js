export default {
	testEnvironment: 'node',
	transform: {},
	moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1.js' },
	coverageDirectory: './coverage',
	testTimeout: 30000,
	setupFiles: ['<rootDir>/tests/jest.setup.js'],
	verbose: true
};
