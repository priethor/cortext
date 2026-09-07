import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apiFetch from '@wordpress/api-fetch';

jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn(),
} ) );

jest.mock( '@wordpress/i18n', () => ( {
	__: ( value ) => value,
	sprintf: ( template, value ) => template.replace( '%s', value ),
} ) );

jest.mock( '@wordpress/icons', () => ( {
	chevronDown: 'chevronDown',
	page: 'page',
	plus: 'plus',
} ) );

jest.mock( '@wordpress/components', () => {
	const React = require( 'react' );
	return {
		__esModule: true,
		Button: ( {
			children,
			className,
			label,
			onClick,
			disabled,
			isBusy,
		} ) => (
			<button
				type="button"
				aria-label={ label }
				className={ className }
				onClick={ onClick }
				disabled={ disabled || isBusy }
			>
				{ children || label }
			</button>
		),
		Dropdown: ( { renderToggle, renderContent } ) => {
			const [ isOpen, setIsOpen ] = React.useState( false );
			return (
				<div>
					{ renderToggle( {
						isOpen,
						onToggle: () => setIsOpen( ( current ) => ! current ),
					} ) }
					{ isOpen ? (
						<div role="menu">
							{ renderContent( {
								onClose: () => setIsOpen( false ),
							} ) }
						</div>
					) : null }
				</div>
			);
		},
		MenuGroup: ( { children } ) => <div>{ children }</div>,
		MenuItem: ( { children, onClick } ) => (
			<button type="button" role="menuitem" onClick={ onClick }>
				{ children }
			</button>
		),
		Notice: ( { children } ) => <div role="alert">{ children }</div>,
	};
} );

jest.mock( '../../../src/templates', () => ( {
	__esModule: true,
	createTemplate: jest.fn(),
	instantiateTemplate: jest.fn(),
	notifyTemplatesChanged: jest.fn(),
	TEMPLATE_KIND_ROW: 'row',
	TEMPLATES_EXPERIMENT_ID: 'templates',
	useTemplates: jest.fn(),
} ) );

jest.mock( '../../../src/components/TemplateEditorModal', () => ( props ) => (
	<div data-testid="template-editor-modal">{ props.templateId }</div>
) );

import DataViewNewRowButton from '../../../src/components/DataViewNewRowButton';
import {
	createTemplate,
	instantiateTemplate,
	notifyTemplatesChanged,
	useTemplates,
} from '../../../src/templates';

const fields = [
	{ id: 'field-1', editable: true, cortextType: 'text' },
	{ id: 'field-2', editable: false, cortextType: 'text' },
	{ id: 'field-3', editable: true, cortextType: 'rollup' },
	{ id: 'title', editable: true, cortextType: 'title' },
];

beforeEach( () => {
	window.cortextSettings = {
		experiments: { templates: true },
	};
	apiFetch.mockReset();
	createTemplate.mockReset();
	instantiateTemplate.mockReset();
	notifyTemplatesChanged.mockReset();
	useTemplates.mockReset();
	useTemplates.mockReturnValue( { templates: [] } );
} );

afterEach( () => {
	delete window.cortextSettings;
} );

function renderButton( props = {} ) {
	return render(
		<DataViewNewRowButton
			collectionId={ 7 }
			view={ { filters: [] } }
			fields={ fields }
			onCreated={ jest.fn() }
			{ ...props }
		/>
	);
}

describe( 'DataViewNewRowButton templates', () => {
	it( 'creates a blank row while row templates are still loading', async () => {
		useTemplates.mockReturnValue( {
			templates: [],
			isResolving: true,
		} );
		apiFetch.mockResolvedValueOnce( { id: 99 } );

		renderButton();

		const primaryButton = screen.getByRole( 'button', { name: 'New' } );
		const optionsButton = screen.getByRole( 'button', {
			name: 'Choose how to create a row',
		} );

		expect( primaryButton ).toBeEnabled();
		expect( optionsButton ).toBeDisabled();

		fireEvent.click( primaryButton );

		await waitFor( () => expect( apiFetch ).toHaveBeenCalledTimes( 1 ) );
		expect( instantiateTemplate ).not.toHaveBeenCalled();
	} );

	it( 'creates a blank row without template controls when the experiment is disabled', async () => {
		window.cortextSettings.experiments.templates = false;
		apiFetch.mockResolvedValueOnce( { id: 103 } );

		const { container } = renderButton();

		expect( useTemplates ).toHaveBeenCalledWith( {
			kind: 'row',
			collectionId: 7,
			enabled: false,
		} );
		expect(
			screen.queryByRole( 'button', {
				name: 'Choose how to create a row',
			} )
		).toBeNull();
		expect(
			container.querySelector( '.cortext-data-view__new-row-controls' )
		).toBeNull();

		fireEvent.click( screen.getByRole( 'button', { name: 'New' } ) );

		await waitFor( () => expect( apiFetch ).toHaveBeenCalledTimes( 1 ) );
		expect( instantiateTemplate ).not.toHaveBeenCalled();
	} );

	it( 'creates from a selected template in the options menu', async () => {
		useTemplates.mockReturnValue( {
			templates: [
				{ id: 10, title: 'Alpha' },
				{ id: 11, title: 'Beta' },
			],
		} );
		instantiateTemplate.mockResolvedValueOnce( { id: 100 } );

		renderButton();

		fireEvent.click(
			screen.getByRole( 'button', {
				name: 'Choose how to create a row',
			} )
		);
		fireEvent.click(
			screen.getByRole( 'menuitem', {
				name: 'Create from Alpha',
			} )
		);

		await waitFor( () =>
			expect( instantiateTemplate ).toHaveBeenCalledWith( 10, {
				field_values: {},
			} )
		);
	} );

	it( 'creates a blank row when the picker blank action is selected', async () => {
		const onCreated = jest.fn();
		useTemplates.mockReturnValue( {
			templates: [
				{ id: 10, title: 'Alpha' },
				{ id: 11, title: 'Beta' },
			],
		} );
		apiFetch.mockResolvedValueOnce( { id: 101 } );

		renderButton( { onCreated } );

		fireEvent.click(
			screen.getByRole( 'button', {
				name: 'Choose how to create a row',
			} )
		);
		fireEvent.click(
			screen.getByRole( 'menuitem', {
				name: 'Blank row',
			} )
		);

		await waitFor( () =>
			expect( apiFetch ).toHaveBeenCalledWith( {
				path: '/wp/v2/crtxt_documents',
				method: 'POST',
				data: {
					status: 'private',
					title: '',
					cortext_trait: 7,
				},
			} )
		);
		expect( onCreated ).toHaveBeenCalledWith( { id: 101 } );
	} );

	it( 'creates a blank row when only one template is available', async () => {
		const template = { id: 22, title: 'Only template' };
		useTemplates.mockReturnValue( { templates: [ template ] } );
		apiFetch.mockResolvedValueOnce( { id: 102 } );

		renderButton();

		fireEvent.click( screen.getByRole( 'button', { name: 'New' } ) );

		await waitFor( () => expect( apiFetch ).toHaveBeenCalledTimes( 1 ) );
		expect( instantiateTemplate ).not.toHaveBeenCalled();
	} );

	it( 'creates a template and opens it in the template editor', async () => {
		createTemplate.mockResolvedValueOnce( { id: 123 } );

		renderButton();

		fireEvent.click(
			screen.getByRole( 'button', {
				name: 'Choose how to create a row',
			} )
		);
		fireEvent.click(
			screen.getByRole( 'menuitem', {
				name: 'New template',
			} )
		);

		await waitFor( () =>
			expect( createTemplate ).toHaveBeenCalledWith( {
				kind: 'row',
				collection_id: 7,
				title: 'Untitled template',
			} )
		);
		expect( notifyTemplatesChanged ).toHaveBeenCalledWith( {
			kind: 'row',
			collectionId: 7,
		} );
		expect(
			await screen.findByTestId( 'template-editor-modal' )
		).toHaveTextContent( '123' );
	} );
} );
