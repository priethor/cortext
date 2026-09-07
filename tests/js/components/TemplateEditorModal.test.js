import { act, render, waitFor } from '@testing-library/react';

let mockSaveRowField;

jest.mock( '@wordpress/components', () => ( {
	__esModule: true,
	Button: ( { children, label, onClick } ) => (
		<button type="button" onClick={ onClick }>
			{ children ?? label }
		</button>
	),
	Modal: ( { children } ) => <div>{ children }</div>,
	Notice: ( { children } ) => <div role="alert">{ children }</div>,
	SlotFillProvider: ( { children } ) => <>{ children }</>,
	Spinner: () => <div>Loading</div>,
} ) );

jest.mock( '@wordpress/core-data', () => ( {
	__esModule: true,
	useEntityRecord: jest.fn(),
} ) );

jest.mock( '@wordpress/data', () => ( {
	__esModule: true,
	useDispatch: jest.fn( () => ( { resetPost: jest.fn() } ) ),
} ) );

jest.mock( '@wordpress/editor', () => ( {
	__esModule: true,
	EditorProvider: ( { children } ) => <>{ children }</>,
	store: 'editor-store',
} ) );

jest.mock( '@wordpress/i18n', () => ( {
	__: ( value ) => value,
} ) );

jest.mock( '@wordpress/icons', () => ( {
	closeSmall: 'closeSmall',
} ) );

jest.mock( '../../../src/hooks/useAutosave', () => ( {
	__esModule: true,
	default: () => ( { flushNow: jest.fn().mockResolvedValue( true ) } ),
} ) );

jest.mock( '../../../src/components/initEditor', () => ( {
	getEditorSettings: () => ( {} ),
} ) );

jest.mock( '../../../src/components/DocumentPropertiesContext', () => ( {
	DocumentPropertiesProvider: ( { children } ) => <>{ children }</>,
} ) );

jest.mock( '../../../src/components/EditorSurfaceContext', () => ( {
	EditorSurfaceProvider: ( { children } ) => <>{ children }</>,
} ) );

jest.mock( '../../../src/components/CortextLinkSuggestions', () => () => null );

jest.mock( '../../../src/components/EditableCell', () => {
	const { createContext } = require( '@wordpress/element' );
	return {
		__esModule: true,
		RowMutationContext: createContext( {} ),
	};
} );

jest.mock( '../../../src/components/EditorBody', () => {
	const React = require( 'react' );
	const {
		RowMutationContext,
	} = require( '../../../src/components/EditableCell' );

	return {
		__esModule: true,
		default: function MockEditorBody() {
			mockSaveRowField =
				React.useContext( RowMutationContext ).saveRowField;
			return <div data-testid="editor-body" />;
		},
	};
} );

jest.mock( '../../../src/templates', () => ( {
	__esModule: true,
	TEMPLATE_KIND_ROW: 'row',
	TEMPLATE_POST_TYPE: 'crtxt_template',
	notifyTemplatesChanged: jest.fn(),
	updateTemplate: jest.fn(),
} ) );

import { useEntityRecord } from '@wordpress/core-data';
import TemplateEditorModal from '../../../src/components/TemplateEditorModal';
import { notifyTemplatesChanged, updateTemplate } from '../../../src/templates';

describe( 'TemplateEditorModal', () => {
	beforeEach( () => {
		mockSaveRowField = null;
		updateTemplate.mockReset();
		notifyTemplatesChanged.mockReset();
		useEntityRecord.mockReturnValue( {
			isResolving: false,
			record: {
				id: 123,
				title: { raw: 'Template' },
				meta: { cortext_template_field_values: {} },
			},
		} );
	} );

	it( 'serializes row template field saves against the latest field value map', async () => {
		let resolveFirst;
		let resolveSecond;
		updateTemplate
			.mockImplementationOnce(
				() =>
					new Promise( ( resolve ) => {
						resolveFirst = resolve;
					} )
			)
			.mockImplementationOnce(
				() =>
					new Promise( ( resolve ) => {
						resolveSecond = resolve;
					} )
			);

		render(
			<TemplateEditorModal
				collectionId={ 7 }
				fields={ [] }
				kind="row"
				templateId={ 123 }
			/>
		);

		await waitFor( () =>
			expect( mockSaveRowField ).toEqual( expect.any( Function ) )
		);

		let firstSave;
		let secondSave;
		await act( async () => {
			firstSave = mockSaveRowField( 123, 'field-1', 'Open' );
			secondSave = mockSaveRowField( 123, 'field-2', 'High' );
			await Promise.resolve();
		} );

		expect( updateTemplate ).toHaveBeenCalledTimes( 1 );
		expect( updateTemplate ).toHaveBeenNthCalledWith( 1, 123, {
			field_values: { 'field-1': 'Open' },
		} );

		await act( async () => {
			resolveFirst( {
				field_values: { 'field-1': 'Open' },
			} );
			await firstSave;
		} );

		await waitFor( () =>
			expect( updateTemplate ).toHaveBeenCalledTimes( 2 )
		);
		expect( updateTemplate ).toHaveBeenNthCalledWith( 2, 123, {
			field_values: { 'field-1': 'Open', 'field-2': 'High' },
		} );

		await act( async () => {
			resolveSecond( {
				field_values: { 'field-1': 'Open', 'field-2': 'High' },
			} );
			await secondSave;
		} );

		expect( notifyTemplatesChanged ).toHaveBeenCalledWith( {
			kind: 'row',
			collectionId: 7,
		} );
	} );
} );
