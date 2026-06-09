export interface SpawnAgentsTask {
  agent: string;
  task: string;
}

export type SpawnAgentsParse =
  | { ok: true; tasks: SpawnAgentsTask[] }
  | { ok: false; error: string };

export function parseSpawnAgentsArgs(
  args: Record<string, unknown>,
  maxTasks: number,
): SpawnAgentsParse {
  const rawTasks = args.tasks;

  if (!Array.isArray(rawTasks)) {
    return { ok: false, error: 'tasks must be an array' };
  }

  if (rawTasks.length === 0) {
    return { ok: false, error: 'tasks array must not be empty' };
  }

  if (rawTasks.length > maxTasks) {
    return { ok: false, error: `tasks array length exceeds maximum of ${maxTasks}` };
  }

  const tasks: SpawnAgentsTask[] = [];

  for (let i = 0; i < rawTasks.length; i++) {
    const item = rawTasks[i];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `task at index ${i} must be a non-null object` };
    }

    const record = item as Record<string, unknown>;

    if (typeof record.agent !== 'string') {
      return { ok: false, error: `task at index ${i} must have a string 'agent' field` };
    }

    const agent = record.agent.trim();
    if (agent.length === 0) {
      return { ok: false, error: `task at index ${i} has an empty 'agent' field` };
    }

    if (typeof record.task !== 'string') {
      return { ok: false, error: `task at index ${i} must have a string 'task' field` };
    }

    const task = record.task.trim();
    if (task.length === 0) {
      return { ok: false, error: `task at index ${i} has an empty 'task' field` };
    }

    tasks.push({ agent, task });
  }

  return { ok: true, tasks };
}
