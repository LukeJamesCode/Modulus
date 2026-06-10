// Chat Hub — the home screen. A hero control bar (start/stop/restart/new-chat/
// proactive/devmode) over a live direct-chat column and a right-hand activity
// strip.
//
// The chat talks to POST /api/chat, which streams through Modulus's orchestrator:
// same profile routing, tools, history, and guardrails as Telegram. It has full
// parity with the Telegram surface: confirm-tier tools (Codex) pop an inline
// approval card, module/core commands run via /api/command and surface as
// buttons, and voice flows both ways (mic → /api/chat/voice-in transcription,
// spoken replies stream back as a `voice` SSE event and autoplay).
const { useState: useStateCH, useRef: useRefCH, useEffect: useEffectCH } = React;

function useDevmode() {
  const [devmode, setDevmode] = useStateCH(() => {
    try {
      return localStorage.getItem('modulus_devmode') === 'true';
    } catch {
      return false;
    }
  });
  useEffectCH(() => {
    try {
      localStorage.setItem('modulus_devmode', devmode ? 'true' : 'false');
    } catch {
      /* ignore */
    }
  }, [devmode]);
  return [devmode, setDevmode];
}

// Persist rendered chat bubbles across reloads. Server-side `chatHistory` (the
// LLM context) already survives the reload because the panel and the agent
// share a process — what gets lost is the rendered view. Cap the saved log so
// a long session can't blow out localStorage quota.
const CHAT_LOG_KEY = 'modulus_chat_messages';
const CHAT_LOG_MAX = 200;
function loadStoredMessages() {
  try {
    const raw = localStorage.getItem(CHAT_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveStoredMessages(messages) {
  try {
    const trimmed = messages.length > CHAT_LOG_MAX ? messages.slice(-CHAT_LOG_MAX) : messages;
    localStorage.setItem(CHAT_LOG_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota or serialization — silently drop persistence */
  }
}

// Per-turn think toggle, remembered across reloads. 'auto' lets each model use
// its default; 'on'/'off' force reasoning for thinking-capable models (qwen3,
// gemma4) and are a no-op on models without a thinking mode.
const THINK_KEY = 'modulus_think_mode';
function loadThinkMode() {
  try {
    const v = localStorage.getItem(THINK_KEY);
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function ChatHub({
  agent,
  onStart,
  onStop,
  onRestart,
  proactive,
  onProactive,
  health,
  activeModel,
  lastError,
  busy,
  scheduler,
  activity,
  modules,
  tier,
  allowlistCount,
}) {
  const running = agent === 'running';
  const [messages, setMessages] = useStateCH(loadStoredMessages);
  const [draft, setDraft] = useStateCH('');
  const [phase, setPhase] = useStateCH('idle'); // idle | streaming | command
  const [streamText, setStreamText] = useStateCH('');
  const [streamThink, setStreamThink] = useStateCH('');
  const [commands, setCommands] = useStateCH({ core: [], modules: [] });
  const [confirmReq, setConfirmReq] = useStateCH(null); // { id, prompt, tool }
  const [thinkMode, setThinkMode] = useStateCH(loadThinkMode); // 'auto' | 'on' | 'off'
  const [devmode, setDevmode] = useDevmode();
  const scrollRef = useRefCH(null);
  const streamRef = useRefCH(null); // active postStream handle (for abort)
  const inputRef = useRefCH(null);
  // File/image/PDF uploads for the next turn. null = don't block visual drops
  // up front; the server gates images on the chat model and reports any skips.
  const att = window.useAttachments(null);

  useEffectCH(
    () => () => {
      if (streamRef.current) streamRef.current.abort();
    },
    [],
  );

  useEffectCH(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, streamThink, phase, confirmReq]);

  useEffectCH(() => {
    saveStoredMessages(messages);
  }, [messages]);

  useEffectCH(() => {
    try {
      localStorage.setItem(THINK_KEY, thinkMode);
    } catch {
      /* quota — non-fatal, toggle just won't persist */
    }
  }, [thinkMode]);

  // Pull the live command reference (core + enabled module commands) so the
  // command bar can surface buttons. Refreshes whenever the agent comes up or
  // the installed-module count changes.
  useEffectCH(() => {
    if (!running) return;
    let cancelled = false;
    window.api.get('/api/commands').then((r) => {
      if (!cancelled && r.ok && r.data) {
        setCommands({ core: r.data.core || [], modules: r.data.modules || [] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [running, modules && modules.enabled]);

  // Append a synthesized voice clip to the most recent assistant bubble.
  const attachVoice = (id) => {
    setMessages((m) => {
      for (let i = m.length - 1; i >= 0; i--) {
        if (m[i].role === 'assistant' && !m[i].voice) {
          const copy = m.slice();
          copy[i] = { ...copy[i], voice: id };
          return copy;
        }
      }
      return m;
    });
  };

  // Stream a normal (non-slash) message through the orchestrator.
  const stream = (text) => {
    // Snapshot the staged batch for this turn, then clear so the next message
    // starts fresh (the server deletes the batch once the turn reads it).
    const stageToken = att.token;
    const attachLabels = att.staged.map((f) => f.rel);
    att.clear();
    setMessages((m) => [
      ...m,
      {
        id: Date.now(),
        role: 'user',
        text: text || '📎 ' + attachLabels.join(', '),
        time: now(),
        ...(attachLabels.length ? { attachments: attachLabels } : {}),
      },
    ]);
    setPhase('streaming');
    setStreamText('');
    setStreamThink('');

    const startedAt = Date.now();
    let acc = '';
    let thinkAcc = '';
    let metaAcc = null;
    streamRef.current = window.api.postStream(
      '/api/chat',
      { text, thinkMode, ...(stageToken ? { stageToken } : {}) },
      {
        onEvent: (ev, data) => {
          if (ev === 'delta' && data && data.delta) {
            acc += data.delta;
            setStreamText(acc);
          } else if (ev === 'thinking' && data && data.thinking) {
            thinkAcc += data.thinking;
            setStreamThink(thinkAcc);
          } else if (ev === 'replace' && data && typeof data.text === 'string') {
            acc = data.text;
            setStreamText(acc);
          } else if (ev === 'meta' && data) {
            metaAcc = data;
          } else if (ev === 'confirm' && data && data.id) {
            setConfirmReq({ id: data.id, prompt: data.prompt, tool: data.tool });
          } else if (ev === 'instant' && data && typeof data.text === 'string') {
            // A finished reply from an module intercept (instant-responses):
            // land it as its own bubble immediately.
            setMessages((m) => [
              ...m,
              {
                id: Date.now() + Math.random(),
                role: 'assistant',
                text: data.text,
                time: now(),
                elapsedMs: Date.now() - startedAt,
              },
            ]);
          } else if (ev === 'voice' && data && data.id) {
            attachVoice(data.id);
          } else if (ev === 'done') {
            const finalText = (data && data.text) || acc;
            if (finalText || thinkAcc) {
              setMessages((m) => [
                ...m,
                {
                  id: Date.now(),
                  role: 'assistant',
                  text: finalText,
                  time: now(),
                  meta: metaAcc,
                  ...(thinkAcc ? { thinking: thinkAcc } : {}),
                  elapsedMs: Date.now() - startedAt,
                },
              ]);
            }
            setStreamText('');
            setStreamThink('');
            setConfirmReq(null);
            setPhase('idle');
            // Don't null the handle — the stream stays open briefly for a
            // trailing `voice` event from afterReply. It closes on its own.
          } else if (ev === 'error') {
            setMessages((m) => [
              ...m,
              {
                id: Date.now(),
                role: 'assistant',
                text: '⚠️ ' + ((data && data.message) || 'The model could not be reached.'),
                time: now(),
                error: true,
              },
            ]);
            setStreamText('');
            setStreamThink('');
            setConfirmReq(null);
            setPhase('idle');
            streamRef.current = null;
          }
        },
      },
    );
    streamRef.current.done
      .catch(() => {})
      .finally(() => {
        // The stream is fully over once `done` resolves (server closes it after
        // afterReply voice). Force idle as a safety net for an abnormal close
        // that never emitted a `done`/`error` event. `setPhase`'s updater form
        // avoids clobbering a phase a later turn may have set.
        setStreamText('');
        setStreamThink('');
        setPhase((p) => (p === 'streaming' ? 'idle' : p));
        streamRef.current = null;
      });
  };

  // Run a slash command line (e.g. "/codex fix this") — the web parity of the
  // Telegram command dispatch. newchat/stop map to the existing controls.
  const runCommandLine = async (line) => {
    const sp = line.indexOf(' ');
    const head = (sp === -1 ? line.slice(1) : line.slice(1, sp)).trim();
    const args = sp === -1 ? '' : line.slice(sp + 1).trim();
    const low = head.toLowerCase();
    if (low === 'newchat') return newChat();
    if (low === 'stop') return abort();
    setMessages((m) => [...m, { id: Date.now(), role: 'user', text: line, time: now() }]);
    setPhase('command');
    const startedAt = Date.now();
    const r = await window.api.post('/api/command', { name: head, args });
    const elapsedMs = Date.now() - startedAt;
    setPhase('idle');
    const replies = r.ok && r.data && Array.isArray(r.data.replies) ? r.data.replies : [];
    if (replies.length > 0) {
      setMessages((m) => [
        ...m,
        ...replies.map((t) => ({
          id: Date.now() + Math.random(),
          role: 'assistant',
          text: t,
          time: now(),
          elapsedMs,
        })),
      ]);
    } else {
      const err = (r.data && r.data.error) || r.error || 'Command produced no output.';
      setMessages((m) => [
        ...m,
        {
          id: Date.now(),
          role: 'assistant',
          text: '⚠️ ' + err,
          time: now(),
          error: true,
          elapsedMs,
        },
      ]);
    }
  };

  // Single entry point for sending — handles slash commands and plain messages.
  const submit = (raw) => {
    const text = (raw || '').trim();
    // An attachments-only turn (no typed text) is allowed once a file has staged.
    if ((!text && !att.staged.length) || !running || phase !== 'idle') return;
    setDraft('');
    if (text.startsWith('/')) {
      runCommandLine(text);
      return;
    }
    stream(text);
  };
  const send = () => submit(draft);

  // Run a command from a button. No-arg commands fire immediately; commands that
  // take arguments prefill the input so the user can type the rest.
  const runCommandButton = (cmd, desc) => {
    const name = cmd.replace(/^\//, '');
    if (commandNeedsArgs(desc)) {
      setDraft('/' + name + ' ');
      if (inputRef.current) inputRef.current.focus();
    } else {
      submit('/' + name);
    }
  };

  const answerConfirm = async (ok) => {
    const req = confirmReq;
    setConfirmReq(null);
    if (req) await window.api.post('/api/chat/confirm', { id: req.id, ok });
  };

  const abort = () => {
    if (streamRef.current) {
      streamRef.current.abort();
      streamRef.current = null;
    }
    if (streamText)
      setMessages((m) => [
        ...m,
        {
          id: Date.now(),
          role: 'assistant',
          text: streamText,
          time: now(),
          ...(streamThink ? { thinking: streamThink } : {}),
        },
      ]);
    setStreamText('');
    setStreamThink('');
    setConfirmReq(null);
    setPhase('idle');
  };
  const newChat = () => {
    if (streamRef.current) {
      streamRef.current.abort();
      streamRef.current = null;
    }
    setStreamText('');
    setStreamThink('');
    setConfirmReq(null);
    setPhase('idle');
    setMessages([]);
    window.api.post('/api/chat/clear');
  };

  // Mic → transcript → auto-send (so a spoken reply can follow via afterReply).
  const onTranscript = (transcript) => {
    if (transcript && transcript.trim()) submit(transcript.trim());
  };

  const streaming = phase === 'streaming' || phase === 'command';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <AgentControlBar
        agent={agent}
        busy={busy}
        onStart={onStart}
        onStop={onStop}
        proactive={proactive}
        onProactive={onProactive}
        devmode={devmode}
        onDevmode={setDevmode}
        onRestart={() => {
          newChat();
          onRestart();
        }}
        onNewChat={newChat}
        onAbort={abort}
        streaming={streaming}
      />

      <OverviewGrid
        agent={agent}
        health={health}
        activeModel={activeModel}
        scheduler={scheduler}
        modules={modules}
        tier={tier}
        allowlistCount={allowlistCount}
      />

      <div
        style={{ display: 'flex', gap: calc(12), flex: 1, minHeight: 0, marginTop: calc(12) }}
        className="chat-grid"
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flex: 'none',
            }}
          >
            <window.Icon name="chat" size={17} style={{ color: 'var(--text-3)' }} />
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>Direct chat</span>
            <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              — full tool use, commands &amp; voice{activeModel ? ` · ${activeModel}` : ''}
            </span>
          </div>

          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 14,
              minHeight: 120,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {messages.length === 0 && phase === 'idle' && (
              <EmptyChat running={running} onPrompt={setDraft} />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 'auto' }}>
              {messages.map((m) => (
                <Bubble key={m.id} m={m} devmode={devmode} />
              ))}
              {phase === 'streaming' && !streamText && !streamThink && !confirmReq && (
                <Thinking label="Thinking…" />
              )}
              {phase === 'command' && <Thinking label="Running command…" />}
              {phase === 'streaming' && streamThink && (
                <ThinkingBlock text={streamThink} live={!streamText} />
              )}
              {phase === 'streaming' && streamText && (
                <Bubble m={{ role: 'assistant', text: streamText, time: now() }} streaming />
              )}
              {confirmReq && <ConfirmCard req={confirmReq} onAnswer={answerConfirm} />}
            </div>
          </div>

          <div
            style={{
              padding: 14,
              borderTop: '1px solid var(--border)',
              flex: 'none',
              background: 'var(--surface)',
            }}
          >
            {!running && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                  color: 'var(--text-3)',
                  fontSize: 13,
                }}
              >
                <window.StatusDot state="stopped" /> Agent is stopped — start it to send messages.
              </div>
            )}
            {running && (
              <CommandBar
                commands={commands}
                disabled={phase !== 'idle'}
                onCommand={runCommandButton}
              />
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
                fontSize: 12,
                color: 'var(--text-dim)',
              }}
              title="Reasoning mode for thinking-capable models (qwen3, gemma4). No-op on models without a thinking mode."
            >
              <span>Reasoning</span>
              <window.Segmented
                size="sm"
                value={thinkMode}
                onChange={setThinkMode}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'on', label: 'Think' },
                  { value: 'off', label: 'No-think' },
                ]}
              />
            </div>
            {att.files.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <window.AttachChips files={att.files} onRemove={att.remove} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <window.AttachButton
                onPick={att.addFiles}
                openUp
                disabled={!running}
                title="Attach files, a folder, images, or PDFs"
              />
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  running ? 'Message Modulus…  (try /help or /codex)' : 'Start the agent to chat'
                }
                disabled={!running}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--accent)';
                  e.target.style.boxShadow = '0 0 0 3px var(--accent-ring)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--border-2)';
                  e.target.style.boxShadow = 'none';
                }}
                style={{
                  flex: 1,
                  resize: 'none',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 14.5,
                  lineHeight: 1.5,
                  color: 'var(--text)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-2)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '11px 14px',
                  outline: 'none',
                  maxHeight: 140,
                  minHeight: 44,
                  transition: 'border-color .15s, box-shadow .15s',
                  opacity: running ? 1 : 0.6,
                }}
              />
              <MicButton
                running={running}
                disabled={phase !== 'idle'}
                onTranscript={onTranscript}
              />
              {streaming ? (
                <window.Button variant="subtle" icon="stop" onClick={abort} style={{ height: 44 }}>
                  Stop
                </window.Button>
              ) : (
                <window.Button
                  variant="primary"
                  icon="send"
                  onClick={send}
                  disabled={!running || att.staging || (!draft.trim() && !att.staged.length)}
                  style={{
                    height: 44,
                    opacity:
                      !running || att.staging || (!draft.trim() && !att.staged.length) ? 0.5 : 1,
                  }}
                >
                  Send
                </window.Button>
              )}
            </div>
          </div>
        </div>

        <ActivityStrip
          agent={agent}
          health={health}
          activeModel={activeModel}
          phase={phase}
          lastError={lastError}
          activity={activity}
        />
      </div>
    </div>
  );
}

function now() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
}
function calc(px) {
  return `calc(${px}px * var(--gap))`;
}

// Heuristic: does a command take arguments? "<task>" or an "on|off" style hint
// in the description means yes (prefill), otherwise it's a no-arg command (run).
function commandNeedsArgs(desc) {
  if (!desc) return false;
  return desc.includes('<') || /\b\w+\|\w+/.test(desc);
}

/* ---- command bar: core + module command buttons ---- */
function CommandBar({ commands, disabled, onCommand }) {
  const core = (commands.core || []).filter((c) =>
    ['/help', '/status', '/model', '/modules'].includes(c.cmd),
  );
  const mods = commands.modules || [];
  if (core.length === 0 && mods.length === 0) return null;
  const chip = (c, accent) => (
    <button
      key={c.cmd}
      className="prompt-chip"
      disabled={disabled}
      title={c.desc || c.cmd}
      onClick={() => onCommand(c.cmd, c.desc)}
      style={{
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        ...(accent ? { borderColor: 'var(--accent)', color: 'var(--accent-strong)' } : {}),
      }}
    >
      <window.Icon name={accent ? 'plug' : 'terminal'} size={12} />
      {c.cmd}
    </button>
  );
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 7,
        marginBottom: 10,
        alignItems: 'center',
      }}
    >
      {mods.map((c) => chip(c, true))}
      {mods.length > 0 && core.length > 0 && (
        <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 2px' }} />
      )}
      {core.map((c) => chip(c, false))}
    </div>
  );
}

/* ---- confirm-tier tool approval card ---- */
function ConfirmCard({ req, onAnswer }) {
  return (
    <div
      className="rise"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '88%',
        border: '1px solid color-mix(in oklab, var(--warn) 45%, var(--border))',
        background: 'color-mix(in oklab, var(--warn) 9%, var(--surface-2))',
        borderRadius: 14,
        borderBottomLeftRadius: 4,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <window.Icon name="shield" size={15} style={{ color: 'var(--warn)' }} />
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>Approval needed</span>
        {req.tool && (
          <span
            className="mono"
            style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}
          >
            {req.tool}
          </span>
        )}
      </div>
      <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
        {req.prompt}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <window.Button variant="primary" icon="check" size="sm" onClick={() => onAnswer(true)}>
          Approve
        </window.Button>
        <window.Button variant="subtle" icon="stop" size="sm" onClick={() => onAnswer(false)}>
          Decline
        </window.Button>
      </div>
    </div>
  );
}

/* ---- mic button: record → /api/chat/voice-in → transcript ---- */
function MicButton({ running, disabled, onTranscript }) {
  const [state, setState] = useStateCH('idle'); // idle | recording | working
  const recorderRef = useRefCH(null);
  const chunksRef = useRefCH([]);
  const startedRef = useRefCH(0);

  const supported =
    typeof MediaRecorder !== 'undefined' &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia;
  if (!supported) return null;

  const stop = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  };

  const start = async () => {
    try {
      const streamMedia = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : '';
      const rec = mime
        ? new MediaRecorder(streamMedia, { mimeType: mime })
        : new MediaRecorder(streamMedia);
      chunksRef.current = [];
      startedRef.current = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        streamMedia.getTracks().forEach((t) => t.stop());
        const ms = Date.now() - startedRef.current;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        setState('working');
        const r = await window.api.postBlob(
          '/api/chat/voice-in?ms=' + ms,
          blob,
          rec.mimeType || 'audio/webm',
        );
        setState('idle');
        if (r.ok && r.data && r.data.ok && r.data.transcript) {
          onTranscript(r.data.transcript);
        } else {
          const msg = (r.data && r.data.error) || r.error || 'Could not transcribe.';
          window.alert(msg);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setState('recording');
    } catch {
      setState('idle');
      window.alert('Microphone access was denied or unavailable.');
    }
  };

  const onClick = () => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  };

  const recording = state === 'recording';
  return (
    <window.Button
      variant={recording ? 'primary' : 'subtle'}
      icon={state === 'working' ? 'refresh' : 'mic'}
      onClick={onClick}
      disabled={!running || (disabled && state === 'idle') || state === 'working'}
      title={recording ? 'Stop recording' : 'Record a voice message'}
      style={{
        height: 44,
        ...(recording ? { borderColor: 'var(--err)', color: 'var(--err)' } : {}),
      }}
    >
      {recording ? 'Stop' : ''}
    </window.Button>
  );
}

function OverviewGrid({ agent, health, activeModel, scheduler, modules, tier, allowlistCount }) {
  const running = agent === 'running';
  const tiles = [
    {
      icon: 'power',
      label: 'Agent',
      value: running
        ? 'Running'
        : agent === 'stopping'
          ? 'Stopping'
          : agent === 'starting'
            ? 'Starting'
            : 'Stopped',
      detail: `${allowlistCount ?? 0} allowed user${allowlistCount === 1 ? '' : 's'}`,
      dot: running
        ? 'running'
        : agent === 'starting' || agent === 'stopping'
          ? 'starting'
          : 'stopped',
    },
    {
      icon: 'terminal',
      label: 'Model',
      value: activeModel || 'Not selected',
      detail: tier ? `${tier} tier` : 'hardware tier pending',
      mono: true,
      dot: health.ollama ? 'ok' : 'err',
    },
    {
      icon: 'plug',
      label: 'Modules',
      value: `${modules?.enabled ?? 0} enabled`,
      detail: `${modules?.installed ?? 0} installed`,
      dot: (modules?.enabled ?? 0) > 0 ? 'ok' : 'stopped',
    },
    {
      icon: 'pulse',
      label: 'Scheduler',
      value: scheduler ? `${scheduler.jobs ?? 0} jobs` : 'Idle',
      detail: scheduler ? `${scheduler.nudgesSent ?? 0} nudges sent` : 'no metrics yet',
      dot: scheduler && scheduler.jobs > 0 ? 'ok' : 'stopped',
    },
  ];
  return (
    <div className="overview-grid">
      {tiles.map((t) => (
        <div key={t.label} className="overview-tile">
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--text-3)',
              flex: 'none',
            }}
          >
            <window.Icon name={t.icon} size={16} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12,
                color: 'var(--text-3)',
                fontWeight: 600,
              }}
            >
              <window.StatusDot state={t.dot} size={7} pulse={t.dot === 'running'} />
              {t.label}
            </div>
            <div
              style={{
                marginTop: 4,
                fontWeight: 700,
                fontSize: 14,
                fontFamily: t.mono ? 'var(--font-mono)' : 'var(--font-ui)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={t.value}
            >
              {t.value}
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 12,
                color: 'var(--text-3)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {t.detail}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Agent control bar (hero) ---- */
function AgentControlBar({
  agent,
  busy,
  onStart,
  onStop,
  proactive,
  onProactive,
  devmode,
  onDevmode,
  onRestart,
  onNewChat,
}) {
  const running = agent === 'running';
  const stopping = agent === 'stopping';
  const starting = agent === 'starting' || (!!busy && !stopping);
  const transitioning = starting || stopping;
  const label =
    {
      running: 'Running',
      stopped: 'Stopped',
      starting: 'Starting…',
      stopping: 'Stopping…',
      error: 'Error',
    }[agent] || 'Stopped';
  const sub =
    {
      running: 'Modulus is live and answering messages on Telegram.',
      stopped: 'The agent is not running. Start it to begin answering messages.',
      starting: 'Bringing the agent online…',
      stopping: 'Taking the agent offline…',
      error: 'Something went wrong starting the agent. Check Diagnostics.',
    }[agent] || 'The agent is not running.';

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: calc(13),
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 240 }}>
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            flex: 'none',
            display: 'grid',
            placeItems: 'center',
            background: running
              ? 'var(--accent-soft)'
              : transitioning
                ? 'color-mix(in oklab, var(--warn) 16%, transparent)'
                : agent === 'error'
                  ? 'color-mix(in oklab, var(--err) 13%, transparent)'
                  : 'var(--surface-2)',
            color: running
              ? 'var(--accent-strong)'
              : transitioning
                ? 'var(--warn)'
                : agent === 'error'
                  ? 'var(--err)'
                  : 'var(--text-3)',
            border: '1px solid var(--border)',
          }}
        >
          {transitioning ? (
            <window.Icon name="refresh" size={22} className="spin" />
          ) : (
            <window.Icon name="power" size={22} />
          )}
        </span>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <window.StatusDot
              state={transitioning ? 'starting' : agent}
              size={10}
              pulse={running}
            />
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 0 }}>
              {stopping ? 'Stopping…' : starting ? 'Starting…' : label}
            </span>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 3, maxWidth: 380 }}>{sub}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
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
          <window.Toggle checked={proactive} onChange={onProactive} label="Proactive nudges" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Proactive</span>
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
          title="Append model, timing, and tool activity under each reply."
        >
          <window.Toggle checked={devmode} onChange={onDevmode} label="Dev mode diagnostics" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Dev mode</span>
        </div>
        <window.Button
          variant="ghost"
          size="sm"
          icon="plus"
          onClick={onNewChat}
          title="Clear the conversation and start fresh"
        >
          New chat
        </window.Button>
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
      </div>
    </div>
  );
}

/* ---- reasoning (thinking) block ---- */
// Collapsible reasoning shown for thinking-capable models run with reasoning on.
// Open while the answer is still streaming (`live`) so the user sees progress;
// collapsed once the answer arrives so it doesn't crowd the transcript.
function ThinkingBlock({ text, live }) {
  return (
    <details
      open={!!live}
      className="rise"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '76%',
        fontSize: 12.5,
        color: 'var(--text-3)',
        background: 'var(--surface-1)',
        border: '1px dashed var(--border)',
        borderRadius: 12,
        padding: '6px 12px',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontFamily: 'var(--font-mono)',
          userSelect: 'none',
        }}
      >
        <window.Icon name="spark" size={12} /> {live ? 'Thinking…' : 'Reasoning'}
      </summary>
      <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, lineHeight: 1.5 }}>{text}</div>
    </details>
  );
}

/* ---- chat bubble ---- */
function Bubble({ m, streaming, devmode }) {
  const isUser = m.role === 'user';
  return (
    <div
      className="rise"
      style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}
    >
      <div
        style={{
          maxWidth: '76%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: isUser ? 'flex-end' : 'flex-start',
          gap: 4,
        }}
      >
        {m.tool && !isUser && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11.5,
              color: 'var(--text-3)',
              fontFamily: 'var(--font-mono)',
              marginBottom: 1,
            }}
          >
            <window.Icon name="plug" size={12} /> {m.tool}
          </span>
        )}
        {m.thinking && !isUser && <ThinkingBlock text={m.thinking} />}
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 14,
            fontSize: 14.5,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            // Neon Ghost bubbles: user = translucent glass with a knife-edge
            // white border; agent = dark surface with a subtle green rim.
            background: isUser
              ? 'var(--glass-bg)'
              : m.error
                ? 'color-mix(in oklab, var(--err) 12%, var(--surface-2))'
                : 'var(--surface-2)',
            backdropFilter: isUser ? 'blur(var(--glass-blur))' : 'none',
            WebkitBackdropFilter: isUser ? 'blur(var(--glass-blur))' : 'none',
            color: 'var(--text)',
            border: isUser
              ? '1px solid var(--border-2)'
              : m.error
                ? '1px solid color-mix(in oklab, var(--err) 35%, transparent)'
                : '1px solid color-mix(in oklab, var(--accent) 26%, var(--border))',
            boxShadow: isUser ? 'none' : 'var(--shadow-sm)',
            borderBottomRightRadius: isUser ? 4 : 14,
            borderBottomLeftRadius: isUser ? 14 : 4,
          }}
        >
          {m.text}
          {streaming && (
            <span
              style={{
                display: 'inline-block',
                width: 7,
                height: 15,
                background: 'var(--text-2)',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                animation: 'blink 1s steps(1) infinite',
              }}
            />
          )}
        </div>
        {m.voice && (
          <audio
            controls
            autoPlay
            src={window.api.url('/api/chat/voice/' + m.voice)}
            style={{ height: 34, marginTop: 2, maxWidth: 260 }}
          />
        )}
        {devmode && m.meta && !isUser && <MetaFooter meta={m.meta} />}
        {(m.time || (!isUser && typeof m.elapsedMs === 'number')) && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {m.time}
            {!isUser && typeof m.elapsedMs === 'number' && (
              <span title="Response time" style={{ fontFamily: 'var(--font-mono)' }}>
                · {formatElapsed(m.elapsedMs)}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/* ---- devmode diagnostics footer (parity with Telegram /devmode) ---- */
function MetaFooter({ meta }) {
  const tools = Array.isArray(meta.tools) ? meta.tools : [];
  const parts = [];
  if (meta.model) parts.push(meta.model);
  if (typeof meta.elapsedMs === 'number') parts.push(`${meta.elapsedMs}ms`);
  if (typeof meta.promptTokens === 'number') parts.push(`${meta.promptTokens}p`);
  if (typeof meta.completionTokens === 'number') parts.push(`${meta.completionTokens}c`);
  const toolStr =
    tools.length > 0
      ? tools.map((t) => `${t.name}${t.ok === false ? '✗' : ''}`).join(', ')
      : 'none';
  return (
    <span
      style={{
        fontSize: 11,
        color: 'var(--text-3)',
        fontFamily: 'var(--font-mono)',
        marginTop: 2,
      }}
    >
      {parts.join(' · ')} · tools: {toolStr}
    </span>
  );
}

function Thinking({ label, tool }) {
  return (
    <div className="rise" style={{ display: 'flex' }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 9,
          padding: '9px 14px',
          borderRadius: 14,
          borderBottomLeftRadius: 4,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
        }}
      >
        {tool ? (
          <window.Icon name="plug" size={14} style={{ color: 'var(--accent-strong)' }} />
        ) : null}
        <span style={{ fontSize: 13.5, color: 'var(--text-2)', fontWeight: tool ? 600 : 400 }}>
          {label}
          {tool && (
            <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 6 }}>
              {tool}
            </span>
          )}
        </span>
        <span style={{ display: 'inline-flex', gap: 3 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 5,
                height: 5,
                borderRadius: 99,
                background: 'var(--text-3)',
                animation: `dots 1.2s ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function EmptyChat({ running, onPrompt }) {
  const prompts = [
    'What should I focus on today?',
    'Check my upcoming reminders.',
    '/codex refactor this function for clarity',
    '/help',
  ];
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        color: 'var(--text-3)',
        padding: 24,
        gap: 10,
      }}
    >
      <span
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-3)',
        }}
      >
        <window.Icon name="chat" size={24} />
      </span>
      <p style={{ fontWeight: 600, color: 'var(--text-2)', fontSize: 15 }}>No messages yet</p>
      <p style={{ fontSize: 13.5, maxWidth: 280 }}>
        {running
          ? 'Say hello below — same model, tools, commands and voice as your Telegram bot.'
          : 'Start the agent to begin chatting.'}
      </p>
      {running && (
        <div className="prompt-grid">
          {prompts.map((p) => (
            <button key={p} className="prompt-chip" onClick={() => onPrompt(p)}>
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- activity strip ---- */
// Human "Xd Xh" / "Xm" from a millisecond span.
function formatUptime(ms) {
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
// Human "Xs ago" / "Xm ago" from an epoch-ms timestamp.
function formatAgo(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - ts;
  if (ms < 5000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function ActivityStrip({ agent, health, activeModel, phase, lastError, activity }) {
  const running = agent === 'running';
  // Everything below comes from the daemon's metrics snapshot (state.activity).
  // It persists after the daemon stops, so gate "live" numbers on `running` and
  // on how recently the file was written (the daemon rewrites it every ~60s).
  const act = activity || {};
  const hasMetrics = !!activity;
  const metricsAt = act.metricsAt || 0;
  const stale = !metricsAt || Date.now() - metricsAt > 150_000;
  const live = running && hasMetrics && !stale;

  const uptimeMs = act.startedAt ? Date.now() - act.startedAt : 0;
  const tickAgoMs = act.lastTickAt ? Date.now() - act.lastTickAt : Infinity;
  const heartbeatDot = running ? (tickAgoMs < 150_000 ? 'ok' : 'warn') : 'stopped';

  const cacheTotal = (act.cacheHits || 0) + (act.cacheMisses || 0);
  const hitRate = cacheTotal > 0 ? Math.round((act.cacheHits / cacheTotal) * 100) : null;

  const rows = [
    {
      label: 'Model in use',
      value: activeModel || '—',
      mono: true,
      dot: running ? 'ok' : 'stopped',
    },
    {
      label: 'Queue depth',
      value: phase !== 'idle' ? '1 message' : '0',
      dot: phase !== 'idle' ? 'warn' : 'ok',
    },
    {
      label: 'Uptime',
      value: running && act.startedAt ? formatUptime(uptimeMs) : '—',
      mono: true,
      dot: running ? 'ok' : 'stopped',
    },
    {
      label: 'Background loop',
      value: running && act.lastTickAt ? formatAgo(act.lastTickAt) : '—',
      dot: heartbeatDot,
      title: running ? `${act.ticks || 0} scheduler ticks` : 'agent stopped',
    },
    {
      label: 'Nudges sent',
      value: hasMetrics ? String(act.nudgesSent || 0) : '—',
      dot: hasMetrics ? 'ok' : 'stopped',
      title: act.nudgesDropped ? `${act.nudgesDropped} dropped (quiet hours / rate limit)` : '',
    },
    {
      label: 'Cache hit-rate',
      value: hitRate == null ? '—' : `${hitRate}%`,
      mono: true,
      dot: hitRate == null ? 'stopped' : hitRate >= 50 ? 'ok' : 'warn',
      title: `${cacheTotal} fast-cache lookups since start`,
    },
    {
      label: 'Telegram',
      value: health.telegram ? 'Connected' : 'Offline',
      dot: health.telegram && running ? 'ok' : 'stopped',
    },
    {
      label: 'Ollama',
      value: health.ollama ? 'Reachable' : 'Unreachable',
      dot: health.ollama ? 'ok' : 'err',
    },
  ];
  return (
    <div
      className="activity-strip"
      style={{ width: 264, flex: 'none', display: 'flex', flexDirection: 'column', gap: calc(12) }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-sm)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <window.Icon name="pulse" size={16} style={{ color: 'var(--text-3)' }} />
          <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>Live activity</span>
          <span
            title={
              metricsAt
                ? `metrics updated ${formatAgo(metricsAt)}`
                : 'no metrics from the daemon yet'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11.5,
              fontWeight: 600,
              color: live ? 'var(--ok)' : 'var(--text-3)',
            }}
          >
            <window.StatusDot state={live ? 'ok' : 'stopped'} size={6} pulse={live} />
            {live ? 'live' : running ? 'stale' : 'paused'}
          </span>
        </div>
        <div>
          {rows.map((r, i) => (
            <div
              key={r.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '11px 16px',
                borderTop: i ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-2)', flex: 'none' }}>{r.label}</span>
              <span
                title={r.title || undefined}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: r.mono ? 'var(--font-mono)' : 'var(--font-ui)',
                  color: 'var(--text)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 160,
                }}
              >
                <window.StatusDot state={r.dot} size={7} /> {r.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-sm)',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <window.Icon
            name={lastError ? 'alert' : 'check'}
            size={16}
            style={{ color: lastError ? 'var(--warn)' : 'var(--ok)' }}
          />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Last error</span>
        </div>
        {lastError ? (
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--text-2)',
              lineHeight: 1.5,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {lastError}
          </p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>None reported. All clear.</p>
        )}
      </div>

      <div
        style={{
          borderRadius: 'var(--radius)',
          padding: 16,
          border: '1px dashed var(--border-2)',
          background: 'color-mix(in oklab, var(--accent) 5%, var(--surface))',
          display: 'flex',
          gap: 11,
        }}
      >
        <window.Icon
          name="shield"
          size={17}
          style={{ color: 'var(--accent-strong)', marginTop: 1 }}
        />
        <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Everything here runs on <b style={{ color: 'var(--text)' }}>this machine</b>. Your
          messages and data stay local unless an module says otherwise.
        </p>
      </div>
    </div>
  );
}

Object.assign(window, { ChatHub });
