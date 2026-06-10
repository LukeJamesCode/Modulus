// Modules tab. Lists the modules Modulus actually has installed (from
// GET /api/modules, which merges each manifest with its readiness state and
// settings schema). Enable/disable/uninstall shell out to the `modulus` CLI on
// the server; settings are read/written through the SQLite settings store.
//
// "Browse marketplace" switches to MarketplaceView, which lists modules from the
// registry (GET /api/modules/registry) and installs them through the consent-
// gated POST /api/modules/registry/install. Local/git installs still go through
// the CLI (`modulus mod install <path|git-url>`).
const { useState: useStateMod, useEffect: useEffectMod, useRef: useRefMod } = React;

function ModulesTab() {
  const [mods, setExts] = useStateMod(null); // null = loading
  const [error, setError] = useStateMod(null);
  const [detail, setDetail] = useStateMod(null); // mod name
  const [tab, setTab] = useStateMod('all'); // all | enabled | disabled
  const [confirm, setConfirm] = useStateMod(null); // { mod }
  const [settingsFor, setSettingsFor] = useStateMod(null); // mod name
  const [authFor, setAuthFor] = useStateMod(null); // mod name being connected
  const [busy, setBusy] = useStateMod(null); // name currently mutating
  const [setupPromptDismissed, setSetupPromptDismissed] = useStateMod(false);
  const [view, setView] = useStateMod('installed'); // installed | browse

  const load = async () => {
    const r = await window.api.get('/api/modules');
    if (r.ok) {
      setExts(r.data.modules);
      setError(null);
    } else setError(r.error || 'Could not load modules.');
  };
  useEffectMod(() => {
    load();
  }, []);

  const act = async (name, action) => {
    setBusy(name + ':' + action);
    const r = await window.api.post(`/api/modules/${encodeURIComponent(name)}/${action}`);
    setBusy(null);
    await load();
    return r;
  };

  const uninstall = async (name) => {
    setConfirm(null);
    if (detail === name) setDetail(null);
    await act(name, 'uninstall');
  };

  if (mods === null && !error) return <window.SectionTitle>Modules</window.SectionTitle>;

  if (settingsFor) {
    const mod = mods.find((e) => e.name === settingsFor);
    if (!mod) {
      setSettingsFor(null);
      return null;
    }
    return (
      <ModuleSettingsView
        mod={mod}
        onBack={() => setSettingsFor(null)}
        onSaved={() => {
          setSettingsFor(null);
          load();
        }}
      />
    );
  }

  if (detail) {
    const mod = mods.find((e) => e.name === detail);
    if (!mod) {
      setDetail(null);
      return null;
    }
    return (
      <>
        <ModuleDetail
          mod={mod}
          mods={mods}
          busy={busy}
          onBack={() => setDetail(null)}
          onToggle={(v) => act(mod.name, v ? 'enable' : 'disable')}
          onUninstall={() => setConfirm({ mod })}
          onSettings={() => setSettingsFor(mod.name)}
          onConnect={() => setAuthFor(mod.name)}
          confirm={confirm}
          setConfirm={setConfirm}
          uninstall={uninstall}
        />
        {authFor === mod.name && (
          <AuthFlowModal
            mod={mod}
            onClose={() => setAuthFor(null)}
            onDone={() => {
              setAuthFor(null);
              load();
            }}
          />
        )}
      </>
    );
  }

  if (view === 'browse') {
    return (
      <MarketplaceView
        onBack={() => {
          setView('installed');
          load();
        }}
      />
    );
  }

  const visibleMods = mods.filter((e) => !e.self);
  const enabled = visibleMods.filter((e) => e.enabled);
  const disabled = visibleMods.filter((e) => !e.enabled);
  const filtered = tab === 'all' ? visibleMods : tab === 'enabled' ? enabled : disabled;
  const setupNeeded = visibleMods.filter((e) => e.source === 'user' && e.status !== 'ready');
  const showSetupPrompt = setupNeeded.length > 0 && !setupPromptDismissed;

  return (
    <div>
      <window.SectionTitle sub="The capabilities Modulus has installed. Each one is opt-in and shows exactly what it can access.">
        Modules
      </window.SectionTitle>

      {error && <ErrorNote text={error} onRetry={load} />}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <window.Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: `All (${visibleMods.length})` },
            { value: 'enabled', label: `Enabled (${enabled.length})` },
            { value: 'disabled', label: `Disabled (${disabled.length})` },
          ]}
        />
        <window.Button
          size="sm"
          variant="default"
          icon="plus"
          onClick={() => setView('browse')}
          style={{ marginLeft: 'auto' }}
        >
          Browse marketplace
        </window.Button>
      </div>

      {visibleMods.length === 0 && !error && (
        <div
          style={{
            textAlign: 'center',
            padding: '50px 20px',
            border: '1px dashed var(--border-2)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-3)',
          }}
        >
          <window.Icon name="plug" size={28} style={{ margin: '0 auto 10px' }} />
          <p style={{ fontSize: 14, color: 'var(--text-2)', fontWeight: 600 }}>
            No modules installed
          </p>
          <p style={{ fontSize: 13, marginTop: 3 }}>
            Install one with <span className="mono">modulus mod install &lt;name&gt;</span>.
          </p>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
          gap: 'calc(16px * var(--gap))',
        }}
      >
        {filtered.map((e) => (
          <ModuleCard
            key={e.name}
            mod={e}
            busy={busy}
            onOpen={() => setDetail(e.name)}
            onToggle={(v) => act(e.name, v ? 'enable' : 'disable')}
          />
        ))}
      </div>

      <ConfirmUninstall confirm={confirm} setConfirm={setConfirm} uninstall={uninstall} />
      <SetupNeededModal
        open={showSetupPrompt}
        modules={setupNeeded}
        onClose={() => setSetupPromptDismissed(true)}
        onReview={(name) => {
          setSetupPromptDismissed(true);
          setDetail(name);
        }}
      />
    </div>
  );
}

function SetupNeededModal({ open, modules, onClose, onReview }) {
  if (!open || modules.length === 0) return null;
  const shown = modules.slice(0, 5);
  const first = modules[0];
  return (
    <window.Modal
      open={open}
      onClose={onClose}
      title="Finish module setup"
      width={560}
      tone="warn"
      footer={
        <>
          <window.Button variant="ghost" onClick={onClose}>
            Not now
          </window.Button>
          <window.Button icon="gear" onClick={() => onReview(first.name)}>
            Review setup
          </window.Button>
        </>
      }
    >
      <p style={{ marginBottom: 12 }}>
        Some downloaded modules are installed but not ready yet. Finish their connection or required
        settings so Modulus can use their tools and commands.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map((mod) => (
          <button
            key={mod.name}
            type="button"
            onClick={() => onReview(mod.name)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              textAlign: 'left',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              cursor: 'pointer',
            }}
          >
            <window.StatusDot state={mod.enabled ? 'warn' : 'stopped'} size={8} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>
                {prettyName(mod)}
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 12.5,
                  color: 'var(--text-3)',
                  marginTop: 2,
                }}
              >
                {setupStatusText(mod)}
              </span>
            </span>
            <window.Icon name="fwd" size={15} style={{ color: 'var(--text-3)', marginTop: 2 }} />
          </button>
        ))}
      </div>
      {modules.length > shown.length && (
        <p style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-3)' }}>
          Plus {modules.length - shown.length} more module
          {modules.length - shown.length === 1 ? '' : 's'}.
        </p>
      )}
    </window.Modal>
  );
}

function setupStatusText(mod) {
  if (mod.status === 'disabled') return 'Disabled. Turn it on to run setup.';
  if (mod.status === 'needs_auth') return 'Needs an account connection.';
  if (mod.status === 'needs_settings') return 'Missing required settings.';
  return mod.reasons && mod.reasons[0] ? mod.reasons[0] : 'Review this module.';
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

function prettyName(mod) {
  return mod.name
    .replace(/^modulus-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function blurbFor(mod) {
  return (
    (window.MODULE_BLURBS && window.MODULE_BLURBS[mod.name]) ||
    mod.description ||
    'No description provided.'
  );
}

/* ---- capability chips ---- */
function CapChips({ caps }) {
  if (!caps || caps.length === 0)
    return <span style={{ fontSize: 12, color: 'var(--text-3)' }}>No special access</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {caps.map((c) => {
        const m = (window.CAP_LABELS && window.CAP_LABELS[c]) || { label: c, tone: 'neutral' };
        return (
          <window.Badge key={c} tone={m.tone} style={{ fontSize: 11 }}>
            {m.label}
          </window.Badge>
        );
      })}
    </div>
  );
}

function ModuleGlyph({ mod, size = 42 }) {
  const initials = prettyName(mod)
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('');
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 11,
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--accent-soft)',
        color: 'var(--accent-strong)',
        fontWeight: 700,
        fontFamily: 'var(--font-display)',
        fontSize: size * 0.36,
      }}
    >
      {initials}
    </span>
  );
}

/* ---- gallery card ---- */
function ModuleCard({ mod, busy, onOpen, onToggle }) {
  const toggling = busy === mod.name + ':enable' || busy === mod.name + ':disable';
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'border-color .15s, box-shadow .15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-2)';
        e.currentTarget.style.boxShadow = 'var(--shadow)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border)';
        e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
      }}
    >
      <div style={{ padding: 18, flex: 1, cursor: 'pointer' }} onClick={onOpen}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ModuleGlyph mod={mod} />
            <div>
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 15.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {prettyName(mod)}
                {['modulus-minimax', 'modulus-openai-compatible', 'modulus-tudor'].includes(
                  mod.name,
                ) && (
                  <window.Badge
                    tone="warn"
                    style={{
                      padding: '2px 6px',
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    IN DEVELOPMENT
                  </window.Badge>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                v{mod.version}
                {mod.source === 'repo' ? ' · bundled' : ''}
              </div>
            </div>
          </div>
          <window.Badge tone={mod.enabled ? 'ok' : 'neutral'}>
            <window.StatusDot state={mod.enabled ? 'ok' : 'stopped'} size={6} />
            {mod.enabled ? 'Enabled' : 'Disabled'}
          </window.Badge>
        </div>
        <p
          style={{
            fontSize: 13.5,
            color: 'var(--text-2)',
            lineHeight: 1.5,
            marginBottom: 14,
            minHeight: 40,
          }}
        >
          {blurbFor(mod)}
        </p>
        <CapChips caps={mod.capabilities} />
        {mod.needsAuth && !mod.authConnected && (
          <div style={{ marginTop: 10 }}>
            <window.Badge tone="warn">
              <window.Icon name="link" size={11} />
              Needs a connection
            </window.Badge>
          </div>
        )}
        {mod.needsAuth && mod.authConnected && (
          <div style={{ marginTop: 10 }}>
            <window.Badge tone="ok">
              <window.Icon name="check" size={11} />
              Connected
            </window.Badge>
          </div>
        )}
      </div>
      <div
        style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {mod.self ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                color: 'var(--text-3)',
                fontWeight: 500,
              }}
            >
              <window.StatusDot state="ok" size={7} /> This panel
            </span>
          ) : toggling ? (
            <window.Icon
              name="refresh"
              size={15}
              className="spin"
              style={{ color: 'var(--text-3)' }}
            />
          ) : (
            <>
              <window.Toggle checked={mod.enabled} onChange={onToggle} label="Enable" />
              <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500 }}>
                {mod.enabled ? 'On' : 'Off'}
              </span>
            </>
          )}
        </div>
        <window.Button size="sm" variant="ghost" onClick={onOpen}>
          Manage →
        </window.Button>
      </div>
    </div>
  );
}

/* ---- detail view ---- */
function ModuleDetail({ mod, mods, busy, onBack, onToggle, onUninstall, onSettings, onConnect }) {
  const dep = (mod.deps || []).map(
    (d) => mods.find((e) => e.name === d) || { name: d, installed: false, enabled: false },
  );
  const toggling = busy === mod.name + ':enable' || busy === mod.name + ':disable';
  return (
    <div className="fade">
      <button
        onClick={onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          color: 'var(--text-2)',
          cursor: 'pointer',
          fontSize: 13.5,
          fontWeight: 600,
          marginBottom: 16,
          padding: 0,
        }}
      >
        <window.Icon name="back" size={16} /> All modules
      </button>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 16,
          marginBottom: 22,
          flexWrap: 'wrap',
        }}
      >
        <ModuleGlyph mod={mod} size={56} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 23 }}>{prettyName(mod)}</h2>
            {['modulus-minimax', 'modulus-openai-compatible', 'modulus-tudor'].includes(
              mod.name,
            ) && (
              <window.Badge
                tone="warn"
                style={{
                  padding: '2px 6px',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  whiteSpace: 'nowrap',
                }}
              >
                IN DEVELOPMENT
              </window.Badge>
            )}
            <span style={{ fontSize: 13, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              v{mod.version}
            </span>
            <window.Badge tone={mod.enabled ? 'ok' : 'neutral'}>
              <window.StatusDot state={mod.enabled ? 'ok' : 'stopped'} size={6} />
              {mod.enabled ? 'Enabled' : 'Disabled'}
            </window.Badge>
            {mod.source === 'repo' && <window.Badge tone="neutral">Bundled</window.Badge>}
          </div>
          <p
            style={{
              fontSize: 14.5,
              color: 'var(--text-2)',
              lineHeight: 1.55,
              marginTop: 8,
              maxWidth: 620,
            }}
          >
            {blurbFor(mod)}
          </p>
          <div style={{ marginTop: 12 }}>
            <CapChips caps={mod.capabilities} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {mod.needsAuth && (
            <window.Button
              variant={mod.authConnected ? 'ok' : 'warn'}
              icon={mod.authConnected ? 'check' : 'link'}
              onClick={onConnect}
            >
              {mod.authConnected ? 'Connected' : 'Connect'}
            </window.Button>
          )}
          <window.Button
            variant="default"
            icon="gear"
            onClick={onSettings}
            disabled={!mod.schema || mod.schema.length === 0}
            style={{ opacity: !mod.schema || mod.schema.length === 0 ? 0.5 : 1 }}
          >
            Settings
          </window.Button>
          {mod.removable && (
            <window.Button variant="outline_danger" icon="trash" onClick={onUninstall}>
              Uninstall
            </window.Button>
          )}
        </div>
      </div>

      <window.Card
        style={{
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          {mod.self ? (
            <>
              <window.StatusDot state="ok" size={11} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>This is the control panel</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                  It's always on while you're using it — it can't be disabled or uninstalled from
                  here.
                </div>
              </div>
            </>
          ) : (
            <>
              {toggling ? (
                <window.Icon
                  name="refresh"
                  size={20}
                  className="spin"
                  style={{ color: 'var(--text-3)' }}
                />
              ) : (
                <window.Toggle checked={mod.enabled} onChange={onToggle} label="Enable module" />
              )}
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {mod.enabled ? 'Module is enabled' : 'Module is disabled'}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                  {mod.enabled
                    ? 'Its tools and commands are available to Modulus.'
                    : 'Turn on to make its tools available.'}
                </div>
              </div>
            </>
          )}
        </div>
      </window.Card>

      {!mod.self && !mod.removable && (
        <p
          style={{
            fontSize: 12.5,
            color: 'var(--text-3)',
            margin: '-4px 0 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <window.Icon name="shield" size={13} style={{ flex: 'none' }} /> Bundled with Modulus —
          disable it to turn it off; it can't be uninstalled.
        </p>
      )}

      {mod.status && mod.status !== 'ready' && mod.reasons && mod.reasons.length > 0 && (
        <window.Card
          style={{
            marginBottom: 16,
            borderColor: 'color-mix(in oklab, var(--warn) 34%, transparent)',
            background: 'color-mix(in oklab, var(--warn) 7%, var(--surface))',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <window.Icon
            name="alert"
            size={20}
            style={{ color: 'var(--warn)', flex: 'none', marginTop: 1 }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Not fully ready</div>
            <ul
              style={{
                fontSize: 13,
                color: 'var(--text-2)',
                margin: '4px 0 0',
                paddingLeft: 18,
                lineHeight: 1.5,
              }}
            >
              {mod.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            {mod.nextAction && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-3)',
                  marginTop: 6,
                  display: 'flex',
                  gap: 6,
                }}
              >
                <window.Icon
                  name="spark"
                  size={13}
                  style={{ color: 'var(--warn)', flex: 'none', marginTop: 1 }}
                />{' '}
                {mod.status === 'needs_auth'
                  ? 'Use the Connect button above — it signs in and saves the credentials for you.'
                  : mod.status === 'needs_settings'
                    ? 'Open Settings above to fill in the missing values.'
                    : mod.nextAction}
              </div>
            )}
          </div>
        </window.Card>
      )}

      {dep.length > 0 && (
        <window.Card style={{ marginBottom: 16 }}>
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
            Depends on
          </div>
          {dep.map((d) => (
            <div
              key={d.name}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}
            >
              <window.StatusDot state={d.installed && d.enabled ? 'ok' : 'warn'} size={7} />{' '}
              {prettyName(d)}
              <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
                {d.installed && d.enabled
                  ? 'installed & enabled'
                  : d.installed
                    ? 'installed but disabled'
                    : 'not installed'}
              </span>
            </div>
          ))}
        </window.Card>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'calc(16px * var(--gap))',
        }}
      >
        <DetailList
          title="Tools it adds"
          icon="plug"
          items={mod.tools}
          empty="No tools"
          render={(x) => (
            <>
              <span className="mono" style={{ fontSize: 13, color: 'var(--accent-strong)' }}>
                {x.name}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{x.desc}</span>
            </>
          )}
        />
        <DetailList
          title="Telegram commands"
          icon="chat"
          items={mod.commands}
          empty="No commands"
          render={(x) => (
            <>
              <span className="mono" style={{ fontSize: 13, color: 'var(--text)' }}>
                {x.cmd}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{x.desc}</span>
            </>
          )}
        />
        <DetailList
          title="Scheduled jobs"
          icon="refresh"
          items={(mod.jobs || []).map((j) => ({ name: j }))}
          empty="No scheduled jobs"
          render={(x) => <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{x.name}</span>}
        />
      </div>
    </div>
  );
}

function DetailList({ title, icon, items, render, empty }) {
  const list = items || [];
  return (
    <window.Card pad={0}>
      <div
        style={{
          padding: '13px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <window.Icon name={icon} size={15} style={{ color: 'var(--text-3)' }} />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{title}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--text-3)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {list.length}
        </span>
      </div>
      {list.length === 0 ? (
        <div style={{ padding: '16px', fontSize: 13, color: 'var(--text-3)' }}>{empty}</div>
      ) : (
        list.map((x, i) => (
          <div
            key={i}
            style={{
              padding: '11px 16px',
              borderTop: i ? '1px solid var(--border)' : 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            {render(x)}
          </div>
        ))
      )}
    </window.Card>
  );
}

/* ---- schema-driven settings form ---- */
function ModuleSettingsView({ mod, onBack, onSaved }) {
  const [vals, setVals] = useStateMod(() =>
    Object.fromEntries((mod.schema || []).map((f) => [f.key, f.value])),
  );
  const [saving, setSaving] = useStateMod(false);
  const [err, setErr] = useStateMod(null);
  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setSaving(true);
    setErr(null);
    const r = await window.api.post(`/api/modules/${encodeURIComponent(mod.name)}/settings`, vals);
    setSaving(false);
    if (r.ok) onSaved();
    else setErr(r.error || 'Could not save settings.');
  };

  return (
    <div className="fade" style={{ maxWidth: 640 }}>
      <button
        onClick={onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          color: 'var(--text-2)',
          cursor: 'pointer',
          fontSize: 13.5,
          fontWeight: 600,
          marginBottom: 16,
          padding: 0,
        }}
      >
        <window.Icon name="back" size={16} /> {prettyName(mod)}
      </button>
      <window.SectionTitle
        sub={`Generated from ${prettyName(mod)}'s settings schema. Secret fields are masked.`}
      >
        {prettyName(mod)} settings
      </window.SectionTitle>
      {err && <ErrorNote text={err} />}
      <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {(mod.schema || []).map((f) => (
          <div key={f.key}>
            <window.Label hint={f.help}>
              {f.label} {f.required && <span style={{ color: 'var(--err)' }}>*</span>}{' '}
              {f.type === 'secret' && (
                <window.Icon
                  name="lock"
                  size={12}
                  style={{ display: 'inline', verticalAlign: 'middle', color: 'var(--text-3)' }}
                />
              )}
            </window.Label>
            {f.type === 'boolean' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <window.Toggle
                  checked={!!vals[f.key]}
                  onChange={(v) => set(f.key, v)}
                  label={f.label}
                />
                <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
                  {vals[f.key] ? 'On' : 'Off'}
                </span>
              </div>
            ) : f.options ? (
              <window.Select value={vals[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </window.Select>
            ) : f.format === 'user-audio-map' ? (
              <UserAudioMapInput
                moduleName={mod.name}
                value={vals[f.key] || ''}
                onChange={(val) => set(f.key, val)}
              />
            ) : f.type === 'secret' ? (
              <window.SecretInput
                value={vals[f.key] || ''}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder="Not set"
              />
            ) : f.type === 'number' ? (
              <window.Input
                type="number"
                mono
                value={vals[f.key]}
                onChange={(e) => set(f.key, e.target.value)}
                style={{ maxWidth: 180 }}
              />
            ) : (
              <window.Input
                value={vals[f.key] || ''}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder="Not set"
              />
            )}
          </div>
        ))}
      </window.Card>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <window.Button variant="ghost" onClick={onBack}>
          Cancel
        </window.Button>
        <window.Button
          variant="primary"
          icon={saving ? undefined : 'check'}
          onClick={save}
          disabled={saving}
        >
          {saving ? (
            <>
              <window.Icon name="refresh" size={16} className="spin" /> Saving…
            </>
          ) : (
            'Save settings'
          )}
        </window.Button>
      </div>
    </div>
  );
}

/* ---- uninstall confirm ---- */
function ConfirmUninstall({ confirm, setConfirm, uninstall }) {
  if (!confirm) return null;
  return (
    <window.Modal
      open={!!confirm}
      onClose={() => setConfirm(null)}
      tone="err"
      title={`Uninstall ${prettyName(confirm.mod)}?`}
      footer={
        <>
          <window.Button variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </window.Button>
          <window.Button variant="danger" icon="trash" onClick={() => uninstall(confirm.mod.name)}>
            Uninstall
          </window.Button>
        </>
      }
    >
      <p>
        This removes the module and its tools, commands, and scheduled jobs. Bundled modules can be
        re-enabled later; installed ones you'd re-add with{' '}
        <span className="mono">modulus mod install</span>.
      </p>
    </window.Modal>
  );
}

/* ---- interactive auth flow ---- */
// Renders an module's `modulus auth` flow in the browser. The server runs the
// real flow (runAuthForModule); we stream its printed output, surface each prompt
// as an input, and POST the user's answers back. URLs in the output are made
// clickable so the OAuth consent link is one tap away.
function linkify(text) {
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a
        key={i}
        href={p}
        target="_blank"
        rel="noreferrer noopener"
        style={{ color: 'var(--accent-strong)', wordBreak: 'break-all' }}
      >
        {p}
      </a>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function AuthFlowModal({ mod, onClose, onDone }) {
  const [lines, setLines] = useStateMod([]);
  const [prompt, setPrompt] = useStateMod(null); // { question, secret }
  const [answer, setAnswer] = useStateMod('');
  const [status, setStatus] = useStateMod('starting'); // starting|running|done|error
  const [error, setError] = useStateMod(null);
  const sessionRef = useRefMod(null);
  const esRef = useRefMod(null);
  const boxRef = useRefMod(null);
  const lastSeqRef = useRefMod(-1);
  const url = (action, qs) =>
    `/api/modules/${encodeURIComponent(mod.name)}/auth/${action}${qs ? '?' + qs : ''}`;

  useEffectMod(() => {
    let cancelled = false;
    (async () => {
      const r = await window.api.post(url('start'));
      if (cancelled) return;
      if (!r.ok || !r.data || !r.data.session) {
        setStatus('error');
        setError((r.data && r.data.error) || r.error || 'Could not start the connection flow.');
        return;
      }
      sessionRef.current = r.data.session;
      setStatus('running');
      const es = window.api.streamSSE(
        url('stream', 'session=' + encodeURIComponent(r.data.session)),
        {
          onMessage: (_ev, data) => {
            let evt;
            try {
              evt = JSON.parse(data);
            } catch {
              return;
            }
            // Skip anything already processed — a reconnecting EventSource gets
            // the whole buffer replayed.
            if (typeof evt.seq === 'number') {
              if (evt.seq <= lastSeqRef.current) return;
              lastSeqRef.current = evt.seq;
            }
            if (evt.type === 'print') setLines((l) => [...l, evt.line || '']);
            else if (evt.type === 'prompt') {
              setPrompt({ question: evt.question, secret: !!evt.secret });
              setAnswer('');
            } else if (evt.type === 'done') {
              setPrompt(null);
              setStatus('done');
            } else if (evt.type === 'error') {
              setPrompt(null);
              setStatus('error');
              setError(evt.message || 'Connection failed.');
            }
          },
        },
      );
      esRef.current = es;
    })();
    return () => {
      cancelled = true;
      if (esRef.current) esRef.current.close();
      const s = sessionRef.current;
      if (s) window.api.post(url('cancel'), { session: s });
    };
  }, []);

  useEffectMod(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, prompt]);

  const submit = async () => {
    const s = sessionRef.current;
    if (!s || !prompt) return;
    const val = answer;
    setLines((l) => [...l, '> ' + (prompt.secret ? '••••••' : val)]);
    setPrompt(null);
    setAnswer('');
    await window.api.post(url('answer'), { session: s, value: val });
  };

  return (
    <window.Modal
      open
      onClose={onClose}
      width={620}
      title={`Connect ${prettyName(mod)}`}
      footer={
        status === 'done' ? (
          <window.Button variant="primary" icon="check" onClick={onDone}>
            Done
          </window.Button>
        ) : (
          <window.Button variant="ghost" onClick={onClose}>
            {status === 'error' ? 'Close' : 'Cancel'}
          </window.Button>
        )
      }
    >
      <p style={{ fontSize: 13.5, color: 'var(--text-2)', marginBottom: 12 }}>
        This runs {prettyName(mod)}'s sign-in right here — the same flow as{' '}
        <span className="mono">modulus auth {mod.name}</span>. Follow the steps below; open any link
        it shows, then paste anything it asks for.
      </p>

      <div
        ref={boxRef}
        style={{
          background: 'var(--code-bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: 14,
          maxHeight: 280,
          overflowY: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}
      >
        {lines.length === 0 && status === 'running' && (
          <span style={{ color: 'var(--text-3)' }}>Starting…</span>
        )}
        {status === 'starting' && <span style={{ color: 'var(--text-3)' }}>Starting…</span>}
        {lines.map((l, i) => (
          <div key={i} style={{ color: 'var(--text)' }}>
            {linkify(l)}
          </div>
        ))}
      </div>

      {prompt && (
        <div style={{ marginTop: 14 }}>
          <window.Label>{prompt.question}</window.Label>
          {prompt.secret ? (
            <window.SecretInput value={answer} onChange={(e) => setAnswer(e.target.value)} />
          ) : (
            <window.Input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="Type your answer and press Enter"
            />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <window.Button variant="primary" icon="send" onClick={submit}>
              Submit
            </window.Button>
          </div>
        </div>
      )}

      {status === 'running' && !prompt && lines.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            fontSize: 13,
            color: 'var(--text-3)',
          }}
        >
          <window.Icon name="refresh" size={15} className="spin" /> Waiting…
        </div>
      )}

      {status === 'done' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 14,
            fontSize: 14,
            color: 'var(--ok)',
            fontWeight: 600,
          }}
        >
          <window.Icon name="check" size={17} /> Connected. Credentials saved on this machine.
        </div>
      )}

      {status === 'error' && <div style={{ marginTop: 14 }}>{<ErrorNote text={error} />}</div>}
    </window.Modal>
  );
}

/* ---- custom inputs ---- */
function UserAudioMapInput({ moduleName, value, onChange }) {
  const [rows, setRows] = useStateMod(() => {
    if (!value) return [];
    return value.split(',').map((pair) => {
      const idx = pair.indexOf(':');
      if (idx === -1) return { uid: pair, path: '' };
      return { uid: pair.slice(0, idx), path: pair.slice(idx + 1) };
    });
  });

  const update = (newRows) => {
    setRows(newRows);
    onChange(
      newRows
        .filter((r) => r.uid || r.path)
        .map((r) => `${r.uid}:${r.path}`)
        .join(','),
    );
  };

  const addRow = () => update([...rows, { uid: '', path: '' }]);
  const removeRow = (i) => update(rows.filter((_, idx) => idx !== i));
  const setRow = (i, field, val) =>
    update(rows.map((r, idx) => (idx === i ? { ...r, [field]: val } : r)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <window.Input
            placeholder="User ID"
            value={row.uid}
            onChange={(e) => setRow(i, 'uid', e.target.value)}
            style={{ width: 150 }}
          />
          <DropZoneInput
            moduleName={moduleName}
            value={row.path}
            onChange={(path) => setRow(i, 'path', path)}
          />
          <window.Button variant="ghost" icon="trash" onClick={() => removeRow(i)} />
        </div>
      ))}
      <div>
        <window.Button variant="ghost" icon="plus" size="sm" onClick={addRow}>
          Add user mapping
        </window.Button>
      </div>
    </div>
  );
}

function DropZoneInput({ moduleName, value, onChange }) {
  const [dragging, setDragging] = useStateMod(false);
  const [uploading, setUploading] = useStateMod(false);

  const onDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const res = await fetch(
        window.api.url(`/api/modules/${encodeURIComponent(moduleName)}/upload`),
        {
          method: 'POST',
          headers: { 'x-filename': file.name },
          body: file,
        },
      );
      const data = await res.json();
      if (res.ok && data.path) {
        onChange(data.path);
      } else {
        window.alert(`Upload failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      window.alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{ flex: 1, position: 'relative' }}
    >
      <window.Input
        value={uploading ? 'Uploading...' : value}
        onChange={(e) => onChange(e.target.value)}
        disabled={uploading}
        placeholder="Drag MP3 file here or type absolute path"
        style={{
          width: '100%',
          borderColor: dragging ? 'var(--accent)' : undefined,
          background: dragging ? 'var(--accent-soft)' : undefined,
        }}
      />
    </div>
  );
}

/* ---- marketplace (browse + install from the registry) ---- */
// Browses GET /api/modules/registry and installs via POST .../install. The
// install is gated by a consent modal listing the module's permissions; we only
// POST acceptAdded:true once the user has seen and confirmed them, so the
// server's fail-closed consent gate is never bypassed silently.
function MarketplaceView({ onBack }) {
  const [mods, setMods] = useStateMod(null); // null = loading
  const [error, setError] = useStateMod(null);
  const [consent, setConsent] = useStateMod(null); // entry awaiting confirmation
  const [busy, setBusy] = useStateMod(null); // name installing
  const [installError, setInstallError] = useStateMod(null);

  const load = async () => {
    setError(null);
    setMods(null);
    const r = await window.api.get('/api/modules/registry');
    if (r.ok) setMods(r.data.modules || []);
    else setError((r.data && r.data.error) || r.error || 'Could not reach the marketplace.');
  };
  useEffectMod(() => {
    load();
  }, []);

  const install = async (entry) => {
    setBusy(entry.name);
    setInstallError(null);
    const r = await window.api.post('/api/modules/registry/install', {
      name: entry.name,
      acceptAdded: true,
    });
    setBusy(null);
    setConsent(null);
    if (r.ok) load();
    else setInstallError((r.data && r.data.error) || r.error || `Could not install ${entry.name}.`);
  };

  return (
    <div className="fade">
      <button
        onClick={onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          color: 'var(--text-2)',
          cursor: 'pointer',
          fontSize: 13.5,
          fontWeight: 600,
          marginBottom: 16,
          padding: 0,
        }}
      >
        <window.Icon name="back" size={16} /> Installed modules
      </button>

      <window.SectionTitle sub="Modules published to the Modulus registry. Each shows exactly what it can access before you install it.">
        Marketplace
      </window.SectionTitle>

      {installError && <ErrorNote text={installError} />}
      {error && <ErrorNote text={error} onRetry={load} />}

      {mods === null && !error && (
        <p style={{ fontSize: 13.5, color: 'var(--text-3)' }}>Loading the marketplace…</p>
      )}

      {mods !== null && mods.length === 0 && !error && (
        <div
          style={{
            textAlign: 'center',
            padding: '50px 20px',
            border: '1px dashed var(--border-2)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-3)',
          }}
        >
          <window.Icon name="plug" size={28} style={{ margin: '0 auto 10px' }} />
          <p style={{ fontSize: 14, color: 'var(--text-2)', fontWeight: 600 }}>
            No modules published yet
          </p>
          <p style={{ fontSize: 13, marginTop: 3 }}>
            The registry is empty right now — check back soon.
          </p>
        </div>
      )}

      {mods !== null && mods.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
            gap: 'calc(16px * var(--gap))',
          }}
        >
          {mods.map((m) => (
            <MarketCard
              key={m.name}
              entry={m}
              busy={busy === m.name}
              onInstall={() => setConsent(m)}
            />
          ))}
        </div>
      )}

      <ConsentModal
        entry={consent}
        busy={!!busy}
        onCancel={() => setConsent(null)}
        onConfirm={() => consent && install(consent)}
      />
    </div>
  );
}

function MarketCard({ entry, busy, onInstall }) {
  const name = { name: entry.name }; // ModuleGlyph/prettyName take an object with .name
  const action = entry.updateAvailable ? 'Update' : entry.installed ? 'Installed' : 'Install';
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        padding: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <ModuleGlyph mod={name} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15.5 }}>
            {entry.displayName || prettyName(name)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            v{entry.version}
            {entry.installed && entry.installedVersion
              ? ` · installed v${entry.installedVersion}`
              : ''}
          </div>
        </div>
      </div>
      <p
        style={{
          fontSize: 13.5,
          color: 'var(--text-2)',
          lineHeight: 1.5,
          marginBottom: 14,
          minHeight: 40,
        }}
      >
        {entry.description || 'No description provided.'}
      </p>
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: '.05em',
            marginBottom: 6,
          }}
        >
          Declared access
        </div>
        <ul
          style={{
            margin: 0,
            paddingLeft: 16,
            fontSize: 12.5,
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          {(entry.permissions || ['Needs no special permissions']).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
        {entry.installed && !entry.updateAvailable ? (
          <window.Badge tone="ok">
            <window.Icon name="check" size={11} /> Installed
          </window.Badge>
        ) : (
          <window.Button
            size="sm"
            variant={entry.updateAvailable ? 'default' : 'primary'}
            icon={busy ? undefined : 'plus'}
            onClick={onInstall}
            disabled={busy}
          >
            {busy ? (
              <>
                <window.Icon name="refresh" size={14} className="spin" /> Installing…
              </>
            ) : (
              action
            )}
          </window.Button>
        )}
      </div>
    </div>
  );
}

function ConsentModal({ entry, busy, onCancel, onConfirm }) {
  if (!entry) return null;
  const perms = entry.permissions || [];
  const noPerms = perms.length === 0 || (perms.length === 1 && /^Needs no special/.test(perms[0]));
  return (
    <window.Modal
      open={!!entry}
      onClose={busy ? () => {} : onCancel}
      width={520}
      title={`Install ${entry.displayName || prettyName({ name: entry.name })}?`}
      footer={
        <>
          <window.Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon={busy ? undefined : 'check'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <>
                <window.Icon name="refresh" size={16} className="spin" /> Installing…
              </>
            ) : (
              'Install'
            )}
          </window.Button>
        </>
      }
    >
      <p style={{ fontSize: 13.5, color: 'var(--text-2)', marginBottom: 12 }}>
        This downloads <span className="mono">{entry.name}</span> v{entry.version} from the
        registry, verifies it, and loads it into Modulus. By installing you grant it:
      </p>
      {noPerms ? (
        <p style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
          <window.Icon name="shield" size={14} style={{ verticalAlign: 'middle' }} /> Needs no
          special access.
        </p>
      ) : (
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            fontSize: 13.5,
            color: 'var(--text)',
            lineHeight: 1.6,
          }}
        >
          {perms.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </window.Modal>
  );
}

Object.assign(window, { ModulesTab, AuthFlowModal });
