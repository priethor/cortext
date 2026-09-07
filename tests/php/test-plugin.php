<?php
/**
 * Tests for Cortext\Plugin.
 *
 * @package Cortext
 */

declare( strict_types=1 );

namespace Cortext\Tests;

use Cortext\Plugin;
use Cortext\Templates;
use WorDBless\BaseTestCase;

final class Test_Plugin extends BaseTestCase {

	public function test_instance_is_idempotent(): void {
		$this->assertSame( Plugin::instance(), Plugin::instance() );
	}

	public function test_registers_templates_as_disabled_experiment(): void {
		$experiments = Plugin::instance()->register_experiments( array() );

		$this->assertSame(
			array(
				'id'          => Templates::EXPERIMENT_ID,
				'label'       => 'Templates',
				'description' => 'Start documents and collection rows from saved templates.',
				'group'       => 'Content',
				'default'     => false,
			),
			$experiments[0]
		);
	}
}
