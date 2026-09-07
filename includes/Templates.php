<?php
/**
 * Shared service for Cortext page and row templates.
 *
 * @package Cortext
 */

declare( strict_types=1 );

namespace Cortext;

defined( 'ABSPATH' ) || exit;

use Cortext\FieldValues\FieldValueIndex;
use Cortext\PostType\Document;
use Cortext\PostType\Template as TemplatePostType;
use Cortext\Taxonomy\TraitTaxonomy;
use WP_Error;
use WP_Post;

final class Templates {

	public const EXPERIMENT_ID = 'templates';
	public const KIND_PAGE     = 'page';
	public const KIND_ROW      = 'row';

	private const TEMPLATE_HEADER_BLOCKS = array(
		'core/post-title',
		'cortext/document-cover',
		'cortext/document-icon',
		'cortext/document-properties',
	);

	public static function sanitize_kind( $value ): string {
		$kind = is_string( $value ) ? sanitize_key( $value ) : '';
		return self::KIND_ROW === $kind ? self::KIND_ROW : self::KIND_PAGE;
	}

	public static function sanitize_field_values( $value ): array {
		if ( is_object( $value ) ) {
			$value = (array) $value;
		}
		if ( ! is_array( $value ) ) {
			return array();
		}

		$sanitized = array();
		foreach ( $value as $key => $raw ) {
			if ( ! is_string( $key ) || 1 !== preg_match( '/^field-[1-9][0-9]*$/', $key ) ) {
				continue;
			}
			$sanitized[ $key ] = self::sanitize_field_value( $raw );
		}
		return $sanitized;
	}

	private static function sanitize_field_value( $value ) {
		if ( is_array( $value ) ) {
			return array_values(
				array_map(
					static fn( $entry ) => self::sanitize_scalar_field_value( $entry ),
					$value
				)
			);
		}
		return self::sanitize_scalar_field_value( $value );
	}

	private static function sanitize_scalar_field_value( $value ) {
		if ( is_bool( $value ) || is_int( $value ) || is_float( $value ) || null === $value ) {
			return $value;
		}
		return sanitize_text_field( (string) $value );
	}

	public function list( array $args = array() ): array {
		$kind          = isset( $args['kind'] ) ? self::sanitize_kind( $args['kind'] ) : null;
		$collection_id = isset( $args['collection_id'] ) ? max( 0, (int) $args['collection_id'] ) : 0;

		$query_args = array(
			'post_type'           => TemplatePostType::POST_TYPE,
			'post_status'         => array( 'private', 'draft', 'publish' ),
			'posts_per_page'      => -1,
			'orderby'             => 'modified',
			'order'               => 'DESC',
			'ignore_sticky_posts' => true,
			'no_found_rows'       => true,
		);

		$meta_query = array();
		if ( null !== $kind ) {
			$meta_query[] = array(
				'key'   => TemplatePostType::META_KIND,
				'value' => $kind,
			);
		}
		if ( $collection_id > 0 ) {
			$meta_query[] = array(
				'key'   => TemplatePostType::META_COLLECTION_ID,
				'value' => (string) $collection_id,
			);
		}
		if ( count( $meta_query ) > 0 ) {
			$query_args['meta_query'] = $meta_query; // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
		}

		$posts = get_posts( $query_args );
		return array_values(
			array_filter(
				array_map(
					fn( WP_Post $post ): ?array => current_user_can( 'edit_post', $post->ID )
						? $this->format_template( $post )
						: null,
					$posts
				)
			)
		);
	}

	public function create( array $payload ) {
		$normalized = $this->normalize_template_payload( $payload, true );
		if ( $normalized instanceof WP_Error ) {
			return $normalized;
		}

		$post_id = wp_insert_post(
			array(
				'post_type'    => TemplatePostType::POST_TYPE,
				'post_status'  => 'private',
				'post_title'   => $normalized['title'],
				'post_content' => $normalized['content'],
				'meta_input'   => array(
					TemplatePostType::META_KIND          => $normalized['kind'],
					TemplatePostType::META_COLLECTION_ID => $normalized['collection_id'],
					TemplatePostType::META_FIELD_VALUES  => $normalized['field_values'],
				),
			),
			true
		);
		if ( $post_id instanceof WP_Error ) {
			return $post_id;
		}

		$post = get_post( (int) $post_id );
		return $post instanceof WP_Post ? $this->format_template( $post ) : $this->insert_failed_error();
	}

	public function update( int $id, array $payload ) {
		$template = $this->get_template_post( $id );
		if ( $template instanceof WP_Error ) {
			return $template;
		}

		$current = $this->template_meta( $template );
		$merged  = array_merge(
			array(
				'kind'          => $current['kind'],
				'collection_id' => $current['collection_id'],
				'field_values'  => $current['field_values'],
				'title'         => $template->post_title,
				'content'       => $template->post_content,
			),
			$payload
		);

		$normalized = $this->normalize_template_payload( $merged, false );
		if ( $normalized instanceof WP_Error ) {
			return $normalized;
		}

		$result = wp_update_post(
			array(
				'ID'           => $id,
				'post_title'   => $normalized['title'],
				'post_content' => $normalized['content'],
			),
			true
		);
		if ( $result instanceof WP_Error ) {
			return $result;
		}

		update_post_meta( $id, TemplatePostType::META_KIND, $normalized['kind'] );
		update_post_meta( $id, TemplatePostType::META_COLLECTION_ID, $normalized['collection_id'] );
		update_post_meta( $id, TemplatePostType::META_FIELD_VALUES, $normalized['field_values'] );

		$post = get_post( $id );
		return $post instanceof WP_Post ? $this->format_template( $post ) : $this->template_not_found_error();
	}

	public function instantiate( int $id, array $args = array() ) {
		$template = $this->get_template_post( $id );
		if ( $template instanceof WP_Error ) {
			return $template;
		}
		$meta = $this->template_meta( $template );

		if ( self::KIND_ROW === $meta['kind'] ) {
			return $this->instantiate_row( $template, $meta, $args );
		}

		return $this->instantiate_page( $template, $args );
	}

	public function format_template( WP_Post $template ): array {
		$meta = $this->template_meta( $template );
		return array(
			'id'            => (int) $template->ID,
			'title'         => $template->post_title,
			'content'       => $template->post_content,
			'kind'          => $meta['kind'],
			'collection_id' => $meta['collection_id'] > 0 ? $meta['collection_id'] : null,
			'field_values'  => $meta['field_values'],
			'modified'      => $template->post_modified_gmt,
		);
	}

	private function normalize_template_payload( array $payload, bool $creating ) {
		$kind = self::sanitize_kind( $payload['kind'] ?? self::KIND_PAGE );

		$title = isset( $payload['title'] ) ? trim( (string) $payload['title'] ) : '';
		if ( '' === $title ) {
			$title = $creating ? __( 'Untitled template', 'cortext' ) : '';
		}

		$content       = isset( $payload['content'] ) ? (string) $payload['content'] : '';
		$collection_id = self::KIND_ROW === $kind ? max( 0, (int) ( $payload['collection_id'] ?? 0 ) ) : 0;
		$field_values  = self::KIND_ROW === $kind
			? self::sanitize_field_values( $payload['field_values'] ?? array() )
			: array();

		if ( self::KIND_ROW === $kind ) {
			$collection = $this->validate_collection( $collection_id );
			if ( $collection instanceof WP_Error ) {
				return $collection;
			}
			$normalized_values = $this->normalize_field_values_for_collection( $collection_id, $field_values, $creating );
			if ( $normalized_values instanceof WP_Error ) {
				return $normalized_values;
			}
			$field_values = $normalized_values;
		}

		return array(
			'title'         => $title,
			'content'       => $content,
			'kind'          => $kind,
			'collection_id' => $collection_id,
			'field_values'  => $field_values,
		);
	}

	private function get_template_post( int $id ) {
		$post = get_post( $id );
		if ( ! $post instanceof WP_Post || TemplatePostType::POST_TYPE !== $post->post_type ) {
			return $this->template_not_found_error();
		}
		return $post;
	}

	private function template_meta( WP_Post $template ): array {
		return array(
			'kind'          => self::sanitize_kind( get_post_meta( (int) $template->ID, TemplatePostType::META_KIND, true ) ),
			'collection_id' => max( 0, (int) get_post_meta( (int) $template->ID, TemplatePostType::META_COLLECTION_ID, true ) ),
			'field_values'  => self::sanitize_field_values( get_post_meta( (int) $template->ID, TemplatePostType::META_FIELD_VALUES, true ) ),
		);
	}

	private function instantiate_page( WP_Post $template, array $args ) {
		$post_id = wp_insert_post(
			array(
				'post_type'    => Document::POST_TYPE,
				'post_status'  => 'draft',
				'post_title'   => $template->post_title,
				'post_content' => $this->starter_content( $template->post_content ),
				'post_parent'  => max( 0, (int) ( $args['parent'] ?? 0 ) ),
			),
			true
		);
		if ( $post_id instanceof WP_Error ) {
			return $post_id;
		}

		return $this->format_document_post( (int) $post_id );
	}

	private function instantiate_row( WP_Post $template, array $meta, array $args ) {
		$collection_id = (int) $meta['collection_id'];
		$collection    = $this->validate_collection( $collection_id );
		if ( $collection instanceof WP_Error ) {
			return $collection;
		}

		$override_values = self::sanitize_field_values( $args['field_values'] ?? array() );
		$template_values = $this->normalize_field_values_for_collection( $collection_id, $meta['field_values'], false );
		$override_values = $this->normalize_field_values_for_collection( $collection_id, $override_values, false );
		$field_values    = array_merge( $template_values, $override_values );

		$post_id = wp_insert_post(
			array(
				'post_type'    => Document::POST_TYPE,
				'post_status'  => 'private',
				'post_title'   => $template->post_title,
				'post_content' => $this->starter_content( $template->post_content ),
			),
			true
		);
		if ( $post_id instanceof WP_Error ) {
			return $post_id;
		}
		$post_id = (int) $post_id;

		$term_id = TraitTaxonomy::term_id_for_trait( $collection_id );
		if ( $term_id < 1 ) {
			wp_delete_post( $post_id, true );
			return $this->collection_not_found_error();
		}
		$set = wp_set_object_terms( $post_id, array( $term_id ), TraitTaxonomy::TAXONOMY, false );
		if ( $set instanceof WP_Error ) {
			wp_delete_post( $post_id, true );
			return $set;
		}

		$written = $this->write_row_field_values( $post_id, $collection_id, $field_values );
		if ( $written instanceof WP_Error ) {
			wp_delete_post( $post_id, true );
			return $written;
		}

		return $this->format_document_post( $post_id );
	}

	private function validate_collection( int $collection_id ): bool|WP_Error {
		$post = get_post( $collection_id );
		if ( ! $post instanceof WP_Post || Document::POST_TYPE !== $post->post_type || ! Document::is_collection( $collection_id ) ) {
			return $this->collection_not_found_error();
		}
		if ( ! current_user_can( 'edit_post', $collection_id ) ) {
			return new WP_Error(
				'cortext_template_collection_forbidden',
				__( "You can't edit this collection.", 'cortext' ),
				array( 'status' => 403 )
			);
		}
		return true;
	}

	private function normalize_field_values_for_collection( int $collection_id, array $values, bool $reject_invalid ) {
		$field_ids = array_flip( Document::collection_field_ids( $collection_id ) );
		$next      = array();

		foreach ( $values as $key => $value ) {
			$field_id = (int) substr( $key, 6 );
			if ( $field_id < 1 || ! isset( $field_ids[ $field_id ] ) ) {
				if ( $reject_invalid ) {
					return $this->invalid_field_error( $key );
				}
				continue;
			}

			$type = (string) get_post_meta( $field_id, 'type', true );
			if ( '' === $type || 'rollup' === $type ) {
				if ( $reject_invalid ) {
					return $this->invalid_field_error( $key );
				}
				continue;
			}

			$next[ $key ] = $this->normalize_value_for_type( $value, $type );
		}

		return $next;
	}

	private function normalize_value_for_type( $value, string $type ) {
		if ( 'checkbox' === $type ) {
			return rest_sanitize_boolean( $value ) ? '1' : '0';
		}
		if ( in_array( $type, array( 'multiselect', 'relation' ), true ) ) {
			return is_array( $value ) ? array_values( $value ) : array( $value );
		}
		return $value;
	}

	private function write_row_field_values( int $row_id, int $collection_id, array $field_values ): bool|WP_Error {
		$index = new FieldValueIndex();

		foreach ( $field_values as $key => $value ) {
			$field_id = (int) substr( $key, 6 );
			$type     = (string) get_post_meta( $field_id, 'type', true );
			if ( 'relation' === $type ) {
				$synced = Relations::sync_relation_value( $row_id, $field_id, $value );
				if ( $synced instanceof WP_Error ) {
					return $synced;
				}
				$index->index_row_field( $row_id, $field_id, $collection_id );
				continue;
			}

			$meta_key = Relations::meta_key( $field_id );
			if ( is_array( $value ) ) {
				delete_post_meta( $row_id, $meta_key );
				foreach ( $value as $entry ) {
					if ( '' !== $entry && null !== $entry ) {
						add_post_meta( $row_id, $meta_key, $entry );
					}
				}
				$index->index_row_field( $row_id, $field_id, $collection_id );
				continue;
			}

			if ( '' !== $value && null !== $value ) {
				update_post_meta( $row_id, $meta_key, $value );
			}
			$index->index_row_field( $row_id, $field_id, $collection_id );
		}

		return true;
	}

	private function starter_content( string $content ): string {
		if ( '' === trim( $content ) || ! str_contains( $content, '<!-- wp:' ) ) {
			return $content;
		}

		$blocks   = parse_blocks( $content );
		$filtered = array_values(
			array_filter(
				$blocks,
				static fn( array $block ): bool => ! in_array( $block['blockName'] ?? null, self::TEMPLATE_HEADER_BLOCKS, true )
			)
		);

		return serialize_blocks( $filtered );
	}

	private function format_document_post( int $post_id ) {
		$post = get_post( $post_id );
		if ( ! $post instanceof WP_Post ) {
			return $this->insert_failed_error();
		}

		return array(
			'id'       => (int) $post->ID,
			'title'    => array(
				'raw'      => $post->post_title,
				'rendered' => get_the_title( $post ),
			),
			'slug'     => (string) $post->post_name,
			'restBase' => 'crtxt_documents',
			'type'     => Document::POST_TYPE,
			'parent'   => (int) $post->post_parent,
		);
	}

	private function template_not_found_error(): WP_Error {
		return new WP_Error(
			'cortext_template_not_found',
			__( "Couldn't find that template.", 'cortext' ),
			array( 'status' => 404 )
		);
	}

	private function collection_not_found_error(): WP_Error {
		return new WP_Error(
			'cortext_template_collection_not_found',
			__( "Couldn't find that collection.", 'cortext' ),
			array( 'status' => 404 )
		);
	}

	private function invalid_field_error( string $key ): WP_Error {
		return new WP_Error(
			'cortext_template_field_invalid',
			sprintf(
				/* translators: %s: field key. */
				__( 'Field "%s" is not part of this collection.', 'cortext' ),
				$key
			),
			array(
				'status' => 400,
				'key'    => $key,
			)
		);
	}

	private function insert_failed_error(): WP_Error {
		return new WP_Error(
			'cortext_template_insert_failed',
			__( "Couldn't create the template.", 'cortext' ),
			array( 'status' => 500 )
		);
	}
}
