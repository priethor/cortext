import {
	Button,
	Modal,
	Notice,
	SlotFillProvider,
	Spinner,
} from '@wordpress/components';
import { useEntityRecord } from '@wordpress/core-data';
import { useDispatch } from '@wordpress/data';
import { EditorProvider, store as editorStore } from '@wordpress/editor';
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { closeSmall } from '@wordpress/icons';

import './RowDetailView.scss';

import { getEditorSettings } from './initEditor';
import { DocumentPropertiesProvider } from './DocumentPropertiesContext';
import { EditorSurfaceProvider } from './EditorSurfaceContext';
import EditorBody from './EditorBody';
import CortextLinkSuggestions from './CortextLinkSuggestions';
import { RowMutationContext } from './EditableCell';
import useAutosave from '../hooks/useAutosave';
import {
	TEMPLATE_KIND_ROW,
	TEMPLATE_POST_TYPE,
	notifyTemplatesChanged,
	updateTemplate,
} from '../templates';

const TEMPLATE_EDITOR_CSS = `
	body {
		background: #fff;
	}

	.editor-styles-wrapper {
		box-sizing: border-box;
		min-height: 100%;
		padding: 24px 32px 48px;
	}

	.editor-styles-wrapper .wp-block-post-content {
		margin-block-start: 0;
	}

	.editor-styles-wrapper > .block-editor-block-list__layout,
	.editor-styles-wrapper .block-editor-block-list__layout.is-root-container {
		min-height: 180px;
	}
`;

const TEMPLATE_EXTRA_STYLES = [ { css: TEMPLATE_EDITOR_CSS } ];

function TemplateAutosaveBridge( { onApi, onSaved } ) {
	const { flushNow, status } = useAutosave( {
		debounceMs: 0,
		minSaveIntervalMs: 0,
	} );
	const { resetPost } = useDispatch( editorStore );
	const discard = useCallback( () => resetPost(), [ resetPost ] );

	useEffect( () => {
		onApi?.( { flushNow, discard } );
		return () => onApi?.( null );
	}, [ discard, flushNow, onApi ] );

	useEffect( () => {
		if ( status === 'saved' ) {
			onSaved?.();
		}
	}, [ onSaved, status ] );

	return null;
}

function fieldValuesFromRecord( record ) {
	return record?.meta?.cortext_template_field_values ?? {};
}

export default function TemplateEditorModal( {
	collectionId = null,
	fields = [],
	kind,
	onClose,
	templateId,
} ) {
	const apiRef = useRef( null );
	const [ error, setError ] = useState( null );
	const [ fieldValues, setFieldValues ] = useState( {} );
	// The API replaces the entire map, so overlapping saves must run in order
	// or a slower response can overwrite a newer field value.
	const fieldValuesRef = useRef( fieldValues );
	const fieldSaveChainRef = useRef( Promise.resolve() );
	const { record, isResolving } = useEntityRecord(
		'postType',
		TEMPLATE_POST_TYPE,
		templateId
	);
	const isRowTemplate = kind === TEMPLATE_KIND_ROW;

	useEffect( () => {
		if ( record ) {
			const next = fieldValuesFromRecord( record );
			fieldValuesRef.current = next;
			setFieldValues( next );
		}
	}, [ record ] );

	const closeAfterSave = useCallback( async () => {
		setError( null );
		const didSave = await apiRef.current?.flushNow?.();
		if ( didSave === false ) {
			setError( __( "Couldn't save the template.", 'cortext' ) );
			return;
		}
		onClose?.();
	}, [ onClose ] );

	const saveTemplateField = useCallback(
		( rowId, fieldId, value ) => {
			const save = async () => {
				const nextValues = {
					...fieldValuesRef.current,
					[ fieldId ]: value,
				};
				fieldValuesRef.current = nextValues;
				setFieldValues( nextValues );
				const template = await updateTemplate( rowId, {
					field_values: nextValues,
				} );
				const savedValues = template?.field_values ?? nextValues;
				fieldValuesRef.current = savedValues;
				setFieldValues( savedValues );
				notifyTemplatesChanged( { kind, collectionId } );
				return {
					id: rowId,
					meta: savedValues,
					cortext_hydrated_meta: {},
				};
			};
			const request = fieldSaveChainRef.current.then( save, save );
			fieldSaveChainRef.current = request.catch( () => {} );
			return request;
		},
		[ collectionId, kind ]
	);

	const mutationContext = useMemo(
		() => ( {
			saveRowField: isRowTemplate ? saveTemplateField : null,
			canEditCells: true,
			layoutType: 'modal',
			optionOverrides: {},
			updateFieldOptions: () => {},
			formatOverrides: {},
			updateFieldFormat: () => {},
			refreshRows: () => {},
		} ),
		[ isRowTemplate, saveTemplateField ]
	);

	const templateRow = useMemo(
		() =>
			record
				? {
						...record,
						id: templateId,
						title: record.title,
						meta: fieldValues,
						cortext_hydrated_meta: {},
				  }
				: null,
		[ fieldValues, record, templateId ]
	);

	const handleSaved = useCallback( () => {
		notifyTemplatesChanged( { kind, collectionId } );
	}, [ collectionId, kind ] );

	return (
		<Modal
			className="cortext-row-detail-modal"
			title={
				isRowTemplate
					? __( 'Row template', 'cortext' )
					: __( 'Document template', 'cortext' )
			}
			onRequestClose={ closeAfterSave }
			__experimentalHideHeader
		>
			<div className="cortext-row-detail cortext-row-detail--modal">
				<div
					className="cortext-row-detail__frame"
					data-properties-visible="true"
				>
					<div className="cortext-row-detail__header">
						<div
							className="cortext-row-detail__toolbar"
							role="toolbar"
							aria-label={
								isRowTemplate
									? __( 'Row template actions', 'cortext' )
									: __(
											'Document template actions',
											'cortext'
									  )
							}
						>
							<div className="cortext-row-detail__toolbar-group cortext-row-detail__toolbar-group--end">
								<Button
									className="cortext-row-detail__toolbar-button cortext-row-detail__toolbar-button--close"
									icon={ closeSmall }
									label={ __( 'Close', 'cortext' ) }
									onClick={ closeAfterSave }
								/>
							</div>
						</div>
					</div>
					{ error ? (
						<Notice
							className="cortext-row-detail__notice"
							status="error"
							isDismissible
							onRemove={ () => setError( null ) }
						>
							{ error }
						</Notice>
					) : null }
					{ isResolving || ! record ? (
						<div className="cortext-row-detail__pane cortext-row-detail__pane--loading">
							<Spinner />
						</div>
					) : (
						<EditorProvider
							post={ record }
							settings={ getEditorSettings() }
							useSubRegistry
						>
							<CortextLinkSuggestions />
							<SlotFillProvider>
								<EditorSurfaceProvider
									hasBlockInspector={ false }
								>
									<RowMutationContext.Provider
										value={ mutationContext }
									>
										<DocumentPropertiesProvider
											collectionId={ collectionId }
											rowId={ templateId }
											fields={
												isRowTemplate ? fields : []
											}
											allFields={
												isRowTemplate ? fields : []
											}
											detailLayoutEntries={ [] }
											fallbackRecord={ templateRow }
											isVisible
										>
											<TemplateAutosaveBridge
												onApi={ ( api ) => {
													apiRef.current = api;
												} }
												onSaved={ handleSaved }
											/>
											<EditorBody
												isActive
												showIdentityActions={ false }
												postId={ templateId }
												postType={ TEMPLATE_POST_TYPE }
												extraStyles={
													TEMPLATE_EXTRA_STYLES
												}
											/>
										</DocumentPropertiesProvider>
									</RowMutationContext.Provider>
								</EditorSurfaceProvider>
							</SlotFillProvider>
						</EditorProvider>
					) }
				</div>
			</div>
		</Modal>
	);
}
