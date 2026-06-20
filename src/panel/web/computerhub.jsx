// Computer Use tab: a live monitor for the modulus-computer-use desktop
// operator. Read-only by design — sessions are started from chat (ask
// "use my computer to …") or Telegram (/computer). This tab streams the
// running session's screenshots and action log from /api/computer/* and offers
// a Stop. Polls /api/computer/state so a session started elsewhere shows up,
// and re-subscribes the SSE when the active session changes.
const { useState, useEffect, useRef } = React;

const OUTCOME_TONE = {
  ok: 'var(--ok, #46d39a)',
  blocked: 'var(--warn)',
  error: 'var(--err)',
  skipped: 'var(--text-3)',
};

function ComputerTab() {
  const [available, setAvailable] = useState(null); // null=loading, false=module off
  const [session, setSession] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null);
  const [steps, setSteps] = useState([]);
  const [stopping, setStopping] = useState(false);
  const esRef = useRef(null);
  const logRef = useRef(null);

  // Poll the snapshot so a session started from chat/Telegram appears here.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await window.api.get('/api/computer/state');
      if (!alive) return;
      if (!r.ok) return;
      setAvailable(r.data.available);
      const active = r.data.active || (r.data.recent && r.data.recent[0]) || null;
      setSession((prev) => (prev && active && prev.id === active.id ? prev : active));
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // (Re)subscribe to the live step stream whenever the watched session changes.
  const sessionId = session ? session.id : null;
  useEffect(() => {
    if (!sessionId) return;
    setSteps([]);
    setLiveStatus(null);
    const es = window.api.streamSSE(`/api/computer/stream?sessionId=${sessionId}`, {
      onMessage: (_name, raw) => {
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          return;
        }
        if (ev.kind === 'step') {
          setSteps((prev) => [...prev, ev.step]);
        } else if (ev.kind === 'status') {
          setLiveStatus(ev.status);
        }
      },
    });
    esRef.current = es;
    return () => {
      try {
        es.close();
      } catch {
        /* ignore */
      }
    };
  }, [sessionId]);

  // Keep the newest step in view.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [steps.length]);

  const stop = async () => {
    setStopping(true);
    await window.api.post('/api/computer/stop');
    setTimeout(() => setStopping(false), 1500);
  };

  if (available === false) {
    return (
      <Empty
        title="Computer Use isn’t enabled"
        body="Enable the modulus-computer-use module, set an app allowlist in its settings, then ask in chat: “use my computer to …”."
      />
    );
  }
  if (available === null && !session) {
    return <Empty title="Loading…" body="" />;
  }
  if (!session) {
    return (
      <Empty
        title="No sessions yet"
        body="Start one from chat (“open Notepad and type my address”) or Telegram (/computer …). It’ll appear here live."
      />
    );
  }

  const status = liveStatus || session.status;
  const running = status === 'running';
  const lastShot = [...steps].reverse().find((s) => s.shotUrl);

  return (
    <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <window.Icon name="monitor" size={20} style={{ color: 'var(--accent-strong)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
            Session #{session.id}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.goal}
          </div>
        </div>
        <StatusPill status={status} />
        <button
          onClick={stop}
          disabled={!running || stopping}
          style={{
            background: running ? 'var(--err)' : 'var(--surface-2)',
            color: running ? '#fff' : 'var(--text-3)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            cursor: running && !stopping ? 'pointer' : 'default',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <window.Icon name="square" size={14} /> {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: '1 1 62%',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 0,
          }}
        >
          {lastShot ? (
            <img
              src={window.api.url(lastShot.shotUrl)}
              alt={`step ${lastShot.stepNo}`}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          ) : (
            <span style={{ color: 'var(--text-3)', fontSize: 13 }}>Waiting for the first screenshot…</span>
          )}
        </div>

        <div
          ref={logRef}
          style={{
            flex: '1 1 38%',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflowY: 'auto',
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            minHeight: 0,
          }}
        >
          {steps.length === 0 && (
            <span style={{ color: 'var(--text-3)', fontSize: 13 }}>No steps yet.</span>
          )}
          {steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
          {(status === 'done' || status === 'stopped' || status === 'paused' || status === 'error') && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-2)' }}>
              {session.summary || `Session ${status}.`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepRow({ step }) {
  const tone = OUTCOME_TONE[step.outcome] || 'var(--text-2)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '6px 8px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-2)',
        fontSize: 12.5,
      }}
    >
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)', flex: 'none' }}>
        #{step.stepNo}
      </span>
      <span style={{ fontWeight: 600, color: 'var(--text)', flex: 'none' }}>{step.action}</span>
      <span style={{ flex: 1, color: 'var(--text-2)', minWidth: 0 }}>
        {step.rationale || step.detail || ''}
      </span>
      <span style={{ color: tone, flex: 'none', fontWeight: 600 }}>{step.outcome}</span>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    running: ['var(--accent-strong)', 'Running'],
    done: ['var(--ok, #46d39a)', 'Done'],
    stopped: ['var(--text-3)', 'Stopped'],
    paused: ['var(--warn)', 'Paused'],
    error: ['var(--err)', 'Error'],
  };
  const [color, label] = map[status] || ['var(--text-3)', status];
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 700,
        color,
        padding: '4px 10px',
        borderRadius: 99,
        border: `1px solid ${color}`,
        background: 'transparent',
      }}
    >
      {label}
    </span>
  );
}

function Empty({ title, body }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        textAlign: 'center',
        padding: 40,
      }}
    >
      <window.Icon name="monitor" size={28} style={{ color: 'var(--text-3)' }} />
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>{title}</div>
      {body && <div style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 420 }}>{body}</div>}
    </div>
  );
}

Object.assign(window, { ComputerTab });
