# Meeting prep

A playbook for walking into a meeting ready, not scrambling.

## Steps

1. **Find the meeting.** Use `calendar_list_events` to locate it (today/this
   week unless the user names another time). Read back the time, attendees, and
   any description so you're both looking at the same thing.
2. **Figure out what "prepared" means here.** A 1:1, an external sales call, and
   a project review need different prep. Ask one clarifying question only if the
   purpose is genuinely unclear.
3. **Research what matters.** Use `web_search` for the things that change how the
   meeting goes — a company or person you'll be talking to, a topic on the
   agenda. Two or three targeted lookups, summarised in a few lines each. Skip it
   entirely for an internal sync where you already have context.
4. **Draft talking points.** Produce a short, ordered list: the outcome you want,
   the 2–4 points to make, and the open questions to ask. Keep it skimmable.
5. **Capture the follow-ups.** Offer to add concrete prep to-dos with `tasks_add`
   (e.g. "send the deck before the call") and, if there's a hard prep deadline,
   set a `reminder_set` so it doesn't slip.

## Guardrails

- Don't invent facts about an attendee or company — if a search turns up nothing
  solid, say so rather than filling the gap.
- Keep the prep proportional to the meeting; don't write a dossier for a standup.
