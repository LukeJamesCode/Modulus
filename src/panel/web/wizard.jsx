// First-run setup wizard. Mirrors `modulus init` but friendly, and writes the
// same config.json the CLI does. Live checks hit real endpoints:
//   ollama  → POST /api/ollama/test, GET pull-stream (SSE) to download a model
//   token   → POST /api/telegram/validate
//   pairing → POST /api/telegram/pair, GET /api/telegram/pair/status (poll)
//   finish  → POST /api/config (+ POST /api/setup/complete in setup mode)
//
// In setup mode the daemon is stubbed and pinned to this wizard; "Start Modulus"
// posts /api/setup/complete, which promotes to the full daemon. The app's own
// /api/state poll flips setupMode→false and renders the hub once promotion lands.
const { useState: useStateWiz, useEffect: useEffectWiz, useRef: useRefWiz } = React;

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'ollama', label: 'Model server' },
  { id: 'telegram', label: 'Connect Telegram' },
  { id: 'modules', label: 'Modules' },
  { id: 'module-config', label: 'Configure modules' },
  { id: 'finish', label: 'Finish' },
];

function Wizard({
  onFinish,
  onExit,
  suggestedTier,
  ramGb,
  setupMode,
  setupError,
  modelRecommendations,
}) {
  const [step, setStep] = useStateWiz(0);
  const [saving, setSaving] = useStateWiz(false);
  const [configSaving, setConfigSaving] = useStateWiz(false);
  const [saveErr, setSaveErr] = useStateWiz(null);
  const [starting, setStarting] = useStateWiz(false);
  const moduleConfigSaveRef = useRefWiz(null);
  const [models, setModels] = useStateWiz([]);
  const [data, setData] = useStateWiz({
    ollamaUrl: 'http://localhost:11434',
    ollamaState: 'idle',
    ollamaErr: '',
    ollamaErrKind: '',
    tier: suggestedTier || 'standard',
    chatModel: '',
    reasoningModel: '',
    toolsModel: '',
    token: '',
    botName: '',
    botUser: '',
    tokenState: 'idle',
    tokenErr: '',
    allowlist: [],
    names: {},
  });
  const set = (patch) => setData((d) => ({ ...d, ...patch }));

  // Only the model step can block forward progress (see `gated`). Telegram is
  // optional, so it isn't gated here.
  const canNext = () => {
    switch (STEPS[step].id) {
      case 'ollama':
        return data.ollamaState === 'ok' && !!data.chatModel;
      default:
        return true;
    }
  };

  const finish = async () => {
    setSaving(true);
    setSaveErr(null);
    // Telegram is optional. Only persist it when it's fully connected (validated
    // token AND at least one paired person); otherwise save it empty so a
    // half-typed token never blocks promotion — the install runs panel-only.
    const useTelegram = data.tokenState === 'ok' && data.allowlist.length > 0;
    const body = {
      token: useTelegram ? data.token : '',
      allowlist: useTelegram ? data.allowlist : [],
      ollamaUrl: data.ollamaUrl,
      chatModel: data.chatModel,
      reasoningModel: data.reasoningModel,
      toolsModel: data.toolsModel,
      tier: data.tier,
    };
    const r = await window.api.post('/api/config', body);
    if (!r.ok) {
      setSaving(false);
      setSaveErr(r.error || 'Could not save your setup.');
      return;
    }
    if (setupMode) {
      const c = await window.api.post('/api/setup/complete');
      setSaving(false);
      if (!c.ok) {
        setSaveErr((c.data && c.data.error) || c.error || 'Could not start Modulus.');
        return;
      }
      // Promotion is underway; show the starting screen. The app's /api/state
      // poll flips setupMode→false and renders the hub when the daemon is live.
      setStarting(true);
    } else {
      setSaving(false);
      onFinish();
    }
  };

  const retryComplete = async () => {
    await window.api.post('/api/setup/complete');
  };

  const next = async () => {
    if (cur === 'module-config') {
      if (moduleConfigSaveRef.current) {
        setConfigSaving(true);
        const ok = await moduleConfigSaveRef.current();
        setConfigSaving(false);
        if (!ok) return;
      }
      setStep(step + 1);
      return;
    }
    if (step < STEPS.length - 1) setStep(step + 1);
    else finish();
  };
  const back = () => step > 0 && setStep(step - 1);
  const cur = STEPS[step].id;

  if (starting) {
    return <StartingScreen setupError={setupError} onRetry={retryComplete} />;
  }

  // Only the model step blocks forward progress; Telegram is optional, so its
  // step always lets you continue (a fully-paired bot is saved; anything else
  // runs panel-only).
  const gated = ['ollama'];
  const blockedLabel = 'Set up a model';

  return (
    <div style={{ height: '100%', display: 'flex', background: 'var(--bg)', overflow: 'hidden' }}>
      <aside
        style={{
          width: 290,
          flex: 'none',
          background: 'var(--bg-2)',
          borderRight: '1px solid var(--border)',
          padding: '26px 22px',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="wiz-rail"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 30 }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: 'var(--accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <span
              className="display"
              style={{ color: 'var(--on-accent)', fontWeight: 700, fontSize: 18 }}
            >
              g
            </span>
          </span>
          <div>
            <div className="display" style={{ fontSize: 16, fontWeight: 700 }}>
              Modulus
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>first-time setup</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          {STEPS.map((s, i) => {
            const done = i < step,
              active = i === step;
            return (
              <button
                key={s.id}
                onClick={() => i <= step && setStep(i)}
                disabled={i > step}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '9px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: active ? 'var(--surface)' : 'transparent',
                  cursor: i <= step ? 'pointer' : 'default',
                  textAlign: 'left',
                  boxShadow: active ? 'var(--shadow-sm)' : 'none',
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 99,
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    fontWeight: 700,
                    background: done
                      ? 'var(--accent)'
                      : active
                        ? 'var(--accent-soft)'
                        : 'var(--surface-2)',
                    color: done
                      ? 'var(--on-accent)'
                      : active
                        ? 'var(--accent-strong)'
                        : 'var(--text-3)',
                    border: active ? 'none' : '1px solid var(--border)',
                  }}
                >
                  {done ? <window.Icon name="check" size={13} /> : i + 1}
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: active ? 600 : 500,
                    color: active ? 'var(--text)' : done ? 'var(--text-2)' : 'var(--text-3)',
                  }}
                >
                  {s.label}
                </span>
              </button>
            );
          })}
        </div>
        {onExit && (
          <button
            onClick={onExit}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-3)',
              fontSize: 12.5,
              cursor: 'pointer',
              textAlign: 'left',
              padding: '8px 10px',
            }}
          >
            Skip setup — I’ll do it later →
          </button>
        )}
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '46px 0' }}>
          <div
            key={cur}
            className="rise"
            style={{ maxWidth: 600, margin: '0 auto', padding: '0 32px' }}
          >
            {cur === 'welcome' && <StepWelcome />}
            {cur === 'ollama' && (
              <StepOllama
                data={data}
                set={set}
                models={models}
                setModels={setModels}
                suggestedTier={suggestedTier}
                ramGb={ramGb}
                modelRecommendations={modelRecommendations}
              />
            )}
            {cur === 'telegram' && <StepTelegram data={data} set={set} />}
            {cur === 'modules' && <StepModules />}
            {cur === 'module-config' && <StepModuleConfig saveRef={moduleConfigSaveRef} />}
            {cur === 'finish' && <StepFinish data={data} goto={setStep} />}
          </div>
        </div>
        <div
          style={{
            flex: 'none',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-2)',
            padding: '16px 32px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          {saveErr && (
            <span
              style={{
                fontSize: 13,
                color: 'var(--err)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <window.Icon name="alert" size={14} /> {saveErr}
            </span>
          )}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                height: 5,
                flex: 1,
                maxWidth: 220,
                background: 'var(--surface-2)',
                borderRadius: 99,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${((step + 1) / STEPS.length) * 100}%`,
                  background: 'var(--accent)',
                  borderRadius: 99,
                  transition: 'width .3s',
                }}
              />
            </div>
            <span
              style={{ fontSize: 12.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}
            >
              {step + 1} / {STEPS.length}
            </span>
          </div>
          <window.Button
            variant="ghost"
            icon="back"
            onClick={back}
            disabled={step === 0}
            style={{ opacity: step === 0 ? 0.4 : 1 }}
          >
            Back
          </window.Button>
          {!canNext() && gated.includes(cur) ? (
            <>
              {/* Ollama: allow skipping the model with an inline warning. */}
              {cur === 'ollama' && data.ollamaState === 'ok' && (
                <window.Button variant="ghost" onClick={() => setStep(step + 1)}>
                  Skip for now
                </window.Button>
              )}
              <window.Button variant="default" disabled style={{ opacity: 0.55 }}>
                {blockedLabel}
              </window.Button>
            </>
          ) : (
            <>
              {cur === 'module-config' && (
                <window.Button
                  variant="ghost"
                  onClick={() => setStep(step + 1)}
                  disabled={configSaving}
                >
                  Skip for now
                </window.Button>
              )}
              <window.Button
                variant="primary"
                icon={cur === 'finish' ? 'power' : cur === 'module-config' ? 'check' : 'fwd'}
                onClick={next}
                disabled={saving || configSaving}
              >
                {saving || configSaving ? (
                  <>
                    <window.Icon name="refresh" size={15} className="spin" /> Saving…
                  </>
                ) : cur === 'finish' ? (
                  'Start Modulus'
                ) : cur === 'module-config' ? (
                  'Save & continue'
                ) : (
                  'Continue'
                )}
              </window.Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Shown after "Start Modulus" in setup mode while the daemon promotes. The app's
// own /api/state poll renders the hub on success; this just covers the gap (and
// surfaces a failed promotion's setupError with a retry).
function StartingScreen({ setupError, onRetry }) {
  const [elapsed, setElapsed] = useStateWiz(0);
  useEffectWiz(() => {
    const t = setInterval(() => setElapsed((e) => e + 1.5), 1500);
    return () => clearInterval(t);
  }, []);
  const timedOut = elapsed >= 90;
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'var(--bg)',
        padding: 32,
        textAlign: 'center',
      }}
    >
      {setupError ? (
        <>
          <span
            style={{
              width: 48,
              height: 48,
              borderRadius: 99,
              background: 'color-mix(in oklab, var(--err) 18%, var(--surface))',
              color: 'var(--err)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <window.Icon name="alert" size={22} />
          </span>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Modulus couldn’t finish starting</div>
          <p style={{ fontSize: 14, color: 'var(--text-2)', maxWidth: 440, lineHeight: 1.55 }}>
            {setupError}
          </p>
          <window.Button variant="primary" icon="refresh" onClick={onRetry}>
            Try again
          </window.Button>
        </>
      ) : (
        <>
          <window.Icon
            name="refresh"
            size={32}
            className="spin"
            style={{ color: 'var(--accent-strong)' }}
          />
          <div style={{ fontSize: 20, fontWeight: 700 }}>Starting Modulus…</div>
          <p style={{ fontSize: 14, color: 'var(--text-2)', maxWidth: 440, lineHeight: 1.55 }}>
            {timedOut
              ? "This is taking a while. If it doesn't land soon, check ~/.modulus/log/modulus.log, then run `modulus start` again."
              : 'Bringing the agent, modules, and Telegram online. This page updates itself.'}
          </p>
        </>
      )}
    </div>
  );
}

function StepHead({ kicker, title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      {kicker && (
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: 'var(--accent-strong)',
            textTransform: 'uppercase',
            letterSpacing: '.07em',
            marginBottom: 10,
          }}
        >
          {kicker}
        </div>
      )}
      <h1 style={{ fontSize: 30, letterSpacing: 0, lineHeight: 1.1 }}>{title}</h1>
      {children && (
        <p style={{ fontSize: 15.5, color: 'var(--text-2)', lineHeight: 1.6, marginTop: 12 }}>
          {children}
        </p>
      )}
    </div>
  );
}

function StepWelcome() {
  const points = [
    {
      icon: 'shield',
      title: 'Runs privately on this machine',
      desc: 'Your conversations and data stay local. Nothing leaves unless an module explicitly sends it.',
    },
    {
      icon: 'send',
      title: 'Chat here, or on Telegram',
      desc: 'Talk to Modulus right in this web panel. Connecting a Telegram bot is optional, for chatting from your phone.',
    },
    {
      icon: 'plug',
      title: 'Grows with modules',
      desc: 'Start minimal, then add calendar, voice, reminders and more whenever you like.',
    },
  ];
  return (
    <div>
      <StepHead kicker="Welcome" title="Let’s set up Modulus, your private assistant.">
        This takes about three minutes. We’ll pick a model to run on this machine, connect your chat
        app, and choose any extras you want. You can change all of it later.
      </StepHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {points.map((p) => (
          <div
            key={p.title}
            style={{
              display: 'flex',
              gap: 14,
              padding: 16,
              borderRadius: 'var(--radius)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                flex: 'none',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--accent-soft)',
                color: 'var(--accent-strong)',
              }}
            >
              <window.Icon name={p.icon} size={19} />
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{p.title}</div>
              <p style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.5 }}>
                {p.desc}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HelperBox({ open, onToggle, title, children }) {
  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        background: 'var(--surface-2)',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '11px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-2)',
          fontSize: 13.5,
          fontWeight: 600,
          textAlign: 'left',
        }}
      >
        <window.Icon name="spark" size={15} style={{ color: 'var(--accent-strong)' }} /> {title}
        <window.Icon
          name="fwd"
          size={15}
          style={{
            marginLeft: 'auto',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .2s',
            color: 'var(--text-3)',
          }}
        />
      </button>
      {open && (
        <div
          className="fade"
          style={{
            padding: '0 14px 14px 38px',
            fontSize: 13.5,
            color: 'var(--text-2)',
            lineHeight: 1.6,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ---- Ollama step (server + tier + model, merged) --------------------------

// Direct installer download per OS, so "Download Ollama" hands the user the
// exact file to run instead of dropping them on a page to hunt for the button.
// Linux has no single-click installer (the curl|sh script needs a shell), so it
// returns null and we fall back to the command.
function ollamaDownloadUrl(isMac, isWin) {
  if (isWin) return 'https://ollama.com/download/OllamaSetup.exe';
  if (isMac) return 'https://ollama.com/download/Ollama.dmg';
  return null;
}

function OllamaInstallCard({ onRecheck, checking }) {
  const plat = (navigator.platform || '').toLowerCase();
  const isMac = plat.includes('mac');
  const isWin = plat.includes('win');
  const downloadUrl = ollamaDownloadUrl(isMac, isWin);
  const osLabel = isMac ? 'macOS' : isWin ? 'Windows' : 'Linux';
  // Once the user kicks off a download we poll the probe so the step advances on
  // its own the moment Ollama comes up — no "click Check again" dance.
  const [waiting, setWaiting] = useStateWiz(false);
  useEffectWiz(() => {
    if (!waiting) return;
    const id = setInterval(() => onRecheck(), 4000);
    return () => clearInterval(id);
  }, [waiting, onRecheck]);

  const startDownload = () => {
    if (downloadUrl) window.open(downloadUrl, '_blank', 'noopener');
    setWaiting(true);
  };

  return (
    <div
      className="fade"
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 'var(--radius)',
        background: 'color-mix(in oklab, var(--warn) 9%, var(--surface))',
        border: '1px solid color-mix(in oklab, var(--warn) 35%, var(--border))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
        <window.Icon name="alert" size={16} style={{ color: 'var(--warn)' }} />
        <span style={{ fontWeight: 600, fontSize: 14.5 }}>Ollama isn’t running yet</span>
      </div>
      <p style={{ margin: '0 0 12px', lineHeight: 1.6, fontSize: 13.5, color: 'var(--text-2)' }}>
        Ollama is the small free program that runs the AI on this machine.{' '}
        {downloadUrl
          ? `Download it for ${osLabel} and run the installer — this page checks automatically and moves on once it’s up.`
          : 'Install it with the command below, then this page will detect it automatically.'}
      </p>
      {!downloadUrl && (
        <pre
          style={{
            margin: '0 0 12px',
            padding: '10px 12px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            color: 'var(--text-2)',
            overflow: 'auto',
          }}
        >
          curl -fsSL https://ollama.com/install.sh | sh
        </pre>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {downloadUrl && (
          <window.Button variant="primary" icon="download" onClick={startDownload}>
            Download Ollama for {osLabel}
          </window.Button>
        )}
        <window.Button variant="default" icon="refresh" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : waiting ? 'Waiting for Ollama…' : 'Check again'}
        </window.Button>
        <a
          href="https://ollama.com/download"
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 13, color: 'var(--text-3)', fontWeight: 600 }}
        >
          Other options →
        </a>
      </div>
      {waiting && (
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
          <window.Icon name="refresh" size={14} className="spin" /> Run the installer if it hasn’t
          started, then leave this page open — it’ll continue on its own.
        </div>
      )}
    </div>
  );
}

// Turn a classified probe failure into a sentence a non-technical user can act
// on — the raw ECONNREFUSED/ETIMEDOUT codes mean nothing to them. Especially
// matters for remote Ollama (e.g. a mini PC on the LAN), where "refused" vs
// "unreachable" points at completely different fixes.
function ollamaErrHint(kind, url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* leave blank */
  }
  const at = host ? ` at ${host}` : '';
  switch (kind) {
    case 'refused':
      return `The machine${at} answered, but Ollama isn’t listening there. Make sure Ollama is running — and if it’s another computer, that it was started with OLLAMA_HOST=0.0.0.0.`;
    case 'unreachable':
    case 'timeout':
      return `Couldn’t reach the machine${at}. Check that it’s powered on, on the same network, and that the address is right.`;
    case 'dns':
      return `That hostname doesn’t resolve. Try the machine’s IP address instead.`;
    default:
      return '';
  }
}

function StepOllama({ data, set, models, setModels, suggestedTier, ramGb, modelRecommendations }) {
  const [showAdvanced, setShowAdvanced] = useStateWiz(false);
  const [changeTier, setChangeTier] = useStateWiz(false);
  const [dl, setDl] = useStateWiz(null); // { model, status, completed, total }
  const [dlErr, setDlErr] = useStateWiz('');
  const dlRef = useRefWiz(null);

  const probe = async () => {
    set({ ollamaState: 'testing', ollamaErr: '', ollamaErrKind: '' });
    const r = await window.api.post('/api/ollama/test', { url: data.ollamaUrl });
    if (r.ok && r.data && r.data.ok) {
      set({ ollamaState: 'ok' });
      setModels(r.data.models || []);
    } else {
      set({
        ollamaState: 'err',
        ollamaErr: (r.data && r.data.error) || r.error || '',
        ollamaErrKind: (r.data && r.data.errorKind) || '',
      });
    }
  };
  // Auto-probe on mount.
  useEffectWiz(() => {
    probe();
    return () => {
      if (dlRef.current) {
        try {
          dlRef.current.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const rec = (modelRecommendations && modelRecommendations[data.tier]) || null;
  const recTag = rec && rec.chat;
  const haveRec = !!recTag && models.includes(recTag);

  // If the recommended tag is already pulled and nothing is chosen yet, adopt it.
  useEffectWiz(() => {
    if (haveRec && !data.chatModel) set({ chatModel: recTag });
  }, [haveRec, recTag, data.chatModel]);

  const startDownload = (tag) => {
    setDlErr('');
    setDl({ model: tag, status: 'starting', completed: 0, total: 0 });
    const es = window.api.streamSSE('/api/ollama/pull-stream?model=' + encodeURIComponent(tag), {
      onMessage: (_e, raw) => {
        let m;
        try {
          m = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          return;
        }
        if (m && m.type === 'progress') {
          setDl((d) => ({
            model: tag,
            status: m.status || (d && d.status) || '',
            total: typeof m.total === 'number' ? m.total : (d && d.total) || 0,
            completed: typeof m.completed === 'number' ? m.completed : (d && d.completed) || 0,
          }));
        } else if (m && m.type === 'done') {
          es.close();
          dlRef.current = null;
          if (m.ok) {
            setModels((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
            set({ chatModel: tag });
            setDl(null);
          } else {
            setDlErr(m.error || 'Download failed.');
            setDl(null);
          }
        }
      },
      onError: () => {
        if (!dlRef.current) return;
        es.close();
        dlRef.current = null;
        setDlErr('The download stream disconnected — check the agent log and retry.');
        setDl(null);
      },
    });
    dlRef.current = es;
  };

  const pct =
    dl && dl.total > 0 ? Math.min(100, Math.round((dl.completed / dl.total) * 100)) : null;

  return (
    <div>
      <StepHead kicker="Step 1" title="Local model server">
        Modulus runs its AI with <b>Ollama</b>, a small program on this machine. Let’s make sure
        it’s reachable and pick a model.
      </StepHead>
      <window.Label hint="The address Ollama listens on. The default works for most setups.">
        Ollama URL
      </window.Label>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <window.Input
            mono
            value={data.ollamaUrl}
            onChange={(e) => set({ ollamaUrl: e.target.value, ollamaState: 'idle' })}
          />
        </div>
        <window.Button variant="primary" onClick={probe} disabled={data.ollamaState === 'testing'}>
          {data.ollamaState === 'testing' ? (
            <>
              <window.Icon name="refresh" size={15} className="spin" /> Testing
            </>
          ) : (
            'Test connection'
          )}
        </window.Button>
      </div>
      <CheckResult
        state={data.ollamaState === 'testing' ? 'checking' : data.ollamaState}
        ok={
          <>
            Reachable — found{' '}
            <b>
              {models.length} model{models.length === 1 ? '' : 's'}
            </b>{' '}
            on this machine.
          </>
        }
        err={
          ollamaErrHint(data.ollamaErrKind, data.ollamaUrl) ||
          (data.ollamaErr
            ? `Couldn’t reach Ollama: ${data.ollamaErr}`
            : 'Couldn’t reach Ollama there.')
        }
      />

      {data.ollamaState === 'err' && (
        <OllamaInstallCard onRecheck={probe} checking={data.ollamaState === 'testing'} />
      )}

      {data.ollamaState === 'ok' && (
        <div className="fade" style={{ marginTop: 18 }}>
          {/* Tier pill + change control */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
            }}
          >
            <window.Icon name="cpu" size={16} style={{ color: 'var(--accent-strong)' }} />
            <span style={{ fontSize: 13.5 }}>
              Detected: <b style={{ textTransform: 'capitalize' }}>{data.tier}</b>
              {ramGb != null && <span style={{ color: 'var(--text-3)' }}> — {ramGb} GB RAM</span>}
            </span>
            <button
              onClick={() => setChangeTier((c) => !c)}
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: 'none',
                color: 'var(--text-3)',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {changeTier ? 'Done' : 'Change'}
            </button>
          </div>
          {changeTier && (
            <div className="fade" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {['small', 'standard', 'heavy'].map((t) => {
                const on = data.tier === t;
                return (
                  <button
                    key={t}
                    onClick={() => set({ tier: t })}
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                      fontWeight: 600,
                      fontSize: 13,
                      background: on ? 'var(--accent-soft)' : 'var(--surface)',
                      border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                      color: on ? 'var(--accent-strong)' : 'var(--text-2)',
                    }}
                  >
                    {t}
                    {t === suggestedTier ? ' ★' : ''}
                  </button>
                );
              })}
            </div>
          )}

          {/* Model recommendation / download */}
          {rec && (
            <div
              style={{
                marginTop: 14,
                padding: 16,
                borderRadius: 'var(--radius)',
                background: 'var(--surface)',
                border: `1px solid ${haveRec ? 'color-mix(in oklab, var(--ok) 40%, var(--border))' : 'var(--border)'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <window.Icon name="spark" size={17} style={{ color: 'var(--accent-strong)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style={{ fontWeight: 700, fontSize: 14.5 }}>
                    {recTag}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                    Recommended for {data.tier} · {rec.approxSize}
                  </div>
                </div>
                {haveRec ? (
                  <window.Badge tone="ok">
                    <window.Icon name="check" size={11} /> installed
                  </window.Badge>
                ) : dl ? (
                  <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                    {pct != null ? `${pct}%` : 'starting…'}
                  </span>
                ) : (
                  <window.Button
                    variant="primary"
                    icon="download"
                    onClick={() => startDownload(recTag)}
                  >
                    Download
                  </window.Button>
                )}
              </div>
              {rec.reason && !dl && !haveRec && (
                <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 8, lineHeight: 1.5 }}>
                  {rec.reason}
                </p>
              )}
              {dl && (
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      height: 6,
                      background: 'var(--surface-2)',
                      borderRadius: 99,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${pct ?? 5}%`,
                        background: 'var(--accent)',
                        borderRadius: 99,
                        transition: 'width .3s',
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
                    {dl.status}
                  </div>
                </div>
              )}
              {dlErr && (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 13,
                    color: 'var(--err)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <window.Icon name="alert" size={14} /> {dlErr}
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => setShowAdvanced((s) => !s)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-3)',
              fontSize: 12.5,
              cursor: 'pointer',
              padding: '12px 0 0',
              fontWeight: 600,
            }}
          >
            {showAdvanced ? '← Hide model slots' : 'Choose a different model →'}
          </button>
          {showAdvanced && (
            <div
              className="fade"
              style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 12 }}
            >
              <ModelSlot
                label="Chat model — your everyday default"
                hint="Fast model used for normal conversation. Required."
                value={data.chatModel}
                onChange={(v) => set({ chatModel: v })}
                models={models}
              />
              <ModelSlot
                label="Reasoning model — for hard problems"
                hint="A bigger, slower model for tricky questions. Optional."
                value={data.reasoningModel}
                onChange={(v) => set({ reasoningModel: v })}
                models={models}
                allowSkip
                skipLabel="Skip — my hardware is small"
              />
              <ModelSlot
                label="Tools model — for tool-calling"
                hint="Used when Modulus calls tools. Leave blank to reuse your Chat model."
                value={data.toolsModel}
                onChange={(v) => set({ toolsModel: v })}
                models={models}
                allowSkip
                skipLabel="Use my Chat model"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelSlot({ label, hint, value, onChange, models, allowSkip, skipLabel }) {
  const [manual, setManual] = useStateWiz(false);
  const useManual = manual || models.length === 0;
  return (
    <div>
      <window.Label hint={hint}>{label}</window.Label>
      {useManual ? (
        <window.Input
          mono
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model:tag"
        />
      ) : (
        <window.Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{allowSkip ? skipLabel : 'Select a model…'}</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </window.Select>
      )}
      {models.length > 0 && (
        <button
          onClick={() => setManual((m) => !m)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-3)',
            fontSize: 12.5,
            cursor: 'pointer',
            padding: '7px 0 0',
            fontWeight: 500,
          }}
        >
          {manual ? '← Pick from detected models' : 'Enter a tag manually →'}
        </button>
      )}
    </div>
  );
}

// ---- Telegram step (token + pairing + allowlist, merged) ------------------

function StepTelegram({ data, set }) {
  const [help, setHelp] = useStateWiz(false);
  const [manualOpen, setManualOpen] = useStateWiz(false);
  const [draft, setDraft] = useStateWiz('');
  const [manualErr, setManualErr] = useStateWiz('');
  const [pair, setPair] = useStateWiz({
    state: 'idle',
    code: '',
    botUser: '',
    firstName: '',
    err: '',
  });
  const pairPoll = useRefWiz(null);

  const stopPoll = () => {
    if (pairPoll.current) {
      clearInterval(pairPoll.current);
      pairPoll.current = null;
    }
  };
  useEffectWiz(() => () => stopPoll(), []);

  const validate = async () => {
    set({ tokenState: 'checking', tokenErr: '' });
    const r = await window.api.post('/api/telegram/validate', { token: data.token });
    if (r.ok && r.data && r.data.ok)
      set({ tokenState: 'ok', botName: r.data.botName, botUser: r.data.botUser });
    else
      set({
        tokenState: 'err',
        tokenErr: (r.data && r.data.error) || r.error || 'That doesn’t look like a valid token.',
      });
  };

  const pollStatus = async () => {
    const r = await window.api.get('/api/telegram/pair/status');
    if (!r.ok || !r.data) return;
    const s = r.data;
    if (s.state === 'paired') {
      stopPoll();
      const id = String(s.userId);
      if (!data.allowlist.includes(id)) {
        set({
          allowlist: [...data.allowlist, id],
          names: { ...data.names, [id]: s.firstName || id },
        });
      }
      setPair((p) => ({ ...p, state: 'paired', firstName: s.firstName || '' }));
    } else if (s.state === 'expired') {
      stopPoll();
      setPair((p) => ({ ...p, state: 'expired' }));
    } else if (s.state === 'error') {
      stopPoll();
      setPair((p) => ({ ...p, state: 'error', err: s.error || '' }));
    }
  };

  const startPair = async () => {
    stopPoll();
    setPair({ state: 'starting', code: '', botUser: '', firstName: '', err: '' });
    const r = await window.api.post('/api/telegram/pair', { token: data.token });
    if (!r.ok) {
      // 409 → pairing isn't available in this mode; fall back to manual entry.
      setPair({
        state: r.status === 409 ? 'unavailable' : 'error',
        code: '',
        botUser: '',
        firstName: '',
        err: (r.data && r.data.error) || r.error || '',
      });
      if (r.status === 409) setManualOpen(true);
      return;
    }
    setPair({
      state: 'waiting',
      code: r.data.code,
      botUser: r.data.botUser,
      firstName: '',
      err: '',
    });
    pairPoll.current = setInterval(pollStatus, 1500);
  };

  const addManual = () => {
    const v = draft.trim();
    if (!/^\d{4,}$/.test(v)) {
      setManualErr('A Telegram ID is a number, e.g. 8675309.');
      return;
    }
    if (data.allowlist.includes(v)) {
      setManualErr('That ID is already added.');
      return;
    }
    set({ allowlist: [...data.allowlist, v] });
    setDraft('');
    setManualErr('');
  };

  const removeId = (id) => set({ allowlist: data.allowlist.filter((x) => x !== id) });

  const deepLink = pair.botUser ? `https://t.me/${pair.botUser.replace(/^@/, '')}` : null;

  return (
    <div>
      <StepHead kicker="Step 2 · optional" title="Connect Telegram">
        Telegram lets you chat with Modulus from your phone. It’s <b>optional</b> — you can use the
        web panel’s chat and skip this, then add Telegram any time from Settings. To connect now,
        paste a <b>bot token</b> from BotFather, then add yourself by sending a code from your
        phone.
      </StepHead>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 18,
          padding: '10px 14px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          fontSize: 13,
          color: 'var(--text-2)',
        }}
      >
        <window.Icon
          name="chat"
          size={15}
          style={{ color: 'var(--accent-strong)', flex: 'none' }}
        />
        <span>
          Just want the web panel? <b>Skip</b> with Continue below — nothing here is required.
        </span>
      </div>
      <window.Label hint="Paste the token here. It looks like 1234567890:AAH... and stays on this machine.">
        Bot token
      </window.Label>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <window.SecretInput
            value={data.token}
            onChange={(e) => set({ token: e.target.value, tokenState: 'idle' })}
            placeholder="1234567890:AAH…"
          />
        </div>
        <window.Button
          variant="primary"
          onClick={validate}
          disabled={!data.token || data.tokenState === 'checking'}
          style={{ opacity: !data.token ? 0.55 : 1 }}
        >
          {data.tokenState === 'checking' ? (
            <>
              <window.Icon name="refresh" size={15} className="spin" /> Checking
            </>
          ) : (
            'Validate'
          )}
        </window.Button>
      </div>
      <CheckResult
        state={data.tokenState}
        ok={
          <>
            Connected as <b>{data.botName}</b>{' '}
            <span className="mono" style={{ color: 'var(--text-3)' }}>
              {data.botUser}
            </span>
          </>
        }
        err={
          data.tokenErr ||
          'That doesn’t look like a valid token. Check you copied the whole thing from BotFather.'
        }
      />
      <HelperBox open={help} onToggle={() => setHelp((h) => !h)} title="How do I get a token?">
        Open Telegram and message <span className="mono">@BotFather</span>. Send{' '}
        <span className="mono">/newbot</span>, pick a name and username, and BotFather replies with
        a token. Copy it and paste it above.
      </HelperBox>

      {/* Pairing panel — only once the token validates. */}
      {data.tokenState === 'ok' && (
        <div
          className="fade"
          style={{
            marginTop: 18,
            padding: 18,
            borderRadius: 'var(--radius)',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
            Add yourself (and others)
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 12 }}>
            Only people you add can talk to your bot. The easiest way: open your bot and send it a
            one-time code.
          </p>

          {(pair.state === 'idle' || pair.state === 'starting' || pair.state === 'error') && (
            <>
              <window.Button
                variant="primary"
                icon="send"
                onClick={startPair}
                disabled={pair.state === 'starting'}
              >
                {pair.state === 'starting' ? 'Starting…' : 'Get a pairing code'}
              </window.Button>
              {pair.state === 'error' && pair.err && (
                <div style={{ marginTop: 10, fontSize: 13, color: 'var(--err)' }}>{pair.err}</div>
              )}
            </>
          )}

          {pair.state === 'unavailable' && (
            <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
              Phone pairing isn’t available right now — add your numeric ID below instead.
            </div>
          )}

          {pair.state === 'waiting' && (
            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {deepLink && (
                  <a href={deepLink} target="_blank" rel="noreferrer">
                    <window.Button variant="default" icon="send">
                      Open {pair.botUser}
                    </window.Button>
                  </a>
                )}
                <window.Icon
                  name="refresh"
                  size={16}
                  className="spin"
                  style={{ color: 'var(--text-3)' }}
                />
                <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                  waiting for your message…
                </span>
              </div>
              <div style={{ marginTop: 12, fontSize: 13.5, color: 'var(--text-2)' }}>
                Open your bot and send it this code:
              </div>
              <div
                className="mono"
                style={{
                  marginTop: 6,
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: 3,
                  color: 'var(--accent-strong)',
                }}
              >
                {pair.code}
              </div>
            </div>
          )}

          {pair.state === 'expired' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, color: 'var(--warn)' }}>Code expired.</span>
              <window.Button variant="default" icon="refresh" onClick={startPair}>
                Get a new code
              </window.Button>
            </div>
          )}

          {pair.state === 'paired' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <window.Badge tone="ok">
                <window.Icon name="check" size={11} /> Hi {pair.firstName || 'there'} ✓
              </window.Badge>
              <window.Button variant="ghost" icon="plus" onClick={startPair}>
                Add another person
              </window.Button>
            </div>
          )}

          {/* Allowlist chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
            {data.allowlist.length === 0 && (
              <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>No one added yet.</span>
            )}
            {data.allowlist.map((id) => (
              <span
                key={id}
                className="rise"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 9px 7px 13px',
                  borderRadius: 99,
                  background: 'var(--accent-soft)',
                  fontSize: 13.5,
                  color: 'var(--accent-strong)',
                  fontWeight: 600,
                }}
              >
                {data.names[id] ? data.names[id] : <span className="mono">{id}</span>}
                <button
                  onClick={() => removeId(id)}
                  aria-label="Remove"
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 99,
                    border: 'none',
                    background: 'color-mix(in oklab, var(--accent) 25%, transparent)',
                    color: 'var(--accent-strong)',
                    cursor: 'pointer',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  <window.Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>

          <HelperBox
            open={manualOpen}
            onToggle={() => setManualOpen((m) => !m)}
            title="Add a numeric ID instead"
          >
            <p style={{ marginBottom: 10 }}>
              Message <span className="mono">@userinfobot</span> on Telegram to get your numeric ID,
              then paste it here.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, maxWidth: 260 }}>
                <window.Input
                  mono
                  value={draft}
                  invalid={!!manualErr}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setManualErr('');
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && addManual()}
                  placeholder="e.g. 8675309"
                />
              </div>
              <window.Button variant="default" icon="plus" onClick={addManual}>
                Add
              </window.Button>
            </div>
            {manualErr && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--err)' }}>{manualErr}</div>
            )}
          </HelperBox>
        </div>
      )}
    </div>
  );
}

function StepModules() {
  const [mods, setExts] = useStateWiz(null);
  const [busy, setBusy] = useStateWiz(null);
  // Per-module toggle result so the user can see whether the post-enable
  // setup (downloads, package-manager installs) actually succeeded — silently
  // failing here is what burned us with whisper.cpp on Windows.
  const [results, setResults] = useStateWiz({});
  const [openDetails, setOpenDetails] = useStateWiz({});
  // Two-phase modal for modulus-voice: 'warn' lists what'll be downloaded;
  // 'streaming' tails live setup output via SSE; 'done' shows the result.
  const [voiceModal, setVoiceModal] = useStateWiz(null);
  const [voiceLines, setVoiceLines] = useStateWiz([]);
  const [voiceOk, setVoiceOk] = useStateWiz(true);
  const voiceStreamRef = useRefWiz(null);
  const load = async () => {
    const r = await window.api.get('/api/modules');
    // Hide the panel itself — it's already running and can't be toggled here.
    if (r.ok) setExts(r.data.modules.filter((e) => !e.self));
    else setExts([]);
  };
  useEffectWiz(() => {
    load();
  }, []);
  const toggle = async (e) => {
    // Special-case enabling Voice: detour through the heads-up modal so the
    // user knows the downloads are coming, then through the streaming modal
    // so they see progress. Disabling skips both — just a flag flip.
    if (e.name === 'modulus-voice' && !e.enabled) {
      setVoiceLines([]);
      setVoiceOk(true);
      setVoiceModal('warn');
      return;
    }
    setBusy(e.name);
    const action = e.enabled ? 'disable' : 'enable';
    const r = await window.api.post(`/api/modules/${encodeURIComponent(e.name)}/${action}`);
    const output = (r.data && r.data.output) || r.error || '';
    const ok = !!(r.ok && r.data && r.data.ok);
    setResults((prev) => ({ ...prev, [e.name]: { ok, output, action } }));
    setBusy(null);
    load();
  };
  const beginVoiceDownload = () => {
    setVoiceModal('streaming');
    setBusy('modulus-voice');
    const es = window.api.streamSSE('/api/modules/modulus-voice/enable-stream', {
      onMessage: (_evt, raw) => {
        let msg;
        try {
          msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          return;
        }
        if (msg && msg.type === 'line') {
          setVoiceLines((prev) => [...prev, msg.line]);
        } else if (msg && msg.type === 'done') {
          const ok = !!msg.ok;
          setVoiceOk(ok);
          if (!ok && msg.error) setVoiceLines((prev) => [...prev, `\nerror: ${msg.error}`]);
          es.close();
          voiceStreamRef.current = null;
          setVoiceModal('done');
          setResults((prev) => ({
            ...prev,
            'modulus-voice': { ok, output: '', action: 'enable' },
          }));
          setBusy(null);
          load();
        }
      },
      onError: () => {
        if (!voiceStreamRef.current) return;
        es.close();
        voiceStreamRef.current = null;
        setVoiceOk(false);
        setVoiceLines((prev) => [...prev, '\n(stream disconnected — check the agent log)']);
        setVoiceModal('done');
        setBusy(null);
      },
    });
    voiceStreamRef.current = es;
  };
  const closeVoiceModal = () => {
    if (voiceStreamRef.current) {
      try {
        voiceStreamRef.current.close();
      } catch {
        /* ignore */
      }
      voiceStreamRef.current = null;
    }
    setVoiceModal(null);
    setBusy(null);
  };
  const pretty = (e) =>
    e.name
      .replace(/^modulus-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const blurb = (e) =>
    (window.MODULE_BLURBS && window.MODULE_BLURBS[e.name]) || e.description || '';
  return (
    <div>
      <StepHead kicker="Step 3" title="Pick your modules">
        These capabilities are on by default — turn off anything you don’t want, or skip to keep
        them all. Codex and Everyday Assistant get a guided connection on the next step.
      </StepHead>
      {mods === null && (
        <div style={{ fontSize: 13.5, color: 'var(--text-3)' }}>Loading modules…</div>
      )}
      {mods && mods.length === 0 && (
        <div style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
          No modules are installed yet. You can add them later with{' '}
          <span className="mono">modulus mod install</span>.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(mods || []).map((e) => {
          const result = results[e.name];
          const detailsOpen = !!openDetails[e.name];
          return (
            <div
              key={e.name}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: 15,
                borderRadius: 'var(--radius)',
                background: 'var(--surface)',
                border: `1px solid ${e.enabled ? 'color-mix(in oklab, var(--accent) 40%, var(--border))' : 'var(--border)'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <span
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    background: 'var(--accent-soft)',
                    color: 'var(--accent-strong)',
                    fontWeight: 700,
                    fontFamily: 'var(--font-display)',
                    fontSize: 14,
                  }}
                >
                  {pretty(e)
                    .replace(/[^A-Za-z ]/g, '')
                    .split(' ')
                    .slice(0, 2)
                    .map((w) => w[0])
                    .join('')}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 14.5 }}>{pretty(e)}</span>
                    {e.needsAuth && !e.authConnected && (
                      <window.Badge tone="warn">
                        <window.Icon name="link" size={11} />
                        needs connection
                      </window.Badge>
                    )}
                    {e.needsAuth && e.authConnected && (
                      <window.Badge tone="ok">
                        <window.Icon name="check" size={11} />
                        connected
                      </window.Badge>
                    )}
                  </div>
                  <p
                    style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2, lineHeight: 1.45 }}
                  >
                    {blurb(e)}
                  </p>
                </div>
                {busy === e.name ? (
                  <window.Icon
                    name="refresh"
                    size={18}
                    className="spin"
                    style={{ color: 'var(--text-3)' }}
                  />
                ) : (
                  <window.Toggle
                    checked={e.enabled}
                    onChange={() => toggle(e)}
                    label={`Enable ${pretty(e)}`}
                  />
                )}
              </div>
              {busy === e.name && (
                <p
                  style={{
                    marginTop: 10,
                    fontSize: 12.5,
                    color: 'var(--text-3)',
                    fontStyle: 'italic',
                  }}
                >
                  Setting up — this may take a minute if native dependencies need to download.
                </p>
              )}
              {result && busy !== e.name && (
                <ModuleResultPanel
                  ok={result.ok}
                  output={result.output}
                  action={result.action}
                  open={detailsOpen}
                  onToggle={() => setOpenDetails((prev) => ({ ...prev, [e.name]: !prev[e.name] }))}
                />
              )}
            </div>
          );
        })}
      </div>
      <VoiceSetupModal
        stage={voiceModal}
        lines={voiceLines}
        ok={voiceOk}
        onConfirm={beginVoiceDownload}
        onClose={closeVoiceModal}
      />
    </div>
  );
}

// Two-stage modal for the modulus-voice setup.
function VoiceSetupModal({ stage, lines, ok, onConfirm, onClose }) {
  const safeClose = stage === 'streaming' ? () => {} : onClose;
  if (stage === 'warn') {
    return (
      <window.Modal
        open
        onClose={safeClose}
        title="Voice needs a few downloads"
        width={520}
        tone="warn"
        footer={
          <>
            <window.Button variant="ghost" onClick={onClose}>
              Cancel
            </window.Button>
            <window.Button onClick={onConfirm}>Download &amp; set up</window.Button>
          </>
        }
      >
        <p style={{ marginBottom: 10 }}>
          Turning on Voice will install (about <b>300&nbsp;MB</b> total):
        </p>
        <ul style={{ paddingLeft: 20, margin: 0, lineHeight: 1.7 }}>
          <li>
            <b>ffmpeg</b> — converts audio between OGG and WAV (system package).
          </li>
          <li>
            <b>Piper TTS</b> binary and a voice model — for spoken replies.
          </li>
          <li>
            <b>whisper.cpp</b> binary and a transcription model — for voice notes.
          </li>
        </ul>
        <p style={{ marginTop: 12, color: 'var(--text-3)', fontSize: 13 }}>
          Stay on this page until the modal closes — some pieces take a minute on a slow link.
        </p>
      </window.Modal>
    );
  }
  if (stage === 'streaming' || stage === 'done') {
    const title =
      stage === 'streaming'
        ? 'Setting up Voice…'
        : ok
          ? 'Voice is ready'
          : 'Voice setup hit a problem';
    return (
      <window.Modal
        open
        onClose={safeClose}
        title={title}
        width={680}
        tone={stage === 'done' && !ok ? 'err' : null}
        footer={stage === 'done' ? <window.Button onClick={onClose}>Close</window.Button> : null}
      >
        {stage === 'streaming' && (
          <p style={{ marginBottom: 10 }}>
            Downloading and installing. Don&rsquo;t close this tab.
          </p>
        )}
        {stage === 'done' && !ok && (
          <p style={{ marginBottom: 10 }}>
            Something didn&rsquo;t finish. The log below shows where it stopped — usually a missing
            system package or a network blip; re-enable to retry.
          </p>
        )}
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--text-2)',
            maxHeight: 340,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {lines.length === 0 ? 'starting…' : lines.join('\n')}
        </pre>
      </window.Modal>
    );
  }
  return null;
}

function ModuleResultPanel({ ok, output, action, open, onToggle }) {
  const verb = action === 'enable' ? 'Enabled' : 'Disabled';
  const hasOutput = !!(output && output.trim().length > 0);
  const tone = ok ? 'var(--ok)' : 'var(--err)';
  const bg = ok
    ? 'color-mix(in oklab, var(--ok) 8%, var(--surface))'
    : 'color-mix(in oklab, var(--err) 10%, var(--surface))';
  return (
    <div
      className="fade"
      style={{
        marginTop: 12,
        padding: '10px 12px',
        borderRadius: 'var(--radius-sm)',
        background: bg,
        border: `1px solid color-mix(in oklab, ${tone} 35%, var(--border))`,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <window.Icon name={ok ? 'check' : 'alert'} size={14} style={{ color: tone }} />
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>
          {ok ? `${verb} successfully.` : `${verb}, but setup reported an issue.`}
        </span>
        {hasOutput && (
          <button
            onClick={onToggle}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'var(--text-3)',
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {open ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>
      {hasOutput && open && (
        <pre
          style={{
            marginTop: 10,
            padding: 10,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--text-2)',
            lineHeight: 1.5,
            maxHeight: 220,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {output.trim()}
        </pre>
      )}
    </div>
  );
}

function StepModuleConfig({ saveRef }) {
  const [mods, setExts] = useStateWiz(null);
  const [vals, setVals] = useStateWiz({});
  const [taskIndex, setTaskIndex] = useStateWiz(0);
  const [authFor, setAuthFor] = useStateWiz(null);
  const [authDone, setAuthDone] = useStateWiz({});
  const [authSkipped, setAuthSkipped] = useStateWiz({});
  const [err, setErr] = useStateWiz(null);

  const authGuided = new Set(['modulus-codex', 'modulus-assistant']);
  const authManagedKeys = {
    'modulus-codex': new Set([
      'codex_access_token',
      'codex_refresh_token',
      'codex_id_token',
      'codex_expires_at',
      'codex_account_id',
    ]),
    'modulus-assistant': new Set([
      'google_client_id',
      'google_client_secret',
      'google_refresh_token',
    ]),
  };

  const prettyModuleName = (name) =>
    name
      .replace(/^modulus-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const initials = (name) =>
    prettyModuleName(name)
      .replace(/[^A-Za-z ]/g, '')
      .split(' ')
      .slice(0, 2)
      .map((w) => w[0])
      .join('');

  const shouldGuideAuth = (e) => authGuided.has(e.name) && e.needsAuth && !e.authConnected;
  const isAuthManagedField = (e, f) => !!authManagedKeys[e.name]?.has(f.key);
  const configurableFrom = (items) =>
    (items || []).filter(
      (e) => e.enabled && !e.self && ((e.schema && e.schema.length > 0) || shouldGuideAuth(e)),
    );
  const buildTasks = (items) =>
    (items || []).flatMap((e) => {
      const tasks = [];
      if (shouldGuideAuth(e)) tasks.push({ type: 'auth', mod: e, key: `${e.name}:auth` });
      for (const f of e.schema || []) {
        if (!isAuthManagedField(e, f)) {
          tasks.push({ type: 'setting', mod: e, field: f, key: `${e.name}:${f.key}` });
        }
      }
      return tasks;
    });

  const loadConfigurable = async () => {
    const r = await window.api.get('/api/modules');
    if (!r.ok) {
      setExts([]);
      return;
    }
    const configurable = configurableFrom(r.data.modules || []);
    setExts(configurable);
    const init = {};
    for (const e of configurable) {
      init[e.name] = Object.fromEntries((e.schema || []).map((f) => [f.key, f.value ?? '']));
    }
    setVals(init);
  };

  useEffectWiz(() => {
    loadConfigurable();
  }, []);

  const tasks = buildTasks(mods);
  const currentTask = tasks[Math.min(taskIndex, Math.max(tasks.length - 1, 0))];
  const atLastTask = taskIndex >= tasks.length - 1;

  const saveCurrentSetting = async () => {
    if (!currentTask || currentTask.type !== 'setting') return true;
    const mod = currentTask.mod;
    const field = currentTask.field;
    const r = await window.api.post(`/api/modules/${encodeURIComponent(mod.name)}/settings`, {
      [field.key]: (vals[mod.name] || {})[field.key] ?? '',
    });
    if (!r.ok) {
      setErr(r.error || `Could not save ${field.label}.`);
      return false;
    }
    setErr(null);
    return true;
  };

  const proceed = async () => {
    if (!currentTask) return true;
    if (currentTask.type === 'auth') {
      const name = currentTask.mod.name;
      if (!currentTask.mod.authConnected && !authDone[name] && !authSkipped[name]) {
        setErr(`Connect ${prettyModuleName(name)} or skip this connection before continuing.`);
        return false;
      }
      setErr(null);
    } else {
      const ok = await saveCurrentSetting();
      if (!ok) return false;
    }
    if (atLastTask) return true;
    setTaskIndex((i) => Math.min(i + 1, tasks.length - 1));
    return false;
  };

  useEffectWiz(() => {
    saveRef.current = proceed;
  });

  const setField = (name, key, v) => setVals((s) => ({ ...s, [name]: { ...s[name], [key]: v } }));

  const renderSettingInput = (task) => {
    const e = task.mod;
    const f = task.field;
    const extVals = vals[e.name] || {};
    if (f.type === 'boolean') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <window.Toggle
            checked={!!extVals[f.key]}
            onChange={(v) => setField(e.name, f.key, v)}
            label={f.label}
          />
          <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
            {extVals[f.key] ? 'On' : 'Off'}
          </span>
        </div>
      );
    }
    if (f.options) {
      return (
        <window.Select
          value={extVals[f.key] || ''}
          onChange={(ev) => setField(e.name, f.key, ev.target.value)}
        >
          {f.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </window.Select>
      );
    }
    if (f.type === 'secret') {
      return (
        <window.SecretInput
          value={extVals[f.key] || ''}
          onChange={(ev) => setField(e.name, f.key, ev.target.value)}
          placeholder="Not set"
        />
      );
    }
    if (f.type === 'number') {
      return (
        <window.Input
          type="number"
          mono
          value={extVals[f.key] || ''}
          onChange={(ev) => setField(e.name, f.key, ev.target.value)}
          style={{ maxWidth: 180 }}
        />
      );
    }
    return (
      <window.Input
        value={extVals[f.key] || ''}
        onChange={(ev) => setField(e.name, f.key, ev.target.value)}
        placeholder="Not set"
      />
    );
  };

  if (mods === null) {
    return (
      <div>
        <StepHead kicker="Step 4" title="Configure your modules">
          Loading module settings...
        </StepHead>
      </div>
    );
  }

  if (mods.length === 0 || tasks.length === 0) {
    return (
      <div>
        <StepHead kicker="Step 4" title="Configure your modules">
          Everything you enabled is ready with its defaults - click <b>Save &amp; continue</b> to
          move on.
        </StepHead>
      </div>
    );
  }

  const task = currentTask;
  const mod = task.mod;
  const connected = task.type === 'auth' && (mod.authConnected || authDone[mod.name]);

  return (
    <div>
      <StepHead kicker="Step 4" title="Configure your modules">
        We'll walk through one module setting at a time. Account connections come first for Codex
        and Everyday Assistant.
      </StepHead>
      {err && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--err)',
          }}
        >
          <window.Icon name="alert" size={14} /> {err}
        </div>
      )}
      <window.Card pad={0} style={{ overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--surface-2)',
          }}
        >
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              flex: 'none',
              display: 'grid',
              placeItems: 'center',
              background: 'var(--accent-soft)',
              color: 'var(--accent-strong)',
              fontWeight: 700,
              fontFamily: 'var(--font-display)',
              fontSize: 13,
            }}
          >
            {initials(mod.name)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{prettyModuleName(mod.name)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 1 }}>
              {task.type === 'auth' ? 'Account connection' : task.field.key}
            </div>
          </div>
          <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {taskIndex + 1} / {tasks.length}
          </span>
        </div>

        <div style={{ padding: 20 }}>
          {task.type === 'auth' ? (
            <div>
              <window.Label hint="This opens the same guided flow as the terminal auth command.">
                Connect {prettyModuleName(mod.name)}
              </window.Label>
              <p
                style={{
                  fontSize: 14,
                  color: 'var(--text-2)',
                  lineHeight: 1.55,
                  marginBottom: 14,
                }}
              >
                {mod.name === 'modulus-codex'
                  ? 'Sign in with your ChatGPT subscription so Modulus can hand hard tasks to Codex.'
                  : 'Connect Google once so Calendar, Tasks, reminders, and briefings can work.'}
              </p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <window.Button
                  variant={connected ? 'ok' : 'primary'}
                  icon={connected ? 'check' : 'link'}
                  onClick={() => setAuthFor(mod.name)}
                >
                  {connected ? 'Connected' : `Connect ${prettyModuleName(mod.name)}`}
                </window.Button>
                {!connected && (
                  <window.Button
                    variant="ghost"
                    onClick={() => {
                      setErr(null);
                      setAuthSkipped((s) => ({ ...s, [mod.name]: true }));
                      if (!atLastTask) setTaskIndex((i) => i + 1);
                    }}
                  >
                    Skip this connection
                  </window.Button>
                )}
                {connected && (
                  <window.Badge tone="ok">
                    <window.Icon name="check" size={11} />
                    credentials saved
                  </window.Badge>
                )}
              </div>
            </div>
          ) : (
            <div>
              <window.Label hint={task.field.help}>
                {task.field.label}
                {task.field.required && <span style={{ color: 'var(--err)' }}> *</span>}
                {task.field.type === 'secret' && (
                  <window.Icon
                    name="lock"
                    size={12}
                    style={{
                      display: 'inline',
                      verticalAlign: 'middle',
                      color: 'var(--text-3)',
                      marginLeft: 4,
                    }}
                  />
                )}
              </window.Label>
              {renderSettingInput(task)}
            </div>
          )}
        </div>
      </window.Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <window.Button
          variant="ghost"
          icon="back"
          onClick={() => {
            setErr(null);
            setTaskIndex((i) => Math.max(0, i - 1));
          }}
          disabled={taskIndex === 0}
          style={{ opacity: taskIndex === 0 ? 0.45 : 1 }}
        >
          Previous
        </window.Button>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          Use the main Save &amp; continue button for the next step.
        </span>
      </div>

      {authFor && window.AuthFlowModal && (
        <window.AuthFlowModal
          mod={mods.find((e) => e.name === authFor) || mod}
          onClose={() => setAuthFor(null)}
          onDone={() => {
            setAuthDone((s) => ({ ...s, [authFor]: true }));
            setAuthSkipped((s) => ({ ...s, [authFor]: false }));
            setAuthFor(null);
            loadConfigurable();
          }}
        />
      )}
    </div>
  );
}

function StepFinish({ data, goto }) {
  // Telegram is optional: skipping it is a deliberate, valid choice, so show it
  // as a settled "using the web panel" row (green) rather than a warning.
  const useTelegram = data.tokenState === 'ok' && data.allowlist.length > 0;
  const peopleLabel = `${data.allowlist.length} ${data.allowlist.length > 1 ? 'people' : 'person'}`;
  const rows = [
    {
      label: 'Chat model',
      value: data.chatModel || 'Not set',
      step: 1,
      ok: !!data.chatModel,
      mono: true,
    },
    { label: 'Hardware tier', value: data.tier, step: 1, ok: true, cap: true },
    { label: 'Ollama', value: data.ollamaUrl, step: 1, ok: data.ollamaState === 'ok', mono: true },
    useTelegram
      ? {
          label: 'Telegram',
          value: `${data.botName} ${data.botUser} · ${peopleLabel}`,
          step: 2,
          ok: true,
        }
      : {
          label: 'Telegram',
          value: 'Skipped — using the web panel (add it later in Settings)',
          step: 2,
          ok: true,
        },
  ];
  return (
    <div>
      <StepHead kicker="Almost there" title="Review &amp; finish">
        Here’s everything you chose. Press <b>Start Modulus</b> to save your setup and bring the
        agent online.
      </StepHead>
      <window.Card pad={0}>
        {rows.map((r, i) => (
          <div
            key={r.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '13px 16px',
              borderTop: i ? '1px solid var(--border)' : 'none',
            }}
          >
            <window.StatusDot state={r.ok ? 'ok' : 'warn'} size={7} />
            <span style={{ fontSize: 13.5, color: 'var(--text-3)', width: 130, flex: 'none' }}>
              {r.label}
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                flex: 1,
                textTransform: r.cap ? 'capitalize' : 'none',
                fontFamily: r.mono ? 'var(--font-mono)' : 'var(--font-ui)',
              }}
            >
              {r.value}
            </span>
            <button
              onClick={() => goto(r.step)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-strong)',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Edit
            </button>
          </div>
        ))}
      </window.Card>
      <div
        style={{
          display: 'flex',
          gap: 11,
          marginTop: 16,
          padding: 14,
          borderRadius: 'var(--radius)',
          border: '1px dashed var(--border-2)',
          background: 'color-mix(in oklab, var(--accent) 5%, var(--surface))',
        }}
      >
        <window.Icon
          name="shield"
          size={18}
          style={{ color: 'var(--accent-strong)', flex: 'none', marginTop: 1 }}
        />
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Your token and settings are saved only on this machine. You can change any of this later
          in Settings.
        </p>
      </div>
    </div>
  );
}

function CheckResult({ state, ok, err }) {
  if (state === 'idle' || !state) return null;
  if (state === 'checking')
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 11,
          fontSize: 13.5,
          color: 'var(--text-2)',
        }}
      >
        <window.Icon name="refresh" size={15} className="spin" /> Checking…
      </div>
    );
  if (state === 'ok')
    return (
      <div
        className="fade"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 11,
          fontSize: 13.5,
          color: 'var(--ok)',
        }}
      >
        <window.Icon name="check" size={16} /> <span>{ok}</span>
      </div>
    );
  return (
    <div
      className="fade"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        marginTop: 11,
        fontSize: 13.5,
        color: 'var(--err)',
      }}
    >
      <window.Icon name="alert" size={16} style={{ flex: 'none', marginTop: 1 }} />{' '}
      <span>{err}</span>
    </div>
  );
}

Object.assign(window, { Wizard });
