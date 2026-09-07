import apiFetch from '@wordpress/api-fetch';
import {
	Button,
	Dropdown,
	MenuGroup,
	MenuItem,
	Notice,
} from '@wordpress/components';
import {
	lazy,
	Suspense,
	useCallback,
	useMemo,
	useState,
} from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { chevronDown, page, plus } from '@wordpress/icons';

import {
	createTemplate,
	instantiateTemplate,
	notifyTemplatesChanged,
	TEMPLATE_KIND_ROW,
	TEMPLATES_EXPERIMENT_ID,
	useTemplates,
} from '../templates';
import { isExperimentEnabled } from '../settings';

const TemplateEditorModal = lazy( () =>
	import( /* webpackChunkName: "editor" */ './TemplateEditorModal' )
);

// Only scalar `is` filters can be copied without changing their meaning.
// Filtering itself remains server-side.
function prefillFromFilters( filters, fieldIds ) {
	const prefill = {};
	if ( ! Array.isArray( filters ) ) {
		return prefill;
	}
	for ( const filter of filters ) {
		if ( ! filter || typeof filter !== 'object' ) {
			continue;
		}
		const op = filter.operator;
		if ( op !== 'is' ) {
			continue;
		}
		const { field, value } = filter;
		if ( ! field || field === 'title' ) {
			continue;
		}
		if ( Array.isArray( value ) || value === null || value === undefined ) {
			continue;
		}
		if ( ! fieldIds.has( field ) ) {
			continue;
		}
		prefill[ field ] = value;
	}
	return prefill;
}

export default function DataViewNewRowButton( {
	collectionId,
	view,
	fields,
	onCreated,
	disabled,
	presentation = 'footer',
} ) {
	const templatesEnabled = isExperimentEnabled( TEMPLATES_EXPERIMENT_ID );
	const [ isCreating, setIsCreating ] = useState( false );
	const [ isCreatingTemplate, setIsCreatingTemplate ] = useState( false );
	const [ editingTemplateId, setEditingTemplateId ] = useState( null );
	const [ error, setError ] = useState( null );
	const { templates, isResolving: areTemplatesResolving } = useTemplates( {
		kind: TEMPLATE_KIND_ROW,
		collectionId,
		enabled: templatesEnabled,
	} );

	const prefillableFieldIds = useMemo(
		() =>
			new Set(
				( fields ?? [] )
					.filter(
						( f ) =>
							f.editable !== false && f.cortextType !== 'rollup'
					)
					.map( ( f ) => f.id )
			),
		[ fields ]
	);

	const createRow = useCallback(
		async ( template = null ) => {
			setIsCreating( true );
			setError( null );
			const meta = prefillFromFilters(
				view?.filters,
				prefillableFieldIds
			);
			try {
				const created = template?.id
					? await instantiateTemplate( template.id, {
							field_values: meta,
					  } )
					: await apiFetch( {
							path: '/wp/v2/crtxt_documents',
							method: 'POST',
							data: {
								status: 'private',
								title: '',
								cortext_trait: collectionId,
								...( Object.keys( meta ).length
									? { meta }
									: {} ),
							},
					  } );
				onCreated( created );
			} catch ( err ) {
				setError(
					err?.message ?? __( "Couldn't create the row.", 'cortext' )
				);
			} finally {
				setIsCreating( false );
			}
		},
		[ collectionId, view, prefillableFieldIds, onCreated ]
	);

	const createRowTemplate = useCallback( async () => {
		if ( ! collectionId ) {
			return;
		}
		setIsCreatingTemplate( true );
		setError( null );
		try {
			const template = await createTemplate( {
				kind: TEMPLATE_KIND_ROW,
				collection_id: collectionId,
				title: __( 'Untitled template', 'cortext' ),
			} );
			notifyTemplatesChanged( {
				kind: TEMPLATE_KIND_ROW,
				collectionId,
			} );
			if ( template?.id ) {
				setEditingTemplateId( template.id );
			}
		} catch ( err ) {
			setError(
				err?.message ?? __( "Couldn't create the template.", 'cortext' )
			);
		} finally {
			setIsCreatingTemplate( false );
		}
	}, [ collectionId ] );

	const primaryClassName =
		'cortext-data-view__new-row' +
		( presentation === 'grid-card'
			? ' cortext-data-view__new-row-card'
			: '' ) +
		( presentation === 'list-row'
			? ' cortext-data-view__new-row-list'
			: '' );

	const primaryButton = (
		<Button
			className={ primaryClassName }
			variant="tertiary"
			icon={ plus }
			onClick={ () => createRow() }
			isBusy={ isCreating }
			disabled={ disabled || isCreating || ! collectionId }
		>
			{ __( 'New', 'cortext' ) }
		</Button>
	);
	const optionsMenu = templatesEnabled ? (
		<Dropdown
			popoverProps={ { placement: 'bottom-start' } }
			renderToggle={ ( { isOpen, onToggle } ) => (
				<Button
					className="cortext-data-view__new-row-template-menu"
					variant="tertiary"
					icon={ chevronDown }
					onClick={ onToggle }
					label={ __( 'Choose how to create a row', 'cortext' ) }
					disabled={
						disabled ||
						isCreating ||
						isCreatingTemplate ||
						areTemplatesResolving ||
						! collectionId
					}
					isPressed={ isOpen }
					aria-expanded={ isOpen }
				/>
			) }
			renderContent={ ( { onClose } ) => (
				<>
					<MenuGroup>
						<MenuItem
							icon={ plus }
							onClick={ () => {
								createRow();
								onClose();
							} }
						>
							{ __( 'Blank row', 'cortext' ) }
						</MenuItem>
						{ templates.map( ( template ) => (
							<MenuItem
								key={ template.id }
								icon={ page }
								onClick={ () => {
									createRow( template );
									onClose();
								} }
							>
								{ sprintf(
									/* translators: %s: template title. */
									__( 'Create from %s', 'cortext' ),
									template.title ||
										__( 'Untitled template', 'cortext' )
								) }
							</MenuItem>
						) ) }
					</MenuGroup>
					<MenuGroup>
						<MenuItem
							icon={ page }
							onClick={ () => {
								createRowTemplate();
								onClose();
							} }
						>
							{ __( 'New template', 'cortext' ) }
						</MenuItem>
					</MenuGroup>
				</>
			) }
		/>
	) : null;
	const controlsClassName =
		'cortext-data-view__new-row-controls' +
		( presentation === 'footer'
			? ' cortext-data-view__new-row-controls--footer'
			: '' );
	const controls = templatesEnabled ? (
		<div className={ controlsClassName }>
			{ primaryButton }
			{ optionsMenu }
		</div>
	) : (
		primaryButton
	);
	const notice = error ? (
		<Notice
			status="error"
			isDismissible
			onRemove={ () => setError( null ) }
		>
			{ error }
		</Notice>
	) : null;
	const templateEditor =
		templatesEnabled && editingTemplateId ? (
			<Suspense fallback={ null }>
				<TemplateEditorModal
					collectionId={ collectionId }
					fields={ fields ?? [] }
					kind={ TEMPLATE_KIND_ROW }
					templateId={ editingTemplateId }
					onClose={ () => setEditingTemplateId( null ) }
				/>
			</Suspense>
		) : null;

	if ( presentation === 'grid-card' ) {
		return (
			<div className="cortext-data-view__new-row-card-wrapper">
				{ controls }
				{ notice }
				{ templateEditor }
			</div>
		);
	}

	return (
		<>
			{ controls }
			{ notice }
			{ templateEditor }
		</>
	);
}
