import { __, sprintf } from '@wordpress/i18n';
import {
	Button,
	Dropdown,
	MenuGroup,
	MenuItem,
	TextControl,
} from '@wordpress/components';
import { useEffect, useRef, useState } from '@wordpress/element';
import {
	chevronRight,
	home as homeIcon,
	moreVertical,
	plus,
	starEmpty,
	starFilled,
} from '@wordpress/icons';
import { useDraggable, useDroppable } from '@dnd-kit/core';

import { collectionIcon } from '../cortextIcons';
import { useDocumentActions, useDocumentRecord } from '../../documents';
import { useSurfaceFocusIntent } from '../SurfaceFocusContext';

export default function DocumentRow( {
	record,
	childNodes = [],
	childBranch = null,
	depth = 0,
	expandedIds,
	draggedId = null,
	activeDrop = null,
	isHidden = false,
	isSelected,
	onSelect,
	onToggleExpand,
	onLoadMore,
	onCreateChild,
	onCreateBlankChild,
	pageTemplates = [],
	onCreateChildFromTemplate,
	onCreateChildCollection,
	isFavorite,
	isFavoriteDisabled = false,
	onToggleFavorite,
	isHome,
	onSetHome,
	isHomeUpdating = false,
	autoRenameId = null,
	onAutoRenameConsumed,
} ) {
	const { requestFromActivation } = useSurfaceFocusIntent();
	const { title, icon, features } = useDocumentRecord( record );
	const { rename, duplicate, trash } = useDocumentActions();

	const recordId = record.id;
	const hasLoadedChildren = features.hierarchy && childNodes.length > 0;
	const hasServerChildren = record.cortext_has_tree_children === true;
	const hasMoreChildren =
		childBranch?.hasResolved &&
		childBranch.totalPages > 0 &&
		childBranch.page < childBranch.totalPages;
	const branchKnownEmpty =
		childBranch?.hasResolved &&
		! childBranch?.isLoading &&
		! childBranch?.error &&
		! hasLoadedChildren &&
		! hasMoreChildren;
	const canExpand =
		features.hierarchy &&
		! branchKnownEmpty &&
		( hasLoadedChildren ||
			hasServerChildren ||
			childBranch?.isLoading ||
			childBranch?.error );
	const isExpanded = expandedIds?.has( recordId ) ?? false;
	const rowIsSelected =
		typeof isSelected === 'function' ? isSelected( record ) : !! isSelected;
	const rowIsFavorite =
		typeof isFavorite === 'function' ? isFavorite( record ) : !! isFavorite;
	const rowIsHome =
		typeof isHome === 'function' ? isHome( record ) : !! isHome;
	const isBeingDragged = draggedId === recordId;
	const isDropTarget = activeDrop && activeDrop.targetId === recordId;
	const templatesEnabled = typeof onCreateBlankChild === 'function';

	const [ isRenaming, setIsRenaming ] = useState( false );
	const [ draftTitle, setDraftTitle ] = useState( '' );
	const renameInputRef = useRef( null );

	useEffect( () => {
		if ( autoRenameId === recordId ) {
			setDraftTitle( record.title?.raw ?? record.title?.rendered ?? '' );
			setIsRenaming( true );
			onAutoRenameConsumed?.();
		}
	}, [
		autoRenameId,
		recordId,
		record.title?.raw,
		record.title?.rendered,
		onAutoRenameConsumed,
	] );

	// TextControl owns the input, so the wrapper ref cannot be focused directly.
	useEffect( () => {
		if ( isRenaming && renameInputRef.current ) {
			const input = renameInputRef.current.querySelector( 'input' );
			input?.focus();
			input?.select();
		}
	}, [ isRenaming ] );

	function commitRename() {
		const next = draftTitle.trim();
		const previous = record.title?.raw ?? record.title?.rendered ?? '';
		if ( next && next !== previous ) {
			rename( record, next );
		}
		setIsRenaming( false );
	}

	function cancelRename() {
		setIsRenaming( false );
	}

	function startRename() {
		setDraftTitle( record.title?.raw ?? record.title?.rendered ?? '' );
		setIsRenaming( true );
	}

	// useSidebarDnd still parses these legacy prefixes.
	const {
		attributes,
		listeners,
		setNodeRef: setDragRef,
	} = useDraggable( {
		id: `${ features.hierarchy ? 'page' : 'collection' }:${ recordId }`,
		data: { pageId: recordId },
	} );

	const dropBefore = useDroppable( {
		id: `before:${ recordId }`,
		data: { zone: 'before', pageId: recordId },
		disabled: isHidden,
	} );
	const dropInside = useDroppable( {
		id: `inside:${ recordId }`,
		data: { zone: 'inside', pageId: recordId },
		disabled: isHidden || ! features.hierarchy,
	} );
	const dropAfter = useDroppable( {
		id: `after:${ recordId }`,
		data: { zone: 'after', pageId: recordId },
		disabled: isHidden,
	} );

	const rowClasses = [ 'cortext-sidebar__row' ];
	if ( rowIsSelected ) {
		rowClasses.push( 'is-selected' );
	}
	if ( isBeingDragged ) {
		rowClasses.push( 'is-dragging' );
	}
	if ( isDropTarget ) {
		rowClasses.push( `is-drop-${ activeDrop.zone }` );
	}

	return (
		<li className="cortext-sidebar__node">
			<div
				className="cortext-sidebar__row-wrapper"
				style={ { '--cortext-depth': depth } }
			>
				<div
					ref={ setDragRef }
					className={ rowClasses.join( ' ' ) }
					{ ...attributes }
					{ ...listeners }
				>
					{ canExpand ? (
						<Button
							className={
								'cortext-sidebar__chevron' +
								( isExpanded ? ' is-expanded' : '' )
							}
							icon={ chevronRight }
							size="small"
							label={
								isExpanded
									? __( 'Collapse', 'cortext' )
									: __( 'Expand', 'cortext' )
							}
							onClick={ ( e ) => {
								e.stopPropagation();
								onToggleExpand( recordId );
							} }
							onPointerDown={ ( e ) => e.stopPropagation() }
						/>
					) : (
						<span
							className="cortext-sidebar__chevron cortext-sidebar__chevron--placeholder"
							aria-hidden="true"
						/>
					) }

					<span className="cortext-sidebar__icon" aria-hidden="true">
						{ icon }
					</span>

					{ isRenaming ? (
						<div
							ref={ renameInputRef }
							className="cortext-sidebar__rename"
						>
							<TextControl
								__nextHasNoMarginBottom
								size="compact"
								value={ draftTitle }
								onChange={ setDraftTitle }
								onBlur={ commitRename }
								onKeyDown={ ( e ) => {
									e.stopPropagation();
									if ( e.key === 'Enter' ) {
										e.preventDefault();
										commitRename();
									} else if ( e.key === 'Escape' ) {
										e.preventDefault();
										cancelRename();
									}
								} }
								onPointerDown={ ( e ) => e.stopPropagation() }
							/>
						</div>
					) : (
						<Button
							className="cortext-sidebar__title"
							size="compact"
							onKeyDown={ ( event ) => {
								if (
									event.key === 'Enter' ||
									event.key === ' '
								) {
									event.stopPropagation();
								}
							} }
							onClick={ ( event ) => {
								requestFromActivation( event, record.id );
								onSelect( record );
							} }
							isPressed={ rowIsSelected }
						>
							{ title }
						</Button>
					) }

					{ features.canCreateChild && (
						<Button
							className="cortext-sidebar__add-child"
							icon={ plus }
							size="small"
							label={ sprintf(
								/* translators: %s: parent document title */
								__( 'Add a document inside %s', 'cortext' ),
								title
							) }
							onClick={ ( e ) => {
								e.stopPropagation();
								onCreateChild( recordId );
							} }
							onPointerDown={ ( e ) => e.stopPropagation() }
						/>
					) }

					<Dropdown
						popoverProps={ { placement: 'bottom-end' } }
						renderToggle={ ( { isOpen, onToggle } ) => (
							<Button
								className="cortext-sidebar__menu"
								icon={ moreVertical }
								size="small"
								label={ sprintf(
									/* translators: %s: document title */
									__( 'Actions for %s', 'cortext' ),
									title
								) }
								onClick={ onToggle }
								isPressed={ isOpen }
								aria-expanded={ isOpen }
								onPointerDown={ ( e ) => e.stopPropagation() }
							/>
						) }
						renderContent={ ( { onClose } ) => (
							<>
								{ features.canCreateChild && (
									<MenuGroup>
										{ templatesEnabled ? (
											<>
												<MenuItem
													icon="admin-page"
													onClick={ () => {
														onCreateBlankChild(
															recordId
														);
														onClose();
													} }
												>
													{ __(
														'Add blank document',
														'cortext'
													) }
												</MenuItem>
												{ pageTemplates.map(
													( template ) => (
														<MenuItem
															key={ template.id }
															icon="admin-page"
															onClick={ () => {
																onCreateChildFromTemplate?.(
																	recordId,
																	template
																);
																onClose();
															} }
														>
															{ sprintf(
																/* translators: %s: template title */
																__(
																	'Add document from %s',
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
											</>
										) : null }
										<MenuItem
											icon={ collectionIcon }
											onClick={ () => {
												onCreateChildCollection?.(
													recordId
												);
												onClose();
											} }
										>
											{ __(
												'Add collection inside',
												'cortext'
											) }
										</MenuItem>
									</MenuGroup>
								) }
								<MenuGroup>
									<MenuItem
										icon={
											rowIsFavorite
												? starFilled
												: starEmpty
										}
										disabled={ isFavoriteDisabled }
										onClick={ () => {
											onToggleFavorite?.( record );
											onClose();
										} }
									>
										{ rowIsFavorite
											? __(
													'Remove from favorites',
													'cortext'
											  )
											: __(
													'Add to favorites',
													'cortext'
											  ) }
									</MenuItem>
									<MenuItem
										icon={ homeIcon }
										disabled={ rowIsHome || isHomeUpdating }
										onClick={ () => {
											onSetHome( record );
											onClose();
										} }
									>
										{ rowIsHome
											? __( 'Home', 'cortext' )
											: __( 'Set as home', 'cortext' ) }
									</MenuItem>
									<MenuItem
										icon="edit"
										onClick={ () => {
											startRename();
											onClose();
										} }
									>
										{ __( 'Rename', 'cortext' ) }
									</MenuItem>
									<MenuItem
										icon="admin-page"
										onClick={ () => {
											duplicate( record );
											onClose();
										} }
									>
										{ __( 'Duplicate', 'cortext' ) }
									</MenuItem>
									<MenuItem
										icon="trash"
										isDestructive
										onClick={ () => {
											trash( record );
											onClose();
										} }
									>
										{ __( 'Move to Trash', 'cortext' ) }
									</MenuItem>
								</MenuGroup>
							</>
						) }
					/>

					{ /* Drop zones overlay the row. pointer-events are off
					     so they don't block clicks when idle. */ }
					<div
						ref={ dropBefore.setNodeRef }
						className={
							'cortext-sidebar__drop-zone cortext-sidebar__drop-zone--before' +
							( features.hierarchy
								? ''
								: ' cortext-sidebar__drop-zone--half' )
						}
						aria-hidden="true"
					/>
					{ features.hierarchy && (
						<div
							ref={ dropInside.setNodeRef }
							className="cortext-sidebar__drop-zone cortext-sidebar__drop-zone--inside"
							aria-hidden="true"
						/>
					) }
					<div
						ref={ dropAfter.setNodeRef }
						className={
							'cortext-sidebar__drop-zone cortext-sidebar__drop-zone--after' +
							( features.hierarchy
								? ''
								: ' cortext-sidebar__drop-zone--half' )
						}
						aria-hidden="true"
					/>
				</div>
			</div>

			{ canExpand && (
				<div
					className={
						'cortext-sidebar__children-wrapper' +
						( isExpanded ? ' is-expanded' : '' )
					}
					{ ...( isExpanded ? {} : { inert: '' } ) }
				>
					<ul className="cortext-sidebar__children">
						{ childNodes.map( ( childNode ) => (
							<DocumentRow
								key={ childNode.page.id }
								record={ childNode.page }
								childNodes={ childNode.children }
								childBranch={ childNode.branch }
								depth={ depth + 1 }
								expandedIds={ expandedIds }
								draggedId={ draggedId }
								activeDrop={ activeDrop }
								isHidden={ isHidden || ! isExpanded }
								isSelected={ isSelected }
								onSelect={ onSelect }
								onToggleExpand={ onToggleExpand }
								onLoadMore={ onLoadMore }
								onCreateChild={ onCreateChild }
								onCreateBlankChild={ onCreateBlankChild }
								pageTemplates={ pageTemplates }
								onCreateChildFromTemplate={
									onCreateChildFromTemplate
								}
								onCreateChildCollection={
									onCreateChildCollection
								}
								isFavorite={ isFavorite }
								isFavoriteDisabled={ isFavoriteDisabled }
								onToggleFavorite={ onToggleFavorite }
								isHome={ isHome }
								onSetHome={ onSetHome }
								isHomeUpdating={ isHomeUpdating }
								autoRenameId={ autoRenameId }
								onAutoRenameConsumed={ onAutoRenameConsumed }
							/>
						) ) }
						{ childBranch?.error && (
							<li className="cortext-sidebar__node">
								<p
									className="cortext-sidebar__row-error"
									role="alert"
								>
									{ __(
										"We couldn't load these documents.",
										'cortext'
									) }
								</p>
							</li>
						) }
						{ hasMoreChildren && (
							<li
								className="cortext-sidebar__node cortext-sidebar__load-more-node"
								style={ { '--cortext-depth': depth + 1 } }
							>
								<Button
									className="cortext-sidebar__load-more"
									size="compact"
									isBusy={ childBranch.isLoading }
									disabled={ childBranch.isLoading }
									onClick={ ( e ) => {
										e.stopPropagation();
										onLoadMore?.( recordId );
									} }
									onPointerDown={ ( e ) =>
										e.stopPropagation()
									}
								>
									{ __( 'Show more', 'cortext' ) }
								</Button>
							</li>
						) }
					</ul>
				</div>
			) }
		</li>
	);
}
