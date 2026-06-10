/* global React, window */
// Agent command center. Lists personas (the "fleet"), lets you create/edit
// them, dispatch a task to one, and watch tasks stream through queued ->
// running -> done with their transcript and sub-agent tree. Mirrors the
// Hermes/OpenClaw control-plane idea: one screen to drive many agents.
//
// The panel only does CRUD + dispatch over HTTP; the daemon's resource-aware
// queue actually runs the tasks (and the heavy-model slot stays single-owner).
const { useState, useEffect, useCallback, useMemo, useRef } = React;

const STATUS_TONE = {
  queued: 'neutral',
  running: 'accent',
  done: 'ok',
  error: 'err',
  cancelled: 'neutral',
};

const EMPTY_AGENT = {
  name: '',
  role: '',
  systemPrompt: '',
  profile: 'chat',
  thinkMode: 'auto', // auto | on | off — reasoning for thinking-capable models
  toolAllowlist: null, // null = all tools
  maxToolRounds: 4,
  budgetTokens: null,
  executionMode: 'sequential',
  maxConcurrency: 1,
  canDelegate: false,
  delegatableAgents: [],
  mode: 'single', // single = one bounded turn; autonomous = plan->act->reflect loop
  maxTotalRounds: null, // autonomous budget; null = engine default
  maxWallClockMs: null, // autonomous budget; null = engine default
};

function listToText(list) {
  return Array.isArray(list) ? list.join(', ') : '';
}
function textToList(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Active Workflows — a visual read of the task table. A "workflow" is a
// top-level task (parentId == null); its pipeline is that task plus the
// sub-agent tasks it delegated. Clicking a card shows that delegation tree.
// ---------------------------------------------------------------------------

const WF_STATUS = {
  queued: { tone: 'yellow', label: 'Queued', node: 'pending', icon: 'clock', spin: false },
  running: { tone: 'blue', label: 'Running', node: 'active', icon: 'loader', spin: true },
  done: { tone: 'green', label: 'Done', node: 'done', icon: 'check-circle', spin: false },
  error: { tone: 'red', label: 'Error', node: 'error', icon: 'alert-triangle', spin: false },
  cancelled: { tone: 'gray', label: 'Cancelled', node: 'pending', icon: 'x', spin: false },
  paused: { tone: 'yellow', label: 'Paused', node: 'pending', icon: 'pause-circle', spin: false },
};
const WF_TAG_TONES = ['green', 'blue', 'purple', 'yellow', 'gray'];
const wfTagTone = (id) =>
  WF_TAG_TONES[((id % WF_TAG_TONES.length) + WF_TAG_TONES.length) % WF_TAG_TONES.length];
const wfStatusOf = (s) => WF_STATUS[s] || WF_STATUS.queued;

function wfRelTime(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function wfClip(text, n) {
  const t = String(text || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function matchesRunFilter(status, filter) {
  if (filter === 'Active')
    return status === 'queued' || status === 'running' || status === 'paused';
  if (filter === 'Inactive')
    return status === 'done' || status === 'error' || status === 'cancelled';
  return true;
}

// Build the unified Run feed: agent task-trees AND authored-workflow runs,
// normalised into one card model so they live in a single list. An agent item
// keeps {root, children} for its delegation diagram; a workflow item keeps
// {run}. `kind` drives which actions/detail view a card offers.
function buildFeed(tasks, wfRuns, wfNameById, filter) {
  const childrenByParent = new Map();
  for (const t of tasks) {
    if (t.parentId != null) {
      const list = childrenByParent.get(t.parentId) || [];
      list.push(t);
      childrenByParent.set(t.parentId, list);
    }
  }
  const agentItems = tasks
    .filter((t) => t.parentId == null && matchesRunFilter(t.status, filter))
    .map((root) => {
      const children = (childrenByParent.get(root.id) || []).sort((a, b) => a.id - b.id);
      const doneKids = children.filter((c) => c.status === 'done').length;
      const meta = wfStatusOf(root.status);
      const percent = children.length
        ? Math.round((doneKids / children.length) * 100)
        : ({ queued: 5, running: 50, done: 100, error: 100, cancelled: 100, paused: 50 }[
            root.status
          ] ?? 0);
      const stepLabel = children.length
        ? `${doneKids} / ${children.length} sub-agents`
        : meta.label;
      const seen = new Set();
      const tags = [];
      for (const t of [root, ...children]) {
        if (t.agentName && !seen.has(t.agentName)) {
          seen.add(t.agentName);
          tags.push({ tone: wfTagTone(t.agentId), label: t.agentName });
        }
      }
      return {
        kind: 'agent',
        key: `agent:${root.id}`,
        id: root.id,
        title: root.agentName || `Task #${root.id}`,
        prompt: root.prompt,
        status: root.status,
        when: root.createdAt || 0,
        meta,
        percent,
        stepLabel,
        tags,
        root,
        children,
      };
    });
  const workflowItems = (wfRuns || [])
    .filter((r) => matchesRunFilter(r.status, filter))
    .map((r) => {
      const name = (wfNameById && wfNameById.get(r.workflowId)) || `Workflow #${r.workflowId}`;
      const meta = wfStatusOf(r.status);
      return {
        kind: 'workflow',
        key: `workflow:${r.id}`,
        id: r.id,
        title: name,
        prompt: r.input || '',
        status: r.status,
        when: r.createdAt || 0,
        meta,
        percent: { queued: 5, running: 50, done: 100, error: 100, cancelled: 100 }[r.status] ?? 0,
        stepLabel: meta.label,
        tags: [{ tone: wfTagTone(r.workflowId), label: name }],
        run: r,
      };
    });
  return [...agentItems, ...workflowItems].sort((a, b) => b.when - a.when).slice(0, 12);
}

function WorkflowCard({
  item,
  selected,
  onSelect,
  onOpen,
  onCancel,
  onPause,
  onResume,
  onViewOutput,
}) {
  const isAgent = item.kind === 'agent';
  const active = item.status === 'running' || item.status === 'queued';
  const paused = item.status === 'paused';
  return (
    <div
      className={`dash-card clickable${selected ? ' selected' : ''}`}
      onClick={() => onSelect(item.key)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.key);
        }
      }}
      aria-pressed={selected}
    >
      <div className="card-header">
        <div className={`card-icon ${item.meta.tone}`}>
          <window.Icon
            name={isAgent ? 'spark' : 'git-merge'}
            size={20}
            className={item.meta.spin ? 'spin' : undefined}
          />
        </div>
        <div className="card-title">
          <h3 title={item.prompt}>{wfClip(item.title, 30)}</h3>
          <span className={`status-label ${item.meta.tone}`}>
            <span className={`dot ${item.meta.tone}`}></span>
            {isAgent ? '' : 'Workflow · '}
            {item.meta.label}
          </span>
        </div>
      </div>
      <div className="progress-section">
        <div className="progress-labels">
          <span>{item.stepLabel}</span>
          <span>{item.percent}%</span>
        </div>
        <div className="progress-bar">
          <div
            className={`progress-fill ${item.meta.tone}`}
            style={{ width: `${item.percent}%` }}
          ></div>
        </div>
      </div>
      {item.tags.length > 0 && (
        <div className="agent-tags">
          {item.tags.slice(0, 3).map((tag, i) => (
            <span key={i} className={`agent-tag ${tag.tone}`}>
              <window.Icon name="spark" size={12} /> {tag.label}
            </span>
          ))}
        </div>
      )}
      <div className="card-actions">
        <button
          className="dash-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(item);
          }}
        >
          <window.Icon name="external-link" size={14} /> Open
        </button>
        {active ? (
          <>
            {isAgent && (
              <button
                className="dash-btn sub"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onPause) onPause(item);
                }}
              >
                <window.Icon name="pause-circle" size={14} /> Pause
              </button>
            )}
            <button
              className="dash-btn sub"
              onClick={(e) => {
                e.stopPropagation();
                onCancel(item);
              }}
            >
              <window.Icon name="stop" size={14} /> Cancel
            </button>
          </>
        ) : paused ? (
          <>
            <button
              className="dash-btn sub"
              onClick={(e) => {
                e.stopPropagation();
                if (onResume) onResume(item);
              }}
            >
              <window.Icon name="play-circle" size={14} /> Resume
            </button>
            <button
              className="dash-btn sub"
              onClick={(e) => {
                e.stopPropagation();
                onCancel(item);
              }}
            >
              <window.Icon name="stop" size={14} /> Cancel
            </button>
          </>
        ) : (
          item.status === 'done' && (
            <button
              className="dash-btn sub"
              onClick={(e) => {
                e.stopPropagation();
                if (onViewOutput) onViewOutput(item);
              }}
            >
              <window.Icon name="file-text" size={14} /> View Output
            </button>
          )
        )}
      </div>
    </div>
  );
}

function WorkflowDiagram({ wf }) {
  const nodes = [
    { icon: 'file-text', title: 'Input', desc: wfClip(wf.root.prompt, 36), state: 'source' },
    {
      icon: 'spark',
      title: wf.root.agentName || `#${wf.root.id}`,
      desc: 'Lead agent',
      state: wfStatusOf(wf.root.status).node,
    },
    ...wf.children.map((c) => ({
      icon: 'spark',
      title: c.agentName || `#${c.id}`,
      desc: wfClip(c.prompt, 36),
      state: wfStatusOf(c.status).node,
    })),
  ];
  return (
    <div className="workflow-diagram" style={{ overflowX: 'auto' }}>
      {nodes.map((n, i) => {
        const arrowGreen = n.state === 'done' || n.state === 'active';
        return (
          <React.Fragment key={i}>
            {i > 0 && <div className={`arrow${arrowGreen ? ' green' : ''}`}>→</div>}
            <div className={`node${n.state === 'active' ? ' active' : ''}`}>
              <window.Icon name={n.icon} size={20} />
              <h4>{n.title}</h4>
              <p>{n.desc}</p>
              {n.state === 'done' && (
                <div className="status-check green">
                  <window.Icon name="check" size={12} />
                </div>
              )}
              {n.state === 'active' && (
                <div className="status-spinner">
                  <window.Icon name="loader" size={12} className="spin" />
                </div>
              )}
              {n.state === 'error' && (
                <div className="status-check red">
                  <window.Icon name="x" size={12} />
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function LiveRunLog({ tasks, onOpen }) {
  return (
    <div className="dash-panel">
      <div className="panel-header">
        <h3>
          <window.Icon name="activity" size={16} /> Live Run Log
        </h3>
      </div>
      {tasks.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '6px 2px' }}>
          No agent activity yet.
        </div>
      ) : (
        <div className="log-table">
          {tasks.slice(0, 6).map((t) => {
            const meta = wfStatusOf(t.status);
            const when = t.finishedAt || t.startedAt || t.createdAt;
            return (
              <div
                key={t.id}
                className={`log-row${t.status === 'error' ? ' yellow-bg' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onOpen(t.id);
                }}
                style={{ cursor: 'pointer' }}
              >
                <span className="time">{wfRelTime(when)}</span>
                <window.Icon
                  name={meta.icon}
                  size={14}
                  className={`${meta.tone}-text${meta.spin ? ' spin' : ''}`}
                />
                <span className={`msg${t.status === 'error' ? ' red-text' : ''}`}>
                  {t.status === 'error' && t.error ? t.error : wfClip(t.prompt, 80)}
                </span>
                <span className={`tag ${wfTagTone(t.agentId)}`}>
                  {t.agentName || `#${t.agentId}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentStatusPanel({ agents, tasks, onNew, onEdit }) {
  const stateOf = (id) => {
    const mine = tasks.filter((t) => t.agentId === id);
    if (mine.some((t) => t.status === 'running')) return { tone: 'yellow', label: 'Busy' };
    if (mine.some((t) => t.status === 'queued')) return { tone: 'blue', label: 'Queued' };
    return { tone: 'green', label: 'Online' };
  };
  return (
    <div className="dash-panel">
      <div className="panel-header">
        <h3>
          <window.Icon name="activity" size={16} /> Agent Status
        </h3>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onNew();
          }}
        >
          + New
        </a>
      </div>
      {agents.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No agents yet.</div>
      ) : (
        <div className="status-list">
          {agents.map((a) => {
            const st = stateOf(a.id);
            return (
              <div
                className="status-item"
                key={a.id}
                role="button"
                tabIndex={0}
                onClick={() => onEdit(a)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onEdit(a);
                }}
                style={{ cursor: 'pointer' }}
                title="Edit agent"
              >
                <span className={`dot ${st.tone}`}></span> {a.name} <span>{st.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SystemHealthPanel({ state }) {
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
    <div className="dash-panel">
      <div className="panel-header">
        <h3>
          <window.Icon name="server" size={16} /> System Health
        </h3>
      </div>
      <div className="health-stats">
        <div className="stat-row">
          <span>
            <window.Icon name="cpu" size={14} /> CPU
          </span>
          <div className="val">
            {cpu == null ? '—' : `${cpu}%`}
            <div className="mini-bar">
              <div className="fill green" style={{ width: `${cpu ?? 0}%` }}></div>
            </div>
          </div>
        </div>
        <div className="stat-row">
          <span>
            <window.Icon name="database" size={14} /> RAM
          </span>
          <div className="val">
            {ram == null ? '—' : `${ram}%`}
            <div className="mini-bar">
              <div className="fill green" style={{ width: `${ram ?? 0}%` }}></div>
            </div>
          </div>
        </div>
        <div className="stat-row">
          <span>
            <window.Icon name="layers" size={14} /> Queue
          </span>
          <div className="val">{queue}</div>
        </div>
        <div className="stat-row">
          <span>
            <window.Icon name="alert-triangle" size={14} /> Errors (24h)
          </span>
          <div className={`val${errors > 0 ? ' red-text' : ''}`}>{errors}</div>
        </div>
      </div>
    </div>
  );
}

function ApprovalsPanel({ approvals, onResolve, busyId }) {
  const pending = (approvals && approvals.pending) || [];
  return (
    <div className="dash-panel">
      <div className="panel-header">
        <h3>
          <window.Icon name="shield" size={16} /> Approvals
        </h3>
        {pending.length > 0 && <span className="tag yellow">{pending.length} pending</span>}
      </div>
      {pending.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13, lineHeight: 1.5 }}>
          No pending approvals. Risky agent steps will appear here for sign-off.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {pending.map((a) => (
            <div className="approval-card" key={a.id}>
              <span className="tag yellow mb-2">PENDING</span>
              <span className="right">{wfRelTime(a.createdAt)}</span>
              <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>
                <strong style={{ color: 'var(--text)' }}>
                  {a.agentName || `Task #${a.taskId}`}
                </strong>{' '}
                wants to run <code>{a.toolName}</code>
                {a.preview ? ` — ${wfClip(a.preview, 120)}` : ''}
              </p>
              <div className="appr-actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <button
                  className="dash-btn green"
                  disabled={busyId === a.id}
                  onClick={() => onResolve(a.id, true)}
                >
                  <window.Icon name="check" size={14} /> Approve
                </button>
                <button
                  className="dash-btn red"
                  disabled={busyId === a.id}
                  onClick={() => onResolve(a.id, false)}
                >
                  <window.Icon name="x" size={14} /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The mission-control layout: workflow cards + pipeline diagram + run log down
// the left, a status/health/approvals/memory sidebar down the right.
function MissionControl({
  tasks,
  wfRuns,
  wfNameById,
  agents,
  state,
  approvals,
  onResolveApproval,
  approvalBusyId,
  onOpenItem,
  onCancelItem,
  onPauseItem,
  onResumeItem,
  onPauseAll,
  onCancelAll,
  onResumeAll,
  onViewOutputItem,
  onManageAgents,
  onNewAgent,
  onEditAgent,
}) {
  const [selectedKey, setSelectedKey] = useState(null);
  const [filter, setFilter] = useState('Active');
  const items = buildFeed(tasks, wfRuns, wfNameById, filter);
  const selected = items.find((it) => it.key === selectedKey) || items[0] || null;
  return (
    <div className="dash-bottom-grid" style={{ marginBottom: 26 }}>
      <div className="dash-col-left">
        <div className="dash-header" style={{ marginBottom: 0 }}>
          <h2>{filter} runs</h2>
          <div
            className="dash-header-actions"
            style={{ display: 'flex', gap: 8, alignItems: 'center' }}
          >
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <select
                className="dash-btn sub"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setSelectedKey(null);
                }}
                style={{ appearance: 'none', paddingRight: 24, cursor: 'pointer' }}
              >
                <option
                  value="All"
                  style={{ background: 'var(--surface-2)', color: 'var(--text)' }}
                >
                  All
                </option>
                <option
                  value="Active"
                  style={{ background: 'var(--surface-2)', color: 'var(--text)' }}
                >
                  Active
                </option>
                <option
                  value="Inactive"
                  style={{ background: 'var(--surface-2)', color: 'var(--text)' }}
                >
                  Inactive
                </option>
              </select>
              <window.Icon
                name="chevron-down"
                size={14}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  pointerEvents: 'none',
                }}
              />
            </div>
            {filter === 'Active' && (
              <>
                <button className="dash-btn sub" onClick={onPauseAll}>
                  <window.Icon name="pause-circle" size={14} /> Pause All
                </button>
                <button className="dash-btn sub" onClick={onCancelAll}>
                  <window.Icon name="stop" size={14} /> Stop All
                </button>
                <button className="dash-btn sub" onClick={onResumeAll}>
                  <window.Icon name="play-circle" size={14} /> Resume All
                </button>
              </>
            )}
            <button className="dash-btn sub" onClick={onManageAgents}>
              <window.Icon name="gear" size={14} /> Manage Agents
            </button>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="dash-card">
            <div style={{ color: 'var(--text-3)', fontSize: 14, padding: '8px 2px' }}>
              No {filter.toLowerCase()} runs. Launch a workflow or dispatch an agent above and it
              shows up here — agent task-trees and authored-workflow runs alike.
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 16,
            }}
          >
            {items.map((it) => (
              <WorkflowCard
                key={it.key}
                item={it}
                selected={selected && it.key === selected.key}
                onSelect={setSelectedKey}
                onOpen={onOpenItem}
                onCancel={onCancelItem}
                onPause={onPauseItem}
                onResume={onResumeItem}
                onViewOutput={onViewOutputItem}
              />
            ))}
          </div>
        )}

        {selected && (
          <div className="dash-section" style={{ marginBottom: 0 }}>
            <div className="section-header">
              <h3>
                <window.Icon name="git-merge" size={16} className="green-text" />{' '}
                {selected.kind === 'agent' ? 'Agent run' : 'Workflow run'}: {selected.title}
              </h3>
              <span className={`status-label ${selected.meta.tone}`}>
                <span className={`dot ${selected.meta.tone}`}></span> {selected.meta.label}
              </span>
            </div>
            {selected.kind === 'agent' ? (
              <WorkflowDiagram wf={selected} />
            ) : (
              <div
                className="dash-card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <span style={{ color: 'var(--text-3)', fontSize: 13.5 }}>
                  Authored workflow run — open it to see each node’s status and output.
                </span>
                <button className="dash-btn" onClick={() => onOpenItem(selected)}>
                  <window.Icon name="external-link" size={14} /> Open run
                </button>
              </div>
            )}
          </div>
        )}

        <LiveRunLog tasks={tasks} onOpen={(id) => onOpenItem({ kind: 'agent', id })} />
      </div>

      <div className="dash-col-right">
        <AgentStatusPanel agents={agents} tasks={tasks} onNew={onNewAgent} onEdit={onEditAgent} />
        <SystemHealthPanel state={state} />
        <ApprovalsPanel
          approvals={approvals}
          onResolve={onResolveApproval}
          busyId={approvalBusyId}
        />
      </div>
    </div>
  );
}

function AgentsFleet({ agents, onNew, onEdit, onDelete, onDispatch, onSchedule }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h2>Agents</h2>
        <window.Button variant="primary" icon="plus" onClick={onNew}>
          New Agent
        </window.Button>
      </div>
      {agents.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>No agents yet. Click New Agent to create one.</div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          {agents.map((agent) => (
            <div key={agent.id} className="dash-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 'bold', fontSize: 15 }}>{agent.name}</div>
                  {agent.role && (
                    <div style={{ color: 'var(--text-3)', fontSize: 12.5, marginTop: 4 }}>
                      {agent.role}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {agent.mode === 'autonomous' && <window.Badge tone="ok">autonomous</window.Badge>}
                  {agent.thinkMode && agent.thinkMode !== 'auto' && (
                    <window.Badge tone="neutral">
                      {agent.thinkMode === 'on' ? 'think' : 'no-think'}
                    </window.Badge>
                  )}
                  <window.Badge tone="accent">{agent.profile}</window.Badge>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <window.Button variant="primary" icon="send" onClick={() => onDispatch(agent)}>
                  Dispatch
                </window.Button>
                <window.Button variant="subtle" icon="clock" onClick={() => onSchedule(agent)}>
                  Schedule
                </window.Button>
                <window.Button variant="subtle" icon="gear" onClick={() => onEdit(agent)}>
                  Edit
                </window.Button>
                <window.Button variant="subtle" icon="trash" onClick={() => onDelete(agent)}>
                  Delete
                </window.Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One bar to start work: dispatch a task to an agent, or run a saved workflow.
// This is what makes "New Run" actually launch something.
function LaunchComposer({ agents, workflows, onDispatchAgent, onRunWorkflow }) {
  const [mode, setMode] = useState('agent');
  const [agentId, setAgentId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [text, setText] = useState('');
  // 'inherit' = use the agent's saved think mode; otherwise override this run.
  const [think, setThink] = useState('inherit');
  // Files/images/PDFs for this launch. null = don't block visual drops up front;
  // the server gates images on the target's model and reports any it skips.
  const att = window.useAttachments(null);
  // An agent needs a prompt; a workflow can launch on attachments alone.
  const canLaunch =
    mode === 'agent' ? !!agentId && (!!text.trim() || !!att.staged.length) : !!workflowId;
  const launch = () => {
    if (!canLaunch || att.staging) return;
    const stageToken = att.token;
    if (mode === 'agent')
      onDispatchAgent(
        Number(agentId),
        text.trim(),
        think === 'inherit' ? undefined : think,
        stageToken,
      );
    else onRunWorkflow(Number(workflowId), text.trim() || null, stageToken);
    setText('');
    att.clear();
  };
  return (
    <div className="dash-card" style={{ marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <window.Icon name="play" size={18} className="green-text" />
        <h3 style={{ fontSize: 16, margin: 0 }}>Launch</h3>
        <window.Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'agent', label: 'Agent' },
            { value: 'workflow', label: 'Workflow' },
          ]}
        />
        <div style={{ flex: 1, minWidth: 180 }}>
          {mode === 'agent' ? (
            <window.Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">— Select agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </window.Select>
          ) : (
            <window.Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
              <option value="">— Select workflow —</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </window.Select>
          )}
        </div>
        {mode === 'agent' && (
          <div
            style={{ minWidth: 130 }}
            title="Reasoning for this run (overrides the agent default)"
          >
            <window.Select value={think} onChange={(e) => setThink(e.target.value)}>
              <option value="inherit">Think: default</option>
              <option value="auto">Think: auto</option>
              <option value="on">Think: on</option>
              <option value="off">Think: off</option>
            </window.Select>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <window.AttachButton onPick={att.addFiles} title="Attach files or a folder for this run" />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={mode === 'agent' ? 'Task for the agent…' : 'Workflow input (optional)…'}
          style={{
            flex: 1,
            resize: 'vertical',
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
            color: 'var(--text)',
            font: 'inherit',
          }}
        />
        <window.Button variant="primary" icon="play" disabled={!canLaunch} onClick={launch}>
          Launch
        </window.Button>
      </div>
      {att.files.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <window.AttachChips files={att.files} onRemove={att.remove} />
        </div>
      )}
    </div>
  );
}

function AgentsTab({ state }) {
  const [view, setView] = useState('run'); // run | agents | workflows
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [workflows, setWorkflows] = useState([]); // authored workflow definitions
  const [wfRuns, setWfRuns] = useState([]); // authored workflow runs
  const [schedules, setSchedules] = useState([]);
  const [editing, setEditing] = useState(null); // agent object or EMPTY_AGENT when creating
  const [dispatchFor, setDispatchFor] = useState(null); // agent to dispatch to
  const [scheduleFor, setScheduleFor] = useState(null); // agent preselected for scheduling; null = choose in modal
  const [openTask, setOpenTask] = useState(null); // agent task id whose detail is open
  const [openWfRun, setOpenWfRun] = useState(null); // workflow run id whose detail is open
  const [viewOutputFor, setViewOutputFor] = useState(null); // task object
  const [pauseTarget, setPauseTarget] = useState(null); // { task, isBulk }
  const [approvals, setApprovals] = useState({ pending: [], recent: [] });
  const [approvalBusyId, setApprovalBusyId] = useState(null); // approval id mid-resolve
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [a, t, w, wr, s, p] = await Promise.all([
      window.api.get('/api/agents'),
      window.api.get('/api/agents/tasks'),
      window.api.get('/api/workflows'),
      window.api.get('/api/workflows/runs?limit=50'),
      window.api.get('/api/agents/schedules'),
      window.api.get('/api/agents/approvals'),
    ]);
    if (a.ok) setAgents(a.data.agents || []);
    if (t.ok) setTasks(t.data.tasks || []);
    if (w.ok) setWorkflows(w.data.workflows || []);
    if (wr.ok) setWfRuns(wr.data.runs || []);
    if (s.ok) setSchedules(s.data.schedules || []);
    if (p.ok) setApprovals({ pending: p.data.pending || [], recent: p.data.recent || [] });
  }, []);

  const wfNameById = useMemo(() => {
    const m = new Map();
    for (const w of workflows) m.set(w.id, w.name);
    return m;
  }, [workflows]);

  const resolveApproval = async (id, approved) => {
    setApprovalBusyId(id);
    // Optimistically drop it from the pending list so the buttons don't linger.
    setApprovals((cur) => ({ ...cur, pending: cur.pending.filter((a) => a.id !== id) }));
    const r = await window.api.post(`/api/agents/approvals/${id}/resolve`, { approved });
    if (!r.ok) setError(r.error || 'Could not record the decision');
    setApprovalBusyId(null);
    load();
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const saveAgent = async (draft) => {
    setError('');
    const r = draft.id
      ? await fetchPut(`/api/agents/${draft.id}`, draft)
      : await window.api.post('/api/agents', draft);
    if (!r.ok) {
      setError(r.error || 'Save failed');
      return;
    }
    setEditing(null);
    load();
  };

  const removeAgent = async (agent) => {
    if (!window.confirm(`Delete agent “${agent.name}”? Its task history stays.`)) return;
    await fetchDelete(`/api/agents/${agent.id}`);
    load();
  };

  const dispatch = async (agent, prompt, thinkMode, stageToken) => {
    setError('');
    const r = await window.api.post(`/api/agents/${agent.id}/dispatch`, {
      prompt,
      thinkMode,
      ...(stageToken ? { stageToken } : {}),
    });
    if (!r.ok) {
      setError(r.error || 'Dispatch failed');
      return;
    }
    // Files dropped for an incompatible model are dropped on the floor server-side;
    // surface that so the user isn't surprised the agent never saw them.
    if (r.data && Array.isArray(r.data.rejected) && r.data.rejected.length) {
      setError(`Some attachments were skipped: ${r.data.rejected.join('; ')}`);
    }
    setDispatchFor(null);
    load();
  };

  // Launch composer: dispatch by id / run a saved workflow by id.
  const dispatchById = async (agentId, prompt, thinkMode, stageToken) => {
    setError('');
    const r = await window.api.post(`/api/agents/${agentId}/dispatch`, {
      prompt,
      thinkMode,
      ...(stageToken ? { stageToken } : {}),
    });
    if (!r.ok) setError(r.error || 'Dispatch failed');
    else if (r.data && r.data.rejected && r.data.rejected.length) {
      setError(`Some attachments were skipped: ${r.data.rejected.join('; ')}`);
    }
    load();
  };
  const runWorkflowById = async (workflowId, input, stageToken) => {
    setError('');
    const r = await window.api.post(`/api/workflows/${workflowId}/run`, {
      input,
      ...(stageToken ? { stageToken } : {}),
    });
    if (!r.ok) setError(r.error || 'Run failed');
    load();
  };

  const cancelTask = async (task) => {
    if (!task || !['queued', 'running', 'paused'].includes(task.status)) return;
    await window.api.post(`/api/agents/tasks/${task.id}/cancel`);
    load();
  };

  const cancelWfRun = async (id) => {
    await window.api.post(`/api/workflows/runs/${id}/cancel`);
    load();
  };

  // Kind-aware handlers for the merged Run feed (item = normalized feed entry).
  const openItem = (item) => (item.kind === 'agent' ? setOpenTask(item.id) : setOpenWfRun(item.id));
  const cancelItem = (item) =>
    item.kind === 'agent' ? cancelTask(item.root) : cancelWfRun(item.id);
  const viewOutputItem = (item) =>
    item.kind === 'agent' ? setViewOutputFor(item.root) : setOpenWfRun(item.id);

  const requestPauseTask = (task) => setPauseTarget({ task, isBulk: false });
  const requestPauseAll = () => setPauseTarget({ task: null, isBulk: true });

  const executePause = async (until) => {
    const { task, isBulk } = pauseTarget;
    setPauseTarget(null);
    if (isBulk) {
      await window.api.post('/api/agents/tasks/pause_all', { until });
    } else if (task) {
      await window.api.post(`/api/agents/tasks/${task.id}/pause`, { until });
    }
    load();
  };

  const resumeTask = async (task) => {
    if (!task || task.status !== 'paused') return;
    await window.api.post(`/api/agents/tasks/${task.id}/resume`);
    load();
  };

  const resumeAll = async () => {
    await window.api.post('/api/agents/tasks/resume_all');
    load();
  };

  const cancelAll = async () => {
    if (!window.confirm('Are you sure you want to stop all active runs?')) return;
    await window.api.post('/api/agents/tasks/cancel_all');
    await Promise.all(
      wfRuns
        .filter((r) => r.status === 'queued' || r.status === 'running')
        .map((r) => window.api.post(`/api/workflows/runs/${r.id}/cancel`)),
    );
    load();
  };

  const createSchedule = async (draft) => {
    setError('');
    const r = await window.api.post('/api/agents/schedules', draft);
    if (!r.ok) {
      setError(r.error || 'Schedule failed');
      return;
    }
    setScheduleFor(null);
    load();
  };

  const removeSchedule = async (schedule) => {
    await fetchDelete(`/api/agents/schedules/${schedule.id}`);
    load();
  };

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <window.Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'run', label: 'Run' },
            { value: 'agents', label: 'Agents' },
            { value: 'workflows', label: 'Workflows' },
          ]}
        />
      </div>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <window.Badge tone="err">{error}</window.Badge>
        </div>
      )}

      {view === 'run' && (
        <>
          <LaunchComposer
            agents={agents}
            workflows={workflows}
            onDispatchAgent={dispatchById}
            onRunWorkflow={runWorkflowById}
          />

          <MissionControl
            tasks={tasks}
            wfRuns={wfRuns}
            wfNameById={wfNameById}
            agents={agents}
            state={state}
            approvals={approvals}
            onResolveApproval={resolveApproval}
            approvalBusyId={approvalBusyId}
            onOpenItem={openItem}
            onCancelItem={cancelItem}
            onPauseItem={(item) => requestPauseTask(item.root)}
            onResumeItem={(item) => resumeTask(item.root)}
            onPauseAll={requestPauseAll}
            onCancelAll={cancelAll}
            onResumeAll={resumeAll}
            onViewOutputItem={viewOutputItem}
            onManageAgents={() => setView('agents')}
            onNewAgent={() => setEditing({ ...EMPTY_AGENT })}
            onEditAgent={(a) => setEditing(a)}
          />

          <window.SectionTitle
            sub="Timed one-shot and recurring agent work."
            right={
              <window.Button variant="primary" icon="plus" onClick={() => setScheduleFor({})}>
                Add Schedule
              </window.Button>
            }
          >
            Schedules
          </window.SectionTitle>
          <ScheduleList schedules={schedules} onDelete={removeSchedule} />
        </>
      )}

      {view === 'agents' && (
        <AgentsFleet
          agents={agents}
          onNew={() => setEditing({ ...EMPTY_AGENT })}
          onEdit={(a) => setEditing(a)}
          onDelete={removeAgent}
          onDispatch={(a) => setDispatchFor(a)}
          onSchedule={(a) => setScheduleFor(a)}
        />
      )}

      {view === 'workflows' && <window.WorkflowBuilder state={state} />}

      {editing && (
        <AgentEditor
          initial={editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSave={saveAgent}
          error={error}
        />
      )}
      {dispatchFor && (
        <DispatchModal
          agent={dispatchFor}
          onClose={() => setDispatchFor(null)}
          onDispatch={(p, tm, st) => dispatch(dispatchFor, p, tm, st)}
        />
      )}
      {scheduleFor && (
        <ScheduleModal
          agents={agents}
          initialAgent={scheduleFor.id ? scheduleFor : null}
          onClose={() => setScheduleFor(null)}
          onSchedule={createSchedule}
        />
      )}
      {pauseTarget && (
        <PauseModal
          task={pauseTarget.task}
          isBulk={pauseTarget.isBulk}
          onClose={() => setPauseTarget(null)}
          onConfirm={executePause}
        />
      )}
      {openTask != null && (
        <TaskDetail
          taskId={openTask}
          onClose={() => setOpenTask(null)}
          onCancelled={() => {
            setOpenTask(null);
            load();
          }}
        />
      )}
      {openWfRun != null && (
        <WorkflowRunDetail runId={openWfRun} onClose={() => setOpenWfRun(null)} />
      )}
      {viewOutputFor && <OutputModal task={viewOutputFor} onClose={() => setViewOutputFor(null)} />}
    </div>
  );
}

// Mirror of the server's classifyKind so the UI can label chips and block
// image/PDF drops before staging when the agent's model isn't multimodal.
// A <label> styled like a subtle Button — clicking it opens the nested hidden
// file input natively (a real <button> inside a <label> doesn't do that).
const PICK_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 14,
  padding: '10px 15px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  userSelect: 'none',
};
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
function classifyDrop(name, type) {
  const lower = name.toLowerCase();
  if ((type || '').startsWith('image/') || IMAGE_EXTS.some((e) => lower.endsWith(e)))
    return 'image';
  if ((type || '') === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  return 'file';
}

// Folder uploads carry a webkitRelativePath ("proj/src/foo.ts"), so a big project
// would otherwise render one chip per file. Collapse each top-level folder into a
// single chip (with a count + aggregate status); loose files stay as-is.
function groupAttachments(files) {
  const folders = new Map(); // name -> file[]
  const loose = [];
  for (const f of files) {
    const slash = f.rel.indexOf('/');
    if (slash > 0) {
      const name = f.rel.slice(0, slash);
      if (!folders.has(name)) folders.set(name, []);
      folders.get(name).push(f);
    } else {
      loose.push(f);
    }
  }
  const folderItems = [];
  for (const [name, fs] of folders) {
    // Worst status wins so a single failure/blocked file stays visible at the folder level.
    const status = fs.some((f) => f.status === 'error')
      ? 'error'
      : fs.some((f) => f.status === 'blocked')
        ? 'blocked'
        : fs.some((f) => f.status === 'staging')
          ? 'staging'
          : 'ready';
    folderItems.push({ id: `dir:${name}`, name, count: fs.length, status });
  }
  return { folderItems, loose };
}

function DispatchModal({ agent, onClose, onDispatch }) {
  const [prompt, setPrompt] = useState('');
  // 'inherit' keeps the agent's saved think mode; the rest override this run.
  const [think, setThink] = useState('inherit');
  // null = still resolving the agent's model capability.
  const [multimodal, setMultimodal] = useState(null);
  // One staging batch per modal session; dispatch ingests this dir then deletes it.
  // crypto.randomUUID needs a secure context — the panel is often plain HTTP on a
  // LAN IP, so fall back to a Math.random token (matches the server's [a-z0-9] regex).
  const stageToken = useMemo(
    () =>
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, '')
        : Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join(''),
    [],
  );
  // { rel, kind, status: 'staging'|'ready'|'blocked'|'error', err? }
  const [files, setFiles] = useState([]);
  const [staging, setStaging] = useState(false);

  useEffect(() => {
    let live = true;
    window.api.get(`/api/agents/${agent.id}/capabilities`).then((r) => {
      if (live) setMultimodal(r.ok && r.data ? !!r.data.multimodal : false);
    });
    return () => {
      live = false;
    };
  }, [agent.id]);

  const addFiles = async (fileList) => {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;
    setStaging(true);
    for (const f of picked) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const rel = f.webkitRelativePath || f.name;
      const kind = classifyDrop(f.name, f.type);
      // Block visual drops up front when the model can't see them.
      if (kind !== 'file' && multimodal === false) {
        setFiles((prev) => [...prev, { id, rel, kind, status: 'blocked' }]);
        continue;
      }
      setFiles((prev) => [...prev, { id, rel, kind, status: 'staging' }]);
      const r = await window.api.postRaw('/api/agents/attachments/stage', f, {
        'x-stage-token': stageToken,
        'x-filename': rel,
      });
      setFiles((prev) =>
        prev.map((x) =>
          x.id === id
            ? { ...x, status: r.ok ? 'ready' : 'error', ...(r.ok ? {} : { err: r.error }) }
            : x,
        ),
      );
    }
    setStaging(false);
  };

  const staged = files.filter((f) => f.status === 'ready');
  const { folderItems, loose } = groupAttachments(files);
  const KIND_ICON = { image: 'image', pdf: 'file-text', file: 'doc' };
  const TONE = { ready: 'ok', staging: 'neutral', blocked: 'err', error: 'err' };

  return (
    <window.Modal
      open
      onClose={onClose}
      disableOutsideClick
      title={`Dispatch to ${agent.name}`}
      footer={
        <>
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon="send"
            disabled={!prompt.trim() || staging}
            onClick={() =>
              onDispatch(
                prompt.trim(),
                think === 'inherit' ? undefined : think,
                staged.length ? stageToken : undefined,
              )
            }
          >
            Dispatch
          </window.Button>
        </>
      }
    >
      <window.Label hint="The agent runs this in the background; watch it under Tasks.">
        Task
      </window.Label>
      <textarea
        autoFocus
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="e.g. Summarize my unread email and draft three replies"
        style={{
          width: '100%',
          resize: 'vertical',
          padding: '10px 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          color: 'var(--text)',
          font: 'inherit',
        }}
      />

      <div style={{ marginTop: 12 }}>
        <window.Label
          hint={
            multimodal === false
              ? "This agent's model is text-only — images and PDFs will be skipped."
              : 'Drop files or a folder for the agent to read. Images and PDFs supported.'
          }
        >
          Attachments
        </window.Label>
        <div
          style={{ display: 'flex', gap: 8, marginBottom: staged.length || files.length ? 8 : 0 }}
        >
          <label style={PICK_BTN}>
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => addFiles(e.target.files)}
            />
            <window.Icon name="plus" size={15} /> Add files
          </label>
          <label style={PICK_BTN}>
            <input
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              style={{ display: 'none' }}
              onChange={(e) => addFiles(e.target.files)}
            />
            <window.Icon name="folder" size={15} /> Add folder
          </label>
        </div>
        {files.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {folderItems.map((d) => (
              <window.Badge key={d.id} tone={TONE[d.status] || 'neutral'}>
                <window.Icon name="folder" size={12} /> {d.name}/ ({d.count}{' '}
                {d.count === 1 ? 'file' : 'files'}){d.status === 'staging' && ' …'}
                {d.status === 'blocked' && ' (some need vision model)'}
                {d.status === 'error' && ' (some failed)'}
              </window.Badge>
            ))}
            {loose.map((f) => (
              <window.Badge key={f.id} tone={TONE[f.status] || 'neutral'}>
                <window.Icon name={KIND_ICON[f.kind] || 'file'} size={12} /> {f.rel}
                {f.status === 'staging' && ' …'}
                {f.status === 'blocked' && ' (needs vision model)'}
                {f.status === 'error' && ` (${f.err || 'failed'})`}
              </window.Badge>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <window.Label
          hint={`Reasoning for this run. Default = ${agent.thinkMode || 'auto'} (the agent's saved setting).`}
        >
          Reasoning
        </window.Label>
        <window.Select value={think} onChange={(e) => setThink(e.target.value)}>
          <option value="inherit">Inherit agent default</option>
          <option value="auto">Auto (model default)</option>
          <option value="on">Think</option>
          <option value="off">No-think</option>
        </window.Select>
      </div>
    </window.Modal>
  );
}

function PauseModal({ task, isBulk, onClose, onConfirm }) {
  const [mode, setMode] = useState('forever'); // 'forever' | 'until'
  const [until, setUntil] = useState('');

  return (
    <window.Modal
      open
      onClose={onClose}
      title={isBulk ? 'Pause All Workflows' : `Pause Workflow ${task ? `#${task.id}` : ''}`}
      footer={
        <>
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon="pause-circle"
            disabled={mode === 'until' && !until}
            onClick={() => {
              const ts = mode === 'until' ? new Date(until).getTime() : null;
              onConfirm(ts);
            }}
          >
            Pause
          </window.Button>
        </>
      }
    >
      <div style={{ marginBottom: 16 }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            cursor: 'pointer',
          }}
        >
          <input type="radio" checked={mode === 'forever'} onChange={() => setMode('forever')} />
          Pause indefinitely
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="radio" checked={mode === 'until'} onChange={() => setMode('until')} />
          Pause until a specific date and time
        </label>
      </div>

      {mode === 'until' && (
        <Field
          label="Resume At"
          hint="The system will automatically resume the workflow at this time."
        >
          <input
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              font: 'inherit',
            }}
          />
        </Field>
      )}
    </window.Modal>
  );
}

function localDateTimeValue(ms) {
  const d = new Date(ms);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseLocalDateTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function ScheduleList({ schedules, onDelete }) {
  if (schedules.length === 0) {
    return (
      <window.Card>
        <div style={{ color: 'var(--text-3)', fontSize: 14 }}>No schedules yet.</div>
      </window.Card>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 26 }}>
      {schedules.map((s) => (
        <div
          key={s.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <window.Badge tone={s.active ? 'accent' : 'neutral'}>
            {s.active ? s.recurrence : 'done'}
          </window.Badge>
          <span style={{ fontWeight: 600, fontSize: 13, minWidth: 130 }}>
            {(s.agentNames || []).join(', ')}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              color: 'var(--text-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.prompt}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            {new Date(s.nextRunAt).toLocaleString()}
          </span>
          <window.Button size="sm" variant="subtle" icon="trash" onClick={() => onDelete(s)} />
        </div>
      ))}
    </div>
  );
}

function ScheduleModal({ agents, initialAgent, onClose, onSchedule }) {
  const [selected, setSelected] = useState(() => (initialAgent ? [initialAgent.id] : []));
  const [prompt, setPrompt] = useState('');
  const [when, setWhen] = useState(() => localDateTimeValue(Date.now() + 60 * 60_000));
  const [recurrence, setRecurrence] = useState('once');
  const toggleAgent = (id) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const nextRunAt = parseLocalDateTime(when);
  const invalidTime = nextRunAt === null || nextRunAt <= Date.now();
  return (
    <window.Modal
      open
      onClose={onClose}
      width={560}
      title="Schedule agents"
      footer={
        <>
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon="send"
            disabled={selected.length === 0 || !prompt.trim() || invalidTime}
            onClick={() =>
              onSchedule({
                agentIds: selected,
                prompt: prompt.trim(),
                nextRunAt,
                recurrence,
              })
            }
          >
            Schedule
          </window.Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Agents">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => toggleAgent(a.id)}
                style={{
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${selected.includes(a.id) ? 'var(--accent)' : 'var(--border)'}`,
                  background: selected.includes(a.id) ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 13,
                }}
              >
                {a.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Task">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="e.g. Run my morning briefing and draft today's priorities"
            style={{
              width: '100%',
              resize: 'vertical',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              font: 'inherit',
            }}
          />
        </Field>
        <Row>
          <Field label="Date and time">
            <window.Input
              type="datetime-local"
              value={when}
              min={localDateTimeValue(Date.now() + 60_000)}
              onChange={(e) => setWhen(e.target.value)}
            />
          </Field>
          <Field label="Repeat">
            <window.Select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              <option value="once">once (specific date)</option>
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
              <option value="monthly">monthly</option>
              <option value="yearly">yearly</option>
            </window.Select>
          </Field>
        </Row>
      </div>
    </window.Modal>
  );
}

function AgentEditor({ initial, agents, onClose, onSave, error }) {
  const [d, setD] = useState(() => ({
    ...EMPTY_AGENT,
    ...initial,
    delegatableAgents: initial.delegatableAgents || [],
  }));
  const set = (k, v) => setD((s) => ({ ...s, [k]: v }));
  const allowlistText = d.toolAllowlist === null ? '' : listToText(d.toolAllowlist);
  const otherAgents = agents.filter((a) => a.id !== d.id).map((a) => a.name);

  return (
    <window.Modal
      open
      onClose={onClose}
      width={560}
      title={d.id ? `Edit ${initial.name}` : 'New agent'}
      footer={
        <>
          {error && <window.Badge tone="err">{error}</window.Badge>}
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon="check"
            disabled={!d.name.trim() || !d.systemPrompt.trim()}
            onClick={() => onSave(d)}
          >
            Save
          </window.Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Row>
          <Field label="Name">
            <window.Input
              value={d.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="researcher"
            />
          </Field>
          <Field label="Model profile" hint="reason = heavy 9B; chat/tools = tiny">
            <window.Select value={d.profile} onChange={(e) => set('profile', e.target.value)}>
              <option value="chat">chat</option>
              <option value="tools">tools</option>
              <option value="reason">reason (heavy)</option>
            </window.Select>
          </Field>
        </Row>
        <Field
          label="Reasoning"
          hint="Thinking-capable models (qwen3, gemma4) only; no-op otherwise. Auto = model default."
        >
          <window.Segmented
            size="sm"
            value={d.thinkMode || 'auto'}
            onChange={(v) => set('thinkMode', v)}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'on', label: 'Think' },
              { value: 'off', label: 'No-think' },
            ]}
          />
        </Field>
        <Field
          label="Run mode"
          hint="Autonomous = plans and works a multi-step goal over many turns until done."
        >
          <window.Segmented
            size="sm"
            value={d.mode || 'single'}
            onChange={(v) => set('mode', v)}
            options={[
              { value: 'single', label: 'Single turn' },
              { value: 'autonomous', label: 'Autonomous' },
            ]}
          />
        </Field>
        {d.mode === 'autonomous' && (
          <Row>
            <Field
              label="Max rounds"
              hint="Loop turns before it must finish. Blank = default (30)."
            >
              <window.Input
                type="number"
                min={1}
                max={200}
                value={d.maxTotalRounds ?? ''}
                placeholder="30"
                onChange={(e) =>
                  set('maxTotalRounds', e.target.value === '' ? null : Number(e.target.value))
                }
              />
            </Field>
            <Field label="Max minutes" hint="Wall-clock cap. Blank = default (30 min).">
              <window.Input
                type="number"
                min={1}
                max={360}
                value={d.maxWallClockMs ? Math.round(d.maxWallClockMs / 60000) : ''}
                placeholder="30"
                onChange={(e) =>
                  set(
                    'maxWallClockMs',
                    e.target.value === '' ? null : Number(e.target.value) * 60000,
                  )
                }
              />
            </Field>
          </Row>
        )}
        <Field label="Role" hint="One line; shown on the card.">
          <window.Input
            value={d.role}
            onChange={(e) => set('role', e.target.value)}
            placeholder="Gathers facts from the web"
          />
        </Field>
        <Field label="System prompt">
          <textarea
            value={d.systemPrompt}
            onChange={(e) => set('systemPrompt', e.target.value)}
            rows={5}
            placeholder="You are a focused research agent. …"
            style={{
              width: '100%',
              resize: 'vertical',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              font: 'inherit',
            }}
          />
        </Field>
        <Field
          label="Tool allowlist"
          hint="Comma-separated module or tool names. Leave blank for ALL tools; a single space-cleared value means none."
        >
          <window.Input
            value={allowlistText}
            placeholder="modulus-websearch, modulus-everyday-assistant"
            onChange={(e) => {
              const txt = e.target.value;
              set('toolAllowlist', txt.trim() === '' ? null : textToList(txt));
            }}
          />
        </Field>
        <Row>
          <Field label="Execution mode" hint="sequential = one of its tasks at a time">
            <window.Select
              value={d.executionMode}
              onChange={(e) => set('executionMode', e.target.value)}
            >
              <option value="sequential">sequential</option>
              <option value="parallel">parallel</option>
            </window.Select>
          </Field>
          <Field label="Max concurrency" hint="Parallel mode only">
            <window.Input
              type="number"
              min={1}
              max={8}
              value={d.maxConcurrency}
              onChange={(e) => set('maxConcurrency', Number(e.target.value))}
            />
          </Field>
          <Field label="Max tool rounds">
            <window.Input
              type="number"
              min={1}
              max={12}
              value={d.maxToolRounds}
              onChange={(e) => set('maxToolRounds', Number(e.target.value))}
            />
          </Field>
        </Row>
        <Field
          label="Delegation"
          hint="Allow this agent to spawn sub-agents (the spawn_agent tool)."
        >
          <window.Toggle
            checked={!!d.canDelegate}
            onChange={(v) => set('canDelegate', v)}
            label="Can delegate"
          />
        </Field>
        {d.canDelegate && (
          <Field
            label="May delegate to"
            hint="Comma-separated agent names. Leave blank to allow any agent."
          >
            <window.Input
              value={listToText(d.delegatableAgents)}
              placeholder={otherAgents.join(', ')}
              onChange={(e) => set('delegatableAgents', textToList(e.target.value))}
            />
          </Field>
        )}
      </div>
    </window.Modal>
  );
}

// Live view of the model's reasoning as it works. Streamed from the daemon via
// the task's live_text (throttled ~1/s, since the panel only reads the DB), it
// auto-scrolls to the newest tokens. Only shown while the task is actually
// running; cleared by the loop on completion.
function ThinkingPane({ text, running }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  if (!running || !text) return null;
  return (
    <div>
      <window.Label hint="The model's live reasoning for the current step.">Thinking</window.Label>
      <pre
        ref={ref}
        style={{
          margin: 0,
          padding: 10,
          maxHeight: 200,
          overflow: 'auto',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          fontSize: 12.5,
          lineHeight: 1.5,
          color: 'var(--text-2)',
          whiteSpace: 'pre-wrap',
          fontFamily: 'var(--mono, monospace)',
        }}
      >
        {text}
      </pre>
    </div>
  );
}

// A live checklist of the autonomous plan. Steps flip done as the loop ticks.
function PlanChecklist({ plan }) {
  if (!plan || !plan.steps || plan.steps.length === 0) return null;
  const icon = { done: 'check-circle', active: 'loader', pending: 'circle' };
  const tone = { done: 'green', active: 'blue', pending: 'gray' };
  return (
    <div>
      <window.Label>Plan</window.Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {plan.steps.map((s) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <window.Icon
              name={icon[s.status] || 'circle'}
              size={14}
              className={`${tone[s.status] || 'gray'}-text${s.status === 'active' ? ' spin' : ''}`}
            />
            <span
              style={{
                color: s.status === 'done' ? 'var(--text-3)' : 'var(--text-2)',
                textDecoration: s.status === 'done' ? 'line-through' : 'none',
              }}
            >
              {s.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Budget burn-down: rounds used vs cap, and elapsed wall-clock vs cap.
function BudgetGauge({ task, agent }) {
  if (!agent || agent.mode !== 'autonomous') return null;
  const rounds = task.roundsUsed || 0;
  const maxRounds = agent.maxTotalRounds || 30;
  const elapsed = task.startedAt ? Date.now() - task.startedAt : 0;
  const maxWall = agent.maxWallClockMs || 30 * 60_000;
  const pct = (n, d) => Math.min(100, Math.round((n / Math.max(1, d)) * 100));
  const mins = (ms) => `${Math.floor(ms / 60000)}m`;
  const bar = (label, used, max, text, tone) => (
    <div style={{ flex: 1, minWidth: 120 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11.5,
          color: 'var(--text-3)',
        }}
      >
        <span>{label}</span>
        <span>{text}</span>
      </div>
      <div className="mini-bar">
        <div className={`fill ${tone}`} style={{ width: `${pct(used, max)}%` }} />
      </div>
    </div>
  );
  return (
    <div>
      <window.Label>Budget</window.Label>
      <div style={{ display: 'flex', gap: 12 }}>
        {bar('Rounds', rounds, maxRounds, `${rounds} / ${maxRounds}`, 'blue')}
        {bar('Time', elapsed, maxWall, `${mins(elapsed)} / ${mins(maxWall)}`, 'green')}
      </div>
    </div>
  );
}

function ArtifactList({ artifacts }) {
  const [open, setOpen] = useState(null);
  if (!artifacts || artifacts.length === 0) return null;
  return (
    <div>
      <window.Label>Artifacts ({artifacts.length})</window.Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {artifacts.map((a) => (
          <div key={a.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => setOpen(open === a.id ? null : a.id)}
              onKeyDown={(e) => e.key === 'Enter' && setOpen(open === a.id ? null : a.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <window.Icon name="file-text" size={14} className="green-text" />
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{a.name}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}>
                {(a.content || '').length} chars
              </span>
            </div>
            {open === a.id && (
              <pre
                style={{
                  margin: '6px 0 0',
                  padding: 10,
                  maxHeight: 220,
                  overflow: 'auto',
                  background: 'var(--surface-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  fontSize: 12.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {a.content}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Inject mid-run guidance without cancelling — appended to the steer queue and
// drained by the loop between steps.
function SteerBox({ taskId }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const r = await window.api.post(`/api/agents/tasks/${taskId}/steer`, { text: t });
    if (r.ok) {
      setText('');
      setSent(true);
      setTimeout(() => setSent(false), 1500);
    }
  };
  return (
    <div>
      <window.Label hint="Sent to the agent and applied before its next step.">Steer</window.Label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Nudge the agent — e.g. focus on X, skip Y…"
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
            color: 'var(--text)',
            font: 'inherit',
            fontSize: 13,
          }}
        />
        <window.Button variant="primary" icon={sent ? 'check' : 'send'} onClick={send}>
          {sent ? 'Sent' : 'Steer'}
        </window.Button>
      </div>
    </div>
  );
}

function TaskDetail({ taskId, onClose, onCancelled }) {
  // Static-ish metadata (agent, budgets, sub-agents) from a one-shot GET; live
  // task/transcript/artifacts arrive over SSE so the view ticks without polling.
  const [meta, setMeta] = useState(null);
  const [live, setLive] = useState(null);
  const load = useCallback(async () => {
    const r = await window.api.get(`/api/agents/tasks/${taskId}`);
    if (r.ok) setMeta(r.data);
  }, [taskId]);
  useEffect(() => {
    load();
    const es = window.api.streamSSE(`/api/agents/tasks/${taskId}/stream`, {
      onMessage: (_evt, raw) => {
        try {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data && data.type === 'snapshot') setLive(data);
        } catch {
          /* ignore malformed frame */
        }
      },
    });
    return () => es && es.close && es.close();
  }, [taskId, load]);

  const detail = meta;
  const task = (live && live.task) || (detail && detail.task);
  const transcript = (live && live.transcript) || (detail && detail.transcript) || [];
  const artifacts = (live && live.artifacts) || (detail && detail.artifacts) || [];
  const children = (live && live.children) || (detail && detail.children) || [];
  const agent = detail && detail.agent;
  const running = task && (task.status === 'queued' || task.status === 'running');
  const cancel = async () => {
    await window.api.post(`/api/agents/tasks/${taskId}/cancel`);
    onCancelled ? onCancelled() : load();
  };

  return (
    <window.Modal
      open
      onClose={onClose}
      width={640}
      title={detail ? `Task #${task.id} · ${detail.agentName || ''}` : 'Task'}
      footer={
        <>
          {task && ['queued', 'running'].includes(task.status) && (
            <window.Button variant="subtle" icon="stop" danger onClick={cancel}>
              Stop
            </window.Button>
          )}
          <window.Button variant="primary" onClick={onClose}>
            Close
          </window.Button>
        </>
      }
    >
      {!detail ? (
        <div style={{ color: 'var(--text-3)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <window.Badge tone={STATUS_TONE[task.status] || 'neutral'}>{task.status}</window.Badge>
            {running && <window.StatusDot state="starting" size={9} pulse />}
            {task.depth > 0 && (
              <window.Badge tone="neutral">sub-agent · depth {task.depth}</window.Badge>
            )}
          </div>
          <div>
            <window.Label>Prompt</window.Label>
            <div style={{ fontSize: 13.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
              {task.prompt}
            </div>
          </div>
          {task.error && task.error !== 'paused' && (
            <div>
              <window.Label>Error</window.Label>
              <div style={{ fontSize: 13, color: 'var(--err)' }}>{task.error}</div>
            </div>
          )}
          <BudgetGauge task={task} agent={agent} />
          <ThinkingPane text={task.liveText} running={task.status === 'running'} />
          <PlanChecklist plan={task.plan} />
          {running && agent && agent.mode === 'autonomous' && <SteerBox taskId={taskId} />}
          <ArtifactList artifacts={artifacts} />
          {children.length > 0 && (
            <div>
              <window.Label>Sub-agents</window.Label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {children.map((c) => (
                  <div
                    key={c.id}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
                  >
                    <window.Badge tone={STATUS_TONE[c.status] || 'neutral'}>
                      {c.status}
                    </window.Badge>
                    <span
                      style={{
                        color: 'var(--text-2)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.prompt}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <window.Label>Transcript</window.Label>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 320,
                overflowY: 'auto',
                padding: 4,
              }}
            >
              {transcript.length === 0 && (
                <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No transcript yet.</div>
              )}
              {transcript.map((m, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 13,
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--surface-2)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--text-3)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {m.role}
                  </span>
                  <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{m.content}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </window.Modal>
  );
}

/* small layout helpers */
function Row({ children }) {
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{children}</div>;
}
function Field({ label, hint, children }) {
  return (
    <div style={{ flex: 1, minWidth: 150 }}>
      <window.Label hint={hint}>{label}</window.Label>
      {children}
    </div>
  );
}

/* The api client exposes get/post but not PUT/DELETE; add thin helpers that
 * reuse its token handling via window.api.url(). */
async function fetchPut(path, body) {
  return rawFetch('PUT', path, body);
}
async function fetchDelete(path) {
  return rawFetch('DELETE', path);
}
async function rawFetch(method, path, body) {
  try {
    const res = await fetch(window.api.url(path), {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { raw: text };
    }
    return res.ok
      ? { ok: true, data }
      : { ok: false, status: res.status, error: (data && data.error) || res.statusText };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), offline: true };
  }
}

function OutputModal({ task, onClose }) {
  return (
    <window.Modal
      open
      onClose={onClose}
      width={640}
      title={`Output · ${task.agentName || `Task #${task.id}`}`}
      footer={
        <window.Button variant="primary" onClick={onClose}>
          Close
        </window.Button>
      }
    >
      <div
        style={{
          maxHeight: '60vh',
          overflowY: 'auto',
          padding: 12,
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      >
        {task.result || 'No output available.'}
      </div>
    </window.Modal>
  );
}

function WorkflowRunDetail({ runId, onClose }) {
  const [detail, setDetail] = useState(null);
  const load = useCallback(async () => {
    const r = await window.api.get(`/api/workflows/runs/${runId}`);
    if (r.ok) setDetail(r.data);
  }, [runId]);
  useEffect(() => {
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  const run = detail && detail.run;
  const steps = detail && detail.steps;

  return (
    <window.Modal
      open
      onClose={onClose}
      width={640}
      title={`Workflow run #${runId}`}
      footer={
        <window.Button variant="primary" onClick={onClose}>
          Close
        </window.Button>
      }
    >
      {!detail ? (
        <div style={{ color: 'var(--text-3)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <window.Badge tone={STATUS_TONE[run.status] || 'neutral'}>{run.status}</window.Badge>
          </div>
          {run.input && (
            <div>
              <window.Label>Input</window.Label>
              <div style={{ fontSize: 13.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
                {run.input}
              </div>
            </div>
          )}
          {steps && steps.length > 0 && (
            <div>
              <window.Label>Steps</window.Label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {steps.map((step) => (
                  <div
                    key={step.id}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
                  >
                    <window.Badge tone={STATUS_TONE[step.status] || 'neutral'}>
                      {step.status}
                    </window.Badge>
                    <span style={{ fontWeight: 600, color: 'var(--text)' }}>{step.nodeType}</span>
                    {step.error ? (
                      <span style={{ color: 'var(--err)', marginLeft: 8 }}>{step.error}</span>
                    ) : step.output ? (
                      <span
                        style={{
                          color: 'var(--text-2)',
                          marginLeft: 8,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {wfClip(step.output, 80)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(run.output || run.error) && (
            <div>
              <window.Label>Result</window.Label>
              {run.error ? (
                <div style={{ fontSize: 13, color: 'var(--err)' }}>{run.error}</div>
              ) : (
                <div
                  style={{
                    fontSize: 13,
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'pre-wrap',
                    color: 'var(--text-2)',
                    background: 'var(--surface-2)',
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {run.output}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </window.Modal>
  );
}

Object.assign(window, { AgentsTab, AgentsFleet, WorkflowRunDetail });
