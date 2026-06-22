// Live chat-turn activity. Tracks the main Modulus assistant's IN-FLIGHT turns
// so the panel's Agents tab can show it as "running" while it answers a message
// — from any chat surface (Telegram, the Dashboard chat, a chat-surface module),
// not just the browser stream the user is looking at.
//
// These markers are deliberately EPHEMERAL and in-memory, NOT agent_tasks. A
// chat turn already runs through the orchestrator directly; persisting it as a
// 'running' agent_task would make boot crash-recovery (src/cli/start.ts) re-queue
// and re-execute it as a headless Modulus task. An in-memory marker instead just
// disappears on restart, which is the correct behaviour for "is it running right
// now". The agents route shapes each live run into a synthetic running task row
// of the built-in Modulus agent, so the existing Activity UI renders it for free.

export interface ChatActivity {
  // Monotonic id, unique among live runs. The agents route negates it to form a
  // synthetic task id that never collides with a real (positive) agent_task id.
  id: number;
  chatId: number;
  userId: number;
  text: string;
  // Which chat surface the turn arrived on ('telegram', 'dashboard', a module
  // surface name, …), so the panel can say "Replying on Telegram". undefined when
  // the caller didn't label it.
  source?: string;
  startedAt: number;
}

// Handle for one in-flight turn. end() is idempotent and must run in a finally
// so a thrown/aborted turn still clears its marker.
export interface ChatActivityHandle {
  end(): void;
}

// The write side, handed to the main orchestrator. Kept structural so the
// orchestrator never imports the registry implementation.
export interface ChatActivityReporter {
  start(info: {
    chatId: number;
    userId: number;
    text: string;
    source?: string;
  }): ChatActivityHandle;
}

// Reporter + read side. The panel reads list() to surface live runs.
export interface ChatActivityRegistry extends ChatActivityReporter {
  list(): ChatActivity[];
}

export function createChatActivityRegistry(): ChatActivityRegistry {
  const live = new Map<number, ChatActivity>();
  let seq = 0;
  return {
    start(info) {
      const id = ++seq;
      live.set(id, {
        id,
        chatId: info.chatId,
        userId: info.userId,
        text: info.text,
        ...(info.source ? { source: info.source } : {}),
        startedAt: Date.now(),
      });
      let ended = false;
      return {
        end() {
          if (ended) return;
          ended = true;
          live.delete(id);
        },
      };
    },
    list: () => [...live.values()],
  };
}
