<?php
/**
 * Tests for Cortext template REST endpoints and instantiation behaviour.
 *
 * @package Cortext
 */

declare( strict_types=1 );

namespace Cortext\Tests;

use Cortext\PostType\Document;
use Cortext\PostType\Field;
use Cortext\PostType\Template as TemplatePostType;
use Cortext\Relations;
use Cortext\Rest\TemplatesController;
use Cortext\Taxonomy\TraitTaxonomy;
use Cortext\Templates;
use WorDBless\BaseTestCase;
use WP_REST_Request;
use WP_REST_Server;

final class Test_Rest_Templates_Controller extends BaseTestCase {

	use InMemoryPostsQuery;
	use InMemoryTermStore;

	private TemplatePostType $template_post_type;

	public function set_up(): void {
		parent::set_up();

		( new Document() )->register_post_type();
		( new Field() )->register_post_type();
		( new TraitTaxonomy() )->register_taxonomy();
		$trait_taxonomy = new TraitTaxonomy();
		add_action( 'added_post_meta', array( $trait_taxonomy, 'sync_term_on_meta_change' ), 10, 4 );
		add_action( 'updated_post_meta', array( $trait_taxonomy, 'sync_term_on_meta_change' ), 10, 4 );
		add_action( 'deleted_post_meta', array( $trait_taxonomy, 'sync_term_on_meta_change' ), 10, 4 );
		add_action( 'before_delete_post', array( $trait_taxonomy, 'sync_term_on_delete' ), 10, 2 );

		$this->template_post_type = new TemplatePostType();
		$this->template_post_type->register_post_type();
		$this->template_post_type->register_meta();

		$this->install_in_memory_posts_query();
		$this->install_in_memory_term_store();

		$GLOBALS['wp_rest_server'] = new WP_REST_Server();
		( new TemplatesController() )->register();
		do_action( 'rest_api_init' );
	}

	public function tear_down(): void {
		$this->uninstall_in_memory_posts_query();
		$this->uninstall_in_memory_term_store();
		wp_set_current_user( 0 );

		parent::tear_down();
	}

	public function test_route_is_registered(): void {
		$routes = rest_get_server()->get_routes();

		$this->assertArrayHasKey( '/cortext/v1/templates', $routes );
		$this->assertArrayHasKey( '/cortext/v1/templates/(?P<id>\d+)/instantiate', $routes );
	}

	public function test_registers_hidden_template_post_type_with_rest_support(): void {
		$this->assertTrue( post_type_exists( TemplatePostType::POST_TYPE ) );

		$object = get_post_type_object( TemplatePostType::POST_TYPE );
		$this->assertNotNull( $object );
		$this->assertFalse( $object->show_ui );
		$this->assertFalse( $object->show_in_menu );
		$this->assertTrue( $object->show_in_rest );
		$this->assertTrue( post_type_supports( TemplatePostType::POST_TYPE, 'title' ) );
		$this->assertTrue( post_type_supports( TemplatePostType::POST_TYPE, 'editor' ) );
		$this->assertTrue( post_type_supports( TemplatePostType::POST_TYPE, 'revisions' ) );
	}

	public function test_requires_edit_posts_capability(): void {
		wp_set_current_user( $this->create_user( 'subscriber' ) );

		$response = $this->request( 'GET', '/cortext/v1/templates' );

		$this->assertSame( 403, $response->get_status() );
	}

	public function test_create_list_and_update_page_templates(): void {
		wp_set_current_user( $this->create_user( 'administrator' ) );

		$create = $this->request(
			'POST',
			'/cortext/v1/templates',
			array(
				'kind'    => Templates::KIND_PAGE,
				'title'   => 'Meeting notes',
				'content' => '<!-- wp:paragraph --><p>Agenda</p><!-- /wp:paragraph -->',
			)
		);

		$this->assertSame( 201, $create->get_status() );
		$template = $create->get_data()['template'];
		$this->assertSame( 'Meeting notes', $template['title'] );
		$this->assertSame( Templates::KIND_PAGE, $template['kind'] );
		$this->assertNull( $template['collection_id'] );

		$list = $this->request(
			'GET',
			'/cortext/v1/templates',
			array( 'kind' => Templates::KIND_PAGE )
		);
		$this->assertSame( array( $template['id'] ), array_column( $list->get_data()['templates'], 'id' ) );

		$update = $this->request(
			'POST',
			'/cortext/v1/templates/' . $template['id'],
			array(
				'title'   => 'Renamed template',
				'content' => '<!-- wp:paragraph --><p>Updated</p><!-- /wp:paragraph -->',
			)
		);
		$this->assertSame( 200, $update->get_status() );
		$this->assertSame( 'Renamed template', $update->get_data()['template']['title'] );
	}

	public function test_instantiate_page_template_copies_title_blocks_and_parent(): void {
		wp_set_current_user( $this->create_user( 'administrator' ) );
		$parent_id   = $this->create_document( 'Parent' );
		$template_id = $this->create_template(
			array(
				'kind'    => Templates::KIND_PAGE,
				'title'   => 'Project brief',
				'content' => '<!-- wp:post-title /--><!-- wp:cortext/document-icon /--><!-- wp:paragraph --><p>Brief body</p><!-- /wp:paragraph -->',
			)
		);

		$response = $this->request(
			'POST',
			'/cortext/v1/templates/' . $template_id . '/instantiate',
			array( 'parent' => $parent_id )
		);

		$this->assertSame( 201, $response->get_status() );
		$document_id = (int) $response->get_data()['document']['id'];
		$document    = get_post( $document_id );
		$this->assertNotNull( $document );
		$this->assertSame( Document::POST_TYPE, $document->post_type );
		$this->assertSame( 'Project brief', $document->post_title );
		$this->assertSame( $parent_id, (int) $document->post_parent );
		$this->assertStringContainsString( 'Brief body', $document->post_content );
		$this->assertStringNotContainsString( 'post-title', $document->post_content );
		$this->assertStringNotContainsString( 'document-icon', $document->post_content );
	}

	public function test_instantiate_row_template_applies_defaults_with_request_prefills_taking_priority(): void {
		wp_set_current_user( $this->create_user( 'administrator' ) );
		$collection_id = $this->create_collection( 'Tasks' );
		$status_id     = $this->attach_field( $collection_id, 'Status', 'text' );
		$owner_id      = $this->attach_field( $collection_id, 'Owner', 'text' );
		$tags_id       = $this->attach_field( $collection_id, 'Tags', 'multiselect' );
		$template_id   = $this->create_template(
			array(
				'kind'          => Templates::KIND_ROW,
				'collection_id' => $collection_id,
				'title'         => 'Task starter',
				'content'       => '<!-- wp:paragraph --><p>Row body</p><!-- /wp:paragraph -->',
				'field_values'  => array(
					'field-' . $status_id => 'todo',
					'field-' . $owner_id  => 'template owner',
					'field-' . $tags_id   => array( 'frontend', 'urgent' ),
				),
			)
		);

		$response = $this->request(
			'POST',
			'/cortext/v1/templates/' . $template_id . '/instantiate',
			array(
				'field_values' => array(
					'field-' . $status_id => 'filtered status',
				),
			)
		);

		$this->assertSame( 201, $response->get_status() );
		$row_id = (int) $response->get_data()['document']['id'];
		$row    = get_post( $row_id );

		$this->assertNotNull( $row );
		$this->assertSame( 'Task starter', $row->post_title );
		$this->assertSame( 'private', $row->post_status );
		$this->assertStringContainsString( 'Row body', $row->post_content );
		$this->assertSame( 'filtered status', get_post_meta( $row_id, Relations::meta_key( $status_id ), true ) );
		$this->assertSame( 'template owner', get_post_meta( $row_id, Relations::meta_key( $owner_id ), true ) );
		$this->assertSame( array( 'frontend', 'urgent' ), get_post_meta( $row_id, Relations::meta_key( $tags_id ), false ) );

		$term_id = TraitTaxonomy::term_id_for_trait( $collection_id );
		$this->assertTrue( has_term( $term_id, TraitTaxonomy::TAXONOMY, $row_id ) );
	}

	public function test_rejects_row_template_defaults_for_fields_outside_collection(): void {
		wp_set_current_user( $this->create_user( 'administrator' ) );
		$collection_id = $this->create_collection( 'Tasks' );

		$response = $this->request(
			'POST',
			'/cortext/v1/templates',
			array(
				'kind'          => Templates::KIND_ROW,
				'collection_id' => $collection_id,
				'title'         => 'Invalid row template',
				'field_values'  => array(
					'field-99999' => 'outside',
				),
			)
		);

		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'cortext_template_field_invalid', $response->get_data()['code'] );
	}

	public function test_update_drops_defaults_for_fields_removed_from_collection(): void {
		wp_set_current_user( $this->create_user( 'administrator' ) );
		$collection_id = $this->create_collection( 'Tasks' );
		$status_id     = $this->attach_field( $collection_id, 'Status', 'text' );
		$template_id   = $this->create_template(
			array(
				'kind'          => Templates::KIND_ROW,
				'collection_id' => $collection_id,
				'title'         => 'Task starter',
				'field_values'  => array(
					'field-' . $status_id => 'todo',
				),
			)
		);

		delete_post_meta( $collection_id, 'cortext_fields', (string) $status_id );

		$response = $this->request(
			'POST',
			'/cortext/v1/templates/' . $template_id,
			array( 'title' => 'Renamed starter' )
		);

		$this->assertSame( 200, $response->get_status(), wp_json_encode( $response->get_data() ) );
		$template = $response->get_data()['template'];
		$this->assertSame( 'Renamed starter', $template['title'] );
		$this->assertArrayNotHasKey( 'field-' . $status_id, $template['field_values'] );
	}

	private function request( string $method, string $path, array $params = array() ) {
		$request = new WP_REST_Request( $method, $path );
		foreach ( $params as $key => $value ) {
			$request->set_param( $key, $value );
		}
		if ( in_array( $method, array( 'POST', 'PUT', 'PATCH', 'DELETE' ), true ) ) {
			$request->set_body_params( $params );
		}
		return rest_do_request( $request );
	}

	private function create_user( string $role ): int {
		return (int) wp_insert_user(
			array(
				'user_login' => uniqid( 'cortext_', false ),
				'user_pass'  => 'password',
				'role'       => $role,
			)
		);
	}

	private function create_document( string $title ): int {
		$id = (int) wp_insert_post(
			array(
				'post_type'   => Document::POST_TYPE,
				'post_status' => 'private',
				'post_title'  => $title,
			)
		);
		$this->assertGreaterThan( 0, $id );
		return $id;
	}

	private function create_collection( string $title ): int {
		$collection_id = $this->create_document( $title );
		$this->attach_field( $collection_id, 'Title', 'text' );
		$this->assertGreaterThan( 0, TraitTaxonomy::term_id_for_trait( $collection_id ) );
		return $collection_id;
	}

	private function create_row( int $collection_id, string $title ): int {
		$row_id  = $this->create_document( $title );
		$term_id = TraitTaxonomy::term_id_for_trait( $collection_id );
		$this->assertGreaterThan( 0, $term_id );
		wp_set_object_terms( $row_id, array( $term_id ), TraitTaxonomy::TAXONOMY, false );
		return $row_id;
	}

	private function attach_field( int $collection_id, string $title, string $type ): int {
		$field_id = (int) wp_insert_post(
			array(
				'post_type'   => Field::POST_TYPE,
				'post_status' => 'private',
				'post_title'  => $title,
				'meta_input'  => array( 'type' => $type ),
			)
		);
		$this->assertGreaterThan( 0, $field_id );
		add_post_meta( $collection_id, 'cortext_fields', (string) $field_id );
		return $field_id;
	}

	private function create_template( array $args ): int {
		$response = $this->request( 'POST', '/cortext/v1/templates', $args );
		$this->assertSame( 201, $response->get_status(), wp_json_encode( $response->get_data() ) );
		return (int) $response->get_data()['template']['id'];
	}
}
