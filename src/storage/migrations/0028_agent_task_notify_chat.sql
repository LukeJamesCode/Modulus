-- 0028_agent_task_notify_chat: the chat to ping when a task finishes.
--
-- A task dispatched from a chat surface (Telegram /dispatch) records the
-- originating chat here so the queue can send a done/failed notification when
-- the task reaches a terminal state. NULL = no notification: delegated/spawned
-- sub-tasks, fleet-tool dispatches, and the panel (which has its own live view).
ALTER TABLE agent_tasks ADD COLUMN notify_chat_id INTEGER;
