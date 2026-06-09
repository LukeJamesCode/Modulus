-- Hive-mind shared memory. One store that every agent — the main chat, module
-- agents, autonomous workers — reads and writes, so a fact learned anywhere is
-- recallable everywhere. Recall is FTS5/BM25 keyword search: CPU-cheap, no
-- embedding model, works on a Pi 4. See src/core/memory.ts.

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  -- sha256 of the normalised content; dedup across writers.
  content_hash TEXT NOT NULL UNIQUE,
  -- 'global' or 'chat:<id>'. Everything is global today; the column exists so
  -- per-chat scoping can land without a schema change.
  scope TEXT NOT NULL DEFAULT 'global',
  -- 'user' | 'extraction' | 'agent:<name>' — who learned this.
  source TEXT NOT NULL,
  -- 1..3. Eviction removes low-importance, least-recently-used rows first.
  importance INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_memories_evict ON memories (importance, last_used_at);

-- External-content FTS index over memories.content, kept in sync by triggers.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
END;
