import apiFetch from '@wordpress/api-fetch';

jest.mock( '@wordpress/api-fetch', () => ( {
	__esModule: true,
	default: jest.fn(),
} ) );

import {
	createTemplate,
	fetchTemplates,
	instantiateTemplate,
	updateTemplate,
} from '../../../src/templates/actions';

beforeEach( () => {
	apiFetch.mockReset();
} );

describe( 'template REST actions', () => {
	it( 'fetches templates with kind and collection filters', async () => {
		apiFetch.mockResolvedValueOnce( {
			templates: [ { id: 1, kind: 'row' } ],
		} );

		const templates = await fetchTemplates( {
			kind: 'row',
			collectionId: 7,
		} );

		expect( templates ).toEqual( [ { id: 1, kind: 'row' } ] );
		expect( apiFetch ).toHaveBeenCalledWith( {
			path: '/cortext/v1/templates?kind=row&collection_id=7',
		} );
	} );

	it( 'creates, updates, and instantiates templates', async () => {
		apiFetch
			.mockResolvedValueOnce( { template: { id: 2 } } )
			.mockResolvedValueOnce( { template: { id: 2, title: 'Renamed' } } )
			.mockResolvedValueOnce( { document: { id: 4 } } );

		await expect(
			createTemplate( { kind: 'page', title: 'Brief' } )
		).resolves.toEqual( { id: 2 } );
		await expect(
			updateTemplate( 2, { title: 'Renamed' } )
		).resolves.toEqual( { id: 2, title: 'Renamed' } );
		await expect(
			instantiateTemplate( 2, { parent: 9 } )
		).resolves.toEqual( { id: 4 } );

		expect( apiFetch ).toHaveBeenNthCalledWith( 1, {
			path: '/cortext/v1/templates',
			method: 'POST',
			data: { kind: 'page', title: 'Brief' },
		} );
		expect( apiFetch ).toHaveBeenNthCalledWith( 2, {
			path: '/cortext/v1/templates/2',
			method: 'POST',
			data: { title: 'Renamed' },
		} );
		expect( apiFetch ).toHaveBeenNthCalledWith( 3, {
			path: '/cortext/v1/templates/2/instantiate',
			method: 'POST',
			data: { parent: 9 },
		} );
	} );
} );
