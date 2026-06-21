// System & Diagnostics — the CLI power-features, integrated:
//   Status  → /api/state            (modulus status)
//   Doctor  → /api/doctor           (modulus doctor)
//   Logs    → /api/logs/stream SSE  (modulus logs -f)
//   Maint.  → /api/maintenance/update + Reset hand-off (modulus update / fresh)
//   Commands→ /api/commands         (the real core + module Telegram commands)
const { useState: useStateSys, useEffect: useEffectSys, useRef: useRefSys } = React;

const SYSTEM_COMMAND_LABELS = {
  status: 'modulus status',
  doctor: 'modulus doctor',
  logs: 'modulus logs',
  commands: 'modulus --help',
};

function SystemTab({
  state,
  onReset,
  // Daemon controls, threaded from App — the Status sub-view hosts them now
  // that the Dashboard tab is gone.
  agentStatus,
  busy,
  onStart,
  onStop,
  onRestart,
  proactive,
  onProactive,
}) {
  const [sub, setSub] = useStateSys('status');
  const [showAdvanced, setShowAdvanced] = useStateSys(false);
  const [cmd, setCmd] = useStateSys({
    running: true,
    result: { ok: true, command: SYSTEM_COMMAND_LABELS.status, output: '' },
  });
  const commandSeq = useRefSys(0);
  // Everyday-facing views up front; raw diagnostics (metrics, logs, the command
  // list) fold behind "Advanced" so the tab doesn't read as a developer console.
  const primarySubs = [
    { value: 'status', label: 'Status' },
    { value: 'doctor', label: 'Health check' },
    { value: 'schedule', label: 'Schedule' },
    { value: 'maintenance', label: 'Maintenance' },
  ];
  const advancedSubs = [
    { value: 'metrics', label: 'Metrics' },
    { value: 'logs', label: 'Logs' },
    { value: 'commands', label: 'Commands' },
  ];

  const runSystemTabCommand = async (name = sub) => {
    const command = SYSTEM_COMMAND_LABELS[name];
    if (!command) return;
    const seq = ++commandSeq.current;
    setCmd({ running: true, result: { ok: true, command, output: '' } });
    const result = await runPanelCommand(name);
    if (seq === commandSeq.current) setCmd({ running: false, result });
  };

  const showCommandOutput = (name, result = null) => {
    commandSeq.current += 1;
    setCmd({
      running: false,
      result: result || {
        ok: true,
        command: name === 'maintenance' ? 'modulus update' : SYSTEM_COMMAND_LABELS[name] || '',
        output: '',
      },
    });
  };

  const runMaintenanceUpdate = async () => {
    const seq = ++commandSeq.current;
    setCmd({ running: true, result: { ok: true, command: 'modulus update', output: '' } });
    const r = await window.api.post('/api/maintenance/update');
    const data = r.data || {};
    const result = {
      ok: r.ok && data.ok !== false,
      code: data.code,
      command: data.command || 'modulus update',
      output: data.output || r.error || '',
    };
    if (seq === commandSeq.current) setCmd({ running: false, result });
    return result;
  };

  const runMaintenanceFresh = async (confirmText) => {
    const seq = ++commandSeq.current;
    const command = 'modulus fresh';
    setCmd({ running: true, result: { ok: true, command, output: '' } });
    const r = await window.api.post('/api/maintenance/fresh', { confirm: confirmText });
    const data = r.data || {};
    const result = {
      ok: r.ok && data.ok !== false,
      code: data.code,
      command: data.command || command,
      output: data.output || r.error || '',
    };
    if (seq === commandSeq.current) setCmd({ running: false, result });
    if (result.ok) onReset();
    return result;
  };

  const changeSub = (next) => {
    setSub(next);
    if (SYSTEM_COMMAND_LABELS[next]) {
      void runSystemTabCommand(next);
    } else {
      showCommandOutput(next);
    }
  };

  useEffectSys(() => {
    void runSystemTabCommand('status');
  }, []);

  return (
    <div>
      <window.SectionTitle sub="Check that everything’s running, see what’s scheduled, and keep Modulus up to date.">
        System &amp; Diagnostics
      </window.SectionTitle>
      <div
        style={{
          marginBottom: 20,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <window.Segmented
          value={primarySubs.some((s) => s.value === sub) ? sub : ''}
          onChange={changeSub}
          options={primarySubs}
        />
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            color: 'var(--text-3)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <window.Icon
            name="fwd"
            size={13}
            style={{
              transform: showAdvanced ? 'rotate(90deg)' : 'none',
              transition: 'transform .2s',
            }}
          />
          {showAdvanced ? 'Hide advanced' : 'Advanced'}
        </button>
        {showAdvanced && (
          <window.Segmented
            value={advancedSubs.some((s) => s.value === sub) ? sub : ''}
            onChange={changeSub}
            options={advancedSubs}
          />
        )}
      </div>
      {state && state.connect && state.connect.lan && state.connect.url && (
        <ConnectCard url={state.connect.url} />
      )}
      {sub === 'status' && (
        <StatusDashboard
          state={state}
          agentStatus={agentStatus}
          busy={busy}
          onStart={onStart}
          onStop={onStop}
          onRestart={onRestart}
          proactive={proactive}
          onProactive={onProactive}
        />
      )}
      {sub === 'metrics' && <MetricsView />}
      {sub === 'schedule' && <ScheduleView />}
      {sub === 'doctor' && <Doctor onRunCommand={() => runSystemTabCommand('doctor')} />}
      {sub === 'logs' && <LogViewer />}
      {sub === 'maintenance' && (
        <Maintenance state={state} onUpdate={runMaintenanceUpdate} onFresh={runMaintenanceFresh} />
      )}
      {sub === 'commands' && <Commands />}
      {/* The Schedule and Metrics views have no terminal output, so they skip the footer. */}
      {sub !== 'schedule' && sub !== 'metrics' && (
        <div style={{ marginTop: 16 }}>
          <CommandOutput
            result={cmd.result}
            running={cmd.running}
            onRun={SYSTEM_COMMAND_LABELS[sub] ? () => runSystemTabCommand(sub) : undefined}
            empty={
              sub === 'maintenance' ? 'Run a maintenance action to see output here.' : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

async function runPanelCommand(name) {
  const fallback = SYSTEM_COMMAND_LABELS[name] || `modulus ${name}`;
  const r = await window.api.post(`/api/system/${name}`);
  const data = r.data || {};
  return {
    ok: r.ok && data.ok !== false,
    code: data.code,
    command: data.command || fallback,
    output: data.output || r.error || '',
  };
}

function CommandOutput({ result, running, onRun, empty = 'No output yet.' }) {
  const command = (result && result.command) || '';
  const output = result && result.output ? result.output : '';
  const ok = !result || result.ok;
  return (
    <div
      style={{
        borderRadius: 'var(--radius)',
        border: `1px solid ${
          result && !ok ? 'color-mix(in oklab, var(--err) 32%, var(--border))' : 'var(--border)'
        }`,
        background: 'var(--code-bg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'color-mix(in oklab, var(--surface) 70%, transparent)',
        }}
      >
        <window.Icon
          name={running ? 'refresh' : ok ? 'terminal' : 'alert'}
          size={15}
          className={running ? 'spin' : ''}
        />
        <span
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            color: ok ? 'var(--text-2)' : 'var(--err)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {command || (running ? 'running command' : 'command output')}
          {result && typeof result.code === 'number' ? ` (exit ${result.code})` : ''}
        </span>
        {onRun && (
          <window.Button
            size="sm"
            variant="subtle"
            icon="refresh"
            onClick={onRun}
            disabled={running}
          >
            {running ? 'Running' : 'Run'}
          </window.Button>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          minHeight: 86,
          maxHeight: 300,
          overflow: 'auto',
          padding: 14,
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          color: output ? 'var(--text)' : 'var(--text-3)',
        }}
      >
        {running && !output ? 'Running...' : output || empty}
      </pre>
    </div>
  );
}

// One health pill. `pct` (0-100) draws a mini bar; omit it for plain-value
// stats like queue depth and error count. (Moved here from the old Dashboard.)
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

// CPU / RAM / queue / errors strip from the `system` block on /api/state.
// Shown when the panel is bound to the LAN ("host for other devices"). The link
// carries the secret token, so it's the one thing to paste into the desktop
// app's "connect to a remote Modulus" box (or another browser).
function ConnectCard({ url }) {
  const [copied, setCopied] = useStateSys(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  };
  return (
    <div
      style={{
        marginBottom: 20,
        padding: 16,
        borderRadius: 'var(--radius)',
        background: 'var(--surface)',
        border: '1px solid color-mix(in oklab, var(--accent) 35%, var(--border))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <window.Icon name="plug" size={16} style={{ color: 'var(--accent-strong)' }} />
        <span style={{ fontWeight: 600, fontSize: 14.5 }}>Connect from another device</span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55, margin: '0 0 12px' }}>
        Paste this link into the desktop app’s “Connect to a Modulus running elsewhere” box, or open
        it in a browser on another device. It contains a secret token — keep it private.
      </p>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <window.Input mono readOnly value={url} onFocus={(e) => e.target.select()} />
        </div>
        <window.Button variant="primary" icon={copied ? 'check' : 'copy'} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </window.Button>
      </div>
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
    <div className="health-bar" style={{ marginBottom: 'calc(14px * var(--gap))' }}>
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

// Daemon Start/Stop/Restart + proactive toggle — the controls that used to live
// in the Dashboard's hero bar, now the top card of System › Status.
function DaemonControls({ agentStatus, busy, onStart, onStop, onRestart, proactive, onProactive }) {
  const running = agentStatus === 'running';
  const stopping = agentStatus === 'stopping';
  const starting = agentStatus === 'starting' || (!!busy && !stopping);
  const transitioning = starting || stopping;
  const label =
    { running: 'Running', stopped: 'Stopped', starting: 'Starting…', stopping: 'Stopping…' }[
      agentStatus
    ] || 'Stopped';
  return (
    <window.Card
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
        marginBottom: 'calc(14px * var(--gap))',
      }}
    >
      <span
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          flex: 'none',
          display: 'grid',
          placeItems: 'center',
          background: running ? 'var(--accent-soft)' : 'var(--surface-2)',
          color: running ? 'var(--accent-strong)' : 'var(--text-3)',
          border: '1px solid var(--border)',
        }}
      >
        <window.Icon
          name={transitioning ? 'refresh' : 'power'}
          size={20}
          className={transitioning ? 'spin' : undefined}
        />
      </span>
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <window.StatusDot
            state={transitioning ? 'starting' : running ? 'running' : 'stopped'}
            size={9}
            pulse={running}
          />
          <span style={{ fontSize: 16, fontWeight: 700 }}>{label}</span>
        </div>
        <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 3 }}>
          {running
            ? 'Modulus is live and answering messages on Telegram.'
            : 'The agent is not running. Start it to begin answering messages.'}
        </p>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px 6px 6px',
          borderRadius: 99,
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }}
        title="Let Modulus message you first with nudges and briefings."
      >
        <window.Toggle checked={!!proactive} onChange={onProactive} label="Proactive nudges" />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Proactive</span>
      </div>
      <window.Button
        variant="subtle"
        size="sm"
        icon="refresh"
        onClick={onRestart}
        disabled={!running || transitioning}
        style={{ opacity: running && !transitioning ? 1 : 0.5 }}
      >
        Restart
      </window.Button>
      <window.Button
        variant={running || stopping ? 'default' : 'primary'}
        icon={running || stopping ? 'stop' : 'power'}
        onClick={running ? onStop : onStart}
        disabled={transitioning}
        style={
          running || stopping
            ? {
                borderColor: 'color-mix(in oklab, var(--err) 40%, transparent)',
                color: 'var(--err)',
              }
            : {}
        }
      >
        {stopping ? 'Stopping…' : running ? 'Stop' : starting ? 'Starting…' : 'Start agent'}
      </window.Button>
    </window.Card>
  );
}

/* ---- status dashboard ---- */
function StatusDashboard({
  state,
  agentStatus,
  busy,
  onStart,
  onStop,
  onRestart,
  proactive,
  onProactive,
}) {
  const s = state || {};
  const agent = s.agent || {};
  const health = s.health || {};
  const models = s.models || {};
  const mods = s.modules || {};
  const agentState = agent.running ? 'running' : 'stopped';
  // "refused" vs "unreachable" point at different fixes (Ollama not listening
  // vs the machine itself being off) — crucial when Ollama lives on another box.
  const ollamaDownLabel = (kind) =>
    kind === 'refused'
      ? 'Not listening'
      : kind === 'dns'
        ? 'Bad hostname'
        : kind === 'unreachable' || kind === 'timeout'
          ? 'Machine unreachable'
          : 'Unreachable';
  const ollamaDownSub = (kind, url) => {
    const u = url || '';
    if (kind === 'refused')
      return `${u} — is Ollama running? On another machine, set OLLAMA_HOST=0.0.0.0`;
    if (kind === 'unreachable' || kind === 'timeout')
      return `${u} — is the machine on and the address right?`;
    if (kind === 'dns') return `${u} — hostname doesn’t resolve; try the IP address`;
    return u;
  };
  const cards = [
    {
      label: 'Agent',
      value: agent.running ? 'Running' : 'Stopped',
      dot: agentState,
      sub: agent.pid ? `pid ${agent.pid}` : 'not running',
    },
    {
      label: 'Ollama',
      value: health.ollama ? 'Reachable' : ollamaDownLabel(health.ollamaErrorKind),
      dot: health.ollama ? 'ok' : 'err',
      sub: health.ollama
        ? health.ollamaUrl || ''
        : ollamaDownSub(health.ollamaErrorKind, health.ollamaUrl),
    },
    { label: 'Models loaded', value: models.loaded ?? 0, sub: models.chat || '—' },
    { label: 'Allowlist', value: s.allowlistCount ?? 0, sub: 'users allowed' },
    {
      label: 'Modules enabled',
      value: mods.enabled ?? 0,
      sub: `${mods.installed ?? 0} installed`,
    },
  ];

  return (
    <div>
      <DaemonControls
        agentStatus={agentStatus}
        busy={busy}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
        proactive={proactive}
        onProactive={onProactive}
      />
      <SystemHealthBar state={state} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 'calc(14px * var(--gap))',
        }}
      >
        {cards.map((c) => (
          <window.Card key={c.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                fontSize: 12.5,
                color: 'var(--text-3)',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '.04em',
              }}
            >
              {c.label}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              {c.dot && <window.StatusDot state={c.dot} size={9} pulse={c.dot === 'running'} />}
              <span
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: 0,
                  fontFamily: typeof c.value === 'number' ? 'var(--font-mono)' : 'var(--font-ui)',
                }}
              >
                {c.value}
              </span>
            </div>
            {c.sub && (
              <span
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-3)',
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {c.sub}
              </span>
            )}
          </window.Card>
        ))}
      </div>
      {s.ramGb != null && (
        <p
          style={{
            fontSize: 12.5,
            color: 'var(--text-3)',
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <window.Icon name="shield" size={13} />{' '}
          {s.freeRamGb != null
            ? `${s.freeRamGb} GB free of ${s.ramGb} GB RAM`
            : `${s.ramGb} GB RAM`}{' '}
          · tier {s.tier} · v{s.version}
        </p>
      )}
    </div>
  );
}

/* ---- doctor ---- */
function Doctor({ onRunCommand }) {
  const [running, setRunning] = useStateSys(false);
  const [checks, setChecks] = useStateSys(null);
  const [error, setError] = useStateSys(null);

  const run = async (includeCommand = true) => {
    setRunning(true);
    setError(null);
    const [r] = await Promise.all([
      window.api.get('/api/doctor'),
      includeCommand ? onRunCommand() : Promise.resolve(),
    ]);
    setRunning(false);
    if (r.ok) setChecks(r.data.checks);
    else setError(r.error || 'Could not run diagnostics.');
  };

  useEffectSys(() => {
    run(false);
  }, []);

  const summary = checks
    ? {
        pass: checks.filter((c) => c.status === 'pass').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      }
    : null;

  return (
    <div style={{ maxWidth: 720 }}>
      <window.Card
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>Health check</div>
          <p style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 3 }}>
            Runs the same preflight checks as <span className="mono">modulus doctor</span>.
          </p>
        </div>
        {summary && (
          <div style={{ display: 'flex', gap: 8 }}>
            <window.Badge tone="ok">{summary.pass} pass</window.Badge>
            {summary.warn > 0 && <window.Badge tone="warn">{summary.warn} warn</window.Badge>}
            {summary.fail > 0 && <window.Badge tone="err">{summary.fail} fail</window.Badge>}
          </div>
        )}
        <window.Button
          variant="primary"
          icon={running ? undefined : 'pulse'}
          onClick={() => run(true)}
          disabled={running}
        >
          {running ? (
            <>
              <window.Icon name="refresh" size={16} className="spin" /> Running…
            </>
          ) : checks ? (
            'Run again'
          ) : (
            'Run check'
          )}
        </window.Button>
      </window.Card>

      {error && <ErrorNote text={error} />}

      {checks ? (
        <window.Card pad={0}>
          {checks.map((c, i) => (
            <div
              key={c.id}
              className="rise"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 13,
                padding: '14px 18px',
                borderTop: i ? '1px solid var(--border)' : 'none',
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 99,
                  flex: 'none',
                  display: 'grid',
                  placeItems: 'center',
                  marginTop: 1,
                  background:
                    c.status === 'pass'
                      ? 'color-mix(in oklab, var(--ok) 16%, transparent)'
                      : c.status === 'warn'
                        ? 'color-mix(in oklab, var(--warn) 18%, transparent)'
                        : 'color-mix(in oklab, var(--err) 14%, transparent)',
                  color:
                    c.status === 'pass'
                      ? 'var(--ok)'
                      : c.status === 'warn'
                        ? 'var(--warn)'
                        : 'var(--err)',
                }}
              >
                <window.Icon
                  name={c.status === 'pass' ? 'check' : c.status === 'warn' ? 'alert' : 'x'}
                  size={14}
                />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{c.label}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>{c.detail}</div>
                {c.fix && c.status !== 'pass' && (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--text-3)',
                      marginTop: 5,
                      display: 'flex',
                      gap: 6,
                    }}
                  >
                    <window.Icon
                      name="spark"
                      size={13}
                      style={{ color: 'var(--warn)', flex: 'none', marginTop: 1 }}
                    />{' '}
                    {c.fix}
                  </div>
                )}
              </div>
            </div>
          ))}
        </window.Card>
      ) : (
        !error &&
        !running && (
          <div
            style={{
              textAlign: 'center',
              padding: '50px 20px',
              border: '1px dashed var(--border-2)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-3)',
            }}
          >
            <window.Icon name="pulse" size={28} style={{ margin: '0 auto 10px' }} />
            <p style={{ fontSize: 14, color: 'var(--text-2)', fontWeight: 600 }}>
              No checks run yet
            </p>
            <p style={{ fontSize: 13, marginTop: 3 }}>
              Press “Run check” to see how Modulus is doing.
            </p>
          </div>
        )
      )}
    </div>
  );
}

/* ---- log viewer ---- */
const LEVEL_COLOR = {
  debug: 'var(--text-3)',
  info: 'var(--info)',
  warn: 'var(--warn)',
  error: 'var(--err)',
};
function parseLine(raw) {
  // Daemon logs are JSON lines {t, level, msg, ...fields}; fall back to raw text.
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && o.msg !== undefined) {
      const { t, level, msg, ...f } = o;
      const time = t ? String(t).slice(11, 23) : '';
      return { t: time, level: level || 'info', msg: String(msg), f };
    }
  } catch {
    /* not JSON */
  }
  return { t: '', level: 'info', msg: raw, f: {} };
}

function LogViewer() {
  const [lines, setLines] = useStateSys([]);
  const [follow, setFollow] = useStateSys(true);
  const [filter, setFilter] = useStateSys('all');
  const [q, setQ] = useStateSys('');
  const [connected, setConnected] = useStateSys(false);
  const boxRef = useRefSys(null);
  const esRef = useRefSys(null);

  useEffectSys(() => {
    if (!follow) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
        setConnected(false);
      }
      return;
    }
    const es = window.api.streamSSE('/api/logs/stream', {
      onOpen: () => setConnected(true),
      onMessage: (_ev, data) => {
        let raw = data;
        try {
          raw = JSON.parse(data);
        } catch {
          /* data is already a string */
        }
        setLines((l) => [...l.slice(-400), parseLine(raw)]);
      },
      onError: () => setConnected(false),
    });
    esRef.current = es;
    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [follow]);

  useEffectSys(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, follow]);

  const shown = lines.filter(
    (l) =>
      (filter === 'all' || l.level === filter) &&
      (!q || (l.msg + JSON.stringify(l.f)).toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <window.Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={['all', 'debug', 'info', 'warn', 'error']}
        />
        <div style={{ position: 'relative', flex: 1, minWidth: 180, maxWidth: 320 }}>
          <window.Icon
            name="search"
            size={15}
            style={{
              position: 'absolute',
              left: 11,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-3)',
              zIndex: 1,
            }}
          />
          <window.Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search logs…"
            style={{ paddingLeft: 34, fontSize: 13 }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px 6px 6px',
            borderRadius: 99,
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}
        >
          <window.Toggle checked={follow} onChange={setFollow} label="Follow logs" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
            Follow
            {follow && connected && (
              <span style={{ marginLeft: 6, color: 'var(--ok)' }}>● live</span>
            )}
          </span>
        </div>
      </div>
      <div
        ref={boxRef}
        style={{
          background: 'var(--code-bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 14,
          height: 460,
          overflowY: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          lineHeight: 1.7,
        }}
      >
        {shown.length === 0 && (
          <div style={{ color: 'var(--text-3)', padding: 20, textAlign: 'center' }}>
            {follow
              ? 'Waiting for log lines… (the daemon writes here while running)'
              : 'Follow is off.'}
          </div>
        )}
        {shown.map((l, i) => (
          <div
            key={i}
            style={{ display: 'flex', gap: 12, whiteSpace: 'pre-wrap', padding: '1px 0' }}
          >
            {l.t && <span style={{ color: 'var(--text-3)', flex: 'none' }}>{l.t}</span>}
            <span
              style={{
                color: LEVEL_COLOR[l.level] || 'var(--text-3)',
                fontWeight: 600,
                width: 46,
                flex: 'none',
                textTransform: 'uppercase',
                fontSize: 11,
              }}
            >
              {l.level}
            </span>
            <span style={{ color: 'var(--text)', flex: 'none' }}>{l.msg}</span>
            <span style={{ color: 'var(--text-3)' }}>
              {Object.entries(l.f)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                .join(' ')}
            </span>
          </div>
        ))}
      </div>
      <p
        style={{
          fontSize: 12.5,
          color: 'var(--text-3)',
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <window.Icon name="shield" size={13} /> Secrets and tokens are automatically redacted in
        logs.
      </p>
    </div>
  );
}

/* ---- maintenance ---- */
function Maintenance({ state, onUpdate, onFresh }) {
  const [updating, setUpdating] = useStateSys(false);
  const [freshing, setFreshing] = useStateSys(false);
  const [resetOpen, setResetOpen] = useStateSys(false);
  const [confirmText, setConfirmText] = useStateSys('');
  const version = state && state.version ? state.version : '';

  const doUpdate = async () => {
    setUpdating(true);
    try {
      await onUpdate();
    } finally {
      setUpdating(false);
    }
  };

  const doFresh = async () => {
    setFreshing(true);
    setResetOpen(false);
    try {
      await onFresh(confirmText);
    } finally {
      setFreshing(false);
      setConfirmText('');
    }
  };

  return (
    <div
      style={{
        maxWidth: 680,
        display: 'flex',
        flexDirection: 'column',
        gap: 'calc(16px * var(--gap))',
      }}
    >
      {state && state.desktop ? (
        // Desktop-app install: a packaged payload, not a git checkout. The
        // shell updates itself from releases; `modulus update` doesn't apply.
        <window.Card style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <window.Icon name="download" size={22} style={{ color: 'var(--text-3)' }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 15.5 }}>Updates</div>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 2 }}>
              The Modulus desktop app keeps itself up to date automatically. When an update is
              ready, quit and reopen the app to apply it.
              {version ? ` Currently v${version}.` : ''}
            </p>
          </div>
        </window.Card>
      ) : (
        <window.Card style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <window.Icon name="download" size={22} style={{ color: 'var(--text-3)' }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 15.5 }}>Update Modulus</div>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 2 }}>
              Pulls the latest code, reinstalls dependencies, and rebuilds (
              <span className="mono">modulus update</span>). Restart the agent afterwards.
              {version ? ` Currently v${version}.` : ''}
            </p>
          </div>
          <window.Button variant="primary" onClick={doUpdate} disabled={updating || freshing}>
            {updating ? (
              <>
                <window.Icon name="refresh" size={16} className="spin" /> Updating…
              </>
            ) : (
              'Check & update'
            )}
          </window.Button>
        </window.Card>
      )}

      <div
        style={{
          borderRadius: 'var(--radius)',
          border: '1px solid color-mix(in oklab, var(--err) 35%, transparent)',
          background: 'color-mix(in oklab, var(--err) 6%, var(--surface))',
          padding: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <window.Icon name="alert" size={18} style={{ color: 'var(--err)' }} />
          <span style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--err)' }}>Danger zone</span>
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 14 }}>
          A fresh install (<span className="mono">modulus fresh</span>) wipes{' '}
          <b>all configuration, modules, and stored data</b> and re-runs first-time setup. This
          cannot be undone.
        </p>
        <window.Button
          variant="outline_danger"
          icon="trash"
          disabled={freshing || updating}
          onClick={() => {
            setResetOpen(true);
            setConfirmText('');
          }}
        >
          {freshing ? 'Fresh install running...' : 'Fresh install / Reset...'}
        </window.Button>
      </div>

      <window.Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        tone="err"
        title="Reset Modulus to a fresh install?"
        width={500}
        footer={
          <>
            <window.Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </window.Button>
            <window.Button
              variant="danger"
              icon="trash"
              disabled={confirmText !== 'RESET' || freshing}
              style={{ opacity: confirmText === 'RESET' && !freshing ? 1 : 0.5 }}
              onClick={doFresh}
            >
              {freshing ? 'Wiping...' : 'Wipe and redownload'}
            </window.Button>
          </>
        }
      >
        <p>
          This permanently deletes your bot token, allowlist, model choices, every installed module,
          and all stored data. It runs <span className="mono">modulus fresh</span>, redownloads the
          current checkout, rebuilds, then returns you to the in-browser setup wizard.
        </p>
        <div style={{ marginTop: 16 }}>
          <window.Label hint="This is a safety check so it can’t happen by accident.">
            Type{' '}
            <span className="mono" style={{ color: 'var(--err)', fontWeight: 700 }}>
              RESET
            </span>{' '}
            to confirm
          </window.Label>
          <window.Input
            mono
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESET"
            invalid={confirmText.length > 0 && confirmText !== 'RESET'}
          />
        </div>
      </window.Modal>
    </div>
  );
}

/* ---- telegram commands ---- */
function Commands() {
  const [data, setData] = useStateSys(null);
  const [error, setError] = useStateSys(null);

  useEffectSys(() => {
    window.api.get('/api/commands').then((r) => {
      if (r.ok) setData(r.data);
      else setError(r.error || 'Could not load commands.');
    });
  }, []);
  if (error)
    return (
      <div style={{ maxWidth: 680 }}>
        <ErrorNote text={error} />
      </div>
    );
  if (!data)
    return <div style={{ maxWidth: 680, color: 'var(--text-3)', fontSize: 13.5 }}>Loading…</div>;
  const groups = [
    { title: 'Core commands', items: data.core || [] },
    { title: 'From modules', items: data.modules || [] },
  ].filter((g) => g.items.length);
  return (
    <div style={{ maxWidth: 680 }}>
      <p style={{ fontSize: 13.5, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.55 }}>
        These are the slash-commands you can type to your bot in Telegram. They do the same things
        you’d find here in the panel.
      </p>
      {groups.map((g) => (
        <div key={g.title} style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: '.05em',
              marginBottom: 10,
            }}
          >
            {g.title}
          </div>
          <window.Card pad={0}>
            {g.items.map((c, i) => (
              <div
                key={c.cmd + i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: '13px 18px',
                  borderTop: i ? '1px solid var(--border)' : 'none',
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: 'var(--accent-strong)',
                    width: 110,
                    flex: 'none',
                  }}
                >
                  {c.cmd}
                </span>
                <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{c.desc}</span>
              </div>
            ))}
          </window.Card>
        </div>
      ))}
    </div>
  );
}

/* ---- metrics dashboard ---- */
// "3d 4h" / "12m" from a millisecond span.
function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
function fmtAgoShort(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - ts;
  if (ms < 5000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// Dependency-free inline-SVG sparkline. `values` is an array of numbers (nulls
// are skipped). `domain` pins the y-axis [min,max]; without it the line
// auto-scales to its own range. Renders fine on a Pi — it's one <path>.
function Sparkline({ values, height = 46, stroke = 'var(--accent)', fill = true, domain }) {
  const width = 240;
  const nums = (values || []).filter((v) => typeof v === 'number');
  if (nums.length < 2)
    return (
      <div
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-3)',
          fontSize: 12,
        }}
      >
        collecting…
      </div>
    );
  let lo = domain ? domain[0] : Math.min(...nums);
  let hi = domain ? domain[1] : Math.max(...nums);
  if (hi <= lo) {
    hi = lo + 1;
    lo = lo - 1;
  }
  const pad = 3;
  const n = values.length;
  const xstep = (width - pad * 2) / Math.max(1, n - 1);
  const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
  const pts = [];
  values.forEach((v, i) => {
    if (typeof v === 'number') pts.push([pad + i * xstep, y(v)]);
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = pts.length
    ? `${line} L${pts[pts.length - 1][0].toFixed(1)} ${height - pad} L${pts[0][0].toFixed(1)} ${
        height - pad
      } Z`
    : '';
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
    >
      {fill && <path d={area} fill={stroke} opacity={0.12} />}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function StatCard({ label, value, sub, dot, mono }) {
  return (
    <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 12.5,
          color: 'var(--text-3)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '.04em',
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        {dot && <window.StatusDot state={dot} size={9} pulse={dot === 'running'} />}
        <span
          style={{
            fontSize: 24,
            fontWeight: 700,
            fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
          }}
        >
          {value}
        </span>
      </div>
      {sub && (
        <span
          style={{
            fontSize: 12.5,
            color: 'var(--text-3)',
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {sub}
        </span>
      )}
    </window.Card>
  );
}

const DROP_LABELS = {
  dedup: 'Deduplicated',
  rate_limit: 'Rate limited',
  paused: 'Snoozed',
  window: 'Quiet hours',
  no_dispatch: 'No active chat',
};
const HISTORY_MAX = 60; // ~5 min of trend at the 5s sample cadence

function MetricsView() {
  const [data, setData] = useStateSys(null);
  const [error, setError] = useStateSys(null);
  const [history, setHistory] = useStateSys([]);

  const poll = async () => {
    const r = await window.api.get('/api/metrics');
    if (!r.ok) {
      setError(r.error || 'Could not load metrics.');
      return;
    }
    setError(null);
    const m = r.data || {};
    setData(m);
    setHistory((h) => {
      const next = [
        ...h,
        {
          t: Date.now(),
          freeGb: m.ram ? m.ram.freeGb : null,
          hitRate: m.hasMetrics && m.cache ? m.cache.hitRate : null,
          nudgesSent: m.hasMetrics && m.scheduler ? m.scheduler.nudgesSent : null,
        },
      ];
      return next.length > HISTORY_MAX ? next.slice(-HISTORY_MAX) : next;
    });
  };

  useEffectSys(() => {
    void poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  if (error && !data)
    return (
      <div style={{ maxWidth: 820 }}>
        <ErrorNote text={error} onRetry={poll} />
      </div>
    );
  if (!data)
    return <div style={{ maxWidth: 820, color: 'var(--text-3)', fontSize: 13.5 }}>Loading…</div>;

  const d = data;
  const ram = d.ram || {};
  const cache = d.cache || {};
  const sched = d.scheduler || {};
  const running = !!d.agentRunning;
  const uptimeMs = d.startedAt && running ? Date.now() - d.startedAt : 0;
  const dropped = sched.nudgesDropped || {};
  const droppedTotal = Object.values(dropped).reduce((a, b) => a + (b || 0), 0);
  const ramUsedPct = ram.totalGb
    ? Math.round(((ram.totalGb - ram.freeGb) / ram.totalGb) * 100)
    : null;

  const freeSeries = history.map((h) => h.freeGb);
  const hitSeries = history.map((h) => h.hitRate);

  return (
    <div
      style={{
        maxWidth: 820,
        display: 'flex',
        flexDirection: 'column',
        gap: 'calc(16px * var(--gap))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', flex: 1, lineHeight: 1.5 }}>
          Live performance for this device. Counters come from the daemon’s metrics snapshot; trends
          are sampled every 5s while this tab is open.
        </p>
        <span style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
          {d.hasMetrics ? `updated ${fmtAgoShort(d.metricsAt)}` : 'agent not running'}
        </span>
        <window.Button size="sm" variant="ghost" icon="refresh" onClick={poll}>
          Refresh
        </window.Button>
      </div>

      {!d.hasMetrics && (
        <div
          style={{
            border: '1px dashed var(--border-2)',
            borderRadius: 'var(--radius)',
            padding: '18px 20px',
            color: 'var(--text-3)',
            fontSize: 13.5,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <window.Icon name="pulse" size={18} />
          The agent hasn’t written metrics yet. Start it to see cache, scheduler, and nudge
          counters. RAM is shown below regardless.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 'calc(14px * var(--gap))',
        }}
      >
        <StatCard
          label="Uptime"
          value={running && d.startedAt ? fmtUptime(uptimeMs) : '—'}
          sub={running ? 'agent running' : 'agent stopped'}
          dot={running ? 'running' : 'stopped'}
          mono
        />
        <StatCard
          label="Cache hit-rate"
          value={cache.hitRate == null ? '—' : `${cache.hitRate}%`}
          sub={`${cache.hits ?? 0} hits · ${cache.misses ?? 0} miss`}
          dot={cache.hitRate == null ? 'stopped' : cache.hitRate >= 50 ? 'ok' : 'warn'}
          mono
        />
        <StatCard label="Cache entries" value={cache.size ?? 0} sub="fast-cache size" mono />
        <StatCard
          label="Scheduler ticks"
          value={sched.ticks ?? 0}
          sub={sched.lastTickAt ? `last ${fmtAgoShort(sched.lastTickAt)}` : 'no ticks yet'}
          mono
        />
        <StatCard
          label="Nudges sent"
          value={sched.nudgesSent ?? 0}
          sub={droppedTotal ? `${droppedTotal} dropped` : 'none dropped'}
          mono
        />
        <StatCard
          label="Free RAM"
          value={ram.freeGb != null ? `${ram.freeGb} GB` : '—'}
          sub={
            ram.totalGb
              ? `of ${ram.totalGb} GB${ramUsedPct != null ? ` · ${ramUsedPct}% used` : ''}`
              : ''
          }
          dot={ramUsedPct != null ? (ramUsedPct < 85 ? 'ok' : 'warn') : undefined}
          mono
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'calc(14px * var(--gap))',
        }}
      >
        <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Free RAM (GB)</span>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              {ram.freeGb != null ? `${ram.freeGb} / ${ram.totalGb}` : '—'}
            </span>
          </div>
          <Sparkline
            values={freeSeries}
            domain={ram.totalGb ? [0, ram.totalGb] : undefined}
            stroke="var(--info)"
          />
        </window.Card>
        <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Cache hit-rate (%)</span>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              {cache.hitRate == null ? '—' : `${cache.hitRate}%`}
            </span>
          </div>
          <Sparkline values={hitSeries} domain={[0, 100]} stroke="var(--accent)" />
        </window.Card>
      </div>

      {droppedTotal > 0 && (
        <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Nudges dropped by reason</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.entries(dropped)
              .filter(([, v]) => v > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => {
                const pct = Math.round((count / droppedTotal) * 100);
                return (
                  <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{ fontSize: 13, color: 'var(--text-2)', width: 130, flex: 'none' }}
                    >
                      {DROP_LABELS[reason] || reason}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 99,
                        background: 'var(--surface-2)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: '100%',
                          background: 'var(--warn)',
                          borderRadius: 99,
                        }}
                      />
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text-3)',
                        width: 36,
                        textAlign: 'right',
                      }}
                    >
                      {count}
                    </span>
                  </div>
                );
              })}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
            Dropped nudges are suppressed on purpose — dedup, rate limits, snooze, or quiet hours.
          </p>
        </window.Card>
      )}
    </div>
  );
}

/* ---- schedule / proactive timeline ---- */
// "in 2h 5m" from a millisecond span until the next fire.
function fmtIn(ms) {
  if (ms == null) return 'unknown';
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `in ${d}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m % 60}m`;
  if (m > 0) return `in ${m}m`;
  return 'in <1m';
}
// Local "Wed 08:00" wall-clock label for an absolute timestamp.
function fmtClock(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function prettyJob(name) {
  return String(name || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function prettyModule(name) {
  return String(name || '').replace(/^modulus-/, '');
}
// ms from now until the next 08:00 local (today if still upcoming, else tomorrow).
function untilMorningMs() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(8, 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime() - now.getTime();
}

function ScheduleView() {
  const [data, setData] = useStateSys(null);
  const [error, setError] = useStateSys(null);
  const [loading, setLoading] = useStateSys(true);
  const [busy, setBusy] = useStateSys(false);

  const load = async () => {
    setLoading(true);
    const r = await window.api.get('/api/scheduler');
    setLoading(false);
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else {
      setError(r.error || 'Could not load the schedule.');
    }
  };

  useEffectSys(() => {
    void load();
  }, []);

  const snooze = async (ms) => {
    setBusy(true);
    await window.api.post('/api/scheduler/snooze', { ms });
    setBusy(false);
    void load();
  };

  if (loading && !data)
    return <div style={{ maxWidth: 760, color: 'var(--text-3)', fontSize: 13.5 }}>Loading…</div>;
  if (error)
    return (
      <div style={{ maxWidth: 760 }}>
        <ErrorNote text={error} onRetry={load} />
      </div>
    );
  if (data && data.configured === false)
    return (
      <div
        style={{
          maxWidth: 760,
          textAlign: 'center',
          padding: '50px 20px',
          border: '1px dashed var(--border-2)',
          borderRadius: 'var(--radius)',
          color: 'var(--text-3)',
        }}
      >
        <window.Icon name="pulse" size={28} style={{ margin: '0 auto 10px' }} />
        <p style={{ fontSize: 14, color: 'var(--text-2)', fontWeight: 600 }}>
          Nothing scheduled yet
        </p>
        <p style={{ fontSize: 13, marginTop: 3 }}>
          Finish setup (a bot token and an allowed user) so the scheduler can run.
        </p>
      </div>
    );

  const d = data || {};
  const jobs = d.jobs || [];
  const now = Date.now();
  const paused = !!d.pausedUntilMs && d.pausedUntilMs > now;
  const quietWindow = d.quiet && d.quiet.reason === 'window' ? d.quiet : null;
  const statusTone = !d.proactive ? 'neutral' : paused || quietWindow ? 'warn' : 'ok';
  const statusText = !d.proactive
    ? 'Proactive nudges are off'
    : paused
      ? `Snoozed until ${fmtTime(d.pausedUntilMs)}`
      : quietWindow
        ? `Quiet hours until ${fmtTime(quietWindow.until)}`
        : 'Active — Modulus may nudge you';

  return (
    <div
      style={{
        maxWidth: 760,
        display: 'flex',
        flexDirection: 'column',
        gap: 'calc(16px * var(--gap))',
      }}
    >
      {/* proactive state + snooze */}
      <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <window.Icon name="pulse" size={20} style={{ color: 'var(--text-3)' }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 15.5 }}>Proactive nudges</div>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 2 }}>
              When Modulus may message you first — briefings, reminders, and follow-ups.
            </p>
          </div>
          <window.Badge tone={statusTone}>{statusText}</window.Badge>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {paused ? (
            <window.Button
              size="sm"
              variant="primary"
              icon="power"
              onClick={() => snooze(0)}
              disabled={busy}
            >
              Resume now
            </window.Button>
          ) : (
            <>
              <span style={{ fontSize: 13, color: 'var(--text-3)', marginRight: 2 }}>Snooze:</span>
              <window.Button
                size="sm"
                variant="subtle"
                onClick={() => snooze(3_600_000)}
                disabled={busy || !d.proactive}
              >
                1 hour
              </window.Button>
              <window.Button
                size="sm"
                variant="subtle"
                onClick={() => snooze(4 * 3_600_000)}
                disabled={busy || !d.proactive}
              >
                4 hours
              </window.Button>
              <window.Button
                size="sm"
                variant="subtle"
                onClick={() => snooze(untilMorningMs())}
                disabled={busy || !d.proactive}
              >
                Until 8 AM
              </window.Button>
            </>
          )}
        </div>
        {d.quietWindow && (
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--text-3)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <window.Icon name="moon" size={13} /> Quiet hours {d.quietWindow} daily · set with{' '}
            <span className="mono">/quiet</span> in Telegram.
          </p>
        )}
      </window.Card>

      {/* upcoming jobs timeline */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 10,
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: '.05em',
            }}
          >
            Upcoming jobs ({jobs.length})
          </span>
          <window.Button size="sm" variant="ghost" icon="refresh" onClick={load} disabled={loading}>
            Refresh
          </window.Button>
        </div>
        {jobs.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '40px 20px',
              border: '1px dashed var(--border-2)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-3)',
              fontSize: 13.5,
            }}
          >
            No scheduled jobs. Modules like the everyday assistant register briefings and reminders
            here.
          </div>
        ) : (
          <window.Card pad={0}>
            {jobs.map((j, i) => (
              <div
                key={j.module + ':' + j.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '13px 18px',
                  borderTop: i ? '1px solid var(--border)' : 'none',
                }}
              >
                <div
                  style={{
                    width: 92,
                    flex: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent-strong)' }}>
                    {fmtIn(j.nextFireMs == null ? null : j.nextFireMs - now)}
                  </span>
                  <span
                    style={{
                      fontSize: 11.5,
                      color: 'var(--text-3)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {j.nextFireMs ? fmtClock(j.nextFireMs) : '—'}
                  </span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                    {prettyJob(j.name)}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--text-3)',
                      marginTop: 2,
                    }}
                  >
                    {j.human || j.cron}
                  </div>
                </div>
                <window.Badge tone="neutral">{prettyModule(j.module)}</window.Badge>
              </div>
            ))}
          </window.Card>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10 }}>
          Times are computed in this machine’s local timezone. The running agent fires these; this
          is a read-only view.
        </p>
      </div>
    </div>
  );
}

function ErrorNote({ text, onRetry }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18,
        padding: 14,
        borderRadius: 'var(--radius)',
        border: '1px solid color-mix(in oklab, var(--err) 30%, transparent)',
        background: 'color-mix(in oklab, var(--err) 7%, var(--surface))',
      }}
    >
      <window.Icon name="alert" size={18} style={{ color: 'var(--err)' }} />
      <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-2)' }}>{text}</span>
      {onRetry && (
        <window.Button size="sm" variant="subtle" icon="refresh" onClick={onRetry}>
          Retry
        </window.Button>
      )}
    </div>
  );
}

Object.assign(window, { SystemTab });
