<?php
/**
 * Plugin Name:       Cortext
 * Plugin URI:        https://github.com/Automattic/cortext
 * Description:       Build a WordPress-native knowledge base with pages, typed collections, views, and public publishing.
 * Version:           0.2.0
 * Requires at least: 7.1
 * Requires PHP:      8.1
 * Author:            Héctor Prieto, Miguel Fonseca
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       cortext
 *
 * @package Cortext
 */

defined( 'ABSPATH' ) || exit;

define( 'CORTEXT_VERSION', '0.2.0' );
define( 'CORTEXT_PATH', plugin_dir_path( __FILE__ ) );
define( 'CORTEXT_URL', plugin_dir_url( __FILE__ ) );

$cortext_autoload = CORTEXT_PATH . 'vendor/autoload.php';
if ( ! file_exists( $cortext_autoload ) ) {
	add_action(
		'admin_notices',
		static function () {
			echo '<div class="notice notice-error"><p>';
			echo esc_html__( 'Cortext: Composer dependencies are missing. Run "composer install" in the plugin directory.', 'cortext' );
			echo '</p></div>';
		}
	);
	return;
}
require $cortext_autoload;

add_action(
	'plugins_loaded',
	static function () {
		\Cortext\Plugin::instance()->boot();
	}
);

register_activation_hook(
	__FILE__,
	static function () {
		// Register the document CPT and its trait taxonomy explicitly so
		// `flush_rewrite_rules()` below sees Cortext's rewrite rules. The
		// same registration runs again on `init` during normal boot via
		// `Plugin::boot()`.
		( new \Cortext\PostType\Document() )->register_post_type();
		( new \Cortext\PostType\Template() )->register_post_type();
		( new \Cortext\Taxonomy\TraitTaxonomy() )->register_taxonomy();
		( new \Cortext\FieldValues\FieldValueIndex() )->activate();
		flush_rewrite_rules();
	}
);

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	\WP_CLI::add_command( 'cortext seed', \Cortext\CLI\SeedDummyCollections::class );
	\WP_CLI::add_command( 'cortext field-values', \Cortext\CLI\FieldValues::class );
	\WP_CLI::add_command( 'cortext perf-seed', array( \Cortext\CLI\PerfBench::class, 'seed' ) );
	\WP_CLI::add_command( 'cortext perf-bench', array( \Cortext\CLI\PerfBench::class, 'bench' ) );
	\WP_CLI::add_command( 'cortext backfill-media', \Cortext\CLI\BackfillMedia::class );
	\WP_CLI::add_command( 'cortext backfill-mentions', \Cortext\CLI\BackfillMentions::class );
}
