// Verify the manifest intent_pattern is a valid regex and matches at least one
// representative phrase from each tool family. Catches typos in the pattern
// that would prevent the module from routing correctly.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')) as {
  intent_pattern: string;
};

const pattern = new RegExp(manifest.intent_pattern, 'i');

const SHOULD_MATCH: Array<[string, string]> = [
  // Calendar
  ['calendar phrase', 'add an event tomorrow at 3pm'],
  ['calendar phrase', 'what meetings do I have today'],
  ['calendar phrase', 'reschedule my appointment'],
  ['calendar phrase', "what's scheduled for Friday"],
  ['calendar phrase', 'am i free Thursday afternoon'],
  // Delete phrasing — the user's noun won't always be event/meeting/etc.
  // "remove eating pizza on may 30th" must still expose the calendar tools.
  ['delete phrase', 'remove eating pizza on may 30th'],
  ['delete phrase', 'cancel my dentist'],
  ['delete phrase', 'drop the 3pm thing'],
  // Tasks
  ['task phrase', 'add buy milk to my todo list'],
  ['task phrase', 'I need to finish the report'],
  ['task phrase', 'mark the dentist appointment as done'],
  ['task phrase', 'show me my tasks'],
  // Reminders
  ['reminder phrase', 'remind me to call the vet'],
  ['reminder phrase', 'set a reminder for 3pm'],
  ['reminder phrase', 'ping me in 30 minutes'],
  // Weather
  ['weather phrase', "what's the weather like today"],
  ['weather phrase', 'will it rain tomorrow'],
  ['weather phrase', "what's the temperature outside"],
  ['weather phrase', 'is it going to be sunny this weekend'],
  // Day-planning / briefing
  ['briefing phrase', 'give me a briefing'],
  ['briefing phrase', 'plan my day'],
  ['briefing phrase', 'when am i free today'],
  ['briefing phrase', 'find me a free slot this afternoon'],
  ['briefing phrase', 'block out time for the presentation'],
  ['briefing phrase', 'will the weather affect my outdoor plans'],
  // Learned routines
  ['routine phrase', 'what routines have you learned'],
  ['routine phrase', 'forget the task review routine'],
];

for (const [label, phrase] of SHOULD_MATCH) {
  test(`intent_pattern matches ${label}: "${phrase}"`, () => {
    assert.ok(pattern.test(phrase), `Expected intent_pattern to match "${phrase}" (${label})`);
  });
}

test('intent_pattern is a valid RegExp', () => {
  assert.ok(pattern instanceof RegExp);
  assert.ok(pattern.source.length > 10, 'pattern should be non-trivial');
});

test('intent_pattern stays under the 256-char module loader limit', () => {
  // src/core/modules.ts silently drops any intent_pattern longer than 256
  // chars, which disables intent pruning entirely and exposes every tool on
  // every turn (a ~3x prompt-token blowup that turned a 40s turn into 100s).
  // Catch this in CI instead of on the next abilitytest run.
  assert.ok(
    manifest.intent_pattern.length <= 256,
    `intent_pattern is ${manifest.intent_pattern.length} chars; limit is 256`,
  );
});
