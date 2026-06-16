# Trip planner

A playbook for turning "I want to go to X" into a concrete, calendar-ready trip.

## Steps

1. **Pin the basics.** Ask for (or confirm) the destinations, the rough dates,
   and how long at each stop. Don't guess dates — if they're vague ("sometime in
   spring"), propose a specific window and confirm.
2. **Check the user's calendar first.** Use `calendar_list_events` over the
   candidate window to spot conflicts before you propose anything. Never schedule
   over an existing commitment without flagging it.
3. **Research each stop.** Use `web_search` for one or two concrete things per
   stop the user actually needs — getting between stops, a neighbourhood to base
   in, opening days for a must-see. Keep it tight; don't dump a guidebook.
4. **Check the forecast** with `weather_get` for each stop's dates when the trip
   is within range, so the plan accounts for the weather (indoor backup days,
   what to pack).
5. **Propose the itinerary** as a short day-by-day outline. Lead with the shape
   (which days where), then the highlights. Ask for one round of adjustments.
6. **Put it on the calendar.** Only after the user approves, use
   `calendar_add_event` to add each leg (travel days and the stay at each stop).
   Confirm what you added.

## Guardrails

- Confirm before adding anything to the calendar — these are real events.
- Prefer fewer, higher-confidence searches over many shallow ones.
- If a tool you need isn't available, say what you'd do and ask the user to do
  that part, rather than pretending you booked something.
