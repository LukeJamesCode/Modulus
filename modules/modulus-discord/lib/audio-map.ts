// Parse the `<user_id>:<path>,<user_id>:<path>,...` map used by the
// entrance_sounds / talking_sounds settings. A naive split on every comma
// corrupts file paths that themselves contain commas (e.g.
// "Liam - Energetic, Social Media Creator.mp3"). Discord user ids are numeric
// snowflakes, so a new entry always begins with `<digits>:` — split only on a
// comma that precedes such a boundary, which leaves commas inside paths intact.
//
// Pure and dependency-free so it stays unit-testable without the heavy
// @discordjs/voice stack that the rest of voice.ts pulls in.
export function parseUserAudioMap(raw: string): Array<{ uid: string; path: string }> {
  if (!raw) return [];
  const out: Array<{ uid: string; path: string }> = [];
  for (const entry of raw.split(/,(?=\s*\d+\s*:)/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const uid = trimmed.slice(0, idx).trim();
    const path = trimmed.slice(idx + 1).trim();
    if (uid && path) out.push({ uid, path });
  }
  return out;
}
