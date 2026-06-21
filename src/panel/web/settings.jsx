// Settings tab — Modulus Core config in friendly forms (GET/POST /api/config).
// Values that are pinned by an environment variable show a "set by environment"
// lock and are read-only here, mirroring how effectiveConfig() lets env vars
// win over the on-disk config.json. Changes are staged locally and written with
// one Save; a model change applies live (the daemon re-points its LLM profiles),
// while the rest take effect on the next agent restart.
const { useState: useStateSet, useEffect: useEffectSet } = React;
const FRONTEND_EXT_NAME = 'modulus-frontend';

function SettingsTab({ onReRunWizard, onSaved }) {
  const [cfg, setCfg] = useStateSet(null);
  const [error, setError] = useStateSet(null);
  const [dirty, setDirty] = useStateSet(false);
  const [saving, setSaving] = useStateSet(false);
  const [saved, setSaved] = useStateSet(false);
  const [models, setModels] = useStateSet([]);
  // Everyday users only need Telegram + models; the rest folds away so the page
  // isn't a wall of knobs on first open.
  const [showAdvanced, setShowAdvanced] = useStateSet(false);

  const load = async () => {
    const r = await window.api.get('/api/config');
    if (r.ok) {
      setCfg(r.data);
      setError(null);
    } else setError(r.error || 'Could not load settings.');
    const m = await window.api.get('/api/models');
    if (m.ok && m.data && Array.isArray(m.data.models)) setModels(m.data.models);
  };
  useEffectSet(() => {
    load();
  }, []);

  const set = (patch) => {
    setCfg((c) => ({ ...c, ...patch }));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      allowlist: cfg.allowlist,
      ollamaUrl: cfg.ollamaUrl,
      panelBind: cfg.panelBind,
      chatModel: cfg.chatModel,
      reasoningModel: cfg.reasoningModel,
      toolsModel: cfg.toolsModel,
      tier: cfg.tier,
      logLevel: cfg.logLevel,
      instantResponses: cfg.instantResponses,
      memoryExtraction: cfg.memoryExtraction,
      memoryDreaming: cfg.memoryDreaming,
    };
    // Only send a new token if the user typed a real one (not the mask).
    if (cfg.newToken && !cfg.newToken.includes('•')) body.token = cfg.newToken;
    const r = await window.api.post('/api/config', body);
    setSaving(false);
    if (r.ok) {
      setDirty(false);
      setSaved(true);
      onSaved && onSaved();
      load();
    } else setError(r.error || 'Could not save settings.');
  };

  if (!cfg && !error) return <window.SectionTitle>Settings</window.SectionTitle>;
  if (!cfg)
    return (
      <div>
        <window.SectionTitle>Settings</window.SectionTitle>
        <ErrorNote text={error} onRetry={load} />
      </div>
    );

  const locks = cfg.envLocks || {};

  return (
    <div>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <window.SectionTitle
          sub="Everything in Modulus Core's config, in plain language. Model changes apply right away; other settings take effect on the next restart."
          right={
            <window.Button
              variant="primary"
              icon={saving ? undefined : 'check'}
              onClick={save}
              disabled={!dirty || saving}
              style={{ opacity: !dirty || saving ? 0.55 : 1 }}
            >
              {saving ? (
                <>
                  <window.Icon name="refresh" size={16} className="spin" /> Saving…
                </>
              ) : saved ? (
                <>
                  <window.Icon name="check" size={16} /> Saved
                </>
              ) : (
                'Save changes'
              )}
            </window.Button>
          }
        >
          Settings
        </window.SectionTitle>
        {error && <ErrorNote text={error} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'calc(16px * var(--gap))' }}>
          <TelegramSection cfg={cfg} set={set} locks={locks} />
          <ModelServerSection
            cfg={cfg}
            set={set}
            locks={locks}
            models={models}
            setModels={setModels}
          />
          <ModelsSection
            cfg={cfg}
            set={set}
            locks={locks}
            models={models}
            onReRun={onReRunWizard}
          />
          <UpdatesSection />
          <button
            onClick={() => setShowAdvanced((s) => !s)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              alignSelf: 'flex-start',
              background: 'none',
              border: 'none',
              color: 'var(--text-2)',
              fontSize: 13.5,
              fontWeight: 600,
              cursor: 'pointer',
              padding: '4px 0',
            }}
          >
            <window.Icon
              name="fwd"
              size={14}
              style={{ transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}
            />
            {showAdvanced ? 'Hide advanced settings' : 'Advanced settings'}
          </button>
          {showAdvanced && (
            <>
              <HardwareSection cfg={cfg} set={set} locks={locks} />
              <NetworkSection cfg={cfg} set={set} locks={locks} />
              <BehaviourSection cfg={cfg} set={set} />
              <LoggingSection cfg={cfg} set={set} locks={locks} />
              <MemoryBrowserSection />
              <FrontendSection onSaved={onSaved} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// One-click update + version status. Talks to /api/maintenance/version (cached
// availability check) and applies via /api/maintenance/update (git: pull +
// rebuild + auto-restart) or /api/maintenance/desktop-update/apply (desktop:
// the shell already downloaded the release; this just restarts into it).
function UpdatesSection() {
  const [status, setStatus] = useStateSet(null);
  const [checking, setChecking] = useStateSet(false);
  const [busy, setBusy] = useStateSet(false);
  const [note, setNote] = useStateSet(null);

  const check = async (force) => {
    setChecking(true);
    const r = await window.api.get('/api/maintenance/version' + (force ? '?force=1' : ''));
    setChecking(false);
    if (r.ok && r.data) setStatus(r.data);
  };
  useEffectSet(() => {
    check(false);
  }, []);

  const apply = async () => {
    if (!status) return;
    setBusy(true);
    setNote(null);
    try {
      if (status.channel === 'desktop') {
        const r = await window.api.post('/api/maintenance/desktop-update/apply');
        setNote(
          r.ok
            ? 'Restarting the app to apply the update…'
            : (r.data && r.data.error) || r.error || 'Could not apply the update.',
        );
      } else {
        const r = await window.api.post('/api/maintenance/update');
        const out = (r && r.data) || {};
        if (out.ok) {
          setNote(out.restarting ? 'Updated — restarting to apply…' : 'Updated. Restart to apply.');
          setTimeout(() => check(true), 9000);
        } else {
          setNote('Update failed:\n' + (out.output || (r && r.error) || 'unknown error'));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const avail = !!(status && status.updateAvailable === true);
  const upToDate = !!(status && status.updateAvailable === false);
  const desktop = !!(status && status.channel === 'desktop');
  const pill = avail
    ? { text: 'Update available', bg: 'var(--warn, #f59e0b)' }
    : upToDate
      ? { text: 'Up to date', bg: 'var(--ok, #22c55e)' }
      : { text: 'Unknown', bg: 'var(--text-3)' };

  return (
    <window.Card style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <window.Icon
        name="download"
        size={22}
        style={{ color: avail ? 'var(--warn, #f59e0b)' : 'var(--text-3)' }}
      />
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 15.5 }}>Updates</span>
          {status && (
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                color: '#0b0b0b',
                background: pill.bg,
                borderRadius: 999,
                padding: '2px 8px',
              }}
            >
              {pill.text}
            </span>
          )}
        </div>
        <p
          style={{
            fontSize: 13,
            color: 'var(--text-3)',
            marginTop: 4,
            whiteSpace: 'pre-line',
            lineHeight: 1.5,
          }}
        >
          {note || (status ? status.detail : 'Checking for updates…')}
          {status && status.current ? ` · Current ${status.current}` : ''}
          {status && status.latest && avail ? ` · Latest ${status.latest}` : ''}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <window.Button variant="subtle" size="sm" onClick={() => check(true)} disabled={checking || busy}>
          {checking ? (
            <>
              <window.Icon name="refresh" size={14} className="spin" /> Checking…
            </>
          ) : (
            'Check now'
          )}
        </window.Button>
        {avail && (
          <window.Button variant="primary" onClick={apply} disabled={busy}>
            {busy ? (
              <>
                <window.Icon name="refresh" size={16} className="spin" />{' '}
                {desktop ? 'Restarting…' : 'Updating…'}
              </>
            ) : desktop ? (
              'Restart to apply'
            ) : (
              'Update now'
            )}
          </window.Button>
        )}
      </div>
    </window.Card>
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

function Group({ title, desc, children, icon }) {
  return (
    <window.Card pad={0}>
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 11,
        }}
      >
        <window.Icon name={icon} size={18} style={{ color: 'var(--text-3)' }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: 15.5 }}>{title}</div>
          {desc && (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 1 }}>{desc}</div>
          )}
        </div>
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {children}
      </div>
    </window.Card>
  );
}

function EnvLock() {
  return (
    <window.Badge tone="neutral" style={{ fontSize: 10.5 }}>
      <window.Icon name="lock" size={11} /> set by environment
    </window.Badge>
  );
}

function TelegramSection({ cfg, set, locks }) {
  const [state, setState] = useStateSet('idle'); // idle | checking | ok | err
  const [result, setResult] = useStateSet(null);
  const [draft, setDraft] = useStateSet('');
  const tokenLocked = !!locks.token;

  const revalidate = async () => {
    const token = cfg.newToken && !cfg.newToken.includes('•') ? cfg.newToken : '';
    if (!token) {
      setState('err');
      setResult({ error: 'Enter a new token to validate (the stored one is masked).' });
      return;
    }
    setState('checking');
    const r = await window.api.post('/api/telegram/validate', { token });
    if (r.ok && r.data.ok) {
      setState('ok');
      setResult(r.data);
    } else {
      setState('err');
      setResult({ error: (r.data && r.data.error) || r.error || 'Validation failed.' });
    }
  };
  const addUser = () => {
    const v = draft.trim();
    if (/^\d{4,}$/.test(v) && !cfg.allowlist.includes(v)) {
      set({ allowlist: [...cfg.allowlist, v] });
      setDraft('');
    }
  };
  return (
    <Group icon="send" title="Telegram" desc="The chat app where you talk to your bot.">
      <div>
        <window.Label
          hint={
            tokenLocked
              ? 'Pinned by the TELEGRAM_BOT_TOKEN environment variable.'
              : 'The secret token from @BotFather that lets Modulus act as your bot. The stored value is masked — paste a new one to change it.'
          }
        >
          Bot token {tokenLocked && <EnvLock />}
        </window.Label>
        {tokenLocked ? (
          <window.Input mono value={cfg.token} disabled style={{ opacity: 0.7 }} />
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <window.SecretInput
                value={cfg.newToken !== undefined ? cfg.newToken : cfg.token}
                onChange={(e) => {
                  set({ newToken: e.target.value });
                  setState('idle');
                }}
                placeholder="1234567890:AAH…"
              />
            </div>
            <window.Button variant="subtle" onClick={revalidate} disabled={state === 'checking'}>
              {state === 'checking' ? (
                <>
                  <window.Icon name="refresh" size={15} className="spin" /> Checking
                </>
              ) : (
                'Validate'
              )}
            </window.Button>
          </div>
        )}
        {state === 'ok' && result && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              marginTop: 9,
              fontSize: 13,
              color: 'var(--ok)',
            }}
          >
            <window.Icon name="check" size={15} /> Valid — connected as <b>{result.botName}</b>{' '}
            {result.botUser}
          </div>
        )}
        {state === 'err' && result && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              marginTop: 9,
              fontSize: 13,
              color: 'var(--err)',
            }}
          >
            <window.Icon name="alert" size={15} /> {result.error}
          </div>
        )}
      </div>
      <div>
        <window.Label hint="Only these Telegram user IDs can talk to your bot. Everyone else is ignored.">
          Allowlist {locks.allowlist && <EnvLock />}
        </window.Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {cfg.allowlist.map((id) => (
            <span
              key={id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 8px 6px 12px',
                borderRadius: 99,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-2)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
              }}
            >
              {id}
              {!locks.allowlist && (
                <button
                  onClick={() => set({ allowlist: cfg.allowlist.filter((x) => x !== id) })}
                  aria-label={`Remove ${id}`}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 99,
                    border: 'none',
                    background: 'var(--border)',
                    color: 'var(--text-2)',
                    cursor: 'pointer',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  <window.Icon name="x" size={12} />
                </button>
              )}
            </span>
          ))}
          {cfg.allowlist.length === 0 && (
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
              No one can talk to the bot yet — add at least one ID.
            </span>
          )}
        </div>
        {!locks.allowlist && (
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, maxWidth: 280 }}>
              <window.Input
                mono
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addUser()}
                placeholder="e.g. 8675309"
              />
            </div>
            <window.Button variant="default" icon="plus" onClick={addUser}>
              Add ID
            </window.Button>
          </div>
        )}
      </div>
    </Group>
  );
}

function ModelServerSection({ cfg, set, locks, setModels }) {
  const [state, setState] = useStateSet('idle');
  const [count, setCount] = useStateSet(0);
  const [err, setErr] = useStateSet(null);
  const locked = !!locks.ollamaUrl;
  const test = async () => {
    setState('testing');
    setErr(null);
    const r = await window.api.post('/api/ollama/test', { url: cfg.ollamaUrl });
    if (r.ok && r.data.ok) {
      setState('ok');
      setCount(r.data.models.length);
      setModels(r.data.models);
    } else {
      setState('err');
      setErr((r.data && r.data.error) || r.error || 'Unreachable.');
    }
  };
  return (
    <Group
      icon="terminal"
      title="Model server (Ollama)"
      desc="The local program that runs the AI models on this machine."
    >
      <div>
        <window.Label hint="Where Ollama is listening. The default is fine for most setups.">
          Ollama URL {locked && <EnvLock />}
        </window.Label>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <window.Input
              mono
              value={cfg.ollamaUrl}
              disabled={locked}
              onChange={(e) => {
                set({ ollamaUrl: e.target.value });
                setState('idle');
              }}
              style={locked ? { opacity: 0.7 } : {}}
            />
          </div>
          <window.Button variant="subtle" onClick={test} disabled={state === 'testing'}>
            {state === 'testing' ? (
              <>
                <window.Icon name="refresh" size={15} className="spin" /> Testing
              </>
            ) : (
              'Test connection'
            )}
          </window.Button>
        </div>
        {state === 'ok' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              marginTop: 9,
              fontSize: 13,
              color: 'var(--ok)',
            }}
          >
            <window.Icon name="check" size={15} /> Reachable — {count} model{count === 1 ? '' : 's'}{' '}
            detected
          </div>
        )}
        {state === 'err' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              marginTop: 9,
              fontSize: 13,
              color: 'var(--err)',
            }}
          >
            <window.Icon name="alert" size={15} /> {err}
          </div>
        )}
      </div>
    </Group>
  );
}

function ModelsSection({ cfg, set, locks, models, onReRun }) {
  const tags = models && models.length ? models : (window.FALLBACK_MODELS || []).map((m) => m.tag);
  const ensure = (val) => (val && !tags.includes(val) ? [val, ...tags] : tags);
  const slots = [
    {
      key: 'chatModel',
      label: 'Chat',
      hint: 'Fast model for everyday conversation. The default.',
      lock: locks.chatModel,
    },
    {
      key: 'reasoningModel',
      label: 'Reasoning',
      hint: 'Bigger model for hard problems. Optional.',
      lock: locks.reasonModel,
      skip: 'Skip — my hardware is small',
    },
    {
      key: 'toolsModel',
      label: 'Tools',
      hint: 'Model used when calling tools. Falls back to Chat.',
      lock: locks.toolsModel,
      skip: 'Use my Chat model',
    },
  ];
  return (
    <Group
      icon="spark"
      title="Models"
      desc="Modulus uses up to three model “slots”. Saving a change applies it on the next message."
    >
      {slots.map((s) => (
        <div key={s.key}>
          <window.Label hint={s.hint}>
            {s.label} model {s.lock && <EnvLock />}
          </window.Label>
          <window.Select
            value={cfg[s.key] || ''}
            onChange={(e) => set({ [s.key]: e.target.value })}
            style={{ maxWidth: 360, opacity: s.lock ? 0.7 : 1 }}
          >
            {s.skip && <option value="">{s.skip}</option>}
            {ensure(cfg[s.key]).map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </window.Select>
        </div>
      ))}
      <div>
        <window.Button variant="ghost" size="sm" icon="refresh" onClick={onReRun}>
          Re-run setup wizard
        </window.Button>
      </div>
    </Group>
  );
}

function HardwareSection({ cfg, set, locks }) {
  return (
    <Group icon="shield" title="Hardware tier" desc="A hint about how powerful this machine is.">
      <div>
        <window.Label hint="Auto-suggested from your RAM. Override if you know better.">
          Tier {locks.tier && <EnvLock />}
        </window.Label>
        <window.Segmented
          value={cfg.tier}
          onChange={(v) => !locks.tier && set({ tier: v })}
          options={['small', 'standard', 'heavy']}
        />
      </div>
    </Group>
  );
}

function LoggingSection({ cfg, set, locks }) {
  const locked = !!locks.logLevel;
  return (
    <Group icon="doc" title="Logging" desc="How much detail Modulus writes to its logs.">
      <div>
        <window.Label hint="“info” is a good default. Use “debug” when troubleshooting.">
          Logging level {locked && <EnvLock />}
        </window.Label>
        <window.Segmented
          value={cfg.logLevel}
          onChange={(v) => !locked && set({ logLevel: v })}
          options={['debug', 'info', 'warn', 'error']}
        />
        {locked && (
          <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 9 }}>
            This value is currently set by the <span className="mono">MODULUS_LOG_LEVEL</span>{' '}
            environment variable and can’t be changed here.
          </p>
        )}
      </div>
    </Group>
  );
}

// A lightweight "Learn more" disclosure for the mechanism detail behind a
// plain-language setting — keeps the everyday hint short while leaving the full
// story one click away. Native <details> mirrors the ThinkingBlock pattern.
function MoreInfo({ children }) {
  return (
    <details style={{ marginTop: 6 }}>
      <summary
        style={{
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--text-3)',
          userSelect: 'none',
          width: 'fit-content',
        }}
      >
        Learn more
      </summary>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 6 }}>
        {children}
      </p>
    </details>
  );
}

function NetworkSection({ cfg, set, locks }) {
  // panelBind is '127.0.0.1' (loopback) or '0.0.0.0' (LAN). The toggle flips
  // between the two; the GET defaults it to loopback. Takes effect on the next
  // restart, so the panel rebinds to the new address.
  const locked = !!locks.panelBind;
  const lan = cfg.panelBind === '0.0.0.0';
  return (
    <Group
      icon="plug"
      title="Network access"
      desc="Whether other devices on your network can reach this Modulus."
    >
      <div>
        <window.Label
          hint={
            locked
              ? 'Pinned by the MODULUS_PANEL_BIND environment variable.'
              : 'Off keeps Modulus to this machine only. On lets the desktop app or a browser on another device connect — useful for an always-on mini PC.'
          }
        >
          Let other devices connect {locked && <EnvLock />}
        </window.Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <window.Toggle
            checked={lan}
            onChange={(v) => !locked && set({ panelBind: v ? '0.0.0.0' : '127.0.0.1' })}
            disabled={locked}
            label="Let other devices connect"
          />
          <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{lan ? 'On' : 'Off'}</span>
        </div>
        <MoreInfo>
          {lan
            ? 'Modulus is reachable on your local network. Anyone with the secret link can control it — keep it private. The link to paste into the desktop app is shown on the System tab and in the log. Takes effect after the next restart.'
            : 'Modulus only answers requests from this machine. Takes effect after the next restart.'}
        </MoreInfo>
      </div>
    </Group>
  );
}

function BehaviourSection({ cfg, set }) {
  // cfg.instantResponses arrives from /api/config as a plain boolean and is
  // saved back through the shared config save() with the other fields. The two
  // memory toggles work the same way; both take effect on the next restart.
  const on = cfg.instantResponses !== false;
  const extraction = cfg.memoryExtraction !== false;
  const dreaming = cfg.memoryDreaming !== false;
  return (
    <Group
      icon="spark"
      title="Behaviour"
      desc="How Modulus replies, learns, and tidies its memory."
    >
      <div>
        <window.Label hint="When a reply will take a moment, Modulus says it’s working right away, then sends the full answer once it’s ready.">
          Instant responses
        </window.Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <window.Toggle
            checked={on}
            onChange={(v) => set({ instantResponses: v })}
            label="Instant responses"
          />
          <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{on ? 'On' : 'Off'}</span>
        </div>
        <MoreInfo>
          The acknowledgement uses no extra model call. It mostly shows up when a reply needs
          deeper reasoning or several steps to put together.
        </MoreInfo>
      </div>
      <div>
        <window.Label hint="Modulus quietly remembers a few useful facts about you — names, preferences, recurring details — so you don’t have to repeat yourself.">
          Memory extraction
        </window.Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <window.Toggle
            checked={extraction}
            onChange={(v) => set({ memoryExtraction: v })}
            label="Memory extraction"
          />
          <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
            {extraction ? 'On' : 'Off'}
          </span>
        </div>
        <MoreInfo>
          Notes 0–2 facts per chat. It runs on the small model after your reply has been sent —
          never on the reply itself — and is off by default on small hardware. Takes effect after
          the next restart.
        </MoreInfo>
      </div>
      <div>
        <window.Label hint="Each night Modulus tidies its memory — keeping what keeps proving useful and forgetting what doesn’t.">
          Memory dreaming
        </window.Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <window.Toggle
            checked={dreaming}
            onChange={(v) => set({ memoryDreaming: v })}
            label="Memory dreaming"
          />
          <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{dreaming ? 'On' : 'Off'}</span>
        </div>
        <MoreInfo>
          A fixed housekeeping pass with no model call. Takes effect after the next restart.
        </MoreInfo>
      </div>
    </Group>
  );
}

// Browse the hive-mind memory the main chat and every agent share: list newest
// first, full-text search (GET /api/memory?q=), and forget a row (DELETE
// /api/memory/:id). Self-loading, independent of the config save flow.
function MemoryBrowserSection() {
  const [memories, setMemories] = useStateSet(null);
  const [total, setTotal] = useStateSet(0);
  const [query, setQuery] = useStateSet('');
  // Scope filter: '' = the whole store, else an agent id (string) showing just
  // that agent's private namespace.
  const [scope, setScope] = useStateSet('');
  const [agents, setAgents] = useStateSet([]);
  const [error, setError] = useStateSet(null);
  const [busy, setBusy] = useStateSet(false);

  const load = async (q, sc) => {
    setBusy(true);
    const scopeVal = sc !== undefined ? sc : scope;
    const params = new URLSearchParams();
    const trimmed = (q || '').trim();
    if (trimmed) params.set('q', trimmed);
    if (scopeVal) params.set('agentId', scopeVal);
    const qs = params.toString();
    const r = await window.api.get(qs ? `/api/memory?${qs}` : '/api/memory');
    setBusy(false);
    if (r.ok && r.data) {
      setMemories(Array.isArray(r.data.memories) ? r.data.memories : []);
      setTotal(typeof r.data.total === 'number' ? r.data.total : 0);
      setError(null);
    } else setError((r.data && r.data.error) || r.error || 'Could not load memories.');
  };

  useEffectSet(() => {
    load('');
    window.api.get('/api/agents').then((r) => {
      if (r.ok && r.data && Array.isArray(r.data.agents)) setAgents(r.data.agents);
    });
  }, []);

  const agentName = (id) => {
    const a = agents.find((x) => x.id === id);
    return a ? a.name : `agent ${id}`;
  };

  const onScope = (v) => {
    setScope(v);
    load(query, v);
  };

  const remove = async (id) => {
    const r = await window.api.del(`/api/memory/${id}`);
    if (r.ok) {
      setMemories((m) => (m ? m.filter((x) => x.id !== id) : m));
      setTotal((t) => (query.trim() ? t : Math.max(0, t - 1)));
    } else setError((r.data && r.data.error) || r.error || 'Could not delete that memory.');
  };

  const clearSearch = () => {
    setQuery('');
    load('', scope);
  };

  return (
    <div>
      <window.SectionTitle sub="Everything Modulus has remembered. The shared store is the hive mind — facts the main chat and every agent recall. Each agent also keeps a private namespace for its own findings; pick a scope to see it. Search to filter; delete to forget.">
        Hive memory
      </window.SectionTitle>
      {error && <ErrorNote text={error} onRetry={() => load(query)} />}
      <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <window.Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load(query)}
              placeholder="Search memories…"
            />
          </div>
          {agents.length > 0 && (
            <window.Select value={scope} onChange={(e) => onScope(e.target.value)}>
              <option value="">All memory</option>
              {agents.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.name}’s memory
                </option>
              ))}
            </window.Select>
          )}
          <window.Button variant="subtle" icon="search" onClick={() => load(query)} disabled={busy}>
            {busy ? 'Searching' : 'Search'}
          </window.Button>
          {query && (
            <window.Button variant="ghost" icon="x" onClick={clearSearch}>
              Clear
            </window.Button>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {memories == null
            ? 'Loading…'
            : query.trim()
              ? `${memories.length} match${memories.length === 1 ? '' : 'es'}`
              : `${total} memor${total === 1 ? 'y' : 'ies'} stored`}
        </div>
        {memories && memories.length === 0 && (
          <div style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
            {query.trim() ? 'Nothing matches that search.' : 'No memories stored yet.'}
          </div>
        )}
        {memories &&
          memories.map((m) => (
            <div
              key={m.id}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
              }}
            >
              <window.Icon
                name="database"
                size={16}
                style={{ color: 'var(--text-3)', marginTop: 3, flex: '0 0 auto' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    color: 'var(--text-1)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.content}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <window.Badge tone="neutral" style={{ fontSize: 10.5 }}>
                    {m.source}
                  </window.Badge>
                  {m.agentId != null ? (
                    <window.Badge tone="accent" style={{ fontSize: 10.5 }}>
                      {agentName(m.agentId)}
                    </window.Badge>
                  ) : (
                    <window.Badge tone="neutral" style={{ fontSize: 10.5 }}>
                      shared
                    </window.Badge>
                  )}
                  {m.scope && m.scope !== 'global' && (
                    <window.Badge tone="neutral" style={{ fontSize: 10.5 }}>
                      {m.scope}
                    </window.Badge>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    importance {m.importance}
                  </span>
                  {m.uses > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>used {m.uses}×</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => remove(m.id)}
                aria-label="Delete memory"
                title="Forget this"
                style={{
                  flex: '0 0 auto',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: '1px solid var(--border-2)',
                  background: 'var(--surface-2)',
                  color: 'var(--text-3)',
                  cursor: 'pointer',
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <window.Icon name="trash" size={14} />
              </button>
            </div>
          ))}
      </window.Card>
    </div>
  );
}

function FrontendSection({ onSaved }) {
  const [fields, setFields] = useStateSet(null);
  const [error, setError] = useStateSet(null);
  const [dirty, setDirty] = useStateSet(false);
  const [saving, setSaving] = useStateSet(false);
  const [saved, setSaved] = useStateSet(false);

  const load = async () => {
    const r = await window.api.get(
      `/api/modules/${encodeURIComponent(FRONTEND_EXT_NAME)}/settings`,
    );
    if (r.ok && r.data && Array.isArray(r.data.schema)) {
      setFields(r.data.schema);
      setError(null);
      setDirty(false);
    } else {
      setError((r.data && r.data.error) || r.error || 'Could not load frontend settings.');
    }
  };

  useEffectSet(() => {
    load();
  }, []);

  const set = (key, value) => {
    setFields((current) =>
      current.map((field) => (field.key === key ? { ...field, value } : field)),
    );
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    if (!fields) return;
    setSaving(true);
    setError(null);
    const body = Object.fromEntries(fields.map((field) => [field.key, field.value]));
    const r = await window.api.post(
      `/api/modules/${encodeURIComponent(FRONTEND_EXT_NAME)}/settings`,
      body,
    );
    setSaving(false);
    if (r.ok) {
      setDirty(false);
      setSaved(true);
      onSaved && onSaved();
      load();
    } else setError(r.error || 'Could not save frontend settings.');
  };

  return (
    <div>
      <window.SectionTitle
        sub="The panel itself: listener, auth token, HTTPS, and the proactive toggle. Restart the panel after changing host, port, or TLS settings."
        right={
          fields ? (
            <window.Button
              variant="primary"
              icon={saving ? undefined : 'check'}
              onClick={save}
              disabled={!dirty || saving}
              style={{ opacity: !dirty || saving ? 0.55 : 1 }}
            >
              {saving ? (
                <>
                  <window.Icon name="refresh" size={16} className="spin" /> Savingâ€¦
                </>
              ) : saved ? (
                <>
                  <window.Icon name="check" size={16} /> Saved
                </>
              ) : (
                'Save panel settings'
              )}
            </window.Button>
          ) : null
        }
      >
        Frontend
      </window.SectionTitle>
      {error && <ErrorNote text={error} onRetry={load} />}
      {!fields ? (
        <window.Card style={{ color: 'var(--text-3)', fontSize: 13.5 }}>
          Loading frontend settings…
        </window.Card>
      ) : (
        <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {fields.map((field) => (
            <div key={field.key}>
              <window.Label hint={field.help}>
                {field.label} {field.required && <span style={{ color: 'var(--err)' }}>*</span>}{' '}
                {field.type === 'secret' && (
                  <window.Icon
                    name="lock"
                    size={12}
                    style={{ display: 'inline', verticalAlign: 'middle', color: 'var(--text-3)' }}
                  />
                )}
              </window.Label>
              {field.type === 'boolean' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <window.Toggle
                    checked={!!field.value}
                    onChange={(v) => set(field.key, v)}
                    label={field.label}
                  />
                  <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
                    {field.value ? 'On' : 'Off'}
                  </span>
                </div>
              ) : field.type === 'secret' ? (
                <window.SecretInput
                  value={field.value || ''}
                  onChange={(e) => set(field.key, e.target.value)}
                  placeholder="Not set"
                />
              ) : field.type === 'number' ? (
                <window.Input
                  type="number"
                  mono
                  value={field.value}
                  onChange={(e) => set(field.key, e.target.value)}
                  style={{ maxWidth: 180 }}
                />
              ) : (
                <window.Input
                  mono
                  value={field.value || ''}
                  onChange={(e) => set(field.key, e.target.value)}
                  placeholder="Not set"
                />
              )}
            </div>
          ))}
        </window.Card>
      )}
    </div>
  );
}

Object.assign(window, { SettingsTab });
