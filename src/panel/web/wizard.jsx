/* global React, window */
// First-run setup wizard. Mirrors `modulus init` but friendly, and writes the
// same config.json the CLI does. Live checks hit real endpoints:
//   token  → POST /api/telegram/validate
//   ollama → POST /api/ollama/test (then GET model tags)
//   finish → POST /api/config, then enable/disable chosen modules
// The last step hands off to the hub with the agent starting.
const { useState: useStateWiz, useEffect: useEffectWiz, useRef: useRefWiz } = React;

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'telegram', label: 'Connect Telegram' },
  { id: 'allowlist', label: 'Who can talk to it' },
  { id: 'ollama', label: 'Model server' },
  { id: 'models', label: 'Choose models' },
  { id: 'hardware', label: 'Hardware tier' },
  { id: 'modules', label: 'Modules' },
  { id: 'ext-config', label: 'Configure modules' },
  { id: 'review', label: 'Review & finish' },
];

function Wizard({ onFinish, onExit, suggestedTier, ramGb }) {
  const [step, setStep] = useStateWiz(0);
  const [saving, setSaving] = useStateWiz(false);
  const [configSaving, setConfigSaving] = useStateWiz(false);
  const [saveErr, setSaveErr] = useStateWiz(null);
  const extConfigSaveRef = useRefWiz(null);
  const [models, setModels] = useStateWiz([]);
  const [data, setData] = useStateWiz({
    token: '',
    botName: '',
    botUser: '',
    tokenState: 'idle',
    tokenErr: '',
    allowlist: [],
    ollamaUrl: 'http://localhost:11434',
    ollamaState: 'idle',
    ollamaErr: '',
    chatModel: '',
    reasoningModel: '',
    toolsModel: '',
    tier: suggestedTier || 'standard',
  });
  const set = (patch) => setData((d) => ({ ...d, ...patch }));

  const canNext = () => {
    switch (STEPS[step].id) {
      case 'telegram':
        return data.tokenState === 'ok';
      case 'allowlist':
        return data.allowlist.length > 0;
      case 'ollama':
        return data.ollamaState === 'ok';
      case 'models':
        return !!data.chatModel;
      default:
        return true;
    }
  };

  const finish = async () => {
    setSaving(true);
    setSaveErr(null);
    const body = {
      token: data.token,
      allowlist: data.allowlist,
      ollamaUrl: data.ollamaUrl,
      chatModel: data.chatModel,
      reasoningModel: data.reasoningModel,
      toolsModel: data.toolsModel,
      tier: data.tier,
    };
    const r = await window.api.post('/api/config', body);
    setSaving(false);
    if (!r.ok) {
      setSaveErr(r.error || 'Could not save your setup.');
      return;
    }
    onFinish();
  };

  const next = async () => {
    if (cur === 'ext-config') {
      if (extConfigSaveRef.current) {
        setConfigSaving(true);
        const ok = await extConfigSaveRef.current();
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
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '46px 0' }}>
          <div
            key={cur}
            className="rise"
            style={{ maxWidth: 600, margin: '0 auto', padding: '0 32px' }}
          >
            {cur === 'welcome' && <StepWelcome />}
            {cur === 'telegram' && <StepTelegram data={data} set={set} />}
            {cur === 'allowlist' && <StepAllowlist data={data} set={set} />}
            {cur === 'ollama' && (
              <StepOllama data={data} set={set} models={models} setModels={setModels} />
            )}
            {cur === 'models' && <StepModels data={data} set={set} models={models} />}
            {cur === 'hardware' && (
              <StepHardware data={data} set={set} suggestedTier={suggestedTier} ramGb={ramGb} />
            )}
            {cur === 'modules' && <StepModules />}
            {cur === 'ext-config' && <StepExtConfig saveRef={extConfigSaveRef} />}
            {cur === 'review' && <StepReview data={data} goto={setStep} />}
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
          {!canNext() && ['telegram', 'allowlist', 'ollama', 'models'].includes(cur) ? (
            <window.Button variant="default" disabled style={{ opacity: 0.55 }}>
              {cur === 'models' ? 'Pick a chat model' : 'Complete this step'}
            </window.Button>
          ) : (
            <>
              {cur === 'ext-config' && (
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
                icon={cur === 'review' ? 'power' : cur === 'ext-config' ? 'check' : 'fwd'}
                onClick={next}
                disabled={saving || configSaving}
              >
                {saving || configSaving ? (
                  <>
                    <window.Icon name="refresh" size={15} className="spin" /> Saving…
                  </>
                ) : cur === 'review' ? (
                  'Start Modulus'
                ) : cur === 'ext-config' ? (
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
      title: 'You chat through Telegram',
      desc: 'Modulus lives in your Telegram app as a bot — and you can talk to it here too.',
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
        This takes about three minutes. We’ll connect your chat app, pick a model to run on this
        machine, and choose any extras you want. You can change all of it later.
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

function StepTelegram({ data, set }) {
  const [help, setHelp] = useStateWiz(false);
  const validate = async () => {
    set({ tokenState: 'checking', tokenErr: '' });
    const r = await window.api.post('/api/telegram/validate', { token: data.token });
    if (r.ok && r.data.ok)
      set({ tokenState: 'ok', botName: r.data.botName, botUser: r.data.botUser });
    else
      set({
        tokenState: 'err',
        tokenErr: (r.data && r.data.error) || r.error || 'That doesn’t look like a valid token.',
      });
  };
  return (
    <div>
      <StepHead kicker="Step 1" title="Connect Telegram">
        Telegram is the chat app you’ll use to talk to Modulus. You need a <b>bot token</b> — a
        secret key that lets Modulus act as your personal bot.
      </StepHead>
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
    </div>
  );
}

function StepAllowlist({ data, set }) {
  const [help, setHelp] = useStateWiz(false);
  const [draft, setDraft] = useStateWiz('');
  const [err, setErr] = useStateWiz('');
  const add = () => {
    const v = draft.trim();
    if (!/^\d{4,}$/.test(v)) {
      setErr('A Telegram ID is a number, e.g. 8675309.');
      return;
    }
    if (data.allowlist.includes(v)) {
      setErr('That ID is already added.');
      return;
    }
    set({ allowlist: [...data.allowlist, v] });
    setDraft('');
    setErr('');
  };
  return (
    <div>
      <StepHead kicker="Step 2" title="Who’s allowed to talk to it?">
        For privacy, only the Telegram accounts you list here can chat with your bot. Everyone else
        is silently ignored. Add yourself first.
      </StepHead>
      <window.Label hint="Add one or more numeric Telegram user IDs.">
        Allowed user IDs
      </window.Label>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1, maxWidth: 320 }}>
          <window.Input
            mono
            value={draft}
            invalid={!!err}
            onChange={(e) => {
              setDraft(e.target.value);
              setErr('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="e.g. 8675309"
          />
        </div>
        <window.Button variant="default" icon="plus" onClick={add}>
          Add
        </window.Button>
      </div>
      {err && (
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
          <window.Icon name="alert" size={14} /> {err}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16, minHeight: 34 }}>
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
              border: '1px solid transparent',
              fontFamily: 'var(--font-mono)',
              fontSize: 13.5,
              color: 'var(--accent-strong)',
              fontWeight: 600,
            }}
          >
            {id}
            <button
              onClick={() => set({ allowlist: data.allowlist.filter((x) => x !== id) })}
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
      <HelperBox open={help} onToggle={() => setHelp((h) => !h)} title="How do I find my ID?">
        In Telegram, message <span className="mono">@userinfobot</span> and it replies with your
        numeric ID. Paste that number above.
      </HelperBox>
    </div>
  );
}

function StepOllama({ data, set, models, setModels }) {
  const test = async () => {
    set({ ollamaState: 'testing', ollamaErr: '' });
    const r = await window.api.post('/api/ollama/test', { url: data.ollamaUrl });
    if (r.ok && r.data.ok) {
      set({ ollamaState: 'ok' });
      setModels(r.data.models || []);
    } else set({ ollamaState: 'err', ollamaErr: (r.data && r.data.error) || r.error || '' });
  };
  return (
    <div>
      <StepHead kicker="Step 3" title="Local model server">
        Modulus runs its AI models with <b>Ollama</b>, a small program on this machine. Let’s make
        sure Modulus can reach it.
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
        <window.Button variant="primary" onClick={test} disabled={data.ollamaState === 'testing'}>
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
          data.ollamaErr
            ? `Couldn’t reach Ollama: ${data.ollamaErr}`
            : 'Couldn’t reach Ollama there. Is it running? Try the default http://localhost:11434.'
        }
      />
      {data.ollamaState === 'ok' && models.length > 0 && (
        <div
          className="fade"
          style={{
            marginTop: 16,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          {models.map((m, i) => (
            <div
              key={m}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                borderTop: i ? '1px solid var(--border)' : 'none',
                background: 'var(--surface)',
              }}
            >
              <window.Icon name="spark" size={15} style={{ color: 'var(--accent-strong)' }} />
              <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>
                {m}
              </span>
            </div>
          ))}
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

function StepModels({ data, set, models }) {
  return (
    <div>
      <StepHead kicker="Step 4" title="Choose your models">
        Modulus uses up to three model “slots”. You only really need the first one.
      </StepHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
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
    </div>
  );
}

function StepHardware({ data, set, suggestedTier, ramGb }) {
  const tiers = [
    {
      id: 'small',
      title: 'Small',
      desc: 'Raspberry Pi or similar. Keeps things light and fast.',
      ram: '≤ 4 GB',
    },
    {
      id: 'standard',
      title: 'Standard',
      desc: 'A mini PC or laptop. A good balance for most people.',
      ram: '4–16 GB',
    },
    {
      id: 'heavy',
      title: 'Heavy',
      desc: 'A powerful desktop. Run bigger models and reasoning.',
      ram: '16 GB+',
    },
  ];
  const sug = suggestedTier || 'standard';
  return (
    <div>
      <StepHead kicker="Step 5" title="How powerful is this machine?">
        {ramGb != null ? (
          <>
            We detected <b>{ramGb} GB of RAM</b> and suggest{' '}
            <b style={{ textTransform: 'capitalize' }}>{sug}</b>.
          </>
        ) : (
          <>
            We suggest <b style={{ textTransform: 'capitalize' }}>{sug}</b>.
          </>
        )}{' '}
        This just helps Modulus pick sensible defaults — change it if you know better.
      </StepHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {tiers.map((t) => {
          const on = data.tier === t.id;
          return (
            <button
              key={t.id}
              onClick={() => set({ tier: t.id })}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: 16,
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                textAlign: 'left',
                background: on ? 'var(--accent-soft)' : 'var(--surface)',
                border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                transition: 'all .15s',
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 99,
                  flex: 'none',
                  border: `2px solid ${on ? 'var(--accent)' : 'var(--border-2)'}`,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                {on && (
                  <span
                    style={{ width: 10, height: 10, borderRadius: 99, background: 'var(--accent)' }}
                  />
                )}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: 15.5 }}>{t.title}</span>
                  {t.id === sug && <window.Badge tone="accent">Suggested</window.Badge>}
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>{t.desc}</p>
              </div>
              <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                {t.ram}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepModules() {
  const [exts, setExts] = useStateWiz(null);
  const [busy, setBusy] = useStateWiz(null);
  // Per-module toggle result so the user can see whether the post-enable
  // setup (downloads, package-manager installs) actually succeeded — silently
  // failing here is what burned us with whisper.cpp on Windows.
  const [results, setResults] = useStateWiz({});
  const [openDetails, setOpenDetails] = useStateWiz({});
  // Two-phase modal for modulus-voice: 'warn' lists what'll be downloaded;
  // 'streaming' tails live setup output via SSE; 'done' shows the result.
  // Null = no modal. Voice gets the special treatment because its setup
  // pulls ~300 MB (Piper + voice model + whisper binary + whisper model) and
  // a frozen "Setting up…" spinner reads as broken on slow links.
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
  // Open the SSE stream and tail lines into the modal. Closing the modal mid-
  // stream cancels the EventSource (the server already started the work — we
  // don't try to roll it back; the result reflects whatever finished). The
  // 'done' event resolves the modal into either success or failure state.
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
        // EventSource auto-reconnects; that's harmful here (work would re-run).
        // Treat any error as a terminal failure and bail.
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
  const blurb = (e) => (window.EXT_BLURBS && window.EXT_BLURBS[e.name]) || e.description || '';
  return (
    <div>
      <StepHead kicker="Step 6" title="Pick your modules">
        Turn on the capabilities you want now, or skip and add them later from the Modules tab.
        Codex and Everyday Assistant will walk you through connection on the next step.
      </StepHead>
      {exts === null && (
        <div style={{ fontSize: 13.5, color: 'var(--text-3)' }}>Loading modules…</div>
      )}
      {exts && exts.length === 0 && (
        <div style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
          No modules are installed yet. You can add them later with{' '}
          <span className="mono">modulus ext install</span>.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(exts || []).map((e) => {
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
                <ExtResultPanel
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

// Two-stage modal for the modulus-voice setup. 'warn' previews the downloads
// so a user on a metered connection can back out; 'streaming' tails live setup
// output (clicks-outside disabled — closing mid-download would leave half-
// installed binaries); 'done' shows success/failure and frees the user.
function VoiceSetupModal({ stage, lines, ok, onConfirm, onClose }) {
  // No-op while streaming so backdrop clicks / Escape don't kill the SSE.
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

// Render the post-toggle setup result. Success collapses to a single line;
// failure shows the install log inline so the user can act on it (most
// commonly: missing winget/sudo, or a download URL they can hit manually).
function ExtResultPanel({ ok, output, action, open, onToggle }) {
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

function StepExtConfig({ saveRef }) {
  const [exts, setExts] = useStateWiz(null);
  const [vals, setVals] = useStateWiz({});
  const [taskIndex, setTaskIndex] = useStateWiz(0);
  const [authFor, setAuthFor] = useStateWiz(null);
  const [authDone, setAuthDone] = useStateWiz({});
  const [authSkipped, setAuthSkipped] = useStateWiz({});
  const [err, setErr] = useStateWiz(null);

  const authGuided = new Set(['modulus-codex', 'modulus-everyday-assistant']);
  const authManagedKeys = {
    'modulus-codex': new Set([
      'codex_access_token',
      'codex_refresh_token',
      'codex_id_token',
      'codex_expires_at',
      'codex_account_id',
    ]),
    'modulus-everyday-assistant': new Set([
      'google_client_id',
      'google_client_secret',
      'google_refresh_token',
    ]),
  };

  const prettyExtName = (name) =>
    name
      .replace(/^modulus-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const initials = (name) =>
    prettyExtName(name)
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
      if (shouldGuideAuth(e)) tasks.push({ type: 'auth', ext: e, key: `${e.name}:auth` });
      for (const f of e.schema || []) {
        if (!isAuthManagedField(e, f)) {
          tasks.push({ type: 'setting', ext: e, field: f, key: `${e.name}:${f.key}` });
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

  const tasks = buildTasks(exts);
  const currentTask = tasks[Math.min(taskIndex, Math.max(tasks.length - 1, 0))];
  const atLastTask = taskIndex >= tasks.length - 1;

  const saveCurrentSetting = async () => {
    if (!currentTask || currentTask.type !== 'setting') return true;
    const ext = currentTask.ext;
    const field = currentTask.field;
    const r = await window.api.post(`/api/modules/${encodeURIComponent(ext.name)}/settings`, {
      [field.key]: (vals[ext.name] || {})[field.key] ?? '',
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
      const name = currentTask.ext.name;
      if (!currentTask.ext.authConnected && !authDone[name] && !authSkipped[name]) {
        setErr(`Connect ${prettyExtName(name)} or skip this connection before continuing.`);
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
    const e = task.ext;
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

  if (exts === null) {
    return (
      <div>
        <StepHead kicker="Step 7" title="Configure your modules">
          Loading module settings...
        </StepHead>
      </div>
    );
  }

  if (exts.length === 0 || tasks.length === 0) {
    return (
      <div>
        <StepHead kicker="Step 7" title="Configure your modules">
          Everything you enabled is ready with its defaults - click <b>Save &amp; continue</b> to
          move on.
        </StepHead>
      </div>
    );
  }

  const task = currentTask;
  const ext = task.ext;
  const connected = task.type === 'auth' && (ext.authConnected || authDone[ext.name]);

  return (
    <div>
      <StepHead kicker="Step 7" title="Configure your modules">
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
            {initials(ext.name)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{prettyExtName(ext.name)}</div>
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
                Connect {prettyExtName(ext.name)}
              </window.Label>
              <p
                style={{
                  fontSize: 14,
                  color: 'var(--text-2)',
                  lineHeight: 1.55,
                  marginBottom: 14,
                }}
              >
                {ext.name === 'modulus-codex'
                  ? 'Sign in with your ChatGPT subscription so Modulus can hand hard tasks to Codex.'
                  : 'Connect Google once so Calendar, Tasks, reminders, and briefings can work.'}
              </p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <window.Button
                  variant={connected ? 'ok' : 'primary'}
                  icon={connected ? 'check' : 'link'}
                  onClick={() => setAuthFor(ext.name)}
                >
                  {connected ? 'Connected' : `Connect ${prettyExtName(ext.name)}`}
                </window.Button>
                {!connected && (
                  <window.Button
                    variant="ghost"
                    onClick={() => {
                      setErr(null);
                      setAuthSkipped((s) => ({ ...s, [ext.name]: true }));
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
          ext={exts.find((e) => e.name === authFor) || ext}
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

function StepReview({ data, goto }) {
  const rows = [
    {
      label: 'Telegram bot',
      value: data.botName ? `${data.botName} ${data.botUser}` : 'Not connected',
      step: 1,
      ok: data.tokenState === 'ok',
    },
    {
      label: 'Allowlist',
      value: data.allowlist.length
        ? `${data.allowlist.length} user${data.allowlist.length > 1 ? 's' : ''}`
        : 'None',
      step: 2,
      ok: data.allowlist.length > 0,
    },
    { label: 'Ollama', value: data.ollamaUrl, step: 3, ok: data.ollamaState === 'ok' },
    { label: 'Chat model', value: data.chatModel || 'Not set', step: 4, ok: !!data.chatModel },
    { label: 'Reasoning model', value: data.reasoningModel || 'Skipped', step: 4, ok: true },
    {
      label: 'Tools model',
      value: data.toolsModel || `${data.chatModel || 'Chat model'} (fallback)`,
      step: 4,
      ok: true,
    },
    { label: 'Hardware tier', value: data.tier, step: 5, ok: true, cap: true },
  ];
  return (
    <div>
      <StepHead kicker="Almost there" title="Review &amp; finish">
        Here’s everything you chose. Press <b>Start Modulus</b> to save your setup and land in the
        hub with the agent coming online.
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
                fontFamily:
                  r.label.includes('model') || r.label === 'Ollama'
                    ? 'var(--font-mono)'
                    : 'var(--font-ui)',
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
