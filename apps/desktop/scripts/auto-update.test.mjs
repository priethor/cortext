import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire( import.meta.url );
const Module = require( 'node:module' );

function withMocks( mocks, run ) {
	const originalLoad = Module._load;
	Module._load = function ( request, parent, isMain ) {
		if ( Object.hasOwn( mocks, request ) ) {
			return mocks[ request ];
		}
		return originalLoad.call( this, request, parent, isMain );
	};

	try {
		return run();
	} finally {
		Module._load = originalLoad;
	}
}

function requireWithMocks( modulePath, mocks ) {
	const resolved = require.resolve( modulePath );
	delete require.cache[ resolved ];
	return withMocks( mocks, () => require( resolved ) );
}

test( 'E2E mode skips both update checkers', () => {
	const previousE2E = process.env.CORTEXT_E2E;
	let legacyChecks = 0;
	process.env.CORTEXT_E2E = '1';

	try {
		const { scheduleUpdateCheck } = requireWithMocks(
			'../lib/auto-update',
			{
				electron: {
					app: { isPackaged: true },
					dialog: {},
				},
				'./update-check': {
					scheduleUpdateCheck: () => {
						legacyChecks += 1;
					},
				},
			}
		);

		scheduleUpdateCheck();
		assert.equal( legacyChecks, 0 );
	} finally {
		if ( previousE2E === undefined ) {
			delete process.env.CORTEXT_E2E;
		} else {
			process.env.CORTEXT_E2E = previousE2E;
		}
	}
} );

function loadUpdater( version ) {
	const calls = { legacy: 0, checks: 0, dialogs: [] };
	const mocks = {
		electron: {
			app: { isPackaged: true, getVersion: () => version },
			dialog: {
				showMessageBox: ( options ) => {
					calls.dialogs.push( options );
					return Promise.resolve( { response: 0 } );
				},
			},
		},
		'./update-check': {
			scheduleUpdateCheck: () => {
				calls.legacy += 1;
			},
		},
		'electron-updater': {
			autoUpdater: {
				on: () => {},
				checkForUpdates: () => {
					calls.checks += 1;
					return Promise.resolve();
				},
			},
		},
	};
	const updater = requireWithMocks( '../lib/auto-update', mocks );

	// electron-updater is required lazily, once a release build asks for it, so
	// the mocks have to stay installed past the initial require.
	return {
		calls,
		scheduleUpdateCheck: () =>
			withMocks( mocks, updater.scheduleUpdateCheck ),
		checkForUpdatesInteractive: () =>
			withMocks( mocks, updater.checkForUpdatesInteractive ),
	};
}

// A branch build's version is <version>-<sha>. electron-updater would read that
// suffix as a release channel and fail every check, so it never starts.
test( 'a branch build leaves updates to the notify-only checker', () => {
	const { scheduleUpdateCheck, calls } = loadUpdater( '0.2.0-b6d0105' );

	scheduleUpdateCheck();

	assert.equal( calls.legacy, 1 );
	assert.equal( calls.checks, 0 );
} );

test( 'a release build starts electron-updater', () => {
	const { scheduleUpdateCheck, calls } = loadUpdater( '0.2.0' );

	scheduleUpdateCheck();

	assert.equal( calls.legacy, 0 );
	assert.equal( calls.checks, 1 );
} );

test( 'a branch build says so instead of offering to check', () => {
	const { checkForUpdatesInteractive, calls } =
		loadUpdater( '0.2.0-b6d0105' );

	checkForUpdatesInteractive();

	assert.equal( calls.dialogs.length, 1 );
	assert.match( calls.dialogs[ 0 ].message, /does not receive updates/ );
	assert.match( calls.dialogs[ 0 ].detail, /0\.2\.0-b6d0105/ );
} );
