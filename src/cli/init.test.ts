import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveExtensionSelection, type ExtensionSelectionPlan } from './init.js';
import type { DiscoveredExtension } from './ext-setup.js';

function ext(name: string, deps: string[] = []): DiscoveredExtension {
  return {
    name,
    folder: `/tmp/${name}`,
    manifest: {
      name,
      version: '0.1.0',
      modulus: '*',
      deps,
    },
  };
}

function names(plan: ExtensionSelectionPlan): string[] {
  return plan.extensions.map((e) => e.name);
}

test('resolveExtensionSelection adds bundled dependencies before selected extensions', () => {
  const plan = resolveExtensionSelection(
    [ext('modulus-dependent', ['modulus-voice']), ext('modulus-voice')],
    ['modulus-dependent'],
  );

  assert.deepEqual(names(plan), ['modulus-voice', 'modulus-dependent']);
  assert.deepEqual(plan.addedDependencies, ['modulus-voice']);
  assert.deepEqual(plan.missingDependencies, []);
});

test('resolveExtensionSelection reports dependencies that are not bundled', () => {
  const plan = resolveExtensionSelection(
    [ext('modulus-front', ['modulus-missing'])],
    ['modulus-front'],
  );

  assert.deepEqual(names(plan), ['modulus-front']);
  assert.deepEqual(plan.addedDependencies, []);
  assert.deepEqual(plan.missingDependencies, [
    { extension: 'modulus-front', dependency: 'modulus-missing' },
  ]);
});
