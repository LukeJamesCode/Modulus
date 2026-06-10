// Thin Google Tasks v1 client. Direct fetch — no SDK. Handles access-token
// refresh from a long-lived refresh token via the shared ./google-client.ts
// core (same plumbing as api/calendar.ts).

import { createGoogleApi, type AccessTokenCache, type FetchLike } from './google-client.js';

export interface TasksCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  default_tasklist: string;
}

export interface Task {
  id: string;
  title: string;
  notes?: string;
  due?: string; // RFC 3339
  status: 'needsAction' | 'completed';
  completed?: string; // RFC 3339
  position?: string;
}

export interface TaskList {
  id: string;
  title: string;
}

export type TasksAccessTokenCache = AccessTokenCache;

export class TasksApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TasksApiError';
  }
}

export interface TasksClientOptions {
  creds: TasksCredentials;
  fetchImpl?: FetchLike;
  cache?: { current: TasksAccessTokenCache | null };
  now?: () => number;
  signal?: AbortSignal;
}

export function createTasksClient(opts: TasksClientOptions) {
  const { api } = createGoogleApi({
    creds: opts.creds,
    label: 'tasks',
    buildUrl: (path) => `https://tasks.googleapis.com/tasks/v1${path}`,
    makeError: (status, message) => new TasksApiError(status, message),
    fetchImpl: opts.fetchImpl,
    cache: opts.cache,
    now: opts.now,
    signal: opts.signal,
  });

  function flattenTask(t: GoogleTask): Task {
    return {
      id: t.id,
      title: t.title ?? '(no title)',
      ...(t.notes ? { notes: t.notes } : {}),
      ...(t.due ? { due: t.due } : {}),
      status: t.status ?? 'needsAction',
      ...(t.completed ? { completed: t.completed } : {}),
      ...(t.position ? { position: t.position } : {}),
    };
  }

  const listId = () => encodeURIComponent(opts.creds.default_tasklist);

  return {
    async listTaskLists(): Promise<TaskList[]> {
      const j = (await api('GET', '/users/@me/lists')) as {
        items?: Array<{ id: string; title: string }>;
      };
      return (j.items ?? []).map((l) => ({ id: l.id, title: l.title }));
    },

    async listTasks(showCompleted = false, tasklistId?: string): Promise<Task[]> {
      const lid = tasklistId ? encodeURIComponent(tasklistId) : listId();
      const all: Task[] = [];
      let pageToken: string | undefined;
      // Cap at 5 pages × 100 = 500 tasks. Anything beyond that is a power user
      // who should be using Google's own UI; we don't want a runaway loop.
      for (let pages = 0; pages < 5; pages++) {
        const params = new URLSearchParams({
          showCompleted: String(showCompleted),
          showHidden: 'false',
          maxResults: '100',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const j = (await api('GET', `/lists/${lid}/tasks?${params.toString()}`)) as {
          items?: GoogleTask[];
          nextPageToken?: string;
        };
        for (const t of j.items ?? []) all.push(flattenTask(t));
        if (!j.nextPageToken) break;
        pageToken = j.nextPageToken;
      }
      return all;
    },

    async addTask(opts2: {
      title: string;
      notes?: string;
      due?: string;
      tasklistId?: string;
    }): Promise<Task> {
      const lid = opts2.tasklistId ? encodeURIComponent(opts2.tasklistId) : listId();
      const body: Record<string, unknown> = { title: opts2.title };
      if (opts2.notes) body['notes'] = opts2.notes;
      if (opts2.due) body['due'] = opts2.due;
      const j = (await api('POST', `/lists/${lid}/tasks`, body)) as GoogleTask;
      return flattenTask(j);
    },

    async completeTask(taskId: string, tasklistId?: string): Promise<Task> {
      const lid = tasklistId ? encodeURIComponent(tasklistId) : listId();
      const tid = encodeURIComponent(taskId);
      const j = (await api('PATCH', `/lists/${lid}/tasks/${tid}`, {
        status: 'completed',
      })) as GoogleTask;
      return flattenTask(j);
    },

    async deleteTask(taskId: string, tasklistId?: string): Promise<void> {
      const lid = tasklistId ? encodeURIComponent(tasklistId) : listId();
      const tid = encodeURIComponent(taskId);
      await api('DELETE', `/lists/${lid}/tasks/${tid}`);
    },
  };
}

export type TasksClient = ReturnType<typeof createTasksClient>;

interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
  completed?: string;
  position?: string;
}
