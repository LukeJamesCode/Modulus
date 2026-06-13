// Root app. Holds the shared agent/health state (polled from /api/state),
// decides between the first-run wizard and the main hub, and owns the agent
// start/stop/restart actions (which POST to /api/agent/* — the server shells
// out to `modulus start --detach` / `modulus stop`). The panel is dark-only
// ("Helix" theme): no theme or density toggles.
const { useState, useEffect, useCallback, useRef } = React;

// Agents is the landing tab; its pinned "Modulus Agent" chat is the one
// conversational home (chat + voice + fleet control). Daemon health/controls
// live under System › Status.
const NAV = [
  { id: 'agents', label: 'Agents', icon: 'spark' },
  { id: 'modules', label: 'Modules', icon: 'plug' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
  { id: 'system', label: 'System', icon: 'pulse' },
];

function App() {
  const [state, setState] = useState(null);
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState(null); // reachable but rejected (e.g. 401)
  const [route, setRoute] = useState('agents');
  const [busy, setBusy] = useState(null); // agent action in flight: start|stop|restart|null
  const [forcedView, setForcedView] = useState(null); // override configured-based view
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    const r = await window.api.get('/api/state');
    if (r.ok) {
      setState(r.data);
      setOffline(false);
      setLoadError(null);
    } else if (r.offline) {
      setOffline(true);
      setLoadError(null);
    } else {
      // Reachable, but the server refused the request (401 bad/missing token,
      // 500, etc). Without this branch the app would spin on the boot screen
      // forever, since neither `state` nor `offline` ever gets set.
      setOffline(false);
      setLoadError({ status: r.status || 0, error: r.error || 'request failed' });
    }
    return r.ok ? r.data : null;
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 4000);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const agentAction = useCallback(
    async (action) => {
      setBusy(action);
      await window.api.post(`/api/agent/${action}`);
      await refresh();
      // Poll a couple more times — the daemon takes a beat to come up/down.
      setTimeout(refresh, 1200);
      setTimeout(() => {
        refresh();
        setBusy(null);
      }, 2600);
    },
    [refresh],
  );

  const setProactive = useCallback(
    async (on) => {
      setState((s) => ({ ...s, proactive: on }));
      await window.api.post('/api/agent/proactive', { on });
      refresh();
    },
    [refresh],
  );

  // ---- access denied / server error ----
  if (!state && loadError) {
    const is401 = loadError.status === 401;
    const forgetToken = () => {
      try {
        localStorage.removeItem('modulus_token');
      } catch {
        /* ignore */
      }
      location.reload();
    };
    return (
      <div className="boot">
        <span className="boot-mark" style={{ background: 'var(--err)' }}>
          !
        </span>
        <span className="boot-text">
          {is401
            ? 'Access token missing or incorrect.'
            : `Couldn’t load the panel (HTTP ${loadError.status || '?'}).`}
        </span>
        {is401 && (
          <span
            style={{ fontSize: 13, color: 'var(--text-3)', maxWidth: 360, textAlign: 'center' }}
          >
            Open the link printed by <code>modulus start</code> on startup — it includes the
            required <code>?token=…</code>.
          </span>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {is401 && (
            <window.Button variant="subtle" onClick={forgetToken}>
              Forget saved token
            </window.Button>
          )}
          <window.Button variant="subtle" icon="refresh" onClick={refresh}>
            Retry
          </window.Button>
        </div>
      </div>
    );
  }

  // ---- loading / boot ----
  if (!state && !offline) {
    return (
      <div className="boot">
        <span className="boot-mark">m</span>
        <span className="boot-text">Loading Modulus…</span>
      </div>
    );
  }

  if (!state && offline) {
    return (
      <div className="boot">
        <span className="boot-mark" style={{ background: 'var(--err)' }}>
          !
        </span>
        <span className="boot-text">Can’t reach the Modulus panel server.</span>
        <window.Button variant="subtle" icon="refresh" onClick={refresh}>
          Retry
        </window.Button>
      </div>
    );
  }

  const configured = !!state.configured;
  // Setup mode pins the wizard regardless of forcedView/configured — the daemon
  // is stubbed and there's no hub to exit to until promotion completes.
  const setupMode = !!state.setupMode;
  const view = setupMode ? 'wizard' : forcedView || (configured ? 'hub' : 'wizard');
  const agentStatus =
    busy === 'stop'
      ? 'stopping'
      : busy
        ? 'starting'
        : state.agent && state.agent.running
          ? 'running'
          : 'stopped';

  if (view === 'wizard') {
    return (
      <window.Wizard
        suggestedTier={state.suggestedTier}
        ramGb={state.ramGb}
        setupMode={setupMode}
        setupError={state.setupError || null}
        modelRecommendations={state.modelRecommendations || {}}
        // In setup mode there's no hub to skip to; hide the exit.
        onExit={setupMode ? null : () => setForcedView('hub')}
        onFinish={async () => {
          setForcedView('hub');
          setRoute('agents');
          await refresh();
          agentAction('start');
        }}
      />
    );
  }

  const health = state.health || {};
  const models = state.models || {};
  const enabledModules = (state.modules && state.modules.enabledNames) || [];
  const needsSetup = (state.modules && state.modules.needsSetup) || [];
  const visibleModuleCount = (state.modules && state.modules.enabled) || 0;
  const voiceEnabled = enabledModules.indexOf('modulus-voice') !== -1;
  // One "model · tools · reason" label for the chat/voice surfaces.
  const activeModel =
    [
      models.chat,
      models.tools ? `tools ${models.tools}` : null,
      models.reason ? `reason ${models.reason}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || null;
  const healthFlags = { telegram: !!health.telegram, ollama: !!health.ollama };

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        setRoute={setRoute}
        agentStatus={agentStatus}
        onStart={() => agentAction('start')}
        onStop={() => agentAction('stop')}
        busy={busy}
        moduleCount={visibleModuleCount}
        enabledModules={enabledModules}
        needsSetup={needsSetup}
        onOpenModules={() => setRoute('modules')}
      />

      <main className="main-panel">
        <Topbar state={state} setRoute={setRoute} offline={offline} agentStatus={agentStatus} />
        {offline && <OfflineBar onRetry={refresh} />}
        {state.cfgError && <ConfigErrorBar message={state.cfgError} />}
        <div className="content-shell">
          {route === 'agents' && (
            <window.AgentsTab
              state={state}
              agentStatus={agentStatus}
              onStart={() => agentAction('start')}
              onStop={() => agentAction('stop')}
              voiceEnabled={voiceEnabled}
              health={healthFlags}
              activeModel={activeModel}
            />
          )}
          {route === 'modules' && <window.ModulesTab />}
          {route === 'settings' && (
            <window.SettingsTab onReRunWizard={() => setForcedView('wizard')} onSaved={refresh} />
          )}
          {route === 'system' && (
            <window.SystemTab
              state={state}
              onReset={() => setForcedView('wizard')}
              agentStatus={agentStatus}
              busy={busy}
              onStart={() => agentAction('start')}
              onStop={() => agentAction('stop')}
              onRestart={() => agentAction('restart')}
              proactive={state.proactive}
              onProactive={setProactive}
            />
          )}
          {route === 'docs' && <window.DocsTab />}
        </div>
      </main>
    </div>
  );
}

function nowLabel() {
  try {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function Topbar({ state, setRoute, offline }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [clock, setClock] = useState(() => nowLabel());
  const dropdownRef = useRef(null);

  // Localized wall-clock in the top bar (Stitch). Tick once a minute.
  useEffect(() => {
    const id = setInterval(() => setClock(nowLabel()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // We only need to load them to check if there are notifications.
    const loadNotifs = async () => {
      try {
        const t = await window.api.get('/api/agents/tasks');
        if (t.ok && t.data && t.data.tasks) setTasks(t.data.tasks);
      } catch {
        // ignore
      }
    };
    loadNotifs();
    const interval = setInterval(loadNotifs, 5000);
    return () => clearInterval(interval);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    } else {
      document.removeEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  const needsSetup = (state && state.modules && state.modules.needsSetup) || [];
  const activeTasks = tasks
    .filter((t) => t.status === 'running' || t.status === 'error')
    .slice(0, 5);

  const notifications = [
    ...needsSetup.map((mod) => ({
      id: `setup-${mod.name}`,
      icon: 'plug',
      title: 'Module Needs Setup',
      desc: `${mod.name.replace(/^modulus-/, '')} requires configuration.`,
      action: () => setRoute('modules'),
    })),
    ...activeTasks.map((t) => ({
      id: `task-${t.id}`,
      icon: t.status === 'error' ? 'alert-triangle' : 'loader',
      tone: t.status === 'error' ? 'err' : 'accent',
      title: t.status === 'error' ? 'Task Error' : 'Active Run',
      desc: t.agentName || `Task #${t.id}`,
      action: () => setRoute('agents'),
    })),
  ];

  const toggleOpen = () => setOpen(!open);

  return (
    <div className="topbar">
      <div className="search-bar">
        <window.Icon name="search" size={16} />
        <span>Search or Cmd+K</span>
        <span className="search-kbd">⌘K</span>
      </div>
      <div className="topbar-actions">
        <span className="conn-clock" title="Local time">
          <window.Icon name="clock" size={14} /> {clock}
        </span>
        <span className={`conn-pill${offline ? ' off' : ''}`} title="Panel connection">
          <window.StatusDot state={offline ? 'error' : 'running'} size={7} pulse={!offline} />
          {offline ? 'Offline' : 'Connected'}
        </span>
        <button className="dash-btn green" onClick={() => setRoute('agents')}>
          <window.Icon name="play" size={14} /> New Run
        </button>
        <div className="icon-action" style={{ position: 'relative' }} ref={dropdownRef}>
          <div
            onClick={toggleOpen}
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <window.Icon name="bell" size={18} />
            {notifications.length > 0 && <div className="badge">{notifications.length}</div>}
          </div>
          {open && (
            <div
              style={{
                position: 'absolute',
                top: 36,
                right: -10,
                width: 320,
                background: 'var(--glass-bg-strong)',
                backdropFilter: 'blur(40px)',
                WebkitBackdropFilter: 'blur(40px)',
                border: '1px solid var(--glass-border)',
                borderTop: '1px solid var(--border-2)',
                borderRadius: 'var(--radius)',
                boxShadow: 'var(--shadow-pop)',
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  fontWeight: 600,
                  fontSize: 13,
                  color: 'var(--text)',
                }}
              >
                Notifications
              </div>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {notifications.length === 0 ? (
                  <div
                    style={{
                      padding: '20px',
                      textAlign: 'center',
                      color: 'var(--text-3)',
                      fontSize: 13,
                    }}
                  >
                    No new notifications.
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      onClick={() => {
                        setOpen(false);
                        n.action();
                      }}
                      style={{
                        padding: '12px 14px',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div
                        style={{
                          color: `var(--${n.tone || 'text-2'})`,
                          flex: 'none',
                          marginTop: 2,
                        }}
                      >
                        <window.Icon name={n.icon} size={16} />
                      </div>
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: 'var(--text)',
                            marginBottom: 2,
                          }}
                        >
                          {n.title}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{n.desc}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <div className="icon-action" onClick={() => setRoute('docs')} style={{ cursor: 'pointer' }}>
          <window.Icon name="help-circle" size={18} />
        </div>
        <div
          className="icon-action"
          onClick={() => setRoute('settings')}
          style={{ cursor: 'pointer' }}
        >
          <window.Icon name="settings" size={18} />
        </div>
      </div>
    </div>
  );
}

function OfflineBar({ onRetry }) {
  return (
    <div
      style={{
        background: 'color-mix(in oklab, var(--err) 12%, var(--surface))',
        borderBottom: '1px solid color-mix(in oklab, var(--err) 30%, transparent)',
        padding: '10px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13.5,
      }}
    >
      <window.Icon name="alert" size={16} style={{ color: 'var(--err)' }} />
      <span style={{ flex: 1, color: 'var(--text-2)' }}>
        Lost connection to the panel server — showing the last known state.
      </span>
      <window.Button size="sm" variant="subtle" icon="refresh" onClick={onRetry}>
        Retry
      </window.Button>
    </div>
  );
}

function ConfigErrorBar({ message }) {
  return (
    <div
      style={{
        background: 'color-mix(in oklab, var(--warn) 14%, var(--surface))',
        borderBottom: '1px solid color-mix(in oklab, var(--warn) 34%, transparent)',
        padding: '10px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13.5,
      }}
    >
      <window.Icon name="alert" size={16} style={{ color: 'var(--warn)' }} />
      <span style={{ flex: 1, color: 'var(--text-2)' }}>Config problem: {message}</span>
    </div>
  );
}

// Brand mark: a DNA double helix, pink strand crossing a purple strand.
function HelixMark({ size = 34 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flex: 'none', filter: 'drop-shadow(0 0 10px rgba(233, 85, 159, 0.35))' }}
    >
      <defs>
        <linearGradient id="helix-a" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff7ab8" />
          <stop offset="1" stopColor="#e9559f" />
        </linearGradient>
        <linearGradient id="helix-b" x1="64" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#b78aff" />
          <stop offset="1" stopColor="#9d6bff" />
        </linearGradient>
      </defs>
      {/* base-pair rungs */}
      <g stroke="#c77be0" strokeWidth="2.6" strokeLinecap="round" opacity="0.55">
        <path d="M24.5 11 H39.5" />
        <path d="M21 18 H43" />
        <path d="M24.5 25 H39.5" />
        <path d="M24.5 39 H39.5" />
        <path d="M21 46 H43" />
        <path d="M24.5 53 H39.5" />
      </g>
      {/* the two strands */}
      <path
        d="M32 4 Q60 18 32 32 Q4 46 32 60"
        stroke="url(#helix-a)"
        strokeWidth="6.5"
        strokeLinecap="round"
      />
      <path
        d="M32 4 Q4 18 32 32 Q60 46 32 60"
        stroke="url(#helix-b)"
        strokeWidth="6.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <HelixMark />
      <div style={{ lineHeight: 1.05, marginTop: 2 }}>
        <div
          className="display"
          style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0, color: 'var(--text)' }}
        >
          MODULUS
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.5,
            background: 'var(--brand-gradient)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          CONTROL CENTER
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { HelixMark });

/* ---------------- sidebar ---------------- */
function Sidebar({ route, setRoute, moduleCount, enabledModules, needsSetup, onOpenModules }) {
  const items = NAV.filter(
    (n) => !n.requiresModule || (enabledModules || []).indexOf(n.requiresModule) !== -1,
  );
  const setupList = needsSetup || [];
  const setupCount = setupList.length;
  // Dismiss persists per setup fingerprint — re-shows if the unfinished list
  // changes, but stays quiet while the same modules are pending.
  const setupKey = setupList
    .map((s) => s.name)
    .sort()
    .join(',');
  const [dismissedKey, setDismissedKey] = useState(() => {
    try {
      return localStorage.getItem('modulus_ext_setup_dismissed') || '';
    } catch {
      return '';
    }
  });
  const showPopup = setupCount > 0 && route !== 'modules' && dismissedKey !== setupKey;
  const dismissPopup = () => {
    try {
      localStorage.setItem('modulus_ext_setup_dismissed', setupKey);
    } catch {
      /* ignore */
    }
    setDismissedKey(setupKey);
  };
  return (
    <aside
      style={{
        width: 236,
        flex: 'none',
        background: 'var(--glass-bg-strong)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        borderRight: '1px solid var(--glass-border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '14px 12px',
        zIndex: 40,
      }}
      className="sidebar"
    >
      <div style={{ padding: '2px 6px 14px', display: 'flex', alignItems: 'center' }}>
        <Wordmark />
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map((n) => {
          const on = route === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setRoute(n.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid',
                borderColor: on ? 'var(--accent-ring)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                background: on ? 'var(--accent-soft)' : 'transparent',
                color: on ? 'var(--accent-strong)' : 'var(--text-2)',
                boxShadow: on ? 'var(--bloom)' : 'none',
                fontWeight: on ? 600 : 500,
                fontSize: 14,
                transition: 'background .12s, color .12s, border-color .12s',
              }}
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.background = 'var(--surface-2)';
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.background = 'transparent';
              }}
            >
              <window.Icon
                name={n.icon}
                size={18}
                style={{ color: on ? 'var(--accent-strong)' : 'var(--text-3)' }}
              />
              <span style={{ flex: 1 }}>{n.label}</span>
              {n.id === 'modules' && setupCount > 0 && (
                <span
                  title={`${setupCount} module${setupCount === 1 ? '' : 's'} need setup: ${setupList
                    .map((s) => s.name.replace(/^modulus-/, ''))
                    .join(', ')}`}
                  style={{
                    minWidth: 18,
                    height: 18,
                    padding: '0 6px',
                    borderRadius: 99,
                    background: 'var(--warn)',
                    color: 'var(--on-accent, #fff)',
                    fontSize: 11,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                  }}
                >
                  {setupCount}
                </span>
              )}
              {n.id === 'modules' && setupCount === 0 && moduleCount > 0 && (
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: 'var(--text-3)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {moduleCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {showPopup && (
        <SetupPopup
          items={setupList}
          onOpen={() => {
            dismissPopup();
            onOpenModules && onOpenModules();
          }}
          onDismiss={dismissPopup}
        />
      )}
      <div style={{ flex: 1 }} />

      <div
        style={{
          padding: '0 12px 12px',
          fontSize: '10px',
          color: 'var(--text-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          margin: '0 10px',
        }}
      >
        <span>CONTROL CENTER v1.2.3</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span className="dot green" style={{ width: '6px', height: '6px' }}></span> All systems
          operational
        </span>
      </div>
    </aside>
  );
}

function SetupPopup({ items, onOpen, onDismiss }) {
  const pretty = (name) =>
    name
      .replace(/^modulus-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div
      role="status"
      style={{
        marginTop: 10,
        padding: 12,
        background: 'color-mix(in oklab, var(--warn) 12%, var(--surface))',
        border: '1px solid color-mix(in oklab, var(--warn) 40%, transparent)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <window.Icon name="alert" size={15} style={{ color: 'var(--warn)' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
          Finish module setup
        </span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: 'var(--text-3)',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
        {items.length === 1 ? (
          <>
            <strong>{pretty(items[0].name)}</strong> still needs{' '}
            {items[0].status === 'needs_auth' ? 'a connection' : 'required settings'}.
          </>
        ) : (
          <>
            {items.length} modules still need setup:{' '}
            <strong>{items.map((s) => pretty(s.name)).join(', ')}</strong>.
          </>
        )}
      </div>
      <button
        onClick={onOpen}
        style={{
          alignSelf: 'flex-start',
          background: 'var(--warn)',
          color: 'var(--on-accent, #fff)',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          padding: '6px 10px',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Open Modules →
      </button>
    </div>
  );
}

Object.assign(window, { App });

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
