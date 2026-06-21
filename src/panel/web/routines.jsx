// Routines tab: the one home for automation. Every routine is the same object —
// do X · on a trigger · (optionally) tell me on Telegram. The trigger picker
// hides the schedule-vs-watch split; the server (routes/routines.ts) maps each
// to the right store. Single-step + time-triggered today; multi-step steps and
// a template gallery are the next phases.
const { useState, useEffect, useCallback } = React;

/* ---- date helpers (mirror agents.jsx) ---- */
function localDateTimeValue(ms) {
  const d = new Date(ms);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function parseLocalDateTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/* ---- small layout helper (local copy of the agents.jsx one) ---- */
function Field({ label, hint, children }) {
  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <window.Label hint={hint}>{label}</window.Label>
      {children}
    </div>
  );
}

const textareaStyle = {
  width: '100%',
  resize: 'vertical',
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  font: 'inherit',
};

// One row of the schedule step editor: who runs it, what to do, and (after the
// first step) an optional condition gating it on earlier output.
function StepEditor({ index, step, agents, canRemove, canMoveUp, canMoveDown, onChange, onRemove, onMove }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: 12,
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', flex: 1 }}>
          Step {index + 1}
        </span>
        <window.Button size="sm" variant="subtle" icon="chevron-up" title="Move up" disabled={!canMoveUp} onClick={() => onMove(-1)} />
        <window.Button size="sm" variant="subtle" icon="chevron-down" title="Move down" disabled={!canMoveDown} onClick={() => onMove(1)} />
        <window.Button size="sm" variant="subtle" icon="trash" title="Remove step" disabled={!canRemove} onClick={onRemove} />
      </div>
      <window.Select value={step.agentId} onChange={(e) => onChange({ agentId: e.target.value })}>
        <option value="">Just message me</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </window.Select>
      <textarea
        value={step.instruction}
        onChange={(e) => onChange({ instruction: e.target.value })}
        rows={2}
        placeholder={index === 0 ? "e.g. Pull together today's agenda" : 'e.g. Summarize the news'}
        style={textareaStyle}
      />
      {index > 0 && (
        <window.Input
          value={step.condition}
          placeholder="Only if earlier output mentions… (optional)"
          onChange={(e) => onChange({ condition: e.target.value })}
        />
      )}
    </div>
  );
}

const TRIGGERS = [
  { id: 'once', label: 'At a time', icon: 'clock' },
  { id: 'recurring', label: 'Repeating', icon: 'clock' },
  { id: 'watch', label: 'When something changes', icon: 'eye' },
];

const REPEAT_PRESETS = [
  'every weekday at 8am',
  'every day at 9am',
  'every Monday at 9am',
  'every hour',
];

// Friendly name for a module slug shown in the gallery's "needs X" chip.
const MODULE_LABELS = {
  'modulus-assistant': 'Assistant',
  'modulus-websearch': 'Web Search',
  'modulus-browser': 'Browser',
};
function prettyModule(slug) {
  return (
    MODULE_LABELS[slug] ||
    slug
      .replace(/^modulus-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Curated starter routines. A `step.agent` flag means "needs one of your agents"
// (filled with your first agent on open, then editable); otherwise it's a
// "just message me" step. `requiresModule` greys the card until that module is
// enabled. All cron-based so no date picking is needed to try one.
const TEMPLATES = [
  {
    id: 'daily-agenda',
    emoji: '📅',
    title: 'Daily agenda',
    blurb: 'Every weekday morning, summarize your calendar and to-dos.',
    requiresModule: 'modulus-assistant',
    trigger: 'recurring',
    cron: '30 7 * * 1-5',
    when: 'every weekday at 7:30am',
    notify: true,
    steps: [
      {
        agent: true,
        instruction:
          'Look at my calendar and tasks for today and give me a short, friendly summary of my day.',
      },
    ],
  },
  {
    id: 'news-digest',
    emoji: '📰',
    title: 'Morning news digest',
    blurb: 'A daily summary of the news in your areas of interest.',
    requiresModule: 'modulus-websearch',
    trigger: 'recurring',
    cron: '0 8 * * *',
    when: 'every day at 8am',
    notify: true,
    steps: [
      {
        agent: true,
        instruction: 'Find the top news in my areas of interest and summarize the highlights.',
      },
    ],
  },
  {
    id: 'morning-brief',
    emoji: '🌅',
    title: 'Morning brief (multi-step)',
    blurb: 'Agenda, then news, then a friendly sign-off — three steps in sequence.',
    requiresModule: 'modulus-assistant',
    trigger: 'recurring',
    cron: '0 7 * * 1-5',
    when: 'every weekday at 7am',
    notify: true,
    steps: [
      { agent: true, instruction: "Pull together today's agenda from my calendar and tasks." },
      { agent: true, instruction: 'Summarize any overnight news worth knowing.' },
      { agent: false, instruction: "That's your morning brief — have a great day!" },
    ],
  },
  {
    id: 'weekly-review',
    emoji: '📝',
    title: 'Weekly review',
    blurb: 'Friday afternoon: recap the week and draft next week’s priorities.',
    trigger: 'recurring',
    cron: '0 16 * * 5',
    when: 'every Friday at 4pm',
    notify: true,
    steps: [
      {
        agent: true,
        instruction:
          'Summarize what I accomplished this week and draft a short plan for next week.',
      },
    ],
  },
  {
    id: 'pay-day',
    emoji: '💸',
    title: 'Pay-day reminder',
    blurb: 'A monthly nudge to move money to savings and pay bills.',
    trigger: 'recurring',
    cron: '0 9 1 * *',
    when: 'monthly on the 1st at 9am',
    notify: true,
    steps: [{ agent: false, instruction: 'Pay day! Move money to savings and pay any bills due.' }],
  },
  {
    id: 'keep-an-eye',
    emoji: '🔎',
    title: 'Keep an eye on something',
    blurb: 'Have an agent watch a topic and ping you when something changes.',
    requiresModule: 'modulus-websearch',
    trigger: 'watch',
    cron: null,
    when: '',
    notify: true,
    steps: [
      {
        agent: true,
        instruction: 'Check <topic> for anything new and let me know if something important changed.',
      },
    ],
  },
];

// Map a template to the `initial` shape RoutineModal pre-fills from.
function templateToInitial(template, agents) {
  const firstAgent = agents[0] ? agents[0].id : null;
  return {
    kind: template.trigger === 'watch' ? 'watch' : 'schedule',
    trigger: template.trigger,
    steps: template.steps.map((s) => ({
      agentId: s.agent ? firstAgent : null,
      instruction: s.instruction,
      condition: s.condition || '',
    })),
    cron: template.cron || null,
    when: template.when || '',
    notify: !!template.notify,
    agentIds: template.trigger === 'watch' && firstAgent ? [firstAgent] : [],
  };
}

function triggerMeta(routine) {
  if (routine.kind === 'watch') return { label: 'Watches', icon: 'eye' };
  if (routine.trigger === 'recurring') return { label: 'Repeats', icon: 'clock' };
  return { label: 'Once', icon: 'clock' };
}

function whenLine(routine) {
  if (routine.kind === 'watch') {
    return routine.cron ? routine.when : 'Checks continuously';
  }
  return routine.when;
}

function trustLine(routine) {
  // Prefer a status marker once it has actually run.
  let last = null;
  if (routine.lastRunAt) {
    const at = new Date(routine.lastRunAt).toLocaleString();
    last =
      routine.lastStatus === 'error'
        ? `⚠ Failed ${at}`
        : routine.lastStatus === 'ok'
          ? `✓ Ran ${at}`
          : `Last ran ${at}`;
  }
  if (routine.kind === 'schedule' && routine.active && routine.trigger !== 'once') {
    const next = `Next ${new Date(routine.nextRunAt).toLocaleString()}`;
    return last ? `${last} · ${next}` : next;
  }
  if (routine.kind === 'schedule' && routine.active && routine.trigger === 'once' && !last) {
    return `Runs ${new Date(routine.nextRunAt).toLocaleString()}`;
  }
  return last || 'Not run yet';
}

function RoutineCard({ routine, onToggle, onEdit, onDelete, onView }) {
  const meta = triggerMeta(routine);
  const stepCount = routine.stepCount || 0;
  const who =
    ((routine.agentNames || []).join(', ') || 'Just messages you') +
    (stepCount > 1 ? ` · ${stepCount} steps` : '');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        opacity: routine.active ? 1 : 0.62,
      }}
    >
      <div
        title={meta.label}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 'none',
          width: 92,
          color: routine.active ? 'var(--accent-strong)' : 'var(--text-3)',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <window.Icon name={meta.icon} size={15} />
        {meta.label}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>{who}</span>
          {!routine.active && <window.Badge tone="neutral">Paused</window.Badge>}
          {routine.notify && (
            <span title="Messages you on Telegram" style={{ color: 'var(--text-3)' }}>
              <window.Icon name="bell" size={13} />
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 2,
          }}
        >
          {routine.prompt}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}>
          {whenLine(routine)} · {trustLine(routine)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
        {routine.lastResult && (
          <window.Button
            size="sm"
            variant="subtle"
            icon="eye"
            title="View last result"
            onClick={() => onView(routine)}
          />
        )}
        <window.Button
          size="sm"
          variant="subtle"
          icon={routine.active ? 'pause' : 'play'}
          title={routine.active ? 'Pause' : 'Resume'}
          onClick={() => onToggle(routine)}
        />
        <window.Button size="sm" variant="subtle" icon="edit" title="Edit" onClick={() => onEdit(routine)} />
        <window.Button
          size="sm"
          variant="subtle"
          icon="trash"
          title="Delete"
          onClick={() => onDelete(routine)}
        />
      </div>
    </div>
  );
}

function RoutineModal({ agents, telegram, initial, onClose, onSave }) {
  const editing = !!(initial && initial.id);
  const [trigger, setTrigger] = useState(initial?.kind === 'watch' ? 'watch' : initial?.trigger || 'recurring');
  // Steps drive both kinds: a schedule runs the whole list in order; a watch
  // uses just the first step. agentId is a string for the <select> ('' = a
  // "just message me" step).
  const [steps, setSteps] = useState(() => {
    const init =
      initial?.steps && initial.steps.length
        ? initial.steps
        : [
            {
              // Default a brand-new routine's first step to a real agent — not
              // "Just message me" — so it actually does something. Leaving it
              // unset silently made the routine a notify-only prompt echo.
              agentId: initial?.agentIds?.[0] ?? (agents[0] ? agents[0].id : null),
              instruction: initial?.prompt || '',
            },
          ];
    return init.map((s) => ({
      agentId: s.agentId != null ? String(s.agentId) : '',
      instruction: s.instruction || '',
      condition: s.condition || '',
    }));
  });
  const [notify, setNotify] = useState(!!initial?.notify);
  const [when, setWhen] = useState(() =>
    localDateTimeValue(initial?.nextRunAt || Date.now() + 60 * 60_000),
  );
  // Repeating / watch share the plain-English → cron path.
  const [nlText, setNlText] = useState('');
  const [nlCron, setNlCron] = useState(initial?.cron || null);
  const [nlTimeZone, setNlTimeZone] = useState(initial?.timeZone || null);
  const [nlHuman, setNlHuman] = useState(initial?.cron ? initial.when : '');
  const [nlError, setNlError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');

  const isWatch = trigger === 'watch';
  const setStep = (i, patch) =>
    setSteps((cur) => cur.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStep = () =>
    setSteps((cur) => [
      ...cur,
      { agentId: agents[0] ? String(agents[0].id) : '', instruction: '', condition: '' },
    ]);
  const removeStep = (i) => setSteps((cur) => (cur.length > 1 ? cur.filter((_, idx) => idx !== i) : cur));
  const moveStep = (i, dir) =>
    setSteps((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const copy = [...cur];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const parseNl = async () => {
    const text = nlText.trim();
    if (!text) return;
    setParsing(true);
    setNlError('');
    const r = await window.api.post('/api/routines/parse', { text });
    setParsing(false);
    const d = (r && r.data) || {};
    if (!r.ok || d.error) {
      setNlCron(null);
      setNlHuman('');
      setNlError(d.error || (r && r.error) || "Couldn't read a time from that.");
      return;
    }
    if (d.cron) {
      setNlCron(d.cron);
      setNlTimeZone(d.timeZone || null);
      setNlHuman(d.human || `repeats (${d.cron})`);
    } else if (d.nextRunAt) {
      // A one-time phrase under "Repeating": fold it back to the time picker.
      setNlCron(null);
      setWhen(localDateTimeValue(d.nextRunAt));
      setTrigger('once');
      setNlHuman(d.human || '');
    }
  };

  const nextRunAt = parseLocalDateTime(when);
  const timeInvalid = nextRunAt === null || nextRunAt <= Date.now();
  const needsCron = trigger === 'recurring';
  const cleanSteps = steps
    .map((s) => ({
      agentId: s.agentId ? Number(s.agentId) : null,
      instruction: s.instruction.trim(),
      condition: s.condition.trim(),
    }))
    .filter((s) => s.instruction);
  const hasAgentStep = cleanSteps.some((s) => s.agentId != null);
  // Notify can only do anything when Telegram is connected (Telegram-only by
  // design). A message-only routine therefore needs Telegram to be useful.
  const effectiveNotify = notify && telegram;
  const blockSubmit =
    cleanSteps.length === 0 ||
    (isWatch && cleanSteps[0]?.agentId == null) ||
    (!isWatch && !hasAgentStep && !effectiveNotify) ||
    (trigger === 'once' && timeInvalid) ||
    (needsCron && !nlCron);

  const submit = async () => {
    setError('');
    const timing =
      trigger === 'watch'
        ? { cron: nlCron || null, ...(nlTimeZone ? { timeZone: nlTimeZone } : {}) }
        : trigger === 'recurring'
          ? { cron: nlCron, timeZone: nlTimeZone }
          : { nextRunAt, recurrence: 'once' };
    let body;
    if (isWatch) {
      const first = cleanSteps[0];
      body = {
        kind: 'watch',
        agentId: first.agentId,
        prompt: first.instruction,
        notify: effectiveNotify,
        ...timing,
      };
    } else {
      body = {
        kind: 'schedule',
        steps: cleanSteps.map((s) =>
          s.condition ? s : { agentId: s.agentId, instruction: s.instruction },
        ),
        notify: effectiveNotify,
        ...timing,
      };
    }
    // The kind is fixed by which store owns the row, so switching a routine
    // to/from "watch" can't be a PUT — it lives in the other store. Recreate it
    // (create the new one first, then drop the old) so a failed create never
    // loses the original.
    const newKind = isWatch ? 'watch' : 'schedule';
    const kindChanged = editing && newKind !== initial.kind;
    const r =
      editing && !kindChanged
        ? await window.api.put(`/api/routines/${initial.kind}/${initial.id}`, body)
        : await window.api.post('/api/routines', body);
    if (!r.ok) {
      setError((r.data && r.data.error) || r.error || 'Could not save the routine.');
      return;
    }
    if (kindChanged) await window.api.del(`/api/routines/${initial.kind}/${initial.id}`);
    onSave();
  };

  return (
    <window.Modal
      open
      onClose={onClose}
      width={580}
      title={editing ? 'Edit routine' : 'New routine'}
      footer={
        <>
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button variant="primary" icon="send" disabled={blockSubmit} onClick={submit}>
            {editing ? 'Save' : 'Create routine'}
          </window.Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* What — a single instruction for a watch, an ordered step list otherwise */}
        {isWatch ? (
          <>
            <Field label="What should happen?">
              <textarea
                autoFocus
                value={steps[0]?.instruction || ''}
                onChange={(e) => setStep(0, { instruction: e.target.value })}
                rows={3}
                placeholder="e.g. Check my calendar for tomorrow and flag anything outdoors"
                style={textareaStyle}
              />
            </Field>
            <Field label="Which agent does the checking?">
              <window.Select
                value={steps[0]?.agentId || ''}
                onChange={(e) => setStep(0, { agentId: e.target.value })}
              >
                <option value="">Choose an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </window.Select>
            </Field>
          </>
        ) : (
          <Field label="What should happen?">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {steps.map((s, i) => (
                <StepEditor
                  key={i}
                  index={i}
                  step={s}
                  agents={agents}
                  canRemove={steps.length > 1}
                  canMoveUp={i > 0}
                  canMoveDown={i < steps.length - 1}
                  onChange={(patch) => setStep(i, patch)}
                  onRemove={() => removeStep(i)}
                  onMove={(dir) => moveStep(i, dir)}
                />
              ))}
              <div>
                <window.Button variant="subtle" icon="plus" onClick={addStep}>
                  Add step
                </window.Button>
              </div>
              {steps.length > 1 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  Steps run top to bottom; each step’s output is handed to the next.
                </div>
              )}
            </div>
          </Field>
        )}

        {/* When */}
        <Field label="When?">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {TRIGGERS.map((t) => {
              const on = trigger === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTrigger(t.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 11px',
                    borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                    color: on ? 'var(--accent-strong)' : 'var(--text-2)',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 13,
                    fontWeight: on ? 600 : 500,
                  }}
                >
                  <window.Icon name={t.icon} size={14} />
                  {t.label}
                </button>
              );
            })}
          </div>

          {trigger === 'once' && (
            <window.Input
              type="datetime-local"
              value={when}
              min={localDateTimeValue(Date.now() + 60_000)}
              onChange={(e) => setWhen(e.target.value)}
            />
          )}

          {(trigger === 'recurring' || trigger === 'watch') && (
            <div>
              <div style={{ display: 'flex', gap: 8 }}>
                <window.Input
                  value={nlText}
                  placeholder={
                    trigger === 'watch'
                      ? 'How often to check — e.g. "every hour" (blank = continuously)'
                      : 'e.g. "every weekday at 8am" or "every 2 hours"'
                  }
                  onChange={(e) => {
                    setNlText(e.target.value);
                    setNlError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      parseNl();
                    }
                  }}
                  style={{ flex: 1 }}
                />
                <window.Button variant="subtle" onClick={parseNl} disabled={parsing || !nlText.trim()}>
                  {parsing ? 'Reading…' : 'Read time'}
                </window.Button>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {REPEAT_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setNlText(p);
                      setNlError('');
                    }}
                    style={{
                      padding: '4px 9px',
                      borderRadius: 99,
                      border: '1px solid var(--border)',
                      background: 'var(--surface-2)',
                      color: 'var(--text-3)',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 12,
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              {nlError && (
                <div style={{ color: 'var(--err)', fontSize: 12.5, marginTop: 6 }}>{nlError}</div>
              )}
              {nlHuman && !nlError && (
                <div style={{ color: 'var(--ok)', fontSize: 12.5, marginTop: 6 }}>
                  {trigger === 'watch' ? 'Checks: ' : 'Repeats: '}
                  {nlHuman}
                </div>
              )}
              {trigger === 'watch' && (
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
                  Modulus re-runs this on its own and reports back. Leave the schedule blank to check
                  continuously.
                </div>
              )}
            </div>
          )}
        </Field>

        {/* Tell me */}
        <Field label="Tell me how?">
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              fontSize: 13.5,
              color: telegram ? 'var(--text)' : 'var(--text-3)',
              cursor: telegram ? 'pointer' : 'not-allowed',
            }}
          >
            <input
              type="checkbox"
              checked={notify && telegram}
              disabled={!telegram}
              onChange={(e) => setNotify(e.target.checked)}
            />
            Message me on Telegram when it runs
          </label>
          {!telegram && (
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 5 }}>
              Connect Telegram in Settings to get messages. Results always show here under Agents ›
              Activity.
            </div>
          )}
        </Field>

        {error && <div style={{ color: 'var(--err)', fontSize: 13 }}>{error}</div>}
      </div>
    </window.Modal>
  );
}

// Starter-routine gallery. Module-aware: a template that needs a module the user
// hasn't enabled is shown but disabled, with a hint. Picking one opens the
// New-routine modal pre-filled.
function RoutineGallery({ enabledModules, onPick, onClose }) {
  const enabled = new Set(enabledModules || []);
  return (
    <window.Modal
      open
      onClose={onClose}
      width={760}
      title="Start from a template"
      footer={
        <window.Button variant="subtle" onClick={onClose}>
          Done
        </window.Button>
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 14,
        }}
      >
        {TEMPLATES.map((t) => {
          const missing = t.requiresModule && !enabled.has(t.requiresModule);
          return (
            <div key={t.id} className="dash-card" style={{ opacity: missing ? 0.6 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 22 }}>{t.emoji}</div>
                <div style={{ fontWeight: 'bold', fontSize: 15 }}>{t.title}</div>
              </div>
              <div style={{ color: 'var(--text-2)', fontSize: 13, minHeight: 38, marginBottom: 10 }}>
                {t.blurb}
              </div>
              {missing ? (
                <window.Badge tone="neutral">Needs {prettyModule(t.requiresModule)}</window.Badge>
              ) : (
                <window.Button variant="primary" icon="plus" onClick={() => onPick(t)}>
                  Use template
                </window.Button>
              )}
            </div>
          );
        })}
      </div>
    </window.Modal>
  );
}

// Read-only viewer for a routine's most recent output.
function ResultModal({ routine, onClose }) {
  return (
    <window.Modal
      open
      onClose={onClose}
      width={620}
      title={`Last run · ${(routine.agentNames || []).join(', ') || 'Routine'}`}
      footer={
        <window.Button variant="primary" onClick={onClose}>
          Close
        </window.Button>
      }
    >
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
        {routine.lastStatus === 'error' ? '⚠ Failed' : '✓ Ran'}
        {routine.lastRunAt ? ` · ${new Date(routine.lastRunAt).toLocaleString()}` : ''}
      </div>
      <div
        style={{
          maxHeight: '60vh',
          overflowY: 'auto',
          padding: 12,
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      >
        {routine.lastResult || 'No output recorded.'}
      </div>
    </window.Modal>
  );
}

function RoutinesTab({ onNavigate, enabledModules }) {
  const [routines, setRoutines] = useState([]);
  const [agents, setAgents] = useState([]);
  const [telegram, setTelegram] = useState(false);
  const [editing, setEditing] = useState(null); // routine | {} (new) | null
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [viewing, setViewing] = useState(null); // routine whose last result is open
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [r, a] = await Promise.all([
      window.api.get('/api/routines'),
      window.api.get('/api/agents'),
    ]);
    if (r.ok) {
      setRoutines(r.data.routines || []);
      setTelegram(!!(r.data.telegram && r.data.telegram.available));
    }
    if (a.ok) setAgents(a.data.agents || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const toggle = async (routine) => {
    await window.api.post(`/api/routines/${routine.kind}/${routine.id}/active`, {
      active: !routine.active,
    });
    load();
  };
  const remove = async (routine) => {
    if (!window.confirm('Delete this routine?')) return;
    await window.api.del(`/api/routines/${routine.kind}/${routine.id}`);
    load();
  };

  return (
    <div style={{ padding: '22px 26px', maxWidth: 900, margin: '0 auto' }}>
      <window.SectionTitle
        sub="Schedule agents, repeat tasks, and let Modulus watch things for you."
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <window.Button
              variant="subtle"
              icon="spark"
              disabled={agents.length === 0}
              onClick={() => setGalleryOpen(true)}
            >
              Templates
            </window.Button>
            <window.Button
              variant="primary"
              icon="plus"
              disabled={agents.length === 0}
              onClick={() => setEditing({})}
            >
              New routine
            </window.Button>
          </div>
        }
      >
        Routines
      </window.SectionTitle>

      {loading ? (
        <window.Card>
          <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading…</div>
        </window.Card>
      ) : agents.length === 0 ? (
        <window.Card>
          <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.5 }}>
            Routines run your agents on a schedule. Create an agent first, then come back to automate
            it.
          </div>
          <div style={{ marginTop: 12 }}>
            <window.Button variant="primary" icon="user" onClick={() => onNavigate && onNavigate('fleet')}>
              Go to Agents
            </window.Button>
          </div>
        </window.Card>
      ) : routines.length === 0 ? (
        <window.Card>
          <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.5 }}>
            No routines yet. Start from a template, or create one to run an agent every morning, on a
            repeating schedule, or whenever something changes.
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <window.Button variant="primary" icon="spark" onClick={() => setGalleryOpen(true)}>
              Browse templates
            </window.Button>
            <window.Button variant="subtle" icon="plus" onClick={() => setEditing({})}>
              New routine
            </window.Button>
          </div>
        </window.Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {routines.map((routine) => (
            <RoutineCard
              key={`${routine.kind}-${routine.id}`}
              routine={routine}
              onToggle={toggle}
              onEdit={(r) => setEditing(r)}
              onDelete={remove}
              onView={(r) => setViewing(r)}
            />
          ))}
        </div>
      )}

      {galleryOpen && (
        <RoutineGallery
          enabledModules={enabledModules}
          onClose={() => setGalleryOpen(false)}
          onPick={(t) => {
            setGalleryOpen(false);
            setEditing(templateToInitial(t, agents));
          }}
        />
      )}

      {editing && (
        <RoutineModal
          agents={agents}
          telegram={telegram}
          initial={editing && (editing.id || editing.steps) ? editing : null}
          onClose={() => setEditing(null)}
          onSave={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {viewing && <ResultModal routine={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

Object.assign(window, { RoutinesTab });
