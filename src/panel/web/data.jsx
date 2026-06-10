// Static labels + small offline fallbacks. Live data comes from the /api
// endpoints (see api.js); these keep the panel legible if the server can't be
// reached and give human labels to the raw capability strings modules
// declare in their manifests.

// Capability strings as they actually appear in module manifest.json files.
const CAP_LABELS = {
  network: { label: 'Network', tone: 'warn', hint: 'Talks to services over the internet.' },
  storage: { label: 'Local storage', tone: 'neutral', hint: 'Saves data on this machine.' },
  'auth:oauth': {
    label: 'Connects an account',
    tone: 'warn',
    hint: 'Uses an OAuth login (e.g. Google, ChatGPT).',
  },
  telegram: { label: 'Telegram', tone: 'neutral', hint: 'Adds Telegram commands or messages.' },
  scheduler: { label: 'Scheduled jobs', tone: 'neutral', hint: 'Runs work on a schedule.' },
  'local-device': {
    label: 'Local device',
    tone: 'neutral',
    hint: 'Talks to a device on your network.',
  },
  'cloud-model': { label: 'Cloud model', tone: 'err', hint: 'Can send data to a cloud AI model.' },
};

// Friendly one-liners for the bundled modules, keyed by manifest name. Used
// to enrich the gallery; falls back to the manifest description when absent.
const MODULE_BLURBS = {
  'modulus-assistant':
    'Google Calendar, tasks, local reminders, weather, and daily briefings — your day, planned.',
  'modulus-voice':
    'Two-way Telegram voice: spoken replies, and transcription of voice notes you send.',
  'modulus-instant-responses':
    'Fast templated replies for trivial chatter — without waking the model. Great on small hardware.',
  'modulus-codex':
    'Escalate hard coding tasks to a more capable cloud model — local-first, with a cloud fallback.',
  'modulus-frontend':
    "This control panel itself — the browser UI you're using right now. Always on while you're here.",
};

// Shown only when the server is unreachable, so the wizard/settings still render.
const FALLBACK_MODELS = [
  { tag: 'qwen3.5:0.8b', size: '—' },
  { tag: 'qwen3.5:3b', size: '—' },
];

Object.assign(window, { CAP_LABELS, MODULE_BLURBS, FALLBACK_MODELS });
