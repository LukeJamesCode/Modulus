import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decide, parseCsvSet, type AllowlistConfig } from './allowlist.js';

const BOT_ID = 'bot-1';

function cfg(opts: { dmAllow?: string[] }): AllowlistConfig {
  return {
    allowedDmUserIds: new Set(opts.dmAllow ?? []),
    botUserId: BOT_ID,
  };
}

test('parseCsvSet trims and drops empty entries', () => {
  assert.deepEqual([...parseCsvSet(' a , b ,, c')], ['a', 'b', 'c']);
  assert.deepEqual([...parseCsvSet('')], []);
  assert.deepEqual([...parseCsvSet(undefined)], []);
});

test('allowlist: DM from allowlisted user passes', () => {
  const d = decide(cfg({ dmAllow: ['u-1'] }), {
    authorId: 'u-1',
    authorIsBot: false,
    isWebhook: false,
    channelId: 'dm-1',
    guildId: null,
    mentionedUserIds: new Set(),
  });
  assert.equal(d.allow, true);
  if (d.allow) assert.equal(d.kind, 'dm');
});

test('allowlist: DM from non-allowlisted user denied', () => {
  const d = decide(cfg({ dmAllow: ['u-1'] }), {
    authorId: 'u-stranger',
    authorIsBot: false,
    isWebhook: false,
    channelId: 'dm-1',
    guildId: null,
    mentionedUserIds: new Set(),
  });
  assert.equal(d.allow, false);
  if (!d.allow) assert.equal(d.reason, 'dm_not_allowed');
});

test('allowlist: guild channel requires both user-allowlist AND mention', () => {
  // Per-channel opt-in was removed (commit "Remove discord channel
  // verification"): a guild message is allowed only when the author is on the
  // global user allowlist AND the bot is @-mentioned. The mention requirement
  // is non-negotiable — the safety doc forbids default-on group-chat intercept.

  // Allowlisted user, but no mention → denied (mention is mandatory).
  const noMention = decide(cfg({ dmAllow: ['u-1'] }), {
    authorId: 'u-1',
    authorIsBot: false,
    isWebhook: false,
    channelId: 'c-1',
    guildId: 'g-1',
    mentionedUserIds: new Set(),
  });
  assert.equal(noMention.allow, false);
  if (!noMention.allow) assert.equal(noMention.reason, 'guild_not_mentioned');

  // Mention but author not on the user allowlist → denied.
  const notAllowed = decide(cfg({}), {
    authorId: 'u-1',
    authorIsBot: false,
    isWebhook: false,
    channelId: 'c-1',
    guildId: 'g-1',
    mentionedUserIds: new Set([BOT_ID]),
  });
  assert.equal(notAllowed.allow, false);
  if (!notAllowed.allow) assert.equal(notAllowed.reason, 'dm_not_allowed');

  // Allowlisted user AND mention → allowed.
  const ok = decide(cfg({ dmAllow: ['u-1'] }), {
    authorId: 'u-1',
    authorIsBot: false,
    isWebhook: false,
    channelId: 'c-1',
    guildId: 'g-1',
    mentionedUserIds: new Set([BOT_ID]),
  });
  assert.equal(ok.allow, true);
  if (ok.allow) assert.equal(ok.kind, 'mention');
});

test('allowlist: default-off — empty allowlists deny every message', () => {
  const dm = decide(cfg({}), {
    authorId: 'u-1',
    authorIsBot: false,
    isWebhook: false,
    channelId: 'dm-1',
    guildId: null,
    mentionedUserIds: new Set(),
  });
  assert.equal(dm.allow, false);

  const guild = decide(cfg({}), {
    authorId: 'u-1',
    authorIsBot: false,
    isWebhook: false,
    channelId: 'c-1',
    guildId: 'g-1',
    mentionedUserIds: new Set([BOT_ID]),
  });
  assert.equal(guild.allow, false);
});

test('allowlist: bot messages and webhooks always dropped', () => {
  const bot = decide(cfg({ dmAllow: ['u-bot'] }), {
    authorId: 'u-bot',
    authorIsBot: true,
    isWebhook: false,
    channelId: 'dm-1',
    guildId: null,
    mentionedUserIds: new Set(),
  });
  assert.equal(bot.allow, false);
  if (!bot.allow) assert.equal(bot.reason, 'is_bot');

  const hook = decide(cfg({ dmAllow: ['u-hook'] }), {
    authorId: 'u-hook',
    authorIsBot: false,
    isWebhook: true,
    channelId: 'dm-1',
    guildId: null,
    mentionedUserIds: new Set(),
  });
  assert.equal(hook.allow, false);
  if (!hook.allow) assert.equal(hook.reason, 'is_webhook');
});

test('allowlist: self-messages dropped even when somehow on allowlist', () => {
  const d = decide(cfg({ dmAllow: [BOT_ID] }), {
    authorId: BOT_ID,
    authorIsBot: false,
    isWebhook: false,
    channelId: 'dm-1',
    guildId: null,
    mentionedUserIds: new Set(),
  });
  assert.equal(d.allow, false);
  if (!d.allow) assert.equal(d.reason, 'self_message');
});
