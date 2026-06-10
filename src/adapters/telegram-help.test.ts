import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildTelegramButtonRows,
  buildTelegramHelp,
  formatModulesText,
  formatPendingFollowups,
  handleFollowupCancel,
  handleFollowupClear,
} from './telegram.js';

test('/help lists core commands and excludes any codex commands', () => {
  const help = buildTelegramHelp();

  assert.match(help, /\/help — this list/);
  assert.match(help, /\/newchat — reset the conversation/);
  assert.match(help, /\/proactive — list scheduled proactive jobs and quiet state/);
  assert.match(help, /\/nudges — show recent proactive nudges in this chat/);
  assert.match(help, /\/why — explain the most recent proactive nudge/);
  assert.doesNotMatch(help, /codex/i);
});

test('/help groups installed modules and their commands', () => {
  const help = buildTelegramHelp({
    modules: [
      { name: 'modulus-google-calendar', enabled: true },
      { name: 'modulus-weather', enabled: false },
    ],
    moduleCommands: [
      {
        module: 'modulus-google-calendar',
        name: 'events',
        description: "List today's events",
        handler: async () => undefined,
      },
    ],
  });

  assert.match(help, /Modules:/);
  assert.match(help, /modulus-google-calendar \(ready\)/);
  assert.match(help, /• modulus-weather \(disabled\)/);
  assert.match(help, /Module commands:/);
  assert.match(help, /\[modulus-google-calendar\]/);
  assert.match(help, /\/events — List today's events/);
});

test('/modules formats readiness, reasons, and next actions', () => {
  const text = formatModulesText([
    {
      name: 'modulus-everyday-assistant',
      version: '0.1.0',
      folder: '/tmp/modulus-everyday-assistant',
      source: 'repo',
      enabled: true,
      status: 'needs_auth',
      reasons: ['missing auth setting: google_refresh_token'],
      nextAction: 'modulus auth modulus-everyday-assistant',
    },
  ]);

  assert.match(text, /modulus-everyday-assistant — needs_auth/);
  assert.match(text, /missing auth setting: google_refresh_token/);
  assert.match(text, /next: modulus auth modulus-everyday-assistant/);
});

test('each view has at most 4 buttons scoped to its own actions', () => {
  // help: single new-chat button
  const helpFlat = buildTelegramButtonRows('help').flat();
  assert.deepEqual(helpFlat, [{ text: '💬 New chat', action: 'core:newchat' }]);

  // modules: refresh + up to 3 module shortcuts, no nav buttons
  const extFlat = buildTelegramButtonRows('modules', {
    moduleCommands: [
      {
        module: 'modulus-weather',
        name: 'weather',
        description: 'Show weather',
        handler: async () => undefined,
      },
    ],
  }).flat();
  assert.ok(extFlat.some((b) => b.action === 'ext:weather'));
  assert.ok(extFlat.some((b) => b.action === 'core:modules'));
  assert.ok(extFlat.length <= 4);
  assert.ok(!extFlat.some((b) => b.action === 'core:help'));
  assert.ok(!extFlat.some((b) => b.action === 'core:model'));

  // home: navigation buttons only
  const homeFlat = buildTelegramButtonRows('home').flat();
  assert.ok(homeFlat.some((b) => b.action === 'core:newchat'));
  assert.ok(homeFlat.length <= 4);
});

test('quiet buttons include on/off and snooze options within the 4-button limit', () => {
  const flat = buildTelegramButtonRows('quiet').flat();

  assert.ok(flat.some((b) => b.action === 'core:quiet:on'));
  assert.ok(flat.some((b) => b.action === 'core:quiet:off'));
  assert.ok(flat.some((b) => b.action === 'core:quiet:30m'));
  assert.ok(flat.some((b) => b.action === 'core:quiet:1h'));
  assert.ok(flat.length <= 4);
});

test('/help advertises followup audit and control commands', () => {
  const help = buildTelegramHelp();

  assert.match(help, /\/followups — list pending proactive followups/);
  assert.match(help, /\/followup_cancel <id> — cancel a pending followup by id/);
  assert.match(help, /\/followup_clear — cancel all pending followups in this chat/);
});

test('followup command helpers format and scope replies', () => {
  const cancelled: Array<{ chatId: number; id: number }> = [];
  const followups = {
    schedule: () => 0,
    sweep: () => [],
    listPending: () => [],
    cancel: (chatId: number, id: number) => {
      cancelled.push({ chatId, id });
      return chatId === 42 && id === 12;
    },
    clearPending: (chatId: number) => (chatId === 42 ? 2 : 0),
  };

  assert.equal(
    formatPendingFollowups([
      {
        id: 12,
        chatId: 42,
        dueAt: Date.parse('2026-05-04T12:30:00Z'),
        topic: 'Check in',
        createdAt: Date.parse('2026-05-04T12:00:00Z'),
      },
    ]),
    [
      'Pending followups for this chat:',
      '#12 — 2026-05-04T12:30:00Z — Check in',
      '',
      'Cancel one with /followup_cancel <id>.',
    ].join('\n'),
  );
  assert.equal(handleFollowupCancel(followups, 42, '12'), 'Cancelled followup #12.');
  assert.equal(handleFollowupCancel(followups, 7, '12'), 'No pending followup #12 for this chat.');
  assert.equal(handleFollowupCancel(followups, 42, '12abc'), 'Usage: /followup_cancel <id>');
  assert.deepEqual(cancelled, [
    { chatId: 42, id: 12 },
    { chatId: 7, id: 12 },
  ]);
  assert.equal(handleFollowupClear(followups, 42), 'Cancelled 2 pending followups for this chat.');
  assert.equal(handleFollowupClear(followups, 7), 'No pending followups for this chat.');
});
