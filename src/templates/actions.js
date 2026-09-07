import apiFetch from '@wordpress/api-fetch';
import { addQueryArgs } from '@wordpress/url';

export const TEMPLATE_POST_TYPE = 'crtxt_template';
export const TEMPLATES_EXPERIMENT_ID = 'templates';
export const TEMPLATE_KIND_PAGE = 'page';
export const TEMPLATE_KIND_ROW = 'row';

export async function fetchTemplates( { kind, collectionId } = {} ) {
	const query = {};
	if ( kind ) {
		query.kind = kind;
	}
	if ( collectionId ) {
		query.collection_id = collectionId;
	}
	const response = await apiFetch( {
		path: addQueryArgs( '/cortext/v1/templates', query ),
	} );
	return response?.templates ?? [];
}

export async function createTemplate( data = {} ) {
	const response = await apiFetch( {
		path: '/cortext/v1/templates',
		method: 'POST',
		data,
	} );
	return response?.template ?? null;
}

export async function updateTemplate( id, data = {} ) {
	const response = await apiFetch( {
		path: `/cortext/v1/templates/${ id }`,
		method: 'POST',
		data,
	} );
	return response?.template ?? null;
}

export async function instantiateTemplate( id, data = {} ) {
	const response = await apiFetch( {
		path: `/cortext/v1/templates/${ id }/instantiate`,
		method: 'POST',
		data,
	} );
	return response?.document ?? null;
}
