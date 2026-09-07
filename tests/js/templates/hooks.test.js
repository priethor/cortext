import { act, renderHook, waitFor } from '@testing-library/react';
import apiFetch from '@wordpress/api-fetch';

jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn(),
} ) );

jest.mock( '@wordpress/data', () => ( {
	__esModule: true,
	useDispatch: jest.fn(),
} ) );

import { useDispatch } from '@wordpress/data';
import { afterDocumentTrash } from '../../../src/documents/invalidation';
import {
	notifyTemplatesChanged,
	useInstantiateTemplate,
	useTemplates,
} from '../../../src/templates/hooks';

beforeEach( () => {
	apiFetch.mockReset();
	useDispatch.mockReset();
} );

describe( 'template hooks', () => {
	it( 'does not resolve templates while the experiment is disabled', async () => {
		const { result } = renderHook( () =>
			useTemplates( {
				kind: 'row',
				collectionId: 7,
				enabled: false,
			} )
		);

		expect( result.current.templates ).toEqual( [] );
		expect( result.current.isResolving ).toBe( false );
		let refreshed;
		await act( async () => {
			refreshed = await result.current.refresh();
		} );
		expect( refreshed ).toEqual( [] );
		expect( apiFetch ).not.toHaveBeenCalled();
	} );

	it( 'loads and refreshes templates for a kind and collection', async () => {
		apiFetch
			.mockResolvedValueOnce( { templates: [ { id: 1 } ] } )
			.mockResolvedValueOnce( { templates: [ { id: 2 } ] } );

		const { result } = renderHook( () =>
			useTemplates( { kind: 'row', collectionId: 7 } )
		);

		await waitFor( () =>
			expect( result.current.isResolving ).toBe( false )
		);
		expect( result.current.templates ).toEqual( [ { id: 1 } ] );

		let refreshed;
		await act( async () => {
			refreshed = await result.current.refresh();
		} );

		expect( refreshed ).toEqual( [ { id: 2 } ] );
		expect( result.current.templates ).toEqual( [ { id: 2 } ] );
		expect( apiFetch ).toHaveBeenNthCalledWith( 1, {
			path: '/cortext/v1/templates?kind=row&collection_id=7',
		} );
		expect( apiFetch ).toHaveBeenNthCalledWith( 2, {
			path: '/cortext/v1/templates?kind=row&collection_id=7',
		} );
	} );

	it( 'refreshes matching template queries after a template change event', async () => {
		apiFetch
			.mockResolvedValueOnce( { templates: [ { id: 1 } ] } )
			.mockResolvedValueOnce( { templates: [ { id: 2 } ] } );

		const { result } = renderHook( () =>
			useTemplates( { kind: 'row', collectionId: 7 } )
		);

		await waitFor( () =>
			expect( result.current.isResolving ).toBe( false )
		);

		await act( async () => {
			notifyTemplatesChanged( { kind: 'row', collectionId: 7 } );
		} );

		await waitFor( () =>
			expect( result.current.templates ).toEqual( [ { id: 2 } ] )
		);
		expect( apiFetch ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'invalidates document lists after instantiating a template', async () => {
		const invalidateResolution = jest.fn();
		useDispatch.mockReturnValue( { invalidateResolution } );
		apiFetch.mockResolvedValueOnce( { document: { id: 11 } } );

		const { result } = renderHook( () => useInstantiateTemplate() );

		await act( async () => {
			await result.current( 9, { parent: 3 } );
		} );

		expect( apiFetch ).toHaveBeenCalledWith( {
			path: '/cortext/v1/templates/9/instantiate',
			method: 'POST',
			data: { parent: 3 },
		} );
		expect( invalidateResolution ).toHaveBeenCalledTimes(
			afterDocumentTrash.length
		);
	} );
} );
