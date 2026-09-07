<?php
/**
 * Registers the hidden template post type shared by page and row templates.
 *
 * @package Cortext
 */

declare( strict_types=1 );

namespace Cortext\PostType;

defined( 'ABSPATH' ) || exit;

use Cortext\Templates;

final class Template {

	public const POST_TYPE = 'crtxt_template';

	public const META_KIND          = 'cortext_template_kind';
	public const META_COLLECTION_ID = 'cortext_template_collection_id';
	public const META_FIELD_VALUES  = 'cortext_template_field_values';

	public function register(): void {
		add_action( 'init', array( $this, 'register_post_type' ) );
		add_action( 'init', array( $this, 'register_meta' ), 11 );
	}

	public function register_post_type(): void {
		register_post_type(
			self::POST_TYPE,
			array(
				'labels'                => array(
					'name'          => __( 'Cortext Templates', 'cortext' ),
					'singular_name' => __( 'Cortext Template', 'cortext' ),
				),
				'public'                => false,
				'publicly_queryable'    => false,
				'exclude_from_search'   => true,
				'show_ui'               => false,
				'show_in_menu'          => false,
				'show_in_rest'          => true,
				'rest_base'             => 'crtxt_templates',
				'rest_controller_class' => 'WP_REST_Posts_Controller',
				'has_archive'           => false,
				'hierarchical'          => false,
				'supports'              => array(
					'title',
					'editor',
					'revisions',
					'custom-fields',
				),
				'capability_type'       => 'post',
				'map_meta_cap'          => true,
				'can_export'            => true,
				'delete_with_user'      => false,
			)
		);
	}

	public function register_meta(): void {
		register_post_meta(
			self::POST_TYPE,
			self::META_KIND,
			array(
				'type'              => 'string',
				'single'            => true,
				'default'           => Templates::KIND_PAGE,
				'show_in_rest'      => array(
					'schema' => array(
						'type' => 'string',
						'enum' => array( Templates::KIND_PAGE, Templates::KIND_ROW ),
					),
				),
				'auth_callback'     => static fn(): bool => current_user_can( 'edit_posts' ),
				'sanitize_callback' => array( Templates::class, 'sanitize_kind' ),
			)
		);

		register_post_meta(
			self::POST_TYPE,
			self::META_COLLECTION_ID,
			array(
				'type'              => 'integer',
				'single'            => true,
				'default'           => 0,
				'show_in_rest'      => true,
				'auth_callback'     => static fn(): bool => current_user_can( 'edit_posts' ),
				'sanitize_callback' => static fn( $value ): int => max( 0, (int) $value ),
			)
		);

		register_post_meta(
			self::POST_TYPE,
			self::META_FIELD_VALUES,
			array(
				'type'              => 'object',
				'single'            => true,
				'default'           => array(),
				'show_in_rest'      => array(
					'schema' => array(
						'type'                 => 'object',
						'additionalProperties' => true,
					),
				),
				'auth_callback'     => static fn(): bool => current_user_can( 'edit_posts' ),
				'sanitize_callback' => array( Templates::class, 'sanitize_field_values' ),
			)
		);
	}
}
