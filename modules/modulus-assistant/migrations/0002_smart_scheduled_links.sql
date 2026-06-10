-- modulus-assistant 0002_smart_scheduled_links
-- Records which calendar events were created by smart_schedule_task so a
-- future "complete-and-clear" hook can find and delete them.

CREATE TABLE smart_scheduled_links (
  task_id      TEXT    NOT NULL,
  event_id     TEXT    NOT NULL,
  scheduled_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, event_id)
);

CREATE INDEX idx_smart_links_event ON smart_scheduled_links (event_id);
