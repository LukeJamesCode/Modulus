// Agent Chats — the Slack-style DM screen that is the Agents tab's home view.
// Left: the roster (one "channel" per agent persona, with live status). Right:
// the selected agent's persistent conversation, streamed over POST
// /api/agents/:id/chat (SSE: delta/thinking/confirm/done/error), plus that
// agent's active background tasks so you can watch what it's doing while you
// talk to it. The header's Pause / Stop act on the selected agent only.
const {
  useState: useStateAC,
  useEffect: useEffectAC,
  useRef: useRefAC,
  useMemo: useMemoAC,
  useCallback: useCallbackAC,
} = React;

// Per-agent avatar hue: rotate the brand pink→purple pair around the wheel so
// every "employee" gets a stable, distinct color.
function agentHue(id) {
  return ((id * 47) % 300) - 40;
}

function AgentAvatar({ agent, size = 34 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '32%',
        background: 'var(--brand-gradient)',
        filter: `hue-rotate(${agentHue(agent.id)}deg)`,
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        fontWeight: 700,
        fontSize: size * 0.44,
        fontFamily: 'var(--font-display)',
        textTransform: 'uppercase',
      }}
    >
      {(agent.name || '?').slice(0, 1)}
    </div>
  );
}

function dmTimeLabel(ms) {
  if (!ms) return '';
  try {
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// What an agent is up to, summarized for the roster + header.
function agentActivity(agentId, tasks, typing) {
  const mine = tasks.filter((t) => t.agentId === agentId);
  const running = mine.filter((t) => t.status === 'running');
  const queued = mine.filter((t) => t.status === 'queued');
  const paused = mine.filter((t) => t.status === 'paused');
  if (typing) return { dot: 'running', label: 'typing…', running, queued, paused };
  if (running.length)
    return {
      dot: 'running',
      label: `working — ${running.length} task${running.length === 1 ? '' : 's'}`,
      running,
      queued,
      paused,
    };
  if (queued.length)
    return { dot: 'idle', label: `${queued.length} queued`, running, queued, paused };
  if (paused.length) return { dot: 'paused', label: 'paused', running, queued, paused };
  return { dot: 'stopped', label: 'idle', running, queued, paused };
}

const DM_DOT = {
  running: 'var(--ok)',
  idle: 'var(--info)',
  paused: 'var(--warn)',
  stopped: 'var(--text-3)',
};

/* ---- top activity bar (stats strip) ---- */
function ActivityBar({ agents, tasks, approvals }) {
  const running = tasks.filter((t) => t.status === 'running').length;
  const queued = tasks.filter((t) => t.status === 'queued').length;
  const paused = tasks.filter((t) => t.status === 'paused').length;
  const doneToday = tasks.filter(
    (t) => t.status === 'done' && t.finishedAt && Date.now() - t.finishedAt < 24 * 3600_000,
  ).length;
  const pending = (approvals && approvals.pending && approvals.pending.length) || 0;
  const stat = (icon, label, value, tone) => (
    <span
      key={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 13,
        color: 'var(--text-2)',
        padding: '6px 12px',
        borderRadius: 99,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
      }}
    >
      <window.Icon name={icon} size={14} style={{ color: tone || 'var(--text-3)' }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)' }}>
        {value}
      </span>
      {label}
    </span>
  );
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginBottom: 12,
        flex: 'none',
      }}
    >
      {stat('spark', 'agents', agents.length)}
      {stat('activity', 'running', running, running ? 'var(--ok)' : undefined)}
      {stat('clock', 'queued', queued)}
      {paused > 0 && stat('pause-circle', 'paused', paused, 'var(--warn)')}
      {stat('check-circle', 'done · 24h', doneToday)}
      {pending > 0 && stat('shield', 'awaiting approval', pending, 'var(--warn)')}
    </div>
  );
}

/* ---- roster (left column) ---- */
function AgentRoster({ agents, tasks, typingId, selectedId, onSelect, onNewAgent, daemonRunning }) {
  const mainOn = selectedId === 'main';
  return (
    <div
      style={{
        width: 264,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '13px 14px 10px',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        Chats
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
        {/* Pinned main agent — the one that controls the whole fleet. */}
        <button
          onClick={() => onSelect('main')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            textAlign: 'left',
            padding: '9px 10px',
            borderRadius: 'var(--radius)',
            border: '1px solid',
            borderColor: mainOn ? 'var(--accent-ring)' : 'transparent',
            background: mainOn ? 'var(--accent-soft)' : 'transparent',
            cursor: 'pointer',
            color: 'inherit',
            font: 'inherit',
          }}
          onMouseEnter={(e) => {
            if (!mainOn) e.currentTarget.style.background = 'var(--surface-2)';
          }}
          onMouseLeave={(e) => {
            if (!mainOn) e.currentTarget.style.background = 'transparent';
          }}
        >
          <span
            style={{
              width: 34,
              height: 34,
              flex: 'none',
              borderRadius: '32%',
              display: 'grid',
              placeItems: 'center',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
            }}
          >
            <window.HelixMark size={22} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--text)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              Modulus Agent
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--text-3)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              main agent · controls the fleet
            </span>
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              flex: 'none',
              borderRadius: 99,
              background: daemonRunning ? 'var(--ok)' : 'var(--text-3)',
              boxShadow: daemonRunning ? '0 0 6px var(--ok)' : 'none',
            }}
          />
        </button>
        {agents.length > 0 && (
          <div
            style={{
              margin: '8px 8px 4px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: 'var(--text-3)',
            }}
          >
            Agents
          </div>
        )}
        {agents.map((a) => {
          const act = agentActivity(a.id, tasks, typingId === a.id);
          const on = a.id === selectedId;
          return (
            <button
              key={a.id}
              onClick={() => onSelect(a.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                padding: '9px 10px',
                borderRadius: 'var(--radius)',
                border: '1px solid',
                borderColor: on ? 'var(--accent-ring)' : 'transparent',
                background: on ? 'var(--accent-soft)' : 'transparent',
                cursor: 'pointer',
                color: 'inherit',
                font: 'inherit',
              }}
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.background = 'var(--surface-2)';
              }}
              onMouseLeave={(e) => {
                if (!on)
                  e.currentTarget.style.background = on ? 'var(--accent-soft)' : 'transparent';
              }}
            >
              <AgentAvatar agent={a} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {a.name}
                </span>
                <span
                  style={{
                    display: 'block',
                    fontSize: 12,
                    color: act.dot === 'running' ? 'var(--ok)' : 'var(--text-3)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {act.label === 'idle' ? a.role || 'idle' : act.label}
                </span>
              </span>
              <span
                style={{
                  width: 8,
                  height: 8,
                  flex: 'none',
                  borderRadius: 99,
                  background: DM_DOT[act.dot],
                  boxShadow: act.dot === 'running' ? '0 0 6px var(--ok)' : 'none',
                }}
              />
            </button>
          );
        })}
      </div>
      <div style={{ padding: 10, borderTop: '1px solid var(--border)' }}>
        <window.Button variant="primary" icon="plus" onClick={onNewAgent} style={{ width: '100%' }}>
          New agent
        </window.Button>
      </div>
    </div>
  );
}

/* ---- a single agent task, shown inline in the chat as a work card ---- */
function TaskCardInline({ task, onOpen }) {
  const tone =
    task.status === 'running'
      ? 'var(--ok)'
      : task.status === 'paused'
        ? 'var(--warn)'
        : task.status === 'error'
          ? 'var(--err)'
          : 'var(--text-3)';
  const live = (task.liveText || '').trim();
  return (
    <button
      onClick={() => onOpen(task.id)}
      title="Open the full run view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
        textAlign: 'left',
        padding: '9px 12px',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        background: 'var(--surface-2)',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
        <window.Icon
          name={
            task.status === 'running'
              ? 'loader'
              : task.status === 'paused'
                ? 'pause-circle'
                : 'clock'
          }
          size={13}
          className={task.status === 'running' ? 'spin' : undefined}
          style={{ color: tone }}
        />
        <span style={{ color: tone, fontWeight: 600, textTransform: 'capitalize' }}>
          {task.status}
        </span>
        <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>#{task.id}</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: 'var(--text-2)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {task.prompt}
        </span>
      </span>
      {live && (
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-3)',
            fontStyle: 'italic',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {live.slice(-160)}
        </span>
      )}
    </button>
  );
}

/* ---- collapsible reasoning block above a streaming reply ---- */
function DmThinking({ text, live }) {
  const [open, setOpen] = useStateAC(false);
  if (!text) return null;
  return (
    <div style={{ maxWidth: '76%', alignSelf: 'flex-start' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: 'var(--accent-2, var(--text-3))',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 0',
          font: 'inherit',
        }}
      >
        <window.Icon
          name={live ? 'loader' : 'chevron-down'}
          size={12}
          className={live ? 'spin' : undefined}
        />
        {live ? 'thinking…' : open ? 'hide reasoning' : 'show reasoning'}
      </button>
      {(open || live) && (
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--text-3)',
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
            borderLeft: '2px solid var(--accent-ring)',
            padding: '4px 10px',
            marginTop: 2,
            maxHeight: 140,
            overflowY: 'auto',
          }}
        >
          {text.slice(-2000)}
        </div>
      )}
    </div>
  );
}

function DmBubble({ m }) {
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
          gap: 3,
        }}
      >
        <div
          style={{
            padding: '9px 13px',
            borderRadius: 14,
            fontSize: 14.5,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            background: isUser
              ? 'var(--accent-soft)'
              : m.error
                ? 'color-mix(in oklab, var(--err) 12%, var(--surface-2))'
                : 'var(--surface-2)',
            color: 'var(--text)',
            border: isUser
              ? '1px solid var(--accent-ring)'
              : m.error
                ? '1px solid color-mix(in oklab, var(--err) 35%, transparent)'
                : '1px solid var(--border)',
            borderBottomRightRadius: isUser ? 4 : 14,
            borderBottomLeftRadius: isUser ? 14 : 4,
          }}
        >
          {m.text}
          {m.streaming && (
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
        {m.time && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{m.time}</span>}
      </div>
    </div>
  );
}

/* ---- inline confirm card for confirm-tier tools fired during a DM turn ---- */
function DmConfirmCard({ confirm, onAnswer }) {
  return (
    <div
      className="rise"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '76%',
        padding: '12px 14px',
        borderRadius: 'var(--radius)',
        border: '1px solid color-mix(in oklab, var(--warn) 40%, transparent)',
        background: 'color-mix(in oklab, var(--warn) 10%, var(--surface-2))',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 }}
      >
        <window.Icon name="shield" size={15} style={{ color: 'var(--warn)' }} />
        Approval needed — {confirm.tool}
      </span>
      <span style={{ fontSize: 13.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
        {confirm.prompt}
      </span>
      <span style={{ display: 'flex', gap: 8 }}>
        <window.Button variant="primary" size="sm" onClick={() => onAnswer(true)}>
          Allow
        </window.Button>
        <window.Button variant="subtle" size="sm" onClick={() => onAnswer(false)}>
          Deny
        </window.Button>
      </span>
    </div>
  );
}

/* ---- the chat pane ---- */
function AgentChatPane({
  agent,
  tasks,
  typing,
  onTyping,
  onOpenTask,
  onEditAgent,
  onDispatch,
  refresh,
}) {
  const [messages, setMessages] = useStateAC([]);
  const [loaded, setLoaded] = useStateAC(false);
  const [draft, setDraft] = useStateAC('');
  const [streamText, setStreamText] = useStateAC('');
  const [thinkText, setThinkText] = useStateAC('');
  const [confirm, setConfirm] = useStateAC(null);
  const [error, setError] = useStateAC('');
  const [menuOpen, setMenuOpen] = useStateAC(false);
  const streamRef = useRefAC(null);
  const scrollRef = useRefAC(null);
  const menuRef = useRefAC(null);

  const act = agentActivity(agent.id, tasks, typing);
  const activeTasks = [...act.running, ...act.queued, ...act.paused];
  const busy = !!typing;

  const loadHistory = useCallbackAC(async () => {
    const r = await window.api.get(`/api/agents/${agent.id}/chat`);
    if (r.ok) {
      setMessages(
        (r.data.messages || []).map((m) => ({
          role: m.role,
          text: m.content,
          time: dmTimeLabel(m.createdAt),
        })),
      );
      setLoaded(true);
    }
  }, [agent.id]);

  // Switching agents: drop any in-flight stream (the server stops the turn on
  // disconnect) and load the new thread.
  useEffectAC(() => {
    setMessages([]);
    setLoaded(false);
    setStreamText('');
    setThinkText('');
    setConfirm(null);
    setError('');
    if (streamRef.current) {
      streamRef.current.abort();
      streamRef.current = null;
      onTyping(null);
    }
    loadHistory();
  }, [agent.id]);

  // Pin the scroll to the newest message.
  useEffectAC(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, thinkText, confirm]);

  useEffectAC(() => {
    if (!menuOpen) return undefined;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setError('');
    setMessages((cur) => [...cur, { role: 'user', text, time: dmTimeLabel(Date.now()) }]);
    setStreamText('');
    setThinkText('');
    onTyping(agent.id);
    let acc = '';
    let think = '';
    const finishStream = () => {
      streamRef.current = null;
      setStreamText('');
      setThinkText('');
      setConfirm(null);
      onTyping(null);
    };
    const handle = window.api.postStream(
      `/api/agents/${agent.id}/chat`,
      { text },
      {
        onEvent: (ev, data) => {
          if (ev === 'delta' && data && data.delta) {
            acc += data.delta;
            setStreamText(acc);
          } else if (ev === 'thinking' && data && data.thinking) {
            think += data.thinking;
            setThinkText(think);
          } else if (ev === 'confirm') {
            setConfirm(data);
          } else if (ev === 'done') {
            const finalText = (data && data.text) || acc;
            setMessages((cur) => [
              ...cur,
              {
                role: 'assistant',
                text: finalText || '(no reply)',
                time: dmTimeLabel(Date.now()),
                thinking: think || undefined,
              },
            ]);
            finishStream();
          } else if (ev === 'error') {
            const msg = (data && data.message) || 'turn failed';
            if (data && data.text) {
              setMessages((cur) => [
                ...cur,
                { role: 'assistant', text: data.text, time: dmTimeLabel(Date.now()) },
              ]);
            }
            setError(msg);
            finishStream();
          }
        },
      },
    );
    streamRef.current = handle;
  };

  const stopEverything = async () => {
    if (streamRef.current) {
      streamRef.current.abort(); // closing the request stops the DM turn server-side
      streamRef.current = null;
      if (streamText) {
        setMessages((cur) => [
          ...cur,
          { role: 'assistant', text: streamText, time: dmTimeLabel(Date.now()) },
        ]);
      }
      setStreamText('');
      setThinkText('');
      setConfirm(null);
      onTyping(null);
    }
    await window.api.post(`/api/agents/${agent.id}/chat/stop`);
    if (activeTasks.length) await window.api.post(`/api/agents/${agent.id}/tasks/cancel_all`);
    refresh();
  };

  const pauseWork = async () => {
    await window.api.post(`/api/agents/${agent.id}/tasks/pause_all`);
    refresh();
  };
  const resumeWork = async () => {
    await window.api.post(`/api/agents/${agent.id}/tasks/resume_all`);
    refresh();
  };

  const clearChat = async () => {
    if (!window.confirm(`Clear your chat with ${agent.name}? This wipes its DM memory.`)) return;
    await window.api.post(`/api/agents/${agent.id}/chat/clear`);
    setMessages([]);
    setStreamText('');
    setThinkText('');
  };

  const answerConfirm = async (ok) => {
    if (!confirm) return;
    await window.api.post('/api/agents/chat/confirm', { id: confirm.id, ok });
    setConfirm(null);
  };

  const hasWork = activeTasks.length > 0 || busy;

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
      {/* header */}
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
        <AgentAvatar agent={agent} size={38} />
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.25 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15.5, fontWeight: 700 }}>{agent.name}</span>
            <window.Badge tone={act.dot === 'running' ? 'ok' : 'neutral'}>
              {busy ? 'typing…' : act.label}
            </window.Badge>
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
            {agent.role || agent.systemPrompt}
          </span>
        </div>
        {act.paused.length > 0 ? (
          <window.Button
            size="sm"
            icon="play"
            onClick={resumeWork}
            title="Resume this agent's paused tasks"
          >
            Resume
          </window.Button>
        ) : (
          <window.Button
            size="sm"
            icon="pause"
            onClick={pauseWork}
            disabled={act.running.length + act.queued.length === 0}
            style={
              act.running.length + act.queued.length > 0
                ? {
                    background: 'color-mix(in oklab, var(--warn) 16%, transparent)',
                    borderColor: 'color-mix(in oklab, var(--warn) 35%, transparent)',
                    color: 'var(--warn)',
                  }
                : undefined
            }
            title="Pause this agent's queued and running tasks"
          >
            Pause
          </window.Button>
        )}
        {hasWork ? (
          <window.Button
            size="sm"
            icon="stop"
            onClick={stopEverything}
            style={{
              background: 'color-mix(in oklab, var(--err) 16%, transparent)',
              borderColor: 'color-mix(in oklab, var(--err) 35%, transparent)',
              color: 'var(--err)',
            }}
            title="Stop the current reply and cancel this agent's tasks"
          >
            Stop
          </window.Button>
        ) : (
          <window.Button
            size="sm"
            icon="play"
            onClick={() => onDispatch(agent)}
            style={{
              background: 'color-mix(in oklab, var(--ok) 16%, transparent)',
              borderColor: 'color-mix(in oklab, var(--ok) 35%, transparent)',
              color: 'var(--ok)',
            }}
            title="Start a background task for this agent"
          >
            Start
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
                width: 180,
                background: 'var(--raised)',
                border: '1px solid var(--border-2)',
                borderRadius: 'var(--radius)',
                boxShadow: 'var(--shadow-pop)',
                zIndex: 60,
                overflow: 'hidden',
              }}
            >
              {[
                { icon: 'edit', label: 'Edit agent', fn: () => onEditAgent(agent) },
                { icon: 'trash', label: 'Clear chat', fn: clearChat },
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

      {/* active background work, inline so the chat shows what it's doing */}
      {activeTasks.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-2)',
            flex: 'none',
            maxHeight: 150,
            overflowY: 'auto',
          }}
        >
          {activeTasks.map((t) => (
            <TaskCardInline key={t.id} task={t} onOpen={onOpenTask} />
          ))}
        </div>
      )}

      {/* messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {loaded && messages.length === 0 && !streamText && (
          <div
            style={{
              margin: 'auto',
              textAlign: 'center',
              color: 'var(--text-3)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <AgentAvatar agent={agent} size={52} />
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)' }}>
              This is the start of your chat with {agent.name}.
            </div>
            <div style={{ fontSize: 13, maxWidth: 380 }}>
              Talk to it like a teammate — it remembers this conversation and can use its tools to
              get things done while you watch.
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <React.Fragment key={i}>
            {m.thinking && <DmThinking text={m.thinking} live={false} />}
            <DmBubble m={m} />
          </React.Fragment>
        ))}
        {thinkText && !streamText && <DmThinking text={thinkText} live />}
        {streamText && (
          <>
            {thinkText && <DmThinking text={thinkText} live={false} />}
            <DmBubble m={{ role: 'assistant', text: streamText, streaming: true }} />
          </>
        )}
        {busy && !streamText && !thinkText && (
          <div
            style={{
              display: 'flex',
              gap: 5,
              alignItems: 'center',
              color: 'var(--text-3)',
              fontSize: 13,
            }}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: 'var(--accent)',
                  animation: `dots 1.2s ${i * 0.2}s ease-in-out infinite`,
                }}
              />
            ))}
            {agent.name} is thinking
          </div>
        )}
        {confirm && <DmConfirmCard confirm={confirm} onAnswer={answerConfirm} />}
      </div>

      {error && (
        <div style={{ padding: '0 18px 8px', flex: 'none' }}>
          <window.Badge tone="err">{error}</window.Badge>
        </div>
      )}

      {/* composer */}
      <div
        style={{ padding: '10px 14px 14px', borderTop: '1px solid var(--border)', flex: 'none' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 10,
            border: '1px solid var(--border-2)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-2)',
            padding: '8px 8px 8px 14px',
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={Math.min(5, Math.max(1, draft.split('\n').length))}
            placeholder={busy ? `${agent.name} is replying…` : `Message ${agent.name}`}
            style={{
              flex: 1,
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--text)',
              font: 'inherit',
              fontSize: 14.5,
              lineHeight: 1.5,
              padding: '4px 0',
            }}
          />
          <window.ImproveButton
            value={draft}
            kind="chat"
            iconOnly
            onImproved={setDraft}
            title="Improve my message with AI"
            style={{ width: 36, height: 36, borderRadius: 12 }}
          />
          <button
            onClick={send}
            disabled={busy || !draft.trim()}
            aria-label="Send"
            style={{
              width: 36,
              height: 36,
              flex: 'none',
              borderRadius: 12,
              border: 'none',
              cursor: busy || !draft.trim() ? 'default' : 'pointer',
              background: busy || !draft.trim() ? 'var(--surface-2)' : 'var(--brand-gradient)',
              color: busy || !draft.trim() ? 'var(--text-3)' : '#fff',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <window.Icon name="send" size={16} />
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6, paddingLeft: 4 }}>
          Enter to send · Shift+Enter for a new line · replies stream live with the agent's tools
        </div>
      </div>
    </div>
  );
}

/* ---- the whole Chats view ---- */
function AgentChatsView({
  agents,
  tasks,
  approvals,
  onNewAgent,
  onEditAgent,
  onOpenTask,
  onDispatch,
  refresh,
  // Main "Modulus Agent" chat wiring, threaded from the Agents tab.
  agentStatus,
  onStart,
  onStop,
  voiceEnabled,
  health,
  activeModel,
}) {
  // 'main' (the pinned Modulus Agent) is the default; otherwise an agent id.
  const [selectedId, setSelectedId] = useStateAC(() => {
    try {
      const v = localStorage.getItem('modulus_dm_selected');
      if (v === 'main') return 'main';
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 'main';
    } catch {
      return 'main';
    }
  });
  const [typingId, setTypingId] = useStateAC(null); // agent currently streaming a DM reply

  const isMain = selectedId === 'main';
  const selectedAgent = useMemoAC(
    () => (isMain ? null : agents.find((a) => a.id === selectedId) || null),
    [agents, selectedId, isMain],
  );

  useEffectAC(() => {
    try {
      localStorage.setItem('modulus_dm_selected', String(selectedId));
    } catch {
      /* ignore */
    }
  }, [selectedId]);

  // A deleted (or never-loaded) agent selection falls back to the main chat.
  useEffectAC(() => {
    if (!isMain && agents.length > 0 && !agents.some((a) => a.id === selectedId)) {
      setSelectedId('main');
    }
  }, [agents, selectedId, isMain]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <ActivityBar agents={agents} tasks={tasks} approvals={approvals} />
      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }} className="dm-grid">
        <AgentRoster
          agents={agents}
          tasks={tasks}
          typingId={typingId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNewAgent={onNewAgent}
          daemonRunning={agentStatus === 'running'}
        />
        {isMain ? (
          <window.MainChatPane
            key="main"
            agentStatus={agentStatus}
            onStart={onStart}
            onStop={onStop}
            voiceEnabled={voiceEnabled}
            health={health}
            activeModel={activeModel}
            tasks={tasks}
            refresh={refresh}
          />
        ) : selectedAgent ? (
          <AgentChatPane
            key={selectedAgent.id}
            agent={selectedAgent}
            tasks={tasks}
            typing={typingId === selectedAgent.id}
            onTyping={setTypingId}
            onOpenTask={onOpenTask}
            onEditAgent={onEditAgent}
            onDispatch={onDispatch}
            refresh={refresh}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              border: '1px dashed var(--border-2)',
              borderRadius: 'var(--radius-lg)',
              color: 'var(--text-3)',
            }}
          >
            <window.HelixMark size={48} />
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)' }}>
              Hire your first agent
            </div>
            <div style={{ fontSize: 13, maxWidth: 360, textAlign: 'center' }}>
              Agents are teammates you chat with. Each one has its own personality, tools, and
              memory of your conversation.
            </div>
            <window.Button variant="primary" icon="plus" onClick={onNewAgent}>
              New agent
            </window.Button>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { AgentChatsView });
