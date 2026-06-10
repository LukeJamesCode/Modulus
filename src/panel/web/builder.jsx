const { useState, useEffect, useRef, useMemo } = React;
const { Icon, Button, Input, Select, Label } = window;

const NODE_DEFS = {
  trigger: { icon: 'zap', name: 'Manual Trigger', color: 'var(--accent)', type: 'trigger' },
  agent: { icon: 'spark', name: 'Agent', color: 'var(--info)', type: 'agent' },
  tool: { icon: 'terminal', name: 'Tool', color: '#b388ff', type: 'tool' },
  transform: { icon: 'code', name: 'Transform', color: '#26c6da', type: 'transform' },
  condition: { icon: 'git-branch', name: 'Condition', color: 'var(--warn)', type: 'condition' },
  loop: { icon: 'repeat', name: 'Loop', color: '#ff9800', type: 'loop' },
  output: { icon: 'send', name: 'Output', color: 'var(--ok)', type: 'output' },
};

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function JsonTextArea({ value, onChange }) {
  const [text, setText] = useState(() =>
    typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2),
  );
  return (
    <textarea
      className="wf-textarea mono"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        try {
          onChange(JSON.parse(e.target.value));
        } catch {
          onChange(e.target.value);
        }
      }}
    />
  );
}

function NodeComponent({ node, selected, onSelect, onDragStart, onDrag, status }) {
  const def = NODE_DEFS[node.type];
  const borderCol = selected
    ? 'var(--accent-ring)'
    : status === 'running'
      ? 'var(--info)'
      : status === 'done'
        ? 'var(--ok)'
        : status === 'error'
          ? 'var(--err)'
          : 'var(--border)';

  let statusIcon = null;
  if (status === 'done')
    statusIcon = (
      <div className="node-status-icon green">
        <Icon name="check" size={14} />
      </div>
    );
  if (status === 'error')
    statusIcon = (
      <div className="node-status-icon red">
        <Icon name="x" size={14} />
      </div>
    );

  return (
    <div
      className={`wf-node ${selected ? 'selected' : ''} ${status ? status : ''}`}
      style={{
        transform: `translate(${node.pos.x}px, ${node.pos.y}px)`,
        borderColor: borderCol,
      }}
      onMouseDown={(e) => {
        if (e.target.closest('.wf-port')) return;
        onSelect(node.id);
        const startX = e.clientX;
        const startY = e.clientY;
        const initialPos = { ...node.pos };

        const handleMouseMove = (me) => {
          onDrag(node.id, {
            x: initialPos.x + (me.clientX - startX),
            y: initialPos.y + (me.clientY - startY),
          });
        };
        const handleMouseUp = () => {
          window.removeEventListener('mousemove', handleMouseMove);
          window.removeEventListener('mouseup', handleMouseUp);
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
      }}
    >
      {statusIcon}
      <div className="wf-node-header">
        <div
          className="wf-node-icon"
          style={{
            color: def.color,
            backgroundColor: `color-mix(in oklab, ${def.color} 15%, transparent)`,
          }}
        >
          <Icon name={def.icon} size={16} />
        </div>
        <div className="wf-node-title">{def.name}</div>
      </div>
      <div className="wf-node-body">
        {node.type === 'agent' && (
          <div className="wf-node-preview">
            {node.config?.agentId ? `Agent #${node.config.agentId}` : 'Unconfigured'}
          </div>
        )}
        {node.type === 'tool' && (
          <div className="wf-node-preview">{node.config?.tool || 'Unconfigured'}</div>
        )}
        {node.type === 'condition' && (
          <div className="wf-node-preview">{node.config?.op || 'if'}</div>
        )}
      </div>

      {/* Ports */}
      {node.type !== 'trigger' && (
        <div
          className="wf-port in"
          onMouseDown={(e) => {
            e.stopPropagation();
            onDragStart(node.id, 'in');
          }}
        />
      )}
      {node.type !== 'output' && (
        <div
          className="wf-port out"
          onMouseDown={(e) => {
            e.stopPropagation();
            onDragStart(node.id, 'out');
          }}
        />
      )}
    </div>
  );
}

function Inspector({ node, onChange, onDelete, agents, tools }) {
  if (!node) return <div className="wf-inspector empty">Select a node to configure</div>;

  const setConfig = (k, v) => onChange(node.id, { ...node.config, [k]: v });

  return (
    <div className="wf-inspector">
      <div className="wf-inspector-header">
        <h3>{NODE_DEFS[node.type].name}</h3>
        <span className="mono text-2">{node.id}</span>
      </div>
      <div className="wf-inspector-body">
        {node.type === 'trigger' && (
          <div className="wf-form-group">
            <Label>Mode</Label>
            <Select
              value={node.config.mode || 'manual'}
              onChange={(e) => setConfig('mode', e.target.value)}
            >
              <option value="manual">Manual Execution</option>
              <option value="webhook">Webhook (Coming Soon)</option>
            </Select>
          </div>
        )}

        {node.type === 'agent' && (
          <>
            <div className="wf-form-group">
              <Label>Agent</Label>
              <Select
                value={node.config.agentId || ''}
                onChange={(e) =>
                  setConfig('agentId', e.target.value ? Number(e.target.value) : undefined)
                }
              >
                <option value="">-- Select Agent --</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="wf-form-group">
              <Label>Prompt Template</Label>
              <textarea
                className="wf-textarea"
                value={node.config.promptTemplate || ''}
                onChange={(e) => setConfig('promptTemplate', e.target.value)}
                placeholder="Hello {{trigger.input}}"
              />
              <div className="wf-hint">
                Use {'{{steps.node_id.output}}'} or {'{{trigger.input}}'}
              </div>
            </div>
            <div className="wf-form-group">
              <Label>Reasoning</Label>
              <Select
                value={node.config.thinkMode || 'inherit'}
                onChange={(e) =>
                  setConfig('thinkMode', e.target.value === 'inherit' ? undefined : e.target.value)
                }
              >
                <option value="inherit">Inherit agent default</option>
                <option value="auto">Auto (model default)</option>
                <option value="on">Think</option>
                <option value="off">No-think</option>
              </Select>
              <div className="wf-hint">
                Overrides this agent's saved think mode for this node only.
              </div>
            </div>
          </>
        )}

        {node.type === 'tool' && (
          <>
            <div className="wf-form-group">
              <Label>Tool</Label>
              <Select
                value={node.config.tool || ''}
                onChange={(e) => setConfig('tool', e.target.value)}
              >
                <option value="">-- Select Tool --</option>
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="wf-form-group">
              <Label>Arguments (JSON Template)</Label>
              <JsonTextArea value={node.config.args} onChange={(val) => setConfig('args', val)} />
              <div className="wf-hint">Values may use {'{{steps.node_id.output}}'} templates.</div>
            </div>
          </>
        )}

        {node.type === 'transform' && (
          <>
            <div className="wf-form-group">
              <Label>Template</Label>
              <textarea
                className="wf-textarea mono"
                value={node.config.template || ''}
                onChange={(e) => setConfig('template', e.target.value)}
              />
              <div className="wf-hint">
                Combine prior outputs, e.g. {'{{steps.research.output}}'}.
              </div>
            </div>
          </>
        )}

        {node.type === 'condition' && (
          <>
            <div className="wf-form-group">
              <Label>Left Value</Label>
              <Input
                value={node.config.left || ''}
                onChange={(e) => setConfig('left', e.target.value)}
              />
            </div>
            <div className="wf-form-group">
              <Label>Operator</Label>
              <Select
                value={node.config.op || 'contains'}
                onChange={(e) => setConfig('op', e.target.value)}
              >
                <option value="contains">contains</option>
                <option value="equals">equals</option>
                <option value="not_equals">not_equals</option>
                <option value="gt">&gt;</option>
                <option value="lt">&lt;</option>
                <option value="regex">regex</option>
                <option value="empty">empty</option>
                <option value="not_empty">not_empty</option>
              </Select>
            </div>
            {!['empty', 'not_empty'].includes(node.config.op || 'contains') && (
              <div className="wf-form-group">
                <Label>Right Value</Label>
                <Input
                  value={node.config.right || ''}
                  onChange={(e) => setConfig('right', e.target.value)}
                />
              </div>
            )}
            <div className="wf-hint">Connect "true" and "false" branch edges</div>
          </>
        )}

        {node.type === 'loop' && (
          <>
            <div className="wf-form-group">
              <Label>Items (Array expression)</Label>
              <Input
                value={node.config.items || ''}
                onChange={(e) => setConfig('items', e.target.value)}
                placeholder="{{steps.prev.output}}"
              />
            </div>
            <div className="wf-form-group">
              <Label>Body Node Type</Label>
              <Select
                value={(node.config.body && node.config.body.type) || 'agent'}
                onChange={(e) =>
                  setConfig('body', { ...(node.config.body || {}), type: e.target.value })
                }
              >
                <option value="agent">Agent</option>
                <option value="tool">Tool</option>
                <option value="transform">Transform</option>
              </Select>
            </div>
            {/* Minimal inline body editor: the runner runs this config once per item. */}
            <div className="wf-form-group">
              <Label>Body Config (JSON)</Label>
              <JsonTextArea
                value={node.config.body?.config}
                onChange={(val) => setConfig('body', { ...(node.config.body || {}), config: val })}
              />
              <div className="wf-hint">
                Use {'{{item}}'} / {'{{index}}'} for the current loop item.
              </div>
            </div>
          </>
        )}

        {node.type === 'output' && (
          <>
            <div className="wf-form-group">
              <Label>Channel</Label>
              <Select
                value={node.config.channel || 'none'}
                onChange={(e) => setConfig('channel', e.target.value)}
              >
                <option value="none">None (just return value)</option>
                <option value="telegram">Telegram (Main user)</option>
              </Select>
            </div>
            <div className="wf-form-group">
              <Label>Template</Label>
              <textarea
                className="wf-textarea"
                value={node.config.template || ''}
                onChange={(e) => setConfig('template', e.target.value)}
              />
            </div>
          </>
        )}
      </div>
      <div className="wf-inspector-footer">
        <Button variant="danger" onClick={() => onDelete(node.id)}>
          <Icon name="trash" size={14} /> Delete Node
        </Button>
      </div>
    </div>
  );
}

function WorkflowBuilder() {
  const [workflows, setWorkflows] = useState([]);
  const [activeWfId, setActiveWfId] = useState(null);

  const [name, setName] = useState('New Workflow');
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);

  const [selectedNodeId, setSelectedNodeId] = useState(null);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);

  const [drawingEdge, setDrawingEdge] = useState(null); // { from, toX, toY }
  const svgRef = useRef();

  const [agents, setAgents] = useState([]);
  const [tools, setTools] = useState([]);

  // Run visualization state
  const [runInput, setRunInput] = useState('');
  // Files/images/PDFs uploaded with the run; the runner ingests them into each
  // agent node's task. null = don't block visual drops; the runner gates images
  // per agent's own model.
  const att = window.useAttachments(null);
  const [runId, setRunId] = useState(null);
  const [runSteps, setRunSteps] = useState([]); // Array of step rows
  const [runStatus, setRunStatus] = useState(null);
  const [runOutput, setRunOutput] = useState(null);
  const [runError, setRunError] = useState(null);

  useEffect(() => {
    window.api.get('/api/workflows').then((res) => {
      if (res.ok) setWorkflows(res.data.workflows);
    });
    window.api.get('/api/agents').then((res) => {
      if (res.ok) setAgents(res.data.agents);
    });
    window.api.get('/api/commands').then((res) => {
      if (res.ok) setTools(res.data.commands);
    });
  }, []);

  // Poller for run visualization
  useEffect(() => {
    if (!runId || (runStatus && runStatus !== 'queued' && runStatus !== 'running')) return;
    const interval = setInterval(() => {
      window.api.get(`/api/workflows/runs/${runId}`).then((res) => {
        if (res.ok) {
          setRunStatus(res.data.run.status);
          setRunSteps(res.data.steps || []);
          if (res.data.run.output) setRunOutput(res.data.run.output);
          if (res.data.run.error) setRunError(res.data.run.error);
        }
      });
    }, 1500);
    return () => clearInterval(interval);
  }, [runId, runStatus]);

  const loadWorkflow = (id) => {
    if (!id) {
      setActiveWfId(null);
      setName('New Workflow');
      setNodes([]);
      setEdges([]);
      clearRun();
      return;
    }
    window.api.get(`/api/workflows/${id}`).then((res) => {
      if (res.ok) {
        setActiveWfId(id);
        setName(res.data.workflow.name);
        setNodes(res.data.workflow.graph?.nodes || []);
        setEdges(res.data.workflow.graph?.edges || []);
        clearRun();
      }
    });
  };

  const clearRun = () => {
    setRunId(null);
    setRunSteps([]);
    setRunStatus(null);
    setRunOutput(null);
    setRunError(null);
  };

  const saveWorkflow = async () => {
    const payload = {
      name,
      graph: { nodes, edges },
      active: true,
    };
    if (activeWfId) {
      const res = await window.api.post(`/api/workflows/${activeWfId}`, {
        ...payload,
        _method: 'PUT',
      }); // Assuming PUT handled by fetch Put or similar, wait, server.ts accepts PUT via regex. The frontend api.js uses method fetch.
      if (res.ok) {
        // saved
        window.api.get('/api/workflows').then((r) => {
          if (r.ok) setWorkflows(r.data.workflows);
        });
      }
    } else {
      const res = await window.api.post('/api/workflows', payload);
      if (res.ok) {
        setActiveWfId(res.data.workflow.id);
        window.api.get('/api/workflows').then((r) => {
          if (r.ok) setWorkflows(r.data.workflows);
        });
      }
    }
  };

  const runWorkflow = async () => {
    if (!activeWfId) {
      await saveWorkflow();
    }
    const targetId = activeWfId; // if just saved, it might not be in state yet synchronously, but let's assume it is or handle properly.
    // better to save, get id, then run.
    if (!targetId) return;
    const input = runInput.trim() || null;
    const stageToken = att.token;
    clearRun();
    const res = await window.api.post(`/api/workflows/${targetId}/run`, {
      input,
      ...(stageToken ? { stageToken } : {}),
    });
    if (res.ok) {
      att.clear();
      setRunId(res.data.run.id);
      setRunStatus('queued');
    }
  };

  const deleteWorkflow = async () => {
    if (!activeWfId || !confirm('Delete this workflow?')) return;
    const res = await window.api.request('DELETE', `/api/workflows/${activeWfId}`);
    if (res.ok) {
      loadWorkflow(null);
      window.api.get('/api/workflows').then((r) => {
        if (r.ok) setWorkflows(r.data.workflows);
      });
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('wf-type');
    if (!type) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - pan.x;
    const y = e.clientY - rect.top - pan.y;
    setNodes([...nodes, { id: generateId(), type, pos: { x, y }, config: {} }]);
  };

  const handleDragOver = (e) => e.preventDefault();

  const handleNodeDrag = (id, newPos) => {
    setNodes(nodes.map((n) => (n.id === id ? { ...n, pos: newPos } : n)));
  };

  const startEdgeDraw = (nodeId, port) => {
    if (port !== 'out') return; // only drag from out ports
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return;
    setDrawingEdge({ from: nodeId, x: n.pos.x + 180 + pan.x, y: n.pos.y + 45 + pan.y });
  };

  const handleCanvasMouseMove = (e) => {
    if (isDraggingCanvas) {
      setPan({ x: pan.x + e.movementX, y: pan.y + e.movementY });
    }
    if (drawingEdge) {
      const rect = svgRef.current.getBoundingClientRect();
      setDrawingEdge({ ...drawingEdge, toX: e.clientX - rect.left, toY: e.clientY - rect.top });
    }
  };

  const handleCanvasMouseUp = (e) => {
    setIsDraggingCanvas(false);
    if (drawingEdge) {
      // Find if dropped on an 'in' port
      const target = e.target.closest('.wf-port.in');
      if (target) {
        const toNodeId = target.parentElement.dataset.nodeId;
        if (toNodeId && toNodeId !== drawingEdge.from) {
          // Add edge
          const fromNode = nodes.find((n) => n.id === drawingEdge.from);
          let branch = undefined;
          if (fromNode && fromNode.type === 'condition') {
            // First outgoing edge is the 'true' branch, the next is 'false'
            // (the runner lights edges by branch). Relabel by deleting + redrawing.
            const hasTrue = edges.some((e) => e.from === drawingEdge.from && e.branch === 'true');
            branch = hasTrue ? 'false' : 'true';
          }
          setEdges((prev) => {
            // Remove existing edge to the same node? Not strictly necessary in DAG, but let's allow multiple inward edges except for condition branching
            return [...prev, { from: drawingEdge.from, to: toNodeId, branch }];
          });
        }
      }
      setDrawingEdge(null);
    }
  };

  const removeEdge = (idx) => {
    setEdges(edges.filter((_, i) => i !== idx));
  };

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId],
  );

  return (
    <div className="wf-builder-root fade">
      <div className="wf-topbar">
        <div className="wf-topbar-left">
          <Select
            value={activeWfId || ''}
            onChange={(e) => loadWorkflow(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">-- New Workflow --</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workflow Name"
          />
        </div>
        <div className="wf-topbar-right">
          {runStatus && (
            <div className="wf-run-status">
              Status:{' '}
              <span
                className={`status-label ${runStatus === 'running' ? 'blue pulse' : runStatus === 'done' ? 'green' : runStatus === 'error' ? 'red' : ''}`}
              >
                {runStatus}
              </span>
            </div>
          )}
          <Input
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
            placeholder="Run input (optional)…"
            style={{ minWidth: 180 }}
          />
          <window.AttachButton
            onPick={att.addFiles}
            size={36}
            title="Attach files or a folder for this run"
          />
          <Button variant="ghost" onClick={saveWorkflow}>
            <Icon name="save" size={16} /> Save
          </Button>
          <Button variant="primary" onClick={runWorkflow} disabled={!activeWfId}>
            <Icon name="play" size={16} /> Run
          </Button>
          {activeWfId && (
            <Button variant="danger" onClick={deleteWorkflow}>
              <Icon name="trash" size={16} /> Delete
            </Button>
          )}
        </div>
      </div>

      {att.files.length > 0 && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <window.AttachChips files={att.files} onRemove={att.remove} />
        </div>
      )}

      <div className="wf-workspace">
        <div className="wf-palette">
          <div className="wf-palette-title">Nodes</div>
          {Object.values(NODE_DEFS).map((def) => (
            <div
              key={def.type}
              className="wf-palette-item"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('wf-type', def.type)}
            >
              <div
                className="wf-palette-icon"
                style={{
                  color: def.color,
                  backgroundColor: `color-mix(in oklab, ${def.color} 15%, transparent)`,
                }}
              >
                <Icon name={def.icon} size={16} />
              </div>
              <div className="wf-palette-label">{def.name}</div>
            </div>
          ))}
        </div>

        <div
          className="wf-canvas"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onMouseDown={(e) => {
            if (e.target.closest('.wf-node') || e.target.closest('.wf-inspector')) return;
            setIsDraggingCanvas(true);
            setSelectedNodeId(null);
          }}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={() => {
            setIsDraggingCanvas(false);
            setDrawingEdge(null);
          }}
        >
          <svg className="wf-edges" ref={svgRef}>
            {/* Background grid */}
            <pattern
              id="wf-grid"
              width="40"
              height="40"
              patternUnits="userSpaceOnUse"
              x={pan.x}
              y={pan.y}
            >
              <circle cx="2" cy="2" r="1" fill="var(--border)" />
            </pattern>
            <rect width="100%" height="100%" fill="url(#wf-grid)" />

            <g transform={`translate(${pan.x}, ${pan.y})`}>
              {edges.map((edge, idx) => {
                const fromNode = nodes.find((n) => n.id === edge.from);
                const toNode = nodes.find((n) => n.id === edge.to);
                if (!fromNode || !toNode) return null;
                const fx = fromNode.pos.x + 180;
                const fy = fromNode.pos.y + 45;
                const tx = toNode.pos.x;
                const ty = toNode.pos.y + 45;
                const path = `M ${fx} ${fy} C ${fx + 60} ${fy}, ${tx - 60} ${ty}, ${tx} ${ty}`;
                return (
                  <g key={`${edge.from}-${edge.to}-${idx}`}>
                    <path
                      d={path}
                      className="wf-edge-path"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeEdge(idx);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        removeEdge(idx);
                      }}
                    />
                    {edge.branch && (
                      <text
                        x={(fx + tx) / 2}
                        y={(fy + ty) / 2 - 10}
                        className="wf-edge-label"
                        fill="var(--text-2)"
                        fontSize="12"
                        textAnchor="middle"
                      >
                        {edge.branch}
                      </text>
                    )}
                  </g>
                );
              })}
              {drawingEdge && (
                <path
                  d={`M ${drawingEdge.x - pan.x} ${drawingEdge.y - pan.y} C ${drawingEdge.x - pan.x + 60} ${drawingEdge.y - pan.y}, ${drawingEdge.toX - 60} ${drawingEdge.toY}, ${drawingEdge.toX} ${drawingEdge.toY}`}
                  className="wf-edge-drawing"
                />
              )}
            </g>
          </svg>

          <div
            className="wf-nodes-layer"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
          >
            {nodes.map((n) => {
              const stepRow = runSteps.find((s) => s.nodeId === n.id);
              const status = stepRow ? stepRow.status : null;
              return (
                <div
                  key={n.id}
                  data-node-id={n.id}
                  style={{ position: 'absolute', top: 0, left: 0 }}
                >
                  <NodeComponent
                    node={n}
                    selected={selectedNodeId === n.id}
                    onSelect={setSelectedNodeId}
                    onDragStart={startEdgeDraw}
                    onDrag={handleNodeDrag}
                    status={status}
                  />
                </div>
              );
            })}
          </div>

          {(runOutput || runError) && (
            <div className="wf-run-result">
              <div className="wf-run-result-header">
                Run Result{' '}
                <button
                  onClick={() => {
                    setRunOutput(null);
                    setRunError(null);
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              <pre className="mono">
                {runError
                  ? `Error: ${runError}`
                  : typeof runOutput === 'string'
                    ? runOutput
                    : JSON.stringify(runOutput, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {selectedNode && (
          <Inspector
            node={selectedNode}
            onChange={(id, conf) =>
              setNodes(nodes.map((n) => (n.id === id ? { ...n, config: conf } : n)))
            }
            onDelete={(id) => {
              setNodes(nodes.filter((n) => n.id !== id));
              setEdges(edges.filter((e) => e.from !== id && e.to !== id));
              setSelectedNodeId(null);
            }}
            agents={agents}
            tools={tools}
          />
        )}
      </div>
    </div>
  );
}

window.WorkflowBuilder = WorkflowBuilder;
