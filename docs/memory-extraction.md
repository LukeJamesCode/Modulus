# Memory-extraction job — design spec

Status: **implemented** (v1.4.0). Lives in
[src/core/memory-extraction.ts](../src/core/memory-extraction.ts), wired through
the chat dispatcher's `memoryExtractor` dep (start.ts → Telegram adapter). This
document remains the contract the implementation follows.

## Goal

After a normal user-facing chat turn, quietly extract 0–2 _durable_ facts about
the user from that turn and persist them with `memory.remember()`, so later turns
recall them through the existing memory slot in the prompt. The user's reply must
never wait on this.

Example: user says "my sister Mia just moved to Lisbon" → store
`"User's sister Mia lives in Lisbon."` Next week, "what should I get Mia for her
birthday?" recalls it.

## Non-goals

- Not a summarizer of the conversation, not a transcript log.
- Not agent findings — those already flow through `promoteFindings()`
  (`source: 'agent:<name>'`). This job owns `source: 'extraction'`.
- No new queue, no new prompt slot, no schema change.

## Where it hooks

The chat dispatch already runs the afterTurn chain **detached, after the reply
has shipped**: `void runAfterTurns({...})` in
[chat-dispatch.ts](../src/core/chat-dispatch.ts) (the reply is awaited and sent
first; afterTurns are fire-and-forget). That is exactly the "reply ships first"
guarantee the job needs — so memory extraction is a **core afterTurn handler**,
not a new background queue.

`AfterTurnContext` (see [modules.ts](../src/core/modules.ts)) already carries
everything needed: `userText`, `assistantText`, `toolCalls`, `chatId`, `userId`,
`conversationId`. The handler is registered in core (alongside how `start.ts`
wires the memory store), gated by config (below), and added to the list
`chat-dispatch` iterates — i.e. core afterTurns must be a first-class input to
the dispatcher the same way module afterTurns are, OR the extraction runs as a
core-owned entry the dispatcher always includes. Prefer the latter: a
`memoryExtractor?: (turn) => Promise<void>` dep on `ChatDispatcherDeps`, invoked
in the same detached block as `runAfterTurns`, so module hooks and core
extraction share the post-reply path and the same failure isolation.

## The model call

- **Model: the SMALL chat profile** (`cfg.models.chat`), never the heavy
  reasoner. This runs on every qualifying turn; it must be cheap. Use the
  `tools`/chat profile already resident — no eviction, no cold load.
- **Prompt: tiny and fixed.** A one-shot system instruction + the turn's
  `userText` (and `assistantText` only if needed for referents). Ask for a JSON
  array of 0–2 short declarative facts about the user that will still be true
  next week. Keep the wording stable — it is not part of the deterministic chat
  prefix (different model call), but a stable prompt still helps Ollama's cache.

  Sketch:

  ```
  Extract 0 to 2 durable facts about the USER from this message — things still
  true next week (preferences, relationships, recurring context). No transient
  state, no chit-chat, no facts about the assistant. Reply with a JSON array of
  short strings; [] if nothing durable.

  User: <userText>
  ```

- **Parsing:** tolerate a bare array or fenced JSON; on any parse failure, treat
  as `[]` and move on. Never throw into the detached path.

## Output contract

For each extracted fact string `f` (after trimming, dropping empties, capping at
~200 chars):

```ts
memory.remember({ content: f, source: 'extraction', importance: 1 });
```

- `remember()` already **dedups by content hash**
  ([memory.ts](../src/core/memory.ts)): re-learning the same fact keeps the
  stronger importance and refreshes recency, and `evictOverflow()` enforces the
  store cap. So the job needs no dedup of its own — "dedup is free at the store."
- `importance: 1` (default). Let repeated mentions and recall usage raise an
  item's standing over time rather than guessing high on first sight.

## Guardrails

1. **Reply-first is structural**, not best-effort — it falls out of the detached
   afterTurn block. Do not `await` extraction anywhere on the reply path.
2. **Skip cheap turns.** No extraction when the turn was an instant response
   (the `instant`-handled turns never reach the orchestrator/afterTurn anyway),
   when `userText` is below a few words, or for slash-command turns.
3. **Failure isolation.** Wrap the whole handler in try/catch and only
   `log.warn` — a bad extraction must never surface to the user or break the
   turn, matching how `runAfterReplies`/`runAfterTurns` already swallow errors.
4. **Cost cap.** One small-model call per qualifying turn, hard-capped output
   tokens (a handful of short facts), short inference timeout. On a Pi this is
   the dominant cost consideration, so it must be gateable.
5. **Config gate.** Add `memory.extraction.enabled` (default on for Standard/
   Heavy tiers, off for Small) to the config schema, surfaced in Settings like
   `instantResponses.enabled`. Honor it before making any model call.
6. **Privacy.** Same store as today (owner-only SQLite, plaintext). No new
   surface. Extraction only ever runs on the owner's own turns.

## Testing (intent, per the repo's test rule)

- A turn with a durable fact → `remember` called once with
  `source: 'extraction'` and the fact text (stub the LLM to return a fixed
  array; assert the store write, not the model).
- A turn the model judges empty (`[]`) → no `remember` call.
- Malformed model output → no throw, no write, a warning logged.
- The same fact extracted twice → one row in the store (dedup), proving the job
  relies on the store and adds no dedup of its own.
- `memory.extraction.enabled = false` → no model call at all (assert the LLM stub
  is never invoked).
- Reply-path independence → the dispatcher sends the reply before the extractor's
  (slow) promise settles.

## Open questions for the implementer

- Should `assistantText` be included in the prompt? It helps resolve pronouns
  ("she" → Mia) but doubles prompt size. Start userText-only; add assistant
  context only if recall quality demands it.
- Throttle: on a busy chat, is one extraction per turn too many model calls? A
  simple per-chat min-interval (e.g. skip if we extracted < N seconds ago) may be
  worth it on Small-tier hardware. Defer until measured.
