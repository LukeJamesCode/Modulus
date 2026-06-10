const { useState, useEffect } = React;

function DocsTab() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    async function fetchDocs() {
      try {
        const res = await window.api.get('/api/docs');
        if (res.ok) {
          setDocs(res.docs || []);
        } else {
          setError(res.error || 'Failed to load docs');
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }
    fetchDocs();
  }, []);

  if (loading) {
    return (
      <div
        className="tab-container"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <window.Icon name="loader" size={24} className="spin" style={{ color: 'var(--text-3)' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="tab-container" style={{ padding: '40px', color: 'var(--err)' }}>
        <h2>Error Loading Documentation</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="tab-container" style={{ padding: '40px', color: 'var(--text-2)' }}>
        <h2>No Documentation Found</h2>
      </div>
    );
  }

  const currentDoc = docs[selectedIndex];

  // Configure marked for safer rendering
  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  const renderHtml = () => {
    return { __html: marked.parse(currentDoc.content) };
  };

  return (
    <div
      className="tab-container"
      style={{ display: 'flex', flexDirection: 'row', height: '100%', overflow: 'hidden' }}
    >
      {/* Sidebar */}
      <div
        style={{
          width: '280px',
          borderRight: '1px solid var(--border)',
          overflowY: 'auto',
          background: 'var(--surface)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '16px', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>
          Documentation
        </div>
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {docs.map((doc, idx) => (
            <button
              key={doc.filename}
              onClick={() => setSelectedIndex(idx)}
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                background: selectedIndex === idx ? 'var(--accent)' : 'transparent',
                color: selectedIndex === idx ? 'var(--on-accent, #fff)' : 'var(--text-2)',
                border: 'none',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: selectedIndex === idx ? 600 : 400,
              }}
            >
              {doc.title}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '32px 48px' }}>
          <div
            className="markdown-body"
            style={{
              maxWidth: '800px',
              margin: '0 auto',
              color: 'var(--text)',
              lineHeight: 1.6,
            }}
            dangerouslySetInnerHTML={renderHtml()}
          />
        </div>

        {/* Pagination Footer */}
        <div
          style={{
            padding: '16px 32px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-2)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <window.Button
            disabled={selectedIndex === 0}
            onClick={() => setSelectedIndex(selectedIndex - 1)}
            icon="chevron-left"
            variant="subtle"
          >
            Previous
          </window.Button>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: '13px',
              color: 'var(--text-3)',
            }}
          >
            Page {selectedIndex + 1} of {docs.length}
          </div>
          <window.Button
            disabled={selectedIndex === docs.length - 1}
            onClick={() => setSelectedIndex(selectedIndex + 1)}
            variant="subtle"
          >
            Next <window.Icon name="chevron-right" size={14} style={{ marginLeft: 6 }} />
          </window.Button>
        </div>
      </div>
    </div>
  );
}

window.DocsTab = DocsTab;
