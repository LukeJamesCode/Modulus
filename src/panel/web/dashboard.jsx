/* global React, window */
// Dashboard — Modulus's home surface. A general control center: a system-health
// strip (CPU / RAM / queue / errors, from the `system` block on /api/state) plus
// the two ways to talk to the agent — Chat Hub and Voice Hub — folded into one
// place behind a segmented toggle. Everything agent-*fleet* related (personas,
// tasks, schedules, workflows) lives on the Agents tab instead; this tab is for
// driving the live agent and watching the machine.
const { useState, useEffect } = React;

const SURFACE_KEY = 'modulus_dashboard_surface';

function useSurface(voiceEnabled) {
  const [surface, setSurface] = useState(() => {
    try {
      return localStorage.getItem(SURFACE_KEY) || 'chat';
    } catch (e) {
      return 'chat';
    }
  });
  // Voice can be disabled out from under us (module turned off) — fall back.
  const effective = surface === 'voice' && !voiceEnabled ? 'chat' : surface;
  useEffect(() => {
    try {
      localStorage.setItem(SURFACE_KEY, effective);
    } catch (e) {
      /* ignore */
    }
  }, [effective]);
  return [effective, setSurface];
}

// One health pill. `pct` (0-100) draws a mini bar; omit it for plain-value
// stats like queue depth and error count.
function HealthPill({ icon, label, value, pct, danger }) {
  return (
    <div className="health-pill">
      <span className="hp-ic">
        <window.Icon name={icon} size={15} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span className="hp-label">{label}</span>
        <span className={`hp-val${danger ? ' red-text' : ''}`}>{value}</span>
      </div>
      {typeof pct === 'number' && (
        <div className="mini-bar" style={{ width: 46 }}>
          <div
            className="fill green"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          ></div>
        </div>
      )}
    </div>
  );
}

function SystemHealthBar({ state }) {
  const sys = state && state.system ? state.system : null;
  const cpu = sys && typeof sys.cpuPercent === 'number' ? sys.cpuPercent : null;
  const ram =
    sys && typeof sys.ramPercent === 'number'
      ? sys.ramPercent
      : state && state.ramGb
        ? Math.round((1 - state.freeRamGb / state.ramGb) * 100)
        : null;
  const queue = sys ? sys.queueDepth : 0;
  const errors = sys ? sys.errors24h : 0;
  return (
    <div className="health-bar">
      <HealthPill icon="cpu" label="CPU" value={cpu == null ? '—' : `${cpu}%`} pct={cpu ?? 0} />
      <HealthPill
        icon="database"
        label="RAM"
        value={ram == null ? '—' : `${ram}%`}
        pct={ram ?? 0}
      />
      <HealthPill icon="layers" label="Queue" value={String(queue)} />
      <HealthPill
        icon="alert-triangle"
        label="Errors (24h)"
        value={String(errors)}
        danger={errors > 0}
      />
    </div>
  );
}

function DashboardTab({
  state,
  agent,
  busy,
  onStart,
  onStop,
  onRestart,
  proactive,
  onProactive,
  health,
  models,
  lastError,
  scheduler,
  activity,
  modules,
  tier,
  allowlistCount,
  voiceEnabled,
}) {
  const [surface, setSurface] = useSurface(voiceEnabled);

  // ChatHub/VoiceHub want a single "model · tools · reason" label.
  const m = models || {};
  const activeModel =
    [m.chat, m.tools ? `tools ${m.tools}` : null, m.reason ? `reason ${m.reason}` : null]
      .filter(Boolean)
      .join(' · ') || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="dash-top-bar">
        <div className="seg" role="tablist" aria-label="Conversation surface">
          <button
            role="tab"
            aria-selected={surface === 'chat'}
            className={`seg-btn${surface === 'chat' ? ' active' : ''}`}
            onClick={() => setSurface('chat')}
          >
            <window.Icon name="chat" size={15} /> Chat
          </button>
          {voiceEnabled && (
            <button
              role="tab"
              aria-selected={surface === 'voice'}
              className={`seg-btn${surface === 'voice' ? ' active' : ''}`}
              onClick={() => setSurface('voice')}
            >
              <window.Icon name="mic" size={15} /> Voice
            </button>
          )}
        </div>
        <SystemHealthBar state={state} />
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {surface === 'voice' && voiceEnabled ? (
          <window.VoiceHub
            agent={agent}
            onStart={onStart}
            onStop={onStop}
            health={health}
            activeModel={activeModel}
            onLeave={() => setSurface('chat')}
          />
        ) : (
          <window.ChatHub
            agent={agent}
            busy={busy}
            onStart={onStart}
            onStop={onStop}
            onRestart={onRestart}
            proactive={proactive}
            onProactive={onProactive}
            health={health}
            activeModel={activeModel}
            lastError={lastError}
            scheduler={scheduler}
            activity={activity}
            modules={modules}
            tier={tier}
            allowlistCount={allowlistCount}
          />
        )}
      </div>
    </div>
  );
}

Object.assign(window, { DashboardTab });
