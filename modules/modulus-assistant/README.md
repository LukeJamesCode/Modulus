# modulus-assistant

Unified everyday assistant: Google Calendar, Google Tasks, local reminders, weather (Open-Meteo, no key), and scheduled morning/evening briefings — all in one extension.

## What it adds

**Tools (LLM-callable):** `calendar_list_events`, `calendar_add_event`, `calendar_quick_add`, `calendar_delete_event`, `tasks_list`, `tasks_add`, `tasks_complete`, `tasks_delete`, `tasks_list_tasklists`, `reminder_set`, `reminder_list`, `reminder_cancel`, `weather_get`, `briefing_today`, `briefing_tomorrow`, `plan_day`, `find_free_slot`, `smart_schedule_task`, `weather_reschedule_check`

**Slash commands:** `/events`, `/addevent`, `/quickadd`, `/delevent`, `/todos`, `/todo`, `/done`, `/tasks`, `/weather`, `/remind`, `/reminders`, `/morningbrief`, `/nightbrief`

**Background jobs:** event reminder sweep (5 min), reminder sweep (1 min), scheduled morning/evening briefings, and optional weather-reschedule alerts. Scheduled private data is sent only to `nudge_chat_id`, `briefing_chat_id`, or the single configured default chat.

## Setup

1. Create a Google Cloud project with the **Calendar API** and **Tasks API** enabled. Create an OAuth 2.0 Desktop client.
2. Run `modulus auth modulus-assistant` and paste the client ID and secret.
3. Run `modulus config` → `modulus-assistant` to set `default_location` and `time_zone`.

See [docs/extensions/modulus-assistant.md](../../docs/extensions/modulus-assistant.md) for the full reference.

## Settings (key ones)

| Key                    | Default         | Notes                                                  |
| ---------------------- | --------------- | ------------------------------------------------------ |
| `google_client_id`     | —               | Required                                               |
| `google_client_secret` | —               | Required (secret)                                      |
| `google_refresh_token` | —               | Set by `modulus auth` (secret)                          |
| `calendar_id`          | `primary`       | Calendar to read/write                                 |
| `default_tasklist`     | `@default`      | Task list to read/write                                |
| `default_location`     | —               | City for weather and briefings                         |
| `time_zone`            | system timezone | IANA tz for briefing schedules                         |
| `morning_time`         | `07:00`         | Morning briefing time in HH:MM 24-hour format (weekdays) |
| `night_time`           | `21:00`         | Evening briefing time in HH:MM 24-hour format (every day) |

## Data stored

- `reminders` table: one-shot reminders (local only)
- `calendar_nudges_sent` table: dedup log for event-reminder nudges
- `smart_scheduled_links` table: reminder↔event linkages
- OAuth credentials in `module_settings` (plaintext SQLite protected by `~/.modulus` file permissions and masked in Modulus UI/status output)
