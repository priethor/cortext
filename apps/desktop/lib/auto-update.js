const { app, dialog } = require( 'electron' );
const {
	scheduleUpdateCheck: scheduleLegacyNotify,
} = require( './update-check' );

// electron-updater handles Squirrel.Mac updates, but only in a packaged, signed
// app. It reads app-update.yml from Resources, a file electron-builder writes
// during packaging. Dev runs do not have it, so load the updater only after the
// packaged-app guard.

// Keep checking after launch so an app left open all day can still notice a new
// published Release.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let state = 'idle'; // idle | checking | available | downloading | downloaded | error | restart
let showManualDialogs = false;
let recheckTimer = null;
let mainWindow = null;
let onStateChange = null;
let prepareQuit = null;

function setState( next ) {
	if ( state === next ) {
		return;
	}
	state = next;
	onStateChange?.( state );
}

function getUpdaterState() {
	return state;
}

function isUpdateReadyToInstall() {
	return state === 'downloaded';
}

function showMessage( options ) {
	return mainWindow
		? dialog.showMessageBox( mainWindow, options )
		: dialog.showMessageBox( options );
}

function isTransientNetworkError( err ) {
	const message = String( err?.message || err || '' );
	return /net::|ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT|ECONNRESET|ECONNREFUSED|timed out|offline/i.test(
		message
	);
}

// electron-updater reads the running version's prerelease suffix as a release
// channel, and branch builds are versioned <version>-<sha>. That names a channel
// no Release carries, so every check ends in "No published versions on GitHub",
// which reads as a broken Release rather than as a build that was never on the
// update channel. Leave those builds to the notify-only checker.
function isReleaseBuild() {
	return /^\d+\.\d+\.\d+$/.test( app.getVersion() );
}

// Downloads from a mounted DMG or ~/Downloads cannot replace the running app.
// Ask the user to move Cortext before starting the update flow.
function notInApplicationsFolder() {
	return (
		process.platform === 'darwin' &&
		typeof app.isInApplicationsFolder === 'function' &&
		! app.isInApplicationsFolder()
	);
}

async function promptMoveToApplications() {
	const { response } = await showMessage( {
		type: 'info',
		message: 'Move Cortext to Applications to use updates',
		detail: 'Cortext needs to run from Applications for automatic updates. Move it now?',
		buttons: [ 'Move to Applications', 'Not Now' ],
		defaultId: 0,
		cancelId: 1,
	} );
	if ( response === 0 ) {
		try {
			app.moveToApplicationsFolder();
		} catch ( err ) {
			console.log(
				'[cortext-desktop] move to Applications failed:',
				err.message
			);
		}
	}
}

function reportError( err ) {
	console.log( '[cortext-desktop] update error:', err?.message || err );
	if ( isTransientNetworkError( err ) ) {
		setState( 'idle' );
		scheduleRecheck();
		return;
	}
	setState( 'error' );
	if ( showManualDialogs ) {
		showManualDialogs = false;
		showMessage( {
			type: 'error',
			message: 'Could not check for updates',
			detail: String( err?.message || err ),
			buttons: [ 'OK' ],
		} );
	}
}

function scheduleRecheck() {
	if ( recheckTimer ) {
		return;
	}
	recheckTimer = setTimeout( () => {
		recheckTimer = null;
		runCheck( { manual: false } );
	}, RECHECK_INTERVAL_MS );
	recheckTimer.unref?.();
}

function wireEvents() {
	autoUpdater.on( 'checking-for-update', () => setState( 'checking' ) );

	autoUpdater.on( 'update-available', async () => {
		setState( 'available' );
		if ( autoUpdater.autoDownload ) {
			setState( 'downloading' );
			return;
		}
		// Manual mode: ask before downloading when automatic installs are off.
		showManualDialogs = false;
		const { response } = await showMessage( {
			type: 'info',
			message: 'A new version of Cortext is available',
			detail: 'Download it now? You can install it later.',
			buttons: [ 'Download', 'Later' ],
			defaultId: 0,
			cancelId: 1,
		} );
		if ( response === 0 ) {
			setState( 'downloading' );
			autoUpdater.downloadUpdate().catch( reportError );
		} else {
			setState( 'idle' );
		}
	} );

	autoUpdater.on( 'update-not-available', () => {
		setState( 'idle' );
		if ( showManualDialogs ) {
			showManualDialogs = false;
			showMessage( {
				type: 'info',
				message: 'Cortext is up to date',
				detail: `You are on version ${ app.getVersion() }.`,
				buttons: [ 'OK' ],
			} );
		}
		scheduleRecheck();
	} );

	autoUpdater.on( 'download-progress', () => setState( 'downloading' ) );

	autoUpdater.on( 'update-downloaded', async () => {
		setState( 'downloaded' );
		const { response } = await showMessage( {
			type: 'info',
			message: 'Update ready to install',
			detail: 'Restart Cortext now to install the update, or install it later.',
			buttons: [ 'Restart Now', 'Later' ],
			defaultId: 0,
			cancelId: 1,
		} );
		if ( response === 0 ) {
			quitAndInstall();
		}
	} );

	autoUpdater.on( 'error', reportError );
}

function initAutoUpdates( {
	autoDownload = true,
	window = null,
	onState = null,
	prepareQuit: prepare = null,
} = {} ) {
	if ( autoUpdater ) {
		mainWindow = window ?? mainWindow;
		return true;
	}
	if ( ! app.isPackaged || ! isReleaseBuild() ) {
		return false;
	}
	try {
		( { autoUpdater } = require( 'electron-updater' ) );
	} catch ( err ) {
		console.log(
			'[cortext-desktop] electron-updater unavailable:',
			err.message
		);
		return false;
	}
	mainWindow = window;
	onStateChange = onState;
	prepareQuit = prepare;
	autoUpdater.autoDownload = autoDownload;
	// Keep install-on-quit tied to the same preference. With the setting off,
	// a manually downloaded update should not install during the next quit.
	autoUpdater.autoInstallOnAppQuit = autoDownload;
	autoUpdater.allowPrerelease = true;
	autoUpdater.logger = null;
	wireEvents();
	return true;
}

function runCheck( { manual } ) {
	if ( ! autoUpdater ) {
		return;
	}
	if ( notInApplicationsFolder() ) {
		// Silent checks from a read-only or quarantined path only fail, so skip
		// them. Manual checks can ask the user to move the app.
		if ( manual ) {
			promptMoveToApplications();
		}
		return;
	}
	// Set this for every check. A later silent retry should not inherit a
	// previous manual dialog.
	showManualDialogs = manual;
	autoUpdater.checkForUpdates().catch( reportError );
}

// Run a silent launch check and schedule later checks. If electron-updater
// cannot load in a packaged build, use the old notify-only checker so users
// still hear about updates.
function scheduleUpdateCheck( options = {} ) {
	// Keep packaged smoke tests offline and suppress update dialogs.
	if ( process.env.CORTEXT_E2E === '1' ) {
		return;
	}
	const ready = initAutoUpdates( options );
	if ( ! ready ) {
		if ( app.isPackaged ) {
			scheduleLegacyNotify();
		}
		return;
	}
	runCheck( { manual: false } );
}

function checkForUpdatesInteractive() {
	if ( ! autoUpdater ) {
		const branchBuild = ! isReleaseBuild();
		showMessage( {
			type: 'info',
			message: branchBuild
				? 'This build does not receive updates'
				: 'Use the installed app for updates',
			detail: branchBuild
				? `Cortext ${ app.getVersion() } was built from a branch. Install a release to get updates.`
				: 'Run the installed Cortext app to check for updates.',
			buttons: [ 'OK' ],
		} );
		return;
	}
	if ( state === 'downloaded' ) {
		quitAndInstall();
		return;
	}
	runCheck( { manual: true } );
}

function quitAndInstall() {
	if ( ! autoUpdater ) {
		return;
	}
	setState( 'restart' );
	// Let main.js enter its normal quit path, which stops PHP before the
	// updater restarts the app.
	prepareQuit?.();
	autoUpdater.quitAndInstall();
}

function setAutoDownload( enabled ) {
	if ( autoUpdater ) {
		autoUpdater.autoDownload = enabled;
		autoUpdater.autoInstallOnAppQuit = enabled;
	}
}

module.exports = {
	scheduleUpdateCheck,
	checkForUpdatesInteractive,
	getUpdaterState,
	isUpdateReadyToInstall,
	quitAndInstall,
	setAutoDownload,
};
