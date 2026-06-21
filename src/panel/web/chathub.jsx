// Modulus Agent chat (MainChatPane) — the pinned "controls them all" chat in
// Agents › Chats. The main orchestrator surface: full module tools, slash
// commands, confirm-tier approvals, and voice — plus a fleet-wide Pause/Resume/
// Stop header so the one agent can steer the whole queue. Rendered in the DM
// pane slot when the roster's pinned "Modulus Agent" entry is selected; a Voice
// button swaps the pane to the existing VoiceHub and back.
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

function MainChatPane({
  agentStatus,
  onStart,
  onStop,
  voiceEnabled,
  health,
  activeModel,
  tasks,
  refresh,
}) {
  const running = agentStatus === 'running';
  const [messages, setMessages] = useStateCH(loadStoredMessages);
  const [draft, setDraft] = useStateCH('');
  const [phase, setPhase] = useStateCH('idle'); // idle | streaming | command
  const [streamText, setStreamText] = useStateCH('');
  const [streamThink, setStreamThink] = useStateCH('');
  const [commands, setCommands] = useStateCH({ core: [], modules: [] });
  const [confirmReq, setConfirmReq] = useStateCH(null); // { id, prompt, tool }
  const [thinkMode, setThinkMode] = useStateCH(loadThinkMode); // 'auto' | 'on' | 'off'
  const [devmode, setDevmode] = useDevmode();
  const [voiceMode, setVoiceMode] = useStateCH(false); // swap pane to VoiceHub
  const [menuOpen, setMenuOpen] = useStateCH(false);
  const scrollRef = useRefCH(null);
  const streamRef = useRefCH(null); // active postStream handle (for abort)
  const inputRef = useRefCH(null);
  const menuRef = useRefCH(null);
  // File/image/PDF uploads for the next turn. null = don't block visual drops
  // up front; the server gates images on the chat model and reports any skips.
  const att = window.useAttachments(null);

  useEffectCH(
    () => () => {
      if (streamRef.current) streamRef.current.abort();
    },
    [],
  );

  // Close the kebab menu on an outside click.
  useEffectCH(() => {
    if (!menuOpen) return undefined;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

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
  // command bar can surface buttons. Refreshes whenever the agent comes up.
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
  }, [running]);

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

  // Fleet-wide controls — the "controls them all" header. Counts come from the
  // whole task table (passed down from the Agents tab), and the buttons hit the
  // existing bulk routes so this one chat can steer the entire queue.
  const fleetPaused = (tasks || []).filter((t) => t.status === 'paused').length;
  const fleetActive = (tasks || []).filter(
    (t) => t.status === 'running' || t.status === 'queued',
  ).length;
  const pauseFleet = async () => {
    await window.api.post('/api/agents/tasks/pause_all');
    refresh && refresh();
  };
  const resumeFleet = async () => {
    await window.api.post('/api/agents/tasks/resume_all');
    refresh && refresh();
  };
  // Stop kills the in-flight main-chat reply AND cancels every queued/running
  // agent task — a single panic button for the whole fleet.
  const stopFleet = async () => {
    abort();
    await window.api.post('/api/agents/tasks/cancel_all');
    refresh && refresh();
  };

  const statusLabel =
    agentStatus === 'running'
      ? 'running'
      : agentStatus === 'starting'
        ? 'starting…'
        : agentStatus === 'stopping'
          ? 'stopping…'
          : 'stopped';

  // Voice button swaps the whole pane to the existing VoiceHub; its onLeave
  // returns here. Rendered without the bordered pane chrome so VoiceHub's own
  // cards aren't double-framed (matches how the old Dashboard hosted it).
  if (voiceMode && voiceEnabled) {
    return (
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <window.VoiceHub
          agent={agentStatus}
          onStart={onStart}
          onStop={onStop}
          health={health}
          activeModel={activeModel}
          onLeave={() => setVoiceMode(false)}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      {/* header — the Modulus Agent identity + fleet controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          flex: 'none',
        }}
      >
        <window.HelixMark size={36} />
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.25 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15.5, fontWeight: 700 }}>Modulus Agent</span>
            <window.Badge tone={running ? 'ok' : 'neutral'}>{statusLabel}</window.Badge>
          </div>
          <span
            style={{
              fontSize: 12.5,
              color: 'var(--text-3)',
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Main agent — full tools, commands &amp; voice{activeModel ? ` · ${activeModel}` : ''}
          </span>
        </div>
        {fleetPaused > 0 ? (
          <window.Button
            size="sm"
            icon="play"
            onClick={resumeFleet}
            title="Resume every paused agent task"
          >
            Resume
          </window.Button>
        ) : (
          <window.Button
            size="sm"
            icon="pause"
            onClick={pauseFleet}
            disabled={fleetActive === 0}
            style={
              fleetActive > 0
                ? {
                    background: 'color-mix(in oklab, var(--warn) 16%, transparent)',
                    borderColor: 'color-mix(in oklab, var(--warn) 35%, transparent)',
                    color: 'var(--warn)',
                  }
                : undefined
            }
            title="Pause every queued and running agent task"
          >
            Pause
          </window.Button>
        )}
        <window.Button
          size="sm"
          icon="stop"
          onClick={stopFleet}
          style={{
            background: 'color-mix(in oklab, var(--err) 16%, transparent)',
            borderColor: 'color-mix(in oklab, var(--err) 35%, transparent)',
            color: 'var(--err)',
          }}
          title="Stop the current reply and cancel every agent task"
        >
          Stop
        </window.Button>
        {voiceEnabled && (
          <window.Button
            size="sm"
            icon="mic"
            onClick={() => setVoiceMode(true)}
            title="Switch to voice"
          >
            Voice
          </window.Button>
        )}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <window.IconButton
            name="menu"
            label="Chat options"
            onClick={() => setMenuOpen(!menuOpen)}
          />
          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                top: 34,
                right: 0,
                width: 190,
                background: 'var(--raised)',
                border: '1px solid var(--border-2)',
                borderRadius: 'var(--radius)',
                boxShadow: 'var(--shadow-pop)',
                zIndex: 60,
                overflow: 'hidden',
              }}
            >
              {[
                { icon: 'plus', label: 'New chat', fn: newChat },
                {
                  icon: 'terminal',
                  label: devmode ? 'Dev mode: on' : 'Dev mode: off',
                  fn: () => setDevmode(!devmode),
                },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={() => {
                    setMenuOpen(false);
                    item.fn();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    width: '100%',
                    padding: '9px 12px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-2)',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 13.5,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <window.Icon name={item.icon} size={14} /> {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
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
          <EmptyChat running={running} onPrompt={setDraft} commands={commands} />
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
          <window.ImproveButton
            value={draft}
            kind="chat"
            iconOnly
            onImproved={setDraft}
            title="Improve my message with AI"
            style={{ width: 44, height: 44 }}
          />
          <MicButton running={running} disabled={phase !== 'idle'} onTranscript={onTranscript} />
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
                opacity: !running || att.staging || (!draft.trim() && !att.staged.length) ? 0.5 : 1,
              }}
            >
              Send
            </window.Button>
          )}
        </div>
      </div>
    </div>
  );
}

function now() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
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
            // Helix bubbles: user = translucent surface with a hairline
            // border; agent = dark surface with a subtle accent rim.
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

// Suggestions that reflect what's actually installed, so the first thing a new
// user sees points at capabilities they really have. Falls back to friendly
// generics, and always surfaces one real module command for discoverability.
function buildEmptyPrompts(commands) {
  const out = ['What should I focus on today?'];
  const mods = (commands && commands.modules) || [];
  const hay = mods
    .map((c) => `${c.cmd || ''} ${c.desc || ''}`)
    .join(' ')
    .toLowerCase();
  if (hay.includes('calendar') || hay.includes('event')) out.push("What's on my calendar today?");
  if (hay.includes('weather')) out.push("What's the weather this weekend?");
  if (hay.includes('search') || hay.includes('web'))
    out.push('Look up the latest news on a topic I care about.');
  out.push('Remind me to stretch in 30 minutes.');
  if (mods[0] && mods[0].cmd) out.push(mods[0].cmd);
  out.push('/help');
  return [...new Set(out)].slice(0, 5);
}

function EmptyChat({ running, onPrompt, commands }) {
  const prompts = buildEmptyPrompts(commands);
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

Object.assign(window, { MainChatPane });
