/* global React, window */
// Settings tab — Modulus Core config in friendly forms (GET/POST /api/config).
// Values that are pinned by an environment variable show a "set by environment"
// lock and are read-only here, mirroring how effectiveConfig() lets env vars
// win over the on-disk config.json. Changes are staged locally and written with
// one Save; they take effect on the next agent restart.
const { useState: useStateSet, useEffect: useEffectSet } = React;
const FRONTEND_EXT_NAME = 'modulus-frontend';

function SettingsTab({ onReRunWizard, onSaved }) {
  const [cfg, setCfg] = useStateSet(null);
  const [error, setError] = useStateSet(null);
  const [dirty, setDirty] = useStateSet(false);
  const [saving, setSaving] = useStateSet(false);
  const [saved, setSaved] = useStateSet(false);
  const [models, setModels] = useStateSet([]);

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
      chatModel: cfg.chatModel,
      reasoningModel: cfg.reasoningModel,
      toolsModel: cfg.toolsModel,
      tier: cfg.tier,
      logLevel: cfg.logLevel,
      instantResponses: cfg.instantResponses,
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
          sub="Everything in Modulus Core's config, in plain language. Changes apply on the next restart."
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
          <HardwareSection cfg={cfg} set={set} locks={locks} />
          <BehaviourSection cfg={cfg} set={set} />
          <LoggingSection cfg={cfg} set={set} locks={locks} />
          <MemoryBrowserSection />
          <FrontendSection onSaved={onSaved} />
        </div>
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

function ModelServerSection({ cfg, set, locks, models, setModels }) {
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
    <Group icon="spark" title="Models" desc="Modulus uses up to three model “slots”.">
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

function BehaviourSection({ cfg, set }) {
  // cfg.instantResponses arrives from /api/config as a plain boolean and is
  // saved back through the shared config save() with the other fields.
  const on = cfg.instantResponses !== false;
  return (
    <Group icon="spark" title="Behaviour" desc="How Modulus replies before a slow turn finishes.">
      <div>
        <window.Label hint="Acknowledge instantly when a reply is predicted slow (reasoning, delegation), then stream the real answer when it’s ready — no extra model call for the ack.">
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
  const [error, setError] = useStateSet(null);
  const [busy, setBusy] = useStateSet(false);

  const load = async (q) => {
    setBusy(true);
    const trimmed = (q || '').trim();
    const path = trimmed ? `/api/memory?q=${encodeURIComponent(trimmed)}` : '/api/memory';
    const r = await window.api.get(path);
    setBusy(false);
    if (r.ok && r.data) {
      setMemories(Array.isArray(r.data.memories) ? r.data.memories : []);
      setTotal(typeof r.data.total === 'number' ? r.data.total : 0);
      setError(null);
    } else setError((r.data && r.data.error) || r.error || 'Could not load memories.');
  };

  useEffectSet(() => {
    load('');
  }, []);

  const remove = async (id) => {
    const r = await window.api.del(`/api/memory/${id}`);
    if (r.ok) {
      setMemories((m) => (m ? m.filter((x) => x.id !== id) : m));
      setTotal((t) => (query.trim() ? t : Math.max(0, t - 1)));
    } else setError((r.data && r.data.error) || r.error || 'Could not delete that memory.');
  };

  const clearSearch = () => {
    setQuery('');
    load('');
  };

  return (
    <div>
      <window.SectionTitle sub="Everything Modulus has remembered — one store shared by the main chat and every agent. Search to filter; delete to forget.">
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
      `/api/extensions/${encodeURIComponent(FRONTEND_EXT_NAME)}/settings`,
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
      `/api/extensions/${encodeURIComponent(FRONTEND_EXT_NAME)}/settings`,
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
