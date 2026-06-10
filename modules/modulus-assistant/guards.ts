// Post-turn reply guards for this module's domains. These catch the two
// hallucinations a small (0.8b/2b) chat model produces against everyday-assistant
// tools, and live here — not in core — because a host without this module has
// neither the tools nor the failure modes they guard. Registered via
// host.guards.register; the orchestrator runs each guard after finalizing a
// reply and the first non-null replacement wins.

import type { Host, TurnGuard, TurnGuardInput } from '../../src/core/modules.js';

// Detect the "I removed that for you" hallucination. qwen3.5:0.8b/2b will
// regularly answer a delete/cancel request by printing a confirmation in
// plaintext WITHOUT calling the destructive tool — leaving the user thinking
// the event/task/reminder is gone when it's still on the calendar. We catch
// this when three things line up:
//   - the user message contained a delete-shaped verb
//   - no destructive tool ran this turn (matched by name suffix)
//   - the model's reply contains a past-tense completion claim
// Both halves are necessary — the model legitimately uses "removed/deleted"
// when describing what it CAN do, or when summarizing a real delete result.
const DESTRUCTIVE_TOOL_PATTERN = /(?:_|^)(delete|cancel|remove|clear|wipe|drop)(?:_|$)/i;
const USER_DELETE_VERB_PATTERN = /\b(cancel|delete|remove|drop|wipe|clear|nuke|get rid of)\b/i;
const ASSISTANT_FAKE_CONFIRM_PATTERN =
  /\b(removed|deleted|cancell?ed|cleared|wiped|dropped|gone|nuked)\b/i;

const FAKE_DELETE_REPLY =
  "I didn't actually run the delete — I can see the item but the action didn't go through. Try the request again, ideally naming the date or id.";

export const fakeActionConfirmationGuard: TurnGuard = ({
  userText,
  assistantText,
  toolCalls,
}: TurnGuardInput): string | null => {
  if (!USER_DELETE_VERB_PATTERN.test(userText)) return null;
  if (!ASSISTANT_FAKE_CONFIRM_PATTERN.test(assistantText)) return null;
  const ranDestructive = toolCalls.some((c) => c.ok && DESTRUCTIVE_TOOL_PATTERN.test(c.name));
  return ranDestructive ? null : FAKE_DELETE_REPLY;
};

// Detect the "let me make up a forecast" hallucination. The 2B tool model
// will sometimes answer "what's the forecast for the next few days" from
// training data instead of calling `weather_get`, producing fabricated
// temperatures and precipitation odds. The shape is reliable: the user
// message contains a weather keyword, no weather tool ran this round, and
// the reply contains forecast-like content (a temperature unit or one of
// the standard weather nouns paired with a number).
const USER_WEATHER_QUESTION_PATTERN =
  /\b(weather|forecast|temperature|rain|raining|snow|snowing|sunny|cloudy|overcast|humid|humidity|degrees?|celsius|fahrenheit)\b/i;
const ASSISTANT_WEATHER_CLAIM_PATTERN =
  /(°\s?[CF]\b|\b\d{1,3}\s?(?:°|deg|degrees?)\b|\b(?:precip|precipitation|overcast|sunny|partly cloudy|mostly cloudy|chance of rain|chance of snow|showers?)\b)/i;
const WEATHER_TOOL_PATTERN = /(?:^|_)weather(?:_|$)/i;

const FAKE_WEATHER_REPLY =
  "I didn't actually check the forecast — that reply was made up. Ask again and I'll pull the real conditions.";

export const fakeWeatherAnswerGuard: TurnGuard = ({
  userText,
  assistantText,
  toolCalls,
}: TurnGuardInput): string | null => {
  if (!USER_WEATHER_QUESTION_PATTERN.test(userText)) return null;
  if (!ASSISTANT_WEATHER_CLAIM_PATTERN.test(assistantText)) return null;
  const ranWeather = toolCalls.some((c) => c.ok && WEATHER_TOOL_PATTERN.test(c.name));
  return ranWeather ? null : FAKE_WEATHER_REPLY;
};

export function register(host: Host): void {
  host.guards.register(fakeActionConfirmationGuard);
  host.guards.register(fakeWeatherAnswerGuard);
}
