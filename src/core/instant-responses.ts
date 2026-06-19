// Instant responses — templated replies shipped before the orchestrator runs
// the LLM. Ported from the gurney-instant-responses module into core, gated
// by the `instantResponses.enabled` setting and wired into both chat surfaces
// (the Telegram chat-dispatch pipeline and the panel's SSE chat route).
//
// Three modes, decided purely from the message text — no model call:
//
//  0. DETERMINISTIC ('reply') — the answer is a computed string (day-of-week,
//     the date, the current time, the model name). The small chat model gets
//     these wrong even with a system anchor, so we bypass the LLM entirely.
//  1. TRIVIAL ('reply') — the message IS chatter ("hi", "thanks", "ok"). Ship a
//     templated reply and skip the orchestrator. <5ms vs 8-15s for an LLM turn
//     on a Pi-class device.
//  2. OFFLOAD ACK ('ack') — the message has tool/query intent ("set an event",
//     "what's the weather"). The LLM still has to run, but we send a quick
//     "On it." / "Checking." ack first so the user isn't staring at a blank
//     chat for the 30-90s the model takes on CPU; the real answer follows.
//
// Each pattern maps to a pool of variants; we pick a random one, avoiding
// repetition within the same chat, so it doesn't feel canned. Greeting variants
// are time-of-day aware.

export type InstantResponse =
  // 'reply' is terminal — the caller sends it and must NOT run the orchestrator.
  | { mode: 'reply'; text: string }
  // 'ack' is a pre-answer — the caller sends it, then runs the orchestrator.
  | { mode: 'ack'; text: string };

export interface InstantResponder {
  // Classify `text` for `chatId`. Returns null to let the normal pipeline run.
  respond(text: string, chatId: number, now?: Date): InstantResponse | null;
}

export interface InstantResponderOptions {
  // Resolver for the active chat model tag, so "what model are you running"
  // answers truthfully (and provider-neutrally — the chat model may be a routed
  // cloud tag in Power Mode) instead of a hardcoded guess. Omit, or let it
  // throw / return empty, to fall back to a generic but still-accurate phrasing.
  modelName?: () => string;
}

type ReplyPool = string[] | ((hour: number) => string[]);

// ── Trivial replies — message IS the answer, no orchestrator follow-up ────
const TRIVIAL_REPLIES: Array<[RegExp, ReplyPool]> = [
  [
    /^(hi|hey|hello)[\s!?.]*$/i,
    (h) => {
      if (h < 5) return ['Up late?', 'Hey — still up?'];
      if (h < 10) return ['Morning.', 'Hey, morning.'];
      if (h < 17) return ['Hey.', 'Yo.', 'Hey — what do you need?'];
      return ['Hey.', 'Evening.'];
    },
  ],
  [
    /^(thanks|thank you|ty|cheers)[\s!?.]*$/i,
    ['Anytime.', 'You got it.', 'No problem.', 'Sure thing.'],
  ],
  [/^(ok|okay|alright|k|got it)[\s!?.]*$/i, ['Got it.', 'Cool.', 'Alright.', 'Noted.']],
  [/^(yes|yeah|yep|yup|absolutely|definitely)[\s!?.]*$/i, ['Yeah.', 'Right.', 'Cool.']],
  [/^(no|nah|nope|naw)[\s!?.]*$/i, ['Fair.', 'OK.', 'Alright.', 'No worries.']],
  [/^(bye|goodbye|cya|see ya|later)[\s!?.]*$/i, ['See you.', 'Later.', 'Catch you later.']],
  [
    /^(good|nice|cool|great|awesome|perfect|sick)[\s!?.]*$/i,
    ['Nice.', 'Good.', 'Glad to hear it.'],
  ],
  [/^(lol|haha|lmao|hehe|ha)[\s!?.]*$/i, ['Ha.', 'Heh.', 'Yeah.']],
  [
    /^(yo|sup|what'?s up|whats up)[\s!?.]*$/i,
    ['Not much. You?', "All good — what's up?", 'Hey. What do you need?'],
  ],
  [
    /^(hey|hi|hello)[\s,!.-]+(modulus[\s,!.-]+)?(how'?s?\s+it\s+going|how\s+are\s+you|how\s+you\s+doing)[?!.]*$/i,
    [
      'Doing alright. You?',
      'Not bad. How about you?',
      "Good — what's going on with you?",
      'All good over here. You?',
    ],
  ],
  [
    /^(hey|hi|hello)[\s,!.-]+(modulus[\s,!.-]+)?(what'?s\s+up|you\s+good|all\s+good)[?!.]*$/i,
    ['All good. What do you need?', 'Yeah, all good. You?', "Running fine. What's up?"],
  ],
  [/^(gm|good morning)[\s!?.]*$/i, ['Morning.', 'Hey, morning.']],
  [/^(gn|good night|goodnight)[\s!?.]*$/i, ['Night.', 'Sleep well.']],
  [/^(sure|sounds good|of course)[\s!?.]*$/i, ['Cool.', 'Alright.', 'Of course.']],
  [/^(i'?m (back|home)|home)[\s!?.]*$/i, ['Welcome back.', 'Hey — how was it?', 'Back already?']],
];

// ── Offload acks — quick "I'm working on it" while the LLM runs ───────────
//
// QUERY_RE catches information-seeking phrasings; anything else matching
// TOOL_INTENT_RE is treated as an action.
const QUERY_RE =
  /\b(what|when|how|show|list|check|look|get|weather|forecast|temperature|do i have|am i|is there)\b/i;

const TOOL_INTENT_RE =
  /\b(add|create|set|schedule|book|make|put|remove|delete|cancel|clear|replace|swap|move|reschedule|change|update|edit|modify|check|look up|search|find|what'?s (on|the|my)|what (are|do) (my|i)|show me|list|get|weather|temperature|timer|remind|calendar|events?|alarm|forecast|task|tasks|todo|todos|complete|completed|finish|finished|track|tracking|habit|habits|streak|log|logged|journal|entry|reflection|goal|goals|undo|revert|cancel that|delete that)\b/i;

const QUERY_ACKS = ['Checking.', 'Looking now.', 'One sec.', 'On it — checking.'];
const ACTION_ACKS = ['On it.', 'Got it.', 'Doing that now.', 'Sure thing.', 'Yeah, on it.'];

export function createInstantResponder(opts: InstantResponderOptions = {}): InstantResponder {
  // Per-chat memory of the last reply we sent, so a user who sends "hi" twice
  // in a row doesn't get the same variant verbatim. Keyed by chatId so chats
  // don't bleed into each other; instance-scoped so the daemon's two surfaces
  // (Telegram + panel) share one anti-repeat history when handed the same
  // responder.
  const lastReplyByChat = new Map<number, string>();

  function pickVariant(pool: string[], chatId: number): string {
    if (pool.length === 1) return pool[0]!;
    const last = lastReplyByChat.get(chatId);
    let pick: string;
    let attempts = 0;
    do {
      pick = pool[Math.floor(Math.random() * pool.length)]!;
      attempts += 1;
    } while (pick === last && attempts < 4);
    lastReplyByChat.set(chatId, pick);
    return pick;
  }

  function trivialReplyFor(message: string, chatId: number, hour: number): string | null {
    const m = message.trim();
    if (!m) return null;
    for (const [re, replyOrFn] of TRIVIAL_REPLIES) {
      if (re.test(m)) {
        const pool = typeof replyOrFn === 'function' ? replyOrFn(hour) : replyOrFn;
        return pickVariant(pool, chatId);
      }
    }
    return null;
  }

  // Deterministic replies that need the current Date. Kept separate from the
  // regex pool because the answer is a computed string, not a fixed variant.
  // The small chat model gets DOW/time/date questions wrong even when the
  // system anchor tells it the answer, so the safest fix is to bypass the LLM.
  function deterministicReplyFor(message: string, now: Date): string | null {
    const raw = message
      .trim()
      .toLowerCase()
      .replace(/[?!.\s]+$/, '');
    if (!raw) return null;
    // Strip an optional leading vocative / greeting so "Hey, what model are you
    // running?" matches the same patterns as "what model are you running".
    const m = raw.replace(/^(hey|hi|hello|yo|modulus)[\s,!.-]+/, '').trim();
    if (!m) return null;
    // "what day (of the week) is it" / "what day is today"
    if (/^what\s+day(\s+of\s+the\s+week)?\s+is\s+(it|today)$/.test(m)) {
      return now.toLocaleDateString('en-US', { weekday: 'long' });
    }
    // "what day is tomorrow"
    if (/^what\s+day\s+is\s+tomorrow$/.test(m)) {
      const t = new Date(now.getTime());
      t.setDate(t.getDate() + 1);
      return t.toLocaleDateString('en-US', { weekday: 'long' });
    }
    // "what model are you running" / "which model are you on". Answer from the
    // live config — a hardcoded family name goes stale the moment the user
    // points a profile at a different model (or a cloud provider in Power Mode).
    if (/^(what|which)\s+model\s+(are\s+you|you'?re)\s+(running|using|on)$/.test(m)) {
      let tag: string | undefined;
      try {
        tag = opts.modelName?.().trim() || undefined;
      } catch {
        tag = undefined;
      }
      return tag
        ? `I'm running on the ${tag} model — use /model to see or change the active profile.`
        : 'Use /model to see the model I’m currently running.';
    }
    // "what time is it (right now)" / "what's the time" — the small model
    // hallucinates GMT offsets and clock times, so answer deterministically.
    if (
      /^(what'?s\s+the\s+time|what\s+time\s+is\s+it(\s+right\s+now)?|what'?s\s+the\s+current\s+time)$/.test(
        m,
      )
    ) {
      const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const day = now.toLocaleDateString(undefined, { weekday: 'long' });
      return `${time} (${day}).`;
    }
    // "what's today's date"
    if (/^what'?s\s+(today'?s\s+date|the\s+date(\s+today)?)$/.test(m)) {
      return now.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    }
    // "what's the date next monday" / "what day is next friday" / "when is next
    // tuesday" — the small model consistently mis-computes "next <DOW>".
    const nextDow =
      /^(what'?s\s+the\s+date\s+|what\s+day\s+is\s+|when\s+is\s+)(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(
        m,
      );
    if (nextDow) {
      const target = [
        'sunday',
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
      ].indexOf(nextDow[3]!);
      const today = now.getDay();
      let delta = target - today;
      if (delta <= 0) delta += 7;
      const d = new Date(now.getTime());
      d.setDate(d.getDate() + delta);
      return d.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    }
    // "what's the date tomorrow" / "what's tomorrow's date"
    if (/^what'?s\s+(the\s+date\s+tomorrow|tomorrow'?s\s+date)$/.test(m)) {
      const d = new Date(now.getTime());
      d.setDate(d.getDate() + 1);
      return d.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    }
    return null;
  }

  function offloadAckFor(message: string, chatId: number): string | null {
    const m = message.trim();
    if (!m) return null;
    if (!TOOL_INTENT_RE.test(m)) return null;
    const pool = QUERY_RE.test(m) ? QUERY_ACKS : ACTION_ACKS;
    return pickVariant(pool, chatId);
  }

  return {
    respond(text, chatId, now = new Date()): InstantResponse | null {
      // Slash commands are routed before this runs; skip defensively.
      if (text.startsWith('/')) return null;
      const deterministic = deterministicReplyFor(text, now);
      if (deterministic !== null) return { mode: 'reply', text: deterministic };
      const trivial = trivialReplyFor(text, chatId, now.getHours());
      if (trivial !== null) return { mode: 'reply', text: trivial };
      const ack = offloadAckFor(text, chatId);
      if (ack !== null) return { mode: 'ack', text: ack };
      return null;
    },
  };
}
