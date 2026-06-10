import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldAutoRoute } from './tools.js';

test('shouldAutoRoute fires on substantial generative requests', () => {
  assert.equal(
    shouldAutoRoute('Draft a detailed step-by-step plan to set up Pi-hole on my network'),
    true,
  );
  assert.equal(
    shouldAutoRoute('Write a Python script that backs up my VM configs and keeps 7 days'),
    true,
  );
  assert.equal(shouldAutoRoute('refactor this module to be async and add error handling'), true);
  // Long produce request without an explicit substance word still routes.
  assert.equal(
    shouldAutoRoute(
      'write me something that takes the list of users and groups them by their signup month then totals each',
    ),
    true,
  );
});

test('shouldAutoRoute stays out of local actions and personal-data lookups', () => {
  assert.equal(shouldAutoRoute('remind me to take out the trash at 8pm'), false);
  assert.equal(shouldAutoRoute('what does my calendar look like today'), false);
  assert.equal(shouldAutoRoute('plan my day'), false);
  assert.equal(shouldAutoRoute("what's the weather tomorrow"), false);
});

test('shouldAutoRoute ignores trivial / short / non-generative messages', () => {
  assert.equal(shouldAutoRoute('hi'), false);
  assert.equal(shouldAutoRoute('what is 2+2'), false);
  assert.equal(shouldAutoRoute('thanks!'), false);
  assert.equal(shouldAutoRoute('how are you doing today'), false);
});
