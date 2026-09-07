<?php
/**
 * Plugin bootstrap.
 *
 * @package Cortext
 */

declare( strict_types=1 );

namespace Cortext;

defined( 'ABSPATH' ) || exit;

use Cortext\Admin\Screen;
use Cortext\Block\DataView;
use Cortext\Editor\DocumentCoverBlock;
use Cortext\Editor\DocumentIconBlock;
use Cortext\Editor\DocumentPropertiesBlock;
use Cortext\Editor\RevisionThrottle;
use Cortext\FieldValues\FieldValueIndex;
use Cortext\Frontend\AdminBar;
use Cortext\Frontend\Assets;
use Cortext\Frontend\MentionRenderer;
use Cortext\Frontend\Template;
use Cortext\Media\CortextMedia;
use Cortext\PostType\ArchiveCascade;
use Cortext\PostType\Document;
use Cortext\PostType\DocumentIdentity;
use Cortext\PostType\Field;
use Cortext\PostType\Template as TemplatePostType;
use Cortext\PostType\TrashCascade;
use Cortext\Rest\BacklinksController;
use Cortext\Rest\DocumentLocatorController;
use Cortext\Rest\DocumentsController;
use Cortext\Rest\ExperimentsController;
use Cortext\Rest\FavoritesController;
use Cortext\Rest\FieldsController;
use Cortext\Notion\Importer as NotionImporter;
use Cortext\Rest\NotionController;
use Cortext\Rest\PostLocksController;
use Cortext\Rest\RecentsController;
use Cortext\Rest\RowsController;
use Cortext\Rest\SampleContentController;
use Cortext\Rest\SidebarTreePreferencesController;
use Cortext\Rest\TemplatesController;
use Cortext\Rest\WorkspaceHomeController;
use Cortext\Taxonomy\MentionTaxonomy;
use Cortext\Taxonomy\TraitTaxonomy;
use Cortext\Theming\Preferences;

final class Plugin {

	private static ?Plugin $instance = null;

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function boot(): void {
		add_filter( 'cortext_experiments', array( $this, 'register_experiments' ) );

		( new Screen() )->register();
		( new Document() )->register();
		( new DocumentIdentity() )->register();
		( new TraitTaxonomy() )->register();
		( new MentionTaxonomy() )->register();
		( new Field() )->register();
		( new TemplatePostType() )->register();
		( new FieldValueIndex() )->register();

		$archive_cascade = new ArchiveCascade();
		$archive_cascade->register();

		// Single instance owns every trash cascade hook and also answers
		// `descendants_for_root` for the REST endpoints.
		$trash_cascade = new TrashCascade();
		$trash_cascade->register();

		( new RevisionThrottle() )->register();
		( new DocumentIconBlock() )->register();
		( new DocumentCoverBlock() )->register();
		( new DocumentPropertiesBlock() )->register();
		( new FavoritesController() )->register();
		( new FieldsController() )->register();
		( new BacklinksController() )->register();
		( new DocumentLocatorController() )->register();
		( new DocumentsController( null, $trash_cascade, $archive_cascade ) )->register();
		( new ExperimentsController() )->register();
		( new PostLocksController() )->register();
		( new RecentsController() )->register();
		( new RowsController() )->register();
		( new SampleContentController() )->register();
		( new SidebarTreePreferencesController() )->register();
		( new TemplatesController() )->register();
		( new WorkspaceHomeController() )->register();
		( new NotionController() )->register();
		( new NotionImporter() )->register();
		( new AdminBar() )->register();
		( new MentionRenderer() )->register();
		( new Template() )->register();
		( new Assets() )->register();
		( new DataView() )->register();
		( new CortextMedia() )->register();
		( new Preferences() )->register();
	}

	public function register_experiments( array $experiments ): array {
		$experiments[] = array(
			'id'          => Templates::EXPERIMENT_ID,
			'label'       => __( 'Templates', 'cortext' ),
			'description' => __( 'Start documents and collection rows from saved templates.', 'cortext' ),
			'group'       => __( 'Content', 'cortext' ),
			'default'     => false,
		);

		return $experiments;
	}

	private function __construct() {}
}
