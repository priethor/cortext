<?php
/**
 * REST endpoints for Cortext templates.
 *
 * @package Cortext
 */

declare( strict_types=1 );

namespace Cortext\Rest;

defined( 'ABSPATH' ) || exit;

use Cortext\PostType\Template as TemplatePostType;
use Cortext\Templates;
use WP_Error;
use WP_Post;
use WP_REST_Request;
use WP_REST_Response;

final class TemplatesController {

	private const NAMESPACE = 'cortext/v1';

	public function __construct( private ?Templates $templates = null ) {
		$this->templates = $templates ?? new Templates();
	}

	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		register_rest_route(
			self::NAMESPACE,
			'/templates',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( $this, 'list_templates' ),
					'permission_callback' => array( $this, 'can_read' ),
					'args'                => array(
						'kind'          => array(
							'type' => 'string',
							'enum' => array( Templates::KIND_PAGE, Templates::KIND_ROW ),
						),
						'collection_id' => array(
							'type'    => 'integer',
							'minimum' => 1,
						),
					),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'create_template' ),
					'permission_callback' => array( $this, 'can_read' ),
				),
			)
		);

		$id_arg = array(
			'id' => array(
				'type'     => 'integer',
				'required' => true,
			),
		);

		register_rest_route(
			self::NAMESPACE,
			'/templates/(?P<id>\d+)',
			array(
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'update_template' ),
					'permission_callback' => array( $this, 'can_edit_template' ),
					'args'                => $id_arg,
				),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/templates/(?P<id>\d+)/instantiate',
			array(
				array(
					'methods'             => 'POST',
					'callback'            => array( $this, 'instantiate_template' ),
					'permission_callback' => array( $this, 'can_edit_template' ),
					'args'                => $id_arg,
				),
			)
		);
	}

	public function can_read(): bool {
		return current_user_can( 'edit_posts' );
	}

	public function can_edit_template( WP_REST_Request $request ): bool|WP_Error {
		$id   = (int) $request->get_param( 'id' );
		$post = get_post( $id );

		if ( ! $post instanceof WP_Post || TemplatePostType::POST_TYPE !== $post->post_type ) {
			return new WP_Error(
				'cortext_template_not_found',
				__( "Couldn't find that template.", 'cortext' ),
				array( 'status' => 404 )
			);
		}

		return current_user_can( 'edit_post', $id );
	}

	public function list_templates( WP_REST_Request $request ): WP_REST_Response {
		return new WP_REST_Response(
			array(
				'templates' => $this->templates->list(
					array(
						'kind'          => $request->get_param( 'kind' ),
						'collection_id' => $request->get_param( 'collection_id' ),
					)
				),
			),
			200
		);
	}

	public function create_template( WP_REST_Request $request ): WP_REST_Response|WP_Error {
		$template = $this->templates->create( $this->body_params( $request ) );
		if ( $template instanceof WP_Error ) {
			return $template;
		}
		return new WP_REST_Response( array( 'template' => $template ), 201 );
	}

	public function update_template( WP_REST_Request $request ): WP_REST_Response|WP_Error {
		$template = $this->templates->update(
			(int) $request->get_param( 'id' ),
			$this->body_params( $request )
		);
		if ( $template instanceof WP_Error ) {
			return $template;
		}
		return new WP_REST_Response( array( 'template' => $template ), 200 );
	}

	public function instantiate_template( WP_REST_Request $request ): WP_REST_Response|WP_Error {
		$document = $this->templates->instantiate(
			(int) $request->get_param( 'id' ),
			$this->body_params( $request )
		);
		if ( $document instanceof WP_Error ) {
			return $document;
		}
		return new WP_REST_Response( array( 'document' => $document ), 201 );
	}

	private function body_params( WP_REST_Request $request ): array {
		$params = $request->get_json_params();
		if ( ! is_array( $params ) || array() === $params ) {
			$params = $request->get_body_params();
		}
		return is_array( $params ) ? $params : array();
	}
}
