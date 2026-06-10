// On-demand briefing tools — let the LLM call buildMorningBrief/buildNightBrief
// without waiting for the scheduled cron. Useful when the user says "give me
// my morning briefing" or "what does tomorrow look like" mid-day.

import type { Host } from '../../../src/core/modules.js';
import { buildMorningBrief, buildNightBrief } from '../gather.js';

const TODAY_BRIEF_INTENT =
  '\\b(brief|briefing|morning brief|today|what.*today|what.*on today|day overview)\\b';
// Require briefing-shaped phrasing, not just any mention of "tomorrow". The
// bare-word version pulled this tool into the manifest for prompts like
// "anything outdoor tomorrow getting rained on", where the chat model then
// preferred it over `weather_reschedule_check`.
const TOMORROW_BRIEF_INTENT =
  '\\b(evening brief(ing)?|night brief(ing)?|brief.*tomorrow|tomorrow.*brief|what.*tomorrow look|how.*tomorrow look|tomorrow overview|day overview.*tomorrow)\\b';

export function register(host: Host): void {
  host.tools.register({
    name: 'briefing_today',
    intentPattern: TODAY_BRIEF_INTENT,
    description:
      "Today's briefing: weather + calendar + tasks in one formatted reply. Use for 'morning briefing / what does today look like / brief me / what's on today'.",
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => buildMorningBrief(host, { signal: ctx.signal }),
  });

  host.tools.register({
    name: 'briefing_tomorrow',
    intentPattern: TOMORROW_BRIEF_INTENT,
    description:
      "Tomorrow's briefing: tomorrow's calendar + outstanding tasks. Use for 'what does tomorrow look like / how does tomorrow look / evening briefing / night brief / what's tomorrow'. " +
      'Always call — never refuse or compose a hallucinated agenda template.',
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => buildNightBrief(host, { signal: ctx.signal }),
  });
}
