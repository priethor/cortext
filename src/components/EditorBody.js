/**
 * Shared editor body for Cortext documents (pages, collections, and rows). Runs inside
 * an existing `EditorProvider` and renders the block-editor-owned document
 * body: cover -> icon -> locked title -> block content. Owns the trash banner,
 * the identity controls above the title, and the layout effect that keeps the
 * locked header blocks present in `post_content`.
 *
 * Mounted by `Canvas`'s `VisualCanvas` for full-page documents and by
 * `RowDetailView` for side peek and modal panes.
 */

import createEmotionCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import apiFetch from '@wordpress/api-fetch';
import {
	BlockCanvas,
	BlockList,
	Inserter,
	store as blockEditorStore,
	useSettings,
} from '@wordpress/block-editor';
import { createBlock } from '@wordpress/blocks';
import { Button, Disabled, Notice } from '@wordpress/components';
import { useEntityProp, useEntityRecord } from '@wordpress/core-data';
import { useDispatch, useSelect } from '@wordpress/data';
import { store as editorStore } from '@wordpress/editor';
import { __ } from '@wordpress/i18n';
import { ENTER, SPACE, isKeyboardEvent } from '@wordpress/keycodes';
import {
	useEffect,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';

import DocumentIdentityControls from './DocumentIdentityControls';
import { CanvasReadyProvider } from './CanvasReadyContext';
import { useDocumentPropertiesContext } from './DocumentPropertiesContext';
import {
	findCanvasOwnerBlock,
	getCanvasOwnerBlockNameForRecord,
	getCanvasOwnerInitialAttributesForRecord,
} from './CanvasOwnerInspector';
import MediaPicker, { MediaUploadCheck } from './MediaPicker';
import { parseDocumentIcon } from './DocumentIcon';
import { isSurfaceFocusOriginCurrent } from './collectionSurfaceFocus';
import afterNextPaint from '../hooks/afterNextPaint';
import { whenViewTransitionsSettled } from '../hooks/viewTransition';

const DOCUMENT_ICON_BLOCK = 'cortext/document-icon';
const DOCUMENT_COVER_BLOCK = 'cortext/document-cover';
const DOCUMENT_PROPERTIES_BLOCK = 'cortext/document-properties';
const POST_TITLE_BLOCK = 'core/post-title';
const ROOT_BLOCK_LIST = '';
const DISABLE_HEADER_BOUNDARY_MOVE_UP_CLASS =
	'cortext-disable-header-boundary-move-up';
const DISABLED_BY_HEADER_BOUNDARY_ATTR =
	'data-cortext-header-boundary-disabled';
const HEADER_BOUNDARY_MOVE_UP_SELECTOR =
	'.block-editor-block-mover-button.is-up-button';
const HEADER_BOUNDARY_MOVE_UP_SCOPE_SELECTOR = [
	'.block-editor-block-list__block-popover',
	'.block-editor-block-contextual-toolbar',
	'.block-editor-block-toolbar',
].join( ',' );
const OPEN_CANVAS_MENU_SELECTOR = '[data-dialog][role="menu"][data-open]';
const CANVAS_TOOLBAR_SELECTOR = '.block-editor-block-contextual-toolbar';
const CANVAS_MENU_TOOLBAR_OVERLAP_CLASS =
	'cortext-canvas__block-canvas--menu-toolbar-overlap';
const activeHeaderBoundaryMoveUpGuards = new Set();
const DEFAULT_HEADER_BLOCK_NAMES = new Set( [
	DOCUMENT_COVER_BLOCK,
	DOCUMENT_ICON_BLOCK,
	POST_TITLE_BLOCK,
	DOCUMENT_PROPERTIES_BLOCK,
] );
const PROTECTED_HEADER_LOCK = { move: true, remove: true };
const COLLECTION_LEGACY_BLOCK_LOCK = { move: true, remove: true, edit: true };
const CANVAS_READY_IMAGE_TIMEOUT = 8000;
const CANVAS_DOCUMENT_EDITOR_CSS = `
	.editor-styles-wrapper {
		box-sizing: border-box;
		display: flow-root;
		margin: 0;
		min-height: 100vh;
	}

	.editor-styles-wrapper .cortext-canvas__editor:not(.cortext-canvas__editor--owner) {
		padding-bottom: 72px;
	}
`;
const CANVAS_DOCUMENT_EXTRA_STYLES = [ { css: CANVAS_DOCUMENT_EDITOR_CSS } ];
const blockCanvasEmotionCaches = new WeakMap();

export function useEditorBodyStyles(
	baseStyles,
	extraStyles,
	isDocumentCanvas = false
) {
	return useMemo(
		() => [
			...( baseStyles ?? [] ),
			...( isDocumentCanvas ? CANVAS_DOCUMENT_EXTRA_STYLES : [] ),
			...( extraStyles ?? [] ),
		],
		[ baseStyles, extraStyles, isDocumentCanvas ]
	);
}

function getBlockCanvasEmotionCache( canvasDocument ) {
	const { head } = canvasDocument;
	let emotionCache = blockCanvasEmotionCaches.get( head );

	if ( ! emotionCache ) {
		emotionCache = createEmotionCache( {
			container: head,
			key: 'cortext-canvas',
		} );
		blockCanvasEmotionCaches.set( head, emotionCache );
	}

	return emotionCache;
}

// tech-debt.md#td-block-canvas-style-runtime-bridge: DataViews bundles its own
// Emotion instance. Point its cache at the BlockCanvas iframe before mounting
// the canvas children. Core's StyleProvider already registers the document.
function BlockCanvasStyleProvider( { children } ) {
	const anchorRef = useRef( null );
	const [ emotionCache, setEmotionCache ] = useState( null );

	useLayoutEffect( () => {
		const canvasDocument = anchorRef.current?.ownerDocument;
		if ( ! canvasDocument?.head ) {
			return undefined;
		}

		const cache = getBlockCanvasEmotionCache( canvasDocument );
		setEmotionCache( cache );
		return undefined;
	}, [] );

	return (
		<>
			<span ref={ anchorRef } hidden />
			{ emotionCache && (
				<CacheProvider value={ emotionCache }>
					{ children }
				</CacheProvider>
			) }
		</>
	);
}

export function rectsOverlap( firstRect, secondRect ) {
	return (
		firstRect.left < secondRect.right &&
		firstRect.right > secondRect.left &&
		firstRect.top < secondRect.bottom &&
		firstRect.bottom > secondRect.top
	);
}

export function projectIframeRectToParent( rect, frameElement, iframeWindow ) {
	const frameRect = frameElement.getBoundingClientRect();
	const layoutWidth = frameElement.offsetWidth || frameRect.width;
	const layoutHeight = frameElement.offsetHeight || frameRect.height;
	if ( ! layoutWidth || ! layoutHeight ) {
		return null;
	}

	const frameScaleX = frameRect.width / layoutWidth;
	const frameScaleY = frameRect.height / layoutHeight;
	const contentLeft = frameRect.left + frameElement.clientLeft * frameScaleX;
	const contentTop = frameRect.top + frameElement.clientTop * frameScaleY;
	const contentWidth = frameElement.clientWidth * frameScaleX;
	const contentHeight = frameElement.clientHeight * frameScaleY;
	const viewportWidth = iframeWindow.innerWidth || frameElement.clientWidth;
	const viewportHeight =
		iframeWindow.innerHeight || frameElement.clientHeight;
	if (
		! contentWidth ||
		! contentHeight ||
		! viewportWidth ||
		! viewportHeight
	) {
		return null;
	}

	const scaleX = contentWidth / viewportWidth;
	const scaleY = contentHeight / viewportHeight;
	const left = Math.max( contentLeft, contentLeft + rect.left * scaleX );
	const top = Math.max( contentTop, contentTop + rect.top * scaleY );
	const right = Math.min(
		contentLeft + contentWidth,
		contentLeft + rect.right * scaleX
	);
	const bottom = Math.min(
		contentTop + contentHeight,
		contentTop + rect.bottom * scaleY
	);

	return { left, top, right, bottom };
}

// tech-debt.md#td-wp-menu-popover-limitations: an iframe menu's z-index cannot
// place it above a toolbar in the parent document. Hide the toolbar only when
// the two overlap.
function CanvasMenuToolbarGuard() {
	const anchorRef = useRef( null );

	useEffect( () => {
		const iframeDocument = anchorRef.current?.ownerDocument;
		const iframeWindow = iframeDocument?.defaultView;
		const frameElement = iframeWindow?.frameElement;
		const canvasRoot = frameElement?.closest(
			'.cortext-canvas__block-canvas'
		);
		const MutationObserverClass = iframeWindow?.MutationObserver;
		const parentWindow = frameElement?.ownerDocument.defaultView;
		const ParentMutationObserverClass = parentWindow?.MutationObserver;

		if (
			! iframeDocument?.body ||
			! canvasRoot ||
			! MutationObserverClass ||
			! ParentMutationObserverClass
		) {
			return undefined;
		}

		let overlapFrame = null;
		const updateToolbarOverlap = () => {
			const openMenus = Array.from(
				iframeDocument.querySelectorAll( OPEN_CANVAS_MENU_SELECTOR )
			);
			if ( openMenus.length === 0 ) {
				canvasRoot.classList.remove(
					CANVAS_MENU_TOOLBAR_OVERLAP_CLASS
				);
				return false;
			}
			// The overlap class hides the toolbar through inherited visibility,
			// but its box stays measurable. Keep it in the calculation to prevent
			// a hide-and-show loop.
			const toolbarRects = Array.from(
				canvasRoot.querySelectorAll( CANVAS_TOOLBAR_SELECTOR )
			)
				.map( ( toolbar ) => toolbar.getBoundingClientRect() )
				.filter(
					( rect ) => rect.right > rect.left && rect.bottom > rect.top
				);

			const hasOverlap = openMenus.some( ( menu ) => {
				const style = iframeWindow.getComputedStyle( menu );
				if (
					style.display === 'none' ||
					style.visibility === 'hidden' ||
					Number.parseFloat( style.opacity ) === 0
				) {
					return false;
				}
				const menuRect = projectIframeRectToParent(
					menu.getBoundingClientRect(),
					frameElement,
					iframeWindow
				);
				if (
					! menuRect ||
					menuRect.right <= menuRect.left ||
					menuRect.bottom <= menuRect.top
				) {
					return false;
				}
				return toolbarRects.some( ( toolbarRect ) =>
					rectsOverlap( menuRect, toolbarRect )
				);
			} );

			canvasRoot.classList.toggle(
				CANVAS_MENU_TOOLBAR_OVERLAP_CLASS,
				hasOverlap
			);
			return true;
		};

		const monitorToolbarOverlap = () => {
			overlapFrame = null;
			if ( updateToolbarOverlap() ) {
				overlapFrame = iframeWindow.requestAnimationFrame(
					monitorToolbarOverlap
				);
			}
		};
		const syncToolbarOverlap = () => {
			const hasOpenMenu = updateToolbarOverlap();
			if ( hasOpenMenu && overlapFrame === null ) {
				overlapFrame = iframeWindow.requestAnimationFrame(
					monitorToolbarOverlap
				);
			} else if ( ! hasOpenMenu && overlapFrame !== null ) {
				iframeWindow.cancelAnimationFrame( overlapFrame );
				overlapFrame = null;
			}
		};

		// Menu portals add a wrapper directly under the iframe body. Observe only
		// direct children because the rest of the DataViews tree changes often.
		const portalObserver = new MutationObserverClass( syncToolbarOverlap );
		portalObserver.observe( iframeDocument.body, { childList: true } );

		// The portal can mount before the menu gets `data-open`, and the
		// attribute can disappear before the wrapper unmounts.
		const stateObserver = new MutationObserverClass( syncToolbarOverlap );
		stateObserver.observe( iframeDocument.body, {
			attributes: true,
			attributeFilter: [ 'data-open' ],
			subtree: true,
		} );
		// Selecting a block can mount the toolbar after the menu. Measure as soon
		// as that happens so the two are not painted on top of each other.
		const toolbarObserver = new ParentMutationObserverClass(
			syncToolbarOverlap
		);
		toolbarObserver.observe( canvasRoot, {
			childList: true,
			subtree: true,
		} );

		syncToolbarOverlap();

		return () => {
			portalObserver.disconnect();
			stateObserver.disconnect();
			toolbarObserver.disconnect();
			if ( overlapFrame !== null ) {
				iframeWindow.cancelAnimationFrame( overlapFrame );
			}
			canvasRoot.classList.remove( CANVAS_MENU_TOOLBAR_OVERLAP_CLASS );
		};
	}, [] );

	// The hidden span gives the guard access to the iframe document.
	return <span ref={ anchorRef } hidden />;
}

// Schema-bearing documents add an owner block to the reserved header/body
// prefix. Plain documents do not, so the set collapses to defaults.
function getHeaderBlockNames( ownerBlockName ) {
	if ( ! ownerBlockName ) {
		return DEFAULT_HEADER_BLOCK_NAMES;
	}
	return new Set( [ ...DEFAULT_HEADER_BLOCK_NAMES, ownerBlockName ] );
}

function isCanvasOwnerBlock( block, record, postId ) {
	if ( ! block || ! getCanvasOwnerBlockNameForRecord( record ) ) {
		return false;
	}
	return !! findCanvasOwnerBlock( [ block ], record, postId );
}

function isHeaderBlock( block, ownerBlockName, record = null, postId = null ) {
	if ( ! getHeaderBlockNames( ownerBlockName ).has( block?.name ) ) {
		return false;
	}
	if ( block?.name !== ownerBlockName ) {
		return true;
	}
	if ( ! record || ! postId ) {
		return true;
	}
	return isCanvasOwnerBlock( block, record, postId );
}

// Choose the block editor target for pages and full-page rows. Focus an empty
// title; otherwise, focus the first body block. Collections use their own
// DataViews focus rules.
export function getDocumentSurfaceFocusClientId( {
	blocks = [],
	title = '',
	ownerBlockName = null,
	record = null,
	postId = null,
} ) {
	if ( ownerBlockName ) {
		return null;
	}

	const titleBlock = blocks.find(
		( block ) => block?.name === POST_TITLE_BLOCK
	);
	if ( String( title ?? '' ).trim() === '' ) {
		return titleBlock?.clientId ?? null;
	}

	const firstBodyBlock = blocks.find(
		( block ) => ! isHeaderBlock( block, ownerBlockName, record, postId )
	);
	return firstBodyBlock?.clientId ?? titleBlock?.clientId ?? null;
}

export function scheduleDocumentSurfaceFocus( {
	clientId,
	completeSurfaceFocus,
	originIsCurrent,
	ownerWindow,
	requestIsCurrent,
	selectBlock,
	token,
} ) {
	let cancelled = false;
	afterNextPaint( ownerWindow ).then( () => {
		if ( cancelled || ! requestIsCurrent() || ! originIsCurrent() ) {
			return;
		}

		completeSurfaceFocus?.( token, () => selectBlock( clientId, 0 ) );
	} );

	// tech-debt.md#td-page-transitions-snapshot: WordPress 7.1 may batch
	// block-editor selection updates past one animation frame. Clear the
	// rich-text position now, then wait for a full paint before restoring the
	// caret. The request remains cancellable until then.
	selectBlock( clientId, null );

	return () => {
		cancelled = true;
	};
}

// Returns clientIds of header blocks that should be removed by the next
// layout pass. Catches two cases:
//   1. Duplicate singletons (cover, icon, title, properties) inserted by a
//      stray paste or older content version.
//   2. Owner data-views whose `collectionId` does not point at the current
//      document, or extra self-referencing copies. A collection's body is
//      its self-referencing data-view; anything else is residue from a
//      stale block-editor state that survived a document switch.
//
// Exported so the invariant can be tested without driving the full layout
// effect.
export function collectDuplicateHeaderClientIds(
	blocks,
	ownerBlockName,
	postId
) {
	const duplicateIds = [];
	const seenSingletons = new Set();
	blocks.forEach( ( block ) => {
		if (
			block.name !== DOCUMENT_COVER_BLOCK &&
			block.name !== DOCUMENT_ICON_BLOCK &&
			block.name !== POST_TITLE_BLOCK &&
			block.name !== DOCUMENT_PROPERTIES_BLOCK
		) {
			return;
		}
		if ( seenSingletons.has( block.name ) ) {
			duplicateIds.push( block.clientId );
			return;
		}
		seenSingletons.add( block.name );
	} );
	if ( ownerBlockName ) {
		let ownerSeen = false;
		blocks.forEach( ( block ) => {
			if ( block.name !== ownerBlockName ) {
				return;
			}
			const attrId = Number( block.attributes?.collectionId );
			if ( attrId !== Number( postId ) ) {
				duplicateIds.push( block.clientId );
				return;
			}
			if ( ownerSeen ) {
				duplicateIds.push( block.clientId );
				return;
			}
			ownerSeen = true;
		} );
	}
	return duplicateIds;
}

// A foreign data view lands in both lists: duplicate owners and new body
// blocks. The duplicate pass removes it first, so skip it here instead of
// dispatching removeBlock twice.
export function collectCollectionBodyClientIdsToRemove(
	collectionBodyClientIds,
	snapshotClientIds,
	removedClientIds
) {
	return collectionBodyClientIds.filter(
		( clientId ) =>
			! removedClientIds.has( clientId ) &&
			! snapshotClientIds.has( clientId )
	);
}

export function areCanvasReadyRequirementsMet( {
	hasTitle,
	needsCover = false,
	hasCover = false,
	needsIcon = false,
	hasIcon = false,
	isCoverRecordReady = true,
	isPropertiesResolving = false,
	needsProperties = false,
	hasProperties = false,
	needsOwner = false,
	hasOwner = false,
	isOwnerContentReady = true,
} ) {
	return (
		hasTitle &&
		( ! needsCover || hasCover ) &&
		( ! needsIcon || hasIcon ) &&
		isCoverRecordReady &&
		! isPropertiesResolving &&
		( ! needsProperties || hasProperties ) &&
		( ! needsOwner || ( hasOwner && isOwnerContentReady ) )
	);
}

export function isEditorPostReadyForHeaderRepair(
	currentEditorPostId,
	targetPostId
) {
	return (
		currentEditorPostId !== null &&
		currentEditorPostId !== undefined &&
		Number( currentEditorPostId ) === Number( targetPostId )
	);
}

function useDocumentRecord( postType, postId ) {
	const { record } = useEntityRecord( 'postType', postType, postId || 0 );
	return record;
}

function isHeaderChromeBlock( block, ownerBlockName, record, postId ) {
	return isHeaderBlock( block, ownerBlockName, record, postId );
}

function isCollectionBodyBlock( block, ownerBlockName, record, postId ) {
	return (
		!! ownerBlockName &&
		!! block &&
		! isHeaderBlock( block, ownerBlockName, record, postId )
	);
}

function lockNeedsRepair( lock, desiredLock ) {
	return (
		lock?.move !== desiredLock.move ||
		lock?.remove !== desiredLock.remove ||
		( desiredLock.edit === true
			? lock?.edit !== true
			: lock?.edit === true )
	);
}

function selectedClientIdFromEvent( event ) {
	const target = event.target;
	if ( ! target || typeof target.closest !== 'function' ) {
		return null;
	}
	return (
		target.closest( '[data-block]' )?.getAttribute( 'data-block' ) ?? null
	);
}

function syncHeaderBoundaryMoveUpClass() {
	document.body.classList.toggle(
		DISABLE_HEADER_BOUNDARY_MOVE_UP_CLASS,
		activeHeaderBoundaryMoveUpGuards.size > 0
	);
}

function getHeaderBoundaryMoveUpScopes( root ) {
	if ( ! root ) {
		return [];
	}

	const scopes = [
		...( root.matches?.( HEADER_BOUNDARY_MOVE_UP_SCOPE_SELECTOR )
			? [ root ]
			: [] ),
		...root.querySelectorAll( HEADER_BOUNDARY_MOVE_UP_SCOPE_SELECTOR ),
	];
	return scopes.length > 0 ? scopes : [ root ];
}

function syncHeaderBoundaryMoveUpButtons( root, shouldDisable ) {
	// tech-debt.md#td-gutenberg-header-boundary: Gutenberg does not expose boundary-aware mover state.
	const ownerWindow = root?.ownerDocument?.defaultView ?? window;
	getHeaderBoundaryMoveUpScopes( root ).forEach( ( scope ) => {
		scope
			.querySelectorAll( HEADER_BOUNDARY_MOVE_UP_SELECTOR )
			.forEach( ( button ) => {
				if ( ! ( button instanceof ownerWindow.HTMLButtonElement ) ) {
					return;
				}

				if ( shouldDisable ) {
					if (
						! button.hasAttribute(
							DISABLED_BY_HEADER_BOUNDARY_ATTR
						)
					) {
						button.setAttribute(
							DISABLED_BY_HEADER_BOUNDARY_ATTR,
							'true'
						);
						button.dataset.cortextPreviousDisabled = button.disabled
							? 'true'
							: 'false';
						const previousAriaDisabled =
							button.getAttribute( 'aria-disabled' );
						if ( previousAriaDisabled !== null ) {
							button.dataset.cortextPreviousAriaDisabled =
								previousAriaDisabled;
						} else {
							delete button.dataset.cortextPreviousAriaDisabled;
						}
					}

					button.disabled = true;
					button.setAttribute( 'aria-disabled', 'true' );
					return;
				}

				if (
					! button.hasAttribute( DISABLED_BY_HEADER_BOUNDARY_ATTR )
				) {
					return;
				}

				button.disabled =
					button.dataset.cortextPreviousDisabled === 'true';
				if (
					Object.prototype.hasOwnProperty.call(
						button.dataset,
						'cortextPreviousAriaDisabled'
					)
				) {
					button.setAttribute(
						'aria-disabled',
						button.dataset.cortextPreviousAriaDisabled
					);
				} else {
					button.removeAttribute( 'aria-disabled' );
				}
				button.removeAttribute( DISABLED_BY_HEADER_BOUNDARY_ATTR );
				delete button.dataset.cortextPreviousDisabled;
				delete button.dataset.cortextPreviousAriaDisabled;
			} );
	} );
}

function syncHeaderBoundaryMoveUpState( root, shouldDisable ) {
	syncHeaderBoundaryMoveUpClass();
	syncHeaderBoundaryMoveUpButtons( root, shouldDisable );
}

function HeaderPrefixToolbarGuard( {
	isActive = true,
	isLocked = false,
	postId,
	postType,
	toolbarRootRef,
} ) {
	const record = useDocumentRecord( postType, postId );
	const ownerBlockName = getCanvasOwnerBlockNameForRecord( record );
	const guardId = useRef( Symbol( DISABLE_HEADER_BOUNDARY_MOVE_UP_CLASS ) );
	const shouldDisableMoveUp = useSelect(
		( select ) => {
			if ( ! isActive || isLocked ) {
				return false;
			}
			const store = select( blockEditorStore );
			const blocks = store.getBlocks();
			const selectedClientIds = store.getSelectedBlockClientIds();
			const titleIndex = blocks.findIndex(
				( block ) => block.name === POST_TITLE_BLOCK
			);
			if ( titleIndex < 0 || selectedClientIds.length === 0 ) {
				return false;
			}

			const firstBodyIndex = blocks.findIndex(
				( block, index ) =>
					index > titleIndex &&
					! isHeaderBlock( block, ownerBlockName, record, postId )
			);
			if ( firstBodyIndex < 0 ) {
				return false;
			}

			const rootBlockIndexes = new Map(
				blocks.map( ( block, index ) => [ block.clientId, index ] )
			);
			const selectedRootIndexes = selectedClientIds
				.map( ( clientId ) => rootBlockIndexes.get( clientId ) )
				.filter( ( index ) => typeof index === 'number' );
			if ( selectedRootIndexes.length === 0 ) {
				return false;
			}

			return Math.min( ...selectedRootIndexes ) === firstBodyIndex;
		},
		[ isActive, isLocked, ownerBlockName, postId, record ]
	);

	useEffect( () => {
		const currentGuardId = guardId.current;
		const toolbarRoot = toolbarRootRef?.current;
		if ( shouldDisableMoveUp ) {
			activeHeaderBoundaryMoveUpGuards.add( currentGuardId );
		} else {
			activeHeaderBoundaryMoveUpGuards.delete( currentGuardId );
		}
		syncHeaderBoundaryMoveUpState( toolbarRoot, shouldDisableMoveUp );
		const observer = new window.MutationObserver( () =>
			syncHeaderBoundaryMoveUpButtons( toolbarRoot, shouldDisableMoveUp )
		);
		if ( shouldDisableMoveUp && toolbarRoot ) {
			observer.observe( toolbarRoot, {
				childList: true,
				subtree: true,
			} );
		}
		return () => {
			observer.disconnect();
			activeHeaderBoundaryMoveUpGuards.delete( currentGuardId );
			syncHeaderBoundaryMoveUpState( toolbarRoot, false );
		};
	}, [ shouldDisableMoveUp, toolbarRootRef ] );

	return null;
}

function DocumentIdentityActions( { isLocked = false, postId, postType } ) {
	const isInsertingCoverRef = useRef( false );
	const actionsRef = useRef( null );
	const [ meta ] = useEntityProp( 'postType', postType, 'meta', postId );
	const iconMeta = meta?.cortext_document_icon ?? '';
	const { hasIcon, hasCover, isTrashed, selectedBlockName } = useSelect(
		( select ) => {
			const store = select( blockEditorStore );
			const blocks = store.getBlocks();
			const selectedClientId = store.getSelectedBlockClientId();
			return {
				hasCover: blocks.some(
					( block ) => block.name === DOCUMENT_COVER_BLOCK
				),
				hasIcon: blocks.some(
					( block ) => block.name === DOCUMENT_ICON_BLOCK
				),
				isTrashed:
					select( editorStore ).getCurrentPostAttribute(
						'status'
					) === 'trash',
				selectedBlockName: selectedClientId
					? store.getBlockName( selectedClientId )
					: null,
			};
		},
		[]
	);
	const { insertBlocks } = useDispatch( blockEditorStore );
	const { editEntityRecord, saveEditedEntityRecord } = useDispatch( 'core' );

	useEffect( () => {
		if ( isTrashed || isLocked || hasCover ) {
			return undefined;
		}
		const node = actionsRef.current;
		const ownerDocument = node?.ownerDocument;
		if ( ! node || ! ownerDocument ) {
			return undefined;
		}
		const focusFirstActionFromTitle = ( event ) => {
			if (
				event.key !== 'Tab' ||
				event.shiftKey ||
				event.defaultPrevented
			) {
				return;
			}
			const target = event.target;
			const targetIsPostTitle =
				target &&
				typeof target.closest === 'function' &&
				target.closest( '[data-type="core/post-title"]' );
			const titleHasFocus = ownerDocument.querySelector(
				'[data-type="core/post-title"]:focus-within'
			);
			if (
				! targetIsPostTitle &&
				! titleHasFocus &&
				selectedBlockName !== POST_TITLE_BLOCK
			) {
				return;
			}
			const firstAction = node.querySelector(
				'.cortext-canvas__identity-action:not(:disabled)'
			);
			if ( ! firstAction ) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			firstAction.focus();
		};
		ownerDocument.addEventListener(
			'keydown',
			focusFirstActionFromTitle,
			true
		);
		return () =>
			ownerDocument.removeEventListener(
				'keydown',
				focusFirstActionFromTitle,
				true
			);
	}, [ hasCover, isLocked, isTrashed, selectedBlockName ] );

	if ( isTrashed || isLocked || hasCover ) {
		return null;
	}

	const ensureIconBlock = () => {
		if ( hasIcon || isLocked ) {
			return;
		}
		const block = createBlock( DOCUMENT_ICON_BLOCK, {
			lock: PROTECTED_HEADER_LOCK,
		} );
		insertBlocks( block, 0, undefined, false );
	};

	const insertCover = async ( mediaId ) => {
		if ( hasCover || isLocked || isInsertingCoverRef.current ) {
			return;
		}
		isInsertingCoverRef.current = true;
		const block = createBlock( DOCUMENT_COVER_BLOCK, {
			align: 'full',
			lock: PROTECTED_HEADER_LOCK,
		} );
		insertBlocks( block, 0, undefined, false );
		try {
			editEntityRecord( 'postType', postType, postId, {
				featured_media: mediaId,
			} );
			await saveEditedEntityRecord( 'postType', postType, postId );
		} finally {
			isInsertingCoverRef.current = false;
		}
	};

	return (
		<div
			ref={ actionsRef }
			className="cortext-canvas__identity-actions"
			role="group"
			aria-label={ __( 'Identity actions', 'cortext' ) }
		>
			{ ! hasIcon && ! hasCover && (
				<DocumentIdentityControls
					postId={ postId }
					postType={ postType }
					currentIcon={ iconMeta }
					onAfterSave={ ensureIconBlock }
					renderToggle={ ( { onToggle } ) => (
						<Button
							className="cortext-canvas__identity-action"
							variant="tertiary"
							onClick={ onToggle }
						>
							{ __( 'Add icon', 'cortext' ) }
						</Button>
					) }
				/>
			) }
			{ ! hasCover && (
				<MediaUploadCheck>
					<MediaPicker
						allowedTypes={ [ 'image' ] }
						postId={ postId }
						onSelect={ ( media ) => insertCover( media.id ) }
						render={ ( { open } ) => (
							<Button
								className="cortext-canvas__identity-action"
								variant="tertiary"
								onClick={ open }
							>
								{ __( 'Add cover', 'cortext' ) }
							</Button>
						) }
					/>
				</MediaUploadCheck>
			) }
		</div>
	);
}

function EnsureHeaderBlocks( { isLocked = false, postId, postType } ) {
	const collectionBodySnapshotRef = useRef( {
		key: null,
		initialized: false,
		clientIds: new Set(),
	} );
	const [ meta ] = useEntityProp( 'postType', postType, 'meta', postId );
	const [ featuredId ] = useEntityProp(
		'postType',
		postType,
		'featured_media',
		postId
	);
	const iconMeta = meta?.cortext_document_icon ?? '';
	const propertiesCtx = useDocumentPropertiesContext();
	// The row context can advance before the editor swaps posts. In that gap,
	// leave the outgoing row's header alone.
	const propertiesContextStable = ! (
		propertiesCtx?.isSchemaResolving ?? propertiesCtx?.isResolving
	);
	const hasSchema =
		propertiesContextStable &&
		Array.isArray( propertiesCtx?.fields ) &&
		propertiesCtx.fields.length > 0;
	const record = useDocumentRecord( postType, postId );
	const ownerBlockName = getCanvasOwnerBlockNameForRecord( record );
	const {
		coverIndex,
		titleIndex,
		hasCover,
		hasIcon,
		hasTitle,
		hasProperties,
		hasOwner,
		propertiesClientId,
		headerEndIndex,
		bodyBlockBeforeTitleId,
		shouldHideHeaderInsertionPoint,
		duplicateHeaderIds,
		shouldSeedEmptyBodyBlock,
		emptyBodyInsertionIndex,
		protectedLockRepairs,
		collectionBodyClientIds,
		lockedCollectionBodyClientIds,
		isTrashed,
	} = useSelect(
		( select ) => {
			const store = select( blockEditorStore );
			const blocks = store.getBlocks();
			const names = blocks.map( ( block ) => block.name );
			const currentTitleIndex = names.indexOf( POST_TITLE_BLOCK );
			const currentPropertiesIndex = names.indexOf(
				DOCUMENT_PROPERTIES_BLOCK
			);
			const ownerBlock = ownerBlockName
				? findCanvasOwnerBlock( blocks, record, postId )
				: null;
			const currentOwnerIndex = ownerBlock
				? blocks.findIndex(
						( block ) => block.clientId === ownerBlock.clientId
				  )
				: -1;
			// The protected prefix ends at the last installed header block:
			// cover, icon, title, properties, or the owner block. max() keeps
			// strange legacy order from shrinking that boundary.
			const currentHeaderEndIndex = Math.max(
				currentTitleIndex,
				currentPropertiesIndex,
				currentOwnerIndex
			);
			let currentBodyBlockBeforeTitleId = null;
			if ( currentHeaderEndIndex > -1 ) {
				for (
					let index = currentHeaderEndIndex - 1;
					index >= 0;
					index--
				) {
					const block = blocks[ index ];
					if (
						isHeaderBlock( block, ownerBlockName, record, postId )
					) {
						continue;
					}
					currentBodyBlockBeforeTitleId = block.clientId;
					break;
				}
			}
			const insertionPoint = store.getBlockInsertionPoint();
			const insertionPointRootClientId =
				insertionPoint?.rootClientId ?? ROOT_BLOCK_LIST;
			const insertionPointIndex =
				insertionPoint?.index ?? Number.POSITIVE_INFINITY;
			const duplicateIds = collectDuplicateHeaderClientIds(
				blocks,
				ownerBlockName,
				postId
			);
			const lockRepairs = [];
			const bodyClientIds = [];
			const lockedBodyClientIds = [];
			blocks.forEach( ( block ) => {
				let desiredLock = null;
				if (
					DEFAULT_HEADER_BLOCK_NAMES.has( block.name ) ||
					isCanvasOwnerBlock( block, record, postId )
				) {
					desiredLock = PROTECTED_HEADER_LOCK;
				} else if (
					isCollectionBodyBlock(
						block,
						ownerBlockName,
						record,
						postId
					)
				) {
					bodyClientIds.push( block.clientId );
					desiredLock = COLLECTION_LEGACY_BLOCK_LOCK;
					if (
						! lockNeedsRepair(
							block.attributes?.lock,
							COLLECTION_LEGACY_BLOCK_LOCK
						)
					) {
						lockedBodyClientIds.push( block.clientId );
					}
				}
				if (
					desiredLock &&
					lockNeedsRepair( block.attributes?.lock, desiredLock )
				) {
					lockRepairs.push( {
						clientId: block.clientId,
						lock: desiredLock,
					} );
				}
			} );
			const propertiesBlock = blocks.find(
				( block ) => block.name === DOCUMENT_PROPERTIES_BLOCK
			);
			return {
				coverIndex: names.indexOf( DOCUMENT_COVER_BLOCK ),
				titleIndex: currentTitleIndex,
				hasCover: names.includes( DOCUMENT_COVER_BLOCK ),
				hasIcon: names.includes( DOCUMENT_ICON_BLOCK ),
				hasTitle: names.includes( POST_TITLE_BLOCK ),
				hasProperties: !! propertiesBlock,
				hasOwner: ownerBlockName ? !! ownerBlock : true,
				propertiesClientId: propertiesBlock?.clientId ?? null,
				headerEndIndex: currentHeaderEndIndex,
				bodyBlockBeforeTitleId: currentBodyBlockBeforeTitleId,
				shouldSeedEmptyBodyBlock:
					! ownerBlockName &&
					blocks.length > 0 &&
					blocks.every( ( block ) =>
						isHeaderChromeBlock(
							block,
							ownerBlockName,
							record,
							postId
						)
					),
				emptyBodyInsertionIndex: currentHeaderEndIndex + 1,
				shouldHideHeaderInsertionPoint:
					store.isBlockInsertionPointVisible() &&
					currentHeaderEndIndex > -1 &&
					insertionPointRootClientId === ROOT_BLOCK_LIST &&
					insertionPointIndex <= currentHeaderEndIndex,
				duplicateHeaderIds: duplicateIds,
				isTrashed:
					select( editorStore ).getCurrentPostAttribute(
						'status'
					) === 'trash',
				protectedLockRepairs: lockRepairs,
				collectionBodyClientIds: bodyClientIds,
				lockedCollectionBodyClientIds: lockedBodyClientIds,
			};
		},
		[ ownerBlockName, postId, record ]
	);
	const {
		insertBlocks,
		moveBlocksToPosition,
		removeBlock,
		hideInsertionPoint,
		updateBlockAttributes,
		startTyping,
		stopTyping,
	} = useDispatch( blockEditorStore );
	const currentEditorPostId = useSelect(
		( select ) => select( editorStore ).getCurrentPostId(),
		[]
	);
	const isEditorPostReady = isEditorPostReadyForHeaderRepair(
		currentEditorPostId,
		postId
	);

	useLayoutEffect( () => {
		collectionBodySnapshotRef.current = {
			key: `${ postType }:${ postId }`,
			initialized: false,
			clientIds: new Set(),
		};
	}, [ postId, postType ] );

	useLayoutEffect( () => {
		if ( isTrashed ) {
			return;
		}

		const removedClientIds = new Set();
		duplicateHeaderIds.forEach( ( clientId ) => {
			removedClientIds.add( clientId );
			updateBlockAttributes( clientId, { lock: {} } );
			removeBlock( clientId, false );
		} );

		const snapshot = collectionBodySnapshotRef.current;
		if (
			ownerBlockName &&
			hasOwner &&
			hasTitle &&
			! snapshot.initialized
		) {
			snapshot.key = `${ postType }:${ postId }`;
			snapshot.clientIds = new Set(
				lockedCollectionBodyClientIds.length > 0
					? lockedCollectionBodyClientIds
					: collectionBodyClientIds
			);
			snapshot.initialized = true;
		}

		if ( ownerBlockName && hasOwner && snapshot.initialized ) {
			collectCollectionBodyClientIdsToRemove(
				collectionBodyClientIds,
				snapshot.clientIds,
				removedClientIds
			).forEach( ( clientId ) => {
				removedClientIds.add( clientId );
				updateBlockAttributes( clientId, { lock: {} } );
				removeBlock( clientId, false );
			} );
		}

		if ( isLocked ) {
			return;
		}

		protectedLockRepairs.forEach( ( { clientId, lock } ) => {
			if ( removedClientIds.has( clientId ) ) {
				return;
			}
			updateBlockAttributes( clientId, { lock } );
		} );

		// Keep the properties block only on rows whose collection has fields.
		// If schema disappears, remove the block so post_content does not keep
		// an empty marker. Skip this while the provider is switching rows.
		if (
			propertiesContextStable &&
			hasProperties &&
			! hasSchema &&
			propertiesClientId
		) {
			updateBlockAttributes( propertiesClientId, { lock: {} } );
			removeBlock( propertiesClientId, false );
		}
	}, [
		duplicateHeaderIds,
		collectionBodyClientIds,
		hasProperties,
		hasSchema,
		hasOwner,
		hasTitle,
		isLocked,
		isTrashed,
		lockedCollectionBodyClientIds,
		ownerBlockName,
		propertiesClientId,
		propertiesContextStable,
		postId,
		postType,
		protectedLockRepairs,
		removeBlock,
		updateBlockAttributes,
	] );

	useLayoutEffect( () => {
		if ( isTrashed || isLocked || ! shouldHideHeaderInsertionPoint ) {
			return;
		}
		hideInsertionPoint();
	}, [
		hideInsertionPoint,
		isLocked,
		isTrashed,
		shouldHideHeaderInsertionPoint,
	] );

	useLayoutEffect( () => {
		if (
			isTrashed ||
			ownerBlockName ||
			! shouldSeedEmptyBodyBlock ||
			duplicateHeaderIds.length > 0 ||
			( featuredId > 0 && ! hasCover ) ||
			( iconMeta && ! hasIcon ) ||
			! hasTitle ||
			( hasSchema && ! hasProperties )
		) {
			return;
		}

		insertBlocks(
			createBlock( 'core/paragraph' ),
			emptyBodyInsertionIndex,
			undefined,
			false
		);
	}, [
		duplicateHeaderIds.length,
		emptyBodyInsertionIndex,
		featuredId,
		hasCover,
		hasIcon,
		hasProperties,
		hasSchema,
		hasTitle,
		iconMeta,
		insertBlocks,
		isTrashed,
		ownerBlockName,
		shouldSeedEmptyBodyBlock,
	] );

	// useLayoutEffect rather than useEffect: we want the insertion to
	// happen between render and paint so the user never sees the
	// intermediate state where the document has body content but the
	// locked header blocks haven't been added yet.
	//
	// `useMovingAnimation` (the hook that animates blocks when their
	// index changes) skips the animation while `isTyping` is true. Wrap
	// the inserts in a startTyping/stopTyping pair so existing body
	// blocks don't slide downward as the headers land — that animation
	// reads as "the icon is being inserted right now" when really the
	// document is just hydrating.
	useLayoutEffect( () => {
		// tech-debt.md#td-page-transitions-snapshot: Canvas can receive the next
		// post before EditorProvider hydrates it into core/editor. Header blocks
		// inserted during that gap are overwritten, so wait for the store to
		// identify the target post.
		if ( ! isEditorPostReady || isTrashed || isLocked ) {
			return;
		}

		const needsCover = featuredId > 0 && ! hasCover;
		const needsIcon = iconMeta && ! hasIcon;
		const needsTitle = ! hasTitle;
		const needsProperties = hasSchema && ! hasProperties;
		const needsOwner = !! ownerBlockName && ! hasOwner;
		if (
			! needsCover &&
			! needsIcon &&
			! needsTitle &&
			! needsProperties &&
			! needsOwner
		) {
			return;
		}

		startTyping();

		if ( needsCover ) {
			insertBlocks(
				createBlock( DOCUMENT_COVER_BLOCK, {
					align: 'full',
					lock: PROTECTED_HEADER_LOCK,
				} ),
				0,
				undefined,
				false
			);
		}
		if ( needsIcon ) {
			let iconIndex = 0;
			if ( hasCover ) {
				iconIndex = coverIndex + 1;
			} else if ( featuredId > 0 ) {
				iconIndex = 1;
			}
			insertBlocks(
				createBlock( DOCUMENT_ICON_BLOCK, {
					lock: PROTECTED_HEADER_LOCK,
				} ),
				iconIndex,
				undefined,
				false
			);
		}
		const computedTitleIndex =
			( featuredId > 0 ? 1 : 0 ) + ( iconMeta ? 1 : 0 );
		if ( needsTitle ) {
			insertBlocks(
				createBlock( POST_TITLE_BLOCK, {
					lock: PROTECTED_HEADER_LOCK,
				} ),
				computedTitleIndex,
				undefined,
				false
			);
		}
		if ( needsProperties ) {
			// The properties block sits directly after the title. Legacy rows
			// can still have body blocks before the title, so the canonical
			// index would put properties before that misplaced title. Anchor on
			// the snapshot `titleIndex`, shifted by any cover/icon inserted
			// above it. If this pass also inserts the title, the snapshot cannot
			// help yet, so use the canonical index.
			const anchorTitleIndex = needsTitle
				? computedTitleIndex
				: titleIndex + ( needsCover ? 1 : 0 ) + ( needsIcon ? 1 : 0 );
			insertBlocks(
				createBlock( DOCUMENT_PROPERTIES_BLOCK, {
					lock: PROTECTED_HEADER_LOCK,
				} ),
				anchorTitleIndex + 1,
				undefined,
				false
			);
		}
		if ( needsOwner ) {
			// The owner block is the body. Add it last so it follows any
			// header repairs made in this pass.
			const ownerAttributes = getCanvasOwnerInitialAttributesForRecord(
				record,
				postId
			);
			insertBlocks(
				createBlock( ownerBlockName, ownerAttributes ?? {} ),
				undefined,
				undefined,
				false
			);
		}

		// Release the typing flag on the next frame, after the moving
		// animation has been decided (and skipped) for this render pass.
		const handle = window.requestAnimationFrame( () => stopTyping() );
		return () => window.cancelAnimationFrame( handle );
	}, [
		coverIndex,
		featuredId,
		hasCover,
		hasIcon,
		hasOwner,
		hasProperties,
		hasSchema,
		hasTitle,
		iconMeta,
		insertBlocks,
		isEditorPostReady,
		isLocked,
		isTrashed,
		ownerBlockName,
		postId,
		record,
		startTyping,
		stopTyping,
		titleIndex,
	] );

	useLayoutEffect( () => {
		if (
			isTrashed ||
			isLocked ||
			! bodyBlockBeforeTitleId ||
			headerEndIndex < 0 ||
			duplicateHeaderIds.length > 0 ||
			( featuredId > 0 && ! hasCover ) ||
			( iconMeta && ! hasIcon ) ||
			! hasTitle ||
			( hasSchema && ! hasProperties )
		) {
			return;
		}

		startTyping();
		moveBlocksToPosition(
			[ bodyBlockBeforeTitleId ],
			ROOT_BLOCK_LIST,
			ROOT_BLOCK_LIST,
			headerEndIndex
		);

		const handle = window.requestAnimationFrame( () => stopTyping() );
		return () => window.cancelAnimationFrame( handle );
	}, [
		bodyBlockBeforeTitleId,
		duplicateHeaderIds.length,
		featuredId,
		hasCover,
		hasIcon,
		hasProperties,
		hasSchema,
		hasTitle,
		headerEndIndex,
		iconMeta,
		isLocked,
		isTrashed,
		moveBlocksToPosition,
		startTyping,
		stopTyping,
	] );

	return null;
}

// Hide Core block actions while a protected Cortext block is selected.
// Duplicate, move, lock, and add actions do not make sense for fixed headers
// or locked collection body content. The toolbar and iframe live in separate
// documents, so a body class is the simplest hook.
function HideHeaderBlockKebab( { postId, postType } ) {
	const record = useDocumentRecord( postType, postId );
	const ownerBlockName = getCanvasOwnerBlockNameForRecord( record );
	const isSelectedProtected = useSelect(
		( select ) => {
			const store = select( blockEditorStore );
			const clientId = store.getSelectedBlockClientId();
			if ( ! clientId ) {
				return false;
			}
			const block = store.getBlock( clientId );
			return (
				isHeaderBlock( block, ownerBlockName, record, postId ) ||
				isCollectionBodyBlock( block, ownerBlockName, record, postId )
			);
		},
		[ ownerBlockName, postId, record ]
	);

	useEffect( () => {
		document.body.classList.toggle(
			'cortext-hide-block-settings-menu',
			isSelectedProtected
		);
		return () => {
			document.body.classList.remove(
				'cortext-hide-block-settings-menu'
			);
		};
	}, [ isSelectedProtected ] );

	return null;
}

function ProtectedBlockShortcutGuard( { postId, postType, canvasRootRef } ) {
	const record = useDocumentRecord( postType, postId );
	const ownerBlockName = getCanvasOwnerBlockNameForRecord( record );
	const { protectedClientIds, selectedClientIds } = useSelect(
		( select ) => {
			const store = select( blockEditorStore );
			const blocks = store.getBlocks();
			const protectedIds = [];
			const selectedIds = store.getSelectedBlockClientIds();

			blocks.forEach( ( block ) => {
				const isProtected =
					isHeaderBlock( block, ownerBlockName, record, postId ) ||
					isCollectionBodyBlock(
						block,
						ownerBlockName,
						record,
						postId
					);
				if ( isProtected ) {
					protectedIds.push( block.clientId );
				}
			} );

			return {
				protectedClientIds: protectedIds,
				selectedClientIds: selectedIds,
			};
		},
		[ ownerBlockName, postId, record ]
	);

	useEffect( () => {
		const protectedSet = new Set( protectedClientIds );
		if ( protectedSet.size === 0 ) {
			return undefined;
		}

		const getCandidateClientIds = ( event, fallbackClientIds ) => {
			const eventClientId = selectedClientIdFromEvent( event );
			return eventClientId ? [ eventClientId ] : fallbackClientIds;
		};
		const includesProtected = ( clientIds ) =>
			clientIds.some( ( clientId ) => protectedSet.has( clientId ) );
		const stopProtectedShortcut = ( event ) => {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation?.();
		};
		const onKeyDown = ( event ) => {
			if ( event.defaultPrevented ) {
				return;
			}
			if ( isKeyboardEvent.primaryShift( event, 'd' ) ) {
				const clientIds = getCandidateClientIds(
					event,
					selectedClientIds
				);
				if ( includesProtected( clientIds ) ) {
					stopProtectedShortcut( event );
				}
				return;
			}
			if ( isKeyboardEvent.primaryAlt( event, 't' ) ) {
				const clientIds = getCandidateClientIds(
					event,
					selectedClientIds.slice( 0, 1 )
				);
				if ( includesProtected( clientIds ) ) {
					stopProtectedShortcut( event );
				}
				return;
			}
			if ( isKeyboardEvent.primaryAlt( event, 'y' ) ) {
				const clientIds = getCandidateClientIds(
					event,
					selectedClientIds.slice( -1 )
				);
				if ( includesProtected( clientIds ) ) {
					stopProtectedShortcut( event );
				}
			}
		};

		const ownerDocument = canvasRootRef?.current?.ownerDocument ?? document;
		const iframeDocument =
			canvasRootRef?.current?.querySelector( 'iframe' )
				?.contentDocument ?? null;
		const documents = [ ownerDocument, iframeDocument ].filter( Boolean );
		documents.forEach( ( doc ) =>
			doc.addEventListener( 'keydown', onKeyDown, true )
		);
		return () => {
			documents.forEach( ( doc ) =>
				doc.removeEventListener( 'keydown', onKeyDown, true )
			);
		};
	}, [ canvasRootRef, protectedClientIds, selectedClientIds ] );

	return null;
}

function HeaderAwareRootAppender( { ownerBlockName, postId, record } ) {
	// tech-debt.md#td-gutenberg-header-boundary: Gutenberg's root appender only treats a fully empty
	// root list as empty. Cortext's locked header blocks are chrome, so the
	// body still needs a first-block prompt after them.
	const { bodyEmpty, insertionIndex } = useSelect(
		( select ) => {
			const blocks = select( blockEditorStore ).getBlocks();
			const headerEndIndex = blocks.reduce(
				( lastIndex, block, index ) =>
					isHeaderChromeBlock( block, ownerBlockName, record, postId )
						? index
						: lastIndex,
				-1
			);
			return {
				bodyEmpty:
					blocks.length > 0 &&
					blocks.every( ( block ) =>
						isHeaderChromeBlock(
							block,
							ownerBlockName,
							record,
							postId
						)
					),
				insertionIndex: headerEndIndex + 1,
			};
		},
		[ ownerBlockName, postId, record ]
	);
	const { insertDefaultBlock, startTyping } = useDispatch( blockEditorStore );

	if ( ! bodyEmpty ) {
		return null;
	}

	const onAppend = () => {
		insertDefaultBlock( undefined, ROOT_BLOCK_LIST, insertionIndex );
		startTyping();
	};

	return (
		<div className="block-editor-default-block-appender has-visible-prompt">
			<p
				tabIndex="0"
				// Match core's default appender semantics so focusing the
				// prompt immediately creates the first editable body block.
				// eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
				role="button"
				aria-label={ __( 'Add default block', 'cortext' ) }
				className="block-editor-default-block-appender__content"
				onKeyDown={ ( event ) => {
					if ( ENTER === event.keyCode || SPACE === event.keyCode ) {
						onAppend();
					}
				} }
				onClick={ onAppend }
				onFocus={ onAppend }
			>
				{ __( 'Type / to choose a block', 'cortext' ) }
			</p>
			<Inserter
				rootClientId={ ROOT_BLOCK_LIST }
				position="bottom right"
				isAppender
				__experimentalIsQuick
			/>
		</div>
	);
}

function TrashedNotice( { postId, postType, onRestored } ) {
	const [ isRestoring, setIsRestoring ] = useState( false );
	const [ error, setError ] = useState( null );

	const restore = async () => {
		setError( null );
		setIsRestoring( true );
		try {
			const response = await apiFetch( {
				path: `/cortext/v1/documents/${ postId }/restore`,
				method: 'POST',
			} );
			onRestored?.( postId, postType, response );
		} catch ( err ) {
			setError(
				err?.message ??
					__( 'Could not restore this document.', 'cortext' )
			);
		} finally {
			setIsRestoring( false );
		}
	};

	return (
		<Notice
			className="cortext-canvas__notice"
			status="warning"
			isDismissible={ false }
			actions={ [
				{
					label: __( 'Restore', 'cortext' ),
					onClick: restore,
					disabled: isRestoring,
					variant: 'primary',
				},
			] }
		>
			{ error
				? error
				: __( 'This document is in the Trash.', 'cortext' ) }
		</Notice>
	);
}

function coverSource( media ) {
	return (
		media?.media_details?.sizes?.large?.source_url ??
		media?.source_url ??
		null
	);
}

function waitForImageReady( image ) {
	const ownerWindow = image.ownerDocument?.defaultView ?? window;
	const isLoaded = image.complete && image.naturalWidth > 0;
	const waitForLoad = isLoaded
		? Promise.resolve()
		: new Promise( ( resolve ) => {
				const cleanup = () => {
					ownerWindow.clearTimeout( timeoutId );
					image.removeEventListener( 'load', cleanup );
					image.removeEventListener( 'error', cleanup );
					resolve();
				};
				const timeoutId = ownerWindow.setTimeout(
					cleanup,
					CANVAS_READY_IMAGE_TIMEOUT
				);
				image.addEventListener( 'load', cleanup, { once: true } );
				image.addEventListener( 'error', cleanup, { once: true } );
		  } );

	return waitForLoad.then( () => image.decode?.().catch( () => {} ) );
}

function imageMatchesSource( image, expectedSource ) {
	if ( ! expectedSource ) {
		return true;
	}
	return (
		image.currentSrc === expectedSource ||
		image.src === expectedSource ||
		image.getAttribute( 'src' ) === expectedSource
	);
}

const COVER_IMAGE_SELECTOR = '.cortext-document-cover-block__image';
const ICON_IMAGE_SELECTOR = '.cortext-document-icon--image';

function findImageNode( ownerDocument, selector, expectedSource ) {
	const images = [ ...ownerDocument.querySelectorAll( selector ) ];
	if ( expectedSource ) {
		return (
			images.find( ( image ) =>
				imageMatchesSource( image, expectedSource )
			) ?? null
		);
	}
	return images[ 0 ] ?? null;
}

function waitForImageNode( ownerDocument, selector, expectedSource ) {
	const existing = findImageNode( ownerDocument, selector, expectedSource );
	if ( existing ) {
		return Promise.resolve( existing );
	}
	const ownerWindow = ownerDocument.defaultView ?? window;
	const MutationObserver = ownerWindow.MutationObserver;
	if ( ! MutationObserver ) {
		return Promise.resolve( null );
	}
	return new Promise( ( resolve ) => {
		const cleanup = ( image = null ) => {
			ownerWindow.clearTimeout( timeoutId );
			observer.disconnect();
			resolve( image );
		};
		const observer = new MutationObserver( () => {
			const image = findImageNode(
				ownerDocument,
				selector,
				expectedSource
			);
			if ( image ) {
				cleanup( image );
			}
		} );
		const timeoutId = ownerWindow.setTimeout(
			() => cleanup(),
			CANVAS_READY_IMAGE_TIMEOUT
		);
		observer.observe( ownerDocument.documentElement, {
			attributeFilter: [ 'src' ],
			attributes: true,
			childList: true,
			subtree: true,
		} );
	} );
}

// Hold the reveal until the header images have painted, so they don't pop in
// once the canvas is shown. The cover is matched by its resolved source. An
// uploaded icon image fetches its media record and bytes async, so the icon slot
// would otherwise sit empty for a moment mid-transition.
async function waitForCriticalImages(
	canvasRoot,
	expectedCoverSource,
	{ iconNeedsImage = false } = {}
) {
	const iframe = canvasRoot?.querySelector( 'iframe' );
	const ownerDocument = iframe?.contentDocument ?? canvasRoot?.ownerDocument;
	if ( ! ownerDocument ) {
		return;
	}
	const waits = [];
	if ( expectedCoverSource ) {
		waits.push(
			waitForImageNode(
				ownerDocument,
				COVER_IMAGE_SELECTOR,
				expectedCoverSource
			).then( ( image ) => image && waitForImageReady( image ) )
		);
	}
	if ( iconNeedsImage ) {
		waits.push(
			waitForImageNode( ownerDocument, ICON_IMAGE_SELECTOR ).then(
				( image ) => image && waitForImageReady( image )
			)
		);
	}
	await Promise.all( waits );
}

function DocumentSurfaceFocusEffect( {
	isActive,
	isEditorSurfaceDisplayed,
	isReadOnly,
	isSurfaceFocusPending,
	postId,
	ownerBlockName,
	record,
	canvasRootRef,
	surfaceFocusRequest,
	completeSurfaceFocus,
} ) {
	const requestRef = useRef( surfaceFocusRequest );
	requestRef.current = surfaceFocusRequest;
	const { blocks, title } = useSelect(
		( select ) => ( {
			blocks: select( blockEditorStore ).getBlocks(),
			title: select( editorStore ).getEditedPostAttribute( 'title' ),
		} ),
		[]
	);
	const { selectBlock } = useDispatch( blockEditorStore );

	useEffect( () => {
		const request = surfaceFocusRequest;
		if (
			! request ||
			! isActive ||
			! isEditorSurfaceDisplayed ||
			ownerBlockName ||
			Number( request.documentId ) !== Number( postId )
		) {
			return undefined;
		}

		const token = request.token;
		let cancelled = false;
		let cancelScheduledFocus = null;
		const ownerWindow =
			canvasRootRef.current?.ownerDocument?.defaultView ?? window;
		const requestIsCurrent = () => requestRef.current?.token === token;
		const originIsCurrent = () =>
			isSurfaceFocusOriginCurrent( requestRef.current?.originElement );

		async function focusDocumentSurface() {
			await whenViewTransitionsSettled( 0 );
			// `DOCUMENT_DISPLAYED` may fire in the same commit that hydrates the
			// editor registry. Wait for one paint before reading the block list so a
			// transient empty list does not consume the request.
			await afterNextPaint( ownerWindow );
			if ( cancelled || ! requestIsCurrent() ) {
				return;
			}
			if ( ! originIsCurrent() ) {
				completeSurfaceFocus?.( token );
				return;
			}

			if ( isSurfaceFocusPending ) {
				return;
			}
			if ( isReadOnly ) {
				completeSurfaceFocus?.( token );
				return;
			}

			const clientId = getDocumentSurfaceFocusClientId( {
				blocks,
				title,
				ownerBlockName,
				record,
				postId,
			} );
			if ( ! clientId ) {
				// Header repair will update the block list and rerun this effect. Leave
				// the request pending until a title or body block exists.
				return;
			}

			// Reset the selection across a paint so the current document can receive
			// focus again. Keep the token pending until focus returns so later input
			// can still cancel it.
			cancelScheduledFocus = scheduleDocumentSurfaceFocus( {
				clientId,
				completeSurfaceFocus,
				originIsCurrent: () =>
					Boolean( canvasRootRef.current?.isConnected ) &&
					originIsCurrent(),
				ownerWindow,
				requestIsCurrent,
				selectBlock,
				token,
			} );
		}

		focusDocumentSurface();
		return () => {
			cancelled = true;
			cancelScheduledFocus?.();
		};
	}, [
		blocks,
		canvasRootRef,
		completeSurfaceFocus,
		isActive,
		isEditorSurfaceDisplayed,
		isReadOnly,
		isSurfaceFocusPending,
		ownerBlockName,
		postId,
		record,
		selectBlock,
		surfaceFocusRequest,
		title,
	] );

	return null;
}

function CanvasReadyEffect( {
	featuredMedia,
	postId,
	postType,
	canvasRootRef,
	ownerContentReady = true,
	onReady,
} ) {
	const [ featuredId ] = useEntityProp(
		'postType',
		postType,
		'featured_media',
		postId
	);
	const [ meta ] = useEntityProp( 'postType', postType, 'meta', postId );
	const numericFeaturedId = Number( featuredId ?? featuredMedia ) || 0;
	const needsCover = numericFeaturedId > 0;
	const needsIcon = Boolean( meta?.cortext_document_icon );
	const iconNeedsImage =
		parseDocumentIcon( meta?.cortext_document_icon )?.type === 'image';
	const propertiesCtx = useDocumentPropertiesContext();
	const isPropertiesResolving = Boolean( propertiesCtx?.isResolving );
	const needsProperties =
		! isPropertiesResolving &&
		Array.isArray( propertiesCtx?.fields ) &&
		propertiesCtx.fields.length > 0;
	const record = useDocumentRecord( postType, postId );
	const ownerBlockName = getCanvasOwnerBlockNameForRecord( record );
	const needsOwner = Boolean( ownerBlockName );
	const {
		record: coverMedia,
		isResolving: isResolvingCoverMedia,
		hasResolved: hasResolvedCoverMedia,
	} = useEntityRecord( 'root', 'media', numericFeaturedId, {
		enabled: needsCover,
	} );
	const src = coverSource( coverMedia );
	const { hasCover, hasIcon, hasTitle, hasProperties, hasOwner } = useSelect(
		( select ) => {
			const blocks = select( blockEditorStore ).getBlocks();
			return {
				hasCover: blocks.some(
					( block ) => block.name === DOCUMENT_COVER_BLOCK
				),
				hasIcon: blocks.some(
					( block ) => block.name === DOCUMENT_ICON_BLOCK
				),
				hasTitle: blocks.some(
					( block ) => block.name === POST_TITLE_BLOCK
				),
				hasProperties: blocks.some(
					( block ) => block.name === DOCUMENT_PROPERTIES_BLOCK
				),
				hasOwner: ownerBlockName
					? Boolean( findCanvasOwnerBlock( blocks, record, postId ) )
					: true,
			};
		},
		[ ownerBlockName, postId, record ]
	);
	const isCoverRecordReady =
		! needsCover ||
		Boolean( src ) ||
		( ! isResolvingCoverMedia && hasResolvedCoverMedia );
	const areHeaderBlocksReady = areCanvasReadyRequirementsMet( {
		hasTitle,
		needsCover,
		hasCover,
		needsIcon,
		hasIcon,
		isCoverRecordReady,
		isPropertiesResolving,
		needsProperties,
		hasProperties,
		needsOwner,
		hasOwner,
		isOwnerContentReady: ownerContentReady,
	} );

	useLayoutEffect( () => {
		if ( ! areHeaderBlocksReady ) {
			return undefined;
		}

		let cancelled = false;
		async function signalReady() {
			if ( ( needsCover && src ) || iconNeedsImage ) {
				await waitForCriticalImages( canvasRootRef.current, src, {
					iconNeedsImage,
				} );
			}
			await afterNextPaint(
				canvasRootRef.current?.ownerDocument?.defaultView
			);
			if ( ! cancelled ) {
				onReady?.( postId, postType );
			}
		}
		signalReady();
		return () => {
			cancelled = true;
		};
	}, [
		areHeaderBlocksReady,
		canvasRootRef,
		featuredMedia,
		iconNeedsImage,
		needsCover,
		onReady,
		postId,
		postType,
		src,
	] );

	return null;
}

export default function EditorBody( {
	featuredMedia,
	isActive = true,
	isEditorSurfaceDisplayed = false,
	isDocumentCanvas = false,
	isLocked = false,
	isSurfaceFocusPending = false,
	showIdentityActions = true,
	postId,
	postType,
	extraStyles,
	surfaceFocusRequest = null,
	completeSurfaceFocus = null,
	onReady,
	onRestored,
} ) {
	const baseStyles = useSelect(
		( select ) => select( editorStore ).getEditorSettings().styles,
		[]
	);
	const styles = useEditorBodyStyles(
		baseStyles,
		extraStyles,
		isDocumentCanvas
	);
	const { themeSupportsLayout, hasRootPaddingAwareAlignments } = useSelect(
		( select ) => {
			const settings = select( blockEditorStore ).getSettings();
			return {
				themeSupportsLayout: settings.supportsLayout,
				hasRootPaddingAwareAlignments:
					settings.__experimentalFeatures
						?.useRootPaddingAwareAlignments,
			};
		},
		[]
	);
	const [ globalLayoutSettings ] = useSettings( 'layout' );
	// Match @wordpress/editor's visual-editor fallback. Themes with layout
	// support get the constrained post-content canvas; classic themes keep the
	// default flow layout.
	const canvasLayout = themeSupportsLayout
		? { type: 'constrained', ...globalLayoutSettings }
		: { type: 'default' };
	const canvasClassName = [
		'wp-block-post-content',
		themeSupportsLayout ? 'is-layout-constrained' : 'is-layout-flow',
		hasRootPaddingAwareAlignments ? 'has-global-padding' : '',
	]
		.filter( Boolean )
		.join( ' ' );
	const blockCanvasRef = useRef( null );
	const [ readyOwnerKey, setReadyOwnerKey ] = useState( null );
	const isTrashed = useSelect(
		( select ) =>
			select( editorStore ).getCurrentPostAttribute( 'status' ) ===
			'trash',
		[]
	);
	const isReadOnly = isTrashed || isLocked;
	const record = useDocumentRecord( postType, postId );
	const ownerBlockName = getCanvasOwnerBlockNameForRecord( record );
	const ownerKey = ownerBlockName ? `${ postType }:${ postId }` : null;
	const ownerContentReady = ! ownerKey || readyOwnerKey === ownerKey;
	const signalCollectionReady = useCallback(
		( collectionId ) => {
			if ( Number( collectionId ) === Number( postId ) ) {
				setReadyOwnerKey( ownerKey );
			}
		},
		[ ownerKey, postId ]
	);
	const canvasReadySignals = useMemo(
		() => ( {
			signalCollectionReady,
			surfaceFocusRequest,
			isEditorSurfaceDisplayed,
			isSurfaceFocusPending,
			isSurfaceFocusReadOnly: isReadOnly,
			completeSurfaceFocus,
		} ),
		[
			completeSurfaceFocus,
			isEditorSurfaceDisplayed,
			isReadOnly,
			isSurfaceFocusPending,
			signalCollectionReady,
			surfaceFocusRequest,
		]
	);
	const shouldUseHeaderAwareAppender = useSelect(
		( select ) => {
			if ( ownerBlockName ) {
				return false;
			}
			const blocks = select( blockEditorStore ).getBlocks();
			return (
				blocks.length > 0 &&
				blocks.every( ( block ) =>
					isHeaderChromeBlock( block, ownerBlockName, record, postId )
				)
			);
		},
		[ ownerBlockName, postId, record ]
	);
	const renderAppender =
		shouldUseHeaderAwareAppender && ! isReadOnly
			? () => (
					<HeaderAwareRootAppender
						ownerBlockName={ ownerBlockName }
						postId={ postId }
						record={ record }
					/>
			  )
			: undefined;

	const blockCanvas = (
		<CanvasReadyProvider value={ canvasReadySignals }>
			<div
				className="cortext-canvas__block-canvas"
				ref={ blockCanvasRef }
			>
				<BlockCanvas height="100%" styles={ styles }>
					<BlockCanvasStyleProvider>
						<CanvasMenuToolbarGuard />
						{ showIdentityActions ? (
							<DocumentIdentityActions
								isLocked={ isReadOnly }
								postId={ postId }
								postType={ postType }
							/>
						) : null }
						<EnsureHeaderBlocks
							isLocked={ isReadOnly }
							postId={ postId }
							postType={ postType }
						/>
						<HideHeaderBlockKebab
							postId={ postId }
							postType={ postType }
						/>
						<ProtectedBlockShortcutGuard
							postId={ postId }
							postType={ postType }
							canvasRootRef={ blockCanvasRef }
						/>
						<HeaderPrefixToolbarGuard
							isActive={ isActive }
							isLocked={ isReadOnly }
							postId={ postId }
							postType={ postType }
							toolbarRootRef={ blockCanvasRef }
						/>
						<div
							className={ [
								'cortext-canvas__editor',
								ownerBlockName
									? 'cortext-canvas__editor--owner'
									: '',
							]
								.filter( Boolean )
								.join( ' ' ) }
						>
							<BlockList
								className={ canvasClassName }
								layout={ canvasLayout }
								renderAppender={ renderAppender }
							/>
						</div>
						<DocumentSurfaceFocusEffect
							isActive={ isActive }
							isEditorSurfaceDisplayed={
								isEditorSurfaceDisplayed
							}
							isReadOnly={ isReadOnly }
							isSurfaceFocusPending={ isSurfaceFocusPending }
							postId={ postId }
							ownerBlockName={ ownerBlockName }
							record={ record }
							canvasRootRef={ blockCanvasRef }
							surfaceFocusRequest={ surfaceFocusRequest }
							completeSurfaceFocus={ completeSurfaceFocus }
						/>
						<CanvasReadyEffect
							featuredMedia={ featuredMedia }
							postId={ postId }
							postType={ postType }
							canvasRootRef={ blockCanvasRef }
							ownerContentReady={ ownerContentReady }
							onReady={ onReady }
						/>
					</BlockCanvasStyleProvider>
				</BlockCanvas>
			</div>
		</CanvasReadyProvider>
	);

	return (
		<div className="cortext-canvas__visual">
			{ isTrashed && (
				<TrashedNotice
					postId={ postId }
					postType={ postType }
					onRestored={ onRestored }
				/>
			) }
			{ isReadOnly ? (
				<Disabled className="cortext-canvas__locked">
					{ blockCanvas }
				</Disabled>
			) : (
				blockCanvas
			) }
		</div>
	);
}
