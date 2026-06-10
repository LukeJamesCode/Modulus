// All 13 Telegram slash-commands for modulus-assistant.
// Commands are convenience wrappers the user can hit directly without
// round-tripping through the LLM.

import type { Host } from '../../src/core/modules.js';
import { formatEventLine, getClient as getCalClient, todayRangeIso } from './helpers/calendar.js';
import { formatTask, friendlyTaskError, getClient as getTasksClient } from './helpers/tasks.js';
import { parseReminderTime, splitReminderArgs } from './helpers/time.js';
import { getWeather } from './api/weather.js';
import {
  buildMorningBrief,
  buildNightBrief,
  briefingTimeZone,
  rememberBriefingChat,
} from './gather.js';

interface ReminderRow {
  id: number;
  text: string;
  fire_at: number;
}

export function register(host: Host): void {
  // ─── CALENDAR ───────────────────────────────────────────────────────────────

  host.telegram.command(
    'events',
    async (ctx) => {
      const c = getCalClient(host);
      if (!c) {
        await ctx.reply('Google Calendar is not configured. Run `modulus auth modulus-assistant`.');
        return;
      }
      const events = await c.listEvents(todayRangeIso(new Date(), briefingTimeZone(host)));
      await ctx.reply(
        events.length === 0
          ? 'No events today.'
          : events.map((ev) => formatEventLine(ev)).join('\n'),
      );
    },
    "List today's events",
  );

  host.telegram.command(
    'addevent',
    async (ctx) => {
      const sep = ctx.args.indexOf('|');
      if (sep === -1) {
        await ctx.reply('Usage: /addevent <ISO start> | <title>');
        return;
      }
      const start = ctx.args.slice(0, sep).trim();
      const summary = ctx.args.slice(sep + 1).trim();
      if (!start || !summary) {
        await ctx.reply('Usage: /addevent <ISO start> | <title>');
        return;
      }
      const startDate = new Date(start);
      if (Number.isNaN(startDate.getTime())) {
        await ctx.reply('Could not parse the start time. Try ISO 8601 (e.g. 2026-05-01T13:00).');
        return;
      }
      const end = new Date(startDate.getTime() + 60 * 60_000).toISOString();
      const c = getCalClient(host);
      if (!c) {
        await ctx.reply('Google Calendar is not configured.');
        return;
      }
      const ev = await c.addEvent({ summary, start: startDate.toISOString(), end });
      rememberNudgeChat(host, ctx.chatId);
      await ctx.reply(`Added: ${formatEventLine(ev)}`);
    },
    'Add an event: /addevent <ISO start> | <title>',
  );

  host.telegram.command(
    'quickadd',
    async (ctx) => {
      if (!ctx.args.trim()) {
        await ctx.reply('Usage: /quickadd Lunch with Sam Friday 1pm');
        return;
      }
      const c = getCalClient(host);
      if (!c) {
        await ctx.reply('Google Calendar is not configured.');
        return;
      }
      const ev = await c.quickAdd(ctx.args);
      rememberNudgeChat(host, ctx.chatId);
      await ctx.reply(`Added: ${formatEventLine(ev)}`);
    },
    'Natural-language quick add',
  );

  host.telegram.command(
    'delevent',
    async (ctx) => {
      const id = ctx.args.trim();
      if (!id) {
        await ctx.reply('Usage: /delevent <event id>');
        return;
      }
      const c = getCalClient(host);
      if (!c) {
        await ctx.reply('Google Calendar is not configured.');
        return;
      }
      await c.deleteEvent(id);
      await ctx.reply('Deleted.');
    },
    'Delete an event by id',
  );

  // ─── TASKS ──────────────────────────────────────────────────────────────────

  const TASKS_NOT_CONFIGURED =
    'Google Tasks is not configured. Run: modulus auth modulus-assistant';

  host.telegram.command(
    'todos',
    async (ctx) => {
      const c = getTasksClient(host);
      if (!c) {
        await ctx.reply(TASKS_NOT_CONFIGURED);
        return;
      }
      try {
        const tasks = await c.listTasks(false);
        await ctx.reply(
          tasks.length === 0 ? 'No incomplete tasks.' : tasks.map((t) => formatTask(t)).join('\n'),
        );
      } catch (e) {
        await ctx.reply(friendlyTaskError(e));
      }
    },
    'List incomplete tasks',
  );

  host.telegram.command(
    'todo',
    async (ctx) => {
      const title = ctx.args.trim();
      if (!title) {
        await ctx.reply('Usage: /todo <task title>');
        return;
      }
      const c = getTasksClient(host);
      if (!c) {
        await ctx.reply(TASKS_NOT_CONFIGURED);
        return;
      }
      try {
        const t = await c.addTask({ title });
        await ctx.reply(`Added: ${formatTask(t)}`);
      } catch (e) {
        await ctx.reply(friendlyTaskError(e));
      }
    },
    'Add a task: /todo <title>',
  );

  host.telegram.command(
    'done',
    async (ctx) => {
      const query = ctx.args.trim();
      if (!query) {
        await ctx.reply('Usage: /done <task title>');
        return;
      }
      const c = getTasksClient(host);
      if (!c) {
        await ctx.reply(TASKS_NOT_CONFIGURED);
        return;
      }
      try {
        const tasks = await c.listTasks(false);
        const needle = query.toLowerCase();
        const matches = tasks.filter((t) => t.title.toLowerCase().includes(needle));
        if (matches.length === 0) {
          await ctx.reply(`No incomplete task matching "${query}".`);
          return;
        }
        if (matches.length > 1) {
          await ctx.reply(
            `"${query}" matches ${matches.length} tasks — be more specific:\n` +
              matches.map((t) => `• ${t.title}`).join('\n'),
          );
          return;
        }
        await c.completeTask(matches[0]!.id);
        await ctx.reply(`Done: ${matches[0]!.title}`);
      } catch (e) {
        await ctx.reply(friendlyTaskError(e));
      }
    },
    'Complete a task: /done <title>',
  );

  host.telegram.command(
    'tasks',
    async (ctx) => {
      const c = getTasksClient(host);
      if (!c) {
        await ctx.reply(TASKS_NOT_CONFIGURED);
        return;
      }
      try {
        const lists = await c.listTaskLists();
        await ctx.reply(
          lists.length === 0 ? 'No task lists found.' : lists.map((l) => l.title).join('\n'),
        );
      } catch (e) {
        await ctx.reply(friendlyTaskError(e));
      }
    },
    'List available task lists',
  );

  // ─── WEATHER ─────────────────────────────────────────────────────────────────

  host.telegram.command(
    'weather',
    async (ctx) => {
      const loc = ctx.args.trim() || host.settings.get<string>('default_location');
      if (!loc) {
        await ctx.reply(
          'Usage: /weather <city>\nOr set default_location in settings: modulus config',
        );
        return;
      }
      await ctx.reply(await getWeather(loc));
    },
    'Current weather and 4-day forecast',
  );

  // ─── REMINDERS ───────────────────────────────────────────────────────────────

  host.telegram.command(
    'remind',
    async (ctx) => {
      const raw = ctx.args.trim();
      if (!raw) {
        await ctx.reply(
          'Usage: /remind <time> <message>\n\nExamples:\n' +
            '  /remind in 30 minutes Call the dentist\n' +
            '  /remind tomorrow at 9am Stand-up prep\n' +
            '  /remind at 3pm Review PR\n' +
            '  /remind in 2 hours Check the oven',
        );
        return;
      }

      const parsed = splitReminderArgs(raw);
      if (!parsed) {
        await ctx.reply(
          'Could not parse. Try:\n  /remind in 30 minutes <message>\n  /remind tomorrow at 9am <message>',
        );
        return;
      }

      const fireAt = parseReminderTime(parsed.timeStr);
      if (!fireAt) {
        await ctx.reply(`Could not parse time: "${parsed.timeStr}".`);
        return;
      }
      if (fireAt <= new Date()) {
        await ctx.reply('That time is already in the past. Try a future time.');
        return;
      }

      host.db
        .prepare(`INSERT INTO reminders (chat_id, text, fire_at, created_at) VALUES (?,?,?,?)`)
        .run(ctx.chatId, parsed.message, fireAt.getTime(), Date.now());

      await ctx.reply(`Reminder set for ${fireAt.toLocaleString()}: ${parsed.message}`);
    },
    'Set a reminder: /remind <time> <message>',
  );

  host.telegram.command(
    'reminders',
    async (ctx) => {
      const rows = host.db
        .prepare(
          `SELECT id, text, fire_at FROM reminders WHERE fired=0 AND chat_id=? ORDER BY fire_at LIMIT 20`,
        )
        .all(ctx.chatId) as ReminderRow[];
      if (rows.length === 0) {
        await ctx.reply('No upcoming reminders.');
        return;
      }
      await ctx.reply(
        rows.map((r) => `[${r.id}] ${new Date(r.fire_at).toLocaleString()}: ${r.text}`).join('\n'),
      );
    },
    'List upcoming reminders',
  );

  // ─── BRIEFINGS ───────────────────────────────────────────────────────────────

  host.telegram.command(
    'morningbrief',
    async (ctx) => {
      rememberBriefingChat(host, ctx.chatId);
      await ctx.reply(await buildMorningBrief(host));
    },
    "Today's weather, events, and tasks",
  );

  host.telegram.command(
    'nightbrief',
    async (ctx) => {
      rememberBriefingChat(host, ctx.chatId);
      await ctx.reply(await buildNightBrief(host));
    },
    "Evening summary: what's done, what's tomorrow",
  );
}

function rememberNudgeChat(host: Host, chatId: number): void {
  host.settings.set('nudge_chat_id', chatId);
}
