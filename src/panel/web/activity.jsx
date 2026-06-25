// Activity tab — the durable record, two zoom levels.
//
//   Timeline (top): the wide shot. One bar per time bucket, height ∝ how much
//   ran, coloured by the dominant trigger, red-capped when something failed.
//   Clicking a bar filters the feed below to that window.
//
//   Feed (bottom): the close-up. Newest-first rows of what Modulus actually did
//   — each an agent run or a routine fire — with a plain summary, a trigger tag,
//   a status chip, and a relative time. Reads /api/activity{,/timeline}.

const ACT_TRIGGER = {
  user: { label: 'You', color: 'var(--accent)', tone: 'accent' },
  schedule: { label: 'Schedule', color: 'var(--warn)', tone: 'warn' },
  chat: { label: 'Chat', color: 'var(--text-2)', tone: 'neutral' },
  delegation: { label: 'Delegated', color: 'var(--ok)', tone: 'ok' },
};
const ACT_STATUS = {
  ok: { label: 'OK', tone: 'ok' },
  failed: { label: 'Failed', tone: 'err' },
  blocked: { label: 'Blocked', tone: 'warn' },
  awaiting: { label: 'Waiting', tone: 'neutral' },
};
const ACT_KIND = {
  agent_run: 'Agent',
  routine_fire: 'Routine',
  tool_call: 'Tool',
  chat_turn: 'Chat',
};

function actRelTime(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Which trigger contributes the most events in a bucket — drives the bar colour.
function actDominantTrigger(bucket) {
  let best = 'user';
  let bestN = -1;
  for (const t of Object.keys(ACT_TRIGGER)) {
    const n = bucket.byTrigger[t] || 0;
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best;
}

function ActivityTimeline({ buckets, bucketMs, selected, onSelect }) {
  if (!buckets.length) return null;
  const max = buckets.reduce((m, b) => Math.max(m, b.total), 1);
  return (
    <window.Card pad={14} style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 3,
          height: 72,
          overflowX: 'auto',
        }}
      >
        {buckets.map((b) => {
          const trig = actDominantTrigger(b);
          const isSel = selected === b.start;
          const when = new Date(b.start);
          const title = `${when.toLocaleString()} — ${b.total} event${b.total === 1 ? '' : 's'}${
            b.failed ? `, ${b.failed} failed` : ''
          }`;
          return (
            <div
              key={b.start}
              title={title}
              onClick={() => onSelect(isSel ? null : b.start)}
              style={{
                flex: '1 0 8px',
                minWidth: 8,
                height: `${Math.max(6, Math.round((b.total / max) * 64))}px`,
                background: ACT_TRIGGER[trig].color,
                borderRadius: 3,
                cursor: 'pointer',
                opacity: selected === null || isSel ? 1 : 0.4,
                outline: isSel ? '2px solid var(--text)' : 'none',
                // A failed event tints the top of the bar red.
                boxShadow: b.failed ? 'inset 0 5px 0 0 var(--err)' : 'none',
              }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 14,
          marginTop: 10,
          flexWrap: 'wrap',
          fontSize: 12,
          color: 'var(--text-2)',
        }}
      >
        {Object.entries(ACT_TRIGGER).map(([k, v]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{ width: 9, height: 9, borderRadius: 2, background: v.color, display: 'inline-block' }}
            />
            {v.label}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>
          {selected !== null
            ? `Showing one ${bucketMs >= 24 * 3600000 ? 'day' : 'hour'} — click the bar again to clear`
            : 'Last 7 days'}
        </span>
      </div>
    </window.Card>
  );
}

function ActivityRow({ item, onOpen }) {
  const trig = ACT_TRIGGER[item.trigger] || ACT_TRIGGER.user;
  const status = ACT_STATUS[item.status] || ACT_STATUS.ok;
  const canOpen = item.refTable === 'agent_tasks';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 4px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span
        title={trig.label}
        style={{ width: 8, height: 8, borderRadius: 99, background: trig.color, flex: 'none' }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text)',
            fontSize: 14,
          }}
        >
          <span style={{ fontWeight: 600, flex: 'none' }}>{item.actor}</span>
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'var(--text-2)',
            }}
          >
            {item.summary}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 12, color: 'var(--text-3)' }}>
          <span>{ACT_KIND[item.kind] || item.kind}</span>
          <span>·</span>
          <span>{actRelTime(item.ts)}</span>
          {item.surface && (
            <>
              <span>·</span>
              <span>{item.surface}</span>
            </>
          )}
        </div>
      </div>
      <window.Badge tone={status.tone}>{status.label}</window.Badge>
      {canOpen && (
        <window.IconButton title="Open in Agents" onClick={() => onOpen(item)}>
          <window.Icon name="external-link" size={16} />
        </window.IconButton>
      )}
    </div>
  );
}

function ActivityTab({ onNavigate }) {
  const { useState, useEffect, useCallback } = React;
  const [items, setItems] = useState([]);
  const [timeline, setTimeline] = useState({ bucketMs: 3600000, buckets: [] });
  const [selected, setSelected] = useState(null); // selected bucket start (ms) or null
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [feed, tl] = await Promise.all([
      window.api.get('/api/activity?limit=200'),
      window.api.get('/api/activity/timeline?days=7&bucket=hour'),
    ]);
    if (feed.ok && feed.data) setItems(feed.data.items || []);
    if (tl.ok && tl.data) setTimeline(tl.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  // Feed honours a selected timeline bucket: show only that window.
  const shown =
    selected === null
      ? items
      : items.filter((it) => it.ts >= selected && it.ts < selected + timeline.bucketMs);

  const openItem = () => {
    // v1 drill-in: jump to the Agents tab, where the run view lives. (A direct
    // deep-link to the specific task is a later refinement.)
    if (onNavigate) onNavigate('fleet');
  };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '8px 0 40px' }}>
      <window.SectionTitle sub="What Modulus has been doing — agent runs and scheduled routines, newest first.">
        Activity
      </window.SectionTitle>

      <ActivityTimeline
        buckets={timeline.buckets}
        bucketMs={timeline.bucketMs}
        selected={selected}
        onSelect={setSelected}
      />

      <window.Card pad={6}>
        {shown.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-2)' }}>
            {loaded
              ? selected !== null
                ? 'Nothing ran in this window.'
                : "Nothing yet. When Modulus runs an agent or a scheduled routine, it'll show up here."
              : 'Loading…'}
          </div>
        ) : (
          <div style={{ padding: '0 12px' }}>
            {shown.map((it) => (
              <ActivityRow key={it.id} item={it} onOpen={openItem} />
            ))}
          </div>
        )}
      </window.Card>
    </div>
  );
}

window.ActivityTab = ActivityTab;
