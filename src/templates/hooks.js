import { useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import { useDispatch } from '@wordpress/data';

import { fetchTemplates, instantiateTemplate } from './actions';
import {
	afterDocumentTrash,
	applyInvalidationPack,
} from '../documents/invalidation';

const TEMPLATES_CHANGED_EVENT = 'cortext:templates-changed';

export function notifyTemplatesChanged( detail = {} ) {
	if ( typeof window === 'undefined' ) {
		return;
	}
	window.dispatchEvent(
		new window.CustomEvent( TEMPLATES_CHANGED_EVENT, { detail } )
	);
}

function matchesTemplateChange( detail, kind, collectionId ) {
	if ( detail?.kind && detail.kind !== kind ) {
		return false;
	}
	if (
		detail?.collectionId &&
		Number( detail.collectionId ) !== Number( collectionId )
	) {
		return false;
	}
	return true;
}

export function useTemplates( { kind, collectionId, enabled = true } = {} ) {
	const [ templates, setTemplates ] = useState( [] );
	const [ isResolving, setIsResolving ] = useState( enabled );
	const [ error, setError ] = useState( null );

	const refresh = useCallback( async () => {
		if ( ! enabled ) {
			setTemplates( [] );
			setIsResolving( false );
			setError( null );
			return [];
		}
		setIsResolving( true );
		setError( null );
		try {
			const next = await fetchTemplates( { kind, collectionId } );
			setTemplates( next );
			return next;
		} catch ( nextError ) {
			setTemplates( [] );
			setError( nextError );
			return [];
		} finally {
			setIsResolving( false );
		}
	}, [ kind, collectionId, enabled ] );

	useEffect( () => {
		if ( ! enabled ) {
			setTemplates( [] );
			setIsResolving( false );
			setError( null );
			return undefined;
		}

		let cancelled = false;
		setIsResolving( true );
		setError( null );
		fetchTemplates( { kind, collectionId } )
			.then( ( next ) => {
				if ( ! cancelled ) {
					setTemplates( next );
					setIsResolving( false );
				}
			} )
			.catch( ( nextError ) => {
				if ( ! cancelled ) {
					setTemplates( [] );
					setError( nextError );
					setIsResolving( false );
				}
			} );
		return () => {
			cancelled = true;
		};
	}, [ kind, collectionId, enabled ] );

	useEffect( () => {
		if ( ! enabled || typeof window === 'undefined' ) {
			return undefined;
		}
		const onTemplatesChanged = ( event ) => {
			if ( matchesTemplateChange( event.detail, kind, collectionId ) ) {
				refresh();
			}
		};
		window.addEventListener( TEMPLATES_CHANGED_EVENT, onTemplatesChanged );
		return () =>
			window.removeEventListener(
				TEMPLATES_CHANGED_EVENT,
				onTemplatesChanged
			);
	}, [ collectionId, enabled, kind, refresh ] );

	return useMemo(
		() => ( { templates, isResolving, error, refresh } ),
		[ templates, isResolving, error, refresh ]
	);
}

export function useInstantiateTemplate() {
	const { invalidateResolution } = useDispatch( 'core' );
	return useCallback(
		async ( id, data = {} ) => {
			const created = await instantiateTemplate( id, data );
			if ( created?.id ) {
				applyInvalidationPack(
					invalidateResolution,
					afterDocumentTrash
				);
			}
			return created;
		},
		[ invalidateResolution ]
	);
}
