import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveModuleSelection, type ModuleSelectionPlan } from './init.js';
import type { DiscoveredModule } from './ext-setup.js';

function ext(name: string, deps: string[] = []): DiscoveredModule {
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

function names(plan: ModuleSelectionPlan): string[] {
  return plan.modules.map((e) => e.name);
}

test('resolveModuleSelection adds bundled dependencies before selected modules', () => {
  const plan = resolveModuleSelection(
    [ext('modulus-dependent', ['modulus-voice']), ext('modulus-voice')],
    ['modulus-dependent'],
  );

  assert.deepEqual(names(plan), ['modulus-voice', 'modulus-dependent']);
  assert.deepEqual(plan.addedDependencies, ['modulus-voice']);
  assert.deepEqual(plan.missingDependencies, []);
});

test('resolveModuleSelection reports dependencies that are not bundled', () => {
  const plan = resolveModuleSelection(
    [ext('modulus-front', ['modulus-missing'])],
    ['modulus-front'],
  );

  assert.deepEqual(names(plan), ['modulus-front']);
  assert.deepEqual(plan.addedDependencies, []);
  assert.deepEqual(plan.missingDependencies, [
    { module: 'modulus-front', dependency: 'modulus-missing' },
  ]);
});
