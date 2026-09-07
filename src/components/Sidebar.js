import { __, _n, sprintf } from '@wordpress/i18n';
import { useEntityRecords } from '@wordpress/core-data';
import { useDispatch } from '@wordpress/data';
import {
	lazy,
	Suspense,
	useState,
	useMemo,
	useCallback,
	useEffect,
} from '@wordpress/element';
import { useParams } from '@tanstack/react-router';
import {
	Button,
	Dropdown,
	Icon,
	MenuGroup,
	MenuItem,
	Notice,
} from '@wordpress/components';
import { displayShortcut } from '@wordpress/keycodes';
import {
	chevronDown,
	cog,
	home as homeIcon,
	page,
	plus,
	search,
	trash as trashIcon,
	wordpress,
} from '@wordpress/icons';

import './Sidebar.scss';

// The aria-label, rather than the icon, communicates the collapsed state.
const sidebarToggleIcon = (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		width="24"
		height="24"
		aria-hidden="true"
		focusable="false"
	>
		<rect
			x="4"
			y="5"
			width="16"
			height="14"
			rx="2"
			stroke="currentColor"
			strokeWidth="1.5"
			fill="none"
		/>
		<line
			x1="9"
			y1="5"
			x2="9"
			y2="19"
			stroke="currentColor"
			strokeWidth="1.5"
		/>
	</svg>
);

import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';

import { openCommandPalette } from './CommandPalette';
import { collectionIcon } from './cortextIcons';
import SidebarFavorites from './SidebarFavorites';
import SidebarResizeHandle from './SidebarResizeHandle';
import SidebarRecents from './SidebarRecents';
import SidebarSection from './SidebarSection';
import SidebarSettingsNav from './SidebarSettingsNav';
import { SidebarListSkeleton } from './Skeleton';
import SidebarTrash, { computeSidebarTrashRoots } from './SidebarTrash';
import ThemeToggle from './ThemeToggle';
import {
	computeDocumentUri,
	isSettingsUri,
	parseIdFromUri,
	parseSplatUri,
	SETTINGS_URI,
} from '../router/useResolveEntity';
import { DOCUMENT_POST_TYPE, FULL_PAGE_COLLECTION_QUERY } from '../collections';
import useDelayedFlag, {
	SKELETON_MIN_VISIBLE_MS,
} from '../hooks/useDelayedFlag';
import { useFavorites } from '../hooks/useFavorites';
import useSidebarSections from '../hooks/useSidebarSections';
import useTrashedDocuments from '../hooks/useTrashedDocuments';
import { useWorkspaceHome } from '../hooks/useWorkspaceHome';
import {
	DocumentsProvider,
	favoriteIdentForRecord,
	favoriteKey,
	favoriteKeyForRecord,
	useCreateCollectionDocument,
	useCreateDocument,
	useDocumentSelection,
	useFavoriteToggle,
} from '../documents';
import {
	createTemplate,
	notifyTemplatesChanged,
	TEMPLATE_KIND_PAGE,
	TEMPLATES_EXPERIMENT_ID,
	useInstantiateTemplate,
	useTemplates,
} from '../templates';
import useSidebarDnd from './sidebar/useSidebarDnd';
import useSidebarNavigation from './sidebar/useSidebarNavigation';
import useSidebarTree, { ROOT_PARENT_ID } from './sidebar/useSidebarTree';
import DocumentRow from './sidebar/DocumentRow';
import {
	isExperimentEnabled,
	isWordPressAffordancesEnabled,
} from '../settings';
import { useSurfaceFocusIntent } from './SurfaceFocusContext';

const TemplateEditorModal = lazy( () =>
	import( /* webpackChunkName: "editor" */ './TemplateEditorModal' )
);

export default function Sidebar( {
	collapsed = false,
	width,
	onToggleCollapsed,
	onWidthChange,
} ) {
	// Favorites still needs collection labels. The Documents tree below loads
	// lazily through useSidebarTree.
	const { records: collections, isResolving: isResolvingCollections } =
		useEntityRecords(
			'postType',
			DOCUMENT_POST_TYPE,
			FULL_PAGE_COLLECTION_QUERY
		);
	const trashedDocumentsState = useTrashedDocuments();
	const params = useParams( { strict: false } );
	const routeUri = params._splat ?? '';
	const { prefix: routePrefix, tail: routeTail } = useMemo(
		() => parseSplatUri( routeUri ),
		[ routeUri ]
	);
	const routeSelectedId = useMemo(
		() =>
			routePrefix === 'page' || routePrefix === null
				? parseIdFromUri( routeTail )
				: null,
		[ routePrefix, routeTail ]
	);
	const routeSelectedCollectionId = useMemo(
		() =>
			routePrefix === 'collection' ? parseIdFromUri( routeTail ) : null,
		[ routePrefix, routeTail ]
	);
	const {
		home,
		setHome,
		isResolving: isResolvingHome,
		isUpdating: isHomeUpdating,
	} = useWorkspaceHome();
	const {
		favorites,
		setFavorites,
		isResolving: isResolvingFavorites,
	} = useFavorites();
	const { saveEntityRecord } = useDispatch( 'core' );
	const {
		tree,
		pages,
		rootBranch,
		isResolvingPages,
		expandedIds,
		toggleExpand,
		expand,
		loadBranch,
		loadMore,
		refreshBranch,
		getBranch,
	} = useSidebarTree( {
		selectedId: routeSelectedId,
		selectedCollectionId: routeSelectedCollectionId,
	} );
	const fallbackHomePage = tree[ 0 ]?.page ?? null;
	const homePath =
		home?.path ??
		( fallbackHomePage ? computeDocumentUri( fallbackHomePage ) : null );
	const isResolvingHomePath =
		isResolvingHome || ( ! home?.path && isResolvingPages );
	const showPagesSkeleton = useDelayedFlag(
		isResolvingPages && pages.length === 0,
		120,
		SKELETON_MIN_VISIBLE_MS
	);
	const { navigate, selectedId, selectedCollectionId, onSelect, goHome } =
		useSidebarNavigation( { pages, homePath } );
	const { requestFromActivation } = useSurfaceFocusIntent();
	const homeDocumentId = home?.id ?? fallbackHomePage?.id ?? null;
	const openHome = useCallback(
		( event ) => {
			requestFromActivation( event, homeDocumentId );
			goHome();
		},
		[ goHome, homeDocumentId, requestFromActivation ]
	);
	const { isSelected: isRowSelected, selectRecord: onRowSelect } =
		useDocumentSelection( { selectedId, selectedCollectionId } );
	const adminUrl = window.cortextSettings?.adminUrl ?? '/wp-admin/';
	const brandIconUrl = window.cortextSettings?.iconUrl ?? '';
	const wordpressAffordances = isWordPressAffordancesEnabled();
	const commandPaletteShortcut = displayShortcut.primary( 'k' );
	const brandLabel = __( 'Cortext', 'cortext' );
	const isSettingsMode = isSettingsUri( routeUri );
	const templatesEnabled = isExperimentEnabled( TEMPLATES_EXPERIMENT_ID );
	const { templates: pageTemplates } = useTemplates( {
		kind: TEMPLATE_KIND_PAGE,
		enabled: templatesEnabled,
	} );
	const instantiateTemplate = useInstantiateTemplate();

	const [ favoritesError, setFavoritesError ] = useState( null );
	const [ duplicateNotice, setDuplicateNotice ] = useState( null );
	const [ templateNotice, setTemplateNotice ] = useState( null );
	const [ isCreatingTemplate, setIsCreatingTemplate ] = useState( false );
	const [ editingTemplateId, setEditingTemplateId ] = useState( null );
	const [ settingsReturnUri, setSettingsReturnUri ] = useState( null );
	const {
		isFavorite,
		toggle: toggleFavorite,
		disabled: areFavoriteActionsDisabled,
	} = useFavoriteToggle( { onError: setFavoritesError } );
	const { isSectionCollapsed, toggleSection } = useSidebarSections();
	const openSettings = useCallback( () => {
		if ( isSettingsMode ) {
			return;
		}
		setSettingsReturnUri( routeUri );
		navigate( {
			to: '/$',
			params: { _splat: SETTINGS_URI },
		} );
	}, [ isSettingsMode, navigate, routeUri ] );
	const closeSettings = useCallback( () => {
		const returnUri = settingsReturnUri;
		setSettingsReturnUri( null );
		if ( returnUri ) {
			navigate( {
				to: '/$',
				params: { _splat: returnUri },
			} );
			return;
		}
		navigate( { to: '/' } );
	}, [ navigate, settingsReturnUri ] );
	const toggleTrashPanel = useCallback( () => {
		if ( collapsed ) {
			setIsTrashPanelOpen( true );
			onToggleCollapsed?.();
			return;
		}
		setIsTrashPanelOpen( ( current ) => ! current );
	}, [ collapsed, onToggleCollapsed ] );

	const reorderFavorites = useCallback(
		async ( next ) => {
			if ( areFavoriteActionsDisabled ) {
				return;
			}
			setFavoritesError( null );
			try {
				await setFavorites( next );
			} catch ( err ) {
				setFavoritesError(
					err?.message ??
						__( 'Could not reorder favorites.', 'cortext' )
				);
			}
		},
		[ areFavoriteActionsDisabled, setFavorites ]
	);
	const selectFavorite = useCallback(
		( favorite ) => {
			// Post IDs are global, so a shared predicate cannot select two records.
			if ( isRowSelected( favorite ) ) {
				return false;
			}
			navigate( {
				to: '/$',
				params: { _splat: favorite.path },
			} );
			return true;
		},
		[ isRowSelected, navigate ]
	);

	// These values appear in dependency arrays below, so initialize them before
	// React evaluates those arrays and hits their temporal dead zone.
	const { sensors, draggedId, draggedPage, activeDrop, handlers } =
		useSidebarDnd( {
			pages,
			expandedIds,
			expand,
			loadBranch,
			refreshBranch,
			getBranch,
			saveEntityRecord,
		} );

	const [ autoRenameId, setAutoRenameId ] = useState( null );
	const [ isTrashPanelOpen, setIsTrashPanelOpen ] = useState( false );
	const trashCount = useMemo( () => {
		if ( Array.isArray( trashedDocumentsState.documents ) ) {
			return computeSidebarTrashRoots( trashedDocumentsState.documents )
				.roots.length;
		}
		return trashedDocumentsState.total;
	}, [ trashedDocumentsState.documents, trashedDocumentsState.total ] );
	let trashButtonLabel = __( 'Open Trash', 'cortext' );
	if ( isTrashPanelOpen ) {
		trashButtonLabel = __( 'Close Trash', 'cortext' );
	} else if ( trashCount > 0 ) {
		trashButtonLabel = sprintf(
			/* translators: %d: number of trashed pages and rows */
			_n(
				'Open Trash, %d item',
				'Open Trash, %d items',
				trashCount,
				'cortext'
			),
			trashCount
		);
	}

	useEffect( () => {
		if ( collapsed ) {
			setIsTrashPanelOpen( false );
		}
	}, [ collapsed ] );

	useEffect( () => {
		if ( ! isSettingsMode ) {
			return;
		}

		const handleKeyDown = ( event ) => {
			if ( event.key !== 'Escape' || event.defaultPrevented ) {
				return;
			}

			const target = event.target;
			const targetElement =
				target instanceof window.HTMLElement ? target : null;
			if (
				targetElement?.isContentEditable ||
				targetElement?.closest( 'input, textarea, select' )
			) {
				return;
			}

			closeSettings();
		};

		window.addEventListener( 'keydown', handleKeyDown );
		return () => {
			window.removeEventListener( 'keydown', handleKeyDown );
		};
	}, [ closeSettings, isSettingsMode ] );

	const onSetRowHome = useCallback(
		async ( record ) => {
			const ident = favoriteIdentForRecord( record );
			if ( ! ident ) {
				return;
			}
			try {
				await setHome( ident );
			} catch {}
		},
		[ setHome ]
	);

	const isRowHome = useCallback(
		( record ) => {
			if ( ! home ) {
				return false;
			}
			return favoriteKey( home ) === favoriteKeyForRecord( record );
		},
		[ home ]
	);

	const documentsHandlers = useMemo(
		() => ( {
			selectedCollectionId,
			expand,
			onSelect,
			onAutoRename: ( target ) => setAutoRenameId( target?.id ?? null ),
			onAfterTrash: () => setIsTrashPanelOpen( true ),
			onDuplicateNotice: setDuplicateNotice,
			onFavoritesError: setFavoritesError,
		} ),
		[ selectedCollectionId, expand, onSelect ]
	);

	const create = useCreateDocument();
	const createCollection = useCreateCollectionDocument();
	const openAfterCreate = useCallback(
		( created ) => {
			if ( created?.id ) {
				setAutoRenameId( created.id );
				navigate( {
					to: '/$',
					params: { _splat: computeDocumentUri( created ) },
				} );
			}
			return created;
		},
		[ navigate ]
	);
	const createAndOpen = useCallback(
		async ( input ) => {
			const created = await create( input );
			refreshBranch( created?.parent ?? input?.parent ?? ROOT_PARENT_ID );
			return openAfterCreate( created );
		},
		[ create, openAfterCreate, refreshBranch ]
	);
	const createFromTemplateAndOpen = useCallback(
		async ( template, input = {} ) => {
			if ( ! template?.id ) {
				return createAndOpen( input );
			}
			const created = await instantiateTemplate( template.id, input );
			refreshBranch( created?.parent ?? input?.parent ?? ROOT_PARENT_ID );
			return openAfterCreate( created );
		},
		[ createAndOpen, instantiateTemplate, openAfterCreate, refreshBranch ]
	);
	const createCollectionAndOpen = useCallback(
		async ( input ) => {
			const created = await createCollection( input );
			refreshBranch( created?.parent ?? input?.parent ?? ROOT_PARENT_ID );
			return openAfterCreate( created );
		},
		[ createCollection, openAfterCreate, refreshBranch ]
	);
	const createRootPage = useCallback(
		() => createAndOpen( {} ),
		[ createAndOpen ]
	);
	const createRootCollection = useCallback(
		() => createCollectionAndOpen( {} ),
		[ createCollectionAndOpen ]
	);
	const createChildPage = useCallback(
		( parentId ) => createAndOpen( { parent: parentId } ),
		[ createAndOpen ]
	);
	const createChildCollection = useCallback(
		( parentId ) => createCollectionAndOpen( { parent: parentId } ),
		[ createCollectionAndOpen ]
	);
	const createPageTemplate = useCallback( async () => {
		setIsCreatingTemplate( true );
		setTemplateNotice( null );
		try {
			const template = await createTemplate( {
				kind: TEMPLATE_KIND_PAGE,
				title: __( 'Untitled template', 'cortext' ),
			} );
			notifyTemplatesChanged( { kind: TEMPLATE_KIND_PAGE } );
			if ( template?.id ) {
				setEditingTemplateId( template.id );
			}
		} catch ( error ) {
			setTemplateNotice(
				error?.message ??
					__( "Couldn't create the template.", 'cortext' )
			);
		} finally {
			setIsCreatingTemplate( false );
		}
	}, [] );

	const rowChrome = {
		expandedIds,
		draggedId,
		activeDrop,
		isSelected: isRowSelected,
		onSelect: onRowSelect,
		onToggleExpand: toggleExpand,
		onLoadMore: loadMore,
		isFavorite,
		isFavoriteDisabled: areFavoriteActionsDisabled,
		onToggleFavorite: toggleFavorite,
		isHome: isRowHome,
		onSetHome: onSetRowHome,
		isHomeUpdating,
		autoRenameId,
		onAutoRenameConsumed: () => setAutoRenameId( null ),
		onCreateChild: createChildPage,
		...( templatesEnabled
			? {
					onCreateBlankChild: createChildPage,
					pageTemplates,
					onCreateChildFromTemplate: ( parentId, template ) =>
						createFromTemplateAndOpen( template, {
							parent: parentId,
						} ),
			  }
			: {} ),
		onCreateChildCollection: createChildCollection,
	};

	return (
		<aside
			id="cortext-sidebar"
			className="cortext-sidebar"
			data-collapsed={ collapsed ? 'true' : 'false' }
		>
			<div className="cortext-sidebar__header">
				{ ! collapsed && (
					<span className="cortext-sidebar__brand">
						<span
							className="cortext-sidebar__brand-mark"
							aria-hidden="true"
						>
							{ brandIconUrl ? (
								<img
									className="cortext-sidebar__brand-image"
									src={ brandIconUrl }
									alt=""
								/>
							) : (
								<span className="cortext-sidebar__brand-initial">
									C
								</span>
							) }
						</span>
						<span className="cortext-sidebar__brand-text">
							{ brandLabel }
						</span>
					</span>
				) }
				<Button
					className="cortext-sidebar__collapse-toggle"
					icon={ sidebarToggleIcon }
					label={
						collapsed
							? __( 'Expand sidebar', 'cortext' )
							: __( 'Collapse sidebar', 'cortext' )
					}
					onClick={ onToggleCollapsed }
				/>
			</div>
			<div
				className="cortext-sidebar__views"
				data-settings={ isSettingsMode ? 'true' : 'false' }
			>
				<div
					className="cortext-sidebar__view cortext-sidebar__view--main"
					aria-hidden={ isSettingsMode }
					{ ...( isSettingsMode ? { inert: '' } : {} ) }
				>
					<div
						className="cortext-sidebar__quick-actions"
						role="toolbar"
						aria-label={ __( 'Quick actions', 'cortext' ) }
					>
						<Button
							className="cortext-sidebar__quick-action cortext-sidebar__quick-action--search"
							label={ __( 'Search or run a command', 'cortext' ) }
							onClick={ () => openCommandPalette() }
						>
							<Icon icon={ search } size={ 16 } />
							{ ! collapsed && (
								<>
									<span className="cortext-sidebar__quick-action-label">
										{ __(
											'Search or run a command',
											'cortext'
										) }
									</span>
									<kbd className="cortext-sidebar__quick-action-kbd">
										{ commandPaletteShortcut }
									</kbd>
								</>
							) }
						</Button>
						<Button
							className="cortext-sidebar__quick-action cortext-sidebar__quick-action--home"
							label={ __( 'Home', 'cortext' ) }
							disabled={ ! homePath || isResolvingHomePath }
							onClick={ openHome }
						>
							<Icon icon={ homeIcon } size={ 16 } />
							{ ! collapsed && (
								<span>{ __( 'Home', 'cortext' ) }</span>
							) }
						</Button>
					</div>
					{ ! collapsed && (
						<DocumentsProvider { ...documentsHandlers }>
							<div className="cortext-sidebar__content">
								{ favoritesError ? (
									<Notice
										status="error"
										onRemove={ () =>
											setFavoritesError( null )
										}
									>
										{ favoritesError }
									</Notice>
								) : null }
								{ duplicateNotice ? (
									<Notice
										status="warning"
										onRemove={ () =>
											setDuplicateNotice( null )
										}
									>
										{ duplicateNotice }
									</Notice>
								) : null }
								{ templatesEnabled && templateNotice ? (
									<Notice
										status="error"
										onRemove={ () =>
											setTemplateNotice( null )
										}
									>
										{ templateNotice }
									</Notice>
								) : null }
								<SidebarSection
									id="recents"
									title={ __( 'Recents', 'cortext' ) }
									isCollapsed={ isSectionCollapsed(
										'recents'
									) }
									onToggle={ () =>
										toggleSection( 'recents' )
									}
								>
									<SidebarRecents />
								</SidebarSection>

								<SidebarSection
									id="favorites"
									title={ __( 'Favorites', 'cortext' ) }
									isCollapsed={ isSectionCollapsed(
										'favorites'
									) }
									onToggle={ () =>
										toggleSection( 'favorites' )
									}
								>
									<SidebarFavorites
										favorites={ favorites }
										pages={ pages }
										collections={ collections ?? [] }
										isResolving={ isResolvingFavorites }
										isResolvingItems={
											isResolvingPages ||
											isResolvingCollections
										}
										isDisabled={
											areFavoriteActionsDisabled
										}
										onSelect={ selectFavorite }
										onRemove={ toggleFavorite }
										onReorder={ reorderFavorites }
									/>
								</SidebarSection>

								<DndContext
									sensors={ sensors }
									collisionDetection={ pointerWithin }
									onDragStart={ handlers.handleDragStart }
									onDragOver={ handlers.handleDragOver }
									onDragEnd={ handlers.handleDragEnd }
									onDragCancel={ handlers.handleDragCancel }
								>
									<SidebarSection
										id="pages"
										title={ __( 'Documents', 'cortext' ) }
										isCollapsed={ isSectionCollapsed(
											'pages'
										) }
										onToggle={ () =>
											toggleSection( 'pages' )
										}
										actions={
											<div className="cortext-sidebar__split-action">
												<Button
													className="cortext-sidebar__section-action cortext-sidebar__split-action-primary"
													icon={ plus }
													size="small"
													label={ __(
														'New document',
														'cortext'
													) }
													onClick={ createRootPage }
												/>
												<Dropdown
													contentClassName="cortext-sidebar__create-menu"
													popoverProps={ {
														placement: 'bottom-end',
													} }
													renderToggle={ ( {
														isOpen,
														onToggle,
													} ) => (
														<Button
															className="cortext-sidebar__section-action cortext-sidebar__split-action-toggle"
															icon={ chevronDown }
															size="small"
															label={ __(
																'Create a document or collection',
																'cortext'
															) }
															onClick={ onToggle }
															isPressed={ isOpen }
															aria-expanded={
																isOpen
															}
														/>
													) }
													renderContent={ ( {
														onClose,
													} ) =>
														templatesEnabled ? (
															<>
																<MenuGroup>
																	<MenuItem
																		icon={
																			page
																		}
																		onClick={ () => {
																			createRootPage();
																			onClose();
																		} }
																	>
																		{ __(
																			'Blank document',
																			'cortext'
																		) }
																	</MenuItem>
																	{ pageTemplates.map(
																		(
																			template
																		) => (
																			<MenuItem
																				key={
																					template.id
																				}
																				icon={
																					page
																				}
																				onClick={ () => {
																					createFromTemplateAndOpen(
																						template
																					);
																					onClose();
																				} }
																			>
																				{ sprintf(
																					/* translators: %s: template title */
																					__(
																						'Create from %s',
																						'cortext'
																					),
																					template.title ||
																						__(
																							'Untitled template',
																							'cortext'
																						)
																				) }
																			</MenuItem>
																		)
																	) }
																	<MenuItem
																		icon={
																			page
																		}
																		disabled={
																			isCreatingTemplate
																		}
																		onClick={ () => {
																			createPageTemplate();
																			onClose();
																		} }
																	>
																		{ __(
																			'New template',
																			'cortext'
																		) }
																	</MenuItem>
																</MenuGroup>
																<MenuGroup>
																	<MenuItem
																		icon={
																			collectionIcon
																		}
																		onClick={ () => {
																			createRootCollection();
																			onClose();
																		} }
																	>
																		{ __(
																			'New collection',
																			'cortext'
																		) }
																	</MenuItem>
																</MenuGroup>
															</>
														) : (
															<MenuGroup>
																<MenuItem
																	icon={
																		page
																	}
																	onClick={ () => {
																		createRootPage();
																		onClose();
																	} }
																>
																	{ __(
																		'New document',
																		'cortext'
																	) }
																</MenuItem>
																<MenuItem
																	icon={
																		collectionIcon
																	}
																	onClick={ () => {
																		createRootCollection();
																		onClose();
																	} }
																>
																	{ __(
																		'New collection',
																		'cortext'
																	) }
																</MenuItem>
															</MenuGroup>
														)
													}
												/>
											</div>
										}
									>
										{ isResolvingPages &&
											pages.length === 0 &&
											showPagesSkeleton && (
												<SidebarListSkeleton
													itemCount={ 1 }
												/>
											) }
										{ ! isResolvingPages &&
											pages.length === 0 && (
												<p className="cortext-sidebar__empty">
													{ __(
														'Nothing here yet.',
														'cortext'
													) }
												</p>
											) }
										{ rootBranch.error && (
											<p
												className="cortext-sidebar__row-error"
												role="alert"
											>
												{ __(
													"We couldn't load these documents.",
													'cortext'
												) }
											</p>
										) }

										<ul className="cortext-sidebar__list">
											{ tree.map( ( node ) => (
												<DocumentRow
													key={ node.page.id }
													record={ node.page }
													childNodes={ node.children }
													childBranch={ node.branch }
													depth={ 0 }
													{ ...rowChrome }
												/>
											) ) }
											{ rootBranch.hasResolved &&
												rootBranch.page <
													rootBranch.totalPages && (
													<li
														className="cortext-sidebar__node cortext-sidebar__load-more-node"
														style={ {
															'--cortext-depth': 0,
														} }
													>
														<Button
															className="cortext-sidebar__load-more"
															size="compact"
															isBusy={
																rootBranch.isLoading
															}
															disabled={
																rootBranch.isLoading
															}
															onClick={ () =>
																loadMore(
																	ROOT_PARENT_ID
																)
															}
														>
															{ __(
																'Show more',
																'cortext'
															) }
														</Button>
													</li>
												) }
										</ul>
									</SidebarSection>

									<DragOverlay>
										{ draggedPage ? (
											<div className="cortext-sidebar__drag-preview">
												{ draggedPage.title?.rendered?.trim() ||
													__(
														'(untitled)',
														'cortext'
													) }
											</div>
										) : null }
									</DragOverlay>
								</DndContext>
							</div>
							{ isTrashPanelOpen && (
								<section
									id="cortext-sidebar-trash-panel"
									className="cortext-sidebar__trash-panel"
									aria-label={ __( 'Trash', 'cortext' ) }
								>
									<div className="cortext-sidebar__trash-panel-header">
										<h2 className="cortext-sidebar__section-title">
											{ __( 'Trash', 'cortext' ) }
										</h2>
									</div>
									<SidebarTrash
										activePages={ pages }
										selectedId={ selectedId }
										selectedCollectionId={
											selectedCollectionId
										}
										onSelect={ onSelect }
										trashedDocumentsState={
											trashedDocumentsState
										}
									/>
								</section>
							) }
						</DocumentsProvider>
					) }
					<div className="cortext-sidebar__footer">
						<div className="cortext-sidebar__footer-group cortext-sidebar__footer-group--navigation">
							<Button
								className="cortext-sidebar__footer-button cortext-sidebar__trash-footer"
								label={ trashButtonLabel }
								aria-expanded={
									! collapsed && isTrashPanelOpen
								}
								aria-controls="cortext-sidebar-trash-panel"
								isPressed={ ! collapsed && isTrashPanelOpen }
								onClick={ toggleTrashPanel }
							>
								<Icon icon={ trashIcon } size={ 20 } />
								{ trashCount > 0 && (
									<span
										className="cortext-sidebar__footer-count"
										aria-hidden="true"
									>
										{ trashCount > 99 ? '99+' : trashCount }
									</span>
								) }
							</Button>
						</div>
						<div className="cortext-sidebar__footer-spacer" />
						<div
							className="cortext-sidebar__footer-separator"
							aria-hidden="true"
						/>
						<div className="cortext-sidebar__footer-group cortext-sidebar__footer-group--preferences">
							<Button
								className="cortext-sidebar__footer-button cortext-sidebar__settings-toggle"
								label={ __( 'Settings', 'cortext' ) }
								isPressed={ isSettingsMode }
								onClick={ openSettings }
							>
								<Icon icon={ cog } size={ 20 } />
							</Button>
							<ThemeToggle />
							{ wordpressAffordances ? (
								<Button
									className="cortext-sidebar__back"
									label={ __( 'Go to WordPress', 'cortext' ) }
									href={ adminUrl }
									icon={
										<Icon icon={ wordpress } size={ 24 } />
									}
								/>
							) : null }
						</div>
					</div>
				</div>
				<div
					className="cortext-sidebar__view cortext-sidebar__view--settings"
					aria-hidden={ ! isSettingsMode }
					{ ...( isSettingsMode ? {} : { inert: '' } ) }
				>
					<SidebarSettingsNav
						collapsed={ collapsed }
						onBack={ closeSettings }
					/>
				</div>
			</div>
			{ ! collapsed && (
				<SidebarResizeHandle
					width={ width }
					onChange={ onWidthChange }
					onToggleCollapsed={ onToggleCollapsed }
				/>
			) }
			{ templatesEnabled && editingTemplateId ? (
				<Suspense fallback={ null }>
					<TemplateEditorModal
						kind={ TEMPLATE_KIND_PAGE }
						templateId={ editingTemplateId }
						onClose={ () => setEditingTemplateId( null ) }
					/>
				</Suspense>
			) : null }
		</aside>
	);
}
