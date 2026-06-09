import { collectDoctorChecks, formatDoctorResults } from '../cli/doctor.js';

export async function collectDoctorReply(): Promise<string> {
  try {
    const results = await collectDoctorChecks();
    return truncateChat(formatDoctorResults(results));
  } catch (e) {
    return `Doctor failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function truncateChat(text: string, max = 3500): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 32) + `\n… truncated ${text.length - max + 32} chars`;
}
