# Day planner

A playbook for turning a vague "what should I do today?" into a plan that fits.

## Steps

1. **See the day as it is.** Use `calendar_list_events` for today's fixed
   commitments and `tasks_list` for what's outstanding. If a `plan_day` tool is
   available, lead with it — it already blends the two.
2. **Sort the tasks.** Group into must-do-today, would-be-nice, and can-wait.
   Ask the user only if the priorities are genuinely ambiguous.
3. **Fit work to the gaps.** Use `find_free_slot` to place the must-dos in the
   real openings between meetings — don't plan eight hours of focus work into a
   day that's already half meetings.
4. **Account for the weather** with `weather_get` when the plan involves anything
   outdoors or a commute, and adjust (move the run earlier, plan for the rain).
5. **Hand back a simple timeline.** A short, ordered list: time-blocked must-dos
   around the fixed events, then the optional list. Offer a `reminder_set` for
   the one or two things that would hurt most if forgotten.

## Guardrails

- Be realistic about how much fits — a plan the user can't actually finish is
  worse than an honest shorter one.
- Don't move or create calendar events here; this skill plans, it doesn't
  reschedule. Suggest changes and let the user confirm separately.
